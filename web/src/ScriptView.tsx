import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { api, assetUrl, uploadFile } from './api.ts';
import { go } from './App.tsx';
import type { Character, LibListing, Me, NoteFocus, NoteItem, NoteRequest, NoteTargetKind, ProjectCard, SegmentContent, Story } from './types.ts';
import { NotesContext, badgesOf, type NotesInfo } from './notesContext.tsx';
import { AddNoteDialog } from './NotesPanel.tsx';
import { StoryIndex } from './StoryIndex.tsx';
import { Writing } from './Writing.tsx';
import { PlaceholderContext } from './characterArt.tsx';
import { RightPanel, type CharacterDialogState } from './RightPanel.tsx';
import { ago, cueCountOrder, inOrder } from './format.ts';
import { BlackbirdIcon } from './Brand.tsx';
import { MenuButton, errorText, useIsMobile, useLocalState, type MenuItem } from './ui.tsx';
import { NavBar } from './NavBar.tsx';
import { accountItems } from './AccountMenu.tsx';
import { NavContext, PlaybackStore } from './playback.ts';
import { toNav, type Pos } from './nav.ts';
import { recordTake } from './recording.ts';
import { TrimDialog, type TrimRequest } from './TrimDialog.tsx';
import { Timeline } from './Timeline.tsx';
import { AudioPlayer } from './audio-playback.ts';
import { LibPlayContext, LibraryPlayer, type LibTrack } from './libplayer.ts';
import { FileInfoPanel } from './Library.tsx';

