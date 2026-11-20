import { parentPort } from 'node:worker_threads';
import { encodeWav } from './encode.js';
import type { Loudness } from './loudness.js';
import { analyseMp3, analyseWav } from './peaks.js';
import type { WorkRequest, WorkResponse } from './types.js';

/** Worker thread entry: one file at a time; the results are transferred back, not copied. */
if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;

/** A transferable copy of exactly these bytes (a view may sit inside a larger shared buffer). */
const own = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

port.on('message', async (req: WorkRequest) => {
  const t0 = performance.now();
  try {
    let mp3: Uint8Array | null = null;
    let peaks: Uint8Array, loudness: Loudness;
    if (req.kind === 'mp3') ({ peaks, loudness } = await analyseMp3(req.data));
    else if (req.peaksOnly) ({ peaks, loudness } = analyseWav(req.data));
    else ({ mp3, peaks, loudness } = await encodeWav(req.data, req.kbps));
    const m = mp3 ? own(mp3) : null, p = own(peaks);
    port.postMessage({ id: req.id, ok: true, mp3: m ? new Uint8Array(m) : null, peaks: new Uint8Array(p), loudness, ms: Math.round(performance.now() - t0) } satisfies WorkResponse, m ? [m, p] : [p]);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    port.postMessage({ id: req.id, ok: false, error: { name: err.name, message: err.message } } satisfies WorkResponse);
  }
});
