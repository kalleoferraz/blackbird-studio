import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { connect } from '../db/connection.js';

/**
 * DATABASE SPIKE. Temporary: remove before real data goes in (see "Spike cleanup" in the Bible).
 *
 * GET /spike/db-schema   header: x-spike-token: <SPIKE_TOKEN>
 *
 * Preview and Published share one database, so this never touches real tables. It creates its own
 * throw-away tables, all prefixed `spk_`, runs every check on them, and drops them again (also after a failure).
 * The checks answer the open questions in the Bible, section 10 ("Database spike").
 */

type Check = { name: string; ok: boolean; detail: unknown };

const TABLES = ['spk_note', 'spk_chapter', 'spk_clip', 'spk_cue', 'spk_asset', 'spk_project', 'spk_check'];

/** A fixed-width fake ULID so rows are easy to read. */
const id = (n: number): string => String(n).padStart(26, '0');

const ID = 'char(26) character set ascii collate ascii_bin';
const CI = 'character set utf8mb4 collate utf8mb4_unicode_ci';

let running = false;

function errorInfo(e: unknown): { code?: string; message: string } {
  const err = e as { code?: string; sqlMessage?: string; message?: string };
  return { code: err.code, message: err.sqlMessage ?? err.message ?? String(e) };
}

async function rows(conn: Connection, sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await conn.query<RowDataPacket[]>(sql, params);
  return result;
}

async function dropAll(conn: Connection): Promise<void> {
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const t of TABLES) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

