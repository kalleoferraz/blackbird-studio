import { Worker } from 'node:worker_threads';
import type { Loudness } from './loudness.js';
import type { WorkRequest, WorkResponse } from './types.js';

// Under `tsx` the sources are .ts and the worker needs a small JavaScript entry that registers tsx first
// (same reason as the image worker). After a build everything is .js and the worker starts directly.
const RUNNING_TS = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(RUNNING_TS ? './worker-boot.mjs' : './worker.js', import.meta.url);

export class EncodeError extends Error {}

export interface Processed { mp3: Uint8Array | null; peaks: Uint8Array; loudness: Loudness; ms: number }

/**
 * One worker thread, one encode at a time (Bible, section 6). The thread starts on the first job, stays
 * for `idleMs`, and is replaced if a job times out or the thread dies.
 */
export class EncodePool {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly idleMs = 60_000, private readonly timeoutMs = 180_000) {}

  /** Runs a job; jobs queue up. The caller's buffer is copied, so it stays usable. */
  process(job: Omit<WorkRequest, 'id'>): Promise<Processed> {
    const next = this.queue.then(() => this.runOne(job));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }

  private discard(worker: Worker) {
    if (this.worker === worker) this.worker = null;
    void worker.terminate();
  }

  private async runOne(job: Omit<WorkRequest, 'id'>): Promise<Processed> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.worker) {
      const w = new Worker(WORKER_URL);
      this.worker = w;
      await new Promise<void>((resolve) => w.once('online', () => resolve()));
    }
    const worker = this.worker;
    const id = ++this.seq;
    const copy = new Uint8Array(job.data.byteLength);
    copy.set(job.data);
    try {
      const response = await new Promise<WorkResponse>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); this.discard(worker); reject(new EncodeError(`Processing took longer than ${this.timeoutMs / 1000} s.`)); }, this.timeoutMs);
        const onMessage = (m: WorkResponse) => { if (m.id === id) { cleanup(); resolve(m); } };
        const onError = (e: Error) => { cleanup(); this.discard(worker); reject(new EncodeError(`The audio worker stopped: ${e.message}`)); };
        const onExit = (code: number) => { cleanup(); this.discard(worker); reject(new EncodeError(`The audio worker stopped (exit code ${code}).`)); };
        const cleanup = () => { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); };
        worker.on('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
        worker.postMessage({ ...job, id, data: copy } satisfies WorkRequest, [copy.buffer]);
      });
      if (!response.ok) throw new EncodeError(`${response.error.name}: ${response.error.message}`);
      return { mp3: response.mp3, peaks: response.peaks, loudness: response.loudness, ms: response.ms };
    } finally {
      if (this.worker) {
        this.idleTimer = setTimeout(() => void this.close(), this.idleMs);
        this.idleTimer.unref();
      }
    }
  }
}

let pool: EncodePool | null = null;
export const encodePool = (): EncodePool => (pool ??= new EncodePool());
export async function closeEncodePool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.close();
}
