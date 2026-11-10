// The audio settings of a take (clip): speed, pitch and level, each of which can also follow an envelope over time. The limits are shared by the server and the app.
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const PITCH_MAX_CENTS = 1200; // one octave either way
export const VOLUME_MIN_DB = -60;
export const VOLUME_MAX_DB = 30; // a take can be made much louder than it was recorded
export const LEVEL_MIN_DB = -24; // the Level slider
export const LEVEL_MAX_DB = 30;
export const MAX_VOLUME_POINTS = 64;

/**
 * The three things an envelope can change over the length of a take. Each envelope is relative to the setting it belongs to:
 * a speed factor times the Speed setting, cents added to the Pitch setting, dB added to the Level setting.
 */
export type EnvelopeKind = 'level' | 'pitch' | 'speed';
export const ENVELOPE_RANGE: Record<EnvelopeKind, { min: number; max: number; neutral: number }> = {
  level: { min: VOLUME_MIN_DB, max: VOLUME_MAX_DB, neutral: 0 },
  pitch: { min: -PITCH_MAX_CENTS, max: PITCH_MAX_CENTS, neutral: 0 },
  speed: { min: SPEED_MIN, max: SPEED_MAX, neutral: 1 },
};

/** A point of an envelope: milliseconds from the start of the take as it plays, and the value at that moment (dB, cents or a speed factor). */
export type EnvelopePoint = [ms: number, value: number];
export type VolumePoint = EnvelopePoint;

/**
 * An envelope as stored: sorted by time, whole milliseconds, the value to two places. Returns null for "no envelope" (null, or an empty list)
 * and undefined when the value is not a valid envelope.
 */
export function cleanPoints(v: unknown, maxMs: number, kind: EnvelopeKind): EnvelopePoint[] | null | undefined {
  if (v === null || (Array.isArray(v) && v.length === 0)) return null;
  if (!Array.isArray(v) || v.length > MAX_VOLUME_POINTS) return undefined;
  const { min, max } = ENVELOPE_RANGE[kind];
  const out: EnvelopePoint[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return undefined;
    const [ms, val] = p as unknown[];
    if (typeof ms !== 'number' || typeof val !== 'number' || !Number.isFinite(ms) || !Number.isFinite(val)) return undefined;
    if (ms < 0 || ms > maxMs || val < min || val > max) return undefined;
    out.push([Math.round(ms), Math.round(val * 100) / 100]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
export const cleanVolumePoints = (v: unknown, maxMs: number) => cleanPoints(v, maxMs, 'level');

/** The envelope's value at `ms`: linear between the points (a speed factor in octaves, so that 0.5 and 2 are equally far from 1), flat before the first and after the last; neutral without an envelope. */
export function envelopeValue(points: readonly EnvelopePoint[] | null | undefined, ms: number, kind: EnvelopeKind): number {
  if (!points || points.length === 0) return ENVELOPE_RANGE[kind].neutral;
  const f = kind === 'speed' ? Math.log2 : (x: number) => x;
  const first = points[0]!, last = points[points.length - 1]!;
  let v: number;
  if (ms <= first[0]) v = f(first[1]);
  else if (ms >= last[0]) v = f(last[1]);
  else {
    let i = 1;
    while (points[i]![0] < ms) i++;
    const a = points[i - 1]!, b = points[i]!;
    v = b[0] === a[0] ? f(b[1]) : f(a[1]) + ((f(b[1]) - f(a[1])) * (ms - a[0])) / (b[0] - a[0]);
  }
  return kind === 'speed' ? 2 ** v : v;
}

/** The volume envelope's gain (a factor) at `ms`; 1 without an envelope. */
export function envelopeGain(points: readonly EnvelopePoint[] | null | undefined, ms: number): number {
  return 10 ** (envelopeValue(points, ms, 'level') / 20);
}

/** How far into the source (ms) a take has got after `ms` of playing, at the base speed times the speed envelope. */
export function sourceAt(baseSpeed: number, points: readonly EnvelopePoint[] | null | undefined, ms: number): number {
  if (!points || points.length === 0) return ms * baseSpeed;
  // Between two points the factor is 2^l with l linear, so each stretch has a closed form; before the first and after the last it is constant.
  const seg = (dt: number, l0: number, l1: number) => (l1 === l0 ? dt * 2 ** l0 : (dt * (2 ** l1 - 2 ** l0)) / ((l1 - l0) * Math.LN2));
  let acc = 0, t = 0, l = Math.log2(points[0]![1]);
  const first = points[0]!;
  if (ms <= first[0]) return ms * baseSpeed * 2 ** l;
  acc += first[0] * 2 ** l; t = first[0];
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!, lb = Math.log2(b[1]);
    if (ms <= b[0]) {
      const lm = b[0] === t ? lb : l + ((lb - l) * (ms - t)) / (b[0] - t);
      return baseSpeed * (acc + seg(ms - t, l, lm));
    }
    acc += seg(b[0] - t, l, lb); t = b[0]; l = lb;
  }
  return baseSpeed * (acc + (ms - t) * 2 ** l);
}
