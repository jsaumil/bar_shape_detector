// Drawing helpers that replace cv2: page rendering, shape labels, stroke images for OCR
import * as mupdf from "mupdf"
import sharp from "sharp"
import { COLORS } from "./constant"
import type { Pt, Roi, Shape } from "./types"

export interface PageImage {
  png: Buffer
  width: number
  height: number
  zoom: number
  // PDF point at the image's top-left corner
  ox: number
  oy: number
}

// Like pymupdf's page.get_pixmap(dpi=dpi, clip=roi)
export async function renderPage(page: mupdf.Page, dpi: number, roi: Roi | null): Promise<PageImage> {
  const zoom = dpi / 72
  const [bx0, by0] = page.getBounds()
  const pix = page.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false)
  let png: Buffer = Buffer.from(pix.asPNG())
  let [width, height] = [pix.getWidth(), pix.getHeight()]
  let [ox, oy] = [bx0, by0]
  if (roi) {
    const left = Math.max(0, Math.floor((roi.x0 - bx0) * zoom))
    const top = Math.max(0, Math.floor((roi.y0 - by0) * zoom))
    width = Math.min(width - left, Math.ceil((roi.x1 - bx0) * zoom) - left)
    height = Math.min(height - top, Math.ceil((roi.y1 - by0) * zoom) - top)
    png = await sharp(png).extract({ left, top, width, height }).png().toBuffer()
    ;[ox, oy] = [bx0 + left / zoom, by0 + top / zoom]
  }
  return { png, width, height, zoom, ox, oy }
}

// COLORS are cv2 BGR tuples, as in the Python scripts
function cssColor(type: string): string {
  const [b, g, r] = COLORS[type] ?? [0, 0, 0]
  return `rgb(${r},${g},${b})`
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Every shape traced in its color with its label above it, moved down while it
// would cover a label already placed (as the Python draw() functions do)
export function shapesSvg(shapes: Shape[], labels: string[], img: PageImage): string {
  const { zoom, ox, oy } = img
  const thickness = Math.max(1, Math.round(zoom / 2))
  const fontScale = 0.1 * zoom
  // cv2's FONT_HERSHEY_SIMPLEX is about 20 px wide and 22 px high per unit of font scale
  const charW = 20 * fontScale
  const h = Math.round(22 * fontScale)
  const placed: BBox4[] = []
  const parts: string[] = []
  shapes.forEach((s, n) => {
    const color = cssColor(s.type)
    const pts = s.points.map(([x, y]): Pt => [Math.trunc((x - ox) * zoom), Math.trunc((y - oy) * zoom)])
    const label = labels[n]!
    const x = Math.min(...pts.map((p) => p[0]))
    let y = Math.min(...pts.map((p) => p[1])) - 3
    const w = Math.round(label.length * charW)
    while (placed.some(([bx0, by0, bx1, by1]) => x < bx1 && bx0 < x + w && y - h < by1 && by0 < y)) y += h + 4
    placed.push([x, y - h, x + w, y])
    const tag = s.closed ? "polygon" : "polyline"
    parts.push(
      `<${tag} points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="${thickness}"/>`,
      `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${h / 0.72}" fill="${color}">${escapeXml(label)}</text>`,
    )
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}">${parts.join("")}</svg>`
}

type BBox4 = [number, number, number, number]

// Writes <name>.png (the page with the overlay) and <name>_only.png (overlay on white)
export async function saveOverlay(img: PageImage, svg: string, pagePath: string, onlyPath: string) {
  const overlay = Buffer.from(svg)
  await sharp(img.png).composite([{ input: overlay }]).png().toFile(pagePath)
  await sharp({ create: { width: img.width, height: img.height, channels: 3, background: "white" } })
    .composite([{ input: overlay }]).png().toFile(onlyPath)
}

// Black polylines (pixel coordinates) on a white image, anti-aliased, as a grayscale PNG.
// `thickness` is cv2's: its anti-aliased lines come out about 1 px wider than that,
// and OCR results depend on it, so the SVG stroke is 1 px wider too.
export async function strokesPng(
  width: number, height: number, polylines: Pt[][], thickness: number, rotate90 = false,
): Promise<Buffer> {
  const paths = polylines
    .map((pts) => `<polyline points="${pts.map((p) => p.join(",")).join(" ")}"/>`)
    .join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="white"/>`
    + `<g fill="none" stroke="black" stroke-width="${thickness + 1}" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`
  let image = sharp(Buffer.from(svg)).flatten({ background: "white" }).toColourspace("b-w")
  if (rotate90) image = sharp(await image.png().toBuffer()).rotate(90)
  return image.png().toBuffer()
}
