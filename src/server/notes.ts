/**
 * Notes: comments, references and tasks on the media project, a chapter, a segment, a scene, a cue or an
 * asset, and flat reply threads (Bible, section 5: Notes, References, Tasks; decisions of 2026-10-22).
 * Rules enforced here, not by the database: a reply is always a comment with no target, ref key, link or
 * done fields; a root note has no target (the media project) or exactly one; a reference needs a ref key,
 * unique per media project; a link is an http or https URL; only a user-kind author edits or deletes a note;
 * a note with replies is tombstoned instead of deleted; any author can check or uncheck a task.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { inTransaction, withDb, type Q, type Tx } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { touchProject } from '../db/touch.js';
import { asset, chapter, cue, note, scene, segment, user } from '../db/schema.js';
import { accessTo, checkId, projectOf, type EntityKind } from './access.js';
import { authenticate } from './auth-routes.js';
import { HttpError, asBody, badRequest, notFound, optString, reqString } from './http.js';

export const NOTE_TEXT_MAX = 20000;
export const REF_KEY_MAX = 24;
export const LINK_MAX = 2048;

const TARGET_KINDS = ['chapter', 'segment', 'scene', 'cue', 'asset'] as const;
type TargetKind = (typeof TARGET_KINDS)[number];
const TARGET_COLUMN = {
  chapter: 'chapterId',
  segment: 'segmentId',
  scene: 'sceneId',
  cue: 'cueId',
  asset: 'assetId',
} as const;

/** A stored link must be an absolute http or https URL (never javascript: or data:). */
export function checkLink(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest('invalid_link', 'The link must be a full web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('invalid_link', 'The link must start with http:// or https://.');
  }
  return value;
}

const author = alias(user, 'note_author');
const doneBy = alias(user, 'note_done_by');

/** Where a root note sits in the script, so the client can group notes without loading every segment. */
export interface Place {
  chapterId: string | null;
  segmentId: string | null;
  sceneId: string | null;
  cueId: string | null;
  assetId: string | null;
  /** A short name for the target: a scene's title, a cue's text, an asset's path. */
  label: string | null;
  sceneNo: number | null;
  cueStartMs: number | null;
}

const emptyPlace = (): Place => ({ chapterId: null, segmentId: null, sceneId: null, cueId: null, assetId: null, label: null, sceneNo: null, cueStartMs: null });

async function placesFor(q: Q, rows: (typeof note.$inferSelect)[]): Promise<Map<string, Place>> {
  const out = new Map<string, Place>();
  const ids = (key: 'chapterId' | 'segmentId' | 'sceneId' | 'cueId' | 'assetId') => [...new Set(rows.map((r) => r[key]).filter((v): v is string => !!v))];
  const cueIds = ids('cueId'), sceneIds = ids('sceneId'), segIds = ids('segmentId'), assetIds = ids('assetId');
  const cues = cueIds.length
    ? await q
        .select({ id: cue.id, text: cue.textMd, start: cue.startMs, sceneId: scene.id, sceneNo: scene.position, segmentId: segment.id, chapterId: segment.chapterId })
        .from(cue)
        .innerJoin(scene, eq(scene.id, cue.sceneId))
        .innerJoin(segment, eq(segment.id, scene.segmentId))
        .where(inArray(cue.id, cueIds))
    : [];
  const scenes = sceneIds.length
    ? await q
        .select({ id: scene.id, label: scene.label, no: scene.position, segmentId: segment.id, chapterId: segment.chapterId })
        .from(scene)
        .innerJoin(segment, eq(segment.id, scene.segmentId))
        .where(inArray(scene.id, sceneIds))
    : [];
  const segs = segIds.length ? await q.select({ id: segment.id, chapterId: segment.chapterId }).from(segment).where(inArray(segment.id, segIds)) : [];
  const assets = assetIds.length ? await q.select({ id: asset.id, path: asset.path }).from(asset).where(inArray(asset.id, assetIds)) : [];
  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  const cm = byId(cues), sm = byId(scenes), gm = byId(segs), am = byId(assets);
  for (const r of rows) {
    const p = emptyPlace();
    if (r.cueId && cm.has(r.cueId)) {
      const c = cm.get(r.cueId)!;
      Object.assign(p, { cueId: c.id, sceneId: c.sceneId, segmentId: c.segmentId, chapterId: c.chapterId, sceneNo: c.sceneNo, cueStartMs: c.start, label: c.text.replace(/\s+/g, ' ').trim().slice(0, 60) || null });
    } else if (r.sceneId && sm.has(r.sceneId)) {
      const c = sm.get(r.sceneId)!;
      Object.assign(p, { sceneId: c.id, segmentId: c.segmentId, chapterId: c.chapterId, sceneNo: c.no, label: c.label });
    } else if (r.segmentId && gm.has(r.segmentId)) {
      const c = gm.get(r.segmentId)!;
      Object.assign(p, { segmentId: c.id, chapterId: c.chapterId });
    } else if (r.chapterId) {
      p.chapterId = r.chapterId;
    } else if (r.assetId && am.has(r.assetId)) {
      Object.assign(p, { assetId: r.assetId, label: am.get(r.assetId)!.path });
    }
    out.set(r.id, p);
  }
  return out;
}

