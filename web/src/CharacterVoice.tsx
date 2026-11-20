// A character's voice (Bible, decision log 2026-11-20): choose one (this project, the account, the public library),
// clone one from the Voice Samples folder, and the "Voice Settings": directions as text plus sliders.
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, uploadFile } from './api.ts';
import type { Character, LibFile, LibListing, VoiceSettings } from './types.ts';
import { Dialog, errorText } from './ui.tsx';
import { useVoiceStatus } from './voiceStatus.ts';
import { VOICE_LANGUAGES } from '../../src/shared/voice.ts';
import { MicRecorder, encodeWav, type Take } from './recorder.ts';

const SOURCE_LABEL = { account: 'from the account', public: 'from the public library', clone: 'cloned' } as const;

export function CharacterVoice({ projectId, character, readOnly, onSaved }: {
  projectId: string; character: Character; readOnly: boolean; onSaved: (c: Character) => void;
}) {
  const status = useVoiceStatus();
  const [picker, setPicker] = useState(false);
  const [clone, setClone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState(character.voiceDirection ?? '');
  const [settings, setSettings] = useState<VoiceSettings>(character.voiceSettings ?? {});
  useEffect(() => { setDirection(character.voiceDirection ?? ''); setSettings(character.voiceSettings ?? {}); }, [character.id, character.voiceDirection, character.voiceSettings]);
  const off = !status?.enabled;
  const canEdit = !readOnly && !off;
  const changed = direction.trim() !== (character.voiceDirection ?? '') || JSON.stringify(clean(settings)) !== JSON.stringify(clean(character.voiceSettings ?? {}));
  const run = async (fn: () => Promise<Character>) => {
    setBusy(true); setError('');
    try { onSaved(await fn()); } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const saveSettings = () => run(() => api<Character>('PATCH', `/api/characters/${character.id}`, { voiceDirection: direction.trim() || null, voiceSettings: clean(settings) }));
  const v = character.voice;
  return (
    <section className="card voice-card">
      <h2 className="card-head">Voice</h2>
      {status && off && <p className="muted small">Voice options are off: {status.reason}</p>}
      <div className="voice-current">
        {v ? <><b>{v.name}</b> <span className="muted small">{v.source ? SOURCE_LABEL[v.source] : ''}</span></> : <span className="muted">No voice chosen.</span>}
      </div>
      {!readOnly && <div className="row voice-actions">
        <button type="button" disabled={!canEdit || busy} onClick={() => setPicker(true)}>{v ? 'Change voice…' : 'Choose voice…'}</button>
        <button type="button" disabled={!canEdit || busy || !character.folder} onClick={() => setClone(true)}>Clone voice…</button>
        {v && <button type="button" disabled={!canEdit || busy} onClick={() => void run(() => api<Character>('DELETE', `/api/characters/${character.id}/voice`))}>Remove voice</button>}
      </div>}
      <label>Voice Settings (directions)
        <textarea rows={2} placeholder="for example: calm, warm, slightly tired" value={direction} disabled={readOnly} onChange={(e) => setDirection(e.target.value)} />
        <span className="muted small">Added to every take generated for this character as audio tags, such as [calm] [warm].</span></label>
      <VoiceSliders value={settings} disabled={readOnly} onChange={setSettings} />
      {!readOnly && <div className="row end"><button type="button" className="primary" disabled={busy || !changed} onClick={() => void saveSettings()}>Save voice settings</button></div>}
      {error && <p className="error">{error}</p>}
      {picker && <VoicePicker projectId={projectId} character={character} onClose={() => setPicker(false)} onSaved={(c) => { setPicker(false); onSaved(c); }} />}
      {clone && character.folder && <CloneDialog projectId={projectId} character={character} onClose={() => setClone(false)} onSaved={(c) => { setClone(false); onSaved(c); }} />}
    </section>
  );
}

function clean(s: VoiceSettings): VoiceSettings | null {
  const o: VoiceSettings = {};
  for (const k of ['stability', 'similarity', 'style', 'speed'] as const) if (typeof s[k] === 'number') o[k] = s[k];
  if (typeof s.speakerBoost === 'boolean') o.speakerBoost = s.speakerBoost;
  return Object.keys(o).length ? o : null;
}

const SLIDERS = [
  { k: 'stability', label: 'Stability', min: 0, max: 1, step: 0.05, def: 0.5, hint: 'lower: a wider emotional range; higher: steadier' },
  { k: 'similarity', label: 'Similarity', min: 0, max: 1, step: 0.05, def: 0.75, hint: 'how closely it keeps to the original voice' },
  { k: 'style', label: 'Style', min: 0, max: 1, step: 0.05, def: 0, hint: 'exaggerates the style; above 0 may be slower' },
  { k: 'speed', label: 'Speed', min: 0.7, max: 1.2, step: 0.01, def: 1, hint: '1 is normal speed' },
] as const;

/** Sliders for the voice settings; a setting left unset keeps the voice's own value (shown as "voice default"). */
export function VoiceSliders({ value, disabled, onChange }: { value: VoiceSettings; disabled?: boolean; onChange: (v: VoiceSettings) => void }) {
  return (
    <div className="voice-sliders">
      {SLIDERS.map((s) => {
        const cur = value[s.k];
        return (
          <div key={s.k} className="vs-row" title={s.hint}>
            <span>{s.label}</span>
            <input type="range" min={s.min} max={s.max} step={s.step} value={cur ?? s.def} disabled={disabled}
              onChange={(e) => onChange({ ...value, [s.k]: Number(e.target.value) })} />
            <span className="vs-val">{typeof cur === 'number' ? cur.toFixed(2) : <span className="muted small">voice default</span>}</span>
            <button type="button" className="vs-reset" disabled={disabled || typeof cur !== 'number'} title="Use the voice's own value" onClick={() => onChange({ ...value, [s.k]: null })}>↺</button>
          </div>);
      })}
      <label className="vs-check"><input type="checkbox" disabled={disabled} checked={value.speakerBoost ?? true}
        onChange={(e) => onChange({ ...value, speakerBoost: e.target.checked })} /> Speaker boost <span className="muted small">(closer to the original speaker, a little slower)</span></label>
    </div>);
}

interface VoiceRow { voiceId: string; name: string; previewUrl: string | null; info: string; publicOwnerId?: string; note?: string; characters?: string[] }
type Tab = 'project' | 'account' | 'public';

function VoicePicker({ projectId, character, onClose, onSaved }: { projectId: string; character: Character; onClose: () => void; onSaved: (c: Character) => void }) {
  const [tab, setTab] = useState<Tab>('project');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<VoiceRow[]>([]);
  const [more, setMore] = useState<{ token?: string; page?: number } | null>(null);
  // The language filter: '' = the project's language (the server's default), 'all' = every language, or a code.
  const [langPick, setLangPick] = useState('');
  const [projectLanguage, setProjectLanguage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => () => { audio.current?.pause(); }, []);

  const load = async (append: boolean) => {
    setLoading(true); setError('');
    try {
      const q = new URLSearchParams();
      if (search.trim() && tab !== 'project') q.set('search', search.trim());
      if (langPick) q.set('language', langPick);
      if (append && more?.token) q.set('pageToken', more.token);
      if (append && more?.page !== undefined) q.set('page', String(more.page));
      let got: VoiceRow[] = [], next: typeof more = null;
      if (tab === 'project') {
        const r = await api<{ voices: { voiceId: string; name: string; previewUrl: string | null; category: string | null; source: string | null; missing: boolean; characters: string[] }[] }>('GET', `/api/projects/${projectId}/voices/project`);
        got = r.voices.map((x) => ({ voiceId: x.voiceId, name: x.name, previewUrl: x.previewUrl, info: x.characters.join(', '), note: x.missing ? 'No longer in the ElevenLabs account' : undefined }));
      } else if (tab === 'account') {
        const r = await api<{ projectLanguage: string | null; voices: { voiceId: string; name: string; previewUrl: string | null; category: string | null; labels: Record<string, string> }[]; nextPageToken: string | null }>('GET', `/api/projects/${projectId}/voices/account?${q}`);
        setProjectLanguage(r.projectLanguage);
        got = r.voices.map((x) => ({ voiceId: x.voiceId, name: x.name, previewUrl: x.previewUrl, info: [x.category, ...Object.values(x.labels ?? {})].filter(Boolean).join(' · ') }));
        next = r.nextPageToken ? { token: r.nextPageToken } : null;
      } else {
        const page = append ? more?.page ?? 0 : 0;
        q.set('page', String(page));
        const r = await api<{ projectLanguage: string | null; hasMore: boolean; voices: { voiceId: string; publicOwnerId: string; name: string; previewUrl: string | null; category: string | null; accent: string | null; gender: string | null; age: string | null; freeUsersAllowed: boolean | null; isAddedByUser: boolean | null }[] }>('GET', `/api/projects/${projectId}/voices/public?${q}`);
        setProjectLanguage(r.projectLanguage);
        got = r.voices.map((x) => ({ voiceId: x.voiceId, publicOwnerId: x.publicOwnerId, name: x.name, previewUrl: x.previewUrl,
          info: [x.gender, x.age, x.accent, x.category].filter(Boolean).join(' · '),
          note: [x.freeUsersAllowed === false ? 'not open to free plans' : '', x.isAddedByUser ? 'already in the account' : ''].filter(Boolean).join(' · ') || undefined }));
        next = r.hasMore ? { page: page + 1 } : null;
      }
      setRows((old) => (append ? [...old, ...got] : got)); setMore(next);
    } catch (e) { setError(errorText(e)); }
    setLoading(false);
  };
  useEffect(() => { setRows([]); setMore(null); void load(false); }, [tab, langPick]); // eslint-disable-line react-hooks/exhaustive-deps
  const langName = (c: string | null) => VOICE_LANGUAGES.find((l) => l.code === c)?.name ?? c ?? '';
  const langOptions = projectLanguage && !VOICE_LANGUAGES.some((l) => l.code === projectLanguage) ? [{ code: projectLanguage, name: projectLanguage }, ...VOICE_LANGUAGES] : VOICE_LANGUAGES;

  const play = (r: VoiceRow) => {
    audio.current?.pause();
    if (playing === r.voiceId || !r.previewUrl) { setPlaying(null); return; }
    const a = new Audio(r.previewUrl);
    a.onended = () => setPlaying(null);
    audio.current = a; setPlaying(r.voiceId); void a.play().catch(() => setPlaying(null));
  };
  const use = async (r: VoiceRow) => {
    setBusy(true); setError('');
    try {
      const body = tab === 'public' ? { source: 'public', voiceId: r.voiceId, publicOwnerId: r.publicOwnerId, name: r.name } : { source: 'account', voiceId: r.voiceId, name: r.name };
      onSaved(await api<Character>('PUT', `/api/characters/${character.id}/voice`, body));
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  return (
    <Dialog title={`Voice for ${character.name}`} wide onClose={onClose}>
      <div className="row voice-tabs">
        {(['project', 'account', 'public'] as const).map((t) => (
          <button key={t} type="button" className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>
            {t === 'project' ? 'This project' : t === 'account' ? 'My account' : 'Public library'}</button>))}
      </div>
      {tab !== 'project' && <form className="row voice-search" onSubmit={(e) => { e.preventDefault(); void load(false); }}>
        <input placeholder="Search by name, accent, description…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={langPick} title="Voice language" onChange={(e) => setLangPick(e.target.value)}>
          <option value="">{projectLanguage ? `${langName(projectLanguage)} (project)` : 'Project language'}</option>
          <option value="all">All languages</option>
          {langOptions.filter((l) => l.code !== projectLanguage).map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <button disabled={loading}>Search</button>
      </form>}
      {tab === 'account' && langPick !== 'all' && <p className="muted small">Multilingual voices can speak other languages too; choose "All languages" to see every voice in the account.</p>}
      {tab === 'public' && <p className="muted small">A public voice is added to the ElevenLabs account as "{character.name} (project title)".</p>}
      <ul className="voice-list">
        {rows.map((r) => (
          <li key={r.publicOwnerId ? r.publicOwnerId + '/' + r.voiceId : r.voiceId} className={r.voiceId === character.voice?.id ? 'current' : ''}>
            <button type="button" className="voice-play" disabled={!r.previewUrl} title={r.previewUrl ? 'Listen' : 'No preview'} onClick={() => play(r)}>{playing === r.voiceId ? '■' : '▶'}</button>
            <div className="grow"><b>{r.name}</b><div className="muted small">{r.info}{r.note ? <> · <span className="voice-note">{r.note}</span></> : null}</div></div>
            <button type="button" disabled={busy || r.voiceId === character.voice?.id} onClick={() => void use(r)}>{r.voiceId === character.voice?.id ? 'In use' : tab === 'public' ? 'Add and use' : 'Use'}</button>
          </li>))}
      </ul>
      {!loading && !rows.length && !error && <p className="muted">{tab === 'project' ? 'No character of this project has a voice yet.' : 'No voices found.'}</p>}
      {loading && <p className="muted">Loading…</p>}
      {more && !loading && <button type="button" onClick={() => void load(true)}>Load more</button>}
      {error && <p className="error">{error}</p>}
      <div className="row end"><button type="button" onClick={onClose}>Close</button></div>
    </Dialog>);
}

const secs = (ms: number | null) => (ms === null ? '?' : `${(ms / 1000).toFixed(1)} s`);

function CloneDialog({ projectId, character, onClose, onSaved }: { projectId: string; character: Character; onClose: () => void; onSaved: (c: Character) => void }) {
  const folder = `Characters/${character.folder}/Voice Samples`;
  const [files, setFiles] = useState<LibFile[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<LibFile[]>([]); // duplicates found elsewhere in the library
  const [consent, setConsent] = useState(false);
  const [noise, setNoise] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const load = async () => {
    try { setFiles((await api<LibListing>('GET', `/api/projects/${projectId}/library?folder=${encodeURIComponent(folder)}`)).files.filter((f) => f.kind === 'audio')); }
    catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const all = [...files, ...extra.filter((x) => !files.some((f) => f.id === x.id))];
  // Uploaded files are processed in the background: look again until they are ready.
  useEffect(() => {
    if (!all.some((f) => f.status === 'pending' || f.status === 'processing')) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  });
  const [recording, setRecording] = useState(false);
  const upload = async (list: FileList | File[]) => {
    setBusy(true); setError('');
    for (const f of Array.from(list)) {
      try {
        const a = await uploadFile<LibFile>('POST', `/api/projects/${projectId}/library/files?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(f.name)}`, f);
        setPicked((p) => new Set(p).add(a.id));
      } catch (e) {
        if (e instanceof ApiError && e.code === 'already_in_library' && e.body?.assetId) {
          setPicked((p) => new Set(p).add(e.body.assetId));
          setExtra((x) => [...x, { id: e.body.assetId, name: f.name, path: e.body.path, kind: 'audio', status: 'ready', durationMs: null } as LibFile]);
          setError(`${f.name} is already in the library at ${e.body.path}; that file is used.`);
        } else setError(errorText(e));
      }
    }
    await load(); setBusy(false);
  };
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = all.filter((f) => picked.has(f.id));
  const total = chosen.reduce((s, f) => s + (f.durationMs ?? 0), 0);
  const ready = chosen.length > 0 && chosen.every((f) => f.status === 'ready');
  const go = async () => {
    setBusy(true); setError('');
    try { onSaved(await api<Character>('POST', `/api/characters/${character.id}/voice/clone`, { assetIds: chosen.map((f) => f.id), consent, removeNoise: noise })); }
    catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  return (
    <Dialog title={`Clone a voice for ${character.name}`} wide onClose={onClose}>
      <p className="muted small">Choose clean recordings of one speaker, without music, reverb or noise: each at least 5 seconds, 1 to 2 minutes in all. Files uploaded here are kept in {folder}.</p>
      <ul className="voice-list">
        {all.map((f) => (
          <li key={f.id}>
            <input type="checkbox" checked={picked.has(f.id)} disabled={f.status !== 'ready'} onChange={() => toggle(f.id)} />
            <div className="grow">{f.name}<div className="muted small">{f.status === 'ready' ? secs(f.durationMs) : f.status === 'failed' ? 'could not be processed' : 'processing…'}{f.path && !f.path.startsWith(folder) ? ` · ${f.path}` : ''}</div></div>
          </li>))}
      </ul>
      {!all.length && <p className="muted">No samples in {folder} yet.</p>}
      <div className="row">
        <button type="button" disabled={busy || recording} onClick={() => input.current?.click()}>Upload samples…</button>
        <button type="button" disabled={busy || recording} onClick={() => setRecording(true)}>Record a sample…</button>
        <span className="muted small">Chosen: {chosen.length} file{chosen.length === 1 ? '' : 's'}, {secs(total)}</span>
      </div>
      {recording && <SampleRecorder characterName={character.name} onCancel={() => setRecording(false)}
        onSave={async (f) => { setRecording(false); await upload([f]); }} />}
      <input ref={input} type="file" accept="audio/*,.wav,.mp3" multiple hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
      <label className="vs-check"><input type="checkbox" checked={noise} onChange={(e) => setNoise(e.target.checked)} /> Remove background noise <span className="muted small">(may lower quality on clean samples)</span></label>
      <label className="vs-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I have the right and the consent of the speaker to clone this voice.</label>
      {error && <p className="error">{error}</p>}
      <div className="row end"><button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !consent || !ready || total < 10_000} onClick={() => void go()}>{busy ? 'Working…' : 'Clone voice'}</button></div>
    </Dialog>);
}

const clock = (ms: number) => { const t = Math.floor(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

/**
 * Records a voice sample with the microphone (the same recorder as takes: mono, no automatic processing, a 24-bit WAV),
 * lets it be heard, and hands it over as a file for the Voice Samples folder.
 */
function SampleRecorder({ characterName, onSave, onCancel }: { characterName: string; onSave: (f: File) => Promise<void>; onCancel: () => void }) {
  const mic = useRef<MicRecorder | null>(null);
  const [state, setState] = useState<'idle' | 'opening' | 'recording' | 'done'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const started = useRef(0);
  useEffect(() => () => { mic.current?.close(); }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => {
    if (state !== 'recording') return;
    const t = setInterval(() => setElapsed(Date.now() - started.current), 200);
    return () => clearInterval(t);
  }, [state]);
  const start = async () => {
    setError(''); setState('opening');
    try {
      mic.current = await MicRecorder.open();
      mic.current.start(); started.current = Date.now(); setElapsed(0); setState('recording');
    } catch (e) { setError(errorText(e)); setState('idle'); }
  };
  const stop = async () => {
    const m = mic.current; mic.current = null;
    if (!m) return;
    const t = await m.stop();
    const b = encodeWav(t, 0, t.durationMs);
    const d = new Date(), two = (n: number) => String(n).padStart(2, '0');
    setTake(t); setBlob(b); setUrl(URL.createObjectURL(b)); setState('done');
    setName(`${characterName} sample ${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`);
  };
  const again = () => { setTake(null); setBlob(null); setUrl(null); setState('idle'); };
  const short = !!take && take.durationMs < 5000;
  return (
    <div className="sample-rec">
      <p className="muted small">Read a passage in the character's voice, close to the microphone, in a quiet room. Keep the tone even; 1 to 2 minutes in all is best, and each sample needs at least 5 seconds.</p>
      {state !== 'done' ? (
        <div className="row">
          {state === 'recording'
            ? <button type="button" className="danger solid" onClick={() => void stop()}>■ Stop</button>
            : <button type="button" className="primary" disabled={state === 'opening'} onClick={() => void start()}>● Record</button>}
          <span className={state === 'recording' ? 'rec-clock on' : 'rec-clock'}>{clock(elapsed)}</span>
          <span className="grow" />
          <button type="button" disabled={state === 'recording'} onClick={onCancel}>Cancel</button>
        </div>
      ) : (
        <>
          {url && <audio controls src={url} className="sample-audio" />}
          <label>File name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          {short && <p className="error">This sample is shorter than 5 seconds; record a longer one.</p>}
          <div className="row end">
            <button type="button" onClick={onCancel}>Discard</button>
            <button type="button" onClick={again}>Record again</button>
            <button type="button" className="primary" disabled={short || !name.trim() || !blob}
              onClick={() => { if (blob) void onSave(new File([blob], `${name.trim().replace(/\.wav$/i, '')}.wav`, { type: 'audio/wav' })); }}>Save to Voice Samples</button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>);
}
