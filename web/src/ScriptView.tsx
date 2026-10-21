import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { api } from './api.ts';
import { go } from './App.tsx';
import type { Character, Me, ProjectCard, SegmentContent, Story } from './types.ts';
import { StoryIndex } from './StoryIndex.tsx';
import { Writing } from './Writing.tsx';
import { CharacterDialog, RightPanel, type CharacterDialogState } from './RightPanel.tsx';
import { ago } from './format.ts';
import { BlackbirdIcon } from './Brand.tsx';
import { errorText, useLocalState } from './ui.tsx';

export function ScriptView({ me, projectId, segmentId }: { me: Me; projectId: string; segmentId?: string }) {
  const [project, setProject] = useState<ProjectCard | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [content, setContent] = useState<SegmentContent | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [error, setError] = useState('');
  const [leftW, setLeftW] = useLocalState('rs.leftW', 280);
  const [rightW, setRightW] = useLocalState('rs.rightW', 320);
  const [dialog, setDialog] = useState<CharacterDialogState>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  const loadProject = useCallback(async () => { try { setProject(await api<ProjectCard>('GET', `/api/projects/${projectId}`)); } catch (e) { setError(errorText(e)); } }, [projectId]);
  const loadCharacters = useCallback(async () => setCharacters((await api<{ characters: Character[] }>('GET', `/api/projects/${projectId}/characters`)).characters), [projectId]);
  const loadStory = useCallback(async () => setStory(await api<Story>('GET', `/api/projects/${projectId}/story`)), [projectId]);

  useEffect(() => { void loadProject(); void loadCharacters(); void loadStory().catch((e) => setError(errorText(e))); }, [loadProject, loadCharacters, loadStory]);

  // Without a segment in the address, open the first one.
  useEffect(() => {
    if (!segmentId && story) { const first = story.chapters.flatMap((c) => c.segments)[0]; if (first) location.replace(`#/p/${projectId}/s/${first.id}`); }
  }, [segmentId, story, projectId]);
  useEffect(() => {
    if (!segmentId) { setContent(null); return; }
    let live = true;
    api<SegmentContent>('GET', `/api/segments/${segmentId}`).then((c) => live && setContent(c)).catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [segmentId]);

  // Opening another segment starts at its top; re-clicking the open one leaves the scroll where it is.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [segmentId]);

  const readOnly = project?.role === 'viewer';
  const refreshAfterEdit = () => { void loadProject(); void loadStory(); };
  const onContent = (c: SegmentContent) => { setContent(c); refreshAfterEdit(); };
  const openSegment = (id: string) => go(`/p/${projectId}/s/${id}`);

  const renameTitle = async (kind: 'chapter' | 'segment', id: string, title: string) => {
    try { await api(`PATCH`, `/api/${kind === 'chapter' ? 'chapters' : 'segments'}/${id}`, { title }); await loadStory(); if (segmentId) setContent(await api<SegmentContent>('GET', `/api/segments/${segmentId}`)); }
    catch (e) { setError(errorText(e)); }
  };

  const saveSnapshot = async () => {
    setSaving(true); setSaved(''); setError('');
    try { await api('POST', `/api/projects/${projectId}/snapshot`, {}); setSaved('Snapshot saved.'); await loadProject(); }
    catch (e: any) { setError(e.status === 404 ? 'Snapshots are not available yet.' : errorText(e)); }
    finally { setSaving(false); }
  };

  if (error && !project) return <div className="page"><a href="#/">← Projects</a><p className="error">{error}</p></div>;
  if (!project || !story) return <div className="center muted">Loading…</div>;

  return (
    <div className="script">
      <header className="topbar">
        <a href="#/" className="brand" title="Projects"><BlackbirdIcon /></a>
        <a href={`#/p/${projectId}`}>{project.title}</a><span className="grow" />
        {error && <span className="error inline-error" onClick={() => setError('')}>{error}</span>}
        {saved && <span className="muted">{saved}</span>}
        <span className="muted small">{project.dirtySince ? 'Unsaved changes' : `Snapshot ${ago(project.lastSnapshotAt)}`}</span>
        {!readOnly && <button onClick={() => void saveSnapshot()} disabled={saving}>{saving ? 'Saving…' : 'Save snapshot'}</button>}
        <span className="muted small">{me.user.displayName}{readOnly && ' · view only'}</span>
      </header>
      <div className="script-body" style={{ '--lw': `${leftW}px`, '--rw': `${rightW}px` } as CSSProperties}>
        <Splitter side="left" width={leftW} onChange={setLeftW} />
        <Splitter side="right" width={rightW} onChange={setRightW} />
        <StoryIndex projectId={projectId} story={story} currentSegmentId={segmentId} readOnly={!!readOnly}
          onStory={setStory} onOpenSegment={openSegment} onError={setError} onChanged={() => { void loadProject(); if (segmentId) void api<SegmentContent>('GET', `/api/segments/${segmentId}`).then(setContent).catch(() => setContent(null)); }} />
        <main className="center-col" ref={mainRef}>
          {content ? (
            <div className="doc">
              <TitleEdit className="chapter-title" value={content.segment.chapterTitle} disabled={!!readOnly} onSave={(v) => renameTitle('chapter', content.segment.chapterId, v)} />
              <TitleEdit className="segment-title" value={content.segment.title} disabled={!!readOnly} onSave={(v) => renameTitle('segment', content.segment.id, v)} />
              <Writing content={content} characters={characters} readOnly={!!readOnly} onContent={onContent} onError={setError}
                onNewCharacter={(then) => setDialog({ then })} />
            </div>
          ) : <p className="muted">Select or add a segment.</p>}
        </main>
        <RightPanel projectId={projectId} characters={characters} readOnly={!!readOnly}
          onCharacters={() => void loadCharacters()} onError={setError} openDialog={setDialog} />
      </div>
      {dialog && <CharacterDialog projectId={projectId} state={dialog} characters={characters} onClose={() => setDialog(null)}
        onSaved={() => { void loadCharacters(); if (segmentId) void api<SegmentContent>('GET', `/api/segments/${segmentId}`).then(setContent); }} onError={setError} />}
    </div>
  );
}

function TitleEdit({ value, onSave, className, disabled }: { value: string; onSave: (v: string) => void; className: string; disabled: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (disabled) return <div className={className}>{value}</div>;
  return <input className={'inline ' + className} value={v} onChange={(e) => setV(e.target.value)}
    onBlur={() => v.trim() && v !== value && onSave(v.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

/** A draggable divider between a side panel and the writing panel; the width is remembered in the browser. */
function Splitter({ side, width, onChange }: { side: 'left' | 'right'; width: number; onChange: (w: number) => void }) {
  const start = (e: RPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    let latest = w0;
    const body = e.currentTarget.parentElement!;
    const move = (m: PointerEvent) => {
      const delta = side === 'left' ? m.clientX - x0 : x0 - m.clientX;
      latest = Math.max(180, Math.min(640, w0 + delta));
      body.style.setProperty(side === 'left' ? '--lw' : '--rw', `${latest}px`);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); onChange(latest); };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className={'splitter sp-' + side} style={side === 'left' ? { left: `calc(var(--lw) - 3px)` } : { right: `calc(var(--rw) - 3px)` }}
    onPointerDown={start} onDoubleClick={() => onChange(side === 'left' ? 280 : 320)} title="Drag to resize (double-click to reset)" />;
}
