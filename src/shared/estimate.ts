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

/**
 * How long a speech cue takes (Bible, section 5, Cue length): syllables times the language's rate,
 * plus a pause for each line break, with Markdown stripped and a minimum of one second.
 */
export function estimateSpeechMs(textMd: string, language: string): number {
  const profile = languageProfile(language) ?? LANGUAGES[0]!;
  const text = stripMarkdown(textMd).trim();
  if (text === '') return MIN_CUE_MS;
  const syllables = countSyllables(text, language);
  const breaks = Math.max(0, text.split(/\n+/).filter((l) => l.trim() !== '').length - 1);
  const ms = syllables * profile.msPerSyllable + breaks * profile.msPerLineBreak;
  return Math.max(MIN_CUE_MS, Math.round(ms / 10) * 10);
}
