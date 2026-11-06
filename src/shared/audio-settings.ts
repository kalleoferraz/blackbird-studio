// The audio settings of a take (clip): speed, pitch and the volume envelope. The limits are shared by the server and the app.
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const PITCH_MAX_CENTS = 1200; // one octave either way
export const VOLUME_MIN_DB = -60;
export const VOLUME_MAX_DB = 12;
export const MAX_VOLUME_POINTS = 64;

/** A point of the volume envelope: milliseconds from the start of the take as it plays, and the gain in dB at that moment. */
export type VolumePoint = [ms: number, db: number];

/**
 * The volume envelope as stored: sorted by time, whole milliseconds, dB to two places. Returns null for "no envelope" (null, or an empty list)
 * and undefined when the value is not a valid envelope.
 */
export function cleanVolumePoints(v: unknown, maxMs: number): VolumePoint[] | null | undefined {
  if (v === null || (Array.isArray(v) && v.length === 0)) return null;
  if (!Array.isArray(v) || v.length > MAX_VOLUME_POINTS) return undefined;
  const out: VolumePoint[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return undefined;
    const [ms, db] = p as unknown[];
    if (typeof ms !== 'number' || typeof db !== 'number' || !Number.isFinite(ms) || !Number.isFinite(db)) return undefined;
    if (ms < 0 || ms > maxMs || db < VOLUME_MIN_DB || db > VOLUME_MAX_DB) return undefined;
    out.push([Math.round(ms), Math.round(db * 100) / 100]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** The envelope's gain (a factor) at `ms`: linear in dB between the points, flat before the first and after the last; 1 without an envelope. */
export function envelopeGain(points: readonly VolumePoint[] | null | undefined, ms: number): number {
  if (!points || points.length === 0) return 1;
  const first = points[0]!, last = points[points.length - 1]!;
  let db: number;
  if (ms <= first[0]) db = first[1];
  else if (ms >= last[0]) db = last[1];
  else {
    let i = 1;
    while (points[i]![0] < ms) i++;
    const a = points[i - 1]!, b = points[i]!;
    db = b[0] === a[0] ? b[1] : a[1] + ((b[1] - a[1]) * (ms - a[0])) / (b[0] - a[0]);
  }
  return 10 ** (db / 20);
}
