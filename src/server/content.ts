/**
 * The content of a segment: scenes, cues and the lanes created for them (Bible, section 5: Cue types and
 * lanes, Lane rules, Cue length and clip playback). All functions run inside the caller's transaction.
 */
import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { basename } from 'node:path';
import type { Q, Tx } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { closeGap, openGap, PARKED } from '../db/positions.js';
import { asset, assetPeaks, chapter, character, clip, cue, lane, project, segment, scene } from '../db/schema.js';
import { MIN_CUE_MS, estimateSpeechMs, msPerUnit, speechUnits, type LearnedSpeech } from '../shared/estimate.js';
import { ripple, type RippleCue } from '../shared/ripple.js';
import { sourceAt, type VolumePoint } from '../shared/audio-settings.js';
import { HttpError, badRequest, notFound } from './http.js';

export type CueType = 'speech' | 'sfx' | 'music';
export const MAX_SCENE_MS = 99 * 60 * 1000; // 99 minutes within a scene (Bible, section 5, Limits)
export const MAX_SCENES = 99;

export interface CueRow {
  id: string;
  sceneId: string;
  laneId: string;
  type: CueType;
  characterId: string | null;
  startMs: number;
  lengthMs: number;
  lengthAuto: boolean;
  muted: boolean;
  textMd: string;
  clipId: string | null;
}

const cueColumns = {
  id: cue.id,
  sceneId: cue.sceneId,
  laneId: cue.laneId,
  type: cue.type,
  characterId: cue.characterId,
  startMs: cue.startMs,
  lengthMs: cue.lengthMs,
  lengthAuto: cue.lengthAuto,
  muted: cue.muted,
  textMd: cue.textMd,
  clipId: cue.clipId,
};

// ---- loading ----------------------------------------------------------------------

