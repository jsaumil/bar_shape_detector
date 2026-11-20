import * as mupdf from "mupdf"
import { getDrawings } from "../src/pdf_drawings.ts"
const [file, x0, y0, x1, y1] = process.argv.slice(2)
const doc = mupdf.Document.openDocument(await Bun.file(file!).arrayBuffer(), "application/pdf")
const page = doc.loadPage(+(process.env.PAGE ?? 1) - 1) as mupdf.PDFPage
const dr = getDrawings(page)
for (const d of dr) {
  const r = d.rect
  if (r.x1 < +x0! || r.x0 > +x1! || r.y1 < +y0! || r.y0 > +y1!) continue
  if (process.env.LAYER ? !new RegExp(process.env.LAYER, "i").test(d.layer) : !/rein|ties/i.test(d.layer)) continue
  console.log(d.layer, d.type, d.width?.toFixed(3), JSON.stringify(d.items.map((it: any) => [it[0], ...it.slice(1).map((p: any) => p.map((v: number) => +v.toFixed(2)))])))
}
