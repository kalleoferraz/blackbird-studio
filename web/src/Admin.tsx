import { formatDateTime } from './format.ts';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Me } from './types.ts';
import { Brand } from './Brand.tsx';
import { Confirm, Dialog, errorText } from './ui.tsx';

interface AdminUser { id: string; email: string; displayName: string; isAdmin: boolean; disabled: boolean; mustChangePassword: boolean; memberships: { projectId: string; title: string; role: string }[] }
interface AdminTeam { id: string; name: string; members: { id: string; email: string; displayName: string }[] }

export function Admin({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [message, setMessage] = useState<string>('');
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [newUser, setNewUser] = useState({ email: '', displayName: '' });
  const [newTeam, setNewTeam] = useState('');
  const [confirmTeam, setConfirmTeam] = useState<AdminTeam | null>(null);
  const [rename, setRename] = useState<AdminTeam | null>(null);

  const load = useCallback(async () => {
    const u = await api<{ users: AdminUser[] }>('GET', '/api/admin/users');
    const t = await api<{ teams: AdminTeam[] }>('GET', '/api/admin/teams');
    setUsers(u.users); setTeams(t.teams);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = (fn: () => Promise<unknown>) => async () => {
    setMessage('');
    try { await fn(); await load(); } catch (e: any) {
      if (e.code === 'last_author') setMessage(`Cannot disable: sole author of ${e.body.projects.map((p: any) => `"${p.title}"`).join(', ')}.`);
      else setMessage(errorText(e));
    }
  };

  return (
    <div className="page">
      <header className="topbar"><Brand /><span className="muted">Administration</span><span className="grow" />
        <span className="muted">{me.user.email}</span><button onClick={onLogout}>Sign out</button></header>
      {message && <p className="error">{message}</p>}
      <section className="card">
        <h2>Accounts</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Projects</th><th /></tr></thead>
          <tbody>{users.filter((u) => !u.isAdmin).map((u) => (
            <tr key={u.id} className={u.disabled ? 'dim' : ''}>
              <td>{u.displayName}{u.disabled && ' (disabled)'}{u.mustChangePassword && ' (temporary password)'}</td>
              <td>{u.email}</td>
              <td>{u.memberships.map((m) => `${m.title} (${m.role === 'reader' ? 'viewer' : 'author'})`).join(', ') || '—'}</td>
              <td className="row end">
                <button onClick={act(async () => { const r = await api<{ temporaryPassword: string }>('POST', `/api/admin/users/${u.id}/reset-password`); setSecret({ email: u.email, password: r.temporaryPassword }); })}>Reset password</button>
                <button onClick={act(() => api('POST', `/api/admin/users/${u.id}/disabled`, { disabled: !u.disabled }))}>{u.disabled ? 'Enable' : 'Disable'}</button>
              </td>
            </tr>))}</tbody>
        </table>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => {
          const r = await api<{ temporaryPassword: string; email: string }>('POST', '/api/admin/users', newUser);
          setSecret({ email: r.email, password: r.temporaryPassword }); setNewUser({ email: '', displayName: '' });
        })(); }}>
          <input placeholder="Name" value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} />
          <input placeholder="Email" type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
          <button className="primary" disabled={!newUser.email || !newUser.displayName}>Create account</button>
        </form>
      </section>

      <section className="card">
        <h2>Teams</h2>
        <p className="muted">Authors can only add people who share a team with them.</p>
        {teams.map((t) => (
          <div key={t.id} className="team">
            <div className="row"><strong>{t.name}</strong><span className="grow" />
              <button onClick={() => setRename(t)}>Rename</button>
              <button className="danger" onClick={() => setConfirmTeam(t)}>Delete</button></div>
            <div className="chips">
              {t.members.map((m) => (
                <span key={m.id} className="chip">{m.displayName}
                  <button title="Remove" onClick={act(() => api('DELETE', `/api/admin/teams/${t.id}/members/${m.id}`))}>×</button></span>))}
              <select value="" onChange={(e) => { if (e.target.value) void act(() => api('PUT', `/api/admin/teams/${t.id}/members/${e.target.value}`))(); }}>
                <option value="">Add member…</option>
                {users.filter((u) => !u.isAdmin && !u.disabled && !t.members.some((m) => m.id === u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </div>
          </div>))}
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('POST', '/api/admin/teams', { name: newTeam }); setNewTeam(''); })(); }}>
          <input placeholder="New team name" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} />
          <button className="primary" disabled={!newTeam.trim()}>Create team</button>
        </form>
      </section>

      <SnapshotSettings />
      <VoiceSettingsCard />

      {secret && (
        <Dialog title="Temporary password" onClose={() => setSecret(null)}>
          <p>For <strong>{secret.email}</strong>. It is shown only now; the person must choose their own at first sign-in.</p>
          <div className="copy-row"><code className="secret">{secret.password}</code><CopyButton text={secret.password} /></div>
          <div className="row end"><button className="primary" onClick={() => setSecret(null)}>Done</button></div>
        </Dialog>)}
      {confirmTeam && <Confirm title="Delete team" danger confirmLabel="Delete" message={`Delete "${confirmTeam.name}"? Existing project members keep their access.`}
        onConfirm={act(() => api('DELETE', `/api/admin/teams/${confirmTeam.id}`))} onClose={() => setConfirmTeam(null)} />}
      {rename && <RenameTeam team={rename} onClose={() => setRename(null)} onSave={(n) => act(() => api('PATCH', `/api/admin/teams/${rename.id}`, { name: n }))()} />}
    </div>
  );
}

