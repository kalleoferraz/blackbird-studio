import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteItem, NoteRequest, NoteTargetKind } from './types.ts';

/** What a cue or a library file shows about its notes: threads, open tasks and the most urgent type. */
export interface NoteBadge {
  threads: number; comments: number; openTasks: number; doneTasks: number; references: number;
}

export interface NotesInfo {
  cue: Map<string, NoteBadge>;
  asset: Map<string, NoteBadge>;
  /** The live notes (thread roots) on a cue or a library file. */
  forTarget: (kind: 'cue' | 'asset', id: string) => NoteItem[];
  /** Ticks or unticks a task; resolves when the server has it and the notes are reloaded. */
  setDone: (noteId: string, done: boolean) => Promise<void>;
  readOnly: boolean;
  /** Opens the Notes tab of the right panel at a place. */
  show: (r: Omit<NoteRequest, 'n'>) => void;
  /** Opens the dialog that adds a note on a place; `target` null is the media project itself. */
  add: (target: { kind: NoteTargetKind; id: string } | null, label: string) => void;
}

export const NotesContext = createContext<NotesInfo>({ cue: new Map(), asset: new Map(), forTarget: () => [], setDone: async () => undefined, readOnly: true, show: () => undefined, add: () => undefined });
export const useNotes = () => useContext(NotesContext);

/** Counts per cue and per asset: a thread counts once (replies do not), a tombstoned root still counts. */
export function badgesOf(notes: NoteItem[]): Pick<NotesInfo, 'cue' | 'asset'> {
  const cue = new Map<string, NoteBadge>(), asset = new Map<string, NoteBadge>();
  for (const n of notes) {
    if (n.rootNoteId || !n.target) continue;
    const map = n.target.kind === 'cue' ? cue : n.target.kind === 'asset' ? asset : null;
    if (!map) continue;
    const b = map.get(n.target.id) ?? { threads: 0, comments: 0, openTasks: 0, doneTasks: 0, references: 0 };
    // A thread counts once; a deleted task or reference is gone, a deleted comment with replies is still a thread.
    if (n.type === 'comment') b.comments += 1;
    else if (n.deleted) continue;
    else if (n.type === 'task') { if (n.doneAt) b.doneTasks += 1; else b.openTasks += 1; }
    else b.references += 1;
    b.threads += 1;
    map.set(n.target.id, b);
  }
  return { cue, asset };
}

/** The most urgent type decides the colour: an open task, then a reference, then a comment. */
export const badgeKind = (b: NoteBadge): 'task' | 'reference' | 'comment' => (b.openTasks > 0 ? 'task' : b.references > 0 ? 'reference' : 'comment');

const BubbleIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 3.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.500V11h0a1.500 1.500 0 0 1-1.500-1.500z" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.500" y="2.500" width="11" height="11" rx="2" /><path d="M5.300 8.200l1.900 1.900 3.500-3.900" />
  </svg>
);
const LinkIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M6.800 9.200a2.700 2.700 0 0 0 3.800 0l2-2a2.700 2.700 0 0 0-3.800-3.800l-.7.7M9.200 6.800a2.700 2.700 0 0 0-3.800 0l-2 2a2.700 2.700 0 0 0 3.800 3.800l.7-.7" />
  </svg>
);

const TYPE_WORD: Record<NoteItem['type'], string> = { comment: 'Comment', task: 'Task', reference: 'Reference' };

/**
 * The note icons of one place (a cue in the script, a file in the Library): a chat balloon for comments, a checkbox for tasks
 * (yellow while one is open, gray when all are done) and a green link icon for references. Each opens a small popup with a
 * summary of the notes of that type; the popup's button goes on to the Notes panel.
 */
