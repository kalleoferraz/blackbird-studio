// The playhead of the Script View: one position, one clock, shared by the navigation bar and the writing panel.
// It lives outside React state so a 10 Hz clock re-renders only what shows the time (the bar and the cue under the playhead).
import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  advance, arrive, clampPos, currentIndex, flatCues, nextMove, posKey, prevMove,
  type Arrive, type FlatCue, type Level, type Move, type NavSegment, type Pos,
} from './nav.ts';

const TICK_MS = 100;

/** A take being recorded: counting in (count 3..1, 0 while the microphone is asked for), recording, or saving. */
export interface RecState { cueId: string; phase: 'count' | 'rec' | 'saving'; count: number; stop: () => void; cancel: () => void }

export class PlaybackStore {
  pos: Pos | null = null;
  playing = false;
  /** Playback stops at the end of the scene instead of running into the next one (Follow is off: the view stays on this scene). */
  holdScene = false;
  rec: RecState | null = null;
  /** A move into a segment whose content is still loading. */
  pending: { segmentId: string; arrive: Arrive } | null = null;
  private data: NavSegment | null = null;
  private order: string[] = [];
  private version = 0;
  private subs = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private flatFor: { seg: NavSegment; flat: FlatCue[]; byId: Map<string, FlatCue> } | null = null;

  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  getVersion = () => this.version;
  private emit() { this.version++; for (const f of this.subs) f(); }

  /** The segment content that matches the playhead, or null while it loads. */
  current(): NavSegment | null {
    return this.data && this.pos && !this.pending && this.data.id === this.pos.segmentId ? this.data : null;
  }
  /** The segment the playhead is in, or is about to enter. */
  wantedSegment(): string | null { return this.pending?.segmentId ?? this.pos?.segmentId ?? null; }
  private flat(seg: NavSegment): FlatCue[] {
    if (this.flatFor?.seg !== seg) { const flat = flatCues(seg); this.flatFor = { seg, flat, byId: new Map(flat.map((f) => [f.cue.id, f])) }; }
    return this.flatFor.flat;
  }

  /** The segments in story order, for moves between segments. */
  setOrder(ids: string[]) {
    if (ids.length === this.order.length && ids.every((x, i) => x === this.order[i])) return;
    this.order = ids;
    if (this.pos && !ids.includes(this.pos.segmentId)) { this.pos = null; this.pending = null; this.stop(); }
    this.emit();
  }
  /** Content of the segment the playhead is in (or entering). */
  setData(d: NavSegment) {
    this.data = d;
    if (this.pending && this.pending.segmentId === d.id) { this.pos = arrive(d, this.pending.arrive); this.pending = null; }
    else if (this.pos && this.pos.segmentId === d.id) this.pos = clampPos(d, this.pos);
    this.emit();
  }
  /** Moves the playhead into a segment (the user opened it, or the clock crossed into it). */
  jump(segmentId: string, how: Arrive = 'start', keepPlaying = false) {
    this.pending = { segmentId, arrive: how };
    if (!keepPlaying) this.stop();
    if (this.data?.id === segmentId) { this.pos = arrive(this.data, how); this.pending = null; }
    this.emit();
  }
  seek(p: Pos) { this.pos = p; this.pending = null; this.emit(); }

  private moveFor(level: Level, dir: 'prev' | 'next'): Move | null {
    const d = this.current();
    if (!d || !this.pos) return null;
    return dir === 'prev' ? prevMove(level, d, this.pos, this.order) : nextMove(level, d, this.pos, this.order);
  }
  can(level: Level, dir: 'prev' | 'next'): boolean { return this.moveFor(level, dir) !== null; }
  move(level: Level, dir: 'prev' | 'next') {
    const m = this.moveFor(level, dir);
    if (m) this.apply(m);
  }
  private apply(m: Move) {
    if ('pos' in m) this.pos = m.pos; else this.pending = m;
    this.emit();
  }