interface SnapshotConfig { repo: string | null; branch: string | null; tokenSet: boolean; tokenUnreadable: boolean; canStoreToken: boolean; source: { repo: string | null; branch: string | null; token: string | null } }

/** Where snapshots go: a GitHub repository and a token that can write to it. Saved here, so no server variables are needed. */
function SnapshotSettings() {
  const [cfg, setCfg] = useState<SnapshotConfig | null>(null);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [token, setToken] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const show = (c: SnapshotConfig) => { setCfg(c); setRepo(c.source.repo === 'app' ? c.repo ?? '' : ''); setBranch(c.source.branch === 'app' ? c.branch ?? '' : ''); setToken(''); };
  useEffect(() => { api<SnapshotConfig>('GET', '/api/admin/settings/snapshots').then(show).catch((e) => setNote({ ok: false, text: errorText(e) })); }, []);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setNote(null); try { await fn(); } catch (e) { setNote({ ok: false, text: errorText(e) }); } setBusy(false); };
  const save = () => run(async () => {
    const r = await api<SnapshotConfig>('PUT', '/api/admin/settings/snapshots', { repo, branch, ...(token ? { token } : {}) });
    show(r); setNote({ ok: true, text: 'Saved.' });
  });
  const test = () => run(async () => {
    const r = await api<{ ok: boolean; message: string }>('POST', '/api/admin/settings/snapshots/test', { repo: repo || undefined, branch: branch || undefined, ...(token ? { token } : {}) });
    setNote({ ok: r.ok, text: r.message });
  });
  const clearToken = () => run(async () => { show(await api<SnapshotConfig>('PUT', '/api/admin/settings/snapshots', { clearToken: true })); setNote({ ok: true, text: 'The saved token was removed.' }); });
  const state = !cfg ? '' : cfg.repo && cfg.tokenSet ? 'Snapshots are set up.' : `Snapshots are not set up: ${[!cfg.repo && 'no repository', !cfg.tokenSet && (cfg.tokenUnreadable ? 'the saved token can no longer be read' : 'no token')].filter(Boolean).join(', ')}.`;
  const from = (s: string | null) => (s === 'env' ? ' (now taken from the server settings)' : '');
  return (
    <section className="card">
      <h2>Snapshots</h2>
      <p className="muted">Saving a snapshot commits the project's text to a private GitHub repository. {state}</p>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Repository<input placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" />
          <span className="muted small">For example kalleoferraz/media-projects{cfg ? from(cfg.source.repo) : ''}</span></label>
        <label>Branch (optional)<input placeholder="the repository's default branch" value={branch} onChange={(e) => setBranch(e.target.value)} autoComplete="off" />
          <span className="muted small">{cfg ? from(cfg.source.branch) : ''}</span></label>
        <label>Access token<input type="password" placeholder={cfg?.tokenSet ? '•••••••• saved (type to replace)' : 'Paste a GitHub token'} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
          <span className="muted small">A fine-grained token with access to that repository and Contents: Read and write. It is stored encrypted and never shown again{cfg ? from(cfg.source.token) : ''}.</span></label>
        {cfg && !cfg.canStoreToken && <p className="error">A token cannot be stored: SESSION_SECRET is missing on this server.</p>}
        <div className="row">
          <button className="primary" disabled={busy || !cfg}>Save</button>
          <button type="button" disabled={busy || !cfg} onClick={() => void test()}>Test connection</button>
          {cfg?.source.token === 'app' && <button type="button" disabled={busy} onClick={() => void clearToken()}>Remove saved token</button>}
        </div>
      </form>
      {note && <p className={note.ok ? 'muted' : 'error'} role="status">{note.text}</p>}
    </section>
  );
}

interface VoiceConfig {
  apiUrl: string; keySet: boolean; keyUnreadable: boolean; canStoreKey: boolean;
  source: { apiUrl: string | null; key: string | null };
  defaults: { apiUrl: string };
}
interface Plan { tier: string; status: string; characterCount: number; characterLimit: number; nextResetUnix: number | null; voiceLimit: number; voiceSlotsUsed: number; canClone: boolean }

