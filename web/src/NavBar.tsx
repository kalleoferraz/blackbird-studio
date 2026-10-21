import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Story } from './types.ts';
import { where, type Level } from './nav.ts';
import type { PlaybackStore } from './playback.ts';
import { formatClock, plainIndex } from './format.ts';

const ICONS = {
  segPrev: <><rect x="4" y="6" width="2.6" height="12" rx="1" /><path d="M20 6.2v11.6L9 12z" /></>,
  scenePrev: <><path d="M12.5 6.2v11.6L3.5 12z" /><path d="M21.5 6.2v11.6L12.5 12z" /></>,
  cuePrev: <><rect x="3" y="11" width="4.5" height="2" rx="1" /><path d="M20 6.2v11.6L9 12z" /></>,
  cueNext: <><path d="M4 6.2v11.6L15 12z" /><rect x="15.5" y="11" width="6" height="2" rx="1" /><rect x="17.75" y="8.75" width="1.5" height="6.5" rx=".75" /></>,
  sceneNext: <><path d="M2.5 6.2v11.6L11.5 12z" /><path d="M11.5 6.2v11.6L20.5 12z" /></>,
  segNext: <><path d="M4 6.2v11.6L15 12z" /><rect x="17.4" y="6" width="2.6" height="12" rx="1" /></>,
  play: <path d="M8 5.2v13.6L19 12z" />,
  rec: <circle cx="12" cy="12" r="6.5" />,
  pause: <><rect x="6.5" y="5" width="3.8" height="14" rx="1" /><rect x="13.7" y="5" width="3.8" height="14" rx="1" /></>,
};
const Icon = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;

const BUTTONS: { icon: keyof typeof ICONS; label: string; keys: string; dir: 'prev' | 'next'; level: Level }[] = [
  { icon: 'segPrev', label: 'Previous segment', keys: 'Alt+←', dir: 'prev', level: 'segment' },
  { icon: 'scenePrev', label: 'Previous scene', keys: 'Shift+←', dir: 'prev', level: 'scene' },
  { icon: 'cuePrev', label: 'Previous cue', keys: '←', dir: 'prev', level: 'cue' },
  { icon: 'cueNext', label: 'Next cue', keys: '→', dir: 'next', level: 'cue' },
  { icon: 'sceneNext', label: 'Next scene', keys: 'Shift+→', dir: 'next', level: 'scene' },
  { icon: 'segNext', label: 'Next segment', keys: 'Alt+→', dir: 'next', level: 'segment' },
];

/** The one navigation bar of the Script View: position at the left, controls in the centre, clock and Follow at the right. */
export function NavBar({ store, story, follow, onFollow, editing }: {
  store: PlaybackStore; story: Story; follow: boolean; onFollow: (v: boolean) => void; editing: boolean;
}) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const seg = store.current();
  const pos = store.pos;
  const recView = store.recView();
  const recKind = recView.startsWith('count') ? 'count' : recView;

  // ---- the position readout, with the higher levels dropped one by one when there is no room ----
  const chapter = pos && story.chapters.find((c) => c.segments.some((s) => s.id === pos.segmentId));
  const segInfo = chapter?.segments.find((s) => s.id === pos!.segmentId);
  const w = seg && pos ? where(seg, pos) : null;
  const levels: [string, string][] = w && chapter && segInfo ? [
    ['Chapter', plainIndex(chapter.index)], ['Segment', String(segInfo.position)], ['Scene', String(w.scene)],
    ['Cue', w.cues ? `${w.cue || '–'}/${w.cues}` : '–'],
  ] : [];
  const box = useRef<HTMLDivElement>(null);
  const measured = useRef<(HTMLSpanElement | null)[]>([]);
  const [from, setFrom] = useState(0);
  const fit = () => {
    const avail = box.current?.clientWidth ?? 0;
    const widths = measured.current.slice(0, levels.length).map((s) => s?.offsetWidth ?? 0);
    let f = 0;
    while (f < widths.length && widths.slice(f).reduce((a, b) => a + b, 0) > avail) f++;
    setFrom(f);
  };
  const fitRef = useRef(fit);
  useLayoutEffect(() => { fitRef.current = fit; fit(); });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  // ---- keys: Space, ← → (Shift: scene, Alt: segment). Ignored while typing or when a dialog is open ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.backdrop')) return;
      if (e.key === ' ') { if (t?.closest('button, a')) return; e.preventDefault(); if (store.rec) store.rec.stop(); else store.toggle(); return; }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      store.move(e.altKey ? 'segment' : e.shiftKey ? 'scene' : 'cue', e.key === 'ArrowLeft' ? 'prev' : 'next');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const btn = (b: (typeof BUTTONS)[number]) => (
    <button key={b.icon} type="button" title={`${b.label} (${b.keys})`} aria-label={b.label}
      disabled={!store.can(b.level, b.dir)} onClick={() => store.move(b.level, b.dir)}><Icon>{ICONS[b.icon]}</Icon></button>
  );
  return (
    <div className="navbar" role="toolbar" aria-label="Script navigation">
      <div className="nav">
        <div className="nav-pos" ref={box} aria-label={levels.map(([n, v]) => `${n} ${v}`).join(', ')}>
          <div className="measure" aria-hidden="true">
            {levels.map(([n, v], i) => <span className="lv" key={n} ref={(el) => { measured.current[i] = el; }}>{n} <b>{v}</b></span>)}
          </div>
          <div className="shown">
            {levels.slice(from).map(([n, v], i, a) => <span className={'lv' + (i === a.length - 1 ? ' last' : '')} key={n}>{n} <b>{v}</b></span>)}
          </div>
        </div>
        <div className="nav-ctrls">
          {BUTTONS.slice(0, 3).map(btn)}
          {recView ? (
            <button type="button" className={'play rec ' + recKind} disabled={recView === 'saving'}
              aria-label={recView === 'saving' ? 'Saving the take' : store.rec?.phase === 'count' ? 'Cancel the recording' : 'Stop recording'}
              title={recView === 'saving' ? 'Saving the take…' : store.rec?.phase === 'count' ? 'Cancel (Space)' : 'Stop recording (Space)'}
              onClick={() => store.rec?.stop()}>
              {recKind === 'count' ? <span key={recView} className="rec-count">{recView.slice(6) === '0' ? '…' : recView.slice(6)}</span>
                : recKind === 'saving' ? <span className="rec-count">…</span> : <span className="rec-dot"><Icon>{ICONS.rec}</Icon></span>}
            </button>
          ) : (
          <button type="button" className="play" disabled={!pos} aria-label={store.playing ? 'Pause' : 'Play'} title={store.playing ? 'Pause (Space)' : 'Play (Space)'}
            onClick={() => store.toggle()}><Icon>{store.playing ? ICONS.pause : ICONS.play}</Icon></button>)}
          {BUTTONS.slice(3).map(btn)}
        </div>
        <div className="nav-right">
          {w && <span className="nav-clock"><b>{formatClock(w.sceneMs)}</b> / {formatClock(w.sceneLengthMs)} in scene</span>}
          <label className={'nav-follow' + (editing ? ' paused' : '')}
            title={editing ? 'Follow is paused while you edit a cue' : 'When on, the script scrolls (and opens the next segment) to follow the playhead'}>
            <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} /> Follow
          </label>
        </div>
      </div>
    </div>
  );
}
