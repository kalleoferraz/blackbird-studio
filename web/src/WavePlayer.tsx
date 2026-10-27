import { useEffect, useRef, useState } from 'react';
import { assetUrl } from './api.ts';
import { formatDuration, formatTenths } from './format.ts';
import { loadPeaks, type Peaks } from './peaks.ts';

const BAR = 2, GAP = 2, HEIGHT = 72;
/** Tenths of a second under a minute (sound effects are short), minutes and seconds above. */
const clock = (ms: number) => (ms < 60_000 ? formatTenths(ms) : formatDuration(ms));
const PLAYED = '#EF9B0B';
const REST = 'rgba(237, 228, 220, 0.42)';

/**
 * A player for one library file: the sound waves, a playhead, and a click (or drag) anywhere on the waves moves the
 * playhead there. Without a waveform (still being made, or none for this file) a flat line takes its place.
 */
export function WavePlayer({ assetId, light, hasPeaks, durationMs }: { assetId: string; light: boolean; hasPeaks: boolean; durationMs: number | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [w, setW] = useState(400);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0); // seconds
  const [dur, setDur] = useState((durationMs ?? 0) / 1000);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setPeaks(null);
    if (hasPeaks) void loadPeaks(assetId).then((p) => { if (live) setPeaks(p); });
    return () => { live = false; };
  }, [assetId, hasPeaks]);

  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setW(Math.max(120, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(120, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // While playing, follow the audio element every frame so the playhead is smooth.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => { setPos(audio.current?.currentTime ?? 0); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const total = dur > 0 ? dur : peaks ? (peaks.data.length * peaks.step) / 1000 : 0;
  const frac = total > 0 ? Math.min(1, pos / total) : 0;

  useEffect(() => {
    const cv = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = HEIGHT * dpr;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, HEIGHT);
    const cols = Math.max(1, Math.floor(w / (BAR + GAP)));
    const totalMs = total * 1000;
    for (let k = 0; k < cols; k++) {
      let bar = BAR;
      if (peaks && totalMs > 0) {
        const a = Math.floor(((k / cols) * totalMs) / peaks.step);
        const b = Math.max(a + 1, Math.floor((((k + 1) / cols) * totalMs) / peaks.step));
        let m = 0;
        for (let i = a; i < b && i < peaks.data.length; i++) m = Math.max(m, peaks.data[i]!);
        bar = m === 0 ? BAR : Math.max(BAR + 1, (m / 255) * (HEIGHT - 8));
      }
      g.fillStyle = (k + 0.5) / cols <= frac ? PLAYED : REST;
      g.beginPath();
      g.roundRect(k * (BAR + GAP), (HEIGHT - bar) / 2, BAR, bar, BAR / 2);
      g.fill();
    }
  }, [peaks, w, frac, total]);

  const seekTo = (clientX: number) => {
    const a = audio.current;
    const rect = host.current?.getBoundingClientRect();
    if (!a || !rect || total <= 0) return;
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
    a.currentTime = t;
    setPos(t);
  };
  const down = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  };
  const move = (e: React.PointerEvent) => { if (e.buttons & 1) seekTo(e.clientX); };
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch((e) => setError(String(e?.message ?? e)));
    else a.pause();
  };

  return (
    <div className="wave-player">
      <audio ref={audio} preload="metadata" src={assetUrl(assetId, light)}
        onPlay={() => { setPlaying(true); setError(''); }} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPos(audio.current?.duration ?? 0); }}
        onLoadedMetadata={(e) => { const d = (e.target as HTMLAudioElement).duration; if (Number.isFinite(d) && d > 0) setDur(d); }}
        onTimeUpdate={(e) => { if (!playing) setPos((e.target as HTMLAudioElement).currentTime); }}
        onError={() => setError('The file could not be played.')} />
      <button className="primary wp-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
      <div className="wp-wave" ref={host} onPointerDown={down} onPointerMove={move} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(pos)}
        tabIndex={0} onKeyDown={(e) => {
          const a = audio.current;
          if (!a) return;
          if (e.key === 'ArrowRight') { a.currentTime = Math.min(total, a.currentTime + 5); setPos(a.currentTime); }
          if (e.key === 'ArrowLeft') { a.currentTime = Math.max(0, a.currentTime - 5); setPos(a.currentTime); }
          if (e.key === ' ') { e.preventDefault(); toggle(); }
        }}>
        <canvas ref={canvas} style={{ width: '100%', height: HEIGHT }} />
        <div className="wp-head" style={{ left: `${frac * 100}%` }} />
      </div>
      <div className="wp-time muted small">{clock(pos * 1000)} / {clock(total * 1000)}{error ? <span className="error"> · {error}</span> : null}</div>
    </div>
  );
}
