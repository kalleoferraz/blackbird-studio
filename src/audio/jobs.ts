import { hostname } from 'node:os';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { withDb } from '../db/client.js';
import { asset, assetPeaks } from '../db/schema.js';
import { blobStore } from '../storage/blob-store.js';
import { MP3_KBPS } from './encode.js';
import { PEAK_STEP_MS } from './peaks.js';
import { closeEncodePool, encodePool } from './pool.js';

/**
 * The audio queue (Bible, section 6): the MP3 playback copy of a WAV and the waveform peaks of every audio asset. The state lives in MySQL: an asset is `pending`, is claimed by one
 * process with a conditional UPDATE (`processing`), and ends `ready` or `failed`. One job runs at a time per process.
 */
const HOST = hostname().slice(0, 40);
const ME = `${HOST}:${process.pid}`;
const STALE_MS = 3 * 60_000;
const MAX_ATTEMPTS = 3;

export interface Log { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void }

let draining = false;
let again = false;
let current: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | null = null;

async function readAll(projectId: string, rel: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const c of blobStore().read(projectId, rel)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Takes the oldest pending audio asset, or returns null. The conditional UPDATE is the claim. */
async function claimNext(): Promise<string | null> {
  return withDb(async (db) => {
    for (let i = 0; i < 5; i++) {
      const next = (await db.select({ id: asset.id }).from(asset).where(and(eq(asset.mediaKind, 'audio'), eq(asset.status, 'pending'))).orderBy(asset.createdAt).limit(1))[0];
      if (!next) return null;
      const r = await db.update(asset)
        .set({ status: 'processing', claimedBy: ME, claimedAt: new Date(), attempts: sql`${asset.attempts} + 1` })
        .where(and(eq(asset.id, next.id), eq(asset.status, 'pending')));
      if (Number((r as unknown as [{ affectedRows: number }])[0].affectedRows) === 1) return next.id;
    }
    return null;
  });
}

async function fail(id: string, message: string): Promise<void> {
  await withDb((db) => db.update(asset).set({ status: 'failed', error: message.slice(0, 1000), claimedBy: null, claimedAt: null, updatedAt: new Date() }).where(and(eq(asset.id, id), eq(asset.claimedBy, ME))));
}

/** The sound of a master: read from the store as it is now. */
async function runJob(id: string, log?: Log): Promise<void> {
  try {
    const row = (await withDb((db) => db.select().from(asset).where(eq(asset.id, id)).limit(1)))[0];
    if (!row) return;
    const isWav = (row.mediaInfo as { format?: string } | null)?.format === 'wav';
    // What is already there is kept: a WAV whose MP3 exists only needs its peaks (assets made before peaks existed).
    const haveMp3 = !isWav || (row.sizeLightweight !== null && row.lightweightPath !== null && (await blobStore().size(row.projectId, row.lightweightPath)) !== null);
    if (isWav && !row.lightweightPath) throw new Error('The asset has no playback copy name.');
    const data = await readAll(row.projectId, row.path);
    const { mp3, peaks, ms } = await encodePool().process({ kind: isWav ? 'wav' : 'mp3', data, kbps: MP3_KBPS, peaksOnly: haveMp3 });
    // The file may have been renamed while it worked: write to the names the row has now.
    await withDb(async (db) => {
      const now = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!now || now.claimedBy !== ME) return; // deleted, or claimed by someone else after a stale requeue
      const patch: Partial<typeof asset.$inferInsert> = {};
      if (mp3) {
        await blobStore().remove(now.projectId, now.lightweightPath!);
        await blobStore().put(now.projectId, now.lightweightPath!, mp3);
        patch.sizeLightweight = mp3.byteLength;
        patch.mediaInfo = { ...((now.mediaInfo ?? {}) as Record<string, unknown>), lightweight: { format: 'mp3', bitrateKbps: MP3_KBPS } };
      }
      const data = Buffer.from(peaks);
      await db.insert(assetPeaks).values({ assetId: id, stepMs: PEAK_STEP_MS, data, createdAt: new Date() }).onDuplicateKeyUpdate({ set: { stepMs: PEAK_STEP_MS, data } });
      await db.update(asset).set({ ...patch, status: 'ready', error: null, claimedBy: null, claimedAt: null, updatedAt: new Date() }).where(eq(asset.id, id));
    });
    log?.info({ asset: id, ms, mp3Bytes: mp3?.byteLength ?? 0, peaks: peaks.length }, 'Audio asset processed');
  } catch (e) {
    log?.error({ asset: id, err: e }, 'Audio processing failed');
    await fail(id, e instanceof Error ? e.message : String(e)).catch(() => undefined);
  }
}

