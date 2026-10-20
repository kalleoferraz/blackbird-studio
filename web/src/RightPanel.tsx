import { useState } from 'react';
import { api } from './api.ts';
import type { Character, Lane, SceneContent } from './types.ts';
import { ink } from './format.ts';
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

export function RightPanel({ projectId, characters, content, readOnly, onCharacters, onContent, onError, openDialog }: {
  projectId: string; characters: Character[]; content: SceneContent | null; readOnly: boolean;
  onCharacters: () => void; onContent: (c: SceneContent) => void; onError: (m: string) => void;
  openDialog: (s: CharacterDialogState) => void;
}) {
  const [tab, setTab] = useState<'characters' | 'lanes'>('characters');
  const [remove, setRemove] = useState<Character | null>(null);
  return (
    <aside className="right">
      <div className="tabs">
        <button className={tab === 'characters' ? 'on' : ''} onClick={() => setTab('characters')}>Characters</button>
        <button className={tab === 'lanes' ? 'on' : ''} onClick={() => setTab('lanes')}>Lanes</button>
      </div>
      {tab === 'characters' && (
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
      {tab === 'lanes' && (
        <div className="panel-body">
          {!content || content.lanes.length === 0 ? <p className="muted">This scene has no lanes yet.</p> : content.lanes.map((l) => (
            <LaneRow key={l.id} lane={l} readOnly={readOnly} onContent={onContent} onError={onError} />))}
          <p className="muted small">Lane colours can differ from the character's default, e.g. to tell similar voices apart in one scene.</p>
        </div>)}
      {remove && <Confirm title="Remove character" danger confirmLabel="Remove" message={`Remove ${remove.name}?`}
        onConfirm={async () => {
          try { await api('DELETE', `/api/characters/${remove.id}`); onCharacters(); }
          catch (e: any) { onError(e.code === 'in_use' ? `${remove.name} is still used: ${e.message}` : errorText(e)); }
        }} onClose={() => setRemove(null)} />}
    </aside>
  );
}

function LaneRow({ lane, readOnly, onContent, onError }: { lane: Lane; readOnly: boolean; onContent: (c: SceneContent) => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(lane.title);
  const patch = async (body: object) => { try { onContent(await api<SceneContent>('PATCH', `/api/lanes/${lane.id}`, body)); } catch (e) { onError(errorText(e)); } };
  return (
    <div className="lane-row">
      <button className="dot big" disabled={readOnly} style={{ background: lane.colour, color: ink(lane.colour) }} onClick={() => setOpen(!open)} title="Colour" />
      {readOnly ? <span className="grow">{lane.title}</span> :
        <input className="inline grow" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== lane.title && void patch({ title: name.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />}
      {open && <div className="lane-colours"><ColourPicker value={lane.colour} onChange={(hex) => void patch({ colour: hex })} /></div>}
    </div>
  );
}
