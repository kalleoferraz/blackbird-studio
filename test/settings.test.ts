import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { withDb } from '../src/db/client.js';
import { createUser } from '../src/auth/accounts.js';
import { SNAPSHOT_REPO_TOKEN, decryptSecret, encryptSecret, getSetting, putSetting } from '../src/settings/settings.js';
import { setVersionStoreFactory } from '../src/server/snapshots.js';
import { GitHubVersionStore } from '../src/snapshot/version-store.js';

let app: FastifyInstance;
const run = Date.now().toString(36);
const cookies: Record<string, string> = {};
async function call(who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
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
  delete process.env.SNAPSHOT_REPO; delete process.env.SNAPSHOT_REPO_TOKEN; delete process.env.SNAPSHOT_BRANCH;
  await runMigrations();
  app = buildApp();
  await app.ready();
  process.env.ADMIN_EMAIL = `admin.set.${run}@t.test`;
  await withDb(async (db) => {
    await createUser(db, { email: process.env.ADMIN_EMAIL!, displayName: 'Admin', password: 'Test-password-123!', mustChangePassword: false });
    await createUser(db, { email: `ann.set.${run}@t.test`, displayName: 'ann', password: 'Test-password-123!', mustChangePassword: false });
  });
  await login('admin', process.env.ADMIN_EMAIL!);
  await login('ann', `ann.set.${run}@t.test`);
  await withDb((db) => putSetting(db, 'SNAPSHOT_REPO', null).then(() => putSetting(db, 'SNAPSHOT_BRANCH', null)).then(() => putSetting(db, SNAPSHOT_REPO_TOKEN, null)));
});
after(async () => { await withDb(async (db) => { await putSetting(db, 'SNAPSHOT_REPO', null); await putSetting(db, SNAPSHOT_REPO_TOKEN, null); }); await app.close(); });

describe('snapshot settings in the admin area', () => {
  it('encrypts a secret and refuses a damaged one', () => {
    const e = encryptSecret('ghp_secret');
    assert.ok(!e.includes('ghp_secret'));
    assert.equal(decryptSecret(e), 'ghp_secret');
    assert.equal(decryptSecret(e.slice(0, -3) + 'AAA'), null);
    assert.equal(decryptSecret('nonsense'), null);
  });

  it('is for the admin only, and starts empty', async () => {
    assert.equal((await call('ann', 'GET', '/api/admin/settings/snapshots')).status, 403);
    const r = await call('admin', 'GET', '/api/admin/settings/snapshots');
    assert.equal(r.status, 200);
    assert.equal(r.body.repo, null);
    assert.equal(r.body.tokenSet, false);
  });

  it('says what is missing when a snapshot is saved before it is set up', async () => {
    setVersionStoreFactory(() => GitHubVersionStore.fromSettings());
    const p = await call('ann', 'POST', '/api/projects', { type: 'audiobook', title: `Snap ${run}`, language: 'en-US' });
    const r = await call('ann', 'POST', `/api/projects/${p.body.id}/snapshot`, {});
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(r.body.message, /missing the repository and the token/);
    await call('ann', 'DELETE', `/api/projects/${p.body.id}`, { confirmTitle: `Snap ${run}` });
  });

  it('saves the repository and the token (the token is stored encrypted and never returned)', async () => {
    assert.equal((await call('admin', 'PUT', '/api/admin/settings/snapshots', { repo: 'https://github.com/x/y' })).status, 400);
    assert.equal((await call('admin', 'PUT', '/api/admin/settings/snapshots', { repo: 'kalleoferraz/media-projects', branch: 'main', token: 'github_pat_abc' })).status, 200);
    const r = await call('admin', 'GET', '/api/admin/settings/snapshots');
    assert.equal(r.body.repo, 'kalleoferraz/media-projects');
    assert.equal(r.body.branch, 'main');
    assert.equal(r.body.tokenSet, true);
    assert.ok(!JSON.stringify(r.body).includes('github_pat_abc'));
    assert.equal(r.body.source.token, 'app');
    const raw = await withDb((db) => getSetting(db, SNAPSHOT_REPO_TOKEN));
    assert.ok(raw && !raw.includes('github_pat_abc'));
    // leaving the token out keeps it
    await call('admin', 'PUT', '/api/admin/settings/snapshots', { repo: 'kalleoferraz/media-projects' });
    assert.equal((await call('admin', 'GET', '/api/admin/settings/snapshots')).body.tokenSet, true);
    // the store is built from them
    const store = await GitHubVersionStore.fromSettings();
    assert.ok(store);
  });

  it('falls back to the environment, and removes the saved token', async () => {
    assert.equal((await call('admin', 'PUT', '/api/admin/settings/snapshots', { clearToken: true, repo: '' })).status, 200);
    let r = (await call('admin', 'GET', '/api/admin/settings/snapshots')).body;
    assert.equal(r.tokenSet, false);
    assert.equal(r.repo, null);
    process.env.SNAPSHOT_REPO = 'env-owner/env-repo';
    process.env.SNAPSHOT_REPO_TOKEN = 'env-token';
    r = (await call('admin', 'GET', '/api/admin/settings/snapshots')).body;
    assert.equal(r.repo, 'env-owner/env-repo');
    assert.equal(r.source.repo, 'env');
    assert.equal(r.tokenSet, true);
    delete process.env.SNAPSHOT_REPO; delete process.env.SNAPSHOT_REPO_TOKEN;
  });

  it('a saved token that cannot be read is reported, not hidden', async () => {
    await withDb((db) => putSetting(db, SNAPSHOT_REPO_TOKEN, 'v1:AAAA:BBBB:CCCC'));
    const r = (await call('admin', 'GET', '/api/admin/settings/snapshots')).body;
    assert.equal(r.tokenSet, false);
    assert.equal(r.tokenUnreadable, true);
    const t = await call('admin', 'POST', '/api/admin/settings/snapshots/test', { repo: 'a/b' });
    assert.equal(t.body.ok, false);
    assert.match(t.body.message, /can no longer be read/);
  });
});
