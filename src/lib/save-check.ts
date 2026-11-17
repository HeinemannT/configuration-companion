/**
 * Save checks shared by every surface that writes a value the user saw
 * (object window, Extended Code editor, Studio, object card).
 *
 *  1. Changed since opened: before a write, the current stored values of the
 *     properties about to be written are read once (one read per object) and
 *     compared with the values the user started from. A difference holds the
 *     write until the user picks Review, Overwrite or Cancel.
 *  2. Outcome unknown: a write whose answer did not arrive (time-out, or the
 *     connection dropped after the request left) may have been applied. The
 *     surface re-reads and says "saved after all", "not saved" or "could not
 *     check". A write is never repeated automatically.
 *  3. Read-back: "Saved" is shown only when the stored value equals the value
 *     that was sent; otherwise the stored value is shown.
 *
 * Comparison: the opened value and the current value always come from the
 * same read form (the object window's binary object read, or the Extended
 * Code text read `output(_o.p.whenMissing(""))` of the editor and Studio), so
 * they are compared exactly. Missing and empty are the same value in both
 * forms (an absent property reads as ""). Booleans, numbers and references
 * are compared as the text the same parser made of them (RIDs stay strings).
 *
 * Pure: no DOM, no chrome.*.
 */

import type { BmpErrorKind } from './error-kind';

export interface ValueChange {
  prop: string;
  /** The value the user opened (the draft's base). */
  opened: string;
  /** The value BMP holds now. */
  current: string;
}

export type BaseCheck =
  | { state: 'unchanged' }
  | { state: 'changed'; changes: ValueChange[] }
  | { state: 'unreadable'; error: string };

/** Compare the opened values with a fresh read. `read(prop)` returns the
 *  current text, '' for a missing property. */
export function compareOpened(
  opened: Readonly<Record<string, string>>,
  read: (prop: string) => string,
  equal: (prop: string, a: string, b: string) => boolean = (_p, a, b) => a === b,
): BaseCheck {
  const changes: ValueChange[] = [];
  for (const [prop, value] of Object.entries(opened)) {
    const current = read(prop);
    if (!equal(prop, value, current)) changes.push({ prop, opened: value, current });
  }
  return changes.length ? { state: 'changed', changes } : { state: 'unchanged' };
}

/** Read the current code of `props` and compare it with what was opened.
 *  `fetch` is the Extended Code text read (STUDIO_FETCH_CODE). */
export async function checkCodeBase(
  fetch: (props: string[]) => Promise<{ ok: true; code: Record<string, string> } | { ok: false; error: string }>,
  opened: Readonly<Record<string, string>>,
): Promise<BaseCheck & { code?: Record<string, string> }> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(Object.keys(opened));
  } catch (e) {
    return { state: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { state: 'unreadable', error: res.error };
  const code = res.code;
  return { ...compareOpened(opened, p => code[p] ?? ''), code };
}

/** True when a failed write may still have been applied: the answer did not
 *  arrive (time-out) or the connection failed while the request was out. */
export function isOutcomeUnknown(errorKind: BmpErrorKind | undefined): boolean {
  return errorKind === 'timeout' || errorKind === 'network';
}

export type UnknownOutcome = 'saved' | 'not-saved' | 'unverified';

/** What a re-read says about a write whose answer was lost. */
export function outcomeAfterReread(sent: string, stored: string | undefined): UnknownOutcome {
  if (stored === undefined) return 'unverified';
  return stored === sent ? 'saved' : 'not-saved';
}

// ── Wording (one line per state) ─────────────────────────────────────────

export const CHANGED_IN_BMP = 'changed in BMP since you opened it';
export const MAY_HAVE_SAVED = 'No answer from BMP. The save may have been applied.';

export function unknownOutcomeLine(outcome: UnknownOutcome): string {
  switch (outcome) {
    case 'saved': return 'No answer from BMP, but the re-read shows it was saved after all.';
    case 'not-saved': return 'No answer from BMP, and the re-read shows it was not saved.';
    default: return 'No answer from BMP, and the re-read failed: could not check whether it was saved. Reload before trying again.';
  }
}

export function checkFailedLine(error: string): string {
  return `Could not check whether it ${CHANGED_IN_BMP}: ${error}`;
}

export function storedDiffersLine(label: string, stored: string): string {
  const shown = stored.length > 80 ? `${stored.slice(0, 80)}…` : stored;
  return `Saved, but BMP stores a different value for ${label}: "${shown}".`;
}
