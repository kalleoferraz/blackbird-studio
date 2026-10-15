import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FailureLimiter } from '../auth/rate-limit.js';
import {
  findUserByEmail,
  findUserById,
  membershipsOf,
  normalizeEmail,
  setPassword,
  setPasswordHash,
  toAccount,
  type Account,
  type UserRow,
} from '../auth/accounts.js';
import { checkPasswordRules, dummyHash, hashPassword, needsRehash, verifyPassword } from '../auth/password.js';
import { clearedSessionCookie, passwordStamp, readSession, sessionConfigured, sessionCookie } from '../auth/session.js';
import { withDb, type Db } from '../db/client.js';

declare module 'fastify' {
  interface FastifyRequest {
    account?: Account;
  }
}

const WINDOW_MS = 15 * 60 * 1000;
const byEmail = new FailureLimiter(8, WINDOW_MS); // one account cannot be guessed at
const byAddress = new FailureLimiter(40, WINDOW_MS); // one address cannot try many accounts
const byUser = new FailureLimiter(8, WINDOW_MS); // wrong "current password" on the change form

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;

/**
 * preHandler that requires a valid session: the cookie signature and expiry, an existing and enabled user,
 * and a password stamp that still matches. A user with a temporary password may only use the routes
 * that allow `allowPasswordChange`.
 */
export function authenticate(options: { allowPasswordChange?: boolean } = {}): Guard {
  return async (request, reply) => {
    if (!sessionConfigured()) return reply.code(503).send({ error: 'auth_not_configured' });
    const session = readSession(request.headers.cookie);
    if (!session) return reply.code(401).send({ error: 'unauthenticated' });
    const row = await withDb((db) => findUserById(db, session.userId));
    if (!row || row.disabledAt || session.stamp !== passwordStamp(row.passwordHash)) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    request.account = toAccount(row);
    if (row.mustChangePassword && !options.allowPasswordChange) {
      return reply.code(403).send({ error: 'password_change_required' });
    }
    return undefined;
  };
}

export const requireAdmin: Guard = async (request, reply) =>
  request.account?.isAdmin ? undefined : reply.code(403).send({ error: 'forbidden' });

/** Reads a string field from a JSON body; undefined when it is missing or not a string. */
export function bodyString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

async function mePayload(db: Db, row: UserRow) {
  return { user: toAccount(row), projects: await membershipsOf(db, row.id) };
}

const smallBody = { bodyLimit: 4096 };

export function registerAuthRoutes(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.post('/api/login', { config: {}, ...smallBody }, async (request, reply) => {
    if (!sessionConfigured()) return reply.code(503).send({ error: 'auth_not_configured' });
    const email = normalizeEmail(bodyString(request.body, 'email'));
    const password = bodyString(request.body, 'password');
    if (!email || password === undefined || password.length > 1000) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const keys = [`email:${email}`, `ip:${request.ip}`];
    const wait = Math.max(byEmail.retryAfterSeconds(keys[0]!), byAddress.retryAfterSeconds(keys[1]!));
    if (wait > 0) return reply.code(429).header('retry-after', String(wait)).send({ error: 'too_many_attempts' });

    const row = await withDb((db) => findUserByEmail(db, email));
    // Always run one scrypt, so an unknown email costs the same time as a wrong password.
    const ok = await verifyPassword(password, row ? row.passwordHash : await dummyHash());
    if (!row || !ok || row.disabledAt) {
      byEmail.fail(keys[0]!);
      byAddress.fail(keys[1]!);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    byEmail.reset(keys[0]!);

    let passwordHash = row.passwordHash;
    if (needsRehash(passwordHash)) {
      passwordHash = await hashPassword(password);
      await withDb((db) => setPasswordHash(db, row.id, passwordHash));
    }
    reply.header('set-cookie', sessionCookie(row.id, passwordHash));
    return withDb((db) => mePayload(db, { ...row, passwordHash }));
  });

  app.post('/api/logout', smallBody, async (_request, reply) => {
    reply.header('set-cookie', clearedSessionCookie());
    return { ok: true };
  });

  app.get('/api/me', { preHandler: authenticate({ allowPasswordChange: true }) }, async (request) => {
    const account = request.account!;
    return withDb(async (db) => {
      const row = (await findUserById(db, account.id))!;
      return mePayload(db, row);
    });
  });

  app.post(
    '/api/me/password',
    { preHandler: authenticate({ allowPasswordChange: true }), ...smallBody },
    async (request, reply) => {
      const account = request.account!;
      const current = bodyString(request.body, 'currentPassword');
      const next = bodyString(request.body, 'newPassword');
      if (current === undefined || next === undefined) return reply.code(400).send({ error: 'invalid_request' });
      const key = `user:${account.id}`;
      const wait = byUser.retryAfterSeconds(key);
      if (wait > 0) return reply.code(429).header('retry-after', String(wait)).send({ error: 'too_many_attempts' });
      const row = await withDb((db) => findUserById(db, account.id));
      if (!row || !(await verifyPassword(current, row.passwordHash))) {
        byUser.fail(key);
        return reply.code(403).send({ error: 'wrong_password' });
      }
      byUser.reset(key);
      const problem = checkPasswordRules(next);
      if (problem) return reply.code(400).send({ error: 'weak_password', message: problem });
      if (next === current) {
        return reply.code(400).send({ error: 'weak_password', message: 'The new password must differ from the current one.' });
      }
      const passwordHash = await withDb((db) => setPassword(db, row.id, next, false));
      reply.header('set-cookie', sessionCookie(row.id, passwordHash));
      return withDb(async (db) => mePayload(db, (await findUserById(db, row.id))!));
    },
  );
}
