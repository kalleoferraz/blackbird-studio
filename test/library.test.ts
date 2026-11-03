import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { before, after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

const root = mkdtempSync(path.join(tmpdir(), 'lib-'));
process.env.LIBRARY_ROOT = root;

const { buildApp } = await import('../src/server/app.js');
const { audioJobsIdle, kickAudioJobs, requeueAudio, stopAudioJobs } = await import('../src/audio/jobs.js');
const { wavFile } = await import('./support/wav.js');
const { hostname } = await import('node:os');
const { sql } = await import('drizzle-orm');
const { runMigrations } = await import('../src/db/migrate.js');
const { withDb } = await import('../src/db/client.js');
const { createUser } = await import('../src/auth/accounts.js');
const { closeResizePool } = await import('../src/library/pool.js');
const { cleanPath } = await import('../src/storage/blob-store.js');
const { coverStamp } = await import('../src/library/covers.js');

let app: FastifyInstance;
const run = Date.now().toString(36);
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A real PNG (RGB) whose pixels depend on `seed`, so different seeds give different bytes. */
function png(w: number, h: number, seed: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * row.length + 1 + x * 3;
      raw[o] = (x + seed * 37) & 255;
      raw[o + 1] = (y * 2 + seed * 11) & 255;
      raw[o + 2] = (x ^ y ^ seed) & 255;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: payload as object, headers: { cookie: cookies[who] ?? '', ...headers } });
  let body: any = null;
  try { body = res.json(); } catch { /* not JSON */ }
  return { status: res.statusCode, body, res };
}
const put = (who: string, url: string, data: Buffer) => call(who, 'PUT', url, data, { 'content-type': 'application/octet-stream' });
const post = (who: string, url: string, data: Buffer) => call(who, 'POST', url, data, { 'content-type': 'application/octet-stream' });

