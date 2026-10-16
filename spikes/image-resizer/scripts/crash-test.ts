/** The worker thread dies in the middle of a job (killed from outside): the caller gets a clear error and the next job works. */
import { readFileSync } from 'node:fs';
import { ResizeWorkerPool } from '../../../src/spike/image/pool.js';
import { processImage } from '../../../src/spike/image/process.js';

const photo = new Uint8Array(readFileSync('fixtures/photo12mp_o6.jpg'));
const pool = new ResizeWorkerPool({ timeoutMs: 30_000 });
const running = processImage(photo, { lib: 'jimp', name: 'p.jpg', pool }); // about 4 s of work
await new Promise((r) => setTimeout(r, 600));
await (pool as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
const a = await running;
console.log('job while the worker is killed :', a.status === 'failed' ? `${a.error.code}: ${a.error.message}` : a.status);
const b = await processImage(photo, { lib: 'wasm-vips', name: 'p.jpg', pool });
console.log('next job                        :', b.status, b.status === 'resized' ? `(new worker: ${b.metrics.workerSpawned})` : '');
await pool.close();
process.exit(0);
