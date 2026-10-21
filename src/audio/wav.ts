import { AudioError } from './errors.js';

/** What the library needs to know about a WAV file, read from its header (no sample is decoded here). */
export interface WavInfo {
  format: 'wav';
  sampleRate: number;
  channels: 1 | 2;
  bitDepth: 16 | 24 | 32;
  sampleFormat: 'pcm' | 'float';
  /** Number of sample frames (one sample per channel). */
  frames: number;
  durationMs: number;
  dataOffset: number;
  dataBytes: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** Reads the header of a RIFF/WAVE file. Accepts mono or stereo PCM of 16, 24 or 32 bits, and 32-bit float. */
export function parseWav(buf: Uint8Array): WavInfo {
  const bad = (m: string) => new AudioError(422, 'audio_unreadable', m);
  if (buf.length < 44 || tag(buf, 0) !== 'RIFF' || tag(buf, 8) !== 'WAVE') throw bad('This is not a WAV file.');
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let fmt: { tag: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null;
  let data: { offset: number; bytes: number } | null = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = tag(buf, pos);
    const declared = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (declared < 16 || body + 16 > buf.length) throw bad('The WAV header is damaged.');
      let t = v.getUint16(body, true);
      if (t === WAVE_FORMAT_EXTENSIBLE && declared >= 26 && body + 26 <= buf.length) t = v.getUint16(body + 24, true);
      fmt = { tag: t, channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), blockAlign: v.getUint16(body + 12, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      // A recorder that could not go back to fix the header leaves 0 or 0xFFFFFFFF: the data then runs to the end.
      const open = declared === 0 || declared === 0xffffffff;
      const available = buf.length - body;
      if (!open && declared > available) throw bad('The WAV file is cut short.');
      data = { offset: body, bytes: open ? available : declared };
      break;
    }
    pos = body + declared + (declared & 1);
  }
  if (!fmt) throw bad('The WAV file has no format information.');
  if (!data) throw bad('The WAV file has no audio data.');

  const unsupported = (m: string) => new AudioError(415, 'unsupported_audio', m);
  const isFloat = fmt.tag === WAVE_FORMAT_FLOAT;
  if (fmt.tag !== WAVE_FORMAT_PCM && !isFloat) throw unsupported('This WAV file is compressed. Use PCM (16, 24 or 32 bit) or 32-bit float.');
  if (fmt.channels < 1 || fmt.channels > 2) throw unsupported(fmt.channels === 0 ? 'The WAV file has no channels.' : `The WAV file has ${fmt.channels} channels. Only mono and stereo are supported.`);
  const okDepth = isFloat ? fmt.bits === 32 : fmt.bits === 16 || fmt.bits === 24 || fmt.bits === 32;
  if (!okDepth) throw unsupported(`${fmt.bits}-bit ${isFloat ? 'float ' : ''}samples are not supported. Use 16, 24 or 32 bit PCM, or 32-bit float.`);
  if (fmt.sampleRate < 8000 || fmt.sampleRate > 192000) throw unsupported(`A sample rate of ${fmt.sampleRate} Hz is not supported.`);
  const frameBytes = fmt.channels * (fmt.bits / 8);
  if (fmt.blockAlign !== frameBytes) throw bad('The WAV header is inconsistent.');
  const frames = Math.floor(data.bytes / frameBytes);
  if (frames === 0) throw bad('The WAV file contains no audio.');
  return {
    format: 'wav',
    sampleRate: fmt.sampleRate,
    channels: fmt.channels as 1 | 2,
    bitDepth: fmt.bits as 16 | 24 | 32,
    sampleFormat: isFloat ? 'float' : 'pcm',
    frames,
    durationMs: Math.round((frames / fmt.sampleRate) * 1000),
    dataOffset: data.offset,
    dataBytes: frames * frameBytes,
  };
}

/** The sample bytes only, so tags and header differences do not make the same recording look different. */
export function wavSamples(buf: Uint8Array, info: WavInfo): Uint8Array {
  return buf.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
}

/** Decodes `count` frames starting at `start` into one Float32Array per channel (-1 to 1). */
export function readFloatChannels(buf: Uint8Array, info: WavInfo, start: number, count: number): Float32Array[] {
  const n = Math.max(0, Math.min(count, info.frames - start));
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const bytes = info.bitDepth / 8, stride = bytes * info.channels;
  const out = Array.from({ length: info.channels }, () => new Float32Array(n));
  for (let c = 0; c < info.channels; c++) {
    const ch = out[c]!;
    let at = info.dataOffset + start * stride + c * bytes;
    for (let i = 0; i < n; i++, at += stride) {
      if (info.sampleFormat === 'float') ch[i] = v.getFloat32(at, true);
      else if (info.bitDepth === 16) ch[i] = v.getInt16(at, true) / 32768;
      else if (info.bitDepth === 24) ch[i] = ((v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16)) | 0) / 8388608;
      else ch[i] = v.getInt32(at, true) / 2147483648;
    }
  }
  return out;
}
