// Measure the real length (mm) of every bar shape in a vector CAD PDF.
//
// The drawing scale is worked out from the drawing's own dimensions (cyan lines
// with an arrowhead at each end, number read by OCR); see shape_lengths.py.
//
// Usage: bun src/shape_lengths.ts [pdf] [--page 1] [--dpi 300] [--roi x0,y0,x1,y1]
// Needs the `tesseract` program.
// Outputs: shape_lengths.csv, shape_lengths.json, shapes.json, shape_lengths.png, shape_lengths_only.png
import { parseArgs } from "node:util"
import { barLength, detectShapes, openPdf, parseRoi } from "./detect_shapes_pdf"
import { dist, round } from "./geometry"
import { ocrImages } from "./ocr"
import { getDrawings } from "./pdf_drawings"
import { renderPage, saveOverlay, shapesSvg, strokesPng } from "./render"
import type { BBox, Dimension, Drawing, Pt, RGB, ScaleGroup, Shape } from "./types"

const DIM_LINE_COLOR: RGB = [0.0, 1.0, 1.0] // cyan dimension lines and arrowheads
const DIM_TEXT_COLOR: RGB = [1.0, 0.5, 0.5] // pink dimension text

// Dimension text sits just above (or left of, if vertical) its line, within this gap
const TEXT_GAP = 1.2
const MAX_TEXT_HEIGHT = 2.0

// Dimensions whose mm-per-point differ by less than this belong to one scale group
const SCALE_TOLERANCE = 0.01
const MIN_GROUP_SIZE = 2

// Dimensions of a minor scale within ZONE_LINK (pt) of each other form one
// detail; shapes inside the box they span (+ ZONE_MARGIN) use that scale
const ZONE_LINK = 30
const ZONE_MARGIN = 5

const OCR_WHITELIST = "0123456789-/@LTCRY()"

interface DetailZone {
  scale: number
  points: Pt[]
  values: number[]
  box: BBox
}

function hasColor(c: RGB | null, target: RGB): boolean {
  return !!c && c.every((v, i) => round(v, 2) === target[i])
}

function pathLines(path: Drawing): [Pt, Pt][] {
  return path.items.filter((it) => it[0] === "l").map((it) => [it[1], it[2]])
}

// Filled cyan triangles as (tip, unit direction)
function arrowheads(drawings: Drawing[]): [Pt, Pt][] {
  const heads: [Pt, Pt][] = []
  for (const path of drawings) {
    if (!path.type.includes("f") || !hasColor(path.fill, DIM_LINE_COLOR)) continue
    const verts: Pt[] = []
    for (const [a, b] of pathLines(path)) {
      for (const q of [a, b]) if (verts.every((v) => dist(q, v) > 1e-3)) verts.push(q)
    }
    if (verts.length !== 3) continue
    const [v0, v1, v2] = verts as [Pt, Pt, Pt]
    // The tip is the corner opposite the shortest (base) edge
    const edges = [dist(v1, v2), dist(v0, v2), dist(v0, v1)]
    const k = edges.indexOf(Math.min(...edges))
    const tip = verts[k]!
    const o = verts.filter((_, i) => i !== k)
    const base: Pt = [(o[0]![0] + o[1]![0]) / 2, (o[0]![1] + o[1]![1]) / 2]
    const d: Pt = [tip[0] - base[0], tip[1] - base[1]]
    const n = Math.hypot(...d)
    heads.push([tip, [d[0] / n, d[1] / n]])
  }
  return heads
}

function onAnyLine(point: Pt, lines: [Pt, Pt][], tol = 0.05): boolean {
  for (const [a, b] of lines) {
    const length = dist(a, b)
    if (length < 1e-6) continue
    const t = ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) / length ** 2
    const d = Math.abs((point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])) / length
    if (t >= -0.01 && t <= 1.01 && d < tol) return true
  }
  return false
}

// Pairs of arrowheads pointing away from each other on one cyan line
function findDimensionLines(drawings: Drawing[]): Dimension[] {
  const heads = arrowheads(drawings)
  const cyanLines = drawings
    .filter((p) => p.type === "s" && hasColor(p.color, DIM_LINE_COLOR))
    .flatMap(pathLines)

  const partner = (i: number): number | null => {
    const [tip, d] = heads[i]!
    let best: number | null = null
    let bestDist = Infinity
    heads.forEach(([tip2, d2], j) => {
      if (j === i || d[0] * d2[0] + d[1] * d2[1] > -0.99) return
      const gap: Pt = [tip2[0] - tip[0], tip2[1] - tip[1]]
      const gapDist = Math.hypot(...gap)
      if (gapDist < 0.5 || Math.abs(gap[0] * d[1] - gap[1] * d[0]) / gapDist > 0.02) return
      // Arrow i must point away from its partner
      if (gap[0] * d[0] + gap[1] * d[1] > 0) return
      if (gapDist < bestDist) [best, bestDist] = [j, gapDist]
    })
    return best
  }

  const partners = heads.map((_, i) => partner(i))
  const dims: Dimension[] = []
  partners.forEach((j, i) => {
    if (j === null || j < i || partners[j] !== i) return
    const p1 = heads[i]![0]
    const p2 = heads[j]![0]
    const mid: Pt = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]
    if (onAnyLine(mid, cyanLines)) {
      dims.push({ p1, p2, length_pt: dist(p1, p2), text: "", value: null, scale: null })
    }
  })
  return dims
}

