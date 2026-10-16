import { Worker } from 'node:worker_threads';
import { toArrayBuffer } from './resizers/util.js';
import type { FailureCode, LibId, ResizeJob, WorkerRequest, WorkerResponse } from './types.js';

// Under `tsx` (npm run dev) the sources are .ts and the worker needs a small JavaScript entry that registers tsx
// first: a worker thread does not get tsx's `.js` -> `.ts` import mapping on its own (found in the spike).
// After a build everything is .js and the worker starts directly.
const RUNNING_TS = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(RUNNING_TS ? './worker-boot.mjs' : './worker.js', import.meta.url);

export class ResizeError extends Error {
  constructor(public code: FailureCode, message: string) {
    super(message);
  }
}

export interface PoolOptions {
  /** Terminate the worker after this long without a job, to give its memory back. Default 60 s. */
  idleMs?: number;
  /** Give up on a job after this long and replace the worker. Default 60 s. */
  timeoutMs?: number;
  /** V8 heap limit for the worker, in MB. WebAssembly memory is not counted in it. Default: Node's. */
  maxOldGenerationMb?: number;
}

export type PoolSuccess = Extract<WorkerResponse, { ok: true }> & {
  /** True when this job had to start a new worker thread. */
  workerSpawned: boolean;
  /** Time from creating the worker thread until it was running, when spawned for this job. */
  spawnMs: number;
};

/**
 * One worker thread, one job at a time (Bible, section 6). The thread starts on the first job, stays
 * for `idleMs`, and is replaced if a job times out or the thread dies.
 */
export class ResizeWorkerPool {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly idleMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: PoolOptions = {}) {
    this.idleMs = opts.idleMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** Runs a job; jobs queue up and run one at a time. Rejects with a ResizeError. */
  run(lib: LibId, job: ResizeJob): Promise<PoolSuccess> {
    const next = this.queue.then(() => this.runOne(lib, job));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }

  private spawn(): Worker {
    return new Worker(WORKER_URL, {
      resourceLimits: this.opts.maxOldGenerationMb ? { maxOldGenerationSizeMb: this.opts.maxOldGenerationMb } : undefined,
    });
  }

  private async runOne(lib: LibId, job: ResizeJob): Promise<PoolSuccess> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    let workerSpawned = false;
    let spawnMs = 0;
    if (!this.worker) {
      const t0 = performance.now();
      this.worker = this.spawn();
      workerSpawned = true;
      await new Promise<void>((resolve) => this.worker?.once('online', () => resolve()));
      spawnMs = Math.round(performance.now() - t0);
    }
    const worker = this.worker;
    const id = ++this.seq;
    // the caller keeps its buffer: copy once, then transfer the copy
    const buffer = toArrayBuffer(job.input);
    const request: WorkerRequest = { id, lib, job: { ...job, input: new Uint8Array(buffer) } };

    try {
      const response = await new Promise<WorkerResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          this.discard(worker);
          reject(new ResizeError('timeout', `resize took longer than ${this.timeoutMs} ms`));
        }, this.timeoutMs);
        const onMessage = (m: WorkerResponse) => { if (m.id === id) { cleanup(); resolve(m); } };
        const onError = (e: Error) => { cleanup(); this.discard(worker); reject(new ResizeError('worker_crashed', e.message)); };
        const onExit = (code: number) => { cleanup(); this.discard(worker); reject(new ResizeError('worker_crashed', `worker exited with code ${code}`)); };
        const cleanup = () => {
          clearTimeout(timer);
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        };
        worker.on('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
        worker.postMessage(request, [buffer]);
      });
      if (!response.ok) throw new ResizeError('decode_failed', `${response.error.name}: ${response.error.message}`);
      return { ...response, workerSpawned, spawnMs };
    } finally {
      this.armIdleTimer();
    }
  }

  private discard(worker: Worker) {
    if (this.worker === worker) this.worker = null;
    void worker.terminate();
  }

  private armIdleTimer() {
    if (!this.worker) return;
    this.idleTimer = setTimeout(() => void this.close(), this.idleMs);
    this.idleTimer.unref();
  }
}
