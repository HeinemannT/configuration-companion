// "JSON before and after" for the review: one scroller, changed lines marked
// with a sign and a background, unchanged runs folded. Uses the line diff that
// Compare uses (lib/line-diff.ts), not its window code.
import { lineDiff, withContext } from '../lib/line-diff';

import { escapeHtml as esc } from '../lib/escape';
const SIGN = { ' ': ' ', '-': '−', '+': '+' };

/** What a reviewer compares: a policy's JSON, or the record without storage identity. */
export function reviewedJSON(collection, record) {
  if (record === undefined || record === null) return '';
  if (collection === 'policies') return JSON.stringify(record.content ?? null, null, 2);
  const { rid: _rid, valid: _valid, ...rest } = record;
  return JSON.stringify(rest, null, 2);
}

export function jsonDiffHTML(before, after, context = 3) {
  const lines = lineDiff(before, after);
  const added = lines.filter(l => l.op === '+').length, removed = lines.filter(l => l.op === '-').length;
  const rows = withContext(lines, context).map(r => r.op === 'gap'
    ? `<div class="jd-gap">${r.count} unchanged ${r.count === 1 ? 'line' : 'lines'}</div>`
    : `<div class="jd-row ${r.op === '+' ? 'add' : r.op === '-' ? 'del' : ''}"><span class="jd-sign" aria-hidden="true">${SIGN[r.op]}</span><span class="sr-only">${r.op === '+' ? 'Added: ' : r.op === '-' ? 'Removed: ' : ''}</span><span class="jd-text">${esc(r.text) || ' '}</span></div>`).join('');
  return `<div class="json-diff" role="group" aria-label="${added} lines added, ${removed} removed"><p class="jd-summary">${added} ${added === 1 ? 'line' : 'lines'} added, ${removed} removed</p>${rows || '<p class="jd-summary">No difference.</p>'}</div>`;
}
