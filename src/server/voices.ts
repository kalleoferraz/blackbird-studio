import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { inTransaction, withDb } from '../db/client.js';
import { touchProject } from '../db/touch.js';
import { asset, character, membership, project } from '../db/schema.js';
import { blobStore } from '../storage/blob-store.js';
import { voiceSamplesFolder } from '../library/managed.js';
import { elevenLabs, type ElevenLabs } from '../voice/elevenlabs.js';
import { projectTitle, retireVoice, voiceName } from '../voice/character-voice.js';
import { accessTo, accessToEntity, checkId } from './access.js';
import { authenticate } from './auth-routes.js';
import { characterView } from './characters.js';
import { HttpError, asBody, badRequest, reqString } from './http.js';

const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_SAMPLE_MS = 5_000, MIN_TOTAL_MS = 10_000;

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

  /** The account's voices: built-in and cloned ones, and those added from the library. */
  app.get('/api/projects/:id/voices/account', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const q = request.query as Record<string, string | undefined>;
    const l = await languageFor(request.account!.id, projectId, q.language);
    const { client } = await elevenLabs();
    const r = await client.voices({ search: q.search?.slice(0, 100) || undefined, language: l.language ?? undefined, nextPageToken: q.pageToken?.slice(0, 500) || undefined, pageSize: 50 });
    return { ...l, ...r };
  });

  /** The public Voice Library, for the project's language unless another is asked for. */
  app.get('/api/projects/:id/voices/public', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    const q = request.query as Record<string, string | undefined>;
    const l = await languageFor(request.account!.id, projectId, q.language);
    const page = Math.max(0, Math.min(1000, Number(q.page ?? 0) || 0));
    const { client } = await elevenLabs();
    return { ...l, ...(await client.sharedVoices({ language: l.language ?? undefined, search: q.search?.slice(0, 100) || undefined, page, pageSize: 30 })) };
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
    let finalId = voiceId, finalName = shownName;
    if (owner) {
      finalName = voiceName(cur.name, await withDb((db) => projectTitle(db, cur.projectId)));
      finalId = await client.addShared(owner, voiceId, finalName);
    }
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

  /** The clone, or 400 when the voice is not one (built-in and library voices are not managed here). */
  const cloneOf = async (client: ElevenLabs, voiceId: string) => {
    if (!VOICE_ID.test(voiceId)) throw badRequest('invalid_voiceId');
    const v = await client.voice(voiceId);
    if (v.category !== 'cloned') throw new HttpError(400, 'not_a_clone', 'Only cloned voices can be renamed, edited or removed here.');
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
    return { voiceId: v.voiceId, name: v.name, description: v.description, samples: v.samples, usedBy: used.characters, usedElsewhere: used.elsewhere };
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
    const v = await cloneOf(client, voiceId);
    await client.edit(voiceId, { name: v.name, files: await Promise.all(files.map(assetAudio)), removeNoise: b.removeNoise === true });
    return { samples: (await client.voice(voiceId)).samples };
  });

  app.delete('/api/projects/:id/voices/clones/:voiceId/samples/:sampleId', auth, async (request) => {
    const { id, voiceId, sampleId } = request.params as { id: string; voiceId: string; sampleId: string };
    await authorOf(request, checkId(id));
    if (!VOICE_ID.test(sampleId)) throw badRequest('invalid_sampleId');
    const { client } = await elevenLabs();
    const v = await cloneOf(client, voiceId);
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
}
