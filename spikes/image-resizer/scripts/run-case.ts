/**
 * One library, one file, in a fresh process (so the memory peak belongs to this case alone).
 *   node --import tsx scripts/run-case.ts <lib> <file> <outDir> [repeats]
 * Run 1 is "cold" (new worker, library loaded). Runs 2..n reuse the worker ("warm").
 * Prints one JSON line.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ResizeWorkerPool } from '../../../src/spike/image/pool.js';
import { processImage } from '../../../src/spike/image/process.js';
import { LIB_IDS, type LibId } from '../../../src/spike/image/types.js';

const [libArg, file, outDir, repeatsArg] = process.argv.slice(2);
if (!libArg || !file || !outDir || !LIB_IDS.includes(libArg as LibId)) {
  console.error('usage: run-case.ts <wasm-vips|jimp|jsquash> <file> <outDir> [repeats]');
  process.exit(2);
}
const lib = libArg as LibId;
const repeats = Number(repeatsArg ?? 3);
const input = new Uint8Array(readFileSync(file));
const name = basename(file);
const baselineRssMB = Math.round((process.memoryUsage.rss() / 1024 / 1024) * 10) / 10;

const pool = new ResizeWorkerPool({ idleMs: 5_000, timeoutMs: 120_000 });
const runs: unknown[] = [];
for (let i = 0; i < repeats; i++) {
  const r = await processImage(input, { lib, name, pool });
  if (i === 0 && r.status === 'resized') {
    mkdirSync(join(outDir, lib), { recursive: true });
    writeFileSync(join(outDir, lib, r.output.name), r.output.data);
  }
  const { output, ...rest } = r as typeof r & { output?: { data: Uint8Array; width: number; height: number; format: string; bytes: number; name: string } };
  runs.push({ ...rest, output: output && { width: output.width, height: output.height, format: output.format, bytes: output.bytes, name: output.name } });
  if (r.status !== 'resized') break; // skipped and failed cases do not change on a repeat
}
const maxRssMB = Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10; // KB to MB
console.log(JSON.stringify({ lib, file: name, baselineRssMB, maxRssMB, runs }));
await pool.close();
process.exit(0);
