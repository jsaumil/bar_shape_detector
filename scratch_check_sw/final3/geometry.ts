import type { Pt } from "./types"

export function dist(a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  return Math.sqrt(dx * dx + dy * dy)
}

export function intersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0])
  if (Math.abs(d) < 1e-9) {
    return [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2]
  }
  const a = p1[0] * p2[1] - p1[1] * p2[0]
  const b = p3[0] * p4[1] - p3[1] * p4[0]
  return [
    (a * (p3[0] - p4[0]) - (p1[0] - p2[0]) * b) / d,
    (a * (p3[1] - p4[1]) - (p1[1] - p2[1]) * b) / d,
  ]
}

export function unitVector(a: Pt, b: Pt): Pt {
  const d = dist(a, b) || 1.0
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]
}

function dot(v1: Pt, v2: Pt): number {
  return v1[0] * v2[0] + v1[1] * v2[1]
}

export function polylineLength(points: Pt[], closed: boolean): number {
  const pts = closed ? [...points, points[0]!] : points
  let total = 0
  for (let i = 0; i < pts.length - 1; i++) {
    total += dist(pts[i]!, pts[i + 1]!)
  }
  return total
}

export function turnAngle(u: Pt, v: Pt): number {
  return Math.acos(Math.max(-1.0, Math.min(1.0, dot(u, v))))
}

export function add(a: Pt, b: Pt): Pt {
  return [a[0] + b[0], a[1] + b[1]]
}

export function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]]
}

// Python's % (result has the sign of n)
export const pymod = (a: number, n: number) => ((a % n) + n) % n

export const round = (v: number, digits = 0) => Math.round(v * 10 ** digits) / 10 ** digits

export const roundPt = (p: Pt, digits: number): Pt => [round(p[0], digits), round(p[1], digits)]
