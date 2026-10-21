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
