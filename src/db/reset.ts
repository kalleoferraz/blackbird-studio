import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { connect } from './connection.js';
import { MIGRATION_LOCK_NAME } from './migrate.js';

/**
 * One-time wipe of the database and the library, for hosts without a shell or SQL access.
 *
 * Set RESET_ALL_DATA to any tag (for example 2026-10-22) and start the app: every table is dropped
 * (Drizzle's migrations table included), the library folder is emptied, and the migrations then
 * rebuild an empty database from the single init migration. The tag is remembered in a marker file
 * next to the library folder, so a restart with the variable still set does not wipe again.
 * A new tag wipes again. Remove the variable after the first healthy start anyway.
 *
 * Not touched: the snapshot repository on GitHub (archive or empty it by hand) and the environment settings.
 */

/** The library folder, the same one the BlobStore uses. */
export function libraryRoot(): string {
  return path.resolve(process.env.LIBRARY_ROOT || path.resolve(process.cwd(), 'library'));
}

/**
 * Refuses a root that is not clearly a library folder, so a wrong LIBRARY_ROOT can never empty
 * a bigger folder: it must be called `library` and sit at least two levels below the file system root.
 */
export function assertWipeableRoot(root: string): void {
  const parts = path.resolve(root).split(path.sep).filter(Boolean);
  if (path.basename(root) !== 'library' || parts.length < 2) {
    throw new Error(`Refusing to empty "${root}": the library folder must be named "library" (for example /private/library)`);
  }
}

/** Where the reset for a tag is remembered: next to the library folder, so the wipe does not remove it. */
export function markerPath(root: string, tag: string): string {
  return path.join(path.dirname(root), `.reset-${tag.replace(/[^A-Za-z0-9._-]/g, '_')}`);
}

/** Empties the library folder but keeps the folder itself. */
export function emptyLibrary(root: string): number {
  assertWipeableRoot(root);
  if (!existsSync(root)) return 0;
  const entries = readdirSync(root);
  for (const name of entries) rmSync(path.join(root, name), { recursive: true, force: true });
  return entries.length;
}

/** Drops every table of the configured database, whatever its name. */
export async function dropAllTables(): Promise<string[]> {
  const conn = await connect();
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = \'BASE TABLE\'',
    );
    const names = rows.map((r) => String(r.name));
    if (names.length === 0) return names;
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const name of names) await conn.query(`DROP TABLE \`${name.replace(/`/g, '``')}\``);
    } finally {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    return names;
  } finally {
    await conn.end();
  }
}

interface Log {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Runs the wipe when RESET_ALL_DATA is set and its tag has not been applied yet.
 * Call it before the migrations; the returned function writes the marker and is called after they succeed.
 * Returns null when nothing was wiped.
 */
export async function resetIfRequested(log: Log): Promise<(() => void) | null> {
  const tag = process.env.RESET_ALL_DATA?.trim();
  if (!tag) return null;
  const root = libraryRoot();
  const marker = markerPath(root, tag);
  if (existsSync(marker)) {
    log.warn(`RESET_ALL_DATA=${tag} was already applied; nothing wiped. Remove the variable.`);
    return null;
  }
  assertWipeableRoot(root);
  // The same lock as the migrations, so Preview and Published cannot wipe and migrate at once.
  const conn = await connect();
  try {
    const [rows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 60) AS got', [MIGRATION_LOCK_NAME]);
    if (rows[0]?.got !== 1) throw new Error('Could not get the migration lock to reset the data');
    try {
      if (existsSync(marker)) return null; // the other instance did it while this one waited
      const files = emptyLibrary(root);
      const tables = await dropAllTables();
      log.warn(`RESET_ALL_DATA=${tag}: dropped ${tables.length} tables and removed ${files} library entries.`);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK_NAME]);
    }
  } finally {
    await conn.end();
  }
  return () => {
    writeFileSync(marker, `${new Date().toISOString()}\n`);
    log.warn(`Reset ${tag} done. Remove RESET_ALL_DATA and redeploy.`);
  };
}
