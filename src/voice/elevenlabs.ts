/**
 * The one place that talks to ElevenLabs (Bible, decision log 2026-11-20). The admin stores the API URL without a
 * version; every call here adds its own (`/v2/voices`, `/v1/...`). Errors become HttpErrors with a clear message.
 */
import { HttpError } from '../server/http.js';
import { voiceConfig } from './settings.js';
import type { VoiceSettings } from '../shared/voice.js';

export interface Subscription {
  tier: string; status: string; characterCount: number; characterLimit: number; nextResetUnix: number | null;
  voiceLimit: number; voiceSlotsUsed: number; professionalVoiceLimit: number | null; canClone: boolean;
}

export interface VoiceItem {
  voiceId: string; name: string; category: string | null; previewUrl: string | null; labels: Record<string, string>;
  description: string | null; isOwner: boolean | null;
}

export interface SharedVoiceItem {
  voiceId: string; publicOwnerId: string; name: string; category: string | null; previewUrl: string | null;
  language: string | null; accent: string | null; gender: string | null; age: string | null; description: string | null;
  freeUsersAllowed: boolean | null; isAddedByUser: boolean | null;
}

export interface VoiceDetail {
  voiceId: string; name: string; category: string | null; description: string | null; previewUrl: string | null;
  samples: { sampleId: string; fileName: string; durationSecs: number | null; mimeType: string | null }[];
}

export interface Audio { data: Buffer; contentType: string; requestId: string | null; characterCost: number | null }

interface CallOptions { query?: Record<string, string | number | boolean | undefined | null>; json?: unknown; form?: FormData; timeoutMs?: number }

/** ElevenLabs answers errors as `{ detail: { status, message } }` or a validation list `{ detail: [{ msg }] }`. */
function errorOf(status: number, body: unknown, what: string): HttpError {
  const d = (body as { detail?: unknown } | null)?.detail;
  const code = typeof d === 'object' && d !== null && !Array.isArray(d) ? String((d as { status?: unknown }).status ?? '') : '';
  const msg = Array.isArray(d)
    ? d.map((x) => String((x as { msg?: unknown }).msg ?? '')).filter(Boolean).join('; ')
    : typeof d === 'object' && d !== null ? String((d as { message?: unknown }).message ?? '') : typeof d === 'string' ? d : '';
  const text = msg || `ElevenLabs answered ${status}.`;
  const lc = (code + ' ' + text).toLowerCase();
  if (lc.includes('quota') || lc.includes('credits') || lc.includes('character limit'))
    return new HttpError(402, 'voice_quota_exceeded', `The ElevenLabs plan has no characters left for this request. ${text}`, { provider: code || null });
  if (status === 401 && (lc.includes('api key') || lc.includes('api_key') || code === 'invalid_api_key' || !code))
    return new HttpError(502, 'voice_key_invalid', `ElevenLabs refused the API key. Check it in the admin area. ${text}`.trim(), { provider: code || null });
  if (lc.includes('output_format') || lc.includes('output format') || lc.includes('tier') || lc.includes('subscription') || lc.includes('plan'))
    return new HttpError(402, 'voice_plan', `The current ElevenLabs plan does not allow this (${what}). ${text}`, { provider: code || null });
  if (status === 404) return new HttpError(404, 'voice_not_found', `ElevenLabs could not find it (${what}). ${text}`, { provider: code || null });
  if (status === 429) return new HttpError(429, 'voice_busy', `ElevenLabs is busy or the request limit was reached; try again shortly. ${text}`, { provider: code || null });
  if (status === 422 || status === 400) return new HttpError(400, 'voice_invalid', `ElevenLabs did not accept the request (${what}): ${text}`, { provider: code || null });
  return new HttpError(502, 'voice_service_error', `ElevenLabs failed (${what}): ${text}`, { provider: code || null });
}

export class ElevenLabs {
  constructor(private apiUrl: string, private key: string) {}

