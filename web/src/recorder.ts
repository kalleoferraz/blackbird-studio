// Records the microphone and turns it into an MP3 in the browser (Bible: recordings are MP3 for now).
// The samples come from an AudioWorklet (recorder-worklet.js); the encoder is loaded only when a take is made.

import workletUrl from './recorder-worklet.js?url';

const MP3_KBPS = 128;

export class MicRecorder {
  private chunks: Float32Array[] = [];
  private keeping = false;
  private closed = false;

  private constructor(private ctx: AudioContext, private stream: MediaStream, private node: AudioWorkletNode) {
    node.port.onmessage = (e: MessageEvent<Float32Array>) => { if (this.keeping) this.chunks.push(e.data); };
  }

  /** Asks for the microphone and gets ready; nothing is kept until `start`. */
  static async open(): Promise<MicRecorder> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record (it needs a secure https address).');
    // Voice for a story: no automatic level or noise processing, which would colour the sound.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    try {
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
      ctx.createMediaStreamSource(stream).connect(node);
      if (ctx.state === 'suspended') await ctx.resume();
      return new MicRecorder(ctx, stream, node);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
  }

  start() { this.chunks = []; this.keeping = true; }

  /** Releases the microphone. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.keeping = false;
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => undefined);
  }

  /** Stops, releases the microphone and hands over what was recorded. */
  async stop(): Promise<Take> {
    this.keeping = false;
    await new Promise((r) => setTimeout(r, 60)); // the last block is on its way from the audio thread
    const chunks = this.chunks;
    const rate = this.ctx.sampleRate;
    this.close();
    const frames = chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(frames);
    let at = 0;
    for (const c of chunks) { samples.set(c, at); at += c.length; }
    return { samples, rate, durationMs: Math.round((frames / rate) * 1000) };
  }
}

/** A finished recording, before it is encoded. */
export interface Take { samples: Float32Array; rate: number; durationMs: number }

/** Encodes the part of a take between two times as an MP3. */
export async function encodeMp3(take: Take, fromMs: number, toMs: number): Promise<Blob> {
  const a = Math.max(0, Math.floor((fromMs / 1000) * take.rate)), b = Math.min(take.samples.length, Math.ceil((toMs / 1000) * take.rate));
  const { createMp3Encoder } = await import('wasm-media-encoders');
  const enc = await createMp3Encoder();
  enc.configure({ sampleRate: take.rate, channels: 1, bitrate: MP3_KBPS as never });
  const parts: Uint8Array[] = [];
  const BLOCK = 16384;
  for (let i = a; i < b; i += BLOCK) { const out = enc.encode([take.samples.subarray(i, Math.min(b, i + BLOCK))]); if (out.length) parts.push(out.slice()); }
  const tail = enc.finalize();
  if (tail.length) parts.push(tail.slice());
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}
