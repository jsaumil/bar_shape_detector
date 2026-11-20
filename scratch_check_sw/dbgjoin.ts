import * as mupdf from "mupdf"
import { getDrawings } from "./dev/pdf_drawings.ts"
import { pathPolylines, joinPolylines } from "./dev/detect_shapes_pdf.ts"
const [file, x0, y0, x1, y1, tol] = process.argv.slice(2)
const doc = mupdf.Document.openDocument(await Bun.file(file!).arrayBuffer(), "application/pdf")
const dr = getDrawings(doc.loadPage(0))
const lines = []
for (const d of dr) {
  const r = d.rect
  if (r.x1 < +x0! || r.x0 > +x1! || r.y1 < +y0! || r.y0 > +y1!) continue
  if (!/rein\.|stirrup|^reinf$|ties/i.test(d.layer) || !d.type.includes("s")) continue
  lines.push(...pathPolylines(d))
}
console.log("in", lines.length)
for (const l of joinPolylines(lines, +tol!)) console.log(l.length, JSON.stringify(l.map((p) => p.map((v) => +v.toFixed(2)))).slice(0, 300))
