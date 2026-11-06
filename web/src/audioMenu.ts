// The audio menu of a cue (its takes, record, choose audio, mute, remove audio): the same in the script and in the timeline.
import { createElement, Fragment } from 'react';
import type { Cue } from './types.ts';
import { AudioSliders } from './AudioSettings.tsx';
import type { NavCtx } from './playback.ts';
import type { MenuItem } from './ui.tsx';
import { formatMs } from './format.ts';

export function audioMenuItems(cue: Cue, o: {
  nav: NavCtx | null;
  /** Runs a change on the cue's content (POST choose-clip, DELETE clip). */
  run: (method: 'POST' | 'DELETE' | 'PATCH', url: string, body?: unknown) => void;
  chooseAudio: () => void;
  /** Asks what to do with the chosen audio (see RemoveAudioDialog). */
  removeAudio: () => void;
  /** Opens the cue in the timeline for editing its audio (the volume envelope and the settings panel); absent where there is no timeline (a phone). */
  edit?: () => void;
  /** On a phone: opens the audio panel above the player bar (sliders and envelope) instead of the submenu. */
  panel?: () => void;
}): MenuItem[] {
  const chosen = cue.clips.find((k) => k.id === cue.clipId) ?? null;
  return [
    ...cue.clips.map((k): MenuItem => ({ label: `Take ${k.number} · ${k.name}`, hint: formatMs(k.lengthMs), checked: k.id === cue.clipId,
      onClick: () => { if (k.id !== cue.clipId) o.run('POST', `/api/cues/${cue.id}/choose-clip`, { clipId: k.id }); } })),
    ...(cue.clips.length ? ['sep' as const] : []),
    { label: 'Record a take…', disabled: !!o.nav?.store.rec, onClick: () => o.nav?.record(cue.id) },
    { label: 'Choose audio…', onClick: o.chooseAudio },
    'sep',
    { label: 'Audio settings', disabled: !chosen, ...(o.panel ? { onClick: o.panel } : { sub: (close) => chosen ? createElement(Fragment, null,
      createElement(AudioSliders, { clip: chosen, run: o.run }),
      ...(o.edit ? [createElement('div', { key: 'sep', className: 'menu-sep' }),
        createElement('button', { key: 'edit', className: 'menu-item', onClick: () => { close(); o.edit?.(); } }, 'Edit volume envelope')] : [])) : null }) },
    { label: cue.muted ? 'Unmute audio' : 'Mute audio', disabled: !chosen, onClick: () => o.run('PATCH', `/api/cues/${cue.id}`, { muted: !cue.muted }) },
    { label: 'Remove audio', danger: true, disabled: !chosen, onClick: () => { if (chosen) o.removeAudio(); } },
  ];
}