export async function segmentContext(
  tx: Tx,
  segmentId: string,
): Promise<{ projectId: string; language: string; segmentId: string; speech: LearnedSpeech }> {
  const rows = await tx
    .select({ projectId: project.id, language: project.language, units: project.speechUnits, ms: project.speechMs })
    .from(segment)
    .innerJoin(chapter, eq(chapter.id, segment.chapterId))
    .innerJoin(project, eq(project.id, chapter.projectId))
    .where(eq(segment.id, segmentId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound();
  return { projectId: row.projectId, language: row.language, segmentId, speech: { units: row.units, ms: row.ms } };
}

export async function sceneRow(tx: Tx, sceneId: string) {
  const rows = await tx.select().from(scene).where(eq(scene.id, sceneId)).limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

export async function cueRow(tx: Tx, cueId: string): Promise<CueRow> {
  const rows = await tx.select(cueColumns).from(cue).where(eq(cue.id, cueId)).limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

/** The cues of a scene in script order: start time, then lane order. */
export async function sceneCues(tx: Tx, sceneId: string): Promise<CueRow[]> {
  return tx
    .select(cueColumns)
    .from(cue)
    .innerJoin(lane, eq(lane.id, cue.laneId))
    .where(eq(cue.sceneId, sceneId))
    .orderBy(asc(cue.startMs), asc(lane.position), asc(cue.id));
}

export async function narratorOf(tx: Tx, projectId: string) {
  const rows = await tx
    .select()
    .from(character)
    .where(and(eq(character.projectId, projectId), eq(character.isNarrator, true)))
    .limit(1);
  return rows[0];
}

async function characterIn(tx: Tx, projectId: string, characterId: string) {
  const rows = await tx
    .select()
    .from(character)
    .where(and(eq(character.id, characterId), eq(character.projectId, projectId)))
    .limit(1);
  if (!rows[0]) throw new HttpError(400, 'invalid_character');
  return rows[0];
}

// ---- lanes ------------------------------------------------------------------------

const LANE_COLOURS: Record<CueType, string> = { speech: '#B5A89F', sfx: '#8C7F78', music: '#CFC3B8' };
const LANE_TITLES: Record<CueType, string> = { speech: 'Speech', sfx: 'SFX', music: 'Music' };

/** The lane a cue belongs on, created when the segment has none that fits (Cue types and lanes). */
export async function laneFor(
  tx: Tx,
  ctx: { projectId: string; segmentId: string },
  spec: { type: CueType; characterId: string | null; sceneId: string; startMs: number; lengthMs: number; excludeCueId?: string },
): Promise<string> {
  const lanes = await tx.select().from(lane).where(eq(lane.segmentId, ctx.segmentId)).orderBy(asc(lane.position));
  const typeRows = await tx
    .select({ laneId: cue.laneId, type: cue.type })
    .from(cue)
    .innerJoin(scene, eq(scene.id, cue.sceneId))
    .where(and(eq(scene.segmentId, ctx.segmentId)))
    .groupBy(cue.laneId, cue.type);
  const typesOf = new Map<string, Set<string>>();
  for (const r of typeRows) {
    if (!typesOf.has(r.laneId)) typesOf.set(r.laneId, new Set());
    typesOf.get(r.laneId)!.add(r.type);
  }
  const sameScene = await tx.select(cueColumns).from(cue).where(eq(cue.sceneId, spec.sceneId));
  const busy = (laneId: string) =>
    sameScene.some(
      (c) =>
        c.laneId === laneId &&
        c.id !== spec.excludeCueId &&
        c.startMs < spec.startMs + spec.lengthMs &&
        spec.startMs < c.startMs + c.lengthMs,
    );

  let found: string | undefined;
  if (spec.type === 'speech' && spec.characterId) {
    found = lanes.find((l) => l.characterId === spec.characterId)?.id;
  } else {
    const kindLanes = lanes.filter((l) => l.characterId === null && (typesOf.get(l.id)?.has(spec.type) ?? false));
    found = kindLanes.find((l) => !busy(l.id))?.id;
    if (spec.type === 'speech') found = kindLanes[0]?.id; // one plain Speech lane; overlap is resolved by position
  }
  if (found) return found;

  let title = LANE_TITLES[spec.type];
  let colour = LANE_COLOURS[spec.type];
  if (spec.type === 'speech' && spec.characterId) {
    const ch = await characterIn(tx, ctx.projectId, spec.characterId);
    title = ch.name;
    colour = ch.defaultColour;
  } else if (spec.type !== 'speech') {
    const used = new Set(lanes.map((l) => l.title));
    let n = 1;
    while (used.has(n === 1 ? title : `${title} ${n}`)) n += 1;
    title = n === 1 ? title : `${title} ${n}`;
  }
  const [{ maxPosition }] = (await tx
    .select({ maxPosition: max(lane.position) })
    .from(lane)
    .where(eq(lane.segmentId, ctx.segmentId))) as [{ maxPosition: number | null }];
  const now = new Date();
  const id = newUlid();
  await tx.insert(lane).values({
    id,
    segmentId: ctx.segmentId,
    characterId: spec.type === 'speech' ? spec.characterId : null,
    position: (maxPosition ?? 0) + 1,
    title,
    colour,
    auto: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Deletes the automatic lanes of a segment that no cue uses any more, and closes the gaps in the order. */
export async function pruneLanes(tx: Tx, segmentId: string): Promise<void> {
  const lanes = await tx.select().from(lane).where(eq(lane.segmentId, segmentId)).orderBy(asc(lane.position));
  const used = await tx
    .selectDistinct({ laneId: cue.laneId })
    .from(cue)
    .where(inArray(cue.laneId, lanes.length ? lanes.map((l) => l.id) : ['']));
  const usedIds = new Set(used.map((u) => u.laneId));
  const doomed = lanes.filter((l) => l.auto && !usedIds.has(l.id));
  if (doomed.length === 0) return;
  await tx.delete(lane).where(inArray(lane.id, doomed.map((l) => l.id)));
  const keep = lanes.filter((l) => !doomed.includes(l));
  // Renumber 1..n in two passes so the unique index never sees a duplicate.
  for (const [i, l] of keep.entries()) {
    if (l.position !== i + 1) await tx.update(lane).set({ position: PARKED - 1 - i }).where(eq(lane.id, l.id));
  }
  for (const [i, l] of keep.entries()) {
    if (l.position !== i + 1) await tx.update(lane).set({ position: i + 1 }).where(eq(lane.id, l.id));
  }
}

// ---- ripple -----------------------------------------------------------------------

async function applyRipple(
  tx: Tx,
  sceneId: string,
  oldEndMs: number,
  delta: number,
  excludeIds: string[],
  dropIds: string[] = [],
): Promise<void> {
  const cues = (await sceneCues(tx, sceneId)).filter((c) => !dropIds.includes(c.id));
  const moved = ripple(cues as RippleCue[], oldEndMs, delta, excludeIds);
  for (const [id, startMs] of moved) await tx.update(cue).set({ startMs, updatedAt: new Date() }).where(eq(cue.id, id));
}

/** Pushes a start past any cue on the same lane that overlaps it (the lane rule wins). */
async function clearLaneConflicts(tx: Tx, c: { id: string; sceneId: string; laneId: string; startMs: number; lengthMs: number }): Promise<number> {
  let start = c.startMs;
  for (let i = 0; i < 1000; i++) {
    const others = await tx
      .select({ startMs: cue.startMs, lengthMs: cue.lengthMs })
      .from(cue)
      .where(and(eq(cue.sceneId, c.sceneId), eq(cue.laneId, c.laneId)));
    const clash = others.find((o) => o.startMs < start + c.lengthMs && start < o.startMs + o.lengthMs);
    if (!clash) return start;
    start = clash.startMs + clash.lengthMs;
  }
  return start;
}

function checkSpan(startMs: number, lengthMs: number): void {
  if (startMs + lengthMs > MAX_SCENE_MS) {
    throw new HttpError(400, 'scene_too_long', 'A scene holds at most 99 minutes.');
  }
}

// ---- cues -------------------------------------------------------------------------

export interface NewCue {
  afterCueId?: string | null;
  type?: CueType;
  characterId?: string | null;
  text?: string;
}

/** Inserts a cue after another one (or first in the scene), rippling the later cues by its length. */
export async function insertCue(tx: Tx, sceneId: string, input: NewCue, userId: string): Promise<CueRow> {
  void userId;
  const seg = await sceneRow(tx, sceneId);
  const ctx = await segmentContext(tx, seg.segmentId);
  const cues = await sceneCues(tx, sceneId);

  let after: CueRow | undefined;
  if (input.afterCueId) {
    after = cues.find((c) => c.id === input.afterCueId);
    if (!after) throw new HttpError(400, 'invalid_after_cue');
  }

  // Type and character: given, else those of the previous cue, else the Narrator.
  let previous: CueRow | undefined = after;
  if (!previous && input.type === undefined) {
    if (cues[0]) previous = cues[0];
    else {
      const earlier = await tx
        .select({ id: scene.id })
        .from(scene)
        .where(and(eq(scene.segmentId, seg.segmentId)))
        .orderBy(desc(scene.position));
      for (const s of earlier) {
        if (s.id === sceneId) continue;
        const sc = await sceneCues(tx, s.id);
        if (sc.length && (await sceneRow(tx, s.id)).position < seg.position) {
          previous = sc[sc.length - 1];
          break;
        }
      }
    }
  }
  const type: CueType = input.type ?? previous?.type ?? 'speech';
  let characterId: string | null;
  if (type !== 'speech') characterId = null;
  else if (input.characterId !== undefined) characterId = input.characterId;
  else if (previous) characterId = previous.type === 'speech' ? previous.characterId : null;
  else characterId = (await narratorOf(tx, ctx.projectId))?.id ?? null;
  if (characterId) await characterIn(tx, ctx.projectId, characterId);

  const text = input.text ?? '';
  const lengthMs = type === 'speech' ? estimateSpeechMs(text, ctx.language, ctx.speech) : MIN_CUE_MS;
  const desired = after ? after.startMs + after.lengthMs : 0;
  const laneId = await laneFor(tx, ctx, { type, characterId, sceneId, startMs: desired, lengthMs });
  const id = newUlid();
  const now = new Date();
  checkSpan(desired, lengthMs);
  await applyRipple(tx, sceneId, desired, lengthMs, []);
  const startMs = await clearLaneConflicts(tx, { id, sceneId, laneId, startMs: desired, lengthMs });
  await tx.insert(cue).values({
    id,
    sceneId,
    laneId,
    type,
    characterId,
    startMs,
    lengthMs,
    lengthAuto: true,
    textMd: text,
    createdAt: now,
    updatedAt: now,
  });
  return cueRow(tx, id);
}

export interface CuePatch {
  text?: string;
  type?: CueType;
  characterId?: string | null;
  lengthMs?: number;
  lengthAuto?: boolean; // true: re-estimate now (speech) and follow the text again
  muted?: boolean;
}

export async function updateCue(tx: Tx, cueId: string, patch: CuePatch): Promise<CueRow> {
  const current = await cueRow(tx, cueId);
  const seg = await sceneRow(tx, current.sceneId);
  const ctx = await segmentContext(tx, seg.segmentId);

  const type: CueType = patch.type ?? current.type;
  let characterId = patch.characterId !== undefined ? patch.characterId : current.characterId;
  if (type !== 'speech') characterId = null;
  else if (patch.type && patch.type !== current.type && patch.characterId === undefined) {
    characterId = (await narratorOf(tx, ctx.projectId))?.id ?? null; // a cue that becomes speech is the Narrator's until chosen
  }
  if (characterId) await characterIn(tx, ctx.projectId, characterId);
  const text = patch.text ?? current.textMd;

  let lengthMs = current.lengthMs;
  let lengthAuto = current.lengthAuto;
  if (patch.lengthMs !== undefined) {
    lengthMs = patch.lengthMs;
    lengthAuto = false;
  } else if (patch.lengthAuto === true) {
    lengthAuto = true;
    lengthMs = type === 'speech' ? estimateSpeechMs(text, ctx.language, ctx.speech) : MIN_CUE_MS;
  } else if (patch.lengthAuto === false) {
    lengthAuto = false;
  } else if (lengthAuto && type === 'speech' && (patch.text !== undefined || patch.type !== undefined)) {
    lengthMs = estimateSpeechMs(text, ctx.language, ctx.speech);
  } else if (lengthAuto && type !== 'speech' && patch.type !== undefined) {
    lengthMs = MIN_CUE_MS; // sfx and music follow their clip; with none they start at the minimum
  }

  checkSpan(current.startMs, lengthMs);
  let laneId = current.laneId;
  if (type !== current.type || characterId !== current.characterId) {
    laneId = await laneFor(tx, ctx, {
      type,
      characterId,
      sceneId: current.sceneId,
      startMs: current.startMs,
      lengthMs,
      excludeCueId: cueId,
    });
  }
  const delta = lengthMs - current.lengthMs;
  await tx
    .update(cue)
    .set({ type, characterId, laneId, lengthMs, lengthAuto, muted: patch.muted ?? current.muted, textMd: text, updatedAt: new Date() })
    .where(eq(cue.id, cueId));
  if (delta !== 0) await applyRipple(tx, current.sceneId, current.startMs + current.lengthMs, delta, [cueId]);
  if (laneId !== current.laneId) await pruneLanes(tx, seg.segmentId);
  return cueRow(tx, cueId);
}

export interface CuePlace {
  startMs?: number;
  lengthMs?: number;
  /** For a new length: `ripple` moves the later cues by the change, `trim` cuts the cue where the next one on its lane begins. */
  mode?: 'ripple' | 'trim';
  /** For a new start: cues of the lane that the moved cue runs into (to its right) are pushed ahead of it instead of refusing the move. */
  push?: boolean;
}

/**
 * The timeline's move and resize. A move changes the cue's start; it is refused when it would overlap a cue on the
 * same lane, except with `push`, where the cues of the lane to its right that are in the way are pushed ahead of it
 * (a chain of back-to-back cues moves right as one). A resize keeps the start: in ripple mode the later cues move by
 * the change (as with a length typed in the writing panel), in trim mode nothing else moves and the length stops where
 * the next cue of the lane begins; the chosen clip's piece of audio then follows the new length (see fitClipToCue).
 * A hand-set length turns length auto off.
 */
/**
 * Moves several cues of a scene by the same amount of time (a selection dragged on the timeline). Nothing is pushed: the cues
 * keep their places relative to each other, and the move is refused if one of them would run into a cue that stays.
 */
export async function shiftCues(tx: Tx, cueIds: string[], deltaMs: number): Promise<void> {
  const first = await cueRow(tx, cueIds[0]!);
  const all = await sceneCues(tx, first.sceneId);
  const ids = new Set(cueIds);
  const moving = all.filter((c) => ids.has(c.id));
  if (moving.length !== ids.size) throw new HttpError(400, 'invalid_cues', 'The cues are not all in the same scene.');
  for (const c of moving) {
    const start = c.startMs + deltaMs;
    if (start < 0) throw new HttpError(409, 'before_start', 'A cue would start before the scene.');
    checkSpan(start, c.lengthMs);
    for (const o of all) {
      if (ids.has(o.id) || o.laneId !== c.laneId) continue;
      if (o.startMs < start + c.lengthMs && start < o.startMs + o.lengthMs) throw new HttpError(409, 'lane_overlap', 'Another cue on this lane is in the way.');
    }
  }
  const now = new Date();
  for (const c of moving) await tx.update(cue).set({ startMs: c.startMs + deltaMs, updatedAt: now }).where(eq(cue.id, c.id));
}

export async function placeCue(tx: Tx, cueId: string, place: CuePlace): Promise<CueRow> {
  let current = await cueRow(tx, cueId);
  const siblings = (await sceneCues(tx, current.sceneId)).filter((c) => c.id !== cueId && c.laneId === current.laneId);

  if (place.startMs !== undefined && place.startMs !== current.startMs) {
    const startMs = Math.max(0, place.startMs);
    checkSpan(startMs, current.lengthMs);
    const endMs = startMs + current.lengthMs;
    // Cues of the lane that begin before this one's old start are never pushed: running into them is refused.
    if (siblings.some((o) => o.startMs < current.startMs && o.startMs + o.lengthMs > startMs)) {
      throw new HttpError(409, 'lane_overlap', 'Another cue on this lane is in the way.');
    }
    const ahead = siblings.filter((o) => o.startMs >= current.startMs).sort((a, b) => a.startMs - b.startMs);
    if (!place.push) {
      if (ahead.some((o) => o.startMs < endMs && startMs < o.startMs + o.lengthMs)) {
        throw new HttpError(409, 'lane_overlap', 'Another cue on this lane is in the way.');
      }
    } else {
      // A chain of cues (a narrator speaking paragraph after paragraph): each cue in the way is pushed to where the one before it ends.
      let edge = endMs;
      for (const o of ahead) {
        if (o.startMs >= edge) break; // a gap: the cues after this one are already clear
        checkSpan(edge, o.lengthMs);
        await tx.update(cue).set({ startMs: edge, updatedAt: new Date() }).where(eq(cue.id, o.id));
        edge += o.lengthMs;
      }
    }
    await tx.update(cue).set({ startMs, updatedAt: new Date() }).where(eq(cue.id, cueId));
    current = await cueRow(tx, cueId);
  }

  if (place.lengthMs !== undefined && place.lengthMs !== current.lengthMs) {
    let lengthMs = Math.max(100, place.lengthMs);
    if (place.mode === 'trim') {
      const next = siblings.filter((o) => o.startMs >= current.startMs + 1).sort((a, b) => a.startMs - b.startMs)[0];
      if (next) lengthMs = Math.min(lengthMs, Math.max(100, next.startMs - current.startMs));
    }
    checkSpan(current.startMs, lengthMs);
    const delta = lengthMs - current.lengthMs;
    await tx.update(cue).set({ lengthMs, lengthAuto: false, updatedAt: new Date() }).where(eq(cue.id, cueId));
    if (place.mode !== 'trim' && delta !== 0) await applyRipple(tx, current.sceneId, current.startMs + current.lengthMs, delta, [cueId]);
    await fitClipToCue(tx, current, lengthMs);
  }
  return cueRow(tx, cueId);
}

/**
 * After the timeline stretches or shrinks a cue, the chosen clip's piece of audio follows the cue's new length:
 * it keeps its start in the file and ends where the cue ends, or where the file ends if that comes first (the cue
 * is then silent after the audio). A clip that loops keeps its piece, because the author shaped it to repeat.
 */
async function fitClipToCue(tx: Tx, current: CueRow, cueLengthMs: number): Promise<void> {
  if (!current.clipId) return;
  const row = (await tx.select().from(clip).where(eq(clip.id, current.clipId)).limit(1))[0];
  if (!row || row.loops !== 0) return;
  const { projectId } = await cueProject(tx, current.id);
  let duration: number;
  try { duration = await audioDuration(tx, projectId, row.assetId); } catch { return; } // audio not ready: leave the clip alone
  const lengthMs = Math.min(cueLengthMs, duration - row.offsetMs);
  if (lengthMs < MIN_CLIP_MS || lengthMs === row.lengthMs) return;
  // A shorter piece squeezes its fades (as when the piece is trimmed by hand).
  const fadeInMs = Math.min(row.fadeInMs, Math.floor(lengthMs / 2));
  const fadeOutMs = Math.min(row.fadeOutMs, lengthMs - fadeInMs);
  await tx.update(clip).set({ lengthMs, fadeInMs, fadeOutMs }).where(eq(clip.id, row.id));
}

export async function deleteCue(tx: Tx, cueId: string): Promise<void> {
  const current = await cueRow(tx, cueId);
  const seg = await sceneRow(tx, current.sceneId);
  await tx.delete(cue).where(eq(cue.id, cueId));
  await applyRipple(tx, current.sceneId, current.startMs + current.lengthMs, -current.lengthMs, []);
  await pruneLanes(tx, seg.segmentId);
}

/** Moves a cue (drag and drop): placed after another cue of any scene of the same segment, or first in a scene. */
export async function moveCue(tx: Tx, cueId: string, targetSceneId: string, afterCueId: string | null): Promise<CueRow> {
  const current = await cueRow(tx, cueId);
  const fromSeg = await sceneRow(tx, current.sceneId);
  const toSeg = await sceneRow(tx, targetSceneId);
  if (fromSeg.segmentId !== toSeg.segmentId) throw new HttpError(400, 'different_segment');
  if (afterCueId === cueId) throw new HttpError(400, 'invalid_after_cue');

  // Take the cue out: the later cues close the gap.
  await applyRipple(tx, current.sceneId, current.startMs + current.lengthMs, -current.lengthMs, [], [cueId]);
  // Park it so it does not take part while the target is arranged.
  const cues = (await sceneCues(tx, targetSceneId)).filter((c) => c.id !== cueId);
  let desired = 0;
  if (afterCueId) {
    const after = cues.find((c) => c.id === afterCueId);
    if (!after) throw new HttpError(400, 'invalid_after_cue');
    desired = after.startMs + after.lengthMs;
  }
  checkSpan(desired, current.lengthMs);
  await tx.update(cue).set({ sceneId: targetSceneId, startMs: MAX_SCENE_MS * 2 }).where(eq(cue.id, cueId));
  await applyRipple(tx, targetSceneId, desired, current.lengthMs, [cueId]);
  const startMs = await clearLaneConflicts(tx, {
    id: cueId,
    sceneId: targetSceneId,
    laneId: current.laneId,
    startMs: desired,
    lengthMs: current.lengthMs,
  });
  await tx.update(cue).set({ startMs, updatedAt: new Date() }).where(eq(cue.id, cueId));
  return cueRow(tx, cueId);
}

// ---- scenes ---------------------------------------------------------------------

export async function newScene(tx: Tx, segmentId: string, atPosition?: number, label: string | null = null): Promise<string> {
  const existing = await tx.select({ id: scene.id }).from(scene).where(eq(scene.segmentId, segmentId));
  if (existing.length >= MAX_SCENES) throw new HttpError(400, 'too_many_scenes', 'A segment holds at most 99 scenes.');
  const position = atPosition ?? existing.length + 1;
  await openGap(tx, 'scene', segmentId, position);
  const id = newUlid();
  const now = new Date();
  // A new scene is titled "Scene " + its number; the author can change or clear the title.
  await tx.insert(scene).values({ id, segmentId, position, label: label ?? `Scene ${position}`, createdAt: now, updatedAt: now });
  return id;
}

/** Splits a scene before a cue: that cue and the ones after it move to a new scene right after. */
export async function splitScene(tx: Tx, sceneId: string, beforeCueId: string): Promise<string> {
  const seg = await sceneRow(tx, sceneId);
  const cues = await sceneCues(tx, sceneId);
  const index = cues.findIndex((c) => c.id === beforeCueId);
  if (index < 0) throw new HttpError(400, 'invalid_cue');
  const moving = cues.slice(index);
  const base = moving[0]!.startMs;
  const id = await newScene(tx, seg.segmentId, seg.position + 1);
  for (const c of moving) {
    await tx.update(cue).set({ sceneId: id, startMs: c.startMs - base, updatedAt: new Date() }).where(eq(cue.id, c.id));
  }
  return id;
}

export async function sceneLength(tx: Tx, sceneId: string): Promise<number> {
  const cues = await sceneCues(tx, sceneId);
  return cues.reduce((m, c) => Math.max(m, c.startMs + c.lengthMs), 0);
}

/** Merges a scene into the one before it; its cues keep their order after the previous scene's cues. */
export async function mergeWithPrevious(tx: Tx, sceneId: string): Promise<void> {
  const seg = await sceneRow(tx, sceneId);
  if (seg.position <= 1) throw new HttpError(400, 'no_previous_scene');
  const prev = (
    await tx
      .select()
      .from(scene)
      .where(and(eq(scene.segmentId, seg.segmentId), eq(scene.position, seg.position - 1)))
      .limit(1)
  )[0];
  if (!prev) throw new HttpError(400, 'no_previous_scene');
  const offset = await sceneLength(tx, prev.id);
  const cues = await sceneCues(tx, sceneId);
  if (cues.length) checkSpan(offset, (await sceneLength(tx, sceneId)));
  for (const c of cues) {
    await tx.update(cue).set({ sceneId: prev.id, startMs: c.startMs + offset, updatedAt: new Date() }).where(eq(cue.id, c.id));
  }
  await tx.delete(scene).where(eq(scene.id, sceneId));
  await closeGap(tx, 'scene', seg.segmentId, seg.position);
}

export async function deleteScene(tx: Tx, sceneId: string): Promise<void> {
  const seg = await sceneRow(tx, sceneId);
  const count = await tx.select({ id: scene.id }).from(scene).where(eq(scene.segmentId, seg.segmentId));
  if (count.length <= 1) throw new HttpError(400, 'last_scene', 'A segment needs at least one scene.');
  await tx.delete(scene).where(eq(scene.id, sceneId));
  await closeGap(tx, 'scene', seg.segmentId, seg.position);
  await pruneLanes(tx, seg.segmentId);
}

/** A new segment always has one scene. */
export async function createSegment(tx: Tx, chapterId: string, title: string, position: number): Promise<string> {
  await openGap(tx, 'segment', chapterId, position);
  const id = newUlid();
  const now = new Date();
  await tx.insert(segment).values({ id, chapterId, position, title, createdAt: now, updatedAt: now });
  await newScene(tx, id);
  return id;
}

// ---- clips: audio pieces assigned to a cue (Bible, section 5, Cue length and clip playback) ----------

export const DEFAULT_FADE_MS = 100;
export const MIN_CLIP_MS = 100;
const CLIP_ORIGINS = ['human-recorded', 'generated', 'voice-converted'] as const;
export type ClipOrigin = (typeof CLIP_ORIGINS)[number];

export interface ClipView {
  id: string;
  cueId: string;
  number: number;
  assetId: string;
  name: string;
  offsetMs: number;
  lengthMs: number;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  loops: number;
  speed: number;
  pitchCents: number;
  volumePoints: VolumePoint[] | null;
  speedPoints: VolumePoint[] | null;
  pitchPoints: VolumePoint[] | null;
  origin: ClipOrigin;
  assetDurationMs: number | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  hasPeaks: boolean;
  /** The MP3 playback copy exists (the player asks for it); otherwise the file itself plays. */
  light: boolean;
  /** The audio file behind the clip is missing on the server (the library flags it); the script shows the cue's audio icon in red. */
  fileMissing: boolean;
}

/** The clips of some cues, with what the timeline needs of their audio (never the peaks themselves). */
export async function clipsOfCues(q: Q, cueIds: string[]): Promise<Map<string, ClipView[]>> {
  const out = new Map<string, ClipView[]>();
  if (cueIds.length === 0) return out;
  const rows = await q
    .select({
      id: clip.id,
      cueId: clip.cueId,
      number: clip.number,
      assetId: clip.assetId,
      path: asset.path,
      mediaInfo: asset.mediaInfo,
      lightweightPath: asset.lightweightPath,
      sizeLightweight: asset.sizeLightweight,
      status: asset.status,
      fileState: asset.fileState,
      offsetMs: clip.offsetMs,
      lengthMs: clip.lengthMs,
      gainDb: clip.gainDb,
      fadeInMs: clip.fadeInMs,
      fadeOutMs: clip.fadeOutMs,
      loops: clip.loops,
      speed: clip.speed,
      pitchCents: clip.pitchCents,
      volumePoints: clip.volumePoints,
      speedPoints: clip.speedPoints,
      pitchPoints: clip.pitchPoints,
      origin: clip.origin,
      peaks: assetPeaks.assetId,
    })
    .from(clip)
    .innerJoin(asset, eq(asset.id, clip.assetId))
    .leftJoin(assetPeaks, eq(assetPeaks.assetId, clip.assetId))
    .where(inArray(clip.cueId, cueIds))
    .orderBy(asc(clip.cueId), asc(clip.number));
  for (const r of rows) {
    const dur = (r.mediaInfo as { durationMs?: unknown } | null)?.durationMs;
    const view: ClipView = {
      id: r.id,
      cueId: r.cueId,
      number: r.number,
      assetId: r.assetId,
      name: basename(r.path),
      offsetMs: r.offsetMs,
      lengthMs: r.lengthMs,
      gainDb: Number(r.gainDb),
      fadeInMs: r.fadeInMs,
      fadeOutMs: r.fadeOutMs,
      loops: r.loops,
      speed: Number(r.speed),
      pitchCents: r.pitchCents,
      volumePoints: pointsOf(r.volumePoints),
      speedPoints: pointsOf(r.speedPoints),
      pitchPoints: pointsOf(r.pitchPoints),
      origin: r.origin,
      assetDurationMs: typeof dur === 'number' ? dur : null,
      status: r.status,
      hasPeaks: r.peaks !== null,
      light: r.lightweightPath !== null && r.sizeLightweight !== null,
      fileMissing: r.fileState === 'missing',
    };
    (out.get(r.cueId) ?? out.set(r.cueId, []).get(r.cueId)!).push(view);
  }
  return out;
}

async function audioDuration(tx: Tx, projectId: string, assetId: string): Promise<number> {
  const row = (await tx.select().from(asset).where(and(eq(asset.id, assetId), eq(asset.projectId, projectId))).limit(1))[0];
  if (!row) throw new HttpError(400, 'invalid_asset');
  if (row.mediaKind !== 'audio') throw new HttpError(400, 'not_audio', 'That file is not audio.');
  if (row.status === 'failed') throw new HttpError(409, 'asset_failed', 'That audio file could not be processed.');
  const dur = (row.mediaInfo as { durationMs?: unknown } | null)?.durationMs;
  if (typeof dur !== 'number' || dur <= 0) throw new HttpError(409, 'asset_not_ready');
  return dur;
}

/** The stored envelope as a list (some drivers hand a JSON column back as text); null when there is none or it is unusable. */
function pointsOf(v: unknown): VolumePoint[] | null {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return null; } }
  return Array.isArray(x) && x.length > 0 ? (x as VolumePoint[]) : null;
}

function checkPiece(offsetMs: number, lengthMs: number, durationMs: number, speed = 1, speedPoints: VolumePoint[] | null = null): void {
  if (lengthMs < MIN_CLIP_MS) throw badRequest('invalid_lengthMs');
  // lengthMs is the playing time; at another speed the piece of the file is longer or shorter (2 ms of slack for the rounding)
  const used = speedPoints ? Math.round(sourceAt(speed, speedPoints, lengthMs)) : Math.round(lengthMs * speed); // a speed envelope changes how much of the file is read
  if (speed === 1 && !speedPoints ? offsetMs + lengthMs > durationMs : offsetMs + used > durationMs + 2) throw new HttpError(400, 'beyond_audio', 'The piece goes past the end of the audio file.');
  checkSpan(0, lengthMs);
}

/** A chosen clip sets the cue's length (audio cues are trim-only); speech stops following the text estimate. */
async function followClip(tx: Tx, current: CueRow, clipLengthMs: number): Promise<void> {
  checkSpan(current.startMs, clipLengthMs);
  const delta = clipLengthMs - current.lengthMs;
  await tx
    .update(cue)
    .set({ lengthMs: clipLengthMs, lengthAuto: current.type === 'speech' ? false : current.lengthAuto, updatedAt: new Date() })
    .where(eq(cue.id, current.id));
  if (delta !== 0) await applyRipple(tx, current.sceneId, current.startMs + current.lengthMs, delta, [current.id]);
}

async function cueProject(tx: Tx, cueId: string): Promise<{ current: CueRow; projectId: string }> {
  const current = await cueRow(tx, cueId);
  const seg = await sceneRow(tx, current.sceneId);
  const ctx = await segmentContext(tx, seg.segmentId);
  return { current, projectId: ctx.projectId };
}

export interface NewClip {
  assetId: string;
  offsetMs?: number;
  lengthMs?: number;
  /** The piece defaults to the cue's length (when the file allows) instead of the rest of the file. */
  keepCueLength?: boolean;
  choose?: boolean;
  origin?: ClipOrigin;
}

export async function addClip(tx: Tx, cueId: string, input: NewClip): Promise<string> {
  const { current, projectId } = await cueProject(tx, cueId);
  const duration = await audioDuration(tx, projectId, input.assetId);
  const offsetMs = input.offsetMs ?? 0;
  if (offsetMs >= duration) throw new HttpError(400, 'beyond_audio', 'The piece starts past the end of the audio file.');
  const keep = input.keepCueLength ?? !current.lengthAuto;
  const available = duration - offsetMs;
  const lengthMs = input.lengthMs ?? (keep ? Math.min(current.lengthMs, available) : available);
  checkPiece(offsetMs, lengthMs, duration);
  const fade = Math.min(DEFAULT_FADE_MS, Math.floor(lengthMs / 2));
  const last = (await tx.select({ n: max(clip.number) }).from(clip).where(eq(clip.cueId, cueId)))[0]?.n ?? 0;
  const id = newUlid();
  await tx.insert(clip).values({
    id,
    cueId,
    assetId: input.assetId,
    number: Number(last) + 1,
    offsetMs,
    lengthMs,
    fadeInMs: fade,
    fadeOutMs: fade,
    origin: input.origin ?? 'human-recorded',
    createdAt: new Date(),
  });
  if (input.choose ?? true) {
    await tx.update(cue).set({ clipId: id, updatedAt: new Date() }).where(eq(cue.id, cueId));
    await followClip(tx, current, lengthMs);
  }
  return id;
}

export interface ClipPatch {
  offsetMs?: number;
  lengthMs?: number;
  gainDb?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  loops?: number;
  speed?: number; // keeps the piece of the file and changes the playing time (and with it the cue's length, like a trim)
  pitchCents?: number;
  volumePoints?: VolumePoint[] | null;
  speedPoints?: VolumePoint[] | null; // relative to the speed: a factor
  pitchPoints?: VolumePoint[] | null; // relative to the pitch: cents
}

/** The column update for one envelope: the new list if one was sent, otherwise the stored one with its times scaled when the speed changed. */
function envelopeUpdate<K extends 'volumePoints' | 'speedPoints' | 'pitchPoints'>(key: K, sent: VolumePoint[] | null | undefined, stored: unknown, oldSpeed: unknown, newSpeed: number | undefined): Partial<Record<K, VolumePoint[] | null>> {
  if (sent !== undefined) return { [key]: sent } as Partial<Record<K, VolumePoint[] | null>>;
  const list = pointsOf(stored);
  if (newSpeed === undefined || !list) return {};
  return { [key]: list.map(([ms, v]): VolumePoint => [Math.round((ms * Number(oldSpeed)) / newSpeed), v]) } as Partial<Record<K, VolumePoint[] | null>>;
}

export async function updateClip(tx: Tx, clipId: string, patch: ClipPatch): Promise<void> {
  const row = (await tx.select().from(clip).where(eq(clip.id, clipId)).limit(1))[0];
  if (!row) throw notFound();
  const { current, projectId } = await cueProject(tx, row.cueId);
  const duration = await audioDuration(tx, projectId, row.assetId);
  const offsetMs = patch.offsetMs ?? row.offsetMs;
  const speed = patch.speed ?? Number(row.speed);
  let lengthMs = patch.lengthMs ?? row.lengthMs;
  if (patch.speed !== undefined && patch.lengthMs === undefined) lengthMs = Math.max(MIN_CLIP_MS, Math.round((row.lengthMs * Number(row.speed)) / speed));
  const speedPoints = patch.speedPoints !== undefined ? patch.speedPoints : pointsOf(row.speedPoints);
  checkPiece(offsetMs, lengthMs, duration, speed, speedPoints);
  let fadeInMs = patch.fadeInMs ?? row.fadeInMs;
  let fadeOutMs = patch.fadeOutMs ?? row.fadeOutMs;
  if (patch.fadeInMs !== undefined || patch.fadeOutMs !== undefined) {
    if (fadeInMs + fadeOutMs > lengthMs) throw new HttpError(400, 'fades_too_long', 'The fades are longer than the piece.');
  } else if (fadeInMs + fadeOutMs > lengthMs) {
    // A shorter piece squeezes its fades instead of refusing the trim.
    fadeInMs = Math.min(fadeInMs, Math.floor(lengthMs / 2));
    fadeOutMs = Math.min(fadeOutMs, lengthMs - fadeInMs);
  }
  await tx
    .update(clip)
    .set({
      offsetMs,
      lengthMs,
      fadeInMs,
      fadeOutMs,
      ...(patch.gainDb !== undefined ? { gainDb: patch.gainDb.toFixed(2) } : {}),
      ...(patch.loops !== undefined ? { loops: patch.loops } : {}),
      ...(patch.speed !== undefined ? { speed: patch.speed.toFixed(2) } : {}),
      ...(patch.pitchCents !== undefined ? { pitchCents: patch.pitchCents } : {}),
      // A new speed moves the envelopes with the sound: their times are playing times, so they scale with the length.
      ...envelopeUpdate('volumePoints', patch.volumePoints, row.volumePoints, row.speed, patch.speed),
      ...envelopeUpdate('speedPoints', patch.speedPoints, row.speedPoints, row.speed, patch.speed),
      ...envelopeUpdate('pitchPoints', patch.pitchPoints, row.pitchPoints, row.speed, patch.speed),
    })
    .where(eq(clip.id, clipId));
  if (current.clipId === clipId && lengthMs !== current.lengthMs) await followClip(tx, current, lengthMs);
}

/** Chooses the clip a cue plays (null: none; the cue keeps its length). */
export async function chooseClip(tx: Tx, cueId: string, clipId: string | null): Promise<void> {
  const current = await cueRow(tx, cueId);
  if (clipId === null) {
    await tx.update(cue).set({ clipId: null, updatedAt: new Date() }).where(eq(cue.id, cueId));
    return;
  }
  const row = (await tx.select().from(clip).where(and(eq(clip.id, clipId), eq(clip.cueId, cueId))).limit(1))[0];
  if (!row) throw new HttpError(400, 'invalid_clip');
  await tx.update(cue).set({ clipId, updatedAt: new Date() }).where(eq(cue.id, cueId));
  await followClip(tx, current, row.lengthMs);
}

/** Removes a take. The audio file stays in the library. */
export async function removeClip(tx: Tx, clipId: string): Promise<void> {
  const row = (await tx.select({ id: clip.id }).from(clip).where(eq(clip.id, clipId)).limit(1))[0];
  if (!row) throw notFound();
  await tx.delete(clip).where(eq(clip.id, clipId)); // the cue's chosen clip becomes null (ON DELETE SET NULL)
}

export const CLIP_ORIGIN_LIST: readonly string[] = CLIP_ORIGINS;

/**
 * Teaches the project's speech-length estimate from a recorded take: the take's length and the speaking units of the
 * cue's text are added to the project's totals, so later estimates follow how this project is actually spoken.
 * The whole take counts, pauses included, since pauses are part of natural speech. Only speech cues with text teach;
 * a take far from the current rate (a take left running, a test click) is ignored.
 */
export async function learnSpeechRate(tx: Tx, cueId: string, clipId: string): Promise<void> {
  const { current, projectId } = await cueProject(tx, cueId);
  if (current.type !== 'speech') return;
  const take = (await tx.select({ lengthMs: clip.lengthMs }).from(clip).where(eq(clip.id, clipId)).limit(1))[0];
  const proj = (await tx.select({ language: project.language, units: project.speechUnits, ms: project.speechMs }).from(project).where(eq(project.id, projectId)).limit(1))[0];
  if (!take || !proj) return;
  const units = speechUnits(current.textMd, proj.language);
  if (units <= 0) return;
  const rate = take.lengthMs / units;
  const now = msPerUnit(proj.language, { units: proj.units, ms: proj.ms });
  if (rate < now * 0.4 || rate > now * 2.5) return;
  await tx
    .update(project)
    .set({ speechUnits: sql`${project.speechUnits} + ${units}`, speechMs: sql`${project.speechMs} + ${take.lengthMs}` })
    .where(eq(project.id, projectId));
}
