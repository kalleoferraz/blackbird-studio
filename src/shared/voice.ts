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

/**
 * The filters of the two voice lists, by the API's parameter names (ElevenLabs docs, Nov 2026). `values` are the
 * documented choices; for traits the docs give no list, `suggest` offers common values and any text is allowed.
 */
export type FilterKind = 'enum' | 'enum-list' | 'text' | 'text-list' | 'bool' | 'int';
export interface FilterDef { key: string; label: string; kind: FilterKind; values?: string[]; suggest?: string[]; group: 'quality' | 'voice' | 'use' | 'sort' | 'more'; max?: number }

const TRAITS: FilterDef[] = [
  { key: 'gender', label: 'Gender', kind: 'text', suggest: ['male', 'female', 'neutral'], group: 'voice' },
  { key: 'age', label: 'Age', kind: 'text', suggest: ['young', 'middle_aged', 'old'], group: 'voice' },
  { key: 'accent', label: 'Accent', kind: 'text', suggest: ['american', 'british', 'australian', 'brazilian', 'portuguese', 'german', 'spanish', 'mexican'], group: 'voice' },
];
const USE_CASES = ['narrative_story', 'conversational', 'characters_animation', 'social_media', 'entertainment_tv', 'advertisement', 'informative_educational'];

export const ACCOUNT_FILTERS: FilterDef[] = [
  { key: 'high_quality', label: 'Studio quality only', kind: 'bool', group: 'quality' },
  ...TRAITS,
  { key: 'use_cases', label: 'Use cases', kind: 'text-list', suggest: USE_CASES, group: 'use' },
  { key: 'sort', label: 'Sort by', kind: 'enum', values: ['name', 'created_at_unix'], group: 'sort' },
  { key: 'sort_direction', label: 'Direction', kind: 'enum', values: ['asc', 'desc'], group: 'sort' },
  { key: 'voice_type', label: 'Voice type', kind: 'enum', values: ['personal', 'community', 'default', 'workspace', 'non-default', 'non-community', 'saved'], group: 'more' },
  { key: 'category', label: 'Category', kind: 'enum', values: ['premade', 'cloned', 'generated', 'professional'], group: 'more' },
  { key: 'fine_tuning_state', label: 'Fine-tuning (professional clones)', kind: 'enum', values: ['draft', 'not_verified', 'not_started', 'queued', 'fine_tuning', 'fine_tuned', 'failed', 'delayed'], group: 'more' },
  { key: 'min_notice_period_days', label: 'Minimum notice period (days)', kind: 'int', max: 3650, group: 'more' },
  { key: 'include_custom_rates', label: 'Include voices with custom rates', kind: 'bool', group: 'more' },
  { key: 'include_live_moderated', label: 'Include live-moderated voices', kind: 'bool', group: 'more' },
];

export const PUBLIC_FILTERS: FilterDef[] = [
  { key: 'category', label: 'Quality', kind: 'enum', values: ['high_quality', 'professional', 'famous'], group: 'quality' },
  { key: 'featured', label: 'Featured only', kind: 'bool', group: 'quality' },
  ...TRAITS,
  { key: 'locale', label: 'Locale', kind: 'text', suggest: ['pt-BR', 'pt-PT', 'en-US', 'en-GB', 'de-DE', 'es-ES', 'es-MX'], group: 'voice' },
  { key: 'descriptives', label: 'Descriptions', kind: 'text-list', suggest: ['calm', 'warm', 'deep', 'raspy', 'soft', 'confident', 'upbeat', 'professional'], group: 'voice' },
  { key: 'use_cases', label: 'Use cases', kind: 'text-list', suggest: USE_CASES, group: 'use' },
  { key: 'sort', label: 'Sort by', kind: 'enum', values: ['created_date', 'usage_character_count_1y', 'trending', 'cloned_by_count'], group: 'sort' },
  { key: 'reader_app_enabled', label: 'Enabled in the Reader app', kind: 'bool', group: 'more' },
  { key: 'min_notice_period_days', label: 'Minimum notice period (days)', kind: 'int', max: 3650, group: 'more' },
  { key: 'owner_id', label: 'Owner ID', kind: 'text', group: 'more' },
  { key: 'include_custom_rates', label: 'Include voices with custom rates', kind: 'bool', group: 'more' },
  { key: 'include_live_moderated', label: 'Include live-moderated voices', kind: 'bool', group: 'more' },
];

/** Readable names for the API's values. */
export const FILTER_VALUE_LABEL: Record<string, string> = {
  name: 'Name', created_at_unix: 'Newest', asc: 'Ascending', desc: 'Descending', created_date: 'Newest', usage_character_count_1y: 'Most used (1 year)',
  trending: 'Trending', cloned_by_count: 'Most cloned', high_quality: 'High quality', professional: 'Professional', famous: 'Famous',
  premade: 'Built-in', cloned: 'Cloned', generated: 'Designed', personal: 'Mine', community: 'Community', default: 'Default', workspace: 'Workspace',
  'non-default': 'Not built-in', 'non-community': 'Not community', saved: 'Saved', middle_aged: 'middle aged',
};
