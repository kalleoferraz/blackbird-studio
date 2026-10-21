import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { Character, Cue, CueType, Lane, SegmentContent, Scene } from './types.ts';
import { formatClock, formatMinutes, formatMs, formatSeconds, formatTenths, parseLength } from './format.ts';
import { Confirm, MenuButton, errorText, type MenuItem } from './ui.tsx';

interface Props {
  content: SegmentContent;
  characters: Character[];
  readOnly: boolean;
  onContent: (c: SegmentContent) => void;
  onError: (message: string) => void;
  onNewCharacter: (then: (c: Character) => void) => void;
}

/** Simple monochrome type icons: a mouth for speech, a waveform for sfx, a note for music. */
function TypeIcon({ type }: { type: CueType }) {
  return (
    <svg className="type-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {type === 'speech' && <><path d="M1.800 8c2.200-2.800 4.200-3.300 6.200-1.800 2-1.500 4-1 6.200 1.800-2.200 3.200-4.200 4-6.200 4S4 11.200 1.800 8Z" /><path d="M2 8h12" /></>}
      {type === 'sfx' && <path d="M2 7v2M4.500 5v6M7 2.500v11M9.500 4.500v7M12 6v4M14 7.500v1" />}
      {type === 'music' && <><path d="M6.200 12V3.500L13 2v8.500" /><circle cx="4.600" cy="12" r="1.700" /><circle cx="11.400" cy="10.500" r="1.700" /></>}
    </svg>
  );
}
const TYPE_LABEL: Record<CueType, string> = { speech: 'Speech', sfx: 'Sound effect', music: 'Music' };

export function Writing({ content, characters, readOnly, onContent, onError, onNewCharacter }: Props) {
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label: string; run: () => Promise<void> }>(null);
  // A new cue exists only in the browser until its check button (or Enter) is used.
  const [draft, setDraft] = useState<Draft | null>(null);
  const narrator = characters.find((c) => c.isNarrator);
  const lanes = new Map(content.lanes.map((l) => [l.id, l]));

  const call = async (method: string, url: string, body?: unknown) => {
    try {
      const next = await api<SegmentContent>(method, url, body);
      onContent(next);
      return next;
    } catch (e) { onError(errorText(e)); return null; }
  };
  const startDraft = (sceneId: string, afterCueId: string | null) =>
    setDraft({ sceneId, afterCueId, type: 'speech', characterId: narrator?.id ?? null });
  /** Persists the draft; with `more`, a fresh Narrator draft follows the saved cue. */
  const saveDraft = async (text: string, more: boolean) => {
    if (!draft) return false;
    const d = draft;
    const next = await call('POST', `/api/scenes/${d.sceneId}/cues`, {
      afterCueId: d.afterCueId, type: d.type, characterId: d.type === 'speech' ? d.characterId : null, text });
    if (!next) return false;
    if (more && next.created) startDraft(d.sceneId, next.created); else setDraft(null);
    return true;
  };

  const total = content.scenes.length;
  return (
    <div className="writing">
      {content.scenes.map((seg, i) => (
        <SceneBlock key={seg.id} seg={seg} index={i} total={total} lanes={lanes} characters={characters} readOnly={readOnly}
          draft={draft} setDraft={setDraft} startDraft={startDraft} saveDraft={saveDraft}
          call={call} setConfirm={setConfirm} onNewCharacter={onNewCharacter} />
      ))}
      {!readOnly && <button className="add-scene" onClick={() => void call('POST', `/api/segments/${content.segment.id}/scenes`, {})}>+ Add scene</button>}
      {confirm && <Confirm title={confirm.title} message={confirm.message} confirmLabel={confirm.label} danger onConfirm={confirm.run} onClose={() => setConfirm(null)} />}
    </div>
  );
}

type Call = (method: string, url: string, body?: unknown) => Promise<SegmentContent | null>;
interface Draft { sceneId: string; afterCueId: string | null; type: CueType; characterId: string | null }
interface DraftApi {
  draft: Draft | null; setDraft: (d: Draft | null) => void;
  startDraft: (sceneId: string, afterCueId: string | null) => void; saveDraft: (text: string, more: boolean) => Promise<boolean>;
}

