// Check rebar_finder.ts against the source DWG and write actual vs predicted lengths to an .ods.
//
// Each PDF shape is paired with a DWG entity by its position on the sheet, never by its
// length, so a wrong pairing shows up as a large error instead of being hidden.
//
// Usage:
//   bun check_drawing.ts [--dwg file.dwg] [--pdf file.pdf] [--out check.ods]
import { deflateRawSync } from "node:zlib"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const BAR_LAYERS = new Set(["CBM_OCS_REINF", "REINF"])

// Ends of a PDF shape and its DWG bar must be this close (mm) to count as the same bar
const END_TOLERANCE = 25

// A bar's own hook can be missing from a shape's corners, moving the shape's end this far (mm)
const HOOK_TOLERANCE = 150

// Corners of a shape sit off the bar's chords by this much (mm) at a bend
const CORNER_TOLERANCE = 25

// Shapes seen on the sheet to be title-block linework: these have no bar in the DWG
const TITLE_BLOCK: Record<string, string> = {
  "#123": 'letter N of "GENERAL" in the title block heading "GENERAL NOTES:"',
  "#124": 'letter N of "NOTES" in the title block heading "GENERAL NOTES:"',
  "#143": "north-arrow circle in the title block",
}

type Pt = [number, number]
type Entity = {
  kind: string
  layer: string
  points: Pt[]
  bulges: number[]
  closed: boolean
  length: number
  paperSpace: boolean
}
type PdfShape = {
  tag: string
  shape: string
  type: string
  true_length_mm: number
  points_pt: Pt[]
}
type Fit = { a: number; tx: number; ty: number }
type Row = {
  tag: string
  shape: string
  predicted: number
  actual: number | null
  layer: string
  endGap: number | null
  note: string
}

const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1])
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length
const round = (value: number, digits: number) => Number(value.toFixed(digits))

function polylineLength(points: Pt[], bulges: number[], closed: boolean) {
  let total = 0
  const count = closed ? points.length : points.length - 1
  for (let i = 0; i < count; i++) {
    const chord = dist(points[i]!, points[(i + 1) % points.length]!)
    const bulge = bulges[i] ?? 0
    if (bulge === 0) {
      total += chord
      continue
    }
    const angle = 4 * Math.atan(Math.abs(bulge))
    total += (chord / (2 * Math.sin(angle / 2))) * angle
  }
  return total
}

// Model-space entities of a DXF's ENTITIES section, with lengths in drawing units
function parseDxf(source: string) {
  const lines = source.split(/\r?\n/)
  const pairs: [number, string][] = []
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([Number(lines[i]), lines[i + 1]!.trim()])

  const entities: Entity[] = []
  let inEntities = false
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i]!
    if (code === 2 && value === "ENTITIES" && pairs[i - 1]?.[1] === "SECTION") inEntities = true
    if (!inEntities) continue
    if (code === 0 && value === "ENDSEC") break
    if (code !== 0) continue

    const group: [number, string][] = []
    let j = i + 1
    while (j < pairs.length && pairs[j]![0] !== 0) group.push(pairs[j++]!)
    const entity = readEntity(value, group)
    if (entity) entities.push(entity)
  }
  return entities
}

function readEntity(kind: string, group: [number, string][]): Entity | null {
  const first = (code: number, fallback = "") => group.find(([c]) => c === code)?.[1] ?? fallback
  const num = (code: number) => Number(first(code, "0"))
  const base = {
    kind,
    layer: first(8),
    bulges: [] as number[],
    closed: false,
    paperSpace: first(67) === "1",
  }
  // A -Z extrusion mirrors the entity's x coordinates in the world
  const flipX = Number(first(230, "1")) < 0 ? -1 : 1

  if (kind === "LWPOLYLINE") {
    const points: Pt[] = []
    const bulges: number[] = []
    let x = 0
    for (const [code, value] of group) {
      if (code === 10) x = Number(value)
      if (code === 20) {
        points.push([flipX * x, Number(value)])
        bulges.push(0)
      }
      if (code === 42) bulges[bulges.length - 1] = Number(value)
    }
    const closed = (num(70) & 1) === 1
    return { ...base, points, bulges, closed, length: polylineLength(points, bulges, closed) }
  }
  return null
}

const toDwg = (fit: Fit, p: Pt): Pt => [fit.a * p[0] + fit.tx, -fit.a * p[1] + fit.ty]

// Gap between the ends of a shape and a bar, whichever way round the bar was drawn
function endGap(start: Pt, end: Pt, bar: Entity) {
  const first = bar.points[0]!
  const last = bar.points[bar.points.length - 1]!
  return Math.min(Math.max(dist(start, first), dist(end, last)), Math.max(dist(start, last), dist(end, first)))
}

