import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt (no native modules). The stored string carries its own
 * parameters, so the cost can be raised later and old hashes are upgraded at the next login:
 *   scrypt$N$r$p$salt$hash   (salt and hash in base64)
 * N=65536, r=8, p=1 took about 174 ms and 64 MiB per hash on the host (database spike, 2026-10-15).
 */
const COST = { N: 65536, r: 8, p: 1 };
const KEY_BYTES = 32;
const MAX_MEMORY = 256 * 1024 * 1024; // scrypt's default limit (32 MiB) is below what N=65536, r=8 needs

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** Returns a message when the password is not acceptable, otherwise null. */
export function checkPasswordRules(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `The password needs at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `The password can have at most ${PASSWORD_MAX} characters.`;
  return null;
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST.N, COST.r, COST.p);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Refuse absurd parameters, so a damaged row cannot make the server allocate gigabytes.
  if (!Number.isInteger(N) || N < 2 || N > 2 ** 17 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  return { N, r, p, salt: Buffer.from(parts[4]!, 'base64'), key: Buffer.from(parts[5]!, 'base64') };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/** True when the stored hash was made with weaker parameters than the current ones. */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.N !== COST.N || parsed.r !== COST.r || parsed.p !== COST.p;
}

let dummy: Promise<string> | undefined;
/** A valid hash of a random password, verified against when the email is unknown so the timing does not reveal it. */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}