/** ElevenLabs: API URL (without a version) and key, plus the plan's figures. The speech model and output format are set per project (Integrations). */
function VoiceSettingsCard() {
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [apiUrl, setApiUrl] = useState('');
  const [key, setKey] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const show = (c: VoiceConfig) => {
    setCfg(c); setApiUrl(c.source.apiUrl === 'app' ? c.apiUrl : ''); setKey('');
  };
  const loadPlan = () => api<{ plan: Plan | null }>('GET', '/api/admin/settings/voices/plan').then((r) => setPlan(r.plan)).catch((e) => setNote({ ok: false, text: errorText(e) }));
  useEffect(() => {
    api<VoiceConfig>('GET', '/api/admin/settings/voices').then((c) => { show(c); if (c.keySet) void loadPlan(); }).catch((e) => setNote({ ok: false, text: errorText(e) }));
  }, []);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setNote(null); try { await fn(); } catch (e) { setNote({ ok: false, text: errorText(e) }); } setBusy(false); };
  const save = () => run(async () => {
    const r = await api<VoiceConfig>('PUT', '/api/admin/settings/voices', { apiUrl, ...(key ? { key } : {}) });
    show(r); setNote({ ok: true, text: 'Saved.' }); if (r.keySet) void loadPlan(); else setPlan(null);
  });
  const test = () => run(async () => {
    const r = await api<{ ok: boolean; message: string; plan?: Plan }>('POST', '/api/admin/settings/voices/test', { apiUrl: apiUrl || undefined, ...(key ? { key } : {}) });
    setNote({ ok: r.ok, text: r.message }); if (r.plan) setPlan(r.plan);
  });
  const clearKey = () => run(async () => { show(await api<VoiceConfig>('PUT', '/api/admin/settings/voices', { clearKey: true })); setPlan(null); setNote({ ok: true, text: 'The saved key was removed.' }); });
  const from = (s: string | null) => (s === 'env' ? ' (now taken from the server settings)' : '');
  const state = !cfg ? '' : cfg.keySet ? 'Voice features are on.' : `Voice features are off: ${cfg.keyUnreadable ? 'the saved key can no longer be read' : 'no API key'}.`;
  const n = (v: number) => v.toLocaleString();
  return (
    <section className="card">
      <h2>Voices (ElevenLabs)</h2>
      <p className="muted">Speech, sound effects, music and the voice changer in the studio use this ElevenLabs account. {state}</p>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>API URL<input placeholder={cfg?.defaults.apiUrl ?? 'https://api.elevenlabs.io'} value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} autoComplete="off" />
          <span className="muted small">Without a version: each call adds its own (for example /v1/text-to-speech, /v2/voices){cfg ? from(cfg.source.apiUrl) : ''}.</span></label>
        <label>API key<input type="password" placeholder={cfg?.keySet ? '•••••••• saved (type to replace)' : 'Paste an ElevenLabs API key'} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="new-password" />
          <span className="muted small">Stored encrypted and never shown again{cfg ? from(cfg.source.key) : ''}.</span></label>
        {cfg && !cfg.canStoreKey && <p className="error">A key cannot be stored: SESSION_SECRET is missing on this server.</p>}
        <p className="muted small">The speech model and the output format are chosen per media project, in the script's Integrations dialog.</p>
        <div className="row">
          <button className="primary" disabled={busy || !cfg}>Save</button>
          <button type="button" disabled={busy || !cfg} onClick={() => void test()}>Test key</button>
          {cfg?.source.key === 'app' && <button type="button" disabled={busy} onClick={() => void clearKey()}>Remove saved key</button>}
        </div>
      </form>
      {note && <p className={note.ok ? 'muted' : 'error'} role="status">{note.text}</p>}
      {plan && (
        <div className="voice-plan">
          <h3>Plan</h3>
          <dl>
            <dt>Plan</dt><dd>{plan.tier || '—'}{plan.status ? ` · ${plan.status}` : ''}</dd>
            <dt>Characters</dt><dd>{n(plan.characterCount)} of {n(plan.characterLimit)} used · {n(Math.max(0, plan.characterLimit - plan.characterCount))} left</dd>
            <dt>Resets</dt><dd>{plan.nextResetUnix ? formatDateTime(plan.nextResetUnix * 1000) : '—'}</dd>
            <dt>Voice slots</dt><dd>{plan.voiceSlotsUsed} of {plan.voiceLimit} used</dd>
            <dt>Voice cloning</dt><dd>{plan.canClone ? 'Allowed' : 'Not in this plan'}</dd>
          </dl>
          <button type="button" disabled={busy} onClick={() => void loadPlan()}>Refresh</button>
        </div>)}
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(t);
    }
    setDone(true); setTimeout(() => setDone(false), 2000);
  };
  return (
    <button type="button" className="copy-btn" onClick={() => void copy()} title="Copy to clipboard">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
        {done ? <path d="m3.500 8.500 3 3 6-7" /> : <><rect x="5.500" y="5.500" width="8" height="9" rx="1.500" /><path d="M10.500 5.500v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" /></>}
      </svg>{done ? 'Copied' : 'Copy'}
    </button>
  );
}

function RenameTeam({ team, onSave, onClose }: { team: AdminTeam; onSave: (n: string) => void; onClose: () => void }) {
  const [name, setName] = useState(team.name);
  return (
    <Dialog title="Rename team" onClose={onClose}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      <div className="row end"><button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!name.trim()} onClick={() => { onSave(name.trim()); onClose(); }}>Save</button></div>
    </Dialog>
  );
}
