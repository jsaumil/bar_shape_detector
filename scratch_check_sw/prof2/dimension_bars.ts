// Draw a CAD-style dimension (straight-part length in mm) on every bar of a vector PDF.
//
// Each straight part of each bar gets a dimension line parallel to it, on the
// outer side of the bar, with extension lines, arrowheads and its real length.
//
// Usage: bun src/dimension_bars.ts [pdf] [--page 1] [--dpi 400] [--roi x0,y0,x1,y1]
// Outputs: bar_dimensions.pdf/.png, bar_dimensions_only.pdf/.png
import { parseArgs } from "node:util"
import * as mupdf from "mupdf"
import sharp from "sharp"
import { detectShapes, openPdf, parseRoi } from "./detect_shapes_pdf"
import { dist } from "./geometry"
import { getDrawings } from "./pdf_drawings"
import { renderPage } from "./render"
import { measure, readDimensions, scaleGroups } from "./shape_lengths"
import type { Pt, Roi, Shape } from "./types"

const DIM_COLOR = "0.85 0 0.85" // magenta, stands out from the drawing's own colors
const BAR_COLOR = "0 0 0"

// Sizes in PDF points (the drawing's own dimension text is about 1.4 pt high)
const FONT_SIZE = 1.1
const LINE_WIDTH = 0.06
const FIRST_OFFSET = 1.2 // distance from the bar to its dimension line
const OFFSET_STEP = 1.6 // extra distance when the spot is already taken
const EXT_GAP = 0.25 // gap between the bar and the start of an extension line
const EXT_OVERSHOOT = 0.4 // extension line continues this far past the dimension line
const ARROW_LENGTH = 0.6
const ARROW_HALF_WIDTH = 0.13
const TEXT_GAP = 0.25 // gap between dimension line and its text

// Straight parts shorter than this (mm) are not dimensioned
const MIN_DIMENSION_MM = 50

const FONT_NAME = "HelvDim"
const helvetica = new mupdf.Font("Helvetica")

interface Plan {
  a: Pt
  b: Pt
  da: Pt
  db: Pt
  u: Pt
  n: Pt
  text: string
  point: Pt
  rotate: 0 | 90
}

const add = (p: Pt, v: Pt, k = 1.0): Pt => [p[0] + v[0] * k, p[1] + v[1] * k]

const intersects = (a: Roi, b: Roi) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
const union = (a: Roi, b: Roi): Roi => ({
  x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
})

function textLength(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += helvetica.advanceGlyph(helvetica.encodeCharacter(ch))
  return w * size
}

// Unit normal of segment a-b pointing away from the rest of the shape
function outwardNormal(a: Pt, b: Pt, shape: Shape): [Pt, Pt] {
  const length = dist(a, b)
  const u: Pt = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]
  const n: Pt = [-u[1], u[0]]
  const xs = shape.points.map((p) => p[0])
  const ys = shape.points.map((p) => p[1])
  const centre: Pt = [xs.reduce((s, v) => s + v, 0) / xs.length, ys.reduce((s, v) => s + v, 0) / ys.length]
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  let side = (mid[0] - centre[0]) * n[0] + (mid[1] - centre[1]) * n[1]
  if (Math.abs(side) < 1e-6) {
    // Straight bar: put the dimension above it (or left of it if vertical)
    side = -(Math.abs(n[1]) > Math.abs(n[0]) ? n[1] : n[0])
  }
  return [u, side > 0 ? n : [-n[0], -n[1]]]
}

