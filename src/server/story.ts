import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { inTransaction, withDb, type Q, type Tx } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { closeGap, openGap, parkRow } from '../db/positions.js';
import { touchProject } from '../db/touch.js';
import { asset, chapter, clip, cue, generation, lane, project, segment, scene } from '../db/schema.js';
import { generateForCue } from '../voice/generate.js';
import { MAX_VARIATIONS, dropVariation, generateVariations, parseSfxSettings, saveSfxSettings, sfxSettings, variation } from '../voice/sfx.js';
import { kickAudioJobs } from '../audio/jobs.js';
import { MAX_UPLOAD, removeFiles, storeFile, type AssetRow } from '../library/files.js';
import { usageOf } from './library.js';
import { chapterIndexLabel } from '../library/managed.js';
import { storylineName, takeKind } from '../library/storyline.js';
import { accessTo, accessToEntity, checkId } from './access.js';
import { assetLoudness, autoLevel, measureBytes, saveLoudness } from './levels.js';
import { authenticate } from './auth-routes.js';
import {
  MAX_SCENE_MS,
  CLIP_ORIGIN_LIST,
  addClip,
  chooseClip,
  clipsOfCues,
  learnSpeechRate,
  createSegment,
  deleteCue,
  deleteScene,
  insertCue,
  mergeWithPrevious,
  moveCue,
  newScene,
  pruneLanes,
  removeClip,
  sceneCues,
  splitScene,
  updateClip,
  updateCue,
  placeCue,
  shiftCues,
  shiftLaneLevel,
  type CuePlace,
  type ClipOrigin,
  type ClipPatch,
  type CuePatch,
  type CueType,
} from './content.js';
import { LEVEL_MAX_DB, LEVEL_MIN_DB, PITCH_MAX_CENTS, SPEED_MAX, SPEED_MIN, cleanPoints } from '../shared/audio-settings.js';
import { HttpError, asBody, badRequest, optBool, optInt, optString, reqString } from './http.js';

const MAX_NUMBERED = 99;
const MAX_INTRODUCTORY = 26;
const MAX_SEGMENTS = 99;
const CUE_TYPES = ['speech', 'sfx', 'music'] as const;

const indexLabel = chapterIndexLabel;

export async function storyOf(q: Q, projectId: string) {
  const chapters = await q.select().from(chapter).where(eq(chapter.projectId, projectId)).orderBy(asc(chapter.position));
  const ids = chapters.map((c) => c.id);
  const segments = ids.length
    ? await q.select().from(segment).where(inArray(segment.chapterId, ids)).orderBy(asc(segment.chapterId), asc(segment.position))
    : [];
  const segmentIds = segments.map((s) => s.id);
  const counts = segmentIds.length
    ? await q
        .select({ segmentId: scene.segmentId, n: count(cue.id) })
        .from(scene)
        .leftJoin(cue, eq(cue.sceneId, scene.id))
        .where(inArray(scene.segmentId, segmentIds))
        .groupBy(scene.segmentId)
    : [];
  const cueCount = new Map(counts.map((c) => [c.segmentId, Number(c.n)]));
  const introCount = chapters.filter((c) => c.introductory).length;
  return {
    chapters: chapters.map((c) => ({
      id: c.id,
      position: c.position,
      index: indexLabel(c.position, c.introductory, introCount),
      title: c.title,
      introductory: c.introductory,
      segments: segments
        .filter((s) => s.chapterId === c.id)
        .map((s) => ({ id: s.id, position: s.position, title: s.title, cueCount: cueCount.get(s.id) ?? 0 })),
    })),
  };
}

async function segmentCount(q: Q, chapterId: string): Promise<number> {
  const rows = await q.select({ n: count() }).from(segment).where(eq(segment.chapterId, chapterId));
  return Number(rows[0]?.n ?? 0);
}

async function chapterCounts(q: Q, projectId: string, excludeId?: string) {
  const rows = await q.select({ id: chapter.id, introductory: chapter.introductory }).from(chapter).where(eq(chapter.projectId, projectId));
  const others = rows.filter((r) => r.id !== excludeId);
  return { intro: others.filter((r) => r.introductory).length, numbered: others.filter((r) => !r.introductory).length };
}

