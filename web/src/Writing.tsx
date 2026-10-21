import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { Character, Cue, CueType, Lane, SceneContent, Segment } from './types.ts';
import { formatClock, formatMinSec, formatMs, formatRounded, formatSeconds, parseLength } from './format.ts';
import { Confirm, MenuButton, errorText, type MenuItem } from './ui.tsx';

interface Props {
  content: SceneContent;
  characters: Character[];
  readOnly: boolean;
  onContent: (c: SceneContent) => void;
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
  const [focusCue, setFocusCue] = useState<string | null>(null);
  const lanes = new Map(content.lanes.map((l) => [l.id, l]));

  const call = async (method: string, url: string, body?: unknown, focusCreated = false) => {
    try {
      const next = await api<SceneContent>(method, url, body);
      onContent(next);
      if (focusCreated && next.created) setFocusCue(next.created);
      return next;
    } catch (e) { onError(errorText(e)); return null; }
  };

  const total = content.segments.length;
  return (
    <div className="writing">
      {content.segments.map((seg, i) => (
        <SegmentBlock key={seg.id} seg={seg} index={i} total={total} lanes={lanes} characters={characters} readOnly={readOnly}
          focusCue={focusCue} clearFocus={() => setFocusCue(null)}
          call={call} setConfirm={setConfirm} onNewCharacter={onNewCharacter} />
      ))}
      {!readOnly && <button className="add-segment" onClick={() => void call('POST', `/api/scenes/${content.scene.id}/segments`, {})}>+ Add segment</button>}
      {confirm && <Confirm title={confirm.title} message={confirm.message} confirmLabel={confirm.label} danger onConfirm={confirm.run} onClose={() => setConfirm(null)} />}
    </div>
  );
}

type Call = (method: string, url: string, body?: unknown, focusCreated?: boolean) => Promise<SceneContent | null>;

function SegmentBlock({ seg, index, total, lanes, characters, readOnly, focusCue, clearFocus, call, setConfirm, onNewCharacter }: {
  seg: Segment; index: number; total: number; lanes: Map<string, Lane>; characters: Character[]; readOnly: boolean;
  focusCue: string | null; clearFocus: () => void; call: Call;
  setConfirm: (c: any) => void; onNewCharacter: Props['onNewCharacter'];
}) {
  const [label, setLabel] = useState(seg.label ?? '');
  useEffect(() => setLabel(seg.label ?? ''), [seg.label]);
  const menu: MenuItem[] = [
    { label: 'Merge with previous', disabled: index === 0, onClick: () => void call('POST', `/api/segments/${seg.id}/merge-previous`) },
    { label: 'Delete segment', danger: true, disabled: total === 1, onClick: () => setConfirm({
      title: 'Delete segment', label: 'Delete',
      message: seg.cues.length ? `Delete this segment and its ${seg.cues.length} cue${seg.cues.length === 1 ? '' : 's'}?` : 'Delete this empty segment?',
      run: async () => { await call('DELETE', `/api/segments/${seg.id}`); } }) },
  ];
  return (
    <section className="segment">
      <div className="segment-head">
        {readOnly ? <span className="seg-label">{seg.label}</span> : (
          <input className="seg-label" placeholder={`Segment ${index + 1}`} value={label} onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label !== (seg.label ?? '') && void call('PATCH', `/api/segments/${seg.id}`, { label: label.trim() || null })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />)}
        <span className="line" />
        <span className="seg-length">{formatMinSec(seg.lengthMs)}</span>
        {!readOnly && <MenuButton className="icon" items={menu} title="Segment">⋯</MenuButton>}
      </div>
      {seg.cues.length === 0 && !readOnly && <Gap seg={seg} afterId={null} canSplit={false} call={call} last always />}
      {seg.cues.map((c, i) => (
        <div key={c.id}>
          {i === 0 && !readOnly && <Gap seg={seg} afterId={null} canSplit={false} call={call} before />}
          <CueBlock cue={c} lane={lanes.get(c.laneId)} characters={characters} readOnly={readOnly} call={call}
            autoFocus={focusCue === c.id} clearFocus={clearFocus} setConfirm={setConfirm} onNewCharacter={onNewCharacter} />
          {!readOnly && <Gap seg={seg} afterId={c.id} canSplit={i < seg.cues.length - 1} nextId={seg.cues[i + 1]?.id} call={call} last={i === seg.cues.length - 1} />}
        </div>
      ))}
    </section>
  );
}

