import { parentPort } from 'node:worker_threads';
import { loadResizer } from './resizers/index.js';
import { toArrayBuffer } from './resizers/util.js';
import type { WorkerRequest, WorkerResponse } from './types.js';

/**
 * Worker thread entry. Receives one job at a time, answers with the resized bytes (transferred, not copied).
 * The library stays loaded between jobs, so only the first job in a worker pays the start-up cost.
 */
if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;

port.on('message', async (req: WorkerRequest) => {
  const t0 = performance.now();
  let initMs = 0;
  try {
    const resizer = await loadResizer(req.lib);
    initMs = Math.round(performance.now() - t0);

    const t1 = performance.now();
    const output = await resizer.resize(req.job);
    const resizeMs = Math.round(performance.now() - t1);

    const buffer = toArrayBuffer(output.data); // never transfer a view over a larger shared buffer
    const response: WorkerResponse = {
      id: req.id,
      ok: true,
      output: { ...output, data: new Uint8Array(buffer) },
      initMs,
      resizeMs,
      libVersion: resizer.version,
    };
    port.postMessage(response, [buffer]);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const response: WorkerResponse = { id: req.id, ok: false, error: { name: err.name, message: err.message }, initMs };
    port.postMessage(response);
  }
});
