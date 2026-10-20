import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PALETTE } from '../../src/shared/palette.ts';

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: string }
  | 'sep';

/** A popover menu anchored to an element; closes on outside click or Escape. */
export function Menu({ anchor, items, onClose }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const m = ref.current!.getBoundingClientRect();
    let left = a.left, top = a.bottom + 2;
    if (left + m.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - m.width - 8);
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 2);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="menu" style={{ left: pos?.left ?? -999, top: pos?.top ?? -999 }}>
      {items.map((it, i) =>
        it === 'sep' ? <div key={i} className="menu-sep" /> : (
          <button key={i} className={'menu-item' + (it.danger ? ' danger' : '')} disabled={it.disabled}
            onClick={() => { onClose(); it.onClick(); }}>
            <span className="menu-check">{it.checked ? '✓' : ''}</span>{it.label}
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ))}
    </div>,
    document.body,
  );
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
        {inPalette && '+'}
      </label>
    </div>
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
