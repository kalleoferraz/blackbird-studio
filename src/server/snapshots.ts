import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { withDb } from '../db/client.js';
import { snapshot, user } from '../db/schema.js';
import { saveSnapshot } from '../snapshot/save.js';
import { GitHubVersionStore, SnapshotsNotConfigured, type VersionStore } from '../snapshot/version-store.js';
import { accessTo, checkId } from './access.js';
import { authenticate } from './auth-routes.js';
import { HttpError, asBody, optString } from './http.js';

/** Tests replace the store; production builds the GitHub one from the environment. */
let storeFactory: () => VersionStore = () => GitHubVersionStore.fromEnv();
export function setVersionStoreFactory(f: () => VersionStore): void { storeFactory = f; }

export function registerSnapshotRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };

  app.post('/api/projects/:id/snapshot', { ...auth, bodyLimit: 2048 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const label = optString(asBody(request.body), 'label', 200, { allowNull: true });
    await withDb((db) => accessTo(db, request.account!.id, id, { edit: true }));
    let store: VersionStore;
    try { store = storeFactory(); } catch (e) {
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
}
