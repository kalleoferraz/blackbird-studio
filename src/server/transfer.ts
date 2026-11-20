import type { FastifyInstance } from 'fastify';
import { ZipArchive } from 'archiver';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { inTransaction, withDb, type Q } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { touchProject } from '../db/touch.js';
import { asset, assetPeaks, chapter, character, clip, cue, cueSfx, generation, lane, membership, note, project, scene, segment } from '../db/schema.js';
import { parseVoiceSettings } from '../voice/character-voice.js';
import type { VoiceSettings } from '../shared/voice.js';
import { PITCH_MAX_CENTS, SPEED_MAX, SPEED_MIN, cleanPoints, type VolumePoint } from '../shared/audio-settings.js';
import { COLOUR_PATTERN } from '../shared/palette.js';
import { languageProfile } from '../shared/languages.js';
import { parseWav, wavSamples } from '../audio/wav.js';
import { AudioError } from '../audio/errors.js';
import { MAX_UPLOAD, replaceFile, sha256, type AssetRow } from '../library/files.js';
import { kickAudioJobs } from '../audio/jobs.js';
import { addFitTasks } from './replaced.js';
import { blobStore, cleanPath } from '../storage/blob-store.js';
import { accessTo, checkId, levelOf } from './access.js';
import { authenticate } from './auth-routes.js';
import { MAX_SCENE_MS } from './content.js';
import { HttpError, badRequest } from './http.js';
import { PROJECT_TYPES } from './projects.js';

/**
 * Moving a whole media project between installations (Bible, section 6, Export and import).
 *
 *  - GET  /api/projects/:id/export       the project as a JSON file: everything except members, snapshots and the
 *                                        library's bytes (the library's file list, its clips and its notes are in it)
 *  - POST /api/projects/import           creates a new project from such a file for the logged-in user
 *  - GET  /api/projects/:id/library.zip  the library's files as a zip, streamed (nothing is written to disk)
 *
 * File format "blackbird-project", version 1. Nothing in it is an id: lists are referred to by position.
 */

const FORMAT = 'blackbird-project';
const VERSION = 1;
const FOLDER_MAX = 80;

type Json = Record<string, unknown>;

// ---- export ---------------------------------------------------------------------------

export async function buildBundle(q: Q, projectId: string): Promise<Json> {
  const p = (await q.select().from(project).where(eq(project.id, projectId)).limit(1))[0]!;
  const assets = await q.select().from(asset).where(eq(asset.projectId, projectId)).orderBy(asc(asset.createdAt), asc(asset.id));
  const assetNo = new Map(assets.map((a, i) => [a.id, i]));
  const peaks = assets.length ? await q.select().from(assetPeaks).where(inArray(assetPeaks.assetId, assets.map((a) => a.id))) : [];
  const peaksOf = new Map(peaks.map((x) => [x.assetId, x]));
  const chars = await q.select().from(character).where(eq(character.projectId, projectId)).orderBy(asc(character.createdAt), asc(character.id));
  const charNo = new Map(chars.map((c, i) => [c.id, i]));
  const chapters = await q.select().from(chapter).where(eq(chapter.projectId, projectId)).orderBy(asc(chapter.position));
  const segments = chapters.length ? await q.select().from(segment).where(inArray(segment.chapterId, chapters.map((c) => c.id))).orderBy(asc(segment.position)) : [];
  const segIds = segments.map((s) => s.id);
  const lanes = segIds.length ? await q.select().from(lane).where(inArray(lane.segmentId, segIds)).orderBy(asc(lane.position)) : [];
  const scenes = segIds.length ? await q.select().from(scene).where(inArray(scene.segmentId, segIds)).orderBy(asc(scene.position)) : [];
  const cues = scenes.length ? await q.select().from(cue).where(inArray(cue.sceneId, scenes.map((s) => s.id))) : [];
  const clips = cues.length ? await q.select().from(clip).where(inArray(clip.cueId, cues.map((c) => c.id))).orderBy(asc(clip.number)) : [];
  const notes = await q.select().from(note).where(eq(note.projectId, projectId)).orderBy(asc(note.createdAt), asc(note.id));
  // How generated takes were made (Bible, decision log 2026-11-20); a voice change names its source take by number.
  const gens = await q.select().from(generation).where(eq(generation.projectId, projectId));
  const genOf = new Map(gens.map((g) => [g.clipId, g]));
  const clipNumber = new Map(clips.map((k) => [k.id, k.number]));
  const sfxRows = cues.length ? await q.select().from(cueSfx).where(inArray(cueSfx.cueId, cues.map((c) => c.id))) : [];
  const sfxOf = new Map(sfxRows.map((x) => [x.cueId, x]));

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const targets = new Map<string, { kind: string; path: number[] }>(); // entity id -> where it sits in the bundle

  const chapterOut = chapters.map((ch, ci) => {
    targets.set(ch.id, { kind: 'chapter', path: [ci] });
    return {
      title: ch.title,
      introductory: ch.introductory,
      segments: segments.filter((s) => s.chapterId === ch.id).map((sg, si) => {
        targets.set(sg.id, { kind: 'segment', path: [ci, si] });
        const ls = lanes.filter((l) => l.segmentId === sg.id);
        const laneNo = new Map(ls.map((l, i) => [l.id, i]));
        return {
          title: sg.title,
          lanes: ls.map((l) => ({ title: l.title, colour: l.colour, auto: l.auto, character: l.characterId === null ? null : charNo.get(l.characterId)! })),
          scenes: scenes.filter((s) => s.segmentId === sg.id).map((sc, sci) => {
            targets.set(sc.id, { kind: 'scene', path: [ci, si, sci] });
            // The editor's order: start, then lane position, then id.
            const inScene = cues
              .filter((c) => c.sceneId === sc.id)
              .sort((a, b) => a.startMs - b.startMs || laneNo.get(a.laneId)! - laneNo.get(b.laneId)! || a.id.localeCompare(b.id));
            return {
              label: sc.label,
              cues: inScene.map((c, qi) => {
                targets.set(c.id, { kind: 'cue', path: [ci, si, sci, qi] });
                return {
                  lane: laneNo.get(c.laneId)!,
                  type: c.type,
                  character: c.characterId === null ? null : charNo.get(c.characterId)!,
                  startMs: c.startMs,
                  lengthMs: c.lengthMs,
                  lengthAuto: c.lengthAuto,
                  muted: c.muted,
                  text: c.textMd,
                  sfx: (() => {
                    const x = sfxOf.get(c.id);
                    return x ? { prompt: x.prompt, durationMs: x.durationMs, loop: x.looped, promptInfluence: Number(x.promptInfluence), model: x.model } : null;
                  })(),
                  clips: clips.filter((k) => k.cueId === c.id).map((k) => ({
                    asset: assetNo.get(k.assetId)!,
                    number: k.number,
                    offsetMs: k.offsetMs,
                    lengthMs: k.lengthMs,
                    gainDb: Number(k.gainDb),
                    fadeInMs: k.fadeInMs,
                    fadeOutMs: k.fadeOutMs,
                    loops: k.loops,
                    speed: Number(k.speed),
                    pitchCents: k.pitchCents,
                    volumePoints: k.volumePoints,
                    speedPoints: k.speedPoints,
                    pitchPoints: k.pitchPoints,
                    origin: k.origin,
                    chosen: c.clipId === k.id,
                    createdAt: iso(k.createdAt),
                    generation: (() => {
                      const g = genOf.get(k.id);
                      return g ? {
                        kind: g.kind, model: g.model, voiceId: g.voiceId, textSent: g.textSent, direction: g.direction, settings: g.settings ?? null,
                        sourceTake: g.sourceClipId ? clipNumber.get(g.sourceClipId) ?? null : null, outputFormat: g.outputFormat, context: g.context,
                        requestId: g.requestId, characterCost: g.characterCost, createdAt: iso(g.createdAt),
                      } : null;
                    })(),
                  })),
                };
              }),
            };
          }),
        };
      }),
    };
  });
  for (const [id, i] of assetNo) targets.set(id, { kind: 'asset', path: [i] });
  const noteNo = new Map(notes.map((n, i) => [n.id, i]));

  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      type: p.type, title: p.title, subtitle: p.subtitle, language: p.language, repoFolder: p.repoFolder,
      speechUnits: p.speechUnits, speechMs: p.speechMs, cover: p.coverAssetId === null ? null : assetNo.get(p.coverAssetId) ?? null,
    },
    assets: assets.map((a) => ({
      path: a.path, hash: a.hash, mediaKind: a.mediaKind, size: a.size, sizeLightweight: a.sizeLightweight, lightweightPath: a.lightweightPath,
      mediaInfo: a.mediaInfo ?? null, status: a.status, createdAt: iso(a.createdAt),
      peaks: peaksOf.has(a.id) ? { stepMs: peaksOf.get(a.id)!.stepMs, data: Buffer.from(peaksOf.get(a.id)!.data as Buffer).toString('base64') } : null,
    })),
    characters: chars.map((c) => ({
      name: c.name, isNarrator: c.isNarrator, colour: c.defaultColour, description: c.description, folder: c.folder,
      picture: c.pictureAssetId === null ? null : assetNo.get(c.pictureAssetId) ?? null, createdAt: iso(c.createdAt),
      voice: c.voiceId ? { id: c.voiceId, name: c.voiceName, source: c.voiceSource } : null, voiceDirection: c.voiceDirection, voiceSettings: c.voiceSettings ?? null,
    })),
    chapters: chapterOut,
    notes: notes.map((n) => {
      const target =
        n.chapterId ?? n.segmentId ?? n.sceneId ?? n.cueId ?? n.assetId;
      return {
        type: n.type, authorKind: n.authorKind, text: n.textMd, refKey: n.refKey, link: n.link,
        doneAt: iso(n.doneAt), createdAt: iso(n.createdAt), editedAt: iso(n.editedAt), deletedAt: iso(n.deletedAt),
        target: target ? targets.get(target) ?? null : null,
        root: n.rootNoteId === null ? null : noteNo.get(n.rootNoteId) ?? null,
        replyTo: n.replyToNoteId === null ? null : noteNo.get(n.replyToNoteId) ?? null,
      };
    }),
  };
}

