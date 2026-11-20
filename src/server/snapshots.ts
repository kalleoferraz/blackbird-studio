import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { withDb } from '../db/client.js';
import { project, snapshot, user } from '../db/schema.js';
import { projectVoiceSettings, voiceConfig } from '../voice/settings.js';
import { ElevenLabs } from '../voice/elevenlabs.js';
import { saveSnapshot } from '../snapshot/save.js';
import { GitHubVersionStore, SnapshotsNotConfigured, type VersionStore } from '../snapshot/version-store.js';
import { accessTo, checkId } from './access.js';
import { authenticate } from './auth-routes.js';
import { HttpError, asBody, optString } from './http.js';

/** Tests replace the store; production builds the GitHub one from the environment. */
let storeFactory: () => VersionStore | Promise<VersionStore> = () => GitHubVersionStore.fromSettings();
export function setVersionStoreFactory(f: () => VersionStore | Promise<VersionStore>): void { storeFactory = f; }

export function registerSnapshotRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };

  app.post('/api/projects/:id/snapshot', { ...auth, bodyLimit: 2048 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const label = optString(asBody(request.body), 'label', 200, { allowNull: true });
    await withDb((db) => accessTo(db, request.account!.id, id, { edit: true }));
    let store: VersionStore;
    try { store = await storeFactory(); } catch (e) {
      if (e instanceof SnapshotsNotConfigured) throw new HttpError(503, 'snapshots_not_configured', e.message);
      throw e;
    }
    try {
      return await saveSnapshot(store, id, request.account!.id, label ?? null);
    } catch (e: any) {
      request.log.error(e);
      throw new HttpError(502, 'snapshot_failed', `The snapshot could not be saved: ${e?.message ?? 'unknown error'}`);
    }
  });

  app.get('/api/projects/:id/snapshots', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, id);
      const rows = await db
        .select({ id: snapshot.id, sha: snapshot.commitSha, revision: snapshot.revision, label: snapshot.label, createdAt: snapshot.createdAt, by: user.displayName })
        .from(snapshot).leftJoin(user, eq(user.id, snapshot.createdByUserId)).where(eq(snapshot.projectId, id)).orderBy(desc(snapshot.createdAt)).limit(50);
      return { snapshots: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
    });
  });

  /**
   * The Integrations dialog of the script: where this project's snapshots go (repository, branch, folder), its last
   * snapshot, the branch's newest commit and the changes not in a snapshot yet; and the ElevenLabs plan with its quotas.
   * Every member can read it; credentials never leave the server.
   */
  app.get('/api/projects/:id/integrations', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const { p, last } = await withDb(async (db) => {
      await accessTo(db, request.account!.id, id);
      const p = (await db.select({ repoFolder: project.repoFolder, title: project.title, dirtySince: project.dirtySince, revision: project.revision, lastEditedAt: project.lastEditedAt })
        .from(project).where(eq(project.id, id)).limit(1))[0]!;
      const last = (await db.select({ sha: snapshot.commitSha, revision: snapshot.revision, label: snapshot.label, createdAt: snapshot.createdAt, by: user.displayName })
        .from(snapshot).leftJoin(user, eq(user.id, snapshot.createdByUserId)).where(eq(snapshot.projectId, id)).orderBy(desc(snapshot.createdAt)).limit(1))[0] ?? null;
      return { p, last };
    });
    const github = await (async () => {
      const base = {
        folder: p.repoFolder, dirtySince: p.dirtySince?.toISOString() ?? null, revision: Number(p.revision), lastEditedAt: p.lastEditedAt?.toISOString() ?? null,
        lastSnapshot: last ? { sha: last.sha, revision: Number(last.revision), label: last.label, at: last.createdAt.toISOString(), by: last.by } : null,
      };
      let store: GitHubVersionStore;
      try { store = await GitHubVersionStore.fromSettings(); } catch (e) { return { configured: false, reason: (e as Error).message, ...base }; }
      const where = store.where;
      const commitUrl = (sha: string) => `https://github.com/${where.repo}/commit/${sha}`;
      const folderUrl = (branch: string) => (p.repoFolder ? `https://github.com/${where.repo}/tree/${encodeURIComponent(branch)}/${encodeURIComponent(p.repoFolder)}` : null);
      try {
        const head = await store.head();
        return { configured: true, repo: where.repo, branch: head.branch, folderUrl: folderUrl(head.branch), head, ...base,
          lastSnapshot: base.lastSnapshot ? { ...base.lastSnapshot, url: commitUrl(base.lastSnapshot.sha) } : null };
      } catch (e: any) {
        return { configured: true, repo: where.repo, branch: where.branch, folderUrl: where.branch ? folderUrl(where.branch) : null, head: null,
          headError: e?.status === 401 ? 'GitHub does not accept the token.' : `GitHub answered: ${e?.message ?? 'an error'}`, ...base,
          lastSnapshot: base.lastSnapshot ? { ...base.lastSnapshot, url: commitUrl(base.lastSnapshot.sha) } : null };
      }
    })();
    const elevenlabs = await (async () => {
      const c = await voiceConfig();
      const ps = await projectVoiceSettings(id);
      if (!c.key) return { configured: false, ...ps, reason: c.keyUnreadable ? 'The saved API key can no longer be read; the admin must enter it again.' : 'No API key is set in the admin area.' };
      try {
        return { configured: true, ...ps, plan: await new ElevenLabs(c.apiUrl, c.key).subscription() };
      } catch (e) {
        return { configured: true, ...ps, plan: null, planError: (e as Error).message };
      }
    })();
    return { github, elevenlabs };
  });
}
