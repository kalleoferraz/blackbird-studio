// Waveform peaks of an asset (one byte per `step` ms, 0 = silence ... 255 = full scale), fetched once and kept.
export interface Peaks { step: number; data: Uint8Array }

const cache = new Map<string, Promise<Peaks | null>>();

/** Drops what was fetched for an asset (its file was replaced, so the waveform changed). */
export function forgetPeaks(assetId: string): void { cache.delete(assetId); }

export function loadPeaks(assetId: string): Promise<Peaks | null> {
  let p = cache.get(assetId);
  if (!p) {
    p = fetch(`/api/assets/${assetId}/peaks`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) return null;
        return { step: Number(r.headers.get('X-Peaks-Step-Ms') ?? 100), data: new Uint8Array(await r.arrayBuffer()) };
      })
      .catch(() => null);
    // A missing waveform (still being made) is looked up again next time.
    void p.then((v) => { if (!v) cache.delete(assetId); });
    cache.set(assetId, p);
  }
  return p;
}
