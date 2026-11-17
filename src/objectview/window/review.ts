/**
 * Object window — content of the "Review and save" confirmation. It uses the
 * existing confirmation modal and its diff rows (components.css); rows are
 * grouped per object. A changed ID makes the confirmation stronger.
 * DOM only; no chrome.*.
 */

import { h } from '../../lib/dom';
import { displayValue } from '../../lib/property-editors';
import type { DraftItem } from './draft';
import { renderLineDiff, codeSummary } from '../../lib/line-diff';
import { refDiffLines, type RefDiff } from './reference-edit';

export interface ReviewObject {
  rid: string;
  name: string;
  /** Type label, plus "template" for the root's template. */
  kind: string;
}

/** One row of the review as data, in the order of `body`: what the dialog
 *  shows, so a view can draw it again without reading the DOM or parsing
 *  the words. */
export interface ReviewEntry {
  rid: string;
  prop: string;
  label: string;
  /** The opened and the new value in words (`to` is "template value" for a
   *  reset); empty for code, which shows a line diff instead. */
  from: string;
  to: string;
  reset?: boolean;
  code?: boolean;
  /** A list of references: the objects added and removed. The row shows
   *  these as `+ Name (ID)` / `− Name (ID)` lines instead of from → to. */
  refs?: RefDiff;
  /** A dated (Historical) reference: the change takes effect from today.
   *  Data only; the row's glyph says the property is historical. */
  dated?: boolean;
  /** The server's last refusal of this property. */
  problem?: string;
}

export interface ReviewContent {
  title: string;
  body: Node[];
  confirmLabel: string;
  confirmVariant: 'success' | 'danger';
  changesId: boolean;
  /** The rows of `body` as data. */
  entries: ReviewEntry[];
}

/** Facts of a row beyond its words: a list-of-references diff and the
 *  dated note. */
export interface ReviewDetail {
  refs?: RefDiff;
  dated?: boolean;
}

function short(v: string): string {
  const d = displayValue(v);
  return d.length > 80 ? `${d.slice(0, 80)}…` : d;
}

export function buildReview(
  items: readonly DraftItem[],
  object: (rid: string) => ReviewObject,
  label: (rid: string, prop: string) => string,
  isCode: (rid: string, prop: string) => boolean,
  /** A value in words (custom properties: item names, On/Off, "Not set");
   *  undefined keeps the raw text. */
  display: (rid: string, prop: string, value: string) => string | undefined = () => undefined,
  /** The last refusal of this property by the server, shown under its row. */
  problem: (rid: string, prop: string) => string | undefined = () => undefined,
  /** A list-of-references diff, the dated note (reference rows). */
  detail: (rid: string, prop: string) => ReviewDetail | undefined = () => undefined,
): ReviewContent {
  const entries: ReviewEntry[] = [];
  const groups = new Map<string, DraftItem[]>();
  for (const it of items) groups.set(it.rid, [...(groups.get(it.rid) ?? []), it]);
  const changesId = items.some(it => it.prop === 'id' && it.entry.kind === 'value');
  const n = items.length;
  const lists: Node[] = [];
  for (const [rid, list] of groups) {
    const o = object(rid);
    lists.push(h('div', { class: 'ow-review-obj' },
      h('span', { class: 'ow-review-name' }, o.name || '(unnamed)'),
      h('span', { class: 'ow-review-kind' }, o.kind)));
    lists.push(h('div', { class: 'crev-modal-diff-list' }, ...list.map(({ prop, entry }) => {
      const key = label(rid, prop);
      const keyEl = h('span', { class: 'crev-modal-diff-key' }, entry.kind === 'reset' ? `${key} · reset override` : key);
      const why = problem(rid, prop);
      if (entry.kind !== 'reset' && isCode(rid, prop)) {
        // An expression shows its actual change as a compact line diff.
        entries.push({ rid, prop, label: key, from: '', to: '', code: true, ...(why ? { problem: why } : {}) });
        return h('div', { class: 'crev-modal-diff-row ow-review-code' },
          keyEl,
          h('span', { class: 'ow-review-code-sum' }, codeSummary(entry.base, entry.value)),
          renderLineDiff(entry.base, entry.value));
      }
      const words = (v: string) => { const d = display(rid, prop, v); return d === undefined ? short(v) : d.length > 80 ? `${d.slice(0, 80)}…` : d; };
      const from = words(entry.base);
      const to = entry.kind === 'reset' ? 'template value' : words(entry.value);
      const more = entry.kind === 'reset' ? undefined : detail(rid, prop);
      entries.push({
        rid, prop, label: key, from, to, ...(entry.kind === 'reset' ? { reset: true } : {}),
        ...(more?.refs ? { refs: more.refs } : {}), ...(more?.dated ? { dated: true } : {}), ...(why ? { problem: why } : {}),
      });
      const err = why ? h('span', { class: 'ow-review-err' }, `Refused last time: ${why}`) : null;
      if (more?.refs) {
        // A list of references: what is added and removed, one line each.
        return h('div', { class: 'crev-modal-diff-row ow-review-refs' },
          keyEl,
          ...refDiffLines(more.refs).map(line => h('span', { class: line.startsWith('+') ? 'crev-modal-diff-to' : 'crev-modal-diff-from' }, line)),
          err);
      }
      return h('div', { class: 'crev-modal-diff-row' },
        keyEl,
        h('span', { class: 'crev-modal-diff-from' }, from),
        h('span', { class: 'crev-modal-diff-arrow' }, '→'),
        h('span', { class: 'crev-modal-diff-to' }, to),
        err);
    })));
  }
  const objects = groups.size;
  return {
    title: changesId ? `Confirm ID change${n === 1 ? '' : 's'}` : `Save ${n} change${n === 1 ? '' : 's'}`,
    body: [
      objects > 1 ? h('div', null, `In ${objects} objects`) : null,
      changesId
        ? h('div', { class: 'ov-id-change-warning' },
          'Changing an ID can break Extended Code, integrations, or saved references that use the old ID.')
        : null,
      ...lists,
    ].filter((x): x is HTMLElement => !!x),
    confirmLabel: changesId ? 'Change ID' : 'Save changes',
    confirmVariant: changesId ? 'danger' : 'success',
    changesId,
    entries,
  };
}

