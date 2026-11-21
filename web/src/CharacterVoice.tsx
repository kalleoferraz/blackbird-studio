// A character's voice (Bible, decision log 2026-11-20): choose one (this project, the account, the public library),
// clone one from the Voice Samples folder, and the "Voice Settings": directions as text plus sliders.
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ContentSink } from './contentSink.ts';
import { ApiError, api, uploadFile } from './api.ts';
import type { Character, LibFile, LibListing, SegmentContent, VoiceSettings } from './types.ts';
import { Confirm, Dialog, errorText, useLocalState } from './ui.tsx';
import { useVoiceStatus } from './voiceStatus.ts';
import { useNav, useStoreValue } from './playback.ts';
import { ACCOUNT_FILTERS, PUBLIC_FILTERS, VOICE_LANGUAGES } from '../../src/shared/voice.ts';
import { VoiceFilterBar, type FilterValues } from './VoiceFilters.tsx';
import { MicRecorder, encodeWav, type Take } from './recorder.ts';

/** About how many credits a sample costs: one per character on most models, half on Turbo and Flash (ElevenLabs API pricing, Nov 2026). */
const sampleCredits = (text: string, model?: string) => Math.ceil(text.length * (/turbo|flash/.test(model ?? '') ? 0.5 : 1));

/**
 * The start of a cue spoken by a voice in the project's language (uses ElevenLabs credits; the same sample again is free).
 * `key` names what is playing, so one button shows "stop".
 */
function useSamplePlayer(projectId: string, characterId: string) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const stop = () => { audio.current?.pause(); audio.current = null; if (url.current) URL.revokeObjectURL(url.current); url.current = null; setPlaying(null); };
  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps
  const play = async (key: string, voiceId: string, text: string) => {
    if (playing === key) { stop(); return; }
    stop(); setError(''); setLoading(key);
    try {
      const res = await fetch(`/api/projects/${projectId}/voices/sample`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voiceId, text, characterId }),
      });
      if (!res.ok) { let m = `Error ${res.status}`; try { const j = await res.json(); m = j.message ?? j.error ?? m; } catch { /* not JSON */ } throw new Error(m); }
      url.current = URL.createObjectURL(await res.blob());
      const a = new Audio(url.current);
      a.onended = () => setPlaying(null);
      audio.current = a; setPlaying(key);
      await a.play();
    } catch (e) { setError(errorText(e)); setPlaying(null); }
    setLoading(null);
  };
  return { play, stop, playing, loading, error };
}

/** The sample text: the first few seconds of the cue selected in the script (under the playhead), editable. */
function useSampleText() {
  const nav = useNav();
  const cueId = useStoreValue(nav?.store, (st) => st.currentCueId(), '');
  const [text, setText] = useState('');
  const [found, setFound] = useState(false);
  useEffect(() => {
    if (!cueId) { setText(''); setFound(false); return; }
    void api<{ text: string }>('GET', `/api/cues/${cueId}/sample-text`)
      .then((r) => { setText(r.text); setFound(!!r.text); }).catch(() => { setText(''); setFound(false); });
  }, [cueId]);
  return { text, setText, found };
}

const SOURCE_LABEL = { account: 'from the account', public: 'from the public library', clone: 'cloned', designed: 'designed' } as const;

const HEAD_ICON = {
  // A list with a play mark: choose from the existing voices.
  choose: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M4 11h10M4 16h6" /><path d="M15 13.5v6l5-3z" /></svg>,
  // A wand with a spark: create a voice from a description.
  create: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20L15 9" /><path d="M13.5 7.5l3 3" /><path d="M18.5 2.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" /><path d="M7 3.5v3M5.5 5h3" /></svg>,
  // Two heads, one behind the other: clone a voice from recordings.
  clone: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2" /><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5" /><path d="M14.2 5.2a3.2 3.2 0 1 1 1.6 6" /><path d="M17.5 14.7c1.8.6 3.1 2.2 3.5 4.8" /></svg>,
};