// ---- reading an imported file ---------------------------------------------------------------

function fail(where: string, what: string): never {
  throw badRequest('invalid_project_file', `${where}: ${what}`);
}
const obj = (v: unknown, where: string): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : fail(where, 'expected an object'));
const arr = (v: unknown, where: string, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : fail(where, `expected a list of at most ${max}`));
function str(v: unknown, where: string, max: number, min = 1): string {
  return typeof v === 'string' && v.length >= min && v.length <= max ? v : fail(where, `expected text of ${min}-${max} characters`);
}
const optStr = (v: unknown, where: string, max: number): string | null => (v === null || v === undefined || v === '' ? null : str(v, where, max));
const bool = (v: unknown, where: string): boolean => (typeof v === 'boolean' ? v : fail(where, 'expected true or false'));
function int(v: unknown, where: string, min: number, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail(where, `expected a whole number ${min}-${max}`);
}
const optInt = (v: unknown, where: string, min: number, max: number): number | null => (v === null || v === undefined ? null : int(v, where, min, max));
function oneOf<T extends string>(v: unknown, where: string, allowed: readonly T[]): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fail(where, `expected one of ${allowed.join(', ')}`);
}
function colour(v: unknown, where: string): string {
  const s = str(v, where, 7, 7);
  return COLOUR_PATTERN.test(s) ? s : fail(where, 'expected #rrggbb');
}
function date(v: unknown, where: string): Date {
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fail(where, 'expected a date');
}
const optDate = (v: unknown, where: string): Date | null => (v === null || v === undefined ? null : date(v, where));
function libPath(v: unknown, where: string): string {
  const s = str(v, where, 255);
  const c = cleanPath(s);
  return c && c === s ? c : fail(where, 'not a valid library path');
}

const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/** A repo folder name from the user or a file: unsafe characters removed, at most 80 characters; null when nothing is left. */
export function cleanFolder(raw: string): string | null {
  const clean = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, FOLDER_MAX)
    .trim();
  return clean || null;
}

/** A character's voice in a file (optional: older files have none). */
function parseCharacterVoice(o: Json, w: string) {
  let voice: { id: string; name: string | null; source: 'account' | 'public' | 'clone' | null } | null = null;
  if (o.voice !== undefined && o.voice !== null) {
    const v = obj(o.voice, `${w}.voice`);
    const id = str(v.id, `${w}.voice.id`, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`${w}.voice.id`, 'expected a voice ID');
    voice = { id, name: optStr(v.name, `${w}.voice.name`, 100), source: v.source === null || v.source === undefined ? null : oneOf(v.source, `${w}.voice.source`, ['account', 'public', 'clone'] as const) };
  }
  let voiceSettings: VoiceSettings | null = null;
  if (o.voiceSettings !== undefined && o.voiceSettings !== null) {
    try { voiceSettings = parseVoiceSettings(o.voiceSettings); } catch (e) { fail(`${w}.voiceSettings`, (e as Error).message); }
  }
  return { voice, voiceDirection: optStr(o.voiceDirection, `${w}.voiceDirection`, 2000), voiceSettings };
}

