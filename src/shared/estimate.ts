import { languageProfile, LANGUAGES } from './languages.js';

export const MIN_CUE_MS = 1000;

/** Removes Markdown marks so they do not count as speech. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/<[^>]+>/g, ' ');
}

const VOWELS = /[aeiouyáéíóúâêôãõàèìòùäöüëï]+/gi;

/** A rough syllable count: groups of vowels per word, with the usual silent final "e" in English. */
export function countSyllables(text: string, language: string): number {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let total = 0;
  for (const word of words) {
    let n = (word.match(VOWELS) ?? []).length;
    if (language.startsWith('en') && n > 1 && /[^aeiouy]e$/.test(word) && !/le$/.test(word)) n -= 1;
    total += Math.max(1, n);
  }
  return total;
}

/** What the project has learned from its recordings: speaking units and the milliseconds they took, summed over all takes. */
export interface LearnedSpeech { units: number; ms: number }

/** Weight of the language's starting rate against the recordings, in speaking units (about half a minute of speech). */
export const PRIOR_UNITS = 100;

/**
 * The length of a text in speaking units: one per syllable, and a line break counts as the syllables its pause is worth
 * (so the pause grows and shrinks with the learned rate). Markdown is stripped. Zero for an empty text.
 */
export function speechUnits(textMd: string, language: string): number {
  const profile = languageProfile(language) ?? LANGUAGES[0]!;
  const text = stripMarkdown(textMd).trim();
  if (text === '') return 0;
  const breaks = Math.max(0, text.split(/\n+/).filter((l) => l.trim() !== '').length - 1);
  return countSyllables(text, language) + (breaks * profile.msPerLineBreak) / profile.msPerSyllable;
}

/** Milliseconds per speaking unit: the language's starting rate, pulled towards what the project's recordings show. */
export function msPerUnit(language: string, learned?: LearnedSpeech | null): number {
  const profile = languageProfile(language) ?? LANGUAGES[0]!;
  if (!learned || learned.units <= 0) return profile.msPerSyllable;
  return (profile.msPerSyllable * PRIOR_UNITS + learned.ms) / (PRIOR_UNITS + learned.units);
}

/**
 * How long a speech cue takes (Bible, section 5, Cue length): speaking units times the project's rate, with Markdown
 * stripped and a minimum of one second. The rate starts as the language's and follows the project's recordings.
 */
export function estimateSpeechMs(textMd: string, language: string, learned?: LearnedSpeech | null): number {
  const units = speechUnits(textMd, language);
  if (units === 0) return MIN_CUE_MS;
  return Math.max(MIN_CUE_MS, Math.round((units * msPerUnit(language, learned)) / 10) * 10);
}