export function ScriptView({ me, projectId, segmentId, onAccount, onLogout }: { me: Me; projectId: string; segmentId?: string; onAccount: () => void; onLogout: () => void }) {
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
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [noteRequest, setNoteRequest] = useState<NoteRequest | null>(null);
  const [addNote, setAddNote] = useState<{ target: { kind: NoteTargetKind; id: string } | null; label: string } | null>(null);
  // On a phone one panel fills the screen at a time; the menu in the top bar chooses it.
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile); isMobileRef.current = isMobile;
  // Each panel the menu opens is a step in the browser's history, so Back returns to the panel shown before (Index, Script, …)
  // and only leaves the script when there is none. The entries keep the page's address; the panel is in the history state.
  const [mview, setMview] = useState<MobileView>(() => (history.state?.rsView as MobileView | undefined) ?? 'script');
  const mviewRef = useRef(mview);
  // The character view (a character opened from the list) is one more step in that history, so Back, like the title, returns to the list.
  const openEditor = useCallback((s: CharacterDialogState) => {
    if (s && isMobileRef.current && !history.state?.rsEditor) history.pushState({ rsView: 'characters', rsEditor: true }, '');
    setDialog(s);
  }, []);
  const closeEditor = (then?: boolean) => {
    if (isMobile && history.state?.rsEditor) { history.go(then ? -2 : -1); return; } // the popstate handler closes it
    setDialog(null);
  };
  const showView = useCallback((v: MobileView) => {
    if (v === mviewRef.current) return;
    history.pushState({ rsView: v }, '');
    mviewRef.current = v; setMview(v);
  }, []);
  useEffect(() => {
    if (!isMobile) return;
    if (history.state?.rsView === undefined) history.replaceState({ ...(history.state ?? {}), rsView: mviewRef.current }, '');
    const pop = (e: PopStateEvent) => { const v = (e.state?.rsView as MobileView | undefined) ?? 'script'; mviewRef.current = v; setMview(v); if (!e.state?.rsEditor) setDialog(null); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [isMobile]);

  const loadProject = useCallback(async () => { try { setProject(await api<ProjectCard>('GET', `/api/projects/${projectId}`)); } catch (e) { setError(errorText(e)); } }, [projectId]);
  // The Characters tab lists the most used first. The order is taken once, when the page loads the list, and kept after that.
  const charOrder = useRef<{ projectId: string; ids: string[] } | null>(null);
  const loadCharacters = useCallback(async () => {
    const list = (await api<{ characters: Character[] }>('GET', `/api/projects/${projectId}/characters`)).characters;
    if (charOrder.current?.projectId !== projectId) charOrder.current = { projectId, ids: cueCountOrder(list) };
    setCharacters(list);
  }, [projectId]);
  const panelCharacters = useMemo(() => inOrder(characters, charOrder.current?.ids ?? []), [characters]);
  const loadStory = useCallback(async () => setStory(await api<Story>('GET', `/api/projects/${projectId}/story`)), [projectId]);

  const loadNotes = useCallback(async () => {
    try { setNotes((await api<{ notes: NoteItem[] }>('GET', `/api/projects/${projectId}/notes`)).notes); } catch (e) { setError(errorText(e)); }
  }, [projectId]);
  useEffect(() => { void loadNotes(); }, [loadNotes]);
  useEffect(() => { void loadProject(); void loadCharacters(); void loadStory().catch((e) => setError(errorText(e))); }, [loadProject, loadCharacters, loadStory]);

  // Where the script stopped last time (the playhead's place), kept in the browser per project: opening the project returns there.
  const resumeKey = `rs.resume.${projectId}`;
  const resume = useRef<Pos | null>((() => { try { const r = JSON.parse(localStorage.getItem(resumeKey) ?? 'null'); return r && typeof r.segmentId === 'string' && Number.isFinite(r.scene) && Number.isFinite(r.ms) ? (r as Pos) : null; } catch { return null; } })());
  const resumeScroll = useRef(false);
  // Without a segment in the address, open the one the script stopped in, or the first one.
  useEffect(() => {
    if (!segmentId && story) {
      const all = story.chapters.flatMap((c) => c.segments);
      const target = all.find((s) => s.id === resume.current?.segmentId) ?? all[0];
      if (target) location.replace(`#/p/${projectId}/s/${target.id}`);
    }
  }, [segmentId, story, projectId]);
  useEffect(() => {
    if (!segmentId) { setContent(null); return; }
    let live = true;
    api<SegmentContent>('GET', `/api/segments/${segmentId}`).then((c) => live && setContent(c)).catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [segmentId]);

  // Opening another segment starts at its top; re-clicking the open one leaves the scroll where it is.
  const mainRef = useRef<HTMLElement>(null);
  const titlesRef = useRef<HTMLDivElement>(null);
  const [titlesGone, setTitlesGone] = useState(false);
  const [tlOpen, setTlOpen] = useLocalState('rs.timelineOpen', true);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [segmentId]);
  // Once the chapter and segment titles have scrolled out of sight, a slim header says where we are.
  useEffect(() => {
    const el = titlesRef.current, root = mainRef.current;
    if (!el || !root) { setTitlesGone(false); return; }
    const io = new IntersectionObserver(([e]) => setTitlesGone(!!e && !e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 1), { root, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [content?.segment.id]);

  // The scene at the top of the view, named in the slim header too (a scene without a title adds nothing).
  const [topScene, setTopScene] = useState<string | null>(null);
  useEffect(() => {
    const root = mainRef.current;
    if (!root || !content) { setTopScene(null); return; }
    let raf = 0;
    const update = () => {
      raf = 0;
      const line = root.getBoundingClientRect().top + 31;
      let id: string | null = null;
      root.querySelectorAll<HTMLElement>('.scene[data-scene-id]').forEach((s) => { if (s.getBoundingClientRect().top <= line) id = s.dataset.sceneId ?? null; });
      setTopScene(id);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => { root.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [content]);
  const topSceneLabel = content?.scenes.find((s) => s.id === topScene)?.label ?? null;

  const readOnly = project?.role === 'viewer';
  // The project's character placeholder (an image called profile_placeholder in the Characters folder).
  const [placeholder, setPlaceholder] = useState<string | null>(null);
  const loadPlaceholder = useCallback(() => {
    void api<LibListing>('GET', `/api/projects/${projectId}/library?folder=Characters`).then((l) => {
      const f = l.files.find((x) => x.kind === 'image' && x.name.replace(/\.[^.]+$/, '').toLowerCase() === 'profile_placeholder');
      setPlaceholder(f ? assetUrl(f.id, f.hasLightweight) : null);
    }).catch(() => undefined);
  }, [projectId]);
  useEffect(loadPlaceholder, [loadPlaceholder]);
  // On a wide screen the script is at its maximum width and leaves room at its left: speech cues show their character there
  // (the circle is 50 to 100 px, whatever fits). The room is measured, not assumed, so it follows the panels and the window.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    if (isMobile) { main.removeAttribute('data-faces'); return; }
    const update = () => {
      const doc = main.querySelector('.doc');
      if (!doc) { main.removeAttribute('data-faces'); return; }
      const free = doc.getBoundingClientRect().left - (main.getBoundingClientRect().left + main.clientLeft);
      const room = Math.min(100, Math.floor(free - 30)); // 30: the tail, its gap and a margin at the window edge
      if (room < 50) { main.removeAttribute('data-faces'); return; }
      main.setAttribute('data-faces', '');
      // All circles of a scene share one size: the room available, or the shortest cue of that scene if smaller.
      main.querySelectorAll<HTMLElement>('.scene').forEach((sc) => {
        let size = room;
        sc.querySelectorAll<HTMLElement>('.cue.faced').forEach((q) => { size = Math.min(size, Math.floor(q.offsetHeight - 4)); });
        sc.style.setProperty('--face', Math.max(size, 24) + 'px');
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(main);
    const watched = new Set<Element>();
    const watch = () => main.querySelectorAll('.cue.faced').forEach((q) => { if (!watched.has(q)) { watched.add(q); ro.observe(q); } });
    watch();
    const mo = new MutationObserver(() => { watch(); update(); });
    mo.observe(main, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [isMobile, content?.segment.id]);
  const refreshAfterEdit = () => { void loadProject(); void loadStory(); void loadNotes(); loadPlaceholder(); };
  const onContent = (c: SegmentContent) => { setContent(c); refreshAfterEdit(); };
  // On a phone, changing segment must not add history steps (Back would walk through segments instead of panels).
  const openSegment = (id: string) => {
    if (!isMobile) { go(`/p/${projectId}/s/${id}`); return; }
    history.replaceState(history.state, '', `#/p/${projectId}/s/${id}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  // A cue picked in the Library (a file's preview): open its segment, put the playhead on it and scroll to it.
  const [showing, setShowing] = useState<{ segmentId: string; cueId: string } | null>(null);
  const showCue = (c: { segmentId: string; cueId: string }) => {
    setShowing({ segmentId: c.segmentId, cueId: c.cueId });
    showView('script');
    if (c.segmentId !== segmentId) { expectedNav.current = c.segmentId; openSegment(c.segmentId); }
  };

  // ---- navigation bar: one playhead for the whole script view ----
  const [playback] = useState(() => new PlaybackStore());
  useEffect(() => () => playback.dispose(), [playback]);
  useEffect(() => { const player = new AudioPlayer(playback); return () => player.dispose(); }, [playback]);
  // A sound played from the Library: the bar takes the library layout, and the script waits where it was until "Return to script".
  const [lib] = useState(() => new LibraryPlayer());
  useEffect(() => () => lib.dispose(), [lib]);
  const libTrack = useSyncExternalStore(lib.subscribe, () => lib.track);
  const [libInfo, setLibInfo] = useState(false);
  useEffect(() => { if (!libTrack) setLibInfo(false); }, [libTrack]);
  const playLib = useCallback((t: LibTrack, startFrac?: number) => {
    if (playback.rec) { setError('Stop the recording first.'); return; } // the sound would go into the microphone
    playback.pause();
    lib.play(t, startFrac);
  }, [playback, lib]);
  const [follow, setFollow] = useLocalState('rs.follow', true);
  const [editingN, setEditingN] = useState(0);
  const editing = editingN > 0;
  const setEditing = useCallback((on: boolean) => setEditingN((n) => Math.max(0, n + (on ? 1 : -1))), []);
  const contentRef = useRef(content); contentRef.current = content;
  const onContentRef = useRef(onContent); onContentRef.current = onContent;
  const [trim, setTrim] = useState<TrimRequest | null>(null);
  const record = useCallback((cueId: string) => {
    const c = contentRef.current;
    const si = c ? c.scenes.findIndex((s) => s.cues.some((q) => q.id === cueId)) : -1;
    if (!c || si < 0) return;
    lib.close();
    const q = c.scenes[si]!.cues.find((x) => x.id === cueId)!;
    void recordTake({
      store: playback, cueId,
      seek: () => playback.seek({ segmentId: c.segment.id, scene: si, ms: q.startMs }),
      review: (take) => new Promise((resolve) => setTrim({ take, text: q.text, resolve })),
      upload: async (wav) => {
        onContentRef.current(await uploadFile<SegmentContent>('POST', `/api/cues/${cueId}/recording`, wav));
        window.dispatchEvent(new Event('library-changed'));
      },
      onError: setError,
    });
  }, [playback, lib]);
  const nav = useMemo(() => ({ store: playback, setEditing, record }), [playback, setEditing, record]);
  const order = useMemo(() => (story ? story.chapters.flatMap((c) => c.segments.map((x) => x.id)) : []), [story]);
  useEffect(() => playback.setOrder(order), [playback, order]);
  const sub = playback.subscribe;
  const wanted = useSyncExternalStore(sub, () => playback.wantedSegment() ?? '');
  const curCue = useSyncExternalStore(sub, () => playback.currentCueId());
  const curScene = useSyncExternalStore(sub, () => playback.currentSceneId());
  // The Notes panel opens on the place the reader is at: the open segment's chapter, and the scene and cue under the playhead.
  const noteFocus = useMemo<NoteFocus>(() => {
    const seg = content?.segment;
    const sceneIdx = content ? content.scenes.findIndex((s) => s.id === curScene) : -1;
    const cueRow = content && curCue ? content.scenes.flatMap((s) => s.cues).find((c) => c.id === curCue) : undefined;
    return {
      chapterId: seg?.chapterId ?? null, segmentId: seg?.id ?? null,
      sceneId: sceneIdx >= 0 ? curScene : null, sceneNo: sceneIdx >= 0 ? content!.scenes[sceneIdx]!.position : null,
      cueId: cueRow && sceneIdx >= 0 ? cueRow.id : null,
      cueLabel: cueRow ? cueRow.text.replace(/\s+/g, ' ').trim().slice(0, 60) || null : null,
    };
  }, [content, curScene, curCue]);
  const notesInfo = useMemo<NotesInfo>(() => ({ ...badgesOf(notes),
    forTarget: (kind, id) => notes.filter((n) => n.target?.kind === kind && n.target.id === id && !n.rootNoteId && !n.deleted),
    readOnly: !!readOnly,
    setDone: async (noteId, done) => {
      try { await api('POST', `/api/notes/${noteId}/done`, { done }); await loadNotes(); void loadProject(); } catch (e) { setError(errorText(e)); }
    },
    show: (r) => { setNoteRequest({ ...r, n: Date.now() }); showView('notes'); }, add: (target, label) => setAddNote({ target, label }) }), [notes, readOnly, loadNotes, loadProject, showView]);
  // Opening a segment yourself (index, address, back button) puts the playhead at its start. Moves the bar makes
  // itself are marked in `expectedNav` so they are not mistaken for that.
  const expectedNav = useRef<string | null>(null);
  useEffect(() => {
    if (!segmentId) return;
    if (resume.current && resume.current.segmentId === segmentId) { const r = resume.current; resume.current = null; resumeScroll.current = true; playback.seek(r); return; }
    resume.current = null;
    if (expectedNav.current === segmentId) { expectedNav.current = null; return; }
    if (playback.wantedSegment() !== segmentId) playback.jump(segmentId, 'start', false);
  }, [segmentId, playback]);
  // Follow: the open segment goes where the playhead goes (not while a cue is being edited).
  useEffect(() => {
    const w = playback.wantedSegment();
    if (follow && !editing && w && segmentId && w !== segmentId) { expectedNav.current = w; openSegment(w); }
  }, [follow, editing, wanted, segmentId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The playhead's segment: the open one when its content is loaded, otherwise fetched for the bar alone.
  useEffect(() => {
    if (!wanted) return;
    if (content && content.segment.id === wanted) { playback.setData(toNav(content)); return; }
    if (follow && !editing) return; // the view is on its way there and supplies the content
    let live = true;
    api<SegmentContent>('GET', `/api/segments/${wanted}`).then((c) => live && playback.setData(toNav(c))).catch(() => undefined);
    return () => { live = false; };
  }, [wanted, content, follow, editing, playback]);
  // Remember the playhead's place; on opening, scroll to it once.
  useEffect(() => {
    const p = playback.pos;
    if (p) { try { localStorage.setItem(resumeKey, JSON.stringify({ segmentId: p.segmentId, scene: p.scene, ms: p.ms })); } catch { /* ignore */ } }
  }, [wanted, curCue, curScene, playback, resumeKey]);
  useEffect(() => {
    if (!resumeScroll.current) return;
    const el = (curCue && document.querySelector(`[data-cue-id="${curCue}"]`)) || (curScene && document.querySelector(`[data-scene-id="${curScene}"]`));
    if (el) { resumeScroll.current = false; (el as HTMLElement).scrollIntoView({ block: 'center' }); }
  }, [curCue, curScene, content]);
  // Follow: scroll to the cue (or empty scene) under the playhead when it changes, and when Follow is switched on.
  const scrolled = useRef('');
  useEffect(() => {
    if (!follow || editing) return;
    const id = `${follow}|${curCue || curScene}`;
    if (scrolled.current === id) return;
    const el = (curCue && document.querySelector(`[data-cue-id="${curCue}"]`)) || (curScene && document.querySelector(`[data-scene-id="${curScene}"]`));
    if (el) { scrolled.current = id; (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }, [follow, editing, curCue, curScene, content]);
  useEffect(() => {
    if (!showing || !content || content.segment.id !== showing.segmentId) return;
    const si = content.scenes.findIndex((sc) => sc.cues.some((q) => q.id === showing.cueId));
    setShowing(null);
    if (si < 0) return;
    const q = content.scenes[si]!.cues.find((x) => x.id === showing.cueId)!;
    playback.seek({ segmentId: content.segment.id, scene: si, ms: q.startMs });
    setTimeout(() => (document.querySelector(`[data-cue-id="${showing.cueId}"]`) as HTMLElement | null)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
  }, [showing, content, playback]);

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
    <NavContext.Provider value={nav}>
    <LibPlayContext.Provider value={playLib}>
    <NotesContext.Provider value={notesInfo}>
    <PlaceholderContext.Provider value={placeholder}>
    <div className="script">
      {isMobile ? (
        <header className="topbar mobile-top">
          <a href="#/" className="brand" title="Projects"><BlackbirdIcon /></a>
          <div className={'m-title' + (mview === 'characters' && dialog ? ' tap' : '')} onClick={() => { if (mview === 'characters' && dialog) closeEditor(!!dialog.then); }}><b>{mview === 'script' ? project.title : MOBILE_VIEWS.find((v) => v.id === mview)!.label}</b>
            {(mview !== 'script' || readOnly) && <span>{mview === 'script' ? 'view only' : project.title + (readOnly ? ' · view only' : '')}</span>}</div>
          <MenuButton className="m-menu" title="Menu" items={mobileMenu(mview, (v) => (v === 'characters' && mview === 'characters' && dialog ? closeEditor(!!dialog.then) : showView(v)), {
            readOnly: !!readOnly, saving, status: project.dirtySince ? 'unsaved' : ago(project.lastSnapshotAt), onSnapshot: () => void saveSnapshot(),
            onProject: () => go(`/p/${projectId}`), onProjects: () => go('/'), onAccount, onLogout })}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </MenuButton>
        </header>
      ) : (
      <header className="topbar">
        <a href="#/" className="brand" title="Projects"><BlackbirdIcon /></a>
        <a href={`#/p/${projectId}`}>{project.title}</a>
        {project.subtitle && <span className="topbar-sub" title={project.subtitle}>{project.subtitle}</span>}<span className="grow" />
        {error && <span className="error inline-error" onClick={() => setError('')}>{error}</span>}
        {saved && <span className="muted">{saved}</span>}
        <span className="muted small">{project.dirtySince ? 'Unsaved changes' : `Snapshot ${ago(project.lastSnapshotAt)}`}{readOnly && ' · view only'}</span>
        <MenuButton className="m-menu" title="Menu" items={[
          ...(readOnly ? [] : [{ label: saving ? 'Saving…' : 'Save snapshot', hint: project.dirtySince ? 'unsaved' : ago(project.lastSnapshotAt), disabled: saving, onClick: () => void saveSnapshot() } as MenuItem]),
          { label: 'Project properties', onClick: () => go(`/p/${projectId}`) },
          { label: 'All projects', onClick: () => go('/') },
          'sep', ...accountItems(onAccount, onLogout),
        ]}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </MenuButton>
      </header>)}
      {isMobile && (error || saved) && <div className={'m-banner ' + (error ? 'error' : 'muted')} onClick={() => { setError(''); setSaved(''); }}>{error || saved}</div>}
      <div className="script-body" data-mview={isMobile ? mview : undefined} style={{ '--lw': `${leftW}px`, '--rw': `${rightW}px` } as CSSProperties}>
        {!isMobile && <Splitter side="left" width={leftW} onChange={setLeftW} />}
        {!isMobile && <Splitter side="right" width={rightW} onChange={setRightW} />}
        <StoryIndex projectId={projectId} story={story} currentSegmentId={segmentId} readOnly={!!readOnly}
          onPick={() => showView('script')}
          onStory={setStory} onOpenSegment={openSegment} onError={setError} onChanged={() => { void loadProject(); if (segmentId) void api<SegmentContent>('GET', `/api/segments/${segmentId}`).then(setContent).catch(() => setContent(null)); }} />
        <main className="center-col" ref={mainRef}>
          {content ? (
            <>
            <div className="where-wrap"><div className={'where' + (titlesGone ? ' on' : '')} onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })} title="Back to the top" data-testid="where">
              <b>{content.segment.chapterTitle}</b><span className="sep">›</span><span>{content.segment.title}</span>
              {topSceneLabel && <><span className="sep">›</span><span>{topSceneLabel}</span></>}
            </div></div>
            <div className="doc">
              <div ref={titlesRef}>
              <TitleEdit className="chapter-title" value={content.segment.chapterTitle} disabled={!!readOnly} onSave={(v) => renameTitle('chapter', content.segment.chapterId, v)} />
              <TitleEdit className="segment-title" value={content.segment.title} disabled={!!readOnly} onSave={(v) => renameTitle('segment', content.segment.id, v)} />
              </div>
              <Writing content={content} characters={characters} readOnly={!!readOnly} onContent={onContent} onError={setError}
                onNewCharacter={(then) => { if (isMobile) showView('characters'); openEditor({ then }); }}
                onOpenCharacter={readOnly ? undefined : (c) => { if (isMobile) showView('characters'); openEditor({ character: c }); }} />
            </div>
            </>
          ) : <p className="muted">Select or add a segment.</p>}
        </main>
        <RightPanel projectId={projectId} meId={me.user.id} characters={panelCharacters} readOnly={!!readOnly}
          onCharacters={() => void loadCharacters()} onError={setError} openDialog={openEditor}
          editor={dialog} allCharacters={characters}
          onCloseEditor={() => closeEditor(!!dialog?.then)}
          onEditorSaved={() => { void loadCharacters(); if (segmentId) void api<SegmentContent>('GET', `/api/segments/${segmentId}`).then(setContent); }}
          notes={notes} story={story} noteFocus={noteFocus} noteRequest={noteRequest} onNotesChanged={() => { void loadNotes(); void loadProject(); }} onAssetChanged={refreshAfterEdit} onOpenCue={showCue}
          mobileTab={isMobile && (mview === 'characters' || mview === 'library' || mview === 'notes') ? mview : undefined} />
      </div>
      {content && project.type !== 'textbook' && tlOpen && !isMobile && <Timeline content={content} readOnly={!!readOnly} onContent={onContent} onError={setError} />}
      {libTrack && libInfo && <FileInfoPanel file={libTrack} notes={notes} onClose={() => setLibInfo(false)} onError={setError}
        onOpenCue={(c) => { lib.close(); showCue(c); }} onShowNote={() => notesInfo.show({ assetId: libTrack.id })} />}
      <NavBar store={playback} lib={lib} libInfo={{ open: libInfo, onToggle: () => setLibInfo((v) => !v) }} story={story} follow={follow} onFollow={setFollow} editing={editing} mobile={isMobile}
        timeline={project.type !== 'textbook' && !isMobile ? { open: tlOpen, onToggle: () => setTlOpen(!tlOpen) } : undefined} />
      {addNote && <AddNoteDialog projectId={projectId} target={addNote.target} label={addNote.label} onClose={() => setAddNote(null)}
        onSaved={() => { void loadNotes(); void loadProject(); }} />}
      {trim && <TrimDialog req={trim} onDone={(keep) => { trim.resolve(keep); setTrim(null); }} />}
    </div>
    </PlaceholderContext.Provider>
    </NotesContext.Provider>
    </LibPlayContext.Provider>
    </NavContext.Provider>
  );
}

type MobileView = 'script' | 'index' | 'characters' | 'library' | 'notes';
const MOBILE_VIEWS: { id: MobileView; label: string }[] = [
  { id: 'script', label: 'Script' }, { id: 'index', label: 'Index' }, { id: 'characters', label: 'Characters' },
  { id: 'library', label: 'Library' }, { id: 'notes', label: 'Notes' },
];

/** The phone's menu: which panel fills the screen, then the actions the desktop top bar has. */
function mobileMenu(current: MobileView, show: (v: MobileView) => void, o: {
  readOnly: boolean; saving: boolean; status: string; onSnapshot: () => void; onProject: () => void; onProjects: () => void; onAccount: () => void; onLogout: () => void;
}): MenuItem[] {
  return [
    ...MOBILE_VIEWS.map((v): MenuItem => ({ label: v.label, checked: v.id === current, onClick: () => show(v.id) })),
    'sep',
    ...(o.readOnly ? [] : [{ label: o.saving ? 'Saving…' : 'Save snapshot', hint: o.status, disabled: o.saving, onClick: o.onSnapshot } as MenuItem]),
    { label: 'Project properties', onClick: o.onProject },
    { label: 'All projects', onClick: o.onProjects },
    'sep',
    ...accountItems(o.onAccount, o.onLogout),
  ];
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
