/**
 * Sound-effect cues (Bible, decision log 2026-11-20): their generation settings (table `cue_sfx`, kept for
 * regenerating), the generation of one or more variations (one API call each), and the variations waiting for the
 * author to keep some of them as takes. Waiting variations live in memory for 30 minutes and are not stored.
 */
import { eq } from 'drizzle-orm';
import type { Q } from '../db/client.js';
import { newUlid } from '../db/ids.js';
import { cue, cueSfx } from '../db/schema.js';
import { HttpError, badRequest } from '../server/http.js';
import { SFX_MAX_MS, SFX_MIN_MS } from '../shared/voice.js';
import { elevenLabs } from './elevenlabs.js';
import { spokenText, stored } from './generate.js';

export const SFX_MODELS = ['eleven_text_to_sound_v3', 'eleven_text_to_sound_v2'] as const;
export const SFX_PROMPT_MAX = 450; // the limit the ElevenLabs website states for its prompt box
export const MAX_VARIATIONS = 4;

export interface SfxSettings { prompt: string; durationMs: number | null; loop: boolean; promptInfluence: number; model: (typeof SFX_MODELS)[number] }

/** The saved settings of a cue, or the defaults: the cue's text as prompt, its length when set by hand. */
export async function sfxSettings(q: Q, cueId: string): Promise<SfxSettings & { saved: boolean }> {
  const saved = (await q.select().from(cueSfx).where(eq(cueSfx.cueId, cueId)).limit(1))[0];
  if (saved) {
    return { prompt: saved.prompt, durationMs: saved.durationMs, loop: saved.looped, promptInfluence: Number(saved.promptInfluence), model: (SFX_MODELS as readonly string[]).includes(saved.model) ? saved.model as SfxSettings['model'] : SFX_MODELS[0], saved: true };
  }
  const c = (await q.select({ text: cue.textMd, lengthMs: cue.lengthMs, lengthAuto: cue.lengthAuto }).from(cue).where(eq(cue.id, cueId)).limit(1))[0];
  if (!c) throw new HttpError(404, 'not_found');
  const len = c.lengthAuto ? null : Math.min(SFX_MAX_MS, Math.max(SFX_MIN_MS, c.lengthMs));
  return { prompt: spokenText(c.text).slice(0, SFX_PROMPT_MAX), durationMs: len, loop: false, promptInfluence: 0.3, model: SFX_MODELS[0], saved: false };
}

/** Checks settings from a request body. */
export function parseSfxSettings(b: Record<string, unknown>): SfxSettings {
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt || prompt.length > SFX_PROMPT_MAX) throw badRequest('invalid_prompt', `Describe the sound in 1 to ${SFX_PROMPT_MAX} characters.`);
  const d = b.durationMs;
  if (d !== null && d !== undefined && (typeof d !== 'number' || !Number.isInteger(d) || d < SFX_MIN_MS || d > SFX_MAX_MS)) throw badRequest('invalid_durationMs', 'The length must be from 0.5 to 30 seconds, or automatic.');
  const pi = b.promptInfluence;
  if (typeof pi !== 'number' || !Number.isFinite(pi) || pi < 0 || pi > 1) throw badRequest('invalid_promptInfluence', 'Prompt influence must be from 0 to 1.');
  if (typeof b.loop !== 'boolean') throw badRequest('invalid_loop');
  if (typeof b.model !== 'string' || !(SFX_MODELS as readonly string[]).includes(b.model)) throw badRequest('invalid_model');
  return { prompt, durationMs: (d as number | null | undefined) ?? null, loop: b.loop, promptInfluence: Math.round(pi * 100) / 100, model: b.model as SfxSettings['model'] };
}

export async function saveSfxSettings(q: Q, cueId: string, s: SfxSettings): Promise<void> {
  const row = { prompt: s.prompt, durationMs: s.durationMs, looped: s.loop, promptInfluence: s.promptInfluence.toFixed(2), model: s.model, updatedAt: new Date() };
  await q.insert(cueSfx).values({ cueId, ...row }).onDuplicateKeyUpdate({ set: row });
}

// ---- waiting variations -----------------------------------------------------------------------------------

export interface Variation {
  id: string; cueId: string; projectId: string; userId: string; data: Buffer; ext: 'wav' | 'mp3'; contentType: string;
  settings: SfxSettings; outputFormat: string; requestId: string | null; characterCost: number | null; expires: number;
}
const waiting = new Map<string, Variation>();
const TTL_MS = 30 * 60_000, MAX_WAITING = 40;
function sweep() {
  const now = Date.now();
  for (const [k, v] of waiting) if (v.expires < now) waiting.delete(k);
  while (waiting.size > MAX_WAITING) waiting.delete(waiting.keys().next().value!);
}

/** A waiting variation of this user, or 404 (expired, or someone else's). */
export function variation(id: string, userId: string): Variation {
  sweep();
  const v = waiting.get(id);
  if (!v || v.userId !== userId) throw new HttpError(404, 'variation_gone', 'This variation is no longer available (they are kept for 30 minutes): generate again.');
  return v;
}
export const dropVariation = (id: string) => waiting.delete(id);

/** Generates `count` variations, one API call each; the ones that fail are reported, the others wait to be kept. */
export async function generateVariations(o: { cueId: string; projectId: string; userId: string; settings: SfxSettings; count: number }):
  Promise<{ variations: { id: string; contentType: string }[]; errors: string[] }> {
  const { client, outputFormat } = await elevenLabs(o.projectId);
  const s = o.settings;
  const results = await Promise.allSettled(Array.from({ length: o.count }, () =>
    client.soundEffect({ text: s.prompt, durationSeconds: s.durationMs === null ? null : s.durationMs / 1000, loop: s.loop, promptInfluence: s.promptInfluence, modelId: s.model }, outputFormat)));
  sweep();
  const out: { id: string; contentType: string }[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === 'rejected') { errors.push((r.reason as Error).message); continue; }
    const id = newUlid();
    const st = stored(r.value, outputFormat);
    const contentType = st.ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
    waiting.set(id, { id, cueId: o.cueId, projectId: o.projectId, userId: o.userId, data: st.data, ext: st.ext, contentType, settings: s, outputFormat,
      requestId: r.value.requestId, characterCost: r.value.characterCost, expires: Date.now() + TTL_MS });
    out.push({ id, contentType });
  }
  // All failed with the same reason (quota, plan, key): one clear error instead of a list.
  if (!out.length && errors.length) {
    const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    throw first.reason;
  }
  return { variations: out, errors };
}
