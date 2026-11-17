/**
 * Read-only code rendering: numbered code blocks for the object window and
 * the editor's peeks (renderCode), and the one coloured-line renderer every
 * surface uses (renderCodeLine; tokenizer from lib/ec-format, colours in
 * styles/ui.css), with sibling-key marks.
 * Pure DOM; no chrome.*.
 */

import { tokenizeEcLine } from '../lib/ec-format';
import type { CodeRef } from '../lib/code-refs';

/** Longer code is not inlined: the pane shows its head and the true size. */
export const CODE_INLINE_LIMIT = 20_000;
/** Characters of the head shown for code above the limit. */
const HEAD_CHARS = 4_000;
/** Lines shown before "expand". */
export const CODE_CAP_LINES = 12;

export interface CodeView {
  /** The `.ow-code` element. */
  el: HTMLElement;
  lines: number;
  chars: number;
  /** True when only the head is shown. */
  truncated: boolean;
}

function line(n: number, content: Node[], extraClass = ''): HTMLElement {
  const row = document.createElement('div');
  row.className = `ow-ln${extraClass ? ` ${extraClass}` : ''}`;
  const num = document.createElement('span');
  num.className = 'n';
  num.textContent = n ? String(n) : '';
  const c = document.createElement('span');
  c.className = 'c';
  if (content.length) c.append(...content);
  else c.textContent = ' ';
  row.append(num, c);
  return row;
}

/** A reference on one line: offsets relative to the line. */
interface LineRef {
  s: number;
  e: number;
  ref: CodeRef;
}

function tokenNode(slice: string, kind: string | null, isKey: boolean): Node {
  if (kind === null && !isKey) return document.createTextNode(slice);
  const span = document.createElement('span');
  span.className = [kind ? `s-${kind}` : '', isKey ? 's-key' : ''].filter(Boolean).join(' ');
  span.textContent = slice;
  return span;
}

/** Ranges drawn over the coloured tokens of one line: the text of range `i`
 *  goes into the element `wrap(i)` makes (search hits, changed words,
 *  reference links). Neighbouring pieces with the same `key` share one
 *  element (default: one element per range). */
export interface CodeLineLayer {
  ranges: ReadonlyArray<readonly [number, number]>;
  wrap: (i: number) => HTMLElement;
  key?: (i: number) => unknown;
}

export interface CodeLineOptions {
  /** Outer layer first; an inner element sits inside the outer one. */
  layers?: readonly CodeLineLayer[];
  /** Tokens whose text is one of these get the `s-key` mark. */
  keys?: ReadonlySet<string>;
  /** No colouring (plain text in the layers). */
  plain?: boolean;
}

/** The one renderer of a read-only Extended Code line: a `span.s-<kind>`
 *  per coloured token (colours: the `.s-*` section of styles/ui.css), text
 *  nodes for the rest, split at every layer edge. Used by the object window,
 *  its peeks, the editor's panels and cookbook, code search and Compare. */
export function renderCodeLine(text: string, opts: CodeLineOptions = {}): Node[] {
  const layers = opts.layers ?? [];
  const keys = opts.keys;
  const toks = opts.plain ? [{ start: 0, end: text.length, kind: null as string | null }] : tokenizeEcLine(text);
  const cuts = new Set<number>([0, text.length]);
  for (const t of toks) { cuts.add(t.start); cuts.add(t.end); }
  for (const l of layers) for (const [s, e] of l.ranges) { cuts.add(s); cuts.add(e); }
  const points = [...cuts].filter(x => x >= 0 && x <= text.length).sort((x, y) => x - y);
  const out: Node[] = [];
  const open: Array<{ key: unknown; el: HTMLElement } | null> = layers.map(() => null);
  let t = 0;
  for (let p = 0; p < points.length - 1; p++) {
    const a = points[p], b = points[p + 1];
    if (a === b) continue;
    layers.forEach((l, d) => {
      const i = l.ranges.findIndex(([s, e]) => s <= a && a < e);
      const key = i < 0 ? null : l.key ? l.key(i) : i;
      if (open[d] && key !== null && open[d]!.key === key) return;
      for (let x = d; x < open.length; x++) open[x] = null;
      if (key === null) return;
      const host = open.slice(0, d).reverse().find(o => o != null)?.el;
      const elx = l.wrap(i);
      if (host) host.append(elx); else out.push(elx);
      open[d] = { key, el: elx };
    });
    while (t < toks.length && toks[t].end <= a) t++;
    const tok = t < toks.length && toks[t].start <= a ? toks[t] : null;
    const isKey = !!tok && !!keys?.size && keys.has(text.slice(tok.start, tok.end));
    const node = tokenNode(text.slice(a, b), tok?.kind ?? null, isKey);
    const host = [...open].reverse().find(o => o != null)?.el;
    if (host) host.append(node); else out.push(node);
  }
  return out;
}

