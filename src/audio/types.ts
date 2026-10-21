/** What the worker thread is asked to do with one file. */
export interface WorkRequest {
  id: number;
  /** wav: encode the MP3 copy (unless `peaksOnly`) and collect peaks; mp3: collect peaks only. */
  kind: 'wav' | 'mp3';
  data: Uint8Array;
  kbps: number;
  peaksOnly: boolean;
}
export type WorkResponse =
  | { id: number; ok: true; mp3: Uint8Array | null; peaks: Uint8Array; ms: number }
  | { id: number; ok: false; error: { name: string; message: string } };
