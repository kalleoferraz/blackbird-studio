import type { FastifyInstance } from 'fastify';
import {
  ROLES,
  createUser,
  findUserById,
  generateTemporaryPassword,
  listProjects,
  listUsers,
  normalizeEmail,
  removeMembership,
  setDisabled,
  setMembership,
  setPassword,
  type Role,
} from '../auth/accounts.js';
import { ULID_PATTERN } from '../db/ids.js';
import { withDb } from '../db/client.js';
import { authenticate, bodyString, requireAdmin } from './auth-routes.js';

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
      await setDisabled(db, id, disabled);
      return true;
    });
    return found ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  app.put('/api/admin/users/:id/memberships/:projectId', { preHandler: adminOnly, bodyLimit: 1024 }, async (request, reply) => {
    const { id, projectId } = request.params as { id: string; projectId: string };
    const role = bodyString(request.body, 'role');
    if (!ULID_PATTERN.test(id) || !ULID_PATTERN.test(projectId) || !role || !(ROLES as readonly string[]).includes(role)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const result = await withDb(async (db) => {
      if (!(await findUserById(db, id))) return 'no_user';
      return (await setMembership(db, id, projectId, role as Role)) ? 'ok' : 'no_project';
    });
    if (result === 'ok') return { ok: true };
    return reply.code(404).send({ error: result === 'no_user' ? 'not_found' : 'project_not_found' });
  });

  app.delete('/api/admin/users/:id/memberships/:projectId', { preHandler: adminOnly }, async (request, reply) => {
    const { id, projectId } = request.params as { id: string; projectId: string };
    if (!ULID_PATTERN.test(id) || !ULID_PATTERN.test(projectId)) return reply.code(400).send({ error: 'invalid_request' });
    await withDb((db) => removeMembership(db, id, projectId));
    return { ok: true };
  });
}
