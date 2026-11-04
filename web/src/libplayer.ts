// The player for one library sound, played in the navigation bar. It lives outside React (like PlaybackStore) so the bar,
// the waves and the Library panel share one audio element. While it has a track, the bar shows the library layout.
import { createContext, useSyncExternalStore } from 'react';
import { assetUrl } from './api.ts';
import type { LibFile } from './types.ts';

/** The library file being played (all its details are at hand for the info panel). */
export type LibTrack = LibFile;

export class LibraryPlayer {
  track: LibTrack | null = null;
  playing = false;
  /** Seconds. */
  pos = 0;
  dur = 0;
  error = '';
  private audio: HTMLAudioElement | null = null;
  private version = 0;
  private subs = new Set<() => void>();
  private raf = 0;

  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  getVersion = () => this.version;
  private emit() { this.version++; for (const f of this.subs) f(); }

  private make(): HTMLAudioElement {
    const a = new Audio();
    a.preload = 'metadata';
    a.addEventListener('play', () => { this.playing = true; this.error = ''; this.loop(); this.emit(); });
    a.addEventListener('pause', () => { this.playing = false; this.pos = a.currentTime; this.emit(); });
    a.addEventListener('ended', () => { this.playing = false; this.pos = a.duration || this.dur; this.emit(); });
    a.addEventListener('loadedmetadata', () => { if (Number.isFinite(a.duration) && a.duration > 0) { this.dur = a.duration; this.emit(); } });
    a.addEventListener('timeupdate', () => { if (!this.playing) { this.pos = a.currentTime; this.emit(); } });
    a.addEventListener('error', () => { this.playing = false; this.error = 'The file could not be played.'; this.emit(); });
    return a;
  }
  /** While playing, the position follows the audio element every frame so the playhead is smooth. */
  private loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.playing || !this.audio) return;
      this.pos = this.audio.currentTime; this.emit();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Loads the sound (when it is not the one loaded already) and plays it, from `startFrac` (0..1) of its length. */
  play(t: LibTrack, startFrac = 0) {
    const a = (this.audio ??= this.make());
    const same = this.track?.id === t.id && this.track.hasLightweight === t.hasLightweight;
    this.track = t; this.error = '';
    if (!same) { a.src = assetUrl(t.id, t.hasLightweight); this.dur = (t.durationMs ?? 0) / 1000; this.pos = 0; }
    if (startFrac > 0 && this.dur > 0) { a.currentTime = startFrac * this.dur; this.pos = a.currentTime; }
    else if (same && a.ended) { a.currentTime = 0; this.pos = 0; }
    void a.play().catch((e) => { this.error = String(e?.message ?? e); this.emit(); });
    this.emit();
  }
  toggle() {
    const a = this.audio;
    if (!a || !this.track) return;
    if (a.paused) { if (a.ended) a.currentTime = 0; void a.play().catch((e) => { this.error = String(e?.message ?? e); this.emit(); }); }
    else a.pause();
  }
  seek(seconds: number) {
    if (!this.audio) return;
    const t = Math.max(0, this.dur > 0 ? Math.min(this.dur, seconds) : seconds);
    this.audio.currentTime = t; this.pos = t; this.emit();
  }
  /** Stops the sound and leaves the library layout. */
  close() {
    if (!this.track) return;
    this.audio?.pause();
    this.track = null; this.playing = false; this.pos = 0; this.error = '';
    this.emit();
  }
  dispose() {
    cancelAnimationFrame(this.raf);
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); }
    this.subs.clear();
  }
}

/** Starts a library sound in the bar (given by the Script View; absent where there is no bar). */
export const LibPlayContext = createContext<((t: LibTrack, startFrac?: number) => void) | null>(null);

/** Re-renders when the value picked from the player changes. */
export function useLibValue<T extends string | number | boolean>(lib: LibraryPlayer, pick: (l: LibraryPlayer) => T): T {
  return useSyncExternalStore(lib.subscribe, () => pick(lib));
}
