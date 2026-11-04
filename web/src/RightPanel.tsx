import { useEffect, useRef, useState } from 'react';
import { api, assetUrl, uploadFile } from './api.ts';
import { LibraryPanel, type FileCue } from './Library.tsx';
import { NotesPanel } from './NotesPanel.tsx';
import type { Character, LibListing, NoteFocus, NoteItem, NoteRequest, Story } from './types.ts';
import { CHARACTER_DRAG, ColourPicker, Confirm, Dialog, errorText, useLocalState } from './ui.tsx';
import { nextColour } from '../../src/shared/palette.ts';
import { Initials } from './characterArt.tsx';

/** What the Characters tab is editing: null = the list; {} = a new character; {character} = that character. */
export type CharacterDialogState = null | { character?: Character; then?: (c: Character) => void };

export function CharacterEditor({ projectId, state, characters, readOnly, showBack, placeholder, onRemove, onClose, onSaved, onError, onAssetChanged, notes, onOpenCue }: {
  projectId: string; state: NonNullable<CharacterDialogState>; characters: Character[]; readOnly: boolean;
  /** A back button above the form: on a phone only (the tab header is hidden there). */
  showBack: boolean;
  /** URL of the faded stand-in image for a character without a picture. */
  placeholder: string | null;
  onRemove: (c: Character) => void;
  onClose: () => void; onSaved: (c: Character) => void; onError: (m: string) => void;
  onAssetChanged: () => void; notes: NoteItem[]; onOpenCue: (c: FileCue) => void;
}) {
  // An existing character opens to look at (name, description, picture); Edit switches to the fields. A new one starts in the fields.
  const [current, setCurrent] = useState<Character | undefined>(state.character);
  const [mode, setMode] = useState<'view' | 'edit'>(state.character ? 'view' : 'edit');
  const [name, setName] = useState(current?.name ?? '');
  const [colour, setColour] = useState(current?.colour ?? nextColour(characters.map((c) => c.colour)));
  const [description, setDescription] = useState(current?.description ?? '');
  const [askLanes, setAskLanes] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pictureId, setPictureId] = useState<string | null>(current?.pictureAssetId ?? null);
  const [libShow, setLibShow] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) { setPreviewUrl(null); return; }
    const u = URL.createObjectURL(file);
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const shownPicture = previewUrl ?? (pictureId ? assetUrl(pictureId, true) : null);
  const editingNow = mode === 'edit';
  const shownName = editingNow ? name : current?.name ?? '';
  const shownColour = editingNow ? colour : current?.colour ?? colour;
  // A character that already exists gets its picture as soon as one is chosen, so it shows in the library files below at once.
  // A new character has no folder yet: its picture is stored when it is saved.
  const choosePicture = async (f: File) => {
    if (!current) { setFile(f); return; }
    try {
      const r = await uploadFile<{ pictureAssetId: string }>('PUT', `/api/characters/${current.id}/picture?name=${encodeURIComponent(f.name)}`, f);
      const next = { ...current, pictureAssetId: r.pictureAssetId };
      setPictureId(r.pictureAssetId); setFile(null); setError(''); setCurrent(next);
      setLibShow((n) => n + 1);
      onSaved(next);
    } catch (e) { setError(errorText(e)); }
  };

  // Removing the picture only cuts the link: the file stays in the character's library folder (and can then be deleted there).
  const removePicture = async () => {
    if (!current) { setFile(null); return; }
    try {
      await api('DELETE', `/api/characters/${current.id}/picture`);
      const next = { ...current, pictureAssetId: null };
      setPictureId(null); setFile(null); setError(''); setCurrent(next);
      setLibShow((n) => n + 1);
      onSaved(next);
    } catch (e) { setError(errorText(e)); }
  };

  const startEdit = () => {
    if (!current) return;
    setName(current.name); setColour(current.colour); setDescription(current.description ?? ''); setError(''); setMode('edit');
  };
  const cancelEdit = () => {
    if (!current) { onClose(); return; }
    setFile(null); setError(''); setMode('view');
  };
  const save = async (updateLanes?: boolean) => {
    try {
      const body = { name: name.trim(), colour, description: description.trim() || null };
      const saved = current
        ? await api<Character>('PATCH', `/api/characters/${current.id}`, { ...body, ...(updateLanes !== undefined ? { updateLanes } : {}) })
        : await api<Character>('POST', `/api/projects/${projectId}/characters`, body);
      let result = saved;
      if (file) {
        const r = await uploadFile<{ pictureAssetId: string }>('PUT', `/api/characters/${saved.id}/picture?name=${encodeURIComponent(file.name)}`, file);
        result = { ...saved, pictureAssetId: r.pictureAssetId };
      }
      onSaved(result);
      // Made from a cue's "New character…": hand it over and go back to the script.
      if (!current && state.then) { state.then(result); onClose(); return; }
      setCurrent(result); setPictureId(result.pictureAssetId ?? null); setFile(null); setError(''); setAskLanes(false); setMode('view');
    } catch (e) { setAskLanes(false); setError(errorText(e)); onError(''); }
  };
  const colourChanged = !!current && current.colour.toLowerCase() !== colour.toLowerCase();
  if (askLanes) {
    return (
      <Dialog title="Update lane colours?" onClose={() => setAskLanes(false)}>
        <p>Change the colour of this character's lanes in all segments as well? Lanes you recoloured by hand will be reset too.</p>
        <div className="row end"><button onClick={() => void save(false)}>Keep lane colours</button><button className="primary" onClick={() => void save(true)}>Update lanes</button></div>
      </Dialog>);
  }
  const pictureButton = (
    <>
      <div className={'picture-wrap' + (editingNow ? ' editing' : '')}>
        <button type="button" className="avatar xl picture-pick" style={{ borderColor: shownColour }} onClick={() => fileInput.current?.click()}
          title={shownPicture ? 'Replace image' : 'Choose image'}>
          {shownPicture ? <img src={shownPicture} alt="" />
            : <>{placeholder && <img className="placeholder-img" src={placeholder} alt="" />}<Initials name={shownName} colour={shownColour} /></>}
          <span className="pick-overlay">{shownPicture ? 'Replace image' : 'Choose image'}</span>
        </button>
        {shownPicture && <button type="button" className="picture-remove" title="Remove picture" aria-label="Remove picture" onClick={() => void removePicture()}>×</button>}
      </div>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void choosePicture(f); e.target.value = ''; }} />
    </>);
  return (
    <div className="panel-body char-editor">
      {showBack && <button type="button" className="back-link" onClick={onClose}>← Characters</button>}
      {!editingNow && current ? (
        <>
          <div className="char-view">
            <div className="picture-side">{pictureButton}</div>
            <div className="char-view-text">
              <div className="char-view-name">{current.name}</div>
              {current.description && <div className="char-view-desc">{current.description}</div>}
            </div>
          </div>
          {error && <p className="error">{error}</p>}
          {!readOnly && <div className="row char-view-actions">
            <button type="button" onClick={startEdit}>Edit</button>
          </div>}
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (colourChanged) setAskLanes(true); else void save(); }}>
          <div className="picture-top">{pictureButton}</div>
          <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Default colour</label>
          <ColourPicker value={colour} onChange={setColour} />
          <label>Description (Markdown, optional)<textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          {error && <p className="error">{error}</p>}
          <div className="row end"><button type="button" onClick={cancelEdit}>Cancel</button><button className="primary" disabled={!name.trim()}>Save</button></div>
        </form>
      )}
      {current?.folder
        ? <LibraryPanel root={{ path: `Characters/${current.folder}`, name: current.folder }} hideRoot title="Library files" showAlso={{ n: libShow, folder: '' }} projectId={projectId} readOnly={readOnly}
            onError={onError} onAssetChanged={onAssetChanged} notes={notes} onOpenCue={onOpenCue} />
        : <div className="card lib-card"><h2 className="card-head">Library files</h2><p className="muted small">Save the character first, then its library folder is here.</p></div>}
      {current && !readOnly && <div className="char-remove">
        <button type="button" className="danger solid" disabled={current.isNarrator} title={current.isNarrator ? 'The Narrator cannot be removed' : undefined}
          onClick={() => onRemove(current)}>Remove Character</button>
      </div>}
    </div>
  );
}

