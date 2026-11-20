// The audio menu of a cue (its takes, record, choose audio, mute, remove audio): the same in the script and in the timeline.
import { createElement } from 'react';
import type { EnvelopeKind } from '../../src/shared/audio-settings.ts';
import type { Cue } from './types.ts';
import { AudioSliders } from './AudioSettings.tsx';
import type { NavCtx } from './playback.ts';
import type { MenuItem } from './ui.tsx';
import { formatMs } from './format.ts';
import { GenerateSub, type GeneratePreset } from './GenerateAudio.tsx';
import type { VoiceStatus } from './voiceStatus.ts';

export function audioMenuItems(cue: Cue, o: {
  nav: NavCtx | null;
  /** Runs a change on the cue's content (POST choose-clip, DELETE clip). */
  run: (method: 'POST' | 'DELETE' | 'PATCH', url: string, body?: unknown) => void;
  chooseAudio: () => void;
  /** Opens "Generate audio" with a preset; absent where it is not offered. */
  generate?: (preset: GeneratePreset) => void;
  voice?: VoiceStatus | null;
  /** Asks what to do with the chosen audio (see RemoveAudioDialog). */
  removeAudio: () => void;
  /** Opens the cue in the timeline with the envelope of a setting to edit (and the settings panel); absent where there is no timeline (a phone). */
  edit?: (kind: EnvelopeKind) => void;
  /** On a phone: opens the audio panel above the player bar (sliders and envelope) instead of the submenu. */
  panel?: (kind?: EnvelopeKind) => void;
}): MenuItem[] {
  const chosen = cue.clips.find((k) => k.id === cue.clipId) ?? null;
  return [
    ...cue.clips.map((k): MenuItem => ({ label: `Take ${k.number} · ${k.name}`, hint: formatMs(k.lengthMs), checked: k.id === cue.clipId,
      onClick: () => { if (k.id !== cue.clipId) o.run('POST', `/api/cues/${cue.id}/choose-clip`, { clipId: k.id }); } })),
    ...(cue.clips.length ? ['sep' as const] : []),
    { label: 'Record a take…', disabled: cue.type !== 'speech' || !!o.nav?.store.rec, onClick: () => o.nav?.record(cue.id) },
    { label: 'Choose audio…', onClick: o.chooseAudio },
    ...(o.generate ? [{ label: 'Generate audio…', sub: (close: () => void) => createElement(GenerateSub, { cue, enabled: !!o.voice?.enabled, reason: o.voice?.reason, onPick: o.generate!, close }) } as MenuItem] : []),
    'sep',
    { label: 'Audio settings', disabled: !chosen, ...(o.panel ? { onClick: () => o.panel?.() } : { sub: (close) => chosen ? createElement(AudioSliders, { clip: chosen, run: o.run, onEnv: o.edit ? (k) => { close(); o.edit?.(k); } : undefined }) : null }) },
    { label: cue.muted ? 'Unmute audio' : 'Mute audio', disabled: !chosen, onClick: () => o.run('PATCH', `/api/cues/${cue.id}`, { muted: !cue.muted }) },
    { label: 'Remove audio', danger: true, disabled: !chosen, onClick: () => { if (chosen) o.removeAudio(); } },
  ];
}
