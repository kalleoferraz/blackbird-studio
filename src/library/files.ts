import { createHash } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import type { Q } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { asset, assetPeaks } from '../db/schema.js';
import { AudioError } from '../audio/errors.js';
import { parseMp3 } from '../audio/mp3.js';
import { parseWav, wavSamples } from '../audio/wav.js';
import { inspectImage } from '../images/inspect.js';
import { lightweightName } from '../images/naming.js';
import { processImage } from '../images/process.js';
import { HttpError } from '../server/http.js';
import { blobStore, cleanPath, PATH_MAX, SEGMENT_MAX } from '../storage/blob-store.js';
import { resizePool } from './pool.js';

export type MediaKind = 'audio' | 'image' | 'video' | 'document' | 'other';
export type AssetRow = typeof asset.$inferSelect;

/** Images that can be shown in the app and previewed. */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'];
const AUDIO = ['wav', 'mp3', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'aif', 'aiff', 'opus', 'wma'];
const VIDEO = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'];
const DOCUMENT = ['pdf', 'txt', 'md', 'rtf', 'doc', 'docx', 'odt', 'csv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'epub', 'json', 'html'];

export const MAX_UPLOAD = 100 * 1024 * 1024;
export const MAX_PICTURE = 10 * 1024 * 1024;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' };
}

/** A file name from the user: one path segment, no unsafe characters. */
export function cleanFileName(input: string): string {
  const last = String(input ?? '').split(/[\\/]/).pop() ?? '';
  const name = last
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  if (!name) throw new HttpError(400, 'invalid_name', 'The file needs a name.');
  if (name.length > SEGMENT_MAX) {
    const { base, ext } = splitName(name);
    return base.slice(0, SEGMENT_MAX - ext.length).trim() + ext;
  }
  return name;
}

export function checkFolder(input: unknown): string {
  const clean = cleanPath(typeof input === 'string' ? input : '');
  if (clean === null) throw new HttpError(400, 'invalid_folder', 'That folder name cannot be used.');
  return clean;
}

export function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
export const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

export interface Detected {
  kind: MediaKind;
  /** Extension to store under (from the content for images). */
  ext: string;
  format?: string;
}