export function RightPanel({ projectId, meId, characters, readOnly, onCharacters, onError, openDialog, editor, onCloseEditor, onEditorSaved, allCharacters, notes, story, noteFocus, noteRequest, onNotesChanged, onAssetChanged, onOpenCue, mobileTab }: {
  projectId: string; meId: string; characters: Character[]; readOnly: boolean;
  onCharacters: () => void; onError: (m: string) => void;
  openDialog: (s: CharacterDialogState) => void;
  /** The character being edited in the Characters tab (null: show the list). */
  editor: CharacterDialogState; onCloseEditor: () => void; onEditorSaved: (c: Character) => void; allCharacters: Character[];
  notes: NoteItem[]; story: Story; noteFocus: NoteFocus; noteRequest: NoteRequest | null; onNotesChanged: () => void; onAssetChanged: () => void; onOpenCue: (c: FileCue) => void;
  /** On a phone: the panel the menu picked. The tab header is not shown then. */
  mobileTab?: 'characters' | 'library' | 'notes';
}) {
  const [remove, setRemove] = useState<Character | null>(null);
  // An image called profile_placeholder in the Characters folder stands in (faded) for characters without a picture.
  const [placeholder, setPlaceholder] = useState<string | null>(null);
  const loadPlaceholder = () => {
    void api<LibListing>('GET', `/api/projects/${projectId}/library?folder=Characters`).then((l) => {
      const f = l.files.find((x) => x.kind === 'image' && x.name.replace(/\.[^.]+$/, '').toLowerCase() === 'profile_placeholder');
      setPlaceholder(f ? assetUrl(f.id, f.hasLightweight) : null);
    }).catch(() => undefined);
  };
  const [storedTab, setTab] = useLocalState<'characters' | 'library' | 'notes'>('rs.rightTab', 'characters');
  const tab = mobileTab ?? storedTab;
  // Looked at again whenever the tab changes, so a placeholder uploaded in the Library shows when you come back here.
  useEffect(loadPlaceholder, [projectId, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening the editor (also from a cue's "New character…") brings the Characters tab forward.
  useEffect(() => { if (editor && !mobileTab) setTab('characters'); }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps
  // A cue's notes icon or a Library badge asks for the Notes tab.
  useEffect(() => { if (noteRequest && !mobileTab) setTab('notes'); }, [noteRequest?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <aside className="right">
      <div className="tabs">
        <button className={tab === 'characters' ? 'on' : ''} onClick={() => { setTab('characters'); if (editor) onCloseEditor(); }}>Characters</button>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>Library</button>
        <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>Notes</button>
      </div>
      {tab === 'notes' && <NotesPanel projectId={projectId} meId={meId} readOnly={readOnly} notes={notes} story={story} focus={noteFocus}
        request={noteRequest} onChanged={onNotesChanged} onError={onError} />}
      {tab === 'library' && <LibraryPanel projectId={projectId} readOnly={readOnly} onError={onError} onAssetChanged={onAssetChanged} notes={notes} onOpenCue={onOpenCue} />}
      {tab === 'characters' && editor && !readOnly && (
        <CharacterEditor key={editor.character?.id ?? 'new'} projectId={projectId} state={editor} characters={allCharacters} readOnly={readOnly}
          showBack={false} placeholder={placeholder} onRemove={setRemove} onClose={onCloseEditor} onSaved={onEditorSaved} onError={onError}
          onAssetChanged={onAssetChanged} notes={notes} onOpenCue={onOpenCue} />)}
      {tab === 'characters' && !(editor && !readOnly) && (
        <div className="panel-body">
          <div className="char-grid">
            {characters.map((c) => (
              <div key={c.id} className={'char-card' + (readOnly ? '' : ' clickable')} title={readOnly ? undefined : 'Edit character'}
                role={readOnly ? undefined : 'button'} tabIndex={readOnly ? undefined : 0}
                onClick={() => !readOnly && openDialog({ character: c })}
                draggable={!readOnly}
                onDragStart={(e) => { e.dataTransfer.setData(CHARACTER_DRAG, c.id); e.dataTransfer.effectAllowed = 'copy'; }}
                onKeyDown={(e) => { if (!readOnly && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDialog({ character: c }); } }}>
                <span className="avatar tile" style={{ borderColor: c.colour }}>
                  {c.pictureAssetId ? <img src={assetUrl(c.pictureAssetId, true)} alt="" />
                    : <>{placeholder && <img className="placeholder-img" src={placeholder} alt="" />}<Initials name={c.name} colour={c.colour} /></>}
                </span>
                <div className="char-name">{c.name}</div>
              </div>))}
            {!readOnly && (
              <div className="char-card clickable" role="button" tabIndex={0} title="Add character" onClick={() => openDialog({})}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDialog({}); } }}>
                <span className="avatar tile new"><span className="plus">+</span></span>
                <div className="char-name">New Character</div>
              </div>)}
          </div>
        </div>)}
      {remove && <Confirm title="Remove character" danger confirmLabel="Remove" message={`Remove ${remove.name}?`}
        onConfirm={async () => {
          try { await api('DELETE', `/api/characters/${remove.id}`); onCharacters(); if (editor) onCloseEditor(); }
          catch (e: any) { onError(e.code === 'in_use' ? `${remove.name} is still used: ${e.message}` : errorText(e)); }
        }} onClose={() => setRemove(null)} />}
    </aside>
  );
}
