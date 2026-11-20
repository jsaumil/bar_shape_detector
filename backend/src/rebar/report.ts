import ExcelJS from 'exceljs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A shape as rebar_finder writes it in shapes.json
export interface FinderShape {
  page: number;
  tag: string;
  beam?: string | null;
  beam_size?: string | null;
  also_in?: string[];
  shape: string;
  type: string;
  length_to_corners_mm: number;
  segments_mm: number[];
  image?: string;
}

// A shape as the API and the reports show it: one length, the sum of the legs
export interface ShapeRow {
  page: number;
  tag: string;
  beam: string | null; // e.g. "B47", or "GB9, GB10" for one detail of several beams
  beam_size: string | null; // "300x600"
  also_in: string[]; // neighbouring beams a continuous bar runs on into
  shape: string;
  type: string;
  length_mm: number;
  segments_mm: number[];
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

// "B2" before "B10"; shapes without a beam last
const natural = new Intl.Collator('en', { numeric: true });
const tagNo = (tag: string) => Number(tag.replace(/\D/g, '')) || 0;
export function byBeam(a: ShapeRow, b: ShapeRow): number {
  if (a.page !== b.page) return a.page - b.page;
  if (!a.beam !== !b.beam) return a.beam ? -1 : 1;
  return natural.compare(a.beam ?? '', b.beam ?? '') || tagNo(a.tag) - tagNo(b.tag);
}

// shapes.csv: one row per shape, grouped by beam, with a full link to its image
// shapes.xlsx: the same rows with each shape's image inside its row, and a summary per beam
export async function writeReports(dir: string, rows: ShapeRow[], fileUrl: (f: string) => string) {
  const shapes = [...rows].sort(byBeam);
  const header = ['page', 'beam', 'beam_size', 'also_in', 'tag', 'shape', 'type', 'length_mm', 'legs_mm', 'image_url'];
  const lines = [header.join(',')];
  for (const s of shapes) {
    lines.push([s.page, s.beam ?? '', s.beam_size ?? '', s.also_in.join(' '), s.tag, s.shape, s.type, s.length_mm,
      s.segments_mm.join(' + '), s.image ? fileUrl(s.image) : ''].map(csvCell).join(','));
  }
  await writeFile(path.join(dir, 'shapes.csv'), lines.join('\n') + '\n');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Shapes', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Image', key: 'img', width: IMG_W / 7 + 2 },
    { header: 'Page', key: 'page', width: 6 },
    { header: 'Beam', key: 'beam', width: 12 },
    { header: 'Beam size', key: 'size', width: 11 },
    { header: 'Also in', key: 'also', width: 12 },
    { header: 'Tag', key: 'tag', width: 7 },
    { header: 'Shape', key: 'shape', width: 26 },
    { header: 'Type', key: 'type', width: 9 },
    { header: 'Length (mm)', key: 'len', width: 14 },
    { header: 'Legs (mm)', key: 'legs', width: 24 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const [i, s] of shapes.entries()) {
    const row = ws.addRow({
      page: s.page, beam: s.beam ?? '(no beam)', size: s.beam_size ?? '', also: s.also_in.join(', '), tag: s.tag, shape: s.shape, type: s.type, len: s.length_mm,
      legs: s.segments_mm.join(' + '),
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

  // One row per beam: how many shapes and their total length
  const sum = wb.addWorksheet('Beams', { views: [{ state: 'frozen', ySplit: 1 }] });
  sum.columns = [
    { header: 'Page', key: 'page', width: 6 },
    { header: 'Beam', key: 'beam', width: 14 },
    { header: 'Beam size', key: 'size', width: 11 },
    { header: 'Shapes', key: 'count', width: 8 },
    { header: 'Total length (mm)', key: 'total', width: 18 },
    { header: 'Tags', key: 'tags', width: 60 },
  ];
  sum.getRow(1).font = { bold: true };
  const groups = new Map<string, ShapeRow[]>();
  for (const s of shapes) {
    const k = `${s.page}\u0000${s.beam ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const g of groups.values()) {
    sum.addRow({
      page: g[0].page, beam: g[0].beam ?? '(no beam)', size: g[0].beam_size ?? '', count: g.length,
      total: g.reduce((t, s) => t + s.length_mm, 0), tags: g.map((s) => s.tag).join(' '),
    });
  }
  await wb.xlsx.writeFile(path.join(dir, 'shapes.xlsx'));
}
