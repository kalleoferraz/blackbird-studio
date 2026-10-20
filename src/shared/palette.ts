/**
 * The colour palette for characters and lanes (Bible, section 12; structure decided 2026-10-20):
 * six hues, each in a brighter and a darker tone, plus white and black. Black is the Narrator's default
 * and is drawn outlined on the dark interface. The exact values are a first proposal, still to be checked
 * for contrast and colour-blind readability.
 */
export interface PaletteColour {
  name: string;
  hex: string;
}

export const PALETTE: readonly PaletteColour[] = [
  { name: 'Red', hex: '#F2605C' },
  { name: 'Blue', hex: '#6FA8FF' },
  { name: 'Yellow', hex: '#FFE14D' },
  { name: 'Purple', hex: '#B98CFF' },
  { name: 'Orange', hex: '#FF9A3D' },
  { name: 'Green', hex: '#6FD58A' },
  { name: 'Dark red', hex: '#B02A2A' },
  { name: 'Dark blue', hex: '#2D5FC4' },
  { name: 'Dark yellow', hex: '#C9A400' },
  { name: 'Dark purple', hex: '#7A3FB5' },
  { name: 'Dark orange', hex: '#C4600A' },
  { name: 'Dark green', hex: '#2F8F4E' },
  { name: 'White', hex: '#F2EDE8' },
  { name: 'Black', hex: '#000000' },
];

export const NARRATOR_COLOUR = '#000000';

export const COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** The first palette colour that no character uses yet; when all are used, starts over from the first. */
export function nextColour(used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  // Black is reserved for the Narrator, so it is never handed out automatically.
  const free = PALETTE.find((c) => c.hex !== NARRATOR_COLOUR && !taken.has(c.hex.toLowerCase()));
  return (free ?? PALETTE[0]!).hex;
}