// Draw the text strokes large and clean, as a PNG for OCR
function numberImage(strokes: Drawing[], vertical: boolean): Promise<Buffer> {
  const x0 = Math.min(...strokes.map((s) => s.rect.x0))
  const y0 = Math.min(...strokes.map((s) => s.rect.y0))
  const x1 = Math.max(...strokes.map((s) => s.rect.x1))
  const y1 = Math.max(...strokes.map((s) => s.rect.y1))
  const [zoom, margin] = [40, 0.5]
  const px = (p: Pt): Pt => [Math.trunc((p[0] - x0 + margin) * zoom), Math.trunc((p[1] - y0 + margin) * zoom)]
  const lines = strokes.flatMap((s) => pathLines(s).map(([a, b]) => [px(a), px(b)]))
  return strokesPng(
    Math.trunc((x1 - x0 + 2 * margin) * zoom), Math.trunc((y1 - y0 + 2 * margin) * zoom), lines, 4, vertical,
  )
}

export async function readDimensions(drawings: Drawing[]): Promise<Dimension[]> {
  const dims = findDimensionLines(drawings)
  const textStrokes = drawings.filter((p) => p.type === "s" && hasColor(p.color, DIM_TEXT_COLOR))

  const jobs = dims.map((dim) => {
    const [[ax, ay], [bx, by]] = [dim.p1, dim.p2]
    const vertical = Math.abs(ax - bx) < 0.05
    let strokes: Drawing[]
    if (vertical) {
      const [lo, hi] = [Math.min(ay, by), Math.max(ay, by)]
      strokes = textStrokes.filter(({ rect: r }) =>
        ax - TEXT_GAP <= r.x1 && r.x1 <= ax + 0.05 && r.x1 - r.x0 < MAX_TEXT_HEIGHT
        && lo <= (r.y0 + r.y1) / 2 && (r.y0 + r.y1) / 2 <= hi)
    } else {
      const [lo, hi] = [Math.min(ax, bx), Math.max(ax, bx)]
      strokes = textStrokes.filter(({ rect: r }) =>
        ay - TEXT_GAP <= r.y1 && r.y1 <= ay + 0.05 && r.y1 - r.y0 < MAX_TEXT_HEIGHT
        && lo <= (r.x0 + r.x1) / 2 && (r.x0 + r.x1) / 2 <= hi)
    }
    return { strokes, vertical }
  })

  const withText = jobs.filter((j) => j.strokes.length)
  const images = await Promise.all(withText.map((j) => numberImage(j.strokes, j.vertical)))
  const read = await ocrImages(images, OCR_WHITELIST)
  const texts = new Map(withText.map((j, i) => [j, read[i]!]))

  dims.forEach((dim, i) => {
    dim.text = texts.get(jobs[i]!) ?? ""
    // Only a plain number is a length; callouts like "2L-T8-100 C/C" are not
    dim.value = /^\d{2,5}$/.test(dim.text) ? Number(dim.text) : null
    dim.scale = dim.value ? dim.value / dim.length_pt : null
  })
  return dims
}

// Group dimensions with matching mm-per-point; groups of 2+ are trusted scales
export function scaleGroups(dims: Dimension[]): ScaleGroup[] {
  const candidates = dims.filter((d) => d.scale).sort((a, b) => a.scale! - b.scale!)
  const groups: Dimension[][] = []
  let current: Dimension[] = []
  for (const d of candidates) {
    if (current.length && d.scale! > current[0]!.scale! * (1 + SCALE_TOLERANCE)) {
      groups.push(current)
      current = []
    }
    current.push(d)
  }
  if (current.length) groups.push(current)

  const trusted: ScaleGroup[] = []
  for (const g of groups) {
    if (g.length < MIN_GROUP_SIZE) continue
    // Total value / total length: long dimensions weigh more, as the PDF's
    // coordinate rounding (~0.06 pt) is a smaller share of their length
    const total = g.reduce((sum, d) => sum + d.value!, 0)
    const scale = total / g.reduce((sum, d) => sum + d.value! / d.scale!, 0)
    for (const d of g) d.group_scale = scale
    trusted.push({ scale, count: g.length })
  }
  trusted.sort((a, b) => b.count - a.count)
  // Detail scales (1:50, 1:25, 1:20, ...) stay within a few times the main one;
  // a group far outside that comes from repeated misread callouts
  const main = trusted[0]?.scale ?? 1
  const inRange = (scale: number) => scale / main >= 0.2 && scale / main <= 5
  for (const d of candidates) if (d.group_scale && !inRange(d.group_scale)) d.group_scale = null
  return trusted.filter((g) => inRange(g.scale))
}