function parseGeneration(v: unknown, w: string): ParsedGeneration | null {
  if (v === undefined || v === null) return null;
  const o = obj(v, w);
  const settings = o.settings ?? null;
  if (settings !== null && (typeof settings !== 'object' || JSON.stringify(settings).length > 4000)) fail(`${w}.settings`, 'expected a small object');
  return {
    kind: oneOf(o.kind, `${w}.kind`, ['speech', 'sfx', 'music', 'voice_change'] as const), model: str(o.model, `${w}.model`, 64), voiceId: optStr(o.voiceId, `${w}.voiceId`, 64),
    textSent: optStr(o.textSent, `${w}.textSent`, 60_000), direction: optStr(o.direction, `${w}.direction`, 500), settings,
    sourceTake: optInt(o.sourceTake, `${w}.sourceTake`, 1, 65_535), outputFormat: str(o.outputFormat, `${w}.outputFormat`, 40), context: bool(o.context ?? false, `${w}.context`),
    requestId: optStr(o.requestId, `${w}.requestId`, 64), characterCost: optInt(o.characterCost, `${w}.characterCost`, 0, 1_000_000_000), createdAt: optDate(o.createdAt, `${w}.createdAt`),
  };
}

interface ParsedClip { asset: number; number: number; offsetMs: number; lengthMs: number; gainDb: number; fadeInMs: number; fadeOutMs: number; loops: number; speed: number; pitchCents: number; volumePoints: VolumePoint[] | null; speedPoints: VolumePoint[] | null; pitchPoints: VolumePoint[] | null; origin: 'human-recorded' | 'generated' | 'voice-converted'; chosen: boolean; createdAt: Date | null; generation: ParsedGeneration | null }
interface ParsedGeneration {
  kind: 'speech' | 'sfx' | 'music' | 'voice_change'; model: string; voiceId: string | null; textSent: string | null; direction: string | null; settings: unknown;
  sourceTake: number | null; outputFormat: string; context: boolean; requestId: string | null; characterCost: number | null; createdAt: Date | null;
}
interface ParsedCue { lane: number; type: 'speech' | 'sfx' | 'music'; character: number | null; startMs: number; lengthMs: number; lengthAuto: boolean; muted: boolean; text: string; clips: ParsedClip[]; sfx: ParsedSfx | null }
interface ParsedSfx { prompt: string; durationMs: number | null; loop: boolean; promptInfluence: number; model: string }
function parseSfx(v: unknown, w: string): ParsedSfx | null {
  if (v === undefined || v === null) return null;
  const o = obj(v, w);
  const pi = o.promptInfluence;
  if (typeof pi !== 'number' || pi < 0 || pi > 1) fail(`${w}.promptInfluence`, 'expected a number from 0 to 1');
  return { prompt: str(o.prompt, `${w}.prompt`, 450), durationMs: optInt(o.durationMs, `${w}.durationMs`, 500, 30_000), loop: bool(o.loop ?? false, `${w}.loop`),
    promptInfluence: pi as number, model: str(o.model, `${w}.model`, 64) };
}
interface ParsedNote {
  type: 'comment' | 'reference' | 'task'; authorKind: 'user' | 'system' | 'llm'; text: string; refKey: string | null; link: string | null;
  doneAt: Date | null; createdAt: Date; editedAt: Date | null; deletedAt: Date | null;
  target: { kind: 'chapter' | 'segment' | 'scene' | 'cue' | 'asset'; path: number[] } | null; root: number | null; replyTo: number | null;
}

