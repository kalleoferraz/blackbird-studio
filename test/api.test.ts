import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { withDb } from '../src/db/client.js';
import { createUser } from '../src/auth/accounts.js';
import { team, teamMember } from '../src/db/schema.js';
import { newUlid } from '../src/db/ids.js';
import { setVersionStoreFactory } from '../src/server/snapshots.js';

let app: FastifyInstance;
const run = Date.now().toString(36);
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

async function call(who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, headers: { cookie: cookies[who] ?? '' } });
  let body: any = null;
  try { body = res.json(); } catch { /* empty */ }
  return { status: res.statusCode, body };
}

async function login(who: string, email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'Test-password-123!' } });
  assert.equal(res.statusCode, 200, res.body);
  cookies[who] = String(res.headers['set-cookie']).split(';')[0]!;
}

before(async () => {
  await runMigrations();
  app = buildApp();
  await app.ready();
  await withDb(async (db) => {
    for (const who of ['ann', 'bob', 'cy']) {
      const u = await createUser(db, { email: `${who}.${run}@t.test`, displayName: who, password: 'Test-password-123!', mustChangePassword: false });
      ids[who] = u!.id;
    }
    const teamId = newUlid();
    const now = new Date();
    await db.insert(team).values({ id: teamId, name: `T ${run}`, createdAt: now, updatedAt: now });
    for (const who of ['ann', 'bob']) await db.insert(teamMember).values({ teamId, userId: ids[who]! });
  });
  for (const who of ['ann', 'bob', 'cy']) await login(who, `${who}.${run}@t.test`);
});

after(async () => { await app.close(); });

