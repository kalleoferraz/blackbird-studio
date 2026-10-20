/**
 * The content of a scene: segments, cues and the lanes created for them (Bible, section 5: Cue types and
 * lanes, Lane rules, Cue length and clip playback). All functions run inside the caller's transaction.
 */
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { closeGap, openGap, PARKED } from '../db/positions.js';
import { chapter, character, cue, lane, project, scene, segment } from '../db/schema.js';
import { MIN_CUE_MS, estimateSpeechMs } from '../shared/estimate.js';
import { ripple, type RippleCue } from '../shared/ripple.js';
import { HttpError, notFound } from './http.js';

export type CueType = 'speech' | 'sfx' | 'music';
export const MAX_SEGMENT_MS = 99 * 60 * 1000; // 99 minutes within a segment (Bible, section 5, Limits)
export const MAX_SEGMENTS = 99;

export interface CueRow {
  id: string;
  segmentId: string;
  laneId: string;
  type: CueType;
  characterId: string | null;
  startMs: number;
  lengthMs: number;
  lengthAuto: boolean;
  textMd: string;
  clipId: string | null;
}

const cueColumns = {
  id: cue.id,
  segmentId: cue.segmentId,
  laneId: cue.laneId,
  type: cue.type,
  characterId: cue.characterId,
  startMs: cue.startMs,
  lengthMs: cue.lengthMs,
  lengthAuto: cue.lengthAuto,
  textMd: cue.textMd,
  clipId: cue.clipId,
};

// ---- loading ----------------------------------------------------------------------

