// Beam titles ("B47 (300x600)", "GB9,GB10 (350x450)", "B15") and which beam each shape belongs to.
//
// A title sits on one side of its detail: below it on most sheets, left of it on some.
// The side is found per page. Each shape then belongs to the nearest title on that side
// whose span covers it. Titles side by side (one drawing of a continuous beam B47 | B48)
// share the line between them at the middle: a bar that runs on into the next span is
// listed there too ("also").

import type * as mupdf from "mupdf"
import { getWords } from "./pdf_drawings"
import type { Dimension, Pt, Roi, Shape } from "./types"

export interface BeamTitle {
  label: string // "B47" or "GB9, GB10"
  size: string | null // "300x600"
  width_mm: number | null
  depth_mm: number | null
  rect: Roi
  text_height: number // height of the name's letters (pt)
}

type Side = "below" | "above" | "left" | "right"

// A beam name: letters with a B among them (B, GB, NGB, BKT), a number, an optional letter
const ONE = "[A-Z]{0,3}B[A-Z]{0,3}\\d{1,4}[A-Za-z]?"
const NAME = new RegExp(`^(${ONE})(?:\\s*[,&/]\\s*${ONE})*(?:-${ONE})?$`)
const NAME_PART = new RegExp(ONE, "g")
const SIZE = /^\(?(\d{2,4})\s*[xX]\s*(\d{2,4})\)?$/
// A name-only title must be about as tall as the titles that carry a size
const NAME_ONLY_HEIGHT = 0.95
// Sized text below this share of the typical title height is a callout, not a title
const CALLOUT_HEIGHT = 0.8
// Titles on one line (or one column, for titles beside their details) within this many
// title heights are one row and split the space between them
const ROW_TOLERANCE = 3
// A bar running on into a neighbouring span is listed there when at least this share of it lies there
const ALSO_SHARE = 0.25
// ... or when it passes under that span's title and covers at least this share of the span
const ALSO_SPAN_SHARE = 0.5
// A title alone in its row covers a span this many title lengths each side of its centre
const END_SPAN = 4
// A title sits on the side opposite the usual one only when a shape there is nearer than
// this share of the usual side's distance
const OTHER_SIDE_SHARE = 0.5
// A shape inside another's box, give or take this much (pt), is part of its detail
const CLUSTER_GAP = 1.0
// A title and a shape further apart than this many typical title-to-detail gaps are not partners
const PARTNER_REACH = 3

const cx = (r: Roi) => (r.x0 + r.x1) / 2
const cy = (r: Roi) => (r.y0 + r.y1) / 2

