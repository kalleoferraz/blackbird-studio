import { useRef, useState } from 'react';
import { api } from './api.ts';
import type { Story, StoryChapter } from './types.ts';
import { Confirm, MenuButton, PlusIcon, errorText, useLocalState, type MenuItem } from './ui.tsx';
import { plainIndex } from './format.ts';


type Drag = { kind: 'chapter'; id: string } | { kind: 'segment'; id: string } | null;

export function StoryIndex({ projectId, story, currentSegmentId, readOnly, onStory, onOpenSegment, onError, onChanged }: {
  projectId: string; story: Story; currentSegmentId?: string; readOnly: boolean;
  onStory: (s: Story) => void; onOpenSegment: (id: string) => void; onError: (m: string) => void; onChanged: () => void;
}) {
  const [collapsed, setCollapsed] = useLocalState<string[]>(`story-collapsed-${projectId}`, []);
  const [editing, setEditing] = useState<string | null>(null); // chapter or segment id; 'new-chapter' for the new row
  const [confirm, setConfirm] = useState<null | { title: string; message: string; run: () => Promise<void> }>(null);
  const drag = useRef<Drag>(null);
  const [over, setOver] = useState<string | null>(null);

  const run = async (fn: () => Promise<Story>) => {
    try { const s = await fn(); onStory(s); onChanged(); return s; } catch (e) { onError(errorText(e)); return null; }
  };
  const toggle = (id: string) => setCollapsed(collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]);

  const chapterMenu = (c: StoryChapter, i: number): MenuItem[] => [
    { label: 'Rename', onClick: () => setEditing(c.id) },
    { label: 'Add segment', onClick: async () => {
      const s = await run(() => api<Story>('POST', `/api/chapters/${c.id}/segments`, { title: 'New segment' }));
      if (s?.created) { setCollapsed(collapsed.filter((x) => x !== c.id)); setEditing(s.created); onOpenSegment(s.created); } } },
    { label: c.introductory ? 'Make a numbered chapter' : 'Mark as introductory', onClick: () => void run(() => api<Story>('PATCH', `/api/chapters/${c.id}`, { introductory: !c.introductory })) },
    'sep',
    { label: 'Move up', disabled: i === 0 || story.chapters[i - 1]!.introductory !== c.introductory, onClick: () => void run(() => api<Story>('POST', `/api/chapters/${c.id}/move`, { position: c.position - 1 })) },
    { label: 'Move down', disabled: i === story.chapters.length - 1 || story.chapters[i + 1]!.introductory !== c.introductory, onClick: () => void run(() => api<Story>('POST', `/api/chapters/${c.id}/move`, { position: c.position + 1 })) },
    'sep',
    { label: 'Delete', danger: true, onClick: () => {
      const cues = c.segments.reduce((n, s) => n + s.cueCount, 0);
      setConfirm({ title: 'Delete chapter', message: `Delete "${c.title}" with ${c.segments.length} segment${c.segments.length === 1 ? '' : 's'} and ${cues} cue${cues === 1 ? '' : 's'}? This cannot be undone.`,
        run: async () => { const s = await run(() => api<Story>('DELETE', `/api/chapters/${c.id}`));
          if (s && c.segments.some((x) => x.id === currentSegmentId)) { const first = s.chapters.flatMap((x) => x.segments)[0]; if (first) onOpenSegment(first.id); } } });
    } },
  ];

  const onDropChapter = (target: StoryChapter) => {
    const d = drag.current; drag.current = null; setOver(null);
    if (!d) return;
    if (d.kind === 'chapter' && d.id !== target.id) void run(() => api<Story>('POST', `/api/chapters/${d.id}/move`, { position: target.position }));
    if (d.kind === 'segment') void run(() => api<Story>('POST', `/api/segments/${d.id}/move`, { chapterId: target.id, position: 1000 }));
  };

  return (
    <nav className="story">
      {story.chapters.map((c, ci) => {
        const open = !collapsed.includes(c.id);
        return (
          <div key={c.id} className="chapter">
            <div className={'row-item chapter-row' + (over === c.id ? ' over' : '')} draggable={!readOnly && editing !== c.id}
              onDragStart={() => { drag.current = { kind: 'chapter', id: c.id }; }}
              onDragOver={(e) => { if (drag.current) { e.preventDefault(); setOver(c.id); } }} onDragLeave={() => setOver(null)}
              onDrop={() => onDropChapter(c)} onClick={() => editing !== c.id && toggle(c.id)}>
              <span className={'caret' + (open ? ' open' : '')} aria-hidden>
                <svg viewBox="0 0 10 10" width="10" height="10"><path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
              <span className="idx">{plainIndex(c.index)}</span>
              {editing === c.id ? (
                <TitleInput value={c.title} onDone={(v) => { setEditing(null); if (v && v !== c.title) void run(() => api<Story>('PATCH', `/api/chapters/${c.id}`, { title: v })); }} />
              ) : <span className="title" onDoubleClick={() => !readOnly && setEditing(c.id)}>{c.title}</span>}
              {!readOnly && <MenuButton className="more" items={chapterMenu(c, ci)} title="Chapter options">⋯</MenuButton>}
            </div>
            {open && c.segments.map((s, si) => (
              <div key={s.id} className={'row-item segment-row' + (s.id === currentSegmentId ? ' current' : '') + (over === s.id ? ' over' : '')}
                draggable={!readOnly && editing !== s.id}
                onDragStart={(e) => { e.stopPropagation(); drag.current = { kind: 'segment', id: s.id }; }}
                onDragOver={(e) => { if (drag.current?.kind === 'segment') { e.preventDefault(); e.stopPropagation(); setOver(s.id); } }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => { e.stopPropagation(); const d = drag.current; drag.current = null; setOver(null);
                  if (d?.kind === 'segment' && d.id !== s.id) void run(() => api<Story>('POST', `/api/segments/${d.id}/move`, { chapterId: c.id, position: s.position })); }}
                onClick={() => editing !== s.id && onOpenSegment(s.id)}>
                <span className="idx seg-idx">{plainIndex(c.index)}.{s.position}</span>
                {editing === s.id ? (
                  <TitleInput value={s.title} onDone={(v) => { setEditing(null); if (v && v !== s.title) void run(() => api<Story>('PATCH', `/api/segments/${s.id}`, { title: v })); }} />
                ) : <span className="title" onDoubleClick={() => !readOnly && setEditing(s.id)}>{s.title}</span>}
                {!readOnly && <MenuButton className="more" title="Segment options" items={[
                  { label: 'Rename', onClick: () => setEditing(s.id) },
                  { label: 'Move up', disabled: si === 0, onClick: () => void run(() => api<Story>('POST', `/api/segments/${s.id}/move`, { chapterId: c.id, position: s.position - 1 })) },
                  { label: 'Move down', disabled: si === c.segments.length - 1, onClick: () => void run(() => api<Story>('POST', `/api/segments/${s.id}/move`, { chapterId: c.id, position: s.position + 1 })) },
                  'sep',
                  { label: 'Delete', danger: true, onClick: () => setConfirm({
                    title: 'Delete segment', message: `Delete "${s.title}" with ${s.cueCount} cue${s.cueCount === 1 ? '' : 's'}? This cannot be undone.`,
                    run: async () => { const st = await run(() => api<Story>('DELETE', `/api/segments/${s.id}`));
                      if (st && s.id === currentSegmentId) { const next = st.chapters.flatMap((x) => x.segments)[0]; if (next) onOpenSegment(next.id); } } }) },
                ]}>⋯</MenuButton>}
              </div>))}
          </div>);
      })}
      {!readOnly && (editing === 'new-chapter' ? (
        <div className="row-item"><TitleInput value="" onDone={(v) => { setEditing(null); if (v) void run(() => api<Story>('POST', `/api/projects/${projectId}/chapters`, { title: v })); }} /></div>
      ) : <button className="add-chapter" title="Add chapter" onClick={() => setEditing('new-chapter')}><PlusIcon /></button>)}
      {confirm && <Confirm title={confirm.title} message={confirm.message} confirmLabel="Delete" danger onConfirm={confirm.run} onClose={() => setConfirm(null)} />}
    </nav>
  );
}

function TitleInput({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (keep: boolean) => { if (done.current) return; done.current = true; onDone(keep ? v.trim() : ''); };
  return <input className="title-input" autoFocus value={v} placeholder="Title" onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()}
    onClick={(e) => e.stopPropagation()} onBlur={() => finish(true)}
    onKeyDown={(e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); }} />;
}