export function NoteIcons({ kind, id, onGo }: { kind: 'cue' | 'asset'; id: string; onGo: () => void }) {
  const { cue, asset, forTarget } = useNotes();
  const [pop, setPop] = useState<{ el: HTMLElement; type: NoteItem['type'] } | null>(null);
  const b = (kind === 'cue' ? cue : asset).get(id);
  if (!b) return null;
  const mk = (type: NoteItem['type']) => (e: { stopPropagation: () => void; currentTarget: HTMLElement }) => {
    e.stopPropagation();
    const el = e.currentTarget;
    setPop(pop && pop.el === el ? null : { el, type });
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    <>
      {b.comments > 0 && <button type="button" className="notes-btn ind comment" title={plural(b.comments, 'comment')} aria-label={plural(b.comments, 'comment')} onClick={mk('comment')}><BubbleIcon /></button>}
      {b.openTasks + b.doneTasks > 0 && (
        <button type="button" className={'notes-btn ind task' + (b.openTasks > 0 ? ' open' : ' done')} onClick={mk('task')}
          title={b.openTasks > 0 ? plural(b.openTasks, 'open task') : plural(b.doneTasks, 'task') + ', all done'}
          aria-label={b.openTasks > 0 ? plural(b.openTasks, 'open task') : 'All tasks done'}><CheckIcon /></button>)}
      {b.references > 0 && <button type="button" className="notes-btn ind reference" title={plural(b.references, 'reference')} aria-label={plural(b.references, 'reference')} onClick={mk('reference')}><LinkIcon /></button>}
      {pop && <NotePopup anchor={pop.el} type={pop.type} notes={forTarget(kind, id).filter((n) => n.type === pop.type)} onClose={() => setPop(null)}
        onGo={() => { setPop(null); onGo(); }} />}
    </>
  );
}

/** A cue's note icons; the popup's button opens the Notes panel at the cue. */
export function CueNoteIcons({ cueId, segmentId, sceneId, chapterId }: { cueId: string; segmentId: string; sceneId: string; chapterId: string }) {
  const { show } = useNotes();
  return <NoteIcons kind="cue" id={cueId} onGo={() => show({ chapterId, segmentId, sceneId, cueId })} />;
}

/** A Library file's note icons, the same as a cue's. */
export function AssetNoteIcons({ assetId }: { assetId: string }) {
  const { show } = useNotes();
  return <NoteIcons kind="asset" id={assetId} onGo={() => show({ assetId })} />;
}

/**
 * A small summary of the notes of one type, next to the icon that was clicked; closes on an outside click or Escape.
 * For tasks each has a checkbox; ticking changes nothing until Save.
 */
function NotePopup({ anchor, type, notes, onGo, onClose }: { anchor: HTMLElement; type: NoteItem['type']; notes: NoteItem[]; onGo: () => void; onClose: () => void }) {
  const { setDone, readOnly } = useNotes();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect(), m = ref.current!.getBoundingClientRect();
    let left = a.left, top = a.bottom + 6;
    if (left + m.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - m.width - 8);
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 6);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [anchor, onClose]);
  const shown = notes.slice(0, 4);
  const isTask = type === 'task';
  const changed = shown.filter((n) => n.id in ticks && ticks[n.id] !== !!n.doneAt);
  const save = async () => {
    setBusy(true);
    try { for (const n of changed) await setDone(n.id, ticks[n.id]!); } finally { setBusy(false); onClose(); }
  };
  return createPortal(
    <div ref={ref} className="note-pop" role="dialog" aria-label="Notes" style={{ left: pos?.left ?? -999, top: pos?.top ?? -999 }} onClick={(e) => e.stopPropagation()}>
      {shown.map((n) => {
        const done = n.id in ticks ? ticks[n.id]! : !!n.doneAt;
        return (
          <div key={n.id} className={'np-item ' + n.type}>
            <div className="np-meta"><span className={'note-tag ' + n.type}>{TYPE_WORD[n.type]}</span>
              {n.author && <span className="muted small">{n.author.name}</span>}</div>
            <div className="note-line">
              {isTask && <input type="checkbox" className="note-check" checked={done} disabled={readOnly || busy} aria-label="Done"
                onChange={(e) => setTicks({ ...ticks, [n.id]: e.target.checked })} />}
              <div className={'np-text' + (isTask && done ? ' done' : '')}>{n.textMd.replace(/\s+/g, ' ').trim() || n.refKey || n.link || '(no text)'}</div>
            </div>
            {type === 'reference' && (n.refKey || n.link) && <div className="muted small">{n.refKey ?? n.link}</div>}
          </div>);
      })}
      {notes.length > shown.length && <div className="muted small">+ {notes.length - shown.length} more</div>}
      <div className="np-actions">
        <button type="button" onClick={onClose}>Close</button>
        {isTask ? (<>
          <button type="button" onClick={onGo}>Go to notes</button>
          <button type="button" className="primary" disabled={busy || changed.length === 0} onClick={() => void save()}>Save</button>
        </>) : <button type="button" className="primary" onClick={onGo}>Go to notes</button>}
      </div>
    </div>, document.body);
}