export function findBeamTitles(page: mupdf.Page): BeamTitle[] {
  const words = getWords(page).map((w) => ({ text: w.text.replace(/[_]/g, "").trim(), r: w.rect }))
  // A size written with spaces comes as three words ("230" "x" "575"): join them into one
  for (let i = 0; i + 2 < words.length; i++) {
    const [a, x, b] = [words[i]!, words[i + 1]!, words[i + 2]!]
    const h = a.r.y1 - a.r.y0
    const sameLine = (p: typeof a, q: typeof a) => Math.abs(cy(p.r) - cy(q.r)) < 0.5 * h && q.r.x0 > p.r.x1 - 0.5 && q.r.x0 - p.r.x1 < 1.5 * h
    if (/^\(?\d{2,4}$/.test(a.text) && /^[xX]$/.test(x.text) && /^\d{2,4}\)?$/.test(b.text) && sameLine(a, x) && sameLine(x, b)) {
      words.splice(i, 3, { text: `${a.text}x${b.text}`, r: { x0: a.r.x0, y0: Math.min(a.r.y0, b.r.y0), x1: b.r.x1, y1: Math.max(a.r.y1, b.r.y1) } })
    }
  }
  const titles: (Omit<BeamTitle, "text_height"> & { sized: boolean; h: number })[] = []
  const used = new Set<number>()
  words.forEach((w, i) => {
    // The name and size may be one word ("B1(200X575)") or two ("B47" "(300x600)")
    const joined = w.text.match(/^(.*?)(\(\d{2,4}\s*[xX]\s*\d{2,4}\))$/)
    const name = (joined ? joined[1]! : w.text).replace(/^SECTION$/i, "")
    if (!NAME.test(name)) return
    const h = w.r.y1 - w.r.y0
    let size: RegExpMatchArray | null = joined ? joined[2]!.match(SIZE) : null
    let rect = { ...w.r }
    if (!size) {
      // Next word on the same line, or right under the name
      const next = words.findIndex((v, j) => j !== i && !used.has(j) && SIZE.test(v.text) && (
        (Math.abs(cy(v.r) - cy(w.r)) < 0.5 * h && v.r.x0 > w.r.x1 - 0.5 && v.r.x0 - w.r.x1 < 1.5 * h)
        || (v.r.y0 > w.r.y0 + 0.5 * h && v.r.y0 - w.r.y1 < 1.0 * h && v.r.x0 < w.r.x1 && v.r.x1 > w.r.x0)))
      if (next >= 0) {
        size = words[next]!.text.match(SIZE)
        used.add(next)
        const r = words[next]!.r
        rect = { x0: Math.min(rect.x0, r.x0), y0: Math.min(rect.y0, r.y0), x1: Math.max(rect.x1, r.x1), y1: Math.max(rect.y1, r.y1) }
      }
    }
    const names = [...new Set(name.split("-")[0]!.match(NAME_PART) ?? [])]
    titles.push({
      label: names.join(", "),
      size: size ? `${size[1]}x${size[2]}` : null,
      width_mm: size ? Number(size[1]) : null,
      depth_mm: size ? Number(size[2]) : null,
      rect,
      sized: !!size,
      h,
    })
  })
  // A list of names continued on the next line ("B6,B7,...," over "B40,B42,...") is one title
  for (let i = 0; i < titles.length; i++) {
    const a = titles[i]!
    const j = titles.findIndex((b) => b !== a && !a.size && b.rect.y0 > a.rect.y0 + 0.5 * a.h
      && b.rect.y0 - a.rect.y1 < 0.6 * a.h && b.rect.x0 < a.rect.x1 && b.rect.x1 > a.rect.x0 && Math.abs(b.h - a.h) < 0.2 * a.h)
    if (j < 0) continue
    const b = titles[j]!
    a.label = [...new Set([...a.label.split(", "), ...b.label.split(", ")])].join(", ")
    Object.assign(a, { size: b.size, width_mm: b.width_mm, depth_mm: b.depth_mm, sized: b.sized })
    a.rect = { x0: Math.min(a.rect.x0, b.rect.x0), y0: a.rect.y0, x1: Math.max(a.rect.x1, b.rect.x1), y1: b.rect.y1 }
    titles.splice(j, 1)
    i--
  }
  // Name-only words are titles only when as tall as the sized ones (not small support labels)
  const heights = titles.filter((t) => t.sized).map((t) => t.h).sort((a, b) => a - b)
  const typical = heights.length ? heights[Math.floor(heights.length / 2)]! : 0
  return titles
    // Sized text much smaller than the titles is a callout tag beside a detail ("BKT6 (300x600)")
    .filter((t) => t.sized ? t.h >= CALLOUT_HEIGHT * typical : typical && t.h >= NAME_ONLY_HEIGHT * typical)
    .map(({ sized, h, ...t }) => ({ ...t, text_height: h }))
}

interface Box { x0: number; y0: number; x1: number; y1: number }

const shapeBox = (s: Shape): Box => {
  const xs = s.points.map((p) => p[0])
  const ys = s.points.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

// Coordinates turned so that the title side is "down" (v grows towards the titles) and
// u runs along the row of titles
function frame(side: Side) {
  return {
    u: (p: Pt) => (side === "below" || side === "above" ? p[0] : p[1]),
    v: (p: Pt) => (side === "below" ? p[1] : side === "above" ? -p[1] : side === "right" ? p[0] : -p[0]),
  }
}

function boxIn(b: Box, side: Side) {
  const f = frame(side)
  const corners: Pt[] = [[b.x0, b.y0], [b.x1, b.y1]]
  const us = corners.map(f.u)
  const vs = corners.map(f.v)
  return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) }
}

