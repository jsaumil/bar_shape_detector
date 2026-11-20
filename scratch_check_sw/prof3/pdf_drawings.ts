import * as mupdf from "mupdf"
import { dist } from "./geometry"
import type { Drawing, PathItem, Pt, RGB, Roi } from "./types"

function transformPoint(x: number, y: number, ctm: mupdf.Matrix): Pt {
  const [a, b, c, d, e, f] = ctm
  return [a * x + c * y + e, b * x + d * y + f]
}

function toRgb(space: mupdf.ColorSpace, color: number[]): RGB {
  const c = color.map((n) => Math.max(0, Math.min(1, n)))
  const type = space.getType()
  if (type === "Gray") return [c[0]!, c[0]!, c[0]!]
  if (type === "BGR") return [c[2]!, c[1]!, c[0]!]
  if (type === "CMYK") {
    const k = c[3]!
    return [0, 1, 2].map((i) => 1 - Math.min(1, c[i]! * (1 - k) + k)) as RGB
  }
  return [c[0]!, c[1]!, c[2]!]
}

function boundsOf(points: Pt[]): Roi {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

function sameItems(a: PathItem[], b: PathItem[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}

// Same idea as pymupdf's page.get_drawings(): every stroked / filled path,
// in page coordinates (y grows downwards), with "l" and "c" items
export function getDrawings(page: mupdf.Page): Drawing[] {
  const drawings: Drawing[] = []
  let layer = ""

  const record = (
    path: mupdf.Path, ctm: mupdf.Matrix, space: mupdf.ColorSpace, color: number[],
    type: "s" | "f", width: number | null,
  ) => {
    const items: PathItem[] = []
    const all: Pt[] = []
    let current: Pt | null = null
    let start: Pt | null = null
    path.walk({
      moveTo(x, y) {
        current = start = transformPoint(x, y, ctm)
        all.push(current)
      },
      lineTo(x, y) {
        const p = transformPoint(x, y, ctm)
        if (current) items.push(["l", current, p])
        all.push(p)
        current = p
      },
      curveTo(x1, y1, x2, y2, x3, y3) {
        const p1 = transformPoint(x1, y1, ctm)
        const p2 = transformPoint(x2, y2, ctm)
        const p3 = transformPoint(x3, y3, ctm)
        if (current) items.push(["c", current, p1, p2, p3])
        all.push(p1, p2, p3)
        current = p3
      },
      closePath() {
        if (current && start && dist(current, start) > 1e-9) items.push(["l", current, start])
        current = start
      },
    })
    if (items.length === 0) return
    const rgb = toRgb(space, color)
    // pymupdf merges the stroke of the path that was just filled into one "fs" drawing
    const prev = drawings.at(-1)
    if (type === "s" && prev?.type === "f" && sameItems(prev.items, items)) {
      prev.type = "fs"
      prev.color = rgb
      prev.width = width
      return
    }
    drawings.push({
      type,
      color: type === "s" ? rgb : null,
      fill: type === "f" ? rgb : null,
      width,
      layer,
      rect: boundsOf(all),
      items,
    })
  }

  const device = new mupdf.Device({
    strokePath(path, stroke, ctm, space, color) {
      const factor = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]))
      record(path, ctm, space, color, "s", factor * stroke.getLineWidth())
    },
    fillPath(path, _evenOdd, ctm, space, color) {
      record(path, ctm, space, color, "f", null)
    },
    beginLayer(name) {
      layer = name || ""
    },
    endLayer() {
      layer = ""
    },
  })
  page.run(device, mupdf.Matrix.identity)
  device.close()
  return drawings
}

// Words of the page's real text with their boxes, like pymupdf's page.get_text("words")
export function getWords(page: mupdf.Page): { text: string; rect: Roi }[] {
  const words: { text: string; rect: Roi }[] = []
  let text = ""
  let corners: Pt[] = []
  const flush = () => {
    if (text) words.push({ text, rect: boundsOf(corners) })
    text = ""
    corners = []
  }
  page.toStructuredText("preserve-whitespace").walk({
    beginLine: flush,
    onChar(c, _origin, _font, _size, quad) {
      if (/\s/.test(c)) return flush()
      text += c
      for (let i = 0; i < 8; i += 2) corners.push([quad[i]!, quad[i + 1]!])
    },
    endLine: flush,
  })
  return words
}

export function getText(page: mupdf.Page): string {
  return page.toStructuredText("preserve-whitespace").asText()
}