export async function sceneContext(tx: Tx, sceneId: string): Promise<{ projectId: string; language: string; sceneId: string }> {
  const rows = await tx
    .select({ projectId: project.id, language: project.language })
    .from(scene)
    .innerJoin(chapter, eq(chapter.id, scene.chapterId))
    .innerJoin(project, eq(project.id, chapter.projectId))
    .where(eq(scene.id, sceneId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound();
  return { ...row, sceneId };
}

export async function segmentRow(tx: Tx, segmentId: string) {
  const rows = await tx.select().from(segment).where(eq(segment.id, segmentId)).limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

export async function cueRow(tx: Tx, cueId: string): Promise<CueRow> {
  const rows = await tx.select(cueColumns).from(cue).where(eq(cue.id, cueId)).limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

/** The cues of a segment in script order: start time, then lane order. */
export async function segmentCues(tx: Tx, segmentId: string): Promise<CueRow[]> {
  return tx
    .select(cueColumns)
    .from(cue)
    .innerJoin(lane, eq(lane.id, cue.laneId))
    .where(eq(cue.segmentId, segmentId))
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

/** The lane a cue belongs on, created when the scene has none that fits (Cue types and lanes). */
export async function laneFor(
  tx: Tx,
  ctx: { projectId: string; sceneId: string },
  spec: { type: CueType; characterId: string | null; segmentId: string; startMs: number; lengthMs: number; excludeCueId?: string },
): Promise<string> {
  const lanes = await tx.select().from(lane).where(eq(lane.sceneId, ctx.sceneId)).orderBy(asc(lane.position));
  const typeRows = await tx
    .select({ laneId: cue.laneId, type: cue.type })
    .from(cue)
    .innerJoin(segment, eq(segment.id, cue.segmentId))
    .where(and(eq(segment.sceneId, ctx.sceneId)))
    .groupBy(cue.laneId, cue.type);
  const typesOf = new Map<string, Set<string>>();
  for (const r of typeRows) {
    if (!typesOf.has(r.laneId)) typesOf.set(r.laneId, new Set());
    typesOf.get(r.laneId)!.add(r.type);
  }
  const sameSegment = await tx.select(cueColumns).from(cue).where(eq(cue.segmentId, spec.segmentId));
  const busy = (laneId: string) =>
    sameSegment.some(
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
    .where(eq(lane.sceneId, ctx.sceneId))) as [{ maxPosition: number | null }];
  const now = new Date();
  const id = newUlid();
  await tx.insert(lane).values({
    id,
    sceneId: ctx.sceneId,
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

/** Deletes the automatic lanes of a scene that no cue uses any more, and closes the gaps in the order. */
export async function pruneLanes(tx: Tx, sceneId: string): Promise<void> {
  const lanes = await tx.select().from(lane).where(eq(lane.sceneId, sceneId)).orderBy(asc(lane.position));
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
  segmentId: string,
  oldEndMs: number,
  delta: number,
  excludeIds: string[],
  dropIds: string[] = [],
): Promise<void> {
  const cues = (await segmentCues(tx, segmentId)).filter((c) => !dropIds.includes(c.id));
  const moved = ripple(cues as RippleCue[], oldEndMs, delta, excludeIds);
  for (const [id, startMs] of moved) await tx.update(cue).set({ startMs, updatedAt: new Date() }).where(eq(cue.id, id));
}

/** Pushes a start past any cue on the same lane that overlaps it (the lane rule wins). */
async function clearLaneConflicts(tx: Tx, c: { id: string; segmentId: string; laneId: string; startMs: number; lengthMs: number }): Promise<number> {
  let start = c.startMs;
  for (let i = 0; i < 1000; i++) {
    const others = await tx
      .select({ startMs: cue.startMs, lengthMs: cue.lengthMs })
      .from(cue)
      .where(and(eq(cue.segmentId, c.segmentId), eq(cue.laneId, c.laneId)));
    const clash = others.find((o) => o.startMs < start + c.lengthMs && start < o.startMs + o.lengthMs);
    if (!clash) return start;
    start = clash.startMs + clash.lengthMs;
  }
  return start;
}

function checkSpan(startMs: number, lengthMs: number): void {
  if (startMs + lengthMs > MAX_SEGMENT_MS) {
    throw new HttpError(400, 'segment_too_long', 'A segment holds at most 99 minutes.');
  }
}

// ---- cues -------------------------------------------------------------------------

export interface NewCue {
  afterCueId?: string | null;
  type?: CueType;
  characterId?: string | null;
  text?: string;
}

/** Inserts a cue after another one (or first in the segment), rippling the later cues by its length. */
export async function insertCue(tx: Tx, segmentId: string, input: NewCue, userId: string): Promise<CueRow> {
  void userId;
  const seg = await segmentRow(tx, segmentId);
  const ctx = await sceneContext(tx, seg.sceneId);
  const cues = await segmentCues(tx, segmentId);

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
        .select({ id: segment.id })
        .from(segment)
        .where(and(eq(segment.sceneId, seg.sceneId)))
        .orderBy(desc(segment.position));
      for (const s of earlier) {
        if (s.id === segmentId) continue;
        const sc = await segmentCues(tx, s.id);
        if (sc.length && (await segmentRow(tx, s.id)).position < seg.position) {
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
  const lengthMs = type === 'speech' ? estimateSpeechMs(text, ctx.language) : MIN_CUE_MS;
  const desired = after ? after.startMs + after.lengthMs : 0;
  const laneId = await laneFor(tx, ctx, { type, characterId, segmentId, startMs: desired, lengthMs });
  const id = newUlid();
  const now = new Date();
  checkSpan(desired, lengthMs);
  await applyRipple(tx, segmentId, desired, lengthMs, []);
  const startMs = await clearLaneConflicts(tx, { id, segmentId, laneId, startMs: desired, lengthMs });
  await tx.insert(cue).values({
    id,
    segmentId,
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
}

export async function updateCue(tx: Tx, cueId: string, patch: CuePatch): Promise<CueRow> {
  const current = await cueRow(tx, cueId);
  const seg = await segmentRow(tx, current.segmentId);
  const ctx = await sceneContext(tx, seg.sceneId);

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
    lengthMs = type === 'speech' ? estimateSpeechMs(text, ctx.language) : MIN_CUE_MS;
  } else if (patch.lengthAuto === false) {
    lengthAuto = false;
  } else if (lengthAuto && type === 'speech' && (patch.text !== undefined || patch.type !== undefined)) {
    lengthMs = estimateSpeechMs(text, ctx.language);
  } else if (lengthAuto && type !== 'speech' && patch.type !== undefined) {
    lengthMs = MIN_CUE_MS; // sfx and music follow their clip; with none they start at the minimum
  }

  checkSpan(current.startMs, lengthMs);
  let laneId = current.laneId;
  if (type !== current.type || characterId !== current.characterId) {
    laneId = await laneFor(tx, ctx, {
      type,
      characterId,
      segmentId: current.segmentId,
      startMs: current.startMs,
      lengthMs,
      excludeCueId: cueId,
    });
  }
  const delta = lengthMs - current.lengthMs;
  await tx
    .update(cue)
    .set({ type, characterId, laneId, lengthMs, lengthAuto, textMd: text, updatedAt: new Date() })
    .where(eq(cue.id, cueId));
  if (delta !== 0) await applyRipple(tx, current.segmentId, current.startMs + current.lengthMs, delta, [cueId]);
  if (laneId !== current.laneId) await pruneLanes(tx, seg.sceneId);
  return cueRow(tx, cueId);
}

export async function deleteCue(tx: Tx, cueId: string): Promise<void> {
  const current = await cueRow(tx, cueId);
  const seg = await segmentRow(tx, current.segmentId);
  await tx.delete(cue).where(eq(cue.id, cueId));
  await applyRipple(tx, current.segmentId, current.startMs + current.lengthMs, -current.lengthMs, []);
  await pruneLanes(tx, seg.sceneId);
}

/** Moves a cue (drag and drop): placed after another cue of any segment of the same scene, or first in a segment. */
export async function moveCue(tx: Tx, cueId: string, targetSegmentId: string, afterCueId: string | null): Promise<CueRow> {
  const current = await cueRow(tx, cueId);
  const fromSeg = await segmentRow(tx, current.segmentId);
  const toSeg = await segmentRow(tx, targetSegmentId);
  if (fromSeg.sceneId !== toSeg.sceneId) throw new HttpError(400, 'different_scene');
  if (afterCueId === cueId) throw new HttpError(400, 'invalid_after_cue');

  // Take the cue out: the later cues close the gap.
  await applyRipple(tx, current.segmentId, current.startMs + current.lengthMs, -current.lengthMs, [], [cueId]);
  // Park it so it does not take part while the target is arranged.
  const cues = (await segmentCues(tx, targetSegmentId)).filter((c) => c.id !== cueId);
  let desired = 0;
  if (afterCueId) {
    const after = cues.find((c) => c.id === afterCueId);
    if (!after) throw new HttpError(400, 'invalid_after_cue');
    desired = after.startMs + after.lengthMs;
  }
  checkSpan(desired, current.lengthMs);
  await tx.update(cue).set({ segmentId: targetSegmentId, startMs: MAX_SEGMENT_MS * 2 }).where(eq(cue.id, cueId));
  await applyRipple(tx, targetSegmentId, desired, current.lengthMs, [cueId]);
  const startMs = await clearLaneConflicts(tx, {
    id: cueId,
    segmentId: targetSegmentId,
    laneId: current.laneId,
    startMs: desired,
    lengthMs: current.lengthMs,
  });
  await tx.update(cue).set({ startMs, updatedAt: new Date() }).where(eq(cue.id, cueId));
  return cueRow(tx, cueId);
}

// ---- segments ---------------------------------------------------------------------

export async function newSegment(tx: Tx, sceneId: string, atPosition?: number, label: string | null = null): Promise<string> {
  const existing = await tx.select({ id: segment.id }).from(segment).where(eq(segment.sceneId, sceneId));
  if (existing.length >= MAX_SEGMENTS) throw new HttpError(400, 'too_many_segments', 'A scene holds at most 99 segments.');
  const position = atPosition ?? existing.length + 1;
  await openGap(tx, 'segment', sceneId, position);
  const id = newUlid();
  const now = new Date();
  await tx.insert(segment).values({ id, sceneId, position, label, createdAt: now, updatedAt: now });
  return id;
}

/** Splits a segment before a cue: that cue and the ones after it move to a new segment right after. */
export async function splitSegment(tx: Tx, segmentId: string, beforeCueId: string): Promise<string> {
  const seg = await segmentRow(tx, segmentId);
  const cues = await segmentCues(tx, segmentId);
  const index = cues.findIndex((c) => c.id === beforeCueId);
  if (index < 0) throw new HttpError(400, 'invalid_cue');
  const moving = cues.slice(index);
  const base = moving[0]!.startMs;
  const id = await newSegment(tx, seg.sceneId, seg.position + 1);
  for (const c of moving) {
    await tx.update(cue).set({ segmentId: id, startMs: c.startMs - base, updatedAt: new Date() }).where(eq(cue.id, c.id));
  }
  return id;
}

export async function segmentLength(tx: Tx, segmentId: string): Promise<number> {
  const cues = await segmentCues(tx, segmentId);
  return cues.reduce((m, c) => Math.max(m, c.startMs + c.lengthMs), 0);
}

/** Merges a segment into the one before it; its cues keep their order after the previous segment's cues. */
export async function mergeWithPrevious(tx: Tx, segmentId: string): Promise<void> {
  const seg = await segmentRow(tx, segmentId);
  if (seg.position <= 1) throw new HttpError(400, 'no_previous_segment');
  const prev = (
    await tx
      .select()
      .from(segment)
      .where(and(eq(segment.sceneId, seg.sceneId), eq(segment.position, seg.position - 1)))
      .limit(1)
  )[0];
  if (!prev) throw new HttpError(400, 'no_previous_segment');
  const offset = await segmentLength(tx, prev.id);
  const cues = await segmentCues(tx, segmentId);
  if (cues.length) checkSpan(offset, (await segmentLength(tx, segmentId)));
  for (const c of cues) {
    await tx.update(cue).set({ segmentId: prev.id, startMs: c.startMs + offset, updatedAt: new Date() }).where(eq(cue.id, c.id));
  }
  await tx.delete(segment).where(eq(segment.id, segmentId));
  await closeGap(tx, 'segment', seg.sceneId, seg.position);
}

export async function deleteSegment(tx: Tx, segmentId: string): Promise<void> {
  const seg = await segmentRow(tx, segmentId);
  const count = await tx.select({ id: segment.id }).from(segment).where(eq(segment.sceneId, seg.sceneId));
  if (count.length <= 1) throw new HttpError(400, 'last_segment', 'A scene needs at least one segment.');
  await tx.delete(segment).where(eq(segment.id, segmentId));
  await closeGap(tx, 'segment', seg.sceneId, seg.position);
  await pruneLanes(tx, seg.sceneId);
}

/** A new scene always has one segment. */
export async function createScene(tx: Tx, chapterId: string, title: string, position: number): Promise<string> {
  await openGap(tx, 'scene', chapterId, position);
  const id = newUlid();
  const now = new Date();
  await tx.insert(scene).values({ id, chapterId, position, title, createdAt: now, updatedAt: now });
  await newSegment(tx, id);
  return id;
}
