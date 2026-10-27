// The audio menu of a cue (its takes, record, choose audio, remove audio): the same in the script and in the timeline.
import type { Cue } from './types.ts';
import type { NavCtx } from './playback.ts';
import type { MenuItem } from './ui.tsx';
import { formatMs } from './format.ts';

export function audioMenuItems(cue: Cue, o: {
  nav: NavCtx | null;
  /** Runs a change on the cue's content (POST choose-clip, DELETE clip). */
  run: (method: 'POST' | 'DELETE', url: string, body?: unknown) => void;
  chooseAudio: () => void;
  /** Asks what to do with the chosen audio (see RemoveAudioDialog). */
  removeAudio: () => void;
}): MenuItem[] {
  const chosen = cue.clips.find((k) => k.id === cue.clipId) ?? null;
  return [
    ...cue.clips.map((k): MenuItem => ({ label: `Take ${k.number} · ${k.name}`, hint: formatMs(k.lengthMs), checked: k.id === cue.clipId,
      onClick: () => { if (k.id !== cue.clipId) o.run('POST', `/api/cues/${cue.id}/choose-clip`, { clipId: k.id }); } })),
    ...(cue.clips.length ? ['sep' as const] : []),
    { label: 'Record a take…', disabled: !!o.nav?.store.rec, onClick: () => o.nav?.record(cue.id) },
    { label: 'Choose audio…', onClick: o.chooseAudio },
    'sep',
    { label: 'Remove audio', danger: true, disabled: !chosen, onClick: () => { if (chosen) o.removeAudio(); } },
  ];
}