async function segmentContent(tx: Q, segmentId: string) {
  const sc = (await tx.select().from(segment).where(eq(segment.id, segmentId)).limit(1))[0]!;
  const ch = (await tx.select().from(chapter).where(eq(chapter.id, sc.chapterId)).limit(1))[0]!;
  const pr = (await tx.select().from(project).where(eq(project.id, ch.projectId)).limit(1))[0]!;
  const scenes = await tx.select().from(scene).where(eq(scene.segmentId, segmentId)).orderBy(asc(scene.position));
  const lanes = await tx.select().from(lane).where(eq(lane.segmentId, segmentId)).orderBy(asc(lane.position));
  let start = 0;
  const outScenes = [];
  const sceneCueRows = [];
  for (const s of scenes) sceneCueRows.push(await sceneCues(tx as Tx, s.id));
  const clips = await clipsOfCues(tx, sceneCueRows.flat().map((c) => c.id));
  for (const [i, s] of scenes.entries()) {
    const cues = sceneCueRows[i]!;
    const length = cues.reduce((m, c) => Math.max(m, c.startMs + c.lengthMs), 0);
    outScenes.push({
      id: s.id,
      position: s.position,
      label: s.label,
      startMs: start,
      lengthMs: length,
      cues: cues.map((c) => ({
        id: c.id,
        laneId: c.laneId,
        type: c.type,
        characterId: c.characterId,
        startMs: c.startMs,
        lengthMs: c.lengthMs,
        lengthAuto: c.lengthAuto,
        muted: c.muted,
        text: c.textMd,
        clipId: c.clipId,
        clips: clips.get(c.id) ?? [],
      })),
    });
    start += length;
  }
  return {
    segment: { id: sc.id, title: sc.title, chapterId: ch.id, chapterTitle: ch.title, projectId: pr.id },
    project: { id: pr.id, type: pr.type, language: pr.language },
    scenes: outScenes,
    lanes: lanes.map((l) => ({ id: l.id, title: l.title, colour: l.colour, characterId: l.characterId, position: l.position, auto: l.auto })),
  };
}

function readCuePatch(body: Record<string, unknown>): CuePatch {
  const patch: CuePatch = {};
  const text = optString(body, 'text', 20000, { trim: false });
  if (text !== undefined && text !== null) patch.text = text;
  if ('type' in body) {
    if (typeof body.type !== 'string' || !(CUE_TYPES as readonly string[]).includes(body.type)) throw badRequest('invalid_type');
    patch.type = body.type as CueType;
  }
  if ('characterId' in body) {
    if (body.characterId === null) patch.characterId = null;
    else patch.characterId = checkId(body.characterId);
  }
  const length = optInt(body, 'lengthMs', 100, MAX_SCENE_MS);
  if (length !== undefined) patch.lengthMs = length;
  const auto = optBool(body, 'lengthAuto');
  if (auto !== undefined) patch.lengthAuto = auto;
  const muted = optBool(body, 'muted');
  if (muted !== undefined) patch.muted = muted;
  return patch;
}

const isWav = (b: Buffer) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE';