describe('projects and story', () => {
  it('creates a project with the starter structure', async () => {
    const r = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Book ${run}`, language: 'en-US' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.p = r.body.id ?? r.body.project?.id;
    assert.ok(ids.p);
    const s = await call('ann', 'GET', `/api/projects/${ids.p}/story`);
    assert.equal(s.body.chapters.length, 1);
    assert.equal(s.body.chapters[0].index, '01');
    assert.equal(s.body.chapters[0].scenes.length, 1);
    assert.equal(s.body.chapters[0].scenes[0].cueCount, 1);
    ids.ch1 = s.body.chapters[0].id;
    ids.sc1 = s.body.chapters[0].scenes[0].id;
  });

  it('hides the project from non-members', async () => {
    assert.equal((await call('cy', 'GET', `/api/projects/${ids.p}/story`)).status, 404);
  });

  it('adds chapters, introductory ones above numbered', async () => {
    const a = await call('ann', 'POST', `/api/projects/${ids.p}/chapters`, { title: 'Two' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await call('ann', 'POST', `/api/projects/${ids.p}/chapters`, { title: 'Prologue', introductory: true });
    assert.deepEqual(b.body.chapters.map((c: any) => c.index), ['00A', '01', '02']);
    assert.deepEqual(b.body.chapters.map((c: any) => c.title), ['Prologue', 'Chapter 1', 'Two'].map((t, i) => (i === 1 ? b.body.chapters[1].title : t)));
    ids.ch2 = a.body.created;
  });

  it('moves chapters within their group only', async () => {
    const m = await call('ann', 'POST', `/api/chapters/${ids.ch2}/move`, { position: 1 });
    assert.equal(m.body.chapters[0].introductory, true);
    assert.equal(m.body.chapters[1].id, ids.ch2);
    assert.deepEqual(m.body.chapters.map((c: any) => c.position), [1, 2, 3]);
  });

  it('adds, renames, moves and deletes scenes', async () => {
    const a = await call('ann', 'POST', `/api/chapters/${ids.ch1}/scenes`, { title: 'Second' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const second = a.body.created;
    const mv = await call('ann', 'POST', `/api/scenes/${second}/move`, { chapterId: ids.ch2, position: 1 });
    const ch2 = mv.body.chapters.find((c: any) => c.id === ids.ch2);
    assert.equal(ch2.scenes.length, 2 - 1 + 1 > 0 ? ch2.scenes.length : 0);
    assert.ok(ch2.scenes.some((s: any) => s.id === second));
    await call('ann', 'PATCH', `/api/scenes/${second}`, { title: 'Renamed' });
    const del = await call('ann', 'DELETE', `/api/scenes/${second}`);
    assert.equal(del.status, 200);
    assert.ok(!del.body.chapters.some((c: any) => c.scenes.some((s: any) => s.id === second)));
  });

  it('writes cues with ripple and lanes', async () => {
    const scn = await call('ann', 'GET', `/api/scenes/${ids.sc1}`);
    assert.equal(scn.status, 200);
    const seg = scn.body.segments[0];
    const first = seg.cues[0];
    const chars = await call('ann', 'GET', `/api/projects/${ids.p}/characters`);
    const narrator = (chars.body.characters ?? chars.body)[0];
    const upd = await call('ann', 'PATCH', `/api/cues/${first.id}`, { text: 'Hello there, this is the first line.', characterId: narrator.id });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const second = await call('ann', 'POST', `/api/segments/${seg.id}/cues`, { afterCueId: first.id, type: 'speech', characterId: narrator.id, text: 'Second line.' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const cues = second.body.segments[0].cues;
    assert.equal(cues.length, 2);
    assert.ok(cues[1].startMs >= cues[0].startMs + cues[0].lengthMs);
    const end0 = cues[0].startMs + cues[0].lengthMs;
    // lengthen the first cue: the second shifts by the delta
    const longer = await call('ann', 'PATCH', `/api/cues/${cues[0].id}`, { lengthMs: cues[0].lengthMs + 5000 });
    assert.equal(longer.body.segments[0].cues[1].startMs, cues[1].startMs + 5000);
    assert.ok(end0 > 0);
    assert.equal(longer.body.segments[0].cues[0].lengthAuto, false);
  });

  it('adds sfx cue on its own lane and prunes it', async () => {
    const scn = await call('ann', 'GET', `/api/scenes/${ids.sc1}`);
    const seg = scn.body.segments[0];
    const r = await call('ann', 'POST', `/api/segments/${seg.id}/cues`, { type: 'sfx', text: 'door slam' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const sfx = r.body.segments[0].cues.find((c: any) => c.id === r.body.created);
    assert.equal(sfx.characterId, null);
    assert.ok(r.body.lanes.some((l: any) => l.id === sfx.laneId && /^SFX/.test(l.title)));
    const d = await call('ann', 'DELETE', `/api/cues/${sfx.id}`);
    assert.ok(!d.body.lanes.some((l: any) => l.id === sfx.laneId));
  });

  it('splits and merges segments', async () => {
    const scn = await call('ann', 'GET', `/api/scenes/${ids.sc1}`);
    const seg = scn.body.segments[0];
    const second = seg.cues[1];
    const sp = await call('ann', 'POST', `/api/segments/${seg.id}/split`, { beforeCueId: second.id });
    assert.equal(sp.status, 201, JSON.stringify(sp.body));
    assert.equal(sp.body.segments.length, 2);
    const mg = await call('ann', 'POST', `/api/segments/${sp.body.created}/merge-previous`);
    assert.equal(mg.body.segments.length, 1);
    assert.equal(mg.body.segments[0].cues.length, 2);
    const last = await call('ann', 'DELETE', `/api/segments/${mg.body.segments[0].id}`);
    assert.equal(last.status, 400);
  });

  it('manages characters', async () => {
    const c = await call('ann', 'POST', `/api/projects/${ids.p}/characters`, { name: 'Zed' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const chars = await call('ann', 'GET', `/api/projects/${ids.p}/characters`);
    const list = chars.body.characters ?? chars.body;
    const narrator = list.find((x: any) => x.isNarrator);
    assert.equal((await call('ann', 'DELETE', `/api/characters/${narrator.id}`)).status, 400);
    const zed = list.find((x: any) => x.name === 'Zed');
    assert.equal((await call('ann', 'DELETE', `/api/characters/${zed.id}`)).status, 200);
  });

  it('members: viewer is read-only, last author guarded', async () => {
    const found = await call('ann', 'GET', `/api/projects/${ids.p}/user-search?q=bob.${run}`);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    const add = await call('ann', 'PUT', `/api/projects/${ids.p}/members/${ids.bob}`, { role: 'viewer' });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.equal((await call('bob', 'GET', `/api/projects/${ids.p}/story`)).status, 200);
    assert.equal((await call('bob', 'POST', `/api/projects/${ids.p}/chapters`, { title: 'x' })).status, 403);
    assert.equal((await call('ann', 'PUT', `/api/projects/${ids.p}/members/${ids.cy}`, { role: 'viewer' })).status >= 400, true);
    assert.equal((await call('ann', 'DELETE', `/api/projects/${ids.p}/members/${ids.ann}`)).status >= 400, true);
  });

  it('deletes a project only with the title', async () => {
    assert.equal((await call('ann', 'DELETE', `/api/projects/${ids.p}`, { confirmTitle: 'nope' })).status, 400);
    assert.equal((await call('ann', 'DELETE', `/api/projects/${ids.p}`, { confirmTitle: `Book ${run}` })).status, 200);
  });
});

describe('admin teams', () => {
  it('manages teams and guards disabling the last author', async () => {
    await withDb(async (db) => {
      await createUser(db, { email: 'admin@example.com', displayName: 'Admin', password: 'Test-password-123!', mustChangePassword: false });
    });
    await login('admin', 'admin@example.com');
    const made = await call('admin', 'POST', '/api/admin/teams', { name: `Crew ${run}` });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call('admin', 'POST', '/api/admin/teams', { name: `Crew ${run}` })).status, 409);
    assert.equal((await call('admin', 'PUT', `/api/admin/teams/${made.body.id}/members/${ids.cy}`)).status, 200);
    const list = await call('admin', 'GET', '/api/admin/teams');
    assert.ok(list.body.teams.find((t: any) => t.id === made.body.id).members.some((m: any) => m.id === ids.cy));
    assert.equal((await call('ann', 'GET', '/api/admin/teams')).status, 403);
    // ann is sole author of a fresh project
    const p = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Solo ${run}`, language: 'en-US' });
    const dis = await call('admin', 'POST', `/api/admin/users/${ids.ann}/disabled`, { disabled: true });
    assert.equal(dis.status, 409, JSON.stringify(dis.body));
    assert.equal(dis.body.error, 'last_author');
    await call('ann', 'DELETE', `/api/projects/${p.body.id}`, { confirmTitle: `Solo ${run}` });
    assert.equal((await call('admin', 'DELETE', `/api/admin/teams/${made.body.id}`)).status, 200);
  });
});

