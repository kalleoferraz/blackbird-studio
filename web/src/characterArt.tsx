import { createContext, useContext } from 'react';
import { assetUrl } from './api.ts';
import type { Character } from './types.ts';

/** URL of the faded stand-in image for a character without a picture (the project's profile_placeholder), or null. */
export const PlaceholderContext = createContext<string | null>(null);
export const usePlaceholder = () => useContext(PlaceholderContext);

/** "Passarinho Figurante 2" -> "PF2": the first letter of every word, a number kept whole. */
export function initialsOf(name: string): string {
  return name.split(/[\s\-_]+/).map((w) => {
    if (/^\p{N}+$/u.test(w)) return w;
    const m = w.match(/[\p{L}\p{N}]/u);
    return m ? m[0].toLocaleUpperCase() : '';
  }).join('');
}

/** The initials over a picture-less character's circle (also over the faded placeholder). */
export function Initials({ name, colour }: { name: string; colour: string }) {
  const t = initialsOf(name);
  if (!t) return null;
  const n = Array.from(t).length;
  return <span className={'initials ' + (n <= 2 ? 'n2' : n === 3 ? 'n3' : 'n4')} style={{ color: colour.toLowerCase() === '#000000' ? 'var(--text)' : colour }}>{t}</span>;
}

/**
 * Beside a speech cue, on a screen wide enough to leave room at the right of the script: the character's round picture
 * and a small tail from the cue pointing at it, like a speech bubble. Whether they show and how large the circle is
 * (--face) is decided by the script column (data-faces) and styles.css.
 */
export function CueFace({ character, colour }: { character: Character; colour: string }) {
  const placeholder = usePlaceholder();
  return (
    <>
      <span className="cue-tail" style={{ background: colour }} aria-hidden />
      <span className="cue-face avatar" style={{ borderColor: colour }} title={character.name} aria-hidden>
        {character.pictureAssetId
          ? <img src={assetUrl(character.pictureAssetId, true)} alt="" />
          : <>{placeholder && <img className="placeholder-img" src={placeholder} alt="" />}<Initials name={character.name} colour={colour} /></>}
      </span>
    </>
  );
}
