// Detect black bar shapes (straight, L, U, Z, closed link, ...) directly from a vector PDF.
//
// Usage: bun src/detect_shapes_pdf.ts [pdf] [--page 1] [--dpi 300] [--roi x0,y0,x1,y1]
// Outputs: shapes_pdf_detected.png, shapes_pdf_only.png, shapes_pdf.json
import { parseArgs } from "node:util"
import * as mupdf from "mupdf"
import {
  COLORS, GRAY_BAR_RANGE, MAX_BLACK, MIN_SEGMENT, MIN_SHAPE_LENGTH,
  MIN_TEXT_STROKES, SNAP, STRAIGHT_ANGLE, TEXT_GAP,
} from "./constant"
import { dist, intersect, polylineLength as length, pymod, round, roundPt, unitVector } from "./geometry"
import { getDrawings } from "./pdf_drawings"
import { renderPage, saveOverlay, shapesSvg } from "./render"
import type {
  BBox, Drawing, Polyline, Pt, Roi, Shape, ShapeColor, ShapeType,
  SimplifyResult, SourcedPolyline, StraightRun,
} from "./types"

export { COLORS, length }

const deg = (rad: number) => (rad * 180) / Math.PI
const angleDiff = (a: number, b: number) => Math.abs(pymod(a - b + 180, 360) - 180)

export function blackPolylines(
  drawings: Drawing[], roi: Roi | null = null, levels: readonly [number, number] = [0, MAX_BLACK],
): Polyline[] {
  const polylines: Polyline[] = []
  for (const path of drawings) {
    const color = path.color
    if (!path.type.includes("s") || !color) continue
    const hi = Math.max(...color)
    if (hi - Math.min(...color) > 0.02 || hi < levels[0] || hi > levels[1]) continue
    const r = path.rect
    if (roi && (r.x1 < roi.x0 || r.x0 > roi.x1 || r.y1 < roi.y0 || r.y0 > roi.y1)) continue
    polylines.push(...pathPolylines(path))
  }
  return polylines
}

export function pathPolylines(path: Drawing): Polyline[] {
  const polylines: Polyline[] = []
  let current: Pt[] = []
  for (const item of path.items) {
    let pts: Pt[]
    if (item[0] === "l") {
      pts = [item[1], item[2]]
    } else {
      // Bezier curve (e.g. a bend): sample it so its length is measured along the arc
      const [, p0, p1, p2, p3] = item
      pts = []
      for (let i = 0; i <= 8; i++) {
        const t = i / 8
        const s = 1 - t
        const w = [s ** 3, 3 * s * s * t, 3 * s * t * t, t ** 3] as const
        pts.push([
          w[0] * p0[0] + w[1] * p1[0] + w[2] * p2[0] + w[3] * p3[0],
          w[0] * p0[1] + w[1] * p1[1] + w[2] * p2[1] + w[3] * p3[1],
        ])
      }
    }
    // A new sub-path starts where the previous one did not end
    if (current.length && dist(current.at(-1)!, pts[0]!) > SNAP) {
      polylines.push(current)
      current = []
    }
    current.push(...(current.length ? pts.slice(1) : pts))
  }
  if (current.length) polylines.push(current)
  return polylines
}

// Two lines leaving a point with directions this close (cosine) lie along each other
const FOLD_BACK_COS = 0.9
// A fold-back is a U-turn bend when the step from one run's end to the next run's start is
// at most this far off square to the runs (cosine)
const U_TURN_SLANT = 0.2
// A line this close (pt) to longer lines along its whole length is a copy of them.
// The plotter rounds each coordinate to about 0.06 pt, so copies do not match exactly;
// real parallel bars are a cover or a bar spacing apart, far more than this
const OVERLAY_TOL = 0.15
const OVERLAY_STEP = 0.5
const OVERLAY_CELL = 2
// Lone line ends this many join tolerances apart are still one bar (see joinPolylines)
const GAP_FACTOR = 2
// Dashes of one line: ends this close (pt), direction within this (deg), offset within this (pt)
const DASH_GAP = 0.05
const DASH_ANGLE = 0.5
const DASH_OFFSET = 0.05

