import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/** A ULID: 48-bit millisecond time and 80 random bits, 26 characters, sortable by creation time. */
export function newUlid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const random = randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ALPHABET[random[i]! & 31]; // 256 is a multiple of 32: no bias
  return time + tail;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
