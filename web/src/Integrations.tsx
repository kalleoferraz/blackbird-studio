// The script's Integrations dialog: where snapshots go (GitHub) and the ElevenLabs plan, side by side.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { ago, formatDateTime } from './format.ts';
import { Dialog, errorText } from './ui.tsx';
import type { OutputFormat } from '../../src/shared/voice.ts';

interface Info {
  github: {
    configured: boolean; reason?: string; repo?: string; branch?: string | null; folder: string | null; folderUrl?: string | null;
    head?: { branch: string; sha: string; date: string | null; message: string; url: string } | null; headError?: string;
    lastSnapshot: { sha: string; revision: number; label: string | null; at: string; by: string | null; url?: string } | null;
    dirtySince: string | null; revision: number; lastEditedAt: string | null;
  };
  elevenlabs: {
    configured: boolean; reason?: string; model: string; outputFormat: string; own: { model: string | null; outputFormat: string | null }; planError?: string;
    plan?: { tier: string; status: string; characterCount: number; characterLimit: number; nextResetUnix: number | null; voiceLimit: number; voiceSlotsUsed: number; professionalVoiceLimit: number | null; canClone: boolean } | null;
  };
}

const short = (sha: string) => sha.slice(0, 7);
const Row = ({ k, children }: { k: string; children: ReactNode }) => <><dt>{k}</dt><dd>{children}</dd></>;
const Link = ({ href, children }: { href?: string | null; children: ReactNode }) => (href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <>{children}</>);

/** A quota as a bar: used of limit, turning orange from 80% and red when full. */
function Quota({ label, used, limit, unit = '' }: { label: string; used: number; limit: number; unit?: string }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  const n = (v: number) => v.toLocaleString();
  return (
    <div className="quota">
      <div className="quota-head"><span>{label}</span><span className="muted small">{n(used)} of {n(limit)}{unit} · {n(Math.max(0, limit - used))} left</span></div>
      <div className="quota-bar" role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={label}>
        <div className={'quota-fill' + (share >= 1 ? ' full' : share >= 0.8 ? ' high' : '')} style={{ width: `${share * 100}%` }} />
      </div>
    </div>);
}

