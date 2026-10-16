import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root folder of an installed package, found from where Node resolves its entry point. */
export function packageRoot(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === name) return dir;
    dir = dirname(dir);
  }
  throw new Error(`package root of ${name} not found`);
}

export function packageVersion(name: string): string {
  return JSON.parse(readFileSync(join(packageRoot(name), 'package.json'), 'utf8')).version as string;
}

/** Runs `fn` and adds the elapsed milliseconds to `steps[label]`. */
export async function timed<T>(steps: Record<string, number>, label: string, fn: () => T | Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    steps[label] = Math.round((steps[label] ?? 0) + (performance.now() - t0));
  }
}

/** A fresh ArrayBuffer holding a copy of `bytes` (safe to transfer between threads). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}
