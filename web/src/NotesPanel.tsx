import './notes.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { ago, plainIndex } from './format.ts';
import type { NoteFocus, NoteItem, NoteRequest, NoteTargetKind, NoteType, Story } from './types.ts';
import { Confirm, Dialog, MenuButton, errorText, useLocalState } from './ui.tsx';

const TYPES: NoteType[] = ['comment', 'task', 'reference'];
const TYPE_LABEL: Record<NoteType, string> = { comment: 'Comments', task: 'Tasks', reference: 'References' };
const TYPE_ONE: Record<NoteType, string> = { comment: 'Comment', task: 'Task', reference: 'Reference' };

type Target = { kind: NoteTargetKind; id: string } | null;
const keyOf = (t: Target) => (t ? `${t.kind}:${t.id}` : 'project');

interface Thread { root: NoteItem; replies: NoteItem[] }
interface TNode { key: string; target: Target; title: string; sort: number; threads: Thread[]; kids: TNode[]; count: number; onPath: boolean }

const authorName = (n: NoteItem, meId: string) =>
  n.authorKind === 'system' ? 'System' : n.authorKind === 'llm' ? 'Assistant' : !n.author ? 'Deleted user' : n.author.id === meId ? 'You' : n.author.name;

interface Ctx {
  projectId: string; meId: string; readOnly: boolean;
  open: Set<string>; toggle: (key: string) => void; forceOpen: boolean;
  changed: () => void; onError: (m: string) => void;
}

