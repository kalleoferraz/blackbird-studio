import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Story } from './types.ts';
import { libraryPathCandidates, scriptPathCandidates, where, type Level } from './nav.ts';
import type { PlaybackStore } from './playback.ts';
import { formatClock, plainIndex } from './format.ts';
import { useLocalState } from './ui.tsx';
import { useLibValue, type LibraryPlayer } from './libplayer.ts';
import { LibWave } from './WavePlayer.tsx';

const ICONS = {
  segPrev: <><rect x="4" y="6" width="2.6" height="12" rx="1" /><path d="M20 6.2v11.6L9 12z" /></>,
  scenePrev: <><path d="M12.5 6.2v11.6L3.5 12z" /><path d="M21.5 6.2v11.6L12.5 12z" /></>,
  cuePrev: <><rect x="3" y="11" width="4.5" height="2" rx="1" /><path d="M20 6.2v11.6L9 12z" /></>,
  cueNext: <><path d="M4 6.2v11.6L15 12z" /><rect x="15.5" y="11" width="6" height="2" rx="1" /><rect x="17.75" y="8.75" width="1.5" height="6.5" rx=".75" /></>,
  sceneNext: <><path d="M2.5 6.2v11.6L11.5 12z" /><path d="M11.5 6.2v11.6L20.5 12z" /></>,
  segNext: <><path d="M4 6.2v11.6L15 12z" /><rect x="17.4" y="6" width="2.6" height="12" rx="1" /></>,
  play: <path d="M8 5.2v13.6L19 12z" />,
  rec: <circle cx="12" cy="12" r="6.5" />,
  back: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
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

/**
 * The path of the playhead (or of the library sound) by name, at the left of the bar. When the whole path does not fit, the
 * beginning is compacted and then dropped, so the end, the most relevant part, stays.
 */
function PathBar({ candidates, label }: { candidates: string[][]; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const measured = useRef<(HTMLDivElement | null)[]>([]);
  const [pick, setPick] = useState(0);
  const fit = () => {
    const avail = box.current?.clientWidth ?? 0;
    let k = candidates.length - 1;
    for (let i = 0; i < candidates.length; i++) if ((measured.current[i]?.offsetWidth ?? 0) <= avail) { k = i; break; }
    setPick(k);
  };
  const fitRef = useRef(fit);
  useLayoutEffect(() => { fitRef.current = fit; fit(); });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const nodes = (c: string[]) => c.map((n, i) => <span className={'lv' + (i === c.length - 1 ? ' last' : n === '…' ? ' omit' : '')} key={i}>{n}</span>);
  return (
    <div className="nav-pos" ref={box} aria-label={label} title={label}>
      <div className="measure" aria-hidden="true">
        {candidates.map((c, i) => <div className="cand" key={i} ref={(el) => { measured.current[i] = el; }}>{nodes(c)}</div>)}
      </div>
      <div className="shown">{nodes(candidates[Math.min(pick, candidates.length - 1)] ?? [])}</div>
    </div>
  );
}

/** The one navigation bar of the Script View: position at the left, controls in the centre, clock and Follow at the right. */
export function NavBar({ store, lib, libInfo, story, follow, onFollow, editing, timeline, mobile }: {
  store: PlaybackStore; story: Story; follow: boolean; onFollow: (v: boolean) => void; editing: boolean;
  /** The library sound player: while it has a sound, the bar takes the library layout. */
  lib: LibraryPlayer;
  /** The (i) button of the library layout: the file info panel above the bar. */
  libInfo?: { open: boolean; onToggle: () => void };
  /** A phone: the bar can be folded away to a slim handle, and it makes room for the keyboard while a cue is edited. */
  mobile?: boolean;
  /** The timeline panel's switch; absent where there is no timeline (a textbook). */
  timeline?: { open: boolean; onToggle: () => void };
}) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const seg = store.current();
  const pos = store.pos;
  const recView = store.recView();
  const recKind = recView.startsWith('count') ? 'count' : recView;
  // The fold is remembered; it opens by itself while a take is being recorded, so the stop button is never out of reach.
  const [folded, setFolded] = useLocalState('rs.navFolded', false);
  const libOn = useLibValue(lib, (l) => !!l.track);
  const libPlaying = useLibValue(lib, (l) => l.playing);
  const libPath = useLibValue(lib, (l) => l.track?.path ?? '');
  const hidden = !!mobile && folded && !recView && !libOn;

  // ---- the path of the playhead by name (chapter › segment › scene; the cue is not part of it) ----
  const chapter = pos && story.chapters.find((c) => c.segments.some((x) => x.id === pos.segmentId));
  const segInfo = chapter?.segments.find((x) => x.id === pos!.segmentId);
  const w = seg && pos ? where(seg, pos) : null;
  const scriptPath = w && chapter && segInfo && pos ? scriptPathCandidates({
    chapterIndex: plainIndex(chapter.index), chapterTitle: chapter.title, segmentPosition: segInfo.position, segmentTitle: segInfo.title,
    scene: w.scene, sceneLabel: seg?.scenes[pos.scene]?.label }) : [];
  const candidates = libOn ? libraryPathCandidates(libPath) : scriptPath;

  // ---- keys: Space, ← → (Shift: scene, Alt: segment). Ignored while typing or when a dialog is open ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.backdrop')) return;
      if (lib.track) { if (e.key === ' ') { if (t?.closest('button, a')) return; e.preventDefault(); lib.toggle(); } return; } // the library sound has no script keys
      if (e.key === ' ') { if (t?.closest('button, a')) return; e.preventDefault(); if (store.rec) store.rec.stop(); else store.toggle(); return; }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      store.move(e.altKey ? 'segment' : e.shiftKey ? 'scene' : 'cue', e.key === 'ArrowLeft' ? 'prev' : 'next');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, lib]);

  const btn = (b: (typeof BUTTONS)[number]) => (
    <button key={b.icon} type="button" className="navbtn" title={`${b.label} (${b.keys})`} aria-label={b.label}
      disabled={!store.can(b.level, b.dir)} onClick={() => store.move(b.level, b.dir)}><Icon>{ICONS[b.icon]}</Icon></button>
  );
  return (
    <div className={'navbar' + (libOn ? ' lib' : '') + (mobile ? ' mobile' : '') + (hidden ? ' folded' : '') + (mobile && editing ? ' typing' : '')} role="toolbar" aria-label="Script navigation">
      {mobile && (
        <button type="button" className="nav-fold" aria-expanded={!hidden} aria-label={hidden ? 'Show the navigation bar' : 'Hide the navigation bar'}
          title={hidden ? 'Show the navigation bar' : 'Hide the navigation bar'} onClick={() => setFolded(!folded)}>
          <svg viewBox="0 0 24 12" width="24" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={hidden ? 'M5 9l7-6 7 6' : 'M5 3l7 6 7-6'} /></svg>
        </button>)}
      <div className="nav">
        <PathBar candidates={candidates} label={candidates[0]?.join(' › ') ?? ''} />
        <div className="nav-ctrls">
          {BUTTONS.slice(0, 3).map(btn)}
          {libOn ? (
            <button type="button" className="play" aria-label={libPlaying ? 'Pause' : 'Play'} title={libPlaying ? 'Pause (Space)' : 'Play (Space)'}
              onClick={() => lib.toggle()}><Icon>{libPlaying ? ICONS.pause : ICONS.play}</Icon></button>
          ) : recView ? (
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
          {libOn && <LibWave lib={lib} />}
        </div>
        <div className="nav-right">
          <div className="nav-extras">
          {w && <span className="nav-clock"><b>{formatClock(w.sceneMs)}</b> / {formatClock(w.sceneLengthMs)} in scene</span>}
          <button type="button" className={'followbtn' + (follow ? ' on' : '') + (editing ? ' paused' : '')} aria-pressed={follow}
            aria-label="Script follows playback" title={'Script follows playback' + (editing ? ' (paused while you edit a cue)' : '')} onClick={() => onFollow(!follow)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle className="disc" cx="12" cy="12" r="6.5" />
              <circle className="dot" cx="12" cy="12" r="2" />
              <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
            </svg>
          </button>
          {timeline && (
            <button type="button" className={'tlbtn' + (timeline.open ? ' on' : '')} aria-pressed={timeline.open} data-testid="timeline-toggle"
              title={timeline.open ? 'Hide the timeline' : 'Show the timeline'} onClick={timeline.onToggle}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M2.5 5.5h8M13.5 5.5h4M2.5 10h4M9.5 10h8M2.5 14.5h10M15.5 14.5h2" />
                <rect x="10.5" y="3.8" width="3" height="3.4" rx=".6" fill="currentColor" stroke="none" />
                <rect x="6.5" y="8.3" width="3" height="3.4" rx=".6" fill="currentColor" stroke="none" />
                <rect x="12.5" y="12.8" width="3" height="3.4" rx=".6" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}
          </div>
          {libOn && libInfo && (
            <button type="button" className={'lib-return' + (libInfo.open ? ' on' : '')} aria-pressed={libInfo.open} aria-label="File info" title="File info" onClick={libInfo.onToggle}>
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><circle cx="12" cy="7.8" r=".6" fill="currentColor" />
              </svg>
            </button>)}
          {libOn && (
            <button type="button" className="lib-return" aria-label="Return to script" title="Return to script" onClick={() => lib.close()}>
              <Icon>{ICONS.back}</Icon>
            </button>)}
        </div>
      </div>
    </div>
  );
}
