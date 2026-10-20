import { sql } from 'drizzle-orm';
import type { Q } from './client.js';

/**
 * Ordered siblings carry a dense `position` 1..n with a unique index on (parent, position). Changes
 * shift the siblings in the order that never shows the unique index a duplicate (Bible, section 5).
 */
export type PositionTable = 'chapter' | 'scene' | 'segment' | 'lane';

const PARENT_COLUMN: Record<PositionTable, string> = {
  chapter: 'project_id',
  scene: 'chapter_id',
  segment: 'scene_id',
  lane: 'scene_id',
};

/** Parked position while a row is taken out of its list (smallint unsigned maximum). */
export const PARKED = 65535;

/** Makes room: siblings at `fromPosition` or later move one step up. */
export async function openGap(q: Q, table: PositionTable, parentId: string, fromPosition: number): Promise<void> {
  await q.execute(
    sql.raw(
      `UPDATE \`${table}\` SET position = position + 1 WHERE ${PARENT_COLUMN[table]} = '${safe(parentId)}' AND position >= ${int(fromPosition)} AND position < ${PARKED} ORDER BY position DESC`,
    ),
  );
}

/** Closes a gap: siblings after `afterPosition` move one step down. */
export async function closeGap(q: Q, table: PositionTable, parentId: string, afterPosition: number): Promise<void> {
  await q.execute(
    sql.raw(
      `UPDATE \`${table}\` SET position = position - 1 WHERE ${PARENT_COLUMN[table]} = '${safe(parentId)}' AND position > ${int(afterPosition)} AND position < ${PARKED} ORDER BY position ASC`,
    ),
  );
}

export async function parkRow(q: Q, table: PositionTable, id: string): Promise<void> {
  await q.execute(sql.raw(`UPDATE \`${table}\` SET position = ${PARKED} WHERE id = '${safe(id)}'`));
}

// The values above are ULIDs and integers produced by the app; these guards make a slip fail loudly.
function safe(value: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) throw new Error(`Not an id: ${value}`);
  return value;
}
function int(value: number): number {
  if (!Number.isInteger(value)) throw new Error(`Not an integer: ${value}`);
  return value;
}
