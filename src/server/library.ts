import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, count, eq, inArray, ne, or } from 'drizzle-orm';
import { withDb, type Q } from '../db/client.js';
import { asset, assetPeaks, chapter, character, clip, cue, note, project, scene, segment } from '../db/schema.js';
import { clearCover, uploadCover, useEarlierCover, EARLIER_COVER } from '../library/covers.js';
import {
  MAX_PICTURE, MAX_UPLOAD, assetsUnder, checkFolder, cleanFileName, findByHash, extensionOf, freeName, join, moveAsset, removeFiles, renameDerived, replaceFile, sha256, splitName, storeFile,
  type AssetRow,
} from '../library/files.js';
import { kickAudioJobs, retryAudio } from '../audio/jobs.js';
import { blobStore, cleanPath, PATH_MAX } from '../storage/blob-store.js';
import { CHARACTERS, MANAGED_ROOTS, isCharactersRoot, isStoryline, pictureFolder } from '../library/managed.js';
import { touchProject } from '../db/touch.js';
import { addFitTasks } from './replaced.js';
import { accessTo, accessToEntity, checkId } from './access.js';
import { authenticate } from './auth-routes.js';
import { HttpError, asBody, badRequest } from './http.js';

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  wav: 'audio/wav', mp3: 'audio/mpeg', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  json: 'application/json', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const INLINE = new Set(['audio/wav', 'audio/mpeg', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'application/pdf', 'text/plain; charset=utf-8', 'video/mp4', 'video/webm']);

export function assetView(a: AssetRow, usage?: string[]) {
  const info = (a.mediaInfo ?? {}) as { width?: number; height?: number; format?: string; durationMs?: number; sampleRate?: number; channels?: number };
  return {
    id: a.id,
    name: a.path.slice(a.path.lastIndexOf('/') + 1),
    path: a.path,
    kind: a.mediaKind,
    size: a.size,
    sizeLightweight: a.sizeLightweight,
    hasLightweight: a.lightweightPath !== null && a.sizeLightweight !== null, // an audio playback copy exists only once it is ready
    width: info.width ?? null,
    height: info.height ?? null,
    status: a.status,
    hasPeaks: a.mediaKind === 'audio' && a.status === 'ready',
    error: a.status === 'failed' ? a.error : null,
    format: info.format ?? null,
    durationMs: info.durationMs ?? null,
    sampleRate: info.sampleRate ?? null,
    channels: info.channels ?? null,
    fileState: a.fileState,
    earlierCover: EARLIER_COVER.test(a.path),
    createdAt: a.createdAt.toISOString(),
    ...(usage ? { usage } : {}),
  };
}

