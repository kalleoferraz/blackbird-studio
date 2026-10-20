import { randomBytes } from 'node:crypto';
import { asc, eq, and } from 'drizzle-orm';
import { withDb, type Db } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { membership, project, user } from '../db/schema.js';
import { checkPasswordRules, hashPassword } from './password.js';

export const ROLES = ['owner', 'author', 'narrator', 'translator', 'reader'] as const;
export type Role = (typeof ROLES)[number];

export type UserRow = typeof user.$inferSelect;

export interface Account {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface MembershipInfo {
  projectId: string;
  title: string;
  role: Role;
}

// ---- helpers ----------------------------------------------------------------

/** Trimmed, lowercase email, or null when it does not look like one. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** The admin is the account whose email is ADMIN_EMAIL (the Bible, section 5, "Accounts and login"). */
export function isAdminEmail(email: string): boolean {
  return normalizeEmail(process.env.ADMIN_EMAIL) === email;
}

export function toAccount(row: UserRow): Account {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    isAdmin: isAdminEmail(row.email),
    mustChangePassword: row.mustChangePassword,
  };
}

export function isDuplicateKey(err: unknown): boolean {
  let e = err as { code?: string; errno?: number; cause?: unknown } | undefined;
  for (let i = 0; i < 4 && e; i++) {
    if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) return true;
    e = e.cause as typeof e;
  }
  return false;
}

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 characters, none easily confused

/** A temporary password such as K7PQ-M2XD-R9TC (60 random bits); the user must replace it at first login. */
export function generateTemporaryPassword(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += TEMP_ALPHABET[bytes[i]! & 31];
    if (i % 4 === 3 && i < 11) out += '-';
  }
  return out;
}

// ---- users ------------------------------------------------------------------

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1);
  return rows[0];
}

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(user).where(eq(user.id, id)).limit(1);
  return rows[0];
}

/** Creates a user; returns null when the email is already taken. */
export async function createUser(
  db: Db,
  input: { email: string; displayName: string; password: string; mustChangePassword: boolean },
): Promise<UserRow | null> {
  const now = new Date();
  const row = {
    id: newUlid(),
    email: input.email,
    passwordHash: await hashPassword(input.password),
    displayName: input.displayName,
    disabledAt: null,
    mustChangePassword: input.mustChangePassword,
    lastLoginAt: null,
    lastEditAt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(user).values(row);
  } catch (err) {
    if (isDuplicateKey(err)) return null;
    throw err;
  }
  return row;
}

export async function setPassword(db: Db, id: string, password: string, mustChangePassword: boolean): Promise<string> {
  const passwordHash = await hashPassword(password);
  await db.update(user).set({ passwordHash, mustChangePassword, updatedAt: new Date() }).where(eq(user.id, id));
  return passwordHash;
}

export async function setPasswordHash(db: Db, id: string, passwordHash: string): Promise<void> {
  await db.update(user).set({ passwordHash }).where(eq(user.id, id));
}

export async function setDisabled(db: Db, id: string, disabled: boolean): Promise<void> {
  const now = new Date();
  await db.update(user).set({ disabledAt: disabled ? now : null, updatedAt: now }).where(eq(user.id, id));
}

// ---- memberships and projects ---------------------------------------------------

export async function membershipsOf(db: Db, userId: string): Promise<MembershipInfo[]> {
  const rows = await db
    .select({ projectId: membership.projectId, title: project.title, role: membership.role })
    .from(membership)
    .innerJoin(project, eq(project.id, membership.projectId))
    .where(eq(membership.userId, userId))
    .orderBy(asc(project.title));
  return rows;
}

export interface UserListEntry {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  memberships: MembershipInfo[];
}

export async function listUsers(db: Db): Promise<UserListEntry[]> {
  const users = await db.select().from(user).orderBy(asc(user.email));
  const memberships = await db
    .select({ userId: membership.userId, projectId: membership.projectId, title: project.title, role: membership.role })
    .from(membership)
    .innerJoin(project, eq(project.id, membership.projectId))
    .orderBy(asc(project.title));
  return users.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    isAdmin: isAdminEmail(row.email),
    disabled: row.disabledAt !== null,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt.toISOString(),
    memberships: memberships
      .filter((m) => m.userId === row.id)
      .map(({ projectId, title, role }) => ({ projectId, title, role })),
  }));
}

export async function listProjects(db: Db): Promise<{ id: string; title: string }[]> {
  return db.select({ id: project.id, title: project.title }).from(project).orderBy(asc(project.title));
}

/** Adds or changes a membership; returns false when the project does not exist. */
export async function setMembership(db: Db, userId: string, projectId: string, role: Role): Promise<boolean> {
  const found = await db.select({ id: project.id }).from(project).where(eq(project.id, projectId)).limit(1);
  if (found.length === 0) return false;
  await db
    .insert(membership)
    .values({ userId, projectId, role, createdAt: new Date() })
    .onDuplicateKeyUpdate({ set: { role } });
  return true;
}

export async function removeMembership(db: Db, userId: string, projectId: string): Promise<void> {
  await db.delete(membership).where(and(eq(membership.userId, userId), eq(membership.projectId, projectId)));
}

// ---- startup --------------------------------------------------------------------

interface Log {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Creates or recovers the admin account from the host's environment settings, since the host gives no shell:
 *  - ADMIN_EMAIL names the admin. Without it there is no admin.
 *  - ADMIN_PASSWORD creates the admin when no account has that email yet (the first login must change it).
 *  - RESET_ADMIN_PASSWORD sets the admin's password at every start while it is set, re-enables the account
 *    and requires a change at the next login. Remove it after use.
 */
export async function bootstrapAccounts(log: Log): Promise<void> {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  if (!email) {
    log.warn('ADMIN_EMAIL is not set (or is not an email): there is no admin account');
    return;
  }
  const reset = process.env.RESET_ADMIN_PASSWORD;
  const initial = process.env.ADMIN_PASSWORD;
  await withDb(async (db) => {
    const existing = await findUserByEmail(db, email);
    if (reset) {
      const problem = checkPasswordRules(reset);
      if (problem) {
        log.error(`RESET_ADMIN_PASSWORD was ignored: ${problem}`);
        return;
      }
      if (existing) {
        await setPassword(db, existing.id, reset, true);
        await setDisabled(db, existing.id, false);
      } else {
        await createUser(db, { email, displayName: 'Admin', password: reset, mustChangePassword: true });
      }
      log.warn('RESET_ADMIN_PASSWORD is set: the admin password was reset. Remove the variable and redeploy, or it resets at every start.');
      return;
    }
    if (existing || !initial) return;
    const problem = checkPasswordRules(initial);
    if (problem) {
      log.error(`ADMIN_PASSWORD was ignored: ${problem}`);
      return;
    }
    const created = await createUser(db, { email, displayName: 'Admin', password: initial, mustChangePassword: true });
    if (created) log.info('Admin account created from ADMIN_PASSWORD; remove that variable after the first login.');
  });
}
