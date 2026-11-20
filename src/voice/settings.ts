import { eq } from 'drizzle-orm';
import { withDb } from '../db/client.js';
import { project } from '../db/schema.js';
import { decryptSecret, getSetting } from '../settings/settings.js';
import { DEFAULT_API_URL, DEFAULT_OUTPUT_FORMAT, DEFAULT_SPEECH_MODEL, isOutputFormat } from '../shared/voice.js';

/**
 * The ElevenLabs settings the administrator edits in the app (the API URL and the key); environment variables of the
 * same name are the fallback. The speech model and the output format belong to each media project (Bible, decision log
 * 2026-11-20): see `projectVoiceSettings`.
 */
export const ELEVENLABS_API_URL = 'ELEVENLABS_API_URL';
export const ELEVENLABS_API_KEY = 'ELEVENLABS_API_KEY';

type Source = 'app' | 'env' | null;

export interface VoiceConfig {
  apiUrl: string;
  key: string | null;
  source: { apiUrl: Source; key: Source };
  /** A key is saved but cannot be read (SESSION_SECRET changed). */
  keyUnreadable: boolean;
}

/** Saved settings first, the environment second, then the defaults. */
export async function voiceConfig(): Promise<VoiceConfig> {
  const [url, key] = await withDb(async (db) => [await getSetting(db, ELEVENLABS_API_URL), await getSetting(db, ELEVENLABS_API_KEY)]);
  const env = (n: string) => process.env[n]?.trim() || null;
  const savedKey = key === null ? null : decryptSecret(key);
  const pick = (app: string | null, name: string): { v: string | null; s: Source } => {
    const a = app?.trim() || null;
    if (a !== null) return { v: a, s: 'app' };
    const e = env(name);
    return e !== null ? { v: e, s: 'env' } : { v: null, s: null };
  };
  const u = pick(url, ELEVENLABS_API_URL), k = pick(savedKey, ELEVENLABS_API_KEY);
  return {
    apiUrl: (u.v ?? DEFAULT_API_URL).replace(/\/+$/, ''),
    key: k.v,
    source: { apiUrl: u.s, key: k.s },
    keyUnreadable: key !== null && savedKey === null,
  };
}

export interface ProjectVoiceSettings {
  /** What generation uses: the project's choice, or the default. */
  model: string; outputFormat: string;
  /** The project's own choices (null: the default is used). */
  own: { model: string | null; outputFormat: string | null };
}

/** A media project's speech model and output format. */
export async function projectVoiceSettings(projectId: string): Promise<ProjectVoiceSettings> {
  const r = await withDb(async (db) => (await db.select({ m: project.voiceModel, f: project.voiceOutputFormat }).from(project).where(eq(project.id, projectId)).limit(1))[0]);
  const model = r?.m ?? null, format = r?.f && isOutputFormat(r.f) ? r.f : null;
  return { model: model ?? DEFAULT_SPEECH_MODEL, outputFormat: format ?? DEFAULT_OUTPUT_FORMAT, own: { model, outputFormat: format } };
}