export function CharacterVoice({ projectId, character, readOnly, onSaved }: {
  projectId: string; character: Character; readOnly: boolean; onSaved: (c: Character) => void;
}) {
  const status = useVoiceStatus();
  const nav = useNav();
  const cueId = useStoreValue(nav?.store, (st) => st.currentCueId(), '');
  const sink = useContext(ContentSink);
  const [context] = useLocalState('rs.genContext', true);
  const [picker, setPicker] = useState(false);
  const [clone, setClone] = useState(false);
  const [design, setDesign] = useState(false);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState(character.voiceDirection ?? '');
  const [settings, setSettings] = useState<VoiceSettings>(character.voiceSettings ?? {});
  // A take tried with the panel's settings, waiting for ✓ (keep) or × (drop).
  const [pending, setPending] = useState<{ id: string; cueId: string } | null>(null);
  const [trying, setTrying] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { setDirection(character.voiceDirection ?? ''); setSettings(character.voiceSettings ?? {}); }, [character.id, character.voiceDirection, character.voiceSettings]);
  useEffect(() => () => { audio.current?.pause(); }, []);
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

  const playPending = (id: string) => {
    audio.current?.pause();
    const a = new Audio(`/api/pending-takes/${id}`);
    a.onended = () => setPlaying(false);
    audio.current = a; setPlaying(true);
    void a.play().catch(() => setPlaying(false));
  };
  /** Keeps the waiting take as the cue's next take; `choose` makes the cue play it. */
  const keep = async (choose: boolean) => {
    const p = pending;
    if (!p) return;
    setPending(null); audio.current?.pause(); setPlaying(false);
    try {
      const c = await api<SegmentContent>('POST', `/api/pending-takes/${p.id}/keep`, { choose });
      sink?.(c);
      setNote(choose ? 'The take is saved and chosen for the cue.' : 'The take is saved as an alternative of the cue.');
    } catch (e) { setError(errorText(e)); }
  };
  const drop = async () => {
    const p = pending;
    setPending(null); audio.current?.pause(); setPlaying(false); setNote('');
    if (p) await api('DELETE', `/api/pending-takes/${p.id}`).catch(() => undefined);
  };
  /** The selected cue spoken by this voice with the panel's settings (saved or not); replays a waiting take. */
  const tryIt = async () => {
    if (playing) { audio.current?.pause(); setPlaying(false); return; }
    if (pending) { playPending(pending.id); return; }
    if (!cueId) return;
    setTrying(true); setError(''); setNote('');
    try {
      const r = await api<{ pendingId: string }>('POST', `/api/cues/${cueId}/generate/try`, {
        characterId: character.id, voiceDirection: direction.trim() || null, voiceSettings: clean(settings), context,
      });
      setPending({ id: r.pendingId, cueId });
      playPending(r.pendingId);
    } catch (e) { setError(errorText(e)); }
    setTrying(false);
  };
  /** A change of settings while a take waits keeps that take (as an alternative); the settings themselves are not saved. */
  const changing = <T,>(set: (v: T) => void) => (val: T) => { if (pending) void keep(false); set(val); };

  return (
    <section className="card voice-card">
      <h2 className="card-head">
        <span>Voice</span>
        {!readOnly && <span className="head-actions">
          <button type="button" title={v ? 'Change voice' : 'Choose voice'} aria-label={v ? 'Change voice' : 'Choose voice'} disabled={!canEdit || busy} onClick={() => setPicker(true)}>{HEAD_ICON.choose}</button>
          <button type="button" title="Create voice from a description" aria-label="Create voice" disabled={!canEdit || busy} onClick={() => setDesign(true)}>{HEAD_ICON.create}</button>
          <button type="button" title="Clone voice from recordings" aria-label="Clone voice" disabled={!canEdit || busy || !character.folder} onClick={() => setClone(true)}>{HEAD_ICON.clone}</button>
        </span>}
      </h2>
      {status && off && <p className="muted small">Voice options are off: {status.reason}</p>}
      <div className="voice-current">
        {v ? <><b>{v.name}</b> <span className="muted small">{v.source ? SOURCE_LABEL[v.source] : ''}</span></> : <span className="muted">No voice chosen.</span>}
      </div>
      {!readOnly && v && <div className="row voice-actions">
        {(v.source === 'clone' || v.source === 'designed') && <button type="button" disabled={!canEdit || busy} onClick={() => setManage(true)}>Manage voice…</button>}
        <button type="button" disabled={!canEdit || busy} onClick={() => void run(() => api<Character>('DELETE', `/api/characters/${character.id}/voice`))}>Remove voice</button>
      </div>}
      <label>Voice Settings (directions)
        <textarea rows={2} placeholder="for example: calm, warm, slightly tired" value={direction} disabled={readOnly} onChange={(e) => changing(setDirection)(e.target.value)} />
        <span className="muted small">Added to every take generated for this character as audio tags, such as [calm] [warm].</span></label>
      <VoiceSliders value={settings} disabled={readOnly} onChange={changing(setSettings)} />
      {!readOnly && <div className="row voice-foot">
        <button type="button" className="voice-ic voice-try" disabled={!canEdit || !v || (!cueId && !pending) || trying}
          title={!v ? 'Choose a voice first' : playing ? 'Stop' : pending ? 'Play the take again' : cueId ? 'Play the selected cue in this voice with these settings (uses credits)' : 'Select a cue in the script'}
          aria-label="Play the selected cue in this voice" onClick={() => void tryIt()}>
          {trying ? <span className="ic-wait">…</span> : playing ? ICON.stop : ICON.sample}</button>
        {pending && <>
          <button type="button" className="voice-ic keep-yes" title="Save this take for the cue" aria-label="Save the take" onClick={() => void keep(true)}>{ICON.check}</button>
          <button type="button" className="voice-ic keep-no" title="Ignore this take" aria-label="Ignore the take" onClick={() => void drop()}>{ICON.exclude}</button>
        </>}
        <span className="grow" />
        <button type="button" className="primary" disabled={busy || !changed} onClick={() => void saveSettings()}>Save settings</button>
      </div>}
      {note && <p className="muted small">{note}</p>}
      {error && <p className="error">{error}</p>}
      {picker && <VoicePicker projectId={projectId} character={character} onClose={() => setPicker(false)} onSaved={(c) => { setPicker(false); onSaved(c); }} onCharacterChanged={onSaved} />}
      {design && <DesignDialog projectId={projectId} character={character} onClose={() => setDesign(false)} onSaved={(c) => { setDesign(false); onSaved(c); }} />}
      {clone && character.folder && <CloneDialog projectId={projectId} character={character} onClose={() => setClone(false)} onSaved={(c) => { setClone(false); onSaved(c); }} />}
      {manage && v && <ManageClone projectId={projectId} voiceId={v.id} character={character} onClose={() => setManage(false)}
        onChanged={(ch) => onSaved(ch === 'removed' ? { ...character, voice: null } : { ...character, voice: { ...v, name: ch.name } })} />}
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

interface VoiceRow { voiceId: string; name: string; previewUrl: string | null; info: string; publicOwnerId?: string; note?: string; characters?: string[]; cloned?: boolean; source?: 'account' | 'public'; added?: boolean }

const svg = (children: ReactNode, fill = false) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>);
/** The voice row's icons. */
const ICON = {
  // A play triangle with a small four-armed star: a new sample, generated now.
  sample: svg(<><path d="M5 6.5v11l9-5.5z" fill="currentColor" /><path d="M19 2.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" strokeWidth="1" /></>),
  stop: svg(<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  check: svg(<path d="M5 12.5l4.5 4.5L19 7.5" />),
  // A person speaking: use this voice for the character.
  use: svg(<><circle cx="9" cy="8" r="3.3" /><path d="M2.8 20c.7-3.4 3.2-5.3 6.2-5.3s5.5 1.9 6.2 5.3" /><path d="M16.8 6.5c1.4 1.4 1.4 4.6 0 6M19.6 4c2.8 2.8 2.8 8.9 0 11.5" /></>),
  manage: svg(<><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>),
  include: svg(<path d="M9 14l-5-5 5-5M4 9h10.5a5.5 5.5 0 010 11H11" />),
  exclude: svg(<path d="M7 7l10 10M17 7L7 17" />),
};

/** A round icon button with its meaning in the tooltip and for screen readers. */
function IconButton({ title, children, className = '', ...rest }: { title: string; children: ReactNode; className?: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className={'voice-ic ' + className} title={title} aria-label={title} {...rest}>{children}</button>;
}
type Tab = 'project' | 'account' | 'public' | 'excluded';

function VoicePicker({ projectId, character, onClose, onSaved, onCharacterChanged }: {
  projectId: string; character: Character; onClose: () => void; onSaved: (c: Character) => void;
  /** The character's voice was renamed or removed while managing a clone (the picker stays open). */
  onCharacterChanged: (c: Character) => void;
}) {
  const [tab, setTab] = useState<Tab>('project');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<VoiceRow[]>([]);
  const [more, setMore] = useState<{ token?: string; page?: number } | null>(null);
  // The language filter: '' = the project's language (the server's default), 'all' = every language, or a code.
  const [langPick, setLangPick] = useState('');
  // The filters of each list, remembered in this browser.
  const [filterSets, setFilterSets] = useLocalState<{ account: FilterValues; public: FilterValues }>('rs.voiceFilters', { account: {}, public: {} });
  const filters = tab === 'account' || tab === 'public' ? (filterSets[tab] ?? {}) : {};
  const [projectLanguage, setProjectLanguage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [managing, setManaging] = useState<VoiceRow | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  useEffect(() => { void api<{ model: string }>('GET', `/api/projects/${projectId}/voices/settings`).then((r) => setModel(r.model)).catch(() => undefined); }, [projectId]);
  const sample = useSamplePlayer(projectId, character.id);
  const sampleText = useSampleText();
  useEffect(() => () => { audio.current?.pause(); }, []);

  const load = async (append: boolean) => {
    setLoading(true); setError('');
    try {
      const q = new URLSearchParams();
      if (search.trim() && (tab === 'account' || tab === 'public')) q.set('search', search.trim());
      if (langPick) q.set('language', langPick);
      if ((tab === 'account' || tab === 'public') && Object.keys(filters).length) q.set('f', JSON.stringify(filters));
      if (append && more?.token) q.set('pageToken', more.token);
      if (append && more?.page !== undefined) q.set('page', String(more.page));
      let got: VoiceRow[] = [], next: typeof more = null;
      if (tab === 'excluded') {
        const r = await api<{ voices: { voiceId: string; source: 'account' | 'public'; name: string; info: string | null; publicOwnerId: string | null; previewUrl: string | null }[] }>('GET', `/api/projects/${projectId}/voices/excluded`);
        got = r.voices.map((x) => ({ voiceId: x.voiceId, name: x.name, previewUrl: x.previewUrl, info: [x.source === 'public' ? 'public library' : 'account', x.info].filter(Boolean).join(' · '), source: x.source, publicOwnerId: x.publicOwnerId ?? undefined }));
      } else if (tab === 'project') {
        const r = await api<{ voices: { voiceId: string; name: string; previewUrl: string | null; category: string | null; source: string | null; missing: boolean; characters: string[] }[] }>('GET', `/api/projects/${projectId}/voices/project`);
        got = r.voices.map((x) => ({ voiceId: x.voiceId, name: x.name, previewUrl: x.previewUrl, info: x.characters.join(', '), note: x.missing ? 'No longer in the ElevenLabs account' : undefined }));
      } else if (tab === 'account') {
        const r = await api<{ projectLanguage: string | null; voices: { voiceId: string; name: string; previewUrl: string | null; category: string | null; labels: Record<string, string> }[]; nextPageToken: string | null }>('GET', `/api/projects/${projectId}/voices/account?${q}`);
        setProjectLanguage(r.projectLanguage);
        got = r.voices.map((x) => ({ voiceId: x.voiceId, name: x.name, previewUrl: x.previewUrl, cloned: x.category === 'cloned' || x.category === 'generated', info: [x.category, ...Object.values(x.labels ?? {})].filter(Boolean).join(' · ') }));
        next = r.nextPageToken ? { token: r.nextPageToken } : null;
      } else {
        const page = append ? more?.page ?? 0 : 0;
        q.set('page', String(page));
        const r = await api<{ projectLanguage: string | null; hasMore: boolean; nextPage: number; voices: { voiceId: string; publicOwnerId: string; name: string; language: string | null; locale: string | null; previewUrl: string | null; category: string | null; accent: string | null; gender: string | null; age: string | null; freeUsersAllowed: boolean | null; isAddedByUser: boolean | null; useCase: string | null; descriptive: string | null; featured: boolean | null; clonedByCount: number | null }[] }>('GET', `/api/projects/${projectId}/voices/public?${q}`);
        setProjectLanguage(r.projectLanguage);
        got = r.voices.map((x) => ({ voiceId: x.voiceId, publicOwnerId: x.publicOwnerId, name: x.name, previewUrl: x.previewUrl,
          info: [x.featured ? '★ featured' : '', x.locale ?? x.language, x.gender, x.age?.replace(/_/g, ' '), x.accent, x.descriptive, x.useCase?.replace(/_/g, ' '), x.category?.replace(/_/g, ' '),
            x.clonedByCount ? `cloned ${x.clonedByCount.toLocaleString()}×` : ''].filter(Boolean).join(' · '),
          added: !!x.isAddedByUser,
          note: [x.freeUsersAllowed === false ? 'not open to free plans' : '', x.isAddedByUser ? 'already in the account' : ''].filter(Boolean).join(' · ') || undefined }));
        next = r.hasMore ? { page: r.nextPage } : null;
      }
      setRows((old) => (append ? [...old, ...got] : got)); setMore(next);
    } catch (e) { setError(errorText(e)); }
    setLoading(false);
  };
  const filterKey = JSON.stringify(filters);
  // Typing searches by itself, a moment after the last key (the magnifier or Enter search at once).
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) { typed.current = true; return; }
    if (tab !== 'account' && tab !== 'public') return;
    const t = setTimeout(() => { setRows([]); setMore(null); void load(false); }, 450);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRows([]); setMore(null); void load(false); }, [tab, langPick, filterKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const langName = (c: string | null) => VOICE_LANGUAGES.find((l) => l.code === c)?.name ?? c ?? '';
  const langOptions = projectLanguage && !VOICE_LANGUAGES.some((l) => l.code === projectLanguage) ? [{ code: projectLanguage, name: projectLanguage }, ...VOICE_LANGUAGES] : VOICE_LANGUAGES;

  const play = (r: VoiceRow) => {
    sample.stop();
    audio.current?.pause();
    if (playing === r.voiceId || !r.previewUrl) { setPlaying(null); return; }
    const a = new Audio(r.previewUrl);
    a.onended = () => setPlaying(null);
    audio.current = a; setPlaying(r.voiceId); void a.play().catch(() => setPlaying(null));
  };
  const [added, setAdded] = useState<Set<string>>(new Set());
  /** Adds a library voice to the account under its own name, without giving it to the character. */
  const addToAccount = async (r: VoiceRow) => {
    setBusy(true); setError('');
    try {
      await api('POST', `/api/projects/${projectId}/voices/add`, { voiceId: r.voiceId, publicOwnerId: r.publicOwnerId, name: r.name.slice(0, 100) });
      setAdded((s) => new Set(s).add(r.voiceId));
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  /** Takes a voice out of this project's searches, now and later (kept in the app; ElevenLabs has no such list). */
  const exclude = async (r: VoiceRow) => {
    setBusy(true); setError('');
    try {
      await api('POST', `/api/projects/${projectId}/voices/excluded`, { voiceId: r.voiceId, source: tab === 'public' ? 'public' : 'account', name: r.name, info: r.info, publicOwnerId: r.publicOwnerId, previewUrl: r.previewUrl });
      setRows((old) => old.filter((x) => x.voiceId !== r.voiceId));
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const include = async (r: VoiceRow) => {
    setBusy(true); setError('');
    try { await api('DELETE', `/api/projects/${projectId}/voices/excluded/${r.voiceId}`); setRows((old) => old.filter((x) => x.voiceId !== r.voiceId)); }
    catch (e) { setError(errorText(e)); }
    setBusy(false);
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
        {(['project', 'account', 'public', 'excluded'] as const).map((t) => (
          <button key={t} type="button" className={tab === t ? 'primary' : ''} onClick={() => setTab(t)}>
            {t === 'project' ? 'This project' : t === 'account' ? 'My account' : t === 'public' ? 'Public library' : 'Excluded'}</button>))}
      </div>
      {(tab === 'account' || tab === 'public') && <form className="voice-search" onSubmit={(e) => { e.preventDefault(); void load(false); }}>
        <div className="vs-field">
          <input placeholder="Search by name, accent, description…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="submit" className="vs-go" disabled={loading} title="Search" aria-label="Search">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></svg>
          </button>
        </div>
        <div className="vs-filters">
        <select value={langPick} title="Voice language" onChange={(e) => setLangPick(e.target.value)}>
          <option value="all">All languages</option>
          <option value="">{projectLanguage ? `${langName(projectLanguage)} (project)` : 'Project language'}</option>
          {projectLanguage !== 'en' && <option value="en">English</option>}
          {langOptions.filter((l) => l.code !== projectLanguage && l.code !== 'en').map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <VoiceFilterBar defs={tab === 'account' ? ACCOUNT_FILTERS : PUBLIC_FILTERS} value={filters}
          onChange={(v) => setFilterSets({ ...filterSets, [tab]: v })} />
        </div>
      </form>}
      <div className="sample-bar">
        <input value={sampleText.text} maxLength={200} onChange={(e) => sampleText.setText(e.target.value)} aria-label="Sample text"
          placeholder="Sample text: select a cue in the script, or type a line"
          title={`Spoken by a voice's new-sample icon, in the project's language with ${character.name}'s directions: about ${sampleCredits(sampleText.text, model)} credits per voice, free to hear again`} />
      </div>
      {sample.error && <p className="error">{sample.error}</p>}
      <ul className="voice-list fill">
        {rows.map((r) => (
          <li key={r.publicOwnerId ? r.publicOwnerId + '/' + r.voiceId : r.voiceId} className={r.voiceId === character.voice?.id ? 'current' : ''}>
            <button type="button" className="voice-play" disabled={!r.previewUrl} title={r.previewUrl ? 'Listen to the preview (free)' : 'No preview'} aria-label="Preview" onClick={() => play(r)}>{playing === r.voiceId ? ICON.stop : svg(<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />)}</button>
            <div className="grow"><b>{r.name}</b><div className="muted small">{r.info}{r.note ? <> · <span className="voice-note">{r.note}</span></> : null}</div></div>
            <div className="voice-acts">
            {tab === 'excluded'
              ? <IconButton title="Include again in this project's searches" onClick={() => void include(r)} disabled={busy}>{ICON.include}</IconButton>
              : <>
              <IconButton title={sample.playing === r.voiceId ? 'Stop the sample' : `New sample: this voice speaks the sample text (about ${sampleCredits(sampleText.text, model)} credits)`}
                disabled={!sampleText.text.trim() || (sample.loading !== null && sample.loading !== r.voiceId)}
                onClick={() => { audio.current?.pause(); setPlaying(null); void sample.play(r.voiceId, r.voiceId, sampleText.text.trim()); }}>
                {sample.playing === r.voiceId ? ICON.stop : sample.loading === r.voiceId ? <span className="ic-wait">…</span> : ICON.sample}</IconButton>
              {tab === 'public' && <IconButton title={added.has(r.voiceId) || r.added ? 'Already in your account' : 'Add to your account (without using it)'}
                disabled={busy || added.has(r.voiceId) || !!r.added} onClick={() => void addToAccount(r)}>{added.has(r.voiceId) || r.added ? ICON.check : ICON.plus}</IconButton>}
              {r.cloned && <IconButton title="Manage this voice (cloned or designed)" disabled={busy} onClick={() => setManaging(r)}>{ICON.manage}</IconButton>}
              <IconButton className={r.voiceId === character.voice?.id ? 'in-use' : ''} disabled={busy || r.voiceId === character.voice?.id}
                title={r.voiceId === character.voice?.id ? `${character.name}'s voice` : tab === 'public' ? `Use for ${character.name} (adds it to your account)` : `Use for ${character.name}`}
                onClick={() => void use(r)}>{ICON.use}</IconButton>
              </>}
            </div>
            {(tab === 'account' || tab === 'public') && <button type="button" className="voice-x" disabled={busy} title="Exclude from this project's searches (see the Excluded tab)" aria-label={`Exclude ${r.name}`}
              onClick={() => void exclude(r)}>{ICON.exclude}</button>}
          </li>))}
      </ul>
      {!loading && !rows.length && !error && <p className="muted">{tab === 'project' ? 'No character of this project has a voice yet.' : tab === 'excluded' ? 'No voice is excluded in this project.' : 'No voices found.'}</p>}
      {loading && <p className="muted">Loading…</p>}
      {more && !loading && <button type="button" onClick={() => void load(true)}>Load more</button>}
      {error && <p className="error">{error}</p>}
      <div className="row end"><button type="button" onClick={onClose}>Close</button></div>
      {managing && <ManageClone projectId={projectId} voiceId={managing.voiceId} character={character} onClose={() => { setManaging(null); void load(false); }}
        onChanged={(ch) => { if (managing.voiceId === character.voice?.id) onCharacterChanged(ch === 'removed' ? { ...character, voice: null } : { ...character, voice: { ...character.voice!, name: ch.name } }); }} />}
    </Dialog>);
}

const secs = (ms: number | null) => (ms === null ? '?' : `${(ms / 1000).toFixed(1)} s`);

function CloneDialog({ projectId, character, onClose, onSaved, addTo, onAdded }: {
  projectId: string; character: Character; onClose: () => void; onSaved?: (c: Character) => void;
  /** Adds the chosen samples to an existing clone instead of making a new one. */
  addTo?: { voiceId: string; name: string }; onAdded?: () => void;
}) {
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
    try {
      if (addTo) {
        await api('POST', `/api/projects/${projectId}/voices/clones/${addTo.voiceId}/samples`, { assetIds: chosen.map((f) => f.id), consent, removeNoise: noise });
        onAdded?.();
      } else onSaved?.(await api<Character>('POST', `/api/characters/${character.id}/voice/clone`, { assetIds: chosen.map((f) => f.id), consent, removeNoise: noise }));
    }
    catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  return (
    <Dialog title={addTo ? `Add samples to ${addTo.name}` : `Clone a voice for ${character.name}`} wide onClose={onClose}>
      <p className="muted small">Choose clean recordings of one speaker, without music, reverb or noise: each at least 5 seconds, 1 to 2 minutes in all. Files uploaded here are kept in {folder}.</p>
      <ul className="voice-list fill">
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
        <button type="button" className="primary" disabled={busy || !consent || !ready || (!addTo && total < 10_000)} onClick={() => void go()}>{busy ? 'Working…' : addTo ? 'Add samples' : 'Clone voice'}</button></div>
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

interface CloneDetail {
  voiceId: string; name: string; category: string | null; description: string | null;
  samples: { sampleId: string; fileName: string; durationSecs: number | null }[];
  usedBy: { characterId: string; name: string; projectId: string; project: string }[]; usedElsewhere: number;
}

/** Rename a cloned voice, change its description, listen to, add and remove its samples, or remove the voice. */
function ManageClone({ projectId, voiceId, character, onClose, onChanged }: {
  projectId: string; voiceId: string; character: Character; onClose: () => void; onChanged: (c: { name: string } | 'removed') => void;
}) {
  const base = `/api/projects/${projectId}/voices/clones/${voiceId}`;
  const [d, setD] = useState<CloneDetail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const [askSample, setAskSample] = useState<string | null>(null);
  const load = async () => {
    try { const r = await api<CloneDetail>('GET', base); setD(r); setName(r.name); setDescription(r.description ?? ''); } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(errorText(e)); } setBusy(false); };
  const save = () => run(async () => {
    const r = await api<{ name: string }>('PATCH', base, { name: name.trim(), description: description.trim() || null });
    onChanged({ name: r.name }); await load();
  });
  const changed = !!d && (name.trim() !== d.name || (description.trim() || null) !== (d.description || null));
  const users = d ? [...d.usedBy.map((u) => `${u.name} (${u.project})`), ...(d.usedElsewhere ? [`${d.usedElsewhere} character${d.usedElsewhere === 1 ? '' : 's'} in projects you are not a member of`] : [])] : [];
  return (
    <Dialog title={d?.category === 'generated' ? 'Manage designed voice' : 'Manage cloned voice'} wide onClose={() => { if (!busy) onClose(); }}>
      {!d && !error && <p className="muted">Loading…</p>}
      {d && <>
        <label>Name in the ElevenLabs account<input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
        <label>Description<textarea rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <div className="row end"><button type="button" className="primary" disabled={busy || !changed || !name.trim()} onClick={() => void save()}>Save</button></div>
        {d.category !== 'generated' && <>
        <h3 className="voice-sub">Samples</h3>
        <ul className="voice-list fill">
          {d.samples.map((x) => (
            <li key={x.sampleId}>
              <div className="grow">{x.fileName || x.sampleId}<div className="muted small">{x.durationSecs ? `${x.durationSecs.toFixed(1)} s` : ''}</div></div>
              <audio controls preload="none" src={`${base}/samples/${x.sampleId}/audio`} className="sample-mini" />
              <button type="button" disabled={busy || d.samples.length <= 1} title={d.samples.length <= 1 ? 'A clone needs at least one sample' : 'Remove this sample'} onClick={() => setAskSample(x.sampleId)}>Remove</button>
            </li>))}
        </ul>
        {!d.samples.length && <p className="muted small">ElevenLabs lists no samples for this voice.</p>}
        <div className="row"><button type="button" disabled={busy || !character.folder} onClick={() => setAdding(true)}>Add samples…</button></div>
        </>}
        <h3 className="voice-sub">Used by</h3>
        <p className="muted small">{users.length ? users.join(', ') : 'No character uses this voice.'}</p>
      </>}
      {error && <p className="error">{error}</p>}
      <div className="row end">
        {d && <button type="button" className="danger" disabled={busy} onClick={() => setAskRemove(true)}>Remove voice…</button>}
        <span className="grow" />
        <button type="button" disabled={busy} onClick={onClose}>Close</button>
      </div>
      {adding && d && <CloneDialog projectId={projectId} character={character} addTo={{ voiceId, name: d.name }} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />}
      {askSample && <Confirm title="Remove sample" danger confirmLabel="Remove" message="Remove this sample from the cloned voice in ElevenLabs? The file in the library stays."
        onConfirm={async () => { const id = askSample; setAskSample(null); await run(async () => { await api('DELETE', `${base}/samples/${id}`); await load(); }); }} onClose={() => setAskSample(null)} />}
      {askRemove && d && <Confirm title="Remove cloned voice" danger confirmLabel="Remove voice"
        message={`Remove "${d.name}" from the ElevenLabs account? This cannot be undone.${users.length ? ` These characters lose their voice: ${users.join(', ')}.` : ''} Takes already generated stay, and the sample files in the library stay.`}
        onConfirm={async () => { setAskRemove(false); await run(async () => { await api('DELETE', base); onChanged('removed'); onClose(); }); }} onClose={() => setAskRemove(false)} />}
    </Dialog>);
}

interface DesignPreview { generatedVoiceId: string; durationSecs: number | null; language: string | null; n: number }

/**
 * Voice Design: a voice made from a description (and, with the v3 model, a reference recording from the library).
 * The alternatives are heard here; the chosen one is saved as "Character (Project)" and becomes the character's voice,
 * or none is kept.
 */
function DesignDialog({ projectId, character, onClose, onSaved }: { projectId: string; character: Character; onClose: () => void; onSaved: (c: Character) => void }) {
  const sampleCue = useSampleText();
  const [description, setDescription] = useState((character.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000));
  const [ownText, setOwnText] = useState(false);
  const [text, setText] = useState('');
  const [model, setModel] = useState<'eleven_multilingual_ttv_v2' | 'eleven_ttv_v3'>('eleven_multilingual_ttv_v2');
  const [loudness, setLoudness] = useState(0.5);
  const [guidance, setGuidance] = useState(5);
  const [enhance, setEnhance] = useState(false);
  const [seed, setSeed] = useState('');
  const [refId, setRefId] = useState('');
  const [strength, setStrength] = useState(0.5);
  const [files, setFiles] = useState<LibFile[]>([]);
  const [list, setList] = useState<DesignPreview[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [played, setPlayed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'' | 'gen' | 'save'>('');
  const [error, setError] = useState('');
  const n = useRef(0);
  // Reference recordings: the audio files in the character's library folder and its Voice Samples.
  useEffect(() => {
    if (!character.folder) return;
    const base = `Characters/${character.folder}`;
    void Promise.all([base, `${base}/Voice Samples`].map((f) => api<LibListing>('GET', `/api/projects/${projectId}/library?folder=${encodeURIComponent(f)}`).catch(() => null)))
      .then((ls) => setFiles(ls.flatMap((l) => (l?.files ?? []).filter((f) => f.kind === 'audio' && f.status === 'ready'))));
  }, [projectId, character.folder]);
  useEffect(() => { if (!text && sampleCue.text) setText(sampleCue.text); }, [sampleCue.text]); // eslint-disable-line react-hooks/exhaustive-deps
  const textOk = !ownText || (text.trim().length >= 100 && text.trim().length <= 1000);
  const create = async () => {
    setBusy('gen'); setError('');
    try {
      const r = await api<{ text: string; previews: Omit<DesignPreview, 'n'>[] }>('POST', `/api/characters/${character.id}/voice/design`, {
        description: description.trim(), model, text: ownText ? text.trim() : null, loudness, guidanceScale: guidance, enhance,
        seed: seed.trim() ? Number(seed) : null, ...(model === 'eleven_ttv_v3' && refId ? { referenceAssetId: refId, promptStrength: strength } : {}),
      });
      setList((old) => [...old, ...r.previews.map((p) => ({ ...p, n: ++n.current }))]);
      if (!ownText && r.text) setText(r.text);
    } catch (e) { setError(errorText(e)); }
    setBusy('');
  };
  const save = async () => {
    if (!chosen) return;
    setBusy('save'); setError('');
    try { onSaved(await api<Character>('POST', `/api/characters/${character.id}/voice/design/save`, { generatedVoiceId: chosen, description: description.trim(), played: [...played] })); }
    catch (e) { setError(errorText(e)); setBusy(''); }
  };
  return (
    <Dialog title={`Create a voice for ${character.name}`} wide onClose={() => { if (!busy) onClose(); }}>
      <label>Description of the voice <span className="muted small">({description.length}/1000)</span>
        <textarea rows={3} maxLength={1000} value={description} disabled={!!busy} placeholder="For example: a warm, slightly hoarse Brazilian man in his sixties, calm and kind, speaking slowly"
          onChange={(e) => setDescription(e.target.value)} /></label>
      <div className="design-grid">
        <label>Model<select value={model} disabled={!!busy} onChange={(e) => setModel(e.target.value as typeof model)}>
          <option value="eleven_multilingual_ttv_v2">Voice design v2 (multilingual)</option><option value="eleven_ttv_v3">Voice design v3 (reference audio)</option></select></label>
        <label>Seed <span className="muted small">(optional: same seed, same voice)</span><input type="number" min={0} max={4294967295} value={seed} disabled={!!busy} onChange={(e) => setSeed(e.target.value)} /></label>
      </div>
      <div className="vs-row design-slider" title="From -1 (quietest) to 1 (loudest); 0 is about -24 LUFS">
        <span>Loudness</span><input type="range" min={-1} max={1} step={0.05} value={loudness} disabled={!!busy} onChange={(e) => setLoudness(Number(e.target.value))} /><span className="vs-val">{loudness.toFixed(2)}</span>
      </div>
      <div className="vs-row design-slider" title="Higher follows the description more strictly but can sound robotic; detailed descriptions work better lower">
        <span>Guidance</span><input type="range" min={0} max={10} step={0.5} value={guidance} disabled={!!busy} onChange={(e) => setGuidance(Number(e.target.value))} /><span className="vs-val">{guidance.toFixed(1)}</span>
      </div>
      <label className="vs-check"><input type="checkbox" checked={enhance} disabled={!!busy} onChange={(e) => setEnhance(e.target.checked)} /> Let ElevenLabs expand the description with more detail</label>
      {model === 'eleven_ttv_v3' && (files.length
        ? <>
          <label>Reference recording <span className="muted small">(optional, from {character.name}'s library)</span><select value={refId} disabled={!!busy} onChange={(e) => setRefId(e.target.value)}>
            <option value="">None</option>{files.map((f) => <option key={f.id} value={f.id}>{f.path.replace(`Characters/${character.folder}/`, '')}</option>)}</select></label>
          {refId && <div className="vs-row design-slider" title="0: mostly the recording; 1: mostly the description">
            <span>Prompt strength</span><input type="range" min={0} max={1} step={0.05} value={strength} disabled={!!busy} onChange={(e) => setStrength(Number(e.target.value))} /><span className="vs-val">{strength.toFixed(2)}</span>
          </div>}
        </>
        : <p className="muted small">No audio in {character.name}'s library yet to use as a reference.</p>)}
      <label className="vs-check"><input type="checkbox" checked={ownText} disabled={!!busy} onChange={(e) => setOwnText(e.target.checked)} /> Use my own sample text <span className="muted small">(otherwise one is written to fit the description)</span></label>
      {ownText && <label>Sample text <span className={'small ' + (textOk ? 'muted' : 'error')}>({text.trim().length}; 100 to 1000 characters)</span>
        <textarea rows={3} maxLength={1000} value={text} disabled={!!busy} onChange={(e) => setText(e.target.value)} /></label>}
      <div className="row">
        <span className="muted small grow">Each creation makes a few alternatives and uses credits.</span>
        <button type="button" className="primary" disabled={!!busy || !description.trim() || !textOk} onClick={() => void create()}>{busy === 'gen' ? 'Creating…' : list.length ? 'Create more' : 'Create'}</button>
      </div>
      {list.length > 0 && <>
        <h3 className="voice-sub">Alternatives <span className="muted small">(kept for 30 minutes; choose one to be {character.name}'s voice, or none)</span></h3>
        <ul className="voice-list">
          {list.map((p) => (
            <li key={p.generatedVoiceId}>
              <input type="radio" name="design-chosen" checked={chosen === p.generatedVoiceId} disabled={!!busy} onChange={() => setChosen(p.generatedVoiceId)} aria-label={`Alternative ${p.n}`} />
              <span className="sfx-n">{p.n}</span>
              <audio controls preload="auto" src={`/api/voice-previews/${p.generatedVoiceId}`} className="sample-audio grow"
                onPlay={() => setPlayed((s) => new Set(s).add(p.generatedVoiceId))} />
              <span className="muted small">{[p.language, p.durationSecs ? `${p.durationSecs.toFixed(1)} s` : ''].filter(Boolean).join(' · ')}</span>
            </li>))}
        </ul>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row end">
        <button type="button" disabled={!!busy} onClick={onClose}>{list.length ? 'None, close' : 'Close'}</button>
        <button type="button" className="primary" disabled={!!busy || !chosen} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : `Use for ${character.name}`}</button>
      </div>
    </Dialog>);
}