export function registerStoryRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };
  const small = { ...auth, bodyLimit: 8192 };
  const userId = (r: { account?: { id: string } }) => r.account!.id;

  /** Runs a write on an entity: access check, the change, the touch, and the story as the answer. */
  async function storyWrite(
    request: { account?: { id: string } },
    kind: 'chapter' | 'segment' | 'project',
    id: string,
    fn: (tx: Tx, projectId: string) => Promise<Record<string, unknown> | void>,
  ) {
    return inTransaction(async (tx) => {
      let projectId = id;
      if (kind === 'project') await accessTo(tx, userId(request), id, { edit: true });
      else projectId = (await accessToEntity(tx, userId(request), kind, id, { edit: true })).projectId;
      const extra = (await fn(tx, projectId)) ?? {};
      await touchProject(tx, projectId, userId(request));
      return { ...(await storyOf(tx, projectId)), ...extra };
    });
  }

  app.get('/api/projects/:id/story', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, userId(request), id);
      return storyOf(db, id);
    });
  });

  // ---- chapters ---------------------------------------------------------------------

  app.post('/api/projects/:id/chapters', small, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const title = reqString(body, 'title', 200);
    const introductory = optBool(body, 'introductory') ?? false;
    const result = await storyWrite(request, 'project', id, async (tx) => {
      const counts = await chapterCounts(tx, id);
      if (introductory && counts.intro >= MAX_INTRODUCTORY) throw new HttpError(400, 'too_many_chapters', 'At most 26 introductory chapters.');
      if (!introductory && counts.numbered >= MAX_NUMBERED) throw new HttpError(400, 'too_many_chapters', 'At most 99 numbered chapters.');
      const position = introductory ? counts.intro + 1 : counts.intro + counts.numbered + 1;
      await openGap(tx, 'chapter', id, position);
      const chapterId = newUlid();
      const now = new Date();
      await tx.insert(chapter).values({ id: chapterId, projectId: id, position, title, introductory, createdAt: now, updatedAt: now });
      return { created: chapterId };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/chapters/:id', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const title = 'title' in body ? reqString(body, 'title', 200) : undefined;
    const introductory = optBool(body, 'introductory');
    return storyWrite(request, 'chapter', id, async (tx, projectId) => {
      const current = (await tx.select().from(chapter).where(eq(chapter.id, id)).limit(1))[0]!;
      if (title !== undefined) await tx.update(chapter).set({ title, updatedAt: new Date() }).where(eq(chapter.id, id));
      if (introductory !== undefined && introductory !== current.introductory) {
        const counts = await chapterCounts(tx, projectId, id);
        if (introductory && counts.intro >= MAX_INTRODUCTORY) throw new HttpError(400, 'too_many_chapters', 'At most 26 introductory chapters.');
        if (!introductory && counts.numbered >= MAX_NUMBERED) throw new HttpError(400, 'too_many_chapters', 'At most 99 numbered chapters.');
        await parkRow(tx, 'chapter', id);
        await closeGap(tx, 'chapter', projectId, current.position);
        const position = counts.intro + 1; // the end of the introductory group, or the start of the numbered one
        await openGap(tx, 'chapter', projectId, position);
        await tx.update(chapter).set({ introductory, position, updatedAt: new Date() }).where(eq(chapter.id, id));
      }
    });
  });

  app.post('/api/chapters/:id/move', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const requested = optInt(asBody(request.body), 'position', 1, 1000);
    if (requested === undefined) throw badRequest('invalid_position');
    return storyWrite(request, 'chapter', id, async (tx, projectId) => {
      const current = (await tx.select().from(chapter).where(eq(chapter.id, id)).limit(1))[0]!;
      const counts = await chapterCounts(tx, projectId, id);
      const lo = current.introductory ? 1 : counts.intro + 1;
      const hi = current.introductory ? counts.intro + 1 : counts.intro + counts.numbered + 1;
      const position = Math.min(hi, Math.max(lo, requested));
      if (position === current.position) return;
      await parkRow(tx, 'chapter', id);
      await closeGap(tx, 'chapter', projectId, current.position);
      await openGap(tx, 'chapter', projectId, position);
      await tx.update(chapter).set({ position, updatedAt: new Date() }).where(eq(chapter.id, id));
    });
  });

  app.delete('/api/chapters/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return storyWrite(request, 'chapter', id, async (tx, projectId) => {
      const current = (await tx.select().from(chapter).where(eq(chapter.id, id)).limit(1))[0]!;
      await tx.delete(chapter).where(eq(chapter.id, id)); // segments, scenes, lanes, cues, clips and notes cascade
      await closeGap(tx, 'chapter', projectId, current.position);
    });
  });

  // ---- segments -----------------------------------------------------------------------

  app.post('/api/chapters/:id/segments', small, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const title = reqString(asBody(request.body), 'title', 200);
    const result = await storyWrite(request, 'chapter', id, async (tx) => {
      const n = await segmentCount(tx, id);
      if (n >= MAX_SEGMENTS) throw new HttpError(400, 'too_many_segments', 'A chapter holds at most 99 segments.');
      return { created: await createSegment(tx, id, title, n + 1) };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/segments/:id', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const title = reqString(asBody(request.body), 'title', 200);
    return storyWrite(request, 'segment', id, async (tx) => {
      await tx.update(segment).set({ title, updatedAt: new Date() }).where(eq(segment.id, id));
    });
  });

  app.post('/api/segments/:id/move', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const toChapter = checkId(body.chapterId);
    const requested = optInt(body, 'position', 1, 1000);
    if (requested === undefined) throw badRequest('invalid_position');
    return storyWrite(request, 'segment', id, async (tx, projectId) => {
      const current = (await tx.select().from(segment).where(eq(segment.id, id)).limit(1))[0]!;
      const target = (await tx.select().from(chapter).where(and(eq(chapter.id, toChapter), eq(chapter.projectId, projectId))).limit(1))[0];
      if (!target) throw new HttpError(404, 'not_found');
      const same = toChapter === current.chapterId;
      const n = await segmentCount(tx, toChapter);
      if (!same && n >= MAX_SEGMENTS) throw new HttpError(400, 'too_many_segments', 'A chapter holds at most 99 segments.');
      const position = Math.min(same ? n : n + 1, Math.max(1, requested));
      if (same && position === current.position) return;
      await parkRow(tx, 'segment', id);
      await closeGap(tx, 'segment', current.chapterId, current.position);
      await openGap(tx, 'segment', toChapter, position);
      await tx.update(segment).set({ chapterId: toChapter, position, updatedAt: new Date() }).where(eq(segment.id, id));
    });
  });

  app.delete('/api/segments/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return storyWrite(request, 'segment', id, async (tx) => {
      const current = (await tx.select().from(segment).where(eq(segment.id, id)).limit(1))[0]!;
      await tx.delete(segment).where(eq(segment.id, id));
      await closeGap(tx, 'segment', current.chapterId, current.position);
    });
  });

  // ---- segment content --------------------------------------------------------------------

  app.get('/api/segments/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessToEntity(db, userId(request), 'segment', id);
      return segmentContent(db, id);
    });
  });

  /** Runs a write inside a segment and answers with the segment's content. */
  async function segmentWrite(
    request: { account?: { id: string } },
    kind: 'segment' | 'scene' | 'cue',
    id: string,
    fn: (tx: Tx, segmentId: string) => Promise<Record<string, unknown> | void>,
  ) {
    return inTransaction(async (tx) => {
      const access = await accessToEntity(tx, userId(request), kind, id, { edit: true });
      let segmentId = id;
      if (kind === 'scene') segmentId = (await tx.select({ s: scene.segmentId }).from(scene).where(eq(scene.id, id)).limit(1))[0]!.s;
      if (kind === 'cue') {
        segmentId = (await tx
          .select({ s: scene.segmentId })
          .from(cue)
          .innerJoin(scene, eq(scene.id, cue.sceneId))
          .where(eq(cue.id, id))
          .limit(1))[0]!.s;
      }
      const extra = (await fn(tx, segmentId)) ?? {};
      await touchProject(tx, access.projectId, userId(request));
      return { ...(await segmentContent(tx, segmentId)), ...extra };
    });
  }

  app.post('/api/segments/:id/scenes', small, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const label = optString(asBody(request.body), 'label', 100, { allowNull: true });
    const result = await segmentWrite(request, 'segment', id, async (tx) => ({ created: await newScene(tx, id, undefined, label || null) }));
    return reply.code(201).send(result);
  });

  app.post('/api/scenes/:id/split', small, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const beforeCueId = checkId(asBody(request.body).beforeCueId);
    const result = await segmentWrite(request, 'scene', id, async (tx) => ({ created: await splitScene(tx, id, beforeCueId) }));
    return reply.code(201).send(result);
  });

  app.patch('/api/scenes/:id', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const label = optString(asBody(request.body), 'label', 100, { allowNull: true });
    if (label === undefined) throw badRequest('invalid_label');
    return segmentWrite(request, 'scene', id, async (tx) => {
      await tx.update(scene).set({ label: label || null, updatedAt: new Date() }).where(eq(scene.id, id));
    });
  });

  app.post('/api/scenes/:id/merge-previous', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return segmentWrite(request, 'scene', id, (tx) => mergeWithPrevious(tx, id));
  });

  app.delete('/api/scenes/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return segmentWrite(request, 'scene', id, (tx) => deleteScene(tx, id));
  });

  // ---- cues -------------------------------------------------------------------------

  app.post('/api/scenes/:id/cues', { ...auth, bodyLimit: 65536 }, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const patch = readCuePatch(body);
    const afterCueId = body.afterCueId === undefined || body.afterCueId === null ? null : checkId(body.afterCueId);
    const result = await segmentWrite(request, 'scene', id, async (tx) => {
      const created = await insertCue(tx, id, { afterCueId, type: patch.type, characterId: patch.characterId, text: patch.text }, userId(request));
      return { created: created.id };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/cues/:id', { ...auth, bodyLimit: 65536 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const patch = readCuePatch(asBody(request.body));
    return segmentWrite(request, 'cue', id, async (tx) => {
      await updateCue(tx, id, patch);
    });
  });

  app.post('/api/cues/:id/place', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const place: CuePlace = {};
    const startMs = optInt(body, 'startMs', 0, MAX_SCENE_MS);
    const lengthMs = optInt(body, 'lengthMs', 100, MAX_SCENE_MS);
    if (startMs !== undefined) place.startMs = startMs;
    if (lengthMs !== undefined) place.lengthMs = lengthMs;
    if ('mode' in body) {
      if (body.mode !== 'ripple' && body.mode !== 'trim') throw badRequest('invalid_mode');
      place.mode = body.mode;
    }
    if ('push' in body) {
      if (typeof body.push !== 'boolean') throw badRequest('invalid_push');
      place.push = body.push;
    }
    return segmentWrite(request, 'cue', id, async (tx) => {
      await placeCue(tx, id, place);
    });
  });

  // Several cues of a scene moved together by the same time.
  app.post('/api/cues/shift', small, async (request) => {
    const body = asBody(request.body);
    if (!Array.isArray(body.cueIds) || body.cueIds.length < 1 || body.cueIds.length > 500) throw badRequest('invalid_cueIds');
    const cueIds = [...new Set(body.cueIds.map((c: unknown) => checkId(c)))];
    const deltaMs = optInt(body, 'deltaMs', -MAX_SCENE_MS, MAX_SCENE_MS);
    if (deltaMs === undefined) throw badRequest('invalid_deltaMs');
    return segmentWrite(request, 'cue', cueIds[0]!, async (tx) => {
      await shiftCues(tx, cueIds, deltaMs);
    });
  });

  app.post('/api/cues/:id/move', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const sceneId = checkId(body.sceneId);
    const afterCueId = body.afterCueId === undefined || body.afterCueId === null ? null : checkId(body.afterCueId);
    return segmentWrite(request, 'cue', id, async (tx) => {
      await moveCue(tx, id, sceneId, afterCueId);
    });
  });

  // ---- clips ------------------------------------------------------------------------

  async function cueOfClip(clipId: string): Promise<string> {
    const row = (await withDb((db) => db.select({ cueId: clip.cueId }).from(clip).where(eq(clip.id, clipId)).limit(1)))[0];
    if (!row) throw new HttpError(404, 'not_found');
    return row.cueId;
  }

  app.post('/api/cues/:id/clips', small, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const assetId = checkId(body.assetId);
    const offsetMs = optInt(body, 'offsetMs', 0, MAX_SCENE_MS);
    const lengthMs = optInt(body, 'lengthMs', 100, MAX_SCENE_MS);
    const keepCueLength = optBool(body, 'keepCueLength');
    const choose = optBool(body, 'choose');
    let origin: ClipOrigin | undefined;
    if ('origin' in body) {
      if (typeof body.origin !== 'string' || !CLIP_ORIGIN_LIST.includes(body.origin)) throw badRequest('invalid_origin');
      origin = body.origin as ClipOrigin;
    }
    // A take chosen from the library is levelled like a new recording (lane levels).
    const projectId = await withDb(async (db) => (await accessToEntity(db, userId(request), 'cue', id, { edit: true })).projectId);
    const level = await autoLevel(projectId, id, await assetLoudness(projectId, assetId));
    const result = await segmentWrite(request, 'cue', id, async (tx) => ({
      created: await addClip(tx, id, { assetId, offsetMs, lengthMs, keepCueLength, choose, origin, level }),
    }));
    return reply.code(201).send(result);
  });

  app.patch('/api/clips/:id', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const patch: ClipPatch = {};
    const offsetMs = optInt(body, 'offsetMs', 0, MAX_SCENE_MS);
    if (offsetMs !== undefined) patch.offsetMs = offsetMs;
    const lengthMs = optInt(body, 'lengthMs', 100, MAX_SCENE_MS);
    if (lengthMs !== undefined) patch.lengthMs = lengthMs;
    const fadeInMs = optInt(body, 'fadeInMs', 0, MAX_SCENE_MS);
    if (fadeInMs !== undefined) patch.fadeInMs = fadeInMs;
    const fadeOutMs = optInt(body, 'fadeOutMs', 0, MAX_SCENE_MS);
    if (fadeOutMs !== undefined) patch.fadeOutMs = fadeOutMs;
    const loops = optInt(body, 'loops', -1, 99);
    if (loops !== undefined) patch.loops = loops;
    if ('gainDb' in body) {
      if (typeof body.gainDb !== 'number' || !Number.isFinite(body.gainDb) || body.gainDb < -60 || body.gainDb > LEVEL_MAX_DB) throw badRequest('invalid_gainDb');
      patch.gainDb = body.gainDb;
    }
    if ('speed' in body) {
      if (typeof body.speed !== 'number' || !Number.isFinite(body.speed) || body.speed < SPEED_MIN || body.speed > SPEED_MAX) throw badRequest('invalid_speed');
      patch.speed = Math.round(body.speed * 100) / 100;
    }
    const pitchCents = optInt(body, 'pitchCents', -PITCH_MAX_CENTS, PITCH_MAX_CENTS);
    if (pitchCents !== undefined) patch.pitchCents = pitchCents;
    for (const [key, kind] of [['volumePoints', 'level'], ['speedPoints', 'speed'], ['pitchPoints', 'pitch']] as const) {
      if (!(key in body)) continue;
      const points = cleanPoints(body[key], MAX_SCENE_MS, kind);
      if (points === undefined) throw badRequest(`invalid_${key}`);
      patch[key] = points;
    }
    const cueId = await cueOfClip(id);
    return segmentWrite(request, 'cue', cueId, async (tx) => {
      await updateClip(tx, id, patch);
    });
  });

  /**
   * A take recorded in the browser (a 24-bit WAV master, from which the worker derives the MP3 copy and the peaks; an MP3 is still accepted): stored under Storyline with the naming scheme, attached to the
   * cue as its next take and chosen. The cue then lasts as long as the take.
   */
  app.post('/api/cues/:id/recording', { onRequest: authenticate(), bodyLimit: MAX_UPLOAD + 4096 }, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const data = request.body;
    if (!Buffer.isBuffer(data)) throw badRequest('invalid_body', 'Send the recording as application/octet-stream.');
    const { projectId, folder, name } = await withDb(async (db) => {
      const access = await accessToEntity(db, userId(request), 'cue', id, { edit: true });
      const where = await storylineName(db, id, 'R');
      return { projectId: access.projectId, folder: where.folder, name: where.base + (isWav(data) ? '.wav' : '.mp3') };
    });
    const loudness = await measureBytes(data); // before the file joins the encoding queue
    const stored = await withDb((db) => storeFile(db, { projectId, folder, name, data, only: ['audio'], maxBytes: MAX_UPLOAD }));
    if (loudness) await saveLoudness(stored.asset.id, loudness);
    if (stored.asset.status === 'pending') kickAudioJobs(request.log);
    const level = await autoLevel(projectId, id, loudness);
    const result = await segmentWrite(request, 'cue', id, async (tx) => {
      const created = await addClip(tx, id, { assetId: stored.asset.id, keepCueLength: false, choose: true, origin: 'human-recorded', level });
      await learnSpeechRate(tx, id, created); // a speech take teaches the project how fast it is spoken
      return { created, path: stored.asset.path };
    });
    return reply.code(201).send(result);
  });

  /**
   * Generate audio (Bible, decision log 2026-11-20): `mode: text` makes speech, a sound effect or music from the cue's text
   * (with optional `direction` and, for speech, `context`); `mode: take` runs the voice changer on one of the cue's takes
   * (`sourceClipId`, default the chosen one). The result is stored under Storyline, added as the next take and chosen.
   */
  app.post('/api/cues/:id/generate', { onRequest: authenticate(), bodyLimit: 8192 }, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const mode = body.mode === 'take' ? 'take' : body.mode === 'text' ? 'text' : null;
    if (!mode) throw badRequest('invalid_mode');
    const direction = optString(body, 'direction', 500, { allowNull: true }) ?? null;
    const sourceClipId = typeof body.sourceClipId === 'string' ? checkId(body.sourceClipId) : null;
    const input = { mode, direction: direction || null, context: body.context === true, sourceClipId, removeNoise: body.removeNoise === true } as const;
    const projectId = await withDb(async (db) => (await accessToEntity(db, userId(request), 'cue', id, { edit: true })).projectId);
    const made = await withDb((db) => generateForCue(db, id, input));
    const { folder, name } = await withDb(async (db) => {
      const where = await storylineName(db, id, takeKind(made.origin));
      return { folder: where.folder, name: `${where.base}.${made.ext}` };
    });
    const loudness = await measureBytes(made.data);
    const stored = await withDb((db) => storeFile(db, { projectId, folder, name, data: made.data, only: ['audio'], maxBytes: MAX_UPLOAD }));
    if (loudness) await saveLoudness(stored.asset.id, loudness);
    if (stored.asset.status === 'pending') kickAudioJobs(request.log);
    const level = await autoLevel(projectId, id, loudness);
    const result = await segmentWrite(request, 'cue', id, async (tx) => {
      const created = await addClip(tx, id, { assetId: stored.asset.id, keepCueLength: false, choose: true, origin: made.origin, level });
      await tx.insert(generation).values({ id: newUlid(), projectId, clipId: created, ...made.record, createdByUserId: userId(request), createdAt: new Date() });
      return { created, path: stored.asset.path, characterCost: made.record.characterCost };
    });
    return reply.code(201).send(result);
  });

  // ---- sound-effect cues: settings, variations, keeping some as takes (Bible, decision log 2026-11-20) ----

  const sfxCue = async (request: { account?: { id: string } }, id: string, edit = true) => withDb(async (db) => {
    const access = await accessToEntity(db, userId(request), 'cue', id, { edit });
    const c = (await db.select({ type: cue.type }).from(cue).where(eq(cue.id, id)).limit(1))[0];
    if (c?.type !== 'sfx') throw badRequest('not_sfx', 'This cue is not a sound effect.');
    return access.projectId;
  });

  app.get('/api/cues/:id/sfx', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    await sfxCue(request, id, false);
    return withDb((db) => sfxSettings(db, id));
  });

  app.put('/api/cues/:id/sfx', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const projectId = await sfxCue(request, id);
    const settings = parseSfxSettings(asBody(request.body));
    await inTransaction(async (tx) => { await saveSfxSettings(tx, id, settings); await touchProject(tx, projectId, userId(request)); });
    return { ...settings, saved: true };
  });

  /** Saves the settings and generates 1 to 4 variations; they wait (30 minutes) until some are kept. */
  app.post('/api/cues/:id/sfx/generate', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const projectId = await sfxCue(request, id);
    const b = asBody(request.body);
    const settings = parseSfxSettings(b);
    const count = typeof b.variations === 'number' && Number.isInteger(b.variations) && b.variations >= 1 && b.variations <= MAX_VARIATIONS ? b.variations : 1;
    await inTransaction(async (tx) => { await saveSfxSettings(tx, id, settings); await touchProject(tx, projectId, userId(request)); });
    return generateVariations({ cueId: id, projectId, userId: userId(request), settings, count });
  });

  app.get('/api/sfx-variations/:vid', auth, async (request, reply) => {
    const v = variation(checkId((request.params as { vid: string }).vid), userId(request));
    return reply.header('content-type', v.contentType).header('cache-control', 'private, no-store').send(v.data);
  });

  /** Keeps chosen variations as the cue's next takes (under Storyline); `chosen` names the one the cue plays. */
  app.post('/api/cues/:id/sfx/keep', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const projectId = await sfxCue(request, id);
    const b = asBody(request.body);
    const ids = Array.isArray(b.variationIds) ? b.variationIds : [];
    if (!ids.length || ids.length > MAX_VARIATIONS * 5 || !ids.every((x) => typeof x === 'string')) throw badRequest('invalid_variationIds', 'Choose at least one variation to keep.');
    const vs = (ids as string[]).map((v) => variation(checkId(v), userId(request)));
    if (vs.some((v) => v.cueId !== id)) throw badRequest('invalid_variationIds', 'A variation belongs to another cue.');
    const chosen = typeof b.chosen === 'string' && ids.includes(b.chosen) ? b.chosen : vs[0]!.id;
    const kept: { v: (typeof vs)[number]; assetId: string; path: string; level: Awaited<ReturnType<typeof autoLevel>> }[] = [];
    for (const v of vs) {
      const { folder, name } = await withDb(async (db) => {
        const where = await storylineName(db, id, 'G', kept.length);
        return { folder: where.folder, name: `${where.base}.${v.ext}` };
      });
      const loudness = await measureBytes(v.data);
      const st = await withDb((db) => storeFile(db, { projectId, folder, name, data: v.data, only: ['audio'], maxBytes: MAX_UPLOAD }));
      if (loudness) await saveLoudness(st.asset.id, loudness);
      kept.push({ v, assetId: st.asset.id, path: st.asset.path, level: await autoLevel(projectId, id, loudness) });
    }
    kickAudioJobs(request.log);
    const result = await segmentWrite(request, 'cue', id, async (tx) => {
      const created: string[] = [];
      for (const k of kept) {
        const clipId = await addClip(tx, id, { assetId: k.assetId, keepCueLength: k.v.id !== chosen, choose: k.v.id === chosen, origin: 'generated', level: k.level });
        await tx.insert(generation).values({
          id: newUlid(), projectId, clipId, kind: 'sfx', model: k.v.settings.model, voiceId: null, textSent: k.v.settings.prompt, direction: null,
          settings: { durationMs: k.v.settings.durationMs, loop: k.v.settings.loop, promptInfluence: k.v.settings.promptInfluence },
          sourceClipId: null, outputFormat: k.v.outputFormat, context: false, requestId: k.v.requestId, characterCost: k.v.characterCost,
          createdByUserId: userId(request), createdAt: new Date(),
        });
        created.push(clipId);
      }
      return { created, paths: kept.map((k) => k.path) };
    });
    for (const k of kept) dropVariation(k.v.id);
    return result;
  });

  // Takes the clip off its cue. With `?deleteAsset=1` the file goes from the library and the disk too, unless
  // something else still uses it (another cue, a note, a picture): then it stays, and `assetKept` says why.
  app.delete('/api/clips/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const withAsset = (request.query as Record<string, unknown>).deleteAsset === '1';
    const cueId = await cueOfClip(id);
    let gone: AssetRow | null = null;
    const result = await segmentWrite(request, 'cue', cueId, async (tx) => {
      const held = (await tx.select({ assetId: clip.assetId }).from(clip).where(eq(clip.id, id)).limit(1))[0];
      await removeClip(tx, id);
      if (!withAsset || !held) return;
      const a = (await tx.select().from(asset).where(eq(asset.id, held.assetId)).limit(1))[0];
      if (!a) return;
      const usage = (await usageOf(tx, a.projectId, [a.id])).get(a.id);
      if (usage) return { assetDeleted: false, assetKept: usage };
      await tx.delete(clip).where(eq(clip.assetId, a.id)); // only alternatives can be left (see usageOf)
      await tx.delete(asset).where(eq(asset.id, a.id));
      gone = a;
      return { assetDeleted: true };
    });
    if (gone) await removeFiles(gone).catch((e) => request.log.error(e));
    return result;
  });

  /** Chooses the clip a cue plays; `clipId: null` chooses none. */
  app.post('/api/cues/:id/choose-clip', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const clipId = body.clipId === null ? null : checkId(body.clipId);
    return segmentWrite(request, 'cue', id, async (tx) => {
      await chooseClip(tx, id, clipId);
    });
  });

  app.delete('/api/cues/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return segmentWrite(request, 'cue', id, async (tx) => {
      await deleteCue(tx, id);
    });
  });

  // ---- lanes ------------------------------------------------------------------------

  /** Moves the level of every take on the lane by `deltaDb` (the lane's level slider). */
  app.post('/api/lanes/:id/level', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const span = LEVEL_MAX_DB - LEVEL_MIN_DB;
    if (typeof body.deltaDb !== 'number' || !Number.isFinite(body.deltaDb) || Math.abs(body.deltaDb) > span) throw badRequest('invalid_deltaDb');
    const deltaDb = Math.round(body.deltaDb * 100) / 100;
    const row = (await withDb((db) => db.select({ segmentId: lane.segmentId }).from(lane).where(eq(lane.id, id)).limit(1)))[0];
    if (!row) throw new HttpError(404, 'not_found');
    return segmentWrite(request, 'segment', row.segmentId, async (tx) => {
      await shiftLaneLevel(tx, id, deltaDb);
    });
  });

  app.patch('/api/lanes/:id', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const title = 'title' in body ? reqString(body, 'title', 100) : undefined;
    const colour = optString(body, 'colour', 7);
    if (colour !== undefined && (colour === null || !/^#[0-9a-fA-F]{6}$/.test(colour))) throw badRequest('invalid_colour');
    const row = (await withDb((db) => db.select().from(lane).where(eq(lane.id, id)).limit(1)))[0];
    if (!row) throw new HttpError(404, 'not_found');
    return segmentWrite(request, 'segment', row.segmentId, async (tx) => {
      const set: Partial<typeof lane.$inferInsert> = { updatedAt: new Date() };
      if (title !== undefined) {
        set.title = title;
        set.auto = false; // a renamed lane stays (proposed); recolouring does not change this
      }
      if (colour) set.colour = colour;
      await tx.update(lane).set(set).where(eq(lane.id, id));
    });
  });

  void pruneLanes;
  void sql;
}