function Gap({ seg, afterId, canSplit, nextId, call, last, before, always }: {
  seg: Segment; afterId: string | null; canSplit: boolean; nextId?: string; call: Call; last?: boolean; before?: boolean; always?: boolean;
}) {
  // The space is reserved, so the layout does not move when the buttons appear on hover.
  return (
    <div className={'gap' + (last ? ' last' : '') + (before ? ' before' : '') + (always ? ' always' : '')}>
      <div className="gap-inner">
        <span className="gap-line" />
        <button onClick={() => void call('POST', `/api/segments/${seg.id}/cues`, { afterCueId: afterId }, true)}>Add cue</button>
        {canSplit && nextId && <button onClick={() => void call('POST', `/api/segments/${seg.id}/split`, { beforeCueId: nextId })}>Split segment here</button>}
        <span className="gap-line" />
      </div>
    </div>
  );
}

function CueBlock({ cue, lane, characters, readOnly, call, autoFocus, clearFocus, setConfirm, onNewCharacter }: {
  cue: Cue; lane?: Lane; characters: Character[]; readOnly: boolean; call: Call; autoFocus: boolean; clearFocus: () => void;
  setConfirm: (c: any) => void; onNewCharacter: Props['onNewCharacter'];
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(cue.text);
  const [editLen, setEditLen] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setText(cue.text); }, [cue.text, editing]);
  useEffect(() => { if (autoFocus && !readOnly) { setEditing(true); clearFocus(); } }, [autoFocus, readOnly, clearFocus]);
  useEffect(() => {
    if (editing && area.current) {
      area.current.focus(); area.current.setSelectionRange(area.current.value.length, area.current.value.length);
      area.current.style.height = 'auto'; area.current.style.height = area.current.scrollHeight + 'px';
    }
  }, [editing, text]);

  const colour = lane?.colour ?? '#888888';
  const character = characters.find((c) => c.id === cue.characterId);
  const patch = (body: object) => call('PATCH', `/api/cues/${cue.id}`, body);
  const commitText = () => { setEditing(false); if (text !== cue.text) void patch({ text }); };
  const commitLen = () => {
    const ms = editLen === null ? null : parseLength(editLen);
    setEditLen(null);
    if (ms !== null && ms >= 100 && ms !== cue.lengthMs) void patch({ lengthMs: ms });
  };

  const typeMenu: MenuItem[] = (['speech', 'sfx', 'music'] as CueType[]).map((t) => ({
    label: TYPE_LABEL[t], checked: cue.type === t, onClick: () => void patch({ type: t }) }));
  const charMenu: MenuItem[] = [
    { label: 'None', checked: !cue.characterId, onClick: () => void patch({ characterId: null }) },
    ...characters.map((c): MenuItem => ({ label: c.name, checked: cue.characterId === c.id, onClick: () => void patch({ characterId: c.id }) })),
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
      <div className="tag">
        {readOnly ? <span className="type-btn"><TypeIcon type={cue.type} /></span> :
          <MenuButton className="type-btn" items={typeMenu} title={TYPE_LABEL[cue.type]}><TypeIcon type={cue.type} /></MenuButton>}
        {cue.type === 'speech' && !readOnly ?
          <MenuButton className="name" items={charMenu} title="Character"><b style={nameStyle}>{name}</b></MenuButton> :
          <span className="name"><b style={nameStyle}>{name}</b></span>}
      </div>
      <div className="cue-main">
        {editing ? (
          <textarea ref={area} className="cue-text" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commitText}
            onKeyDown={(e) => { if (e.key === 'Escape') { setText(cue.text); setEditing(false); } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitText(); }} />
        ) : (
          <div className={'cue-text' + (cue.text ? '' : ' empty')} onDoubleClick={() => !readOnly && setEditing(true)}>
            {cue.text || placeholder}</div>)}
      </div>
      <div className="times">
        <span className="start" title="Start within the segment">{formatClock(cue.startMs)}</span>
        {editLen !== null ? (
          <input className="len-input" autoFocus value={editLen} onChange={(e) => setEditLen(e.target.value)} onBlur={commitLen}
            onKeyDown={(e) => { if (e.key === 'Enter') commitLen(); if (e.key === 'Escape') setEditLen(null); }} />
        ) : readOnly ? <span className="len">{formatRounded(cue.lengthMs)}</span> : (
          <MenuButton className="len" items={lengthMenu} title={`${formatSeconds(cue.lengthMs)}${cue.lengthAuto ? ' · follows the text (auto)' : ''}`}>{formatRounded(cue.lengthMs)}</MenuButton>)}
        {cue.lengthAuto && <span className="auto" title="The length follows the text until you set it by hand">auto</span>}
      </div>
      {readOnly ? <span /> : <MenuButton className="icon more-cue" items={moreMenu} title="More">⋯</MenuButton>}
    </div>
  );
}