export function NotesPanel({ projectId, meId, readOnly, notes, story, focus, request, onChanged, onError }: {
  projectId: string; meId: string; readOnly: boolean; notes: NoteItem[]; story: Story; focus: NoteFocus;
  request: NoteRequest | null; onChanged: () => void; onError: (m: string) => void;
}) {
  const [types, setTypes] = useLocalState<NoteType[]>('rs.notesTypes', TYPES);
  const [search, setSearch] = useState('');
  const [openList, setOpenList] = useLocalState<string[]>(`rs.notesOpen.${projectId}`, ['project']);
  const open = useMemo(() => new Set(openList), [openList]);
  const q = search.trim().toLowerCase();
  const filtering = !!q || types.length < TYPES.length;

  // The ref keeps two updates in one render pass (the focus and a request) from overwriting each other.
  const openRef = useRef(openList);
  openRef.current = openList;
  const setOpen = (list: string[]) => { openRef.current = list; setOpenList(list); };
  const openKeys = (keys: string[]) => {
    const missing = keys.filter((k) => !openRef.current.includes(k));
    if (missing.length) setOpen([...openRef.current, ...missing]);
  };
  const toggle = (key: string) => setOpen(openRef.current.includes(key) ? openRef.current.filter((k) => k !== key) : [...openRef.current, key]);

  const focusKeys = useMemo(() => [
    focus.chapterId && `chapter:${focus.chapterId}`, focus.segmentId && `segment:${focus.segmentId}`,
    focus.sceneId && `scene:${focus.sceneId}`, focus.cueId && `cue:${focus.cueId}`,
  ].filter((k): k is string => !!k), [focus]);
  const focusSig = focusKeys.join('|');
  // The panel follows the script: the path to the current chapter, segment, scene and cue opens when it changes.
  useEffect(() => { openKeys(focusKeys); }, [focusSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // A request from a cue's notes icon or a Library badge: open that place, scroll to it, offer the composer when it is empty.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!request) return;
    const keys = [
      request.chapterId && `chapter:${request.chapterId}`, request.segmentId && `segment:${request.segmentId}`,
      request.sceneId && `scene:${request.sceneId}`, request.cueId && `cue:${request.cueId}`, request.assetId && `asset:${request.assetId}`,
      request.assetId && 'library',
    ].filter((k): k is string => !!k);
    openKeys(keys);
    const last = keys.filter((k) => k !== 'library').at(-1);
    setTimeout(() => {
      const el = last && rootRef.current?.querySelector(`[data-note-node="${CSS.escape(last)}"]`);
      if (el) (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
  }, [request?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- threads, filtered ----
  const threads = useMemo(() => {
    const replies = new Map<string, NoteItem[]>();
    for (const n of notes) if (n.rootNoteId) (replies.get(n.rootNoteId) ?? replies.set(n.rootNoteId, []).get(n.rootNoteId)!).push(n);
    const text = (n: NoteItem) => `${n.textMd} ${n.refKey ?? ''} ${n.link ?? ''} ${authorName(n, meId)}`.toLowerCase();
    return notes.filter((n) => !n.rootNoteId).map((root): Thread => ({ root, replies: replies.get(root.id) ?? [] }))
      .filter((t) => types.includes(t.root.type) && (!q || [t.root, ...t.replies].some((n) => !n.deleted && text(n).includes(q))));
  }, [notes, types, q, meId]);

  // ---- the tree: chapters and segments from the story, scenes and cues from the notes' places ----
  const { script, project, library } = useMemo(() => {
    const map = new Map<string, TNode>();
    const path = new Set(focusKeys);
    const make = (target: Target, title: string, sort: number): TNode => {
      const key = keyOf(target);
      let node = map.get(key);
      if (!node) { node = { key, target, title, sort, threads: [], kids: [], count: 0, onPath: path.has(key) }; map.set(key, node); }
      return node;
    };
    const chapters: TNode[] = [];
    for (const c of story.chapters) {
      const cn = make({ kind: 'chapter', id: c.id }, `${plainIndex(c.index)}  ${c.title}`, c.position);
      chapters.push(cn);
      for (const s of c.segments) cn.kids.push(make({ kind: 'segment', id: s.id }, `${s.position}  ${s.title}`, s.position));
    }
    const ensureScene = (segmentId: string, sceneId: string, no: number | null, label: string | null) => {
      const seg = map.get(`segment:${segmentId}`);
      if (!seg) return null;
      const existed = map.has(`scene:${sceneId}`);
      const sn = make({ kind: 'scene', id: sceneId }, label || `Scene ${no ?? ''}`.trim(), no ?? 0);
      if (!existed) seg.kids.push(sn);
      return sn;
    };
    const ensureCue = (sn: TNode, cueId: string, label: string | null, start: number | null) => {
      const existed = map.has(`cue:${cueId}`);
      const cn = make({ kind: 'cue', id: cueId }, label ? `“${label}”` : 'Cue', start ?? 0);
      if (!existed) sn.kids.push(cn);
      return cn;
    };
    const projectThreads: Thread[] = [];
    const assets = new Map<string, TNode>();
    for (const t of threads) {
      const p = t.root.place, tg = t.root.target;
      if (!tg) { projectThreads.push(t); continue; }
      if (tg.kind === 'asset') {
        const an = assets.get(tg.id) ?? make({ kind: 'asset', id: tg.id }, p.label ?? 'File', 0);
        assets.set(tg.id, an); an.threads.push(t); continue;
      }
      let node: TNode | null | undefined;
      if (tg.kind === 'chapter' || tg.kind === 'segment') node = map.get(keyOf(tg));
      else if (p.segmentId && p.sceneId) {
        const sn = ensureScene(p.segmentId, p.sceneId, p.sceneNo, tg.kind === 'scene' ? p.label : null);
        node = tg.kind === 'scene' ? sn : sn && p.cueId ? ensureCue(sn, p.cueId, p.label, p.cueStartMs) : null;
      }
      node?.threads.push(t);
    }
    const finish = (n: TNode): number => {
      n.kids.sort((a, b) => a.sort - b.sort);
      n.count = n.threads.length + n.kids.reduce((sum, k) => sum + finish(k), 0);
      n.kids = n.kids.filter((k) => k.count > 0);
      n.onPath = n.onPath || n.kids.some((k) => k.onPath);
      return n.count;
    };
    chapters.forEach(finish);
    const shown = chapters.filter((c) => c.count > 0);
    const lib = [...assets.values()].sort((a, b) => a.title.localeCompare(b.title));
    lib.forEach((n) => { n.count = n.threads.length; });
    return { script: shown, project: projectThreads, library: lib };
  }, [story, threads, filtering, focusSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx: Ctx = { projectId, meId, readOnly, open, toggle, forceOpen: filtering, changed: onChanged, onError };
  const nothing = script.length === 0 && project.length === 0 && library.length === 0;
  const projectOpen = open.has('project') || filtering;
  const libraryOpen = open.has('library') || filtering;
  const projectTotal = project.length;
  const libraryTotal = library.reduce((s, n) => s + n.count, 0);

  return (
    <div className="notes" ref={rootRef}>
      <div className="notes-head">
        <input type="search" placeholder="Search notes…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="note-filters">
          {TYPES.map((t) => (
            <button key={t} className={'nf ' + t + (types.includes(t) ? ' on' : '')} aria-pressed={types.includes(t)}
              onClick={() => setTypes(types.includes(t) ? types.filter((x) => x !== t) : TYPES.filter((x) => x === t || types.includes(x)))}>{TYPE_LABEL[t]}</button>))}
        </div>
      </div>
      <div className="notes-body">
        {script.map((n) => <NodeView key={n.key} node={n} depth={0} ctx={ctx} />)}
        <div className="note-group">
          <div className="note-node-row group" data-note-node="project">
            <button className="caret" onClick={() => toggle('project')} aria-label="Toggle">{projectOpen ? '▾' : '▸'}</button>
            <button className="note-title" onClick={() => toggle('project')}>Media project</button>
            {projectTotal > 0 && <span className="note-count">{projectTotal}</span>}
          </div>
          {projectOpen && <div className="note-node-body">
            {project.map((t) => <ThreadView key={t.root.id} thread={t} ctx={ctx} />)}
            {projectTotal === 0 && <p className="muted small note-empty">No notes on the media project.</p>}
          </div>}
          <div className="note-node-row group" data-note-node="library">
            <button className="caret" onClick={() => toggle('library')} aria-label="Toggle">{libraryOpen ? '▾' : '▸'}</button>
            <button className="note-title" onClick={() => toggle('library')}>Library files</button>
            {libraryTotal > 0 && <span className="note-count">{libraryTotal}</span>}
          </div>
          {libraryOpen && <div className="note-node-body">
            {library.map((n) => <NodeView key={n.key} node={n} depth={0} ctx={ctx} />)}
            {library.length === 0 && <p className="muted small note-empty">No notes on files.</p>}
          </div>}
        </div>
        {nothing && filtering && <p className="muted small note-empty">No notes match.</p>}
      </div>
    </div>
  );
}

function NodeView({ node, depth, ctx }: { node: TNode; depth: number; ctx: Ctx }) {
  const isOpen = ctx.open.has(node.key) || ctx.forceOpen;
  const here = node.onPath && !node.kids.some((k) => k.onPath);
  return (
    <div className={'note-node' + (node.onPath ? ' on-path' : '') + (here ? ' here' : '')}>
      <div className="note-node-row" style={{ paddingLeft: depth * 12 }} data-note-node={node.key}>
        <button className="caret" onClick={() => ctx.toggle(node.key)} aria-label="Toggle">{isOpen ? '▾' : '▸'}</button>
        <button className="note-title" onClick={() => ctx.toggle(node.key)} title={node.title}>{node.title}</button>
        {node.count > 0 && <span className="note-count">{node.count}</span>}
      </div>
      {isOpen && (
        <div className="note-node-body" style={{ paddingLeft: depth * 12 }}>
          {node.threads.map((t) => <ThreadView key={t.root.id} thread={t} ctx={ctx} />)}
          {node.kids.map((k) => <NodeView key={k.key} node={k} depth={depth + 1} ctx={ctx} />)}
        </div>)}
    </div>
  );
}

/** One root note with its replies. */
function ThreadView({ thread, ctx }: { thread: Thread; ctx: Ctx }) {
  const [replying, setReplying] = useState(false);
  const { root, replies } = thread;
  return (
    <div className={'note-thread ' + root.type}>
      <NoteBody note={root} ctx={ctx} root />
      {replies.length > 0 && <div className="note-replies">{replies.map((r) => <NoteBody key={r.id} note={r} ctx={ctx} />)}</div>}
      {!ctx.readOnly && !replying && <button className="linklike small" onClick={() => setReplying(true)}>Reply</button>}
      {replying && <Composer projectId={ctx.projectId} onChanged={ctx.changed} target={null} replyTo={root.id} onDone={() => setReplying(false)} />}
    </div>
  );
}

function NoteBody({ note, ctx, root }: { note: NoteItem; ctx: Ctx; root?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mine = note.authorKind === 'user' && note.author?.id === ctx.meId;
  if (note.deleted) return <div className="note deleted muted small">This note was deleted.</div>;
  const check = async (done: boolean) => {
    try { await api('POST', `/api/notes/${note.id}/done`, { done }); ctx.changed(); } catch (e) { ctx.onError(errorText(e)); }
  };
  const remove = async () => {
    try { await api('DELETE', `/api/notes/${note.id}`); ctx.changed(); } catch (e) { ctx.onError(errorText(e)); }
  };
  if (editing) return <Composer projectId={ctx.projectId} onChanged={ctx.changed} target={null} editing={note} onDone={() => setEditing(false)} />;
  return (
    <div className={'note' + (note.authorKind !== 'user' ? ' by-' + note.authorKind : '')}>
      <div className="note-meta small">
        {root && <span className={'note-tag ' + note.type}>{TYPE_ONE[note.type]}</span>}
        <span className="note-author">{authorName(note, ctx.meId)}</span>
        <span className="muted">{ago(note.createdAt)}{note.editedAt ? ' · edited' : ''}</span>
        <span className="grow" />
        {mine && !ctx.readOnly && <MenuButton className="more show" title="Note" items={[
          { label: 'Edit', onClick: () => setEditing(true) },
          { label: 'Delete', danger: true, onClick: () => setConfirmDelete(true) },
        ]}>⋯</MenuButton>}
      </div>
      {note.type === 'reference' && root && (
        <div className="note-ref">
          <b className="ref-key">{note.refKey}</b>
          {note.link && <a href={note.link} target="_blank" rel="noopener noreferrer">{note.link}</a>}
        </div>)}
      <div className="note-line">
        {note.type === 'task' && root && (
          <input type="checkbox" className="note-check" checked={!!note.doneAt} disabled={ctx.readOnly}
            onChange={(e) => void check(e.target.checked)} aria-label="Done" />)}
        {note.textMd && <div className={'note-text' + (note.doneAt ? ' done' : '')}>{note.textMd}</div>}
      </div>
      {note.doneAt && note.doneBy && <div className="muted small">Done by {note.doneBy.id === ctx.meId ? 'you' : note.doneBy.name} · {ago(note.doneAt)}</div>}
      {confirmDelete && <Confirm title="Delete note" danger confirmLabel="Delete"
        message="Delete this note? If it has replies, they stay and this note shows as deleted." onConfirm={remove} onClose={() => setConfirmDelete(false)} />}
    </div>
  );
}

/** Adds a root note on `target`, adds a reply (`replyTo`) or edits `editing`. */
function Composer({ projectId, onChanged, target, initialType, replyTo, editing, onDone }: {
  projectId: string; onChanged: () => void; target: Target; initialType?: NoteType; replyTo?: string; editing?: NoteItem; onDone: () => void;
}) {
  const [type, setType] = useState<NoteType>(editing?.type ?? initialType ?? 'comment');
  const [text, setText] = useState(editing?.textMd ?? '');
  const [refKey, setRefKey] = useState(editing?.refKey ?? '');
  const [link, setLink] = useState(editing?.link ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { area.current?.focus(); }, []);
  const isRef = (editing ? editing.type : type) === 'reference' && !replyTo;
  const ok = isRef ? !!refKey.trim() && (!!text.trim() || !!link.trim()) : !!text.trim();
  const submit = async () => {
    setBusy(true); setError('');
    try {
      if (editing) {
        await api('PATCH', `/api/notes/${editing.id}`, isRef ? { textMd: text, refKey: refKey.trim(), link: link.trim() || null } : { textMd: text });
      } else if (replyTo) {
        await api('POST', `/api/projects/${projectId}/notes`, { replyTo, textMd: text });
      } else {
        await api('POST', `/api/projects/${projectId}/notes`, {
          type, textMd: text, ...(target ? { target } : {}),
          ...(type === 'reference' ? { refKey: refKey.trim(), link: link.trim() || null } : {}),
        });
      }
      onChanged(); onDone();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <form className="note-composer" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) void submit(); }}>
      {!replyTo && !editing && (
        <div className="row compact">
          {TYPES.map((t) => <button type="button" key={t} className={'nf ' + t + (type === t ? ' on' : '')} onClick={() => setType(t)}>{TYPE_ONE[t]}</button>)}
        </div>)}
      {isRef && (
        <div className="row compact">
          <input className="ref-key-input" placeholder="Key (e.g. Smith20)" maxLength={24} value={refKey} onChange={(e) => setRefKey(e.target.value)} />
          <input placeholder="Link (https://…)" value={link} onChange={(e) => setLink(e.target.value)} />
        </div>)}
      <textarea ref={area} rows={replyTo ? 2 : 3} value={text} maxLength={20000}
        placeholder={replyTo ? 'Reply…' : isRef ? 'Source or description (Markdown)' : type === 'task' ? 'What needs to be done?' : 'Write a note (Markdown)…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onDone(); else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ok && !busy) void submit(); }} />
      {error && <p className="error small">{error}</p>}
      <div className="row end compact">
        <button type="button" onClick={onDone}>Cancel</button>
        <button className="primary" disabled={!ok || busy}>{editing ? 'Save' : replyTo ? 'Reply' : 'Add'}</button>
      </div>
    </form>
  );
}

/** The dialog that adds a note on a place (a cue, a scene, a segment, a chapter, a file or the media project). */
export function AddNoteDialog({ projectId, target, label, onClose, onSaved }: {
  projectId: string; target: { kind: NoteTargetKind; id: string } | null; label: string; onClose: () => void; onSaved: () => void;
}) {
  return (
    <Dialog title="Add note" onClose={onClose}>
      <p className="muted small note-where" title={label}>On {label}</p>
      <Composer projectId={projectId} onChanged={onSaved} target={target} onDone={onClose} />
    </Dialog>
  );
}
