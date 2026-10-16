import exifr from 'exifr';
import type { Inspection } from './types.js';
import { swapsAxes } from './orientation.js';

const u16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32 = (b: Uint8Array, i: number) => (u16(b, i) * 65536 + u16(b, i + 2)) >>> 0;
const le16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/**
 * Reads format, size, orientation, animation and alpha from the file's headers, without decoding.
 * Cheap enough to run in the main thread before any worker is involved, and it decides what the
 * worker is asked to do (skip, refuse, or resize to an exact target size).
 */
export async function inspectImage(input: Uint8Array): Promise<Inspection> {
  const base: Inspection = { format: 'unknown', exifOrientation: 1, animated: false, hasAlpha: false };
  if (input.length < 12) return { ...base, error: 'file too short' };

  let result: Inspection;
  if (input[0] === 0xff && input[1] === 0xd8) result = inspectJpeg(input, base);
  else if (input[0] === 0x89 && ascii(input, 1, 3) === 'PNG') result = inspectPng(input, base);
  else if (ascii(input, 0, 3) === 'GIF') result = inspectGif(input, base);
  else if (ascii(input, 0, 4) === 'RIFF' && ascii(input, 8, 4) === 'WEBP') result = inspectWebp(input, base);
  else return base;

  if ((result.format === 'jpeg' || result.format === 'webp') && !result.error) {
    try {
      const o = await exifr.orientation(input);
      if (typeof o === 'number' && o >= 1 && o <= 8) result.exifOrientation = o;
    } catch {
      /* a broken EXIF block is treated as "no orientation" */
    }
  }
  if (result.width && result.height) {
    const swap = swapsAxes(result.exifOrientation);
    result.displayWidth = swap ? result.height : result.width;
    result.displayHeight = swap ? result.width : result.height;
  }
  return result;
}

function inspectJpeg(b: Uint8Array, base: Inspection): Inspection {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1] ?? 0;
    if (m === 0xff) { i++; continue; }
    if (m === 0x00 || m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = u16(b, i + 2);
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      return {
        ...base,
        format: 'jpeg',
        height: u16(b, i + 5),
        width: u16(b, i + 7),
        components: b[i + 9] ?? 0,
        progressive: m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce,
        truncated: !jpegHasEnd(b),
      };
    }
    i += 2 + len;
  }
  return { ...base, format: 'jpeg', error: 'no frame header found' };
}

/** A JPEG ends with the marker FF D9 (cameras may add a little padding or a second image after it). */
function jpegHasEnd(b: Uint8Array): boolean {
  for (let i = b.length - 2; i >= Math.max(2, b.length - 64); i--) if (b[i] === 0xff && b[i + 1] === 0xd9) return true;
  return false;
}

function inspectPng(b: Uint8Array, base: Inspection): Inspection {
  if (ascii(b, 12, 4) !== 'IHDR') return { ...base, format: 'png', error: 'IHDR missing' };
  const width = u32(b, 16);
  const height = u32(b, 20);
  const colorType = b[25] ?? 0;
  let hasAlpha = colorType === 4 || colorType === 6;
  let animated = false;
  // walk the chunks that come before the image data: tRNS gives a palette image transparency, acTL marks APNG
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32(b, i);
    const type = ascii(b, i + 4, 4);
    if (type === 'tRNS') hasAlpha = true;
    if (type === 'acTL') animated = true;
    if (type === 'IDAT' || type === 'IEND') break;
    i += 12 + len;
  }
  const truncated = ascii(b, b.length - 8, 4) !== 'IEND';
  return { ...base, format: 'png', width, height, hasAlpha, animated, truncated };
}

function inspectGif(b: Uint8Array, base: Inspection): Inspection {
  const width = le16(b, 6);
  const height = le16(b, 8);
  const flags = b[10] ?? 0;
  let i = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  let frames = 0;
  while (i < b.length && frames < 2) {
    const block = b[i];
    if (block === 0x3b) break;
    if (block === 0x21) {
      i += 2;
      while (i < b.length && (b[i] ?? 0) !== 0) i += (b[i] ?? 0) + 1;
      i++;
    } else if (block === 0x2c) {
      frames++;
      const f = b[i + 9] ?? 0;
      i += 10 + (f & 0x80 ? 3 * (1 << ((f & 7) + 1)) : 0) + 1;
      while (i < b.length && (b[i] ?? 0) !== 0) i += (b[i] ?? 0) + 1;
      i++;
    } else {
      return { ...base, format: 'gif', width, height, error: 'unreadable GIF block' };
    }
  }
  return { ...base, format: 'gif', width, height, animated: frames >= 2, hasAlpha: true };
}

function inspectWebp(b: Uint8Array, base: Inspection): Inspection {
  const kind = ascii(b, 12, 4);
  if (kind === 'VP8X') {
    const flags = b[20] ?? 0;
    const width = 1 + ((b[24] ?? 0) | ((b[25] ?? 0) << 8) | ((b[26] ?? 0) << 16));
    const height = 1 + ((b[27] ?? 0) | ((b[28] ?? 0) << 8) | ((b[29] ?? 0) << 16));
    return { ...base, format: 'webp', width, height, animated: (flags & 0x02) !== 0, hasAlpha: (flags & 0x10) !== 0 };
  }
  if (kind === 'VP8L') {
    const bits = le16(b, 21) | (le16(b, 23) << 16);
    return { ...base, format: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), hasAlpha: true };
  }
  if (kind === 'VP8 ') {
    return { ...base, format: 'webp', width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  return { ...base, format: 'webp', error: 'unknown WebP chunk' };
}
