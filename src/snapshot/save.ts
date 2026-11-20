import { and, asc, eq, inArray } from 'drizzle-orm';
import { connect } from '../db/connection.js';
import { drizzle } from 'drizzle-orm/mysql2';
import { newUlid } from '../db/ids.js';
import { asset, chapter, character, clip, cue, lane, note, project, segment, scene, snapshot, generation, cueSfx } from '../db/schema.js';
import { buildSnapshotFiles, type Rows } from './build.js';
import type { VersionStore } from './version-store.js';

export interface SnapshotResult {
  id: string | null;
  sha: string | null;
  revision: number;
  /** True when nothing had changed against the repository, so no commit was made. */
  unchanged: boolean;
}

/** Reads the whole project in one consistent read-only view; returns its rows and the revision. */
export async function readProjectRows(projectId: string): Promise<{ rows: Rows; revision: number; title: string; folder: string } | null> {
  const conn = await connect();
  try {
    const db = drizzle(conn);
    // Drizzle's transaction options produce invalid SQL for this, so the transaction is opened by hand.
    await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try {
      const tx = db;
      return await (async () => {
        const p = (await tx.select().from(project).where(eq(project.id, projectId)).limit(1))[0];
        if (!p) return null;
        const chapters = await tx.select().from(chapter).where(eq(chapter.projectId, projectId)).orderBy(asc(chapter.position));
        const cIds = chapters.map((c) => c.id);
        const segments = cIds.length ? await tx.select().from(segment).where(inArray(segment.chapterId, cIds)) : [];
        const sIds = segments.map((s) => s.id);
        const scenes = sIds.length ? await tx.select().from(scene).where(inArray(scene.segmentId, sIds)) : [];
        const lanes = sIds.length ? await tx.select().from(lane).where(inArray(lane.segmentId, sIds)) : [];
        const gIds = scenes.map((s) => s.id);
        const cues = gIds.length ? await tx.select().from(cue).where(inArray(cue.sceneId, gIds)) : [];
        const qIds = cues.map((q) => q.id);
        const clips = qIds.length ? await tx.select().from(clip).where(inArray(clip.cueId, qIds)) : [];
        const characters = await tx.select().from(character).where(eq(character.projectId, projectId));
        const notes = await tx.select().from(note).where(and(eq(note.projectId, projectId), undefined));
        const assets = await tx.select().from(asset).where(eq(asset.projectId, projectId));
        const generations = await tx.select().from(generation).where(eq(generation.projectId, projectId));
        const sfx = gIds.length && cues.length ? await tx.select().from(cueSfx).where(inArray(cueSfx.cueId, cues.map((q) => q.id))) : [];
        const rows: Rows = { project: p, characters, chapters, segments, scenes, lanes, cues, clips, notes, assets, generations, sfx };
        return { rows, revision: Number(p.revision), title: p.title, folder: p.repoFolder ?? '' };
      })();
    } finally {
      await conn.query('COMMIT');
    }
  } finally {
    await conn.end();
  }
}

export async function saveSnapshot(store: VersionStore, projectId: string, userId: string, label?: string | null): Promise<SnapshotResult> {
  const read = await readProjectRows(projectId);
  if (!read) throw new Error('not_found');
  if (!read.folder) throw new Error('The project has no repository folder yet.');
  const files = buildSnapshotFiles(read.rows);
  const message = label?.trim() ? `${read.title}: ${label.trim()}` : `${read.title}: snapshot (revision ${read.revision})`;
  const { sha } = await store.commit({ folder: read.folder, files, message });

  const conn = await connect();
  try {
    const db = drizzle(conn);
    let id: string | null = null;
    if (sha) {
      id = newUlid();
      await db.insert(snapshot).values({ id, projectId, commitSha: sha, revision: read.revision, label: label?.trim() || null, createdByUserId: userId, createdAt: new Date() });
    }
    // Clean only when nothing was written meanwhile.
    await db.update(project).set({ dirtySince: null }).where(and(eq(project.id, projectId), eq(project.revision, read.revision)));
    return { id, sha, revision: read.revision, unchanged: sha === null };
  } finally {
    await conn.end();
  }
}
