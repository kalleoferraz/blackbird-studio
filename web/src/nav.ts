// Navigation logic for the Script View, with no React in it so it can be tested on its own.
//
// The playhead is a position inside the open segment: a scene and a time inside that scene (ms).
// Four levels exist in the story (chapter > segment > scene > cue); the bar moves by cue, scene and segment.
import type { SegmentContent } from './types.ts';

/** Past this much time inside a unit, "previous" goes to the unit's own start; before it, to the previous unit. */
export const RESTART_MS = 3000;

export type Level = 'cue' | 'scene' | 'segment';
/** The audio a cue plays (its chosen clip). */
export interface NavClip { assetId: string; light: boolean; offsetMs: number; lengthMs: number; gainDb: number; fadeInMs: number; fadeOutMs: number; speed: number; pitchCents: number; volumePoints: [number, number][] | null; speedPoints: [number, number][] | null; pitchPoints: [number, number][] | null }
export interface NavCue { id: string; startMs: number; lengthMs: number; clip?: NavClip | null; muted?: boolean }
export interface NavScene { id: string; startMs: number; lengthMs: number; cues: NavCue[]; /** The scene's title, when it has one. */ label?: string | null }
export interface NavSegment { id: string; scenes: NavScene[] }
/** `ms` is counted from the start of the scene. */
export interface Pos { segmentId: string; scene: number; ms: number }
/** Where to land when a move enters another segment (whose content is not loaded yet). */
export type Arrive = 'start' | 'first-cue' | 'last-cue' | 'last-scene';
export type Move = { pos: Pos } | { segmentId: string; arrive: Arrive };
export type Step = { pos: Pos } | { move: Move } | { end: Pos };

function chosenClip(q: SegmentContent['scenes'][number]['cues'][number]): NavClip | null {
  const k = q.clips.find((x) => x.id === q.clipId);
  return k ? { assetId: k.assetId, light: k.light, offsetMs: k.offsetMs, lengthMs: k.lengthMs, gainDb: k.gainDb, fadeInMs: k.fadeInMs, fadeOutMs: k.fadeOutMs, speed: k.speed, pitchCents: k.pitchCents, volumePoints: k.volumePoints, speedPoints: k.speedPoints, pitchPoints: k.pitchPoints } : null;
}

export function toNav(c: SegmentContent): NavSegment {
  return {
    id: c.segment.id,
    scenes: c.scenes.map((s) => ({
      id: s.id, startMs: s.startMs, lengthMs: s.lengthMs, label: s.label,
      cues: s.cues.map((q) => ({ id: q.id, startMs: q.startMs, lengthMs: q.lengthMs, clip: chosenClip(q), muted: q.muted })).sort((a, b) => a.startMs - b.startMs),
    })),
  };
}

// A scene index and a time in one number, so positions compare with < and >. A scene is at most 99 minutes (< 1e8 ms).
const key = (scene: number, ms: number) => scene * 1e8 + ms;
export const posKey = (p: Pos) => key(p.scene, p.ms);

export interface FlatCue { scene: number; cue: NavCue; k: number }
/** Every cue of the segment in script order. */
export function flatCues(seg: NavSegment): FlatCue[] {
  const out: FlatCue[] = [];
  seg.scenes.forEach((s, i) => s.cues.forEach((cue) => out.push({ scene: i, cue, k: key(i, cue.startMs) })));
  return out;
}
/** Index of the last cue that starts at or before the position; -1 before the first cue. */
export function currentIndex(flat: FlatCue[], p: Pos): number {
  const k = posKey(p);
  let r = -1;
  for (let i = 0; i < flat.length; i++) { if (flat[i]!.k <= k) r = i; else break; }
  return r;
}
/** Keeps a position inside the segment (after edits that shorten or remove scenes). */
export function clampPos(seg: NavSegment, p: Pos): Pos {
  const scene = Math.min(Math.max(p.scene, 0), Math.max(0, seg.scenes.length - 1));
  const len = seg.scenes[scene]?.lengthMs ?? 0;
  return { segmentId: seg.id, scene, ms: Math.max(0, Math.min(p.ms, len)) };
}

function around(order: string[], id: string): { prev?: string; next?: string } {
  const i = order.indexOf(id);
  if (i < 0) return {};
  return { prev: order[i - 1], next: order[i + 1] };
}

