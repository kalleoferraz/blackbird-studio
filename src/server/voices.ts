import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { inTransaction, withDb } from '../db/client.js';
import { touchProject } from '../db/touch.js';
import { asset, character, cue, membership, project, voiceExclusion } from '../db/schema.js';
import { audioTags, spokenText } from '../voice/generate.js';
import { projectVoiceSettings } from '../voice/settings.js';
import { ACCOUNT_FILTERS, DEFAULT_OUTPUT_FORMAT, DEFAULT_SPEECH_MODEL, OUTPUT_FORMATS, PUBLIC_FILTERS, SPEECH_MODELS, isOutputFormat, type FilterDef } from '../shared/voice.js';
import { blobStore } from '../storage/blob-store.js';
import { voiceSamplesFolder } from '../library/managed.js';
import { elevenLabs, type ElevenLabs, type VoiceFilters } from '../voice/elevenlabs.js';
import { projectTitle, retireVoice, voiceName } from '../voice/character-voice.js';
import { accessTo, accessToEntity, checkId } from './access.js';
import { authenticate } from './auth-routes.js';
import { characterView } from './characters.js';
import { HttpError, asBody, badRequest, reqString } from './http.js';

const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_SAMPLE_MS = 5_000, MIN_TOTAL_MS = 10_000;

/** The first few seconds of a text: about 90 characters, cut at a sentence end when one comes late enough, else at a word. */
export function firstSeconds(text: string, max = 90): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence >= 40) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '') + '…';
}

/** Voice Design previews waiting to be chosen: generated voice ID → audio, for 30 minutes. */
const previews = new Map<string, { userId: string; characterId: string; audio: Buffer; mediaType: string; expires: number }>();
function sweepPreviews() {
  const now = Date.now();
  for (const [k, v] of previews) if (v.expires < now) previews.delete(k);
  while (previews.size > 60) previews.delete(previews.keys().next().value!);
}

/** Samples already heard, so listening again costs nothing: key → audio. Kept in memory, the newest 60. */
const sampleCache = new Map<string, Buffer>();
const remember = (k: string, v: Buffer) => { sampleCache.delete(k); sampleCache.set(k, v); while (sampleCache.size > 60) sampleCache.delete(sampleCache.keys().next().value!); };

/**
 * The list filters from `?f=<json>`, checked against the documented ones (`defs`); unknown keys are refused.
 * Exported for tests.
 */
export function parseVoiceFilters(raw: string | undefined, defs: FilterDef[]): VoiceFilters {
  if (!raw) return {};
  let o: unknown;
  try { o = JSON.parse(raw); } catch { throw badRequest('invalid_filters', 'The filters are not valid JSON.'); }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw badRequest('invalid_filters');
  const out: VoiceFilters = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const d = defs.find((x) => x.key === k);
    if (!d) throw badRequest('invalid_filters', `Unknown filter: ${k}.`);
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    const bad = () => badRequest('invalid_filters', `The filter "${d.label}" has a value that is not allowed.`);
    if (d.kind === 'bool') { if (typeof v !== 'boolean') throw bad(); out[k] = v; }
    else if (d.kind === 'int') { if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > (d.max ?? 1e6)) throw bad(); out[k] = v; }
    else if (d.kind === 'enum') { if (typeof v !== 'string' || !d.values!.includes(v)) throw bad(); out[k] = v; }
    else if (d.kind === 'text') { if (typeof v !== 'string' || v.length > 100) throw bad(); out[k] = v.trim(); }
    else {
      if (!Array.isArray(v) || v.length > 10 || !v.every((x) => typeof x === 'string' && x.length <= 50)) throw bad();
      if (d.kind === 'enum-list' && !v.every((x) => d.values!.includes(x as string))) throw bad();
      out[k] = (v as string[]).map((x) => x.trim()).filter(Boolean);
    }
  }
  return out;
}

