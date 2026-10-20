import { useRef, useState } from 'react';
import { api } from './api.ts';
import type { Story, StoryChapter } from './types.ts';
import { Confirm, MenuButton, errorText, useLocalState, type MenuItem } from './ui.tsx';

type Drag = { kind: 'chapter'; id: string } | { kind: 'scene'; id: string } | null;

export function StoryIndex({ projectId, story, currentSceneId, readOnly, onStory, onOpenScene, onError, onChanged }: {
  projectId: string; story: Story; currentSceneId?: string; readOnly: boolean;
  onStory: (s: Story) => void; onOpenScene: (id: string) => void; onError: (m: string) => void; onChanged: () => void;
}) {
  const [collapsed, setCollapsed] = useLocalState<string[]>(`story-collapsed-${projectId}`, []);
  const [editing, setEditing] = useState<string | null>(null); // chapter or scene id; 'new-chapter' for the new row
  const [confirm, setConfirm] = useState<null | { title: string; message: string; run: () => Promise<void> }>(null);
  const drag = useRef<Drag>(null);
  const [over, setOver] = useState<string | null>(null);

  const run = async (fn: () => Promise<Story>) => {
    try { const s = await fn(); onStory(s); onChanged(); return s; } catch (e) { onError(errorText(e)); return null; }
  };
  const toggle = (id: string) => setCollapsed(collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]);

  const chapterMenu = (c: StoryChapter, i: number): MenuItem[] => [
    { label: 'Rename', onClick: () => setEditing(c.id) },
    { label: 'Add scene', onClick: async () => {
      const s = await run(() => api<Story>('POST', `/api/chapters/${c.id}/scenes`, { title: 'New scene' }));
      if (s?.created) { setCollapsed(collapsed.filter((x) => x !== c.id)); setEditing(s.created); onOpenScene(s.created); } } },
    { label: c.introductory ? 'Make a numbered chapter' : 'Mark as introductory', onClick: () => void run(() => api<Story>('PATCH', `/api/chapters/${c.id}`, { introductory: !c.introductory })) },
    'sep',
    { label: 'Move up', disabled: i === 0 || story.chapters[i - 1]!.introductory !== c.introductory, onClick: () => void run(() => api<Story>('POST', `/api/chapters/${c.id}/move`, { position: c.position - 1 })) },
    { label: 'Move down', disabled: i === story.chapters.length - 1 || story.chapters[i + 1]!.introductory !== c.introductory, onClick: () => void run(() => api<Story>('POST', `/api/chapters/${c.id}/move`, { position: c.position + 1 })) },
    'sep',
    { label: 'Delete', danger: true, onClick: () => {
      const cues = c.scenes.reduce((n, s) => n + s.cueCount, 0);
      setConfirm({ title: 'Delete chapter', message: `Delete "${c.title}" with ${c.scenes.length} scene${c.scenes.length === 1 ? '' : 's'} and ${cues} cue${cues === 1 ? '' : 's'}? This cannot be undone.`,
        run: async () => { const s = await run(() => api<Story>('DELETE', `/api/chapters/${c.id}`));
          if (s && c.scenes.some((x) => x.id === currentSceneId)) { const first = s.chapters.flatMap((x) => x.scenes)[0]; if (first) onOpenScene(first.id); } } });
    } },
  ];

  const onDropChapter = (target: StoryChapter) => {
    const d = drag.current; drag.current = null; setOver(null);
    if (!d) return;
    if (d.kind === 'chapter' && d.id !== target.id) void run(() => api<Story>('POST', `/api/chapters/${d.id}/move`, { position: target.position }));
    if (d.kind === 'scene') void run(() => api<Story>('POST', `/api/scenes/${d.id}/move`, { chapterId: target.id, position: 1000 }));
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
              onDrop={() => onDropChapter(c)}>
              <button className="twisty" onClick={() => toggle(c.id)}>{open ? '▾' : '▸'}</button>
              <span className="idx">{c.index}</span>
              {editing === c.id ? (
                <TitleInput value={c.title} onDone={(v) => { setEditing(null); if (v && v !== c.title) void run(() => api<Story>('PATCH', `/api/chapters/${c.id}`, { title: v })); }} />
              ) : <span className="title" onDoubleClick={() => !readOnly && setEditing(c.id)}>{c.title}</span>}
              {!readOnly && <MenuButton className="more" items={chapterMenu(c, ci)} title="Chapter options">⋯</MenuButton>}
            </div>
            {open && c.scenes.map((s, si) => (
              <div key={s.id} className={'row-item scene-row' + (s.id === currentSceneId ? ' current' : '') + (over === s.id ? ' over' : '')}
                draggable={!readOnly && editing !== s.id}
                onDragStart={(e) => { e.stopPropagation(); drag.current = { kind: 'scene', id: s.id }; }}
                onDragOver={(e) => { if (drag.current?.kind === 'scene') { e.preventDefault(); e.stopPropagation(); setOver(s.id); } }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => { e.stopPropagation(); const d = drag.current; drag.current = null; setOver(null);
                  if (d?.kind === 'scene' && d.id !== s.id) void run(() => api<Story>('POST', `/api/scenes/${d.id}/move`, { chapterId: c.id, position: s.position })); }}
                onClick={() => editing !== s.id && onOpenScene(s.id)}>
                {editing === s.id ? (
                  <TitleInput value={s.title} onDone={(v) => { setEditing(null); if (v && v !== s.title) void run(() => api<Story>('PATCH', `/api/scenes/${s.id}`, { title: v })); }} />
                ) : <span className="title" onDoubleClick={() => !readOnly && setEditing(s.id)}>{s.title}</span>}
                {!readOnly && <MenuButton className="more" title="Scene options" items={[
                  { label: 'Rename', onClick: () => setEditing(s.id) },
                  { label: 'Move up', disabled: si === 0, onClick: () => void run(() => api<Story>('POST', `/api/scenes/${s.id}/move`, { chapterId: c.id, position: s.position - 1 })) },
                  { label: 'Move down', disabled: si === c.scenes.length - 1, onClick: () => void run(() => api<Story>('POST', `/api/scenes/${s.id}/move`, { chapterId: c.id, position: s.position + 1 })) },
                  'sep',
                  { label: 'Delete', danger: true, onClick: () => setConfirm({
                    title: 'Delete scene', message: `Delete "${s.title}" with ${s.cueCount} cue${s.cueCount === 1 ? '' : 's'}? This cannot be undone.`,
                    run: async () => { const st = await run(() => api<Story>('DELETE', `/api/scenes/${s.id}`));
                      if (st && s.id === currentSceneId) { const next = st.chapters.flatMap((x) => x.scenes)[0]; if (next) onOpenScene(next.id); } } }) },
                ]}>⋯</MenuButton>}
              </div>))}
          </div>);
      })}
      {!readOnly && (editing === 'new-chapter' ? (
        <div className="row-item"><TitleInput value="" onDone={(v) => { setEditing(null); if (v) void run(() => api<Story>('POST', `/api/projects/${projectId}/chapters`, { title: v })); }} /></div>
      ) : <button className="add-chapter" title="Add chapter" onClick={() => setEditing('new-chapter')}>+</button>)}
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
