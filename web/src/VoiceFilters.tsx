// The voice picker's filters (Bible, decision log 2026-11-21): one icon per group (quality, voice, use, sort, more),
// each opening its own small panel with exactly the filters the ElevenLabs list accepts. Active groups show a count.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FILTER_VALUE_LABEL, type FilterDef } from '../../src/shared/voice.ts';

export type FilterValues = Record<string, string | number | boolean | string[]>;
type Group = FilterDef['group'];

const GROUPS: { id: Group; title: string; icon: ReactNode }[] = [
  { id: 'quality', title: 'Quality', icon: <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /> },
  { id: 'voice', title: 'Voice traits', icon: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></> },
  { id: 'use', title: 'Use cases', icon: <><path d="M4 7h16v12H4z" /><path d="M9 7V5h6v2" /></> },
  { id: 'sort', title: 'Sort', icon: <path d="M8 4v16M8 20l-3-3M8 20l3-3M16 20V4M16 4l-3 3M16 4l3 3" /> },
  { id: 'more', title: 'More filters', icon: <><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></> },
];

const label = (v: string) => FILTER_VALUE_LABEL[v] ?? v.replace(/_/g, ' ');
const isSet = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && v !== false;

/** The icon bar. `onChange` gets the whole set; the list reloads when a panel closes with changes. */
export function VoiceFilterBar({ defs, value, onChange }: { defs: FilterDef[]; value: FilterValues; onChange: (v: FilterValues) => void }) {
  const [open, setOpen] = useState<{ group: Group; el: HTMLElement } | null>(null);
  const [draft, setDraft] = useState<FilterValues>(value);
  useEffect(() => { if (!open) setDraft(value); }, [value, open]);
  const close = () => { setOpen(null); if (JSON.stringify(draft) !== JSON.stringify(value)) onChange(clean(draft)); };
  const count = (g: Group) => defs.filter((d) => d.group === g && isSet(value[d.key])).length;
  const total = defs.filter((d) => isSet(value[d.key])).length;
  return (
    <div className="vf-bar">
      {GROUPS.filter((g) => defs.some((d) => d.group === g.id)).map((g) => {
        const n = count(g.id);
        return (
          <button key={g.id} type="button" className={'vf-btn' + (n ? ' on' : '') + (open?.group === g.id ? ' open' : '')} title={g.title} aria-label={g.title}
            onClick={(e) => { if (open?.group === g.id) close(); else { setDraft(value); setOpen({ group: g.id, el: e.currentTarget }); } }}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{g.icon}</svg>
            {n > 0 && <span className="vf-n">{n}</span>}
          </button>);
      })}
      {total > 0 && <button type="button" className="vf-clear" title="Clear all filters" onClick={() => { setOpen(null); onChange({}); }}>Clear</button>}
      {open && (
        <Popover anchor={open.el} onClose={close}>
          <div className="vf-title">{GROUPS.find((g) => g.id === open.group)!.title}</div>
          {defs.filter((d) => d.group === open.group).map((d) => (
            <FilterControl key={d.key} def={d} value={draft[d.key]} onChange={(v) => setDraft({ ...draft, [d.key]: v as never })} />))}
          <div className="row end vf-actions">
            <button type="button" onClick={() => setDraft(Object.fromEntries(Object.entries(draft).filter(([k]) => !defs.some((d) => d.key === k && d.group === open.group))))}>Reset</button>
            <button type="button" className="primary" onClick={close}>Apply</button>
          </div>
        </Popover>)}
    </div>);
}

function clean(v: FilterValues): FilterValues {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => isSet(x)));
}

function FilterControl({ def, value, onChange }: { def: FilterDef; value: unknown; onChange: (v: unknown) => void }) {
  const id = `vf-${def.key}`;
  if (def.kind === 'bool') {
    return <label className="vs-check"><input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked || undefined)} /> {def.label}</label>;
  }
  if (def.kind === 'enum') {
    return (
      <label>{def.label}<select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{def.group === 'sort' ? 'Default' : 'Any'}</option>
        {def.values!.map((v) => <option key={v} value={v}>{label(v)}</option>)}
      </select></label>);
  }
  if (def.kind === 'int') {
    return <label>{def.label}<input type="number" min={0} max={def.max} value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Math.max(0, Math.min(def.max ?? 1e6, Math.round(Number(e.target.value)))))} /></label>;
  }
  if (def.kind === 'text') {
    return (
      <label>{def.label}<input list={def.suggest ? id : undefined} value={typeof value === 'string' ? value : ''} placeholder="Any" maxLength={100} onChange={(e) => onChange(e.target.value || undefined)} />
        {def.suggest && <datalist id={id}>{def.suggest.map((s) => <option key={s} value={s}>{label(s)}</option>)}</datalist>}</label>);
  }
  // A list: the common values as chips to toggle, and any other value typed in.
  const list = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (v: string) => onChange(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const extra = list.filter((v) => !(def.suggest ?? def.values ?? []).includes(v));
  return (
    <div className="vf-list">
      <div className="vf-list-label">{def.label} <span className="muted small">(any of them)</span></div>
      <div className="vf-chips">
        {[...(def.suggest ?? def.values ?? []), ...extra].map((v) => (
          <button key={v} type="button" className={'vf-chip' + (list.includes(v) ? ' on' : '')} onClick={() => toggle(v)}>{label(v)}</button>))}
      </div>
      {def.kind === 'text-list' && <AddValue onAdd={(v) => { if (!list.includes(v) && list.length < 10) onChange([...list, v]); }} />}
    </div>);
}

function AddValue({ onAdd }: { onAdd: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="row vf-add">
      <input value={v} maxLength={50} placeholder="Other…" onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (v.trim()) { onAdd(v.trim()); setV(''); } } }} />
      <button type="button" disabled={!v.trim()} onClick={() => { onAdd(v.trim()); setV(''); }}>Add</button>
    </div>);
}

/** A small panel under its button, above the dialog; closes on a click outside. */
function Popover({ anchor, onClose, children }: { anchor: HTMLElement; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect(), m = ref.current!.getBoundingClientRect();
    let left = a.left, top = a.bottom + 4;
    if (left + m.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - m.width - 8);
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 4);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [anchor, onClose]);
  return createPortal(<div ref={ref} className="vf-pop" style={{ left: pos?.left ?? -999, top: pos?.top ?? -999 }}>{children}</div>, document.body);
}
