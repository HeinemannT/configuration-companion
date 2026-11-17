/**
 * The code save of the Extended Code editor and the Studio: check, write,
 * read back (lib/save-check.ts).
 *
 *  1. One read of the properties about to be written (STUDIO_FETCH_CODE, the
 *     same text read the editor opened them with) is compared with the opened
 *     values. Changed: the user picks Review, Overwrite or Cancel. The read
 *     failed: Save anyway or Cancel. Nothing is written before the choice.
 *  2. Each property is written as today (SAVE_PROPERTY, byte for byte).
 *  3. One read-back of the written properties: "saved" only when BMP stores
 *     what was sent; a lost answer becomes "saved after all", "not saved" or
 *     "could not check". A write is never repeated automatically.
 *
 * No DOM except `conflictBody`, no chrome.*: the caller supplies the port.
 */

import { h } from '../lib/dom';
import {
  checkCodeBase, outcomeAfterReread, CHANGED_IN_BMP,
  type BaseCheck, type UnknownOutcome, type ValueChange,
} from '../lib/save-check';
import { codeSummary } from '../lib/line-diff';
import { renderLineDiff } from '../lib/line-diff';

export type CodeFetchResult = { ok: true; code: Record<string, string> } | { ok: false; error: string };

export interface CodeWriteAnswer {
  ok: boolean;
  error?: string;
  notSent?: boolean;
  outcomeUnknown?: boolean;
}

export type ConflictDecision = 'review' | 'overwrite' | 'cancel';

export interface CodeSavePort {
  /** Read the stored text of `props` (STUDIO_FETCH_CODE). */
  fetch(props: string[]): Promise<CodeFetchResult>;
  /** Write one property (SAVE_PROPERTY). `undefined`: no answer arrived. */
  write(prop: string, value: string): Promise<CodeWriteAnswer | undefined>;
  /** Ask the user. For an unreadable check only 'overwrite' (Save anyway)
   *  and 'cancel' are offered. */
  decide(check: Exclude<BaseCheck, { state: 'unchanged' }>): Promise<ConflictDecision>;
  /** Pause before the re-read when an answer was lost (a commit may still be
   *  running on the server). Default: 2 s. */
  pause?(ms: number): Promise<void>;
}

/** Pause before re-reading after a lost answer (see ControllerOptions in the
 *  object window: a commit can outlast the broken-off answer). */
export const UNKNOWN_REREAD_DELAY_MS = 2000;

export type PropOutcome =
  | { prop: string; kind: 'saved'; stored: string }
  | { prop: string; kind: 'stored-differs'; stored: string }
  | { prop: string; kind: 'saved-unverified'; error: string }
  | { prop: string; kind: 'failed'; error: string }
  | { prop: string; kind: 'unknown'; outcome: UnknownOutcome; stored?: string };

export type CodeSaveResult =
  | { kind: 'cancelled'; check: Exclude<BaseCheck, { state: 'unchanged' }> }
  | { kind: 'review'; changes: ValueChange[]; current: Record<string, string> }
  | { kind: 'done'; props: PropOutcome[]; checked: boolean };

/** Run a code save of one object. `values`: per property, the value to write
 *  and the value it was opened with. */
