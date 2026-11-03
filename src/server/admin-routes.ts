import type { FastifyInstance } from 'fastify';
import {
  ROLES,
  createUser,
  isDuplicateKey,
  soleAuthorProjects,
  findUserById,
  generateTemporaryPassword,
  listProjects,
  listUsers,
  normalizeEmail,
  setDisabled,
  setPassword,
} from '../auth/accounts.js';
import { asc, and, eq } from 'drizzle-orm';
import { ULID_PATTERN, newUlid } from '../db/ids.js';
import { team, teamMember, user } from '../db/schema.js';
import { withDb } from '../db/client.js';
import { authenticate, bodyString, requireAdmin } from './auth-routes.js';
import { GitHubVersionStore, REPO_PATTERN } from '../snapshot/version-store.js';
import { SNAPSHOT_BRANCH, SNAPSHOT_REPO, SNAPSHOT_REPO_TOKEN, encryptSecret, putSetting, snapshotSettings } from '../settings/settings.js';
import { sessionConfigured } from '../auth/session.js';
import { HttpError, asBody } from './http.js';

const adminOnly = [authenticate(), requireAdmin];

/** Account management for the admin (the account named by ADMIN_EMAIL). */
export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/users', { preHandler: adminOnly }, async () => ({
    users: await withDb(listUsers),
    projects: await withDb(listProjects),
    roles: ROLES,
  }));

  app.post('/api/admin/users', { preHandler: adminOnly, bodyLimit: 4096 }, async (request, reply) => {
    const email = normalizeEmail(bodyString(request.body, 'email'));
    const displayName = bodyString(request.body, 'displayName')?.trim();
    if (!email) return reply.code(400).send({ error: 'invalid_email' });
    if (!displayName || displayName.length > 100) return reply.code(400).send({ error: 'invalid_display_name' });
    const temporaryPassword = generateTemporaryPassword();
    const created = await withDb((db) =>
      createUser(db, { email, displayName, password: temporaryPassword, mustChangePassword: true }),
    );
    if (!created) return reply.code(409).send({ error: 'email_taken' });
    return reply.code(201).send({ id: created.id, email, temporaryPassword });
  });

  app.post('/api/admin/users/:id/reset-password', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ULID_PATTERN.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    const temporaryPassword = generateTemporaryPassword();
    const found = await withDb(async (db) => {
      const row = await findUserById(db, id);
      if (!row) return false;
      await setPassword(db, id, temporaryPassword, true);
      return true;
    });
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return { temporaryPassword };
  });

  app.post('/api/admin/users/:id/disabled', { preHandler: adminOnly, bodyLimit: 1024 }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const disabled = (request.body as { disabled?: unknown } | null)?.disabled;
    if (!ULID_PATTERN.test(id) || typeof disabled !== 'boolean') return reply.code(400).send({ error: 'invalid_request' });
    if (id === request.account!.id) return reply.code(400).send({ error: 'cannot_disable_yourself' });
    const found = await withDb(async (db) => {
      if (!(await findUserById(db, id))) return false;
      if (disabled) {
        const blocking = await soleAuthorProjects(db, id);
        if (blocking.length > 0) return blocking;
      }
      await setDisabled(db, id, disabled);
      return true;
    });
    if (Array.isArray(found)) return reply.code(409).send({ error: 'last_author', projects: found });
    return found ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  // ---- teams: who may find whom when adding project members -------------------------------

  app.get('/api/admin/teams', { preHandler: adminOnly }, async () =>
    withDb(async (db) => {
      const teams = await db.select().from(team).orderBy(asc(team.name));
      const members = await db
        .select({ teamId: teamMember.teamId, id: user.id, email: user.email, displayName: user.displayName })
        .from(teamMember)
        .innerJoin(user, eq(user.id, teamMember.userId))
        .orderBy(asc(user.email));
      return { teams: teams.map((t) => ({ id: t.id, name: t.name, members: members.filter((m) => m.teamId === t.id).map(({ teamId: _t, ...m }) => m) })) };
    }),
  );

  app.post('/api/admin/teams', { preHandler: adminOnly, bodyLimit: 1024 }, async (request, reply) => {
    const name = bodyString(request.body, 'name')?.trim();
    if (!name || name.length > 100) return reply.code(400).send({ error: 'invalid_request' });
    const now = new Date();
    const id = newUlid();
    try {
      await withDb((db) => db.insert(team).values({ id, name, createdAt: now, updatedAt: now }));
    } catch (err) {
      if (isDuplicateKey(err)) return reply.code(409).send({ error: 'name_taken' });
      throw err;
    }
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/teams/:id', { preHandler: adminOnly, bodyLimit: 1024 }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const name = bodyString(request.body, 'name')?.trim();
    if (!ULID_PATTERN.test(id) || !name || name.length > 100) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await withDb((db) => db.update(team).set({ name, updatedAt: new Date() }).where(eq(team.id, id)));
    } catch (err) {
      if (isDuplicateKey(err)) return reply.code(409).send({ error: 'name_taken' });
      throw err;
    }
    return { ok: true };
  });

  app.delete('/api/admin/teams/:id', { preHandler: adminOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ULID_PATTERN.test(id)) return reply.code(400).send({ error: 'invalid_request' });
    await withDb((db) => db.delete(team).where(eq(team.id, id)));
    return { ok: true };
  });

  app.put('/api/admin/teams/:id/members/:userId', { preHandler: adminOnly }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    if (!ULID_PATTERN.test(id) || !ULID_PATTERN.test(userId)) return reply.code(400).send({ error: 'invalid_request' });
    const ok = await withDb(async (db) => {
      const t = await db.select({ id: team.id }).from(team).where(eq(team.id, id)).limit(1);
      if (t.length === 0 || !(await findUserById(db, userId))) return false;
      await db.insert(teamMember).ignore().values({ teamId: id, userId });
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/api/admin/teams/:id/members/:userId', { preHandler: adminOnly }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    if (!ULID_PATTERN.test(id) || !ULID_PATTERN.test(userId)) return reply.code(400).send({ error: 'invalid_request' });
    await withDb((db) => db.delete(teamMember).where(and(eq(teamMember.teamId, id), eq(teamMember.userId, userId))));
    return { ok: true };
  });

  // ---- snapshot repository (saved in the app; the environment variables are the fallback) ----
  const snapshotView = async () => {
    const c = await snapshotSettings();
    return { repo: c.repo, branch: c.branch, tokenSet: c.token !== null, tokenUnreadable: c.tokenUnreadable, source: c.source, canStoreToken: sessionConfigured() };
  };

  app.get('/api/admin/settings/snapshots', { preHandler: adminOnly }, async () => snapshotView());

  app.put('/api/admin/settings/snapshots', { preHandler: adminOnly, bodyLimit: 4096 }, async (request) => {
    const b = asBody(request.body);
    const text = (k: string, max: number) => {
      const v = b[k];
      if (v === undefined) return undefined;
      if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `invalid_${k}`, `The ${k} is not valid.`);
      return v.trim();
    };
    const repo = text('repo', 200);
    const branch = text('branch', 200);
    const token = text('token', 500);
    if (repo && !REPO_PATTERN.test(repo)) throw new HttpError(400, 'invalid_repo', 'The repository must be written owner/name, for example kalleoferraz/media-projects.');
    if (branch && !/^[\w./-]+$/.test(branch)) throw new HttpError(400, 'invalid_branch', 'The branch name has characters that are not allowed.');
    if (token && !sessionConfigured()) throw new HttpError(400, 'cannot_store_token', 'The token cannot be stored: SESSION_SECRET is missing on this server.');
    await withDb(async (db) => {
      if (repo !== undefined) await putSetting(db, SNAPSHOT_REPO, repo || null);
      if (branch !== undefined) await putSetting(db, SNAPSHOT_BRANCH, branch || null);
      if (b.clearToken === true) await putSetting(db, SNAPSHOT_REPO_TOKEN, null);
      else if (token) await putSetting(db, SNAPSHOT_REPO_TOKEN, encryptSecret(token));
    });
    return snapshotView();
  });

  // Tries the settings against GitHub. Values in the body (not saved yet) replace the saved ones for this test.
  app.post('/api/admin/settings/snapshots/test', { preHandler: adminOnly, bodyLimit: 4096 }, async (request) => {
    const b = asBody(request.body);
    const c = await snapshotSettings();
    const str = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim() : null);
    const repo = str('repo') ?? c.repo;
    const token = str('token') ?? c.token;
    const branch = b.branch === undefined ? c.branch : str('branch');
    const m = repo ? REPO_PATTERN.exec(repo) : null;
    if (!m) return { ok: false, message: repo ? 'The repository must be written owner/name.' : 'No repository is set.' };
    if (!token) return { ok: false, message: c.tokenUnreadable ? 'The saved token can no longer be read: enter it again.' : 'No token is set.' };
    return new GitHubVersionStore(m[1]!, m[2]!, token, branch ?? undefined).check();
  });
}
