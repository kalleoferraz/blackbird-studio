import Vips from 'wasm-vips';
import { LIB_SUPPORTS, type Resizer, type ResizeJob, type ResizeOutput } from '../types.js';
import { packageVersion, timed } from './util.js';

type VipsModule = Awaited<ReturnType<typeof Vips>>;
let vips: VipsModule | undefined;

/**
 * libvips compiled to WebAssembly. One call (`thumbnail`) decodes with shrink-on-load, applies the EXIF
 * orientation, converts embedded colour profiles to sRGB, resizes with alpha handled correctly, and a
 * second call encodes without metadata (no EXIF, no GPS).
 */
export const wasmVips: Resizer = {
  id: 'wasm-vips',
  version: packageVersion('wasm-vips'),
  supports: LIB_SUPPORTS['wasm-vips'],

  async init() {
    if (vips) return;
    vips = await Vips();
    vips.Cache.max(0); // do not keep decoded images around between jobs
    vips.concurrency(Number(process.env.VIPS_CONCURRENCY ?? 1)); // keep CPU use predictable on a shared host
  },

  async resize(job: ResizeJob): Promise<ResizeOutput> {
    const v = vips;
    if (!v) throw new Error('wasm-vips not initialised');
    const steps: Record<string, number> = {};

    const img = await timed(steps, 'decode+resize', () =>
      v.Image.thumbnailBuffer(job.input, job.target.width, {
        height: job.target.height,
        size: v.Size.force, // exact target size, computed once for every library
        output_profile: 'srgb', // an embedded profile (Display P3 on iPhone photos) is converted to sRGB; CMYK too
        intent: v.Intent.relative,
        fail_on: v.FailOn.error, // a truncated or damaged file is an error, not a half image
      }),
    );
    try {
      const data = await timed(steps, 'encode', () => {
        switch (job.format) {
          case 'jpeg': return img.jpegsaveBuffer({ Q: job.quality, keep: v.ForeignKeep.none, optimize_coding: true });
          case 'png': return img.pngsaveBuffer({ compression: 6, keep: v.ForeignKeep.none });
          case 'webp': return img.webpsaveBuffer({ Q: job.quality, keep: v.ForeignKeep.none });
        }
      });
      return { data, width: img.width, height: img.height, format: job.format, steps };
    } finally {
      img.delete();
    }
  },
};
