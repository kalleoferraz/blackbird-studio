// The audio settings of a cue's chosen take: speed (the pitch kept), pitch (the speed kept) and level as sliders, shown in the audio menu,
// in the timeline's floating panel and in the phone's panel. Each has a button that shows its envelope on the cue (see Timeline.tsx).
import { useEffect, useState } from 'react';
import type { Clip } from './types.ts';
import { LEVEL_MAX_DB, LEVEL_MIN_DB, PITCH_MAX_CENTS, SPEED_MAX, SPEED_MIN, type EnvelopeKind } from '../../src/shared/audio-settings.ts';

const EDIT = 'rs-edit-audio';
/** What is being edited on a cue: its envelope of one setting. */
export interface AudioEdit { cueId: string; kind: EnvelopeKind }
export const ENVELOPE_NAME: Record<EnvelopeKind, string> = { level: 'Level', pitch: 'Pitch', speed: 'Speed' };

/** Asks the timeline (or the phone's panel) to open the cue for editing the envelope of a setting (the level's by default). */
export const editCueAudio = (cueId: string, kind: EnvelopeKind = 'level') => window.dispatchEvent(new CustomEvent(EDIT, { detail: { cueId, kind } }));
export const onEditCueAudio = (fn: (e: AudioEdit) => void) => {
  const on = (e: Event) => fn((e as CustomEvent<AudioEdit>).detail);
  window.addEventListener(EDIT, on);
  return () => window.removeEventListener(EDIT, on);
};

type Run = (method: 'PATCH', url: string, body?: unknown) => void;

/** Sliders with draggable controls: a change is sent when the control is let go (or a key is released). `env` is the envelope shown on the cue. */
export function AudioSliders({ clip, run, env, onEnv }: { clip: Clip; run: Run; env?: EnvelopeKind | null; onEnv?: (k: EnvelopeKind) => void }) {
  const [speed, setSpeed] = useState(clip.speed);
  const [semi, setSemi] = useState(clip.pitchCents / 100);
  const [level, setLevel] = useState(clip.gainDb);
  useEffect(() => { setSpeed(clip.speed); setSemi(clip.pitchCents / 100); setLevel(clip.gainDb); }, [clip.id, clip.speed, clip.pitchCents, clip.gainDb]);
  const send = (body: object) => run('PATCH', `/api/clips/${clip.id}`, body);
  const has: Record<EnvelopeKind, boolean> = { speed: !!clip.speedPoints?.length, pitch: !!clip.pitchPoints?.length, level: !!clip.volumePoints?.length };
  const row = (kind: EnvelopeKind, hint: string, value: number, min: number, max: number, step: number, set: (v: number) => void, text: string, reset: number, commit: (v: number) => void) => (
    <div className="as-row" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="as-name" title={hint}>{ENVELOPE_NAME[kind]}</span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={ENVELOPE_NAME[kind]}
        onChange={(e) => set(Number(e.target.value))}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))} onKeyUp={(e) => commit(Number(e.currentTarget.value))} />
      <output>{text}</output>
      {onEnv && (
        <button type="button" className={'as-env' + (env === kind ? ' on' : '') + (has[kind] ? ' has' : '')} title={`Edit the ${ENVELOPE_NAME[kind].toLowerCase()} envelope on the cue`} aria-label={`Edit the ${ENVELOPE_NAME[kind].toLowerCase()} envelope`} onClick={() => onEnv(kind)}>
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M2 14 L7 6 L12 12 L18 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /><circle cx="7" cy="6" r="2" fill="currentColor" /><circle cx="12" cy="12" r="2" fill="currentColor" /><circle cx="18" cy="4" r="2" fill="currentColor" /></svg>
        </button>
      )}
      <button type="button" className="as-reset" title="Reset" disabled={value === reset} onClick={() => { set(reset); commit(reset); }}>↺</button>
    </div>
  );
  return (
    <div className="as-sliders">
      {row('speed', 'Faster or slower, the pitch stays', speed, SPEED_MIN, SPEED_MAX, 0.05, setSpeed, `${speed.toFixed(2)}×`, 1, (v) => { if (v !== clip.speed) send({ speed: v }); })}
      {row('pitch', 'Higher or lower, the speed stays', semi, -PITCH_MAX_CENTS / 100, PITCH_MAX_CENTS / 100, 0.5, setSemi, `${semi > 0 ? '+' : ''}${semi.toFixed(1)} st`, 0, (v) => { if (Math.round(v * 100) !== clip.pitchCents) send({ pitchCents: Math.round(v * 100) }); })}
      {row('level', 'The whole take, in dB', level, LEVEL_MIN_DB, LEVEL_MAX_DB, 0.5, setLevel, `${level > 0 ? '+' : ''}${level.toFixed(1)} dB`, 0, (v) => { if (v !== clip.gainDb) send({ gainDb: v }); })}
    </div>
  );
}
