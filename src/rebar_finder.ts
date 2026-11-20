// Find rebar shapes and their real lengths in any CAD-exported vector PDF.
//
// Bars: from a reinforcement CAD layer (REIN, REBAR, BAR, STEEL, RFT) if the PDF
// has one, otherwise the black/gray lines (detect_shapes_pdf.ts).
//
// Drawing scale (mm per PDF point), first that works:
//   1. --mm-per-pt / --scale given by you
//   2. the drawing's own dimensions (a straight line with small filled markers;
//      its number from the PDF text, or by OCR of the strokes next to it)
//   3. a "SCALE 1:N" label in the PDF text (assumes the sheet is plotted true size)
//
// Usage:
//   bun src/rebar_finder.ts file.pdf [--pages 1,2] [--scale 50 | --mm-per-pt 87.96]
//       [--scale-y N | --mm-per-pt-y X | --vertical-ratio R] [--bar-layer NAME]
//       [--dim-layer NAME] [--roi x0,y0,x1,y1] [--dpi 300] [--out DIR] [--probe]
//
// Outputs (in <pdf name>_results/ unless --out is given):
//   shapes.json, shapes.csv, page<N>_shapes.png, page<N>_shapes_only.png
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import type * as mupdf from "mupdf"
import { assignBeams, checkDepths, type DepthStatus, depthVerdict, findBeamTitles, sectionDepthCheck } from "./beams"
import { detectShapes, joinPolylines, openPdf, parseRoi, pathPolylines, shapesFromLines } from "./detect_shapes_pdf"
import { dist, round } from "./geometry"
import { ocrImages } from "./ocr"
import { getDrawings, getText, getWords } from "./pdf_drawings"
import { renderPage, saveOverlay, shapesSvg, strokesPng } from "./render"
import { saveShapeImages } from "./shape_images"
import { csvRow, measure, scaleGroups } from "./shape_lengths"
import type { Dimension, Drawing, Polyline, Pt, Roi, ScaleGroup, Shape } from "./types"

const BAR_LAYER_PATTERN = /REIN|REBAR|\bBARS?\b|STEEL|RFT|\bTIES?\b/i
// Annotation layers named after the bars (BEAM_STEEL_TXT, BEAM_STEEL_DOT, CBM_OCS_REINF_DOT):
// stroked text, leaders and section dots, never bar shapes; hatch layers (REINF.HATCH.) are section dot fills
const NOT_BAR_LAYER_PATTERN = /TXT|TEXT|DOT|DIM|HATCH/i
const DIM_LAYER_PATTERN = /DIM/i
// How far (share of the radius) a section dot's outline may stray from a circle
const DOT_ROUNDNESS = 0.1
// A dot's fill strokes lie within this share of its radius (plot rounding)
const DOT_FILL_REACH = 1.1

// Bar pieces on a bar layer are joined when their ends are this share of the line width apart
const JOIN_SHARE_OF_WIDTH = 0.3
// ... but never less than the plotter's coordinate rounding allows: a bend arc plotted 0.12 pt
// across and 0.06 pt along from its straight leaves a 0.134 pt gap even with thin pens
const MIN_JOIN_TOL = 0.18

// Scale groups within this share of the main scale are the same scale (rounding of numbers)
const SAME_SCALE = 0.03

// Details drawn at another scale use a standard scale; a group whose ratio to the
// main scale is not a ratio of two of these is a repeated misread and is dropped
const STANDARD_SCALES = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200, 250, 500, 1000]

// AutoCAD plots at 600 dpi, so a length between two plotted points is off by up to this (pt)
const PLOT_ROUNDING = 0.12

// Dimension markers: small filled shapes (arrowheads, ticks, dots) up to this size (pt)
const MAX_MARKER_SIZE = 4.0
// A marker belongs to a line if it is this close to it (pt) ...
const MARKER_ON_LINE = 0.3
// ... and no further beyond the line's ends than this (pt, plus 15% of the line)
const MARKER_BEYOND_END = 1.5
// Stroked dimension ends (slash ticks, or short extension-line stubs crossing the
// line) are lines up to this long (pt) ...
const MAX_TICK_LENGTH = 8.0
// ... that cross the dimension line at this angle or steeper (degrees)
const MIN_TICK_ANGLE = 30
// A scale is trusted only when at least this many dimensions agree on it;
// fewer is more likely misread table marks than a real scale
const MIN_SCALE_DIMENSIONS = 5
// Collinear pieces of one dimension line (e.g. broken around its text) are joined
// when the gap between them is less than this share of the longer piece
const LINE_JOIN_GAP = 0.6
// A line whose direction has an x part up to this (sin of ~3 deg) reads as vertical text
const NEAR_VERTICAL = 0.05

// Text strokes are paths no bigger than this (pt)
const MAX_GLYPH_SIZE = 15.0
// The number is searched up to this far from its line (pt, plus 10% of the line)
const MAX_TEXT_DISTANCE = 3.0

// A number is never drawn with more strokes than this
const MAX_TEXT_STROKES = 60

// Text heights (px) the number is rendered at for OCR; the first two must agree,
// otherwise all are read and the majority wins
const OCR_HEIGHTS = [40, 30, 50, 60, 80]
const OCR_WHITELIST = "0123456789-/@LTCRYXABEH()."
// A dimension value: 2 to 6 digits, never starting with 0 ("008" is 800 read upside down)
const DIM_NUMBER = /^[1-9]\d{1,5}$/
// Text wider than this many times its height is not a dimension number
const MAX_TEXT_ASPECT = 8

type Line = [origin: Pt, u: Pt, t0: number, t1: number]
interface Glyph {
  polylines: Polyline[]
  corners: Pt[]
}
// A glyph with its extent along / across the dimension line
type Near = [glyph: Glyph, a0: number, a1: number, c0: number, c1: number]
type Blob = [glyphs: Glyph[], box: [number, number, number, number], mid: Pt, u: Pt]