// Translation by voting: every shape/bar pair of similar length proposes one, the true one repeats
function registerSheet(shapes: PdfShape[], bars: Entity[], mmPerPt: number): Fit {
  const votes = new Map<string, number>()
  const bin = 20
  for (const shape of shapes) {
    const start = shape.points_pt[0]!
    const end = shape.points_pt[shape.points_pt.length - 1]!
    for (const bar of bars) {
      if (bar.points.length < 2 || Math.abs(bar.length - shape.true_length_mm) > 30) continue
      for (const target of [bar.points[0]!, bar.points[bar.points.length - 1]!]) {
        for (const source of [start, end]) {
          const key = `${Math.round((target[0] - mmPerPt * source[0]) / bin)},${Math.round((target[1] + mmPerPt * source[1]) / bin)}`
          votes.set(key, (votes.get(key) ?? 0) + 1)
        }
      }
    }
  }
  const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1])
  if (!best) throw new Error("No PDF shape has a DWG bar of similar length: this is not the source DWG")
  const [binX, binY] = best[0].split(",").map(Number)
  return { a: mmPerPt, tx: binX! * bin, ty: binY! * bin }
}

function pairs(shapes: PdfShape[], bars: Entity[], fit: Fit, tolerance: number) {
  const found: { shape: PdfShape; bar: Entity; gap: number }[] = []
  for (const shape of shapes) {
    const start = toDwg(fit, shape.points_pt[0]!)
    const end = toDwg(fit, shape.points_pt[shape.points_pt.length - 1]!)
    let best: Entity | null = null
    let bestGap = tolerance
    for (const bar of bars) {
      if (bar.points.length < 2) continue
      const gap = endGap(start, end, bar)
      if (gap < bestGap) [best, bestGap] = [bar, gap]
    }
    if (best) found.push({ shape, bar: best, gap: bestGap })
  }
  return found
}

// Least-squares scale and offset from the paired ends
function refineFit(found: ReturnType<typeof pairs>, fit: Fit): Fit {
  const from: Pt[] = []
  const to: Pt[] = []
  for (const { shape, bar } of found) {
    const start = shape.points_pt[0]!
    const end = shape.points_pt[shape.points_pt.length - 1]!
    const first = bar.points[0]!
    const last = bar.points[bar.points.length - 1]!
    const sameWay = dist(toDwg(fit, start), first) + dist(toDwg(fit, end), last)
      <= dist(toDwg(fit, start), last) + dist(toDwg(fit, end), first)
    from.push(start, end)
    to.push(sameWay ? first : last, sameWay ? last : first)
  }
  const mx = mean(from.map((p) => p[0]))
  const my = mean(from.map((p) => p[1]))
  const ux = mean(to.map((p) => p[0]))
  const uy = mean(to.map((p) => p[1]))
  let top = 0
  let bottom = 0
  from.forEach((p, i) => {
    const dx = p[0] - mx
    const dy = p[1] - my
    top += dx * (to[i]![0] - ux) - dy * (to[i]![1] - uy)
    bottom += dx * dx + dy * dy
  })
  const a = top / bottom
  return { a, tx: ux - a * mx, ty: uy + a * my }
}

function bounds(points: Pt[]) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

function distanceToSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const span = dx * dx + dy * dy
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / span))
  return dist(p, [a[0] + t * dx, a[1] + t * dy])
}

