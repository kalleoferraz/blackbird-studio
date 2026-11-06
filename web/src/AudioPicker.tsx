import { useEffect, useMemo, useRef, useState } from 'react';
import { api, assetUrl } from './api.ts';
import type { Cue, LibFile, SegmentContent } from './types.ts';
import { Dialog, errorText, useLocalState } from './ui.tsx';
import { formatMs, formatTenths, parseLength } from './format.ts';

const MIN_MS = 100;
const YOLK = '#F6CF3D'; // the piece that "Use this piece" will keep
const STEP = 100; // the waveform has one value per 100 ms, so pieces start and end on it

interface Peaks { step: number; data: Uint8Array }

/** One waveform with the frame of the chosen piece. Dragging the frame moves it; its edges resize it (unless the length is kept). */
function WaveBox({ peaks, from, to, start, len, locked, colour, height, playMs, hilite, onChange, onDrag }: {
  peaks: Peaks | null; from: number; to: number; start: number; len: number; locked: boolean; colour: string; height: number; playMs: number | null; hilite?: boolean;
  onChange: (start: number, len: number) => void; onDrag: (on: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setW(Math.max(100, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(100, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const cv = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = height * dpr;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, height);
    if (!peaks) return;
    g.globalAlpha = 0.9;
    const ax = ((start - from) / (to - from)) * w, bx = ((start + len - from) / (to - from)) * w;
    for (let x = 0; x < w; x++) {
      g.fillStyle = hilite && x >= ax && x < bx ? YOLK : colour;
      const a = Math.floor(((from + (x / w) * (to - from)) / peaks.step)), b = Math.max(a + 1, Math.floor((from + ((x + 1) / w) * (to - from)) / peaks.step));
      let m = 0;
      for (let i = a; i < b && i < peaks.data.length; i++) m = Math.max(m, peaks.data[i]!);
      const h = m === 0 ? 1 : Math.max(2, (m / 255) * (height - 6));
      g.fillRect(x, (height - h) / 2, 1, h);
    }
  }, [peaks, from, to, w, height, colour, hilite, start, len]);

  const span = Math.max(1, to - from), px = w / span;
  const x0 = (start - from) * px, x1 = (start + len - from) * px;
  const down = (e: React.PointerEvent) => {
    let kind = (e.target as HTMLElement).dataset.k ?? ((e.target as HTMLElement).closest('.win') ? 'move' : null);
    const rect = host.current!.getBoundingClientRect();
    let s0 = start;
    if (!kind) { // a click on the empty waveform centres the piece there
      s0 = from + ((e.clientX - rect.left) / w) * span - len / 2;
      onChange(s0, len);
      kind = 'move';
    }
    if (locked && kind !== 'move') kind = 'move';
    const l0 = len, cx = e.clientX;
    onDrag(true);
    const mv = (ev: PointerEvent) => {
      const dt = Math.round(((ev.clientX - cx) / w) * span / STEP) * STEP;
      if (kind === 'move') onChange(s0 + dt, l0);
      else if (kind === 'L') { const end = s0 + l0; const ns = Math.min(end - MIN_MS, s0 + dt); onChange(ns, end - ns); }
      else onChange(s0, l0 + dt);
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); onDrag(false); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={'wv' + (locked ? ' locked' : '')} ref={host} onPointerDown={down} style={{ height, ['--c' as string]: hilite ? YOLK : colour }}>
      <canvas ref={canvas} style={{ width: '100%', height }} />
      <div className="shade" style={{ left: 0, width: Math.max(0, x0) }} />
      <div className="shade" style={{ left: Math.min(w, x1), right: 0 }} />
      <div className="win" data-k="move" style={{ left: x0, width: Math.max(6, x1 - x0) }}>
        <div className="hd" data-k="L" style={{ left: -6 }} /><div className="hd" data-k="R" style={{ right: -6 }} />
      </div>
      {playMs !== null && playMs >= from && playMs <= to && <div className="pp" style={{ left: (playMs - from) * px }} />}
    </div>
  );
}

function Axis({ from, to }: { from: number; to: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setW(Math.max(100, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(100, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  const span = Math.max(1, to - from) / 1000;
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => (s / span) * w >= 70) ?? 600;
  const ticks: number[] = [];
  for (let t = Math.ceil(from / 1000 / step) * step; t <= to / 1000 + 1e-6; t += step) ticks.push(t);
  return (
    <div className="axis" ref={host}>
      {ticks.map((t) => <span key={t} style={{ left: ((t * 1000 - from) / (to - from)) * w }}>{formatMs(t * 1000).replace(/\.0$/, '')}</span>)}
    </div>
  );
}

interface TreeNode { name: string; path: string; folders: TreeNode[]; files: LibFile[] }

/** The folders of the library that hold audio (and only those), from the flat list of audio files. */
function audioTree(files: LibFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folders: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    parts.pop();
    let node = root;
    for (const part of parts) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.folders.find((c) => c.path === path);
      if (!next) { next = { name: part, path, folders: [], files: [] }; node.folders.push(next); }
      node = next;
    }
    node.files.push(f);
  }
  const sort = (n: TreeNode) => { n.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })); n.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })); n.folders.forEach(sort); };
  sort(root);
  return root;
}

