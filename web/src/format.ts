export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
/** Accepts "7.4", "0:07.4", "1:02" or "12" (seconds); returns ms or null. */
export function parseLength(text: string): number | null {
  const t = text.trim().replace(',', '.');
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  return Math.round((Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000);
}
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
/** Readable text colour on a lane colour. */
export function ink(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#f4f1ee';
}
/** Start time as mm:ss. */
export function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
/** Length as "8.4 s", or m:ss.s from one minute up. */
export function formatSeconds(ms: number): string {
  return ms < 60000 ? `${(Math.round(ms / 100) / 10).toFixed(1)} s` : formatMs(ms);
}
/** Length in whole seconds ("4 s"), m:ss from one minute up. */
export function formatRounded(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** m:ss without decimals (rounded to the second). */
export function formatMinSec(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Scene duration as "N min M s" ("M s" under one minute). */
export function formatMinutes(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60), sec = total % 60;
  return m > 0 ? `${m} min ${sec} s` : `${sec} s`;
}
/** Cue duration with one decimal of a second ("4.3 s"). */
export function formatTenths(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}

/** Ids ordered with the characters that have a picture first, then by number of cues, most first; ties keep creation order. */
export const cueCountOrder = (list: { id: string; cueCount?: number; pictureAssetId?: string | null }[]): string[] =>
  [...list].sort((a, b) => Number(!!b.pictureAssetId) - Number(!!a.pictureAssetId) || (b.cueCount ?? 0) - (a.cueCount ?? 0)).map((c) => c.id);
/** The list in a remembered order; anything not in it (added since) goes last, in its own order. */
export function inOrder<T extends { id: string }>(list: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, i) => [id, i] as const));
  return [...list].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

/** "01" shows as "1" and "00A" as "A": the stored chapter index is padded for folder names, the screen is not. */
export const plainIndex = (index: string) => index.replace(/^0+/, '') || index;

/** A length as m:ss, or h:mm:ss from an hour on (0:07, 3:42, 1:02:09). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