async function drain(log?: Log): Promise<void> {
  if (draining) { again = true; return; }
  draining = true;
  try {
    do {
      again = false;
      for (let id = await claimNext(); id; id = await claimNext()) await runJob(id, log);
    } while (again);
  } finally {
    draining = false;
  }
}

/** Starts the queue if it is not running. Does not wait for it. */
export function kickAudioJobs(log?: Log): void {
  current = drain(log).catch((e) => log?.error({ err: e }, 'Audio queue error'));
}

/** For tests: resolves when the queue has nothing left to do. */
export async function audioJobsIdle(): Promise<void> {
  for (let i = 0; i < 4; i++) { await current; while (draining) await new Promise((r) => setTimeout(r, 20)); }
}

/**
 * Puts claimed-but-unfinished assets back to `pending`: all of this host's on boot (its process died), and any
 * from another instance only when their claim is old. After MAX_ATTEMPTS an asset is marked failed instead.
 */
export async function requeueAudio(onBoot: boolean): Promise<number> {
  return withDb(async (db) => {
    const old = new Date(Date.now() - STALE_MS);
    const mine = sql`${asset.claimedBy} LIKE ${HOST.replace(/[\\%_]/g, '\\$&') + ':%'}`;
    const stuck = and(eq(asset.mediaKind, 'audio'), eq(asset.status, 'processing'), onBoot ? or(mine, lt(asset.claimedAt, old)) : lt(asset.claimedAt, old));
    await db.update(asset).set({ status: 'failed', error: 'Encoding was interrupted too many times.', claimedBy: null, claimedAt: null }).where(and(stuck, sql`${asset.attempts} >= ${MAX_ATTEMPTS}`));
    const r = await db.update(asset).set({ status: 'pending', claimedBy: null, claimedAt: null }).where(stuck);
    return Number((r as unknown as [{ affectedRows: number }])[0].affectedRows);
  });
}

/** Ready audio assets that have no peaks yet (made before peaks existed) go through the queue for them. */
export async function queueMissingPeaks(): Promise<number> {
  return withDb(async (db) => {
    const r = await db.update(asset).set({ status: 'pending', attempts: 0 })
      .where(and(eq(asset.mediaKind, 'audio'), eq(asset.status, 'ready'), sql`NOT EXISTS (SELECT 1 FROM ${assetPeaks} WHERE ${assetPeaks.assetId} = ${asset.id})`));
    return Number((r as unknown as [{ affectedRows: number }])[0].affectedRows);
  });
}

/** Startup: re-queue what a restart interrupted, run the queue, and look again every minute. */
export async function startAudioJobs(log?: Log): Promise<void> {
  const n = (await requeueAudio(true)) + (await queueMissingPeaks());
  if (n) log?.info({ count: n }, 'Audio assets put back in the queue');
  kickAudioJobs(log);
  timer ??= setInterval(() => { void requeueAudio(false).then(() => kickAudioJobs(log)).catch(() => undefined); }, 60_000);
  timer.unref();
}

/** A failed asset goes back in the queue (the master is kept, so retrying is always possible). */
export async function retryAudio(id: string): Promise<boolean> {
  const r = await withDb((db) => db.update(asset).set({ status: 'pending', attempts: 0, error: null, claimedBy: null, claimedAt: null, updatedAt: new Date() }).where(and(eq(asset.id, id), eq(asset.mediaKind, 'audio'), eq(asset.status, 'failed'))));
  return Number((r as unknown as [{ affectedRows: number }])[0].affectedRows) === 1;
}

export async function stopAudioJobs(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await audioJobsIdle();
  await closeEncodePool();
}
