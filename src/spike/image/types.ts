export const LIB_IDS = ['wasm-vips', 'jimp', 'jsquash'] as const;
export type LibId = (typeof LIB_IDS)[number];

/** The copy keeps the original's format (Bible, section 6), so input and output formats are the same set. */
export type ImageFormat = 'jpeg' | 'png' | 'webp';

/** Formats each library can both read and write (static, so the main thread need not load the library to know). */
export const LIB_SUPPORTS: Record<LibId, readonly ImageFormat[]> = {
  'wasm-vips': ['jpeg', 'png', 'webp'],
  jimp: ['jpeg', 'png'],
  jsquash: ['jpeg', 'png', 'webp'],
};

/** What the shared inspection can say about a file without decoding it. */
export interface Inspection {
  /** Detected from the file's first bytes, never from the extension. */
  format: ImageFormat | 'gif' | 'unknown';
  /** Stored (sensor) size. */
  width?: number;
  height?: number;
  /** EXIF orientation 1..8 (1 when absent). Orientations 5..8 swap the axes on display. */
  exifOrientation: number;
  /** Size as displayed, after the EXIF orientation. */
  displayWidth?: number;
  displayHeight?: number;
  animated: boolean;
  hasAlpha: boolean;
  /** JPEG only. */
  components?: number;
  progressive?: boolean;
  /** JPEG without an end marker near the end, PNG without IEND: the upload was cut off. */
  truncated?: boolean;
  /** Why inspection failed (header unreadable). */
  error?: string;
}

export interface ResizeJob {
  input: Uint8Array;
  format: ImageFormat;
  /** Final size, in displayed orientation. Computed once, so every library aims at the same size. */
  target: { width: number; height: number };
  exifOrientation: number;
  /** JPEG and WebP quality, 1..100. */
  quality: number;
  hasAlpha: boolean;
}

export interface ResizeOutput {
  data: Uint8Array;
  width: number;
  height: number;
  format: ImageFormat;
  /** Milliseconds per internal step (decode, resize, rotate, encode...), library specific. */
  steps: Record<string, number>;
}

export interface Resizer {
  id: LibId;
  version: string;
  /** Formats it can both read and write. */
  supports: readonly ImageFormat[];
  /** Loads and compiles code (WebAssembly modules). Timed separately as the cold-start cost. */
  init(): Promise<void>;
  resize(job: ResizeJob): Promise<ResizeOutput>;
}

export type FailureCode =
  | 'empty'
  | 'unsupported_format'
  | 'unreadable_header'
  | 'too_many_pixels'
  | 'decode_failed'
  | 'unsupported_by_library'
  | 'timeout'
  | 'worker_crashed';

export interface SerializedError {
  name: string;
  message: string;
}

export interface WorkerRequest {
  id: number;
  lib: LibId;
  job: ResizeJob;
}

export type WorkerResponse =
  | {
      id: number;
      ok: true;
      output: ResizeOutput;
      /** Time to load and initialise the library in this worker (near 0 once warm). */
      initMs: number;
      resizeMs: number;
      libVersion: string;
    }
  | { id: number; ok: false; error: SerializedError; initMs: number };
