/**
 * Integrated loudness (ITU-R BS.1770-4 / EBU R128) and sample peak of a whole file, measured in blocks of any size.
 * K-weighting (a high shelf, then a high pass), 400 ms blocks with 75 % overlap, an absolute gate at -70 LUFS and a
 * relative gate 10 LU below the ungated mean. Every channel has weight 1 (mono and stereo, which is all the app takes).
 */
export interface Loudness {
  /** Integrated loudness in LUFS; null when nothing passes the gates (silence, or shorter than one block). */
  lufs: number | null;
  /** The loudest sample in dBFS; -120 for digital silence. */
  peakDb: number;
}

export const SILENCE_DB = -120;
const ABS_GATE = -70;
const REL_GATE = 10;

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** The two K-weighting filters for any sample rate (the coefficients derived as in libebur128). */
function kWeighting(rate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const pass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, pass];
}

export class LoudnessMeter {
  private readonly f: [Biquad, Biquad];
  /** Filter state per channel: [x1, x2, y1, y2] of each stage. */
  private state: Float64Array[] = [];
  private readonly subLen: number; // frames in 100 ms
  private sub = 0; // sum of squares of the current 100 ms, all channels
  private subFrames = 0;
  private subs: number[] = []; // mean squares of the finished 100 ms pieces
  private peak = 0;

  constructor(rate: number) {
    this.f = kWeighting(rate);
    this.subLen = Math.max(1, Math.round(rate / 10));
  }

  push(channels: Float32Array[]): void {
    const n = channels[0]?.length ?? 0;
    while (this.state.length < channels.length) this.state.push(new Float64Array(8));
    const [s, p] = this.f;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels.length; c++) {
        const x = channels[c]![i]!;
        const a = Math.abs(x);
        if (a > this.peak) this.peak = a;
        const z = this.state[c]!;
        const y1 = s.b0 * x + s.b1 * z[0]! + s.b2 * z[1]! - s.a1 * z[2]! - s.a2 * z[3]!;
        z[1] = z[0]!; z[0] = x; z[3] = z[2]!; z[2] = y1;
        const y2 = p.b0 * y1 + p.b1 * z[4]! + p.b2 * z[5]! - p.a1 * z[6]! - p.a2 * z[7]!;
        z[5] = z[4]!; z[4] = y1; z[7] = z[6]!; z[6] = y2;
        this.sub += y2 * y2;
      }
      if (++this.subFrames === this.subLen) {
        this.subs.push(this.sub / this.subLen);
        this.sub = 0;
        this.subFrames = 0;
      }
    }
  }

  result(): Loudness {
    const peakDb = this.peak > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(this.peak)) : SILENCE_DB;
    const blocks: number[] = [];
    for (let i = 0; i + 4 <= this.subs.length; i++) blocks.push((this.subs[i]! + this.subs[i + 1]! + this.subs[i + 2]! + this.subs[i + 3]!) / 4);
    const lufsOf = (ms: number) => -0.691 + 10 * Math.log10(ms);
    const loud = blocks.filter((b) => b > 0 && lufsOf(b) > ABS_GATE);
    if (!loud.length) return { lufs: null, peakDb };
    const rel = lufsOf(loud.reduce((a, b) => a + b, 0) / loud.length) - REL_GATE;
    const kept = loud.filter((b) => lufsOf(b) > rel);
    return { lufs: kept.length ? lufsOf(kept.reduce((a, b) => a + b, 0) / kept.length) : null, peakDb };
  }
}