function SceneBlock({ seg, index, total, lanes, characters, readOnly, draft, setDraft, startDraft, saveDraft, call, setConfirm, onNewCharacter }: DraftApi & {
  seg: Scene; index: number; total: number; lanes: Map<string, Lane>; characters: Character[]; readOnly: boolean; call: Call;
  setConfirm: (c: any) => void; onNewCharacter: Props['onNewCharacter'];
}) {
  // The scene's title is stored in `label`; it is edited from the scene's "⋯" menu.
  const [label, setLabel] = useState(seg.label ?? '');
  const [editingTitle, setEditingTitle] = useState(false);
  useEffect(() => setLabel(seg.label ?? ''), [seg.label]);
  const saveTitle = () => {
    setEditingTitle(false);
    if (label.trim() !== (seg.label ?? '')) void call('PATCH', `/api/scenes/${seg.id}`, { label: label.trim() || null });
  };
  const menu: MenuItem[] = [
    { label: seg.label ? 'Edit title' : 'Add title', onClick: () => setEditingTitle(true) },
    { label: 'Merge with previous', disabled: index === 0, onClick: () => void call('POST', `/api/scenes/${seg.id}/merge-previous`) },
    { label: 'Delete scene', danger: true, disabled: total === 1, onClick: () => setConfirm({
      title: 'Delete scene', label: 'Delete',
      message: seg.cues.length ? `Delete this scene and its ${seg.cues.length} cue${seg.cues.length === 1 ? '' : 's'}?` : 'Delete this empty scene?',
      run: async () => { await call('DELETE', `/api/scenes/${seg.id}`); } }) },
  ];
  return (
    <section className="scene">
      <div className="scene-head">
        {editingTitle ? (
          <input className="seg-label" autoFocus placeholder="Scene title" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') { setLabel(seg.label ?? ''); setEditingTitle(false); }
            }} />
        ) : seg.label ? <span className="seg-label">{seg.label}</span> : null}
        <span className="line" />
        <span className="seg-start">{formatClock(seg.startMs)}</span>
        <span className="seg-length">{formatMinutes(seg.lengthMs)}</span>
        {!readOnly && <MenuButton className="icon" items={menu} title="Scene">⋯</MenuButton>}
      </div>
      {(() => {
        const here = draft && draft.sceneId === seg.id ? draft : null;
        const draftAfter = (afterId: string | null) => {
          if (!here || here.afterCueId !== afterId) return null;
          const prev = seg.cues.find((c) => c.id === afterId);
          const pseudo: Cue = { id: 'draft', laneId: '', type: here.type, characterId: here.characterId, startMs: prev ? prev.startMs + prev.lengthMs : 0,
            lengthMs: 0, lengthAuto: true, text: '', clipId: null };
          return <CueBlock key={'draft-' + afterId} cue={pseudo} lane={undefined} characters={characters} readOnly={false} call={call} isLast={afterId === (seg.cues[seg.cues.length - 1]?.id ?? null)}
            drafting={{ patch: (b) => setDraft({ ...here, ...b }), save: saveDraft, cancel: () => setDraft(null) }}
            startDraft={() => undefined} setConfirm={setConfirm} onNewCharacter={onNewCharacter} />;
        };
        const add = (afterId: string | null) => startDraft(seg.id, afterId);
        return (<>
          {seg.cues.length === 0 && draftAfter(null)}
          {seg.cues.length === 0 && !readOnly && <Gap seg={seg} afterId={null} canSplit={false} call={call} onAdd={add} last always />}
          {seg.cues.map((c, i) => (
            <div key={c.id}>
              {i === 0 && draftAfter(null)}
              {i === 0 && !readOnly && <Gap seg={seg} afterId={null} canSplit={false} call={call} onAdd={add} before />}
              <CueBlock cue={c} lane={lanes.get(c.laneId)} characters={characters} readOnly={readOnly} call={call} isLast={i === seg.cues.length - 1}
                startDraft={() => startDraft(seg.id, c.id)} setConfirm={setConfirm} onNewCharacter={onNewCharacter} />
              {draftAfter(c.id)}
              {!readOnly && <Gap seg={seg} afterId={c.id} canSplit={i < seg.cues.length - 1} nextId={seg.cues[i + 1]?.id} call={call} onAdd={add} last={i === seg.cues.length - 1} />}
            </div>
          ))}
        </>);
      })()}
    </section>
  );
}

