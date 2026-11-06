// A small Markdown renderer for the cue text shown in the script (not while it is being edited): paragraphs and line breaks,
// headings, lists, quotes, and **bold**, *italic*, ~~strike~~, `code` and [links](https://…). It builds React elements, never HTML.
import type { ReactNode } from 'react';

const INLINE = /(\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|`([^`]+?)`|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;

export function inlineMd(text: string, key = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, n = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const k = `${key}${n++}`;
    if (m[2] ?? m[3]) out.push(<strong key={k}>{inlineMd((m[2] ?? m[3])!, k)}</strong>);
    else if (m[4]) out.push(<s key={k}>{inlineMd(m[4], k)}</s>);
    else if (m[5]) out.push(<code key={k}>{m[5]}</code>);
    else if (m[6] ?? m[7]) out.push(<em key={k}>{inlineMd((m[6] ?? m[7])!, k)}</em>);
    else out.push(<a key={k} href={m[9]} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{inlineMd(m[8]!, k)}</a>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const lines = (s: string, key: string): ReactNode[] =>
  s.split('\n').flatMap((l, i) => (i ? [<br key={`${key}b${i}`} />, ...inlineMd(l, `${key}${i}.`)] : inlineMd(l, `${key}${i}.`)));

/** `prefix` (the dash of a spoken line) goes in front of the first paragraph. */
export function renderMd(text: string, prefix = ''): ReactNode {
  const blocks = text.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  let first = true;
  return blocks.map((b, bi) => {
    const pre = first ? prefix : '';
    const k = `b${bi}`;
    const head = /^(#{1,3})\s+(.*)$/.exec(b);
    if (head && !b.includes('\n')) { first = false; const H = (`h${head[1]!.length + 2}`) as 'h3'; return <H key={k} className="md-h">{pre}{inlineMd(head[2]!, k)}</H>; }
    const ls = b.split('\n');
    if (ls.every((l) => /^\s*[-*+]\s+/.test(l))) { first = false; return <ul key={k}>{ls.map((l, i) => <li key={i}>{inlineMd(l.replace(/^\s*[-*+]\s+/, ''), `${k}${i}.`)}</li>)}</ul>; }
    if (ls.every((l) => /^\s*\d+[.)]\s+/.test(l))) { first = false; return <ol key={k}>{ls.map((l, i) => <li key={i}>{inlineMd(l.replace(/^\s*\d+[.)]\s+/, ''), `${k}${i}.`)}</li>)}</ol>; }
    if (ls.every((l) => /^\s*>/.test(l))) { first = false; return <blockquote key={k}>{lines(ls.map((l) => l.replace(/^\s*>\s?/, '')).join('\n'), k)}</blockquote>; }
    first = false;
    return <p key={k}>{pre}{lines(b, k)}</p>;
  });
}

/** The text without its Markdown marks, for one-line labels. */
export function plainMd(text: string): string {
  return text.replace(/^\s{0,3}(#{1,3}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '').replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '').replace(/\*([^*\s][^*]*?)\*/g, '$1').replace(/(?<![\w])_([^_\s][^_]*?)_(?![\w])/g, '$1').replace(/\s*\n+\s*/g, ' ').trim();
}
