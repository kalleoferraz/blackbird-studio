import { eq, sql } from 'drizzle-orm';
import type { Q } from './client.js';
import { project, user } from './schema.js';

/**
 * Every write that ends up in a snapshot calls this at the end of its transaction (Bible, section 5,
 * Write path): the revision goes up, "last edited at" is set, "dirty since" is set if empty, and the
 * acting user's last edit time is set. App code, not a trigger.
 */
export async function touchProject(q: Q, projectId: string, userId: string): Promise<void> {
  const now = new Date();
  await q
    .update(project)
    .set({
      revision: sql`${project.revision} + 1`,
      lastEditedAt: now,
      dirtySince: sql`COALESCE(${project.dirtySince}, ${now})`,
      updatedAt: now,
    })
    .where(eq(project.id, projectId));
  await q.update(user).set({ lastEditAt: now }).where(eq(user.id, userId));
}