function Gap({ seg, afterId, canSplit, nextId, call, onAdd, last, before, always }: {
  seg: Scene; afterId: string | null; canSplit: boolean; nextId?: string; call: Call; onAdd: (afterId: string | null) => void; last?: boolean; before?: boolean; always?: boolean;
}) {
  // The space is reserved, so the layout does not move when the buttons appear on hover.
  return (
    <div className={'gap' + (last ? ' last' : '') + (before ? ' before' : '') + (always ? ' always' : '')}>
      <div className="gap-inner">
        <span className="gap-line" />
        <button onClick={() => onAdd(afterId)}>Add cue</button>
        {canSplit && nextId && <button onClick={() => void call('POST', `/api/scenes/${seg.id}/split`, { beforeCueId: nextId })}>Split scene here</button>}
        <span className="gap-line" />
      </div>
    </div>
  );
}

function CueBlock({ cue, lane, characters, readOnly, call, isLast, startDraft, drafting, setConfirm, onNewCharacter }: {
  cue: Cue; lane?: Lane; characters: Character[]; readOnly: boolean; call: Call; isLast: boolean; startDraft: () => void;
  /** Present for a cue that only exists in the browser so far. */
  drafting?: { patch: (b: Partial<Draft>) => void; save: (text: string, more: boolean) => Promise<boolean>; cancel: () => void };
  setConfirm: (c: any) => void; onNewCharacter: Props['onNewCharacter'];
}) {
  const [editing, setEditing] = useState(!!drafting);
  const [text, setText] = useState(cue.text);
  const [editLen, setEditLen] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setText(cue.text); }, [cue.text, editing]);
  // Focus and put the caret at the end only when editing starts; doing it on every keystroke threw the caret to the end.
  useEffect(() => {
    if (editing && area.current) {
      area.current.focus(); area.current.setSelectionRange(area.current.value.length, area.current.value.length);
    }
  }, [editing]);
  useEffect(() => {
    if (editing && area.current) { area.current.style.height = 'auto'; area.current.style.height = area.current.scrollHeight + 'px'; }
  }, [editing, text]);

  const character = characters.find((c) => c.id === cue.characterId);
  const colour = lane?.colour ?? character?.colour ?? '#888888';
  const patch = async (body: object) => {
    if (drafting) { drafting.patch(body as Partial<Draft>); return null; }
    return call('PATCH', `/api/cues/${cue.id}`, body);
  };
  const cancel = () => { if (drafting) { drafting.cancel(); return; } setText(cue.text); setEditing(false); };
  /** Saves the text; Enter on the last cue of a scene goes on to a new Narrator cue. */
  const save = async (more: boolean) => {
    if (drafting) { await drafting.save(text, more && isLast); return; }
    if (text !== cue.text && !(await patch({ text }))) return;
    setEditing(false);
    if (more && isLast) startDraft();
  };
  const commitLen = () => {
    const ms = editLen === null ? null : parseLength(editLen);
    setEditLen(null);
    if (ms !== null && ms >= 100 && ms !== cue.lengthMs) void patch({ lengthMs: ms });
  };

  const typeMenu: MenuItem[] = (['speech', 'sfx', 'music'] as CueType[]).map((t) => ({
    label: TYPE_LABEL[t], checked: cue.type === t, onClick: () => void patch({ type: t }) }));
  const charMenu: MenuItem[] = [
    { label: 'None', checked: !cue.characterId, onClick: () => void patch({ characterId: null }) },
    ...characters.map((c): MenuItem => ({ label: c.name, color: c.colour.toLowerCase() === '#000000' ? 'var(--text)' : c.colour, checked: cue.characterId === c.id, onClick: () => void patch({ characterId: c.id }) })),
    'sep',
    { label: 'New character…', onClick: () => onNewCharacter((c) => void patch({ characterId: c.id })) },
  ];
  const lengthMenu: MenuItem[] = [
    ...(cue.type === 'speech' ? [{ label: 'Re-estimate from text', onClick: () => void patch({ lengthAuto: true }) } as MenuItem] : []),
    { label: 'Edit length', onClick: () => setEditLen(formatMs(cue.lengthMs)) },
  ];
  const moreMenu: MenuItem[] = [
    { label: 'Delete cue', danger: true, onClick: () => setConfirm({
      title: 'Delete cue', label: 'Delete', message: 'Delete this cue?', run: async () => { await call('DELETE', `/api/cues/${cue.id}`); } }) },
  ];

  const placeholder = cue.type === 'speech' ? 'Spoken text (Markdown)…' : cue.type === 'sfx' ? 'Describe the sound effect…' : 'Describe the music…';
  const black = colour.toLowerCase() === '#000000';
  const name = cue.type === 'speech' ? (character?.name ?? lane?.title ?? 'No character') : (lane?.title ?? TYPE_LABEL[cue.type]);
  const nameStyle = { color: black ? 'var(--text)' : colour };
  return (
    <div className={'cue ' + cue.type + (editing ? ' editing' : '')}>
      <span className={'strip' + (black ? ' black' : '')} style={{ background: colour }} />
      <div className="tagcol">
      <div className="tag">
        {readOnly ? <span className="type-btn"><TypeIcon type={cue.type} /></span> :
          <MenuButton className="type-btn" items={typeMenu} title={TYPE_LABEL[cue.type]}><TypeIcon type={cue.type} /></MenuButton>}
        {cue.type === 'speech' && !readOnly ?
          <MenuButton className="name" items={charMenu} title="Character"><b style={nameStyle}>{name}</b></MenuButton> :
          <span className="name"><b style={nameStyle}>{name}</b></span>}
      </div>
      {editing && (
        <div className="edit-actions">
          <button className="round cancel" title="Cancel (Esc)" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
            <svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button>
          <button className="round confirm" title="Save (Enter)" onMouseDown={(e) => e.preventDefault()} onClick={() => void save(false)}>
            <svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 6.5l2.8 2.8L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        </div>)}
      </div>
      <div className="cue-main">
        {editing ? (
          <textarea ref={area} rows={1} className="cue-text" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') { e.preventDefault(); cancel(); }
              // Enter saves; Shift+Enter breaks the line. Enter on an empty draft just drops it.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (drafting && !text.trim()) cancel(); else void save(true); }
            }} />
        ) : (
          <div className={'cue-text' + (cue.text ? '' : ' empty')} onDoubleClick={() => !readOnly && setEditing(true)}>
            {cue.text ? (cue.type === 'speech' && !character?.isNarrator ? '— ' : '') + cue.text : placeholder}</div>)}
      </div>
      <div className="times">
        <span className="start" title="Start within the scene">{formatClock(cue.startMs)}</span>
        {editLen !== null ? (
          <input className="len-input" autoFocus value={editLen} onChange={(e) => setEditLen(e.target.value)} onBlur={commitLen}
            onKeyDown={(e) => { if (e.key === 'Enter') commitLen(); if (e.key === 'Escape') setEditLen(null); }} />
        ) : drafting ? <span className="len">–</span> : readOnly ? <span className="len">{formatTenths(cue.lengthMs)}</span> : (
          <MenuButton className="len" items={lengthMenu} title={`${formatSeconds(cue.lengthMs)}${cue.lengthAuto ? ' · follows the text (auto)' : ''}`}>{formatTenths(cue.lengthMs)}</MenuButton>)}
        {cue.lengthAuto && !drafting && <span className="auto" title="The length follows the text until you set it by hand">auto</span>}
      </div>
      {readOnly || drafting ? <span /> : <MenuButton className="icon more-cue" items={moreMenu} title="More">⋯</MenuButton>}
    </div>
  );
}
