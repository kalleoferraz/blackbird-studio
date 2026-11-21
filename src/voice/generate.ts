/**
 * Generate audio for a cue (Bible, decision log 2026-11-20). "From text": speech with the character's voice,
 * a sound effect or music from the cue's text; "from take": the voice changer on one of the cue's takes.
 * This module builds and sends the request; the route stores the result as the cue's next take.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Q } from '../db/client.js';
import { asset, chapter, character, clip, cue, lane, project, scene, segment } from '../db/schema.js';
import { HttpError, badRequest } from '../server/http.js';
import { stripMarkdown } from '../shared/estimate.js';
import { MUSIC_MAX_MS, MUSIC_MIN_MS, SFX_MAX_MS, SFX_MIN_MS, type VoiceSettings } from '../shared/voice.js';
import { assetAudio } from '../server/voices.js';
import { elevenLabs, type Audio } from './elevenlabs.js';

export interface GenerateInput {
  mode: 'text' | 'take'; direction: string | null; context: boolean; sourceClipId: string | null; removeNoise: boolean;
  /** Try another voice or settings than the cue's character has saved (the Voice panel's sample): speech only. */
  override?: { voiceId: string; direction: string | null; settings: VoiceSettings | null };
}

export interface Generated {
  data: Buffer; ext: 'wav' | 'mp3'; origin: 'generated' | 'voice-converted';
  record: { kind: 'speech' | 'sfx' | 'music' | 'voice_change'; model: string; voiceId: string | null; textSent: string | null; direction: string | null;
    settings: unknown; sourceClipId: string | null; outputFormat: string; context: boolean; requestId: string | null; characterCost: number | null };
}

/** The spoken text of a cue: Markdown removed, and the leading dash of dialogue. */
export const spokenText = (md: string) => stripMarkdown(md ?? '').replace(/^\s*[—–-]\s*/, '').trim();

/** Directions written as "calm, warm" or "[calm] [warm]" become audio tags: "[calm] [warm]". */
export function audioTags(...directions: (string | null | undefined)[]): string {
  const tags: string[] = [];
  for (const d of directions) {
    if (!d?.trim()) continue;
    const bracketed = d.match(/\[[^\]]+\]/g);
    const parts = bracketed ? bracketed.map((t) => t.slice(1, -1)) : d.split(/[,;\n]+/);
    for (const p of parts) { const t = p.trim(); if (t) tags.push(`[${t}]`); }
  }
  return tags.join(' ');
}

/** PCM from ElevenLabs is raw 16-bit little-endian mono: give it a WAV header so the pipeline takes it as a master. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export function stored(a: Audio, format: string): { data: Buffer; ext: 'wav' | 'mp3' } {
  if (format.startsWith('pcm_')) return { data: pcmToWav(a.data, Number(format.split('_')[1])), ext: 'wav' };
  if (format.startsWith('wav_')) return { data: a.data, ext: 'wav' };
  return { data: a.data, ext: 'mp3' };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The speech cues just before and after this one in the segment's script order (scene, start, lane), for context. */
async function neighbours(q: Q, cueId: string, segmentId: string): Promise<{ previous: string | null; next: string | null }> {
  const rows = await q
    .select({ id: cue.id, type: cue.type, text: cue.textMd })
    .from(cue).innerJoin(scene, eq(scene.id, cue.sceneId)).innerJoin(lane, eq(lane.id, cue.laneId))
    .where(eq(scene.segmentId, segmentId))
    .orderBy(asc(scene.position), asc(cue.startMs), asc(lane.position));
  const speech = rows.filter((r) => r.type === 'speech' || r.id === cueId);
  const i = speech.findIndex((r) => r.id === cueId);
  const t = (r?: { text: string }) => (r ? spokenText(r.text) || null : null);
  return { previous: t(speech[i - 1]), next: t(speech[i + 1]) };
}

