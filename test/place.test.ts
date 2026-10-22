import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

const root = mkdtempSync(path.join(tmpdir(), 'place-'));
process.env.LIBRARY_ROOT = root;

const { sql } = await import('drizzle-orm');
const { buildApp } = await import('../src/server/app.js');
const { audioJobsIdle, stopAudioJobs } = await import('../src/audio/jobs.js');
const { wavFile } = await import('./support/wav.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { withDb } = await import('../src/db/client.js');
const { createUser } = await import('../src/auth/accounts.js');
const { closeResizePool } = await import('../src/library/pool.js');

let app: FastifyInstance;
const run = Date.now().toString(36);
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

async function call(who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: payload as object, headers: { cookie: cookies[who] ?? '', ...headers } });
  let body: any = null;
  try { body = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, body };
}
const upload = (name: string, data: Buffer) =>
  call('ann', 'POST', `/api/projects/${ids.p}/library/files?folder=&name=${encodeURIComponent(name)}`, data, { 'content-type': 'application/octet-stream' });

before(async () => {
  await runMigrations();
  app = buildApp();
  await app.ready();
  await withDb(async (db) => {
    for (const who of ['ann', 'cy']) {
      const u = await createUser(db, { email: `${who}.place.${run}@t.test`, displayName: who, password: 'Test-password-123!', mustChangePassword: false });
      ids[who] = u!.id;
    }
  });
  for (const who of ['ann', 'cy']) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: `${who}.place.${run}@t.test`, password: 'Test-password-123!' } });
    cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
  }
  const p = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Place ${run}`, language: 'en-US' });
  ids.p = p.body.id;
  const story = await call('ann', 'GET', `/api/projects/${ids.p}/story`);
  ids.seg = story.body.chapters[0].segments[0].id;
});

after(async () => {
  await app.close();
  await closeResizePool();
  await stopAudioJobs();
  rmSync(root, { recursive: true, force: true });
});

describe('timeline placement', () => {
  const content = async () => (await call('ann', 'GET', `/api/segments/${ids.seg}`)).body;
  const cueOf = (body: any, id: string) => body.scenes.flatMap((s: any) => s.cues).find((c: any) => c.id === id);
  const add = async (type: string, text: string, afterCueId?: string) => {
    const c = await content();
    const r = await call('ann', 'POST', `/api/scenes/${c.scenes[0].id}/cues`, { type, text, afterCueId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.created as string;
  };
  const place = (id: string, body: object, who = 'ann') => call(who, 'POST', `/api/cues/${id}/place`, body);

  it('moves a cue without touching the others, and refuses an overlap on its lane', async () => {
    ids.a = await add('sfx', 'wind');
    ids.b = await add('sfx', 'rain', ids.a);
    const c = await content();
    const a = cueOf(c, ids.a), b = cueOf(c, ids.b);
    assert.equal(a.laneId, b.laneId); // both on the first SFX lane
    const free = b.startMs + b.lengthMs + 4000;
    const ok = await place(ids.a, { startMs: free });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(cueOf(ok.body, ids.a).startMs, free);
    assert.equal(cueOf(ok.body, ids.b).startMs, b.startMs);
    const clash = await place(ids.a, { startMs: b.startMs + 100 });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, 'lane_overlap');
    assert.equal(cueOf(await content(), ids.a).startMs, free);
  });

  it('resizes with ripple by default and trims against the next cue of the lane in trim mode', async () => {
    let c = await content();
    const b = cueOf(c, ids.b), a = cueOf(c, ids.a); // b ends before a starts, a is after b on the lane
    const gap = a.startMs - (b.startMs + b.lengthMs);
    assert.ok(gap > 0);
    // trim: b grows but stops where a begins; a does not move
    const t = await place(ids.b, { lengthMs: b.lengthMs + gap + 5000, mode: 'trim' });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(cueOf(t.body, ids.b).lengthMs, a.startMs - b.startMs);
    assert.equal(cueOf(t.body, ids.b).lengthAuto, false);
    assert.equal(cueOf(t.body, ids.a).startMs, a.startMs);
    // ripple: shrinking b by 500 ms pulls a back by 500 ms (nothing stays against it)
    c = await content();
    const b2 = cueOf(c, ids.b);
    const r = await place(ids.b, { lengthMs: b2.lengthMs - 500 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(cueOf(r.body, ids.a).startMs, a.startMs - 500);
    // growing ripples forward
    const g = await place(ids.b, { lengthMs: cueOf(r.body, ids.b).lengthMs + 2000 });
    assert.equal(cueOf(g.body, ids.a).startMs, a.startMs - 500 + 2000);
  });

  it('validates the input and needs write access', async () => {
    assert.equal((await place(ids.a, { mode: 'squash', lengthMs: 2000 })).status, 400);
    assert.equal((await place(ids.a, { startMs: -5 })).status, 400);
    assert.equal((await place(ids.a, { lengthMs: 10 })).status, 400);
    assert.notEqual((await place(ids.a, { startMs: 0 }, 'cy')).status, 200); // not a member
  });
});
