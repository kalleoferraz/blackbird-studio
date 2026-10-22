import { fileURLToPath } from 'node:url';
import type { RowDataPacket } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { connect } from './connection.js';

// One name for the whole app; a second instance (Preview and Published share the database)
// waits here instead of running the same migration at the same time.
export const MIGRATION_LOCK_NAME = 'merulo_studio_migrate';
const LOCK_WAIT_SECONDS = 60;

// The folder written by `npm run db:generate`; the same relative path works from src/ and from dist/.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Applies the pending SQL migrations from ./drizzle under a MySQL advisory lock.
 * Throws if the lock is not
 * obtained in time or a migration fails; the caller decides whether that stops the app.
 */
export async function runMigrations(): Promise<void> {
  const conn = await connect();
  try {
    const [rows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS got', [MIGRATION_LOCK_NAME, LOCK_WAIT_SECONDS]);
    if (rows[0]?.got !== 1) {
      throw new Error(`Could not get the migration lock within ${LOCK_WAIT_SECONDS} s`);
    }
    try {
      await migrate(drizzle(conn), { migrationsFolder });
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK_NAME]);
    }
  } finally {
    await conn.end();
  }
}
