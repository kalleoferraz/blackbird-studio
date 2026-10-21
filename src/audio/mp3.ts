import { AudioError } from './errors.js';

/** What the library needs to know about an MP3 file. */
export interface Mp3Info {
  format: 'mp3';
  sampleRate: number;
  channels: 1 | 2;
  /** Average bit rate in kbit/s. */
  bitrateKbps: number;
  frames: number;
  durationMs: number;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Frame { length: number; sampleRate: number; channels: 1 | 2; samples: number; bitrate: number; version: number }

/** Reads a layer III frame header at `at`, or null when the bytes there are not one. */
function frameAt(b: Uint8Array, at: number): Frame | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1]! >> 3) & 3; // 3 = MPEG 1, 2 = MPEG 2, 0 = MPEG 2.5
  const layer = (b[at + 1]! >> 1) & 3; // 1 = layer III
  if (version === 1 || layer !== 1) return null;
  const bi = (b[at + 2]! >> 4) & 15, si = (b[at + 2]! >> 2) & 3, pad = (b[at + 2]! >> 1) & 1;
  if (bi === 0 || bi === 15 || si === 3) return null;
  const bitrate = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bi]!;
  const sampleRate = RATES[version]![si]!;
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((version === 3 ? 144 : 72) * bitrate * 1000) / sampleRate) + pad;
  return { length, sampleRate, channels: ((b[at + 3]! >> 6) & 3) === 3 ? 1 : 2, samples, bitrate, version };
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** Reads an MP3 file: duration from the Xing/Info header when there is one, else by walking the frames. */
export function parseMp3(buf: Uint8Array): Mp3Info {
  const bad = new AudioError(422, 'audio_unreadable', 'This is not a readable MP3 file.');
  let pos = 0;
  while (ascii(buf, pos, 3) === 'ID3' && pos + 10 <= buf.length) {
    const size = ((buf[pos + 6]! & 0x7f) << 21) | ((buf[pos + 7]! & 0x7f) << 14) | ((buf[pos + 8]! & 0x7f) << 7) | (buf[pos + 9]! & 0x7f);
    pos += 10 + size + ((buf[pos + 5]! & 0x10) !== 0 ? 10 : 0);
  }
  // The first frame: three frames in a row must fit, so a stray 0xFF byte is not taken for one.
  let first = -1;
  for (let i = pos; i < Math.min(buf.length - 4, pos + 65536); i++) {
    const f = frameAt(buf, i);
    if (!f) continue;
    const f2 = frameAt(buf, i + f.length);
    if (f2 && f2.sampleRate === f.sampleRate && (i + f.length + f2.length >= buf.length || frameAt(buf, i + f.length + f2.length))) { first = i; break; }
  }
  if (first < 0) throw bad;
  const head = frameAt(buf, first)!;

  // Xing / Info (VBR, and CBR written by LAME) or VBRI: the frame count is in the first frame.
  const side = head.version === 3 ? (head.channels === 1 ? 17 : 32) : head.channels === 1 ? 9 : 17;
  let frames = 0, xing = false;
  const x = first + 4 + side;
  if (['Xing', 'Info'].includes(ascii(buf, x, 4)) && (buf[x + 7]! & 1) !== 0) {
    frames = new DataView(buf.buffer, buf.byteOffset).getUint32(x + 8, false);
    xing = true;
  } else if (ascii(buf, first + 36, 4) === 'VBRI') {
    frames = new DataView(buf.buffer, buf.byteOffset).getUint32(first + 50, false);
    xing = true;
  }
  if (xing) frames = Math.max(0, frames); // the header frame itself carries no audio and is not counted

  let walked = 0, at = first, resyncs = 0;
  if (!xing || frames === 0) {
    while (at + 4 <= buf.length) {
      const f = frameAt(buf, at);
      if (f && at + f.length <= buf.length) { walked++; at += f.length; continue; }
      if (ascii(buf, at, 3) === 'TAG' || ascii(buf, at, 4) === 'APET') break; // a tag after the audio
      if (++resyncs > 64) break; // junk in the middle: give up counting
      at++;
    }
    frames = walked;
  }
  if (frames < 1) throw bad;
  const durationMs = Math.round(((frames * head.samples) / head.sampleRate) * 1000);
  const audioBytes = Math.max(0, (xing ? buf.length - first : at - first));
  const bitrateKbps = durationMs > 0 ? Math.round((audioBytes * 8) / durationMs) : head.bitrate;
  return { format: 'mp3', sampleRate: head.sampleRate, channels: head.channels, bitrateKbps, frames, durationMs };
}
