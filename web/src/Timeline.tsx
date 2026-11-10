// The timeline of the open scene: its lanes over time, with the cues as blocks (waveform of the chosen clip inside),
// a playhead that follows playback, click to seek, drag to move a cue and drag its right edge to resize it.
// After resizing a speech cue the author is asked whether the later cues move with it (ripple) or stay where they are;
// sound effects and music never ripple: they only stop where the next cue of their lane begins.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { api } from './api.ts';
import type { Cue, Lane, SegmentContent } from './types.ts';
import { useNav, useStoreValue } from './playback.ts';
import { loadPeaks, type Peaks } from './peaks.ts';
import { Menu, errorText, useLocalState } from './ui.tsx';
import { AudioPicker } from './AudioPicker.tsx';
import { audioMenuItems } from './audioMenu.ts';
import { plainMd } from './md.tsx';
import { ENVELOPE_RANGE, MAX_VOLUME_POINTS, VOLUME_MAX_DB, VOLUME_MIN_DB, sourceAt, type EnvelopeKind } from '../../src/shared/audio-settings.ts';
import { AudioSliders, ENVELOPE_NAME, type AudioEdit } from './AudioSettings.tsx';
import { RemoveAudioDialog } from './RemoveAudio.tsx';

const LANE_H = 54;
const RULER_H = 22;
const MIN_CUE_MS = 100;
const MAX_MS = 99 * 60 * 1000;
const DRAG_PX = 3;

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const laneColour = (c: string) => (c.toLowerCase() === '#000000' ? '#EDE4DC' : c);

interface Drag { cueId: string; kind: 'move' | 'resize'; startMs: number; lengthMs: number; shift: number; /** Cues of the lane pushed ahead of a cue moved to the right: id to new start. */ pushed?: Map<string, number> }
/** A resized speech cue waiting for the answer to "shift the later cues too?". */
interface Ask { drag: Drag; later: number; x: number; y: number; clamped: boolean }