export async function runCodeSave(
  values: Readonly<Record<string, { value: string; opened: string }>>,
  port: CodeSavePort,
): Promise<CodeSaveResult> {
  const props = Object.keys(values);
  const opened = Object.fromEntries(props.map(p => [p, values[p].opened]));
  const check = await checkCodeBase(list => port.fetch(list), opened);
  if (check.state !== 'unchanged') {
    const decision = await port.decide(check.state === 'changed'
      ? { state: 'changed', changes: check.changes }
      : { state: 'unreadable', error: check.error });
    if (decision === 'review' && check.state === 'changed') {
      return { kind: 'review', changes: check.changes, current: Object.fromEntries(check.changes.map(c => [c.prop, c.current])) };
    }
    if (decision !== 'overwrite') {
      return { kind: 'cancelled', check: check.state === 'changed' ? { state: 'changed', changes: check.changes } : { state: 'unreadable', error: check.error } };
    }
  }

  const outcomes: PropOutcome[] = [];
  const written: string[] = [];
  const unknown: string[] = [];
  for (const prop of props) {
    let answer: CodeWriteAnswer | undefined;
    try {
      answer = await port.write(prop, values[prop].value);
    } catch {
      answer = undefined;
    }
    if (!answer || answer.outcomeUnknown) unknown.push(prop);
    else if (answer.ok) written.push(prop);
    else outcomes.push({ prop, kind: 'failed', error: answer.error ?? 'Save failed' });
  }

  const toRead = [...written, ...unknown];
  if (unknown.length) {
    await (port.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(UNKNOWN_REREAD_DELAY_MS);
  }
  if (toRead.length) {
    let back: CodeFetchResult;
    try {
      back = await port.fetch(toRead);
    } catch (e) {
      back = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    for (const prop of written) {
      if (!back.ok) { outcomes.push({ prop, kind: 'saved-unverified', error: back.error }); continue; }
      const stored = back.code[prop] ?? '';
      outcomes.push(stored === values[prop].value ? { prop, kind: 'saved', stored } : { prop, kind: 'stored-differs', stored });
    }
    for (const prop of unknown) {
      const stored = back.ok ? back.code[prop] ?? '' : undefined;
      outcomes.push({ prop, kind: 'unknown', outcome: outcomeAfterReread(values[prop].value, stored), ...(stored !== undefined ? { stored } : {}) });
    }
  }
  outcomes.sort((a, b) => props.indexOf(a.prop) - props.indexOf(b.prop));
  return { kind: 'done', props: outcomes, checked: check.state === 'unchanged' };
}

/** Body of the changed-in-BMP dialog for code: per property the BMP change
 *  since it was opened as a line diff, and the size of the user's edit. */
export function conflictBody(
  check: Exclude<BaseCheck, { state: 'unchanged' }>,
  yours: (prop: string) => string | undefined,
): Node[] {
  if (check.state === 'unreadable') {
    return [h('div', null, `Could not check whether it ${CHANGED_IN_BMP}: ${check.error}`)];
  }
  return [
    h('div', null, 'Nothing was written. Review loads the current BMP value into the comparison and keeps your edit.'),
    h('div', { class: 'crev-modal-diff-list' }, ...check.changes.map(c => {
      const mine = yours(c.prop);
      return h('div', { class: 'crev-modal-diff-row ow-review-code' },
        h('span', { class: 'crev-modal-diff-key' }, `${c.prop} · changed in BMP`),
        h('span', { class: 'ow-review-code-sum' },
          `In BMP now: ${codeSummary(c.opened, c.current)}${mine !== undefined ? ` · yours: ${codeSummary(c.opened, mine)}` : ''}`),
        renderLineDiff(c.opened, c.current),
        ...(mine !== undefined ? [
          h('span', { class: 'ow-review-code-sum' }, 'Overwrite writes yours over the BMP value:'),
          renderLineDiff(c.current, mine),
        ] : []));
    })),
  ];
}

/** Choices of the dialog (choiceModal), by check state. */
export function conflictChoices(check: Exclude<BaseCheck, { state: 'unchanged' }>): Array<{ id: 'review' | 'overwrite'; label: string; variant?: 'danger' }> {
  return check.state === 'changed'
    ? [{ id: 'review', label: 'Review' }, { id: 'overwrite', label: 'Overwrite', variant: 'danger' }]
    : [{ id: 'overwrite', label: 'Save anyway', variant: 'danger' }];
}

export function conflictTitle(check: Exclude<BaseCheck, { state: 'unchanged' }>, prop: string): string {
  return check.state === 'changed' ? `${prop} ${CHANGED_IN_BMP}` : 'Could not check for changes in BMP';
}

/** The editor's line for an Execute (a transactional run) or Preview answer. */
export function executeOutcome(
  response: { type: string; ok?: boolean; log?: string; error?: string; outcomeUnknown?: boolean } | undefined,
  transactional: boolean,
): { ok: boolean; text: string; failed: boolean } {
  if (response?.type !== 'EC_RESULT') {
    return transactional
      ? { ok: false, failed: false, text: 'No answer from BMP. The run may have been applied; look in BMP before running it again.' }
      : { ok: false, failed: true, text: 'No response from service worker' };
  }
  if (response.ok !== false) return { ok: true, failed: false, text: response.log ?? 'No output' };
  if (transactional && response.outcomeUnknown) {
    return { ok: false, failed: false, text: `No answer from BMP. The run may have been applied; look in BMP before running it again. (${response.error ?? 'no answer'})` };
  }
  return { ok: false, failed: true, text: response.error ?? response.log ?? 'Execution failed' };
}