  private async call(method: string, path: string, what: string, o: CallOptions = {}): Promise<Response> {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { 'xi-api-key': this.key, ...(o.json !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: o.form ?? (o.json !== undefined ? JSON.stringify(o.json) : undefined),
        signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      });
    } catch (e) {
      const timeout = (e as Error).name === 'TimeoutError';
      throw new HttpError(504, timeout ? 'voice_timeout' : 'voice_unreachable', timeout ? `ElevenLabs took too long (${what}).` : `ElevenLabs could not be reached at ${this.apiUrl} (${what}).`);
    }
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      throw errorOf(res.status, body, what);
    }
    return res;
  }

  private async json<T>(method: string, path: string, what: string, o?: CallOptions): Promise<T> {
    return (await (await this.call(method, path, what, o)).json()) as T;
  }

  private async audio(path: string, what: string, o: CallOptions): Promise<Audio> {
    const res = await this.call('POST', path, what, o);
    const cost = res.headers.get('character-cost') ?? res.headers.get('x-character-count');
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      requestId: res.headers.get('request-id') ?? res.headers.get('x-request-id'),
      characterCost: cost !== null && Number.isFinite(Number(cost)) ? Number(cost) : null,
    };
  }

  async subscription(): Promise<Subscription> {
    const s = await this.json<Record<string, any>>('GET', '/v1/user/subscription', 'reading the plan');
    return {
      tier: String(s.tier ?? ''), status: String(s.status ?? ''), characterCount: Number(s.character_count ?? 0), characterLimit: Number(s.character_limit ?? 0),
      nextResetUnix: s.next_character_count_reset_unix ?? null, voiceLimit: Number(s.voice_limit ?? 0), voiceSlotsUsed: Number(s.voice_slots_used ?? 0),
      professionalVoiceLimit: s.professional_voice_limit ?? null, canClone: !!s.can_use_instant_voice_cloning,
    };
  }

  /** The account's voices (built-in, cloned, added from the library). */
  async voices(o: { search?: string; language?: string; voiceIds?: string[]; pageSize?: number; nextPageToken?: string } = {}): Promise<{ voices: VoiceItem[]; nextPageToken: string | null }> {
    const url = '/v2/voices' + (o.voiceIds?.length ? '?' + o.voiceIds.map((v) => 'voice_ids=' + encodeURIComponent(v)).join('&') : '');
    const r = await this.json<Record<string, any>>('GET', url, 'listing voices', {
      query: { search: o.search, language: o.language, page_size: o.pageSize ?? 100, next_page_token: o.nextPageToken, include_total_count: false },
    });
    return {
      voices: (r.voices ?? []).map((v: Record<string, any>): VoiceItem => ({
        voiceId: v.voice_id, name: v.name ?? '', category: v.category ?? null, previewUrl: v.preview_url ?? null, labels: v.labels ?? {},
        description: v.description ?? null, isOwner: v.is_owner ?? null,
      })),
      nextPageToken: r.has_more ? r.next_page_token ?? null : null,
    };
  }

  /** The public Voice Library. */
  async sharedVoices(o: { language?: string; search?: string; page?: number; pageSize?: number }): Promise<{ voices: SharedVoiceItem[]; hasMore: boolean }> {
    const r = await this.json<Record<string, any>>('GET', '/v1/shared-voices', 'searching the Voice Library', {
      query: { language: o.language, search: o.search, page: o.page ?? 0, page_size: o.pageSize ?? 30 },
    });
    return {
      voices: (r.voices ?? []).map((v: Record<string, any>): SharedVoiceItem => ({
        voiceId: v.voice_id, publicOwnerId: v.public_owner_id, name: v.name ?? '', category: v.category ?? null, previewUrl: v.preview_url ?? null,
        language: v.language ?? null, accent: v.accent ?? null, gender: v.gender ?? null, age: v.age ?? null, description: v.description ?? null,
        freeUsersAllowed: v.free_users_allowed ?? null, isAddedByUser: v.is_added_by_user ?? null,
      })),
      hasMore: !!r.has_more,
    };
  }

  /** Adds a public voice to the account under a new name; returns its voice ID in the account. */
  async addShared(publicOwnerId: string, voiceId: string, name: string): Promise<string> {
    const r = await this.json<{ voice_id: string }>('POST', `/v1/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`, 'adding a library voice', { json: { new_name: name } });
    return r.voice_id;
  }

  async rename(voiceId: string, name: string): Promise<void> {
    const form = new FormData();
    form.set('name', name);
    await this.call('POST', `/v1/voices/${encodeURIComponent(voiceId)}/edit`, 'renaming a voice', { form });
  }

  /** One voice with its samples (a clone keeps the recordings it was made from). */
  async voice(voiceId: string): Promise<VoiceDetail> {
    const v = await this.json<Record<string, any>>('GET', `/v1/voices/${encodeURIComponent(voiceId)}`, 'reading a voice');
    return {
      voiceId: v.voice_id, name: v.name ?? '', category: v.category ?? null, description: v.description ?? null, previewUrl: v.preview_url ?? null,
      samples: (v.samples ?? []).map((x: Record<string, any>) => ({ sampleId: x.sample_id, fileName: x.file_name ?? '', durationSecs: x.duration_secs ?? null, mimeType: x.mime_type ?? null })),
    };
  }

  /** Renames a voice, changes its description and/or adds samples (the name is always sent; the API requires it). */
  async edit(voiceId: string, o: { name: string; description?: string | null; files?: { name: string; data: Uint8Array; type: string }[]; removeNoise?: boolean }): Promise<void> {
    const form = new FormData();
    form.set('name', o.name);
    if (o.description !== undefined) form.set('description', o.description ?? '');
    for (const f of o.files ?? []) form.append('files', new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
    if (o.removeNoise) form.set('remove_background_noise', 'true');
    await this.call('POST', `/v1/voices/${encodeURIComponent(voiceId)}/edit`, 'editing a voice', { form, timeoutMs: 180_000 });
  }

  async deleteVoice(voiceId: string): Promise<void> {
    await this.call('DELETE', `/v1/voices/${encodeURIComponent(voiceId)}`, 'removing a voice');
  }

  async deleteSample(voiceId: string, sampleId: string): Promise<void> {
    await this.call('DELETE', `/v1/voices/${encodeURIComponent(voiceId)}/samples/${encodeURIComponent(sampleId)}`, 'removing a sample');
  }

  /** The audio of a sample (playing it costs nothing). */
  async sampleAudio(voiceId: string, sampleId: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await this.call('GET', `/v1/voices/${encodeURIComponent(voiceId)}/samples/${encodeURIComponent(sampleId)}/audio`, 'reading a sample');
    return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'audio/mpeg' };
  }

  /** Instant voice cloning. */
  async clone(name: string, files: { name: string; data: Uint8Array; type: string }[], o: { removeNoise?: boolean; description?: string | null }): Promise<{ voiceId: string; requiresVerification: boolean }> {
    const form = new FormData();
    form.set('name', name);
    for (const f of files) form.append('files', new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
    if (o.removeNoise) form.set('remove_background_noise', 'true');
    if (o.description) form.set('description', o.description);
    const r = await this.json<{ voice_id: string; requires_verification?: boolean }>('POST', '/v1/voices/add', 'cloning a voice', { form, timeoutMs: 180_000 });
    return { voiceId: r.voice_id, requiresVerification: !!r.requires_verification };
  }

  async speech(voiceId: string, body: { text: string; modelId: string; languageCode?: string | null; settings?: VoiceSettings | null; previousText?: string | null; nextText?: string | null }, outputFormat: string): Promise<Audio> {
    return this.audio(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, 'generating speech', {
      query: { output_format: outputFormat },
      json: {
        text: body.text, model_id: body.modelId,
        ...(body.languageCode ? { language_code: body.languageCode } : {}),
        ...(body.settings ? { voice_settings: settingsBody(body.settings) } : {}),
        ...(body.previousText ? { previous_text: body.previousText } : {}),
        ...(body.nextText ? { next_text: body.nextText } : {}),
      },
    });
  }

  async soundEffect(body: { text: string; durationSeconds: number | null; loop: boolean }, outputFormat: string): Promise<Audio> {
    return this.audio('/v1/sound-generation', 'generating a sound effect', {
      query: { output_format: outputFormat },
      json: { text: body.text, model_id: 'eleven_text_to_sound_v3', loop: body.loop, ...(body.durationSeconds ? { duration_seconds: body.durationSeconds } : {}) },
    });
  }

  async music(body: { prompt: string; lengthMs: number | null }, outputFormat: string): Promise<Audio> {
    return this.audio('/v1/music', 'composing music', {
      query: { output_format: outputFormat },
      json: { prompt: body.prompt, model_id: 'music_v2_5', ...(body.lengthMs ? { music_length_ms: body.lengthMs } : {}) },
      timeoutMs: 600_000,
    });
  }

  /** The voice changer: a recording spoken again in another voice. */
  async changeVoice(voiceId: string, audio: { name: string; data: Uint8Array; type: string }, o: { settings?: VoiceSettings | null; removeNoise?: boolean }, outputFormat: string): Promise<Audio> {
    const form = new FormData();
    form.set('audio', new Blob([new Uint8Array(audio.data)], { type: audio.type }), audio.name);
    form.set('model_id', 'eleven_multilingual_sts_v2');
    if (o.settings) form.set('voice_settings', JSON.stringify(settingsBody(o.settings)));
    if (o.removeNoise) form.set('remove_background_noise', 'true');
    return this.audio(`/v1/voice-changer/${encodeURIComponent(voiceId)}`, 'changing the voice', { query: { output_format: outputFormat }, form, timeoutMs: 300_000 });
  }
}

function settingsBody(s: VoiceSettings): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  if (typeof s.stability === 'number') out.stability = s.stability;
  if (typeof s.similarity === 'number') out.similarity_boost = s.similarity;
  if (typeof s.style === 'number') out.style = s.style;
  if (typeof s.speed === 'number') out.speed = s.speed;
  if (typeof s.speakerBoost === 'boolean') out.use_speaker_boost = s.speakerBoost;
  return out;
}

/** A client with the saved settings, or a 409 `voice_not_configured` when no key is set. */
export async function elevenLabs(): Promise<{ client: ElevenLabs; outputFormat: string; model: string }> {
  const c = await voiceConfig();
  if (!c.key) {
    throw new HttpError(409, 'voice_not_configured', c.keyUnreadable
      ? 'The saved ElevenLabs API key can no longer be read; the admin must enter it again.'
      : 'Voice features are off: no ElevenLabs API key is set in the admin area.');
  }
  return { client: new ElevenLabs(c.apiUrl, c.key), outputFormat: c.outputFormat, model: c.model };
}