/** Where assets are used: cover, character pictures, clips, notes (the library refuses to delete these). */
export async function usageOf(q: Q, projectId: string, ids: string[]): Promise<Map<string, string[]>> {
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
  // A clip holds its file, except a take under Storyline that its cue does not play: that one is only an alternative
  // and goes with the file when the file is deleted (Bible: only unused alternatives can be deleted by hand).
  const clips = await q
    .select({ id: clip.id, assetId: clip.assetId, path: asset.path, chosen: cue.clipId })
    .from(clip)
    .innerJoin(asset, eq(asset.id, clip.assetId))
    .innerJoin(cue, eq(cue.id, clip.cueId))
    .where(inArray(clip.assetId, ids));
  const holding = new Map<string, number>();
  for (const c of clips) {
    if (isStoryline(c.path) && c.chosen !== c.id) continue;
    holding.set(c.assetId, (holding.get(c.assetId) ?? 0) + 1);
  }
  for (const [id, n] of holding) add(id, n === 1 ? 'a cue that plays it' : `${n} clips`);
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
  if (variant === 'light' && a.mediaKind === 'audio' && a.lightweightPath !== null && a.status !== 'ready') {
    throw new HttpError(409, a.status === 'failed' ? 'encoding_failed' : 'not_ready', a.status === 'failed' ? 'The playback copy could not be made.' : 'The playback copy is still being made.');
  }
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

  /** The project's audio files that are ready to be used in a cue (the picker's list). */
  app.get('/api/projects/:id/audio', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId);
      const rows = await db
        .select()
        .from(asset)
        .where(and(eq(asset.projectId, projectId), eq(asset.mediaKind, 'audio'), eq(asset.status, 'ready')));
      rows.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
      return { files: rows.map((a) => assetView(a)) };
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
      if (rows.length > 0) {
        await db.delete(clip).where(inArray(clip.assetId, rows.map((a) => a.id)));
        await db.delete(asset).where(inArray(asset.id, rows.map((a) => a.id)));
      }
      await blobStore().removeDir(projectId, folder);
      if (rows.length > 0) await touchProject(db, projectId, request.account!.id);
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
      if (inside.length > 0) await touchProject(db, projectId, request.account!.id);
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
      await touchProject(db, projectId, request.account!.id);
      if (stored.asset.status === 'pending') kickAudioJobs(request.log);
      return reply.code(201).send(assetView(stored.asset));
    });
  });

  // Does every file the project lists exist on disk? Asked once when the Library first opens. A file that is gone is
  // flagged `missing` (red mark in the Library); one that is back is `ok` again. Only the files are looked at: the
  // MP3 or reduced copy counts only once it has been made (its size is known).
  app.post('/api/projects/:id/library/verify', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId);
      const rows = await db.select().from(asset).where(eq(asset.projectId, projectId));
      const store = blobStore();
      let missing = 0;
      let changed = 0;
      for (let i = 0; i < rows.length; i += 32) {
        await Promise.all(rows.slice(i, i + 32).map(async (a) => {
          const masterThere = (await store.size(projectId, a.path)) !== null;
          const derivedThere = a.lightweightPath === null || a.sizeLightweight === null || (await store.size(projectId, a.lightweightPath)) !== null;
          const next = !masterThere || !derivedThere ? 'missing' : a.fileState === 'missing' ? 'ok' : a.fileState;
          if (next === 'missing') missing++;
          if (next !== a.fileState) {
            changed++;
            await db.update(asset).set({ fileState: next, updatedAt: new Date() }).where(eq(asset.id, a.id));
          }
        }));
      }
      return { checked: rows.length, missing, changed };
    });
  });

  // A new file for an existing asset (a missing one put back, or another take of the same sound). Cues keep their
  // clips; the waveform is made again, and a cue that plays a different recording gets a task to listen again.
  app.post('/api/assets/:id/replace', upload(MAX_UPLOAD + 4096), async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const data = rawBody(request);
    const result = await withDb(async (db) => {
      const row = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!row) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, row.projectId, { edit: true });
      const r = await replaceFile(db, row, data);
      await touchProject(db, row.projectId, request.account!.id);
      return r;
    });
    // Re-uploading is always worth a listen, even when the recording turns out to be the same one as before.
    const tasks = await addFitTasks(request.account!.id, result.asset);
    if (result.asset.status === 'pending') kickAudioJobs(request.log);
    return { ...assetView(result.asset), tasks };
  });

  app.delete('/api/assets/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      const a = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!a) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, a.projectId, { edit: true });
      const usage = (await usageOf(db, a.projectId, [id])).get(id);
      if (usage) throw new HttpError(409, 'in_use', `Used by ${usage.join(', ')}.`, { usage });
      await db.delete(clip).where(eq(clip.assetId, id)); // only alternatives can be left (see usageOf)
      await db.delete(asset).where(eq(asset.id, id));
      await removeFiles(a);
      await touchProject(db, a.projectId, request.account!.id);
      return { ok: true };
    });
  });

  // Moves one file to another folder (drag and drop in the Library). The file keeps its id, so clips, notes and
  // pictures that use it are untouched. A name already taken in the target gets a number, as with uploads.
  app.post('/api/assets/:id/move', { ...auth, bodyLimit: 2048 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const to = checkFolder(asBody(request.body).folder ?? '');
    return withDb(async (db) => {
      const a = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!a) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, a.projectId, { edit: true });
      const from = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : '';
      if (lockedForWrite(from)) {
        throw new HttpError(400, 'managed_folder', 'Files in a folder managed by the app cannot be moved.');
      }
      if (lockedForWrite(to)) throw new HttpError(400, 'managed_folder', 'Files cannot be moved into a folder managed by the app.');
      if (lower(from) === lower(to)) return assetView(a);
      const oldLight = a.lightweightPath ? a.lightweightPath.slice(a.lightweightPath.lastIndexOf('/') + 1) : '';
      const name = await freeName(db, a.projectId, to, a.path.slice(a.path.lastIndexOf('/') + 1), (n) => (a.lightweightPath ? renameDerived(oldLight, join('', n), a.mediaKind) : null));
      await moveAsset(db, a, join(to, name));
      await touchProject(db, a.projectId, request.account!.id);
      const fresh = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0]!;
      return assetView(fresh);
    });
  });

  // Renames one file (its context menu). Clips, notes and pictures keep pointing at it; the MP3 or reduced copy is renamed too.
  app.patch('/api/assets/:id', { ...auth, bodyLimit: 2048 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    let name = cleanFileName(typeof body.name === 'string' ? body.name : '');
    return withDb(async (db) => {
      const a = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!a) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, a.projectId, { edit: true });
      const dir = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : '';
      const old = a.path.slice(a.path.lastIndexOf('/') + 1);
      if (isStoryline(dir)) throw new HttpError(400, 'managed_folder', 'Files in Storyline are named by the app.');
      const usage = (await usageOf(db, a.projectId, [id])).get(id) ?? [];
      if (usage.some((u) => u === 'the cover' || u.startsWith('the picture of '))) {
        throw new HttpError(400, 'managed_file', 'This file is a cover or a character picture and keeps its name.');
      }
      // The extension is the file's kind: it stays, whatever is typed.
      const ext = extensionOf(old);
      if (ext && extensionOf(name) !== ext) name = (extensionOf(name) ? name.slice(0, name.lastIndexOf('.')) : name) + old.slice(old.lastIndexOf('.'));
      name = cleanFileName(name);
      if (name === old) return assetView(a);
      const to = join(dir, name);
      const oldLight = a.lightweightPath ? a.lightweightPath.slice(a.lightweightPath.lastIndexOf('/') + 1) : '';
      const toLight = a.lightweightPath ? join(dir, renameDerived(oldLight, to, a.mediaKind)) : null;
      if (to.length > PATH_MAX || (toLight && toLight.length > PATH_MAX)) throw new HttpError(400, 'path_too_long', 'The name makes the path too long.');
      const wanted = [to, ...(toLight ? [toLight] : [])];
      const clash = await db
        .select({ id: asset.id })
        .from(asset)
        .where(and(eq(asset.projectId, a.projectId), ne(asset.id, id), or(inArray(asset.path, wanted), inArray(asset.lightweightPath, wanted))))
        .limit(1);
      if (clash.length > 0) throw new HttpError(409, 'name_taken', 'A file with that name already exists in this folder.');
      await moveAsset(db, a, to);
      await touchProject(db, a.projectId, request.account!.id);
      return assetView((await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0]!);
    });
  });

  // The cues that play a file, with their place in the story, for the file's preview.
  app.get('/api/assets/:id/cues', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      const a = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!a) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, a.projectId);
      const rows = await db
        .select({
          clipId: clip.id, cueId: cue.id, chosen: cue.clipId, text: cue.textMd, startMs: cue.startMs,
          sceneId: scene.id, sceneNo: scene.position, segmentId: segment.id, segment: segment.title, chapterId: chapter.id, chapter: chapter.title,
          chapterPos: chapter.position, segmentPos: segment.position,
        })
        .from(clip)
        .innerJoin(cue, eq(cue.id, clip.cueId))
        .innerJoin(scene, eq(scene.id, cue.sceneId))
        .innerJoin(segment, eq(segment.id, scene.segmentId))
        .innerJoin(chapter, eq(chapter.id, segment.chapterId))
        .where(eq(clip.assetId, id));
      rows.sort((x, y) => x.chapterPos - y.chapterPos || x.segmentPos - y.segmentPos || x.sceneNo - y.sceneNo || x.startMs - y.startMs);
      const seen = new Set<string>();
      const cues = [];
      for (const r of rows) {
        if (seen.has(r.cueId)) continue;
        seen.add(r.cueId);
        cues.push({
          cueId: r.cueId, sceneId: r.sceneId, sceneNo: r.sceneNo, segmentId: r.segmentId, segment: r.segment, chapterId: r.chapterId, chapter: r.chapter,
          text: r.text.replace(/\s+/g, ' ').trim().slice(0, 80), chosen: r.chosen === r.clipId,
        });
      }
      return { cues };
    });
  });

  app.get('/api/assets/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      const row = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!row) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, row.projectId);
      return assetView(row, (await usageOf(db, row.projectId, [id])).get(id));
    });
  });

  // A failed playback copy goes back in the queue; the WAV master is kept, so this is always possible.
  app.post('/api/assets/:id/retry', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      const row = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!row) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, row.projectId, { edit: true });
      if (!(await retryAudio(id))) throw new HttpError(409, 'not_failed', 'Only an asset whose playback copy failed can be retried.');
      kickAudioJobs(request.log);
      return { ok: true };
    });
  });

  // The waveform: one byte per `stepMs`, loudest sample of the window on a decibel scale (see src/audio/peaks.ts).
  app.get('/api/assets/:id/peaks', auth, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const found = await withDb(async (db) => {
      const row = (await db.select().from(asset).where(eq(asset.id, id)).limit(1))[0];
      if (!row) throw new HttpError(404, 'not_found');
      await accessTo(db, request.account!.id, row.projectId);
      if (row.mediaKind !== 'audio') throw new HttpError(404, 'no_peaks', 'Only audio has a waveform.');
      if (row.status !== 'ready') throw new HttpError(409, row.status === 'failed' ? 'processing_failed' : 'not_ready', row.status === 'failed' ? 'The audio could not be processed.' : 'The waveform is still being made.');
      const p = (await db.select().from(assetPeaks).where(eq(assetPeaks.assetId, id)).limit(1))[0];
      if (!p) throw new HttpError(404, 'no_peaks', 'This file has no waveform yet.');
      return { hash: row.hash, stepMs: p.stepMs, data: p.data };
    });
    const etag = `"${found.hash.slice(0, 16)}-p${found.stepMs}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=86400').header('X-Peaks-Step-Ms', String(found.stepMs)).header('X-Peaks-Floor-Db', '60');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/octet-stream').send(found.data);
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
      if (r.status === 'set') await touchProject(db, projectId, request.account!.id);
      return { coverAssetId: r.asset.id, changed: r.status === 'set', previous: r.status === 'set' ? r.previous : null };
    });
  });

  app.post('/api/projects/:id/cover/use', { ...auth, bodyLimit: 1024 }, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const assetId = checkId(asBody(request.body).assetId);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      const a = await useEarlierCover(db, projectId, assetId);
      await touchProject(db, projectId, request.account!.id);
      return { coverAssetId: a.id };
    });
  });

  // ---- character placeholder: Characters/profile_placeholder.<ext>, shown faded for characters without a picture -----

  app.put('/api/projects/:id/character-placeholder', upload(MAX_PICTURE + 4096), async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const data = rawBody(request);
    const { ext } = splitName(cleanFileName(queryString(request, 'name') || 'profile_placeholder'));
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      const stem = 'profile_placeholder';
      const old = (await assetsUnder(db, projectId, CHARACTERS)).filter((a) => {
        const rest = a.path.slice(CHARACTERS.length + 1);
        return !rest.includes('/') && splitName(rest).base.toLowerCase() === stem;
      });
      const dup = await findByHash(db, projectId, sha256(data));
      if (dup && old.some((o) => o.id === dup.id)) return { assetId: dup.id, changed: false };
      if (dup) throw new HttpError(409, 'already_in_library', `This image is already in the library at ${dup.path}. Rename or move it to Characters/${stem}${splitName(dup.path).ext} yourself, or choose another image.`, { path: dup.path });
      for (const o of old) { await db.delete(asset).where(eq(asset.id, o.id)); await removeFiles(o); }
      const stored = await storeFile(db, { projectId, folder: CHARACTERS, name: stem + ext, data, only: ['image'], maxBytes: MAX_PICTURE, exactName: true });
      await touchProject(db, projectId, request.account!.id);
      return { assetId: stored.asset.id, changed: true };
    });
  });

  app.delete('/api/projects/:id/cover', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      await clearCover(db, projectId);
      await touchProject(db, projectId, request.account!.id);
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
      const dir = pictureFolder(c.folder);
      // The picture is the file `Profile.<ext>` in the character's own folder; a new picture replaces the earlier profile file.
      const earlier = (await assetsUnder(db, access.projectId, dir)).filter((a) => {
        const rest = a.path.slice(dir.length + 1);
        return !rest.includes('/') && splitName(rest).base.toLowerCase() === 'profile';
      });
      const dup = await findByHash(db, access.projectId, sha256(data));
      let assetId: string;
      if (dup) {
        if (dup.mediaKind !== 'image') throw new HttpError(409, 'already_in_library', `This file is already in the library at ${dup.path}.`, { path: dup.path });
        assetId = dup.id; // the same image is simply used again
      } else {
        for (const e of earlier) {
          const others = ((await usageOf(db, access.projectId, [e.id])).get(e.id) ?? []).filter((u) => u !== `the picture of ${c.name}`);
          if (others.length) throw new HttpError(409, 'in_use', `The file ${e.path} is also used by ${others.join(', ')}.`);
        }
        if (earlier.length) {
          await db.update(character).set({ pictureAssetId: null }).where(eq(character.id, id)); // the picture points at the file with a restricting reference
          for (const e of earlier) { await db.delete(asset).where(eq(asset.id, e.id)); await removeFiles(e); }
        }
        const stored = await storeFile(db, {
          projectId: access.projectId, folder: dir, name: 'Profile' + splitName(cleanFileName(name)).ext, data, only: ['image'], maxBytes: MAX_PICTURE, exactName: true,
        });
        assetId = stored.asset.id;
      }
      await db.update(character).set({ pictureAssetId: assetId, updatedAt: new Date() }).where(eq(character.id, id));
      await touchProject(db, access.projectId, request.account!.id);
      return { pictureAssetId: assetId };
    });
  });

  app.delete('/api/characters/:id/picture', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      const access = await accessToEntity(db, request.account!.id, 'character', id, { edit: true });
      await db.update(character).set({ pictureAssetId: null, updatedAt: new Date() }).where(eq(character.id, id));
      await touchProject(db, access.projectId, request.account!.id);
      return { ok: true };
    });
  });
}