function distanceToShape(point: Pt, shape: Shape): number {
  const pts = shape.closed ? [...shape.points, shape.points[0]!] : shape.points
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i]!, pts[i + 1]!]
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
    const seg = dx * dx + dy * dy
    const t = seg === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / seg))
    best = Math.min(best, dist(point, [a[0] + t * dx, a[1] + t * dy]))
  }
  return best
}

// Areas drawn at a different scale than the main one (e.g. a 1:25 section):
// dimensions of each other scale grouped by proximity, the box they span is the area
function detailZones(dims: Dimension[], mainScale: number): DetailZone[] {
  const others = dims.filter((d) => d.group_scale && d.group_scale !== mainScale)
  const zones: Omit<DetailZone, "box">[] = []
  for (const d of others) {
    const pts = [d.p1, d.p2]
    const zone = zones.find((z) =>
      z.scale === d.group_scale && pts.some((p) => z.points.some((q) => dist(p, q) <= ZONE_LINK)))
    if (zone) {
      zone.points.push(...pts)
      zone.values.push(d.value!)
    } else {
      zones.push({ scale: d.group_scale!, points: pts, values: [d.value!] })
    }
  }
  return zones.map((z) => {
    const xs = z.points.map((p) => p[0])
    const ys = z.points.map((p) => p[1])
    const box: BBox = [
      Math.min(...xs) - ZONE_MARGIN, Math.min(...ys) - ZONE_MARGIN,
      Math.max(...xs) + ZONE_MARGIN, Math.max(...ys) + ZONE_MARGIN,
    ]
    return { ...z, box }
  })
}

// Lengths with separate horizontal (sx) and vertical (sy) mm per point, for
// drawings that are not to scale in one direction
function measureXY(s: Shape, sx: number, sy: number) {
  const d = (a: Pt, b: Pt) => Math.hypot((b[0] - a[0]) * sx, (b[1] - a[1]) * sy)
  const pts = s.closed ? [...s.points, s.points[0]!] : s.points
  s.segments_mm = pts.slice(1).map((b, i) => Math.round(d(pts[i]!, b)))
  s.length_mm = s.segments_mm.reduce((a, b) => a + b, 0)
  s.straight_mm = s.straight_ends.map(([a, b]) => Math.round(d(a, b)))
  s.straight_length_mm = s.straight_mm.reduce((a, b) => a + b, 0)
  s.true_length_mm = round(barLength(s.path, sx, sy), 1)
  s.mm_per_pt = round(sx, 3)
  s.scale_from = "horizontal and vertical scales"
}

// Lengths of the shapes. Shapes in a detail drawn at another scale (a 1:25 section) use
// that scale both ways; the rest use mainScale horizontally and scaleY vertically
export function measure(shapes: Shape[], dims: Dimension[], mainScale: number, scaleY = mainScale) {
  const zones = detailZones(dims, mainScale)
  const mainDims = dims.filter((d) => d.group_scale === mainScale)
  for (const s of shapes) {
    const xs = s.points.map((p) => p[0])
    const ys = s.points.map((p) => p[1])
    const zone = zones.find(({ box }) => box[0] <= Math.min(...xs) && Math.max(...xs) <= box[2]
      && box[1] <= Math.min(...ys) && Math.max(...ys) <= box[3])
    let scale: number
    if (zone) {
      scale = zone.scale
      s.scale_from = `detail with dimensions ${zone.values.join(", ")}`
    } else if (scaleY !== mainScale) {
      measureXY(s, mainScale, scaleY)
      continue
    } else {
      scale = mainScale
      const midOf = (d: Dimension): Pt => [(d.p1[0] + d.p2[0]) / 2, (d.p1[1] + d.p2[1]) / 2]
      let nearest: Dimension | null = null
      let best = Infinity
      for (const d of mainDims) {
        const dd = distanceToShape(midOf(d), s)
        if (dd < best) [nearest, best] = [d, dd]
      }
      s.scale_from = nearest ? `drawing scale (e.g. dimension ${nearest.value})` : "drawing scale"
    }

    const pts = s.closed ? [...s.points, s.points[0]!] : s.points
    s.segments_mm = pts.slice(1).map((b, i) => Math.round(dist(pts[i]!, b) * scale))
    s.length_mm = s.segments_mm.reduce((a, b) => a + b, 0)
    // True length: along the bar as drawn, straight parts plus bends
    s.true_length_mm = round(s.bar_length * scale, 1)
    // Straight parts only: each segment up to where its bends start
    s.straight_mm = s.straight_parts.map((v) => Math.round(v * scale))
    s.straight_length_mm = s.straight_mm.reduce((a, b) => a + b, 0)
    s.mm_per_pt = round(scale, 3)
  }
}

