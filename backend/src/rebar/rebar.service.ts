import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeReports } from './report';

// backend/finder/rebar_finder.ts (same path from src/rebar and dist/rebar)
const FINDER = path.resolve(__dirname, '../../finder/rebar_finder.ts');
const JOBS_DIR = process.env.JOBS_DIR ?? path.resolve(process.cwd(), 'jobs');
const UUID = /^[0-9a-f-]{36}$/;
const FILE = /^[\w.#-]+\.(png|csv|json|xlsx)$/;

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
  async analyze(pdf: Buffer, opts: AnalyzeOptions) {
    const id = randomUUID();
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

    const log = await this.run(args);
    const jsonPath = path.join(dir, 'shapes.json');
    if (!existsSync(jsonPath)) throw new InternalServerErrorException(`Finder failed:\n${log.slice(-2000)}`);

    const result = JSON.parse(await readFile(jsonPath, 'utf8'));
    const url = (f: string) => `/api/jobs/${id}/${f}`;
    await writeReports(dir, result.shapes, (f) => PUBLIC_URL + url(f));
    return {
      jobId: id,
      log,
      csvUrl: url('shapes.csv'),
      xlsxUrl: url('shapes.xlsx'),
      pages: result.pages.map((p: { page: number }) => ({
        ...p,
        overlayUrl: url(`page${p.page}_shapes.png`),
      })),
      shapes: result.shapes.map((s: { image?: string }) => ({
        ...s,
        imageUrl: s.image ? url(s.image) : null,
      })),
    };
  }

  // Absolute path of a result file, after checking the names (no path traversal)
  filePath(id: string, ...parts: string[]): string {
    if (!UUID.test(id) || !FILE.test(parts[parts.length - 1])) throw new BadRequestException('Bad file name');
    const p = path.join(JOBS_DIR, id, ...parts);
    if (!existsSync(p)) throw new NotFoundException();
    return p;
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath.includes('bun') ? process.execPath : 'bun', args);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', () => resolve(out));
      child.on('error', (e) => resolve(out + String(e)));
    });
  }
}