// ── Changed since opened ─────────────────────────────────────────────────

export type ConflictChoice = 'review' | 'overwrite' | 'cancel';

export interface HeldObject {
  object: ReviewObject;
  /** Changed values (opened → current), or why the check could not read. */
  changes?: ReadonlyArray<{ prop: string; opened: string; current: string }>;
  checkError?: string;
}

export interface ConflictContent {
  title: string;
  body: Node[];
  choices: Array<{ id: Exclude<ConflictChoice, 'cancel'>; label: string; variant?: 'accent' | 'danger' | 'success' }>;
}

/**
 * The dialog shown when objects were held back: for each, what changed in BMP
 * since the window opened it (property, opened value, current value, the
 * user's new value; code as a line diff of the BMP change). Review loads the
 * current values into the comparison, Overwrite writes the user's values
 * anyway, Cancel keeps the draft. When no value is known to have changed (the
 * check could not read), the choices are Save anyway and Cancel.
 */
export function buildConflict(
  held: readonly HeldObject[],
  savedObjects: number,
  label: (rid: string, prop: string) => string,
  isCode: (rid: string, prop: string) => boolean,
  yours: (rid: string, prop: string) => string | undefined,
  display: (rid: string, prop: string, value: string) => string | undefined = () => undefined,
): ConflictContent {
  const changed = held.filter(o => o.changes?.length);
  const n = held.length;
  const lines: Node[] = [];
  lines.push(h('div', null,
    `${savedObjects ? `Saved ${savedObjects} object${savedObjects === 1 ? '' : 's'}. ` : ''}`
    + `Held back ${n} object${n === 1 ? '' : 's'}: nothing was written to ${n === 1 ? 'it' : 'them'}.`));
  for (const o of held) {
    const rid = o.object.rid;
    lines.push(h('div', { class: 'ow-review-obj' },
      h('span', { class: 'ow-review-name' }, o.object.name || '(unnamed)'),
      h('span', { class: 'ow-review-kind' }, o.object.kind)));
    if (!o.changes?.length) {
      lines.push(h('div', { class: 'ov-id-change-warning' },
        `Could not check whether it changed in BMP since you opened it: ${o.checkError ?? 'the read failed'}`));
      continue;
    }
    lines.push(h('div', { class: 'crev-modal-diff-list' }, ...o.changes.map(c => {
      const key = h('span', { class: 'crev-modal-diff-key' }, `${label(rid, c.prop)} · changed in BMP`);
      const mine = yours(rid, c.prop);
      if (isCode(rid, c.prop)) {
        return h('div', { class: 'crev-modal-diff-row ow-review-code' },
          key,
          h('span', { class: 'ow-review-code-sum' },
            `In BMP now: ${codeSummary(c.opened, c.current)}${mine !== undefined ? ` · yours: ${codeSummary(c.opened, mine)}` : ''}`),
          renderLineDiff(c.opened, c.current),
          ...(mine !== undefined ? [
            h('span', { class: 'ow-review-code-sum' }, 'Overwrite writes yours over the BMP value:'),
            renderLineDiff(c.current, mine),
          ] : []));
      }
      const words = (v: string) => display(rid, c.prop, v) ?? (short(v) || '(empty)');
      return h('div', { class: 'crev-modal-diff-row' },
        key,
        h('span', { class: 'crev-modal-diff-from' }, `opened ${words(c.opened)}`),
        h('span', { class: 'crev-modal-diff-arrow' }, '→'),
        h('span', { class: 'crev-modal-diff-to' },
          `in BMP now ${words(c.current)}${mine !== undefined ? ` · yours ${words(mine)}` : ''}`));
    })));
  }
  return {
    title: changed.length
      ? `Changed in BMP since you opened ${n === 1 ? 'it' : 'them'}`
      : 'Could not check for changes in BMP',
    body: lines,
    choices: changed.length
      ? [{ id: 'review', label: 'Review' }, { id: 'overwrite', label: 'Overwrite', variant: 'danger' }]
      : [{ id: 'overwrite', label: 'Save anyway', variant: 'danger' }],
  };
}
