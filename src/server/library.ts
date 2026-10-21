import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, count, eq, inArray } from 'drizzle-orm';
import { withDb, type Q } from '../db/client.js';
import { asset, character, clip, note, project } from '../db/schema.js';
import { clearCover, uploadCover, useEarlierCover, EARLIER_COVER } from '../library/covers.js';
import {
  MAX_PICTURE, MAX_UPLOAD, assetsUnder, checkFolder, cleanFileName, findByHash, join, removeFiles, sha256, splitName, storeFile,
  type AssetRow,
} from '../library/files.js';
import { blobStore, cleanPath, PATH_MAX } from '../storage/blob-store.js';
import { CHARACTERS, MANAGED_ROOTS, isCharactersRoot, isStoryline, pictureFolder } from '../library/managed.js';
import { accessTo, accessToEntity, checkId } from './access.js';
import { authenticate } from './auth-routes.js';
import { HttpError, asBody, badRequest } from './http.js';

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  json: 'application/json', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'application/pdf', 'text/plain; charset=utf-8', 'video/mp4', 'video/webm']);

export function assetView(a: AssetRow, usage?: string[]) {
  const info = (a.mediaInfo ?? {}) as { width?: number; height?: number; format?: string };
  return {
    id: a.id,
    name: a.path.slice(a.path.lastIndexOf('/') + 1),
    path: a.path,
    kind: a.mediaKind,
    size: a.size,
    sizeLightweight: a.sizeLightweight,
    hasLightweight: a.lightweightPath !== null,
    width: info.width ?? null,
    height: info.height ?? null,
    fileState: a.fileState,
    earlierCover: EARLIER_COVER.test(a.path),
    createdAt: a.createdAt.toISOString(),
    ...(usage ? { usage } : {}),
  };
}

/** Where assets are used: cover, character pictures, clips, notes (the library refuses to delete these). */
async function usageOf(q: Q, projectId: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const add = (id: string | null, text: string) => {
    if (!id) return;
    out.set(id, [...(out.get(id) ?? []), text]);
  };
  const p = (await q.select({ cover: project.coverAssetId }).from(project).where(eq(project.id, projectId)).limit(1))[0];
  if (p?.cover && ids.includes(p.cover)) add(p.cover, 'the cover');
  const chars = await q.select({ id: character.pictureAssetId, name: character.name }).from(character).where(and(eq(character.projectId, projectId), inArray(character.pictureAssetId, ids)));
  for (const c of chars) add(c.id, `the picture of ${c.name}`);
  const clips = await q.select({ id: clip.assetId, n: count() }).from(clip).where(inArray(clip.assetId, ids)).groupBy(clip.assetId);
  for (const c of clips) add(c.id, `${Number(c.n)} clip${Number(c.n) === 1 ? '' : 's'}`);
  const notes = await q.select({ id: note.assetId }).from(note).where(and(eq(note.projectId, projectId), inArray(note.assetId, ids)));
  for (const n of notes) add(n.id, 'a note');
  return out;
}

async function characterFolders(q: Q, projectId: string): Promise<string[]> {
  return (await q.select({ f: character.folder }).from(character).where(eq(character.projectId, projectId))).map((r) => r.f);
}

const lower = (s: string) => s.toLowerCase();

/** Folders the app manages: nothing can be uploaded to, created in or removed from Storyline or the Characters root. */
function lockedForWrite(folder: string): boolean {
  return isStoryline(folder) || isCharactersRoot(folder);
}
function lockedForDelete(folder: string, characterDirs: string[]): boolean {
  if (isStoryline(folder) || isCharactersRoot(folder)) return true;
  const parts = lower(folder).split('/');
  return parts[0] === lower(CHARACTERS) && parts.length === 2 && characterDirs.some((c) => lower(c) === parts[1]);
}

function rawBody(request: FastifyRequest): Buffer {
  const b = request.body;
  if (!Buffer.isBuffer(b)) throw badRequest('invalid_body', 'Send the file as the request body (application/octet-stream).');
  return b;
}

