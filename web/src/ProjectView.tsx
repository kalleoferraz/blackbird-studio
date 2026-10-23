import { useCallback, useEffect, useRef, useState } from 'react';
import { api, assetUrl, downloadAs, startDownload, uploadFile } from './api.ts';
import { go } from './App.tsx';
import { TYPES } from './Projects.tsx';
import type { Language, Me, Member, ProjectCard } from './types.ts';
import { ago, formatBytes } from './format.ts';
import { BlackbirdIcon } from './Brand.tsx';
import { Confirm, Dialog, errorText } from './ui.tsx';
import { readZipEntry, readZipIndex } from './zip.ts';

export function ProjectView({ me, projectId, onLogout }: { me: Me; projectId: string; onLogout: () => void }) {
  const [p, setP] = useState<ProjectCard | null>(null);
  const [langs, setLangs] = useState<Language[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState<File | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try {
      setP(await api<ProjectCard>('GET', `/api/projects/${projectId}`));
      setMembers((await api<{ members: Member[] }>('GET', `/api/projects/${projectId}/members`)).members);
    } catch (e: any) { setError(e.status === 404 ? 'This project does not exist, or you are not a member.' : errorText(e)); }
  }, [projectId]);
  useEffect(() => { void load(); void api<{ languages: Language[] }>('GET', '/api/languages').then((r) => setLangs(r.languages)); }, [load]);

  const patch = async (body: object) => { try { setP(await api<ProjectCard>('PATCH', `/api/projects/${projectId}`, body)); setError(''); } catch (e) { setError(errorText(e)); } };
  const exportProject = async () => {
    setExporting(true);
    try { await downloadAs(`/api/projects/${projectId}/export`, 'project.json'); setError(''); } catch (e) { setError(errorText(e)); } finally { setExporting(false); }
  };
  if (error && !p) return <div className="page"><a href="#/">← Projects</a><p className="error">{error}</p></div>;
  if (!p) return <div className="center muted">Loading…</div>;
  const author = p.role === 'author';

  return (
    <div className="page">
      <header className="topbar"><a href="#/" className="brand" title="Projects"><BlackbirdIcon /></a><a href="#/">← Projects</a><span className="grow" />
        <span className="muted">{me.user.displayName}</span><button onClick={onLogout}>Sign out</button></header>
      {error && <p className="error">{error}</p>}
      <section className="card details-card">
        <Cover p={p} author={author} onChange={(card) => setP(card)} setError={setError} reload={load} />
        <div className="details-main">
          <EditableText value={p.title} disabled={!author} className="h1" onSave={(v) => v.trim() && patch({ title: v.trim() })} />
          <EditableText value={p.subtitle ?? ''} placeholder="Add a subtitle" disabled={!author} className="sub" onSave={(v) => patch({ subtitle: v.trim() })} />
          <dl className="facts">
            <dt>Type</dt><dd>{TYPES.find((t) => t.id === p.type)?.label ?? p.type}</dd>
            <dt>Language</dt><dd>{author ? (
              <select value={p.language} onChange={(e) => void patch({ language: e.target.value })}>
                {langs.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}</select>) : p.language}</dd>
            <dt>Repository folder</dt><dd>{p.repoFolder}</dd>
            <dt>Chapters</dt><dd>{p.chapterCount}</dd>
            <dt>Size</dt><dd>{formatBytes(p.sizeBytes)}</dd>
            <dt>Last edited</dt><dd>{ago(p.lastEditedAt)}</dd>
            <dt>Last snapshot</dt><dd>{ago(p.lastSnapshotAt)}{p.dirtySince && <span className="dirty"> · unsaved changes</span>}</dd>
          </dl>
          <button className="primary open-script" onClick={() => go(`/p/${p.id}/s`)}>Open script</button>
        </div>
      </section>
      <MembersPanel projectId={p.id} members={members} me={me} author={author} onChange={load} setError={setError} />
      {author && <section className="card"><h2>Manage Project</h2>
        <div className="manage-actions">
          <div className="manage-col">
          <div><button disabled={exporting} onClick={() => void exportProject()}>Export</button>
            <p className="muted small">Saves the project as a .json file: story, notes, characters and the library's file list. Members and the library's files are not included.</p></div>
          <div><button className="danger solid delete-project" onClick={() => setDeleting(true)}>Delete permanently</button>
            <p className="muted small">Removes the project and everything in it. Snapshots already in the repository are kept.</p></div>
          </div>
          <div className="manage-col">
          <div><button onClick={() => { if (p.sizeBytes === 0) setError('The library is empty.'); else { setError(''); startDownload(`/api/projects/${p.id}/library.zip`); } }}>Download Library</button>
            <p className="muted small">Saves all the library's files as one .zip.</p></div>
          <div><button onClick={() => zipInput.current?.click()}>Upload Library</button>
            <p className="muted small">Puts the files of a library .zip (from Download Library) back into this project. Files the project does not list are skipped.</p>
            <input ref={zipInput} type="file" hidden accept=".zip,application/zip"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) setRestoring(f); e.target.value = ''; }} /></div>
          </div>
        </div></section>}
      {restoring && <RestoreLibrary projectId={p.id} zip={restoring} onClose={() => { setRestoring(null); void load(); }} />}
      {deleting && <DeleteProject p={p} onClose={() => setDeleting(false)} />}
    </div>
  );
}