async function loadView(q: Q, where: ReturnType<typeof eq>) {
  const rows = await q
    .select({
      n: note,
      authorName: author.displayName,
      doneByName: doneBy.displayName,
    })
    .from(note)
    .leftJoin(author, eq(author.id, note.authorUserId))
    .leftJoin(doneBy, eq(doneBy.id, note.doneByUserId))
    .where(where)
    .orderBy(asc(note.createdAt), asc(note.id));
  const places = await placesFor(q, rows.map((r) => r.n));
  return rows.map(({ n, authorName, doneByName }) => view(n, authorName, doneByName, places.get(n.id) ?? emptyPlace()));
}

function view(n: typeof note.$inferSelect, authorName: string | null, doneByName: string | null, place: Place) {
  let target: { kind: TargetKind; id: string } | null = null;
  for (const kind of TARGET_KINDS) {
    const id = n[TARGET_COLUMN[kind]];
    if (id) target = { kind, id };
  }
  return {
    id: n.id,
    type: n.type,
    textMd: n.textMd,
    refKey: n.refKey,
    link: n.link,
    authorKind: n.authorKind,
    author: n.authorUserId ? { id: n.authorUserId, name: authorName ?? '' } : null,
    doneAt: n.doneAt ? n.doneAt.toISOString() : null,
    doneBy: n.doneByUserId ? { id: n.doneByUserId, name: doneByName ?? '' } : null,
    target,
    place,
    rootNoteId: n.rootNoteId,
    replyToNoteId: n.replyToNoteId,
    createdAt: n.createdAt.toISOString(),
    editedAt: n.editedAt ? n.editedAt.toISOString() : null,
    deleted: n.deletedAt !== null,
  };
}