function queryString(request: FastifyRequest, key: string): string {
  const v = (request.query as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'bad' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? 'bad' : { start, end };
}

async function sendFile(request: FastifyRequest, reply: FastifyReply, a: AssetRow, variant: 'original' | 'light', download: boolean) {
  const useLight = variant === 'light' && a.lightweightPath !== null;
  const rel = useLight ? a.lightweightPath! : a.path;
  const size = await blobStore().size(a.projectId, rel);
  if (size === null) throw new HttpError(404, 'file_missing', 'The file is missing from the library.');
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const type = CONTENT_TYPES[splitName(name).ext.slice(1).toLowerCase()] ?? 'application/octet-stream';
  const range = parseRange(request.headers.range, size);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', type);
  reply.header('ETag', `"${a.hash.slice(0, 16)}${useLight ? '-l' : ''}"`);
  reply.header('Cache-Control', 'private, max-age=86400');
  reply.header('X-Content-Type-Options', 'nosniff');
  // SVG can carry script: it may only be shown as an image, never as a page.
  reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  const inline = INLINE.has(type) && !download;
  reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (request.headers['if-none-match'] === `"${a.hash.slice(0, 16)}${useLight ? '-l' : ''}"`) return reply.code(304).send();
  if (range === 'bad') {
    reply.header('Content-Range', `bytes */${size}`);
    return reply.code(416).send();
  }
  if (range) {
    reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`).header('Content-Length', range.end - range.start + 1);
    return reply.send(blobStore().read(a.projectId, rel, range));
  }
  reply.header('Content-Length', size);
  return reply.send(blobStore().read(a.projectId, rel));
}

export function registerLibraryRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };
  // Uploads are authenticated before the body is read (onRequest), so a stranger cannot make the server buffer 100 MB.
  const upload = (limit: number) => ({ onRequest: authenticate(), bodyLimit: limit });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // ---- browsing ----------------------------------------------------------------------

  app.get('/api/projects/:id/library', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const folder = checkFolder(queryString(request, 'folder'));
    return withDb(async (db) => {
      const access = await accessTo(db, request.account!.id, projectId);
      const charDirs = await characterFolders(db, projectId);
      const rows = await assetsUnder(db, projectId, folder);
      const prefix = folder ? folder + '/' : '';
      const here = rows.filter((a) => !a.path.slice(prefix.length).includes('/'));
      const names = new Map<string, string>(); // lower case -> shown
      const addFolder = (n: string) => {
        if (!names.has(lower(n))) names.set(lower(n), n);
      };
      for (const a of rows) {
        const rest = a.path.slice(prefix.length);
        const i = rest.indexOf('/');
        if (i > 0) addFolder(rest.slice(0, i));
      }
      for (const d of await blobStore().listDirs(projectId, folder)) addFolder(d);
      if (!folder) {
        // The managed folders are named first, so their spelling wins over any older one on disk or in the rows.
        MANAGED_ROOTS.forEach((n) => names.set(lower(n), n));
      }
      if (isCharactersRoot(folder)) charDirs.forEach(addFolder);
      const usage = await usageOf(db, projectId, here.map((a) => a.id));
      const folders = [...names.values()]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .map((name) => {
          const path = join(folder, name);
          return { name, path, managed: lockedForDelete(path, charDirs), writable: access.canEdit && !lockedForWrite(path) };
        });
      const files = here
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
        .map((a) => assetView(a, usage.get(a.id)));
      return { folder, canEdit: access.canEdit, writable: access.canEdit && !lockedForWrite(folder), folders, files };
    });
  });

  app.post('/api/projects/:id/library/folders', { ...auth, bodyLimit: 2048 }, async (request, reply) => {
    const projectId = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const parent = checkFolder(body.parent ?? '');
    const name = cleanFileName(typeof body.name === 'string' ? body.name : '');
    if (lockedForWrite(parent)) throw new HttpError(400, 'managed_folder', 'This folder is managed by the app.');
    const path = join(parent, name);
    if (cleanPath(path) === null || path.length > PATH_MAX) throw new HttpError(400, 'invalid_name', 'That folder name cannot be used.');
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      const siblings = await blobStore().listDirs(projectId, parent);
      const rows = await assetsUnder(db, projectId, parent);
      const taken = new Set([...siblings, ...rows.map((a) => a.path.slice(parent ? parent.length + 1 : 0).split('/')[0]!)].map(lower));
      if (!parent) {
        MANAGED_ROOTS.forEach((n) => taken.add(lower(n)));
      }
      if (taken.has(lower(name))) throw new HttpError(409, 'name_taken', 'A file or folder with that name already exists here.');
      await blobStore().mkdir(projectId, path);
      return reply.code(201).send({ name, path });
    });
  });

  app.delete('/api/projects/:id/library/folders', { ...auth, bodyLimit: 2048 }, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const folder = checkFolder(queryString(request, 'path'));
    const recursive = queryString(request, 'recursive') === '1';
    if (!folder) throw badRequest('invalid_folder');
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      if (lockedForDelete(folder, await characterFolders(db, projectId))) {
        throw new HttpError(400, 'managed_folder', 'This folder is managed by the app and cannot be removed.');
      }
      const rows = await assetsUnder(db, projectId, folder);
      const subdirs = (await blobStore().listDirs(projectId, folder)).length;
      if (!recursive && (rows.length > 0 || subdirs > 0)) {
        throw new HttpError(409, 'not_empty', 'The folder is not empty.', { files: rows.length, folders: subdirs });
      }
      const usage = await usageOf(db, projectId, rows.map((a) => a.id));
      if (usage.size > 0) {
        const first = rows.find((a) => usage.has(a.id))!;
        throw new HttpError(409, 'in_use', `${first.path.slice(first.path.lastIndexOf('/') + 1)} is used by ${usage.get(first.id)!.join(', ')}.`, { files: usage.size });
      }
      if (rows.length > 0) await db.delete(asset).where(inArray(asset.id, rows.map((a) => a.id)));
      await blobStore().removeDir(projectId, folder);
      return { ok: true, removedFiles: rows.length };
    });
  });

  app.patch('/api/projects/:id/library/folders', { ...auth, bodyLimit: 2048 }, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const from = checkFolder(body.path ?? '');
    const name = cleanFileName(typeof body.name === 'string' ? body.name : '');
    if (!from) throw badRequest('invalid_folder');
    const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const to = join(parent, name);
    if (cleanPath(to) === null || to.length > PATH_MAX) throw new HttpError(400, 'invalid_name', 'That folder name cannot be used.');
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      if (lockedForDelete(from, await characterFolders(db, projectId))) {
        throw new HttpError(400, 'managed_folder', 'This folder is managed by the app and cannot be renamed.');
      }
      if (from === to) return { path: to };
      const siblings = await blobStore().listDirs(projectId, parent);
      const rows = await assetsUnder(db, projectId, parent);
      const taken = new Set([...siblings, ...rows.map((a) => a.path.slice(parent ? parent.length + 1 : 0).split('/')[0]!)].map(lower));
      if (!parent) {
        MANAGED_ROOTS.forEach((n) => taken.add(lower(n)));
      }
      taken.delete(lower(from.slice(parent ? parent.length + 1 : 0)));
      if (taken.has(lower(name))) throw new HttpError(409, 'name_taken', 'A file or folder with that name already exists here.');
      const inside = await assetsUnder(db, projectId, from);
      for (const a of inside) {
        if (a.path.length - from.length + to.length > PATH_MAX) throw new HttpError(400, 'path_too_long', 'The new name makes some paths too long.');
      }
      // A case-only change is two renames, because the disk may treat both spellings as one name.
      const blobs = blobStore();
      if (lower(from) === lower(to)) {
        await blobs.rename(projectId, from, `${from}.renaming`);
        await blobs.rename(projectId, `${from}.renaming`, to);
      } else {
        await blobs.mkdir(projectId, from);
        await blobs.rename(projectId, from, to);
      }
      try {
        for (const a of inside) {
          await db
            .update(asset)
            .set({
              path: to + a.path.slice(from.length),
              lightweightPath: a.lightweightPath ? to + a.lightweightPath.slice(from.length) : null,
              updatedAt: new Date(),
            })
            .where(eq(asset.id, a.id));
        }
      } catch (e) {
        await blobs.rename(projectId, to, from).catch(() => undefined);
        throw e;
      }
      return { path: to };
    });
  });

  // ---- files -------------------------------------------------------------------------

  app.post('/api/projects/:id/library/files', upload(MAX_UPLOAD + 4096), async (request, reply) => {
    const projectId = checkId((request.params as { id: string }).id);
    const folder = checkFolder(queryString(request, 'folder'));
    const name = queryString(request, 'name');
    const data = rawBody(request);
    if (lockedForWrite(folder)) throw new HttpError(400, 'managed_folder', 'Files cannot be added to this folder.');
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      const stored = await storeFile(db, { projectId, folder, name: cleanFileName(name), data, maxBytes: MAX_UPLOAD });
      if (stored.duplicate) {
        throw new HttpError(409, 'already_in_library', `This file is already in the library at ${stored.asset.path}.`, { assetId: stored.asset.id, path: stored.asset.path });
      }
      return reply.code(201).send(assetView(stored.asset));
    });
  });

  app.delete('/api/assets/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      const a = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!a) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, a.projectId, { edit: true });
      const usage = (await usageOf(db, a.projectId, [id])).get(id);
      if (usage) throw new HttpError(409, 'in_use', `Used by ${usage.join(', ')}.`, { usage });
      await db.delete(asset).where(eq(asset.id, id));
      await removeFiles(a);
      return { ok: true };
    });
  });

  app.get('/api/assets/:id/file', auth, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const q = request.query as Record<string, string>;
    const a = await withDb(async (db) => {
      const row = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!row) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, row.projectId);
      return row;
    });
    return sendFile(request, reply, a, q.variant === 'light' ? 'light' : 'original', q.download === '1');
  });

  // ---- cover -------------------------------------------------------------------------

  app.put('/api/projects/:id/cover', upload(MAX_PICTURE + 4096), async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const data = rawBody(request);
    const name = queryString(request, 'name') || 'cover';
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      const r = await uploadCover(db, projectId, name, data);
      return { coverAssetId: r.asset.id, changed: r.status === 'set', previous: r.status === 'set' ? r.previous : null };
    });
  });

  app.post('/api/projects/:id/cover/use', { ...auth, bodyLimit: 1024 }, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const assetId = checkId(asBody(request.body).assetId);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      const a = await useEarlierCover(db, projectId, assetId);
      return { coverAssetId: a.id };
    });
  });

  app.delete('/api/projects/:id/cover', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      await clearCover(db, projectId);
      return { ok: true };
    });
  });

  // ---- character pictures --------------------------------------------------------------

  app.put('/api/characters/:id/picture', upload(MAX_PICTURE + 4096), async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const data = rawBody(request);
    const name = queryString(request, 'name') || 'picture';
    return withDb(async (db) => {
      const access = await accessToEntity(db, request.account!.id, 'character', id, { edit: true });
      const c = (await db.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
      const dup = await findByHash(db, access.projectId, sha256(data));
      let assetId: string;
      if (dup) {
        if (dup.mediaKind !== 'image') throw new HttpError(409, 'already_in_library', `This file is already in the library at ${dup.path}.`, { path: dup.path });
        assetId = dup.id; // the same image is simply used again
      } else {
        const stored = await storeFile(db, {
          projectId: access.projectId, folder: pictureFolder(c.folder), name: cleanFileName(name), data, only: ['image'], maxBytes: MAX_PICTURE,
        });
        assetId = stored.asset.id;
      }
      await db.update(character).set({ pictureAssetId: assetId, updatedAt: new Date() }).where(eq(character.id, id));
      return { pictureAssetId: assetId };
    });
  });

  app.delete('/api/characters/:id/picture', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      const access = await accessToEntity(db, request.account!.id, 'character', id, { edit: true });
      await db.update(character).set({ pictureAssetId: null, updatedAt: new Date() }).where(eq(character.id, id));
      return { ok: true };
    });
  });
}