  setRec(r: Omit<RecState, never> | null) { this.rec = r; this.emit(); }
  play() { if (this.pos && !this.playing) { this.start(); this.emit(); } }
  pause() { if (this.playing) { this.stop(); this.emit(); } }
  /** The recording phase for one cue ('' when it is not the one being recorded). */
  recPhase(cueId: string): string { return this.rec?.cueId === cueId ? this.rec.phase : ''; }
  /** What the play button shows while a take is made, as one primitive: '' none, 'count:3', 'rec', 'saving'. */
  recView(): string { return !this.rec ? '' : this.rec.phase === 'count' ? `count:${this.rec.count}` : this.rec.phase; }

  toggle() { if (this.pos) { if (this.playing) this.stop(); else this.start(); this.emit(); } }
  private start() {
    // Resting at the end of a scene: playing goes on from the next one.
    const d = this.current();
    if (d && this.pos && this.pos.ms >= (d.scenes[this.pos.scene]?.lengthMs ?? 0)) {
      const s = advance(d, this.pos, 0, this.order);
      if ('pos' in s) this.pos = s.pos; else if ('move' in s) this.apply(s.move);
    }
    this.playing = true; this.last = performance.now();
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }
  private stop() {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  private tick() {
    const now = performance.now(), dt = now - this.last;
    this.last = now;
    const d = this.current();
    if (!d || !this.pos) return; // loading: the clock waits
    const s = advance(d, this.pos, dt, this.order);
    if (this.rec?.phase === 'rec' && !('pos' in s)) {
      // Recording: time runs on past the end of the cue (the other lanes keep playing; the cue keeps its length until
      // the take is reviewed), but not into another segment: at the end of this one the playhead waits there.
      const last = d.scenes.length - 1;
      const end = d.scenes[last]?.lengthMs ?? this.pos.ms;
      if (this.pos.scene !== last || this.pos.ms !== end) { this.pos = { ...this.pos, scene: Math.max(0, last), ms: end }; this.emit(); }
      return;
    }
    if (this.holdScene && (!('pos' in s) || s.pos.scene !== this.pos.scene)) {
      this.pos = { ...this.pos, ms: d.scenes[this.pos.scene]?.lengthMs ?? this.pos.ms };
      this.stop(); this.emit(); return;
    }
    if ('pos' in s) this.pos = s.pos;
    else if ('move' in s) this.apply(s.move);
    else { this.pos = s.end; this.stop(); }
    this.emit();
  }
  dispose() { this.rec?.cancel(); this.stop(); this.subs.clear(); }

  // ---- values for the screen (primitives, so a component re-renders only when its own value changes) ----
  currentCueId(): string {
    const d = this.current();
    if (!d || !this.pos) return '';
    const flat = this.flat(d), i = currentIndex(flat, this.pos);
    return i >= 0 ? flat[i]!.cue.id : '';
  }
  currentSceneId(): string { const d = this.current(); return (d && this.pos && d.scenes[this.pos.scene]?.id) || ''; }
  /**
   * For one cue, judged on its own time span, so overlapping cues each keep their own progress:
   * -1 waiting (or not in this segment), 0..1000 while the playhead is inside it, 2000 once it has finished.
   */
  cueState(cueId: string): number {
    const d = this.current();
    if (!d || !this.pos) return -1;
    this.flat(d);
    const f = this.flatFor?.byId.get(cueId);
    if (!f) return -1;
    if (f.scene < this.pos.scene) return 2000;
    if (f.scene > this.pos.scene) return -1;
    const elapsed = this.pos.ms - f.cue.startMs;
    if (elapsed < 0) return -1;
    const len = Math.max(1, f.cue.lengthMs);
    if (elapsed >= len) return 2000;
    return Math.min(1000, Math.round((elapsed / len) * 1000));
  }
  /** Where the playhead is, as a sortable number (used only to detect change). */
  key(): number { return this.pos ? posKey(this.pos) : -1; }
}

export interface NavCtx { store: PlaybackStore; setEditing: (on: boolean) => void; record: (cueId: string) => void }
export const NavContext = createContext<NavCtx | null>(null);
export const useNav = () => useContext(NavContext);

const noSubscribe = () => () => {};
/** Re-renders when the value picked from the store changes. */
export function useStoreValue<T extends string | number | boolean>(store: PlaybackStore | null | undefined, pick: (s: PlaybackStore) => T, fallback: T): T {
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, () => (store ? pick(store) : fallback));
}
