import { MPEGDecoder } from 'mpg123-decoder';
import { parseWav, readFloatChannels, type WavInfo } from './wav.js';

/**
 * Waveform peaks (Bible, section 6): one byte per 100 ms, the loudest sample of that window in either channel,
 * on a decibel scale so that quiet recordings (birds, room tone) are still visible:
 * 0 = silence or -60 dB and below, 255 = full scale (0 dB). The value is linear in decibels.
 */
export const PEAK_STEP_MS = 100;
export const PEAK_FLOOR_DB = 60;

/** The byte for a sample amplitude (0 to 1). */
export function peakByte(amplitude: number): number {
  if (!(amplitude > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, amplitude));
  return Math.max(0, Math.min(255, Math.round(((db + PEAK_FLOOR_DB) / PEAK_FLOOR_DB) * 255)));
}
/** The amplitude (0 to 1) a byte stands for: the inverse of peakByte, for drawing on a linear scale. */
export const peakAmplitude = (b: number): number => (b === 0 ? 0 : Math.pow(10, ((b / 255) * PEAK_FLOOR_DB - PEAK_FLOOR_DB) / 20));

/** Collects peaks from audio that arrives in blocks of any size. */
export class PeakAccumulator {
  private out: number[] = [];
  private frame = 0; // frames seen so far
  private windowEnd: number; // frame index where the current window ends
  private index = 0;
  private max = 0;
  constructor(private readonly sampleRate: number) {
    this.windowEnd = this.boundary(1);
  }
  private boundary(i: number): number {
    return Math.round((i * this.sampleRate * PEAK_STEP_MS) / 1000);
  }
  push(channels: Float32Array[]): void {
    const n = channels[0]?.length ?? 0;
    for (let i = 0; i < n; i++, this.frame++) {
      while (this.frame >= this.windowEnd) this.close();
      for (const ch of channels) {
        const a = Math.abs(ch[i]!);
        if (a > this.max) this.max = a;
      }
    }
  }
  private close() {
    this.out.push(peakByte(this.max));
    this.max = 0;
    this.index++;
    this.windowEnd = this.boundary(this.index + 1);
  }
  /** The peaks, including the last, partly filled window. */
  finish(): Uint8Array {
    if (this.frame > this.boundary(this.index)) this.close();
    return Uint8Array.from(this.out);
  }
}

const BLOCK_FRAMES = 48000;

export function peaksFromWav(wav: Uint8Array, info: WavInfo = parseWav(wav)): Uint8Array {
  const acc = new PeakAccumulator(info.sampleRate);
  for (let start = 0; start < info.frames; start += BLOCK_FRAMES) acc.push(readFloatChannels(wav, info, start, BLOCK_FRAMES));
  return acc.finish();
}

/** Decodes an MP3 (WebAssembly mpg123, in blocks) and returns its peaks. */
export async function peaksFromMp3(mp3: Uint8Array): Promise<Uint8Array> {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    let acc: PeakAccumulator | null = null;
    for (let at = 0; at < mp3.length; at += 32768) {
      const r = decoder.decode(mp3.subarray(at, at + 32768));
      if (r.samplesDecoded === 0) continue;
      acc ??= new PeakAccumulator(r.sampleRate);
      acc.push(r.channelData);
    }
    if (!acc) throw new Error('The MP3 could not be decoded.');
    return acc.finish();
  } finally {
    decoder.free();
  }
}