// The side of its detail a title sits on. Most titles of a sheet sit on one side (below
// their details, or left of them); a title takes another side when a shape there is nearer
const SIDES: Side[] = ["below", "above", "left", "right"]
function titleSides(titles: BeamTitle[], boxes: Box[]): Side[] {
  // Distance from each title to the nearest shape it could be on each side of
  const dist = titles.map((t) => {
    const r = t.rect
    const d: Record<Side, number> = { below: Infinity, above: Infinity, left: Infinity, right: Infinity }
    for (const b of boxes) {
      const gap = Math.hypot(Math.max(b.x0 - r.x1, r.x0 - b.x1, 0), Math.max(b.y0 - r.y1, r.y0 - b.y1, 0))
      if (b.y1 <= r.y0 + 1) d.below = Math.min(d.below, gap)
      if (b.y0 >= r.y1 - 1) d.above = Math.min(d.above, gap)
      if (b.x0 >= r.x1 - 1) d.left = Math.min(d.left, gap)
      if (b.x1 <= r.x0 + 1) d.right = Math.min(d.right, gap)
    }
    return d
  })
  const nearest = dist.map((d) => SIDES.reduce((a, b) => (d[b] < d[a] ? b : a)))
  const opposite: Record<Side, Side> = { below: "above", above: "below", left: "right", right: "left" }
  let usual = SIDES.reduce((a, b) => (nearest.filter((x) => x === b).length > nearest.filter((x) => x === a).length ? b : a))
  // Between rows of details a title can be nearer to the next row than to its own (a stirrup
  // table under each elevation, then its title). The true side pairs every row up: on the
  // wrong one the last row of titles has no details beyond it. Take the side that leaves
  // fewer titles without a detail
  let paired = Infinity // set when the rows pair up only on the side chosen here
  const gaps = dist.map((d) => Math.min(d[usual], d[opposite[usual]])).filter(Number.isFinite).sort((a, b) => a - b)
  if (gaps.length) {
    const reach = PARTNER_REACH * Math.max(gaps[Math.floor(gaps.length / 2)]!, 1)
    // Titles with no detail on that side (details with no readable title say nothing)
    const orphans = (side: Side) => dist.filter((d) => !(d[side] <= reach)).length
    if (orphans(opposite[usual]) < orphans(usual)) {
      usual = opposite[usual]
      paired = reach
    }
  }
  // A title between two rows of details is about as near to the row on the far side as to
  // its own: the opposite side must be clearly nearer. A side across (a section's title
  // below it on a sheet of titles beside their details) only needs to be nearer
  return nearest.map((side, i) => {
    if (side === usual) return side
    const share = side === opposite[usual] ? OTHER_SIDE_SHARE : 1
    // Rows paired up that way: a title has its own detail on that side, if any is within reach
    if (side === opposite[usual] && dist[i]![usual] <= paired) return usual
    return dist[i]![side] < share * dist[i]![usual] ? side : usual
  })
}

export interface BeamAssignment {
  sides: Side[] // per title
  titles: BeamTitle[]
  // per shape: [beam title or null, other beams the shape runs into]
  beams: [BeamTitle | null, BeamTitle[]][]
}

