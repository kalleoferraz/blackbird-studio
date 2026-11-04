import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { formatDuration, formatTenths } from './format.ts';
import { loadPeaks, type Peaks } from './peaks.ts';
import type { LibraryPlayer } from './libplayer.ts';

const BAR = 2, GAP = 2;
/** Tenths of a second under a minute (sound effects are short), minutes and seconds above. */
const clock = (ms: number) => (ms < 60_000 ? formatTenths(ms) : formatDuration(ms));
const PLAYED = '#EF9B0B';
const REST = 'rgba(237, 228, 220, 0.42)';

/** The waveform of an asset (null while it loads, or when there is none). */
export function usePeaks(assetId: string, hasPeaks: boolean): Peaks | null {
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  useEffect(() => {
    let live = true;
    setPeaks(null);
    if (assetId && hasPeaks) void loadPeaks(assetId).then((p) => { if (live) setPeaks(p); });
    return () => { live = false; };
  }, [assetId, hasPeaks]);
  return peaks;
}

/** The sound waves with a playhead; a click (or drag) anywhere on them calls `onSeek` with the place as 0..1. Without peaks, a flat line. */
export function WaveView({ peaks, total, frac, height, onSeek, onKeyDown }: {
  peaks: Peaks | null; total: number; frac: number; height: number; onSeek: (frac: number) => void; onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(400);

  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setW(Math.max(60, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(60, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = height * dpr;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, height);
    const cols = Math.max(1, Math.floor(w / (BAR + GAP)));
    const totalMs = total * 1000;
    for (let k = 0; k < cols; k++) {
      let bar = BAR;
      if (peaks && totalMs > 0) {
        const a = Math.floor(((k / cols) * totalMs) / peaks.step);
        const b = Math.max(a + 1, Math.floor((((k + 1) / cols) * totalMs) / peaks.step));
        let m = 0;
        for (let i = a; i < b && i < peaks.data.length; i++) m = Math.max(m, peaks.data[i]!);
        bar = m === 0 ? BAR : Math.max(BAR + 1, (m / 255) * (height - 8));
      }
      g.fillStyle = (k + 0.5) / cols <= frac ? PLAYED : REST;
      g.beginPath();
      g.roundRect(k * (BAR + GAP), (height - bar) / 2, BAR, bar, BAR / 2);
      g.fill();
    }
  }, [peaks, w, frac, total, height]);

  const seekTo = (clientX: number) => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    onSeek(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
  };
  return (
    <div className="wp-wave" ref={host} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(frac * total)} tabIndex={0}
      onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); seekTo(e.clientX); }}
      onPointerMove={(e) => { if (e.buttons & 1) seekTo(e.clientX); }} onKeyDown={onKeyDown}>
      <canvas ref={canvas} style={{ width: '100%', height }} />
      <div className="wp-head" style={{ left: `${frac * 100}%` }} />
    </div>
  );
}

/** The library sound in the player bar: the waves with the playhead, and the time. The play button is the bar's own. */
export function LibWave({ lib }: { lib: LibraryPlayer }) {
  useSyncExternalStore(lib.subscribe, lib.getVersion);
  const t = lib.track;
  const peaks = usePeaks(t?.id ?? '', !!t?.hasPeaks);
  const total = lib.dur > 0 ? lib.dur : peaks ? (peaks.data.length * peaks.step) / 1000 : 0;
  const frac = total > 0 ? Math.min(1, lib.pos / total) : 0;
  return (
    <div className="lib-wave">
      <WaveView peaks={peaks} total={total} frac={frac} height={36} onSeek={(f) => lib.seek(f * total)} onKeyDown={(e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); lib.seek(lib.pos + 5); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); lib.seek(lib.pos - 5); }
      }} />
      <span className="lib-time">{clock(lib.pos * 1000)} / {clock(total * 1000)}{lib.error ? <span className="error"> · {lib.error}</span> : null}</span>
    </div>
  );
}
