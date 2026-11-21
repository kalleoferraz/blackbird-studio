// Voice generation without a database: text preparation, PCM wrapping, settings checks, and the ElevenLabs client
// against a local fake server (paths with their versions, the key header, bodies and error messages).
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { audioTags, pcmToWav, spokenText } from '../src/voice/generate.js';
import { parseVoiceSettings, voiceName } from '../src/voice/character-voice.js';
import { ElevenLabs } from '../src/voice/elevenlabs.js';
import { firstSeconds, parseVoiceFilters } from '../src/server/voices.js';
import { ACCOUNT_FILTERS, PUBLIC_FILTERS } from '../src/shared/voice.js';
import { parseSfxSettings } from '../src/voice/sfx.js';
import { parseWav } from '../src/audio/wav.js';
import { HttpError } from '../src/server/http.js';

describe('voice text', () => {
  it('turns directions into audio tags', () => {
    assert.equal(audioTags('calm, warm', 'nervous'), '[calm] [warm] [nervous]');
    assert.equal(audioTags('[whispers] [sad]', null, ''), '[whispers] [sad]');
    assert.equal(audioTags(null, undefined), '');
  });
  it('removes Markdown and the leading dash of dialogue', () => {
    assert.equal(spokenText('— **Come** in.'), 'Come in.');
    assert.equal(spokenText('  '), '');
  });
  it('names voices "Character (Project)" within 100 characters', () => {
    assert.equal(voiceName('Marta', 'Enredo'), 'Marta (Enredo)');
    assert.equal(voiceName('Marta', 'Enredo', ' · unused'), 'Marta (Enredo) · unused');
    assert.equal(voiceName('x'.repeat(120), 'P').length, 100);
  });
  it('checks voice settings', () => {
    assert.deepEqual(parseVoiceSettings({ stability: 0.333, speed: 1.1, speakerBoost: false, style: null }), { stability: 0.33, speed: 1.1, speakerBoost: false });
    assert.equal(parseVoiceSettings({}), null);
    assert.throws(() => parseVoiceSettings({ speed: 2 }), HttpError);
  });
});

describe('sample text', () => {
  it('keeps the first few seconds of a cue', () => {
    assert.equal(firstSeconds('Short line.'), 'Short line.');
    const long = 'Era uma vez uma menina que morava perto do rio. Todas as manhãs ela descia a colina para ver os barcos passarem devagar.';
    assert.equal(firstSeconds(long), 'Era uma vez uma menina que morava perto do rio.');
    const run = 'palavra '.repeat(30);
    const cut = firstSeconds(run);
    assert.ok(cut.length <= 91 && cut.endsWith('palavra…'), cut);
  });
});

describe('sound-effect settings', () => {
  it('accepts the settings the API takes and refuses others', () => {
    assert.deepEqual(parseSfxSettings({ prompt: ' door slam ', durationMs: 2500, loop: false, promptInfluence: 0.333, model: 'eleven_text_to_sound_v3' }),
      { prompt: 'door slam', durationMs: 2500, loop: false, promptInfluence: 0.33, model: 'eleven_text_to_sound_v3' });
    assert.equal(parseSfxSettings({ prompt: 'rain', durationMs: null, loop: true, promptInfluence: 1, model: 'eleven_text_to_sound_v2' }).durationMs, null);
    assert.throws(() => parseSfxSettings({ prompt: 'x', durationMs: 31000, loop: false, promptInfluence: 0.3, model: 'eleven_text_to_sound_v3' }), HttpError);
    assert.throws(() => parseSfxSettings({ prompt: '', durationMs: null, loop: false, promptInfluence: 0.3, model: 'eleven_text_to_sound_v3' }), HttpError);
    assert.throws(() => parseSfxSettings({ prompt: 'x'.repeat(451), durationMs: null, loop: false, promptInfluence: 0.3, model: 'eleven_text_to_sound_v3' }), HttpError);
    assert.throws(() => parseSfxSettings({ prompt: 'x', durationMs: null, loop: false, promptInfluence: 2, model: 'eleven_text_to_sound_v3' }), HttpError);
  });
});

