// "Generate audio…" (Bible, decision log 2026-11-20): from text (speech with the character's voice, a sound effect or
// music from the cue's text) or from a take (the voice changer). The result becomes the cue's next take, chosen.
import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { Character, Cue, SegmentContent } from './types.ts';
import { Dialog, errorText, useLocalState } from './ui.tsx';

export type GeneratePreset = 'default' | 'custom' | 'take' | 'sfx';

const KIND = { speech: 'speech', sfx: 'a sound effect', music: 'music' } as const;

export function GenerateDialog({ cue, characters, preset, onContent, onClose }: {
  cue: Cue; characters: Character[]; preset: GeneratePreset; onContent: (c: SegmentContent) => void; onClose: () => void;
}) {
  if (preset === 'sfx' || cue.type === 'sfx') return <SfxDialog cue={cue} onContent={onContent} onClose={onClose} />;
  return <TextOrTakeDialog cue={cue} characters={characters} preset={preset} onContent={onContent} onClose={onClose} />;
}

function TextOrTakeDialog({ cue, characters, preset, onContent, onClose }: {
  cue: Cue; characters: Character[]; preset: GeneratePreset; onContent: (c: SegmentContent) => void; onClose: () => void;
}) {
  const ch = characters.find((c) => c.id === cue.characterId) ?? null;
  const [mode, setMode] = useState<'text' | 'take'>(preset === 'take' ? 'take' : 'text');
  const [direction, setDirection] = useState('');
  // On by default; the choice is remembered in this browser.
  const [context, setContext] = useLocalState('rs.genContext', true);
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

interface SfxSettings { prompt: string; durationMs: number | null; loop: boolean; promptInfluence: number; model: string; saved?: boolean }
interface Variation { id: string; contentType: string; n: number }
const PROMPT_MAX = 450;

/**
 * A sound-effect cue: the prompt (by default a copy of the cue's text; saved for regenerating, the script text is not
 * changed) and the settings the API accepts; 1 to 4 variations (one generation each), of which one or more are kept as takes.
 */
function SfxDialog({ cue, onContent, onClose }: { cue: Cue; onContent: (c: SegmentContent) => void; onClose: () => void }) {
  const [s, setS] = useState<SfxSettings | null>(null);
  const [count, setCount] = useLocalState('rs.sfxVariations', 2);
  const [vars, setVars] = useState<Variation[]>([]);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'gen' | 'keep' | 'save'>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const n = useRef(0);
  useEffect(() => { api<SfxSettings>('GET', `/api/cues/${cue.id}/sfx`).then(setS).catch((e) => setError(errorText(e))); }, [cue.id]);
  if (!s) return <Dialog title="Generate a sound effect" onClose={onClose}>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</Dialog>;
  const set = (p: Partial<SfxSettings>) => setS({ ...s, ...p });
  const body = { prompt: s.prompt, durationMs: s.durationMs, loop: s.loop, promptInfluence: s.promptInfluence, model: s.model };
  const run = async (kind: 'gen' | 'keep' | 'save', fn: () => Promise<void>) => { setBusy(kind); setError(''); setNote(''); try { await fn(); } catch (e) { setError(errorText(e)); } setBusy(''); };
  const generate = () => run('gen', async () => {
    const r = await api<{ variations: { id: string; contentType: string }[]; errors: string[] }>('POST', `/api/cues/${cue.id}/sfx/generate`, { ...body, variations: count });
    const added = r.variations.map((v) => ({ ...v, n: ++n.current }));
    setVars((old) => [...old, ...added]);
    setS({ ...s, saved: true });
    if (r.errors.length) setNote(`${r.errors.length} of ${count} could not be made: ${r.errors[0]}`);
  });
  const save = () => run('save', async () => { setS(await api<SfxSettings>('PUT', `/api/cues/${cue.id}/sfx`, body)); setNote('Settings saved.'); });
  const toggle = (id: string) => {
    const k = new Set(keep);
    if (k.has(id)) { k.delete(id); if (chosen === id) setChosen([...k][0] ?? null); } else { k.add(id); if (!chosen) setChosen(id); }
    setKeep(k);
  };
  const keepNow = () => run('keep', async () => {
    const ids = vars.filter((v) => keep.has(v.id)).map((v) => v.id);
    onContent(await api<SegmentContent>('POST', `/api/cues/${cue.id}/sfx/keep`, { variationIds: ids, chosen }));
    onClose();
  });
  const auto = s.durationMs === null;
  const valid = s.prompt.trim().length > 0 && s.prompt.length <= PROMPT_MAX;
  return (
    <Dialog title="Generate a sound effect" wide onClose={() => { if (!busy) onClose(); }}>
      <label>Prompt <span className="muted small">({s.prompt.length}/{PROMPT_MAX}; a copy of the cue's text at first, saved for regenerating; the script text stays as it is. ElevenLabs' examples are in English, which is the safest choice.)</span>
        <textarea rows={3} maxLength={PROMPT_MAX} value={s.prompt} disabled={!!busy} onChange={(e) => set({ prompt: e.target.value })} /></label>
      <div className="sfx-grid">
        <label className="vs-check"><input type="checkbox" checked={auto} disabled={!!busy} onChange={(e) => set({ durationMs: e.target.checked ? null : Math.min(30000, Math.max(500, cue.lengthMs)) })} /> Length chosen by the model</label>
        {!auto && <label className="sfx-len">Length (s)<input type="number" min={0.5} max={30} step={0.1} value={(s.durationMs! / 1000).toString()} disabled={!!busy}
          onChange={(e) => { const v = Math.round(Number(e.target.value) * 1000); if (Number.isFinite(v)) set({ durationMs: Math.min(30000, Math.max(500, v)) }); }} /></label>}
        <label className="vs-check"><input type="checkbox" checked={s.loop} disabled={!!busy} onChange={(e) => set({ loop: e.target.checked })} /> Seamless loop</label>
        <label>Model<select value={s.model} disabled={!!busy} onChange={(e) => set({ model: e.target.value })}>
          <option value="eleven_text_to_sound_v3">Sound effects v3</option><option value="eleven_text_to_sound_v2">Sound effects v2 (older)</option></select></label>
      </div>
      <div className="vs-row sfx-influence" title="Higher: follows the prompt closely, with less variety. Lower: more creative.">
        <span>Prompt influence</span>
        <input type="range" min={0} max={1} step={0.05} value={s.promptInfluence} disabled={!!busy} onChange={(e) => set({ promptInfluence: Number(e.target.value) })} />
        <span className="vs-val">{s.promptInfluence.toFixed(2)}</span><span className="muted small">{s.promptInfluence < 0.34 ? 'creative' : s.promptInfluence > 0.66 ? 'literal' : 'balanced'}</span>
      </div>
      <div className="row">
        <label className="sfx-count">Variations<select value={count} disabled={!!busy} onChange={(e) => setCount(Number(e.target.value))}>{[1, 2, 3, 4].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
        <span className="muted small grow">Each variation is a separate generation and uses credits.</span>
        <button type="button" disabled={!!busy || !valid} onClick={() => void save()}>Save settings</button>
        <button type="button" className="primary" disabled={!!busy || !valid} onClick={() => void generate()}>{busy === 'gen' ? 'Generating…' : vars.length ? 'Generate more' : 'Generate'}</button>
      </div>
      {vars.length > 0 && <>
        <h3 className="voice-sub">Variations <span className="muted small">(kept for 30 minutes; tick the ones to keep as takes, and pick the one the cue plays)</span></h3>
        <ul className="voice-list">
          {vars.map((v) => (
            <li key={v.id}>
              <input type="checkbox" checked={keep.has(v.id)} disabled={!!busy} onChange={() => toggle(v.id)} title="Keep as a take" />
              <span className="sfx-n">{v.n}</span>
              <audio controls preload="auto" src={`/api/sfx-variations/${v.id}`} className="sample-audio grow" />
              <label className="vs-check sfx-play"><input type="radio" name="sfx-chosen" checked={chosen === v.id} disabled={!keep.has(v.id) || !!busy} onChange={() => setChosen(v.id)} /> plays in cue</label>
            </li>))}
        </ul>
      </>}
      {note && <p className="muted small">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row end">
        <button type="button" disabled={!!busy} onClick={onClose}>{vars.length ? 'Close without keeping' : 'Close'}</button>
        <button type="button" className="primary" disabled={!!busy || !keep.size} onClick={() => void keepNow()}>{busy === 'keep' ? 'Saving…' : `Keep ${keep.size || ''} as take${keep.size === 1 ? '' : 's'}`}</button>
      </div>
    </Dialog>);
}
