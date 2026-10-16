/**
 * Name of the lightweight copy: `{base}_{W}x{H}.{ext}` with the real size of the result,
 * so a 3000x4000 photo.jpg gives photo_450x600.jpg (Bible, section 6).
 * The extension of the original is kept as written.
 */
export function lightweightName(originalName: string, width: number, height: number): string {
  const slash = Math.max(originalName.lastIndexOf('/'), originalName.lastIndexOf('\\'));
  const file = originalName.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  return `${base}_${width}x${height}${ext}`;
}
