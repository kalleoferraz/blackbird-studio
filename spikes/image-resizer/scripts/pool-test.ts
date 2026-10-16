/**
 * Behaviour of the worker pool under stress: timeout, crash, idle shutdown, sequential load.
 *   node --import tsx scripts/pool-test.ts
 */
import { readFileSync } from 'node:fs';
import { ResizeWorkerPool } from '../../../src/spike/image/pool.js';
import { processImage, type ProcessResult } from '../../../src/spike/image/process.js';

const photo = new Uint8Array(readFileSync('fixtures/photo12mp_o6.jpg'));
const rss = () => Math.round(process.memoryUsage.rss() / 1048576);
const line = (label: string, v: unknown) => console.log(label.padEnd(46), typeof v === 'string' ? v : JSON.stringify(v));
const brief = (r: ProcessResult) =>
  r.status === 'failed' ? `failed: ${r.error.code}: ${r.error.message.slice(0, 60)}`
  : r.status === 'resized' ? `resized (new worker: ${r.metrics.workerSpawned})`
  : r.status;

// 1. timeout: the job is abandoned, the worker is replaced, and the next job works
{
  const pool = new ResizeWorkerPool({ timeoutMs: 60 });
  const a = await processImage(photo, { lib: 'wasm-vips', name: 'p.jpg', pool });
  (pool as unknown as { timeoutMs: number }).timeoutMs = 20_000;
  const b = await processImage(photo, { lib: 'wasm-vips', name: 'p.jpg', pool });
  line('1 timeout (60 ms), then retry on same pool', `${brief(a)}  ->  ${brief(b)}`);
  await pool.close();
}
// 2. crash: a 24 MB V8 heap limit kills the worker while Jimp decodes a 12 MP image
{
  const pool = new ResizeWorkerPool({ maxOldGenerationMb: 24, timeoutMs: 30_000 });
  const a = await processImage(photo, { lib: 'jimp', name: 'p.jpg', pool });
  const b = await processImage(photo, { lib: 'wasm-vips', name: 'p.jpg', pool });
  line('2 jimp with 24 MB heap limit, then wasm-vips', `${brief(a)}  ->  ${brief(b)}`);
  await pool.close();
}
// 3. idle shutdown gives the memory back
{
  const pool = new ResizeWorkerPool({ idleMs: 300 });
  const a = await processImage(photo, { lib: 'wasm-vips', name: 'p.jpg', pool });
  const during = rss();
  await new Promise((r) => setTimeout(r, 900));
  const after = rss();
  const b = await processImage(photo, { lib: 'wasm-vips', name: 'p.jpg', pool });
  line('3 idle shutdown (300 ms)', {
    firstSpawned: a.status === 'resized' && a.metrics.workerSpawned,
    rssAfterJobMB: during,
    rssAfterIdleMB: after,
    nextSpawned: b.status === 'resized' && b.metrics.workerSpawned,
  });
  await pool.close();
}
// 4. 60 sequential 12 MP jobs in one worker: does memory keep growing?
{
  const pool = new ResizeWorkerPool({ idleMs: 60_000 });
  const samples: number[] = [];
  const t0 = performance.now();
  for (let i = 1; i <= 60; i++) {
    const r = await processImage(photo, { lib: 'wasm-vips', name: 'p.jpg', pool });
    if (r.status !== 'resized') { line('4 failure at job ' + i, brief(r)); break; }
    if (i % 10 === 0) samples.push(rss());
  }
  line('4 60 sequential jobs, RSS MB after every 10', samples);
  line('4 total / per job', `${Math.round(performance.now() - t0)} ms / ${Math.round((performance.now() - t0) / 60)} ms`);
  await pool.close();
}
process.exit(0);
