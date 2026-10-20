import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { inTransaction, withDb, type Tx, type Q } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { touchProject } from '../db/touch.js';
import { chapter, character, cue, lane, segment, scene } from '../db/schema.js';
import { COLOUR_PATTERN, nextColour } from '../shared/palette.js';
import { accessTo, accessToEntity, checkId } from './access.js';
import { authenticate } from './auth-routes.js';
import { HttpError, asBody, badRequest, optBool, optString, reqString } from './http.js';

const FOLDER_MAX = 30;

/** A folder name for a character: unsafe characters removed, at most 30 characters, a number on collision. */
export function folderName(name: string, taken: readonly string[]): string {
  const clean =
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, FOLDER_MAX)
      .trim() || 'character';
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(clean.toLowerCase())) return clean;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` ${n}`;
    const candidate = clean.slice(0, FOLDER_MAX - suffix.length).trim() + suffix;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return clean + newUlid().slice(-4);
}

export async function createCharacter(
  tx: Tx,
  projectId: string,
  input: { name: string; colour?: string; description?: string | null; isNarrator?: boolean },
): Promise<typeof character.$inferSelect> {
  const existing = await tx
    .select({ folder: character.folder, defaultColour: character.defaultColour })
    .from(character)
    .where(eq(character.projectId, projectId));
  const now = new Date();
  const row = {
    id: newUlid(),
    projectId,
    name: input.name,
    isNarrator: input.isNarrator ?? false,
    defaultColour: input.colour ?? nextColour(existing.map((e) => e.defaultColour)),
    pictureAssetId: null,
    description: input.description ?? null,
    folder: folderName(input.name, existing.map((e) => e.folder)),
    createdAt: now,
    updatedAt: now,
  };
  await tx.insert(character).values(row);
  return row;
}

function view(c: typeof character.$inferSelect, usage?: { cues: number; scenes: number }) {
  return {
    id: c.id,
    name: c.name,
    isNarrator: c.isNarrator,
    colour: c.defaultColour,
    description: c.description,
    folder: c.folder,
    pictureAssetId: c.pictureAssetId,
    ...(usage ? { usage } : {}),
  };
}

async function usageOf(q: Q, characterId: string): Promise<{ cues: number; scenes: number }> {
  const rows = await q
    .select({ cues: sql<number>`COUNT(${cue.id})`, scenes: sql<number>`COUNT(DISTINCT ${segment.sceneId})` })
    .from(cue)
    .innerJoin(segment, eq(segment.id, cue.segmentId))
    .where(eq(cue.characterId, characterId));
  return { cues: Number(rows[0]?.cues ?? 0), scenes: Number(rows[0]?.scenes ?? 0) };
}

export function registerCharacterRoutes(app: FastifyInstance): void {
  const auth = { preHandler: authenticate() };

  app.get('/api/projects/:id/characters', auth, async (request) => {
    const projectId = checkId((request.params as { id: string }).id);
    return withDb(async (db) => {
      await accessTo(db, request.account!.id, projectId);
      const rows = await db
        .select()
        .from(character)
        .where(eq(character.projectId, projectId))
        .orderBy(desc(character.isNarrator), asc(character.createdAt), asc(character.id));
      const counts = await db
        .select({ characterId: cue.characterId, cues: sql<number>`COUNT(${cue.id})` })
        .from(cue)
        .innerJoin(segment, eq(segment.id, cue.segmentId))
        .innerJoin(scene, eq(scene.id, segment.sceneId))
        .innerJoin(chapter, eq(chapter.id, scene.chapterId))
        .where(eq(chapter.projectId, projectId))
        .groupBy(cue.characterId);
      const cueCount = new Map(counts.map((c) => [c.characterId, Number(c.cues)]));
      return { characters: rows.map((r) => ({ ...view(r), cueCount: cueCount.get(r.id) ?? 0 })) };
    });
  });

  app.post('/api/projects/:id/characters', { ...auth, bodyLimit: 16384 }, async (request, reply) => {
    const projectId = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const name = reqString(body, 'name', 100);
    const colour = optString(body, 'colour', 7);
    if (colour !== undefined && (colour === null || !COLOUR_PATTERN.test(colour))) throw badRequest('invalid_colour');
    const description = optString(body, 'description', 20000, { allowNull: true });
    const created = await inTransaction(async (tx) => {
      await accessTo(tx, request.account!.id, projectId, { edit: true });
      const row = await createCharacter(tx, projectId, { name, colour: colour ?? undefined, description });
      await touchProject(tx, projectId, request.account!.id);
      return row;
    });
    return reply.code(201).send(view(created));
  });

  app.patch('/api/characters/:id', { ...auth, bodyLimit: 16384 }, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    const body = asBody(request.body);
    const name = 'name' in body ? reqString(body, 'name', 100) : undefined;
    const colour = optString(body, 'colour', 7);
    if (colour !== undefined && (colour === null || !COLOUR_PATTERN.test(colour))) throw badRequest('invalid_colour');
    const description = optString(body, 'description', 20000, { allowNull: true });
    const updateLanes = optBool(body, 'updateLanes') ?? false;
    return inTransaction(async (tx) => {
      const access = await accessToEntity(tx, request.account!.id, 'character', id, { edit: true });
      const current = (await tx.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
      const set: Partial<typeof character.$inferInsert> = { updatedAt: new Date() };
      if (name !== undefined && name !== current.name) {
        set.name = name;
        const others = await tx
          .select({ folder: character.folder, id: character.id })
          .from(character)
          .where(eq(character.projectId, access.projectId));
        set.folder = folderName(name, others.filter((o) => o.id !== id).map((o) => o.folder));
      }
      if (colour) set.defaultColour = colour;
      if (description !== undefined) set.description = description;
      await tx.update(character).set(set).where(eq(character.id, id));
      if (colour && updateLanes) {
        await tx.update(lane).set({ colour, updatedAt: new Date() }).where(eq(lane.characterId, id));
      }
      await touchProject(tx, access.projectId, request.account!.id);
      return view((await tx.select().from(character).where(eq(character.id, id)).limit(1))[0]!);
    });
  });

  app.delete('/api/characters/:id', auth, async (request) => {
    const id = checkId((request.params as { id: string }).id);
    return inTransaction(async (tx) => {
      const access = await accessToEntity(tx, request.account!.id, 'character', id, { edit: true });
      const current = (await tx.select().from(character).where(eq(character.id, id)).limit(1))[0]!;
      if (current.isNarrator) throw new HttpError(400, 'narrator_required', 'The Narrator cannot be removed.');
      const usage = await usageOf(tx, id);
      if (usage.cues > 0) {
        throw new HttpError(409, 'in_use', `Used by ${usage.cues} cue${usage.cues === 1 ? '' : 's'} in ${usage.scenes} scene${usage.scenes === 1 ? '' : 's'}.`, { usage });
      }
      await tx.delete(lane).where(eq(lane.characterId, id)); // lanes left empty by earlier edits
      await tx.delete(character).where(and(eq(character.id, id)));
      await touchProject(tx, access.projectId, request.account!.id);
      return { ok: true };
    });
  });
}
