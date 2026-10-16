import type { LibId, Resizer } from '../types.js';

const cache = new Map<LibId, Resizer>();

/**
 * Loads one library on demand, so a worker only holds the code (and WebAssembly memory)
 * of the library it is actually asked to use.
 */
export async function loadResizer(id: LibId): Promise<Resizer> {
  const hit = cache.get(id);
  if (hit) return hit;
  let resizer: Resizer;
  switch (id) {
    case 'wasm-vips': resizer = (await import('./wasm-vips.js')).wasmVips; break;
    case 'jimp': resizer = (await import('./jimp.js')).jimp; break;
    case 'jsquash': resizer = (await import('./jsquash.js')).jsquash; break;
    default: throw new Error(`unknown library: ${String(id)}`);
  }
  await resizer.init();
  cache.set(id, resizer);
  return resizer;
}
