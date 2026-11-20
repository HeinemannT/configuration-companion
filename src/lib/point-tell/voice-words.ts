/**
 * Point and tell: the words of a dictation, the pure part. The browser's recogniser hands over its whole list of
 * results every time one changes (earlier phrases final, the last one still interim, and an interim word is often
 * revised by the next result). The field shows each word as its own element, so between two lists this says which
 * words are new, which were revised in place and which became final; the view then animates exactly those.
 * The first alternative of each result is the one used; the others are ignored.
 */

export interface HeardWord { text: string; final: boolean }
/** same: nothing to show. new: arrives. changed: revised in place. firm: became final. */
export type WordKind = 'same' | 'new' | 'changed' | 'firm';
export interface WordItem {
  word: HeardWord;
  /** The index of the word it continues in the previous list; null for a new one. */
  from: number | null;
  kind: WordKind;
}
export interface WordDiff {
  /** The words now, in order. */
  items: WordItem[];
  /** Indexes of previous words that are gone. */
  removed: number[];
}

/** One result of the recogniser: the text of its first alternative, and whether it is final. */
export interface HeardResult { text: string; final: boolean }

/** The words of a list of results, in order, each carrying whether its result is final. */
export function heardWords(results: readonly HeardResult[]): HeardWord[] {
  const out: HeardWord[] = [];
  for (const r of results) for (const text of r.text.split(/\s+/)) if (text) out.push({ text, final: r.final });
  return out;
}

/**
 * What changed from `prev` to `next`. Words that agree at the start or at the end of both lists are the same words
 * (a word is kept even when the words around it change); what lies between pairs up in order: a different word at the
 * same place is a revision, extra words are new or gone. A same word that is final now but was not is `firm`.
 */
export function diffWords(prev: readonly HeardWord[], next: readonly HeardWord[]): WordDiff {
  let head = 0;
  while (head < prev.length && head < next.length && prev[head].text === next[head].text) head++;
  let tail = 0;
  while (tail < prev.length - head && tail < next.length - head && prev[prev.length - 1 - tail].text === next[next.length - 1 - tail].text) tail++;
  const items: WordItem[] = [];
  const same = (from: number, word: HeardWord): WordItem => ({ word, from, kind: word.final && !prev[from].final ? 'firm' : 'same' });
  for (let i = 0; i < head; i++) items.push(same(i, next[i]));
  const midPrev = prev.length - head - tail, midNext = next.length - head - tail;
  const removed: number[] = [];
  for (let k = 0; k < Math.max(midPrev, midNext); k++) {
    if (k < midPrev && k < midNext) items.push({ word: next[head + k], from: head + k, kind: 'changed' });
    else if (k < midNext) items.push({ word: next[head + k], from: null, kind: 'new' });
    else removed.push(head + k);
  }
  for (let i = 0; i < tail; i++) items.push(same(prev.length - tail + i, next[next.length - tail + i]));
  return { items, removed };
}

/** The text of the words, after what was in the field (one space between, none when the field is empty or ends in white space). */
export function spokenText(base: string, words: readonly HeardWord[]): string {
  const said = words.map(w => w.text).join(' ');
  if (!said) return base;
  return base && !/\s$/.test(base) ? `${base} ${said}` : `${base}${said}`;
}

/** A phrase ended with this list: some word became final, or a new final word closes a sentence. */
export function phraseEnded(diff: WordDiff): boolean {
  return diff.items.some(i => i.kind === 'firm' || (i.kind === 'new' && i.word.final && /[.!?]$/.test(i.word.text)));
}

/** How many words arrived with this list (they land one after another a few milliseconds apart). */
export const arrived = (diff: WordDiff): number => diff.items.filter(i => i.kind === 'new').length;

/** The delay of the n-th word of a chunk (ms): a short stagger, never long however many arrive at once. */
export const staggerMs = (n: number, step = 45, max = 180): number => Math.min(max, Math.max(0, n) * step);

/** Whether this is a loud word: the level reached `at` and the last one was at least `gap` ms ago. */
export function loudNow(level: number, now: number, last: number, at = 0.92, gap = 700): boolean {
  return level >= at && now - last >= gap;
}
