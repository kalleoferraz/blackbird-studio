import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOrientation, swapsAxes } from '../orientation.js';
import { LIB_SUPPORTS, type ImageFormat, type Resizer, type ResizeJob, type ResizeOutput } from '../types.js';
import { packageRoot, packageVersion, timed, toArrayBuffer } from './util.js';

// jSquash's codecs expect the browser's ImageData class.
if (!('ImageData' in globalThis)) {
  (globalThis as Record<string, unknown>).ImageData = class ImageData {
    colorSpace = 'srgb';
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  };
}

interface Bitmap { data: Uint8ClampedArray; width: number; height: number }
interface Codecs {
  decode: Record<ImageFormat, (buf: ArrayBuffer) => Promise<Bitmap>>;
  encode: Record<ImageFormat, (img: Bitmap, quality: number) => Promise<ArrayBuffer>>;
  resize: (img: Bitmap, width: number, height: number) => Promise<Bitmap>;
}
let codecs: Codecs | undefined;

const compile = (path: string) => WebAssembly.compile(readFileSync(path));

/**
 * Squoosh's codecs as WebAssembly: mozjpeg, OxiPNG-style PNG, libwebp and a Lanczos resizer.
 * They know nothing about the EXIF orientation, so the file is decoded in stored orientation,
 * resized to the stored-orientation target, and only then rotated (a cheap step on the small image).
 */
export const jsquash: Resizer = {
  id: 'jsquash',
  version: packageVersion('@jsquash/jpeg'),
  supports: LIB_SUPPORTS.jsquash,

  async init() {
    if (codecs) return;
    const jpegRoot = packageRoot('@jsquash/jpeg');
    const pngRoot = packageRoot('@jsquash/png');
    const webpRoot = packageRoot('@jsquash/webp');
    const resizeRoot = packageRoot('@jsquash/resize');

    const [jpegDec, jpegEnc, pngDec, pngEnc, webpDec, webpEnc, rz] = await Promise.all([
      import('@jsquash/jpeg/decode.js'),
      import('@jsquash/jpeg/encode.js'),
      import('@jsquash/png/decode.js'),
      import('@jsquash/png/encode.js'),
      import('@jsquash/webp/decode.js'),
      import('@jsquash/webp/encode.js'),
      import('@jsquash/resize'),
    ]);
    await Promise.all([
      jpegDec.init(await compile(join(jpegRoot, 'codec/dec/mozjpeg_dec.wasm'))),
      jpegEnc.init(await compile(join(jpegRoot, 'codec/enc/mozjpeg_enc.wasm'))),
      pngDec.init(await compile(join(pngRoot, 'codec/pkg/squoosh_png_bg.wasm'))),
      pngEnc.init(await compile(join(pngRoot, 'codec/pkg/squoosh_png_bg.wasm'))),
      webpDec.init(await compile(join(webpRoot, 'codec/dec/webp_dec.wasm'))),
      webpEnc.init(await compile(join(webpRoot, 'codec/enc/webp_enc.wasm'))),
      rz.initResize(await compile(join(resizeRoot, 'lib/resize/pkg/squoosh_resize_bg.wasm'))),
    ]);

    codecs = {
      decode: {
        jpeg: (b) => jpegDec.default(b) as Promise<Bitmap>,
        png: (b) => pngDec.default(b) as Promise<Bitmap>,
        webp: (b) => webpDec.default(b) as Promise<Bitmap>,
      },
      encode: {
        jpeg: (i, q) => jpegEnc.default(i as ImageData, { quality: q }),
        png: (i) => pngEnc.default(i as ImageData),
        webp: (i, q) => webpEnc.default(i as ImageData, { quality: q }),
      },
      resize: (img, width, height) =>
        rz.default(img as ImageData, {
          width,
          height,
          method: 'lanczos3',
          premultiply: true, // alpha-aware: no dark halo around transparent edges
          linearRGB: false,
        }) as Promise<Bitmap>,
    };
  },

  async resize(job: ResizeJob): Promise<ResizeOutput> {
    const c = codecs;
    if (!c) throw new Error('jsquash not initialised');
    const steps: Record<string, number> = {};
    const orientation = job.format === 'png' ? 1 : job.exifOrientation;
    const swap = swapsAxes(orientation);
    const storedW = swap ? job.target.height : job.target.width;
    const storedH = swap ? job.target.width : job.target.height;

    const decoded = await timed(steps, 'decode', () => c.decode[job.format](toArrayBuffer(job.input)));
    const small = await timed(steps, 'resize', () => c.resize(decoded, storedW, storedH));
    const upright = await timed(steps, 'rotate', () => applyOrientation(small, orientation));
    const data = await timed(steps, 'encode', () => c.encode[job.format](upright, job.quality));
    return { data: new Uint8Array(data), width: upright.width, height: upright.height, format: job.format, steps };
  },
};
