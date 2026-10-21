import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { go } from './App.tsx';
import type { Character, Me, ProjectCard, SceneContent, Story } from './types.ts';
import { StoryIndex } from './StoryIndex.tsx';
import { Writing } from './Writing.tsx';
import { CharacterDialog, RightPanel, type CharacterDialogState } from './RightPanel.tsx';
import { ago } from './format.ts';
import { BlackbirdIcon } from './Brand.tsx';
import { errorText } from './ui.tsx';

export function ScriptView({ me, projectId, sceneId }: { me: Me; projectId: string; sceneId?: string }) {
  const [project, setProject] = useState<ProjectCard | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [content, setContent] = useState<SceneContent | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<CharacterDialogState>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  const loadProject = useCallback(async () => { try { setProject(await api<ProjectCard>('GET', `/api/projects/${projectId}`)); } catch (e) { setError(errorText(e)); } }, [projectId]);
  const loadCharacters = useCallback(async () => setCharacters((await api<{ characters: Character[] }>('GET', `/api/projects/${projectId}/characters`)).characters), [projectId]);
  const loadStory = useCallback(async () => setStory(await api<Story>('GET', `/api/projects/${projectId}/story`)), [projectId]);

  useEffect(() => { void loadProject(); void loadCharacters(); void loadStory().catch((e) => setError(errorText(e))); }, [loadProject, loadCharacters, loadStory]);

  // Without a scene in the address, open the first one.
  useEffect(() => {
    if (!sceneId && story) { const first = story.chapters.flatMap((c) => c.scenes)[0]; if (first) location.replace(`#/p/${projectId}/s/${first.id}`); }
  }, [sceneId, story, projectId]);
  useEffect(() => {
    if (!sceneId) { setContent(null); return; }
    let live = true;
    api<SceneContent>('GET', `/api/scenes/${sceneId}`).then((c) => live && setContent(c)).catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [sceneId]);

  const readOnly = project?.role === 'viewer';
  const refreshAfterEdit = () => { void loadProject(); void loadStory(); };
  const onContent = (c: SceneContent) => { setContent(c); refreshAfterEdit(); };
  const openScene = (id: string) => go(`/p/${projectId}/s/${id}`);

  const renameTitle = async (kind: 'chapter' | 'scene', id: string, title: string) => {
    try { await api(`PATCH`, `/api/${kind === 'chapter' ? 'chapters' : 'scenes'}/${id}`, { title }); await loadStory(); if (sceneId) setContent(await api<SceneContent>('GET', `/api/scenes/${sceneId}`)); }
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
      <div className="script-body">
        <StoryIndex projectId={projectId} story={story} currentSceneId={sceneId} readOnly={!!readOnly}
          onStory={setStory} onOpenScene={openScene} onError={setError} onChanged={() => { void loadProject(); if (sceneId) void api<SceneContent>('GET', `/api/scenes/${sceneId}`).then(setContent).catch(() => setContent(null)); }} />
        <main className="center-col">
          {content ? (
            <div className="doc">
              <TitleEdit className="chapter-title" value={content.scene.chapterTitle} disabled={!!readOnly} onSave={(v) => renameTitle('chapter', content.scene.chapterId, v)} />
              <TitleEdit className="scene-title" value={content.scene.title} disabled={!!readOnly} onSave={(v) => renameTitle('scene', content.scene.id, v)} />
              <Writing content={content} characters={characters} readOnly={!!readOnly} onContent={onContent} onError={setError}
                onNewCharacter={(then) => setDialog({ then })} />
            </div>
          ) : <p className="muted">Select or add a scene.</p>}
        </main>
        <RightPanel characters={characters} readOnly={!!readOnly}
          onCharacters={() => void loadCharacters()} onError={setError} openDialog={setDialog} />
      </div>
      {dialog && <CharacterDialog projectId={projectId} state={dialog} characters={characters} onClose={() => setDialog(null)}
        onSaved={() => { void loadCharacters(); if (sceneId) void api<SceneContent>('GET', `/api/scenes/${sceneId}`).then(setContent); }} onError={setError} />}
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
