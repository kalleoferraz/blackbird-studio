// Recording a take for a cue: ask for the microphone, count 3-2-1, record until stopped, then hand the WAV over.
import { MicRecorder, encodeWav, type Take } from './recorder.ts';
import type { PlaybackStore } from './playback.ts';
import { errorText } from './ui.tsx';

const COUNT_FROM = 3;
const MIN_TAKE_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function recordTake(o: {
  store: PlaybackStore; cueId: string;
  /** Puts the playhead at the start of the cue. */
  seek: () => void;
  /** Shows the recording for trimming; resolves with the part to keep, or null to throw the take away. */
  review: (take: Take) => Promise<{ fromMs: number; toMs: number } | null>;
  upload: (wav: Blob) => Promise<void>;
  onError: (message: string) => void;
}): Promise<void> {
  const { store, cueId } = o;
  if (store.rec) return;
  let mic: MicRecorder | null = null;
  let aborted = false;
  let recording = false;
  const set = (phase: 'count' | 'rec' | 'saving', count = 0) => store.setRec({ cueId, phase, count, stop, cancel });
  /** Click on the red button: during the count it cancels, while recording it ends the take. */
  const stop = () => { if (recording) finishNow(); else cancel(); };
  const cancel = () => { aborted = true; mic?.close(); store.pause(); store.setRec(null); };
  let finishNow = () => {};

  store.pause();
  o.seek();
  set('count', 0); // waiting for the microphone permission
  try {
    mic = await MicRecorder.open();
  } catch (e) {
    if (!aborted) { store.setRec(null); o.onError(`The microphone is not available: ${errorText(e)}`); }
    return;
  }
  for (let n = COUNT_FROM; n >= 1; n--) {
    if (aborted) return;
    set('count', n);
    await sleep(1000);
  }
  if (aborted) return;
  const taken = new Promise<void>((resolve) => { finishNow = resolve; });
  mic.start();
  recording = true;
  set('rec');
  store.play();
  await taken;
  recording = false;
  store.pause();
  set('saving');
  try {
    const take = await mic.stop();
    if (take.durationMs < MIN_TAKE_MS) o.onError('That recording was too short to keep.');
    else {
      const keep = await o.review(take);
      if (keep) await o.upload(encodeWav(take, keep.fromMs, keep.toMs));
    }
  } catch (e) {
    o.onError(`The take could not be saved: ${errorText(e)}`);
  } finally {
    mic.close();
    store.setRec(null);
  }
}
