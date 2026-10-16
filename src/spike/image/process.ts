import { inspectImage } from './inspect.js';
import { lightweightName } from './naming.js';
import { fitLongest } from './orientation.js';
import { ResizeError, type ResizeWorkerPool } from './pool.js';
import { LIB_SUPPORTS, type FailureCode, type ImageFormat, type Inspection, type LibId } from './types.js';

export const DEFAULTS = {
  /** Longest side of the lightweight copy (Bible, section 6). */
  maxSide: 600,
  /** JPEG and WebP quality of the copy. Not decided in the Bible; a starting value. */
  quality: 82,
  /** Refuse to decode more pixels than this: RGBA costs 4 bytes per pixel, so 50 MP is about 200 MB. */
  maxPixels: 50_000_000,
} as const;

export interface ProcessOptions {
  lib: LibId;
  /** Original file name, used for the name of the copy. */
  name: string;
  pool: ResizeWorkerPool;
  maxSide?: number;
  quality?: number;
  maxPixels?: number;
}

export interface ProcessMetrics {
  inspectMs: number;
  /** Everything from handing the job to the worker until the answer is back (includes worker start). */
  roundTripMs: number;
  workerSpawned: boolean;
  spawnMs: number;
  /** Library load and initialisation inside the worker (near 0 once warm). */
  initMs: number;
  resizeMs: number;
  /** Library specific steps (decode, resize, rotate, encode). */
  steps: Record<string, number>;
  /** CPU time of the whole process during the job, all threads. */
  cpuMs: number;
  rssBeforeMB: number;
  rssAfterMB: number;
  /** Highest RSS sampled every 5 ms while the job ran. RSS covers the whole process, worker and WebAssembly included. */
  rssPeakMB: number;
}

export type ProcessResult =
  | {
      status: 'resized';
      lib: LibId;
      libVersion: string;
      inspection: Inspection;
      output: { data: Uint8Array; width: number; height: number; format: ImageFormat; bytes: number; name: string };
      metrics: ProcessMetrics;
    }
  | { status: 'skipped'; lib: LibId; inspection: Inspection; reason: string; metrics: Pick<ProcessMetrics, 'inspectMs'> }
  | {
      status: 'failed';
      lib: LibId;
      inspection?: Inspection;
      error: { code: FailureCode; message: string };
      metrics: Partial<ProcessMetrics> & { inspectMs: number };
    };

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

function startRssSampler(intervalMs = 5) {
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, intervalMs);
  return () => {
    clearInterval(timer);
    return Math.max(peak, process.memoryUsage.rss());
  };
}

/**
 * The whole rule for one uploaded image: inspect the headers, decide (skip, refuse or resize), and when
 * resizing, run the worker with an exact target size. Never throws; the outcome says what happened.
 */
export async function processImage(input: Uint8Array, opts: ProcessOptions): Promise<ProcessResult> {
  const maxSide = opts.maxSide ?? DEFAULTS.maxSide;
  const quality = opts.quality ?? DEFAULTS.quality;
  const maxPixels = opts.maxPixels ?? DEFAULTS.maxPixels;
  const lib = opts.lib;

  const t0 = performance.now();
  if (input.length === 0) {
    return { status: 'failed', lib, error: { code: 'empty', message: 'empty file' }, metrics: { inspectMs: 0 } };
  }
  const inspection = await inspectImage(input);
  const inspectMs = Math.round((performance.now() - t0) * 10) / 10;
  const fail = (code: FailureCode, message: string): ProcessResult => ({
    status: 'failed', lib, inspection, error: { code, message }, metrics: { inspectMs },
  });

  if (inspection.format === 'unknown') return fail('unsupported_format', 'not a JPEG, PNG, GIF or WebP file');
  if (inspection.error || !inspection.width || !inspection.height || !inspection.displayWidth || !inspection.displayHeight) {
    return fail('unreadable_header', inspection.error ?? 'image size not found');
  }
  const megapixels = (inspection.width * inspection.height) / 1e6;
  if (inspection.width * inspection.height > maxPixels) {
    return fail('too_many_pixels', `${megapixels.toFixed(0)} MP is above the limit of ${(maxPixels / 1e6).toFixed(0)} MP`);
  }
  if (inspection.truncated) return fail('decode_failed', 'the file is cut off (end of file not found)');
  if (inspection.animated) return { status: 'skipped', lib, inspection, reason: 'animated image: no lightweight copy', metrics: { inspectMs } };
  if (inspection.format === 'gif') return { status: 'skipped', lib, inspection, reason: 'GIF is not resized in this spike', metrics: { inspectMs } };

  if (Math.max(inspection.displayWidth, inspection.displayHeight) <= maxSide) {
    return { status: 'skipped', lib, inspection, reason: `not larger than ${maxSide} px: no lightweight copy`, metrics: { inspectMs } };
  }
  const format: ImageFormat = inspection.format;
  if (!LIB_SUPPORTS[lib].includes(format)) return fail('unsupported_by_library', `${lib} cannot write ${format}`);

  const target = fitLongest(inspection.displayWidth, inspection.displayHeight, maxSide);

  const rssBeforeMB = mb(process.memoryUsage.rss());
  const cpu0 = process.cpuUsage();
  const stopSampler = startRssSampler();
  const t1 = performance.now();
  try {
    const r = await opts.pool.run(lib, {
      input,
      format,
      target,
      exifOrientation: inspection.exifOrientation,
      quality,
      hasAlpha: inspection.hasAlpha,
    });
    const roundTripMs = Math.round(performance.now() - t1);
    const rssPeakMB = mb(stopSampler());
    const cpu = process.cpuUsage(cpu0);
    return {
      status: 'resized',
      lib,
      libVersion: r.libVersion,
      inspection,
      output: {
        data: r.output.data,
        width: r.output.width,
        height: r.output.height,
        format: r.output.format,
        bytes: r.output.data.byteLength,
        name: lightweightName(opts.name, r.output.width, r.output.height),
      },
      metrics: {
        inspectMs,
        roundTripMs,
        workerSpawned: r.workerSpawned,
        spawnMs: r.spawnMs,
        initMs: r.initMs,
        resizeMs: r.resizeMs,
        steps: r.output.steps,
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        rssBeforeMB,
        rssAfterMB: mb(process.memoryUsage.rss()),
        rssPeakMB,
      },
    };
  } catch (e) {
    stopSampler();
    const code: FailureCode = e instanceof ResizeError ? e.code : 'decode_failed';
    return {
      status: 'failed', lib, inspection,
      error: { code, message: e instanceof Error ? e.message : String(e) },
      metrics: { inspectMs, roundTripMs: Math.round(performance.now() - t1), rssBeforeMB, rssPeakMB: mb(process.memoryUsage.rss()) },
    };
  }
}