// Both lines start at the same point. If they leave it the same way, a path through it would
// double back on itself, which a bar never does: they are two bars on top of each other or sharing an end
function foldsBack(a: Polyline, b: Polyline): boolean {
  const leaving = (line: Polyline): Pt | null => {
    const to = line.find((p) => dist(p, line[0]!) > SNAP)
    return to ? unitVector(line[0]!, to) : null
  }
  const [u, v] = [leaving(a), leaving(b)]
  return u !== null && v !== null && u[0] * v[0] + u[1] * v[1] > FOLD_BACK_COS
}

// AutoCAD plots two overlaid bars as one path that goes out and comes back: cut it at the turn
function splitAtFoldBacks(line: Polyline): Polyline[] {
  const parts: Polyline[] = []
  let start = 0
  for (let i = 1; i < line.length - 1; i++) {
    if (foldsBack(line.slice(0, i + 1).reverse(), line.slice(i))) {
      parts.push(line.slice(start, i + 1))
      start = i
    }
  }
  parts.push(line.slice(start))
  return parts
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const n = dx * dx + dy * dy
  const t = n === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

// Remove lines lying entirely on top of longer ones (a loose copy of a bar's tail, say).
// Checked longest first, so of two copies of one bar the first stays. The order of the rest is kept
function dropOverlaid(lines: Polyline[]): Polyline[] {
  const cellOf = (v: number) => Math.floor(v / OVERLAY_CELL)
  const segments = new Map<string, [Pt, Pt][]>()
  const isCovered = (p: Pt) => {
    const [cx, cy] = [cellOf(p[0]), cellOf(p[1])]
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        for (const [a, b] of segments.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (distToSegment(p, a, b) <= OVERLAY_TOL) return true
        }
      }
    }
    return false
  }
  const covered = new Set<Polyline>()
  for (const line of [...lines].sort((x, y) => length(y, false) - length(x, false))) {
    const samples: Pt[] = [line[0]!]
    for (let i = 0; i < line.length - 1; i++) {
      const [a, b] = [line[i]!, line[i + 1]!]
      const k = Math.max(1, Math.ceil(dist(a, b) / OVERLAY_STEP))
      for (let j = 1; j <= k; j++) samples.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k])
    }
    if (samples.every(isCovered)) {
      covered.add(line)
      continue
    }
    for (let i = 0; i < line.length - 1; i++) {
      const [a, b] = [line[i]!, line[i + 1]!]
      for (let x = cellOf(Math.min(a[0], b[0])); x <= cellOf(Math.max(a[0], b[0])); x++) {
        for (let y = cellOf(Math.min(a[1], b[1])); y <= cellOf(Math.max(a[1], b[1])); y++) {
          const k = `${x},${y}`
          if (!segments.has(k)) segments.set(k, [])
          segments.get(k)!.push([a, b])
        }
      }
    }
  }

  // A covered piece may still be part of a real bar: two bars can share the line of a leg. It is
  // real if a line ends at its end, carries on from it, and would otherwise lead nowhere
  const fromEnd = (line: Polyline, e: Pt) => (line[0] === e ? line : [...line].reverse())
  const carriesOn = (a: Polyline, b: Polyline, e: Pt, f: Pt) =>
    a !== b && dist(e, f) <= OVERLAY_TOL && !foldsBack(fromEnd(a, e), fromEnd(b, f))
  const lineEnds = (line: Polyline): Pt[] => [line[0]!, line.at(-1)!]
  const kept = lines.filter((line) => !covered.has(line))
  const endCells = new Map<string, Polyline[]>()
  const addEnds = (line: Polyline) => {
    for (const e of lineEnds(line)) {
      const k = `${cellOf(e[0])},${cellOf(e[1])}`
      if (!endCells.has(k)) endCells.set(k, [])
      endCells.get(k)!.push(line)
    }
  }
  const nearEnds = (e: Pt) => {
    const near: Polyline[] = []
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) near.push(...(endCells.get(`${cellOf(e[0]) + dx},${cellOf(e[1]) + dy}`) ?? []))
    }
    return near
  }
  kept.forEach(addEnds)
  const isNeeded = (line: Polyline) => lineEnds(line).some((e) =>
    nearEnds(e).some((m) => lineEnds(m).some((f) =>
      carriesOn(line, m, e, f)
      && !nearEnds(f).some((n) => n !== line && lineEnds(n).some((g) => carriesOn(m, n, f, g))))))
  // Repeat until nothing changes, as before, but recheck only the covered lines a restored
  // line can affect: those with an end near its ends, or near the far end of a line that
  // ends there (isNeeded looks two lines out). The rest would give the same answer again,
  // and on a sheet with many thousands of covered strokes re-asking them all took minutes
  const coveredEnds = new Map<string, Polyline[]>()
  for (const line of covered) {
    for (const e of lineEnds(line)) {
      const k = `${cellOf(e[0])},${cellOf(e[1])}`
      if (!coveredEnds.has(k)) coveredEnds.set(k, [])
      coveredEnds.get(k)!.push(line)
    }
  }
  const coveredNear = (e: Pt) => {
    const near: Polyline[] = []
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) near.push(...(coveredEnds.get(`${cellOf(e[0]) + dx},${cellOf(e[1]) + dy}`) ?? []))
    }
    return near
  }
  let dirty = new Set(covered)
  let changed = true
  while (changed) {
    changed = false
    const next = new Set<Polyline>()
    const mark = (line: Polyline) => {
      if (!covered.has(line)) return
      dirty.add(line)
      next.add(line)
    }
    for (const line of covered) {
      if (!dirty.has(line) || !isNeeded(line)) continue
      covered.delete(line)
      addEnds(line)
      changed = true
      for (const e of lineEnds(line)) {
        coveredNear(e).forEach(mark)
        for (const m of nearEnds(e)) for (const f of lineEnds(m)) coveredNear(f).forEach(mark)
      }
    }
    dirty = next
  }
  return lines.filter((line) => !covered.has(line))
}

