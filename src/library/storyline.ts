/**
 * Where a recording made in a cue goes (Bible, section 6, Storyline naming):
 *   Storyline/{chapter index} - {chapter}/{segment no.} - {segment}/{scene no.}.{MMSS} - {lane} - {text} ({n}).ext
 * Every title part is plain ASCII and at most 10 characters.
 */
import { and, count, eq } from 'drizzle-orm';
import type { Q } from '../db/client.js';
import { chapter, cue, lane, scene, segment } from '../db/schema.js';
import { notFound } from '../server/http.js';
import { STORYLINE, chapterIndexLabel } from './managed.js';

const PART_MAX = 10;

/** Plain ASCII, no unsafe characters, at most 10 characters; empty becomes "untitled". */
export function sanitizePart(input: string): string {
  const ascii = String(input ?? '')
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/Æ/g, 'AE').replace(/ø/g, 'o').replace(/Ø/g, 'O').replace(/đ/g, 'd').replace(/ł/g, 'l')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = ascii.slice(0, PART_MAX).trim();
  return cut || 'untitled';
}

const two = (n: number) => String(n).padStart(2, '0');

/** The folder and file name (without extension) for take `n` of a cue. */
export async function storylineName(q: Q, cueId: string, n: number): Promise<{ folder: string; base: string }> {
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
  const base = `${two(row.scenePos)}.${mmss} - ${sanitizePart(row.lane)} - ${sanitizePart(row.text)} (${n})`;
  return { folder, base };
}
