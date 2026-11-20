// One PNG per shape: the bar drawn alone, each leg labelled with its length,
// and the tag, shape name and true length as a title (like a bar bending schedule)
import { mkdir } from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import { COLORS } from "./constant"
import type { Pt, Shape } from "./types"

const SIZE = 600 // max drawing width in px
const MAX_H = 300 // max drawing height in px, so vertical bars stay readable
const PAD = 70 // room for leg labels
const TITLE_H = 50

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function cssColor(type: string): string {
  const [b, g, r] = COLORS[type] ?? [0, 0, 0] // COLORS are BGR
  return `rgb(${r},${g},${b})`
}

export function shapeSvg(s: Shape): string {
  const xs = s.points.map((p) => p[0])
  const ys = s.points.map((p) => p[1])
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)]
  const w = Math.max(...xs) - minX
  const h = Math.max(...ys) - minY
  const k = Math.min(SIZE / Math.max(w, 1e-9), MAX_H / Math.max(h, 1e-9))
  const title = `${s.tag ?? ""}  ${s.beam ? s.beam + "  " : ""}${s.name}  L = ${s.length_mm} mm`
  // At least as wide as the title (about 13 px per bold 22 px character), drawing centred
  const width = Math.round(Math.max(w * k + 2 * PAD, title.length * 13 + 24))
  const height = Math.round(h * k + 2 * PAD + TITLE_H)
  const left = (width - w * k) / 2
  const pts: Pt[] = s.points.map(([x, y]) => [left + (x - minX) * k, TITLE_H + PAD + (y - minY) * k])
  const color = cssColor(s.type)

  // Centre of the shape, so leg labels go on the outside of each leg
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length
  const labels: string[] = []
  const segs = s.segments_mm ?? []
  segs.forEach((mm, i) => {
    const a = pts[i]!
    const b = pts[(i + 1) % pts.length]!
    const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    let [nx, ny] = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]
    if (nx * (mx - cx) + ny * (my - cy) < 0) [nx, ny] = [-nx, -ny]
    if (Math.abs(nx) < 1e-6 && Math.abs(ny) < 1e-6) ny = -1
    labels.push(`<text x="${(mx + nx * 22).toFixed(1)}" y="${(my + ny * 22 + 6).toFixed(1)}" `
      + `text-anchor="middle" font-family="sans-serif" font-size="18" fill="#222">${mm}</text>`)
  })

  const tag = s.closed ? "polygon" : "polyline"
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="white"/>`
    + `<text x="12" y="32" font-family="sans-serif" font-size="22" font-weight="bold" fill="#000">${escapeXml(title)}</text>`
    + `<${tag} points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}" fill="none" `
    + `stroke="${color}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`
    + labels.join("")
    + `</svg>`
}

// File name like page1_007_U_8413mm.png
export function shapeImageName(s: Shape, pageNo: number, index: number): string {
  const n = String(index + 1).padStart(3, "0")
  return `page${pageNo}_${n}_${s.type}_${Math.round(s.length_mm ?? 0)}mm.png`
}

// Saves every shape to <outDir>/shapes/ and returns the relative path of each image
export async function saveShapeImages(shapes: Shape[], outDir: string, pageNo: number): Promise<string[]> {
  const dir = path.join(outDir, "shapes")
  await mkdir(dir, { recursive: true })
  return Promise.all(shapes.map(async (s, i) => {
    const name = shapeImageName(s, pageNo, i)
    await sharp(Buffer.from(shapeSvg(s))).png().toFile(path.join(dir, name))
    return path.join("shapes", name)
  }))
}