/** Where "previous" goes at the given level, or null when there is nowhere to go (the very beginning). */
export function prevMove(level: Level, seg: NavSegment, p: Pos, order: string[]): Move | null {
  const { prev } = around(order, seg.id);
  const here = (scene: number, ms: number): Move => ({ pos: { segmentId: seg.id, scene, ms } });
  const atStart = p.scene === 0 && p.ms === 0;
  if (level === 'cue') {
    const flat = flatCues(seg), cur = currentIndex(flat, p), k = posKey(p);
    if (cur >= 0) {
      const c = flat[cur]!;
      if (k - c.k > RESTART_MS) return here(c.scene, c.cue.startMs);
      for (let j = cur - 1; j >= 0; j--) if (flat[j]!.k < c.k) return here(flat[j]!.scene, flat[j]!.cue.startMs);
      if (prev) return { segmentId: prev, arrive: 'last-cue' };
      return k > c.k ? here(c.scene, c.cue.startMs) : null;
    }
    if (prev) return { segmentId: prev, arrive: 'last-cue' };
    return atStart ? null : here(0, 0);
  }
  if (level === 'scene') {
    if (p.ms > RESTART_MS) return here(p.scene, 0);
    if (p.scene > 0) return here(p.scene - 1, 0);
    if (prev) return { segmentId: prev, arrive: 'last-scene' };
    return p.ms > 0 ? here(p.scene, 0) : null;
  }
  const elapsed = (seg.scenes[p.scene]?.startMs ?? 0) + p.ms;
  if (elapsed > RESTART_MS) return here(0, 0);
  if (prev) return { segmentId: prev, arrive: 'start' };
  return atStart ? null : here(0, 0);
}

/** Where "next" goes at the given level, or null at the very end. */
export function nextMove(level: Level, seg: NavSegment, p: Pos, order: string[]): Move | null {
  const { next } = around(order, seg.id);
  const here = (scene: number, ms: number): Move => ({ pos: { segmentId: seg.id, scene, ms } });
  if (level === 'cue') {
    const k = posKey(p);
    const f = flatCues(seg).find((x) => x.k > k);
    if (f) return here(f.scene, f.cue.startMs);
    return next ? { segmentId: next, arrive: 'first-cue' } : null;
  }
  if (level === 'scene') {
    if (p.scene + 1 < seg.scenes.length) return here(p.scene + 1, 0);
    return next ? { segmentId: next, arrive: 'start' } : null;
  }
  return next ? { segmentId: next, arrive: 'start' } : null;
}

/** The position a move into this (now loaded) segment lands on. */
export function arrive(seg: NavSegment, how: Arrive): Pos {
  const start: Pos = { segmentId: seg.id, scene: 0, ms: 0 };
  if (how === 'start') return start;
  if (how === 'last-scene') return { segmentId: seg.id, scene: Math.max(0, seg.scenes.length - 1), ms: 0 };
  const flat = flatCues(seg);
  const f = how === 'first-cue' ? flat[0] : flat[flat.length - 1];
  return f ? { segmentId: seg.id, scene: f.scene, ms: f.cue.startMs } : start;
}

/** Walks the clock forward by cue lengths, so time passes with or without audio. */
export function advance(seg: NavSegment, p: Pos, dtMs: number, order: string[]): Step {
  let scene = p.scene, ms = p.ms + dtMs;
  for (;;) {
    const len = seg.scenes[scene]?.lengthMs ?? 0;
    if (ms < len) return { pos: { segmentId: seg.id, scene, ms } };
    if (scene + 1 < seg.scenes.length) { ms -= len; scene++; continue; }
    const { next } = around(order, seg.id);
    if (next) return { move: { segmentId: next, arrive: 'start' } };
    return { end: { segmentId: seg.id, scene, ms: len } };
  }
}

/** Numbers for the position readout: scene n of N, cue n of N (cue 0 = none started yet in this scene). */
export function where(seg: NavSegment, p: Pos) {
  const sc = seg.scenes[p.scene];
  const cues = sc?.cues ?? [];
  return { scene: p.scene + 1, scenes: seg.scenes.length, cue: cues.filter((c) => c.startMs <= p.ms).length, cues: cues.length, sceneMs: p.ms, sceneLengthMs: sc?.lengthMs ?? 0 };
}

/** What the path in the bar needs to name the place of the playhead. */
export interface PathInfo { chapterIndex: string; chapterTitle: string; segmentPosition: number; segmentTitle: string; scene: number; sceneLabel?: string | null }

/**
 * The path "Chapter › Segment › Scene" by name (the cue is not part of it), as candidates from the fullest to the shortest.
 * The end of the path matters most, so the beginning is compacted first ("2. O Feitiço" → "Ch.2"), then dropped ("…").
 */
export function scriptPathCandidates(i: PathInfo): string[][] {
  const chC = `Ch.${i.chapterIndex}`;
  const ch = i.chapterTitle.trim() ? `${i.chapterIndex}. ${i.chapterTitle.trim()}` : chC;
  const segC = `Seg.${i.segmentPosition}`;
  const seg = i.segmentTitle.trim() || segC;
  const sc = i.sceneLabel?.trim() || `Scene ${i.scene}`;
  return [[ch, seg, sc], [chC, seg, sc], [chC, segC, sc], ['…', segC, sc], [sc]];
}

/** The path of a library file (folders and file name), as candidates: folders from the beginning are dropped one by one ("…"). */
export function libraryPathCandidates(path: string): string[][] {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return [[path]];
  return parts.map((_, i) => (i === 0 ? parts : i === parts.length - 1 ? [parts[i]!] : ['…', ...parts.slice(i)]));
}
