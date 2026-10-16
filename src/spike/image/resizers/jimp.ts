import { Jimp, JimpMime, ResizeStrategy } from 'jimp';
import { LIB_SUPPORTS, type Resizer, type ResizeJob, type ResizeOutput } from '../types.js';
import { packageVersion, timed } from './util.js';

/**
 * Jimp: pure JavaScript, no WebAssembly. Decodes the whole image (the EXIF orientation is applied
 * on load), resizes in JavaScript and encodes. Cannot write WebP.
 */
export const jimp: Resizer = {
  id: 'jimp',
  version: packageVersion('jimp'),
  supports: LIB_SUPPORTS.jimp,

  async init() {
    /* nothing to load */
  },

  async resize(job: ResizeJob): Promise<ResizeOutput> {
    const steps: Record<string, number> = {};
    const buf = Buffer.from(job.input.buffer, job.input.byteOffset, job.input.byteLength);
    const img = await timed(steps, 'decode', () => Jimp.read(buf));
    await timed(steps, 'resize', () =>
      img.resize({ w: job.target.width, h: job.target.height, mode: ResizeStrategy.HERMITE }),
    );
    const out = await timed(steps, 'encode', () =>
      job.format === 'png'
        ? img.getBuffer(JimpMime.png)
        : img.getBuffer(JimpMime.jpeg, { quality: job.quality }),
    );
    return { data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), width: img.width, height: img.height, format: job.format, steps };
  },
};
