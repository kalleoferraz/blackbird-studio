import { and, eq, ne } from 'drizzle-orm';
import type { Q } from '../db/client.js';
import { character, project } from '../db/schema.js';
import { HttpError } from '../server/http.js';
import type { VoiceSettings } from '../shared/voice.js';
import type { ElevenLabs } from './elevenlabs.js';

/** The name a voice gets in the ElevenLabs account when the app adds or clones it: "Character (Project)". */
export function voiceName(characterName: string, projectTitle: string, suffix = ''): string {
  const tail = ` (${projectTitle})${suffix}`;
  return (characterName.slice(0, Math.max(1, 100 - tail.length)) + tail).slice(0, 100);
}

export async function projectTitle(q: Q, projectId: string): Promise<string> {
  return (await q.select({ t: project.title }).from(project).where(eq(project.id, projectId)).limit(1))[0]?.t ?? '';
}

/**
 * A voice a character no longer uses stays in the account, renamed "Character (Project) · unused", when the app
 * created it (added from the library or cloned) and no other character uses it. A failure is only logged.
 */
export async function retireVoice(
  q: Q, client: ElevenLabs, old: { id: string; voiceId: string | null; voiceSource: string | null; name: string; projectId: string },
  log?: { warn(o: unknown, m?: string): void },
): Promise<void> {
  if (!old.voiceId || (old.voiceSource !== 'public' && old.voiceSource !== 'clone')) return;
  const others = await q.select({ id: character.id }).from(character).where(and(eq(character.voiceId, old.voiceId), ne(character.id, old.id))).limit(1);
  if (others.length) return;
  try {
    await client.rename(old.voiceId, voiceName(old.name, await projectTitle(q, old.projectId), ' · unused'));
  } catch (e) {
    log?.warn({ err: e, voiceId: old.voiceId }, 'Could not rename the unused voice');
  }
}

const RANGES = { stability: [0, 1], similarity: [0, 1], style: [0, 1], speed: [0.7, 1.2] } as const;

/** Checks voice settings from a request body; null clears them. */
export function parseVoiceSettings(v: unknown): VoiceSettings | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'invalid_voiceSettings');
  const o = v as Record<string, unknown>;
  const out: VoiceSettings = {};
  for (const [k, [lo, hi]] of Object.entries(RANGES) as [keyof typeof RANGES, readonly [number, number]][]) {
    const x = o[k];
    if (x === undefined || x === null) continue;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) throw new HttpError(400, 'invalid_voiceSettings', `${k} must be from ${lo} to ${hi}.`);
    out[k] = Math.round(x * 100) / 100;
  }
  if (o.speakerBoost !== undefined && o.speakerBoost !== null) {
    if (typeof o.speakerBoost !== 'boolean') throw new HttpError(400, 'invalid_voiceSettings');
    out.speakerBoost = o.speakerBoost;
  }
  return Object.keys(out).length ? out : null;
}