export async function generateForCue(q: Q, cueId: string, input: GenerateInput): Promise<Generated> {
  const row = (await q
    .select({ c: cue, segmentId: scene.segmentId, language: project.language, projectId: project.id })
    .from(cue).innerJoin(scene, eq(scene.id, cue.sceneId)).innerJoin(segment, eq(segment.id, scene.segmentId))
    .innerJoin(chapter, eq(chapter.id, segment.chapterId)).innerJoin(project, eq(project.id, chapter.projectId))
    .where(eq(cue.id, cueId)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found');
  const c = row.c;
  const ch = c.characterId ? (await q.select().from(character).where(eq(character.id, c.characterId)).limit(1))[0] ?? null : null;
  const { client, outputFormat, model } = await elevenLabs(row.projectId);
  const settings = input.override ? input.override.settings : (ch?.voiceSettings ?? null) as VoiceSettings | null;
  const needVoice = () => {
    if (!ch) throw new HttpError(409, 'no_character', 'This cue has no character, so there is no voice to speak it. Choose a character for the cue first.');
    if (!ch.voiceId) throw new HttpError(409, 'no_voice', `${ch.name} has no voice yet. Choose or clone one in the character's view.`);
    return ch.voiceId;
  };

  if (input.mode === 'take') {
    if (c.type !== 'speech') throw badRequest('speech_only', 'The voice changer works on speech cues only.');
    const voiceId = needVoice();
    const srcId = input.sourceClipId ?? c.clipId;
    if (!srcId) throw badRequest('no_take', 'This cue has no take to convert.');
    const src = (await q.select({ k: clip, a: asset }).from(clip).innerJoin(asset, eq(asset.id, clip.assetId))
      .where(and(eq(clip.id, srcId), eq(clip.cueId, cueId))).limit(1))[0];
    if (!src) throw badRequest('invalid_sourceClipId', 'That take is not one of this cue\'s takes.');
    if (src.a.status !== 'ready') throw new HttpError(409, 'not_ready', 'The take is still being processed.');
    const audio = await client.changeVoice(voiceId, await assetAudio(src.a), { settings, removeNoise: input.removeNoise }, outputFormat);
    return {
      ...stored(audio, outputFormat), origin: 'voice-converted',
      record: { kind: 'voice_change', model: 'eleven_multilingual_sts_v2', voiceId, textSent: null, direction: null, settings: { voice: settings, removeNoise: input.removeNoise },
        sourceClipId: src.k.id, outputFormat, context: false, requestId: audio.requestId, characterCost: audio.characterCost },
    };
  }

  const text = spokenText(c.textMd);
  if (!text) throw badRequest('no_text', c.type === 'speech' ? 'The cue has no text to speak.' : 'The cue has no description to generate from.');

  if (c.type === 'speech') {
    const voiceId = input.override?.voiceId ?? needVoice();
    const tags = audioTags(input.override ? input.override.direction : ch!.voiceDirection, input.direction);
    const sent = tags ? `${tags} ${text}` : text;
    const ctx = input.context ? await neighbours(q, cueId, row.segmentId) : { previous: null, next: null };
    const languageCode = row.language.split('-')[0]!.toLowerCase();
    const audio = await client.speech(voiceId, {
      text: sent, modelId: model, settings, previousText: ctx.previous, nextText: ctx.next,
      // Multilingual v2 does not take a language code; the newer models do.
      languageCode: model.startsWith('eleven_multilingual_v2') ? null : languageCode,
    }, outputFormat);
    return {
      ...stored(audio, outputFormat), origin: 'generated',
      record: { kind: 'speech', model, voiceId, textSent: sent, direction: input.direction, settings, sourceClipId: null, outputFormat,
        context: input.context, requestId: audio.requestId, characterCost: audio.characterCost },
    };
  }

  // Sound effects and music: the cue's description is the prompt, the typed directions are added to it.
  const prompt = input.direction?.trim() ? `${text}. ${input.direction.trim()}` : text;
  // A length set by hand is asked for; while the length follows the audio, the model chooses it.
  const wanted = c.lengthAuto ? null : c.lengthMs;
  if (c.type === 'sfx') {
    const loop = wanted !== null && wanted > SFX_MAX_MS;
    const seconds = wanted === null ? null : clamp(wanted, SFX_MIN_MS, SFX_MAX_MS) / 1000;
    const audio = await client.soundEffect({ text: prompt, durationSeconds: seconds, loop }, outputFormat);
    return {
      ...stored(audio, outputFormat), origin: 'generated',
      record: { kind: 'sfx', model: 'eleven_text_to_sound_v3', voiceId: null, textSent: prompt, direction: input.direction, settings: { durationSeconds: seconds, loop },
        sourceClipId: null, outputFormat, context: false, requestId: audio.requestId, characterCost: audio.characterCost },
    };
  }
  // Music has no WAV output: WAV is asked for as PCM and wrapped.
  const musicFormat = outputFormat.startsWith('wav_') ? 'pcm_' + outputFormat.slice(4) : outputFormat;
  const lengthMs = wanted === null ? null : clamp(wanted, MUSIC_MIN_MS, MUSIC_MAX_MS);
  const audio = await client.music({ prompt, lengthMs }, musicFormat);
  return {
    ...stored(audio, musicFormat), origin: 'generated',
    record: { kind: 'music', model: 'music_v2_5', voiceId: null, textSent: prompt, direction: input.direction, settings: { lengthMs },
      sourceClipId: null, outputFormat: musicFormat, context: false, requestId: audio.requestId, characterCost: audio.characterCost },
  };
}

// ---- takes tried in the Voice panel, waiting for ✓ (keep) or × (drop) -------------------------------------------

export interface PendingTake { id: string; userId: string; cueId: string; projectId: string; made: Generated; contentType: string; expires: number }
const pending = new Map<string, PendingTake>();
function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  while (pending.size > 40) pending.delete(pending.keys().next().value!);
}
export function holdTake(t: Omit<PendingTake, 'expires'>): void { sweep(); pending.set(t.id, { ...t, expires: Date.now() + 30 * 60_000 }); }
export function pendingTake(id: string, userId: string): PendingTake {
  sweep();
  const t = pending.get(id);
  if (!t || t.userId !== userId) throw new HttpError(404, 'take_gone', 'This take is no longer waiting (takes wait 30 minutes): play the sample again.');
  return t;
}
export const dropTake = (id: string) => pending.delete(id);
