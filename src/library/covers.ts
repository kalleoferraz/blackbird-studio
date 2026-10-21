import { eq } from 'drizzle-orm';
import type { Q } from '../db/client.js';
import { asset, project } from '../db/schema.js';
import { HttpError } from '../server/http.js';
import {
  MAX_PICTURE, detect, findByHash, join, moveAsset, removeFiles, sha256, splitName, storeFile, type AssetRow,
} from './files.js';

export const EARLIER_COVER = /^cover_\d{8}-\d{4}\.[^./]+$/;

const two = (n: number) => String(n).padStart(2, '0');
/** UTC stamp for a retired cover: YYYYMMDD-HHmm (Bible, section 6). */
export function coverStamp(d: Date): string {
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}`;
}

async function currentCover(q: Q, projectId: string): Promise<AssetRow | undefined> {
  const p = (await q.select({ id: project.coverAssetId }).from(project).where(eq(project.id, projectId)).limit(1))[0];
  if (!p?.id) return undefined;
  return (await q.select().from(asset).where(eq(asset.id, p.id)).limit(1))[0];
}

/**
 * The current cover steps aside as cover_{stamp}.{ext}. If that name is taken the cover was itself set within the
 * same minute: it is deleted instead (it is used by nothing else). Returns the name it was moved to, or null.
 */
async function retire(q: Q, projectId: string, current: AssetRow, now: Date): Promise<string | null> {
  const { ext } = splitName(current.path);
  const target = `cover_${coverStamp(now)}${ext}`;
  const takenHere = (await q.select().from(asset).where(eq(asset.projectId, projectId))).some((a) => a.path.toLowerCase() === target.toLowerCase());
  await q.update(project).set({ coverAssetId: null }).where(eq(project.id, projectId));
  if (takenHere) {
    await q.delete(asset).where(eq(asset.id, current.id));
    await removeFiles(current);
    return null;
  }
  await moveAsset(q, current, target);
  return target;
}

export type CoverResult =
  | { status: 'set'; asset: AssetRow; previous: string | null }
  | { status: 'unchanged'; asset: AssetRow };

export async function uploadCover(q: Q, projectId: string, name: string, data: Uint8Array, now = new Date()): Promise<CoverResult> {
  if (data.byteLength > MAX_PICTURE) throw new HttpError(413, 'too_large', 'The cover is larger than 10 MB.');
  const d = await detect(name, data);
  if (d.kind !== 'image') throw new HttpError(415, 'unsupported_type', 'Choose a JPEG, PNG, WebP, SVG or GIF image.');
  const cur = await currentCover(q, projectId);
  const dup = await findByHash(q, projectId, sha256(data));
  if (dup) {
    if (cur && dup.id === cur.id) return { status: 'unchanged', asset: dup };
    if (EARLIER_COVER.test(dup.path)) {
      throw new HttpError(409, 'same_as_earlier_cover', 'This is an earlier cover of this media project.', { assetId: dup.id, path: dup.path });
    }
    throw new HttpError(409, 'already_in_library', `This image is already in the library at ${dup.path}.`, { assetId: dup.id, path: dup.path });
  }
  let previous: string | null = null;
  const before = cur ? { ...cur } : undefined;
  if (cur) previous = await retire(q, projectId, cur, now);
  try {
    const stored = await storeFile(q, { projectId, folder: '', name: `cover${d.ext}`, data, only: ['image'], exactName: true, maxBytes: MAX_PICTURE });
    await q.update(project).set({ coverAssetId: stored.asset.id, updatedAt: new Date() }).where(eq(project.id, projectId));
    return { status: 'set', asset: stored.asset, previous };
  } catch (e) {
    if (before && previous) await moveAsset(q, { ...before, path: join('', previous), lightweightPath: null }, before.path).catch(() => undefined);
    if (before && previous) await q.update(project).set({ coverAssetId: before.id }).where(eq(project.id, projectId));
    throw e;
  }
}

/** Puts an earlier cover back (the swap). */
export async function useEarlierCover(q: Q, projectId: string, assetId: string, now = new Date()): Promise<AssetRow> {
  const chosen = (await q.select().from(asset).where(eq(asset.id, assetId)).limit(1))[0];
  if (!chosen || chosen.projectId !== projectId || !EARLIER_COVER.test(chosen.path)) {
    throw new HttpError(400, 'not_a_cover', 'That file is not an earlier cover.');
  }
  const cur = await currentCover(q, projectId);
  if (cur) await retire(q, projectId, cur, now);
  const { ext } = splitName(chosen.path);
  const fresh = (await q.select().from(asset).where(eq(asset.id, chosen.id)).limit(1))[0]!;
  await moveAsset(q, fresh, `cover${ext}`);
  await q.update(project).set({ coverAssetId: chosen.id, updatedAt: new Date() }).where(eq(project.id, projectId));
  return (await q.select().from(asset).where(eq(asset.id, chosen.id)).limit(1))[0]!;
}

/** Removes the cover from the media project; the file steps aside as an earlier cover. */
export async function clearCover(q: Q, projectId: string, now = new Date()): Promise<void> {
  const cur = await currentCover(q, projectId);
  if (cur) await retire(q, projectId, cur, now);
  await q.update(project).set({ coverAssetId: null, updatedAt: new Date() }).where(eq(project.id, projectId));
}
