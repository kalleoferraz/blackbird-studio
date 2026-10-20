import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { inTransaction, withDb, type Q, type Tx } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { closeGap, openGap, parkRow } from '../db/positions.js';
import { touchProject } from '../db/touch.js';
import { chapter, cue, lane, project, scene, segment } from '../db/schema.js';
import { accessTo, accessToEntity, checkId } from './access.js';
import { authenticate } from './auth-routes.js';
import {
  MAX_SEGMENT_MS,
  createScene,
  deleteCue,
  deleteSegment,
  insertCue,
  mergeWithPrevious,
  moveCue,
  newSegment,
  pruneLanes,
  segmentCues,
  splitSegment,
  updateCue,
  type CuePatch,
  type CueType,
} from './content.js';
import { HttpError, asBody, badRequest, optBool, optInt, optString, reqString } from './http.js';

const MAX_NUMBERED = 99;
const MAX_INTRODUCTORY = 26;
const MAX_SCENES = 99;
const CUE_TYPES = ['speech', 'sfx', 'music'] as const;

function indexLabel(position: number, introductory: boolean, introCount: number): string {
  if (introductory) return `00${String.fromCharCode(64 + position)}`; // 00A to 00Z
  return String(position - introCount).padStart(2, '0');
}

export async function storyOf(q: Q, projectId: string) {
  const chapters = await q.select().from(chapter).where(eq(chapter.projectId, projectId)).orderBy(asc(chapter.position));
  const ids = chapters.map((c) => c.id);
  const scenes = ids.length
    ? await q.select().from(scene).where(inArray(scene.chapterId, ids)).orderBy(asc(scene.chapterId), asc(scene.position))
    : [];
  const sceneIds = scenes.map((s) => s.id);
  const counts = sceneIds.length
    ? await q
        .select({ sceneId: segment.sceneId, n: count(cue.id) })
        .from(segment)
        .leftJoin(cue, eq(cue.segmentId, segment.id))
        .where(inArray(segment.sceneId, sceneIds))
        .groupBy(segment.sceneId)
    : [];
  const cueCount = new Map(counts.map((c) => [c.sceneId, Number(c.n)]));
  const introCount = chapters.filter((c) => c.introductory).length;
  return {
    chapters: chapters.map((c) => ({
      id: c.id,
      position: c.position,
      index: indexLabel(c.position, c.introductory, introCount),
      title: c.title,
      introductory: c.introductory,
      scenes: scenes
        .filter((s) => s.chapterId === c.id)
        .map((s) => ({ id: s.id, position: s.position, title: s.title, cueCount: cueCount.get(s.id) ?? 0 })),
    })),
  };
}

async function sceneCount(q: Q, chapterId: string): Promise<number> {
  const rows = await q.select({ n: count() }).from(scene).where(eq(scene.chapterId, chapterId));
  return Number(rows[0]?.n ?? 0);
}

async function chapterCounts(q: Q, projectId: string, excludeId?: string) {
  const rows = await q.select({ id: chapter.id, introductory: chapter.introductory }).from(chapter).where(eq(chapter.projectId, projectId));
  const others = rows.filter((r) => r.id !== excludeId);
  return { intro: others.filter((r) => r.introductory).length, numbered: others.filter((r) => !r.introductory).length };
}

async function sceneContent(tx: Q, sceneId: string) {
  const sc = (await tx.select().from(scene).where(eq(scene.id, sceneId)).limit(1))[0]!;
  const ch = (await tx.select().from(chapter).where(eq(chapter.id, sc.chapterId)).limit(1))[0]!;
  const pr = (await tx.select().from(project).where(eq(project.id, ch.projectId)).limit(1))[0]!;
  const segments = await tx.select().from(segment).where(eq(segment.sceneId, sceneId)).orderBy(asc(segment.position));
  const lanes = await tx.select().from(lane).where(eq(lane.sceneId, sceneId)).orderBy(asc(lane.position));
  let start = 0;
  const outSegments = [];
  for (const s of segments) {
    const cues = await segmentCues(tx as Tx, s.id);
    const length = cues.reduce((m, c) => Math.max(m, c.startMs + c.lengthMs), 0);
    outSegments.push({
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
        text: c.textMd,
        clipId: c.clipId,
      })),
    });
    start += length;
  }
  return {
    scene: { id: sc.id, title: sc.title, chapterId: ch.id, chapterTitle: ch.title, projectId: pr.id },
    project: { id: pr.id, type: pr.type, language: pr.language },
    segments: outSegments,
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
  const length = optInt(body, 'lengthMs', 100, MAX_SEGMENT_MS);
  if (length !== undefined) patch.lengthMs = length;
  const auto = optBool(body, 'lengthAuto');
  if (auto !== undefined) patch.lengthAuto = auto;
  return patch;
}

