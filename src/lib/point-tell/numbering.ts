/**
 * Point and tell: the numbers people see. Every mark has an internal number that is never reused, but the numbers on
 * the badges, in the list and in the copied brief count the marks that are lines of the brief (all but the mark that
 * drew a page, which is the brief's own page line), from 1, without gaps, in the order the marks were made.
 */
import { isPageMark } from './drafts';
import type { PtMark } from './types';

/** The shown number of each mark by its internal number. A mark that drew a page has none. */
export function shownNumbers(marks: readonly Pick<PtMark, 'n' | 'meaning'>[]): Map<number, number> {
  const out = new Map<number, number>();
  let k = 0;
  for (const m of marks) if (!isPageMark(m)) out.set(m.n, ++k);
  return out;
}