export function IntegrationsDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); setError(''); try { setInfo(await api<Info>('GET', `/api/projects/${projectId}/integrations`)); } catch (e) { setError(errorText(e)); } setBusy(false); };
  useEffect(() => { void load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const g = info?.github, e = info?.elevenlabs;
  const changes = g?.dirtySince ? Math.max(1, g.revision - (g.lastSnapshot?.revision ?? 0)) : 0;
  return (
    <Dialog title="Integrations" wide onClose={onClose}>
      {!info && !error && <p className="muted">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {info && g && e && (
        <div className="integrations">
          <section className="integ-panel">
            <h3>ElevenLabs</h3>
            {!e.configured ? <p className="muted small">{e.reason}</p> : <>
              <dl className="integ-list">
                <Row k="Plan">{e.plan ? `${e.plan.tier || '—'}${e.plan.status ? ` · ${e.plan.status}` : ''}` : '—'}</Row>
                {e.plan && <Row k="Quota resets">{e.plan.nextResetUnix ? formatDateTime(e.plan.nextResetUnix * 1000) : '—'}</Row>}
                {e.plan && <Row k="Voice cloning">{e.plan.canClone ? 'allowed' : 'not in this plan'}</Row>}
              </dl>
              {e.plan && <>
                <Quota label="Characters" used={e.plan.characterCount} limit={e.plan.characterLimit} />
                <Quota label="Voice slots" used={e.plan.voiceSlotsUsed} limit={e.plan.voiceLimit} />
              </>}
              {e.planError && <p className="error small">{e.planError}</p>}
            </>}
            <ProjectVoiceSettings projectId={projectId} onSaved={() => void load()} />
          </section>
          <section className="integ-panel">
            <h3>GitHub snapshots</h3>
            {!g.configured ? <p className="muted small">{g.reason}</p> : (
              <dl className="integ-list">
                <Row k="Repository"><Link href={`https://github.com/${g.repo}`}>{g.repo}</Link></Row>
                <Row k="Branch">{g.head?.branch ?? g.branch ?? 'default'}</Row>
                <Row k="Project folder">{g.folder ? <Link href={g.folderUrl}>{g.folder}</Link> : <span className="muted">set at the first snapshot</span>}</Row>
                <Row k="Last snapshot">{g.lastSnapshot
                  ? <><Link href={g.lastSnapshot.url}><code>{short(g.lastSnapshot.sha)}</code></Link> {ago(g.lastSnapshot.at)}{g.lastSnapshot.by ? ` by ${g.lastSnapshot.by}` : ''}{g.lastSnapshot.label ? <div className="muted small">{g.lastSnapshot.label}</div> : null}</>
                  : <span className="muted">none yet</span>}</Row>
                <Row k="Branch head">{g.head
                  ? <><Link href={g.head.url}><code>{short(g.head.sha)}</code></Link> {g.head.date ? ago(g.head.date) : ''}<div className="muted small">{g.head.message}{g.lastSnapshot && g.head.sha !== g.lastSnapshot.sha ? ' (a later commit, possibly another project\'s)' : ''}</div></>
                  : <span className="error small">{g.headError ?? 'unknown'}</span>}</Row>
                <Row k="Not in a snapshot">{g.dirtySince ? <span className="dirty">{changes} saved change{changes === 1 ? '' : 's'}, the first {ago(g.dirtySince)}</span> : <span className="muted">no changes</span>}</Row>
                <Row k="Since last snapshot">{g.lastSnapshot ? ago(g.lastSnapshot.at) : '—'}</Row>
              </dl>)}
          </section>
        </div>)}
      <div className="row end"><button type="button" disabled={busy} onClick={() => void load()}>Refresh</button><button type="button" className="primary" onClick={onClose}>Close</button></div>
    </Dialog>);
}

interface VoiceSettingsInfo {
  model: string; outputFormat: string; own: { model: string | null; outputFormat: string | null }; canEdit: boolean;
  defaults: { model: string; outputFormat: string }; formats: OutputFormat[]; models: string[];
}

/** This media project's speech model and output format (empty = the default). */
function ProjectVoiceSettings({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const [v, setV] = useState<VoiceSettingsInfo | null>(null);
  const [model, setModel] = useState('');
  const [format, setFormat] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const show = (r: VoiceSettingsInfo) => { setV(r); setModel(r.own.model ?? ''); setFormat(r.own.outputFormat ?? ''); };
  useEffect(() => { void api<VoiceSettingsInfo>('GET', `/api/projects/${projectId}/voices/settings`).then(show).catch((e) => setNote({ ok: false, text: errorText(e) })); }, [projectId]);
  if (!v) return note ? <p className="error small">{note.text}</p> : null;
  const changed = model.trim() !== (v.own.model ?? '') || format !== (v.own.outputFormat ?? '');
  const save = async () => {
    setBusy(true); setNote(null);
    try {
      await api('PATCH', `/api/projects/${projectId}/voices/settings`, { model: model.trim() || null, outputFormat: format || null });
      show(await api<VoiceSettingsInfo>('GET', `/api/projects/${projectId}/voices/settings`)); setNote({ ok: true, text: 'Saved.' }); onSaved();
    } catch (e) { setNote({ ok: false, text: errorText(e) }); }
    setBusy(false);
  };
  const groups = (['MP3', 'PCM', 'WAV'] as const).map((g) => ({ g, items: v.formats.filter((f) => f.id.startsWith(g.toLowerCase())) }));
  const label = (id: string) => { const f = v.formats.find((x) => x.id === id); return f ? f.label : id; };
  return (
    <div className="integ-settings">
      <h4>This project</h4>
      <label>Speech model<input list="project-voice-models" value={model} disabled={!v.canEdit || busy} placeholder={`${v.defaults.model} (default)`} onChange={(e) => setModel(e.target.value)} autoComplete="off" />
        <datalist id="project-voice-models">{v.models.map((m) => <option key={m} value={m} />)}</datalist></label>
      <label>Output format<select value={format} disabled={!v.canEdit || busy} onChange={(e) => setFormat(e.target.value)}>
        <option value="">{label(v.defaults.outputFormat)} (default)</option>
        {groups.map(({ g, items }) => <optgroup key={g} label={g}>{items.map((f) => <option key={f.id} value={f.id}>{f.label}{f.plan ? ` (${f.plan} plan or higher)` : ''}</option>)}</optgroup>)}
      </select></label>
      <p className="muted small">A format the plan does not include is refused by ElevenLabs when audio is generated, and the studio shows why. Music has no WAV output, so WAV is asked for as PCM there.</p>
      {v.canEdit && <div className="row end"><button type="button" className="primary" disabled={busy || !changed} onClick={() => void save()}>Save</button></div>}
      {note && <p className={note.ok ? 'muted small' : 'error small'}>{note.text}</p>}
    </div>);
}