before(async () => {
  await runMigrations();
  app = buildApp();
  await app.ready();
  await withDb(async (db) => {
    for (const who of ['ann', 'cy']) {
      const u = await createUser(db, { email: `${who}.lib.${run}@t.test`, displayName: who, password: 'Test-password-123!', mustChangePassword: false });
      ids[who] = u!.id;
    }
  });
  for (const who of ['ann', 'cy']) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: `${who}.lib.${run}@t.test`, password: 'Test-password-123!' } });
    cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
  }
  const p = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Lib ${run}`, language: 'en-US' });
  ids.p = p.body.id;
});

after(async () => {
  await app.close();
  await closeResizePool();
  await stopAudioJobs();
  rmSync(root, { recursive: true, force: true });
});

describe('paths', () => {
  it('refuses unsafe paths', () => {
    assert.equal(cleanPath('../x'), null);
    assert.equal(cleanPath('a/../b'), null);
    assert.equal(cleanPath('a\\b'), null);
    assert.equal(cleanPath('a/b:c'), null);
    assert.equal(cleanPath('/a//b/'), 'a/b');
    assert.equal(cleanPath(''), '');
  });
  it('stamps covers in UTC', () => {
    assert.equal(coverStamp(new Date(Date.UTC(2026, 9, 21, 9, 5))), '20261021-0905');
  });
});

describe('library', () => {
  it('lists the managed folders at the root', async () => {
    const r = await call('ann', 'GET', `/api/projects/${ids.p}/library`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.folders.map((f: any) => f.name), ['Characters', 'Storyline']);
    assert.ok(r.body.folders.every((f: any) => f.managed));
    assert.equal((await call('cy', 'GET', `/api/projects/${ids.p}/library`)).status, 404);
  });

  it('uploads an image, makes a reduced copy and streams both', async () => {
    const big = png(1200, 900, 1);
    const r = await post('ann', `/api/projects/${ids.p}/library/files?folder=&name=${encodeURIComponent('Map.png')}`, big);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'image');
    assert.equal(r.body.hasLightweight, true);
    assert.equal(r.body.width, 1200);
    ids.map = r.body.id;
    const orig = await call('ann', 'GET', `/api/assets/${ids.map}/file`);
    assert.equal(orig.status, 200);
    assert.equal(orig.res.headers['content-type'], 'image/png');
    assert.equal(orig.res.rawPayload.length, big.length);
    const light = await call('ann', 'GET', `/api/assets/${ids.map}/file?variant=light`);
    assert.ok(light.res.rawPayload.length < big.length);
    const files = readdirSync(path.join(root, ids.p!));
    assert.ok(files.includes('Map.png') && files.some((f) => /^Map_600x450\.png$/.test(f)), files.join(','));
    const part = await app.inject({ method: 'GET', url: `/api/assets/${ids.map}/file`, headers: { cookie: cookies.ann!, range: 'bytes=0-9' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.rawPayload.length, 10);
    assert.equal((await call('cy', 'GET', `/api/assets/${ids.map}/file`)).status, 404);
  });

  it('hides the derived copy from the listing and refuses duplicates', async () => {
    const list = await call('ann', 'GET', `/api/projects/${ids.p}/library`);
    assert.deepEqual(list.body.files.map((f: any) => f.name), ['Map.png']);
    const dup = await post('ann', `/api/projects/${ids.p}/library/files?folder=&name=Other.png`, png(1200, 900, 1));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'already_in_library');
    assert.equal(dup.body.path, 'Map.png');
  });

  it('numbers files with the same name and different content', async () => {
    const r = await post('ann', `/api/projects/${ids.p}/library/files?folder=&name=Map.png`, png(100, 100, 2));
    assert.equal(r.status, 201);
    assert.equal(r.body.name, 'Map (2).png');
    assert.equal(r.body.hasLightweight, false);
  });

  it('stores documents as they are and checks audio', async () => {
    const doc = await post('ann', `/api/projects/${ids.p}/library/files?folder=&name=notes.txt`, Buffer.from('hello'));
    assert.equal(doc.status, 201);
    assert.equal(doc.body.kind, 'document');
    const wav = await post('ann', `/api/projects/${ids.p}/library/files?folder=&name=take.wav`, Buffer.from('RIFFxxxxWAVE'));
    assert.equal(wav.status, 422);
    assert.equal(wav.body.error, 'audio_unreadable');
    const flac = await post('ann', `/api/projects/${ids.p}/library/files?folder=&name=take.flac`, Buffer.from('fLaC0000'));
    assert.equal(flac.status, 415);
    assert.equal(flac.body.error, 'unsupported_audio');
    const bad = await post('ann', `/api/projects/${ids.p}/library/files?folder=Storyline&name=a.txt`, Buffer.from('x'));
    assert.equal(bad.status, 400);
    assert.equal((await post('cy', `/api/projects/${ids.p}/library/files?folder=&name=a.txt`, Buffer.from('y'))).status, 404);
  });

  it('creates, fills and removes folders', async () => {
    const f = await call('ann', 'POST', `/api/projects/${ids.p}/library/folders`, { parent: '', name: 'Research' });
    assert.equal(f.status, 201, JSON.stringify(f.body));
    assert.equal((await call('ann', 'POST', `/api/projects/${ids.p}/library/folders`, { parent: '', name: 'research' })).status, 409);
    assert.equal((await call('ann', 'POST', `/api/projects/${ids.p}/library/folders`, { parent: 'Storyline', name: 'x' })).status, 400);
    assert.equal((await call('ann', 'POST', `/api/projects/${ids.p}/library/folders`, { parent: '', name: '..' })).status, 400);
    await post('ann', `/api/projects/${ids.p}/library/files?folder=Research&name=a.txt`, Buffer.from('aaa'));
    const list = await call('ann', 'GET', `/api/projects/${ids.p}/library?folder=Research`);
    assert.deepEqual(list.body.files.map((x: any) => x.path), ['Research/a.txt']);
    const notEmpty = await call('ann', 'DELETE', `/api/projects/${ids.p}/library/folders?path=Research`);
    assert.equal(notEmpty.status, 409);
    assert.equal(notEmpty.body.files, 1);
    const gone = await call('ann', 'DELETE', `/api/projects/${ids.p}/library/folders?path=Research&recursive=1`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(existsSync(path.join(root, ids.p!, 'Research')), false);
    assert.equal((await call('ann', 'DELETE', `/api/projects/${ids.p}/library/folders?path=Storyline`)).status, 400);
  });

  it('deletes a file', async () => {
    const list = await call('ann', 'GET', `/api/projects/${ids.p}/library`);
    const txt = list.body.files.find((f: any) => f.name === 'notes.txt');
    assert.equal((await call('cy', 'DELETE', `/api/assets/${txt.id}`)).status, 404);
    assert.equal((await call('ann', 'DELETE', `/api/assets/${txt.id}`)).status, 200);
    assert.equal(existsSync(path.join(root, ids.p!, 'notes.txt')), false);
  });
});

describe('cover', () => {
  it('sets a cover, retires the old one with a UTC stamp and merges same-minute replacements', async () => {
    const a = await put('ann', `/api/projects/${ids.p}/cover?name=front.png`, png(800, 600, 3));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.previous, null);
    ids.cover1 = a.body.coverAssetId;
    const card = await call('ann', 'GET', `/api/projects/${ids.p}`);
    assert.equal(card.body.coverAssetId, ids.cover1);
    assert.ok(existsSync(path.join(root, ids.p!, 'cover.png')));

    const same = await put('ann', `/api/projects/${ids.p}/cover?name=again.png`, png(800, 600, 3));
    assert.equal(same.body.changed, false);

    // Both covers are replaced within the same minute (unless the minute turns): the first replacement is dropped.
    const b = await put('ann', `/api/projects/${ids.p}/cover?name=b.png`, png(800, 600, 4));
    assert.match(b.body.previous, /^cover_\d{8}-\d{4}\.png$/);
    const c = await put('ann', `/api/projects/${ids.p}/cover?name=c.png`, png(800, 600, 5));
    const files = readdirSync(path.join(root, ids.p!)).filter((f) => f.startsWith('cover'));
    if (c.body.previous === null) {
      assert.equal(files.filter((f) => !f.includes('_600x')).length, 2, files.join(','));
    } else {
      assert.equal(files.filter((f) => /^cover_\d{8}-\d{4}\.png$/.test(f)).length, 2, files.join(','));
    }
    ids.cover3 = c.body.coverAssetId;
  });

  it('proposes the swap for an earlier cover and applies it', async () => {
    const list = await call('ann', 'GET', `/api/projects/${ids.p}/library`);
    const earlier = list.body.files.find((f: any) => f.earlierCover);
    assert.ok(earlier);
    const dup = await put('ann', `/api/projects/${ids.p}/cover?name=x.png`, await (async () => {
      const r = await call('ann', 'GET', `/api/assets/${earlier.id}/file`);
      return Buffer.from(r.res.rawPayload);
    })());
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'same_as_earlier_cover');
    const use = await call('ann', 'POST', `/api/projects/${ids.p}/cover/use`, { assetId: earlier.id });
    assert.equal(use.status, 200, JSON.stringify(use.body));
    const card = await call('ann', 'GET', `/api/projects/${ids.p}`);
    assert.equal(card.body.coverAssetId, earlier.id);
    assert.ok(existsSync(path.join(root, ids.p!, 'cover.png')));
  });

  it('refuses files that are not images, and the cover cannot be deleted from the library while in use', async () => {
    const r = await put('ann', `/api/projects/${ids.p}/cover?name=a.txt`, Buffer.from('not an image'));
    assert.equal(r.status, 415);
    const card = await call('ann', 'GET', `/api/projects/${ids.p}`);
    assert.equal((await call('ann', 'DELETE', `/api/assets/${card.body.coverAssetId}`)).status, 409);
    assert.equal((await call('ann', 'DELETE', `/api/projects/${ids.p}/cover`)).status, 200);
    assert.equal((await call('ann', 'GET', `/api/projects/${ids.p}`)).body.coverAssetId, null);
  });

  it('limits pictures to 10 MB', async () => {
    const r = await put('ann', `/api/projects/${ids.p}/cover?name=big.png`, Buffer.alloc(10 * 1024 * 1024 + 10, 1));
    assert.ok(r.status === 413 || r.status === 400, String(r.status));
  });
});

describe('character pictures', () => {
  it('stores the picture as Characters/{name}/profile.{ext}, replaces it and reuses identical images', async () => {
    const ch = await call('ann', 'POST', `/api/projects/${ids.p}/characters`, { name: 'Marta' });
    ids.marta = ch.body.id;
    const r = await put('ann', `/api/characters/${ids.marta}/picture?name=marta.png`, png(300, 300, 7));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(existsSync(path.join(root, ids.p!, 'Characters', 'Marta', 'profile.png')));
    const list = await call('ann', 'GET', `/api/projects/${ids.p}/characters`);
    assert.equal(list.body.characters.find((c: any) => c.id === ids.marta).pictureAssetId, r.body.pictureAssetId);
    const again = await put('ann', `/api/characters/${ids.marta}/picture?name=other.png`, png(300, 300, 7));
    assert.equal(again.body.pictureAssetId, r.body.pictureAssetId);
    const tree = await call('ann', 'GET', `/api/projects/${ids.p}/library?folder=Characters`);
    assert.deepEqual(tree.body.folders.map((f: any) => f.name), ['Marta', 'Narrator']);
    assert.equal((await call('ann', 'DELETE', `/api/assets/${r.body.pictureAssetId}`)).status, 409);
    const newer = await put('ann', `/api/characters/${ids.marta}/picture?name=new.png`, png(300, 300, 11));
    assert.equal(newer.status, 200, JSON.stringify(newer.body));
    assert.notEqual(newer.body.pictureAssetId, r.body.pictureAssetId);
    assert.ok(existsSync(path.join(root, ids.p!, 'Characters', 'Marta', 'profile.png')));
    const folder = await call('ann', 'GET', `/api/projects/${ids.p}/library?folder=${encodeURIComponent('Characters/Marta')}`);
    assert.deepEqual(folder.body.files.map((f: any) => f.name), ['profile.png']);
    assert.equal((await call('ann', 'DELETE', `/api/characters/${ids.marta}/picture`)).status, 200);
    assert.equal((await call('cy', 'PUT', `/api/characters/${ids.marta}/picture?name=x.png`, png(30, 30, 8), { 'content-type': 'application/octet-stream' })).status, 404);
  });
});

describe('project deletion', () => {
  it('keeps the files unless asked to delete them', async () => {
    const keep = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Keep ${run}`, language: 'en-US' });
    await post('ann', `/api/projects/${keep.body.id}/library/files?folder=&name=a.txt`, Buffer.from('keep me'));
    await call('ann', 'DELETE', `/api/projects/${keep.body.id}`, { confirmTitle: `Keep ${run}` });
    assert.ok(existsSync(path.join(root, keep.body.id, 'a.txt')));
    const drop = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Drop ${run}`, language: 'en-US' });
    await post('ann', `/api/projects/${drop.body.id}/library/files?folder=&name=a.txt`, Buffer.from('drop me'));
    const d = await call('ann', 'DELETE', `/api/projects/${drop.body.id}`, { confirmTitle: `Drop ${run}`, deleteFiles: true });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(existsSync(path.join(root, drop.body.id)), false);
  });
});

describe('folder rename', () => {
  it('renames a folder with its files, and refuses managed folders and clashes', async () => {
    const pr = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Ren ${run}`, language: 'en-US' });
    const pid = pr.body.id;
    await call('ann', 'POST', `/api/projects/${pid}/library/folders`, { parent: '', name: 'Old' });
    await call('ann', 'POST', `/api/projects/${pid}/library/folders`, { parent: '', name: 'Other' });
    await post('ann', `/api/projects/${pid}/library/files?folder=Old&name=big.png`, png(900, 700, 21));
    const r = await call('ann', 'PATCH', `/api/projects/${pid}/library/folders`, { path: 'Old', name: 'New' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = await call('ann', 'GET', `/api/projects/${pid}/library?folder=New`);
    assert.deepEqual(list.body.files.map((f: any) => f.path), ['New/big.png']);
    assert.ok(existsSync(path.join(root, pid, 'New', 'big.png')) && existsSync(path.join(root, pid, 'New', 'big_600x467.png')));
    assert.equal((await call('ann', 'GET', `/api/assets/${list.body.files[0].id}/file?variant=light`)).status, 200);
    assert.equal((await call('ann', 'PATCH', `/api/projects/${pid}/library/folders`, { path: 'New', name: 'other' })).status, 409);
    assert.equal((await call('ann', 'PATCH', `/api/projects/${pid}/library/folders`, { path: 'Storyline', name: 'x' })).status, 400);
    assert.equal((await call('ann', 'PATCH', `/api/projects/${pid}/library/folders`, { path: 'New', name: 'NEW' })).status, 200);
    assert.equal((await call('cy', 'PATCH', `/api/projects/${pid}/library/folders`, { path: 'NEW', name: 'z' })).status, 404);
  });
});