export function assignBeams(shapes: Shape[], titles: BeamTitle[]): BeamAssignment {
  const boxes = shapes.map(shapeBox)
  if (!titles.length || !shapes.length) return { sides: [], titles, beams: shapes.map(() => [null, []]) }
  const sides = titleSides(titles, boxes)

  // Each title in its own frame; its span along u reaches halfway to the neighbours in
  // its row (titles on the same side at about the same distance)
  const tb = titles.map((t, i) => {
    const side = sides[i]!
    const f = frame(side)
    return { t, side, ...boxIn(t.rect, side), c: f.u([cx(t.rect), cy(t.rect)]), vc: f.v([cx(t.rect), cy(t.rect)]),
      tol: ROW_TOLERANCE * Math.max(t.text_height, 1) }
  })
  const sameRow = (a: (typeof tb)[number], b: (typeof tb)[number]) => a.side === b.side && Math.abs(a.vc - b.vc) <= Math.max(a.tol, b.tol)
  // At the end of a row the span reaches as far as on its inner side, or a few title
  // lengths for a title alone in its row (a detail is a few times longer than its title)
  const spans = tb.map((a) => {
    let lo = -Infinity
    let hi = Infinity
    for (const b of tb) {
      // Neighbours stand beside the title, not over or under it
      if (b === a || !sameRow(a, b) || (b.u0 < a.u1 && b.u1 > a.u0)) continue
      if (b.c < a.c) lo = Math.max(lo, (a.c + b.c) / 2)
      else if (b.c > a.c) hi = Math.min(hi, (a.c + b.c) / 2)
    }
    const reach = Math.min(a.c - lo, hi - a.c, END_SPAN * (a.u1 - a.u0))
    return [Math.max(lo, a.c - reach), Math.min(hi, a.c + reach)] as const
  })

  const beams = boxes.map((b): [BeamTitle | null, BeamTitle[]] => {
    const found: [gap: number, overlap: number, i: number][] = []
    tb.forEach((t, i) => {
      const s = boxIn(b, t.side)
      // The title must lie wholly on its side of the shape ...
      if (t.v0 < s.v1 - 1) return
      // ... and its span must cover part of the shape
      const [lo, hi] = spans[i]!
      if (s.u1 < lo || s.u0 > hi) return
      found.push([t.v0 - s.v1, Math.min(s.u1, hi) - Math.max(s.u0, lo), i])
    })
    if (!found.length) return [null, []]
    // The nearest row; in it, the span holding most of the shape
    const nearest = tb[found.reduce((a, c) => (c[0] < a[0] ? c : a))[2]]!
    const own = tb[found.filter((c) => sameRow(tb[c[2]]!, nearest)).reduce((a, c) => (c[1] > a[1] ? c : a))[2]]!
    // Other spans of the same row the shape runs on into
    const s = boxIn(b, own.side)
    const len = s.u1 - s.u0
    const also: BeamTitle[] = []
    if (len > 2) {
      tb.forEach((t, i) => {
        if (t === own || !sameRow(t, own)) return
        const [lo, hi] = spans[i]!
        const overlap = Math.min(s.u1, hi) - Math.max(s.u0, lo)
        // A long bar through a row of short spans has a small share in each, yet covers them,
        // passing right under their titles
        const through = overlap >= ALSO_SPAN_SHARE * (hi - lo) && s.u0 <= t.u0 && s.u1 >= t.u1
        if (overlap >= ALSO_SHARE * len || through) also.push(t.t)
      })
    }
    return [own.t, also]
  })

  // A shape lying inside a bigger shape's box (an extra bar inside a beam's outline bars)
  // is part of that detail: if it took a title from another row (a section title nearby,
  // say), it moves to the row of the enclosing shape's title
  const size = (b: Box) => Math.hypot(b.x1 - b.x0, b.y1 - b.y0)
  const inside = (a: Box, b: Box) => a.x0 >= b.x0 - CLUSTER_GAP && a.x1 <= b.x1 + CLUSTER_GAP
    && a.y0 >= b.y0 - CLUSTER_GAP && a.y1 <= b.y1 + CLUSTER_GAP
  const index = new Map(titles.map((t, i) => [t, i]))
  const first = beams.map(([t]) => t)
  boxes.forEach((b, i) => {
    let host = -1
    boxes.forEach((c, j) => {
      if (j !== i && first[j] && size(c) > size(b) && inside(b, c) && (host < 0 || size(c) > size(boxes[host]!))) host = j
    })
    if (host < 0) return
    const top = tb[index.get(first[host]!)!]!
    const t = first[i]
    if (t && sameRow(tb[index.get(t)!]!, top)) return
    const s = boxIn(b, top.side)
    const mid = (s.u0 + s.u1) / 2
    const k = tb.findIndex((x, j) => sameRow(x, top) && mid >= spans[j]![0] && mid <= spans[j]![1])
    beams[i] = [k >= 0 ? tb[k]!.t : top.t, []]
  })
  return { sides, titles, beams }
}

// ---------------------------------------------------------------- depth check

export interface DepthCheck {
  beams: number // beams measured
  ratio: number | null // median of title depth / drawn depth (1.00 = the scale fits)
  agree: number // beams within DEPTH_TOLERANCE of 1
  details: { label: string; title_mm: number; drawn_mm: number }[]
}

// Drawn depths within this share of the title depth agree with the scale
const DEPTH_TOLERANCE = 0.03
// Outline lines are at least this share of the beam's bars long
const OUTLINE_SHARE = 0.3