const FORMAT_EXT: Record<string, string> = { jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif' };

export async function detect(name: string, data: Uint8Array): Promise<Detected> {
  const ext = extensionOf(name);
  const head = Buffer.from(data.subarray(0, 512)).toString('utf8').trimStart().toLowerCase();
  if (ext === 'svg' || head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    if (!head.includes('<svg') && !Buffer.from(data.subarray(0, 4096)).toString('utf8').toLowerCase().includes('<svg')) {
      return { kind: 'other', ext: ext ? '.' + ext : '' };
    }
    return { kind: 'image', ext: '.svg', format: 'svg' };
  }
  const insp = await inspectImage(data);
  if (insp.format !== 'unknown') return { kind: 'image', ext: FORMAT_EXT[insp.format] ?? '.' + ext, format: insp.format };
  if (AUDIO.includes(ext)) return { kind: 'audio', ext: '.' + ext };
  if (VIDEO.includes(ext)) return { kind: 'video', ext: '.' + ext };
  if (DOCUMENT.includes(ext)) return { kind: 'document', ext: '.' + ext };
  return { kind: 'other', ext: ext ? '.' + ext : '' };
}

/** The extension to keep: the user's when it names the same format (photo.jpeg stays), else the detected one. */
function finalName(name: string, d: Detected): string {
  if (d.kind !== 'image') return name;
  const { base, ext } = splitName(name);
  const same = ext.toLowerCase() === d.ext || (d.ext === '.jpg' && ext.toLowerCase() === '.jpeg');
  return same ? name : base + d.ext;
}

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The playback copy of a WAV: the same base name with .mp3 (Bible, section 6). */
export const mp3Name = (name: string): string => splitName(name).base + '.mp3';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/** A path not used by any asset (master or lightweight) in this project: `name`, then `name (2)`, ... */
export async function freeName(q: Q, projectId: string, folder: string, name: string, derived: (n: string) => string | null): Promise<string> {
  const { base, ext } = splitName(name);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${base} (${n})${ext}`;
    const master = join(folder, candidate);
    const light = derived(candidate);
    const lightPath = light ? join(folder, light) : null;
    if (master.length > PATH_MAX || (lightPath && lightPath.length > PATH_MAX)) throw new HttpError(400, 'path_too_long', 'The path is too long.');
    const clash = await q
      .select({ id: asset.id })
      .from(asset)
      .where(
        and(
          eq(asset.projectId, projectId),
          lightPath
            ? sql`(${asset.path} IN (${master}, ${lightPath}) OR ${asset.lightweightPath} IN (${master}, ${lightPath}))`
            : sql`(${asset.path} = ${master} OR ${asset.lightweightPath} = ${master})`,
        ),
      )
      .limit(1);
    if (clash.length === 0) return candidate;
  }
  throw new HttpError(409, 'name_taken', 'Too many files with that name.');
}

export interface Stored {
  duplicate: boolean;
  asset: AssetRow;
}

export interface StoreOptions {
  projectId: string;
  folder: string;
  name: string;
  data: Uint8Array;
  /** Only these kinds are accepted (pictures: image). */
  only?: MediaKind[];
  /** Exact file name wanted (the cover): fails with name_taken instead of numbering. */
  exactName?: boolean;
  maxBytes: number;
}

export async function findByHash(q: Q, projectId: string, hash: string): Promise<AssetRow | undefined> {
  return (await q.select().from(asset).where(and(eq(asset.projectId, projectId), eq(asset.hash, hash))).limit(1))[0];
}

/** Hashes, detects, reduces (images over 600 px) and stores a file in the library; an identical file is not stored twice. */
export async function storeFile(q: Q, o: StoreOptions): Promise<Stored> {
  if (o.data.byteLength === 0) throw new HttpError(400, 'empty_file', 'The file is empty.');
  if (o.data.byteLength > o.maxBytes) {
    throw new HttpError(413, 'too_large', `The file is larger than ${Math.round(o.maxBytes / (1024 * 1024))} MB.`);
  }
  const bytesHash = sha256(o.data);
  const existing = await findByHash(q, o.projectId, bytesHash);
  if (existing) return { duplicate: true, asset: existing };

  const d = await detect(o.name, o.data);
  if (o.only && !o.only.includes(d.kind)) {
    throw new HttpError(415, 'unsupported_type', o.only.includes('image') ? 'Choose a JPEG, PNG, WebP, SVG or GIF image.' : 'This kind of file is not accepted here.');
  }

  let hash = bytesHash;
  let light: { data: Uint8Array; width: number; height: number; format: string } | null = null;
  let info: Record<string, unknown> = {};
  let wavMaster = false;
  if (d.kind === 'audio') {
    const ext = d.ext.toLowerCase();
    if (ext !== '.wav' && ext !== '.mp3') throw new HttpError(415, 'unsupported_audio', 'Only WAV and MP3 files are accepted for now.');
    try {
      if (ext === '.wav') {
        const w = parseWav(o.data);
        wavMaster = true;
        // The hash covers the samples only (Bible, section 6), so the same recording with other tags is the same file.
        hash = sha256(wavSamples(o.data, w));
        info = { format: 'wav', durationMs: w.durationMs, sampleRate: w.sampleRate, channels: w.channels, bitDepth: w.bitDepth, sampleFormat: w.sampleFormat };
      } else {
        const m = parseMp3(o.data);
        info = { format: 'mp3', durationMs: m.durationMs, sampleRate: m.sampleRate, channels: m.channels, bitrateKbps: m.bitrateKbps };
      }
    } catch (e) {
      if (e instanceof AudioError) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
    if (hash !== bytesHash) {
      const same = await findByHash(q, o.projectId, hash);
      if (same) return { duplicate: true, asset: same };
    }
  } else if (d.kind === 'image' && d.format !== 'svg') {
    const r = await processImage(o.data, { lib: 'wasm-vips', name: o.name, pool: resizePool() });
    if (r.status === 'failed') throw new HttpError(422, 'image_unreadable', `The image could not be read: ${r.error.message}.`);
    const i = r.inspection;
    info = { width: i.displayWidth, height: i.displayHeight, format: i.format };
    if (r.status === 'resized') light = { data: r.output.data, width: r.output.width, height: r.output.height, format: r.output.format };
  } else if (d.format === 'svg') {
    info = { format: 'svg' };
  }

  const wanted = finalName(cleanFileName(o.name), d);
  const derived = (n: string) => (light ? lightweightName(n, light.width, light.height) : wavMaster ? mp3Name(n) : null);
  let name = wanted;
  if (o.exactName) {
    const free = await freeName(q, o.projectId, o.folder, wanted, derived);
    if (free !== wanted) throw new HttpError(409, 'name_taken', 'A file with that name exists.');
  } else {
    name = await freeName(q, o.projectId, o.folder, wanted, derived);
  }
  const path = join(o.folder, name);
  const lightName = derived(name);
  const lightPath = lightName ? join(o.folder, lightName) : null;

  const blobs = blobStore();
  const written: string[] = [];
  try {
    await blobs.put(o.projectId, path, o.data);
    written.push(path);
    if (light && lightPath) {
      await blobs.put(o.projectId, lightPath, light.data);
      written.push(lightPath);
    }
    const now = new Date();
    const row: AssetRow = {
      id: newUlid(),
      projectId: o.projectId,
      path,
      hash,
      mediaKind: d.kind,
      size: o.data.byteLength,
      sizeLightweight: light ? light.data.byteLength : null,
      lightweightPath: lightPath,
      mediaInfo: info,
      loudnessLufs: null,
      peakDb: null,
      status: d.kind === 'audio' ? 'pending' : 'ready', // audio waits for its peaks, and a WAV for its MP3 copy (audio/jobs.ts)
      fileState: 'ok',
      claimedBy: null,
      claimedAt: null,
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await q.insert(asset).values(row);
    return { duplicate: false, asset: row };
  } catch (e) {
    for (const p of written) await blobs.remove(o.projectId, p).catch(() => undefined);
    if ((e as { code?: string; cause?: { code?: string } }).code === 'ER_DUP_ENTRY' || (e as { cause?: { code?: string } }).cause?.code === 'ER_DUP_ENTRY') {
      const again = await findByHash(q, o.projectId, hash);
      if (again) return { duplicate: true, asset: again };
    }
    throw e;
  }
}

export interface Replaced {
  asset: AssetRow;
  /** False when the new bytes are the same recording or picture as before (same hash). */
  changed: boolean;
}

/**
 * Puts new bytes under an existing asset: same id, same path, so every clip, note and picture that points at it keeps
 * pointing at it. The hash, size and media info are taken from the new file, the old derived copy (MP3, reduced
 * picture) is dropped and made again, and for audio the waveform is made again (the asset goes back to `pending`).
 * The new file must be the same kind of file with the same extension; an identical file is accepted too (that is how
 * a missing file is put back).
 */
export async function replaceFile(q: Q, row: AssetRow, data: Uint8Array): Promise<Replaced> {
  if (data.byteLength === 0) throw new HttpError(400, 'empty_file', 'The file is empty.');
  if (data.byteLength > MAX_UPLOAD) throw new HttpError(413, 'too_large', `The file is larger than ${Math.round(MAX_UPLOAD / (1024 * 1024))} MB.`);
  const name = row.path.slice(row.path.lastIndexOf('/') + 1);
  const d = await detect(name, data);
  const pathExt = extensionOf(name);
  const sameExt = d.ext.slice(1) === pathExt || (d.ext === '.jpg' && pathExt === 'jpeg');
  if (d.kind !== row.mediaKind || !sameExt) {
    throw new HttpError(415, 'wrong_type', `Choose a ${pathExt ? '.' + pathExt : ''} file of the same kind as ${name}.`);
  }
  const bytesHash = sha256(data);
  let hash = bytesHash;
  let info: Record<string, unknown> = {};
  let light: { data: Uint8Array; width: number; height: number } | null = null;
  if (d.kind === 'audio') {
    try {
      if (pathExt === 'wav') {
        const w = parseWav(data);
        hash = sha256(wavSamples(data, w));
        info = { format: 'wav', durationMs: w.durationMs, sampleRate: w.sampleRate, channels: w.channels, bitDepth: w.bitDepth, sampleFormat: w.sampleFormat };
      } else {
        const m = parseMp3(data);
        info = { format: 'mp3', durationMs: m.durationMs, sampleRate: m.sampleRate, channels: m.channels, bitrateKbps: m.bitrateKbps };
      }
    } catch (e) {
      if (e instanceof AudioError) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  } else if (d.kind === 'image' && d.format !== 'svg') {
    const r = await processImage(data, { lib: 'wasm-vips', name, pool: resizePool() });
    if (r.status === 'failed') throw new HttpError(422, 'image_unreadable', `The image could not be read: ${r.error.message}.`);
    info = { width: r.inspection.displayWidth, height: r.inspection.displayHeight, format: r.inspection.format };
    if (r.status === 'resized') light = { data: r.output.data, width: r.output.width, height: r.output.height };
  } else if (d.format === 'svg') {
    info = { format: 'svg' };
  }
  const other = await findByHash(q, row.projectId, hash);
  if (other && other.id !== row.id) {
    throw new HttpError(409, 'already_in_library', `This file is already in the library at ${other.path}.`, { assetId: other.id, path: other.path });
  }

  const blobs = blobStore();
  const lightPath = light ? join(dirOf(row.path), lightweightName(name, light.width, light.height)) : row.mediaKind === 'audio' ? row.lightweightPath : null;
  // `put` never overwrites, so what is there goes first; the derived copies are made again from the new bytes.
  await blobs.remove(row.projectId, row.path).catch(() => undefined);
  await blobs.put(row.projectId, row.path, data);
  if (row.lightweightPath) await blobs.remove(row.projectId, row.lightweightPath).catch(() => undefined);
  if (light && lightPath) await blobs.put(row.projectId, lightPath, light.data);
  const patch: Partial<typeof asset.$inferInsert> = {
    hash,
    size: data.byteLength,
    mediaInfo: info,
    loudnessLufs: null, // measured again with the new sound
    peakDb: null,
    lightweightPath: lightPath,
    sizeLightweight: light ? light.data.byteLength : null,
    status: d.kind === 'audio' ? 'pending' : 'ready',
    fileState: 'ok',
    claimedBy: null,
    claimedAt: null,
    attempts: 0,
    error: null,
    updatedAt: new Date(),
  };
  await q.update(asset).set(patch).where(eq(asset.id, row.id));
  if (d.kind === 'audio') await q.delete(assetPeaks).where(eq(assetPeaks.assetId, row.id));
  return { asset: { ...row, ...patch } as AssetRow, changed: hash !== row.hash };
}

/** Removes the row's files from disk (the row itself is removed by the caller). */
export async function removeFiles(a: Pick<AssetRow, 'projectId' | 'path' | 'lightweightPath'>): Promise<void> {
  const blobs = blobStore();
  await blobs.remove(a.projectId, a.path).catch(() => undefined);
  if (a.lightweightPath) await blobs.remove(a.projectId, a.lightweightPath).catch(() => undefined);
}

/** Moves a master (and its derived copy) to a new path, in the database and on disk. */
export async function moveAsset(q: Q, a: AssetRow, toPath: string): Promise<void> {
  const blobs = blobStore();
  const toLight = a.lightweightPath ? join(dirOf(toPath), renameDerived(a.lightweightPath.slice(a.lightweightPath.lastIndexOf('/') + 1), toPath, a.mediaKind)) : null;
  // A file that is already missing has no bytes to move: only its address changes.
  if (a.fileState !== 'missing') await blobs.rename(a.projectId, a.path, toPath);
  if (a.lightweightPath && toLight) await blobs.rename(a.projectId, a.lightweightPath, toLight).catch(() => undefined);
  await q.update(asset).set({ path: toPath, lightweightPath: toLight, updatedAt: new Date() }).where(eq(asset.id, a.id));
}

/** The derived name for a renamed master: keeps the `_WxH` part of the old derived name. */
export function renameDerived(oldDerivedName: string, newMasterPath: string, kind: MediaKind): string {
  if (kind === 'audio') return mp3Name(newMasterPath.slice(newMasterPath.lastIndexOf('/') + 1));
  const m = /_(\d+x\d+)(\.[^.]*)?$/.exec(oldDerivedName);
  const { base, ext } = splitName(newMasterPath.slice(newMasterPath.lastIndexOf('/') + 1));
  return `${base}_${m ? m[1] : '0x0'}${ext}`;
}

export async function assetsUnder(q: Q, projectId: string, folder: string): Promise<AssetRow[]> {
  const prefix = folder ? folder + '/' : '';
  return q
    .select()
    .from(asset)
    .where(and(eq(asset.projectId, projectId), prefix ? like(asset.path, escapeLike(prefix) + '%') : undefined));
}
