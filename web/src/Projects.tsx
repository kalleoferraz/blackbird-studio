import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, assetUrl } from './api.ts';
import { go } from './App.tsx';
import { ChangePassword } from './Login.tsx';
import type { Language, Me, ProjectCard } from './types.ts';
import { ago, formatBytes } from './format.ts';
import { Brand } from './Brand.tsx';
import { Dialog, errorText } from './ui.tsx';

export const TYPES = [
  { id: 'audiobook', label: 'Audiobook' }, { id: 'textbook', label: 'Textbook' }, { id: 'film', label: 'Film' },
  { id: 'series', label: 'Series' }, { id: 'podcast', label: 'Podcast' },
];

export function Projects({ me, onLogout, onMe }: { me: Me; onLogout: () => void; onMe: (m: Me) => void }) {
  const [list, setList] = useState<ProjectCard[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [clash, setClash] = useState<{ file: unknown; folder: string; suggestion: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => setList((await api<{ projects: ProjectCard[] }>('GET', '/api/projects')).projects), []);
  useEffect(() => { void load(); }, [load]);
  // Import: read the file, check that it is a project file, then let the server create it. When a project already
  // uses the file's repository folder, ask whether to import into another folder.
  const send = async (file: unknown, repoFolder?: string) => {
    setBusy(true);
    setMessage('');
    try {
      const r = await api<{ id: string }>('POST', '/api/projects/import', repoFolder === undefined ? { file } : { file, repoFolder });
      setClash(null);
      go(`/p/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'folder_taken') setClash({ file, folder: e.body.folder, suggestion: e.body.suggestion });
      else { setClash(null); setMessage(errorText(e)); }
    } finally { setBusy(false); }
  };
  const pick = async (f: File) => {
    let data: any;
    try { data = JSON.parse(await f.text()); } catch { setMessage(`"${f.name}" is not a project file: it is not valid JSON.`); return; }
    if (data?.format !== 'blackbird-project' || typeof data?.project?.title !== 'string') { setMessage(`"${f.name}" is not a project file exported from this app.`); return; }
    if (data.version !== 1) { setMessage(`"${f.name}" was made by a different version of the app (file version ${String(data.version)}).`); return; }
    await send(data);
  };
  if (password) return <ChangePassword onDone={(m) => { onMe(m); setPassword(false); }} onCancel={() => setPassword(false)} />;
  return (
    <div className="page">
      <header className="topbar"><Brand /><span className="grow" />
        <span className="muted">{me.user.displayName}</span>
        <button onClick={() => setPassword(true)}>Password</button><button onClick={onLogout}>Sign out</button></header>
      <div className="row"><h1 className="grow">Projects</h1><button disabled={busy} onClick={() => picker.current?.click()}>Import</button>
        <button className="primary" onClick={() => setCreating(true)}>New project</button>
        <input ref={picker} type="file" hidden accept=".json,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} /></div>
      {message && <p className="error">{message}</p>}
      {list === null ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">No projects yet. Create the first one.</p> : (
        <div className="grid">
          {list.map((p) => (
            <a key={p.id} className="project-card" href={`#/p/${p.id}`}>
              {p.coverAssetId && <div className="pc-cover"><img src={assetUrl(p.coverAssetId, true)} alt="" loading="lazy" /></div>}
              <div className="pc-type">{TYPES.find((t) => t.id === p.type)?.label ?? p.type} · {p.language}{p.role === 'viewer' && ' · view only'}</div>
              <div className="pc-title">{p.title}</div>
              {p.subtitle && <div className="pc-sub">{p.subtitle}</div>}
              <div className="pc-meta">{p.chapterCount} chapter{p.chapterCount === 1 ? '' : 's'} · {formatBytes(p.sizeBytes)}</div>
              <div className="pc-meta">Edited {ago(p.lastEditedAt)}{p.dirtySince && <span className="dirty" title="Changes not yet saved as a snapshot"> ●</span>}</div>
            </a>))}
        </div>)}
      {clash && <FolderClash folder={clash.folder} suggestion={clash.suggestion} busy={busy} onCancel={() => setClash(null)} onImport={(f) => void send(clash.file, f)} />}
      {creating && <NewProject onClose={() => setCreating(false)} onCreated={(id) => go(`/p/${id}`)} />}
    </div>
  );
}

function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [langs, setLangs] = useState<Language[]>([]);
  const [type, setType] = useState('audiobook');
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [language, setLanguage] = useState('en-US');
  const [error, setError] = useState('');
  useEffect(() => { void api<{ languages: Language[] }>('GET', '/api/languages').then((r) => setLangs(r.languages)); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try { const r = await api<ProjectCard>('POST', '/api/projects', { type, title: title.trim(), subtitle: subtitle.trim() || null, language }); onCreated(r.id); }
    catch (err) { setError(errorText(err)); }
  };
  return (
    <Dialog title="New project" onClose={onClose}>
      <form onSubmit={submit}>
        <label>Type<select value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
        <label>Title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Subtitle (optional)<input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} /></label>
        <label>Language<select value={language} onChange={(e) => setLanguage(e.target.value)}>
          {langs.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}</select></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!title.trim()}>Create</button></div>
      </form>
    </Dialog>
  );
}

function FolderClash({ folder, suggestion, busy, onCancel, onImport }: { folder: string; suggestion: string; busy: boolean; onCancel: () => void; onImport: (folder: string) => void }) {
  const [name, setName] = useState(suggestion);
  return (
    <Dialog title="Folder already in use" onClose={onCancel}>
      <p>A project with the repository folder <strong>{folder}</strong> already exists. Import this one into another folder?</p>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onImport(name.trim()); }}>
        <label>Folder name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <div className="row end"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy || !name.trim()}>Import into this folder</button></div>
      </form>
    </Dialog>
  );
}