export function parseBundle(raw: unknown) {
  const b = obj(raw, 'file');
  if (b.format !== FORMAT) fail('file', 'this is not a project file');
  if (b.version !== VERSION) fail('file', `unsupported version ${String(b.version)}`);

  const p = obj(b.project, 'project');
  const proj = {
    type: oneOf(p.type, 'project.type', PROJECT_TYPES),
    title: str(p.title, 'project.title', 200),
    subtitle: optStr(p.subtitle, 'project.subtitle', 200),
    language: str(p.language, 'project.language', 10),
    repoFolder: ((): string | null => { const f = optStr(p.repoFolder, 'project.repoFolder', 200); return f === null ? null : cleanFolder(f); })(),
    speechUnits: typeof p.speechUnits === 'number' && p.speechUnits >= 0 && p.speechUnits < 1e12 ? p.speechUnits : 0,
    speechMs: int(p.speechMs ?? 0, 'project.speechMs', 0, Number.MAX_SAFE_INTEGER),
    cover: optInt(p.cover, 'project.cover', 0, 1_000_000),
  };
  if (!languageProfile(proj.language)) fail('project.language', 'unknown language');

  // library file list
  const seenHash = new Set<string>();
  const seenPath = new Set<string>();
  const assets = arr(b.assets ?? [], 'assets', 50_000).map((a, i) => {
    const w = `assets[${i}]`;
    const o = obj(a, w);
    const hash = str(o.hash, `${w}.hash`, 64, 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash) || seenHash.has(hash)) fail(`${w}.hash`, 'expected a unique SHA-256');
    seenHash.add(hash);
    const path = libPath(o.path, `${w}.path`);
    const light = o.lightweightPath === null || o.lightweightPath === undefined ? null : libPath(o.lightweightPath, `${w}.lightweightPath`);
    for (const x of [path, light]) {
      if (x === null) continue;
      if (seenPath.has(x.toLowerCase())) fail(w, `the path "${x}" is used twice`);
      seenPath.add(x.toLowerCase());
    }
    const info = o.mediaInfo === null || o.mediaInfo === undefined ? null : obj(o.mediaInfo, `${w}.mediaInfo`);
    if (info && JSON.stringify(info).length > 65_536) fail(`${w}.mediaInfo`, 'too large');
    let peaks: { stepMs: number; data: Buffer } | null = null;
    if (o.peaks !== null && o.peaks !== undefined) {
      const pk = obj(o.peaks, `${w}.peaks`);
      peaks = { stepMs: int(pk.stepMs, `${w}.peaks.stepMs`, 1, 65_535), data: Buffer.from(str(pk.data, `${w}.peaks.data`, 4_000_000, 0), 'base64') };
    }
    return {
      path, hash, lightweightPath: light, mediaKind: oneOf(o.mediaKind, `${w}.mediaKind`, ['audio', 'image', 'video', 'document', 'other'] as const),
      size: int(o.size, `${w}.size`, 0, Number.MAX_SAFE_INTEGER), sizeLightweight: optInt(o.sizeLightweight, `${w}.sizeLightweight`, 0, Number.MAX_SAFE_INTEGER),
      mediaInfo: info, status: oneOf(o.status ?? 'ready', `${w}.status`, ['pending', 'processing', 'ready', 'failed'] as const),
      createdAt: optDate(o.createdAt, `${w}.createdAt`), peaks,
    };
  });
  const assetRef = (v: unknown, where: string): number | null => {
    const n = optInt(v, where, 0, 1_000_000);
    if (n !== null && n >= assets.length) fail(where, 'refers to a file that is not in the list');
    return n;
  };
  if (proj.cover !== null) assetRef(proj.cover, 'project.cover');

  const seenFolder = new Set<string>();
  const chars = arr(b.characters, 'characters', 500).map((c, i) => {
    const w = `characters[${i}]`;
    const o = obj(c, w);
    const folder = str(o.folder, `${w}.folder`, 30);
    if (UNSAFE_NAME.test(folder) || folder !== folder.trim() || seenFolder.has(folder.toLowerCase())) fail(`${w}.folder`, 'expected a unique folder name');
    seenFolder.add(folder.toLowerCase());
    return {
      name: str(o.name, `${w}.name`, 100), isNarrator: bool(o.isNarrator, `${w}.isNarrator`), colour: colour(o.colour, `${w}.colour`),
      description: optStr(o.description, `${w}.description`, 60_000), folder, picture: assetRef(o.picture, `${w}.picture`), createdAt: optDate(o.createdAt, `${w}.createdAt`),
      ...parseCharacterVoice(o, w),
    };
  });
  if (chars.filter((c) => c.isNarrator).length !== 1) fail('characters', 'exactly one narrator is required');
  const charRef = (v: unknown, where: string): number | null => {
    const n = optInt(v, where, 0, 1_000_000);
    if (n !== null && n >= chars.length) fail(where, 'refers to a character that is not in the list');
    return n;
  };

  let cueTotal = 0;
  const chapters = arr(b.chapters, 'chapters', 125).map((c, ci) => {
    const co = obj(c, `chapters[${ci}]`);
    const segments = arr(co.segments, `chapters[${ci}].segments`, 99).map((s, si) => {
      const where = `chapters[${ci}].segments[${si}]`;
      const so = obj(s, where);
      const lanes = arr(so.lanes, `${where}.lanes`, 99).map((l, li) => {
        const lo = obj(l, `${where}.lanes[${li}]`);
        return { title: str(lo.title, `${where}.lanes[${li}].title`, 100), colour: colour(lo.colour, `${where}.lanes[${li}].colour`), auto: bool(lo.auto, `${where}.lanes[${li}].auto`), character: charRef(lo.character, `${where}.lanes[${li}].character`) };
      });
      const scenes = arr(so.scenes, `${where}.scenes`, 99).map((sc, sci) => {
        const w = `${where}.scenes[${sci}]`;
        const sco = obj(sc, w);
        const cues: ParsedCue[] = arr(sco.cues, `${w}.cues`, 5000).map((q, qi) => {
          const wq = `${w}.cues[${qi}]`;
          const qo = obj(q, wq);
          const clips: ParsedClip[] = arr(qo.clips ?? [], `${wq}.clips`, 200).map((k, ki) => {
            const wk = `${wq}.clips[${ki}]`;
            const ko = obj(k, wk);
            const gain = typeof ko.gainDb === 'number' && ko.gainDb >= -100 && ko.gainDb <= 100 ? Math.round(ko.gainDb * 100) / 100 : fail(`${wk}.gainDb`, 'expected -100 to 100');
            const speed = ko.speed === undefined ? 1 : typeof ko.speed === 'number' && ko.speed >= SPEED_MIN && ko.speed <= SPEED_MAX ? Math.round(ko.speed * 100) / 100 : fail(`${wk}.speed`, `expected ${SPEED_MIN} to ${SPEED_MAX}`);
            const points = cleanPoints(ko.volumePoints ?? null, MAX_SCENE_MS, 'level');
            if (points === undefined) fail(`${wk}.volumePoints`, 'expected a list of [ms, dB]');
            const speedPoints = cleanPoints(ko.speedPoints ?? null, MAX_SCENE_MS, 'speed');
            if (speedPoints === undefined) fail(`${wk}.speedPoints`, 'expected a list of [ms, factor]');
            const pitchPoints = cleanPoints(ko.pitchPoints ?? null, MAX_SCENE_MS, 'pitch');
            if (pitchPoints === undefined) fail(`${wk}.pitchPoints`, 'expected a list of [ms, cents]');
            return {
              speed, pitchCents: ko.pitchCents === undefined ? 0 : int(ko.pitchCents, `${wk}.pitchCents`, -PITCH_MAX_CENTS, PITCH_MAX_CENTS), volumePoints: points ?? null, speedPoints: speedPoints ?? null, pitchPoints: pitchPoints ?? null,
              asset: assetRef(ko.asset, `${wk}.asset`) ?? fail(`${wk}.asset`, 'a clip needs a file'),
              number: int(ko.number, `${wk}.number`, 1, 65_535), offsetMs: int(ko.offsetMs, `${wk}.offsetMs`, 0, MAX_SCENE_MS), lengthMs: int(ko.lengthMs, `${wk}.lengthMs`, 100, MAX_SCENE_MS),
              gainDb: gain, fadeInMs: int(ko.fadeInMs, `${wk}.fadeInMs`, 0, MAX_SCENE_MS), fadeOutMs: int(ko.fadeOutMs, `${wk}.fadeOutMs`, 0, MAX_SCENE_MS),
              loops: int(ko.loops, `${wk}.loops`, -1, 1000), origin: oneOf(ko.origin, `${wk}.origin`, ['human-recorded', 'generated', 'voice-converted'] as const),
              chosen: bool(ko.chosen ?? false, `${wk}.chosen`), createdAt: optDate(ko.createdAt, `${wk}.createdAt`),
              generation: parseGeneration(ko.generation, `${wk}.generation`),
            };
          });
          if (new Set(clips.map((k) => k.number)).size !== clips.length) fail(`${wq}.clips`, 'clip numbers must be unique');
          if (clips.filter((k) => k.chosen).length > 1) fail(`${wq}.clips`, 'only one clip can be chosen');
          return {
            lane: int(qo.lane, `${wq}.lane`, 0, Math.max(0, lanes.length - 1)), type: oneOf(qo.type, `${wq}.type`, ['speech', 'sfx', 'music'] as const),
            character: charRef(qo.character, `${wq}.character`), startMs: int(qo.startMs, `${wq}.startMs`, 0, MAX_SCENE_MS), lengthMs: int(qo.lengthMs, `${wq}.lengthMs`, 100, MAX_SCENE_MS),
            lengthAuto: bool(qo.lengthAuto, `${wq}.lengthAuto`), muted: qo.muted === undefined ? false : bool(qo.muted, `${wq}.muted`), text: str(qo.text, `${wq}.text`, 60_000, 0), clips, sfx: parseSfx(qo.sfx, `${wq}.sfx`),
          };
        });
        cueTotal += cues.length;
        if (cues.length > 0 && lanes.length === 0) fail(w, 'cues need lanes');
        // Cues on one lane may not overlap (Bible, section 5, Lane rules).
        const byLane = new Map<number, ParsedCue[]>();
        for (const q of cues) byLane.set(q.lane, [...(byLane.get(q.lane) ?? []), q]);
        for (const [laneNo, list] of byLane) {
          const sorted = [...list].sort((x, y) => x.startMs - y.startMs);
          for (let i = 1; i < sorted.length; i++) if (sorted[i]!.startMs < sorted[i - 1]!.startMs + sorted[i - 1]!.lengthMs) fail(w, `cues overlap on lane ${laneNo}`);
        }
        return { label: optStr(sco.label, `${w}.label`, 100), cues };
      });
      if (scenes.length === 0) fail(where, 'a segment needs at least one scene');
      return { title: str(so.title, `${where}.title`, 200), lanes, scenes };
    });
    return { title: str(co.title, `chapters[${ci}].title`, 200), introductory: bool(co.introductory, `chapters[${ci}].introductory`), segments };
  });
  if (cueTotal > 20_000) fail('chapters', 'too many cues (at most 20000)');
  const intro = chapters.filter((c) => c.introductory).length;
  if (intro > 26 || chapters.length - intro > 99) fail('chapters', 'too many chapters');
  if (chapters.some((c, i) => c.introductory && i >= intro)) fail('chapters', 'introductory chapters must come first');

  const exists = (kind: string, path: number[]): boolean => {
    const [ci, si, sci, qi] = path;
    if (kind === 'asset') return path.length === 1 && ci! < assets.length;
    const ch = chapters[ci!];
    if (kind === 'chapter') return path.length === 1 && !!ch;
    const sg = ch?.segments[si!];
    if (kind === 'segment') return path.length === 2 && !!sg;
    const sc = sg?.scenes[sci!];
    if (kind === 'scene') return path.length === 3 && !!sc;
    return kind === 'cue' && path.length === 4 && !!sc?.cues[qi!];
  };
  const seenRef = new Set<string>();
  const notes: ParsedNote[] = arr(b.notes ?? [], 'notes', 50_000).map((n, i) => {
    const w = `notes[${i}]`;
    const o = obj(n, w);
    let target: ParsedNote['target'] = null;
    if (o.target !== null && o.target !== undefined) {
      const t = obj(o.target, `${w}.target`);
      const kind = oneOf(t.kind, `${w}.target.kind`, ['chapter', 'segment', 'scene', 'cue', 'asset'] as const);
      const path = arr(t.path, `${w}.target.path`, 4).map((x, k) => int(x, `${w}.target.path[${k}]`, 0, 1_000_000));
      if (!exists(kind, path)) fail(`${w}.target`, 'points at something that is not in the file');
      target = { kind, path };
    }
    const refKey = optStr(o.refKey, `${w}.refKey`, 24);
    if (refKey !== null) {
      if (seenRef.has(refKey.toLowerCase())) fail(`${w}.refKey`, 'used twice');
      seenRef.add(refKey.toLowerCase());
    }
    return {
      type: oneOf(o.type, `${w}.type`, ['comment', 'reference', 'task'] as const), authorKind: oneOf(o.authorKind ?? 'user', `${w}.authorKind`, ['user', 'system', 'llm'] as const),
      text: str(o.text, `${w}.text`, 60_000, 0), refKey, link: optStr(o.link, `${w}.link`, 2048), doneAt: optDate(o.doneAt, `${w}.doneAt`),
      createdAt: date(o.createdAt, `${w}.createdAt`), editedAt: optDate(o.editedAt, `${w}.editedAt`), deletedAt: optDate(o.deletedAt, `${w}.deletedAt`),
      target, root: optInt(o.root, `${w}.root`, 0, 49_999), replyTo: optInt(o.replyTo, `${w}.replyTo`, 0, 49_999),
    };
  });
  notes.forEach((n, i) => {
    if (n.root !== null && (n.root >= i || notes[n.root]!.root !== null)) fail(`notes[${i}].root`, 'a reply must follow its root note');
    if (n.replyTo !== null && n.replyTo >= i) fail(`notes[${i}].replyTo`, 'a reply must follow the note it answers');
    if (n.root !== null && n.type !== 'comment') fail(`notes[${i}]`, 'a reply must be a comment');
    if (n.link !== null && !/^https?:\/\//i.test(n.link)) fail(`notes[${i}].link`, 'expected an http or https address');
  });

  return { proj, assets, chars, chapters, notes, cueTotal };
}