function Cover({ p, author, setError, reload }: { p: ProjectCard; author: boolean; onChange: (c: ProjectCard) => void; setError: (s: string) => void; reload: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [earlier, setEarlier] = useState<string | null>(null);
  const send = async (f: File) => {
    setBusy(true);
    try { await uploadFile('PUT', `/api/projects/${p.id}/cover?name=${encodeURIComponent(f.name)}`, f); setError(''); await reload(); }
    catch (e: any) {
      if (e.code === 'same_as_earlier_cover') setEarlier(e.body.assetId);
      else setError(errorText(e));
    } finally { setBusy(false); }
  };
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); setError(''); await reload(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  if (!p.coverAssetId && !author) return null;
  return (
    <div className={'cover' + (p.coverAssetId ? '' : ' empty')}>
      {p.coverAssetId ? <img src={assetUrl(p.coverAssetId, true)} alt="Cover" /> : <span className="muted">No cover</span>}
      {author && <div className="cover-actions">
        <button disabled={busy} onClick={() => input.current?.click()}>{p.coverAssetId ? 'Replace cover' : 'Add cover'}</button>
        {p.coverAssetId && <button disabled={busy} onClick={() => void act(() => api('DELETE', `/api/projects/${p.id}/cover`))}>Remove</button>}
      </div>}
      <input ref={input} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void send(f); e.target.value = ''; }} />
      {earlier && <Confirm title="Earlier cover" confirmLabel="Use it again"
        message="This image is an earlier cover of this project. Swap it back in? The current cover becomes an earlier one."
        onConfirm={() => act(() => api('POST', `/api/projects/${p.id}/cover/use`, { assetId: earlier }))} onClose={() => setEarlier(null)} />}
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
  const [deleteFiles, setDeleteFiles] = useState(false);
  return (
    <Dialog title="Delete permanently" onClose={onClose}>
      <p>This cannot be undone. Type the project title to confirm:</p>
      <p><strong>{p.title}</strong></p>
      <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
      <label className="check"><input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
        Also delete the project's files (library, covers, pictures) from disk. Unchecked, they are kept on the server.</label>
      {error && <p className="error">{error}</p>}
      <div className="row end"><button onClick={onClose}>Cancel</button>
        <button className="danger solid" disabled={typed !== p.title} onClick={async () => {
          try { await api('DELETE', `/api/projects/${p.id}`, { confirmTitle: typed, deleteFiles }); go('/'); } catch (e) { setError(errorText(e)); }
        }}>Delete forever</button></div>
    </Dialog>
  );
}

type RestoreTally = { restored: number; already: number; skipped: string[]; failed: { name: string; why: string }[] };

/** Reads the zip in the browser and sends its files to the project one at a time (the zip itself is never uploaded). */
function RestoreLibrary({ projectId, zip, onClose }: { projectId: string; zip: File; onClose: () => void }) {
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState('');
  const [finished, setFinished] = useState(false);
  const [fatal, setFatal] = useState('');
  const [tally, setTally] = useState<RestoreTally>({ restored: 0, already: 0, skipped: [], failed: [] });
  const stop = useRef(false);
  useEffect(() => {
    stop.current = false;
    const t: RestoreTally = { restored: 0, already: 0, skipped: [], failed: [] };
    void (async () => {
      try {
        const entries = (await readZipIndex(zip)).filter((e) => !e.directory);
        setTotal(entries.length);
        let n = 0;
        for (const e of entries) {
          if (stop.current) break;
          setCurrent(e.name);
          if (e.size > 100 * 1024 * 1024) t.failed.push({ name: e.name, why: 'larger than 100 MB, which the server cannot take' });
          else if (e.size === 0) t.skipped.push(e.name);
          else {
            try {
              const r = await uploadFile<{ outcome: 'restored' | 'already' }>('POST', `/api/projects/${projectId}/library/restore?path=${encodeURIComponent(e.name)}`, await readZipEntry(zip, e));
              if (r.outcome === 'restored') t.restored++; else t.already++;
            } catch (err: any) {
              if (err.code === 'not_in_project') t.skipped.push(e.name);
              else t.failed.push({ name: e.name, why: errorText(err) });
            }
          }
          setDone(++n);
          setTally({ ...t, skipped: [...t.skipped], failed: [...t.failed] });
        }
      } catch (err) { setFatal(errorText(err)); }
      setFinished(true);
    })();
    return () => { stop.current = true; };
  }, [zip, projectId]);
  return (
    <Dialog title="Upload Library" onClose={finished ? onClose : () => undefined}>
      {fatal ? <p className="error">{fatal}</p> : <>
        <p className="muted small">{zip.name}</p>
        {!finished && <p>{done} of {total} files{current ? <><br /><span className="muted small">{current}</span></> : null}</p>}
        {!finished && total > 0 && <progress value={done} max={total} style={{ width: '100%' }} />}
        {finished && <p>{stop.current ? 'Stopped. ' : ''}{tally.restored} restored, {tally.already} already there{tally.skipped.length ? `, ${tally.skipped.length} skipped (not in this project's file list)` : ''}{tally.failed.length ? `, ${tally.failed.length} failed` : ''}.</p>}
        {finished && tally.failed.length > 0 && <ul className="small">{tally.failed.slice(0, 20).map((f) => <li key={f.name}>{f.name}: {f.why}</li>)}</ul>}
      </>}
      <div className="row end">
        {finished ? <button className="primary" onClick={onClose}>Close</button> : <button onClick={() => { stop.current = true; }}>Stop</button>}
      </div>
    </Dialog>
  );
}