/** A small version of the library panel: only the folders with audio, which open and close here independently of the panel's own. */
function AudioTree({ projectId, files, selected, onSelect }: { projectId: string; files: LibFile[]; selected: string | null; onSelect: (f: LibFile) => void }) {
  const [open, setOpen] = useLocalState<string[]>(`rs.audioPickOpen.${projectId}`, []);
  const root = useMemo(() => audioTree(files), [files]);
  const sel = files.find((f) => f.id === selected);
  const keep = new Set(open);
  if (sel) { const parts = sel.path.split('/'); parts.pop(); parts.forEach((_, i) => keep.add(parts.slice(0, i + 1).join('/'))); } // the chosen file is always visible
  const toggle = (path: string) => setOpen(keep.has(path) ? open.filter((o) => o !== path && !o.startsWith(path + '/')) : [...open, path]);
  const folderIcon = (isOpen: boolean) => isOpen
    ? <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H7.2a2 2 0 0 0-1.9 1.4L3 17z" fill="#C9830A" /><path d="M5.3 11.4A2 2 0 0 1 7.2 10H21l-2.3 7.6a2 2 0 0 1-1.9 1.4H3z" fill="#EF9B0B" /></svg>
    : <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#EF9B0B" /></svg>;
  const render = (n: TreeNode, depth: number): React.ReactNode => (
    <>
      {n.folders.map((f) => {
        const isOpen = keep.has(f.path);
        return (
          <div key={f.path}>
            <div className="tree-row" style={{ paddingLeft: depth * 14 }}>
              <button className="tree-main" onClick={() => toggle(f.path)}><span className="tree-icon folder">{folderIcon(isOpen)}</span><span className="grow lib-name">{f.name}</span></button>
            </div>
            {isOpen && render(f, depth + 1)}
          </div>
        );
      })}
      {n.files.map((f) => (
        <div key={f.id} className={'tree-row pk-file' + (f.id === selected ? ' sel' : '')} style={{ paddingLeft: depth * 14 }}>
          <button className="tree-main" onClick={() => onSelect(f)}>
            <span className="tree-icon">♪</span>
            <span className="grow"><span className="lib-name">{f.name}</span>{f.durationMs ? <span className="muted small lib-meta"> · {formatMs(f.durationMs).replace(/\.0$/, '')}</span> : null}</span>
          </button>
        </div>
      ))}
    </>
  );
  return <div className="pk-tree">{render(root, 0)}</div>;
}