interface Args {
  pages?: number[]
  scale?: number
  mmPerPt?: number
  scaleY?: number
  mmPerPtY?: number
  verticalRatio?: number
  barLayer?: string
  dimLayer?: string
  dpi: number
  probe: boolean
}

interface PageResult {
  page: number
  mm_per_pt: number
  scale_from: string
  mm_per_pt_vertical: number
  vertical_scale_from: string
  bars_from: string
  beam_titles: number
  shapes_in_beams: number
  depth_check: string
  depth_status: DepthStatus
  shapes: Shape[]
}

const width = (r: Roi) => r.x1 - r.x0
const height = (r: Roi) => r.y1 - r.y0

// Counter.most_common(): [value, count] pairs, most frequent first (ties keep first-seen order)
function mostCommon<T>(items: T[], key: (item: T) => string = String): [T, number][] {
  const counts = new Map<string, [T, number]>()
  for (const item of items) {
    const k = key(item)
    const entry = counts.get(k)
    if (entry) entry[1]++
    else counts.set(k, [item, 1])
  }
  return [...counts.values()].sort((a, b) => b[1] - a[1])
}

// ---------------------------------------------------------------- geometry

function unit(a: Pt, b: Pt): Pt {
  const d = dist(a, b)
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]
}

// (along, across) coordinates of p relative to a line through origin with direction u
function project(p: Pt, origin: Pt, u: Pt): [number, number] {
  const [dx, dy] = [p[0] - origin[0], p[1] - origin[1]]
  return [dx * u[0] + dy * u[1], -dx * u[1] + dy * u[0]]
}

// Spatial hash of rectangles for quick "what is near here" queries
class Grid<T> {
  private cells = new Map<string, T[]>()

  constructor(private cell = 10.0) {}

  private *keys(x0: number, y0: number, x1: number, y1: number) {
    const c = this.cell
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) {
      for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++) yield `${i},${j}`
    }
  }

  add(item: T, x0: number, y0: number, x1: number, y1: number) {
    for (const k of this.keys(x0, y0, x1, y1)) {
      if (!this.cells.has(k)) this.cells.set(k, [])
      this.cells.get(k)!.push(item)
    }
  }

  *query(x0: number, y0: number, x1: number, y1: number) {
    const seen = new Set<T>()
    for (const k of this.keys(x0, y0, x1, y1)) {
      for (const item of this.cells.get(k) ?? []) {
        if (!seen.has(item)) {
          seen.add(item)
          yield item
        }
      }
    }
  }
}

// ---------------------------------------------------------------- bars

function findBarLayers(drawings: Drawing[], forced?: string): string[] {
  const layers = [...new Set(drawings.map((p) => p.layer))]
  if (forced) return layers.filter((name) => name.toLowerCase() === forced.toLowerCase())
  return layers.filter((name) => name && BAR_LAYER_PATTERN.test(name) && !NOT_BAR_LAYER_PATTERN.test(name))
}

// A stroked circle (closed, every point about the same distance from the centre) is a bar
// seen end-on in a section. It is never a bar shape, and where it touches a link's corner its
// arcs would join onto the link and break it apart
function dotCircle(line: Polyline): [Pt, number] {
  const c: Pt = [0, 1].map((k) => line.reduce((sum, p) => sum + p[k]!, 0) / line.length) as Pt
  return [c, line.reduce((sum, p) => sum + dist(p, c), 0) / line.length]
}

function isDot(line: Polyline): boolean {
  if (line.length < 8 || dist(line[0]!, line.at(-1)!) > 0.05) return false
  const [c, mean] = dotCircle(line)
  return mean > 0 && line.every((p) => Math.abs(dist(p, c) - mean) <= DOT_ROUNDNESS * mean)
}

function findBars(drawings: Drawing[], barLayers: string[], roi: Roi | null): [Shape[], Drawing[], string] {
  if (barLayers.length) {
    const paths = drawings.filter((p) => barLayers.includes(p.layer) && p.type.includes("s"))
    let lines: Polyline[] = []
    for (const p of paths) {
      const r = p.rect
      if (roi && (r.x1 < roi.x0 || r.x0 > roi.x1 || r.y1 < roi.y0 || r.y0 > roi.y1)) continue
      lines.push(...pathPolylines(p))
    }
    // Section dots, and the strokes that fill them (hatch lines, or a zigzag of thin filled
    // triangles): drawn within the dot, straight or doubling back on themselves. A link's bend
    // also lies on the dot's edge, but it is a smooth arc that never doubles back
    const dots = lines.filter(isDot).map(dotCircle)
    const zigzags = (line: Polyline) => line.slice(2).some((c, k) => {
      const [a, b] = [line[k]!, line[k + 1]!]
      const [u, v] = [[b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]]
      return u[0]! * v[0]! + u[1]! * v[1]! < -0.5 * Math.hypot(u[0]!, u[1]!) * Math.hypot(v[0]!, v[1]!)
    })
    const inDot = (line: Polyline) => (line.length === 2 || zigzags(line))
      && dots.some(([c, r]) => line.every((p) => dist(p, c) <= DOT_FILL_REACH * r))
    lines = lines.filter((line) => !isDot(line) && !inDot(line))
    // CAD exports often draw each piece of a bar (straight, bend arc, leg) as its own
    // path with ends slightly apart; join ends closer than a share of the line width
    const widths = paths.map((p) => p.width ?? 0).sort((a, b) => a - b)
    const tol = widths.length
      ? Math.min(0.5, Math.max(MIN_JOIN_TOL, JOIN_SHARE_OF_WIDTH * widths[Math.floor(widths.length / 2)]!))
      : null
    const shapes = shapesFromLines(joinPolylines(lines, tol).map((line) => [line, "layer"] as const))
    return [shapes, paths, `layer ${barLayers.join(", ")}`]
  }
  return [detectShapes(drawings, roi), [], "black/gray lines"]
}

// ---------------------------------------------------------------- dimensions

