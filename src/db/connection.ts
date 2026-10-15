import mysql, { type Connection } from 'mysql2/promise';

/**
 * Database connection settings, read from the environment the host injects (see .env.example).
 * Throws a clear error when one is missing instead of connecting to the wrong place.
 */
export function dbConfig() {
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing environment variable ${name}`);
    return value;
  };
  return {
    host: need('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 3306),
    database: need('DB_NAME'),
    user: need('DB_USER'),
    password: need('DB_PASSWORD'),
    // Dates are stored in UTC as DATETIME(3) and set by the app.
    timezone: 'Z',
    dateStrings: false,
  };
}

/**
 * A short-lived connection, as the host recommends (no long-lived pool).
 * The caller closes it with `await conn.end()`.
 */
export async function connect(): Promise<Connection> {
  return mysql.createConnection(dbConfig());
}
