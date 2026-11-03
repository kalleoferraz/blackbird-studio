import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withDb, type Q } from '../db/client.js';
import { appSetting } from '../db/schema.js';

/** The settings the administrator can edit in the app. Environment variables of the same name are the fallback. */
export const SNAPSHOT_REPO = 'SNAPSHOT_REPO';
export const SNAPSHOT_BRANCH = 'SNAPSHOT_BRANCH';
export const SNAPSHOT_REPO_TOKEN = 'SNAPSHOT_REPO_TOKEN';

/** The key comes from SESSION_SECRET: when that changes, saved secrets cannot be read any more and must be entered again. */
function key(): Buffer | null {
  const s = process.env.SESSION_SECRET;
  return s && s.length >= 32 ? createHash('sha256').update('app-setting:' + s).digest() : null;
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) throw new Error('SESSION_SECRET is missing or shorter than 32 characters, so a secret cannot be stored.');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

/** The secret, or null when it cannot be read (other SESSION_SECRET, damaged value). */
export function decryptSecret(stored: string): string | null {
  const k = key();
  const [v, iv, tag, body] = stored.split(':');
  if (!k || v !== 'v1' || !iv || !tag || !body) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export async function getSetting(q: Q, name: string): Promise<string | null> {
  const r = (await q.select({ v: appSetting.value }).from(appSetting).where(eq(appSetting.key, name)).limit(1))[0];
  return r ? r.v : null;
}

export async function putSetting(q: Q, name: string, value: string | null): Promise<void> {
  if (value === null) { await q.delete(appSetting).where(eq(appSetting.key, name)); return; }
  const now = new Date();
  await q.insert(appSetting).values({ key: name, value, updatedAt: now }).onDuplicateKeyUpdate({ set: { value, updatedAt: now } });
}

export interface SnapshotSettings {
  repo: string | null;
  branch: string | null;
  token: string | null;
  /** Where each value comes from: the admin area (`app`), the environment (`env`) or nowhere. */
  source: { repo: 'app' | 'env' | null; branch: 'app' | 'env' | null; token: 'app' | 'env' | null };
  /** A token is saved but cannot be read (SESSION_SECRET changed). */
  tokenUnreadable: boolean;
}

/** Saved settings first, the environment second. */
export async function snapshotSettings(): Promise<SnapshotSettings> {
  const [repo, branch, token] = await withDb(async (db) => [
    await getSetting(db, SNAPSHOT_REPO), await getSetting(db, SNAPSHOT_BRANCH), await getSetting(db, SNAPSHOT_REPO_TOKEN),
  ]);
  const env = (n: string) => process.env[n]?.trim() || null;
  const savedToken = token === null ? null : decryptSecret(token);
  const pick = <T,>(app: T | null, fromEnv: T | null): { v: T | null; s: 'app' | 'env' | null } =>
    app !== null ? { v: app, s: 'app' } : fromEnv !== null ? { v: fromEnv, s: 'env' } : { v: null, s: null };
  const r = pick(repo?.trim() || null, env(SNAPSHOT_REPO));
  const b = pick(branch?.trim() || null, env(SNAPSHOT_BRANCH));
  const t = pick(savedToken, env(SNAPSHOT_REPO_TOKEN));
  return { repo: r.v, branch: b.v, token: t.v, source: { repo: r.s, branch: b.s, token: t.s }, tokenUnreadable: token !== null && savedToken === null };
}
