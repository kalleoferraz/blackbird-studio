import { and, asc, eq } from 'drizzle-orm';
import { withDb } from '../db/client.js';
import { asset, clip, cue, scene } from '../db/schema.js';
import { blobStore } from '../storage/blob-store.js';
import { loudnessColumns } from '../audio/jobs.js';
import type { Loudness } from '../audio/loudness.js';
import { MP3_KBPS } from '../audio/encode.js';
import { encodePool } from '../audio/pool.js';
import { LEVEL_MAX_DB, LEVEL_MIN_DB } from '../shared/audio-settings.js';

/**
 * Lane levels (Bible, decision log 2026-11-20): a new take (recorded, generated or chosen from the library) gets the level
 * that makes it sound as loud as the cue just before it on its lane plays (that take's loudness plus its level). The first
 * take of a lane aims at FIRST_TAKE_LUFS. The level is an ordinary level: shown in the take's settings and changed by hand.
 */
export const FIRST_TAKE_LUFS = -18;
/** An automatic level never raises a take by more than this, and never lifts its loudest sample above PEAK_CEILING_DB. */
export const AUTO_MAX_BOOST_DB = 12;
export const PEAK_CEILING_DB = -1;

export interface AutoLevel { gainDb: number; levelAuto: 'auto' | 'limited' }

const isWavBytes = (b: Uint8Array) => b.length > 12 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WAVE';

/** Measures audio bytes (WAV or MP3) in the audio worker. Null when the format cannot be read. */
export async function measureBytes(data: Uint8Array): Promise<Loudness | null> {
  try {
    const wav = isWavBytes(data);
    return (await encodePool().process({ kind: wav ? 'wav' : 'mp3', data, kbps: MP3_KBPS, peaksOnly: true })).loudness;
  } catch {
    return null;
  }
}

const fromRow = (r: { loudnessLufs: string | null; peakDb: string | null }): Loudness | null =>
  r.peakDb === null ? null : { lufs: r.loudnessLufs === null ? null : Number(r.loudnessLufs), peakDb: Number(r.peakDb) };

/** Keeps a measurement on the asset (only when it has none yet). */
export async function saveLoudness(assetId: string, l: Loudness): Promise<void> {
  await withDb((db) => db.update(asset).set(loudnessColumns(l)).where(and(eq(asset.id, assetId), eq(asset.mediaKind, 'audio'))));
}

/** The loudness of an audio asset of the project: stored, or measured from its file now (and stored). Null if it cannot be had. */
export async function assetLoudness(projectId: string, assetId: string): Promise<Loudness | null> {
  const row = (await withDb((db) => db.select().from(asset).where(and(eq(asset.id, assetId), eq(asset.projectId, projectId))).limit(1)))[0];
  if (!row || row.mediaKind !== 'audio' || row.fileState === 'missing') return null;
  const stored = fromRow(row);
  if (stored) return stored;
  const format = (row.mediaInfo as { format?: string } | null)?.format;
  if (format !== 'wav' && format !== 'mp3') return null;
  try {
    const chunks: Buffer[] = [];
    for await (const c of blobStore().read(row.projectId, row.path)) chunks.push(c as Buffer);
    const l = await measureBytes(Buffer.concat(chunks));
    if (l) await saveLoudness(assetId, l);
    return l;
  } catch {
    return null;
  }
}

/**
 * The loudness a new take of this cue should have: the nearest earlier cue on the same lane (scenes in order, then start
 * time) whose chosen take can be measured; if none, the nearest later one; if none, FIRST_TAKE_LUFS.
 */
export async function laneTarget(projectId: string, cueId: string): Promise<number> {
  const me = (await withDb((db) => db.select({ laneId: cue.laneId }).from(cue).where(eq(cue.id, cueId)).limit(1)))[0];
  if (!me) return FIRST_TAKE_LUFS;
  const rows = await withDb((db) => db
    .select({ id: cue.id, assetId: clip.assetId, gainDb: clip.gainDb })
    .from(cue)
    .innerJoin(scene, eq(scene.id, cue.sceneId))
    .leftJoin(clip, eq(clip.id, cue.clipId))
    .where(eq(cue.laneId, me.laneId))
    .orderBy(asc(scene.position), asc(cue.startMs), asc(cue.id)));
  const at = rows.findIndex((r) => r.id === cueId);
  if (at < 0) return FIRST_TAKE_LUFS;
  const order = [...rows.slice(0, at).reverse(), ...rows.slice(at + 1)];
  for (const r of order) {
    if (!r.assetId) continue;
    const l = await assetLoudness(projectId, r.assetId);
    if (l?.lufs != null) return l.lufs + Number(r.gainDb ?? 0);
  }
  return FIRST_TAKE_LUFS;
}

/** The level that brings a take of this loudness to the target, within the limits. Null when the take has no measurable loudness. */
export function levelFor(l: Loudness | null, target: number): AutoLevel | null {
  if (l?.lufs == null) return null;
  const wanted = target - l.lufs;
  const max = Math.min(AUTO_MAX_BOOST_DB, LEVEL_MAX_DB, PEAK_CEILING_DB - l.peakDb);
  const gain = Math.max(LEVEL_MIN_DB, Math.min(max, wanted));
  return { gainDb: Math.round(gain * 10) / 10, levelAuto: Math.abs(gain - wanted) > 0.05 ? 'limited' : 'auto' };
}

/** The automatic level of a new take of the cue, from its measured loudness. */
export async function autoLevel(projectId: string, cueId: string, l: Loudness | null): Promise<AutoLevel | null> {
  if (l?.lufs == null) return null;
  return levelFor(l, await laneTarget(projectId, cueId));
}
