// ElevenLabs options shared by the server and the browser (Bible, decision log 2026-11-20).

export interface OutputFormat { id: string; label: string; /** The plan the docs name for it, when they name one. */ plan?: string }

/**
 * The output formats offered in the admin. Opus, μ-law and A-law are left out: the audio pipeline cannot decode them.
 * PCM is raw 16-bit mono; the server wraps it into a WAV. Formats a plan does not cover fail when used, with a clear error.
 */
export const OUTPUT_FORMATS: OutputFormat[] = [
  { id: 'mp3_22050_32', label: 'MP3 22.05 kHz 32 kbps' },
  { id: 'mp3_24000_48', label: 'MP3 24 kHz 48 kbps' },
  { id: 'mp3_44100_32', label: 'MP3 44.1 kHz 32 kbps' },
  { id: 'mp3_44100_64', label: 'MP3 44.1 kHz 64 kbps' },
  { id: 'mp3_44100_96', label: 'MP3 44.1 kHz 96 kbps' },
  { id: 'mp3_44100_128', label: 'MP3 44.1 kHz 128 kbps' },
  { id: 'mp3_44100_192', label: 'MP3 44.1 kHz 192 kbps', plan: 'Creator' },
  ...[8000, 16000, 22050, 24000, 32000, 44100, 48000].map((r) => ({ id: `pcm_${r}`, label: `PCM ${r / 1000} kHz (stored as WAV)`, ...(r === 44100 ? { plan: 'Pro' } : {}) })),
  ...[8000, 16000, 22050, 24000, 32000, 44100, 48000].map((r) => ({ id: `wav_${r}`, label: `WAV ${r / 1000} kHz`, ...(r === 44100 ? { plan: 'Pro' } : {}) })),
];
export const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
export const isOutputFormat = (s: string) => OUTPUT_FORMATS.some((f) => f.id === s);

/** Speech models offered as suggestions; any model ID can be typed. */
export const SPEECH_MODELS = ['eleven_v4', 'eleven_v4_turbo', 'eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5'];
export const DEFAULT_SPEECH_MODEL = 'eleven_v4';
export const DEFAULT_API_URL = 'https://api.elevenlabs.io';

/** The voice settings a character can set with sliders; null leaves the voice's own value. */
export interface VoiceSettings { stability?: number | null; similarity?: number | null; style?: number | null; speed?: number | null; speakerBoost?: boolean | null }

export const SFX_MIN_MS = 500, SFX_MAX_MS = 30_000;
export const MUSIC_MIN_MS = 3_000, MUSIC_MAX_MS = 600_000;

/** Languages offered in the voice lists' filter (ISO 639-1); the project's language is added when it is missing. */
export const VOICE_LANGUAGES: { code: string; name: string }[] = [
  ['ar', 'Arabic'], ['zh', 'Chinese'], ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['en', 'English'], ['fi', 'Finnish'], ['fr', 'French'],
  ['de', 'German'], ['el', 'Greek'], ['hi', 'Hindi'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['no', 'Norwegian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'], ['es', 'Spanish'], ['sv', 'Swedish'], ['tr', 'Turkish'], ['uk', 'Ukrainian'],
].map(([code, name]) => ({ code: code!, name: name! }));
