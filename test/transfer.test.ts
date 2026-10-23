import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

const root = mkdtempSync(path.join(tmpdir(), 'transfer-'));
process.env.LIBRARY_ROOT = root;

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
  return { status: res.statusCode, body, res };
}

before(async () => {
  await runMigrations();
  app = buildApp();
  await app.ready();
  await withDb(async (db) => {
    for (const who of ['ann', 'cy']) {
      await createUser(db, { email: `${who}.xfer.${run}@t.test`, displayName: who, password: 'Test-password-123!', mustChangePassword: false });
    }
  });
  for (const who of ['ann', 'cy']) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: `${who}.xfer.${run}@t.test`, password: 'Test-password-123!' } });
    cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
  }
  // A project with a bit of everything: characters, cues, a library file with a chosen clip, and notes of every kind.
  const p = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Transfer ${run} Ünï`, subtitle: 'sub', language: 'pt-BR' });
  ids.p = p.body.id;
  const ana = await call('ann', 'POST', `/api/projects/${ids.p}/characters`, { name: 'Ana', colour: '#F2605C', description: 'The hero' });
  assert.equal(ana.status, 201, JSON.stringify(ana.body));
  const story = await call('ann', 'GET', `/api/projects/${ids.p}/story`);
  ids.chapter = story.body.chapters[0].id;
  ids.seg = story.body.chapters[0].segments[0].id;
  const content = (await call('ann', 'GET', `/api/segments/${ids.seg}`)).body;
  ids.scene = content.scenes[0].id;
  const speech = await call('ann', 'POST', `/api/scenes/${ids.scene}/cues`, { type: 'speech', text: 'Olá, mundo!', characterId: ana.body.id });
  assert.equal(speech.status, 201, JSON.stringify(speech.body));
  const sfx = await call('ann', 'POST', `/api/scenes/${ids.scene}/cues`, { type: 'sfx', text: 'birds' });
  ids.sfx = sfx.body.created;
  const up = await call('ann', 'POST', `/api/projects/${ids.p}/library/files?folder=&name=birds.wav`, wavFile({ seconds: 3, seed: 5 }), { 'content-type': 'application/octet-stream' });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  ids.asset = up.body.id;
  await audioJobsIdle();
  const clip = await call('ann', 'POST', `/api/cues/${ids.sfx}/clips`, { assetId: ids.asset, offsetMs: 500, lengthMs: 1500, choose: true });
  assert.equal(clip.status, 201, JSON.stringify(clip.body));
  const c1 = await call('ann', 'POST', `/api/projects/${ids.p}/notes`, { type: 'comment', textMd: 'Project note' });
  const r1 = await call('ann', 'POST', `/api/projects/${ids.p}/notes`, { replyTo: c1.body.id, textMd: 'A reply' });
  await call('ann', 'POST', `/api/projects/${ids.p}/notes`, { replyTo: r1.body.id, textMd: 'A reply to the reply' });
  await call('ann', 'POST', `/api/projects/${ids.p}/notes`, { type: 'task', textMd: 'Record the intro', target: { kind: 'chapter', id: ids.chapter } });
  const ref = await call('ann', 'POST', `/api/projects/${ids.p}/notes`, { type: 'reference', refKey: 'wiki', link: 'https://example.com/x', textMd: 'Source', target: { kind: 'cue', id: ids.sfx } });
  assert.equal(ref.status, 201, JSON.stringify(ref.body));
  await call('ann', 'POST', `/api/projects/${ids.p}/notes`, { type: 'comment', textMd: 'About the file', target: { kind: 'asset', id: ids.asset } });
});

after(async () => {
  await app.close();
  await closeResizePool();
  await stopAudioJobs();
  rmSync(root, { recursive: true, force: true });
});

/** The file without what must differ between two imports of it. */
const essence = (b: any) => ({ ...b, exportedAt: undefined, project: { ...b.project, title: undefined, repoFolder: undefined } });
const { readZipEntry, readZipIndex } = await import('../web/src/zip.js');
/** The export is a zip: project.json at its root and the library's files. This returns the response with the project file read out of it. */
const exportOf = async (who: string, id: string) => {
  const res = (await call(who, 'GET', `/api/projects/${id}/export`)).res;
  let project: any = null;
  let names: string[] = [];
  if (res.statusCode === 200) {
    const blob = new Blob([res.rawPayload]);
    const entries = await readZipIndex(blob);
    names = entries.map((e) => e.name);
    project = JSON.parse(await (await readZipEntry(blob, entries.find((e) => e.name === 'project.json')!)).text());
  }
  return { statusCode: res.statusCode, headers: res.headers, raw: res.rawPayload, names, json: () => project };
};

describe('export, import and library zip', () => {
  let file: any;

  it('exports everything but the members as one zip with project.json in its root', async () => {
    const res = await exportOf('ann', ids.p);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-disposition']), /^attachment; filename=".*\.zip"; filename\*=UTF-8''/);
    file = res.json();
    assert.equal(file.format, 'blackbird-project');
    assert.equal(file.assets.length, 1);
    assert.equal(file.characters.length, 2); // Narrator + Ana
    assert.equal(file.notes.length, 6);
    assert.ok(file.assets[0].peaks);
    assert.ok(!JSON.stringify(file).includes('membership'));
    assert.equal((await exportOf('cy', ids.p)).statusCode, 404); // not a member
  });

  it('asks for another folder when the folder is taken, and imports into the one chosen', async () => {
    const taken = await call('cy', 'POST', '/api/projects/import', { file });
    assert.equal(taken.status, 409, JSON.stringify(taken.body));
    assert.equal(taken.body.error, 'folder_taken');
    assert.ok(taken.body.suggestion && taken.body.suggestion !== taken.body.folder);
    assert.equal(taken.body.existing, undefined); // cy cannot edit ann's project, so there is nothing to add files to
    const own = await call('ann', 'POST', '/api/projects/import', { file });
    assert.equal(own.status, 409);
    assert.deepEqual(own.body.existing, { id: ids.p, title: `Transfer ${run} Ünï` }); // ann can: the app offers to add the files there
    // still taken when the user types a name that is taken (ignoring case)
    assert.equal((await call('cy', 'POST', '/api/projects/import', { file, repoFolder: taken.body.folder.toUpperCase() })).status, 409);

    const ok = await call('cy', 'POST', '/api/projects/import', { file, repoFolder: taken.body.suggestion });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    ids.copy = ok.body.id;
    const card = (await call('cy', 'GET', `/api/projects/${ids.copy}`)).body;
    assert.equal(card.role, 'author');
    assert.equal(card.repoFolder, taken.body.suggestion);
    assert.equal((await call('cy', 'GET', `/api/projects/${ids.copy}/members`)).body.members.length, 1); // only the importer
  });

  it('gives back the same file when the copy is exported again', async () => {
    const again = (await exportOf('cy', ids.copy)).json();
    assert.deepEqual(essence(again), essence(file));
  });

  it('keeps clips, the chosen clip, the library list (files marked missing) and note threads', async () => {
    const content = (await call('cy', 'GET', `/api/segments/${(await call('cy', 'GET', `/api/projects/${ids.copy}/story`)).body.chapters[0].segments[0].id}`)).body;
    const sfx = content.scenes[0].cues.find((c: any) => c.type === 'sfx');
    assert.equal(sfx.clips.length, 1);
    assert.equal(sfx.clips[0].offsetMs, 500);
    const lib = (await call('cy', 'GET', `/api/projects/${ids.copy}/library`)).body;
    assert.ok(JSON.stringify(lib).includes('birds.wav'));
    const notes = (await call('cy', 'GET', `/api/projects/${ids.copy}/notes`)).body.notes;
    assert.equal(notes.length, 6);
  });

  it('refuses things that are not a project file, and saves nothing', async () => {
    const count = async () => (await call('cy', 'GET', '/api/projects')).body.projects.length;
    const before = await count();
    for (const bad of [{ nope: 1 }, { ...file, format: 'other' }, { ...file, version: 9 }, { ...file, characters: [] }]) {
      const r = await call('cy', 'POST', '/api/projects/import', { file: bad, repoFolder: `X ${Math.random()}` });
      assert.equal(r.status, 400, JSON.stringify(r.body));
    }
    const dup = structuredClone(file);
    dup.notes[1].root = 5; // a reply that points forward
    assert.equal((await call('cy', 'POST', '/api/projects/import', { file: dup, repoFolder: `Y ${Math.random()}` })).status, 400);
    assert.equal(await count(), before);
    assert.equal((await call('cy', 'POST', '/api/projects/import', { file })).status, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/import', payload: { file } })).statusCode, 401);
  });

  it('has the library files next to project.json in the zip, and refuses a clashing file name', async () => {
    const res = await exportOf('ann', ids.p!);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.equal(res.raw.subarray(0, 2).toString(), 'PK');
    assert.equal(res.names[0], 'project.json');
    assert.ok(res.names.includes('birds.wav'), 'the library file is in the zip');
    assert.equal((await call('ann', 'GET', `/api/projects/${ids.p}/export/check`)).body.ok, true);
    // a library file that would take the place of the project file
    const clash = await call('ann', 'POST', `/api/projects/${ids.p}/library/files?folder=&name=project.json`, Buffer.from('{}'), { 'content-type': 'application/octet-stream' });
    assert.equal(clash.status, 201, JSON.stringify(clash.body));
    const refused = await call('ann', 'GET', `/api/projects/${ids.p}/export/check`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'name_clash');
    assert.equal((await call('ann', 'DELETE', `/api/assets/${clash.body.id}`)).status, 200);
  });

  it('restores library files into the imported copy, file by file', async () => {
    const { asset } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const restore = (who: string, id: string, p: string, body: Buffer) =>
      call(who, 'POST', `/api/projects/${id}/library/restore?path=${encodeURIComponent(p)}`, body, { 'content-type': 'application/octet-stream' });
    const row = (project: string) => withDb(async (db) => (await db.select().from(asset).where(eq(asset.projectId, project)))[0]!);
    const master = wavFile({ seconds: 3, seed: 5 });
    const before = await row(ids.copy!);
    assert.equal(before.fileState, 'missing');
    // not in the project's list, wrong content, not a member
    assert.equal((await restore('cy', ids.copy!, 'nope.wav', master)).status, 404);
    const wrong = await restore('cy', ids.copy!, before.path, wavFile({ seconds: 3, seed: 6 }));
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error, 'hash_mismatch');
    assert.equal((await restore('ann', ids.copy!, before.path, master)).status, 404);
    // the master, then the same again, then the derived copy (when the asset has one)
    const first = await restore('cy', ids.copy!, before.path, master);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.outcome, 'restored');
    assert.equal((await restore('cy', ids.copy!, before.path, master)).body.outcome, 'already');
    if (before.lightweightPath) {
      assert.equal((await row(ids.copy!)).fileState, 'missing'); // the playback copy is still absent
      const original = await row(ids.p!);
      const light = await app.inject({ method: 'GET', url: `/api/assets/${original.id}/file?variant=light`, headers: { cookie: cookies.ann! } });
      assert.equal(light.statusCode, 200);
      const derived = await restore('cy', ids.copy!, before.lightweightPath, light.rawPayload);
      assert.equal(derived.body.kind, 'derived');
    }
    const after = await row(ids.copy!);
    assert.equal(after.fileState, 'ok');
    const served = await app.inject({ method: 'GET', url: `/api/assets/${after.id}/file`, headers: { cookie: cookies.cy! } });
    assert.equal(served.statusCode, 200);
    assert.ok(served.rawPayload.equals(master));
  });

  it('re-uploads a file: same asset and clips, new waveform, one task per cue that plays it', async () => {
    const { asset, assetPeaks, clip } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const before = await withDb(async (db) => ({ a: (await db.select().from(asset).where(eq(asset.id, ids.asset!)))[0]!, p: (await db.select().from(assetPeaks).where(eq(assetPeaks.assetId, ids.asset!)))[0]!, clips: await db.select().from(clip).where(eq(clip.assetId, ids.asset!)) }));
    const send = (who: string, id: string, body: Buffer) => call(who, 'POST', `/api/assets/${id}/replace`, body, { 'content-type': 'application/octet-stream' });
    const tasks = async () => (await call('ann', 'GET', `/api/projects/${ids.p}/notes`)).body.notes.filter((n: any) => n.type === 'task' && n.textMd === 'Check if new audio is fitting');
    assert.equal((await send('cy', ids.asset!, wavFile({ seconds: 3, seed: 9 }))).status, 404); // not a member
    assert.equal((await send('ann', ids.asset!, Buffer.from('not audio'))).status >= 400, true);
    const r = await send('ann', ids.asset!, wavFile({ seconds: 4, seed: 9 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.id, ids.asset);
    assert.equal(r.body.tasks, 1);
    await audioJobsIdle();
    const after = await withDb(async (db) => ({ a: (await db.select().from(asset).where(eq(asset.id, ids.asset!)))[0]!, p: (await db.select().from(assetPeaks).where(eq(assetPeaks.assetId, ids.asset!)))[0]!, clips: await db.select().from(clip).where(eq(clip.assetId, ids.asset!)) }));
    assert.notEqual(after.a.hash, before.a.hash);
    assert.equal(after.a.status, 'ready');
    assert.equal(after.a.path, before.a.path);
    assert.ok(!after.p.data.equals(before.p.data), 'the waveform was made again');
    assert.deepEqual(after.clips.map((c) => [c.id, c.cueId, c.offsetMs, c.lengthMs]), before.clips.map((c) => [c.id, c.cueId, c.offsetMs, c.lengthMs])); // the cue is untouched
    assert.equal((await tasks()).length, 1);
    assert.equal((await tasks())[0].target.kind, 'cue');
    // another change while the task is still open adds no second task; the same file again changes nothing
    assert.equal((await send('ann', ids.asset!, wavFile({ seconds: 4, seed: 10 }))).body.tasks, 0);
    await audioJobsIdle();
    assert.equal((await tasks()).length, 1);
    // the same recording again (what putting a missing file back usually is) still asks for a listen, once the first task is done
    const t = (await tasks())[0];
    assert.equal((await call('ann', 'POST', `/api/notes/${t.id}/done`, { done: true })).status < 300, true);
    const same = await send('ann', ids.asset!, wavFile({ seconds: 4, seed: 10 }));
    assert.equal(same.body.tasks, 1);
    await audioJobsIdle();
  });

  it('asks which zip files exist, and replaces the ones chosen', async () => {
    const { asset } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const row = (await withDb(async (db) => db.select().from(asset).where(eq(asset.projectId, ids.copy!))))[0]!;
    const check = await call('cy', 'POST', `/api/projects/${ids.copy}/library/restore-check`, { paths: [row.path, 'nope.wav'] });
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.equal(check.body.files.length, 1);
    assert.equal(check.body.files[0].role, 'master');
    assert.ok(check.body.files[0].onDisk > 0);
    assert.equal((await call('ann', 'POST', `/api/projects/${ids.copy}/library/restore-check`, { paths: [row.path] })).status, 404);
    const replace = await call('cy', 'POST', `/api/projects/${ids.copy}/library/restore?path=${encodeURIComponent(row.path)}&replace=1`, wavFile({ seconds: 2, seed: 21 }), { 'content-type': 'application/octet-stream' });
    assert.equal(replace.status, 200, JSON.stringify(replace.body));
    assert.equal(replace.body.outcome, 'replaced');
    assert.equal(replace.body.tasks, 1);
    await audioJobsIdle();
    const now = (await withDb(async (db) => db.select().from(asset).where(eq(asset.id, row.id))))[0]!;
    assert.notEqual(now.hash, row.hash);
    assert.equal(now.status, 'ready');
    // without the flag an existing file is kept
    const keep = await call('cy', 'POST', `/api/projects/${ids.copy}/library/restore?path=${encodeURIComponent(row.path)}`, wavFile({ seconds: 2, seed: 21 }), { 'content-type': 'application/octet-stream' });
    assert.equal(keep.body.outcome, 'already');
  });

  it('deletes projects with note threads and chosen clips, original and imported copy', async () => {
    const title = (await call('cy', 'GET', `/api/projects/${ids.copy}`)).body.title;
    assert.equal((await call('cy', 'DELETE', `/api/projects/${ids.copy}`, { confirmTitle: title, deleteFiles: true })).status, 200);
    assert.equal((await call('cy', 'GET', `/api/projects/${ids.copy}`)).status, 404);
    const own = (await call('ann', 'GET', `/api/projects/${ids.p}`)).body.title;
    assert.equal((await call('ann', 'DELETE', `/api/projects/${ids.p}`, { confirmTitle: own })).status, 200);
  });
});
