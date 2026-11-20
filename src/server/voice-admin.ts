import type { FastifyInstance } from 'fastify';
import { withDb } from '../db/client.js';
import { sessionConfigured } from '../auth/session.js';
import { encryptSecret, putSetting } from '../settings/settings.js';
import { DEFAULT_API_URL } from '../shared/voice.js';
import { ElevenLabs } from '../voice/elevenlabs.js';
import { ELEVENLABS_API_KEY, ELEVENLABS_API_URL, voiceConfig } from '../voice/settings.js';
import { authenticate, requireAdmin } from './auth-routes.js';
import { HttpError, asBody } from './http.js';

const adminOnly = [authenticate(), requireAdmin];

/** A URL without a version: https, a host, no path apart from a trailing slash. */
function cleanUrl(v: string): string {
  let u: URL;
  try { u = new URL(v); } catch { throw new HttpError(400, 'invalid_apiUrl', 'The API URL is not a valid address.'); }
  if (u.protocol !== 'https:') throw new HttpError(400, 'invalid_apiUrl', 'The API URL must start with https://.');
  if (u.pathname !== '/' && u.pathname !== '') throw new HttpError(400, 'invalid_apiUrl', 'Write the API URL without a path or version, for example https://api.elevenlabs.io. The version is added by each call.');
  return u.origin;
}

/** ElevenLabs settings in the admin area: the API URL and the key (Bible, decision log 2026-11-20). The model and the output format are each project's. */
export function registerVoiceAdminRoutes(app: FastifyInstance): void {
  const view = async () => {
    const c = await voiceConfig();
    return {
      apiUrl: c.apiUrl, keySet: c.key !== null, keyUnreadable: c.keyUnreadable,
      source: c.source, canStoreKey: sessionConfigured(), defaults: { apiUrl: DEFAULT_API_URL },
    };
  };

  app.get('/api/admin/settings/voices', { preHandler: adminOnly }, async () => view());

  app.put('/api/admin/settings/voices', { preHandler: adminOnly, bodyLimit: 4096 }, async (request) => {
    const b = asBody(request.body);
    const text = (k: string, max: number) => {
      const v = b[k];
      if (v === undefined) return undefined;
      if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `invalid_${k}`, `The ${k} is not valid.`);
      return v.trim();
    };
    const apiUrl = text('apiUrl', 200), key = text('key', 500);
    const url = apiUrl ? cleanUrl(apiUrl) : apiUrl;
    if (key && !sessionConfigured()) throw new HttpError(400, 'cannot_store_key', 'The key cannot be stored: SESSION_SECRET is missing on this server.');
    await withDb(async (db) => {
      if (url !== undefined) await putSetting(db, ELEVENLABS_API_URL, url || null);
      if (b.clearKey === true) await putSetting(db, ELEVENLABS_API_KEY, null);
      else if (key) await putSetting(db, ELEVENLABS_API_KEY, encryptSecret(key));
    });
    return view();
  });

  // Reads the plan with the saved settings, or with the values in the body (not saved yet) for a test.
  app.post('/api/admin/settings/voices/test', { preHandler: adminOnly, bodyLimit: 4096 }, async (request) => {
    const b = asBody(request.body);
    const c = await voiceConfig();
    const str = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim() : null);
    const url = str('apiUrl') ? cleanUrl(str('apiUrl')!) : c.apiUrl;
    const key = str('key') ?? c.key;
    if (!key) return { ok: false, message: c.keyUnreadable ? 'The saved key can no longer be read: enter it again.' : 'No API key is set.' };
    try {
      const plan = await new ElevenLabs(url, key).subscription();
      return { ok: true, message: `Connected. Plan: ${plan.tier || 'unknown'}.`, plan };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });

  app.get('/api/admin/settings/voices/plan', { preHandler: adminOnly }, async () => {
    const c = await voiceConfig();
    if (!c.key) return { plan: null };
    return { plan: await new ElevenLabs(c.apiUrl, c.key).subscription() };
  });

  // For every signed-in user: whether the voice options in the studio are on, and why not.
  app.get('/api/voices/status', { preHandler: authenticate() }, async () => {
    const c = await voiceConfig();
    return c.key
      ? { enabled: true }
      : { enabled: false, reason: c.keyUnreadable ? 'The saved ElevenLabs API key can no longer be read; the admin must enter it again.' : 'No ElevenLabs API key is set in the admin area.' };
  });
}
