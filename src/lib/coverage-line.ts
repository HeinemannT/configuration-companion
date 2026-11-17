/**
 * One short sentence that says how a "nothing found" (or any) answer was
 * reached, so an empty list never reads as a fact the product cannot back.
 *
 * Every surface that states an empty answer (object window "Used by" and
 * "Calls", Browse search, the picker, Compare, code search) builds it here:
 *
 *   "Searched 3,025 objects in the copy from 13 Nov, 14:02."
 *   "Searched 3,025 objects live at 14:02."
 *   "Not searched: no code copy on this computer."  (the surface adds a "Search now" action)
 *
 * Pure; covered by tests.
 */

/** "14:02" today, "12 Nov 14:02" on another day (local time). */
export function timeOfDay(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? hm : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${hm}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "13 Nov, 14:02"; another year: "13 Nov 2025, 14:02" (local time): the
 *  time of the local code copy wherever it is named. */
export function dateTimeText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const count = (n: number): string => n.toLocaleString('en-US');
const things = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;

export type Coverage =
  /** Read from the local code copy, made or checked at `at`. */
  | { kind: 'index'; objects: number; at: number | null; noun?: [string, string]; note?: string; what?: string }
  /** Read from the server just now (or at `at`). `failed` parts could not be read. */
  | { kind: 'live'; objects: number; at?: number | null; noun?: [string, string]; failed?: number; note?: string; what?: string }
  /** Nothing was searched; `reason` says why ("no code copy on this computer"). */
  | { kind: 'not-searched'; reason: string };

/** The coverage sentence, ending with a full stop. */
export function coverageText(c: Coverage, now = Date.now()): string {
  if (c.kind === 'not-searched') return `Not searched: ${c.reason}.`;
  const [one, many] = c.noun ?? ['object', 'objects'];
  // `what`: the thing searched, when the server does not say how many ("the workspace").
  const what = c.what ?? things(c.objects, one, many);
  const note = c.note ? ` ${c.note.replace(/\.?$/, '.')}` : '';
  if (c.kind === 'index') {
    const when = c.at ? ` from ${dateTimeText(c.at, now)}` : '';
    return `Searched ${what} in the copy${when}.${note}`;
  }
  const when = c.at ? ` at ${timeOfDay(c.at, now)}` : '';
  const failed = c.failed ? ` ${things(c.failed, 'part')} could not be read.` : '';
  return `Searched ${what} live${when}.${failed}${note}`;
}

/** Label of the action a "not searched" line offers. */
export const SEARCH_NOW_LABEL = 'Search now';