export function registerStoryRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };
  const small = { ...auth, bodyLimit: 8192 };
  const userId = (r: { account?: { id: string } }) => r.account!.id;

  /** Runs a write on an entity: access check, the change, the touch, and the story as the answer. */
  async function storyWrite(
    request: { account?: { id: string } },
    kind: 'chapter' | 'scene' | 'project',
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
      await tx.delete(chapter).where(eq(chapter.id, id)); // scenes, segments, lanes, cues, clips and notes cascade
      await closeGap(tx, 'chapter', projectId, current.position);
    });
  });

  // ---- scenes -----------------------------------------------------------------------

  app.post('/api/chapters/:id/scenes', small, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const title = reqString(asBody(request.body), 'title', 200);
    const result = await storyWrite(request, 'chapter', id, async (tx) => {
      const n = await sceneCount(tx, id);
      if (n >= MAX_SCENES) throw new HttpError(400, 'too_many_scenes', 'A chapter holds at most 99 scenes.');
      return { created: await createScene(tx, id, title, n + 1) };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/scenes/:id', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const title = reqString(asBody(request.body), 'title', 200);
    return storyWrite(request, 'scene', id, async (tx) => {
      await tx.update(scene).set({ title, updatedAt: new Date() }).where(eq(scene.id, id));
    });
  });

  app.post('/api/scenes/:id/move', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const toChapter = checkId(body.chapterId);
    const requested = optInt(body, 'position', 1, 1000);
    if (requested === undefined) throw badRequest('invalid_position');
    return storyWrite(request, 'scene', id, async (tx, projectId) => {
      const current = (await tx.select().from(scene).where(eq(scene.id, id)).limit(1))[0]!;
      const target = (await tx.select().from(chapter).where(and(eq(chapter.id, toChapter), eq(chapter.projectId, projectId))).limit(1))[0];
      if (!target) throw new HttpError(404, 'not_found');
      const same = toChapter === current.chapterId;
      const n = await sceneCount(tx, toChapter);
      if (!same && n >= MAX_SCENES) throw new HttpError(400, 'too_many_scenes', 'A chapter holds at most 99 scenes.');
      const position = Math.min(same ? n : n + 1, Math.max(1, requested));
      if (same && position === current.position) return;
      await parkRow(tx, 'scene', id);
      await closeGap(tx, 'scene', current.chapterId, current.position);
      await openGap(tx, 'scene', toChapter, position);
      await tx.update(scene).set({ chapterId: toChapter, position, updatedAt: new Date() }).where(eq(scene.id, id));
    });
  });

  app.delete('/api/scenes/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return storyWrite(request, 'scene', id, async (tx) => {
      const current = (await tx.select().from(scene).where(eq(scene.id, id)).limit(1))[0]!;
      await tx.delete(scene).where(eq(scene.id, id));
      await closeGap(tx, 'scene', current.chapterId, current.position);
    });
  });

  // ---- scene content --------------------------------------------------------------------

  app.get('/api/scenes/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessToEntity(db, userId(request), 'scene', id);
      return sceneContent(db, id);
    });
  });

  /** Runs a write inside a scene and answers with the scene's content. */
  async function sceneWrite(
    request: { account?: { id: string } },
    kind: 'scene' | 'segment' | 'cue',
    id: string,
    fn: (tx: Tx, sceneId: string) => Promise<Record<string, unknown> | void>,
  ) {
    return inTransaction(async (tx) => {
      const access = await accessToEntity(tx, userId(request), kind, id, { edit: true });
      let sceneId = id;
      if (kind === 'segment') sceneId = (await tx.select({ s: segment.sceneId }).from(segment).where(eq(segment.id, id)).limit(1))[0]!.s;
      if (kind === 'cue') {
        sceneId = (await tx
          .select({ s: segment.sceneId })
          .from(cue)
          .innerJoin(segment, eq(segment.id, cue.segmentId))
          .where(eq(cue.id, id))
          .limit(1))[0]!.s;
      }
      const extra = (await fn(tx, sceneId)) ?? {};
      await touchProject(tx, access.projectId, userId(request));
      return { ...(await sceneContent(tx, sceneId)), ...extra };
    });
  }

  app.post('/api/scenes/:id/segments', small, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const label = optString(asBody(request.body), 'label', 100, { allowNull: true });
    const result = await sceneWrite(request, 'scene', id, async (tx) => ({ created: await newSegment(tx, id, undefined, label || null) }));
    return reply.code(201).send(result);
  });

  app.post('/api/segments/:id/split', small, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const beforeCueId = checkId(asBody(request.body).beforeCueId);
    const result = await sceneWrite(request, 'segment', id, async (tx) => ({ created: await splitSegment(tx, id, beforeCueId) }));
    return reply.code(201).send(result);
  });

  app.patch('/api/segments/:id', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const label = optString(asBody(request.body), 'label', 100, { allowNull: true });
    if (label === undefined) throw badRequest('invalid_label');
    return sceneWrite(request, 'segment', id, async (tx) => {
      await tx.update(segment).set({ label: label || null, updatedAt: new Date() }).where(eq(segment.id, id));
    });
  });

  app.post('/api/segments/:id/merge-previous', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return sceneWrite(request, 'segment', id, (tx) => mergeWithPrevious(tx, id));
  });

  app.delete('/api/segments/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return sceneWrite(request, 'segment', id, (tx) => deleteSegment(tx, id));
  });

  // ---- cues -------------------------------------------------------------------------

  app.post('/api/segments/:id/cues', { ...auth, bodyLimit: 65536 }, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const patch = readCuePatch(body);
    const afterCueId = body.afterCueId === undefined || body.afterCueId === null ? null : checkId(body.afterCueId);
    const result = await sceneWrite(request, 'segment', id, async (tx) => {
      const created = await insertCue(tx, id, { afterCueId, type: patch.type, characterId: patch.characterId, text: patch.text }, userId(request));
      return { created: created.id };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/cues/:id', { ...auth, bodyLimit: 65536 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const patch = readCuePatch(asBody(request.body));
    return sceneWrite(request, 'cue', id, async (tx) => {
      await updateCue(tx, id, patch);
    });
  });

  app.post('/api/cues/:id/move', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const segmentId = checkId(body.segmentId);
    const afterCueId = body.afterCueId === undefined || body.afterCueId === null ? null : checkId(body.afterCueId);
    return sceneWrite(request, 'cue', id, async (tx) => {
      await moveCue(tx, id, segmentId, afterCueId);
    });
  });

  app.delete('/api/cues/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return sceneWrite(request, 'cue', id, async (tx) => {
      await deleteCue(tx, id);
    });
  });

  // ---- lanes ------------------------------------------------------------------------

  app.patch('/api/lanes/:id', small, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const title = 'title' in body ? reqString(body, 'title', 100) : undefined;
    const colour = optString(body, 'colour', 7);
    if (colour !== undefined && (colour === null || !/^#[0-9a-fA-F]{6}$/.test(colour))) throw badRequest('invalid_colour');
    const row = (await withDb((db) => db.select().from(lane).where(eq(lane.id, id)).limit(1)))[0];
    if (!row) throw new HttpError(404, 'not_found');
    return sceneWrite(request, 'scene', row.sceneId, async (tx) => {
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