// The beam's depth as drawn: between the outline lines just above its top bar and just
// below its bottom bar, against the depth in its title ("300x600" -> 600)
export function checkDepths(
  shapes: Shape[], assignment: BeamAssignment, lines: [Pt, Pt][], mmPerPtY: number,
): DepthCheck {
  const horizontal = lines.filter(([a, b]) => Math.abs(a[1] - b[1]) < 0.05 && Math.abs(a[0] - b[0]) > 5)
  const details: DepthCheck["details"] = []
  assignment.titles.forEach((t, ti) => {
    if (!t.depth_mm || assignment.sides[ti] === "above") return
    // The beam's horizontal bars (elevations; a section's bars are mostly vertical)
    const bars = shapes.filter((s, i) => assignment.beams[i]![0] === t)
    const flat = bars.flatMap((s) => s.points.slice(1).map((b, k): [Pt, Pt] => [s.points[k]!, b]))
      .filter(([a, b]) => Math.abs(a[1] - b[1]) < 0.05 && Math.abs(a[0] - b[0]) > 5)
    if (flat.length < 2) return
    const x0 = Math.min(...flat.map(([a, b]) => Math.min(a[0], b[0])))
    const x1 = Math.max(...flat.map(([a, b]) => Math.max(a[0], b[0])))
    if (x1 - x0 < 10) return
    const top = Math.min(...flat.map(([a]) => a[1]))
    const bottom = Math.max(...flat.map(([a]) => a[1]))
    if (bottom - top < 1) return
    const span = (l: [Pt, Pt]) => Math.min(x1, Math.max(l[0][0], l[1][0])) - Math.max(x0, Math.min(l[0][0], l[1][0]))
    const along = horizontal.filter((l) => span(l) >= OUTLINE_SHARE * (x1 - x0))
    const above = along.filter(([a]) => a[1] < top - 0.2).map(([a]) => a[1])
    const below = along.filter(([a]) => a[1] > bottom + 0.2).map(([a]) => a[1])
    if (!above.length || !below.length) return
    const drawn = (Math.min(...below) - Math.max(...above)) * mmPerPtY
    details.push({ label: t.label, title_mm: t.depth_mm, drawn_mm: Math.round(drawn) })
  })
  const ratios = details.map((d) => d.title_mm / d.drawn_mm).sort((a, b) => a - b)
  return {
    beams: details.length,
    ratio: ratios.length ? ratios[Math.floor(ratios.length / 2)]! : null,
    agree: ratios.filter((r) => Math.abs(r - 1) <= DEPTH_TOLERANCE).length,
    details,
  }
}

// corrected: the vertical scale was set from the section depths
export type DepthStatus = "confirmed" | "exaggerated" | "mismatch" | "unchecked" | "corrected"

// Beams needed before the depth check says anything
const MIN_DEPTH_BEAMS = 3

// What the beam depths say about the vertical scale: it fits (ratio about 1), the details
// are drawn N times deeper than they are (ratio about 1/N, a common way to show the bars),
// or it is off (a wrong scale, e.g. from a SCALE label on a sheet printed to fit)
export function depthVerdict(c: DepthCheck): { status: DepthStatus; factor: number | null; text: string } {
  if (c.beams < MIN_DEPTH_BEAMS || c.ratio === null) {
    return { status: "unchecked", factor: null, text: `not checked (${c.beams} beam depths readable, need ${MIN_DEPTH_BEAMS})` }
  }
  const ratios = c.details.map((d) => d.title_mm / d.drawn_mm)
  const near = ratios.filter((r) => Math.abs(r / c.ratio! - 1) <= DEPTH_TOLERANCE).length
  const of = `${near} of ${c.beams} beam depths`
  // A median the beams do not agree on says nothing (on a sheet whose elevations run up the
  // page the "depths" measured are section widths and gaps, all different)
  if (near < Math.max(MIN_DEPTH_BEAMS, c.beams / 2)) {
    return { status: "unchecked", factor: null, text: `not checked (beam depths disagree: ${of} near the median)` }
  }
  if (Math.abs(c.ratio - 1) <= DEPTH_TOLERANCE) {
    return { status: "confirmed", factor: 1, text: `confirmed: ${c.agree} of ${c.beams} beam depths match their titles` }
  }
  const n = Math.round(1 / c.ratio)
  if (n >= 2 && Math.abs(c.ratio * n - 1) <= DEPTH_TOLERANCE) {
    return { status: "exaggerated", factor: n, text: `beams drawn ${n}x deeper than their titles (${of}): `
      + `vertical legs are as drawn; --vertical-ratio ${n} gives real lengths` }
  }
  const pct = ((1 / c.ratio - 1) * 100).toFixed(1)
  return { status: "mismatch", factor: 1 / c.ratio, text: `beam depths come out ${pct}% off their titles (${of}): the scale may be wrong` }
}

// ---------------------------------------------------------------- depth check from sections

