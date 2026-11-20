import { createMp3Encoder } from 'wasm-media-encoders';
import { LoudnessMeter, type Loudness } from './loudness.js';
import { PeakAccumulator } from './peaks.js';
import { parseWav, readFloatChannels } from './wav.js';

/** The playback copy's bit rate (Bible, section 6: 128 kbit/s to start; the WAV master is kept, so it can change). */
export const MP3_KBPS = 128;
const BLOCK_FRAMES = 48000;

let encoder: Awaited<ReturnType<typeof createMp3Encoder>> | null = null;

/** Encodes a whole WAV file to MP3 and collects its peaks and loudness in the same pass. Runs in a worker thread. */
export async function encodeWav(wav: Uint8Array, kbps = MP3_KBPS): Promise<{ mp3: Uint8Array; peaks: Uint8Array; loudness: Loudness }> {
  const info = parseWav(wav);
  encoder ??= await createMp3Encoder();
  encoder.configure({ sampleRate: info.sampleRate, channels: info.channels, bitrate: kbps as never });
  const peaks = new PeakAccumulator(info.sampleRate), meter = new LoudnessMeter(info.sampleRate);
  const parts: Uint8Array[] = [];
  let total = 0;
  const keep = (chunk: Uint8Array) => {
    if (chunk.length === 0) return;
    parts.push(chunk.slice()); // the encoder owns its buffer: copy
    total += chunk.length;
  };
  for (let start = 0; start < info.frames; start += BLOCK_FRAMES) {
    const block = readFloatChannels(wav, info, start, BLOCK_FRAMES);
    peaks.push(block);
    meter.push(block);
    keep(encoder.encode(block));
  }
  keep(encoder.finalize());
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return { mp3: out, peaks: peaks.finish(), loudness: meter.result() };
}

/** Just the MP3 (kept for callers that do not need the peaks). */
export async function encodeWavToMp3(wav: Uint8Array, kbps = MP3_KBPS): Promise<Uint8Array> {
  return (await encodeWav(wav, kbps)).mp3;
}