export function AudioPicker({ cue, content, colour, onContent, onClose, onError }: {
  cue: Cue; content: SegmentContent; colour: string;
  onContent: (c: SegmentContent) => void; onClose: () => void; onError: (m: string) => void;
}) {
  const chosen = cue.clips.find((c) => c.id === cue.clipId) ?? null;
  const [files, setFiles] = useState<LibFile[] | null>(null);
  const [assetId, setAssetId] = useState<string | null>(chosen?.assetId ?? null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [keep, setKeep] = useState(chosen ? false : !cue.lengthAuto);
  const [start, setStart] = useState(chosen?.offsetMs ?? 0);
  const [len, setLen] = useState(chosen?.lengthMs ?? (cue.lengthAuto ? 5000 : cue.lengthMs)); // an untouched cue offers a few seconds to start from
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ k: 'from' | 'len'; v: string } | null>(null);
  const [playMs, setPlayMs] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    api<{ files: LibFile[] }>('GET', `/api/projects/${content.segment.projectId}/audio`)
      .then((r) => { setFiles(r.files); setAssetId((cur) => cur ?? r.files[0]?.id ?? null); })
      .catch((e) => onError(errorText(e)));
  }, [content.segment.projectId, onError]);

  const file = files?.find((f) => f.id === assetId) ?? null;
  const dur = file?.durationMs ?? 0;

  useEffect(() => {
    setPeaks(null);
    if (!assetId) return;
    let live = true;
    fetch(`/api/assets/${assetId}/peaks`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error('No waveform for this file yet.');
        const step = Number(r.headers.get('X-Peaks-Step-Ms') ?? 100);
        return { step, data: new Uint8Array(await r.arrayBuffer()) };
      })
      .then((p) => { if (live) setPeaks(p); })
      .catch((e) => { if (live) onError(errorText(e)); });
    return () => { live = false; };
  }, [assetId, onError]);

  // One place keeps the piece inside the file. Same length as now means a move; another length is a resize.
  const place = (s: number, l: number) => {
    if (!dur) return;
    if (keep || l === len) {
      const nl = keep ? Math.min(cue.lengthMs, dur) : len;
      setLen(nl);
      setStart(Math.max(0, Math.min(dur - nl, Math.round(s / STEP) * STEP)));
      return;
    }
    if (s < 0) { l += s; s = 0; }
    s = Math.round(s / STEP) * STEP;
    setStart(s);
    setLen(Math.max(MIN_MS, Math.min(dur - s, Math.round(l / STEP) * STEP)));
  };
  // When the file or the mode changes, take the piece back inside it.
  useEffect(() => {
    if (!dur) return;
    const l = keep ? Math.min(cue.lengthMs, dur) : Math.min(len, dur);
    setLen(l); setStart((s) => Math.max(0, Math.min(dur - l, s)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dur, keep]);

  // The zoomed view follows the piece, but stays put while a frame is dragged.
  const viewRef = useRef<[number, number]>([0, 1]);
  const view = useMemo<[number, number]>(() => {
    if (dragging && viewRef.current[1] > 1) return viewRef.current;
    const m = Math.max(2000, len * 0.35);
    return (viewRef.current = [Math.max(0, start - m), Math.min(dur || 1, start + len + m)]);
  }, [dragging, start, len, dur]);

  const stop = () => { cancelAnimationFrame(raf.current); audio.current?.pause(); setPlayMs(null); };
  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = () => {
    if (!assetId) return;
    stop();
    const a = audio.current = new Audio(assetUrl(assetId, true));
    const end = start + len;
    a.currentTime = start / 1000;
    const tick = () => {
      const ms = a.currentTime * 1000;
      if (ms >= end || a.ended) { stop(); return; }
      setPlayMs(ms);
      raf.current = requestAnimationFrame(tick);
    };
    a.play().then(() => { raf.current = requestAnimationFrame(tick); }).catch((e) => onError(errorText(e)));
  };

  const commitEdit = () => {
    if (!edit) return;
    const ms = parseLength(edit.v);
    setEdit(null);
    if (ms === null) return;
    if (edit.k === 'from') place(ms, len); else if (!keep) place(start, ms);
  };

  const use = async () => {
    if (!assetId || !file) return;
    setBusy(true);
    try {
      const body = { assetId, offsetMs: start, lengthMs: len, keepCueLength: keep };
      const res = await api<SegmentContent>('POST', `/api/cues/${cue.id}/clips`, body);
      onContent(res);
      onClose();
    } catch (e) { onError(errorText(e)); setBusy(false); }
  };

  const shorter = keep && dur > 0 && dur < cue.lengthMs;
  return (
    <Dialog title="Audio for this cue" onClose={() => { stop(); onClose(); }} wide>
      <p className="muted small pk-sub">“{cue.text.slice(0, 60) || 'Empty cue'}” · the cue is {formatTenths(cue.lengthMs)} long</p>
      {files && files.length === 0 ? (
        <p className="muted">There is no audio in the library yet. Upload a WAV or MP3 in the Library, then choose it here.</p>
      ) : (
        <>
          <AudioTree projectId={content.segment.projectId} files={files ?? []} selected={assetId} onSelect={(f) => { stop(); setAssetId(f.id); setStart(0); }} />
          <div className="pk-line">
            <label className="rb"><input type="radio" checked={keep} onChange={() => setKeep(true)} /> Keep the cue length</label>
            <label className="rb"><input type="radio" checked={!keep} onChange={() => setKeep(false)} /> Cue length follows the piece</label>
          </div>
          <div className="wvlabel">Whole file: drag the frame to choose where the piece starts</div>
          <WaveBox peaks={peaks} from={0} to={dur || 1} start={start} len={len} locked={keep} colour={colour} height={48} playMs={playMs} onChange={place} onDrag={setDragging} />
          <Axis from={0} to={dur || 1} />
          <div className="wvlabel">Zoomed on the piece: fine tuning</div>
          <WaveBox peaks={peaks} from={view[0]} to={view[1]} start={start} len={len} locked={keep} colour={colour} height={64} playMs={playMs} hilite onChange={place} onDrag={setDragging} />
          <Axis from={view[0]} to={view[1]} />
          <div className="pk-line">
            <span>From</span>
            {edit?.k === 'from' ? <input className="num" autoFocus value={edit.v} onChange={(e) => setEdit({ k: 'from', v: e.target.value })} onBlur={commitEdit} onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEdit(null); }} />
              : <button className="num" onClick={() => setEdit({ k: 'from', v: formatMs(start) })}>{formatMs(start)}</button>}
            <span>to</span><span className="num">{formatMs(start + len)}</span>
            <span>length</span>
            {edit?.k === 'len' ? <input className="num" autoFocus value={edit.v} onChange={(e) => setEdit({ k: 'len', v: e.target.value })} onBlur={commitEdit} onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEdit(null); }} />
              : <button className="num" disabled={keep} onClick={() => setEdit({ k: 'len', v: formatMs(len) })}>{formatTenths(len)}</button>}
          </div>
          {shorter && <p className="muted small">The file is shorter than the cue, so the cue will shrink to {formatTenths(dur)}.</p>}
        </>
      )}
      <div className="row end pk-btns">
        <button disabled={!file || !peaks} onClick={playMs === null ? preview : stop}>{playMs === null ? '▶ Preview the piece' : '■ Stop'}</button>
        <span className="grow" />
        <button onClick={() => { stop(); onClose(); }}>Cancel</button>
        <button className="primary" disabled={busy || !file || !peaks} onClick={() => void use()}>Use this piece</button>
      </div>
    </Dialog>
  );
}