// ---- writing it ----------------------------------------------------------------------------

async function takenFolders(q: Q): Promise<Set<string>> {
  const rows = await q.select({ f: project.repoFolder }).from(project);
  return new Set(rows.map((r) => (r.f ?? '').toLowerCase()).filter(Boolean));
}

function freeFolder(taken: Set<string>, base: string): string {
  for (let n = 2; n < 10_000; n++) {
    const suffix = ` ${n}`;
    const candidate = base.slice(0, FOLDER_MAX - suffix.length).trim() + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base.slice(0, FOLDER_MAX - 7) + ' ' + newUlid().slice(-6);
}

export async function importBundle(userId: string, raw: unknown, folderOverride?: string): Promise<{ id: string; chapters: number; cues: number }> {
  const parsed = parseBundle(raw);
  const { proj, assets, chars, chapters, notes } = parsed;
  let override: string | null = null;
  if (folderOverride !== undefined) {
    override = cleanFolder(folderOverride);
    if (!override) throw badRequest('invalid_folder', 'Enter a folder name.');
  }

  const id = await inTransaction(async (tx) => {
    const taken = await takenFolders(tx);
    const wanted = override ?? proj.repoFolder ?? cleanFolder(proj.title) ?? 'Untitled';
    if (taken.has(wanted.toLowerCase())) {
      // When the folder belongs to a project this person can edit, the files of the zip can go there instead.
      const mine = await tx.select({ id: project.id, title: project.title, folder: project.repoFolder, role: membership.role })
        .from(project).innerJoin(membership, eq(membership.projectId, project.id)).where(eq(membership.userId, userId));
      const existing = mine.find((m) => (m.folder ?? '').toLowerCase() === wanted.toLowerCase() && levelOf(m.role) === 'author');
      throw new HttpError(409, 'folder_taken', `A project with the folder name "${wanted}" already exists.`, {
        folder: wanted, suggestion: freeFolder(taken, wanted), ...(existing ? { existing: { id: existing.id, title: existing.title } } : {}),
      });
    }
    const now = new Date();
    const projectId = newUlid();
    await tx.insert(project).values({
      id: projectId, type: proj.type, title: proj.title, subtitle: proj.subtitle, language: proj.language, speechUnits: proj.speechUnits, speechMs: proj.speechMs,
      revision: 0, repoFolder: wanted, createdAt: now, updatedAt: now,
    });
    await tx.insert(membership).values({ userId, projectId, role: 'author', createdAt: now });

    // The library's file list. The bytes are not in the file, so every asset is marked missing.
    const assetIds = assets.map(() => newUlid());
    if (assets.length) {
      for (let i = 0; i < assets.length; i += 500) {
        await tx.insert(asset).values(assets.slice(i, i + 500).map((a, k) => ({
          id: assetIds[i + k]!, projectId, path: a.path, hash: a.hash, mediaKind: a.mediaKind, size: a.size, sizeLightweight: a.sizeLightweight, lightweightPath: a.lightweightPath,
          mediaInfo: a.mediaInfo, status: a.status, fileState: 'missing' as const, attempts: 0, createdAt: a.createdAt ?? now, updatedAt: now,
        })));
      }
      const withPeaks = assets.map((a, i) => ({ a, i })).filter((x) => x.a.peaks);
      for (const { a, i } of withPeaks) await tx.insert(assetPeaks).values({ assetId: assetIds[i]!, stepMs: a.peaks!.stepMs, data: a.peaks!.data, createdAt: now });
    }
    if (proj.cover !== null) await tx.update(project).set({ coverAssetId: assetIds[proj.cover]! }).where(eq(project.id, projectId));

    // Characters keep the file's order (the list is ordered by creation time).
    const charIds: string[] = [];
    let last = 0;
    for (const c of chars) {
      const cid = newUlid();
      const at = Math.max(last + 1, (c.createdAt ?? now).getTime()); // the original time, nudged only to keep the order
      last = at;
      await tx.insert(character).values({
        id: cid, projectId, name: c.name, isNarrator: c.isNarrator, defaultColour: c.colour, pictureAssetId: c.picture === null ? null : assetIds[c.picture]!,
        description: c.description, folder: c.folder, createdAt: new Date(at), updatedAt: now,
        voiceId: c.voice?.id ?? null, voiceName: c.voice?.name ?? null, voiceSource: c.voice?.source ?? null, voiceDirection: c.voiceDirection, voiceSettings: c.voiceSettings,
      });
      charIds.push(cid);
    }
    const charId = (i: number | null) => (i === null ? null : charIds[i]!);

    const chapterIds: string[] = [];
    const segmentIds: string[][] = [];
    const sceneIds: string[][][] = [];
    const cueIds: string[][][][] = [];
    let cueSeq = 0; // cues are ordered by start, lane, then id: ids that rise with the file's order keep ties in that order
    const clipRows: (typeof clip.$inferInsert)[] = [];
    const chosen: { cueId: string; clipId: string }[] = [];
    const gens: { g: ParsedGeneration; clipId: string; cueId: string; cueClips: ParsedClip[] }[] = [];
    const sfxRows: (typeof cueSfx.$inferInsert)[] = [];
    for (const [ci, ch] of chapters.entries()) {
      const chapterId = newUlid();
      chapterIds.push(chapterId);
      segmentIds.push([]); sceneIds.push([]); cueIds.push([]);
      await tx.insert(chapter).values({ id: chapterId, projectId, position: ci + 1, title: ch.title, introductory: ch.introductory, createdAt: now, updatedAt: now });
      for (const [si, sg] of ch.segments.entries()) {
        const segmentId = newUlid();
        segmentIds[ci]!.push(segmentId); sceneIds[ci]!.push([]); cueIds[ci]!.push([]);
        await tx.insert(segment).values({ id: segmentId, chapterId, position: si + 1, title: sg.title, createdAt: now, updatedAt: now });
        const laneIds = sg.lanes.map(() => newUlid());
        if (sg.lanes.length) {
          await tx.insert(lane).values(sg.lanes.map((l, li) => ({
            id: laneIds[li]!, segmentId, characterId: charId(l.character), position: li + 1, title: l.title, colour: l.colour, auto: l.auto, createdAt: now, updatedAt: now,
          })));
        }
        for (const [sci, sc] of sg.scenes.entries()) {
          const sceneId = newUlid();
          sceneIds[ci]![si]!.push(sceneId); cueIds[ci]![si]!.push([]);
          await tx.insert(scene).values({ id: sceneId, segmentId, position: sci + 1, label: sc.label, createdAt: now, updatedAt: now });
          const ids = sc.cues.map(() => newUlid(now.getTime() + ++cueSeq));
          cueIds[ci]![si]![sci] = ids;
          if (sc.cues.length) {
            await tx.insert(cue).values(sc.cues.map((q, qi) => ({
              id: ids[qi]!, sceneId, laneId: laneIds[q.lane]!, type: q.type, characterId: charId(q.character), clipId: null,
              startMs: q.startMs, lengthMs: q.lengthMs, lengthAuto: q.lengthAuto, muted: q.muted, textMd: q.text, createdAt: now, updatedAt: now,
            })));
          }
          for (const [qi, q] of sc.cues.entries()) {
            for (const k of q.clips) {
              const clipId = newUlid();
              clipRows.push({
                id: clipId, cueId: ids[qi]!, assetId: assetIds[k.asset]!, number: k.number, offsetMs: k.offsetMs, lengthMs: k.lengthMs, gainDb: k.gainDb.toFixed(2), speed: k.speed.toFixed(2), pitchCents: k.pitchCents, volumePoints: k.volumePoints, speedPoints: k.speedPoints, pitchPoints: k.pitchPoints,
                fadeInMs: k.fadeInMs, fadeOutMs: k.fadeOutMs, loops: k.loops, origin: k.origin, createdAt: k.createdAt ?? now,
              });
              if (k.chosen) chosen.push({ cueId: ids[qi]!, clipId });
              if (k.generation) gens.push({ g: k.generation, clipId, cueClips: q.clips, cueId: ids[qi]! });
            }
            if (q.sfx) sfxRows.push({ cueId: ids[qi]!, prompt: q.sfx.prompt, durationMs: q.sfx.durationMs, looped: q.sfx.loop, promptInfluence: q.sfx.promptInfluence.toFixed(2), model: q.sfx.model, updatedAt: now });
          }
        }
      }
    }
    for (let i = 0; i < clipRows.length; i += 500) await tx.insert(clip).values(clipRows.slice(i, i + 500));
    for (let i = 0; i < sfxRows.length; i += 500) await tx.insert(cueSfx).values(sfxRows.slice(i, i + 500));
    if (gens.length) {
      const byCueNumber = new Map(clipRows.map((r) => [`${r.cueId}#${r.number}`, r.id!]));
      const rows = gens.map(({ g, clipId, cueId }) => ({
        id: newUlid(), projectId, clipId, kind: g.kind, model: g.model, voiceId: g.voiceId, textSent: g.textSent, direction: g.direction, settings: g.settings,
        sourceClipId: g.sourceTake === null ? null : byCueNumber.get(`${cueId}#${g.sourceTake}`) ?? null, outputFormat: g.outputFormat, context: g.context,
        requestId: g.requestId, characterCost: g.characterCost, createdByUserId: null, createdAt: g.createdAt ?? now,
      }));
      for (let i = 0; i < rows.length; i += 500) await tx.insert(generation).values(rows.slice(i, i + 500));
    }
    for (const c of chosen) await tx.update(cue).set({ clipId: c.clipId }).where(eq(cue.id, c.cueId));

    // Notes: roots first, then replies, each in the file's order.
    const noteIds = notes.map(() => newUlid());
    const targetId = (t: NonNullable<(typeof notes)[number]['target']>): string => {
      const [a, b, c, d] = t.path as [number, number, number, number];
      switch (t.kind) {
        case 'chapter': return chapterIds[a]!;
        case 'segment': return segmentIds[a]![b]!;
        case 'scene': return sceneIds[a]![b]![c]!;
        case 'cue': return cueIds[a]![b]![c]![d]!;
        default: return assetIds[a]!;
      }
    };
    const order = [...notes.keys()].filter((i) => notes[i]!.root === null).concat([...notes.keys()].filter((i) => notes[i]!.root !== null));
    for (const i of order) {
      const n = notes[i]!;
      const t = n.target;
      await tx.insert(note).values({
        id: noteIds[i]!, projectId, authorUserId: n.authorKind === 'user' ? userId : null, authorKind: n.authorKind, type: n.type, textMd: n.text, refKey: n.refKey, link: n.link,
        doneAt: n.doneAt, doneByUserId: n.doneAt ? userId : null,
        chapterId: t?.kind === 'chapter' ? targetId(t) : null, segmentId: t?.kind === 'segment' ? targetId(t) : null, sceneId: t?.kind === 'scene' ? targetId(t) : null,
        cueId: t?.kind === 'cue' ? targetId(t) : null, assetId: t?.kind === 'asset' ? targetId(t) : null,
        rootNoteId: n.root === null ? null : noteIds[n.root]!, replyToNoteId: n.replyTo === null ? null : noteIds[n.replyTo]!,
        createdAt: n.createdAt, editedAt: n.editedAt, deletedAt: n.deletedAt,
      });
    }
    await touchProject(tx, projectId, userId);
    return projectId;
  });
  return { id, chapters: chapters.length, cues: parsed.cueTotal };
}

// ---- routes --------------------------------------------------------------------------------

/** A Content-Disposition value for a download name with any characters in it. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The project file inside an export (the zip's root). */
export const PROJECT_FILE = 'project.json';

const ALREADY_COMPRESSED = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'zip', 'pdf', 'docx', 'xlsx', 'pptx', 'epub']);

