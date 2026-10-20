/**
 * Language profiles (Bible, section 13, Project View): each language carries its flag, its name and the
 * values used to estimate how long a text takes to speak. The estimation values are starting points,
 * to be tuned against real recordings.
 */
export interface LanguageProfile {
  code: string; // BCP 47, as stored in project.language
  label: string; // shown in upper case style in the interface, such as EN-US
  name: string;
  flag: string;
  msPerSyllable: number;
  msPerLineBreak: number;
}

export const LANGUAGES: readonly LanguageProfile[] = [
  { code: 'en-US', label: 'EN-US', name: 'English (US)', flag: '🇺🇸', msPerSyllable: 200, msPerLineBreak: 400 },
  { code: 'pt-BR', label: 'PT-BR', name: 'Português (Brasil)', flag: '🇧🇷', msPerSyllable: 180, msPerLineBreak: 400 },
  { code: 'de-DE', label: 'DE-DE', name: 'Deutsch', flag: '🇩🇪', msPerSyllable: 210, msPerLineBreak: 400 },
];

export function languageProfile(code: string): LanguageProfile | undefined {
  return LANGUAGES.find((l) => l.code === code);
}
