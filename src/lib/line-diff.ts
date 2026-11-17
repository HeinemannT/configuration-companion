/**
 * Compact line diff for the review dialog: the changed lines of an expression
 * with a little context, in the colours Compare uses (removed red, added
 * green). `diffSeq` is the shared longest-common-subsequence step; Compare
 * (lib/compare-model.ts) runs it on lines and on words.
 * DOM only; no chrome.*.
 */

import { h } from './dom';

export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
}

export type DiffRow = DiffLine | { op: 'gap'; count: number };

/** One step of a sequence diff: `i` indexes `a`, `j` indexes `b`. */
export type SeqOp = { op: ' '; i: number; j: number } | { op: '-'; i: number } | { op: '+'; j: number };

/** Above this many cells (old items x new items) the LCS table is skipped
 *  and the change is shown as all old items removed, all new items added. */
const MAX_CELLS = 1_000_000;

/** Diff of two sequences (longest common subsequence on `key`). Common head
 *  and tail items are matched first, so a small edit in a long text stays
 *  cheap. Removed items come before added ones. */
export function diffSeq<T>(a: readonly T[], b: readonly T[], key: (item: T) => string = String): SeqOp[] {
  const ka = a.map(key), kb = b.map(key);
  let head = 0;
  while (head < ka.length && head < kb.length && ka[head] === kb[head]) head++;
  let tail = 0;
  while (tail < ka.length - head && tail < kb.length - head && ka[ka.length - 1 - tail] === kb[kb.length - 1 - tail]) tail++;
  const out: SeqOp[] = [];
  for (let k = 0; k < head; k++) out.push({ op: ' ', i: k, j: k });
  const n = ka.length - head - tail, m = kb.length - head - tail;
  if (n * m > MAX_CELLS) {
    for (let k = 0; k < n; k++) out.push({ op: '-', i: head + k });
    for (let k = 0; k < m; k++) out.push({ op: '+', j: head + k });
  } else {
    // lcs[i][j]: length of the LCS of the middle parts from i and j on.
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = ka[head + i] === kb[head + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ka[head + i] === kb[head + j]) { out.push({ op: ' ', i: head + i, j: head + j }); i++; j++; }
      else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) { out.push({ op: '-', i: head + i }); i++; }
      else { out.push({ op: '+', j: head + j }); j++; }
    }
  }
  for (let k = 0; k < tail; k++) out.push({ op: ' ', i: ka.length - tail + k, j: kb.length - tail + k });
  return out;
}

/** Line diff of `from` → `to`. */
export function lineDiff(from: string, to: string): DiffLine[] {
  const a = from === '' ? [] : from.split('\n');
  const b = to === '' ? [] : to.split('\n');
  return diffSeq(a, b).map(s => s.op === '+' ? { op: '+', text: b[s.j] } : { op: s.op, text: a[s.i] });
}

/** Keep `context` unchanged lines around each change; fold the rest. */
export function withContext(lines: readonly DiffLine[], context = 2): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) rows.push({ op: 'gap', count: gap });
      gap = 0;
      rows.push(l);
    } else gap++;
  });
  if (gap) rows.push({ op: 'gap', count: gap });
  return rows;
}

const SIGN: Record<DiffLine['op'], string> = { ' ': ' ', '-': '−', '+': '+' };

/** The compact diff block (capped in height by CSS, scrolls inside). */
export function renderLineDiff(from: string, to: string): HTMLElement {
  const lines = lineDiff(from, to);
  const added = lines.filter(l => l.op === '+').length;
  const removed = lines.filter(l => l.op === '-').length;
  const rows = withContext(lines).map(r => r.op === 'gap'
    ? h('div', { class: 'ow-ld-gap' }, `${r.count} unchanged ${r.count === 1 ? 'line' : 'lines'}`)
    : h('div', { class: `ow-ld-row${r.op === '+' ? ' add' : r.op === '-' ? ' del' : ''}` },
      h('span', { class: 'ow-ld-sign', 'aria-hidden': 'true' }, SIGN[r.op]),
      h('span', { class: 'ow-ld-text' }, r.text || ' ')));
  return h('div', { class: 'ow-ld', role: 'group', 'aria-label': `Expression change: ${added} added, ${removed} removed` }, ...rows);
}

/** "3 lines (+1 −1)": the size of the new text and the changed line counts. */
export function codeSummary(from: string, to: string): string {
  const lines = lineDiff(from, to);
  const added = lines.filter(l => l.op === '+').length;
  const removed = lines.filter(l => l.op === '-').length;
  const n = to === '' ? 0 : to.split('\n').length;
  return `${n} ${n === 1 ? 'line' : 'lines'} (+${added} −${removed})`;
}
