import { ResizeWorkerPool } from '../images/pool.js';

let pool: ResizeWorkerPool | null = null;

/** The one resize worker of the process (Bible, section 6): one job at a time, started on demand. */
export function resizePool(): ResizeWorkerPool {
  pool ??= new ResizeWorkerPool();
  return pool;
}

export async function closeResizePool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.close();
}
