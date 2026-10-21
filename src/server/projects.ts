import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, inArray, isNull, like, max, ne, notInArray, sql, sum } from 'drizzle-orm';
import { inTransaction, withDb, type Q, type Tx } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { touchProject } from '../db/touch.js';
import { isAdminEmail, normalizeEmail } from '../auth/accounts.js';
import { asset, chapter, character, cue, membership, note, project, segment, scene, snapshot, teamMember, user } from '../db/schema.js';
import { NARRATOR_COLOUR } from '../shared/palette.js';
import { LANGUAGES, languageProfile } from '../shared/languages.js';
import { accessTo, checkId, levelOf } from './access.js';
import { authenticate } from './auth-routes.js';
import { blobStore } from '../storage/blob-store.js';
import { createCharacter } from './characters.js';
import { createSegment, insertCue, narratorOf } from './content.js';
import { HttpError, asBody, badRequest, forbidden, optString, reqString } from './http.js';

export const PROJECT_TYPES = ['audiobook', 'textbook', 'film', 'series', 'podcast'] as const;
type ProjectType = (typeof PROJECT_TYPES)[number];

const FOLDER_MAX = 80;

/** A repo folder name suggested by the title: unsafe characters removed, at most 80 characters, unique ignoring case. */
export async function suggestRepoFolder(q: Q, title: string): Promise<string> {
  const clean =
    title
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, FOLDER_MAX)
      .trim() || 'Untitled';
  const rows = await q.select({ f: project.repoFolder }).from(project);
  const taken = new Set(rows.map((r) => (r.f ?? '').toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let n = 2; n < 10000; n++) {
    const suffix = ` ${n}`;
    const candidate = clean.slice(0, FOLDER_MAX - suffix.length).trim() + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return clean + ' ' + newUlid().slice(-6);
}

function levelName(role: string): 'author' | 'viewer' {
  return levelOf(role);
}

// ---- projects ---------------------------------------------------------------------

async function cards(q: Q, userId: string, onlyProjectId?: string) {
  const mine = await q
    .select({ projectId: membership.projectId, role: membership.role })
    .from(membership)
    .where(and(eq(membership.userId, userId), onlyProjectId ? eq(membership.projectId, onlyProjectId) : undefined));
  if (mine.length === 0) return [];
  const ids = mine.map((m) => m.projectId);
  const projects = await q.select().from(project).where(inArray(project.id, ids));
  const chapterCounts = await q
    .select({ projectId: chapter.projectId, n: count() })
    .from(chapter)
    .where(inArray(chapter.projectId, ids))
    .groupBy(chapter.projectId);
  const lastSnaps = await q
    .select({ projectId: snapshot.projectId, at: max(snapshot.createdAt) })
    .from(snapshot)
    .where(inArray(snapshot.projectId, ids))
    .groupBy(snapshot.projectId);
  const sizes = await q
    .select({ projectId: asset.projectId, size: sum(asset.size), light: sum(asset.sizeLightweight) })
    .from(asset)
    .where(inArray(asset.projectId, ids))
    .groupBy(asset.projectId);
  const comments = await q
    .select({ projectId: note.projectId, n: count() })
    .from(note)
    .where(and(inArray(note.projectId, ids), eq(note.type, 'comment'), isNull(note.rootNoteId), isNull(note.deletedAt)))
    .groupBy(note.projectId);
  const tasks = await q
    .select({ projectId: note.projectId, n: count() })
    .from(note)
    .where(and(inArray(note.projectId, ids), eq(note.type, 'task'), isNull(note.doneAt), isNull(note.deletedAt)))
    .groupBy(note.projectId);
  const by = <T extends { projectId: string }>(rows: T[]) => new Map(rows.map((r) => [r.projectId, r]));
  const cc = by(chapterCounts);
  const ls = by(lastSnaps);
  const sz = by(sizes);
  const cm = by(comments);
  const tk = by(tasks);
  const role = new Map(mine.map((m) => [m.projectId, m.role]));
  return projects.map((p) => ({
    id: p.id,
    type: p.type,
    title: p.title,
    subtitle: p.subtitle,
    language: p.language,
    role: levelName(role.get(p.id)!),
    createdAt: p.createdAt.toISOString(),
    lastEditedAt: p.lastEditedAt ? p.lastEditedAt.toISOString() : null,
    dirtySince: p.dirtySince ? p.dirtySince.toISOString() : null,
    lastSnapshotAt: ls.get(p.id)?.at ? new Date(ls.get(p.id)!.at as Date).toISOString() : null,
    chapterCount: Number(cc.get(p.id)?.n ?? 0),
    sizeBytes: Number(sz.get(p.id)?.size ?? 0) + Number(sz.get(p.id)?.light ?? 0),
    commentCount: Number(cm.get(p.id)?.n ?? 0),
    openTaskCount: Number(tk.get(p.id)?.n ?? 0),
    coverAssetId: p.coverAssetId,
    repoFolder: p.repoFolder,
  }));
}

/** New media project: the project, the author membership, the Narrator and one chapter, segment, scene and empty cue. */
export async function createProject(
  tx: Tx,
  userId: string,
  input: { type: ProjectType; title: string; subtitle: string | null; language: string },
): Promise<string> {
  const now = new Date();
  const id = newUlid();
  await tx.insert(project).values({
    id,
    type: input.type,
    title: input.title,
    subtitle: input.subtitle,
    language: input.language,
    revision: 0,
    repoFolder: await suggestRepoFolder(tx, input.title),
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(membership).values({ userId, projectId: id, role: 'author', createdAt: now });
  await createCharacter(tx, id, { name: 'Narrator', colour: NARRATOR_COLOUR, isNarrator: true });
  const chapterId = newUlid();
  await tx.insert(chapter).values({ id: chapterId, projectId: id, position: 1, title: 'Chapter 1', introductory: false, createdAt: now, updatedAt: now });
  const segmentId = await createSegment(tx, chapterId, 'Segment 1', 1);
  const seg = await tx.select({ id: scene.id }).from(scene).where(eq(scene.segmentId, segmentId)).limit(1);
  await insertCue(tx, seg[0]!.id, {}, userId); // Narrator, speech, empty text
  await touchProject(tx, id, userId);
  void narratorOf;
  return id;
}

function readType(body: Record<string, unknown>): ProjectType {
  const v = body.type;
  if (typeof v !== 'string' || !(PROJECT_TYPES as readonly string[]).includes(v)) throw badRequest('invalid_type');
  return v as ProjectType;
}

function readLanguage(body: Record<string, unknown>): string {
  const v = body.language;
  if (typeof v !== 'string' || !languageProfile(v)) throw badRequest('invalid_language');
  return v;
}

export function registerProjectRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };

  app.get('/api/languages', auth, async () => ({ languages: LANGUAGES }));

  app.get('/api/projects', auth, async (request) => {
    const list = await withDb((db) => cards(db, request.account!.id));
    list.sort((a, b) => (b.lastEditedAt ?? b.createdAt).localeCompare(a.lastEditedAt ?? a.createdAt));
    return { projects: list };
  });

  app.post('/api/projects', { ...auth, bodyLimit: 8192 }, async (request, reply) => {
    if (request.account!.isAdmin) throw new HttpError(403, 'admin_cannot_create', 'The admin account cannot create media projects.');
    const body = asBody(request.body);
    const input = {
      type: readType(body),
      title: reqString(body, 'title', 200),
      subtitle: (optString(body, 'subtitle', 200, { allowNull: true }) || null) as string | null,
      language: readLanguage(body),
    };
    const id = await inTransaction((tx) => createProject(tx, request.account!.id, input));
    const [card] = await withDb((db) => cards(db, request.account!.id, id));
    return reply.code(201).send(card);
  });

  app.get('/api/projects/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, id);
      const [card] = await cards(db, request.account!.id, id);
      return card;
    });
  });

  app.patch('/api/projects/:id', { ...auth, bodyLimit: 8192 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const title = 'title' in body ? reqString(body, 'title', 200) : undefined;
    const subtitle = optString(body, 'subtitle', 200, { allowNull: true });
    const language = 'language' in body ? readLanguage(body) : undefined;
    return inTransaction(async (tx) => {
      await accessTo(tx, request.account!.id, id, { edit: true });
      const set: Partial<typeof project.$inferInsert> = { updatedAt: new Date() };
      if (title !== undefined) set.title = title;
      if (subtitle !== undefined) set.subtitle = subtitle === '' ? null : subtitle;
      if (language !== undefined) set.language = language;
      await tx.update(project).set(set).where(eq(project.id, id));
      await touchProject(tx, id, request.account!.id);
      const [card] = await cards(tx, request.account!.id, id);
      return card;
    });
  });

  // The ordered delete (Bible, section 5): no single cascade, because RESTRICT keys such as clip to asset
  // may fail inside one. Files on disk are the library's concern and come with the library.
  app.delete('/api/projects/:id', { ...auth, bodyLimit: 4096 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const deleteFiles = body.deleteFiles === true;
    const result = await inTransaction(async (tx) => {
      await accessTo(tx, request.account!.id, id, { edit: true });
      const row = (await tx.select().from(project).where(eq(project.id, id)).limit(1))[0]!;
      if (body.confirmTitle !== row.title) throw new HttpError(400, 'confirm_title', 'Type the title of the media project to confirm.');
      await tx.delete(note).where(eq(note.projectId, id));
      await tx.delete(chapter).where(eq(chapter.projectId, id)); // segments, scenes, lanes, cues and clips cascade
      await tx.delete(character).where(eq(character.projectId, id));
      await tx.update(project).set({ coverAssetId: null }).where(eq(project.id, id));
      await tx.delete(asset).where(eq(asset.projectId, id));
      await tx.delete(snapshot).where(eq(snapshot.projectId, id));
      await tx.delete(membership).where(eq(membership.projectId, id));
      await tx.delete(project).where(eq(project.id, id));
      return { ok: true };
    });
    // Files on disk go only when the author chose so; otherwise they stay in the library folder.
    if (deleteFiles) await blobStore().removeProject(id).catch((e) => request.log.error(e));
    return result;
  });

  // ---- members ----------------------------------------------------------------------

  app.get('/api/projects/:id/members', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, id);
      const rows = await db
        .select({ userId: user.id, name: user.displayName, email: user.email, role: membership.role, addedAt: membership.createdAt })
        .from(membership)
        .innerJoin(user, eq(user.id, membership.userId))
        .where(eq(membership.projectId, id))
        .orderBy(asc(membership.createdAt), asc(user.email));
      return { members: rows.map((r) => ({ userId: r.userId, name: r.name, email: r.email, role: levelName(r.role), addedAt: r.addedAt.toISOString() })) };
    });
  });

  // Users who share a team with the author, not yet members; two characters or more.
  app.get('/api/projects/:id/user-search', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const q = String((request.query as { q?: string }).q ?? '').trim();
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, id, { edit: true });
      if (q.length < 2) return { users: [], tooShort: true };
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      const members = db.select({ id: membership.userId }).from(membership).where(eq(membership.projectId, id));
      const myTeams = db.select({ id: teamMember.teamId }).from(teamMember).where(eq(teamMember.userId, request.account!.id));
      const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
      const rows = await db
        .selectDistinct({ id: user.id, name: user.displayName, email: user.email })
        .from(user)
        .innerJoin(teamMember, eq(teamMember.userId, user.id))
        .where(
          and(
            isNull(user.disabledAt),
            notInArray(user.id, members),
            inArray(teamMember.teamId, myTeams),
            adminEmail ? ne(user.email, adminEmail) : undefined,
            sql`(${user.displayName} LIKE ${pattern} OR ${user.email} LIKE ${pattern})`,
          ),
        )
        .orderBy(asc(user.displayName))
        .limit(10);
      return { users: rows.filter((r) => !isAdminEmail(r.email)) };
    });
  });

  async function authorCount(q: Q, projectId: string): Promise<number> {
    const rows = await q
      .select({ n: count() })
      .from(membership)
      .where(and(eq(membership.projectId, projectId), inArray(membership.role, ['author', 'owner'])));
    return Number(rows[0]?.n ?? 0);
  }

  app.put('/api/projects/:id/members/:userId', { ...auth, bodyLimit: 1024 }, async (request) => {
    const params = request.params as { id: string; userId: string };
    const id = checkId(params.id);
    const userId = checkId(params.userId);
    const role = asBody(request.body).role;
    if (role !== 'author' && role !== 'viewer') throw badRequest('invalid_role');
    return inTransaction(async (tx) => {
      await accessTo(tx, request.account!.id, id, { edit: true });
      const existing = (await tx
        .select()
        .from(membership)
        .where(and(eq(membership.userId, userId), eq(membership.projectId, id)))
        .limit(1))[0];
      if (existing) {
        if (levelOf(existing.role) === 'author' && role === 'viewer' && (await authorCount(tx, id)) <= 1) {
          throw new HttpError(409, 'last_author', 'The last author cannot be demoted.');
        }
        await tx
          .update(membership)
          .set({ role: role === 'author' ? 'author' : 'reader' })
          .where(and(eq(membership.userId, userId), eq(membership.projectId, id)));
        return { ok: true };
      }
      // Adding: only a user the author can find (shares a team), enabled, not the admin.
      const target = (await tx.select().from(user).where(eq(user.id, userId)).limit(1))[0];
      if (!target || target.disabledAt || isAdminEmail(target.email)) throw new HttpError(404, 'not_found');
      const shared = await tx
        .select({ t: teamMember.teamId })
        .from(teamMember)
        .where(
          and(
            eq(teamMember.userId, userId),
            inArray(teamMember.teamId, tx.select({ id: teamMember.teamId }).from(teamMember).where(eq(teamMember.userId, request.account!.id))),
          ),
        )
        .limit(1);
      if (shared.length === 0) throw new HttpError(404, 'not_found');
      await tx.insert(membership).values({ userId, projectId: id, role: role === 'author' ? 'author' : 'reader', createdAt: new Date() });
      return { ok: true };
    });
  });

  app.delete('/api/projects/:id/members/:userId', auth, async (request) => {
    const params = request.params as { id: string; userId: string };
    const id = checkId(params.id);
    const userId = checkId(params.userId);
    return inTransaction(async (tx) => {
      await accessTo(tx, request.account!.id, id, { edit: true });
      const existing = (await tx
        .select()
        .from(membership)
        .where(and(eq(membership.userId, userId), eq(membership.projectId, id)))
        .limit(1))[0];
      if (!existing) throw new HttpError(404, 'not_found');
      if (levelOf(existing.role) === 'author' && (await authorCount(tx, id)) <= 1) {
        throw new HttpError(409, 'last_author', 'The last author cannot be removed.');
      }
      await tx.delete(membership).where(and(eq(membership.userId, userId), eq(membership.projectId, id)));
      return { ok: true };
    });
  });

  void desc;
  void forbidden;
}
