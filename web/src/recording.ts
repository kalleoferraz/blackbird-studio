// Recording a take for a cue: ask for the microphone, count 3-2-1, record until stopped, then hand the WAV over.
import { MicRecorder, encodeWav, type Take } from './recorder.ts';
import type { PlaybackStore } from './playback.ts';
import { errorText } from './ui.tsx';

const COUNT_FROM = 3;
const MIN_TAKE_MS = 300;

/** A key press meant for a text field (typing a note, say) is not a shortcut. */
const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

/**
 * Records a take. Shortcuts while counting in or recording: Esc cancels (nothing is kept), Backspace starts over
 * (the take so far is thrown away, the playhead goes back to the cue's start and the count-in runs again).
 */
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
  let restart = false;
  /** Wakes the count-in or the recording wait when something happens (stop, cancel, restart). */
  let wake = () => {};
  const set = (phase: 'count' | 'rec' | 'saving', count = 0) => store.setRec({ cueId, phase, count, stop, cancel });
  /** Click on the red button: during the count it cancels, while recording it ends the take. */
  const stop = () => { if (recording) wake(); else cancel(); };
  const cancel = () => { aborted = true; mic?.close(); store.pause(); store.setRec(null); wake(); };
  const startOver = () => { if (!aborted) { restart = true; wake(); } };
  const onKey = (e: KeyboardEvent) => {
    if (typing(e) || e.repeat) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); startOver(); }
  };
  /** Waits `ms`, or less when woken. */
  const wait = (ms?: number) => new Promise<void>((resolve) => {
    const t = ms === undefined ? null : setTimeout(resolve, ms);
    wake = () => { if (t) clearTimeout(t); resolve(); };
  });

  store.pause();
  o.seek();
  set('count', 0); // waiting for the microphone permission
  try {
    mic = await MicRecorder.open();
  } catch (e) {
    if (!aborted) { store.setRec(null); o.onError(`The microphone is not available: ${errorText(e)}`); }
    return;
  }
  document.addEventListener('keydown', onKey, true);
  try {
    // Count in and record; Backspace comes back here.
    for (;;) {
      restart = false;
      for (let n = COUNT_FROM; n >= 1 && !aborted && !restart; n--) {
        set('count', n);
        await wait(1000);
      }
      if (aborted) return;
      if (restart) { store.pause(); o.seek(); continue; }
      mic.start(); // starts a fresh take: anything kept before is dropped
      recording = true;
      set('rec');
      store.play();
      await wait();
      recording = false;
      if (aborted) return;
      if (restart) { store.pause(); o.seek(); continue; }
      break;
    }
  } finally {
    document.removeEventListener('keydown', onKey, true);
  }
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
