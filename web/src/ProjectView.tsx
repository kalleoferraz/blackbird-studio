import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { go } from './App.tsx';
import { TYPES } from './Projects.tsx';
import type { Language, Me, Member, ProjectCard } from './types.ts';
import { ago, formatBytes } from './format.ts';
import { Dialog, errorText } from './ui.tsx';

export function ProjectView({ me, projectId, onLogout }: { me: Me; projectId: string; onLogout: () => void }) {
  const [p, setP] = useState<ProjectCard | null>(null);
  const [langs, setLangs] = useState<Language[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const load = useCallback(async () => {
    try {
      setP(await api<ProjectCard>('GET', `/api/projects/${projectId}`));
      setMembers((await api<{ members: Member[] }>('GET', `/api/projects/${projectId}/members`)).members);
    } catch (e: any) { setError(e.status === 404 ? 'This project does not exist, or you are not a member.' : errorText(e)); }
  }, [projectId]);
  useEffect(() => { void load(); void api<{ languages: Language[] }>('GET', '/api/languages').then((r) => setLangs(r.languages)); }, [load]);

  const patch = async (body: object) => { try { setP(await api<ProjectCard>('PATCH', `/api/projects/${projectId}`, body)); setError(''); } catch (e) { setError(errorText(e)); } };
  if (error && !p) return <div className="page"><a href="#/">← Projects</a><p className="error">{error}</p></div>;
  if (!p) return <div className="center muted">Loading…</div>;
  const author = p.role === 'author';

  return (
    <div className="page">
      <header className="topbar"><a href="#/">← Projects</a><span className="grow" />
        <span className="muted">{me.user.displayName}</span><button onClick={onLogout}>Sign out</button></header>
      <div className="row"><div className="grow">
        <EditableText value={p.title} disabled={!author} className="h1" onSave={(v) => v.trim() && patch({ title: v.trim() })} />
        <EditableText value={p.subtitle ?? ''} placeholder="Add a subtitle" disabled={!author} className="sub" onSave={(v) => patch({ subtitle: v.trim() })} />
      </div>
        <button className="primary" onClick={() => go(`/p/${p.id}/s`)}>Open script</button></div>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Details</h2>
        <dl className="facts">
          <dt>Type</dt><dd>{TYPES.find((t) => t.id === p.type)?.label ?? p.type}</dd>
          <dt>Language</dt><dd>{author ? (
            <select value={p.language} onChange={(e) => void patch({ language: e.target.value })}>
              {langs.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}</select>) : p.language}</dd>
          <dt>Chapters</dt><dd>{p.chapterCount}</dd>
          <dt>Size</dt><dd>{formatBytes(p.sizeBytes)}</dd>
          <dt>Last edited</dt><dd>{ago(p.lastEditedAt)}</dd>
          <dt>Last snapshot</dt><dd>{ago(p.lastSnapshotAt)}{p.dirtySince && <span className="dirty"> · unsaved changes</span>}</dd>
          <dt>Repository folder</dt><dd>{p.repoFolder}</dd>
        </dl>
      </section>
      <MembersPanel projectId={p.id} members={members} me={me} author={author} onChange={load} setError={setError} />
      {author && <section className="card"><h2>Delete project</h2>
        <p className="muted">Removes the project and everything in it. Snapshots already in the repository are kept.</p>
        <button className="danger" onClick={() => setDeleting(true)}>Delete project…</button></section>}
      {deleting && <DeleteProject p={p} onClose={() => setDeleting(false)} />}
    </div>
  );
}

function EditableText({ value, onSave, className, placeholder, disabled }: { value: string; onSave: (v: string) => void; className?: string; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  if (disabled) return <div className={className}>{value}</div>;
  return <input className={'inline ' + (className ?? '')} value={text} placeholder={placeholder}
    onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(value); (e.target as HTMLInputElement).blur(); } }} />;
}

function MembersPanel({ projectId, members, me, author, onChange, setError }: {
  projectId: string; members: Member[]; me: Me; author: boolean; onChange: () => void; setError: (s: string) => void;
}) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: string; name: string; email: string }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => { void api<{ users: any[] }>('GET', `/api/projects/${projectId}/user-search?q=${encodeURIComponent(q.trim())}`)
      .then((r) => setFound(r.users.map((u) => ({ id: u.id ?? u.userId, name: u.name ?? u.displayName, email: u.email })))).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q, projectId]);
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setError(''); onChange(); } catch (e: any) { setError(e.code === 'last_author' ? 'A project needs at least one author.' : errorText(e)); } };
  return (
    <section className="card">
      <h2>Members</h2>
      <table className="table"><tbody>{members.map((m) => (
        <tr key={m.userId}>
          <td>{m.name}{m.userId === me.user.id && ' (you)'}</td><td className="muted">{m.email}</td>
          <td>{author ? (
            <select value={m.role} onChange={(e) => void run(() => api('PUT', `/api/projects/${projectId}/members/${m.userId}`, { role: e.target.value }))}>
              <option value="author">Author</option><option value="viewer">Viewer</option></select>) : m.role === 'author' ? 'Author' : 'Viewer'}</td>
          <td>{(author || m.userId === me.user.id) && <button className="danger" onClick={() => void run(async () => {
            await api('DELETE', `/api/projects/${projectId}/members/${m.userId}`);
            if (m.userId === me.user.id) go('/');
          })}>{m.userId === me.user.id ? 'Leave' : 'Remove'}</button>}</td>
        </tr>))}</tbody></table>
      {author && <div className="add-member">
        <input placeholder="Add someone from your teams (name or email)" value={q} onChange={(e) => setQ(e.target.value)} />
        {found.length > 0 && <div className="found">{found.map((u) => (
          <div key={u.id} className="row"><span className="grow">{u.name} <span className="muted">{u.email}</span></span>
            <button onClick={() => void run(async () => { await api('PUT', `/api/projects/${projectId}/members/${u.id}`, { role: 'viewer' }); setQ(''); })}>Add as viewer</button>
            <button onClick={() => void run(async () => { await api('PUT', `/api/projects/${projectId}/members/${u.id}`, { role: 'author' }); setQ(''); })}>Add as author</button></div>))}</div>}
        {q.trim().length >= 2 && found.length === 0 && <p className="muted">No one found. You can only add people who share a team with you.</p>}
      </div>}
    </section>
  );
}

function DeleteProject({ p, onClose }: { p: ProjectCard; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  return (
    <Dialog title="Delete project" onClose={onClose}>
      <p>This cannot be undone. Type the project title to confirm:</p>
      <p><strong>{p.title}</strong></p>
      <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <div className="row end"><button onClick={onClose}>Cancel</button>
        <button className="danger solid" disabled={typed !== p.title} onClick={async () => {
          try { await api('DELETE', `/api/projects/${p.id}`, { confirmTitle: typed }); go('/'); } catch (e) { setError(errorText(e)); }
        }}>Delete forever</button></div>
    </Dialog>
  );
}