async function noteRow(q: Q, id: string) {
  const rows = await q.select().from(note).where(eq(note.id, id)).limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

/** Ref keys are unique per media project, ignoring case and accents (the column's collation decides). */
async function assertRefKeyFree(q: Q, projectId: string, refKey: string, exceptId?: string): Promise<void> {
  const taken = await q
    .select({ id: note.id })
    .from(note)
    .where(exceptId ? and(eq(note.projectId, projectId), eq(note.refKey, refKey), ne(note.id, exceptId)) : and(eq(note.projectId, projectId), eq(note.refKey, refKey)))
    .limit(1);
  if (taken[0]) throw new HttpError(409, 'ref_key_taken', `The key "${refKey}" is already used in this media project.`);
}

async function resolveTarget(q: Q, projectId: string, raw: unknown): Promise<{ kind: TargetKind; id: string } | null> {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('invalid_target');
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  if (typeof kind !== 'string' || !(TARGET_KINDS as readonly string[]).includes(kind)) throw badRequest('invalid_target');
  const targetId = checkId(id);
  if (kind === 'asset') {
    const rows = await q.select({ projectId: asset.projectId }).from(asset).where(eq(asset.id, targetId)).limit(1);
    if (!rows[0] || rows[0].projectId !== projectId) throw notFound();
  } else if ((await projectOf(q, kind as EntityKind, targetId)) !== projectId) {
    throw notFound();
  }
  return { kind: kind as TargetKind, id: targetId };
}

function readRefFields(body: Record<string, unknown>): { refKey: string | undefined; link: string | null | undefined } {
  const refKey = 'refKey' in body ? reqString(body, 'refKey', REF_KEY_MAX) : undefined;
  const raw = optString(body, 'link', LINK_MAX, { allowNull: true });
  const link = raw === undefined || raw === null || raw === '' ? (raw === undefined ? undefined : null) : checkLink(raw);
  return { refKey, link };
}

export async function createNote(
  tx: Tx,
  projectId: string,
  authorUserId: string | null,
  authorKind: 'user' | 'system' | 'llm',
  body: Record<string, unknown>,
) {
  const now = new Date();
  const row: typeof note.$inferInsert = {
    id: newUlid(),
    projectId,
    authorUserId,
    authorKind,
    type: 'comment',
    textMd: '',
    createdAt: now,
  };
  if (body.replyTo !== undefined && body.replyTo !== null) {
    // A reply: always a comment, no target, ref key, link or done fields; the thread stays flat.
    if (body.type !== undefined && body.type !== 'comment') throw badRequest('invalid_type', 'A reply is always a comment.');
    if ('target' in body || 'refKey' in body || 'link' in body) throw badRequest('invalid_reply', 'A reply takes only text.');
    const parent = await noteRow(tx, checkId(body.replyTo));
    if (parent.projectId !== projectId) throw notFound();
    row.rootNoteId = parent.rootNoteId ?? parent.id;
    row.replyToNoteId = parent.id;
    row.textMd = reqString(body, 'textMd', NOTE_TEXT_MAX);
  } else {
    const type = body.type;
    if (type !== 'comment' && type !== 'reference' && type !== 'task') throw badRequest('invalid_type');
    row.type = type;
    const target = await resolveTarget(tx, projectId, body.target);
    if (target) row[TARGET_COLUMN[target.kind]] = target.id;
    const { refKey, link } = readRefFields(body);
    if (type === 'reference') {
      if (!refKey) throw badRequest('invalid_refKey', 'A reference needs a short key.');
      await assertRefKeyFree(tx, projectId, refKey);
      row.refKey = refKey;
      row.link = link ?? null;
      const text = optString(body, 'textMd', NOTE_TEXT_MAX) ?? '';
      if (!text && !row.link) throw badRequest('invalid_textMd', 'A reference needs a description or a link.');
      row.textMd = text;
    } else {
      if (refKey !== undefined || (link !== undefined && link !== null)) throw badRequest('invalid_note', 'Only a reference has a key and a link.');
      row.textMd = reqString(body, 'textMd', NOTE_TEXT_MAX);
    }
  }
  await tx.insert(note).values(row);
  return row.id!;
}

export function registerNoteRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };

  /** Every note of the media project (tombstones included), oldest first; the client builds the tree. */
  app.get('/api/projects/:id/notes', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId);
      return { notes: await loadView(db, eq(note.projectId, projectId)) };
    });
  });

  app.post('/api/projects/:id/notes', { ...auth, bodyLimit: 65536 }, async (request, reply) => {
    const projectId = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const created = await inTransaction(async (tx) => {
      await accessTo(tx, request.account!.id, projectId, { edit: true });
      const id = await createNote(tx, projectId, request.account!.id, 'user', body);
      await touchProject(tx, projectId, request.account!.id);
      return (await loadView(tx, eq(note.id, id)))[0]!;
    });
    return reply.code(201).send(created);
  });

  app.patch('/api/notes/:id', { ...auth, bodyLimit: 65536 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    return inTransaction(async (tx) => {
      const current = await noteRow(tx, id);
      await accessTo(tx, request.account!.id, current.projectId, { edit: true });
      if (current.deletedAt) throw new HttpError(409, 'deleted', 'This note was deleted.');
      if (current.authorKind !== 'user' || current.authorUserId !== request.account!.id) {
        throw new HttpError(403, 'not_author', 'Only the author can edit a note.');
      }
      if ('type' in body || 'target' in body || 'replyTo' in body) throw badRequest('immutable', 'The type and the target of a note do not change.');
      const set: Partial<typeof note.$inferInsert> = { editedAt: new Date() };
      const isReference = current.type === 'reference';
      if ('textMd' in body) set.textMd = isReference ? (optString(body, 'textMd', NOTE_TEXT_MAX) ?? '') : reqString(body, 'textMd', NOTE_TEXT_MAX);
      const { refKey, link } = readRefFields(body);
      if (!isReference && (refKey !== undefined || (link !== undefined && link !== null))) {
        throw badRequest('invalid_note', 'Only a reference has a key and a link.');
      }
      if (refKey !== undefined && refKey !== current.refKey) {
        await assertRefKeyFree(tx, current.projectId, refKey, id);
        set.refKey = refKey;
      }
      if (link !== undefined) set.link = link;
      if (isReference) {
        const text = set.textMd ?? current.textMd;
        const finalLink = link !== undefined ? link : current.link;
        if (!text && !finalLink) throw badRequest('invalid_textMd', 'A reference needs a description or a link.');
      }
      await tx.update(note).set(set).where(eq(note.id, id));
      await touchProject(tx, current.projectId, request.account!.id);
      return (await loadView(tx, eq(note.id, id)))[0]!;
    });
  });

  /** Deletes a note outright, or tombstones it when it has replies (text, ref key and link are cleared). */
  app.delete('/api/notes/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return inTransaction(async (tx) => {
      const current = await noteRow(tx, id);
      await accessTo(tx, request.account!.id, current.projectId, { edit: true });
      if (current.authorKind !== 'user' || current.authorUserId !== request.account!.id) {
        throw new HttpError(403, 'not_author', 'Only the author can delete a note.');
      }
      if (current.deletedAt) return { ok: true, tombstone: true };
      const replies = await tx.select({ id: note.id }).from(note).where(eq(note.rootNoteId, id)).limit(1);
      let tombstone = false;
      if (replies[0]) {
        await tx
          .update(note)
          .set({ deletedAt: new Date(), textMd: '', refKey: null, link: null })
          .where(eq(note.id, id));
        tombstone = true;
      } else {
        await tx.delete(note).where(eq(note.id, id));
      }
      await touchProject(tx, current.projectId, request.account!.id);
      return { ok: true, tombstone };
    });
  });

  /** Checks or unchecks a task; any author may do it (decided 2026-10-22). */
  app.post('/api/notes/:id/done', { ...auth, bodyLimit: 1024 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const done = asBody(request.body).done;
    if (typeof done !== 'boolean') throw badRequest('invalid_done');
    return inTransaction(async (tx) => {
      const current = await noteRow(tx, id);
      await accessTo(tx, request.account!.id, current.projectId, { edit: true });
      if (current.type !== 'task' || current.deletedAt || current.rootNoteId) throw badRequest('not_a_task', 'Only a task can be checked.');
      await tx
        .update(note)
        .set(done ? { doneAt: new Date(), doneByUserId: request.account!.id } : { doneAt: null, doneByUserId: null })
        .where(eq(note.id, id));
      await touchProject(tx, current.projectId, request.account!.id);
      return (await loadView(tx, eq(note.id, id)))[0]!;
    });
  });
}