describe('pcm to wav', () => {
  it('makes a 16-bit mono WAV the pipeline reads', () => {
    const pcm = Buffer.alloc(44100 * 2); // one second of silence at 44.1 kHz
    const info = parseWav(pcmToWav(pcm, 44100));
    assert.equal(info.sampleRate, 44100);
    assert.equal(info.channels, 1);
    assert.equal(info.bitDepth, 16);
    assert.equal(Math.round(info.durationMs), 1000);
  });
});

describe('ElevenLabs client', () => {
  let server: Server;
  let base = '';
  const seen: { method: string; url: string; key: string | undefined; type: string | undefined; body: string }[] = [];
  let next: { status: number; body: unknown; headers?: Record<string, string> } = { status: 200, body: {} };
  const read = (r: IncomingMessage) => new Promise<string>((ok) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => ok(s)); });
  before(async () => {
    server = createServer(async (req, res) => {
      seen.push({ method: req.method!, url: req.url!, key: req.headers['xi-api-key'] as string | undefined, type: req.headers['content-type'], body: await read(req) });
      const n = next;
      if (Buffer.isBuffer(n.body)) { res.writeHead(n.status, { 'content-type': 'audio/mpeg', ...n.headers }); res.end(n.body); return; }
      res.writeHead(n.status, { 'content-type': 'application/json', ...n.headers }); res.end(JSON.stringify(n.body));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());
  const client = () => new ElevenLabs(base, 'k-123');

  it('reads the plan from /v1/user/subscription with the key header', async () => {
    next = { status: 200, body: { tier: 'free', status: 'free', character_count: 120, character_limit: 10000, voice_limit: 3, voice_slots_used: 1, can_use_instant_voice_cloning: false } };
    const p = await client().subscription();
    assert.equal(seen.at(-1)!.url, '/v1/user/subscription');
    assert.equal(seen.at(-1)!.key, 'k-123');
    assert.deepEqual([p.tier, p.characterLimit - p.characterCount, p.canClone], ['free', 9880, false]);
  });

  it('lists the account voices from /v2/voices', async () => {
    next = { status: 200, body: { voices: [{ voice_id: 'v1', name: 'Ana', category: 'premade', preview_url: 'https://x/p.mp3', labels: { accent: 'br' } }], has_more: false } };
    const r = await client().voices({ voiceIds: ['v1', 'v2'], search: 'an', filters: { high_quality: true, use_cases: ['a', 'b'] } });
    assert.match(seen.at(-1)!.url, /^\/v2\/voices\?high_quality=true&use_cases=a&use_cases=b&voice_ids=v1&voice_ids=v2&search=an/);
    assert.equal(r.voices[0]!.name, 'Ana');
    assert.equal(r.nextPageToken, null);
  });

  it('searches the public library by language', async () => {
    next = { status: 200, body: { voices: [{ voice_id: 'p1', public_owner_id: 'o1', name: 'Rui', free_users_allowed: false }], has_more: true } };
    const r = await client().sharedVoices({ language: 'pt', page: 2 });
    assert.match(seen.at(-1)!.url, /^\/v1\/shared-voices\?language=pt&page=2/);
    assert.equal(r.voices[0]!.freeUsersAllowed, false);
    assert.equal(r.hasMore, true);
  });

  it('sends speech with tags, settings and context, and returns the audio', async () => {
    next = { status: 200, body: Buffer.from('ID3fake'), headers: { 'request-id': 'req-9', 'character-cost': '17' } };
    const a = await client().speech('v1', { text: '[calm] Hello.', modelId: 'eleven_v4', languageCode: 'pt', settings: { stability: 0.4, similarity: 0.8, speakerBoost: true }, previousText: 'Before.', nextText: null }, 'mp3_44100_128');
    const s = seen.at(-1)!;
    assert.equal(s.url, '/v1/text-to-speech/v1?output_format=mp3_44100_128');
    assert.deepEqual(JSON.parse(s.body), { text: '[calm] Hello.', model_id: 'eleven_v4', language_code: 'pt', voice_settings: { stability: 0.4, similarity_boost: 0.8, use_speaker_boost: true }, previous_text: 'Before.' });
    assert.equal(a.data.toString(), 'ID3fake');
    assert.equal(a.requestId, 'req-9');
    assert.equal(a.characterCost, 17);
  });

  it('asks sound effects and music for their lengths', async () => {
    next = { status: 200, body: Buffer.from('x') };
    await client().soundEffect({ text: 'door slam', durationSeconds: 2.5, loop: false }, 'wav_48000');
    assert.equal(seen.at(-1)!.url, '/v1/sound-generation?output_format=wav_48000');
    assert.equal(JSON.parse(seen.at(-1)!.body).duration_seconds, 2.5);
    await client().soundEffect({ text: 'rain', durationSeconds: null, loop: true, promptInfluence: 0.7, modelId: 'eleven_text_to_sound_v2' }, 'mp3_44100_128');
    assert.deepEqual(JSON.parse(seen.at(-1)!.body), { text: 'rain', model_id: 'eleven_text_to_sound_v2', loop: true, prompt_influence: 0.7 });
    await client().music({ prompt: 'slow strings', lengthMs: 30000 }, 'pcm_44100');
    assert.equal(seen.at(-1)!.url, '/v1/music?output_format=pcm_44100');
    assert.equal(JSON.parse(seen.at(-1)!.body).music_length_ms, 30000);
  });

  it('sends files as multipart for cloning and the voice changer', async () => {
    next = { status: 200, body: { voice_id: 'c1', requires_verification: false } };
    const r = await client().clone('Marta (Enredo)', [{ name: 'a.mp3', data: new Uint8Array([1, 2, 3]), type: 'audio/mpeg' }], { removeNoise: true });
    assert.equal(seen.at(-1)!.url, '/v1/voices/add');
    assert.match(seen.at(-1)!.type ?? '', /^multipart\/form-data/);
    assert.match(seen.at(-1)!.body, /name="remove_background_noise"/);
    assert.equal(r.voiceId, 'c1');
    next = { status: 200, body: Buffer.from('y') };
    await client().changeVoice('c1', { name: 't.mp3', data: new Uint8Array([4]), type: 'audio/mpeg' }, { settings: { style: 0.2 } }, 'mp3_44100_128');
    assert.equal(seen.at(-1)!.url, '/v1/voice-changer/c1?output_format=mp3_44100_128');
    assert.match(seen.at(-1)!.body, /eleven_multilingual_sts_v2/);
  });

  it('reads, edits and removes a cloned voice and its samples', async () => {
    next = { status: 200, body: { voice_id: 'c1', name: 'Marta (Enredo)', category: 'cloned', samples: [{ sample_id: 's1', file_name: 'a.mp3', duration_secs: 12.5 }] } };
    const v = await client().voice('c1');
    assert.equal(seen.at(-1)!.url, '/v1/voices/c1');
    assert.deepEqual([v.category, v.samples[0]!.sampleId, v.samples[0]!.durationSecs], ['cloned', 's1', 12.5]);
    next = { status: 200, body: { status: 'ok' } };
    await client().edit('c1', { name: 'Marta', description: 'warm', files: [{ name: 'b.mp3', data: new Uint8Array([9]), type: 'audio/mpeg' }] });
    assert.equal(seen.at(-1)!.url, '/v1/voices/c1/edit');
    assert.match(seen.at(-1)!.body, /name="name"\r\n\r\nMarta\r\n/);
    assert.match(seen.at(-1)!.body, /name="files"; filename="b.mp3"/);
    await client().deleteSample('c1', 's1');
    assert.deepEqual([seen.at(-1)!.method, seen.at(-1)!.url], ['DELETE', '/v1/voices/c1/samples/s1']);
    await client().deleteVoice('c1');
    assert.deepEqual([seen.at(-1)!.method, seen.at(-1)!.url], ['DELETE', '/v1/voices/c1']);
    next = { status: 200, body: Buffer.from('mp3') };
    const a = await client().sampleAudio('c1', 's2');
    assert.equal(seen.at(-1)!.url, '/v1/voices/c1/samples/s2/audio');
    assert.equal(a.data.toString(), 'mp3');
  });

  it('turns ElevenLabs errors into clear messages', async () => {
    next = { status: 401, body: { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } } };
    await assert.rejects(client().subscription(), (e: HttpError) => e.code === 'voice_quota_exceeded' && e.status === 402 && /quota of 10000/.test(e.message));
    next = { status: 401, body: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } };
    await assert.rejects(client().subscription(), (e: HttpError) => e.code === 'voice_key_invalid');
    next = { status: 403, body: { detail: { status: 'output_format_not_allowed', message: 'wav_44100 requires Pro tier.' } } };
    await assert.rejects(client().speech('v1', { text: 'x', modelId: 'm' }, 'wav_44100'), (e: HttpError) => e.code === 'voice_plan' && /Pro tier/.test(e.message));
    next = { status: 422, body: { detail: [{ loc: ['body', 'text'], msg: 'field required', type: 'missing' }] } };
    await assert.rejects(client().subscription(), (e: HttpError) => e.code === 'voice_invalid' && /field required/.test(e.message));
  });

  it('reports an unreachable server', async () => {
    await assert.rejects(new ElevenLabs('http://127.0.0.1:1', 'k').subscription(), (e: HttpError) => e.code === 'voice_unreachable');
  });
});