describe('managed folder names', () => {
  it('renames lower-case managed folders from older libraries, on disk and in the file paths', async () => {
    const { renameSync } = await import('node:fs');
    const { sql } = await import('drizzle-orm');
    const { normalizeManagedFolders } = await import('../src/library/managed.js');
    const pr = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Old ${run}`, language: 'en-US' });
    const pid = pr.body.id;
    const ch = await call('ann', 'POST', `/api/projects/${pid}/characters`, { name: 'Rita' });
    const up = await put('ann', `/api/characters/${ch.body.id}/picture?name=rita.png`, png(300, 300, 9));
    assert.equal(up.status, 200, JSON.stringify(up.body));
    // Make the library look like one written before the rename.
    renameSync(path.join(root, pid, 'Characters'), path.join(root, pid, 'characters'));
    await withDb((db) => db.execute(sql`UPDATE asset SET path = CONCAT('characters', SUBSTRING(path, 11)), lightweight_path = IF(lightweight_path IS NULL, NULL, CONCAT('characters', SUBSTRING(lightweight_path, 11))) WHERE project_id = ${pid}`));
    assert.ok(readdirSync(path.join(root, pid)).includes('characters'));
    const done = await withDb((db) => normalizeManagedFolders(db, pid));
    assert.equal(done.folders, 1);
    assert.ok(done.files >= 1);
    assert.ok(readdirSync(path.join(root, pid)).includes('Characters'));
    assert.ok(existsSync(path.join(root, pid, 'Characters', 'Rita', 'profile.png')));
    const rows = await withDb((db) => db.execute(sql`SELECT path FROM asset WHERE project_id = ${pid}`));
    for (const r of (rows as unknown as [{ path: string }[]])[0]) assert.ok(r.path.startsWith('Characters/'), r.path);
    const again = await withDb((db) => normalizeManagedFolders(db, pid));
    assert.deepEqual(again, { folders: 0, files: 0 });
    const list = await call('ann', 'GET', `/api/projects/${pid}/library`);
    assert.deepEqual(list.body.folders.map((f: any) => f.name), ['Characters', 'Storyline']);
  });
});

describe('audio files', () => {
  const peaksOf = async (id: string) => call('ann', 'GET', `/api/assets/${id}/peaks`);
  const up = (name: string, data: Buffer, folder = '') => post('ann', `/api/projects/${ids.aud}/library/files?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`, data);
  const info = async (id: string) => (await call('ann', 'GET', `/api/assets/${id}`)).body;
  const wav = wavFile({ seconds: 2, seed: 5 });

  it('stores a WAV, reads its header and makes the MP3 playback copy', async () => {
    const pr = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Aud ${run}`, language: 'en-US' });
    ids.aud = pr.body.id;
    const r = await up('take.wav', wav);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'audio');
    assert.ok(['pending', 'processing', 'ready'].includes(r.body.status));
    assert.deepEqual([r.body.format, r.body.durationMs, r.body.sampleRate, r.body.channels], ['wav', 2000, 48000, 2]);
    ids.take = r.body.id;
    await audioJobsIdle();
    const a = await info(ids.take);
    assert.equal(a.status, 'ready');
    assert.equal(a.hasLightweight, true);
    assert.ok(a.sizeLightweight > 10000 && a.sizeLightweight < wav.length);
    assert.ok(existsSync(path.join(root, ids.aud!, 'take.wav')) && existsSync(path.join(root, ids.aud!, 'take.mp3')));
    const light = await call('ann', 'GET', `/api/assets/${ids.take}/file?variant=light`);
    assert.equal(light.res.headers['content-type'], 'audio/mpeg');
    assert.equal(light.res.rawPayload.length, a.sizeLightweight);
    const part = await app.inject({ method: 'GET', url: `/api/assets/${ids.take}/file?variant=light`, headers: { cookie: cookies.ann!, range: 'bytes=0-99' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.rawPayload.length, 100);
    const orig = await call('ann', 'GET', `/api/assets/${ids.take}/file?download=1`);
    assert.equal(orig.res.headers['content-type'], 'audio/wav');
    assert.equal(orig.res.rawPayload.length, wav.length);
    const list = await call('ann', 'GET', `/api/projects/${ids.aud}/library`);
    assert.deepEqual(list.body.files.map((f: any) => f.name), ['take.wav']); // the playback copy is not a library file
    assert.equal((await call('cy', 'GET', `/api/assets/${ids.take}`)).status, 404);
  });

  it('serves the waveform: one byte per 100 ms, on a decibel scale', async () => {
    const a = await info(ids.take);
    assert.equal(a.hasPeaks, true);
    const r = await peaksOf(ids.take);
    assert.equal(r.status, 200);
    assert.equal(r.res.headers['content-type'], 'application/octet-stream');
    assert.equal(r.res.headers['x-peaks-step-ms'], '100');
    assert.equal(r.res.rawPayload.length, 20); // 2 s
    // the tone is at 0.6 of full scale, about -4.4 dB: byte 255 * (60 - 4.4) / 60 = 236
    for (const v of r.res.rawPayload) assert.ok(Math.abs(v - 236) <= 2, `byte ${v}`);
    const again = await app.inject({ method: 'GET', url: `/api/assets/${ids.take}/peaks`, headers: { cookie: cookies.ann!, 'if-none-match': String(r.res.headers.etag) } });
    assert.equal(again.statusCode, 304);
    assert.equal((await call('cy', 'GET', `/api/assets/${ids.take}/peaks`)).status, 404);
  });

  it('refuses a recording it already has, even with other tags, and unusable files', async () => {
    const same = await up('copy.wav', wavFile({ seconds: 2, seed: 5, list: true }));
    assert.equal(same.status, 409);
    assert.equal(same.body.error, 'already_in_library');
    assert.equal(same.body.details?.assetId ?? same.body.assetId, ids.take);
    assert.equal((await up('cut.wav', wavFile({ cut: 3000 }))).status, 422);
    assert.equal((await up('six.wav', wavFile({ channels: 3 }))).status, 415);
  });

  it('keeps an uploaded MP3 as it is, without a second copy', async () => {
    const mp3 = (await call('ann', 'GET', `/api/assets/${ids.take}/file?variant=light`)).res.rawPayload;
    const r = await up('song.mp3', mp3, '');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.hasLightweight, r.body.format], [false, 'mp3']);
    assert.ok(Math.abs(r.body.durationMs - 2000) < 60);
    await audioJobsIdle(); // its peaks are made from the decoded MP3
    const a = await info(r.body.id);
    assert.deepEqual([a.status, a.hasLightweight, a.hasPeaks], ['ready', false, true]);
    assert.ok(!existsSync(path.join(root, ids.aud!, 'song.mp3.mp3')));
    ids.song = r.body.id;
  });

  it('names the playback copy after the master, and numbers on a clash', async () => {
    const r = await up('take.wav', wavFile({ seconds: 1, seed: 6 }));
    assert.equal(r.status, 201);
    assert.equal(r.body.name, 'take (2).wav');
    await audioJobsIdle();
    assert.ok(existsSync(path.join(root, ids.aud!, 'take (2).mp3')));
  });

  it('moves the playback copy with a renamed folder and removes both files on delete', async () => {
    await call('ann', 'POST', `/api/projects/${ids.aud}/library/folders`, { parent: '', name: 'Birds' });
    const r = await up('gulls.wav', wavFile({ seconds: 1, seed: 8 }), 'Birds');
    await audioJobsIdle();
    assert.equal((await call('ann', 'PATCH', `/api/projects/${ids.aud}/library/folders`, { path: 'Birds', name: 'Sea birds' })).status, 200);
    assert.ok(existsSync(path.join(root, ids.aud!, 'Sea birds', 'gulls.mp3')));
    assert.equal((await call('ann', 'GET', `/api/assets/${r.body.id}/file?variant=light`)).status, 200);
    assert.equal((await call('ann', 'DELETE', `/api/assets/${r.body.id}`)).status, 200);
    assert.equal(existsSync(path.join(root, ids.aud!, 'Sea birds', 'gulls.wav')) || existsSync(path.join(root, ids.aud!, 'Sea birds', 'gulls.mp3')), false);
  });

  it('marks a failed encode, keeps the master, and retries it', async () => {
    const r = await up('fragile.wav', wavFile({ seconds: 1, seed: 9 }));
    await audioJobsIdle();
    const wavPath = path.join(root, ids.aud!, 'fragile.wav');
    const keep = readFileSync(wavPath);
    rmSync(wavPath);
    await withDb((db) => db.execute(sql`UPDATE asset SET status = 'pending', size_lightweight = NULL WHERE id = ${r.body.id}`));
    kickAudioJobs();
    await audioJobsIdle();
    const failed = await info(r.body.id);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.error);
    assert.equal(failed.hasLightweight, false);
    assert.equal(failed.hasPeaks, false);
    assert.equal((await peaksOf(r.body.id)).status, 409);
    assert.equal((await call('ann', 'GET', `/api/assets/${r.body.id}/file?variant=light`)).status, 409);
    assert.equal((await call('ann', 'POST', `/api/assets/${ids.take}/retry`)).status, 409); // not failed
    assert.equal((await call('cy', 'POST', `/api/assets/${r.body.id}/retry`)).status, 404);
    writeFileSync(wavPath, keep);
    assert.equal((await call('ann', 'POST', `/api/assets/${r.body.id}/retry`)).status, 200);
    await audioJobsIdle();
    assert.equal((await info(r.body.id)).status, 'ready');
  });

  it('puts interrupted work back in the queue', async () => {
    const r = await up('stuck.wav', wavFile({ seconds: 1, seed: 10 }));
    await audioJobsIdle();
    const set = (by: string, minutes: number) => withDb((db) => db.execute(sql`UPDATE asset SET status = 'processing', claimed_by = ${by}, claimed_at = ${new Date(Date.now() - minutes * 60000)}, attempts = 1 WHERE id = ${r.body.id}`));
    await set('otherhost:1', 1);
    assert.equal(await requeueAudio(true), 0); // another instance, claim still fresh
    await set(`${hostname().slice(0, 40)}:99999`, 0);
    assert.equal(await requeueAudio(false), 0); // this host, but not on boot and not old
    assert.equal(await requeueAudio(true), 1); // this host's process is gone
    await set('otherhost:1', 10);
    assert.equal(await requeueAudio(false), 1); // old enough
    kickAudioJobs();
    await audioJobsIdle();
    assert.equal((await info(r.body.id)).status, 'ready');
    await withDb((db) => db.execute(sql`UPDATE asset SET status = 'processing', claimed_by = 'otherhost:1', claimed_at = ${new Date(Date.now() - 600000)}, attempts = 3 WHERE id = ${r.body.id}`));
    await requeueAudio(false);
    assert.equal((await info(r.body.id)).status, 'failed'); // tried three times already
  });
});