// Elevation bar runs at least this long (pt) are measured for the beam depth around them
const MIN_RUN = 20
// Section depth dimensions are at least this (mm): smaller vertical ones are covers, gaps
const MIN_SECTION_DEPTH = 150
// Drawn depths needed before the section check says anything
const MIN_SECTION_MATCHES = 3

export interface SectionDepthCheck {
  factor: number | null // elevations drawn this many times deeper than the horizontal scale gives
  matched: number // elevation depths that fit a section depth at that factor
  measured: number // elevation depths measured
  text: string
}

// Without readable beam titles the sections tell the depths: a sheet's 1:25 sections carry
// vertical dimensions (600, 450) at their own, true scale. The elevations around the main-scale
// bars are drawn between outline lines; measured with the horizontal scale they must come out
// as one of those depths. If they come out N times one of them (1200, 900), the elevations
// are drawn N times deeper than their horizontal scale: squashed along the beam, or
// exaggerated in depth. elevation(s) says whether a shape is outside every detail zone
export function sectionDepthCheck(
  shapes: Shape[], elevation: (s: Shape) => boolean, lines: [Pt, Pt][], dims: Dimension[], mainScale: number,
): SectionDepthCheck {
  const depths = [...new Set(dims.filter((d) => d.group_scale && d.group_scale !== mainScale && d.value
    && d.value >= MIN_SECTION_DEPTH && Math.abs(d.p1[0] - d.p2[0]) <= 0.05 * d.length_pt).map((d) => d.value!))]
  const none = (text: string): SectionDepthCheck => ({ factor: null, matched: 0, measured: 0, text })
  if (!depths.length) return none("not checked (no section depth dimensions)")

  const horizontal = lines.filter(([a, b]) => Math.abs(a[1] - b[1]) < 0.05 && Math.abs(a[0] - b[0]) > 5)
  const drawn: number[] = []
  const seen = new Set<string>()
  for (const s of shapes) {
    if (!elevation(s)) continue
    for (let i = 0; i < s.points.length - 1; i++) {
      const [a, b] = [s.points[i]!, s.points[i + 1]!]
      if (Math.abs(a[1] - b[1]) >= 0.05 || Math.abs(a[0] - b[0]) < MIN_RUN) continue
      const [x0, x1, y] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), a[1]]
      const span = (l: [Pt, Pt]) => Math.min(x1, Math.max(l[0][0], l[1][0])) - Math.max(x0, Math.min(l[0][0], l[1][0]))
      const along = horizontal.filter((l) => span(l) >= OUTLINE_SHARE * (x1 - x0))
      const above = along.filter(([p]) => p[1] < y - 0.2).map(([p]) => p[1])
      const below = along.filter(([p]) => p[1] > y + 0.2).map(([p]) => p[1])
      if (!above.length || !below.length) continue
      const [top, bottom] = [Math.max(...above), Math.min(...below)]
      const key = `${Math.round(top * 10)},${Math.round(bottom * 10)},${Math.round(x0)}`
      if (seen.has(key)) continue // the top and bottom bars of one beam see the same outline
      seen.add(key)
      drawn.push((bottom - top) * mainScale)
    }
  }
  const fits = (n: number) => drawn.filter((mm) => depths.some((d) => Math.abs(mm / n / d - 1) <= DEPTH_TOLERANCE)).length
  const support = [1, 2, 3, 4].map((n) => [n, fits(n)] as const)
  const [n, matched] = support.reduce((best, x) => (x[1] > best[1] ? x : best))
  const of = `${matched} of ${drawn.length} elevation depths`
  const sections = `section depths ${depths.sort((x, y) => x - y).join(", ")}`
  if (matched < MIN_SECTION_MATCHES || matched < 0.5 * drawn.length) {
    return { factor: null, matched, measured: drawn.length, text: `not checked (${of} fit the ${sections})` }
  }
  // Depths of 300 and 600 fit factors 1 and 2 alike: then only a clear winner counts
  const one = support[0]![1]
  if (n !== 1 && one >= 0.5 * matched) {
    return { factor: null, matched, measured: drawn.length, text: `unclear (${of} fit at ${n}x, ${one} at 1x; ${sections})` }
  }
  return n === 1
    ? { factor: 1, matched, measured: drawn.length, text: `confirmed: ${of} match the ${sections}` }
    : { factor: n, matched, measured: drawn.length, text: `elevations drawn ${n}x deeper than their horizontal scale (${of} are ${n}x the ${sections})` }
}
