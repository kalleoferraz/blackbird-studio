// Plays the audio of the cues while the script plays: each cue's chosen clip starts with the cue and stops with it.
// The clock (PlaybackStore) is the master; this only follows it, correcting the audio when the playhead jumps.
import { assetUrl } from './api.ts';
import { posKey, type NavClip } from './nav.ts';
import type { PlaybackStore } from './playback.ts';

const STEP_MS = 30;
const DRIFT_S = 0.4; // the audio is moved only when it is this far from where the clock says it should be
const WARM_MS = 3000; // cues starting within this time are loaded in advance

const urlOf = (c: NavClip) => assetUrl(c.assetId, c.light);

export class AudioPlayer {
  private live = new Map<string, { el: HTMLAudioElement; url: string }>();
  private warm = new Map<string, { el: HTMLAudioElement; url: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stamp = { key: -1, ms: 0, at: 0, scene: -1 };
  private wasPlaying = false;
  private unsub: () => void;

  constructor(private store: PlaybackStore) {
    this.unsub = store.subscribe(() => this.onStore());
  }

  private onStore() {
    const pos = this.store.pos;
    if (pos) {
      const key = posKey(pos);
      // A new position, or the clock has just started: time is measured from here.
      if (key !== this.stamp.key || (this.store.playing && !this.wasPlaying)) this.stamp = { key, ms: pos.ms, at: performance.now(), scene: pos.scene };
    }
    this.wasPlaying = this.store.playing;
    if (this.store.playing && !this.timer) this.timer = setInterval(() => this.step(), STEP_MS);
    if (!this.store.playing && this.timer) { clearInterval(this.timer); this.timer = null; this.silence(); }
  }

  private silence() {
    for (const { el } of this.live.values()) el.pause();
    this.live.clear();
  }

  private step() {
    const { store } = this;
    const d = store.current(), pos = store.pos;
    const scene = d && pos ? d.scenes[pos.scene] : undefined;
    if (!d || !pos || !scene) { this.silence(); return; }
    // The clock moves in 100 ms steps; between them the time is estimated, so a cue starts close to its exact moment.
    const now = this.stamp.scene === pos.scene ? this.stamp.ms + Math.min(performance.now() - this.stamp.at, 150) : pos.ms;
    const active = new Set<string>();
    const upcoming = new Set<string>();
    for (const c of scene.cues) {
      const clip = c.clip;
      if (!clip || store.recPhase(c.id)) continue; // a cue being recorded must not play its old takes into the microphone
      const t = now - c.startMs;
      const len = Math.min(c.lengthMs, clip.lengthMs);
      if (t < 0) { if (-t <= WARM_MS) { upcoming.add(c.id); this.preload(c.id, clip); } continue; }
      if (t >= len) continue;
      active.add(c.id);
      const want = (clip.offsetMs + t) / 1000;
      let l = this.live.get(c.id);
      if (l && l.url !== urlOf(clip)) { l.el.pause(); this.live.delete(c.id); l = undefined; }
      if (!l) {
        const warmed = this.warm.get(c.id);
        this.warm.delete(c.id);
        l = warmed && warmed.url === urlOf(clip) ? warmed : { el: new Audio(urlOf(clip)), url: urlOf(clip) };
        l.el.currentTime = want;
        this.live.set(c.id, l);
        void l.el.play().catch(() => undefined);
      } else {
        if (Math.abs(l.el.currentTime - want) > DRIFT_S) l.el.currentTime = want;
        if (l.el.paused && !l.el.ended) void l.el.play().catch(() => undefined);
      }
      const gain = 10 ** (clip.gainDb / 20);
      const fadeIn = clip.fadeInMs > 0 ? Math.min(1, t / clip.fadeInMs) : 1;
      const fadeOut = clip.fadeOutMs > 0 ? Math.min(1, (len - t) / clip.fadeOutMs) : 1;
      l.el.volume = Math.max(0, Math.min(1, gain * fadeIn * fadeOut));
    }
    for (const [id, l] of this.live) if (!active.has(id)) { l.el.pause(); this.live.delete(id); }
    for (const id of this.warm.keys()) if (!upcoming.has(id)) this.warm.delete(id);
  }

  private preload(id: string, clip: NavClip) {
    const url = urlOf(clip);
    if (this.warm.get(id)?.url === url) return;
    const el = new Audio(url);
    el.preload = 'auto';
    this.warm.set(id, { el, url });
  }

  dispose() {
    this.unsub();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.silence();
    this.warm.clear();
  }
}
