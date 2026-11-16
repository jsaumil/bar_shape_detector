import ExcelJS from 'exceljs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ShapeRow {
  page: number;
  tag: string;
  shape: string;
  type: string;
  true_length_mm: number;
  length_to_corners_mm: number;
  segments_mm: number[];
  straight_length_mm: number;
  straight_parts_mm: number[];
  image?: string;
}

const IMG_W = 260; // px, image box in the Excel sheet
const IMG_H = 90;

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Width and height from the PNG header
const pngSize = (buf: Buffer) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

// shapes.csv: one row per shape, with a full link to its image
// shapes.xlsx: the same rows, with each shape's image inside its row
export async function writeReports(dir: string, shapes: ShapeRow[], fileUrl: (f: string) => string) {
  const header = ['page', 'tag', 'shape', 'type', 'true_length_mm', 'length_to_corners_mm',
    'segments_mm', 'straight_length_mm', 'straight_parts_mm', 'image_url'];
  const lines = [header.join(',')];
  for (const s of shapes) {
    lines.push([s.page, s.tag, s.shape, s.type, s.true_length_mm, s.length_to_corners_mm,
      s.segments_mm.join(' + '), s.straight_length_mm, s.straight_parts_mm.join(' + '),
      s.image ? fileUrl(s.image) : ''].map(csvCell).join(','));
  }
  await writeFile(path.join(dir, 'shapes.csv'), lines.join('\n') + '\n');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shapes', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Image', key: 'img', width: IMG_W / 7 + 2 },
    { header: 'Page', key: 'page', width: 6 },
    { header: 'Tag', key: 'tag', width: 7 },
    { header: 'Shape', key: 'shape', width: 26 },
    { header: 'Type', key: 'type', width: 9 },
    { header: 'True length (mm)', key: 'len', width: 16 },
    { header: 'Legs (mm)', key: 'legs', width: 24 },
    { header: 'Straight length (mm)', key: 'straight', width: 19 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const [i, s] of shapes.entries()) {
    const row = ws.addRow({
      page: s.page, tag: s.tag, shape: s.shape, type: s.type, len: s.true_length_mm,
      legs: s.segments_mm.join(' + '), straight: s.straight_length_mm,
    });
    row.height = IMG_H * 0.75 + 8; // row height is in points
    row.alignment = { vertical: 'middle' };
    if (!s.image) continue;
    const buf = await readFile(path.join(dir, s.image));
    const { w, h } = pngSize(buf);
    const k = Math.min(IMG_W / w, IMG_H / h);
    const id = wb.addImage({ buffer: buf as unknown as ExcelJS.Buffer, extension: 'png' });
    ws.addImage(id, { tl: { col: 0.05, row: i + 1.05 }, ext: { width: w * k, height: h * k }, editAs: 'oneCell' });
  }
  await wb.xlsx.writeFile(path.join(dir, 'shapes.xlsx'));
}