describe('take file names', () => {
  it('cuts the text part at 30 characters and the others at 10', async () => {
    const { sanitizePart, TEXT_PART_MAX, takeKind } = await import('../src/library/storyline.js');
    assert.equal(sanitizePart('Era uma vez uma menina que morava perto do rio', TEXT_PART_MAX), 'Era uma vez uma menina que mor');
    assert.equal(sanitizePart('Marta Albuquerque'), 'Marta Albu');
    assert.deepEqual(['human-recorded', 'generated', 'voice-converted'].map(takeKind), ['R', 'G', 'G']);
  });
});

describe('voice list filters', () => {
  it('passes documented filters on and refuses the rest', () => {
    assert.deepEqual(parseVoiceFilters(JSON.stringify({ high_quality: true, gender: ' female ', use_cases: ['narrative_story', ''], sort: 'name', category: null }), ACCOUNT_FILTERS),
      { high_quality: true, gender: 'female', use_cases: ['narrative_story'], sort: 'name' });
    assert.deepEqual(parseVoiceFilters(JSON.stringify({ category: 'high_quality', featured: true, sort: 'cloned_by_count', min_notice_period_days: 7 }), PUBLIC_FILTERS),
      { category: 'high_quality', featured: true, sort: 'cloned_by_count', min_notice_period_days: 7 });
    assert.deepEqual(parseVoiceFilters(undefined, ACCOUNT_FILTERS), {});
    assert.throws(() => parseVoiceFilters(JSON.stringify({ high_quality: 'yes' }), ACCOUNT_FILTERS), HttpError);
    assert.throws(() => parseVoiceFilters(JSON.stringify({ sort: 'trending' }), ACCOUNT_FILTERS), HttpError); // a public-library sort
    assert.throws(() => parseVoiceFilters(JSON.stringify({ voice_type: 'saved' }), PUBLIC_FILTERS), HttpError); // an account-only filter
    assert.throws(() => parseVoiceFilters('{', PUBLIC_FILTERS), HttpError);
  });
});
