// Records the microphone in the browser and writes the kept part as a 24-bit WAV (Bible: upload is WAV; the server derives the MP3).
// The samples come from an AudioWorklet (recorder-worklet.js).

import workletUrl from './recorder-worklet.js?url';

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

/** A finished recording, before it is written. */
export interface Take { samples: Float32Array; rate: number; durationMs: number }

/** Writes the part of a take between two times as a mono 24-bit WAV (the master; the server derives the MP3 copy). */
export function encodeWav(take: Take, fromMs: number, toMs: number): Blob {
  const a = Math.max(0, Math.floor((fromMs / 1000) * take.rate)), b = Math.min(take.samples.length, Math.ceil((toMs / 1000) * take.rate));
  const n = Math.max(0, b - a), bytes = n * 3;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const tag = (at: number, t: string) => { for (let i = 0; i < 4; i++) v.setUint8(at + i, t.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, take.rate, true); v.setUint32(28, take.rate * 3, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true);
  tag(36, 'data'); v.setUint32(40, bytes, true);
  let at = 44;
  for (let i = a; i < b; i++) {
    const x = Math.max(-1, Math.min(1, take.samples[i]!));
    const q = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
    v.setUint8(at, q & 255); v.setUint8(at + 1, (q >> 8) & 255); v.setUint8(at + 2, (q >> 16) & 255);
    at += 3;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
