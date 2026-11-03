import { sql } from 'drizzle-orm';
import { withDb, type Q } from '../db/client.js';
import { asset, project } from '../db/schema.js';
import { blobStore } from '../storage/blob-store.js';

/**
 * The folders the app creates and manages in every media project's library. Their spelling lives here only:
 * the library routes, the picture upload and the startup normalisation all use these names.
 */
export const STORYLINE = 'Storyline';
export const CHARACTERS = 'Characters';
export const MANAGED_ROOTS = [STORYLINE, CHARACTERS] as const;

const lower = (s: string) => s.toLowerCase();

/** `Storyline` itself or anything below it (any letter case, as the library treats names case-insensitively). */
export const isStoryline = (p: string) => lower(p) === lower(STORYLINE) || lower(p).startsWith(lower(STORYLINE) + '/');
export const isCharactersRoot = (p: string) => lower(p) === lower(CHARACTERS);

/** The library folder of a character; its profile picture is the file `profile.<ext>` in it. */
export const pictureFolder = (characterFolder: string) => `${CHARACTERS}/${characterFolder}`;

/**
 * Brings one project's managed folders to the current spelling: the folders on disk and the paths of the files in
 * them (`path` and `lightweight_path`). Safe to repeat. Returns what it changed.
 */
export async function normalizeManagedFolders(q: Q, projectId: string): Promise<{ folders: number; files: number }> {
  let folders = 0;
  let files = 0;
  const blobs = blobStore();
  for (const canonical of MANAGED_ROOTS) {
    const n = canonical.length;
    // The path columns compare without regard to case, so BINARY tells the spellings apart.
    for (const col of ['path', 'lightweight_path'] as const) {
      const c = sql.raw('`' + col + '`');
      const r = await q.execute(
        sql`UPDATE ${asset} SET ${c} = CONCAT(${canonical}, SUBSTRING(${c}, ${n + 1}))
            WHERE ${asset.projectId} = ${projectId} AND ${c} IS NOT NULL
              AND (${c} = ${canonical} OR ${c} LIKE ${canonical + '/%'})
              AND BINARY LEFT(${c}, ${n}) <> BINARY ${canonical}`,
      );
      if (col === 'path') files += Number((r as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
    }
    const spelled = (await blobs.listDirs(projectId, '')).filter((d) => lower(d) === lower(canonical));
    // Two spellings side by side can only happen on a case-sensitive disk; merging them is left to a person.
    if (spelled.length === 1 && spelled[0] !== canonical) {
      // A case-only change is two renames, because the disk may treat both spellings as one name.
      await blobs.rename(projectId, spelled[0]!, `${canonical}.renaming`);
      await blobs.rename(projectId, `${canonical}.renaming`, canonical);
      folders++;
    }
  }
  return { folders, files };
}

/** Startup task: normalises every project's managed folders. A failure in one project does not stop the others. */
export async function normalizeAllManagedFolders(log?: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void }): Promise<void> {
  const ids = await withDb((db) => db.select({ id: project.id }).from(project));
  for (const { id } of ids) {
    try {
      const done = await withDb((db) => normalizeManagedFolders(db, id));
      if (done.folders || done.files) log?.info({ project: id, ...done }, 'Managed library folders renamed');
    } catch (e) {
      log?.error({ project: id, err: e }, 'Could not normalise the managed library folders');
    }
  }
}

/** A chapter's index in file and folder names: `00A` to `00Z` for introductory chapters, `01` to `99` for the others. */
export function chapterIndexLabel(position: number, introductory: boolean, introCount: number): string {
  if (introductory) return `00${String.fromCharCode(64 + position)}`;
  return String(position - introCount).padStart(2, '0');
}
