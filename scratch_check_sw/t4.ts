import { joinPolylines } from "./dev/detect_shapes_pdf.ts"
import { pathPolylines } from "./dev/detect_shapes_pdf.ts"
const d: any = { items: [["c",[275.18,265.08],[275.88,265.08],[276.44,264.52],[276.44,263.82]]], type: "s", rect: {} }
const p = pathPolylines(d); console.log(JSON.stringify(p))
const l1 = [[276.56,249.6],[276.56,263.88]], l2 = [[275.24,265.2],[223.04,265.2]]
console.log(JSON.stringify(joinPolylines([l1, ...p, l2] as any, 0.18)))
