import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PALETTE } from '../../src/shared/palette.ts';

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: ReactNode; color?: string }
  /** A submenu: its own content (controls such as sliders) opens beside the item, on hover or click, and the menu stays open while it is used. */
  | { label: string; sub: ReactNode | ((close: () => void) => ReactNode); disabled?: boolean }
  | 'sep';

function SubItem({ label, sub, disabled, onClose }: { label: string; sub: ReactNode | ((close: () => void) => ReactNode); disabled?: boolean; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(false);
  const [up, setUp] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !host.current || !pop.current) { setUp(0); return; }
    const h = host.current.getBoundingClientRect(), w = pop.current.offsetWidth, ph = pop.current.offsetHeight;
    // Opens to the right of its item, or to the left when the screen ends there; and moves up when its height does not fit below.
    setLeft(h.right + w + 2 > window.innerWidth - 8 && h.left - w - 2 >= 8);
    const top = h.top - 5;
    setUp(Math.max(0, Math.min(top + ph - (window.innerHeight - 8), top - 8)));
  }, [open]);
  return (
    <div ref={host} className="menu-subhost" onMouseEnter={() => !disabled && setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className="menu-item" disabled={disabled} onClick={() => setOpen(true)}><span className="menu-check" />{label}<span className="menu-hint">▸</span></button>
      {open && <div ref={pop} className={'menu menu-sub' + (left ? ' left' : '')} style={up ? { top: -5 - up } : undefined}>{typeof sub === 'function' ? sub(onClose) : sub}</div>}
    </div>
  );
}

/** A popover menu anchored to an element, or to a point (a right click); closes on outside click or Escape. */
export function Menu({ anchor, items, onClose }: { anchor: HTMLElement | { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y - 2 };
    const m = ref.current!.getBoundingClientRect();
    let left = a.left, top = a.bottom + 2;
    if (left + m.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - m.width - 8);
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 2);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node))) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="menu" style={{ left: pos?.left ?? -999, top: pos?.top ?? -999 }}>
      {items.map((it, i) =>
        it === 'sep' ? <div key={i} className="menu-sep" /> : 'sub' in it ? <SubItem key={i} label={it.label} sub={it.sub} disabled={it.disabled} onClose={onClose} /> : (
          <button key={i} className={'menu-item' + (it.danger ? ' danger' : '')} disabled={it.disabled}
            onClick={() => { onClose(); it.onClick(); }}>
            <span className="menu-check">{it.checked ? '✓' : ''}</span>{it.color ? <span style={{ color: it.color }}>{it.label}</span> : it.label}
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ))}
    </div>,
    document.body,
  );
}

/** The number of saves since the last snapshot, as a small badge with a pencil (Bible, decision log 2026-11-20). */
export function ChangeCount({ n }: { n: number }) {
  return (
    <span className="change-count" title={`${n} saved change${n === 1 ? '' : 's'} since the last snapshot`} aria-label={`${n} changes since the last snapshot`}>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /></svg>
      {n > 999 ? '999+' : n}
    </span>);
}

/** A button that opens a Menu on click. */
export function MenuButton({ items, children, className, title }: { items: MenuItem[]; children: ReactNode; className?: string; title?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button className={className} title={title} onClick={(e) => setAnchor(anchor ? null : (e.currentTarget as HTMLElement))}>{children}</button>
      {anchor && <Menu anchor={anchor} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'dialog' + (wide ? ' wide' : '')} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ title, message, confirmLabel, danger, onConfirm, onClose, extra }: {
  title: string; message: ReactNode; confirmLabel: string; danger?: boolean;
  onConfirm: () => void | Promise<void>; onClose: () => void; extra?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <p>{message}</p>
      {extra}
      <div className="row end">
        <button onClick={onClose}>Cancel</button>
        <button className={danger ? 'danger solid' : 'primary'} disabled={busy}
          onClick={async () => { setBusy(true); try { await onConfirm(); } finally { onClose(); } }}>{confirmLabel}</button>
      </div>
    </Dialog>
  );
}

/** A plus drawn as two strokes in a square box, so it sits exactly at the centre of its circle. */
export function PlusIcon() {
  return <svg className="plus-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
}

export function ColourPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const inPalette = PALETTE.some((p) => p.hex.toLowerCase() === value.toLowerCase());
  return (
    <div className="palette">
      {PALETTE.map((p) => (
        <button key={p.hex} type="button" title={p.name}
          className={'swatch' + (p.hex.toLowerCase() === value.toLowerCase() ? ' on' : '') + (p.hex === '#000000' ? ' outlined' : '')}
          style={{ background: p.hex }} onClick={() => onChange(p.hex)} />
      ))}
      <label className={'swatch custom' + (!inPalette ? ' on' : '')} title="Custom colour"
        style={!inPalette ? { background: value } : undefined}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        {inPalette && <PlusIcon />}
      </label>
    </div>
  );
}

/** A phone: a narrow screen, or a landscape phone (short and touch). Keep in step with the `@media` blocks marked "phone" in styles.css. */
export const MOBILE_QUERY = '(max-width: 720px), (max-height: 500px) and (pointer: coarse)';
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(MOBILE_QUERY); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

/** The screen is wider than tall (a phone turned sideways shows the timeline instead of the lane levels). */
export function useIsLandscape(): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia('(orientation: landscape)'); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia('(orientation: landscape)').matches,
    () => true,
  );
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s === null ? initial : (JSON.parse(s) as T); } catch { return initial; }
  });
  return [v, (n: T) => { setV(n); try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* ignore */ } }];
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Drag type of a character tile from the Characters tab; the data is the character's id. Dropped on a cue it makes the cue that character's speech. */
export const CHARACTER_DRAG = 'application/x-blackbird-character';
