import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

const root = mkdtempSync(path.join(tmpdir(), 'clip-'));
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
      const u = await createUser(db, { email: `${who}.clip.${run}@t.test`, displayName: who, password: 'Test-password-123!', mustChangePassword: false });
      ids[who] = u!.id;
    }
  });
  for (const who of ['ann', 'cy']) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: `${who}.clip.${run}@t.test`, password: 'Test-password-123!' } });
    cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
  }
  const p = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Clip ${run}`, language: 'en-US' });
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

describe('clips', () => {
  const content = async () => (await call('ann', 'GET', `/api/segments/${ids.seg}`)).body;
  const sfxCue = async (text = 'birds') => {
    const c = await content();
    const r = await call('ann', 'POST', `/api/scenes/${c.scenes[0].id}/cues`, { type: 'sfx', text });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.created as string;
  };
  const cueOf = (body: any, id: string) => body.scenes.flatMap((s: any) => s.cues).find((c: any) => c.id === id);

  it('assigns a piece of an audio file: the cue follows the piece, fades default to 100 ms', async () => {
    const up = await upload('birds.wav', wavFile({ seconds: 10, seed: 3 }));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    ids.birds = up.body.id;
    await audioJobsIdle();
    ids.c1 = await sfxCue();
    const r = await call('ann', 'POST', `/api/cues/${ids.c1}/clips`, { assetId: ids.birds, offsetMs: 2000, lengthMs: 3000 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const cue = cueOf(r.body, ids.c1);
    assert.equal(cue.lengthMs, 3000);
    assert.equal(cue.clipId, r.body.created);
    assert.equal(cue.clips.length, 1);
    assert.deepEqual(
      [cue.clips[0].number, cue.clips[0].offsetMs, cue.clips[0].lengthMs, cue.clips[0].fadeInMs, cue.clips[0].fadeOutMs, cue.clips[0].gainDb, cue.clips[0].name, cue.clips[0].assetDurationMs, cue.clips[0].hasPeaks, cue.clips[0].status],
      [1, 2000, 3000, 100, 100, 0, 'birds.wav', 10000, true, 'ready'],
    );
    ids.k1 = r.body.created;
  });

  it('ripples the later cues when the cue length changes', async () => {
    const made = await call('ann', 'POST', `/api/scenes/${(await content()).scenes[0].id}/cues`, { afterCueId: ids.c1, type: 'sfx', text: 'after' });
    ids.c2 = made.body.created;
    const before = cueOf(made.body, ids.c2);
    assert.equal(before.startMs, 3000);
    const r = await call('ann', 'PATCH', `/api/clips/${ids.k1}`, { lengthMs: 4000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(cueOf(r.body, ids.c1).lengthMs, 4000);
    assert.equal(cueOf(r.body, ids.c2).startMs, 4000);
  });

  it('refuses a piece past the end of the file, long fades, a foreign or non-audio asset', async () => {
    assert.equal((await call('ann', 'PATCH', `/api/clips/${ids.k1}`, { offsetMs: 7000 })).body.error, 'beyond_audio');
    assert.equal((await call('ann', 'PATCH', `/api/clips/${ids.k1}`, { fadeInMs: 3000, fadeOutMs: 2000 })).body.error, 'fades_too_long');
    assert.equal((await call('ann', 'POST', `/api/cues/${ids.c1}/clips`, { assetId: '0'.repeat(26) })).status, 400);
    const other = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Other ${run}`, language: 'en-US' });
    const f = await call('ann', 'POST', `/api/projects/${other.body.id}/library/files?folder=&name=x.wav`, wavFile({ seconds: 1, seed: 9 }), { 'content-type': 'application/octet-stream' });
    assert.equal((await call('ann', 'POST', `/api/cues/${ids.c1}/clips`, { assetId: f.body.id })).body.error, 'invalid_asset');
    assert.equal((await call('cy', 'POST', `/api/cues/${ids.c1}/clips`, { assetId: ids.birds })).status, 404);
  });

  it('keeps the cue length by default when it was set by hand, and shortens it for a short file', async () => {
    const short = await upload('short.wav', wavFile({ seconds: 1.5, seed: 4 }));
    await audioJobsIdle();
    ids.c3 = await sfxCue('manual');
    await call('ann', 'PATCH', `/api/cues/${ids.c3}`, { lengthMs: 6000 });
    const long = await call('ann', 'POST', `/api/cues/${ids.c3}/clips`, { assetId: ids.birds, choose: false });
    assert.equal(cueOf(long.body, ids.c3).lengthMs, 6000); // not chosen: the cue is untouched
    assert.equal(cueOf(long.body, ids.c3).clipId, null);
    assert.equal(cueOf(long.body, ids.c3).clips[0].lengthMs, 6000); // the piece defaults to the cue length
    const s = await call('ann', 'POST', `/api/cues/${ids.c3}/clips`, { assetId: short.body.id });
    assert.equal(cueOf(s.body, ids.c3).lengthMs, 1500);
    assert.equal(cueOf(s.body, ids.c3).clips.length, 2);
    assert.equal(cueOf(s.body, ids.c3).clips[1].number, 2);
  });

  it('chooses another take, clears the choice and removes a clip', async () => {
    const c = cueOf(await content(), ids.c3);
    const first = c.clips[0].id;
    const ch = await call('ann', 'POST', `/api/cues/${ids.c3}/choose-clip`, { clipId: first });
    assert.equal(cueOf(ch.body, ids.c3).clipId, first);
    assert.equal(cueOf(ch.body, ids.c3).lengthMs, 6000);
    assert.equal((await call('ann', 'POST', `/api/cues/${ids.c1}/choose-clip`, { clipId: first })).body.error, 'invalid_clip');
    const none = await call('ann', 'POST', `/api/cues/${ids.c3}/choose-clip`, { clipId: null });
    assert.equal(cueOf(none.body, ids.c3).clipId, null);
    const del = await call('ann', 'DELETE', `/api/clips/${first}`);
    assert.equal(cueOf(del.body, ids.c3).clips.length, 1);
    const used = await call('ann', 'DELETE', `/api/assets/${ids.birds}`);
    assert.equal(used.status, 409); // still used by the clip of the first cue
  });

  it('squeezes fades when the piece gets shorter, and removing the chosen clip leaves the cue', async () => {
    const r = await call('ann', 'PATCH', `/api/clips/${ids.k1}`, { lengthMs: 150 });
    assert.equal(r.status, 200);
    const k = cueOf(r.body, ids.c1).clips[0];
    assert.ok(k.fadeInMs + k.fadeOutMs <= 150);
    const d = await call('ann', 'DELETE', `/api/clips/${ids.k1}`);
    assert.equal(cueOf(d.body, ids.c1).clipId, null);
    assert.equal(cueOf(d.body, ids.c1).lengthMs, 150);
  });

  it('stores a recording under Storyline as the next take and chooses it', async () => {
    const { encodeWavToMp3 } = await import('../src/audio/encode.js');
    const { sanitizePart } = await import('../src/library/storyline.js');
    assert.equal(sanitizePart('Ação à Straße — "Hello"!'), 'Acao a Str');
    assert.equal(sanitizePart('???'), 'untitled');
    const mp3 = Buffer.from(await encodeWavToMp3(wavFile({ seconds: 2, seed: 21, sampleRate: 44100, channels: 1 })));
    const cueId = await sfxCue('Splash!');
    const rec = (data: Buffer) => call('ann', 'POST', `/api/cues/${cueId}/recording`, data, { 'content-type': 'application/octet-stream' });
    const r = await rec(mp3);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.path, /^Storyline\/01 - [^/]+\/01 - [^/]+\/01\.\d{4} - [^/]+ - Splash \(1\)\.mp3$/);
    const cue = cueOf(r.body, cueId);
    assert.equal(cue.clipId, r.body.created);
    assert.equal(cue.clips[0].origin, 'human-recorded');
    assert.ok(Math.abs(cue.lengthMs - 2000) < 100, String(cue.lengthMs));
    const again = await rec(Buffer.from(await encodeWavToMp3(wavFile({ seconds: 1, seed: 22, sampleRate: 44100, channels: 1 }))));
    assert.match(again.body.path, / \(2\)\.mp3$/);
    assert.equal(cueOf(again.body, cueId).clips.length, 2);
    assert.equal((await call('cy', 'POST', `/api/cues/${cueId}/recording`, mp3, { 'content-type': 'application/octet-stream' })).status, 404);
    assert.equal((await rec(Buffer.from('not audio at all'))).status >= 400, true);
  });

  it('stores a recorded WAV as the master and the worker derives the MP3 copy', async () => {
    const cueId = await sfxCue('Wav take');
    const wav = wavFile({ seconds: 2, seed: 51, sampleRate: 48000, channels: 1, bits: 24 });
    const r = await call('ann', 'POST', `/api/cues/${cueId}/recording`, wav, { 'content-type': 'application/octet-stream' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.path, /Wav take \(1\)\.wav$/);
    assert.ok(Math.abs(cueOf(r.body, cueId).lengthMs - 2000) < 100);
    await audioJobsIdle();
    const row = (await withDb((db) => db.execute(sql`SELECT status, lightweight_path AS lw FROM asset WHERE project_id = ${ids.p} AND path = ${r.body.path}`)) as any)[0][0];
    assert.equal(row.status, 'ready');
    assert.match(row.lw, /Wav take \(1\)\.mp3$/);
  });

  it('lets an unplayed take be deleted from the library, but not the one a cue plays', async () => {
    const { encodeWavToMp3 } = await import('../src/audio/encode.js');
    const cueId = await sfxCue('Takes');
    const rec = async (seed: number) => call('ann', 'POST', `/api/cues/${cueId}/recording`, Buffer.from(await encodeWavToMp3(wavFile({ seconds: 1, seed, sampleRate: 44100, channels: 1 }))), { 'content-type': 'application/octet-stream' });
    const first = await rec(31);
    const second = await rec(32);
    const c = cueOf(second.body, cueId);
    assert.equal(c.clips.length, 2);
    assert.equal(c.clipId, second.body.created); // the newest take is the one played
    const firstAsset = c.clips[0].assetId, secondAsset = c.clips[1].assetId;
    assert.equal((await call('ann', 'DELETE', `/api/assets/${secondAsset}`)).status, 409);
    const del = await call('ann', 'DELETE', `/api/assets/${firstAsset}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const left = cueOf(await content(), cueId);
    assert.deepEqual(left.clips.map((k: any) => k.id), [second.body.created]);
    void first;
  });

  it('learns the speech rate from recorded speech takes, and only from them', async () => {
    const { encodeWavToMp3 } = await import('../src/audio/encode.js');
    const { estimateSpeechMs } = await import('../src/shared/estimate.js');
    const proj = async () => (await withDb((db) => db.execute(sql`SELECT speech_units AS u, speech_ms AS m FROM project WHERE id = ${ids.p}`)) as any)[0][0];
    const before = await proj();
    const c = await content();
    const made = await call('ann', 'POST', `/api/scenes/${c.scenes[0].id}/cues`, { type: 'speech', text: 'Once upon a time there was a quiet little house by the sea.' });
    const cueId = made.body.created;
    const mp3 = Buffer.from(await encodeWavToMp3(wavFile({ seconds: 6, seed: 41, sampleRate: 44100, channels: 1 })));
    const r = await call('ann', 'POST', `/api/cues/${cueId}/recording`, mp3, { 'content-type': 'application/octet-stream' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const after = await proj();
    assert.ok(Number(after.u) > Number(before.u) + 10, JSON.stringify([before, after]));
    assert.ok(Math.abs(Number(after.m) - Number(before.m) - 6000) < 150);
    // An sfx take teaches nothing.
    const sfx = await sfxCue('wind');
    await call('ann', 'POST', `/api/cues/${sfx}/recording`, Buffer.from(await encodeWavToMp3(wavFile({ seconds: 2, seed: 42, sampleRate: 44100, channels: 1 }))), { 'content-type': 'application/octet-stream' });
    assert.equal(Number((await proj()).u), Number(after.u));
    // New estimates use the learned rate; the language's rate alone would give another number.
    const text = 'A new line of speech for this project, about the same length.';
    const again = await call('ann', 'POST', `/api/scenes/${c.scenes[0].id}/cues`, { type: 'speech', text });
    const len = cueOf(again.body, again.body.created).lengthMs;
    assert.notEqual(len, estimateSpeechMs(text, 'en-US'));
  });
});