export function registerTransferRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };

  /** Reads what an export holds, and refuses when it cannot be made: a library file called project.json at the root would clash with the project file. */
  async function prepareExport(userId: string, id: string) {
    const { bundle, title, folder } = await withDb(async (db) => {
      await accessTo(db, userId, id);
      const b = await buildBundle(db, id);
      const row = (await db.select({ t: project.title, f: project.repoFolder }).from(project).where(eq(project.id, id)).limit(1))[0]!;
      return { bundle: b, title: row.t, folder: row.f };
    });
    const files = await blobStore().listFiles(id);
    if (files.some((f) => f.toLowerCase() === PROJECT_FILE)) {
      throw new HttpError(409, 'name_clash', 'The library has a file named project.json in its root, which the export needs for the project itself. Rename that file first.');
    }
    return { bundle, files, name: cleanFolder(folder ?? title) ?? 'project' };
  }

  // The browser asks first, so a refusal is shown as a message instead of being saved as the download.
  app.get('/api/projects/:id/export/check', auth, async (request) => {
    const { files } = await prepareExport(request.account!.id, checkId((request.params as { id: string }).id));
    return { ok: true, files: files.length };
  });

  // The whole project as one zip: project.json at the root (everything but members, snapshots and file bytes) and
  // the library's files at their paths. Streamed as it is built: nothing is kept in memory or written to disk.
  app.get('/api/projects/:id/export', auth, async (request, reply) => {
    const id = checkId((request.params as { id: string }).id);
    const { bundle, files, name } = await prepareExport(request.account!.id, id);
    // The browser sends its own local time ("DD.MM.YY HH:mm") for the file name; without it the server's clock is used.
    const sent = (request.query as { stamp?: string }).stamp;
    const d = new Date(), p2 = (n: number) => String(n).padStart(2, '0');
    const stamp = sent && /^\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}$/.test(sent) ? sent
      : `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${p2(d.getFullYear() % 100)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const store = blobStore();
    const archive = new ZipArchive({ zlib: { level: 3 } });
    archive.on('warning', (e) => request.log.warn(e));
    archive.on('error', (e) => {
      request.log.error(e);
      reply.raw.destroy(e);
    });
    reply.raw.on('close', () => archive.abort());
    archive.append(Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'), { name: PROJECT_FILE });
    for (const rel of files) {
      const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
      archive.append(store.read(id, rel), { name: rel, store: ALREADY_COMPRESSED.has(ext) });
    }
    void archive.finalize();
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', attachment(`${name} - ${stamp}.zip`))
      .header('cache-control', 'no-store')
      .send(archive);
  });

  app.post('/api/projects/import', { ...auth, bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    if (request.account!.isAdmin) throw new HttpError(403, 'admin_cannot_create', 'The admin account cannot create media projects.');
    const body = obj(request.body, 'request');
    const folder = body.repoFolder === undefined ? undefined : str(body.repoFolder, 'repoFolder', 200, 0);
    const result = await importBundle(request.account!.id, body.file, folder);
    return reply.code(201).send(result);
  });

  /**
   * Puts one file of an exported library back where the project's file list says it belongs. The browser unpacks the
   * zip and sends each entry here, one request per file, so no request is larger than a library file (100 MiB).
   * `path` is the entry's path in the zip. It must be a master or a derived copy (MP3 of a WAV, reduced image) of a
   * file the project already lists; a master must also match the listed hash. Works in managed folders too, since it
   * only fills in what the project already knows.
   */
  app.post('/api/projects/:id/library/restore', { onRequest: authenticate(), bodyLimit: MAX_UPLOAD + 4096 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const raw = (request.query as Record<string, unknown>).path;
    const rel = typeof raw === 'string' ? cleanPath(raw) : null;
    if (!rel) throw badRequest('invalid_path', 'The file has no valid path.');
    const data = request.body;
    if (!Buffer.isBuffer(data) || data.byteLength === 0) throw badRequest('invalid_body', 'Send the file as the request body (application/octet-stream).');
    if (data.byteLength > MAX_UPLOAD) throw new HttpError(413, 'too_large', 'The file is larger than 100 MB.');
    const replace = (request.query as Record<string, unknown>).replace === '1';
    const out = await withDb(async (db) => {
      await accessTo(db, request.account!.id, id, { edit: true });
      const a = (await db.select().from(asset).where(and(eq(asset.projectId, id), or(eq(asset.path, rel), eq(asset.lightweightPath, rel)))).limit(1))[0];
      if (!a) throw new HttpError(404, 'not_in_project', 'This file is not in the project\'s file list.');
      const store = blobStore();
      const isMaster = a.path.toLowerCase() === rel.toLowerCase();
      const place = isMaster ? a.path : a.lightweightPath!;
      // The zip's file is chosen over the one already there: it becomes the asset's file (see replaceFile).
      if (replace && isMaster && (await store.size(id, a.path)) !== null) {
        const r = await replaceFile(db, a, data);
        await touchProject(db, id, request.account!.id);
        return { outcome: 'replaced' as const, kind: 'master' as const, assetId: a.id, path: a.path, complete: true, fit: r.changed ? r.asset : null };
      }
      let outcome: 'restored' | 'already' = 'restored';
      // A copy (MP3, reduced picture) that the server is making right now is not put back from the zip.
      if ((await store.size(id, place)) !== null || (!isMaster && (a.status === 'pending' || a.status === 'processing'))) outcome = 'already';
      else {
        if (isMaster) {
          let hash = sha256(data);
          if (a.mediaKind === 'audio' && /\.wav$/i.test(place)) {
            try { hash = sha256(wavSamples(data, parseWav(data))); } catch (e) {
              if (e instanceof AudioError) throw new HttpError(422, 'unreadable_file', e.message);
              throw e;
            }
          }
          if (hash !== a.hash) throw new HttpError(409, 'hash_mismatch', 'This is not the same file the project lists.');
        }
        await store.put(id, place, data);
      }
      // The listing is complete again when the master and its derived copy are both on disk.
      const masterThere = (await store.size(id, a.path)) !== null;
      const lightThere = a.lightweightPath === null || (await store.size(id, a.lightweightPath)) !== null;
      const fileState = masterThere && lightThere ? 'ok' : 'missing';
      if (fileState !== a.fileState) await db.update(asset).set({ fileState, updatedAt: new Date() }).where(eq(asset.id, a.id));
      return { outcome, kind: (isMaster ? 'master' : 'derived') as 'master' | 'derived', assetId: a.id, path: place, complete: fileState === 'ok', fit: null as AssetRow | null };
    });
    const { fit, ...result } = out;
    const tasks = fit ? await addFitTasks(request.account!.id, fit) : 0;
    if (fit && fit.status === 'pending') kickAudioJobs(request.log);
    return { ...result, tasks };
  });

  // Which of these zip entries does the project know, and which of those are on disk right now? The browser asks before
  // it uploads anything, so the person can decide what to do with files that already exist.
  app.post('/api/projects/:id/library/restore-check', { onRequest: authenticate(), bodyLimit: 4 * 1024 * 1024 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { paths?: unknown };
    if (!Array.isArray(body.paths) || body.paths.length > 20000 || body.paths.some((x) => typeof x !== 'string')) throw badRequest('invalid_paths', 'Send { paths: [...] }.');
    const paths = [...new Set((body.paths as string[]).map((x) => cleanPath(x)).filter((x): x is string => !!x))];
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, id, { edit: true });
      const store = blobStore();
      const files: { path: string; role: 'master' | 'derived'; assetId: string; masterPath: string; onDisk: number | null; listedSize: number }[] = [];
      for (let i = 0; i < paths.length; i += 400) {
        const chunk = paths.slice(i, i + 400);
        const rows = await db.select().from(asset).where(and(eq(asset.projectId, id), or(inArray(asset.path, chunk), inArray(asset.lightweightPath, chunk))));
        for (const a of rows) {
          for (const p of chunk) {
            const master = a.path.toLowerCase() === p.toLowerCase();
            const derived = !!a.lightweightPath && a.lightweightPath.toLowerCase() === p.toLowerCase();
            if (!master && !derived) continue;
            const place = master ? a.path : a.lightweightPath!;
            files.push({ path: p, role: master ? 'master' : 'derived', assetId: a.id, masterPath: a.path, onDisk: await store.size(id, place), listedSize: master ? a.size : a.sizeLightweight ?? 0 });
          }
        }
      }
      return { files };
    });
  });
}