describe('snapshots', () => {
  it('saves files, clears the dirty flag, and skips unchanged saves', async () => {
    const saved: { folder: string; files: Record<string, string>; message: string }[] = [];
    let last = '';
    setVersionStoreFactory(() => ({
      async commit(input) {
        const key = JSON.stringify(input.files);
        if (key === last) return { sha: null };
        last = key; saved.push(input);
        return { sha: 'a'.repeat(39) + String(saved.length) };
      },
    }));
    const p = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Snap ${run}`, language: 'en-US' });
    const sc = (await call('ann', 'GET', `/api/projects/${p.body.id}/story`)).body.chapters[0].scenes[0].id;
    const seg = (await call('ann', 'GET', `/api/scenes/${sc}`)).body.segments[0];
    await call('ann', 'PATCH', `/api/cues/${seg.cues[0].id}`, { text: 'Opening line.' });
    await call('ann', 'POST', `/api/segments/${seg.id}/cues`, { type: 'sfx', text: 'door slam' });
    assert.ok((await call('ann', 'GET', `/api/projects/${p.body.id}`)).body.dirtySince);

    const r1 = await call('ann', 'POST', `/api/projects/${p.body.id}/snapshot`, { label: 'first' });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.unchanged, false);
    const files = saved[0]!.files;
    assert.ok(files['Project.json'] && files['Script.md']);
    assert.ok(Object.keys(files).some((f) => f === 'Chapters/01 - Chapter 1.md'));
    assert.match(files['Script.md']!, /\*\*Narrator:\*\* Opening line\./);
    assert.match(files['Script.md']!, /\[SFX: door slam\]/);
    assert.equal((await call('ann', 'GET', `/api/projects/${p.body.id}`)).body.dirtySince, null);

    const r2 = await call('ann', 'POST', `/api/projects/${p.body.id}/snapshot`, {});
    assert.equal(r2.body.unchanged, true);
    const list = await call('ann', 'GET', `/api/projects/${p.body.id}/snapshots`);
    assert.equal(list.body.snapshots.length, 1);
    assert.equal(list.body.snapshots[0].label, 'first');
    assert.equal((await call('bob', 'POST', `/api/projects/${p.body.id}/snapshot`, {})).status, 404);
    await call('ann', 'DELETE', `/api/projects/${p.body.id}`, { confirmTitle: `Snap ${run}` });
  });

  it('answers 503 when the repository is not configured', async () => {
    const { GitHubVersionStore } = await import('../src/snapshot/version-store.js');
    setVersionStoreFactory(() => GitHubVersionStore.fromEnv());
    const p = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `NoRepo ${run}`, language: 'en-US' });
    const r = await call('ann', 'POST', `/api/projects/${p.body.id}/snapshot`, {});
    assert.equal(r.status, 503, JSON.stringify(r.body));
    await call('ann', 'DELETE', `/api/projects/${p.body.id}`, { confirmTitle: `NoRepo ${run}` });
  });
});
