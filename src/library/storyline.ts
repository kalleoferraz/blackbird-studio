/**
 * Where a take made in a cue goes (Bible, section 6, Storyline naming):
 *   Storyline/{chapter index} - {chapter}/{segment no.} - {segment}/{scene no.}.{MMSS} - {lane} - {text} ({R|G}{n}).ext
 * Title parts are plain ASCII: the chapter, segment and lane at most 10 characters, the cue's text at most 30.
 * R marks a recorded take, G a generated one (text to speech, sound effect, music or voice changer); n counts the
 * cue's takes of that kind (2026-11-20).
 */
import { and, count, eq, inArray, like } from 'drizzle-orm';
import type { Q } from '../db/client.js';
import { asset, chapter, clip, cue, lane, scene, segment } from '../db/schema.js';
import { notFound } from '../server/http.js';
import { STORYLINE, chapterIndexLabel } from './managed.js';

const PART_MAX = 10;
/** The cue's text gets more room, so a take's file name says which line it is. */
export const TEXT_PART_MAX = 30;

/** Plain ASCII, no unsafe characters, at most `max` characters (10 by default); empty becomes "untitled". */
export function sanitizePart(input: string, max = PART_MAX): string {
  const ascii = String(input ?? '')
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/Æ/g, 'AE').replace(/ø/g, 'o').replace(/Ø/g, 'O').replace(/đ/g, 'd').replace(/ł/g, 'l')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = ascii.slice(0, max).trim();
  return cut || 'untitled';
}

const two = (n: number) => String(n).padStart(2, '0');

export type TakeKind = 'R' | 'G';
/** R for a recorded take, G for every other origin (generated, voice-converted). */
export const takeKind = (origin: string): TakeKind => (origin === 'human-recorded' ? 'R' : 'G');

/**
 * The folder and file name (without extension) for the next take of a kind in a cue. `ahead` counts takes of that
 * kind being stored in the same request before this one. A name a file already has (an orphan kept after its take
 * was removed, say) is skipped, so the number may jump.
 */
export async function storylineName(q: Q, cueId: string, kind: TakeKind, ahead = 0): Promise<{ folder: string; base: string }> {
  const row = (
    await q
      .select({
        startMs: cue.startMs,
        text: cue.textMd,
        lane: lane.title,
        scenePos: scene.position,
        segPos: segment.position,
        segTitle: segment.title,
        chapterId: chapter.id,
        chapterPos: chapter.position,
        chapterTitle: chapter.title,
        intro: chapter.introductory,
        projectId: chapter.projectId,
      })
      .from(cue)
      .innerJoin(lane, eq(lane.id, cue.laneId))
      .innerJoin(scene, eq(scene.id, cue.sceneId))
      .innerJoin(segment, eq(segment.id, scene.segmentId))
      .innerJoin(chapter, eq(chapter.id, segment.chapterId))
      .where(eq(cue.id, cueId))
      .limit(1)
  )[0];
  if (!row) throw notFound();
  const introCount = Number(
    (await q.select({ n: count() }).from(chapter).where(and(eq(chapter.projectId, row.projectId), eq(chapter.introductory, true))))[0]?.n ?? 0,
  );
  const sec = Math.floor(row.startMs / 1000);
  const mmss = two(Math.floor(sec / 60)) + two(sec % 60);
  const folder = [
    STORYLINE,
    `${chapterIndexLabel(row.chapterPos, row.intro, introCount)} - ${sanitizePart(row.chapterTitle)}`,
    `${two(row.segPos)} - ${sanitizePart(row.segTitle)}`,
  ].join('/');
  const stem = `${two(row.scenePos)}.${mmss} - ${sanitizePart(row.lane)} - ${sanitizePart(row.text, TEXT_PART_MAX)}`;
  const origins = kind === 'R' ? ['human-recorded'] as const : ['generated', 'voice-converted'] as const;
  const have = Number((await q.select({ n: count() }).from(clip).where(and(eq(clip.cueId, cueId), inArray(clip.origin, [...origins]))))[0]?.n ?? 0);
  // Names already used in the folder (any extension, any letter case: paths compare case-insensitively).
  const taken = new Set((await q.select({ p: asset.path }).from(asset)
    .where(and(eq(asset.projectId, row.projectId), like(asset.path, `${folder}/${stem} (${kind}%`)))).map((r) => r.p.toLowerCase().replace(/\.[^./]+$/, '')));
  let n = have + 1 + ahead;
  while (taken.has(`${folder}/${stem} (${kind}${n})`.toLowerCase())) n++;
  return { folder, base: `${stem} (${kind}${n})` };
}
