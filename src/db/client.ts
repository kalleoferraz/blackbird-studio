import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { connect } from './connection.js';

export type Db = MySql2Database;

/** Runs `fn` on a short-lived connection (the host recommends no long-lived pool) and closes it afterwards. */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const conn = await connect();
  try {
    return await fn(drizzle(conn));
  } finally {
    await conn.end();
  }
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Something that can run queries: a connection or a transaction. */
export type Q = Db | Tx;

/** Runs `fn` in one transaction on a short-lived connection. */
export function inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withDb((db) => db.transaction(fn));
}