export function csvRow(values: unknown[]): string {
  return values.map((v) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(",") + "\n"
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      page: { type: "string", default: "1" },
      dpi: { type: "string", default: "300" },
      roi: { type: "string" },
    },
  })
  const pdf = positionals[0] ?? "drawing.pdf"
  const pageNo = Number(values.page)
  const page = (await openPdf(pdf)).loadPage(pageNo - 1)
  const roi = parseRoi(values.roi)
  const drawings = getDrawings(page)

  // Dimensions are read from the whole page so shapes near the ROI edge still get one
  const dims = await readDimensions(drawings)
  const groups = scaleGroups(dims)
  if (!groups.length) {
    console.error("No readable dimensions found, so the drawing scale is unknown.")
    process.exit(1)
  }
  console.log(`Dimensions found: ${dims.length}, used for scale: ${groups.reduce((a, g) => a + g.count, 0)}`)
  for (const g of groups) console.log(`  scale group: ${g.scale.toFixed(3)} mm per pt  (${g.count} dimensions)`)

  const shapes = detectShapes(drawings, roi)
  measure(shapes, dims, groups[0]!.scale)

  console.log("\ntrue = along the bar incl. bends; to corner = to the corner points; straight = straight parts only")
  console.log(`${"#".padStart(4)}  ${"type".padEnd(26)} ${"true mm".padStart(9)}  ${"to corner mm".padStart(27)}  ${"straight parts mm".padStart(27)}`)
  shapes.forEach((s, i) => {
    const corner = `${s.length_mm} = ${s.segments_mm!.join(" + ")}`
    const straight = `${s.straight_length_mm} = ${s.straight_mm!.join(" + ")}`
    console.log(`${String(i + 1).padStart(4)}  ${s.name.padEnd(26)} ${String(s.true_length_mm).padStart(9)}  `
      + `${corner.padStart(27)}  ${straight.padStart(27)}   (${s.scale_from})`)
  })

  let csv = csvRow(["id", "type", "shape", "true_length_mm", "length_mm", "segments_mm",
    "straight_length_mm", "straight_parts_mm", "scale_from", "mm_per_pt", "points_pt"])
  shapes.forEach((s, i) => {
    csv += csvRow([i + 1, s.type, s.name, s.true_length_mm, s.length_mm, s.segments_mm!.join(" + "),
      s.straight_length_mm, s.straight_mm!.join(" + "), s.scale_from, s.mm_per_pt, JSON.stringify(s.points)])
  })
  await Bun.write("shape_lengths.csv", csv)
  shapes.forEach((s, i) => (s.tag = `#${i + 1}`)) // same numbers as the labels on the images
  await Bun.write("shapes.json", JSON.stringify({
    pdf,
    page: pageNo,
    mm_per_pt: round(groups[0]!.scale, 3),
    shapes: shapes.map((s) => ({
      tag: s.tag,
      shape: s.name,
      type: s.type,
      true_length_mm: s.true_length_mm,
      length_to_corners_mm: s.length_mm,
      segments_mm: s.segments_mm,
      straight_length_mm: s.straight_length_mm,
      straight_parts_mm: s.straight_mm,
      points_pt: s.points,
    })),
  }, null, 2))
  await Bun.write("shape_lengths.json", JSON.stringify({
    scale_groups: groups,
    dimensions: dims.map((d) => ({
      p1: d.p1, p2: d.p2, length_pt: d.length_pt, text: d.text, value: d.value, group_scale: d.group_scale ?? null,
    })),
    shapes,
  }, null, 1))

  const img = await renderPage(page, Number(values.dpi), roi)
  const svg = shapesSvg(shapes, shapes.map((s) => `${s.tag} ${s.true_length_mm!.toFixed(0)}`), img)
  await saveOverlay(img, svg, "shape_lengths.png", "shape_lengths_only.png")
  console.log("\nSaved: shapes.json, shape_lengths.csv, shape_lengths.json, shape_lengths.png, shape_lengths_only.png")
}

if (import.meta.main) await main()