// A dashed linetype plotted at a tiny linetype scale draws one line as thousands of
// 0.025 pt dashes 0.01 pt apart (mitraj CLUSTER sheets: 366k strokes on one page): no tick,
// dimension line or bar is long enough to be seen, and as each dash lies on its neighbours
// dropOverlaid takes them for copies and spends hours on them. Collinear straight pieces of
// the same pen whose ends are at most DASH_GAP apart are put back into one line, when at
// least one of the two is a dash (shorter than MIN_SEGMENT): solid lines meeting end to end
// keep their joint, as a junction there still matters
function mergeCollinear<T>(pieces: { a: Pt; b: Pt; pen: string; src: T }[]): { a: Pt; b: Pt; src: T }[] {
  const groups = new Map<string, [number, number, Pt, Pt, T][]>()
  for (const { a: p, b: q, pen, src } of pieces) {
    let [a, b] = [p, q]
    let u = unitVector(a, b)
    if (u[0] < -1e-9 || (Math.abs(u[0]) <= 1e-9 && u[1] < 0)) [a, b, u] = [b, a, [-u[0], -u[1]]]
    const offset = -a[0] * u[1] + a[1] * u[0]
    const key = `${pen}|${Math.round((Math.atan2(u[1], u[0]) * 180) / Math.PI / DASH_ANGLE)},${Math.round(offset / DASH_OFFSET)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push([a[0] * u[0] + a[1] * u[1], b[0] * u[0] + b[1] * u[1], a, b, src])
  }
  const merged: { a: Pt; b: Pt; src: T }[] = []
  for (const list of groups.values()) {
    list.sort((x, y) => x[0] - y[0])
    let [, s1, a, b, src] = list[0]!
    let short = s1 - list[0]![0] < MIN_SEGMENT
    for (const [t0, t1, c, d, srcT] of list.slice(1)) {
      const isShort = t1 - t0 < MIN_SEGMENT
      if (t0 - s1 <= DASH_GAP && (short || isShort)) {
        if (t1 > s1) [s1, b] = [t1, d]
        short = isShort
      } else {
        merged.push({ a, b, src })
        ;[s1, a, b, src, short] = [t1, c, d, srcT, isShort]
      }
    }
    merged.push({ a, b, src })
  }
  return merged
}

// mergeCollinear over the page's stroked one-segment paths (dimension lines, ticks, bars
// alike); other paths are kept as they are. Nothing changes on a page without dashes
export function mergeDashPaths(drawings: Drawing[]): Drawing[] {
  const single = (p: Drawing) => p.type === "s" && p.items.length === 1 && p.items[0]![0] === "l"
    && dist(p.items[0]![1], p.items[0]![2]) > 1e-6
  const lines = drawings.filter(single)
  if (!lines.some((p) => dist(p.items[0]![1], p.items[0]![2]) < MIN_SEGMENT)) return drawings
  const pen = (p: Drawing) => `${p.layer}|${p.color}|${p.width}`
  const merged = mergeCollinear(lines.map((p) => ({ a: p.items[0]![1], b: p.items[0]![2], pen: pen(p), src: p })))
  const rebuilt = merged.map(({ a, b, src }): Drawing => ({
    ...src,
    items: [["l", a, b]],
    rect: { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) },
  }))
  return [...drawings.filter((p) => !single(p)), ...rebuilt]
}

export function joinPolylines(input: Polyline[], tol: number | null = null): Polyline[] {
  // CAD files often hold the same piece twice; the copy would make false junctions
  const unique = new Map<string, Polyline>()
  for (const line of input.flatMap(splitAtFoldBacks)) {
    const ends = [line[0]!, line.at(-1)!].map((p) => `${round(p[0], 2)},${round(p[1], 2)}`).sort()
    const k = `${ends[0]}|${ends[1]}|${round(length(line, false), 2)}`
    if (!unique.has(k)) unique.set(k, line)
  }
  let polylines = dropOverlaid([...unique.values()])
  // A piece shorter than tol would sit inside one cluster and fake a junction, so it is
  // dropped; but it still bridges its two ends (a tiny bend arc between a leg and a crank)
  let bridges: Polyline[] = []
  if (tol !== null) {
    bridges = polylines.filter((line) => length(line, false) <= tol)
    polylines = polylines.filter((line) => length(line, false) > tol)
  }

  let key: (pt: Pt) => string
  if (tol === null) {
    key = (pt) => `${Math.round(pt[0] / SNAP)},${Math.round(pt[1] / SNAP)}`
  } else {
    // Cluster nearby end points (union-find over a grid of tol-sized cells)
    const points = [...polylines, ...bridges].flatMap((line) => [line[0]!, line.at(-1)!])
    const cellOf = (pt: Pt) => [Math.floor(pt[0] / tol), Math.floor(pt[1] / tol)] as const
    const cell = new Map<string, number[]>()
    points.forEach((pt, i) => {
      const [cx, cy] = cellOf(pt)
      const k = `${cx},${cy}`
      if (!cell.has(k)) cell.set(k, [])
      cell.get(k)!.push(i)
    })
    const parent = points.map((_, i) => i)
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!
        i = parent[i]!
      }
      return i
    }
    points.forEach((pt, i) => {
      const [cx, cy] = cellOf(pt)
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          for (const j of cell.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (j < i && dist(pt, points[j]!) <= tol) parent[find(i)] = find(j)
          }
        }
      }
    })
    const nLine = polylines.length * 2
    bridges.forEach((_, b) => { parent[find(nLine + 2 * b + 1)] = find(nLine + 2 * b) })
    // Likewise a short piece whose own two ends fell into one cluster (a 0.19 pt bend arc
    // whose start is within tol of the next leg too): it is a joint, not a bar
    const isJoint = polylines.map((line, k) => length(line, false) <= 3 * tol && find(2 * k) === find(2 * k + 1))
    // Second pass for wider plot-rounding gaps (0.24 pt where a bend arc got dropped as a
    // copy of its leg): a line end still alone joins the one other lone end within
    // GAP_FACTOR x tol, when each is the other's only candidate and the bar does not fold back
    const members = new Map<number, number[]>()
    for (let i = 0; i < nLine; i++) {
      if (isJoint[i >> 1]) continue
      const r = find(i)
      if (!members.has(r)) members.set(r, [])
      members.get(r)!.push(i)
    }
    const lone = [...members.values()].filter((m) => m.length === 1).map((m) => m[0]!)
    const reach = Math.min(0.5, GAP_FACTOR * tol)
    const candidates = new Map<number, number[]>()
    for (const i of lone) {
      const near = lone.filter((j) => j !== i && (j >> 1) !== (i >> 1) && dist(points[i]!, points[j]!) <= reach)
      candidates.set(i, near)
    }
    const fromEnd = (i: number): Polyline => {
      const line = polylines[i >> 1]!
      return i % 2 === 0 ? line : [...line].reverse()
    }
    for (const i of lone) {
      const near = candidates.get(i)!
      if (near.length !== 1) continue
      const j = near[0]!
      if (j < i || candidates.get(j)!.length !== 1) continue
      if (foldsBack(fromEnd(i), fromEnd(j))) continue
      parent[find(i)] = find(j)
    }
    const cluster = new Map<string, number>()
    points.forEach((pt, i) => cluster.set(`${pt[0]},${pt[1]}`, find(i)))
    key = (pt) => String(cluster.get(`${pt[0]},${pt[1]}`))
    polylines = polylines.filter((_, k) => !isJoint[k])
  }

  const ends = new Map<string, number[]>()
  polylines.forEach((line, i) => {
    for (const pt of [line[0]!, line.at(-1)!]) {
      const k = key(pt)
      if (!ends.has(k)) ends.set(k, [])
      ends.get(k)!.push(i)
    }
  })

  const nextLine = (pt: Pt, current: number, used: Set<number>): number | null => {
    const touching = ends.get(key(pt))!
    if (touching.length !== 2) return null
    const other = touching[0] === current ? touching[1]! : touching[0]!
    return used.has(other) ? null : other
  }

  const used = new Set<number>()
  const joined: Polyline[] = []
  polylines.forEach((line, i) => {
    if (used.has(i)) return
    used.add(i)
    let chain = [...line]
    // Grow forwards from the last point, then backwards from the first
    for (const forward of [true, false]) {
      let current = i
      while (true) {
        const pt = forward ? chain.at(-1)! : chain[0]!
        const j = nextLine(pt, current, used)
        if (j === null) break
        used.add(j)
        let other = polylines[j]!
        if (key(other[0]!) !== key(pt)) other = [...other].reverse()
        if (foldsBack(forward ? [...chain].reverse() : chain, other)) {
          used.delete(j)
          break
        }
        chain = forward ? [...chain, ...other] : [...[...other].reverse(), ...chain]
        current = j
      }
    }
    joined.push(chain)
  })
  return joined
}

export function simplify(points: Pt[]): SimplifyResult {
  const closed = points.length > 3 && dist(points[0]!, points.at(-1)!) <= SNAP

  const runs = straightRuns(points)
  for (const r of runs) {
    r.start = points[r.i0]!
    r.end = points[r.i1]!
  }
  if (closed && runs.length > 2 && angleDiff(runs[0]!.angle, runs.at(-1)!.angle) < STRAIGHT_ANGLE) {
    runs[0]!.start = runs.pop()!.start
  }

  // Corners where consecutive runs meet
  const pairs: [StraightRun, StraightRun][] = []
  for (let i = 0; i < runs.length - 1; i++) pairs.push([runs[i]!, runs[i + 1]!])
  if (closed && runs.length > 2) pairs.push([runs.at(-1)!, runs[0]!])
  const corners = pairs.map(([a, b]) => intersect(a.start!, a.end!, b.start!, b.end!))

  const straightEnds = runs.map((r): [Pt, Pt] => [r.start!, r.end!])
  if (closed && runs.length > 2) {
    return { points: [corners.at(-1)!, ...corners.slice(0, -1)], closed: true, straightEnds }
  }
  return { points: [runs[0]!.start!, ...corners, runs.at(-1)!.end!], closed: false, straightEnds }
}

export function straightRuns(points: Pt[]): StraightRun[] {
  const runs: StraightRun[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]!
    const q = points[i + 1]!
    const len = dist(p, q)
    if (len < 1e-6 || (runs.length && len < MIN_SEGMENT)) continue
    const angle = deg(Math.atan2(q[1] - p[1], q[0] - p[0]))
    const last = runs.at(-1)
    if (last && angleDiff(angle, last.angle) < STRAIGHT_ANGLE) {
      last.i1 = i + 1
      last.length += len
    } else {
      runs.push({ angle, length: len, i0: i, i1: i + 1 })
    }
  }
  const long = runs.filter((r) => r.length >= MIN_SEGMENT)
  return long.length ? long : runs.slice(0, 1)
}

// Length along a bar, bends included, rebuilt from its straight runs
// (see the docstring of bar_length in detect_shapes_pdf.py)
export function barLength(path: Pt[], sx = 1.0, sy = 1.0): number {
  const closed = path.length > 3 && dist(path[0]!, path.at(-1)!) <= SNAP
  const runs = straightRuns(path)
  const pts = path.map(([x, y]): Pt => [x * sx, y * sy])
  if (closed || runs.length < 2) return length(pts, false)

  const drawn = (i: number, j: number) => {
    let total = 0
    for (let k = i; k < j; k++) total += dist(pts[k]!, pts[k + 1]!)
    return total
  }
  // First and last segment of a run that are not kinks
  const longPieces = (r: StraightRun): [[Pt, Pt], [Pt, Pt]] => {
    const long: number[] = []
    for (let i = r.i0; i < r.i1; i++) if (dist(path[i]!, path[i + 1]!) >= MIN_SEGMENT) long.push(i)
    const f = long[0]!
    const l = long.at(-1)!
    return [[pts[f]!, pts[f + 1]!], [pts[l]!, pts[l + 1]!]]
  }

  const pieces = runs.map(longPieces)
  const ends = runs.map((r): [Pt, Pt] => [pts[r.i0]!, pts[r.i1]!])
  let total = drawn(0, runs[0]!.i0) + drawn(runs.at(-1)!.i1, pts.length - 1)
  runs.forEach((r, k) => (total += drawn(r.i0, r.i1) - dist(...ends[k]!)))
  let previous = ends[0]![0]
  for (let k = 0; k < runs.length - 1; k++) {
    const a1 = ends[k]![1]
    const b0 = ends[k + 1]![0]
    const aLast = pieces[k]![1]
    const bFirst = pieces[k + 1]![0]
    const corner = intersect(aLast[0], aLast[1], bFirst[0], bFirst[1])
    const u = unitVector(...aLast)
    const v = unitVector(...bFirst)
    const turn = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])))
    if (turn < (STRAIGHT_ANGLE * Math.PI) / 180) {
      // nearly straight: no reliable corner, keep it as drawn
      total += dist(previous, a1) + dist(a1, b0)
      previous = b0
      continue
    }
    if (turn > (170 * Math.PI) / 180) {
      // Folded back. A U-turn bend (a hairpin link's 180 degree bend) crosses straight over
      // from one run's end to the next run's start: count half a circle across them. Anything
      // else (an out-and-back copy, a zigzag) has no reliable corner: keep it as drawn
      const gap = dist(a1, b0)
      const across = gap > 0 ? Math.abs(((b0[0] - a1[0]) * u[0] + (b0[1] - a1[1]) * u[1]) / gap) : 1
      const radius = gap / (2 * Math.sin(turn / 2))
      total += dist(previous, a1) + (across <= U_TURN_SLANT ? radius * turn : gap)
      previous = b0
      continue
    }
    total += dist(previous, corner)
    const setback = (dist(a1, corner) + dist(b0, corner)) / 2
    const radius = setback / Math.tan(turn / 2)
    total -= 2 * setback - radius * turn
    previous = corner
  }
  return total + dist(previous, ends.at(-1)![1])
}

function directionName(v: Pt): string {
  const angle = pymod(deg(Math.atan2(v[1], v[0])), 360) // y grows downwards
  const names = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"]
  return names[pymod(Math.floor((angle + 22.5) / 45), 8)]!
}

export function classify(points: Pt[], closed: boolean): [ShapeType, string] {
  const n = closed ? points.length : points.length - 1
  if (closed) return ["closed", `closed link (${n} sides)`]
  if (n === 1) {
    const [[x1, y1], [x2, y2]] = points as [Pt, Pt]
    if (Math.abs(y1 - y2) < Math.abs(x1 - x2) * 0.05) return ["straight", "straight (horizontal)"]
    if (Math.abs(x1 - x2) < Math.abs(y1 - y2) * 0.05) return ["straight", "straight (vertical)"]
    return ["straight", "straight (inclined)"]
  }

  const bends: number[] = []
  for (let i = 0; i < points.length - 2; i++) {
    const [a, b, c] = [points[i]!, points[i + 1]!, points[i + 2]!]
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    bends.push(cross > 0 ? 1 : -1)
  }
  const sub = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]]

  if (n === 2) {
    const corner = points[1]!
    const legs = [points[0]!, points[2]!].map((p) => directionName(sub(p, corner)))
    return ["L", `L (legs ${legs[0]} and ${legs[1]})`]
  }
  if (n === 3) {
    if (bends[0] !== bends[1]) return ["Z", "Z / crank"]
    // Legs point the same way -> U; name the side it opens to
    const a = sub(points[0]!, points[1]!)
    const b = sub(points[3]!, points[2]!)
    return ["U", `U (opens ${directionName([a[0] + b[0], a[1] + b[1]])})`]
  }
  return ["other", `other (${n} segments)`]
}

function isUnderline(points: Pt[], strokes: BBox[]): boolean {
  const [[ax, y1], [bx, y2]] = points as [Pt, Pt]
  if (Math.abs(y1 - y2) > 0.05) return false
  const [x1, x2] = [Math.min(ax, bx), Math.max(ax, bx)]
  const above = strokes.filter((b) => x1 <= b[0] && b[2] <= x2 && y1 - TEXT_GAP <= b[1] && b[3] < y1)
  return above.length >= MIN_TEXT_STROKES
}

function isAxisAligned(points: Pt[], closed: boolean): boolean {
  const pts = closed ? [...points, points[0]!] : points
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i]!, pts[i + 1]!]
    if (!(Math.abs(a[0] - b[0]) < 0.05 || Math.abs(a[1] - b[1]) < 0.05)) return false
  }
  return true
}

export function detectShapes(drawings: Drawing[], roi: Roi | null = null): Shape[] {
  const lines: SourcedPolyline[] = [
    ...joinPolylines(blackPolylines(drawings, roi)).map((l) => [l, "black"] as const),
    ...joinPolylines(blackPolylines(drawings, roi, GRAY_BAR_RANGE)).map((l) => [l, "gray"] as const),
  ]
  return shapesFromLines(lines)
}

// source is "black", "gray" (only simple axis-aligned open shapes kept) or
// "layer" for bars picked by CAD layer
export function shapesFromLines(lines: readonly SourcedPolyline[]): Shape[] {
  let shapes: Shape[] = []
  const strokes: BBox[] = []
  for (const [line, color] of lines) {
    if (length(line, false) < MIN_SHAPE_LENGTH) {
      if (color === "black") {
        const xs = line.map((p) => p[0])
        const ys = line.map((p) => p[1])
        strokes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
      }
      continue
    }
    const { points, closed, straightEnds } = simplify(line)
    if (length(points, closed) < MIN_SHAPE_LENGTH) continue
    if (color === "gray" && (closed || points.length > 4 || !isAxisAligned(points, closed))) continue
    const [type, name] = classify(points, closed)
    shapes.push({
      color: color as ShapeColor,
      type,
      name,
      closed,
      points: points.map((p) => roundPt(p, 2)),
      length: round(length(points, closed), 2),
      // Full length along the drawn bar, bends (arcs) included
      path_length: round(length(line, false), 4),
      // Full length rebuilt from the straight runs and bend radii (see barLength)
      bar_length: round(barLength(line), 4),
      path: line.map((p) => roundPt(p, 3)),
      straight_parts: straightEnds.map(([a, b]) => round(dist(a, b), 2)),
      straight_ends: straightEnds.map(([a, b]): [Pt, Pt] => [roundPt(a, 2), roundPt(b, 2)]),
    })
  }
  shapes = shapes.filter((s) => !(s.type === "straight" && isUnderline(s.points, strokes)))
  const sortKey = (s: Shape) => [
    Math.round(Math.min(...s.points.map((p) => p[1])) / 20),
    Math.min(...s.points.map((p) => p[0])),
  ] as const
  shapes.sort((a, b) => {
    const [a0, a1] = sortKey(a)
    const [b0, b1] = sortKey(b)
    return a0 - b0 || a1 - b1
  })
  return shapes
}

// "x0,y0,x1,y1" -> Roi
export function parseRoi(value: string | undefined): Roi | null {
  if (!value) return null
  const [x0, y0, x1, y1] = value.split(",").map(Number)
  return { x0: x0!, y0: y0!, x1: x1!, y1: y1! }
}

export async function openPdf(file: string): Promise<mupdf.Document> {
  try {
    return mupdf.Document.openDocument(await Bun.file(file).bytes(), "application/pdf")
  } catch (e) {
    console.error(`Could not open PDF: ${e}`)
    process.exit(1)
  }
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
  const doc = await openPdf(positionals[0] ?? "drawing.pdf")
  const page = doc.loadPage(Number(values.page) - 1)
  const roi = parseRoi(values.roi)

  const shapes = detectShapes(getDrawings(page), roi)
  const counts: Record<string, number> = {}
  for (const s of shapes) counts[s.type] = (counts[s.type] ?? 0) + 1
  console.log(`Found ${shapes.length} shape(s):`, counts)
  shapes.forEach((s, n) =>
    console.log(`  #${n + 1}: ${s.name}, length=${s.length}pt, points=${JSON.stringify(s.points)}`))

  const img = await renderPage(page, Number(values.dpi), roi)
  const svg = shapesSvg(shapes, shapes.map((_, n) => `#${n + 1}`), img)
  await saveOverlay(img, svg, "shapes_pdf_detected.png", "shapes_pdf_only.png")
  await Bun.write("shapes_pdf.json", JSON.stringify(shapes, null, 1))
  console.log("Saved: shapes_pdf_detected.png, shapes_pdf_only.png, shapes_pdf.json")
}

if (import.meta.main) await main()