export function Timeline({ content, readOnly, onContent, onError, audioEdit, onAudioEdit }: {
  content: SegmentContent; readOnly: boolean; onContent: (c: SegmentContent) => void; onError: (m: string) => void;
  /** The cue open for audio editing (taller, with its volume envelope and a panel of settings), and the way to open or close it. */
  audioEdit: AudioEdit | null; onAudioEdit: (e: AudioEdit | null) => void;
}) {
  const nav = useNav();
  const store = nav?.store;
  const curScene = useStoreValue(store, (s) => s.currentSceneId(), '');
  const curCue = useStoreValue(store, (s) => s.currentCueId(), '');
  const sceneIndex = Math.max(0, content.scenes.findIndex((s) => s.id === curScene));
  const scene = content.scenes[sceneIndex]!;

  const [height, setHeight] = useLocalState('rs.timelineH', 240);
  const [zoom, setZoom] = useState<number | null>(null); // pixels per second; null fits the scene to the width
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [bw, setBw] = useState(800);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBw(el.clientWidth));
    ro.observe(el); setBw(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // The lane labels are as wide as the longest lane title unless the author has dragged the edge (double-click: back to automatic).
  const [labelPref, setLabelPref] = useLocalState('rs.timelineLabelW', 0);
  const autoLabelW = useMemo(() => {
    const g = document.createElement('canvas').getContext('2d');
    if (!g) return 120;
    g.font = `${Math.round(0.8 * 16)}px ${getComputedStyle(document.body).fontFamily}`;
    const w = content.lanes.reduce((m, l) => Math.max(m, g.measureText(l.title).width), 0);
    return Math.round(Math.min(320, Math.max(90, w + 44)));
  }, [content.lanes]);
  const labelW = labelPref || autoLabelW;
  const vw = Math.max(200, bw - labelW);
  const [selId, setSelId] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number; cue: Cue; colour: string }>(null);
  const [picking, setPicking] = useState<null | { cue: Cue; colour: string }>(null);
  const [removing, setRemoving] = useState<Cue | null>(null);
  const recording = useStoreValue(store, (st) => !!st.rec, false);
  useEffect(() => setZoom(null), [scene.id]); // a new scene starts fitted

  const generic = `Scene ${scene.position}`;
  const sceneTitle = scene.label && scene.label !== generic ? `${generic} · ${scene.label}` : generic;
  const extentMs = Math.max(scene.lengthMs + 5000, 15000);
  const fit = (vw / extentMs) * 1000;
  const pps = zoom ?? fit;
  const width = Math.max(vw, (extentMs / 1000) * pps);
  const x = (ms: number) => (ms / 1000) * pps;
  // Zooming keeps the moment under `cx` (pixels from the left edge of the scroll area) where it is.
  const ppsRef = useRef(pps); ppsRef.current = pps;
  const fitRef = useRef(fit); fitRef.current = fit;
  const labelRef = useRef(labelW); labelRef.current = labelW;
  const anchor = useRef<{ t: number; cx: number } | null>(null);
  const zoomAt = (f: number, cx: number) => {
    const el = scroller.current;
    const cur = ppsRef.current;
    const next = Math.min(400, Math.max(fitRef.current * 0.5, cur * f));
    if (!el || next === cur) return;
    anchor.current = { t: (el.scrollLeft + cx - labelRef.current) / cur, cx };
    setZoom(next);
  };
  useLayoutEffect(() => {
    const a = anchor.current, el = scroller.current;
    if (!a || !el) return;
    anchor.current = null;
    el.scrollLeft = Math.max(0, a.t * pps + labelW - a.cx);
  }, [pps, labelW]);
  const zoomBy = (f: number) => zoomAt(f, labelW + (bw - labelW) / 2);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls the lanes as usual
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - el.getBoundingClientRect().left);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const lanes = useMemo(() => {
    const used = new Set(scene.cues.map((c) => c.laneId));
    return content.lanes.filter((l) => used.has(l.id)).sort((a, b) => a.position - b.position);
  }, [content.lanes, scene.cues]);

  // The lane of the cue open for audio editing is half as tall again, so the volume envelope has room; the others move down with a transition.
  const editId = audioEdit?.cueId ?? null;
  const editCue = editId ? scene.cues.find((c) => c.id === editId) : undefined;
  const laneH = lanes.map((l) => (editCue && l.id === editCue.laneId ? Math.round(LANE_H * 1.5) : LANE_H));
  const laneTop = laneH.map((_, i) => RULER_H + laneH.slice(0, i).reduce((a, b) => a + b, 0));
  const totalH = RULER_H + laneH.reduce((a, b) => a + b, 0);
  // Opened from the script's menu for a cue of another scene: the playhead goes there, which shows that scene.
  useEffect(() => {
    if (!editId || editCue) return;
    const si = content.scenes.findIndex((s) => s.cues.some((c) => c.id === editId));
    if (si >= 0) store?.seek({ segmentId: content.segment.id, scene: si, ms: content.scenes[si]!.cues.find((c) => c.id === editId)!.startMs });
  }, [editId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A press outside the edited cue, its panel and the menus ends the editing; the lane shrinks back.
  useEffect(() => {
    if (!editId) return;
    const down = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.tl-cue.audio-edit, .tl-audio-panel, .menu, .backdrop')) onAudioEdit(null);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [editId, onAudioEdit]);
  useEffect(() => {
    if (!editId) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input, textarea')) onAudioEdit(null); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [editId, onAudioEdit]);

  const seek = (ms: number) => store?.seek({ segmentId: content.segment.id, scene: sceneIndex, ms: Math.max(0, Math.round(ms)) });
  const seekAt = (clientX: number) => {
    seek(((clientX - canvasRef.current!.getBoundingClientRect().left) / pps) * 1000);
  };

  const openMenu = (cue: Cue, lane: Lane) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (readOnly) return;
    setSelId(cue.id);
    setMenu({ x: e.clientX, y: e.clientY, cue, colour: laneColour(lane.colour) });
  };
  const runOnCue = async (method: string, url: string, body?: unknown) => {
    try { onContent(await api<SegmentContent>(method, url, body)); } catch (e) { onError(errorText(e)); }
  };
  const answer = async (mode: 'ripple' | 'trim' | null) => {
    const a = ask; setAsk(null);
    if (a && mode) await commit(a.drag.cueId, { lengthMs: a.drag.lengthMs, mode });
  };
  useEffect(() => {
    if (!ask) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') void answer(null); else if (e.key === 'Enter') void answer('ripple'); };
    const away = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.tl-ask')) void answer(null); };
    window.addEventListener('keydown', key); window.addEventListener('pointerdown', away, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', away, true); };
  }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = async (cueId: string, body: object) => {
    try { onContent(await api<SegmentContent>('POST', `/api/cues/${cueId}/place`, body)); }
    catch (e) { onError(errorText(e)); }
  };

  const begin = (cue: Cue, kind: 'move' | 'resize') => (e: RPointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    setSelId(cue.id);
    if (readOnly) { seek(cue.startMs); return; }
    e.preventDefault();
    const x0 = e.clientX;
    const mates = scene.cues.filter((c) => c.laneId === cue.laneId && c.id !== cue.id);
    const prevEnd = mates.filter((c) => c.startMs < cue.startMs).reduce((m, c) => Math.max(m, c.startMs + c.lengthMs), 0);
    const nextStart = mates.filter((c) => c.startMs > cue.startMs).reduce((m, c) => Math.min(m, c.startMs), Infinity);
    // Cues to the right on the lane: a cue moved to the right pushes the ones in its way ahead of it (a narrator's chain of paragraphs).
    const ahead = mates.filter((c) => c.startMs > cue.startMs).sort((a, b) => a.startMs - b.startMs);
    const pushFor = (start: number): { pushed: Map<string, number>; end: number } => {
      const pushed = new Map<string, number>();
      let edge = start + cue.lengthMs;
      for (const o of ahead) {
        if (o.startMs >= edge) break;
        pushed.set(o.id, edge);
        edge += o.lengthMs;
      }
      return { pushed, end: edge };
    };
    let moved = false;
    let last: Drag = { cueId: cue.id, kind, startMs: cue.startMs, lengthMs: cue.lengthMs, shift: 0 };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_PX) return;
      moved = true;
      const dms = Math.round(((ev.clientX - x0) / pps) * 100) * 10; // steps of 10 ms
      if (kind === 'move') {
        let start = Math.max(0, cue.startMs + dms, prevEnd);
        let push = pushFor(start);
        // The pushed chain must still fit in the scene: stop where its last cue reaches the end.
        for (let i = 0; i < 20 && push.end > MAX_MS && start > cue.startMs; i++) { start = Math.max(cue.startMs, start - (push.end - MAX_MS)); push = pushFor(start); }
        last = { cueId: cue.id, kind, startMs: start, lengthMs: cue.lengthMs, shift: 0, pushed: push.pushed };
      } else {
        let len = Math.max(MIN_CUE_MS, cue.lengthMs + dms);
        // A sound effect or music stops at the next cue of its lane; a speech cue may grow, and the author decides on release.
        if (cue.type !== 'speech' && nextStart !== Infinity) len = Math.min(len, Math.max(MIN_CUE_MS, nextStart - cue.startMs));
        len = Math.min(len, MAX_MS - cue.startMs);
        last = { cueId: cue.id, kind, startMs: cue.startMs, lengthMs: len, shift: 0 };
      }
      setDrag(last);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      setDrag(null); // a speech cue's new length is kept in `ask` until it is answered
      if (!moved) { if (kind === 'move') seek(cue.startMs); return; }
      if (kind === 'move') { if (last.startMs !== cue.startMs) void commit(cue.id, { startMs: last.startMs, push: true }); }
      else if (last.lengthMs !== cue.lengthMs) {
        const oldEnd = cue.startMs + cue.lengthMs;
        const later = scene.cues.filter((c) => c.id !== cue.id && c.startMs >= oldEnd).length;
        if (cue.type !== 'speech') void commit(cue.id, { lengthMs: last.lengthMs, mode: 'trim' });
        else if (later === 0 && (nextStart === Infinity || cue.startMs + last.lengthMs <= nextStart)) void commit(cue.id, { lengthMs: last.lengthMs, mode: 'ripple' });
        else setAsk({ drag: { ...last, shift: last.lengthMs - cue.lengthMs }, later, x: ev.clientX, y: ev.clientY, clamped: nextStart !== Infinity && cue.startMs + last.lengthMs > nextStart });
      }
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // Empty space: drag to move the view (a plain click seeks). The ruler seeks at once and follows the pointer.
  const onCanvasDown = (e: RPointerEvent) => {
    const el = scroller.current;
    const t = e.target as HTMLElement;
    if (e.button !== 0 || !el || t.closest('.tl-cue')) return;
    if (t.closest('.tl-ruler')) {
      seekAt(e.clientX);
      const move = (m: PointerEvent) => seekAt(m.clientX);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    const x0 = e.clientX, y0 = e.clientY, sl = el.scrollLeft, st = el.scrollTop;
    let panned = false;
    const move = (m: PointerEvent) => {
      if (!panned && Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) < DRAG_PX) return;
      if (!panned) { panned = true; el.classList.add('panning'); }
      el.scrollLeft = sl - (m.clientX - x0); el.scrollTop = st - (m.clientY - y0);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      el.classList.remove('panning');
      if (!panned) seekAt(x0);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const startLabelResize = (e: RPointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = labelW;
    const move = (m: PointerEvent) => setLabelPref(Math.max(60, Math.min(400, Math.round(w0 + m.clientX - x0))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  // The panel is never taller than its lanes need: the ruler, the lanes and room for the last lane to grow while its audio is edited.
  const sectionRef = useRef<HTMLElement>(null);
  const fitHeight = () => {
    const chrome = sectionRef.current && scroller.current ? sectionRef.current.offsetHeight - scroller.current.offsetHeight : 44;
    return Math.round(chrome + RULER_H + lanes.length * LANE_H + LANE_H * 0.5 + 28); // 28: a margin and the horizontal scroll bar
  };
  // A scene with fewer lanes shortens the panel; with more, the panel keeps its height and scrolls.
  useEffect(() => {
    const fit = fitHeight();
    if (height > fit) setHeight(fit);
  }, [lanes.length, scene.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const startResize = (e: RPointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = height;
    const max = Math.min(600, Math.max(fitHeight(), 100)), min = Math.min(120, max);
    let latest = h0;
    const move = (m: PointerEvent) => { latest = Math.max(min, Math.min(max, h0 + (y0 - m.clientY))); setHeight(latest); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const ticks = useMemo(() => {
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 70) ?? 600;
    const out: number[] = [];
    for (let t = 0; t * 1000 <= extentMs; t += step) out.push(t * 1000);
    return out;
  }, [pps, extentMs]);

  // While a cue is resized with ripple, the later cues are shown moving with it.
  const target = scene.cues.find((c) => c.id === selId) ?? scene.cues.find((c) => c.id === curCue);
  const canRecord = !readOnly && !recording && target?.type === 'speech';
  const view = drag ?? ask?.drag ?? null;
  const shown = (c: Cue): { start: number; len: number } => {
    if (view && c.id === view.cueId) return { start: view.startMs, len: view.lengthMs };
    const pushedTo = view?.pushed?.get(c.id);
    if (pushedTo !== undefined) return { start: pushedTo, len: c.lengthMs };
    return { start: c.startMs, len: c.lengthMs };
  };

  return (
    <section className="timeline" ref={sectionRef} style={{ height }} data-testid="timeline">
      <div className="tl-divider" onPointerDown={startResize} title="Drag to resize" />
      <div className="tl-head">
        <b>Timeline</b>
        <span className="muted">{sceneTitle} · {clock(scene.lengthMs)}</span>
        <span className="grow" />
        <span className="muted small tl-hint">{readOnly ? 'View only' : 'Drag a cue to move it · drag its right edge to resize'}</span>
        <button className="tl-rec" disabled={!canRecord} data-testid="timeline-record" onClick={() => target && nav?.record(target.id)}
          title={canRecord ? 'Record a take for the selected cue' : 'Select a speech cue to record it'}><i />Record</button>
        <button className="tl-zoom" onClick={() => zoomBy(1 / 1.5)} title="Zoom out">−</button>
        <button className="tl-zoom" onClick={() => zoomBy(1.5)} title="Zoom in">+</button>
        <button className="tl-zoom wide" onClick={() => setZoom(null)} disabled={zoom === null} title="Fit the scene">Fit</button>
      </div>
      <div className="tl-body" ref={scroller}>
        <div className="tl-inner" style={{ width: labelW + width }}>
          <div className="tl-labels" style={{ width: labelW }}>
            <div className="tl-corner" style={{ height: RULER_H }} />
            {lanes.map((l, i) => <div key={l.id} className="tl-label" style={{ height: laneH[i] }} title={l.title}>
              <i style={{ background: laneColour(l.colour) }} />{l.title}
            </div>)}
            <div className="tl-label-grip" onPointerDown={startLabelResize} onDoubleClick={() => setLabelPref(0)} title="Drag to resize (double-click: fit the longest name)" />
          </div>
          <div className="tl-canvas" ref={canvasRef} style={{ width, height: Math.max(totalH, RULER_H + LANE_H) }}
            onPointerDown={onCanvasDown}>
            <div className="tl-ruler" style={{ height: RULER_H }}>
              {ticks.map((t) => <span key={t} style={{ left: x(t) }}>{clock(t)}</span>)}
            </div>
            <div className="tl-grid" style={{ top: RULER_H, '--s': `${pps}px`, '--t': `${pps * 10}px`, '--sec': pps >= 6 ? 1 : 0 } as React.CSSProperties} />
            {lanes.map((l, i) => <div key={l.id} className="tl-lane" style={{ top: laneTop[i], height: laneH[i] }} />)}
            {scene.cues.map((c) => {
              const li = lanes.findIndex((l) => l.id === c.laneId);
              if (li < 0) return null;
              const s = shown(c);
              return <CueBlock key={c.id} cue={c} lane={lanes[li]!} left={x(s.start)} width={Math.max(3, x(s.len))} lengthMs={s.len}
                top={laneTop[li]!} h={laneH[li]! - 6} now={c.id === curCue} sel={c.id === target?.id} dragging={view?.cueId === c.id} readOnly={readOnly}
                editing={c.id === editId ? audioEdit!.kind : null} onEditAudio={() => onAudioEdit({ cueId: c.id, kind: 'level' })}
                onSeekIn={(ms) => seek(c.startMs + ms)}
                onEnvelope={(points) => void runOnCue('PATCH', `/api/clips/${c.clipId}`, { [ENVELOPE_KEY[audioEdit!.kind]]: points })}
                onMove={begin(c, 'move')} onResize={begin(c, 'resize')} onMenu={openMenu(c, lanes[li]!)} />;
            })}
            {editCue && (() => {
              const li = lanes.findIndex((l) => l.id === editCue.laneId), s = shown(editCue), k = editCue.clips.find((q) => q.id === editCue.clipId);
              if (li < 0 || !k) return null;
              const PANEL_W = 290, right = x(s.start) + Math.max(3, x(s.len)) + 8;
              const left = right + PANEL_W > width ? Math.max(4, x(s.start) - PANEL_W - 8) : right;
              return (
                <div className="tl-audio-panel" style={{ left, top: laneTop[li]! + 3 }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                  <div className="tl-ap-head"><b>Audio settings</b><button className="tl-ap-done" onClick={() => onAudioEdit(null)}>Done</button></div>
                  <AudioSliders clip={k} run={(m, u, b) => void runOnCue(m, u, b)} env={audioEdit!.kind} onEnv={(kind) => onAudioEdit({ cueId: editCue.id, kind })} />
                  <p className="muted small">Showing the {ENVELOPE_NAME[audioEdit!.kind].toLowerCase()} envelope. Double-click the cue to add a point, drag a point to move it, double-click a point to remove it. A click moves the playhead.</p>
                </div>);
            })()}
            <Playhead sceneId={scene.id} x={x} />
          </div>
        </div>
      </div>
      {menu && <Menu anchor={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)}
        items={audioMenuItems(menu.cue, { nav, run: (m, u, b) => void runOnCue(m, u, b), chooseAudio: () => setPicking({ cue: menu.cue, colour: menu.colour }), removeAudio: () => setRemoving(menu.cue), edit: (kind) => onAudioEdit({ cueId: menu.cue.id, kind }) })} />}
      {picking && <AudioPicker cue={picking.cue} content={content} colour={picking.colour} onContent={onContent} onError={onError} onClose={() => setPicking(null)} />}
      {removing && <RemoveAudioDialog cue={removing} onContent={onContent} onError={onError} onClose={() => setRemoving(null)} />}
      {ask && (
        <div className="tl-ask" role="dialog" style={{ left: Math.max(8, Math.min(window.innerWidth - 330, ask.x - 150)), bottom: window.innerHeight - ask.y + 14 }}>
          <div>Shift the {ask.later} later cue{ask.later === 1 ? '' : 's'} with it?</div>
          {ask.clamped && <div className="muted small">If they stay, this cue stops where the next one on its lane begins.</div>}
          <div className="row">
            <button className="primary" autoFocus onClick={() => void answer('ripple')}>Shift them</button>
            <button onClick={() => void answer('trim')}>Keep them in place</button>
            <button className="tl-ask-x" onClick={() => void answer(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

const Playhead = memo(function Playhead({ sceneId, x }: { sceneId: string; x: (ms: number) => number }) {
  const nav = useNav();
  const ms = useStoreValue(nav?.store, (s) => (s.currentSceneId() === sceneId && s.pos ? s.pos.ms : -1), -1);
  if (ms < 0) return null;
  return <div className="tl-playhead" style={{ left: x(ms) }} />;
});

const CueBlock = memo(function CueBlock({ cue, lane, left, width, lengthMs, top, h, now, sel, dragging, readOnly, editing, onEditAudio, onEnvelope, onSeekIn, onMove, onResize, onMenu }: {
  cue: Cue; lane: Lane; left: number; width: number; lengthMs: number; top: number; h: number; now: boolean; sel: boolean; dragging: boolean; readOnly: boolean;
  editing: EnvelopeKind | null; onEditAudio: () => void; onEnvelope: (points: [number, number][] | null) => void; onSeekIn: (ms: number) => void;
  onMove: (e: RPointerEvent) => void; onResize: (e: RPointerEvent) => void; onMenu: (e: React.MouseEvent) => void;
}) {
  const nav = useNav();
  const past = useStoreValue(nav?.store, (s) => s.cueState(cue.id) === 2000, false);
  const clip = cue.clips.find((k) => k.id === cue.clipId) ?? null;
  const colour = laneColour(lane.colour);
  // While the cue is stretched, its audio piece is shown fitting the new length (from the same start, up to the end of the file); the server does the same on release.
  const stretching = dragging && lengthMs !== cue.lengthMs;
  const clipMs = clip && stretching && clip.loops === 0 && clip.assetDurationMs !== null ? Math.max(0, Math.min(lengthMs, (clip.assetDurationMs - clip.offsetMs) / clip.speed)) : clip?.lengthMs ?? 0;
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  useEffect(() => {
    setPeaks(null);
    if (!clip?.hasPeaks) return;
    let live = true;
    void loadPeaks(clip.assetId).then((p) => live && setPeaks(p));
    return () => { live = false; };
  }, [clip?.assetId, clip?.hasPeaks, clip?.status]);
  return (
    <div className={'tl-cue' + (now ? ' now' : '') + (sel ? ' sel' : '') + (past ? ' past' : '') + (dragging ? ' dragging' : '') + (clip ? '' : ' empty') + (cue.muted ? ' muted' : '') + (editing ? ' audio-edit' : '')} data-cue-id={cue.id}
      style={{ left, width, top: top + 3, height: h, '--c': colour } as React.CSSProperties}
      onPointerDown={editing ? undefined : onMove} onContextMenu={onMenu} title={cue.text || cue.type}
      onDoubleClick={() => { if (clip && !readOnly && !editing) onEditAudio(); }}>
      {clip && peaks && <Wave peaks={peaks} offsetMs={clip.offsetMs} clipMs={clipMs} lengthMs={lengthMs} width={width} colour={colour} speed={clip.speed} speedPoints={clip.speedPoints} height={h} />}
      {clip && editing && !readOnly ? <EnvelopeEditor key={editing} kind={editing} points={clip[ENVELOPE_KEY[editing]]} lengthMs={lengthMs} width={width} height={h} onChange={onEnvelope} onSeek={(ms) => onSeekIn(ms)} />
        : clip && Array.isArray(clip.volumePoints) && clip.volumePoints.length > 0 && <EnvelopeLine points={clip.volumePoints} lengthMs={lengthMs} width={width} height={h} />}
      <span className="tl-text">{plainMd(cue.text) || (cue.type === 'speech' ? '' : cue.type)}</span>
      {!readOnly && <div className="tl-grip" onPointerDown={onResize} />}
    </div>
  );
});

/** The vertical scale of an envelope: the top is the highest value, and a speed is spread by octaves so that 1 sits in the middle. */
function envScale(kind: EnvelopeKind, height: number) {
  const { min, max, neutral } = ENVELOPE_RANGE[kind];
  const f = kind === 'speed' ? Math.log2 : (v: number) => v, g = kind === 'speed' ? (v: number) => 2 ** v : (v: number) => v;
  const span = Math.max(1, height - 6);
  const y = (v: number) => 3 + ((f(max) - f(v)) / (f(max) - f(min))) * span;
  const value = (py: number): number => {
    if (Math.abs(py - y(neutral)) < 5) return neutral; // sticks to "no change"
    const raw = g(f(max) - ((py - 3) / span) * (f(max) - f(min)));
    const clamped = Math.max(min, Math.min(max, raw));
    return kind === 'level' ? Math.round(clamped * 2) / 2 : kind === 'pitch' ? Math.round(clamped / 10) * 10 : Math.round(clamped * 100) / 100;
  };
  return { y, value };
}
const envText = (kind: EnvelopeKind, v: number) => (kind === 'level' ? `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` : kind === 'pitch' ? `${v > 0 ? '+' : ''}${(v / 100).toFixed(1)} st` : `${v.toFixed(2)}×`);

/** The clip field that holds the envelope of each setting. */
export const ENVELOPE_KEY = { level: 'volumePoints', pitch: 'pitchPoints', speed: 'speedPoints' } as const;

/** The envelope being edited on the cue: click to add a point, drag to move it, double-click a point to remove it. */
export function EnvelopeEditor({ kind, points, lengthMs, width, height, onChange, onSeek }: { kind: EnvelopeKind; points: [number, number][] | null; lengthMs: number; width: number; height: number; onChange: (p: [number, number][] | null) => void; /** A single click: the playing time (ms from the start of the take) to move the playhead to. */ onSeek: (ms: number) => void }) {
  const [pts, setPts] = useState<[number, number][]>(Array.isArray(points) ? points : []);
  const dragging = useRef<number | null>(null);
  const moved = useRef(false);
  const lastTap = useRef<{ i: number | null; t: number; x: number; y: number } | null>(null);
  useEffect(() => { if (dragging.current === null) setPts(Array.isArray(points) ? points : []); }, [points]);
  const { y, value } = envScale(kind, height);
  const px = (ms: number) => Math.max(0, Math.min(width, (ms / Math.max(1, lengthMs)) * width));
  const at = (e: React.PointerEvent): [number, number] => {
    const r = e.currentTarget.closest('svg')!.getBoundingClientRect();
    const ms = Math.max(0, Math.min(lengthMs, ((e.clientX - r.left) / Math.max(1, r.width)) * lengthMs));
    return [Math.round(ms), value(e.clientY - r.top)];
  };
  const commit = (list: [number, number][]) => onChange(list.length ? [...list].sort((a, b) => a[0] - b[0]) : null);
  const start = (i: number | null) => (e: React.PointerEvent) => {
    e.stopPropagation();
    // A second press within a moment is a double click / double tap: on a point it removes the point, on the empty line it adds one.
    const now = Date.now(), last = lastTap.current;
    const dbl = !!last && last.i === i && now - last.t < 400 && (i !== null || (Math.abs(last.x - e.clientX) < 12 && Math.abs(last.y - e.clientY) < 12));
    lastTap.current = dbl ? null : { i, t: now, x: e.clientX, y: e.clientY };
    const svg = e.currentTarget.closest('svg') as Element;
    if (i !== null) {
      if (dbl) { const next = pts.filter((_, k) => k !== i); setPts(next); commit(next); return; }
      moved.current = false; dragging.current = i; svg.setPointerCapture(e.pointerId);
      return;
    }
    if (!dbl) { onSeek(at(e)[0]); return; } // a single click puts the playhead there
    if (pts.length >= MAX_VOLUME_POINTS) return;
    const next = [...pts, at(e)];
    setPts(next); moved.current = true; dragging.current = next.length - 1; svg.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => { const i = dragging.current; if (i === null) return; moved.current = true; const v = at(e); setPts((p) => p.map((q, k) => (k === i ? v : q))); };
  const end = () => { if (dragging.current === null) return; dragging.current = null; if (moved.current) commit(pts); };
  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  const d = sorted.length ? `M0,${y(sorted[0]![1])} ${sorted.map(([ms, db]) => `L${px(ms)},${y(db)}`).join(' ')} L${width},${y(sorted[sorted.length - 1]![1])}` : `M0,${y(ENVELOPE_RANGE[kind].neutral)} L${width},${y(ENVELOPE_RANGE[kind].neutral)}`;
  return (
    <svg className={'tl-envelope edit k-' + kind} width={width} height={height} onPointerDown={start(null)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <line x1={0} x2={width} y1={y(ENVELOPE_RANGE[kind].neutral)} y2={y(ENVELOPE_RANGE[kind].neutral)} className="zero" />
      <path d={d} className={sorted.length ? '' : 'flat'} />
      {pts.map(([ms, db], i) => <g key={i} onPointerDown={start(i)}><circle className="hit" cx={px(ms)} cy={y(db)} r={16} /><circle className="dot" cx={px(ms)} cy={y(db)} r={5} /><title>{`${(ms / 1000).toFixed(2)} s · ${envText(kind, db)}`}</title></g>)}
    </svg>
  );
}

/** The volume envelope over the cue's waveform: a thin line, high for loud and low for soft. */
function EnvelopeLine({ points, lengthMs, width, height }: { points: [number, number][]; lengthMs: number; width: number; height: number }) {
  const x = (ms: number) => Math.max(0, Math.min(width, (ms / Math.max(1, lengthMs)) * width));
  const y = (db: number) => 3 + ((VOLUME_MAX_DB - db) / (VOLUME_MAX_DB - VOLUME_MIN_DB)) * (height - 6);
  const first = points[0]!, last = points[points.length - 1]!;
  const d = `M0,${y(first[1])} ${points.map(([ms, db]) => `L${x(ms)},${y(db)}`).join(' ')} L${x(lengthMs)},${y(last[1])}`;
  return <svg className="tl-envelope" width={width} height={height} aria-hidden="true"><path d={d} /></svg>;
}

export function Wave({ peaks, offsetMs, clipMs, lengthMs, width, colour, speed, speedPoints, height }: { peaks: Peaks; offsetMs: number; clipMs: number; lengthMs: number; width: number; colour: string; speed: number; speedPoints?: [number, number][] | null; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = height;
  const w = Math.min(4000, Math.max(1, Math.round(width)));
  useEffect(() => {
    const cv = ref.current!;
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    g.fillStyle = colour; g.globalAlpha = 0.85;
    const played = Math.min(lengthMs, clipMs); // a longer cue is silent after its clip ends
    // Thin rounded bars with a gap between them: one bar every BAR+GAP pixels.
    const BAR = 2, GAP = 2;
    const span = Math.max(1, Math.round((played / Math.max(1, lengthMs)) * w));
    const cols = Math.max(1, Math.floor(span / (BAR + GAP)));
    for (let k = 0; k < cols; k++) {
      const a = Math.floor((offsetMs + sourceAt(speed, speedPoints, (k / cols) * played)) / peaks.step);
      const b = Math.max(a + 1, Math.floor((offsetMs + sourceAt(speed, speedPoints, ((k + 1) / cols) * played)) / peaks.step));
      let m = 0;
      for (let i = a; i < b && i < peaks.data.length; i++) m = Math.max(m, peaks.data[i]!);
      const bar = m === 0 ? BAR : Math.max(BAR + 1, (m / 255) * (h - 8));
      g.beginPath();
      g.roundRect(k * (BAR + GAP), (h - bar) / 2, BAR, bar, BAR / 2);
      g.fill();
    }
  }, [peaks, offsetMs, clipMs, lengthMs, w, h, colour, speed, speedPoints]);
  return <canvas ref={ref} className="tl-wave" />;
}
