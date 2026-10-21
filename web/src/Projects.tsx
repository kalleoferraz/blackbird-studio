import { useCallback, useEffect, useState } from 'react';
import { api, assetUrl } from './api.ts';
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
  const load = useCallback(async () => setList((await api<{ projects: ProjectCard[] }>('GET', '/api/projects')).projects), []);
  useEffect(() => { void load(); }, [load]);
  if (password) return <ChangePassword onDone={(m) => { onMe(m); setPassword(false); }} onCancel={() => setPassword(false)} />;
  return (
    <div className="page">
      <header className="topbar"><Brand /><span className="grow" />
        <span className="muted">{me.user.displayName}</span>
        <button onClick={() => setPassword(true)}>Password</button><button onClick={onLogout}>Sign out</button></header>
      <div className="row"><h1 className="grow">Projects</h1><button className="primary" onClick={() => setCreating(true)}>New project</button></div>
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
