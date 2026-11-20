import { withDb } from '../db/client.js';
import { decryptSecret, getSetting } from '../settings/settings.js';
import { DEFAULT_API_URL, DEFAULT_OUTPUT_FORMAT, DEFAULT_SPEECH_MODEL } from '../shared/voice.js';

/** The ElevenLabs settings the administrator edits in the app; environment variables of the same name are the fallback. */
export const ELEVENLABS_API_URL = 'ELEVENLABS_API_URL';
export const ELEVENLABS_API_KEY = 'ELEVENLABS_API_KEY';
export const ELEVENLABS_OUTPUT_FORMAT = 'ELEVENLABS_OUTPUT_FORMAT';
export const ELEVENLABS_MODEL = 'ELEVENLABS_MODEL';

type Source = 'app' | 'env' | null;

export interface VoiceConfig {
  apiUrl: string;
  key: string | null;
  outputFormat: string;
  model: string;
  source: { apiUrl: Source; key: Source; outputFormat: Source; model: Source };
  /** A key is saved but cannot be read (SESSION_SECRET changed). */
  keyUnreadable: boolean;
}

/** Saved settings first, the environment second, then the defaults. */
export async function voiceConfig(): Promise<VoiceConfig> {
  const [url, key, format, model] = await withDb(async (db) => [
    await getSetting(db, ELEVENLABS_API_URL), await getSetting(db, ELEVENLABS_API_KEY),
    await getSetting(db, ELEVENLABS_OUTPUT_FORMAT), await getSetting(db, ELEVENLABS_MODEL),
  ]);
  const env = (n: string) => process.env[n]?.trim() || null;
  const savedKey = key === null ? null : decryptSecret(key);
  const pick = (app: string | null, name: string): { v: string | null; s: Source } => {
    const a = app?.trim() || null;
    if (a !== null) return { v: a, s: 'app' };
    const e = env(name);
    return e !== null ? { v: e, s: 'env' } : { v: null, s: null };
  };
  const u = pick(url, ELEVENLABS_API_URL), k = pick(savedKey, ELEVENLABS_API_KEY), f = pick(format, ELEVENLABS_OUTPUT_FORMAT), m = pick(model, ELEVENLABS_MODEL);
  return {
    apiUrl: (u.v ?? DEFAULT_API_URL).replace(/\/+$/, ''),
    key: k.v,
    outputFormat: f.v ?? DEFAULT_OUTPUT_FORMAT,
    model: m.v ?? DEFAULT_SPEECH_MODEL,
    source: { apiUrl: u.s, key: k.s, outputFormat: f.s, model: m.s },
    keyUnreadable: key !== null && savedKey === null,
  };
}
