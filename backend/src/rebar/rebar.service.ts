import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { byBeam, type FinderShape, type ShapeRow, writeReports } from './report';

// backend/finder/rebar_finder.ts (same path from src/rebar and dist/rebar)
const FINDER = path.resolve(__dirname, '../../finder/rebar_finder.ts');
const JOBS_DIR = process.env.JOBS_DIR ?? path.resolve(process.cwd(), 'jobs');
const UUID = /^[0-9a-f-]{36}$/;
const FILE = /^[\w.#-]+\.(png|csv|json|xlsx)$/;

// Finder output lines worth showing in the server log (the rest stays in the job's log)
const MAIN_LINE = /^\s*(page \d+:|scale|beams:|scale check:|WARNING|warning: vertical|error|Error|wrote|no )/;

// Public address of the site (the frontend, which forwards /api), used for the image links in the CSV
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:8000';

export interface AnalyzeOptions {
  mmPerPt?: string;
  scale?: string;
  verticalRatio?: string;
  pages?: string;
}

@Injectable()
export class RebarService {
  private readonly logger = new Logger('Rebar');

  async analyze(pdf: Buffer, opts: AnalyzeOptions, fileName = 'upload.pdf') {
    const id = randomUUID();
    const job = id.slice(0, 8);
    const started = Date.now();
    const given = Object.entries(opts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');
    this.logger.log(`[${job}] new job: "${fileName}" (${(pdf.length / 1024 / 1024).toFixed(2)} MB)${given ? `, options: ${given}` : ''}`);
    const dir = path.join(JOBS_DIR, id);
    await mkdir(dir, { recursive: true });
    const pdfPath = path.join(dir, 'input.pdf');
    await writeFile(pdfPath, pdf);

    const args = [FINDER, pdfPath, '--out', dir];
    const num = /^\d+(\.\d+)?$/;
    if (opts.mmPerPt && num.test(opts.mmPerPt)) args.push('--mm-per-pt', opts.mmPerPt);
    if (opts.scale && num.test(opts.scale)) args.push('--scale', opts.scale);
    if (opts.verticalRatio && num.test(opts.verticalRatio)) args.push('--vertical-ratio', opts.verticalRatio);
    if (opts.pages && /^\d+(,\d+)*$/.test(opts.pages)) args.push('--pages', opts.pages);

    const { out: log, code } = await this.run(args, job);
    const jsonPath = path.join(dir, 'shapes.json');
    if (!existsSync(jsonPath)) {
      this.logger.error(`[${job}] finder failed (exit ${code}) after ${secs(started)}:\n${log.slice(-2000)}`);
      throw new InternalServerErrorException(`Finder failed:\n${log.slice(-2000)}`);
    }

    const result = JSON.parse(await readFile(jsonPath, 'utf8'));
    // One length per bar: the sum of its legs (corner to corner)
    const shapes: ShapeRow[] = result.shapes.map((s: FinderShape) => ({
      page: s.page,
      tag: s.tag,
      beam: s.beam ?? null,
      beam_size: s.beam_size ?? null,
      also_in: s.also_in ?? [],
      shape: s.shape,
      type: s.type,
      length_mm: s.length_to_corners_mm,
      segments_mm: s.segments_mm,
      image: s.image,
    }));
    const url = (f: string) => `/api/jobs/${id}/${f}`;
    await writeReports(dir, shapes, (f) => PUBLIC_URL + url(f));

    const inBeams = shapes.filter((s) => s.beam).length;
    const beams = new Set(shapes.filter((s) => s.beam).map((s) => `${s.page}:${s.beam}`)).size;
    for (const p of result.pages as { page: number; mm_per_pt: number; depth_status?: string }[]) {
      const n = shapes.filter((s) => s.page === p.page).length;
      this.logger.log(`[${job}] page ${p.page}: ${n} shapes, scale ${p.mm_per_pt} mm/pt, depth check ${p.depth_status ?? '-'}`);
    }
    this.logger.log(`[${job}] done in ${secs(started)}: ${result.pages.length} page(s), ${shapes.length} shapes, `
      + `${inBeams} in ${beams} beams, ${shapes.length - inBeams} without a beam; reports in ${dir}`);
    return {
      jobId: id,
      log,
      csvUrl: url('shapes.csv'),
      xlsxUrl: url('shapes.xlsx'),
      pages: result.pages.map((p: { page: number }) => ({
        ...p,
        overlayUrl: url(`page${p.page}_shapes.png`),
      })),
      shapes: [...shapes].sort(byBeam).map((s) => ({ ...s, imageUrl: s.image ? url(s.image) : null })),
    };
  }

  // Absolute path of a result file, after checking the names (no path traversal)
  filePath(id: string, ...parts: string[]): string {
    const name = parts[parts.length - 1];
    if (!UUID.test(id) || !FILE.test(name)) {
      this.logger.warn(`bad file request: ${id}/${parts.join('/')}`);
      throw new BadRequestException('Bad file name');
    }
    const p = path.join(JOBS_DIR, id, ...parts);
    if (!existsSync(p)) {
      this.logger.warn(`[${id.slice(0, 8)}] file not found: ${parts.join('/')}`);
      throw new NotFoundException();
    }
    if (name.endsWith('.xlsx') || name.endsWith('.csv')) this.logger.log(`[${id.slice(0, 8)}] download ${name}`);
    return p;
  }

  // Run the finder, logging its main lines as they come
  private run(args: string[], job: string): Promise<{ out: string; code: number | null }> {
    const started = Date.now();
    this.logger.log(`[${job}] finder started`);
    return new Promise((resolve) => {
      const child = spawn(process.execPath.includes('bun') ? process.execPath : 'bun', args);
      let out = '';
      let partial = '';
      const take = (d: Buffer) => {
        out += d;
        const lines = (partial + d).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
          if (!MAIN_LINE.test(line)) continue;
          const text = `[${job}] ${line.trim()}`;
          if (/WARNING|warning/.test(line)) this.logger.warn(text);
          else if (/error/i.test(line)) this.logger.error(text);
          else this.logger.log(text);
        }
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('close', (code) => {
        this.logger.log(`[${job}] finder finished (exit ${code}) in ${secs(started)}`);
        resolve({ out, code });
      });
      child.on('error', (e) => {
        this.logger.error(`[${job}] could not start the finder: ${e.message}`);
        resolve({ out: out + String(e), code: null });
      });
    });
  }
}

const secs = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} s`;
