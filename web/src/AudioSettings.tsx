// The audio settings of a cue's chosen take: speed (the pitch kept), pitch (the speed kept) and level as sliders, shown in the audio menu
// and in the timeline's floating panel. The volume envelope is edited on the timeline cue itself (see Timeline.tsx).
import { useEffect, useState } from 'react';
import type { Clip } from './types.ts';
import { PITCH_MAX_CENTS, SPEED_MAX, SPEED_MIN } from '../../src/shared/audio-settings.ts';

const EDIT = 'rs-edit-audio';
/** Asks the timeline to open the cue for audio editing (the menu's "Edit volume envelope", a double click on the cue). */
export const editCueAudio = (cueId: string) => window.dispatchEvent(new CustomEvent(EDIT, { detail: { cueId } }));
export const onEditCueAudio = (fn: (cueId: string) => void) => {
  const on = (e: Event) => fn((e as CustomEvent<{ cueId: string }>).detail.cueId);
  window.addEventListener(EDIT, on);
  return () => window.removeEventListener(EDIT, on);
};

type Run = (method: 'PATCH', url: string, body?: unknown) => void;

/** Sliders with draggable controls: a change is sent when the control is let go (or a key is released). */
export function AudioSliders({ clip, run }: { clip: Clip; run: Run }) {
  const [speed, setSpeed] = useState(clip.speed);
  const [semi, setSemi] = useState(clip.pitchCents / 100);
  const [level, setLevel] = useState(clip.gainDb);
  useEffect(() => { setSpeed(clip.speed); setSemi(clip.pitchCents / 100); setLevel(clip.gainDb); }, [clip.id, clip.speed, clip.pitchCents, clip.gainDb]);
  const send = (body: object) => run('PATCH', `/api/clips/${clip.id}`, body);
  const row = (label: string, hint: string, value: number, min: number, max: number, step: number, set: (v: number) => void, text: string, reset: number, commit: (v: number) => void) => (
    <div className="as-row" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="as-name" title={hint}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label}
        onChange={(e) => set(Number(e.target.value))}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))} onKeyUp={(e) => commit(Number(e.currentTarget.value))} />
      <output>{text}</output>
      <button type="button" className="as-reset" title="Reset" disabled={value === reset} onClick={() => { set(reset); commit(reset); }}>↺</button>
    </div>
  );
  return (
    <div className="as-sliders">
      {row('Speed', 'Faster or slower, the pitch stays', speed, SPEED_MIN, SPEED_MAX, 0.05, setSpeed, `${speed.toFixed(2)}×`, 1, (v) => { if (v !== clip.speed) send({ speed: v }); })}
      {row('Pitch', 'Higher or lower, the speed stays', semi, -PITCH_MAX_CENTS / 100, PITCH_MAX_CENTS / 100, 0.5, setSemi, `${semi > 0 ? '+' : ''}${semi.toFixed(1)} st`, 0, (v) => { if (Math.round(v * 100) !== clip.pitchCents) send({ pitchCents: Math.round(v * 100) }); })}
      {row('Level', 'The whole take, in dB', level, -24, 12, 0.5, setLevel, `${level > 0 ? '+' : ''}${level.toFixed(1)} dB`, 0, (v) => { if (v !== clip.gainDb) send({ gainDb: v }); })}
    </div>
  );
}
