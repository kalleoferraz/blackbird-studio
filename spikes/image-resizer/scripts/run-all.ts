/**
 * Runs every fixture through every library, each case in its own process, and writes results/results.json.
 *   node --import tsx scripts/run-all.ts [fixturesDir] [lib ...]
 * Then:  python3 scripts/check_outputs.py   (checks the outputs and writes results/report.md)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { LIB_IDS, type LibId } from '../../../src/spike/image/types.js';
import { packageVersion } from '../../../src/spike/image/resizers/util.js';

const fixtures = process.argv[2] ?? 'fixtures';
const only = process.argv.slice(3) as LibId[];
const libs = only.length ? only : [...LIB_IDS];
const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const outDir = 'results/out';
if (!process.env.ONLY) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ONLY="a.jpg,b.png" runs just those fixtures and merges them into the existing results.json
const onlyFiles = process.env.ONLY?.split(',').filter(Boolean);
const files = onlyFiles ?? Object.keys(manifest);
let cases: Record<string, unknown>[] = [];
if (onlyFiles) {
  try {
    cases = (JSON.parse(readFileSync('results/results.json', 'utf8')) as { cases: typeof cases }).cases
      .filter((c) => !(onlyFiles.includes(String(c.file)) && libs.includes(c.lib as LibId)));
  } catch { /* no earlier results */ }
}
for (const lib of libs) {
  for (const file of files) {
    const t0 = Date.now();
    const p = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-case.ts', lib, join(fixtures, file), outDir, '3'], {
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const line = p.stdout.trim().split('\n').pop() ?? '';
    try {
      cases.push(JSON.parse(line));
      process.stdout.write('.');
    } catch {
      cases.push({ lib, file, crashed: true, exitCode: p.status, signal: p.signal, stderr: p.stderr.slice(-800), wallMs: Date.now() - t0 });
      process.stdout.write('X');
    }
  }
  process.stdout.write(` ${lib}\n`);
}

const env = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: os.cpus()[0]?.model,
  cpus: os.cpus().length,
  totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
  libraries: {
    'wasm-vips': packageVersion('wasm-vips'),
    jimp: packageVersion('jimp'),
    jsquash: packageVersion('@jsquash/jpeg'),
  },
};
writeFileSync('results/results.json', JSON.stringify({ env, cases }, null, 1));
console.log(`${cases.length} cases written to results/results.json`);
