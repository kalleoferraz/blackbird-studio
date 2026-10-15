import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The session is one signed cookie, with no session table: user ID, expiry, and a short stamp derived
 * from the user's current password hash. Changing or resetting a password changes the stamp, which ends
 * every older cookie of that user. Disabling a user is checked against the database on each request.
 */
const COOKIE_NAME = 'rs_session';
const MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

function secret(): string | null {
  const value = process.env.SESSION_SECRET;
  return value && value.length >= 32 ? value : null;
}

export function sessionConfigured(): boolean {
  return secret() !== null;
}

function mac(text: string, key: string): string {
  return createHmac('sha256', key).update(text).digest('base64url');
}

export function passwordStamp(passwordHash: string): string {
  const key = secret();
  return key ? mac(`pw:${passwordHash}`, key).slice(0, 16) : '';
}

interface Payload {
  u: string; // user id
  p: string; // password stamp
  e: number; // expiry, ms since epoch
}

export interface Session {
  userId: string;
  stamp: string;
}

function cookieAttributes(maxAge: number): string {
  // Secure is on unless COOKIE_INSECURE=1, for plain-http local runs in Safari.
  const secure = process.env.COOKIE_INSECURE === '1' ? '' : '; Secure';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** The Set-Cookie header value that logs the user in. */
export function sessionCookie(userId: string, passwordHash: string, now = Date.now()): string {
  const key = secret();
  if (!key) throw new Error('SESSION_SECRET is missing or shorter than 32 characters');
  const payload: Payload = { u: userId, p: passwordStamp(passwordHash), e: now + MAX_AGE_SECONDS * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${COOKIE_NAME}=${body}.${mac(body, key)}; ${cookieAttributes(MAX_AGE_SECONDS)}`;
}

export function clearedSessionCookie(): string {
  return `${COOKIE_NAME}=; ${cookieAttributes(0)}`;
}

/** Reads and verifies the session cookie from a Cookie request header. */
export function readSession(cookieHeader: string | undefined, now = Date.now()): Session | null {
  const key = secret();
  if (!key || !cookieHeader) return null;
  const raw = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;
  const value = raw.slice(COOKIE_NAME.length + 1);
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(mac(body, key));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Payload>;
    if (typeof payload.u !== 'string' || typeof payload.p !== 'string' || typeof payload.e !== 'number') return null;
    if (payload.e <= now) return null;
    return { userId: payload.u, stamp: payload.p };
  } catch {
    return null;
  }
}
