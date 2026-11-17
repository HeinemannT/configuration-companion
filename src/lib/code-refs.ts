/**
 * References to other BMP objects in Extended Code text.
 *
 * One pure finder for every surface that turns references into links: the
 * object window's code view, its Calls section and the Extended Code
 * window's hover. Both windows call `findCodeRefs`, so they always agree on
 * what is a reference.
 *
 * Forms (a reference must start an expression; `_x.t.foo` is a member):
 *  - `t.some_id`, `ceras.123`: an ID space and a business ID (`[A-Za-z0-9_]`,
 *    at least two characters, as the editor has always required);
 *  - `t.get("some-id.v2")`: a literal ID in `get(…)`, which also reaches IDs
 *    with `-` or `.`. A computed argument (`t.get(_id)`, `t.get("a" + _b)`)
 *    is not a reference;
 *  - `{some_id}`: the brace call, the value of `t.some_id.expression`;
 *  - `lookup(1234567)` and `lookup("1234567")`: a RID;
 *  - `rid=1234567` / `rid:1234567`: a RID written into text.
 * A trailing code property (`.expression`, `.javascript` …) belongs to the
 * link; any other trailing property is reported but not linked.
 *
 * Text inside `//` and `/* … *​/` comments and inside string literals is
 * never a reference (the literal argument of `get`/`lookup` is the only
 * string read). Pure: no DOM, no chrome.*.
 */

import { isValidNamespace } from './namespace';

export type CodeRefForm = 'dot' | 'get' | 'brace' | 'lookup' | 'rid';

export interface CodeRef {
  /** Link range in the text: `start` inclusive, `end` exclusive. */
  start: number;
  end: number;
  /** ID space (`t`, `o`, `ceras` …); empty for the RID forms. */
  ns: string;
  /** Business ID, or the RID for the RID forms. */
  id: string;
  /** Property read right after the reference (`expression`); implied
   *  `expression` for the brace call. */
  prop?: string;
  form: CodeRefForm;
  /** Resolve key: `<ns>.<id>` or `rid:<digits>`. One object, one key. */
  key: string;
  /** 1-based line of `start`. */
  line: number;
}

/** Trailing properties that are part of the link (they hold code). */
export const CODE_LINK_PROPS: ReadonlySet<string> = new Set([
  'expression', 'javascript', 'html', 'initExpression', 'afterExpression', 'defaultExpression',
  'refreshExpression', 'showExpression', 'enableExpression', 'requiredExpression', 'editExpression',
]);

/** Literal IDs accepted from `get("…")`: no quotes, backslashes or breaks. */
const LITERAL_ID_RE = /^[^"'\\\r\n]{1,200}$/;
const WORD_RE = /[A-Za-z0-9_]/;
const WORD_START_RE = /[A-Za-z_]/;

export function refKey(ns: string, id: string): string {
  return ns ? `${ns}.${id}` : `rid:${id}`;
}

/** Split a key back into its parts. */
export function parseRefKey(key: string): { ns: string; id: string } | null {
  if (key.startsWith('rid:')) {
    const id = key.slice(4);
    return /^-?\d{5,20}$/.test(id) ? { ns: '', id } : null;
  }
  const dot = key.indexOf('.');
  if (dot <= 0) return null;
  const ns = key.slice(0, dot), id = key.slice(dot + 1);
  if (!/^[a-z]{1,6}$/.test(ns) || !isValidNamespace(ns) || !LITERAL_ID_RE.test(id)) return null;
  return { ns, id };
}

/** End of a string literal that starts at `i` (the quote), exclusive. */
function stringEnd(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === q) return j + 1;
    j++;
  }
  return text.length;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/** `(  "literal"  )` or `(digits)` at `i` (the opening paren). */
function literalArg(text: string, i: number, digits: boolean): { value: string; end: number } | null {
  if (text[i] !== '(') return null;
  let j = skipSpace(text, i + 1);
  let value: string;
  if (text[j] === '"' || text[j] === "'") {
    const end = stringEnd(text, j);
    if (text[end - 1] !== text[j] || end - j < 2) return null;
    value = text.slice(j + 1, end - 1);
    j = end;
  } else if (digits) {
    const m = /^-?\d+/.exec(text.slice(j, j + 24));
    if (!m) return null;
    value = m[0];
    j += m[0].length;
  } else {
    return null;
  }
  j = skipSpace(text, j);
  if (text[j] !== ')') return null;
  return { value, end: j + 1 };
}

/** Members of an ID space itself, not business IDs: `t.children()`,
 *  `t.id`, `u.current` … are reads on the space and never a reference. */
export const SPACE_MEMBERS: ReadonlySet<string> = new Set([
  'id', 'rid', 'name', 'current', 'me', 'children', 'descendants', 'parent', 'className', 'size', 'first', 'last',
  'filter', 'forEach', 'whenMissing', 'isMissing', 'calculate', 'add', 'change', 'delete', 'lookup', 'type',
]);

/** A trailing `.prop` that is a property, not a method call. Spaces or tabs
 *  before the dot are allowed (`t.foo .expression`). */
