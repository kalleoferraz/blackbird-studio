import { and, eq } from 'drizzle-orm';
import type { Q } from '../db/client.js';
import { ULID_PATTERN } from '../db/ids.js';
import { chapter, cue, membership, segment, scene, character } from '../db/schema.js';
import { HttpError, notFound } from './http.js';

/** In v1 only authors edit; every other role is a viewer (Bible, section 5, Membership rules). */
export type Level = 'author' | 'viewer';

export function levelOf(role: string): Level {
  return role === 'author' || role === 'owner' ? 'author' : 'viewer';
}

export interface Access {
  projectId: string;
  role: string;
  level: Level;
  canEdit: boolean;
}

export function checkId(id: unknown): string {
  if (typeof id !== 'string' || !ULID_PATTERN.test(id)) throw new HttpError(404, 'not_found');
  return id;
}

/** The user's access to a media project, or a 404 (the admin and non-members learn nothing). */
export async function accessTo(q: Q, userId: string, projectId: string, { edit = false } = {}): Promise<Access> {
  const rows = await q
    .select({ role: membership.role })
    .from(membership)
    .where(and(eq(membership.userId, userId), eq(membership.projectId, projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound();
  const level = levelOf(row.role);
  if (edit && level !== 'author') throw new HttpError(403, 'read_only', 'Only authors can change this media project.');
  return { projectId, role: row.role, level, canEdit: level === 'author' };
}

export type EntityKind = 'chapter' | 'segment' | 'scene' | 'cue' | 'character';

/** The media project an entity belongs to (the tree tables carry no project_id), or a 404. */
export async function projectOf(q: Q, kind: EntityKind, id: string): Promise<string> {
  let rows: { projectId: string }[];
  switch (kind) {
    case 'chapter':
      rows = await q.select({ projectId: chapter.projectId }).from(chapter).where(eq(chapter.id, id)).limit(1);
      break;
    case 'segment':
      rows = await q
        .select({ projectId: chapter.projectId })
        .from(segment)
        .innerJoin(chapter, eq(chapter.id, segment.chapterId))
        .where(eq(segment.id, id))
        .limit(1);
      break;
    case 'scene':
      rows = await q
        .select({ projectId: chapter.projectId })
        .from(scene)
        .innerJoin(segment, eq(segment.id, scene.segmentId))
        .innerJoin(chapter, eq(chapter.id, segment.chapterId))
        .where(eq(scene.id, id))
        .limit(1);
      break;
    case 'cue':
      rows = await q
        .select({ projectId: chapter.projectId })
        .from(cue)
        .innerJoin(scene, eq(scene.id, cue.sceneId))
        .innerJoin(segment, eq(segment.id, scene.segmentId))
        .innerJoin(chapter, eq(chapter.id, segment.chapterId))
        .where(eq(cue.id, id))
        .limit(1);
      break;
    case 'character':
      rows = await q.select({ projectId: character.projectId }).from(character).where(eq(character.id, id)).limit(1);
      break;
  }
  const row = rows[0];
  if (!row) throw notFound();
  return row.projectId;
}

/** Resolves an entity to its project and checks the user's access in one step. */
export async function accessToEntity(q: Q, userId: string, kind: EntityKind, id: string, opts: { edit?: boolean } = {}): Promise<Access> {
  checkId(id);
  return accessTo(q, userId, await projectOf(q, kind, id), opts);
}
