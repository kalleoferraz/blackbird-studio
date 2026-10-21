// After a recording: the text, the waveform of the take, and handles to cut some of the beginning or the end.
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './ui.tsx';
import type { Take } from './recorder.ts';

export interface TrimRequest { take: Take; text: string; resolve: (keep: { fromMs: number; toMs: number } | null) => void }

const MIN_KEEP_MS = 300;
const H = 120;
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

export function TrimDialog({ req, onDone }: { req: TrimRequest; onDone: (keep: { fromMs: number; toMs: number } | null) => void }) {
  const { take } = req;
  const total = take.durationMs;
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(total);
  const [playMs, setPlayMs] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  const audio = useRef<{ ctx: AudioContext; src: AudioBufferSourceNode; t0: number; from: number } | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setW(Math.max(100, el.clientWidth)));
    ro.observe(el); setW(Math.max(100, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // One peak per pixel column, computed once per width.
  const peaks = useRef<{ w: number; v: Float32Array } | null>(null);
  if (peaks.current?.w !== w) {
    const v = new Float32Array(w), n = take.samples.length;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * n), b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
      let m = 0;
      for (let i = a; i < b; i += Math.max(1, (b - a) >> 6)) m = Math.max(m, Math.abs(take.samples[i]!));
      v[x] = m;
    }
    peaks.current = { w, v };
  }

  useEffect(() => {
    const cv = canvas.current!, dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr); g.clearRect(0, 0, w, H);
    const ax = (from / total) * w, bx = (to / total) * w;
    const v = peaks.current!.v;
    const top = Math.max(0.05, ...v); // scale to the loudest part so a quiet take is still readable
    for (let x = 0; x < w; x++) {
      g.fillStyle = x >= ax && x < bx ? '#F6CF3D' : '#6b605b';
      const h = Math.max(1, Math.min(1, v[x]! / top) * (H - 8));
      g.fillRect(x, (H - h) / 2, 1, h);
    }
    if (playMs !== null) { g.fillStyle = '#EDE4DC'; g.fillRect((playMs / total) * w, 0, 1.5, H); }
  }, [w, from, to, playMs, total]);

  const stop = () => {
    cancelAnimationFrame(raf.current);
    const a = audio.current; audio.current = null;
    if (a) { try { a.src.stop(); } catch { /* already ended */ } void a.ctx.close().catch(() => undefined); }
    setPlayMs(null);
  };
  useEffect(() => stop, []);
  const preview = () => {
    stop();
    const ctx = new AudioContext(), buf = ctx.createBuffer(1, take.samples.length, take.rate);
    buf.copyToChannel(take.samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    src.start(0, from / 1000, (to - from) / 1000);
    const a = { ctx, src, t0: ctx.currentTime, from }; audio.current = a;
    src.onended = () => { if (audio.current === a) stop(); };
    const loop = () => { if (audio.current !== a) return; setPlayMs(a.from + (ctx.currentTime - a.t0) * 1000); raf.current = requestAnimationFrame(loop); };
    loop();
  };

  const drag = (which: 'from' | 'to') => (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = host.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const ms = Math.round(Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) * total);
      if (which === 'from') setFrom((f) => Math.min(ms, to - MIN_KEEP_MS) < 0 ? f : Math.min(ms, to - MIN_KEEP_MS));
      else setTo((t) => Math.max(ms, from + MIN_KEEP_MS) > total ? t : Math.max(ms, from + MIN_KEEP_MS));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const finish = (keep: { fromMs: number; toMs: number } | null) => { stop(); onDone(keep); };
  return (
    <Dialog title="Review the take" wide onClose={() => finish(null)}>
      {req.text.trim() && <p className="trim-text">{req.text}</p>}
      <div className="trim-wave" ref={host} data-testid="trim-wave">
        <canvas ref={canvas} style={{ width: '100%', height: H }} />
        <div className="trim-handle" data-testid="trim-from" style={{ left: `${(from / total) * 100}%` }} onPointerDown={drag('from')} />
        <div className="trim-handle" data-testid="trim-to" style={{ left: `${(to / total) * 100}%` }} onPointerDown={drag('to')} />
      </div>
      <div className="pk-line">
        <span>From</span><span className="num">{sec(from)}</span>
        <span>to</span><span className="num">{sec(to)}</span>
        <span>length</span><span className="num">{sec(to - from)}</span>
        <span className="grow" />
        <button onClick={() => { setFrom(0); setTo(total); }} disabled={from === 0 && to === total}>Reset</button>
        <button onClick={playMs === null ? preview : stop}>{playMs === null ? '▶ Play' : '■ Stop'}</button>
      </div>
      <div className="row end pk-btns">
        <span className="muted small grow">Drag the handles to cut the beginning or the end. Only the yellow part is kept.</span>
        <button onClick={() => finish(null)}>Discard take</button>
        <button className="primary" onClick={() => finish({ fromMs: from, toMs: to })}>Save take</button>
      </div>
    </Dialog>
  );
}
