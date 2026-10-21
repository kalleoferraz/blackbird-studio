/**
 * Builds the snapshot files (Bible, section 6) from rows read in one consistent view. Pure functions: the
 * same rows always give the same text, so an unchanged project produces identical files and Git records
 * nothing.
 */
export interface Rows {
  project: Record<string, unknown>;
  characters: Record<string, unknown>[];
  chapters: Record<string, unknown>[];
  segments: Record<string, unknown>[];
  scenes: Record<string, unknown>[];
  lanes: Record<string, unknown>[];
  cues: Record<string, unknown>[];
  clips: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  assets: Record<string, unknown>[];
}

type Obj = Record<string, any>;

const byPosition = (a: Obj, b: Obj) => a.position - b.position;

/** The label of a chapter: 00A.. for introductory chapters, 01.. for numbered ones. */
export function chapterIndexes(chapters: Obj[]): Map<string, string> {
  const sorted = [...chapters].sort(byPosition);
  const intro = sorted.filter((c) => c.introductory).length;
  return new Map(sorted.map((c) => [c.id, c.introductory ? `00${String.fromCharCode(64 + c.position)}` : String(c.position - intro).padStart(2, '0')]));
}

export function safeFileName(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80).trim();
  return clean || 'Untitled';
}

/** JSON with a fixed key order and one key per line; dates are ISO strings. */
export function stableJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Obj).sort().map((k) => [k, norm((v as Obj)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value), null, 2) + '\n';
}

function omit(row: Obj, keys: string[]): Obj {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
}

export function buildProjectJson(rows: Rows): string {
  const indexes = chapterIndexes(rows.chapters as Obj[]);
  const clipsByCue = new Map<string, Obj[]>();
  for (const c of rows.clips as Obj[]) (clipsByCue.get(c.cueId) ?? clipsByCue.set(c.cueId, []).get(c.cueId)!).push(c);
  const group = (list: Obj[], key: string) => {
    const m = new Map<string, Obj[]>();
    for (const r of list) (m.get(r[key]) ?? m.set(r[key], []).get(r[key])!).push(r);
    return m;
  };
  const segmentsBy = group(rows.segments as Obj[], 'chapterId');
  const scenesBy = group(rows.scenes as Obj[], 'segmentId');
  const lanesBy = group(rows.lanes as Obj[], 'segmentId');
  const cuesBy = group(rows.cues as Obj[], 'sceneId');
  const tree = [...(rows.chapters as Obj[])].sort(byPosition).map((ch) => ({
    ...omit(ch, ['projectId', 'position']),
    index: indexes.get(ch.id),
    segments: (segmentsBy.get(ch.id) ?? []).sort(byPosition).map((sc) => ({
      ...omit(sc, ['chapterId', 'position']),
      lanes: (lanesBy.get(sc.id) ?? []).sort(byPosition).map((l) => omit(l, ['segmentId'])),
      scenes: (scenesBy.get(sc.id) ?? []).sort(byPosition).map((sg) => ({
        ...omit(sg, ['segmentId', 'position']),
        cues: (cuesBy.get(sg.id) ?? []).sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id)).map((q) => ({
          ...omit(q, ['sceneId', 'title']),
          clips: (clipsByCue.get(q.id) ?? []).sort((a, b) => a.number - b.number).map((c) => omit(c, ['cueId'])),
        })),
      })),
    })),
  }));
  return stableJson({
    format: 1,
    project: omit(rows.project, ['revision', 'dirtySince', 'lastEditedAt', 'activeSessionId']),
    characters: [...(rows.characters as Obj[])].sort((a, b) => Number(b.isNarrator) - Number(a.isNarrator) || a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map((c) => omit(c, ['projectId'])),
    chapters: tree,
    notes: [...(rows.notes as Obj[])].sort((a, b) => a.id.localeCompare(b.id)).map((n) => omit(n, ['projectId'])),
    assets: [...(rows.assets as Obj[])].sort((a, b) => a.path.localeCompare(b.path)).map((a) => omit(a, ['projectId', 'claimedBy', 'claimedAt', 'attempts'])),
  });
}

function chapterMarkdown(ch: Obj, index: string, rows: Rows, characterName: Map<string, string>, heading: number): string {
  const segments = (rows.segments as Obj[]).filter((s) => s.chapterId === ch.id).sort(byPosition);
  const h = (n: number) => '#'.repeat(n);
  const out: string[] = [`${h(heading)} ${index} · ${ch.title}`];
  for (const sc of segments) {
    out.push('', `${h(heading + 1)} ${sc.title}`);
    const scenes = (rows.scenes as Obj[]).filter((s) => s.segmentId === sc.id).sort(byPosition);
    scenes.forEach((sg, i) => {
      if (i > 0) out.push('', '---');
      if (sg.label) out.push('', `_${sg.label}_`);
      const cues = (rows.cues as Obj[]).filter((q) => q.sceneId === sg.id).sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
      for (const q of cues) {
        const text = String(q.textMd ?? '').trim();
        if (!text) continue;
        if (q.type === 'sfx') out.push('', `[SFX: ${text.replace(/\s*\n\s*/g, ' ')}]`);
        else if (q.type === 'music') out.push('', `[MUSIC: ${text.replace(/\s*\n\s*/g, ' ')}]`);
        else {
          const name = q.characterId ? characterName.get(q.characterId) : undefined;
          out.push('', name ? `**${name}:** ${text}` : text);
        }
      }
    });
  }
  return out.join('\n') + '\n';
}

export function buildMarkdownFiles(rows: Rows): Record<string, string> {
  const indexes = chapterIndexes(rows.chapters as Obj[]);
  const names = new Map((rows.characters as Obj[]).map((c) => [c.id as string, c.name as string]));
  const files: Record<string, string> = {};
  const chapters = [...(rows.chapters as Obj[])].sort(byPosition);
  const used = new Set<string>();
  for (const ch of chapters) {
    const index = indexes.get(ch.id)!;
    let name = `${index} - ${safeFileName(ch.title)}.md`;
    if (used.has(name.toLowerCase())) name = `${index} - ${safeFileName(ch.title)} (${ch.id.slice(-4)}).md`;
    used.add(name.toLowerCase());
    files[`Chapters/${name}`] = chapterMarkdown(ch, index, rows, names, 1);
  }
  const title = String(rows.project.title);
  const head = [`# ${title}`];
  if (rows.project.subtitle) head.push('', `_${rows.project.subtitle}_`);
  const body = chapters.map((ch) => chapterMarkdown(ch, indexes.get(ch.id)!, rows, names, 2)).join('\n');
  files['Script.md'] = head.join('\n') + '\n\n' + body;
  return files;
}

export function buildSnapshotFiles(rows: Rows): Record<string, string> {
  return { 'Project.json': buildProjectJson(rows), ...buildMarkdownFiles(rows) };
}
