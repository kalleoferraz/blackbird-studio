import { createContext, useContext } from 'react';
import type { NoteItem, NoteRequest, NoteTargetKind } from './types.ts';

/** What a cue or a library file shows about its notes: threads, open tasks and the most urgent type. */
export interface NoteBadge {
  threads: number; comments: number; openTasks: number; doneTasks: number; references: number;
}

export interface NotesInfo {
  cue: Map<string, NoteBadge>;
  asset: Map<string, NoteBadge>;
  /** Opens the Notes tab of the right panel at a place. */
  show: (r: Omit<NoteRequest, 'n'>) => void;
  /** Opens the dialog that adds a note on a place; `target` null is the media project itself. */
  add: (target: { kind: NoteTargetKind; id: string } | null, label: string) => void;
}

export const NotesContext = createContext<NotesInfo>({ cue: new Map(), asset: new Map(), show: () => undefined, add: () => undefined });
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

/**
 * What a cue's notes look like in the script: a chat balloon for comments, a checkbox for tasks (yellow while one is open,
 * gray when all are done) and a green link icon for references (whether or not the link is filled in). Each opens the Notes tab at the cue.
 */
export function CueNoteIcons({ cueId, segmentId, sceneId, chapterId }: { cueId: string; segmentId: string; sceneId: string; chapterId: string }) {
  const { cue, show } = useNotes();
  const b = cue.get(cueId);
  if (!b) return null;
  const open = (e: { stopPropagation: () => void }) => { e.stopPropagation(); show({ chapterId, segmentId, sceneId, cueId }); };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    <>
      {b.comments > 0 && <button type="button" className="notes-btn ind comment" title={plural(b.comments, 'comment')} aria-label={plural(b.comments, 'comment')} onClick={open}><BubbleIcon /></button>}
      {b.openTasks + b.doneTasks > 0 && (
        <button type="button" className={'notes-btn ind task' + (b.openTasks > 0 ? ' open' : ' done')} onClick={open}
          title={b.openTasks > 0 ? plural(b.openTasks, 'open task') : plural(b.doneTasks, 'task') + ', all done'}
          aria-label={b.openTasks > 0 ? plural(b.openTasks, 'open task') : 'All tasks done'}><CheckIcon /></button>)}
      {b.references > 0 && <button type="button" className="notes-btn ind reference" title={plural(b.references, 'reference')} aria-label={plural(b.references, 'reference')} onClick={open}><LinkIcon /></button>}
    </>
  );
}

/** The icon that adds a note on a cue: a solid yolk circle with a black plus, shown when the pointer is on the cue. */
export function AddCueNoteButton({ cueId, label }: { cueId: string; label: string }) {
  const { add } = useNotes();
  return (
    <button type="button" className="notes-btn add" title="Add a note" aria-label="Add a note"
      onClick={(e) => { e.stopPropagation(); add({ kind: 'cue', id: cueId }, label); }}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 2.200v7.600M2.200 6h7.600" stroke="currentColor" strokeWidth="1.900" strokeLinecap="round" fill="none" /></svg>
    </button>
  );
}

/** A badge at the left of a Library file row with its note count. */
export function AssetNotesBadge({ assetId }: { assetId: string }) {
  const { asset, show } = useNotes();
  const b = asset.get(assetId);
  if (!b) return null;
  return (
    <button type="button" className={'asset-badge ' + badgeKind(b)} title={`${b.threads} note${b.threads === 1 ? '' : 's'}`}
      onClick={(e) => { e.stopPropagation(); show({ assetId }); }}>{b.threads}</button>
  );
}