// (insert point, rotate, bounding rect) for text beside the dimension line
function textLayout(text: string, mid: Pt, n: Pt, u: Pt): [Pt, 0 | 90, Roi] {
  const width = textLength(text, FONT_SIZE)
  const height = FONT_SIZE * 0.75
  if (Math.abs(u[1]) <= Math.abs(u[0])) {
    const x = mid[0] - width / 2
    // text above the line, or below it
    const y = n[1] <= 0 ? mid[1] - TEXT_GAP : mid[1] + TEXT_GAP + height
    return [[x, y], 0, { x0: x, y0: y - height, x1: x + width, y1: y }]
  }
  // Vertical: text reads bottom to top, like CAD; left of the line, or right of it
  const y = mid[1] + width / 2
  const x = n[0] <= 0 ? mid[0] - TEXT_GAP : mid[0] + TEXT_GAP + height
  return [[x, y], 90, { x0: x - height, y0: y - width, x1: x, y1: y }]
}

// Work out where every dimension goes, moving it out until it is free
function planDimensions(shapes: Shape[]): Plan[] {
  const placed: Roi[] = []
  const plans: Plan[] = []
  for (const s of shapes) {
    if (s.type === "closed") continue // filled dots and similar outlines, not bars
    s.straight_ends.forEach(([a, b], i) => {
      const mm = s.straight_mm![i]!
      if (mm < MIN_DIMENSION_MM) return
      const [u, n] = outwardNormal(a, b, s)
      const text = String(mm)
      let offset = FIRST_OFFSET
      while (true) {
        const [da, db] = [add(a, n, offset), add(b, n, offset)]
        const mid: Pt = [(da[0] + db[0]) / 2, (da[1] + db[1]) / 2]
        const [point, rotate, textRect] = textLayout(text, mid, n, u)
        const lineRect: Roi = {
          x0: Math.min(da[0], db[0]) - 0.2, y0: Math.min(da[1], db[1]) - 0.2,
          x1: Math.max(da[0], db[0]) + 0.2, y1: Math.max(da[1], db[1]) + 0.2,
        }
        const box = union(lineRect, textRect)
        if (!placed.some((r) => intersects(box, r)) || offset > 20 * OFFSET_STEP) {
          placed.push(box)
          plans.push({ a, b, da, db, u, n, text, point, rotate })
          break
        }
        offset += OFFSET_STEP
      }
    })
  }
  return plans
}

// ---------------------------------------------------------------- PDF content
// Content is written in page coordinates (y down, as everywhere else here);
// appendContent() maps it into the page's PDF space.

const f = (v: number) => v.toFixed(4)
const moveLine = (p: Pt, q: Pt) => `${f(p[0])} ${f(p[1])} m ${f(q[0])} ${f(q[1])} l\n`

function dimensionOps(plans: Plan[]): string {
  let ops = ""
  for (const { a, b, da, db, u, n, text, point, rotate } of plans) {
    // Extension lines from the bar ends past the dimension line, and the dimension line
    ops += `${DIM_COLOR} RG ${LINE_WIDTH} w\n`
    ops += moveLine(add(a, n, EXT_GAP), add(da, n, EXT_OVERSHOOT))
    ops += moveLine(add(b, n, EXT_GAP), add(db, n, EXT_OVERSHOOT))
    ops += moveLine(da, db) + "S\n"
    // Arrowheads pointing at the extension lines
    ops += `${DIM_COLOR} rg 0.01 w\n`
    for (const [tip, back] of [[da, u], [db, [-u[0], -u[1]]]] as [Pt, Pt][]) {
      const base = add(tip, back, ARROW_LENGTH)
      const [p, q] = [add(base, n, ARROW_HALF_WIDTH), add(base, n, -ARROW_HALF_WIDTH)]
      ops += `${f(tip[0])} ${f(tip[1])} m ${f(p[0])} ${f(p[1])} l ${f(q[0])} ${f(q[1])} l h b\n`
    }
    // Text: un-flip the y-down page space; rotated 90 it reads bottom to top
    const tm = rotate === 0 ? "1 0 0 -1" : "0 -1 -1 0"
    ops += `BT /${FONT_NAME} ${FONT_SIZE} Tf ${tm} ${f(point[0])} ${f(point[1])} Tm (${text}) Tj ET\n`
  }
  return ops
}