function trailingProp(text: string, i0: number): { name: string; end: number } | null {
  const i = skipSpace(text, i0);
  if (text[i] !== '.' || !WORD_START_RE.test(text[i + 1] ?? '')) return null;
  let j = i + 1;
  while (j < text.length && WORD_RE.test(text[j])) j++;
  if (skipSpace(text, j) < text.length && text[skipSpace(text, j)] === '(') return null;
  return { name: text.slice(i + 1, j), end: j };
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

function lineOf(starts: number[], pos: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** Every reference in `text`, in text order. */
export function findCodeRefs(text: string): CodeRef[] {
  const out: Array<Omit<CodeRef, 'line'>> = [];
  const n = text.length;
  let i = 0;
  const withProp = (ref: Omit<CodeRef, 'line' | 'end' | 'prop'>, end: number) => {
    const p = trailingProp(text, end);
    if (p && CODE_LINK_PROPS.has(p.name)) out.push({ ...ref, prop: p.name, end: p.end });
    else out.push({ ...ref, ...(p ? { prop: p.name } : {}), end });
    return p && CODE_LINK_PROPS.has(p.name) ? p.end : end;
  };
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") { i = stringEnd(text, i); continue; }
    if (c === '{') {
      const m = /^\{(\w{2,})\}/.exec(text.slice(i, i + 220));
      if (m) {
        out.push({ start: i, end: i + m[0].length, ns: 't', id: m[1], prop: 'expression', form: 'brace', key: refKey('t', m[1]) });
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && WORD_RE.test(text[i])) i++;
      continue;
    }
    if (!WORD_START_RE.test(c)) { i++; continue; }
    const start = i;
    while (i < n && WORD_RE.test(text[i])) i++;
    const word = text.slice(start, i);
    const prev = start > 0 ? text[start - 1] : '';
    // A member (`_x.t.foo`, `this.object`) is never the start of a reference.
    if (prev === '.') continue;
    if (word === 'lookup') {
      const arg = literalArg(text, skipSpace(text, i), true);
      if (arg && /^-?\d{5,20}$/.test(arg.value)) {
        i = withProp({ start, ns: '', id: arg.value, form: 'lookup', key: refKey('', arg.value) }, arg.end);
      }
      continue;
    }
    if (word.toLowerCase() === 'rid' && (text[i] === '=' || text[i] === ':')) {
      const m = /^\d{5,20}(?![A-Za-z0-9_])/.exec(text.slice(i + 1, i + 24));
      if (m) {
        out.push({ start, end: i + 1 + m[0].length, ns: '', id: m[0], form: 'rid', key: refKey('', m[0]) });
        i += 1 + m[0].length;
      }
      continue;
    }
    if (text[i] !== '.' || !isValidNamespace(word)) continue;
    // `ns.get("literal")`
    const after = text.slice(i + 1, i + 4);
    if (after === 'get' && !WORD_RE.test(text[i + 4] ?? '')) {
      const open = skipSpace(text, i + 4);
      if (text[open] === '(') {
        const arg = literalArg(text, open, false);
        if (arg && LITERAL_ID_RE.test(arg.value) && arg.value.trim() === arg.value) {
          i = withProp({ start, ns: word, id: arg.value, form: 'get', key: refKey(word, arg.value) }, arg.end);
        } else {
          i = open; // computed argument: scan it as ordinary code
        }
        continue;
      }
    }
    // `ns.id`
    let j = i + 1;
    while (j < n && WORD_RE.test(text[j])) j++;
    const id = text.slice(i + 1, j);
    if (id.length < 2) continue;
    // A method on the space (`t.children()`) or a member of it (`t.id`).
    if (SPACE_MEMBERS.has(id) || text[skipSpace(text, j)] === '(') { i = j; continue; }
    i = withProp({ start, ns: word, id, form: 'dot', key: refKey(word, id) }, j);
  }
  const starts = lineStarts(text);
  return out.map(r => ({ ...r, line: lineOf(starts, r.start) }));
}

/** One entry per referenced object, in first-use order, with every line
 *  that names it. */
export interface CodeRefUse {
  key: string;
  first: CodeRef;
  lines: number[];
}

export function groupCodeRefs(refs: readonly CodeRef[]): CodeRefUse[] {
  const map = new Map<string, CodeRefUse>();
  for (const r of refs) {
    const cur = map.get(r.key);
    if (!cur) map.set(r.key, { key: r.key, first: r, lines: [r.line] });
    else if (!cur.lines.includes(r.line)) cur.lines.push(r.line);
  }
  return [...map.values()];
}

/** The written form of a reference without its trailing property, for
 *  "not found" rows (`t.some_id`, `t.get("a-b")`, `lookup(123)`). */
export function refLabel(ref: Pick<CodeRef, 'ns' | 'id' | 'form'>): string {
  switch (ref.form) {
    case 'get': return `${ref.ns}.get("${ref.id}")`;
    case 'brace': return `{${ref.id}}`;
    case 'lookup': return `lookup(${ref.id})`;
    case 'rid': return `rid ${ref.id}`;
    default: return `${ref.ns}.${ref.id}`;
  }
}
