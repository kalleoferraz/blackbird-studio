import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Where the library's bytes live (Bible, section 6). Everything goes through this interface so the disk can be
 * replaced later; callers never see a disk path. Paths are relative to a media project's library, written with `/`.
 */
export interface BlobStore {
  put(projectId: string, relPath: string, data: Uint8Array): Promise<void>;
  /** Streams a file, optionally only a byte range (inclusive). */
  read(projectId: string, relPath: string, range?: { start: number; end: number }): Readable;
  size(projectId: string, relPath: string): Promise<number | null>;
  remove(projectId: string, relPath: string): Promise<void>;
  rename(projectId: string, from: string, to: string): Promise<void>;
  mkdir(projectId: string, relPath: string): Promise<void>;
  /** Names of the sub-directories of a directory (empty when it does not exist). */
  listDirs(projectId: string, relPath: string): Promise<string[]>;
  /** Removes a directory and everything in it. */
  removeDir(projectId: string, relPath: string): Promise<void>;
  /** Removes the whole library of a media project. */
  removeProject(projectId: string): Promise<void>;
  /** Every file of a media project's library, as paths relative to it written with `/` (sorted; empty when there is no library). */
  listFiles(projectId: string): Promise<string[]>;
}

const BAD_CHARS = /[\\:*?"<>|\u0000-\u001f]/;
export const SEGMENT_MAX = 100;
export const PATH_MAX = 255;

/** A checked, normalised library path (no `..`, no absolute paths, no odd characters) or null. */
export function cleanPath(input: string): string | null {
  if (typeof input !== 'string') return null;
  const parts = input.split('/').filter((p) => p !== '');
  if (parts.length === 0) return '';
  for (const p of parts) {
    if (p === '.' || p === '..' || BAD_CHARS.test(p) || p.length > SEGMENT_MAX) return null;
    if (p !== p.trim() || p.endsWith('.')) return null;
  }
  const joined = parts.join('/');
  return joined.length > PATH_MAX ? null : joined;
}

/** Disk implementation: `<root>/<projectId>/<relative path>`. */
export class LocalDiskBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private dir(projectId: string): string {
    if (!/^[0-9A-Za-z]{26}$/.test(projectId)) throw new Error('bad project id');
    return path.join(path.resolve(this.root), projectId);
  }

  private abs(projectId: string, relPath: string): string {
    const clean = cleanPath(relPath);
    if (clean === null) throw new Error('unsafe path');
    const base = this.dir(projectId);
    const full = path.resolve(base, ...clean.split('/'));
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error('unsafe path');
    return full;
  }

  async put(projectId: string, relPath: string, data: Uint8Array): Promise<void> {
    const full = this.abs(projectId, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { flag: 'wx' });
  }

  read(projectId: string, relPath: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.abs(projectId, relPath), range);
  }

  async size(projectId: string, relPath: string): Promise<number | null> {
    try {
      const s = await stat(this.abs(projectId, relPath));
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  }

  async remove(projectId: string, relPath: string): Promise<void> {
    await rm(this.abs(projectId, relPath), { force: true });
  }

  async rename(projectId: string, from: string, to: string): Promise<void> {
    const dest = this.abs(projectId, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(this.abs(projectId, from), dest);
  }

  async mkdir(projectId: string, relPath: string): Promise<void> {
    await mkdir(this.abs(projectId, relPath), { recursive: true });
  }

  async listDirs(projectId: string, relPath: string): Promise<string[]> {
    try {
      const entries = await readdir(this.abs(projectId, relPath), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async removeDir(projectId: string, relPath: string): Promise<void> {
    const clean = cleanPath(relPath);
    if (!clean) throw new Error('refusing to remove the library root');
    await rm(this.abs(projectId, clean), { recursive: true, force: true });
  }

  async removeProject(projectId: string): Promise<void> {
    await rm(this.dir(projectId), { recursive: true, force: true });
  }

  async listFiles(projectId: string): Promise<string[]> {
    const base = this.dir(projectId);
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(path.join(base, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const next = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(next);
        else if (e.isFile()) out.push(next);
      }
    };
    await walk('');
    return out.sort();
  }
}

let store: BlobStore | null = null;

/** The configured store. LIBRARY_ROOT must point outside any folder a deploy replaces (on the host: under /private). */
export function blobStore(): BlobStore {
  store ??= new LocalDiskBlobStore(process.env.LIBRARY_ROOT || path.resolve(process.cwd(), 'library'));
  return store;
}

/** For tests. */
export function setBlobStore(s: BlobStore | null): void {
  store = s;
}
