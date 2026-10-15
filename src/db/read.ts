import type { drizzle } from 'drizzle-orm/mysql2';

type Db = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Runs `fn` inside one transaction that sees a single consistent snapshot
 * (START TRANSACTION WITH CONSISTENT SNAPSHOT under REPEATABLE READ), so a whole project can be
 * read for a snapshot push while other requests keep writing. The callback must only read.
 * Use a connection that is not shared with other work while it runs.
 *
 * No `accessMode: 'read only'`: Drizzle then emits `... consistent snapshot read only` without the
 * comma MySQL requires, which is a syntax error.
 */
export function readConsistent<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn, {
    isolationLevel: 'repeatable read',
    withConsistentSnapshot: true,
  });
}