// Measuring points of small filled markers: arrow tip or tick/dot centre
function markerPoints(drawings: Drawing[], maxSize = MAX_MARKER_SIZE): Pt[] {
  const points: Pt[] = []
  for (const path of drawings) {
    const r = path.rect
    if (!path.type.includes("f") || Math.max(width(r), height(r)) > maxSize) continue
    const verts: Pt[] = []
    for (const poly of pathPolylines(path)) {
      for (const q of poly) if (verts.every((v) => dist(q, v) > 1e-3)) verts.push(q)
    }
    if (verts.length === 3) {
      // Arrowhead: the tip is the corner opposite the shortest edge
      const [v0, v1, v2] = verts as [Pt, Pt, Pt]
      const edges = [dist(v1, v2), dist(v0, v2), dist(v0, v1)]
      points.push(verts[edges.indexOf(Math.min(...edges))]!)
    } else {
      points.push([(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2])
    }
  }
  return points
}

// Short stroked lines that may be dimension ends: slash ticks or extension-line stubs.
// Filled shapes are markers, never ticks (an arrowhead's back edge crosses the line too)
function tickSegments(drawings: Drawing[]): [Pt, Pt][] {
  const ticks: [Pt, Pt][] = []
  for (const path of drawings) {
    if (!path.type.includes("s") || path.type.includes("f")) continue
    for (const item of path.items) {
      if (item[0] !== "l") continue
      const length = dist(item[1], item[2])
      if (length >= 0.5 && length <= MAX_TICK_LENGTH) ticks.push([item[1], item[2]])
    }
  }
  return ticks
}

// Straight segments of the given paths, with collinear pieces joined
function candidateLines(paths: Drawing[]): Line[] {
  const groups = new Map<string, [Pt, Pt, Pt][]>()
  for (const path of paths) {
    if (!path.type.includes("s")) continue
    for (const item of path.items) {
      if (item[0] !== "l") continue
      let [a, b] = [item[1], item[2]]
      if (dist(a, b) < 0.5) continue
      let u = unit(a, b)
      if (u[0] < -1e-9 || (Math.abs(u[0]) <= 1e-9 && u[1] < 0)) [a, b, u] = [b, a, [-u[0], -u[1]]]
      const offset = -a[0] * u[1] + a[1] * u[0]
      const key = `${round((Math.atan2(u[1], u[0]) * 180) / Math.PI, 1)},${Math.round(offset / 0.05)}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push([a, b, u])
    }
  }

  const lines: Line[] = []
  for (const pieces of groups.values()) {
    const [origin, , u] = pieces[0]!
    const spans = pieces
      .map(([a, b]): [number, number] => [project(a, origin, u)[0], project(b, origin, u)[0]])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])
    let cur = [...spans[0]!] as [number, number]
    for (const [s0, s1] of spans.slice(1)) {
      const gap = s0 - cur[1]
      if (gap <= LINE_JOIN_GAP * Math.max(cur[1] - cur[0], s1 - s0)) {
        cur[1] = Math.max(cur[1], s1)
      } else {
        lines.push([origin, u, cur[0], cur[1]])
        cur = [s0, s1]
      }
    }
    lines.push([origin, u, cur[0], cur[1]])
  }
  return lines
}

// Pairs of consecutive markers lying on one line. Filled markers count where they
// sit; stroked ticks count where they cross the line
function dimensionIntervals(lines: Line[], markers: Pt[], ticks: [Pt, Pt][] = []): Dimension[] {
  const grid = new Grid<Pt>()
  for (const m of markers) grid.add(m, m[0], m[1], m[0], m[1])
  const tickGrid = new Grid<[Pt, Pt]>()
  for (const t of ticks) {
    tickGrid.add(t, Math.min(t[0][0], t[1][0]), Math.min(t[0][1], t[1][1]), Math.max(t[0][0], t[1][0]), Math.max(t[0][1], t[1][1]))
  }
  const minSin = Math.sin((MIN_TICK_ANGLE * Math.PI) / 180)

  const intervals: Dimension[] = []
  const seen = new Set<string>()
  for (const [origin, u, t0, t1] of lines) {
    const reach = MARKER_BEYOND_END + 0.15 * (t1 - t0)
    const a: Pt = [origin[0] + u[0] * (t0 - reach), origin[1] + u[1] * (t0 - reach)]
    const b: Pt = [origin[0] + u[0] * (t1 + reach), origin[1] + u[1] * (t1 + reach)]
    const found: [number, Pt][] = []
    for (const m of grid.query(Math.min(a[0], b[0]) - 1, Math.min(a[1], b[1]) - 1,
      Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1)) {
      const [along, across] = project(m, origin, u)
      // The end is where the marker sits along the line, on the line itself: a marker a
      // little off the line would tilt the interval and turn its text the wrong way up
      if (Math.abs(across) <= MARKER_ON_LINE && t0 - reach <= along && along <= t1 + reach) {
        found.push([along, [origin[0] + u[0] * along, origin[1] + u[1] * along]])
      }
    }
    if (ticks.length) {
      for (const [ta, tb] of tickGrid.query(Math.min(a[0], b[0]) - MAX_TICK_LENGTH, Math.min(a[1], b[1]) - MAX_TICK_LENGTH,
        Math.max(a[0], b[0]) + MAX_TICK_LENGTH, Math.max(a[1], b[1]) + MAX_TICK_LENGTH)) {
        const [alA, acA] = project(ta, origin, u)
        const [alB, acB] = project(tb, origin, u)
        if (acA * acB > 0 || Math.abs(acA - acB) < minSin * dist(ta, tb)) continue // misses the line, or too flat
        const along = alA + (acA / (acA - acB)) * (alB - alA)
        if (t0 - reach <= along && along <= t1 + reach) {
          found.push([along, [origin[0] + u[0] * along, origin[1] + u[1] * along]])
        }
      }
    }
    found.sort((x, y) => x[0] - y[0] || x[1][0] - y[1][0] || x[1][1] - y[1][1])
    const stops: [number, Pt][] = []
    for (const [along, m] of found) {
      if (!stops.length || along - stops.at(-1)![0] > 0.2) stops.push([along, m])
    }
    for (let i = 0; i < stops.length - 1; i++) {
      const [s0, p1] = stops[i]!
      const [s1, p2] = stops[i + 1]!
      if (s1 - s0 < 0.5) continue
      const key = [p1[0], p1[1], p2[0], p2[1]].map((v) => round(v, 1)).join(",")
      if (!seen.has(key)) {
        seen.add(key)
        intervals.push({ p1, p2, length_pt: s1 - s0, u, text: "", value: null, scale: null })
      }
    }
  }
  return intervals
}

// Reading direction u (left to right / bottom to top) and "down" v of a dimension's text
function textFrame(p1: Pt, p2: Pt): [Pt, Pt] {
  let u = unit(p1, p2)
  // Within a few degrees of vertical counts as vertical (plot rounding tilts lines slightly)
  if (Math.abs(u[0]) <= NEAR_VERTICAL ? u[1] > 0 : u[0] < 0) u = [-u[0], -u[1]]
  return [u, [-u[1], u[0]]]
}

// The text strokes of the number next to a dimension line (or null)
function glyphBlob(dim: Dimension, grid: Grid<Glyph>): Blob | null {
  const { p1, p2 } = dim
  const [u] = textFrame(p1, p2)
  const mid: Pt = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]
  const half = dim.length_pt / 2
  const reach = MAX_TEXT_DISTANCE + 0.1 * dim.length_pt
  // Search a band along the line, not a square around it
  const band = reach + MAX_GLYPH_SIZE
  const xs = [p1[0], p2[0]]
  const ys = [p1[1], p2[1]]

  const near: Near[] = []
  for (const g of grid.query(Math.min(...xs) - band, Math.min(...ys) - band,
    Math.max(...xs) + band, Math.max(...ys) + band)) {
    const coords = g.corners.map((q) => project(q, mid, u))
    const al = coords.map((c) => c[0])
    const ac = coords.map((c) => c[1])
    const [c0, c1] = [Math.min(...ac), Math.max(...ac)]
    if (c0 < 0.05 && c1 > -0.05) continue // crosses the line: extension line, marker, not text
    near.push([g, Math.min(...al), Math.max(...al), c0, c1])
  }

  const gapTo = (n: Near) => Math.min(Math.abs(n[3]), Math.abs(n[4]))
  const seeds = near.filter((n) => n[1] < half && n[2] > -half && gapTo(n) <= reach)
  if (!seeds.length) return null
  const score = (n: Near) => gapTo(n) + 0.3 * Math.abs((n[1] + n[2]) / 2)
  const seed = seeds.reduce((best, n) => (score(n) < score(best) ? n : best))
  const blob = [seed]
  let [, a0, a1, c0, c1] = seed
  let grew = true
  while (grew) {
    grew = false
    const h = Math.max(c1 - c0, 0.5)
    for (const n of near) {
      if (blob.includes(n)) continue
      if (n[3] > c1 + 0.25 * h || n[4] < c0 - 0.25 * h) continue
      if (n[1] > a1 + 0.8 * h || n[2] < a0 - 0.8 * h) continue
      blob.push(n)
      ;[a0, a1, c0, c1] = [Math.min(a0, n[1]), Math.max(a1, n[2]), Math.min(c0, n[3]), Math.max(c1, n[4])]
      grew = true
    }
    if (blob.length > MAX_TEXT_STROKES) return null // far too much to be one number: hatching, a table, ...
  }
  return [blob.map((n) => n[0]), [a0, a1, c0, c1], mid, u]
}

// Draw the number's strokes black on white, reading left to right
// (turned half a turn when flip is set, for text written the other way round)
function renderBlob(blob: Blob, textHeight: number, flip = false): Promise<Buffer> {
  const [glyphs, [a0, a1, c0, c1], mid, u] = blob
  const zoom = textHeight / Math.max(c1 - c0, 0.3)
  const margin = 0.4 * (c1 - c0) + 0.2
  const w = Math.trunc((a1 - a0 + 2 * margin) * zoom) + 1
  const h = Math.trunc((c1 - c0 + 2 * margin) * zoom) + 1
  if (w * h > 4e6) return strokesPng(1, 1, [], 1)
  const polylines = glyphs.flatMap((g) => g.polylines.map((poly) => poly.map((q): Pt => {
    const [al, ac] = project(q, mid, u)
    return flip
      ? [Math.trunc((a1 - al + margin) * zoom), Math.trunc((c1 - ac + margin) * zoom)]
      : [Math.trunc((al - a0 + margin) * zoom), Math.trunc((ac - c0 + margin) * zoom)]
  })))
  return strokesPng(w, h, polylines, Math.max(2, Math.floor(textHeight / 12)))
}

// OCR at several sizes and vote: single OCR runs misread digits (5 -> 3) now and then.
// Round 1 reads every number at two sizes; if both agree it is accepted. The rest
// that look like numbers are read at the other sizes and the majority wins.
// With bothWays, numbers that do not read are read again turned half a turn
// (rotated sheets: "800" upside down reads "008")
async function ocrBlobs(blobs: Blob[], bothWays = false): Promise<string[]> {
  const results = blobs.map(() => "")
  const todo = blobs.flatMap(([, [a0, a1, c0, c1]], i) =>
    a1 - a0 <= MAX_TEXT_ASPECT * Math.max(c1 - c0, 0.1) ? [i] : []) // wider is not a number
  await ocrVote(blobs, todo, results, false)
  if (bothWays) {
    const again = todo.filter((i) => !DIM_NUMBER.test(results[i]!))
    const flipped = blobs.map(() => "")
    await ocrVote(blobs, again, flipped, true)
    for (const i of again) if (DIM_NUMBER.test(flipped[i]!)) results[i] = flipped[i]!
  }
  return results
}

async function ocrVote(blobs: Blob[], todo: number[], results: string[], flip: boolean) {
  const number = DIM_NUMBER
  const reads = new Map<number, string[]>(todo.map((i) => [i, []]))
  const readAt = async (indexes: number[], h: number) => {
    const texts = await ocrImages(await Promise.all(indexes.map((i) => renderBlob(blobs[i]!, h, flip))), OCR_WHITELIST)
    indexes.forEach((i, k) => reads.get(i)!.push(texts[k]!))
  }
  for (const h of OCR_HEIGHTS.slice(0, 2)) await readAt(todo, h)
  const vote: number[] = []
  for (const i of todo) {
    const r = reads.get(i)!
    if (r[0] === r[1] && number.test(r[0]!)) results[i] = r[0]!
    else if (r.some((t) => /\d{2}/.test(t))) vote.push(i)
    else results[i] = r[0]! // a letter or a label, not a number
  }
  for (const h of OCR_HEIGHTS.slice(2)) await readAt(vote, h)
  for (const i of vote) {
    const r = reads.get(i)!
    const top = mostCommon(r.filter((t) => number.test(t)))[0]
    results[i] = top && top[1] >= 2 ? top[0] : "?" + r[0] // no agreement: not trusted
  }
}

// Numbers in the PDF's real text: [value, centre, size]
function textWords(page: mupdf.Page): [number, Pt, number][] {
  const words: [number, Pt, number][] = []
  for (const { text, rect: r } of getWords(page)) {
    const w = text.replace(/,/g, "")
    if (/^\d{2,6}$/.test(w)) words.push([Number(w), [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2], Math.max(width(r), height(r))])
  }
  return words
}

// strokedTicks (second try): also take stroked ticks and larger arrowheads as dimension
// ends, and read rotated text both ways
async function readDimensions(
  page: mupdf.Page, drawings: Drawing[], barPaths: Drawing[], dimLayers: string[], strokedTicks = false,
): Promise<Dimension[]> {
  const barSet = new Set(barPaths)
  const other = drawings.filter((p) => !barSet.has(p))
  const linePaths = dimLayers.length ? other.filter((p) => dimLayers.includes(p.layer)) : other
  // The second try also takes larger arrowheads (up to a tick's length)
  const ticks = strokedTicks ? tickSegments(linePaths) : []
  const markers = markerPoints(other, strokedTicks ? MAX_TICK_LENGTH : MAX_MARKER_SIZE)
  const dims = dimensionIntervals(candidateLines(linePaths), markers, ticks)

  const words = textWords(page)
  const grid = new Grid<Glyph>(MAX_GLYPH_SIZE)
  for (const p of other) {
    const r = p.rect
    if (p.type.includes("s") && Math.max(width(r), height(r)) <= MAX_GLYPH_SIZE) {
      const polylines = pathPolylines(p)
      if (polylines.length) {
        grid.add({ polylines, corners: [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]] }, r.x0, r.y0, r.x1, r.y1)
      }
    }
  }

  const jobs: [Dimension, Blob][] = []
  for (const d of dims) {
    d.text = ""
    d.source = null
    const mid: Pt = [(d.p1[0] + d.p2[0]) / 2, (d.p1[1] + d.p2[1]) / 2]
    const [u] = textFrame(d.p1, d.p2)
    const reach = MAX_TEXT_DISTANCE + 0.1 * d.length_pt
    let best: [number, number] | null = null
    for (const [value, c, size] of words) {
      const [along, across] = project(c, mid, u)
      if (Math.abs(along) <= d.length_pt / 2 && Math.abs(across) <= reach + size) {
        const score = Math.abs(across) + 0.3 * Math.abs(along)
        if (!best || score < best[0]) best = [score, value]
      }
    }
    if (best) {
      d.text = String(best[1])
      d.source = "pdf text"
      continue
    }
    const blob = glyphBlob(d, grid)
    if (blob) jobs.push([d, blob])
  }

  const texts = await ocrBlobs(jobs.map(([, blob]) => blob), strokedTicks)
  jobs.forEach(([d], i) => {
    d.text = texts[i]!
    d.source = "ocr"
  })

  for (const d of dims) {
    d.value = DIM_NUMBER.test(d.text) ? Number(d.text) : null
    d.scale = d.value ? d.value / d.length_pt : null
  }
  return dims
}

function isStandardRatio(ratio: number, tol = 0.01): boolean {
  return STANDARD_SCALES.some((a) => STANDARD_SCALES.some((b) => Math.abs(ratio / (a / b) - 1) <= tol))
}

// The scale most dimensions agree on once plot rounding is allowed for, from those dimensions only.
// A misread number or an overridden text shifts a plain average but does not fit this consensus
function consensusScale(dims: Dimension[]): number {
  const events: [scale: number, change: number][] = []
  for (const d of dims) {
    if (d.length_pt <= PLOT_ROUNDING) continue
    events.push([d.value! / (d.length_pt + PLOT_ROUNDING), 1], [d.value! / (d.length_pt - PLOT_ROUNDING), -1])
  }
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let [open, most, best] = [0, 0, 0]
  events.forEach(([scale, change], i) => {
    open += change
    if (open > most) {
      most = open
      best = (scale + events[i + 1]![0]) / 2
    }
  })
  const agree = dims.filter((d) => Math.abs(d.value! / best - d.length_pt) <= PLOT_ROUNDING)
  const used = agree.length ? agree : dims
  const average = used.reduce((sum, d) => sum + d.value!, 0) / used.reduce((sum, d) => sum + d.length_pt, 0)
  // Short dimensions placed on one drawing grid all round the same way (every 800 reading
  // 21.12 pt where 21.075 is true), which biases the average; the scale can only lie where
  // every agreeing dimension allows it, so keep the average inside that range (if there is one)
  if (!agree.length) return average
  const low = Math.max(...agree.map((d) => d.value! / (d.length_pt + PLOT_ROUNDING)))
  const high = Math.min(...agree.map((d) => d.value! / (d.length_pt - PLOT_ROUNDING)))
  return low <= high ? Math.min(high, Math.max(low, average)) : average
}

// Scale groups with the main one merged from its rounding-split parts, or [] when
// too few dimensions back the main scale to trust it
function trustedGroups(dims: Dimension[]): ScaleGroup[] {
  let groups = scaleGroups(dims)
  if (!groups.length) return []
  // The main scale is the one that covers the most of the drawing: the largest total
  // dimension length, not the most dimensions. Many small 1:25 sections can carry as
  // many dimensions as the long elevations they belong to
  const extent = (g: ScaleGroup) => dims.filter((d) => d.group_scale === g.scale).reduce((sum, d) => sum + d.length_pt, 0)
  groups.sort((a, b) => extent(b) - extent(a))
  // Groups only slightly off the main one are the same scale: merge them
  const main = groups[0]!.scale
  const merged = new Set(groups.filter((g) => Math.abs(g.scale / main - 1) <= SAME_SCALE).map((g) => g.scale))
  const mergedDims = dims.filter((d) => merged.has(d.group_scale ?? NaN))
  if (mergedDims.length < MIN_SCALE_DIMENSIONS) {
    for (const d of dims) d.group_scale = null
    return []
  }
  // Rounding splits one scale into groups, each biased its own way: only all of them together are true
  const mergedScale = consensusScale(mergedDims)
  groups = [{ scale: mergedScale, count: mergedDims.length }, ...groups.slice(1).filter((g) =>
    !merged.has(g.scale) && isStandardRatio(g.scale / main))]
  for (const d of mergedDims) d.group_scale = mergedScale
  const kept = new Set(groups.map((g) => g.scale))
  for (const d of dims) if (!kept.has(d.group_scale ?? NaN)) d.group_scale = null
  return groups
}

// A few of the longest dimensions behind a scale, as "1400 = 44.10 pt"
function scaleExamples(dims: Dimension[], scale: number): string {
  const seen = new Set<number>()
  return dims
    .filter((d) => d.group_scale === scale)
    .sort((a, b) => b.length_pt - a.length_pt)
    .filter((d) => !seen.has(d.value!) && seen.add(d.value!))
    .slice(0, 3)
    .map((d) => `${d.value} = ${d.length_pt.toFixed(2)} pt`)
    .join(", ")
}

// mm per pt from a "SCALE 1:N" label in real text, assuming a true-size plot
function scaleFromLabel(page: mupdf.Page): [number | null, number | null] {
  const found = [...getText(page).matchAll(/SCALE\s*[-:=]?\s*1\s*[:/]\s*(\d+)/gi)].map((m) => m[1]!)
  if (!found.length) return [null, null]
  const n = Number(mostCommon(found)[0]![0])
  return [(25.4 / 72) * n, n]
}

// ---------------------------------------------------------------- output

async function draw(page: mupdf.Page, shapes: Shape[], dpi: number, roi: Roi | null, outDir: string, pageNo: number) {
  const img = await renderPage(page, dpi, roi)
  const svg = shapesSvg(shapes, shapes.map((s) => `${s.tag} ${s.length_mm}`), img)
  await saveOverlay(img, svg,
    path.join(outDir, `page${pageNo}_shapes.png`), path.join(outDir, `page${pageNo}_shapes_only.png`))
}

function probe(
  page: mupdf.Page, drawings: Drawing[], dimLayers: string[], barMode: string,
  shapes: Shape[], dims: Dimension[], groups: ScaleGroup[],
) {
  const layers = mostCommon(drawings.map((p) => p.layer || "(none)")).slice(0, 15)
  const colors = mostCommon(
    drawings.filter((p) => p.color).map((p) => JSON.stringify([p.color!.map((v) => round(v, 2)), round(p.width ?? 0, 2)])),
  ).slice(0, 8)
  const [x0, y0, x1, y1] = page.getBounds()
  console.log(`  size ${(x1 - x0).toFixed(0)} x ${(y1 - y0).toFixed(0)} pt, ${drawings.length} paths,`
    + ` ${textWords(page).length} numbers in PDF text`)
  console.log(`  layers: ${JSON.stringify(Object.fromEntries(layers))}`)
  console.log(`  stroke colors (rgb, width): ${colors.map(([k, n]) => `${k} x${n}`).join(", ")}`)
  console.log(`  bars from: ${barMode} -> ${shapes.length} shapes`)
  console.log(`  dimension lines from: ${dimLayers.length ? "layer " + dimLayers.join(", ") : "any layer"}`
    + ` -> ${dims.length} marked intervals, ${dims.filter((d) => d.value).length} with a number`)
  const read = mostCommon(dims.filter((d) => d.text).map((d) => `${d.text} (${d.source})`)).slice(0, 25)
  console.log(`  text read (text, source): ${read.map(([k, n]) => `${k} x${n}`).join(", ")}`)
  for (const g of groups) console.log(`  scale group: ${g.scale.toFixed(3)} mm per pt (${g.count} dimensions)`)
}

// ---------------------------------------------------------------- main

async function processPage(page: mupdf.Page, pageNo: number, args: Args, roi: Roi | null): Promise<PageResult | null> {
  const drawings = getDrawings(page)
  const barLayers = findBarLayers(drawings, args.barLayer)
  if (args.barLayer && !barLayers.length) {
    console.log(`  warning: no layer named '${args.barLayer}'; using black/gray lines`)
  }
  const layerNames = [...new Set(drawings.map((p) => p.layer))]
  const dimLayers = args.dimLayer
    ? layerNames.filter((n) => n.toLowerCase() === args.dimLayer!.toLowerCase())
    : layerNames.filter((n) => n && DIM_LAYER_PATTERN.test(n))

  const [shapes, barPaths, barMode] = findBars(drawings, barLayers, roi)

  let dims: Dimension[] = []
  let groups: ScaleGroup[] = []
  let mainScale: number | null
  let scaleNote: string | null
  if (args.mmPerPt) {
    [mainScale, scaleNote] = [args.mmPerPt, "given (--mm-per-pt)"]
  } else if (args.scale) {
    [mainScale, scaleNote] = [(25.4 / 72) * args.scale, `given (--scale 1:${args.scale})`]
  } else {
    // First filled arrowheads/ticks only; if that gives no trusted scale, also stroked
    // ticks (slashes, extension stubs) with rotated text read both ways
    let how = ""
    dims = await readDimensions(page, drawings, barPaths, dimLayers)
    groups = trustedGroups(dims)
    if (!groups.length) {
      dims = await readDimensions(page, drawings, barPaths, dimLayers, true)
      groups = trustedGroups(dims)
      how = ", second try: stroked ticks / large arrows"
    }
    if (groups.length) {
      mainScale = groups[0]!.scale
      scaleNote = `from ${groups[0]!.count} dimensions${how}`
      console.log(`  scale: ${mainScale.toFixed(3)} mm per pt = 1:${(mainScale / (25.4 / 72)).toFixed(1)} on paper; `
        + `${groups[0]!.count} dimensions agree, e.g. ${scaleExamples(dims, mainScale)}`)
    } else {
      const [scale, n] = scaleFromLabel(page)
      mainScale = scale
      scaleNote = scale ? `from label SCALE 1:${n} (assumes true-size plot)` : null
    }
  }

  if (args.probe) probe(page, drawings, dimLayers, barMode, shapes, dims, groups)
  if (mainScale === null) {
    console.log(`  page ${pageNo}: no scale found (no readable dimensions, no SCALE label).`
      + " Use --scale N or --mm-per-pt X, or --probe to see what the page contains.")
    return null
  }

  // Vertical scale: given, or assumed equal to the horizontal one
  let scaleY: number
  let scaleYNote: string
  if (args.mmPerPtY || args.scaleY) {
    scaleY = args.mmPerPtY || (25.4 / 72) * args.scaleY!
    scaleYNote = "given"
  } else if (args.verticalRatio) {
    scaleY = mainScale / args.verticalRatio
    scaleYNote = `horizontal / ${args.verticalRatio} (given --vertical-ratio)`
  } else {
    scaleY = mainScale
    const vertical = dims.filter((d) => d.group_scale === mainScale && Math.abs(d.p1[0] - d.p2[0]) < 0.05)
    scaleYNote = vertical.length
      ? `same as horizontal (checked by ${vertical.length} vertical dimensions)`
      : "ASSUMED same as horizontal: no vertical dimensions to check it"
  }
  measure(shapes, groups.length ? dims : [], mainScale, scaleY)
  shapes.forEach((s, i) => (s.tag = `#${i + 1}`))

  // Which beam each shape belongs to, from the beam titles ("B47 (300x600)")
  const titles = findBeamTitles(page)
  const assignment = assignBeams(shapes, titles)
  shapes.forEach((s, i) => {
    const [t, also] = assignment.beams[i]!
    s.beam = t?.label ?? null
    s.beam_size = t?.size ?? null
    s.also_in = also.map((a) => a.label)
  })
  const inBeams = shapes.filter((s) => s.beam).length
  console.log(`  beams: ${titles.length} titles; ${inBeams} of ${shapes.length} shapes assigned`
    + `${shapes.some((s) => s.also_in!.length) ? `, ${shapes.filter((s) => s.also_in!.length).length} run on into a neighbouring beam` : ""}`
    + `${titles.length ? "" : " (no beam titles in the PDF text)"}`)

  // Check the scale against the beam depths in the titles
  const barSet = new Set(barPaths)
  const lines = drawings.filter((p) => !barSet.has(p) && p.type.includes("s"))
    .flatMap((p) => p.items.filter((it) => it[0] === "l").map((it) => [it[1], it[2]] as [Pt, Pt]))
  const verdict = depthVerdict(checkDepths(shapes, assignment, lines, scaleY))
  if (verdict.status === "confirmed") {
    console.log(`  scale check: ${verdict.text}`)
    if (scaleYNote.startsWith("ASSUMED")) scaleYNote = "same as horizontal (checked by beam depths)"
  } else if (verdict.status === "unchecked") {
    console.log(`  scale check: ${verdict.text}`)
  } else {
    console.log(`  WARNING: ${verdict.text}`)
    if (verdict.status === "exaggerated" && scaleYNote.startsWith("ASSUMED")) {
      scaleYNote = `same as horizontal, but beams are drawn ${verdict.factor}x deep (lengths as drawn)`
    }
  }
  // No beam titles to check against: the sections' depth dimensions tell the depths instead,
  // and elevations drawn N times deeper than their horizontal scale are measured at 1/N vertically
  let [depthText, depthStatus] = [verdict.text, verdict.status as DepthStatus]
  if (verdict.status === "unchecked" && scaleYNote.startsWith("ASSUMED")) {
    const check = sectionDepthCheck(shapes, (s) => s.mm_per_pt === round(mainScale!, 3), lines, dims, mainScale)
    console.log(`  scale check (sections): ${check.text}`)
    if (check.factor === 1) {
      scaleYNote = "same as horizontal (checked by section depths)"
      ;[depthText, depthStatus] = [check.text, "confirmed"]
    } else if (check.factor) {
      // The elevations' dimensions read N times what is drawn (a dimension scale factor, e.g.
      // DIMLFAC 2 on elevations squashed along the beam): the true drawing scale is the sections'
      // one. Lengths are as drawn, the same as the CAD program's length of each bar
      const dimsScale = mainScale
      // That group must be dimensioned both ways (a section's width and depth): a group of
      // vertical dimensions only is the elevations' own depths, overridden to read less than
      // drawn (depths drawn N times deep), and then the main scale is the drawing scale
      const both = (g: ScaleGroup) => {
        const own = dims.filter((d) => d.group_scale === g.scale)
        const vertical = own.filter((d) => Math.abs(d.p1[0] - d.p2[0]) <= NEAR_VERTICAL * d.length_pt).length
        return vertical > 0 && own.length - vertical > 0
      }
      const drawing = groups.find((g) => Math.abs((g.scale * check.factor!) / dimsScale - 1) <= 0.01 && both(g))
      if (drawing) {
        mainScale = scaleY = drawing.scale
        measure(shapes, dims.filter((d) => d.group_scale !== dimsScale), mainScale)
        scaleNote = `from ${drawing.count} section dimensions (elevation dimensions read ${check.factor}x the drawing)`
        scaleYNote = "same as horizontal (as drawn; checked by section depths)"
        ;[depthText, depthStatus] = [`${check.text}: their dimensions read ${check.factor}x what is drawn, `
          + `lengths are as drawn at ${mainScale.toFixed(3)} mm per pt`, "corrected"]
        console.log(`  drawing scale: ${mainScale.toFixed(3)} mm per pt (sections); elevation dimensions read `
          + `${check.factor}x the drawing (${dimsScale.toFixed(3)} mm per pt); lengths as drawn`)
      } else {
        ;[depthText, depthStatus] = [`${check.text}: lengths as drawn at the dimension scale`, "exaggerated"]
        console.log(`  WARNING: ${depthText}`)
        scaleYNote = `same as horizontal, but elevations are drawn ${check.factor}x deep (lengths as drawn)`
      }
    }
  }
  if (scaleYNote.startsWith("ASSUMED")) {
    console.log(`  warning: vertical scale ${scaleYNote}. If the sheet is not drawn to scale`
      + " vertically, give it with --vertical-ratio R, --scale-y N or --mm-per-pt-y X.")
  }

  console.log(`  page ${pageNo}: ${shapes.length} shapes (${barMode}), scale ${mainScale.toFixed(3)} mm/pt ${scaleNote}`)
  return {
    page: pageNo, mm_per_pt: round(mainScale, 4), scale_from: scaleNote!,
    mm_per_pt_vertical: round(scaleY, 4), vertical_scale_from: scaleYNote,
    bars_from: barMode, beam_titles: titles.length, shapes_in_beams: inBeams,
    depth_check: depthText, depth_status: depthStatus, shapes,
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pages: { type: "string" }, // "1,2"
      scale: { type: "string" },
      "mm-per-pt": { type: "string" },
      "scale-y": { type: "string" },
      "mm-per-pt-y": { type: "string" },
      "vertical-ratio": { type: "string" },
      "bar-layer": { type: "string" },
      "dim-layer": { type: "string" },
      roi: { type: "string" },
      dpi: { type: "string", default: "300" },
      out: { type: "string" },
      probe: { type: "boolean", default: false },
    },
  })
  const pdf = positionals[0]
  if (!pdf) {
    console.error("usage: bun src/rebar_finder.ts file.pdf [options]")
    process.exit(1)
  }
  const num = (v?: string) => (v === undefined ? undefined : Number(v))
  const args: Args = {
    pages: values.pages?.split(",").map(Number),
    scale: num(values.scale),
    mmPerPt: num(values["mm-per-pt"]),
    scaleY: num(values["scale-y"]),
    mmPerPtY: num(values["mm-per-pt-y"]),
    verticalRatio: num(values["vertical-ratio"]),
    barLayer: values["bar-layer"],
    dimLayer: values["dim-layer"],
    dpi: Number(values.dpi),
    probe: values.probe!,
  }

  const doc = await openPdf(pdf)
  const outDir = values.out ?? path.basename(pdf, path.extname(pdf)) + "_results"
  await mkdir(outDir, { recursive: true })
  const roi = parseRoi(values.roi)

  const results: PageResult[] = []
  const images = new Map<Shape, string>()
  const pages = args.pages ?? Array.from({ length: doc.countPages() }, (_, i) => i + 1)
  for (const pageNo of pages) {
    console.log(`Page ${pageNo}:`)
    const page = doc.loadPage(pageNo - 1)
    const result = await processPage(page, pageNo, args, roi)
    if (result) {
      await draw(page, result.shapes, args.dpi, roi, outDir, pageNo)
      const files = await saveShapeImages(result.shapes, outDir, pageNo)
      result.shapes.forEach((s, i) => images.set(s, files[i]!))
      results.push(result)
    }
  }

  const rows = results.flatMap((r) => r.shapes.map((s) => ({
    page: r.page,
    tag: s.tag,
    beam: s.beam ?? null,
    beam_size: s.beam_size ?? null,
    also_in: s.also_in ?? [],
    shape: s.name,
    type: s.type,
    true_length_mm: s.true_length_mm,
    length_to_corners_mm: s.length_mm,
    segments_mm: s.segments_mm!,
    straight_length_mm: s.straight_length_mm,
    straight_parts_mm: s.straight_mm!,
    points_pt: s.points,
    image: images.get(s),
  })))

  await Bun.write(path.join(outDir, "shapes.json"), JSON.stringify({
    pdf,
    pages: results.map(({ shapes, ...info }) => info),
    shapes: rows,
  }, null, 2))
  let csv = csvRow(["page", "tag", "beam", "beam_size", "also_in", "shape", "type", "true_length_mm", "length_to_corners_mm",
    "segments_mm", "straight_length_mm", "straight_parts_mm", "image"])
  for (const row of rows) {
    csv += csvRow([row.page, row.tag, row.beam ?? "", row.beam_size ?? "", row.also_in.join(" "), row.shape, row.type,
      row.true_length_mm, row.length_to_corners_mm,
      row.segments_mm.join(" + "), row.straight_length_mm, row.straight_parts_mm.join(" + "), row.image])
  }
  await Bun.write(path.join(outDir, "shapes.csv"), csv)
  console.log(`Saved ${rows.length} shapes to ${outDir}/ (shapes.json, shapes.csv, page images, shapes/*.png)`)
}

if (import.meta.main) await main()
