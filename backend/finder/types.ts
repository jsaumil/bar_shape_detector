export type Pt = [number, number]

export type Polyline = Pt[]

export type BBox = [number, number, number, number]

export type RGB = [number, number, number]

export interface Roi {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface StraightRun {
  angle: number
  length: number
  i0: number
  i1: number
  start?: Pt
  end?: Pt
}

export interface SimplifyResult {
  points: Pt[]
  closed: boolean
  straightEnds: [Pt, Pt][]
}

export type ShapeColor = "black" | "gray" | "layer"
export type ShapeType = "straight" | "L" | "U" | "Z" | "closed" | "other"

export type SourcedPolyline = readonly [Polyline, ShapeColor]

export type PathItem = ["l", Pt, Pt] | ["c", Pt, Pt, Pt, Pt]

// One path of the page, like an entry of pymupdf's page.get_drawings()
export interface Drawing {
  type: "f" | "s" | "fs"
  color: RGB | null
  fill: RGB | null
  // Line width in PDF points (strokes only)
  width: number | null
  // CAD layer (PDF optional content), "" if none
  layer: string
  rect: Roi
  items: PathItem[]
}

export interface Shape {
  color: ShapeColor
  type: ShapeType
  name: string
  closed: boolean
  points: Pt[]
  length: number
  path_length: number
  bar_length: number
  path: Pt[]
  straight_parts: number[]
  straight_ends: [Pt, Pt][]
  // Filled in by measure() / measureXY()
  tag?: string
  scale_from?: string
  segments_mm?: number[]
  length_mm?: number
  true_length_mm?: number
  straight_mm?: number[]
  straight_length_mm?: number
  mm_per_pt?: number
  // Filled in by assignBeams(): the beam title it belongs to, and beams it runs on into
  beam?: string | null
  beam_size?: string | null
  also_in?: string[]
}

export interface Dimension {
  p1: Pt
  p2: Pt
  length_pt: number
  u?: Pt
  text: string
  source?: "pdf text" | "ocr" | null
  value: number | null
  scale: number | null
  group_scale?: number | null
}

export interface ScaleGroup {
  scale: number
  count: number
}