function barOps(shapes: Shape[]): string {
  let ops = `${BAR_COLOR} RG 0.12 w\n`
  for (const s of shapes) {
    if (s.type === "closed") continue
    const pts = s.closed ? [...s.points, s.points[0]!] : s.points
    ops += pts.map((p, i) => `${f(p[0])} ${f(p[1])} ${i ? "l" : "m"}`).join(" ") + " S\n"
  }
  return ops
}

// Add drawing operators on top of a page's content, in page coordinates
function appendContent(doc: mupdf.PDFDocument, page: mupdf.PDFPage, ops: string) {
  const pageObj = page.getObject()
  let resources = pageObj.get("Resources")
  if (resources.isNull()) {
    resources = doc.newDictionary()
    pageObj.put("Resources", resources)
  }
  let fonts = resources.get("Font")
  if (fonts.isNull()) {
    fonts = doc.newDictionary()
    resources.put("Font", fonts)
  }
  fonts.put(FONT_NAME, doc.addSimpleFont(helvetica, "Latin"))

  const [a, b, c, d, e, g] = mupdf.Matrix.invert(page.getTransform())
  const contents = doc.newArray()
  // Wrap the old content in q/Q so its graphics state does not leak into ours
  contents.push(doc.addStream("q\n", {}))
  const old = pageObj.get("Contents")
  if (old.isArray()) for (let i = 0; i < old.length; i++) contents.push(old.get(i))
  else if (!old.isNull()) contents.push(old)
  contents.push(doc.addStream(`Q\nq ${[a, b, c, d, e, g].map(f).join(" ")} cm\n${ops}Q\n`, {}))
  pageObj.put("Contents", contents)
}

async function save(doc: mupdf.PDFDocument, name: string, dpi: number, roi: Roi | null) {
  await Bun.write(`${name}.pdf`, doc.saveToBuffer("garbage=3,compress").asUint8Array())
  const img = await renderPage(doc.loadPage(0), dpi, roi)
  await sharp(img.png).toFile(`${name}.png`)
  console.log(`Saved: ${name}.pdf, ${name}.png`)
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      page: { type: "string", default: "1" },
      dpi: { type: "string", default: "400" },
      roi: { type: "string" },
    },
  })
  const pdf = positionals[0] ?? "drawing.pdf"
  const pageNo = Number(values.page)
  const dpi = Number(values.dpi)
  const src = (await openPdf(pdf)) as mupdf.PDFDocument
  const page = src.loadPage(pageNo - 1)
  const roi = parseRoi(values.roi)
  const drawings = getDrawings(page)

  const dims = await readDimensions(drawings)
  const groups = scaleGroups(dims)
  if (!groups.length) {
    console.error("No readable dimensions found, so the drawing scale is unknown.")
    process.exit(1)
  }
  const shapes = detectShapes(drawings, roi)
  measure(shapes, dims, groups[0]!.scale)
  console.log(`Drawing scale: ${groups[0]!.scale.toFixed(3)} mm per pt; bars: ${shapes.filter((s) => s.type !== "closed").length}`)

  const plans = planDimensions(shapes)
  console.log(`Dimensions drawn: ${plans.length}`)

  // 1. The drawing with dimensions added
  const out = new mupdf.PDFDocument()
  out.graftPage(-1, src, pageNo - 1)
  appendContent(out, out.loadPage(0), dimensionOps(plans))
  await save(out, "bar_dimensions", dpi, roi)

  // 2. Only the bars and their dimensions
  const only = new mupdf.PDFDocument()
  const [x0, y0, x1, y1] = page.getBounds()
  only.insertPage(-1, only.addPage([0, 0, x1 - x0, y1 - y0], 0, only.newDictionary(), ""))
  appendContent(only, only.loadPage(0), barOps(shapes) + dimensionOps(plans))
  await save(only, "bar_dimensions_only", dpi, roi)
}

if (import.meta.main) await main()
