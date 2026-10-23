import { and, eq, isNull } from 'drizzle-orm';
import { inTransaction } from '../db/client.js';
import { clip, note } from '../db/schema.js';
import type { AssetRow } from '../library/files.js';
import { createNote } from './notes.js';

export const FIT_TASK_TEXT = 'Check if new audio is fitting';

/**
 * A recording was replaced by a different one. The cues that play it are not touched (same clip, same offset and
 * length); each gets one task asking someone to listen again. A cue that already has that task open gets no second one.
 * Returns how many tasks were added.
 */
export async function addFitTasks(userId: string, a: AssetRow): Promise<number> {
  if (a.mediaKind !== 'audio') return 0;
  return inTransaction(async (tx) => {
    const cues = [...new Set((await tx.select({ cueId: clip.cueId }).from(clip).where(eq(clip.assetId, a.id))).map((c) => c.cueId))];
    let added = 0;
    for (const cueId of cues) {
      const open = await tx.select({ id: note.id }).from(note)
        .where(and(eq(note.projectId, a.projectId), eq(note.cueId, cueId), eq(note.type, 'task'), eq(note.textMd, FIT_TASK_TEXT), isNull(note.doneAt), isNull(note.deletedAt)))
        .limit(1);
      if (open.length) continue;
      await createNote(tx, a.projectId, userId, 'user', { type: 'task', textMd: FIT_TASK_TEXT, target: { kind: 'cue', id: cueId } });
      added++;
    }
    return added;
  });
}