// The bar a shape lies along when the shape's corners leave out a short hook at the bar's end
function hookedBar(shape: PdfShape, bars: Entity[], fit: Fit) {
  const corners = shape.points_pt.map((p) => toDwg(fit, p))
  const start = corners[0]!
  const end = corners[corners.length - 1]!
  for (const bar of bars) {
    if (bar.points.length < 2 || endGap(start, end, bar) > HOOK_TOLERANCE) continue
    const onBar = corners.every((corner) =>
      bar.points.slice(1).some((point, i) => distanceToSegment(corner, bar.points[i]!, point) <= CORNER_TOLERANCE))
    if (onBar) return bar
  }
  return null
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const textCell = (s: string, style = "") =>
  `<table:table-cell${style ? ` table:style-name="${style}"` : ""} office:value-type="string"><text:p>${escapeXml(s)}</text:p></table:table-cell>`

const numberCell = (value: number, style = "") =>
  `<table:table-cell${style ? ` table:style-name="${style}"` : ""} office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`

const formulaCell = (formula: string, value: number, style = "") =>
  `<table:table-cell${style ? ` table:style-name="${style}"` : ""} table:formula="of:=${escapeXml(formula)}" office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`

const blankCell = `<table:table-cell/>`

const column = (style: string) => `<table:table-column table:style-name="${style}"/>`

const row = (cells: string[]) => `<table:table-row>${cells.join("")}</table:table-row>`

function contentXml(rows: Row[], summary: [string, string | number, string?][]) {
  const header = ["sr no", "shape number", "shape", "actual (DWG, mm)", "predicted (mm)", "error (mm)", "abs error (mm)", "error %", "note"]
  const body = rows.map((r, i) => {
    const line = i + 2
    if (r.actual === null) {
      return row([numberCell(i + 1), textCell(r.tag), textCell(r.shape), blankCell, numberCell(r.predicted, "n1"), blankCell, blankCell, blankCell, textCell(r.note)])
    }
    const error = r.predicted - r.actual
    return row([
      numberCell(i + 1),
      textCell(r.tag),
      textCell(r.shape),
      numberCell(round(r.actual, 3), "n3"),
      numberCell(r.predicted, "n1"),
      formulaCell(`[.E${line}]-[.D${line}]`, round(error, 3), "n2"),
      formulaCell(`ABS([.F${line}])`, round(Math.abs(error), 3), "n2"),
      formulaCell(`[.G${line}]/[.D${line}]*100`, round((Math.abs(error) / r.actual) * 100, 4), "n3"),
      textCell(r.note),
    ])
  })
  const summaryRows = summary.map(([label, value, formula]) =>
    row([
      textCell(label, "bold"),
      formula ? formulaCell(formula, value as number, "n2") : typeof value === "number" ? numberCell(value) : textCell(value),
    ]),
  )

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.2">
<office:automatic-styles>
<number:number-style style:name="f1"><number:number number:decimal-places="1" number:min-integer-digits="1"/></number:number-style>
<number:number-style style:name="f2"><number:number number:decimal-places="2" number:min-integer-digits="1"/></number:number-style>
<number:number-style style:name="f3"><number:number number:decimal-places="3" number:min-integer-digits="1"/></number:number-style>
<style:style style:name="n1" style:family="table-cell" style:data-style-name="f1"/>
<style:style style:name="n2" style:family="table-cell" style:data-style-name="f2"/>
<style:style style:name="n3" style:family="table-cell" style:data-style-name="f3"/>
<style:style style:name="bold" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="narrow" style:family="table-column"><style:table-column-properties style:column-width="2.2cm"/></style:style>
<style:style style:name="medium" style:family="table-column"><style:table-column-properties style:column-width="3.2cm"/></style:style>
<style:style style:name="wide" style:family="table-column"><style:table-column-properties style:column-width="5.5cm"/></style:style>
<style:style style:name="note" style:family="table-column"><style:table-column-properties style:column-width="14cm"/></style:style>
</office:automatic-styles>
<office:body><office:spreadsheet>
<table:table table:name="Lengths">
${column("narrow")}${column("narrow")}${column("wide")}${column("medium")}${column("medium")}${column("narrow")}${column("medium")}${column("narrow")}${column("note")}
${row(header.map((h) => textCell(h, "bold")))}
${body.join("\n")}
</table:table>
<table:table table:name="Summary">
${column("wide")}${column("note")}
${summaryRows.join("\n")}
</table:table>
</office:spreadsheet></office:body>
</office:document-content>`
}

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`

// A zip with the mimetype first and uncompressed, as the OpenDocument format requires
function odsBytes(files: [string, string][]) {
  const encoder = new TextEncoder()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  files.forEach(([name, content], index) => {
    const nameBytes = encoder.encode(name)
    const raw = encoder.encode(content)
    const stored = index === 0
    const data = stored ? raw : deflateRawSync(raw)
    const crc = Bun.hash.crc32(raw)
    const method = stored ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, Buffer.from(nameBytes), Buffer.from(data))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, Buffer.from(nameBytes))
    offset += local.length + nameBytes.length + data.length
  })
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const { values: args } = parseArgs({
  options: {
    dwg: { type: "string", default: "/home/saumil/Downloads/ST-712-00 TO 03-R1 -Basement 04 beam reinforcement  details.dwg" },
    pdf: { type: "string", default: "pdf/drawing.pdf" },
    out: { type: "string", default: "check.ods" },
  },
})

const work = await mkdtemp(path.join(tmpdir(), "check-drawing-"))
const dxfPath = path.join(work, "source.dxf")
await Bun.$`dwg2dxf -y -o ${dxfPath} ${args.dwg}`.quiet()
await Bun.$`bun src/rebar_finder.ts ${args.pdf} --out ${work}`.quiet()

const result = await Bun.file(path.join(work, "shapes.json")).json()
const shapes: PdfShape[] = result.shapes
const mmPerPt: number = result.pages[0].mm_per_pt

const entities = parseDxf(await Bun.file(dxfPath).text()).filter((e) => !e.paperSpace)
const bars = entities.filter((e) => BAR_LAYERS.has(e.layer) && e.kind === "LWPOLYLINE")

let fit = registerSheet(shapes, bars, mmPerPt)
let found = pairs(shapes, bars, fit, 150)
for (const tolerance of [100, 50, END_TOLERANCE]) {
  fit = refineFit(found, fit)
  found = pairs(shapes, bars, fit, tolerance)
}
fit = refineFit(found, fit)
found = pairs(shapes, bars, fit, END_TOLERANCE)

const pairedBy = new Map(found.map((f) => [f.shape.tag, f]))
const used = new Set(found.map((f) => f.bar))
const rows: Row[] = shapes.map((shape) => {
  const pair = pairedBy.get(shape.tag)
  const hooked = pair ? null : hookedBar(shape, bars.filter((bar) => !used.has(bar)), fit)
  if (hooked) used.add(hooked)
  const bar = pair?.bar ?? hooked
  const hookNote = "DWG bar ends in a short hook; the shape name and corners leave it out, its length includes it"
  return {
    tag: shape.tag,
    shape: shape.shape,
    predicted: shape.true_length_mm,
    actual: bar ? bar.length : null,
    layer: bar?.layer ?? "",
    endGap: pair ? pair.gap : null,
    note: hooked ? hookNote : bar ? "" : `Not a bar: ${TITLE_BLOCK[shape.tag] ?? "no bar in the DWG at this spot"}`,
  }
})

// Bars of the DWG inside this PDF's sheet that no shape was paired with
const sheet = bounds(shapes.flatMap((s) => s.points_pt.map((p) => toDwg(fit, p))))
const missed = bars.filter((bar) => {
  if (used.has(bar)) return false
  const box = bounds(bar.points)
  return box.x0 >= sheet.x0 - 500 && box.x1 <= sheet.x1 + 500 && box.y0 >= sheet.y0 - 500 && box.y1 <= sheet.y1 + 500
})

const paired = rows.filter((r): r is Row & { actual: number } => r.actual !== null)
const errors = paired.map((r) => Math.abs(r.predicted - r.actual))
const last = rows.length + 1
const summary: [string, string | number, string?][] = [
  ["DWG (actual)", path.basename(args.dwg)],
  ["PDF (predicted)", args.pdf],
  ["Predicted by", "bun src/rebar_finder.ts"],
  ["PDF shapes", shapes.length],
  ["Shapes paired with a DWG bar", paired.length],
  ["Shapes with no DWG bar", rows.length - paired.length],
  ["DWG bars in this sheet with no shape", missed.length],
  ["  of these, small closed dots (bars cut in a section)", missed.filter((bar) => bar.closed && bar.length < 100).length],
  ["Mean abs error (mm)", round(mean(errors), 3), `AVERAGE([Lengths.G2:.G${last}])`],
  ["Max abs error (mm)", round(Math.max(...errors), 3), `MAX([Lengths.G2:.G${last}])`],
  ["Scale used by finder (mm/pt)", mmPerPt],
  ["Scale from DWG position fit (mm/pt)", round(fit.a, 4)],
]

await Bun.write(args.out, odsBytes([
  ["mimetype", "application/vnd.oasis.opendocument.spreadsheet"],
  ["content.xml", contentXml(rows, summary)],
  ["META-INF/manifest.xml", MANIFEST],
]))

const gaps = found.map((f) => f.gap).sort((a, b) => a - b)
console.log(`DWG entities ${entities.length}, bar polylines ${bars.length}`)
console.log(`Fit: ${round(fit.a, 4)} mm/pt (finder ${mmPerPt}), offset ${round(fit.tx, 1)}, ${round(fit.ty, 1)}`)
console.log(`Paired ${paired.length}/${shapes.length}, end gap median ${round(gaps[gaps.length >> 1]!, 2)} mm, max ${round(gaps[gaps.length - 1]!, 2)} mm`)
console.log(`Mean abs error ${round(mean(errors), 3)} mm, max ${round(Math.max(...errors), 3)} mm`)
console.log(`Bars paired twice: ${paired.length - used.size}`)
console.log(`Unpaired shapes:`)
for (const r of rows.filter((r) => r.actual === null)) console.log(`  ${r.tag} ${r.shape} ${r.predicted} mm: ${r.note}`)
console.log(`DWG bars in the sheet with no shape: ${missed.length}`)
for (const bar of missed) console.log(`  ${bar.layer} ${round(bar.length, 2)} mm closed=${bar.closed} at ${bar.points[0]!.map((v) => round(v, 0))}`)
console.log(`Saved ${args.out}`)
