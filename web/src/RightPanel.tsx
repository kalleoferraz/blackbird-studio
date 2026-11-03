import { useEffect, useRef, useState } from 'react';
import { api, assetUrl, uploadFile } from './api.ts';
import { LibraryPanel, type FileCue } from './Library.tsx';
import { NotesPanel } from './NotesPanel.tsx';
import type { Character, LibListing, NoteFocus, NoteItem, NoteRequest, Story } from './types.ts';
import { CHARACTER_DRAG, ColourPicker, Confirm, Dialog, errorText, useLocalState } from './ui.tsx';
import { nextColour } from '../../src/shared/palette.ts';

/** What the Characters tab is editing: null = the list; {} = a new character; {character} = that character. */
export type CharacterDialogState = null | { character?: Character; then?: (c: Character) => void };

/** "Passarinho Figurante 2" -> "PF2": the first letter of every word, a number kept whole. */
export function initialsOf(name: string): string {
  return name.split(/[\s\-_]+/).map((w) => {
    if (/^\p{N}+$/u.test(w)) return w;
    const m = w.match(/[\p{L}\p{N}]/u);
    return m ? m[0].toLocaleUpperCase() : '';
  }).join('');
}

/** The initials over a picture-less character's circle (also over the faded placeholder). */
function Initials({ name, colour }: { name: string; colour: string }) {
  const t = initialsOf(name);
  if (!t) return null;
  const n = Array.from(t).length;
  return <span className={'initials ' + (n <= 2 ? 'n2' : n === 3 ? 'n3' : 'n4')} style={{ color: colour.toLowerCase() === '#000000' ? 'var(--text)' : colour }}>{t}</span>;
}

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
  const editing = state.character;
  const [name, setName] = useState(editing?.name ?? '');
  const [colour, setColour] = useState(editing?.colour ?? nextColour(characters.map((c) => c.colour)));
  const [description, setDescription] = useState(editing?.description ?? '');
  const [askLanes, setAskLanes] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pictureId, setPictureId] = useState<string | null>(editing?.pictureAssetId ?? null);
  const [libShow, setLibShow] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) { setPreviewUrl(null); return; }
    const u = URL.createObjectURL(file);
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const shownPicture = previewUrl ?? (pictureId ? assetUrl(pictureId, true) : null);
  // A character that already exists gets its picture as soon as one is chosen, so it shows in the library files below at once.
  // A new character has no folder yet: its picture is stored when it is saved.
  const choosePicture = async (f: File) => {
    if (!editing) { setFile(f); return; }
    try {
      const r = await uploadFile<{ pictureAssetId: string }>('PUT', `/api/characters/${editing.id}/picture?name=${encodeURIComponent(f.name)}`, f);
      setPictureId(r.pictureAssetId); setFile(null); setError('');
      setLibShow((n) => n + 1);
      onSaved({ ...editing, pictureAssetId: r.pictureAssetId });
    } catch (e) { setError(errorText(e)); }
  };

  const save = async (updateLanes?: boolean) => {
    try {
      const body = { name: name.trim(), colour, description: description.trim() || null };
      const saved = editing
        ? await api<Character>('PATCH', `/api/characters/${editing.id}`, { ...body, ...(updateLanes !== undefined ? { updateLanes } : {}) })
        : await api<Character>('POST', `/api/projects/${projectId}/characters`, body);
      let result = saved;
      if (file) {
        const r = await uploadFile<{ pictureAssetId: string }>('PUT', `/api/characters/${saved.id}/picture?name=${encodeURIComponent(file.name)}`, file);
        result = { ...saved, pictureAssetId: r.pictureAssetId };
      }
      onSaved(result); state.then?.(result); onClose();
    } catch (e) { setError(errorText(e)); onError(''); }
  };
  const colourChanged = !!editing && editing.colour.toLowerCase() !== colour.toLowerCase();
  if (askLanes) {
    return (
      <Dialog title="Update lane colours?" onClose={() => setAskLanes(false)}>
        <p>Change the colour of this character's lanes in all segments as well? Lanes you recoloured by hand will be reset too.</p>
        <div className="row end"><button onClick={() => void save(false)}>Keep lane colours</button><button className="primary" onClick={() => void save(true)}>Update lanes</button></div>
      </Dialog>);
  }
  return (
    <div className="panel-body char-editor">
      {showBack && <button type="button" className="back-link" onClick={onClose}>← Characters</button>}
      <h3 className="char-editor-title">{editing ? 'Edit character' : 'New character'}</h3>
      <form onSubmit={(e) => { e.preventDefault(); if (colourChanged) setAskLanes(true); else void save(); }}>
        <div className="picture-top">
          <button type="button" className="avatar xl picture-pick" style={{ borderColor: colour }} onClick={() => fileInput.current?.click()}
            title={shownPicture ? 'Replace image' : 'Choose image'}>
            {shownPicture ? <img src={shownPicture} alt="" />
              : <>{placeholder && <img className="placeholder-img" src={placeholder} alt="" />}<Initials name={name} colour={colour} /></>}
            <span className="pick-overlay">{shownPicture ? 'Replace image' : 'Choose image'}</span>
          </button>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void choosePicture(f); e.target.value = ''; }} />
        </div>
        <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Default colour</label>
        <ColourPicker value={colour} onChange={setColour} />
        <label>Description (Markdown, optional)<textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim()}>Save</button></div>
      </form>
      <h4 className="char-section">Library files</h4>
      {editing?.folder
        ? <LibraryPanel root={{ path: `Characters/${editing.folder}`, name: editing.folder }} showAlso={{ n: libShow, folder: '' }} projectId={projectId} readOnly={readOnly}
            onError={onError} onAssetChanged={onAssetChanged} notes={notes} onOpenCue={onOpenCue} />
        : <p className="muted small">Save the character first, then its library folder is here.</p>}
      {editing && !readOnly && <div className="char-remove">
        <button type="button" className="danger solid" disabled={editing.isNarrator} title={editing.isNarrator ? 'The Narrator cannot be removed' : undefined}
          onClick={() => onRemove(editing)}>Remove character</button>
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
          showBack={!!mobileTab} placeholder={placeholder} onRemove={setRemove} onClose={onCloseEditor} onSaved={onEditorSaved} onError={onError}
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