describe('peaks for older assets and cleanup', () => {
  it('makes peaks for a ready asset that has none, without encoding the MP3 again', async () => {
    const { queueMissingPeaks } = await import('../src/audio/jobs.js');
    const before = await call('ann', 'GET', `/api/assets/${ids.take}`);
    const mp3Path = path.join(root, ids.aud!, 'take.mp3');
    const stamp = readFileSync(mp3Path);
    await withDb((db) => db.execute(sql`DELETE FROM asset_peaks WHERE asset_id = ${ids.take}`));
    assert.equal((await call('ann', 'GET', `/api/assets/${ids.take}/peaks`)).status, 404);
    assert.ok((await queueMissingPeaks()) >= 1);
    kickAudioJobs();
    await audioJobsIdle();
    assert.equal((await call('ann', 'GET', `/api/assets/${ids.take}/peaks`)).status, 200);
    assert.deepEqual(readFileSync(mp3Path), stamp); // the MP3 was kept, not made again
    assert.equal((await call('ann', 'GET', `/api/assets/${ids.take}`)).body.sizeLightweight, before.body.sizeLightweight);
  });

  it('removes the peaks with the asset', async () => {
    const n = async () => Number(((await withDb((db) => db.execute(sql`SELECT COUNT(*) AS n FROM asset_peaks WHERE asset_id = ${ids.song}`))) as any)[0][0].n);
    assert.equal(await n(), 1);
    assert.equal((await call('ann', 'DELETE', `/api/assets/${ids.song}`)).status, 200);
    assert.equal(await n(), 0);
  });
});