/** The minimum structure each check needs, with the same key types, collations and delete rules as the real schema. */
async function createTables(conn: Connection): Promise<void> {
  await conn.query(`CREATE TABLE spk_project (
    id ${ID} NOT NULL PRIMARY KEY,
    title varchar(50) NOT NULL,
    cover_asset_id ${ID} NULL
  ) ENGINE=InnoDB`);
  await conn.query(`CREATE TABLE spk_asset (
    id ${ID} NOT NULL PRIMARY KEY,
    project_id ${ID} NOT NULL,
    path varchar(255) ${CI} NOT NULL,
    UNIQUE KEY spk_asset_path_uq (project_id, path),
    CONSTRAINT spk_asset_project_fk FOREIGN KEY (project_id) REFERENCES spk_project (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  // stand-in for the chain project > chapter > scene > segment > cue
  await conn.query(`CREATE TABLE spk_cue (
    id ${ID} NOT NULL PRIMARY KEY,
    project_id ${ID} NOT NULL,
    clip_id ${ID} NULL,
    CONSTRAINT spk_cue_project_fk FOREIGN KEY (project_id) REFERENCES spk_project (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await conn.query(`CREATE TABLE spk_clip (
    id ${ID} NOT NULL PRIMARY KEY,
    cue_id ${ID} NOT NULL,
    asset_id ${ID} NOT NULL,
    CONSTRAINT spk_clip_cue_fk FOREIGN KEY (cue_id) REFERENCES spk_cue (id) ON DELETE CASCADE,
    CONSTRAINT spk_clip_asset_fk FOREIGN KEY (asset_id) REFERENCES spk_asset (id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  // the two cycles are closed afterwards, as drizzle-kit does
  await conn.query(
    'ALTER TABLE spk_cue ADD CONSTRAINT spk_cue_clip_fk FOREIGN KEY (clip_id) REFERENCES spk_clip (id) ON DELETE SET NULL',
  );
  await conn.query(
    'ALTER TABLE spk_project ADD CONSTRAINT spk_project_cover_fk FOREIGN KEY (cover_asset_id) REFERENCES spk_asset (id) ON DELETE SET NULL',
  );
  await conn.query(`CREATE TABLE spk_chapter (
    id ${ID} NOT NULL PRIMARY KEY,
    project_id ${ID} NOT NULL,
    position smallint unsigned NOT NULL,
    UNIQUE KEY spk_chapter_position_uq (project_id, position),
    CONSTRAINT spk_chapter_project_fk FOREIGN KEY (project_id) REFERENCES spk_project (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await conn.query(`CREATE TABLE spk_note (
    id ${ID} NOT NULL PRIMARY KEY,
    project_id ${ID} NOT NULL,
    ref_key varchar(24) ${CI} NULL,
    UNIQUE KEY spk_note_ref_key_uq (project_id, ref_key),
    CONSTRAINT spk_note_project_fk FOREIGN KEY (project_id) REFERENCES spk_project (id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}

async function check(checks: Check[], name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    checks.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    checks.push({ name, ok: false, detail: errorInfo(e) });
  }
}

/** Runs `fn`; the result says whether it threw (and the error), so a check can assert that something fails. */
async function attempt(fn: () => Promise<unknown>): Promise<{ failed: boolean; error?: { code?: string; message: string } }> {
  try {
    await fn();
    return { failed: false };
  } catch (e) {
    return { failed: true, error: errorInfo(e) };
  }
}

async function count(conn: Connection, table: string, where = '1=1', params: unknown[] = []): Promise<number> {
  const r = await rows(conn, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(r[0]?.n ?? -1);
}

async function runChecks(conn: Connection, checks: Check[]): Promise<void> {
  // 1. Server facts and feature support
  await check(checks, 'server facts', async () => {
    const r = await rows(
      conn,
      `SELECT VERSION() AS version, @@version_comment AS comment, @@sql_mode AS sql_mode,
              @@character_set_database AS charset_db, @@collation_database AS collation_db,
              @@max_allowed_packet AS max_allowed_packet, @@lower_case_table_names AS lower_case_table_names`,
    );
    const first: RowDataPacket = r[0] ?? ({} as RowDataPacket);
    const version = String(first.version ?? '');
    return { ...first, is_mariadb: /mariadb/i.test(version + String(first.comment ?? '')) };
  });

  await check(checks, 'isolation level', async () => {
    try {
      return (await rows(conn, 'SELECT @@transaction_isolation AS level'))[0];
    } catch {
      return (await rows(conn, 'SELECT @@tx_isolation AS level'))[0];
    }
  });

  await check(checks, 'JSON functions', async () => (await rows(conn, `SELECT JSON_EXTRACT('{"a":1}', '$.a') AS a`))[0]);

  await check(checks, 'CHECK constraints are enforced', async () => {
    await conn.query('CREATE TABLE spk_check (x int, CONSTRAINT spk_check_positive CHECK (x > 0)) ENGINE=InnoDB');
    const insert = await attempt(() => conn.query('INSERT INTO spk_check (x) VALUES (0)'));
    return { enforced: insert.failed, insertOfInvalidRowFailed: insert.failed, error: insert.error };
  });

  await check(checks, 'triggers can be created', async () => {
    const created = await attempt(() =>
      conn.query('CREATE TRIGGER spk_check_bi BEFORE INSERT ON spk_check FOR EACH ROW SET NEW.x = NEW.x'),
    );
    if (!created.failed) await conn.query('DROP TRIGGER IF EXISTS spk_check_bi');
    return { allowed: !created.failed, error: created.error };
  });

  await check(checks, 'advisory lock (GET_LOCK) between two connections', async () => {
    const other = await connect();
    try {
      const a = (await rows(conn, `SELECT GET_LOCK('spk_lock', 1) AS got`))[0]?.got;
      const b = (await rows(other, `SELECT GET_LOCK('spk_lock', 1) AS got`))[0]?.got;
      await rows(conn, `SELECT RELEASE_LOCK('spk_lock')`);
      const c = (await rows(other, `SELECT GET_LOCK('spk_lock', 1) AS got`))[0]?.got;
      await rows(other, `SELECT RELEASE_LOCK('spk_lock')`);
      return { firstGot: a, secondWhileHeld: b, secondAfterRelease: c, works: a === 1 && b === 0 && c === 1 };
    } finally {
      await other.end();
    }
  });

  // 2. cue.clip_id: cycle, SET NULL, and cascade
  const P1 = id(1);
  await conn.query('INSERT INTO spk_project (id, title) VALUES (?, ?)', [P1, 'cycle test']);
  await conn.query('INSERT INTO spk_asset (id, project_id, path) VALUES (?, ?, ?)', [id(11), P1, 'a.wav']);
  await conn.query('INSERT INTO spk_cue (id, project_id) VALUES (?, ?), (?, ?)', [id(21), P1, id(22), P1]);
  await conn.query('INSERT INTO spk_clip (id, cue_id, asset_id) VALUES (?, ?, ?), (?, ?, ?)', [
    id(31), id(21), id(11), id(32), id(22), id(11),
  ]);
  await conn.query('UPDATE spk_cue SET clip_id = ? WHERE id = ?', [id(31), id(21)]);
  await conn.query('UPDATE spk_cue SET clip_id = ? WHERE id = ?', [id(32), id(22)]);

  await check(checks, 'deleting a clip sets cue.clip_id to NULL', async () => {
    await conn.query('DELETE FROM spk_clip WHERE id = ?', [id(32)]);
    const cue = (await rows(conn, 'SELECT clip_id FROM spk_cue WHERE id = ?', [id(22)]))[0];
    return { cueClipIdNow: cue?.clip_id ?? null, ok: cue?.clip_id === null };
  });

  await check(checks, 'deleting a cue cascades to its clips although cue.clip_id points back (the cycle)', async () => {
    const del = await attempt(() => conn.query('DELETE FROM spk_cue WHERE id = ?', [id(21)]));
    return {
      deleteFailed: del.failed,
      error: del.error,
      clipsLeftForDeletedCue: await count(conn, 'spk_clip', 'cue_id = ?', [id(21)]),
    };
  });

  // 3. deleting a whole project while RESTRICT keys exist
  await conn.query('INSERT INTO spk_project (id, title) VALUES (?, ?)', [id(2), 'one cascade']);
  await conn.query('INSERT INTO spk_asset (id, project_id, path) VALUES (?, ?, ?)', [id(12), id(2), 'b.wav']);
  await conn.query('INSERT INTO spk_cue (id, project_id) VALUES (?, ?)', [id(23), id(2)]);
  await conn.query('INSERT INTO spk_clip (id, cue_id, asset_id) VALUES (?, ?, ?)', [id(33), id(23), id(12)]);
  await conn.query('UPDATE spk_cue SET clip_id = ? WHERE id = ?', [id(33), id(23)]);
  await conn.query('UPDATE spk_project SET cover_asset_id = ? WHERE id = ?', [id(12), id(2)]);

  await check(checks, 'deleting a project with ONE statement while clip -> asset is RESTRICT', async () => {
    const del = await attempt(() => conn.query('DELETE FROM spk_project WHERE id = ?', [id(2)]));
    return {
      deleteFailed: del.failed,
      error: del.error,
      projectRowsLeft: await count(conn, 'spk_project', 'id = ?', [id(2)]),
      note: 'If it failed, project deletion must be the ordered app routine.',
    };
  });

  await check(checks, 'deleting a project in the ORDERED routine (clips, cues, assets, project)', async () => {
    await conn.beginTransaction();
    try {
      await conn.query('DELETE FROM spk_clip WHERE cue_id IN (SELECT id FROM spk_cue WHERE project_id = ?)', [id(2)]);
      await conn.query('DELETE FROM spk_cue WHERE project_id = ?', [id(2)]);
      await conn.query('DELETE FROM spk_asset WHERE project_id = ?', [id(2)]);
      await conn.query('DELETE FROM spk_project WHERE id = ?', [id(2)]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }
    return { projectRowsLeft: await count(conn, 'spk_project', 'id = ?', [id(2)]) };
  });

  // 4. shifting positions under a unique (parent, position) index
  await conn.query('INSERT INTO spk_project (id, title) VALUES (?, ?)', [id(3), 'positions']);
  for (let i = 1; i <= 5; i++) {
    await conn.query('INSERT INTO spk_chapter (id, project_id, position) VALUES (?, ?, ?)', [id(100 + i), id(3), i]);
  }
  const positions = async (): Promise<number[]> =>
    (await rows(conn, 'SELECT position FROM spk_chapter WHERE project_id = ? ORDER BY position', [id(3)])).map((r) => Number(r.position));

  await check(checks, 'shift positions up WITHOUT ORDER BY (expected to fail on the unique index)', async () => {
    const shift = await attempt(() =>
      conn.query('UPDATE spk_chapter SET position = position + 1 WHERE project_id = ? AND position >= 3', [id(3)]),
    );
    return { failed: shift.failed, error: shift.error, positionsNow: await positions() };
  });

  await check(checks, 'shift positions up WITH ORDER BY position DESC, then insert at 3', async () => {
    await conn.beginTransaction();
    try {
      await conn.query(
        'UPDATE spk_chapter SET position = position + 1 WHERE project_id = ? AND position >= 3 ORDER BY position DESC',
        [id(3)],
      );
      await conn.query('INSERT INTO spk_chapter (id, project_id, position) VALUES (?, ?, 3)', [id(106), id(3)]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }
    const now = await positions();
    return { positionsNow: now, ok: now.join(',') === '1,2,3,4,5,6' };
  });

  // 5. ref_key: NULLs and case/accent-insensitive uniqueness
  await conn.query('INSERT INTO spk_project (id, title) VALUES (?, ?), (?, ?)', [id(4), 'refs', id(5), 'refs 2']);
  await check(checks, 'several NULL ref_key values are allowed under the unique index', async () => {
    await conn.query('INSERT INTO spk_note (id, project_id, ref_key) VALUES (?, ?, NULL), (?, ?, NULL), (?, ?, NULL)', [
      id(201), id(4), id(202), id(4), id(203), id(4),
    ]);
    return { nullRows: await count(conn, 'spk_note', 'project_id = ? AND ref_key IS NULL', [id(4)]) };
  });
  await check(checks, 'ref_key is unique per project, case-insensitive', async () => {
    await conn.query('INSERT INTO spk_note (id, project_id, ref_key) VALUES (?, ?, ?)', [id(204), id(4), 'Smith20']);
    const sameCase = await attempt(() => conn.query('INSERT INTO spk_note (id, project_id, ref_key) VALUES (?, ?, ?)', [id(205), id(4), 'SMITH20']));
    const accent = await attempt(() => conn.query('INSERT INTO spk_note (id, project_id, ref_key) VALUES (?, ?, ?)', [id(206), id(4), 'Smïth20']));
    const otherProject = await attempt(() => conn.query('INSERT INTO spk_note (id, project_id, ref_key) VALUES (?, ?, ?)', [id(207), id(5), 'Smith20']));
    return {
      upperCaseRejected: sameCase.failed,
      accentVariantRejected: accent.failed,
      sameKeyInOtherProjectAllowed: !otherProject.failed,
    };
  });
  await check(checks, 'asset path is unique per project, case-insensitive', async () => {
    await conn.query('INSERT INTO spk_asset (id, project_id, path) VALUES (?, ?, ?)', [id(13), id(4), 'Kick.wav']);
    const lower = await attempt(() => conn.query('INSERT INTO spk_asset (id, project_id, path) VALUES (?, ?, ?)', [id(14), id(4), 'kick.wav']));
    return { lowerCaseRejected: lower.failed, error: lower.error };
  });

  // 6. consistent snapshot read
  await check(checks, 'START TRANSACTION WITH CONSISTENT SNAPSHOT keeps a stable read while another connection writes', async () => {
    const writer = await connect();
    try {
      await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
      const before = await count(conn, 'spk_chapter', 'project_id = ?', [id(3)]);
      await writer.query('INSERT INTO spk_chapter (id, project_id, position) VALUES (?, ?, 7)', [id(107), id(3)]);
      const duringSnapshot = await count(conn, 'spk_chapter', 'project_id = ?', [id(3)]);
      await conn.query('COMMIT');
      const after = await count(conn, 'spk_chapter', 'project_id = ?', [id(3)]);
      return { before, duringSnapshot, after, stable: before === duringSnapshot && after === before + 1 };
    } finally {
      await writer.end();
    }
  });

  // 7. SKIP LOCKED (for claiming asset jobs)
  await check(checks, 'SELECT ... FOR UPDATE SKIP LOCKED', async () => {
    const other = await connect();
    try {
      await conn.beginTransaction();
      await conn.query('SELECT id FROM spk_asset WHERE project_id = ? FOR UPDATE', [id(4)]);
      const r = await attempt(() => other.query('SELECT id FROM spk_asset WHERE project_id = ? FOR UPDATE SKIP LOCKED', [id(4)]));
      await conn.rollback();
      return { supported: !r.failed, error: r.error };
    } finally {
      await other.end();
    }
  });
}

/** Time scrypt at a few cost settings: a login should take a fraction of a second. */
async function scryptTimings(): Promise<unknown> {
  const out: Array<{ N: number; r: number; p: number; ms: number; memoryMiB: number }> = [];
  for (const N of [2 ** 14, 2 ** 15, 2 ** 16]) {
    const r = 8;
    const p = 1;
    const started = performance.now();
    await new Promise<void>((resolve, reject) =>
      scrypt('correct horse battery staple', randomBytes(16), 64, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    out.push({ N, r, p, ms: Math.round(performance.now() - started), memoryMiB: (128 * N * r) / (1024 * 1024) });
  }
  return out;
}

function tokenOk(provided: unknown): boolean {
  const expected = process.env.SPIKE_TOKEN;
  if (!expected || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerSpikeDb(app: FastifyInstance): void {
  app.get('/spike/db-schema', async (request, reply) => {
    // Without SPIKE_TOKEN configured the route does not exist.
    if (!process.env.SPIKE_TOKEN) return reply.code(404).send({ error: 'not found' });
    if (!tokenOk(request.headers['x-spike-token'])) return reply.code(401).send({ error: 'unauthorized' });
    if (running) return reply.code(409).send({ error: 'a run is already in progress' });

    running = true;
    const started = Date.now();
    const checks: Check[] = [];
    let cleanedUp = false;
    let conn: Connection | undefined;
    try {
      conn = await connect();
      await dropAll(conn); // leftovers of an earlier, interrupted run
      await createTables(conn);
      await runChecks(conn, checks);
    } catch (e) {
      checks.push({ name: 'setup or an unexpected failure', ok: false, detail: errorInfo(e) });
    } finally {
      if (conn) {
        try {
          await conn.query('ROLLBACK').catch(() => undefined);
          await dropAll(conn);
          cleanedUp = true;
        } catch (e) {
          checks.push({ name: 'cleanup (drop the spk_ tables by hand)', ok: false, detail: errorInfo(e) });
        }
        await conn.end().catch(() => undefined);
      }
      running = false;
    }

    await check(checks, 'scrypt timings (ms per hash)', scryptTimings);

    return {
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      cleanedUp,
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
      checks,
    };
  });
}
