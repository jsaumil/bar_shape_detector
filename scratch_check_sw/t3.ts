import { joinPolylines } from "./dev/detect_shapes_pdf.ts"
const arc = [[747.89,410.04],[747.9,410.02],[747.91,410],[747.91,409.97],[747.91,409.95],[747.92,409.93],[747.92,409.91],[747.92,409.88],[747.92,409.86]]
const a = [[724.28,451.2],[747.92,410.16]], b = [[747.92,409.92],[747.92,386.76]]
console.log(JSON.stringify(joinPolylines([a, arc, b] as any, 0.18)))
console.log(JSON.stringify(joinPolylines([a, b] as any, 0.18)))