/** Colour one line; the text of each reference goes into the element
 *  `link` makes for it (tokens are split at reference edges). */
function colourLine(text: string, keys: ReadonlySet<string>, refs: readonly LineRef[] = [], link?: (ref: CodeRef) => HTMLElement): Node[] {
  const layers: CodeLineLayer[] = link && refs.length
    ? [{ ranges: refs.map(r => [r.s, r.e] as const), wrap: i => link(refs[i].ref) }]
    : [];
  return renderCodeLine(text, { layers, keys });
}

export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface RenderCodeOptions {
  plain?: boolean;
  keys?: ReadonlySet<string>;
  label: string;
  orig?: string;
  /** References in `code` (lib/code-refs findCodeRefs) drawn as links. */
  refs?: readonly CodeRef[];
  link?: (ref: CodeRef) => HTMLElement;
  /** Nodes drawn right after a line (inline peeks under the calling line). */
  after?: (line: number) => Node[];
  /** Show only the first lines; `more` draws the row that offers the rest. */
  maxLines?: number;
  more?: (hidden: number) => HTMLElement;
}

/** Render `code` as numbered lines. `plain` skips EC colouring. */
export function renderCode(code: string, opts: RenderCodeOptions): CodeView {
  const chars = code.length;
  const truncated = chars > CODE_INLINE_LIMIT;
  let shown = code;
  if (truncated) {
    const cut = code.lastIndexOf('\n', HEAD_CHARS);
    shown = code.slice(0, cut > 0 ? cut : HEAD_CHARS);
  }
  const all = code.split('\n').length;
  const el = document.createElement('div');
  el.className = 'ow-code';
  el.tabIndex = 0;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', `${opts.label} code`);
  const keys = opts.keys ?? new Set<string>();
  // Lines that are not in the saved text (an unsaved edit) get a change mark.
  const before = opts.orig != null ? new Set(opts.orig.split('\n')) : null;
  // References per line, with offsets relative to the line.
  const lines = shown.split('\n');
  const byLine = new Map<number, LineRef[]>();
  if (opts.refs?.length && opts.link && !opts.plain) {
    let offset = 0;
    const starts = lines.map(t => { const s = offset; offset += t.length + 1; return s; });
    for (const ref of opts.refs) {
      const ls = starts[ref.line - 1];
      if (ls == null || ref.end > ls + lines[ref.line - 1].length) continue;
      const list = byLine.get(ref.line) ?? [];
      list.push({ s: ref.start - ls, e: ref.end - ls, ref });
      byLine.set(ref.line, list);
    }
  }
  const limit = opts.maxLines != null && opts.maxLines < lines.length ? opts.maxLines : lines.length;
  for (let i = 0; i < limit; i++) {
    const text = lines[i];
    const changed = before != null && !before.has(text);
    const content = text === '' ? [] : opts.plain ? [document.createTextNode(text)] : colourLine(text, keys, byLine.get(i + 1), opts.link);
    const row = line(i + 1, content, changed ? 'chg' : '');
    if (changed) row.title = 'Changed line';
    el.append(row);
    const extra = opts.after?.(i + 1);
    if (extra?.length) el.append(...extra);
  }
  if (limit < lines.length && opts.more) el.append(opts.more(lines.length - limit));
  if (truncated) {
    el.append(line(0, [document.createTextNode(`… ${formatCount(chars - shown.length)} more characters`)], 'cut'));
  }
  return { el, lines: all, chars, truncated };
}

/** Sibling keys that the code mentions as whole words. */
export function keysReadBy(code: string, keys: readonly string[]): string[] {
  return keys.filter(k => new RegExp(`(^|[^A-Za-z0-9_])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(code));
}
