import { useState } from 'react';
import { api } from './api.ts';
import type { Character } from './types.ts';
import { ColourPicker, Confirm, Dialog, MenuButton, errorText } from './ui.tsx';
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

  const save = async (updateLanes?: boolean) => {
    try {
      const body = { name: name.trim(), colour, description: description.trim() || null };
      const saved = editing
        ? await api<Character>('PATCH', `/api/characters/${editing.id}`, { ...body, ...(updateLanes !== undefined ? { updateLanes } : {}) })
        : await api<Character>('POST', `/api/projects/${projectId}/characters`, body);
      onSaved(saved); state.then?.(saved); onClose();
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
        <p className="muted">Picture upload comes with the library.</p>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim()}>Save</button></div>
      </form>
    </Dialog>
  );
}

export function RightPanel({ characters, readOnly, onCharacters, onError, openDialog }: {
  characters: Character[]; readOnly: boolean;
  onCharacters: () => void; onError: (m: string) => void;
  openDialog: (s: CharacterDialogState) => void;
}) {
  const [remove, setRemove] = useState<Character | null>(null);
  return (
    <aside className="right">
      <div className="tabs"><button className="on">Characters</button></div>
      {(
        <div className="panel-body">
          {characters.map((c) => (
            <div key={c.id} className="char-row">
              <span className={'dot' + (c.colour === '#000000' ? ' outlined' : '')} style={{ background: c.colour }} />
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
