/**
 * The colour palette for characters and lanes (Bible, section 12; structure decided 2026-10-20):
 * 14 hues in a brighter tone, 13 of them also in a darker tone (grown from 14 to 29 colours on 2026-10-21), plus white and black. Black is the Narrator's default
 * and is drawn outlined on the dark interface. The exact values are a first proposal, still to be checked
 * for contrast and colour-blind readability.
 */
export interface PaletteColour {
  name: string;
  hex: string;
}

export const PALETTE: readonly PaletteColour[] = [
  // grouped by hue, each bright tone next to its darker one, so the picker reads red, orange, yellow, green, blue, purple, pink
  { name: 'Red', hex: '#F2605C' },
  { name: 'Dark red', hex: '#B02A2A' },
  { name: 'Orange', hex: '#FF9A3D' },
  { name: 'Dark orange', hex: '#C4600A' },
  { name: 'Peach', hex: '#FFC09F' },
  { name: 'Brown', hex: '#C08B5C' },
  { name: 'Dark brown', hex: '#8C5A32' },
  { name: 'Yellow', hex: '#FFE14D' },
  { name: 'Dark yellow', hex: '#C9A400' },
  { name: 'Lime', hex: '#C4E34F' },
  { name: 'Dark lime', hex: '#7C9A1E' },
  { name: 'Green', hex: '#6FD58A' },
  { name: 'Dark green', hex: '#2F8F4E' },
  { name: 'Teal', hex: '#3FC3A8' },
  { name: 'Dark teal', hex: '#1E8A76' },
  { name: 'Cyan', hex: '#4FD8E6' },
  { name: 'Dark cyan', hex: '#1C8FA3' },
  { name: 'Blue', hex: '#6FA8FF' },
  { name: 'Dark blue', hex: '#2D5FC4' },
  { name: 'Slate', hex: '#A3AEC2' },
  { name: 'Dark slate', hex: '#5E6B82' },
  { name: 'Purple', hex: '#B98CFF' },
  { name: 'Dark purple', hex: '#7A3FB5' },
  { name: 'Magenta', hex: '#E55CD0' },
  { name: 'Dark magenta', hex: '#A52E93' },
  { name: 'Pink', hex: '#FF8FC7' },
  { name: 'Dark pink', hex: '#C2457F' },
  // neutrals
  { name: 'White', hex: '#F2EDE8' },
  { name: 'Black', hex: '#000000' },
];

/**
 * The order in which new characters get a colour: bright tones first, then the darker ones, jumping between hues
 * so that characters created one after another differ as much as possible (the picker order is by hue instead).
 */
const HANDOUT_ORDER: readonly string[] = [
  'Red', 'Blue', 'Yellow', 'Purple', 'Orange', 'Green', 'Pink', 'Cyan', 'Lime', 'Magenta', 'Teal', 'Peach', 'Brown', 'Slate',
  'Dark red', 'Dark blue', 'Dark yellow', 'Dark purple', 'Dark orange', 'Dark green', 'Dark pink', 'Dark cyan', 'Dark lime',
  'Dark magenta', 'Dark teal', 'Dark brown', 'Dark slate', 'White',
];

export const NARRATOR_COLOUR = '#000000';

export const COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** The next colour in the handout order that no character uses yet; when all are used, starts over from the first. */
export function nextColour(used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  const byName = new Map(PALETTE.map((c) => [c.name, c.hex]));
  // Black is reserved for the Narrator, so it is never in the handout order.
  const free = HANDOUT_ORDER.map((n) => byName.get(n)!).find((hex) => !taken.has(hex.toLowerCase()));
  return free ?? byName.get(HANDOUT_ORDER[0]!)!;
}
