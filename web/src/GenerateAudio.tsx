// "Generate audio…" (Bible, decision log 2026-11-20): from text (speech with the character's voice, a sound effect or
// music from the cue's text) or from a take (the voice changer). The result becomes the cue's next take, chosen.
import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { Character, Cue, SegmentContent } from './types.ts';
import { Dialog, errorText } from './ui.tsx';

export type GeneratePreset = 'default' | 'custom' | 'take';

const KIND = { speech: 'speech', sfx: 'a sound effect', music: 'music' } as const;

export function GenerateDialog({ cue, characters, preset, onContent, onClose }: {
  cue: Cue; characters: Character[]; preset: GeneratePreset; onContent: (c: SegmentContent) => void; onClose: () => void;
}) {
  const ch = characters.find((c) => c.id === cue.characterId) ?? null;
  const [mode, setMode] = useState<'text' | 'take'>(preset === 'take' ? 'take' : 'text');
  const [direction, setDirection] = useState('');
  const [context, setContext] = useState(false);
  const [source, setSource] = useState<string>(cue.clipId ?? cue.clips[0]?.id ?? '');
  const [noise, setNoise] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);
  const speech = cue.type === 'speech';
  const takes = cue.clips.filter((k) => k.status === 'ready');
  const go = async () => {
    setBusy(true); setError('');
    try {
      const body = mode === 'take' ? { mode, sourceClipId: source || undefined, removeNoise: noise } : { mode, direction: direction.trim() || null, context: speech && context };
      const r = await api<SegmentContent & { characterCost?: number | null }>('POST', `/api/cues/${cue.id}/generate`, body);
      onContent(r);
      onClose();
      return;
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  // Default runs at once: the cue's text, with the character's directions.
  useEffect(() => { if (preset === 'default' && !started.current) { started.current = true; void go(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const what = mode === 'take' ? `${ch?.name ?? 'the character'}'s voice` : KIND[cue.type];
  return (
    <Dialog title="Generate audio" onClose={() => { if (!busy) onClose(); }}>
      {speech && <div className="row gen-modes">
        <label className="vs-check"><input type="radio" checked={mode === 'text'} disabled={busy} onChange={() => setMode('text')} /> From text</label>
        <label className="vs-check"><input type="radio" checked={mode === 'take'} disabled={busy || !takes.length} onChange={() => setMode('take')} /> From take (voice changer)</label>
      </div>}
      {speech && <p className="muted small">{ch ? (ch.voice ? <>Voice: <b>{ch.voice.name}</b>{ch.voiceDirection ? <> · directions: {ch.voiceDirection}</> : null}</> : <>{ch.name} has no voice yet: choose or clone one in the character's view.</>) : 'This cue has no character.'}</p>}
      {mode === 'text' ? (
        <>
          <label>{speech ? 'Directions for this take (added to the character\'s)' : 'Extra description (added to the cue\'s text)'}
            <input value={direction} disabled={busy} placeholder={speech ? 'for example: nervous, whispering' : 'for example: distant, with echo'} onChange={(e) => setDirection(e.target.value)} />
          </label>
          {speech && <label className="vs-check"><input type="checkbox" checked={context} disabled={busy} onChange={(e) => setContext(e.target.checked)} /> Send the text of the cues before and after as context <span className="muted small">(smoother joins; not spoken)</span></label>}
          {!speech && <p className="muted small">{cue.lengthAuto ? 'The length is left to the model; the cue then takes the length of the audio.' : `Asked for the cue's length${cue.type === 'sfx' ? ' (a sound effect lasts at most 30 s; longer cues get a seamless loop)' : ''}.`}</p>}
        </>
      ) : (
        <>
          <label>Take to convert<select value={source} disabled={busy} onChange={(e) => setSource(e.target.value)}>
            {takes.map((k) => <option key={k.id} value={k.id}>Take {k.number} · {k.name}</option>)}
          </select></label>
          <label className="vs-check"><input type="checkbox" checked={noise} disabled={busy} onChange={(e) => setNoise(e.target.checked)} /> Remove background noise first</label>
        </>
      )}
      {busy && <p className="muted" role="status">Generating {what}… {cue.type === 'music' ? 'Music can take a few minutes.' : 'This can take a little while.'}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row end">
        <button type="button" disabled={busy} onClick={onClose}>{error ? 'Close' : 'Cancel'}</button>
        <button type="button" className="primary" disabled={busy || (mode === 'take' && !source)} onClick={() => void go()}>{error ? 'Try again' : 'Generate'}</button>
      </div>
    </Dialog>);
}

/** The submenu of "Generate audio…" in a cue's audio menu. */
export function GenerateSub({ cue, enabled, reason, onPick, close }: { cue: Cue; enabled: boolean; reason?: string; onPick: (p: GeneratePreset) => void; close: () => void }) {
  const pick = (p: GeneratePreset) => { close(); onPick(p); };
  const hasTake = cue.type === 'speech' && cue.clips.some((k) => k.status === 'ready');
  return (
    <div className="gen-sub">
      {!enabled && <p className="muted small">{reason ?? 'Voice options are off.'}</p>}
      <div className="menu-label">From text</div>
      <button className="menu-item" disabled={!enabled} onClick={() => pick('default')}><span className="menu-check" />Default</button>
      <button className="menu-item" disabled={!enabled} onClick={() => pick('custom')}><span className="menu-check" />Custom…</button>
      {cue.type === 'speech' && <>
        <div className="menu-label">From take</div>
        <button className="menu-item" disabled={!enabled || !hasTake} title={hasTake ? undefined : 'Record or choose a take first'} onClick={() => pick('take')}><span className="menu-check" />Voice changer…</button>
      </>}
    </div>);
}
