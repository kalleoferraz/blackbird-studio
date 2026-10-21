import { useEffect, useRef, useState } from 'react';
import { api, assetUrl, uploadFile } from './api.ts';
import { LibraryPanel } from './Library.tsx';
import type { Character } from './types.ts';
import { ColourPicker, Confirm, Dialog, MenuButton, errorText, useLocalState } from './ui.tsx';
import { nextColour } from '../../src/shared/palette.ts';

export type CharacterDialogState = null | { character?: Character; then?: (c: Character) => void };

export function CharacterDialog({ projectId, state, characters, onClose, onSaved, onError }: {
  projectId: string; state: NonNullable<CharacterDialogState>; characters: Character[];
  onClose: () => void; onSaved: (c: Character) => void; onError: (m: string) => void;
}) {
  const editing = state.character;
  const [name, setName] = useState(editing?.name ?? '');
  const [colour, setColour] = useState(editing?.colour ?? nextColour(characters.map((c) => c.colour)));
  const [description, setDescription] = useState(editing?.description ?? '');
  const [askLanes, setAskLanes] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [removePicture, setRemovePicture] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) { setPreviewUrl(null); return; }
    const u = URL.createObjectURL(file);
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const shownPicture = previewUrl ?? (editing?.pictureAssetId && !removePicture ? assetUrl(editing.pictureAssetId, true) : null);

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
      } else if (removePicture && editing?.pictureAssetId) {
        await api('DELETE', `/api/characters/${saved.id}/picture`);
        result = { ...saved, pictureAssetId: null };
      }
      onSaved(result); state.then?.(result); onClose();
    } catch (e) { setError(errorText(e)); onError(''); }
  };
  const colourChanged = !!editing && editing.colour.toLowerCase() !== colour.toLowerCase();
  if (askLanes) {
    return (
      <Dialog title="Update lane colours?" onClose={() => setAskLanes(false)}>
        <p>Change the colour of this character's lanes in all scenes as well? Lanes you recoloured by hand will be reset too.</p>
        <div className="row end"><button onClick={() => void save(false)}>Keep lane colours</button><button className="primary" onClick={() => void save(true)}>Update lanes</button></div>
      </Dialog>);
  }
  return (
    <Dialog title={editing ? 'Edit character' : 'New character'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); if (colourChanged) setAskLanes(true); else void save(); }}>
        <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Default colour</label>
        <ColourPicker value={colour} onChange={setColour} />
        <label>Description (Markdown, optional)<textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label>Picture (optional, up to 10 MB)</label>
        <div className="row picture-row">
          <div className="avatar big" style={{ borderColor: colour }}>{shownPicture ? <img src={shownPicture} alt="" /> : <span className="muted">none</span>}</div>
          <button type="button" onClick={() => fileInput.current?.click()}>{shownPicture ? 'Replace…' : 'Choose…'}</button>
          {shownPicture && <button type="button" onClick={() => { setFile(null); setRemovePicture(true); }}>Remove</button>}
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setRemovePicture(false); } e.target.value = ''; }} />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim()}>Save</button></div>
      </form>
    </Dialog>
  );
}

export function RightPanel({ projectId, characters, readOnly, onCharacters, onError, openDialog }: {
  projectId: string; characters: Character[]; readOnly: boolean;
  onCharacters: () => void; onError: (m: string) => void;
  openDialog: (s: CharacterDialogState) => void;
}) {
  const [remove, setRemove] = useState<Character | null>(null);
  const [tab, setTab] = useLocalState<'characters' | 'library'>('rs.rightTab', 'characters');
  return (
    <aside className="right">
      <div className="tabs">
        <button className={tab === 'characters' ? 'on' : ''} onClick={() => setTab('characters')}>Characters</button>
        <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>Library</button>
      </div>
      {tab === 'library' && <LibraryPanel projectId={projectId} readOnly={readOnly} onError={onError} />}
      {tab === 'characters' && (
        <div className="panel-body">
          {characters.map((c) => (
            <div key={c.id} className="char-row">
              {c.pictureAssetId
                ? <span className="avatar" style={{ borderColor: c.colour }}><img src={assetUrl(c.pictureAssetId, true)} alt="" /></span>
                : <span className={'dot' + (c.colour === '#000000' ? ' outlined' : '')} style={{ background: c.colour }} />}
              <div className="grow"><div>{c.name}</div>{c.description && <div className="muted small">{c.description.slice(0, 80)}</div>}</div>
              {!readOnly && <MenuButton className="more show" title="Character" items={[
                { label: 'Edit', onClick: () => openDialog({ character: c }) },
                { label: 'Remove', danger: true, disabled: c.isNarrator, onClick: () => setRemove(c) },
              ]}>⋯</MenuButton>}
            </div>))}
          {!readOnly && <button className="add-chapter" title="Add character" onClick={() => openDialog({})}>+</button>}
        </div>)}
      {remove && <Confirm title="Remove character" danger confirmLabel="Remove" message={`Remove ${remove.name}?`}
        onConfirm={async () => {
          try { await api('DELETE', `/api/characters/${remove.id}`); onCharacters(); }
          catch (e: any) { onError(e.code === 'in_use' ? `${remove.name} is still used: ${e.message}` : errorText(e)); }
        }} onClose={() => setRemove(null)} />}
    </aside>
  );
}
