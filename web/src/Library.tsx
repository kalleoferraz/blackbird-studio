import { useCallback, useEffect, useRef, useState } from 'react';
import { api, assetUrl, uploadFile } from './api.ts';
import { formatBytes } from './format.ts';
import type { LibFile, LibFolder, LibListing } from './types.ts';
import { Confirm, Dialog, MenuButton, errorText, useLocalState } from './ui.tsx';

const KIND_ICON: Record<string, string> = { image: '🖼', audio: '♪', video: '▶', document: '📄', other: '▫' };
const ROOT: LibFolder = { name: '/', path: '', managed: true, writable: true };

/** The library as an explorer tree: folders open and close in place, there is no navigation. */
export function LibraryPanel({ projectId, readOnly, onError }: { projectId: string; readOnly: boolean; onError: (m: string) => void }) {
  const [open, setOpen] = useLocalState<string[]>(`rs.libOpen.${projectId}`, []);
  const [lists, setLists] = useState<Record<string, LibListing>>({});
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<LibFile | null>(null);
  const [newIn, setNewIn] = useState<LibFolder | null>(null);
  const [renaming, setRenaming] = useState<LibFolder | null>(null);
  const [removeFile, setRemoveFile] = useState<LibFile | null>(null);
  const [removeFolder, setRemoveFolder] = useState<{ folder: LibFolder; nonEmpty: boolean } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const target = useRef('');
  const expanded = new Set(['', ...open]);

  const fetchList = useCallback(async (path: string) => {
    try {
      const l = await api<LibListing>('GET', `/api/projects/${projectId}/library?folder=${encodeURIComponent(path)}`);
      setLists((prev) => ({ ...prev, [path]: l }));
      return l;
    } catch (e: any) {
      if (e.status === 404 && path) setOpen(open.filter((o) => o !== path && !o.startsWith(path + '/'))); else onError(errorText(e));
      return null;
    }
  }, [projectId, onError]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadOpen = useCallback(async (paths: string[] = [...expanded]) => {
    setLists({});
    await Promise.all(paths.map((p) => fetchList(p)));
  }, [fetchList]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void reloadOpen(['', ...open]); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (path: string) => {
    if (expanded.has(path)) { setOpen(open.filter((o) => o !== path)); return; }
    setOpen([...open, path]);
    if (!lists[path]) void fetchList(path);
  };
  const expand = (path: string) => { if (path && !expanded.has(path)) setOpen([...open, path]); };

  const upload = async (folder: string, files: FileList | File[]) => {
    const all = [...files];
    const problems: string[] = [];
    for (let i = 0; i < all.length; i++) {
      const f = all[i]!;
      setBusy(`Uploading ${i + 1} of ${all.length}: ${f.name}`);
      try { await uploadFile('POST', `/api/projects/${projectId}/library/files?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(f.name)}`, f); }
      catch (e) { problems.push(`${f.name}: ${errorText(e)}`); }
    }
    setBusy('');
    onError(problems.join(' · '));
    expand(folder);
    await fetchList(folder);
  };

  const askRemoveFolder = async (f: LibFolder) => {
    const l = lists[f.path] ?? (await fetchList(f.path));
    if (l) setRemoveFolder({ folder: f, nonEmpty: l.files.length + l.folders.length > 0 });
  };

  const renderFolder = (f: LibFolder, depth: number, isRoot = false) => {
    const isOpen = expanded.has(f.path);
    const l = lists[f.path];
    return (
      <div key={f.path || 'root'}>
        <div className={'tree-row' + (dropOn === f.path ? ' drop' : '')} style={{ paddingLeft: depth * 14 }}
          onDragOver={(e) => { if (!readOnly && f.writable) { e.preventDefault(); e.stopPropagation(); setDropOn(f.path); } }}
          onDragLeave={() => setDropOn(null)}
          onDrop={(e) => { setDropOn(null); if (!readOnly && f.writable && e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); void upload(f.path, e.dataTransfer.files); } }}>
          <button className="tree-main" onClick={() => (isRoot ? undefined : toggle(f.path))} style={isRoot ? { cursor: 'default', fontWeight: 600 } : undefined}>
            {!isRoot && <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>}
            <span className="tree-icon">{isOpen ? '📂' : '📁'}</span>
            <span className="grow lib-name">{f.name}</span>
          </button>
          {!readOnly && <MenuButton className="more show" title="Folder" items={[
            { label: 'Upload…', disabled: !f.writable, onClick: () => { target.current = f.path; input.current?.click(); } },
            { label: 'New folder…', disabled: !f.writable, onClick: () => setNewIn(f) },
            'sep',
            { label: 'Rename…', disabled: f.managed, onClick: () => setRenaming(f) },
            { label: 'Delete…', danger: true, disabled: f.managed, onClick: () => void askRemoveFolder(f) },
          ]}>⋯</MenuButton>}
        </div>
        {isOpen && (l ? (
          <>
            {l.folders.map((c) => renderFolder(c, depth + 1))}
            {l.files.map((file) => (
              <div key={file.id} className="tree-row" style={{ paddingLeft: (depth + 1) * 14 }}>
                <button className="tree-main" onClick={() => setPreview(file)} title={file.usage?.length ? `Used by ${file.usage.join(', ')}` : file.name}>
                  <span className="tree-caret" />
                  <span className="tree-icon">{file.kind === 'image' ? <img src={assetUrl(file.id, file.hasLightweight)} alt="" loading="lazy" /> : KIND_ICON[file.kind]}</span>
                  <span className="grow"><span className="lib-name">{file.name}</span>
                    <span className="muted small lib-meta">{formatBytes(file.size)}{file.width ? ` · ${file.width}×${file.height}` : ''}{file.usage?.length ? ` · ${file.usage.join(', ')}` : ''}</span></span>
                </button>
                <MenuButton className="more show" title="File" items={[
                  { label: file.kind === 'image' ? 'Preview' : 'Details', onClick: () => setPreview(file) },
                  { label: 'Download', onClick: () => { window.location.href = assetUrl(file.id, false, true); } },
                  ...(readOnly ? [] : ['sep' as const, { label: 'Delete…', danger: true, disabled: !!file.usage?.length, hint: file.usage?.length ? 'in use' : undefined, onClick: () => setRemoveFile(file) }]),
                ]}>⋯</MenuButton>
              </div>))}
          </>) : <div className="muted small" style={{ paddingLeft: (depth + 1) * 14 + 24 }}>Loading…</div>)}
      </div>
    );
  };

  return (
    <div className="panel-body library">
      {busy && <p className="muted small">{busy}</p>}
      {renderFolder({ ...ROOT, writable: !readOnly }, 0, true)}
      <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(target.current, e.target.files); e.target.value = ''; }} />

      {preview && <Dialog title={preview.name} wide onClose={() => setPreview(null)}>
        {preview.kind === 'image' ? <div className="preview"><img src={assetUrl(preview.id)} alt={preview.name} /></div>
          : <p className="muted">No preview for this kind of file.</p>}
        <p className="muted small">{preview.path} · {formatBytes(preview.size)}{preview.width ? ` · ${preview.width}×${preview.height}` : ''}
          {preview.sizeLightweight ? ` · reduced copy ${formatBytes(preview.sizeLightweight)}` : ''}</p>
        <div className="row end"><a className="button" href={assetUrl(preview.id, false, true)}>Download</a><button onClick={() => setPreview(null)}>Close</button></div>
      </Dialog>}

      {newIn && <NameDialog title="New folder" label="Name" action="Create" initial="" onClose={() => setNewIn(null)} onSubmit={async (name) => {
        await api('POST', `/api/projects/${projectId}/library/folders`, { parent: newIn.path, name });
        expand(newIn.path); setNewIn(null); await fetchList(newIn.path);
      }} />}

      {renaming && <NameDialog title="Rename folder" label="New name" action="Rename" initial={renaming.name} onClose={() => setRenaming(null)} onSubmit={async (name) => {
        const r = await api<{ path: string }>('PATCH', `/api/projects/${projectId}/library/folders`, { path: renaming.path, name });
        const from = renaming.path;
        const moved = (p: string) => (p === from || p.startsWith(from + '/') ? r.path + p.slice(from.length) : p);
        const next = open.map(moved);
        setOpen(next); setRenaming(null);
        await reloadOpen(['', ...next]);
      }} />}

      {removeFile && <Confirm title="Delete file" danger confirmLabel="Delete" message={`Delete ${removeFile.name} from the library? This cannot be undone.`}
        onConfirm={async () => {
          try { await api('DELETE', `/api/assets/${removeFile.id}`); await reloadOpen(); } catch (e) { onError(errorText(e)); }
        }} onClose={() => setRemoveFile(null)} />}

      {removeFolder && <Confirm title="Delete folder" danger confirmLabel={removeFolder.nonEmpty ? 'Delete everything' : 'Delete'}
        message={removeFolder.nonEmpty ? `${removeFolder.folder.name} is not empty. Delete it with everything inside? This cannot be undone.`
          : `Delete the folder ${removeFolder.folder.name}?`}
        onConfirm={async () => {
          try {
            await api('DELETE', `/api/projects/${projectId}/library/folders?path=${encodeURIComponent(removeFolder.folder.path)}&recursive=1`);
            const gone = removeFolder.folder.path;
            const next = open.filter((o) => o !== gone && !o.startsWith(gone + '/'));
            setOpen(next); await reloadOpen(['', ...next]);
          } catch (e) { onError(errorText(e)); }
        }} onClose={() => setRemoveFolder(null)} />}
    </div>
  );
}

function NameDialog({ title, label, action, initial, onClose, onSubmit }: {
  title: string; label: string; action: string; initial: string; onClose: () => void; onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={async (e) => { e.preventDefault(); try { await onSubmit(name.trim()); } catch (er) { setError(errorText(er)); } }}>
        <label>{label}<input autoFocus value={name} onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim()}>{action}</button></div>
      </form>
    </Dialog>
  );
}