export async function readAll(projectId: string, path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of blobStore().read(projectId, path)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** The audio of an asset to send to ElevenLabs: the MP3 copy when there is one (the docs advise MP3 for samples), else the master. */
export async function assetAudio(a: typeof asset.$inferSelect): Promise<{ name: string; data: Buffer; type: string }> {
  const path = a.lightweightPath ?? a.path;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const type = name.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : name.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'application/octet-stream';
  return { name, data: await readAll(a.projectId, path), type };
}

const durationOf = (a: typeof asset.$inferSelect) => Number((a.mediaInfo as { durationMs?: number } | null)?.durationMs ?? 0);

/** Character voices: choosing, cloning and listing (Bible, decision log 2026-11-20). */
export function registerVoiceRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };

  /** Voices the project's characters use (including public ones already added), with their previews. */
  app.get('/api/projects/:id/voices/project', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const rows = await withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      return db.select({ id: character.id, name: character.name, voiceId: character.voiceId, voiceName: character.voiceName, voiceSource: character.voiceSource })
        .from(character).where(eq(character.projectId, projectId));
    });
    const used = rows.filter((r) => r.voiceId);
    const ids = [...new Set(used.map((r) => r.voiceId!))];
    if (!ids.length) return { voices: [] };
    const { client } = await elevenLabs();
    const found = new Map((await client.voices({ voiceIds: ids })).voices.map((v) => [v.voiceId, v]));
    return {
      voices: ids.map((id) => {
        const v = found.get(id), first = used.find((r) => r.voiceId === id)!;
        return { voiceId: id, name: v?.name ?? first.voiceName ?? id, previewUrl: v?.previewUrl ?? null, category: v?.category ?? null, labels: v?.labels ?? {},
          source: first.voiceSource, missing: !v, characters: used.filter((r) => r.voiceId === id).map((r) => r.name) };
      }),
    };
  });

  /**
   * The language filter of the voice lists: `?language=` absent means the project's language, `all` means none,
   * any other value is an ISO 639-1 code. Returns the code used (null: all languages) and the project's own.
   */
  const languageFor = async (userId: string, projectId: string, asked: string | undefined) => {
    const lang = await withDb(async (db) => {
      await accessTo(db, userId, projectId, { edit: true });
      return (await db.select({ l: project.language }).from(project).where(eq(project.id, projectId)).limit(1))[0]?.l ?? '';
    });
    const own = lang.split('-')[0]!.toLowerCase() || null;
    if (asked === 'all') return { language: null, projectLanguage: own };
    if (asked !== undefined && asked !== '') {
      if (!/^[a-z]{2,3}$/.test(asked)) throw badRequest('invalid_language');
      return { language: asked, projectLanguage: own };
    }
    return { language: own, projectLanguage: own };
  };

  const excludedIds = async (projectId: string) =>
    new Set((await withDb((db) => db.select({ v: voiceExclusion.voiceId }).from(voiceExclusion).where(eq(voiceExclusion.projectId, projectId)))).map((r) => r.v));

  // ---- voices excluded from this project's searches (Bible, decision log 2026-11-21) -----------------------

  app.get('/api/projects/:id/voices/excluded', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      const rows = await db.select().from(voiceExclusion).where(eq(voiceExclusion.projectId, projectId)).orderBy(voiceExclusion.name);
      return { voices: rows.map((r) => ({ voiceId: r.voiceId, source: r.source, name: r.name, info: r.info, publicOwnerId: r.publicOwnerId, previewUrl: r.previewUrl, createdAt: r.createdAt.toISOString() })) };
    });
  });

  /** Excludes a voice from this project's account and library searches (kept until it is included again). */
  app.post('/api/projects/:id/voices/excluded', { ...auth, bodyLimit: 4096 }, async (request, reply) => {
    const projectId = checkId((request.params as { id: string }).id);
    const b = asBody(request.body);
    const voiceId = reqString(b, 'voiceId', 64);
    if (!VOICE_ID.test(voiceId)) throw badRequest('invalid_voiceId');
    if (b.source !== 'account' && b.source !== 'public') throw badRequest('invalid_source');
    const str = (k: string, max: number) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim().slice(0, max) : null);
    const preview = str('previewUrl', 2048);
    const row = {
      projectId, voiceId, source: b.source, name: str('name', 100) ?? voiceId, info: str('info', 300), publicOwnerId: str('publicOwnerId', 100),
      previewUrl: preview && /^https:\/\//.test(preview) ? preview : null, createdByUserId: request.account!.id, createdAt: new Date(),
    } as const;
    await inTransaction(async (tx) => {
      await accessTo(tx, request.account!.id, projectId, { edit: true });
      await tx.insert(voiceExclusion).values(row).onDuplicateKeyUpdate({ set: { name: row.name, info: row.info } });
      await touchProject(tx, projectId, request.account!.id);
    });
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/projects/:id/voices/excluded/:voiceId', auth, async (request) => {
    const { id, voiceId } = request.params as { id: string; voiceId: string };
    const projectId = checkId(id);
    if (!VOICE_ID.test(voiceId)) throw badRequest('invalid_voiceId');
    await inTransaction(async (tx) => {
      await accessTo(tx, request.account!.id, projectId, { edit: true });
      await tx.delete(voiceExclusion).where(and(eq(voiceExclusion.projectId, projectId), eq(voiceExclusion.voiceId, voiceId)));
      await touchProject(tx, projectId, request.account!.id);
    });
    return { ok: true };
  });

  /** Adds a public library voice to the ElevenLabs account under its own name, without giving it to a character. */
  app.post('/api/projects/:id/voices/add', { ...auth, bodyLimit: 4096 }, async (request, reply) => {
    const projectId = checkId((request.params as { id: string }).id);
    const b = asBody(request.body);
    const voiceId = reqString(b, 'voiceId', 64), owner = reqString(b, 'publicOwnerId', 100), name = reqString(b, 'name', 100);
    if (!VOICE_ID.test(voiceId)) throw badRequest('invalid_voiceId');
    await withDb((db) => accessTo(db, request.account!.id, projectId, { edit: true }));
    const { client } = await elevenLabs(projectId);
    return reply.code(201).send({ voiceId: await client.addShared(owner, voiceId, name) });
  });

  /** The account's voices: built-in and cloned ones, and those added from the library. */
  app.get('/api/projects/:id/voices/account', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const q = request.query as Record<string, string | undefined>;
    const l = await languageFor(request.account!.id, projectId, q.language);
    const { client } = await elevenLabs();
    const filters = parseVoiceFilters(q.f, ACCOUNT_FILTERS);
    const r = await client.voices({ search: q.search?.slice(0, 100) || undefined, language: l.language ?? undefined, nextPageToken: q.pageToken?.slice(0, 500) || undefined, pageSize: 50, filters });
    const out = await excludedIds(projectId);
    return { ...l, ...r, voices: r.voices.filter((v) => !out.has(v.voiceId)) };
  });

  /** The public Voice Library, for the project's language unless another is asked for. */
  app.get('/api/projects/:id/voices/public', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const q = request.query as Record<string, string | undefined>;
    const l = await languageFor(request.account!.id, projectId, q.language);
    const page = Math.max(0, Math.min(1000, Number(q.page ?? 0) || 0));
    const { client } = await elevenLabs();
    const filters = parseVoiceFilters(q.f, PUBLIC_FILTERS);
    const out = await excludedIds(projectId);
    // The library's language filter also returns voices only verified in that language (English voices that can
    // speak Portuguese, say). Only voices whose own language is the chosen one are kept; to fill a page, up to six
    // pages of the library are read. `nextPage` is where the next search continues.
    const own = (v: { language: string | null }) => !l.language || (v.language ?? '').toLowerCase().split(/[-_]/)[0] === l.language;
    const voices: Awaited<ReturnType<typeof client.sharedVoices>>['voices'] = [];
    let at = page, hasMore = true;
    for (let read = 0; read < (l.language ? 6 : 1) && hasMore && voices.length < 30; read++, at++) {
      const r = await client.sharedVoices({ language: l.language ?? undefined, search: q.search?.slice(0, 100) || undefined, page: at, pageSize: 30, filters });
      voices.push(...r.voices.filter((v) => own(v) && !out.has(v.voiceId)));
      hasMore = r.hasMore;
    }
    return { ...l, voices, hasMore, nextPage: at };
  });

  /**
   * Gives a character a voice: one of the account's (`source: account`), or one from the public library
   * (`source: public`, added to the account as "Character (Project)"). The voice it had before is retired.
   */
  app.put('/api/characters/:id/voice', { ...auth, bodyLimit: 4096 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const b = asBody(request.body);
    const source = b.source;
    if (source !== 'account' && source !== 'public') throw badRequest('invalid_source');
    const voiceId = reqString(b, 'voiceId', 64);
    if (!VOICE_ID.test(voiceId)) throw badRequest('invalid_voiceId');
    const shownName = reqString(b, 'name', 100);
    const owner = source === 'public' ? reqString(b, 'publicOwnerId', 100) : null;
    const { client } = await elevenLabs();
    const cur = await withDb(async (db) => {
      await accessToEntity(db, request.account!.id, 'character', id, { edit: true });
      return (await db.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
    });
    let finalId = voiceId;
    const finalName = shownName;
    // A library voice is added to the account just as it is, under its own name (decided 2026-11-21).
    if (owner) finalId = await client.addShared(owner, voiceId, finalName);
    const row = await inTransaction(async (tx) => {
      await tx.update(character).set({ voiceId: finalId, voiceName: finalName.slice(0, 100), voiceSource: source, updatedAt: new Date() }).where(eq(character.id, id));
      await touchProject(tx, cur.projectId, request.account!.id);
      return (await tx.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
    });
    if (cur.voiceId && cur.voiceId !== finalId) await withDb((db) => retireVoice(db, client, cur, request.log));
    return characterView(row);
  });

  /** Takes the voice off a character (the voice itself stays in the account, renamed when the app created it). */
  app.delete('/api/characters/:id/voice', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const cur = await withDb(async (db) => {
      await accessToEntity(db, request.account!.id, 'character', id, { edit: true });
      return (await db.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
    });
    const row = await inTransaction(async (tx) => {
      await tx.update(character).set({ voiceId: null, voiceName: null, voiceSource: null, updatedAt: new Date() }).where(eq(character.id, id));
      await touchProject(tx, cur.projectId, request.account!.id);
      return (await tx.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
    });
    if (cur.voiceId) {
      try { const { client } = await elevenLabs(); await withDb((db) => retireVoice(db, client, cur, request.log)); } catch { /* no key: nothing to rename */ }
    }
    return characterView(row);
  });

  /**
   * Instant voice cloning from audio files of the library (normally the character's Voice Samples folder).
   * Needs `consent: true`: the author confirms having the right and consent to clone the voice.
   */
  app.post('/api/characters/:id/voice/clone', { ...auth, bodyLimit: 8192 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const b = asBody(request.body);
    if (b.consent !== true) throw new HttpError(400, 'consent_required', 'Confirm that you have the right and the consent to clone this voice.');
    const ids = Array.isArray(b.assetIds) ? b.assetIds : [];
    if (!ids.length || ids.length > 25 || !ids.every((x) => typeof x === 'string')) throw badRequest('invalid_assetIds', 'Choose from 1 to 25 audio files.');
    ids.forEach(checkId);
    const removeNoise = b.removeNoise === true;
    const { cur, files } = await withDb(async (db) => {
      await accessToEntity(db, request.account!.id, 'character', id, { edit: true });
      const cur = (await db.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
      const files = await db.select().from(asset).where(and(eq(asset.projectId, cur.projectId), inArray(asset.id, ids as string[])));
      return { cur, files };
    });
    if (files.length !== ids.length) throw badRequest('invalid_assetIds', 'Some files are not in this project.');
    for (const f of files) {
      if (f.mediaKind !== 'audio') throw badRequest('not_audio', `${f.path} is not audio.`);
      if (f.status !== 'ready') throw new HttpError(409, 'not_ready', `${f.path} is still being processed.`);
      if (f.fileState === 'missing') throw new HttpError(409, 'missing_file', `${f.path} is missing on disk.`);
      if (durationOf(f) < MIN_SAMPLE_MS) throw badRequest('sample_too_short', `${f.path} is shorter than 5 seconds; every sample needs at least 5 seconds.`);
    }
    if (files.reduce((s, f) => s + durationOf(f), 0) < MIN_TOTAL_MS) throw badRequest('samples_too_short', 'The samples together need at least 10 seconds (1 to 2 minutes is best).');
    const { client } = await elevenLabs();
    const plan = await client.subscription();
    if (!plan.canClone) throw new HttpError(402, 'voice_plan', `The ElevenLabs plan (${plan.tier || 'current'}) does not include voice cloning.`);
    const name = voiceName(cur.name, await withDb((db) => projectTitle(db, cur.projectId)));
    const made = await client.clone(name, await Promise.all(files.map(assetAudio)), { removeNoise, description: `Cloned in Blackbird Studio from ${files.length} sample${files.length === 1 ? '' : 's'} in ${voiceSamplesFolder(cur.folder)}.` });
    const row = await inTransaction(async (tx) => {
      await tx.update(character).set({ voiceId: made.voiceId, voiceName: name, voiceSource: 'clone', updatedAt: new Date() }).where(eq(character.id, id));
      await touchProject(tx, cur.projectId, request.account!.id);
      return (await tx.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
    });
    if (cur.voiceId && cur.voiceId !== made.voiceId) await withDb((db) => retireVoice(db, client, cur, request.log));
    return { ...characterView(row), requiresVerification: made.requiresVerification };
  });

  // ---- managing a cloned voice: rename, description, samples, remove ----------------------------------

  /**
   * A voice made in the account (cloned, or designed: category `generated`), or 400 otherwise (built-in and library
   * voices are not managed here).
   */
  const cloneOf = async (client: ElevenLabs, voiceId: string, needSamples = false) => {
    if (!VOICE_ID.test(voiceId)) throw badRequest('invalid_voiceId');
    const v = await client.voice(voiceId);
    if (v.category !== 'cloned' && v.category !== 'generated') throw new HttpError(400, 'not_managed', 'Only cloned and designed voices can be renamed, edited or removed here.');
    if (needSamples && v.category !== 'cloned') throw new HttpError(400, 'no_samples', 'A designed voice has no samples: only cloned voices do.');
    return v;
  };
  /** The characters that use a voice, in every project. Projects the user is not a member of are only counted. */
  const usersOf = async (userId: string, voiceId: string) => withDb(async (db) => {
    const rows = await db.select({ characterId: character.id, name: character.name, projectId: character.projectId, title: project.title })
      .from(character).innerJoin(project, eq(project.id, character.projectId)).where(eq(character.voiceId, voiceId));
    const mine = new Set((await db.select({ p: membership.projectId }).from(membership).where(eq(membership.userId, userId))).map((m) => m.p));
    return {
      characters: rows.filter((r) => mine.has(r.projectId)).map((r) => ({ characterId: r.characterId, name: r.name, projectId: r.projectId, project: r.title })),
      elsewhere: rows.filter((r) => !mine.has(r.projectId)).length,
      projectIds: [...new Set(rows.map((r) => r.projectId))],
    };
  });
  const authorOf = (request: { account?: { id: string } }, projectId: string) => withDb((db) => accessTo(db, request.account!.id, projectId, { edit: true }));

  app.get('/api/projects/:id/voices/clones/:voiceId', auth, async (request) => {
    const { id, voiceId } = request.params as { id: string; voiceId: string };
    await authorOf(request, checkId(id));
    const { client } = await elevenLabs();
    const v = await cloneOf(client, voiceId);
    const used = await usersOf(request.account!.id, voiceId);
    return { voiceId: v.voiceId, name: v.name, category: v.category, description: v.description, samples: v.samples, usedBy: used.characters, usedElsewhere: used.elsewhere };
  });

  /** Renames a clone and/or changes its description; the name is updated on every character that uses it. */
  app.patch('/api/projects/:id/voices/clones/:voiceId', { ...auth, bodyLimit: 8192 }, async (request) => {
    const { id, voiceId } = request.params as { id: string; voiceId: string };
    await authorOf(request, checkId(id));
    const b = asBody(request.body);
    const { client } = await elevenLabs();
    const v = await cloneOf(client, voiceId);
    const name = 'name' in b ? reqString(b, 'name', 100) : v.name;
    const description = 'description' in b ? (b.description === null ? null : typeof b.description === 'string' && b.description.length <= 500 ? b.description.trim() : (() => { throw badRequest('invalid_description'); })()) : undefined;
    await client.edit(voiceId, { name, description });
    if (name !== v.name) {
      const used = await usersOf(request.account!.id, voiceId);
      await inTransaction(async (tx) => {
        await tx.update(character).set({ voiceName: name, updatedAt: new Date() }).where(eq(character.voiceId, voiceId));
        for (const p of used.projectIds) await touchProject(tx, p, request.account!.id);
      });
    }
    return { ok: true, name };
  });

  /** Adds samples from the project's library to a clone. */
  app.post('/api/projects/:id/voices/clones/:voiceId/samples', { ...auth, bodyLimit: 8192 }, async (request) => {
    const { id, voiceId } = request.params as { id: string; voiceId: string };
    const projectId = checkId(id);
    await authorOf(request, projectId);
    const b = asBody(request.body);
    if (b.consent !== true) throw new HttpError(400, 'consent_required', 'Confirm that you have the right and the consent to use these recordings of this voice.');
    const ids = Array.isArray(b.assetIds) ? b.assetIds : [];
    if (!ids.length || ids.length > 25 || !ids.every((x) => typeof x === 'string')) throw badRequest('invalid_assetIds', 'Choose from 1 to 25 audio files.');
    ids.forEach(checkId);
    const files = await withDb((db) => db.select().from(asset).where(and(eq(asset.projectId, projectId), inArray(asset.id, ids as string[]))));
    if (files.length !== ids.length) throw badRequest('invalid_assetIds', 'Some files are not in this project.');
    for (const f of files) {
      if (f.mediaKind !== 'audio') throw badRequest('not_audio', `${f.path} is not audio.`);
      if (f.status !== 'ready') throw new HttpError(409, 'not_ready', `${f.path} is still being processed.`);
      if (durationOf(f) < MIN_SAMPLE_MS) throw badRequest('sample_too_short', `${f.path} is shorter than 5 seconds; every sample needs at least 5 seconds.`);
    }
    const { client } = await elevenLabs();
    const v = await cloneOf(client, voiceId, true);
    await client.edit(voiceId, { name: v.name, files: await Promise.all(files.map(assetAudio)), removeNoise: b.removeNoise === true });
    return { samples: (await client.voice(voiceId)).samples };
  });

  app.delete('/api/projects/:id/voices/clones/:voiceId/samples/:sampleId', auth, async (request) => {
    const { id, voiceId, sampleId } = request.params as { id: string; voiceId: string; sampleId: string };
    await authorOf(request, checkId(id));
    if (!VOICE_ID.test(sampleId)) throw badRequest('invalid_sampleId');
    const { client } = await elevenLabs();
    const v = await cloneOf(client, voiceId, true);
    if (v.samples.length <= 1) throw new HttpError(409, 'last_sample', 'A clone needs at least one sample: add another before removing this one.');
    await client.deleteSample(voiceId, sampleId);
    return { samples: (await client.voice(voiceId)).samples };
  });

  /** Plays a sample through the server, which holds the key. */
  app.get('/api/projects/:id/voices/clones/:voiceId/samples/:sampleId/audio', auth, async (request, reply) => {
    const { id, voiceId, sampleId } = request.params as { id: string; voiceId: string; sampleId: string };
    await authorOf(request, checkId(id));
    if (!VOICE_ID.test(voiceId) || !VOICE_ID.test(sampleId)) throw badRequest('invalid_request');
    const { client } = await elevenLabs();
    const a = await client.sampleAudio(voiceId, sampleId);
    return reply.header('content-type', a.contentType).header('cache-control', 'private, max-age=300').send(a.data);
  });

  /** Removes a clone from the ElevenLabs account; every character that used it, in any project, loses its voice. Takes stay. */
  app.delete('/api/projects/:id/voices/clones/:voiceId', auth, async (request) => {
    const { id, voiceId } = request.params as { id: string; voiceId: string };
    await authorOf(request, checkId(id));
    const { client } = await elevenLabs();
    await cloneOf(client, voiceId);
    const used = await usersOf(request.account!.id, voiceId);
    await client.deleteVoice(voiceId);
    await inTransaction(async (tx) => {
      await tx.update(character).set({ voiceId: null, voiceName: null, voiceSource: null, updatedAt: new Date() }).where(eq(character.voiceId, voiceId));
      for (const p of used.projectIds) await touchProject(tx, p, request.account!.id);
    });
    return { ok: true, charactersCleared: used.characters.length + used.elsewhere };
  });

  // ---- a sample of a voice speaking the start of a cue (uses credits; heard again from the cache) -----------

  /** The text a voice sample reads: the first few seconds of a cue (the one selected in the script). */
  app.get('/api/cues/:id/sample-text', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessToEntity(db, request.account!.id, 'cue', id, { edit: true });
      const row = (await db.select({ text: cue.textMd, type: cue.type }).from(cue).where(eq(cue.id, id)).limit(1))[0];
      return { text: row ? firstSeconds(spokenText(row.text)) : '', type: row?.type ?? null };
    });
  });

  /**
   * A voice speaking a short text in the project's language, with the character's directions and settings when a
   * character is named. Nothing is stored; the same request again is answered from memory without new credits.
   */
  app.post('/api/projects/:id/voices/sample', { ...auth, bodyLimit: 4096 }, async (request, reply) => {
    const projectId = checkId((request.params as { id: string }).id);
    const b = asBody(request.body);
    const voiceId = reqString(b, 'voiceId', 64);
    if (!VOICE_ID.test(voiceId)) throw badRequest('invalid_voiceId');
    const text = reqString(b, 'text', 200);
    const characterId = typeof b.characterId === 'string' ? checkId(b.characterId) : null;
    const { lang, ch } = await withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId, { edit: true });
      const lang = (await db.select({ l: project.language }).from(project).where(eq(project.id, projectId)).limit(1))[0]?.l ?? '';
      const ch = characterId ? (await db.select().from(character).where(and(eq(character.id, characterId), eq(character.projectId, projectId))).limit(1))[0] ?? null : null;
      return { lang, ch };
    });
    const { client, model } = await elevenLabs(projectId);
    const tags = audioTags(ch?.voiceDirection);
    const sent = tags ? `${tags} ${text}` : text;
    const settings = (ch?.voiceSettings ?? null) as Record<string, unknown> | null;
    const key = JSON.stringify([voiceId, model, lang, sent, settings]);
    let audio = sampleCache.get(key);
    const cached = !!audio;
    if (!audio) {
      const languageCode = model.startsWith('eleven_multilingual_v2') ? null : lang.split('-')[0]!.toLowerCase() || null;
      try {
        const a = await client.speech(voiceId, { text: sent, modelId: model, languageCode, settings }, 'mp3_44100_64');
        audio = a.data;
      } catch (e) {
        if (e instanceof HttpError && e.code === 'voice_not_found') {
          throw new HttpError(409, 'voice_not_in_account', 'This voice is not in the ElevenLabs account, so it cannot speak a sample yet. Add it first (Add and use), or listen to its preview.');
        }
        throw e;
      }
      remember(key, audio);
    }
    return reply.header('content-type', 'audio/mpeg').header('x-sample-cached', cached ? '1' : '0')
      .header('cache-control', 'no-store').send(audio);
  });

  // ---- the project's own speech model and output format (Bible, decision log 2026-11-20) -----------------------

  app.get('/api/projects/:id/voices/settings', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const access = await withDb((db) => accessTo(db, request.account!.id, projectId));
    return { ...(await projectVoiceSettings(projectId)), canEdit: access.canEdit, defaults: { model: DEFAULT_SPEECH_MODEL, outputFormat: DEFAULT_OUTPUT_FORMAT }, formats: OUTPUT_FORMATS, models: SPEECH_MODELS };
  });

  /** `model` and `outputFormat`: a value, or null for the default. Authors only. */
  app.patch('/api/projects/:id/voices/settings', { ...auth, bodyLimit: 2048 }, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const b = asBody(request.body);
    const set: { voiceModel?: string | null; voiceOutputFormat?: string | null } = {};
    if ('model' in b) {
      const m = b.model === null || b.model === '' ? null : typeof b.model === 'string' ? b.model.trim() : undefined;
      if (m === undefined || (m !== null && !/^[\w.-]{1,64}$/.test(m))) throw badRequest('invalid_model', 'The model ID has characters that are not allowed.');
      set.voiceModel = m;
    }
    if ('outputFormat' in b) {
      const f = b.outputFormat === null || b.outputFormat === '' ? null : b.outputFormat;
      if (f !== null && (typeof f !== 'string' || !isOutputFormat(f))) throw badRequest('invalid_outputFormat', 'Choose one of the listed output formats.');
      set.voiceOutputFormat = f as string | null;
    }
    await inTransaction(async (tx) => {
      await accessTo(tx, request.account!.id, projectId, { edit: true });
      if (Object.keys(set).length) await tx.update(project).set(set).where(eq(project.id, projectId));
      await touchProject(tx, projectId, request.account!.id);
    });
    return projectVoiceSettings(projectId);
  });

  // ---- Voice Design: a voice made from a description, saved as the character's voice (Bible, decision log 2026-11-21) ----

  /**
   * Previews of a designed voice. Their audio waits in memory (30 minutes, for this user) and is played through
   * `/api/voice-previews/:id`; nothing is stored until one is chosen. Optional reference audio is a library file.
   */
  app.post('/api/characters/:id/voice/design', { ...auth, bodyLimit: 16384 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const b = asBody(request.body);
    const description = reqString(b, 'description', 1000);
    const text = typeof b.text === 'string' && b.text.trim() ? b.text.trim() : null;
    if (text !== null && (text.length < 100 || text.length > 1000)) throw badRequest('invalid_text', 'The sample text needs 100 to 1000 characters, or let it be written for you.');
    const model = b.model === 'eleven_ttv_v3' ? 'eleven_ttv_v3' : 'eleven_multilingual_ttv_v2';
    const num = (k: string, lo: number, hi: number, def: number) => {
      const v = b[k];
      if (v === undefined || v === null) return def;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw badRequest(`invalid_${k}`, `${k} must be from ${lo} to ${hi}.`);
      return v;
    };
    const loudness = num('loudness', -1, 1, 0.5), guidanceScale = num('guidanceScale', 0, 100, 5);
    const seed = b.seed === undefined || b.seed === null ? null : num('seed', 0, 4294967295, 0);
    if (seed !== null && !Number.isInteger(seed)) throw badRequest('invalid_seed');
    const refId = typeof b.referenceAssetId === 'string' ? checkId(b.referenceAssetId) : null;
    if (refId && model !== 'eleven_ttv_v3') throw badRequest('reference_needs_v3', 'Reference audio works with the v3 design model only.');
    const promptStrength = refId && b.promptStrength !== undefined && b.promptStrength !== null ? num('promptStrength', 0, 1, 0.5) : null;
    const { cur, ref } = await withDb(async (db) => {
      await accessToEntity(db, request.account!.id, 'character', id, { edit: true });
      const cur = (await db.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
      const ref = refId ? (await db.select().from(asset).where(and(eq(asset.id, refId), eq(asset.projectId, cur.projectId))).limit(1))[0] : null;
      return { cur, ref };
    });
    if (refId && (!ref || ref.mediaKind !== 'audio' || ref.status !== 'ready')) throw badRequest('invalid_reference', 'The reference must be a ready audio file of this project.');
    let referenceAudioBase64: string | null = null;
    if (ref) {
      const a = await assetAudio(ref);
      if (a.data.length > 15 * 1024 * 1024) throw badRequest('reference_too_large', 'The reference audio is too large (15 MB at most); choose a shorter file.');
      referenceAudioBase64 = a.data.toString('base64');
    }
    const { client } = await elevenLabs(cur.projectId);
    const r = await client.design({ description, model, text, loudness, guidanceScale, enhance: b.enhance === true, seed, referenceAudioBase64, promptStrength });
    sweepPreviews();
    for (const p of r.previews) previews.set(p.generatedVoiceId, { userId: request.account!.id, characterId: id, audio: p.audio, mediaType: p.mediaType, expires: Date.now() + 30 * 60_000 });
    return {
      text: r.text,
      previews: r.previews.map((p) => ({ generatedVoiceId: p.generatedVoiceId, durationSecs: p.durationSecs, language: p.language, mediaType: p.mediaType })),
    };
  });

  app.get('/api/voice-previews/:gid', auth, async (request, reply) => {
    const gid = (request.params as { gid: string }).gid;
    sweepPreviews();
    const p = VOICE_ID.test(gid) ? previews.get(gid) : undefined;
    if (!p || p.userId !== request.account!.id) throw new HttpError(404, 'preview_gone', 'This preview is no longer available (previews are kept for 30 minutes): create again.');
    return reply.header('content-type', p.mediaType).header('cache-control', 'private, no-store').send(p.audio);
  });

  /** Saves the chosen preview as a voice named "Character (Project)" and gives it to the character. */
  app.post('/api/characters/:id/voice/design/save', { ...auth, bodyLimit: 8192 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const b = asBody(request.body);
    const gid = reqString(b, 'generatedVoiceId', 64);
    if (!VOICE_ID.test(gid)) throw badRequest('invalid_generatedVoiceId');
    const description = reqString(b, 'description', 1000);
    const played = Array.isArray(b.played) ? (b.played as unknown[]).filter((x): x is string => typeof x === 'string' && VOICE_ID.test(x) && x !== gid).slice(0, 20) : [];
    const cur = await withDb(async (db) => {
      await accessToEntity(db, request.account!.id, 'character', id, { edit: true });
      return (await db.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
    });
    const { client } = await elevenLabs(cur.projectId);
    const name = voiceName(cur.name, await withDb((db) => projectTitle(db, cur.projectId)));
    const voiceId = await client.createDesigned({ name, description, generatedVoiceId: gid, playedNotSelected: played });
    const row = await inTransaction(async (tx) => {
      await tx.update(character).set({ voiceId, voiceName: name, voiceSource: 'designed', updatedAt: new Date() }).where(eq(character.id, id));
      await touchProject(tx, cur.projectId, request.account!.id);
      return (await tx.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
    });
    if (cur.voiceId && cur.voiceId !== voiceId) await withDb((db) => retireVoice(db, client, cur, request.log));
    return characterView(row);
  });
}
