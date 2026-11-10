// Plays the audio of the cues while the script plays: each cue's chosen clip starts with the cue and stops with it.
// The clock (PlaybackStore) is the master; this only follows it, correcting the audio when the playhead jumps.
import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import processorUrl from '@soundtouchjs/audio-worklet/processor?url';
import { assetUrl } from './api.ts';
import { envelopeGain, envelopeValue, sourceAt } from '../../src/shared/audio-settings.ts';
import { posKey, type NavClip } from './nav.ts';
import type { PlaybackStore } from './playback.ts';

const STEP_MS = 30;
const DRIFT_S = 0.4; // the audio is moved only when it is this far from where the clock says it should be
const WARM_MS = 3000; // cues starting within this time are loaded in advance

/** The highest the volume envelope goes (dB), 0 without one. */
const peakDb = (c: NavClip) => (c.volumePoints?.length ? Math.max(0, ...c.volumePoints.map((p) => p[1])) : 0);

const urlOf = (c: NavClip) => assetUrl(c.assetId, c.light);

/** An element routed through Web Audio: for a gain above 1 (an element's own volume stops at 1) and, with `node`, for a pitch: the element plays at the speed (its own pitch correction off), the shifter sets the pitch. */
interface Routed { src: MediaElementAudioSourceNode; node?: SoundTouchNode; gain: GainNode }
type Live = { el: HTMLAudioElement; url: string; routed?: Routed };

export class AudioPlayer {
  private live = new Map<string, Live>();
  private ctx: AudioContext | null = null;
  private shifter: 'none' | 'loading' | 'ready' | 'failed' = 'none';
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
    for (const l of this.live.values()) this.release(l);
    this.live.clear();
  }

  private release(l: Live) {
    l.el.pause();
    if (l.routed) { l.routed.src.disconnect(); l.routed.node?.disconnect(); l.routed.gain.disconnect(); }
  }

  private ensureCtx(): AudioContext | null {
    if (!this.ctx) { try { this.ctx = new AudioContext(); } catch { return null; } }
    return this.ctx;
  }

  /** The pitch shifter's processor is loaded once, the first time a take has a pitch; until it is ready the take plays at its own pitch. */
  private prepareShifter() {
    if (this.shifter !== 'none') return;
    const ctx = this.ensureCtx();
    if (!ctx) { this.shifter = 'failed'; return; }
    this.shifter = 'loading';
    SoundTouchNode.register(ctx, processorUrl).then(() => { this.shifter = 'ready'; }, () => { this.shifter = 'failed'; });
  }

  private route(l: Live) {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const src = ctx.createMediaElementSource(l.el), gain = ctx.createGain();
    src.connect(gain); gain.connect(ctx.destination);
    l.routed = { src, gain };
  }

  /** Puts the pitch shifter between the source and the gain of a routed element. */
  private shift(l: Live) {
    const r = l.routed!, ctx = this.ctx!;
    const node = new SoundTouchNode({ context: ctx });
    r.src.disconnect(); r.src.connect(node); node.connect(r.gain);
    r.node = node;
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
      if (!clip || c.muted || store.recPhase(c.id)) continue; // a cue being recorded must not play its old takes into the microphone
      const t = now - c.startMs;
      const len = Math.min(c.lengthMs, clip.lengthMs);
      if (t < 0) { if (-t <= WARM_MS) { upcoming.add(c.id); this.preload(c.id, clip); } continue; }
      if (t >= len) continue;
      active.add(c.id);
      const want = (clip.offsetMs + sourceAt(clip.speed, clip.speedPoints, t)) / 1000; // a faster take uses more of the file in the same time
      let l = this.live.get(c.id);
      if (l && l.url !== urlOf(clip)) { this.release(l); this.live.delete(c.id); l = undefined; }
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
      // Speed (the pitch kept by the browser), pitch (through the shifter) and the volume: the level, the fades and the envelope.
      const rate = clip.speed * envelopeValue(clip.speedPoints, t, 'speed');
      const cents = clip.pitchCents + envelopeValue(clip.pitchPoints, t, 'pitch');
      const pitched = clip.pitchCents !== 0 || !!clip.pitchPoints?.length;
      const boosted = clip.gainDb + peakDb(clip) > 0;
      if (pitched) this.prepareShifter();
      if (!l.routed && boosted) this.route(l);
      if (pitched && this.shifter === 'ready') { if (!l.routed) this.route(l); if (l.routed && !l.routed.node) this.shift(l); }
      if (Math.abs(l.el.playbackRate - rate) > 0.001) l.el.playbackRate = rate;
      l.el.preservesPitch = !l.routed?.node;
      const fadeIn = clip.fadeInMs > 0 ? Math.min(1, t / clip.fadeInMs) : 1;
      const fadeOut = clip.fadeOutMs > 0 ? Math.min(1, (len - t) / clip.fadeOutMs) : 1;
      const volume = Math.max(0, 10 ** (clip.gainDb / 20) * fadeIn * fadeOut * envelopeGain(clip.volumePoints, t));
      if (l.routed) {
        if (l.routed.node) { l.routed.node.playbackRate.value = rate; l.routed.node.pitch.value = 2 ** (cents / 1200); }
        l.routed.gain.gain.value = volume;
      } else l.el.volume = Math.min(1, volume);
    }
    for (const [id, l] of this.live) if (!active.has(id)) { this.release(l); this.live.delete(id); }
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
    void this.ctx?.close().catch(() => undefined);
  }
}
