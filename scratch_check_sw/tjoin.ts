import * as mupdf from "mupdf"
import { getDrawings } from "./dev/pdf_drawings.ts"
import { blackPolylines, joinPolylines } from "./dev/detect_shapes_pdf.ts"
const doc = mupdf.Document.openDocument(await Bun.file(process.argv[2]!).arrayBuffer(), "application/pdf")
const dr = getDrawings(doc.loadPage(0))
const roi = process.argv[3] ? (([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 }))(process.argv[3].split(",").map(Number)) : null
let t = Date.now()
const lines = blackPolylines(dr, roi as any)
console.log("black", lines.length, (Date.now() - t) / 1000); t = Date.now()
const j = joinPolylines(lines)
console.log("joined", j.length, (Date.now() - t) / 1000)
