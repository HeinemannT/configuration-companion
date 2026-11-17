/**
 * Transport (beta), the pure half: reading the text BMP generates for an
 * object and assembling a plain Extended Code bundle that a person pastes
 * into a script window on another workspace. No chrome.*, no DOM, no I/O;
 * the reads are in transport-read.ts, the messages in handlers/transport.ts.
 *
 * Measured on BMP 5.6.17:
 *  - `obj.genedit()` is one line `<address>.change(<arguments>) //<Class>`,
 *    sometimes after a leading line break. Strings are single-quoted with
 *    backslash escapes (`\'`, `\"`, `\n`, `<\/p>`); arguments can hold
 *    parentheses, commas and quotes inside strings, nested calls such as
 *    `historical(2026-10-01:list(o.111, o.112))` and `list(…)`. Running the
 *    line back onto the object leaves its text unchanged.
 *  - `obj.generate(true)` is the creation script with the ID. For every
 *    object that is not a linked copy (1,463 of 1,774 over all 14 areas, 128
 *    classes, with and without children) the arguments of its first
 *    statement are those of `genedit()`, so an Add is made from the parent,
 *    the class and the genedit arguments. Only a property definition needs
 *    it: `_lmc := root.property.add(…)` is followed by one
 *    `c.get(<Class>.name).link(_lmc)` line per class it is linked to, in no
 *    fixed order, and `genedit()` does not print the links.
 *  - `genedit()` is empty for some classes (ObjectProfileMapping,
 *    TableFilter, WebTableView, ClassConfig, SystemMethodConfig).
 *  - `x = MISSING` is true when an address does not resolve; a line that
 *    addresses a missing object does not fail the run. `a.moveAfter(b)` and
 *    `a.moveBefore(b)` set sibling order. An `IF` used as a statement
 *    without `ELSE` prints a "Missing value for IF" line, so every guard
 *    here has `ELSE ""`.
 *  - A bundle of this form (guarded creates, the genedit lines twice, a
 *    report) recreated five deleted objects with identical generate and
 *    genedit text, and a second run changed nothing.
 *
 * Everything here is deterministic: the same objects give the same text,
 * whatever order they come in.
 */

import { ecString } from './ec-guards';

// ── roots and limits ────────────────────────────────────────────────

/** Roots a changes scan may walk (`root.<name>`), on by default first. */
export const TRANSPORT_ROOTS = [
  'expression', 'portal', 'property', 'templateCategory', 'externalResource', 'transformer', 'defaults', 'page', 'nodeType', 'classConfig',
  'notification', 'role', 'accessProfile', 'accessPolicy',
] as const;
export type TransportRoot = typeof TRANSPORT_ROOTS[number];

/** Roots ticked by default; the others are opt-in. `root.organisation` is
 *  not among the roots: organisations are not transported. */
export const TRANSPORT_DEFAULT_ROOTS: readonly TransportRoot[] = Object.freeze(
  ['expression', 'portal', 'property', 'templateCategory', 'externalResource', 'transformer', 'defaults', 'page', 'nodeType', 'classConfig'] as TransportRoot[],
);

export function isTransportRoot(v: unknown): v is TransportRoot {
  return typeof v === 'string' && (TRANSPORT_ROOTS as readonly string[]).includes(v);
}

/** Rows one root's scan returns at most; one more row is read to tell
 *  "more than this". */
export const TRANSPORT_SCAN_CAP = 2_000;

/** Rows one group holds at most when a cut scan is read to the end, child
 *  by child. */
export const TRANSPORT_SCAN_TOTAL = 20_000;

/** Objects one bundle read asks for (one preview post). */
export const TRANSPORT_READ_BATCH = 25;

/** Characters of one bundle part. */
export const BUNDLE_PART_LIMIT = 20_000;

/** A calendar day `YYYY-MM-DD` that exists. */
export function isScanDay(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** An ID a scan "under an object" may start from: any characters but line
 *  breaks and other control characters, at most 128 (so the script that
 *  looks it up stays a small varying one; it is written as a quoted text). */
export const START_ID = { test: (id: string): boolean => id.length >= 1 && id.length <= 128 && writableId(id) };

export const START_EMPTY = 'Enter the ID of an object.';
/** ID spaces a starting object may be looked up in (`<space>.get("<ID>")`,
 *  measured on BMP 5.6.17 for these and more). */
export const START_SPACES = ['t', 'k', 'r', 'd'] as const;
export type StartSpace = typeof START_SPACES[number];

export const isStartSpace = (v: unknown): v is StartSpace => typeof v === 'string' && (START_SPACES as readonly string[]).includes(v);

export const START_SPACE = 'Only objects addressed as t.<ID>, k.<ID>, r.<ID> or d.<ID> can be a starting point.';
export const START_NOT_ID = 'An ID has at most 128 characters and no line breaks.';

export type ScanStart = { ok: true; space: StartSpace; id: string; address: string } | { ok: false; error: string };

/**
 * The starting object of a scan "under an object", as a person types it: an
 * ID (`my_module`, the `t.` space) or its address `<space>.<ID>` in one of
 * START_SPACES (`t.my_module`, `k.my_kpi`). Another space (`o.x`) is
 * refused. Checked here, before any script is built.
 */
export function parseScanStart(text: string): ScanStart {
  const t = text.trim();
  if (!t) return { ok: false, error: START_EMPTY };
  // `t.get("…")` or `t.get('…')`.
  const g = /\.get\(/.test(t) ? splitAddress(t) : null;
  let space: string, id: string;
  if (g) { space = g.space; id = g.id; } else {
    // `<space>.<ID>`, the ID as typed (it may hold spaces and dots); a text
    // without a space in front is an ID in `t`. A short name before the
    // first dot that is no start space is another space.
    const dot = t.indexOf('.');
    const head = dot > 0 ? t.slice(0, dot) : '';
    if (isStartSpace(head)) { space = head; id = t.slice(dot + 1); }
    else if (/^[A-Za-z]{1,2}$/.test(head) || /^(cepro|acpol|root)$/i.test(head)) return { ok: false, error: START_SPACE };
    else { space = 't'; id = t; }
  }
  if (!isStartSpace(space)) return { ok: false, error: START_SPACE };
  if (!START_ID.test(id)) return { ok: false, error: START_NOT_ID };
  const address = addressOf(space, id);
  if (!address) return { ok: false, error: START_NOT_ID };
  return { ok: true, space, id, address };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A date as the server prints it (`str(lastModifiedDate)`), as ISO text
 * without a zone (`2026-11-01T10:00:00`), the server's own clock time; or
 * undefined when the text has another form. Forms read: `Nov 1, 2026
 * 10:00:00` (the form in this repository's fixtures of
 * `str(lastModifiedDate)`), the same with `AM`/`PM`, and ISO
 * `2026-05-14T10:00:00` or `2026-05-14 10:00` (with or without seconds,
 * fraction or zone; the zone is dropped).
 */
export function serverStampIso(text: string): string | undefined {
  const s = text.trim();
  const p = (n: number) => String(n).padStart(2, '0');
  const out = (y: number, mo: number, d: number, h: number, mi: number, se: number) => {
    if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return undefined;
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return undefined;
    return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(se)}`;
  };
  let m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (!mo) return undefined;
    let h = Number(m[4]);
    if (m[7]) {
      if (h < 1 || h > 12) return undefined;
      h = (h % 12) + (m[7].toLowerCase() === 'p' ? 12 : 0);
    }
    return out(Number(m[3]), mo, Number(m[2]), h, Number(m[5]), Number(m[6] ?? 0));
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) return out(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return undefined;
}

// ── reading generated text ──────────────────────────────────────────

/** Index just past the string literal that starts at `i` (a `'` or `"`),
 *  or the end of the text when it is not closed. Backslash escapes. */
function skipString(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    j++;
  }
  return text.length;
}

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/** Index of the bracket that closes the one at `open`, skipping strings and
 *  nested brackets; -1 when it is not closed or brackets do not pair. */
function matchClose(text: string, open: number): number {
  const stack: string[] = [];
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '\'' || c === '"') { i = skipString(text, i); continue; }
    if (OPENERS[c]) stack.push(OPENERS[c]);
    else if (CLOSERS.has(c)) {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
    i++;
  }
  return -1;
}

/** Index of the first `needle` outside strings, from `from`; -1 if none. */
function indexOutsideStrings(text: string, needle: string, from = 0): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '\'' || c === '"') { i = skipString(text, i); continue; }
    if (text.startsWith(needle, i)) return i;
    i++;
  }
  return -1;
}

/** One `genedit()` line, read. */
export interface GeneditLine {
  /** The text before `.change(`: the object's address (`t.x`, `cepro.108`). */
  address: string;
  /** The raw text between `.change(` and its closing parenthesis. */
  args: string;
  /** The class named in the trailing `//<Class>`, when there is one. */
  className?: string;
}

/**
 * Read a `genedit()` text: `<address>.change(<args>)` with an optional
 * `//<Class>` after it. Quotes, escapes, nested brackets and line breaks
 * inside strings are respected. Null when the text has another shape
 * (empty, no `.change(`, unclosed, or anything but a comment after the
 * closing parenthesis).
 */
export function parseGenedit(text: string): GeneditLine | null {
  const t = text.trim();
  if (!t) return null;
  const at = indexOutsideStrings(t, '.change(');
  if (at <= 0) return null;
  const raw = t.slice(0, at).trim();
  const open = at + '.change'.length;
  const close = matchClose(t, open);
  if (close < 0) return null;
  const args = t.slice(open + 1, close);
  const address = textAddress(raw, args);
  if (!address) return null;
  const rest = t.slice(close + 1).trim();
  if (!rest) return { address, args };
  const m = /^\/\/\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(rest);
  return m ? { address, args, className: m[1] } : null;
}

/**
 * The address of a `genedit()` text from the text before `.change(` and
 * its arguments: the space from the text before the first dot, the ID from
 * the `id := '…'` argument (addressOf). That covers `t.x`,
 * `t.get('a-b')` (5.6.17) and the bare `ap.Everyone profile` (5.6.10).
 * The item of a flow project (`t.p.configObjects.item(0)`), whose `id` is
 * the step's, and a text without an `id` keep the text as it is (without
 * white space). '' when there is no address.
 */
function textAddress(raw: string, args: string): string {
  const keep = !/\s/.test(raw) ? plainAddress(raw) || raw : '';
  if (/\.(configObjects|transLinks)\.item\(/.test(raw)) return keep;
  const dot = raw.indexOf('.');
  const space = dot > 0 ? raw.slice(0, dot) : '';
  const literal = argumentText(args, 'id');
  const id = literal != null ? decodeEcString(literal) : undefined;
  if (!SPACE.test(space) || id == null) return keep;
  return addressOf(space, id) || keep;
}

/** The arguments of a call split at their top-level commas (not inside
 *  strings or brackets), each trimmed; empty pieces dropped. */
export function splitArguments(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < args.length) {
    const c = args[i];
    if (c === '\'' || c === '"') { i = skipString(args, i); continue; }
    if (OPENERS[c]) depth++;
    else if (CLOSERS.has(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(args.slice(start, i)); start = i + 1; }
    i++;
  }
  out.push(args.slice(start));
  return out.map(s => s.trim()).filter(Boolean);
}

/** The raw value text of the named argument (`name := <value>`), or
 *  undefined when the arguments do not set it. The name is matched without
 *  regard to case, as BMP's accessors are. */
export function argumentText(args: string, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const piece of splitArguments(args)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]*)$/.exec(piece);
    if (m && m[1].toLowerCase() === want) return m[2].trim();
  }
  return undefined;
}

/** The text of exactly one Extended Code string literal (`'…'` or `"…"`
 *  with backslash escapes), or undefined. `\n`, `\r`, `\t` are control
 *  characters; any other escaped character stands for itself (`\'`, `\"`,
 *  `\\`, `\/`). */
export function decodeEcString(literal: string): string | undefined {
  const t = literal.trim();
  const m = /^'((?:[^'\\]|\\[\s\S])*)'$/.exec(t) ?? /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(t);
  if (!m) return undefined;
  return m[1].replace(/\\(u[0-9A-Fa-f]{4}|[\s\S])/g, (_all, c: string) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

/** The decoded `name := '…'` of a genedit argument list, when it is one
 *  plain string literal. */
export function nameArgument(args: string): string | undefined {
  const raw = argumentText(args, 'name');
  return raw == null ? undefined : decodeEcString(raw);
}

/**
 * The statements of a script text: one per line, except that a line break
 * inside a string literal (measured texts hold `\n` escapes instead, but a
 * raw break is tolerated) continues the statement. A `//` comment outside a
 * string runs to the end of its line and stays with it. Each statement is
 * trimmed; blank lines are dropped.
 */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\'' || c === '"') { i = skipString(text, i); continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      out.push(text.slice(start, i));
      if (c === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
    }
    i++;
  }
  out.push(text.slice(start));
  return out.map(s => s.trim()).filter(Boolean);
}

/** The create block of an object, from its `generate(true)` text. */
export interface CreateBlock {
  /** The first statement, then the `c.get(…).link(<its variable>)` lines. */
  statements: string[];
  /** The address the first statement adds the object to (the part before
   *  its top-level `.add(`), when it has that shape. */
  parentAddress?: string;
  /** Statements left out: those that create children. */
  dropped: number;
}

const LINK_LINE = /^c\.get\([\s\S]*\)\.link\(\s*(_[A-Za-z0-9_]*)\s*\)$/;

/**
 * The create block of an object: the first statement of its
 * `generate(true)` text, plus the `c.get(…).link(_v)` lines that link the
 * first statement's variable `_v` (a property definition's classes). Every
 * other statement creates a child and is dropped: a ticked child gets its
 * own block. Null for an empty text.
 */
export function createBlock(generateText: string): CreateBlock | null {
  const statements = splitStatements(generateText);
  if (!statements.length) return null;
  const [first, ...rest] = statements;
  const variable = /^(_[A-Za-z0-9_]*)\s*:=/.exec(first)?.[1];
  const links = variable ? rest.filter(s => LINK_LINE.exec(s)?.[1] === variable) : [];
  const receiver = createParentAddress(first);
  return { statements: [first, ...links], ...(receiver ? { parentAddress: receiver } : {}), dropped: rest.length - links.length };
}

/** A property definition: a class ending in `MethodConfig` other than
 *  `SystemMethodConfig` (a system object), at `k.<ID>` when `address` is
 *  given. Its links to classes are only in `generate(true)`. */
export function isPropertyDefinition(className: string, address?: string): boolean {
  return /MethodConfig$/.test(className) && className !== 'SystemMethodConfig' && (address == null || /^k\./i.test(address));
}

/** One link line of a property definition's `generate(true)` text. */
const CLASS_LINK = /^c\.get\(\s*([A-Za-z_][A-Za-z0-9_]*)\.name\s*\)\.link\(\s*(_[A-Za-z0-9_]*)\s*\)$/;

/**
 * The classes a property definition is linked to, from its `generate(true)`
 * text: the `<Class>` of each `c.get(<Class>.name).link(_v)` line that links
 * the first statement's variable, as a set (sorted; BMP prints them in no
 * fixed order). Null for a text without a first statement.
 */
export function linkedClasses(generateText: string): string[] | null {
  const [first, ...rest] = splitStatements(generateText);
  if (!first) return null;
  const variable = /^(_[A-Za-z0-9_]*)\s*:=/.exec(first)?.[1];
  const set = new Set<string>();
  for (const st of rest) {
    const m = CLASS_LINK.exec(st);
    if (m && m[2] === variable) set.add(m[1]);
  }
  return [...set].sort();
}

/** The variable a property definition's Add assigns, for its link lines. */
export const PROPERTY_VARIABLE = '_pd';

/** The link line of a class: `c.get(<Class>.name).link(<target>)`, the form
 *  `generate(true)` prints. */
export const classLinkLine = (className: string, target: string): string => `c.get(${className}.name).link(${target})`;

// ── flow projects ───────────────────────────────────────────────────

/** A FlowProject's class. Its `genedit()` prints the project's own
 *  `change(…)`, then one `<p>.configObjects.item(n).change(…) //<Class>` per
 *  step, then one `<p>.transLinks.item(n).change(from := t.a, to := t.b)
 *  //TransLink` per link (measured on 5.6.17). */
export const FLOW_PROJECT = 'FlowProject';

/** A step of a flow project, as the project's text names it. */
export interface FlowStep { id: string; className?: string; args: string }
/** A link between two steps: their addresses. */
export interface FlowLink { from: string; to: string }

/** The project's own line, its steps in order and its links. */
export interface FlowText { line: GeneditLine; steps: FlowStep[]; links: FlowLink[] }

const FLOW_ITEM = /^(.+)\.(configObjects|transLinks)\.item\(\d+\)$/;

/**
 * A FlowProject's `genedit()` text: the first statement gives the
 * project's values, each `configObjects.item(n)` statement a step (its ID
 * from its `id := '…'` argument), each `transLinks.item(n)` statement a
 * link (`from` and `to` as addresses). Null for any other text.
 */
export function parseFlowText(text: string): FlowText | null {
  const [first, ...rest] = splitStatements(text);
  const line = first ? parseGenedit(first) : null;
  if (!line || line.className !== FLOW_PROJECT) return null;
  const steps: FlowStep[] = [];
  const links: FlowLink[] = [];
  for (const st of rest) {
    const l = parseGenedit(st);
    const m = l ? FLOW_ITEM.exec(l.address) : null;
    if (!l || !m || key(m[1]) !== key(line.address)) return null;
    if (m[2] === 'configObjects') {
      const id = decodeEcString(argumentText(l.args, 'id') ?? '');
      if (!id) return null;
      steps.push({ id, ...(l.className ? { className: l.className } : {}), args: withoutNeverCarried(l.args) });
    } else {
      const from = plainAddress(argumentText(l.args, 'from')), to = plainAddress(argumentText(l.args, 'to'));
      if (!from || !to) return null;
      links.push({ from, to });
    }
  }
  return { line, steps, links };
}

/** An object's `genedit()` text: one line (parseGenedit), or a FlowProject's
 *  several statements, of which the first gives its values. */
export function parseObjectText(text: string): GeneditLine | null {
  return parseGenedit(text) ?? parseFlowText(text)?.line ?? null;
}

/** A link of the steps of a flow project as the project's links text gives
 *  it: `<from ID>><to ID>`. */
export const flowPair = (l: FlowLink): string => `${idOfAddress(l.from)}>${idOfAddress(l.to)}`;

/** The pairs of a project's links text (measured: `transLinks.forEach(_i:
 *  _s := _s + str(_i.from.id) + ">" + str(_i.to.id) + ";")`), in order. */
export const flowPairsOf = (text: string): string[] => text.split(';').filter(x => x.includes('>'));

/** The lines that put the links text of `project` into `_s`, starting
 *  with `start`. A link without a step on one side gives an empty ID there
 *  (never a warning text): measured, after `genedit()` of a FlowProject its
 *  `transLinks` hold such links for the rest of the run. */
export const flowLinksEc = (project: string, start = '""'): string[] => [
  `_s := ${start}`,
  `${project}.transLinks.forEach(_i: _s := _s + str(_i.from.id.whenMissing("")) + ">" + str(_i.to.id.whenMissing("")) + ";")`,
];

/**
 * The guarded link of two steps of `project` (measured: `t.p.add(TransLink,
 * transLink, from := t.a, to := t.b)`): only when the project and both
 * steps exist and the project has no such link yet.
 */
export function flowLinkStatement(project: string, l: FlowLink): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  return [
    `IF ${project} != MISSING AND ${l.from} != MISSING AND ${l.to} != MISSING THEN`,
    ...flowLinksEc(project, '";"').map(x => i1 + x),
    `${i1}IF _s.indexOf(${ecString(`;${flowPair(l)};`)}).whenMissing(-1) < 0 THEN`,
    `${i2}${project}.add(TransLink, transLink, from := ${l.from}, to := ${l.to})`,
    `${i1}ELSE ""`,
    `${i1}ENDIF`,
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

// ── class configuration ─────────────────────────────────────────────

/** A visibility rule: a child of a ClassConfig, addressed `t.<ID>`. */
export const CONDITION_RULE = 'ConditionRule';

/** The address of a ClassConfig by its ID (the full class name, e.g.
 *  `com.corporater.bmp.model.model.enterprise.CeTask`): `c.get(CeTask.name)`;
 *  '' for an ID of another form. */
export function classConfigAddress(id: string): string {
  const name = id.trim().slice(id.trim().lastIndexOf('.') + 1);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `c.get(${name}.name)` : '';
}

/** The short class name of a ClassConfig ID. */
export const classNameOf = (id: string): string => id.trim().slice(id.trim().lastIndexOf('.') + 1);

/** The own values a linked property has on one class (its instance under
 *  the ClassConfig), without its `id`. */
export interface ClassInstance { className: string; values: Array<{ name: string; value: string }> }

/** `<size>:<text>` texts one after another, as the scripts print them. */
export function sizedTexts(text: string): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const m = /^(\d{1,9}):/.exec(text.slice(pos, pos + 11));
    if (!m) break;
    const start = pos + m[0].length;
    const size = Number(m[1]);
    if (start + size > text.length) break;
    out.push(text.slice(start, start + size));
    pos = start + size;
  }
  return out;
}

/**
 * The instances of property `propertyId` from the `genedit()` texts of
 * `k.<ID>.rref(linkedTo)` (sizedTexts): an instance's text is
 * `k.get('<ClassConfig ID>.<property ID>').change(id := '…', <own values>)`
 * (measured). By class, sorted; texts of another form are passed over.
 */
export function classInstances(texts: string, propertyId: string): ClassInstance[] {
  const out = new Map<string, ClassInstance>();
  const suffix = `.${propertyId.toLowerCase()}`;
  for (const t of sizedTexts(texts)) {
    const line = parseGenedit(t);
    const id = line ? decodeEcString(argumentText(line.args, 'id') ?? '') : undefined;
    if (!line || !id || !id.toLowerCase().endsWith(suffix)) continue;
    const className = classNameOf(id.slice(0, id.length - suffix.length));
    const pairs = argumentPairs(splitArguments(withoutNeverCarried(line.args)));
    if (!className || !pairs) continue;
    out.set(className, { className, values: pairs.filter(v => v.name.toLowerCase() !== 'id') });
  }
  return [...out.values()].sort((a, b) => (a.className < b.className ? -1 : a.className > b.className ? 1 : 0));
}

/** The lines that put the `genedit()` texts of a property's instances into
 *  `_v`, each `<size>:<text>` (measured: `k.get("x").rref(linkedTo)`
 *  lists them). */
export const instancesEc = (property: string, indent = ''): string[] => [
  `${indent}_v := ""`,
  `${indent}${property}.rref(linkedTo).forEach(_i:`,
  `${indent}${INDENT}_h := str(_i.genedit())`,
  `${indent}${INDENT}_v := _v + str(_h.size()) + ":" + _h`,
  `${indent})`,
];

/**
 * The change of a property's own values on one class (measured: `_x :=
 * str(c.get(CeTask.name).id) + ".<property ID>"`, then `k.get(_x)`
 * addresses the instance, also for `change`): guarded on the class and the
 * instance existing. `clear`: values to remove (not measured on an
 * instance; written only with "Remove values only the target has").
 */
export function instanceChangeStatement(property: string, className: string, set: string, clear: readonly string[] = []): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  return [
    `_lc := c.get(${className}.name)`,
    `IF _lc != MISSING AND ${property} != MISSING THEN`,
    `${i1}_lx := str(_lc.id) + "." + str(${property}.id)`,
    `${i1}_li := k.get(_lx)`,
    `${i1}IF _li != MISSING THEN`,
    ...(set ? [`${i2}k.get(_lx).change(${set})`] : []),
    ...clear.map(n => `${i2}k.get(_lx).clear(${n})`),
    `${i1}ELSE ""`,
    `${i1}ENDIF`,
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

// ── objects never listed ────────────────────────────────────────────

/** Classes never listed and never transported: logs are data. */
export const LOG_CLASSES: readonly string[] = ['CorpoLog', 'CorpoWarningLog'];

/** An object never listed in Find and never added on its own: a log, a
 *  system property, a ClassConfig, or the instance of a linked property
 *  under a ClassConfig (a linked copy of a property definition). */
export function isNeverListed(className: string, linkedTo?: string): boolean {
  return LOG_CLASSES.includes(className) || className === 'SystemMethodConfig' || className === 'ClassConfig'
    || (/MethodConfig$/.test(className) && !!linkedTo);
}

/** The class of a schedule: it runs on the target as it is set. */
export const SCHEDULE_CLASS = 'TransformerSchedule';

/** The receiver of a create statement (`[_v :=] <receiver>.add(…)`), when
 *  it is a plain dotted address. */
export function createParentAddress(statement: string): string | undefined {
  const body = statement.replace(/^_[A-Za-z0-9_]*\s*:=\s*/, '');
  const at = indexOutsideStrings(body, '.add(');
  if (at <= 0) return undefined;
  const receiver = body.slice(0, at).trim();
  return ADDRESS_SHAPE.test(receiver) ? receiver : undefined;
}

/** The arguments of a create statement (`[_v :=] <receiver>.add(<Class>,
 *  …)`) after its class, split at their top-level commas (splitArguments);
 *  undefined for another shape (no top-level `.add(`, not closed, text after
 *  it, or a first argument that is not a class name). */
export function createArgumentPieces(statement: string): string[] | undefined {
  const body = statement.trim().replace(/^_[A-Za-z0-9_]*\s*:=\s*/, '');
  const at = indexOutsideStrings(body, '.add(');
  if (at <= 0) return undefined;
  const open = at + '.add'.length;
  const close = matchClose(body, open);
  if (close < 0 || body.slice(close + 1).trim()) return undefined;
  const [cls, ...rest] = splitArguments(body.slice(open + 1, close));
  return cls && /^[A-Za-z_][A-Za-z0-9_]*$/.test(cls) ? rest : undefined;
}

/** `name := value` pairs of argument pieces, in order, each value trimmed;
 *  null when a piece has another form. */
export function argumentPairs(pieces: readonly string[]): Array<{ name: string; value: string }> | null {
  const out: Array<{ name: string; value: string }> = [];
  for (const piece of pieces) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]*)$/.exec(piece);
    if (!m) return null;
    out.push({ name: m[1], value: m[2].trim() });
  }
  return out;
}

/**
 * Does the create statement set exactly the values of the genedit arguments
 * `args`: the same names, written the same, with the same value texts, in
 * any order? A name given twice on either side, or an argument of another
 * form, makes them not the same. Measured on a real folder: for every one of
 * 353 objects the creation statement's arguments were those of its
 * genedit(), so an object a patch adds needs no Change after its Add. The
 * patch relies on that only when this comparison holds.
 */
export function createSetsValues(statement: string, args: string): boolean {
  // A step's Add names its collection (`configObject`) before its values.
  const pieces = createArgumentPieces(statement)?.filter(x => x !== 'configObject' && x !== 'transLink');
  const created = pieces ? argumentPairs(pieces) : null;
  const values = argumentPairs(splitArguments(args));
  if (!created || !values || created.length !== values.length) return false;
  const byName = new Map<string, string>();
  for (const c of created) {
    if (byName.has(c.name)) return false;
    byName.set(c.name, c.value);
  }
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v.name) || byName.get(v.name) !== v.value) return false;
    seen.add(v.name);
  }
  return true;
}

// ── addresses ───────────────────────────────────────────────────────

/** A dotted address without spaces, quotes or brackets (`t.x`,
 *  `root.property`, `cepro.108`). */
const ADDRESS_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

/** An ID written bare after its space: a letter or underscore first, then
 *  letters, digits and underscores; or digits only. */
const PLAIN_ID = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/;

/** An ID that can be written into a script: no line break or other control
 *  character. */
/** Does `id` have a character, and no line break or other control character? */
export function writableId(id: string): boolean {
  if (!id) return false;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 32 || c === 127) return false;
  }
  return true;
}
const WRITABLE_ID = { test: writableId };

/** An ID space: a name. */
const SPACE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The address of the object with ID `id` in ID space `space`: `<space>.<ID>`
 * for a plain ID (PLAIN_ID: short), else `<space>.get("<ID>")` with `\` and
 * `"` escaped (measured on 5.6.17 for `crev-qa-dash`, `crev qa space`,
 * `crev.qa.dot`, quotes, `/#:()`, `Äö`, a digit first; on 5.6.10 for
 * `ap.get("Everyone profile")`). '' when the ID cannot be written
 * (WRITABLE_ID) or the space is not a name.
 */
export function addressOf(space: string, id: string): string {
  if (!SPACE.test(space) || !id || !WRITABLE_ID.test(id)) return '';
  return PLAIN_ID.test(id) ? `${space}.${id}` : `${space}.get("${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

/** Is `id` written bare after its space (PLAIN_ID)? */
export const isPlainId = (id: string): boolean => PLAIN_ID.test(id);

/** An ID a loop over IDs may hold: it can be written, and its address can
 *  be shown from it in the script (no `"` or `\`, which addressOf escapes),
 *  nor `|` or `=` (the keyed text of the Check). */
export const isLoopId = (id: string): boolean => writableId(id) && !/["\\|=]/.test(id);

/** The address of the loop's `_x` as the script shows it in a message, the
 *  way addressOf writes it: `"t." + _x` for plain IDs, `"t.get(\"" + _x +
 *  "\")"` for the others (a loop holds one kind or the other). */
export const shownAddressEc = (space: string, plain: boolean, v = '_x'): string => (plain
  ? `${ecString(`${space}.`)} + ${v}`
  : `${ecString(`${space}.get("`)} + ${v} + ${ecString('")')}`);

/** `<space>.get("…")` or `<space>.get('…')`. */
const GET_FORM = /^([A-Za-z_][A-Za-z0-9_]*)\.get\(\s*("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')\s*\)$/;

/** The space and ID of an address: `<space>.<ID>` (one dot, a plain ID) or
 *  `<space>.get("<ID>")`; null for any other text. */
export function splitAddress(address: string | undefined): { space: string; id: string } | null {
  const t = (address ?? '').trim();
  const g = GET_FORM.exec(t);
  if (g) {
    const id = decodeEcString(g[2]);
    return id ? { space: g[1], id } : null;
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]+)$/.exec(t);
  return m ? { space: m[1], id: m[2] } : null;
}

/** An address as given when it is one (a dotted address, or a
 *  `.get("…")` form, written the way addressOf writes it), else ''. For
 *  addresses read from the server before they are written into a script. */
export function plainAddress(text: string | undefined): string {
  const t = (text ?? '').trim();
  if (ADDRESS_SHAPE.test(t)) return t;
  const g = GET_FORM.test(t) ? splitAddress(t) : null;
  return g ? addressOf(g.space, g.id) : '';
}

/** The ID of an address (`t.x` → `x`, `t.get("a-b")` → `a-b`), '' for
 *  anything else. */
export function idOfAddress(address: string | undefined): string {
  return splitAddress(address)?.id ?? '';
}

/** The `root.<name>` of a root's ID (`PORTAL` → `root.portal`), without
 *  regard to case; '' for an ID that names none of TRANSPORT_ROOTS. */
export function rootAddressOf(id: string): string {
  const name = TRANSPORT_ROOTS.find(r => r.toLowerCase() === id.trim().toLowerCase());
  return name ? `root.${name}` : '';
}

export type AddressCheck =
  | { ok: true; space: string; id: string; numeric: boolean }
  | { ok: false; reason: string };

export const UNADDRESSABLE_REASON = 'Its ID has a character that cannot be written into a script.';

/**
 * Is `address` an address of one object (`<space>.<ID>` or
 * `<space>.get("<ID>")`, splitAddress)? An ID of digits only can be
 * addressed (`cepro.108`) but is reported as a warning: such IDs are often
 * numbered per workspace and may name another object on the target.
 */
export function checkAddress(address: string): AddressCheck {
  const a = splitAddress(address);
  if (!a) return { ok: false, reason: 'Its address is not of the form <space>.<ID>, so it cannot be addressed.' };
  if (!WRITABLE_ID.test(a.id)) return { ok: false, reason: UNADDRESSABLE_REASON };
  return { ok: true, space: a.space, id: a.id, numeric: /^\d+$/.test(a.id) };
}

/** Lower case: IDs are case-insensitive in BMP. An address of one object is
 *  first written the way addressOf writes it. */
const key = (address: string) => {
  const a = splitAddress(address);
  return (a ? addressOf(a.space, a.id) || address : address).trim().toLowerCase();
};

// ── references ──────────────────────────────────────────────────────

/** `<space>.<ID>` with one of the ID spaces a value may name. */
const REFERENCE = /([tkoug])\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** `<space>.get("<ID>")` or `<space>.get('<ID>')` with a quoted text: a use of
 *  that object (`t.get(` followed by anything else is a call). */
const GET_REFERENCE = /([tkoug])\.get\(\s*(\\?["'])((?:(?!\2)[^\n])*?)\2\s*\)/g;

/** Is the character before `i` part of another name? A letter, digit, `_`
 *  or `.` is, except the letter of an escape `\n`, `\r`, `\t` (an odd number
 *  of backslashes before it), which ends a line of code in a string. */
function joinedToName(text: string, i: number): boolean {
  const c = text[i - 1];
  if (!c || !/[A-Za-z0-9_.]/.test(c)) return false;
  if (!/[nrt]/.test(c)) return true;
  let slashes = 0;
  for (let j = i - 2; j >= 0 && text[j] === '\\'; j--) slashes++;
  return slashes % 2 === 0;
}

/**
 * The addresses the arguments of a genedit line name: tokens `<space>.<ID>`
 * (space `t`, `k`, `o`, `u` or `g`; an ID that starts with a letter or `_`)
 * anywhere in the text, so in a reference value (`listPropertySet :=
 * t.my_lps`), a list (`LIST(t.a, t.b)`) and code inside a string
 * (`expression := 't.a.name + k.b'`, escaped quotes included). A token right
 * after a letter, digit, `_` or `.` belongs to another name (`_t.name`,
 * `root.t.x`, `list.k.y`) and does not count, nor does a token right before
 * `(` (a call: `t.get("x")`, `u.delete()` on a variable in code). Without `own` and repeats (by
 * lower-case address, the first spelling kept), sorted by lower-case address.
 */
export function argumentReferences(args: string, own = ''): string[] {
  const found = new Map<string, string>();
  for (const m of args.matchAll(REFERENCE)) {
    if (joinedToName(args, m.index)) continue;
    // A call (`t.get(…)`, `u.delete()` on a variable in code) names no object.
    if (args[m.index + m[0].length] === '(') continue;
    const k = key(m[0]);
    if (k !== key(own) && !found.has(k)) found.set(k, m[0]);
  }
  for (const m of args.matchAll(GET_REFERENCE)) {
    if (joinedToName(args, m.index)) continue;
    // Inside a string its quotes are escaped (\'…\'): the ID is the text between.
    const id = m[3].replace(/\\(u[0-9A-Fa-f]{4}|[^u])/g, (_all, c: string) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c));
    const a = id ? addressOf(m[1], id) : '';
    if (a && key(a) !== key(own) && !found.has(key(a))) found.set(key(a), a);
  }
  // A visibility rule's `operations` name properties as text
  // ('H#security_objectives'): each is a used property `k.<name>`.
  for (const a of operationProperties(args)) if (!found.has(key(a))) found.set(key(a), a);
  return [...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, a]) => a);
}

/** The properties the `operations` value names (`'<letter>#<property ID>'`),
 *  as `k.<ID>`. */
export function operationProperties(args: string): string[] {
  const ops = argumentText(args, 'operations');
  if (!ops) return [];
  return [...new Set([...ops.matchAll(/'[A-Za-z]#([A-Za-z_][A-Za-z0-9_]*)'/g)].map(m => `k.${m[1]}`))];
}

/** The addresses the values of a `genedit()` text refer to, without the
 *  object's own (argumentReferences); none for a text of another form. */
export function referencedAddresses(genedit: string): string[] {
  const line = parseObjectText(genedit);
  return line ? argumentReferences(line.args, line.address) : [];
}

/** An address objects refer to, and those that refer to it. */
export interface OutsideReference {
  address: string;
  /** The addresses that refer to it, sorted. */
  by: string[];
}

/**
 * The addresses `objects` refer to that are none of theirs: one entry per
 * address (by lower-case address), sorted, each with the objects that refer
 * to it, sorted. Deterministic.
 */
export function outsideReferences(objects: ReadonlyArray<{ address: string; args: string }>): OutsideReference[] {
  const inside = new Set(objects.map(o => key(o.address)));
  const out = new Map<string, { address: string; by: Map<string, string> }>();
  for (const o of objects) {
    for (const a of argumentReferences(o.args, o.address)) {
      const k = key(a);
      if (inside.has(k)) continue;
      const entry = out.get(k) ?? { address: a, by: new Map<string, string>() };
      out.set(k, entry);
      if (!entry.by.has(key(o.address))) entry.by.set(key(o.address), o.address);
    }
  }
  const sorted = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  return sorted(out).map(e => ({ address: e.address, by: sorted(e.by) }));
}

/**
 * The parents of `objects` (addresses `<space>.<ID>` of the spaces a value
 * may name; roots are not) that are none of theirs nor in `others`: one entry per parent,
 * sorted, each with the objects under it, sorted. Deterministic.
 */
export function outsideParents(objects: ReadonlyArray<{ address: string; parent: string }>, others: readonly string[] = []): OutsideReference[] {
  const inside = new Set([...objects.map(o => o.address), ...others].map(key));
  return outsideReferences(objects.map(o => ({ address: o.address, args: o.parent })).filter(o => o.args))
    .filter(r => !inside.has(key(r.address)));
}

/** Do the values `args` of `own` refer to one of the addresses in `keys`
 *  (lower case)? */
export function refersToAny(args: string, own: string, keys: ReadonlySet<string>): boolean {
  return keys.size > 0 && argumentReferences(args, own).some(a => keys.has(key(a)));
}

/** "t.y" or "t.y (and 2 more)": who refers to an address. */
export const referrersText = (by: readonly string[]): string => `${by[0] ?? ''}${by.length > 1 ? ` (and ${by.length - 1} more)` : ''}`;

/**
 * `items` with every parent before its children (stable: otherwise in the
 * given order). A parent is matched by address without regard to case; a
 * parent that is not among the items, and a cycle, change nothing.
 */
export function orderParentsFirst<T>(items: readonly T[], addressOf: (item: T) => string, parentOf: (item: T) => string | undefined): T[] {
  const at = new Map<string, number>();
  items.forEach((item, i) => { const k = key(addressOf(item)); if (!at.has(k)) at.set(k, i); });
  const state = new Array<0 | 1 | 2>(items.length).fill(0);
  const out: T[] = [];
  const visit = (i: number) => {
    if (state[i]) return;
    state[i] = 1;
    const parent = parentOf(items[i]);
    const p = parent ? at.get(key(parent)) : undefined;
    if (p != null && p !== i) visit(p);
    state[i] = 2;
    out.push(items[i]);
  };
  items.forEach((_, i) => visit(i));
  return out;
}

/** A min-heap of numbers (positions). */
class PositionHeap {
  private readonly a: number[] = [];
  get size(): number { return this.a.length; }
  push(v: number): void {
    const a = this.a;
    a.push(v);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The objects to add, in the order their Add statements run: every parent
 * before its children (orderParentsFirst, whose order also breaks every tie)
 * and, where that allows, an object another one refers to (argumentReferences
 * of `argsOf`) before the one that refers to it. A reference between an
 * object and one above or below it is not followed: the parent comes first
 * anyway. Where references go round in a cycle, the first object of the
 * parents-first order that is ready goes first. Deterministic.
 */
export function orderForAdd<T>(items: readonly T[], addressOf: (item: T) => string, parentOf: (item: T) => string | undefined, argsOf: (item: T) => string): T[] {
  const base = orderParentsFirst(items, addressOf, parentOf);
  const n = base.length;
  const at = new Map<string, number>();
  base.forEach((item, i) => { const k = key(addressOf(item)); if (!at.has(k)) at.set(k, i); });
  // A parent edge only forward in the parents-first order (a cycle of
  // parents is cut there, as orderParentsFirst cuts it).
  const parent = base.map((item, i) => { const p = parentOf(item); const j = p ? at.get(key(p)) : undefined; return j != null && j < i ? j : -1; });
  const above = (a: number, d: number) => { for (let x = parent[d]; x >= 0; x = parent[x]) if (x === a) return true; return false; };
  const children: number[][] = base.map(() => []);
  const referrers: number[][] = base.map(() => []);
  const waitParent = new Int32Array(n);
  const waitRefs = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (parent[i] >= 0) { children[parent[i]].push(i); waitParent[i] = 1; }
    const refs = new Set<number>();
    for (const r of argumentReferences(argsOf(base[i]), addressOf(base[i]))) {
      const j = at.get(key(r));
      if (j == null || j === i || refs.has(j) || above(i, j) || above(j, i)) continue;
      refs.add(j);
      referrers[j].push(i);
    }
    waitRefs[i] = refs.size;
  }
  const ready = new PositionHeap();
  const early = new PositionHeap();
  const placed = new Uint8Array(n);
  const queue = (i: number) => (waitRefs[i] === 0 ? ready : early).push(i);
  for (let i = 0; i < n; i++) if (!waitParent[i]) queue(i);
  const out: T[] = [];
  while (out.length < n) {
    let i: number | undefined;
    do i = ready.size ? ready.pop() : early.pop(); while (i != null && placed[i]);
    if (i == null) break;
    placed[i] = 1;
    out.push(base[i]);
    for (const c of children[i]) if (--waitParent[c] === 0) queue(c);
    for (const c of referrers[i]) if (--waitRefs[c] === 0 && !waitParent[c] && !placed[c]) ready.push(c);
  }
  return out;
}

/**
 * The objects of `ordered` (in the order they are added) whose values refer
 * to an object added with or after them: itself, or one later in the order.
 * Such a reference cannot resolve when the object is added, so it is changed
 * again after every Add. A cycle of references always has such an object.
 */
export function refersToLaterAdded<T>(ordered: readonly T[], addressOf: (item: T) => string, argsOf: (item: T) => string): Set<T> {
  const at = new Map<string, number>();
  ordered.forEach((item, i) => { const k = key(addressOf(item)); if (!at.has(k)) at.set(k, i); });
  const out = new Set<T>();
  ordered.forEach((item, i) => {
    if (argumentReferences(argsOf(item)).some(a => (at.get(key(a)) ?? -1) >= i)) out.add(item);
  });
  return out;
}

// ── text for Extended Code ──────────────────────────────────────────

/** A single-quoted Extended Code string literal in the form generated text
 *  uses: backslash and single quote escaped, a line break (CR LF, CR or LF)
 *  written as `\n`. */
export function ecSingleQuoted(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\r\n?|\n/g, '\\n')}'`;
}

/** Whitespace as Java's `Character.isWhitespace` sees it (no non-breaking
 *  spaces). */
const WS = '[' + [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x1c, 0x1d, 0x1e, 0x1f, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x205f, 0x3000]
  .map(c => '\\u' + c.toString(16).padStart(4, '0')).join('') + ']+';
const STRIP_EDGE = new RegExp(`^${WS}|${WS}$`, 'g');

/** A generated text without the whitespace at its ends (the server returns
 *  it with one line break before and one after): what the exact comparison
 *  compares. The server's own `strip()` is not used for this: measured, it
 *  also removes markup and decodes entities inside the text. */
export function stripLikeServer(text: string): string {
  return text.replace(STRIP_EDGE, '');
}

/**
 * Lines that compare the whole generated text of `address` (an object that
 * exists) with `expected` exactly, then run `same` or `differs`. Measured in
 * preview runs: the text as returned is the expected text plus one character
 * before and one after, so `_g.size() = _e.size() + 2 AND
 * _g.indexOf(_e).whenMissing(-1) = 1` is true for identical text and false
 * when one character differs, for code with quotes, line breaks, markup,
 * entities and dated values. `=` between texts is not used: `*` and `?` on
 * its right side are wildcards. Preview runs only: `genedit()` is refused in
 * a committed run.
 */
export function exactTextEc(address: string, expected: string, same: readonly string[], differs: readonly string[], indent = '', short = false): string[] {
  const inner = indent + INDENT;
  return [
    // `short`: a file whose content is not carried, compared without it.
    `${indent}_g := str(${address}.${short ? FILE_VALUES : 'genedit()'})`,
    `${indent}_e := ${ecString(stripLikeServer(expected))}`,
    `${indent}IF _g.size() = _e.size() + 2 AND _g.indexOf(_e).whenMissing(-1) = 1 THEN`,
    ...same.map(l => inner + l),
    `${indent}ELSE`,
    ...differs.map(l => inner + l),
    `${indent}ENDIF`,
  ];
}

// ── files ───────────────────────────────────────────────────────────

/** A file's values without its content (measured on 5.6.17:
 *  `genedit(id, name)` of a FileResource prints them without `content`). */
export const FILE_VALUES = 'genedit(id, name)';

/** The default and the range of "up to n KB" (the cap of one script part,
 *  FILE_PART_ROOM, is the real maximum). */
export const FILE_LIMIT_KB_DEFAULT = 19;
export const FILE_LIMIT_KB_MIN = 1;
export const FILE_LIMIT_KB_MAX = 19;

/** Characters of a file's text that still fit in one script part with its
 *  header and guards (parts stay at BUNDLE_PART_LIMIT). */
export const FILE_PART_ROOM = 19_000;

/** The limit in KB, as a whole number within its range. */
export function fileLimitKb(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(FILE_LIMIT_KB_MAX, Math.max(FILE_LIMIT_KB_MIN, Math.round(n))) : FILE_LIMIT_KB_DEFAULT;
}

/**
 * The characters of a file's generated text whose content is still read
 * and carried: the limit (KB here means 1,000 characters of the generated
 * text, the content as gzip-base64 text, not the file's size on disk), and
 * never more than fits in one script part.
 */
export const fileLimitChars = (kb: number): number => Math.min(fileLimitKb(kb) * 1_000, FILE_PART_ROOM);

/** What happens to a file's content: carried, or not carried because the
 *  text is over the limit (`part`: within the limit but over one part). */
export function fileContent(size: number, kb: number): { carried: boolean; part: boolean } {
  if (size <= fileLimitChars(kb)) return { carried: true, part: false };
  return { carried: false, part: size <= fileLimitKb(kb) * 1_000 };
}

/** "412 KB": characters of the generated text in thousands; "under 1 KB"
 *  below 1,000 characters. */
export const sizeKb = (size: number): string => (size < 1_000 ? 'under 1 KB' : `${Math.round(size / 1_000).toLocaleString('en-US')} KB`);

/** A file added without its content: the person uploads it afterwards. */
export interface UploadFile {
  rid: string;
  address: string;
  /** Its name (the file name). */
  name: string;
  /** Characters of its generated text; absent when it was not measured
   *  (file content off). */
  size?: number;
}

/** "t.x (logo.png, 412 KB)", "t.x (logo.png)" without a size. */
export const uploadText = (u: UploadFile): string => `${u.address} (${oneLine(u.name) || 'no name'}${u.size != null ? `, ${sizeKb(u.size)}` : ''})`;

/** The comment lines of the files to upload afterwards. */
export const uploadLines = (uploads: readonly UploadFile[]): string[] => uploads.map(u => `// Upload afterwards: ${uploadText(u)}`);

/** The file a prepared object is, when its content is not carried. */
export function uploadOf(p: PreparedObject): UploadFile | null {
  const f = p.input.file;
  return f && !f.carried ? { rid: p.input.rid, address: p.address, name: p.name ?? '', ...(f.size != null ? { size: f.size } : {}) } : null;
}

// ── values never carried ────────────────────────────────────────────

/**
 * Value names never carried and never compared. `steadfastAgentConfiguration`:
 * BMP 5.6.17 prints it in generated text but refuses to write it ("Failed to
 * write"), and a 5.6.10 target does not have it, so carrying it would leave
 * a difference after every apply.
 */
export const NEVER_CARRIED: readonly string[] = ['steadfastAgentConfiguration'];

/** Arguments `name := value` without the names of NEVER_CARRIED. */
export function withoutNeverCarried(args: string): string {
  const pieces = splitArguments(args);
  const kept = pieces.filter(x => !NEVER_CARRIED.some(n => new RegExp(`^${n}\\s*:=`, 'i').test(x)));
  return kept.length === pieces.length ? args : kept.join(', ');
}

/** A generated text with its arguments without NEVER_CARRIED, for comparing
 *  (the text itself when it has another form). */
export function comparableText(text: string): string {
  // A flow project: its first statement (its steps are compared as their own objects).
  const line = parseObjectText(text);
  return line ? `${line.address}.change(${withoutNeverCarried(line.args)})${line.className ? ` //${line.className}` : ''}` : text;
}

/** The comment line of an Add of a file to upload, for the top of its part. */
export function uploadComment(p: PreparedObject): { comment?: string[] } {
  const u = uploadOf(p);
  return u ? { comment: uploadLines([u]) } : {};
}

/** An object a committed part checks before it changes anything. */
export interface IdentityGuard {
  address: string;
  /** The class the object must have when it exists. */
  className: string;
}

/** The first line of a part's guards: the list of objects of another class. */
export const GUARD_OPEN = '_w := ""';

/** The last line of a part's guards: one error for every object of another
 *  class. Measured: an `error()` in a committed run fails it and nothing of
 *  that run is stored (the lines after it still run and print, but are
 *  discarded); `x.className` works in committed runs. */
export const GUARD_CLOSE = 'IF _w.size() > 0 THEN error(\'Other classes than expected:\' + _w + \'. Nothing in this part was applied.\') ELSE "" ENDIF';

/**
 * The guard line of one object: when it exists with another class, its
 * address and class are added to `_w` (GUARD_OPEN); GUARD_CLOSE then fails
 * the run once for all of them.
 */
export function identityGuardEc(g: IdentityGuard): string {
  const a = g.address;
  return `IF ${a} != MISSING AND ${a}.className != ${ecSingleQuoted(g.className)} THEN _w := _w + ${ecSingleQuoted(` ${a} (`)} + str(${a}.className) + ')' ELSE "" ENDIF`;
}

/** Guards of one class and ID space that go into one loop at least (a loop
 *  costs about as much as two guard lines). */
export const GUARD_LOOP_MIN = 3;

/**
 * The guard lines of objects: GUARD_OPEN, then per class and ID space with
 * at least GUARD_LOOP_MIN objects one loop over their IDs (measured:
 * `list("a", "b").forEach(_x:` with `_o := t.get(_x)`), else one line per
 * object, then GUARD_CLOSE; none without objects. The loop adds each object
 * of another class to `_w` as the line does: its address as addressOf
 * writes it, and its class.
 */
export function guardBlockEc(guards: readonly IdentityGuard[]): string[] {
  if (!guards.length) return [];
  const groups = new Map<string, { space: string; plain: boolean; className: string; ids: string[] }>();
  const single: IdentityGuard[] = [];
  for (const g of guards) {
    const a = splitAddress(g.address);
    if (!a || !isLoopId(a.id)) { single.push(g); continue; }
    const plain = isPlainId(a.id);
    const k = `${a.space}\u0000${plain ? 'p' : 'g'}\u0000${g.className}`;
    const e = groups.get(k) ?? { space: a.space, plain, className: g.className, ids: [] };
    e.ids.push(a.id);
    groups.set(k, e);
  }
  const lines: string[] = [];
  for (const e of groups.values()) {
    if (e.ids.length < GUARD_LOOP_MIN) { for (const id of e.ids) single.push({ address: addressOf(e.space, id), className: e.className }); continue; }
    lines.push(
      `list(${e.ids.map(id => ecString(id)).join(', ')}).forEach(_x:`,
      `${INDENT}_o := ${e.space}.get(_x)`,
      `${INDENT}IF _o != MISSING AND _o.className != ${ecSingleQuoted(e.className)} THEN _w := _w + " " + ${shownAddressEc(e.space, e.plain)} + " (" + str(_o.className) + ")" ELSE "" ENDIF`,
      ')',
    );
  }
  // The single lines in the order the objects came.
  const order = new Map(guards.map((g, i) => [key(g.address), i]));
  single.sort((x, y) => (order.get(key(x.address)) ?? 0) - (order.get(key(y.address)) ?? 0));
  return [GUARD_OPEN, ...single.map(identityGuardEc), ...lines, GUARD_CLOSE];
}

// ── the bundle ──────────────────────────────────────────────────────

/** One object to bundle: the scan row's facts plus the text read for it
 *  (transport-read.ts readTransportObjects). */
export interface BundleInput {
  rid: string;
  /** The business ID from the scan. */
  id: string;
  /** The name from the scan (used when the genedit text has none). */
  name?: string;
  className: string;
  /** Created on or after the scan's day: the bundle creates it when it is
   *  missing and puts it back in its place among its siblings. A patch
   *  creates every object the target lacks, new or not. */
  isNew: boolean;
  /** `generate(true)`, read for a property definition only (its links). */
  generate?: string;
  /** `genedit()`. */
  genedit?: string;
  /** The parent's address ('' when unknown). */
  parentAddress?: string;
  /** The previous sibling's address ('' for the first). */
  previousAddress?: string;
  /** The next sibling's address ('' for the last). */
  nextAddress?: string;
  /** The parent's ID as BMP prints it (a root's is its upper-case name,
   *  `PORTAL`); '' when unknown. */
  parentId?: string;
  /** The parent is a root (`root.<name>`). */
  parentIsRoot?: boolean;
  /** A system object: BMP refuses to move it. */
  systemObject?: boolean;
  /** Its parent and siblings could not be read (its own text could): its
   *  place among its siblings is not restored. */
  neighboursError?: string;
  /** Why its text could not be read. */
  readError?: string;
  /** Why the `generate(true)` text of a property definition could not be read. */
  creationError?: string;
  /** A linked copy: the ID of its template. It is never added (its
   *  `generate(true)` text adds a plain object without the link, and its
   *  values would add an unlinked duplicate); where the target has it, only
   *  its own values are changed. */
  linkedTo?: string;
  /** Under the Templates area: a change of it reaches every linked copy. */
  template?: boolean;
  /** A step of a flow project (its parent is a FlowProject and it is one of
   *  the project's `configObjects`): added with `configObject`, never moved. */
  flowStep?: boolean;
  /** A property definition: the `genedit()` texts of its instances
   *  (`<size>:<text>` each, sizedTexts), read with `generate`. */
  instances?: string;
  /** A file (FileResource), measured: the characters of its whole generated
   *  text, and whether its content is carried. When it is not, `genedit`
   *  holds its values without the content, it is added from its ID and name
   *  without content, and its content is never compared. */
  file?: { size?: number; carried: boolean };
}

export type LeftOutReason =
  | 'unaddressable' | 'no-text' | 'unreadable'
  /** Patch only: the target holds an object of another class there. */
  | 'class-mismatch'
  /** Patch only: its parent is neither on the target nor created by it. */
  | 'parent-missing'
  /** Patch only: a linked copy the target lacks (it is made by a link). */
  | 'linked-copy'
  /** Patch only: its type is switched off on the target. */
  | 'type-off';

export interface LeftOutObject {
  rid: string;
  id: string;
  className: string;
  /** The address, when one was read. */
  address?: string;
  reason: LeftOutReason;
  /** One sentence for the person. */
  detail: string;
}

export type BundleWarningKind =
  | 'numeric-id' | 'oversize'
  /** A created object whose neighbours could not be read: not ordered. */
  | 'no-order'
  /** Patch: values the target has are kept (`clearExtra` off). */
  | 'kept-values'
  /** Patch: the values could not be compared one by one: the whole line is set. */
  | 'whole-line'
  /** An address the objects refer to that is not coming along: bundle, every
   *  one; patch, those missing on the target. */
  | 'outside-reference'
  /** Patch: an object under another parent on the target is left where it is. */
  | 'no-move'
  /** Patch: the listing of the target was cut, so nothing counts as only there. */
  | 'listing'
  /** Scripts without comparison: objects under Templates get every value written. */
  | 'template'
  /** Scripts without comparison: the parent of an object to add is not in the transport. */
  | 'outside-parent';

export interface BundleWarning {
  kind: BundleWarningKind;
  /** The object it is about (numeric-id, no-order, kept-values, whole-line). */
  rid?: string;
  /** That object's address, or the address referred to (outside-reference). */
  address?: string;
  /** The part it is about (oversize), 1-based. */
  part?: number;
  /** outside-parent: the addresses of the objects under it. */
  by?: string[];
  detail: string;
}

export type BundleStep = 'create' | 'set' | 'link' | 'own' | 'setAgain' | 'order' | 'report';

export interface BundlePart<S extends string = BundleStep> {
  /** 1-based position among all parts. */
  index: number;
  total: number;
  step: S;
  /** Position within its step's parts (1-based) and their count. */
  stepIndex: number;
  stepTotal: number;
  /** Run committed (create, values, order, record) or as a preview (check,
   *  report, probe). */
  run: 'committed' | 'preview';
  /** Statements in it (an IF block counts one; an object's change and
   *  clear lines count one), guards not counted. */
  statements: number;
  /** Identity guards at its top (committed parts). */
  guards: number;
  /** The script, header included, ending in a line break. */
  text: string;
  /** One statement longer than the part limit: this part is over it. */
  oversize?: true;
  /** The lines (1-based, inclusive) of each statement about one object, to
   *  name the object of a line BMP names in a message. */
  spans?: Array<{ from: number; to: number; address: string }>;
}

/** An object the bundle carries. */
export interface BundledObject {
  rid: string;
  address: string;
  className: string;
  isNew: boolean;
  /** The name in its generated text (or the scan's). */
  name?: string;
}

export interface TransportBundle {
  /** Files added without their content where the target lacks them. */
  uploads: UploadFile[];
  /** Steps of flow projects of the transport that are not in it (`t.<ID>`). */
  flowSteps: string[];
  parts: BundlePart[];
  objects: BundledObject[];
  leftOut: LeftOutObject[];
  warnings: BundleWarning[];
  /** The fixed notes, always shown above the bundle. */
  notes: readonly string[];
  /** Comment lines above the parts in the whole text: counts, how to run,
   *  the notes, the left-out objects and warnings. */
  preamble: string;
  /** The preamble and every part: what "copy all" and the download take. */
  text: string;
}

/** Said above every bundle. */
export const BUNDLE_NOTES: readonly string[] = Object.freeze([
  'Deletes are not part of these scripts: an object deleted here stays on the target.',
  'Secrets and files are not part of these scripts.',
  'Every committed part first checks the class of each object it addresses. When one differs, the run fails and nothing of that part is stored.',
  'Values the target has and this workspace does not are kept, and values that use objects that are neither in this transport nor on the target do not resolve. The report compares the whole generated text, so such an object shows as DIFFERENT.',
  'Only added objects are moved into their place. To move objects the target already has, compare with the target instead.',
]);

/** What a step does, for the header of its parts. */
export interface StepSpec {
  title: string;
  does: string;
  run: 'committed' | 'preview';
  /** Ends "Safe to run again: …". */
  again: string;
  /** Replaces the "Run … Safe to run again" line. */
  runLine?: string;
}

/** The step that changes the own values of linked properties per class. */
export const OWN_STEP: StepSpec = { title: 'Change per class', does: 'Changes the values a property definition has of its own on each class it is linked to.', run: 'committed', again: 'it changes to the same values' };

const STEPS: Readonly<Record<BundleStep, StepSpec>> = {
  create: { title: 'Add', does: 'Adds the objects the target lacks, parents before children.', run: 'committed', again: 'it adds only what is missing' },
  set: { title: 'Change', does: 'Changes every object of this transport to its values here.', run: 'committed', again: 'it changes to the same values' },
  link: { title: 'Link', does: 'Links the steps of flow projects as they are linked here. A link the target has already is not added again.', run: 'committed', again: 'it links only steps not linked yet' },
  own: OWN_STEP,
  setAgain: { title: 'Change (uses added objects)', does: 'Changes again the added objects that use one added after them, and the other objects that use an added one, so that these values resolve.', run: 'committed', again: 'it changes to the same values' },
  order: { title: 'Move', does: 'Moves the added objects into their place among their siblings.', run: 'committed', again: 'it moves only objects that exist' },
  report: { title: 'Report', does: 'Prints one line per object: ok, MISSING, or DIFFERENT (its whole generated text compared with this workspace\'s), then the counts.', run: 'preview', again: 'it changes nothing' },
};

const INDENT = '     ';

/** Text for a comment line: no line breaks. */
export const oneLine = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').trim();

/** One input, read and checked (shared with transport-patch.ts). */
export interface PreparedObject {
  input: BundleInput;
  line: GeneditLine;
  address: string;
  /** The class its text names, else the scan's. */
  className: string;
  /** Its genedit text without the whitespace at its ends. */
  text: string;
  create?: CreateBlock;
  /** A property definition: the classes it is linked to here (its
   *  `generate(true)` text), sorted; absent when that text was not read. */
  links?: string[];
  /** A property definition: its own values per class (its instances). */
  instances?: ClassInstance[];
  /** A flow project: its steps and links. */
  flow?: { steps: FlowStep[]; links: FlowLink[] };
  name?: string;
  /** Parent address: the one read, else the create statement's receiver. */
  parent: string;
  /** The parent's ID: the one read, else that of its address ('' when unknown). */
  parentId: string;
  /** The parent is a root: read so, or its address is `root.<name>`. */
  parentIsRoot: boolean;
  previous: string;
  next: string;
}

/** Sort key of a left-out object (by ID, then RID): deterministic whatever
 *  the input order. */
const leftOutKey = (o: LeftOutObject) => `${o.id.toLowerCase()}\u0000${o.rid.padStart(21, '0')}`;

/** Sort left-out objects by ID, then RID. */
export function sortLeftOut(list: LeftOutObject[]): LeftOutObject[] {
  return list.sort((a, b) => (leftOutKey(a) < leftOutKey(b) ? -1 : leftOutKey(a) > leftOutKey(b) ? 1 : 0));
}

/** Why a system object is not carried or added. */
export const SYSTEM_OBJECT_DETAIL = 'A system object: BMP makes it itself, so it is not added.';

/** Why a log is not carried. */
export const LOG_DETAIL = 'A log entry is data: it is not transported.';

/** Why an object whose parent is not known is not added. */
export const NO_PARENT_DETAIL = 'Its parent could not be read, so it cannot be added.';

/** Prepare one input: the object, or why it is left out. `needCreate`: a
 *  new object that cannot be added is left out (the bundle); otherwise the
 *  create block is made whenever it can be (the patch). The Add of an
 *  object is `<parent>.add(<Class>, <genedit arguments>)`; of a file whose
 *  content is not carried, its ID and name only; of a property definition,
 *  that Add assigned to PROPERTY_VARIABLE and one link line per class of its
 *  `generate(true)` text. A linked copy and a system object are never
 *  added. */
function prepare(given: BundleInput, needCreate: boolean): PreparedObject | LeftOutObject {
  // A linked copy and a system object are never added.
  const input = (given.linkedTo || given.systemObject) && given.isNew ? { ...given, isNew: false } : given;
  const base = { rid: input.rid, id: input.id, className: input.className };
  if (input.readError != null) return { ...base, reason: 'unreadable', detail: `Its text could not be read: ${oneLine(input.readError) || 'no reason given'}.` };
  if (input.id && !WRITABLE_ID.test(input.id)) return { ...base, reason: 'unaddressable', detail: UNADDRESSABLE_REASON };
  const genedit = (input.genedit ?? '').trim();
  if (!genedit && (input.systemObject || input.className === 'SystemMethodConfig')) return { ...base, reason: 'no-text', detail: SYSTEM_OBJECT_DETAIL };
  if (LOG_CLASSES.includes(input.className)) return { ...base, reason: 'no-text', detail: LOG_DETAIL };
  if (!genedit) return { ...base, reason: 'no-text', detail: `BMP generates no text for its class (${input.className}).` };
  const flow = parseFlowText(genedit);
  const parsed = flow?.line ?? parseGenedit(genedit);
  if (!parsed) return { ...base, reason: 'unreadable', detail: 'Its generated text has an unexpected form.' };
  const line = { ...parsed, args: withoutNeverCarried(parsed.args) };
  const check = checkAddress(line.address);
  if (!check.ok) return { ...base, address: line.address, reason: 'unaddressable', detail: check.reason };
  const property = isPropertyDefinition(line.className ?? input.className, line.address);
  const links = property && input.generate != null ? linkedClasses(input.generate) ?? undefined : undefined;
  const addable = !input.linkedTo && !input.systemObject;
  const add = !addable ? undefined
    : input.file && !input.file.carried ? addStatement(input, line)
      : property ? (links ? propertyAdd(input, line, links) : undefined)
        : addStatement(input, line, line.args);
  const block = needCreate && !input.isNew ? null : createBlock(add ?? '');
  if (needCreate && input.isNew && !block) {
    if (property && input.creationError != null) return { ...base, address: line.address, reason: 'unreadable', detail: creationErrorDetail(input.creationError) };
    if (property) return { ...base, address: line.address, reason: 'no-text', detail: `BMP generates no text that adds an object of its class (${input.className}).` };
    return { ...base, address: line.address, reason: 'unreadable', detail: NO_PARENT_DETAIL };
  }
  const create = block ?? undefined;
  const instances = links && input.instances != null ? classInstances(input.instances, idOfAddress(line.address)) : undefined;
  const name = nameArgument(line.args) ?? (input.name || undefined);
  const parent = plainAddress(input.parentAddress) || create?.parentAddress || '';
  const parentIsRoot = !!input.parentIsRoot || /^root\./i.test(parent);
  const parentId = (input.parentId ?? '').trim() || idOfAddress(parent);
  return {
    input, line, address: line.address, className: line.className ?? input.className, text: stripLikeServer(input.genedit ?? ''),
    ...(create ? { create } : {}), ...(links ? { links } : {}), ...(instances ? { instances } : {}),
    ...(flow ? { flow: { steps: flow.steps, links: flow.links } } : {}), ...(name != null ? { name } : {}),
    parent, parentId, parentIsRoot, previous: plainAddress(input.previousAddress), next: plainAddress(input.nextAddress),
  };
}

/** The Add of an object under its parent (an address, or its root):
 *  `<parent>.add(<Class>, <args>)` (measured: the first statement of
 *  `generate(true)` has the `genedit()` arguments for 1,463 of 1,463
 *  objects that are not linked copies). Without `args`, a file without its
 *  content: its ID and name (measured: `add(FileResource, id := …, name :=
 *  …)` without content works). Undefined without a parent. */
function addStatement(input: BundleInput, line: GeneditLine, args?: string): string | undefined {
  const cls = line.className ?? input.className;
  // A visibility rule: under its ClassConfig, `c.get(<Class>.name)`.
  const parent = cls === CONDITION_RULE ? classConfigAddress(input.parentId ?? '')
    : plainAddress(input.parentAddress) || (input.parentIsRoot ? rootAddressOf(input.parentId ?? '') : '');
  if (!parent) return undefined;
  // A step of a flow project: into the project's steps (measured:
  // `t.p.add(<Class>, configObject, <arguments>)`).
  if (input.flowStep && args != null) return `${parent}.add(${cls}, configObject${args.trim() ? `, ${args}` : ''})`;
  if (args != null) return `${parent}.add(${cls}${args.trim() ? `, ${args}` : ''})`;
  const name = argumentText(line.args, 'name');
  return `${parent}.add(${line.className ?? input.className}, id := ${ecSingleQuoted(idOfAddress(line.address) || input.id)}${name ? `, name := ${name}` : ''})`;
}

/** The Add of a property definition: its Add assigned to PROPERTY_VARIABLE,
 *  then one link line per class. */
function propertyAdd(input: BundleInput, line: GeneditLine, links: readonly string[]): string | undefined {
  const add = addStatement(input, line, line.args);
  return add ? [`${PROPERTY_VARIABLE} := ${add}`, ...links.map(c => classLinkLine(c, PROPERTY_VARIABLE))].join('\n') : undefined;
}

/** Why a property definition without its `generate(true)` text is left out. */
export const creationErrorDetail = (error: string): string => `The text that adds it could not be read: ${oneLine(error) || 'no reason given'}.`;

/**
 * Inputs read and checked, sorted by address (then RID), one object per
 * RID and per address, with the left-out objects (sorted by ID) and the
 * numeric-ID warnings. Shared by the bundle, the probe and the patch.
 * `needCreate`: see prepare.
 */
export function prepareTransportInputs(inputs: readonly BundleInput[], needCreate: boolean): { prepared: PreparedObject[]; leftOut: LeftOutObject[]; warnings: BundleWarning[] } {
  const leftOut: LeftOutObject[] = [];
  const warnings: BundleWarning[] = [];
  let prepared: PreparedObject[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.rid)) continue;
    seen.add(input.rid);
    const p = prepare(input, needCreate);
    if ('reason' in p) leftOut.push(p); else prepared.push(p);
  }
  // One object per address: a second object with the same address (another
  // RID) would set the first one's values.
  prepared.sort((a, b) => (key(a.address) < key(b.address) ? -1 : key(a.address) > key(b.address) ? 1 : a.input.rid.length - b.input.rid.length || (a.input.rid < b.input.rid ? -1 : a.input.rid > b.input.rid ? 1 : 0)));
  const byAddress = new Set<string>();
  prepared = prepared.filter(p => {
    if (!byAddress.has(key(p.address))) { byAddress.add(key(p.address)); return true; }
    leftOut.push({ rid: p.input.rid, id: p.input.id, className: p.input.className, address: p.address, reason: 'unaddressable', detail: 'Another object in this transport has the same address.' });
    return false;
  });
  sortLeftOut(leftOut);
  for (const p of prepared) {
    const c = checkAddress(p.address);
    if (c.ok && c.numeric) warnings.push({ kind: 'numeric-id', rid: p.input.rid, address: p.address, detail: `${p.address}: its ID is a number, which may name another object on the target.` });
  }
  return { prepared, leftOut, warnings };
}

/** Lower case address: IDs are case-insensitive in BMP. */
export const addressKey = key;

/** Is the object never moved: a step of a flow project (measured: a step
 *  cannot be moved), or a visibility rule (moving one is not measured). */
export const neverMoved = (p: PreparedObject): boolean => !!p.input.flowStep || p.className === CONDITION_RULE;

/** A file whose content is not carried: its text is read and compared
 *  without the content (FILE_VALUES). */
export const isShort = (p: PreparedObject): boolean => !!p.input.file && !p.input.file.carried;

/** The guard of an object. */
export const guardOf = (p: PreparedObject): IdentityGuard => ({ address: p.address, className: p.className });

/** The guarded create of one object. */
export function createStatement(p: PreparedObject): string {
  return [
    `IF ${p.address} = MISSING THEN`,
    ...p.create!.statements.map(s => INDENT + s),
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

/** The value line of one object (genedit without its `//<Class>`). */
export const valueStatement = (p: PreparedObject): string => `${p.address}.change(${p.line.args})`;

/** Where an object goes among its siblings: after or before `anchor`. */
export interface OrderAnchor { method: 'moveAfter' | 'moveBefore'; anchor: string }

/** One order statement: the object it moves and the sibling it moves to. */
export interface OrderLine extends OrderAnchor { text: string; moved: PreparedObject }

/** Can the object `p` be placed next to the sibling at `address` on the
 *  target (it exists there, under the parent `p` will have)? */
export type SiblingAvailable = (address: string, p: PreparedObject) => boolean;

/**
 * The anchor of each object among `all`: `moveAfter` its previous sibling
 * when that is created or available; otherwise (a first child, or a
 * previous sibling that is not available) `moveBefore` the first following
 * sibling that is not created, when that one is available; else null.
 * `available`: the sibling exists on the target (the bundle assumes every
 * sibling it does not create does).
 */
export function orderAnchors(all: readonly PreparedObject[], created: (p: PreparedObject) => boolean, available: SiblingAvailable = () => true): (p: PreparedObject) => OrderAnchor | null {
  const byAddress = new Map(all.map(p => [key(p.address), p]));
  const isCreated = (address: string) => { const p = byAddress.get(key(address)); return !!p && created(p); };
  return (p: PreparedObject) => {
    if (p.previous && (isCreated(p.previous) || available(p.previous, p))) return { method: 'moveAfter', anchor: p.previous };
    // Before the first following sibling that is not created.
    let next = p.next;
    const seen = new Set<string>([key(p.address)]);
    while (next && isCreated(next) && !seen.has(key(next))) {
      seen.add(key(next));
      next = byAddress.get(key(next))!.next;
    }
    return next && !isCreated(next) && available(next, p) ? { method: 'moveBefore', anchor: next } : null;
  };
}

/** The guarded statement of one anchor. */
const orderText = (address: string, a: OrderAnchor) => `IF ${address} != MISSING AND ${a.anchor} != MISSING THEN ${address}.${a.method}(${a.anchor}) ELSE "" ENDIF`;

/**
 * The place statements of the objects `placed` picks (default: the created
 * ones), so that after them the objects stand among their siblings in the
 * source's order. A sibling is usable when it exists once the earlier steps
 * ran (added: `created`; or `available`: on the target under the parent the
 * object will have). A sibling is fixed when it is usable and not placed:
 * it stays where it is, and the others are placed relative to it.
 *
 *  - An object with a fixed sibling somewhere before it (walking back
 *    through usable placed siblings) goes `moveAfter` its previous sibling,
 *    after that one is placed: left to right.
 *  - Any other object (a first child, or a run of placed siblings before the
 *    first fixed one) goes `moveBefore` its next sibling when that is usable,
 *    after that one is placed: right to left. The last of such a run with no
 *    usable next sibling stays where it is, and the run lines up before it.
 *
 * So no statement moves an object that an earlier one already placed
 * relative to it, whatever order the target has: applied in order, they
 * give the source's order.
 */
export function orderStatements(all: readonly PreparedObject[], created: (p: PreparedObject) => boolean, available: SiblingAvailable = () => true, placed: (p: PreparedObject) => boolean = created): OrderLine[] {
  const byAddress = new Map(all.map(p => [key(p.address), p]));
  const usable = (address: string, p: PreparedObject) => {
    if (!address) return false;
    const q = byAddress.get(key(address));
    return (!!q && created(q)) || available(address, p);
  };
  const afterFixed = new Map<PreparedObject, boolean>();
  /** Is there a fixed sibling before `p` (through usable placed ones)? */
  const fixedBefore = (p: PreparedObject, seen = new Set<PreparedObject>()): boolean => {
    const known = afterFixed.get(p);
    if (known != null) return known;
    seen.add(p);
    let v = false;
    if (usable(p.previous, p)) {
      const q = byAddress.get(key(p.previous));
      v = !q || !placed(q) ? true : !seen.has(q) && fixedBefore(q, seen);
    }
    afterFixed.set(p, v);
    return v;
  };
  const anchorOf = (p: PreparedObject): OrderAnchor | null => {
    if (fixedBefore(p)) return { method: 'moveAfter', anchor: p.previous };
    return usable(p.next, p) ? { method: 'moveBefore', anchor: p.next } : null;
  };
  const out: OrderLine[] = [];
  const done = new Set<PreparedObject>();
  const visiting = new Set<PreparedObject>();
  const place = (p: PreparedObject) => {
    if (done.has(p) || visiting.has(p)) return;
    visiting.add(p);
    const a = anchorOf(p);
    if (a) {
      const other = byAddress.get(key(a.anchor));
      if (other && placed(other)) place(other);
      out.push({ ...a, text: orderText(p.address, a), moved: p });
    }
    visiting.delete(p);
    done.add(p);
  };
  all.filter(placed).forEach(place);
  return out;
}

/** The report lines of one object: MISSING, ok or DIFFERENT by the exact
 *  comparison of its whole generated text with `expected`, counted in
 *  `_ms`, `_ok`, `_df`. */
export function reportStatement(address: string, expected: string, short = false): string {
  const add = (text: string) => `_r := _r + ${ecString(text)}`;
  return [
    `IF ${address} = MISSING THEN`,
    INDENT + add(`\nMISSING ${address}`),
    `${INDENT}_ms := _ms + "."`,
    'ELSE',
    ...exactTextEc(address, expected, [add(`\nok ${address}`), '_ok := _ok + "."'], [add(`\nDIFFERENT ${address}`), '_df := _df + "."'], INDENT, short),
    'ENDIF',
  ].join('\n');
}

/** The lines around a report part. The counts are kept as texts of dots,
 *  so the last line prints only `str(<text>.size())`, the measured form. */
export function reportFrame(objects: number): PartFrame {
  return {
    before: [`_r := ${ecString(`Transport report (${objects} object${objects === 1 ? '' : 's'} in this part)`)}`, '_ok := ""', '_df := ""', '_ms := ""'],
    after: ['_r := _r + "\\n" + str(_ok.size()) + " ok, " + str(_df.size()) + " different, " + str(_ms.size()) + " missing"', '_r'],
  };
}

// ── parts ───────────────────────────────────────────────────────────

/** Lines that open and close one part of a step. */
export interface PartFrame { before: string[]; after: string[] }

/** One statement of a step with the objects it addresses. */
export interface PartUnit {
  text: string;
  /** Objects it counts for in a frame ("n objects in this part"). */
  objects: number;
  /** Guards that go to the top of the part that holds it. */
  guards: readonly IdentityGuard[];
  /** Lines that go to the top of the part that holds it, after the guards
   *  and before every statement (the probe reads places before any text). */
  head?: readonly string[];
  /** Comment lines that go right after the part's header (a file to upload). */
  comment?: readonly string[];
  /** The object it is about, for a head of its part (StepInput.partHead). */
  place?: { space: string; id: string };
  /** The object its statements write (default: its first guard's). */
  address?: string;
}

/** One step's statements and how its parts are framed. */
export interface StepInput<S extends string> {
  step: S;
  spec: StepSpec;
  units: readonly PartUnit[];
  /** The frame of a part from its object count and its numbers. */
  frame?: (objects: number, index: number, total: number) => PartFrame;
  /** Lines at the top of a part, made from the units in it (after the
   *  guards, before the units' own heads). */
  partHead?: (units: readonly PartUnit[]) => string[];
}

/** Header lines of a part; `oversize` adds the warning line. */
function headerOf(label: string, s: StepSpec, index: number, total: number, stepIndex: number, stepTotal: number, oversize: boolean, limit: number): string[] {
  const title = stepTotal > 1 ? `${s.title} (${stepIndex} of ${stepTotal})` : s.title;
  return [
    `// ${label}, part ${index} of ${total}: ${title}`,
    `// ${s.does}`,
    `// ${s.runLine ?? `Run with ${s.run === 'committed' ? 'Execute' : 'Preview'}. Safe to run again: ${s.again}.`}`,
    ...(oversize ? [`// This part is longer than ${limit.toLocaleString('en-US')} characters: one statement is that long. Check that the script window takes it.`] : []),
  ];
}

const NO_FRAME = (): PartFrame => ({ before: [], after: [] });

/** The guards of a group of units: one per address, in order. */
function guardsOf(units: readonly PartUnit[]): IdentityGuard[] {
  const seen = new Set<string>();
  const out: IdentityGuard[] = [];
  for (const u of units) for (const g of u.guards) {
    if (seen.has(key(g.address))) continue;
    seen.add(key(g.address));
    out.push(g);
  }
  return out;
}

/** The body of a part: guards, the units' heads, the frame's first lines,
 *  the statements, the frame's last lines. */
const bodyOf = (units: readonly PartUnit[], f: PartFrame, head: readonly string[] = []) => [
  ...new Set(units.flatMap(u => u.comment ?? [])), ...guardBlockEc(guardsOf(units)), ...head, ...units.flatMap(u => u.head ?? []), ...f.before, ...units.map(u => u.text), ...f.after,
];

/** The lines of each unit that writes one object, in a part's `text`: its
 *  statements come right before the frame's last lines. */
function unitSpans(units: readonly PartUnit[], text: string, f: PartFrame): NonNullable<BundlePart['spans']> {
  const count = (t: string) => t.split('\n').length;
  const lines = count(text) - 1;
  const own = units.reduce((n, u) => n + count(u.text), 0);
  let at = lines - f.after.length - own + 1;
  const out: NonNullable<BundlePart['spans']> = [];
  for (const u of units) {
    const n = count(u.text);
    const address = u.address ?? u.guards[0]?.address;
    if (address) out.push({ from: at, to: at + n - 1, address });
    at += n;
  }
  return out;
}

/** The object of line `line` of a part (BundlePart.spans). */
export function objectAtLine(part: Pick<BundlePart, 'spans'>, line: number): string | undefined {
  return part.spans?.find(s => line >= s.from && line <= s.to)?.address;
}

/** Split units into groups whose part text (header, guards, frame, body)
 *  stays within `limit`; a unit that alone is too long forms its own group.
 *  A unit's guards always go with it. */
function chunk<S extends string>(label: string, s: StepInput<S>, limit: number): PartUnit[][] {
  const frame = s.frame ?? NO_FRAME;
  const room = limit - (headerOf(label, s.spec, 9999, 9999, 9999, 9999, false, limit).join('\n').length + 1);
  const size = (units: readonly PartUnit[]) => bodyOf(units, frame(units.reduce((n, u) => n + u.objects, 0), 9999, 9999), s.partHead?.(units) ?? []).join('\n').length + 1;
  const groups: PartUnit[][] = [];
  let cur: PartUnit[] = [];
  for (const u of s.units) {
    const next = [...cur, u];
    if (cur.length && size(next) > room) { groups.push(cur); cur = [u]; } else cur = next;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** For each unit of `s`, the part of its step it lands in (0-based), as
 *  renderParts cuts it with the same `label` and `limit`. */
export function unitParts<S extends string>(label: string, s: StepInput<S>, limit: number): number[] {
  return chunk(label, s, limit).flatMap((units, i) => units.map(() => i));
}

/**
 * The parts of `steps` in order, numbered across all steps. Each part is
 * at most `limit` characters, header included, cut only between units; a
 * single longer unit is a part of its own, flagged (`oversize` and a
 * warning). A step without units has no part. `label` names the text in
 * each header ("Transport bundle").
 */
export function renderParts<S extends string>(label: string, steps: readonly StepInput<S>[], limit: number): { parts: BundlePart<S>[]; warnings: BundleWarning[] } {
  const groups = steps.flatMap(s => chunk(label, s, limit).map((units, i, all) => ({ s, units, stepIndex: i + 1, stepTotal: all.length })));
  const total = groups.length;
  const warnings: BundleWarning[] = [];
  const parts = groups.map(({ s, units, stepIndex, stepTotal }, i): BundlePart<S> => {
    const f = (s.frame ?? NO_FRAME)(units.reduce((n, u) => n + u.objects, 0), i + 1, total);
    const body = bodyOf(units, f, s.partHead?.(units) ?? []);
    const guards = guardsOf(units).length;
    const render = (flag: boolean) => [...headerOf(label, s.spec, i + 1, total, stepIndex, stepTotal, flag, limit), ...body].join('\n') + '\n';
    let text = render(false);
    const oversize = text.length > limit;
    if (oversize) {
      text = render(true);
      warnings.push({ kind: 'oversize', part: i + 1, detail: `Part ${i + 1} has ${text.length.toLocaleString('en-US')} characters, over ${limit.toLocaleString('en-US')}: one statement is that long.` });
    }
    const spans = unitSpans(units, text, f);
    return {
      index: i + 1, total, step: s.step, stepIndex, stepTotal, run: s.spec.run, statements: units.length, guards, text,
      ...(oversize ? { oversize: true as const } : {}),
      ...(spans.length ? { spans } : {}),
    };
  });
  return { parts, warnings };
}

export interface BundleOptions {
  /** Characters per part (default BUNDLE_PART_LIMIT). */
  partLimit?: number;
}

/** The warning of a created object whose neighbours could not be read. */
export function noOrderWarning(p: PreparedObject): BundleWarning {
  return { kind: 'no-order', rid: p.input.rid, address: p.address, detail: `${p.address}: its parent and siblings could not be read, so its place among its siblings is not restored.` };
}

/**
 * Assemble the bundle for `inputs` as the spec's parts:
 *  1. Add: for each new object, `IF <address> = MISSING THEN <create
 *     block> ELSE "" ENDIF`, parents before children, and where possible an
 *     object referred to before the one that refers to it (orderForAdd).
 *  2. Change: every object's genedit line (without `//<Class>`).
 *  3. Change again: the lines of the new objects that refer to one added
 *     with or after them (refersToLaterAdded) and of the other objects whose
 *     values refer to a new one (no part when there are none).
 *  4. Order: for each new object, `moveAfter` its previous sibling or, as
 *     a first child, `moveBefore` its next one, each guarded. Objects the
 *     target already has keep their place.
 *  5. Report, run as a preview: one line per object (ok, MISSING or
 *     DIFFERENT by the exact comparison of its whole generated text with
 *     this workspace's), then the counts.
 * Every committed part starts with one identity guard per object its
 * statements address (guardBlockEc: one line per object, one error for all
 * of them); a guard stays in the part that holds the object's statement. Each part is at most `partLimit`
 * characters, header included (renderParts). Objects are sorted by address
 * (then RID) first, so the text does not depend on the order of `inputs`.
 * Each address the objects' values refer to that is not one of them is a
 * warning (`outside-reference`, outsideReferences).
 */
export function assembleBundle(inputs: readonly BundleInput[], opts: BundleOptions = {}): TransportBundle {
  const limit = opts.partLimit ?? BUNDLE_PART_LIMIT;
  const { prepared, leftOut, warnings } = prepareTransportInputs(inputs, true);
  const isNew = (p: PreparedObject) => p.input.isNew;
  for (const p of prepared) if (isNew(p) && p.input.neighboursError != null) warnings.push(noOrderWarning(p));
  const templates = prepared.filter(p => p.input.template).length;
  if (templates) warnings.push({ kind: 'template', detail: templateWarning(templates) });
  for (const r of outsideReferences(prepared.map(p => ({ address: p.address, args: p.line.args })))) {
    warnings.push({ kind: 'outside-reference', address: r.address, detail: `${r.address} is used by ${referrersText(r.by)} but is not in this transport; it must exist on the target.` });
  }
  // The parent of an object to add: its Add statement is addressed to it.
  for (const r of outsideParents(prepared.filter(isNew), prepared.map(p => p.address))) {
    warnings.push({ kind: 'outside-parent', address: r.address, by: r.by, detail: `${r.address} is the parent of ${referrersText(r.by)} but is not in this transport; it must exist on the target.` });
  }

  // Parents first, and where possible what is referred to before what refers to it.
  const creates = orderForAdd(prepared.filter(isNew), p => p.address, p => p.parent, p => p.line.args);
  const unit = (text: string, p: PreparedObject): PartUnit => ({ text, objects: 1, guards: [guardOf(p)] });
  // A bundle cannot know what the target has: every object is changed. The
  // links of a property definition cannot be compared: they come only with
  // its Add.
  const values = prepared.map(p => ({ ...unit(valueStatement(p), p), ...(p.links ? { comment: [PROPERTY_LINKS_COMMENT] } : {}) }));
  const createdKeys = new Set(creates.map(p => key(p.address)));
  // Again: new objects that refer to one added with or after them, and the
  // others that refer to a new one.
  const later = refersToLaterAdded(creates, p => p.address, p => p.line.args);
  const again = prepared.filter(p => (isNew(p) ? later.has(p) : refersToAny(p.line.args, p.address, createdKeys))).map(p => unit(valueStatement(p), p));
  const steps: Array<StepInput<BundleStep>> = [
    { step: 'create', spec: STEPS.create, units: creates.map(p => ({ ...unit(createStatement(p), p), ...uploadComment(p) })) },
    { step: 'set', spec: STEPS.set, units: values },
    // The links of flow projects (a link the target has is not added again).
    { step: 'link', spec: STEPS.link, units: prepared.flatMap(p => (p.flow?.links ?? []).map(l => unit(flowLinkStatement(p.address, l), p))) },
    // The own values of linked properties per class.
    { step: 'own', spec: STEPS.own, units: prepared.flatMap(p => (p.instances ?? []).filter(x => x.values.length).map(x => unit(instanceChangeStatement(p.address, x.className, x.values.map(v => `${v.name} := ${v.value}`).join(', ')), p))) },
    { step: 'setAgain', spec: STEPS.setAgain, units: again },
    { step: 'order', spec: STEPS.order, units: orderStatements(prepared, p => isNew(p) && !neverMoved(p)).map(o => unit(o.text, o.moved)) },
    { step: 'report', spec: STEPS.report, units: prepared.map(p => ({ text: reportStatement(p.address, p.text, isShort(p)), objects: 1, guards: [] })), frame: reportFrame },
  ];
  const rendered = renderParts('Transport scripts', steps, limit);
  warnings.push(...rendered.warnings);
  const parts = rendered.parts;

  const objects: BundledObject[] = prepared.map(p => ({
    rid: p.input.rid, address: p.address, className: p.className, isNew: p.input.isNew, ...(p.name != null ? { name: p.name } : {}),
  }));
  const uploads = prepared.filter(isNew).map(uploadOf).filter((u): u is UploadFile => !!u);
  const preamble = preambleOf(objects, parts, leftOut, warnings, uploads);
  // Steps of the flow projects that are not in the transport.
  const inside = new Set(prepared.map(p => key(p.address)));
  const flowSteps = [...new Map(prepared.flatMap(p => (p.flow?.steps ?? []).map(st => addressOf('t', st.id))).filter(a => a && !inside.has(key(a))).map(a => [key(a), a] as const)).values()];
  return { parts, objects, leftOut, warnings, notes: BUNDLE_NOTES, preamble, text: [preamble, ...parts.map(p => p.text)].join('\n'), uploads, flowSteps };
}

/** The comment of a part of scripts without comparison that changes a
 *  property definition. */
export const PROPERTY_LINKS_COMMENT = '// Property definitions are linked to their classes only when they are added. Where the target has one already, its links stay as they are: compare with the target to add links.';

/** The warning of scripts without comparison that change objects under
 *  Templates. */
export const templateWarning = (n: number): string => `${n === 1 ? '1 object is a template' : `${n.toLocaleString('en-US')} objects are templates`}. These scripts change every value of ${n === 1 ? 'it' : 'them'} on the target, and each value written walks every linked copy. Compare with the target instead where you can.`;

/** Outside-reference warnings listed one per line in a preamble; the rest
 *  are counted in one line. */
export const PREAMBLE_REFERENCES_SHOWN = 10;

/** Comment lines that list left-out objects and warnings. Outside-reference
 *  warnings come last, at most PREAMBLE_REFERENCES_SHOWN, then "… and <n>
 *  more". */
export function leftOutAndWarningLines(leftOut: readonly LeftOutObject[], warnings: readonly BundleWarning[]): string[] {
  const lines: string[] = [];
  if (leftOut.length) {
    lines.push(`// Left out (${leftOut.length}):`);
    for (const o of leftOut) lines.push(`//   ${oneLine(o.address ?? o.id) || o.rid} (${oneLine(o.className)}): ${oneLine(o.detail)}`);
  }
  if (warnings.length) {
    lines.push('// Warnings:');
    const refs = warnings.filter(w => w.kind === 'outside-reference');
    for (const w of warnings) if (w.kind !== 'outside-reference') lines.push(`//   ${oneLine(w.detail)}`);
    for (const w of refs.slice(0, PREAMBLE_REFERENCES_SHOWN)) lines.push(`//   ${oneLine(w.detail)}`);
    if (refs.length > PREAMBLE_REFERENCES_SHOWN) lines.push(`//   … and ${refs.length - PREAMBLE_REFERENCES_SHOWN} more`);
  }
  return lines;
}

/** The comment block above the parts. */
function preambleOf(objects: readonly BundledObject[], parts: readonly BundlePart[], leftOut: readonly LeftOutObject[], warnings: readonly BundleWarning[], uploads: readonly UploadFile[]): string {
  const fresh = objects.filter(o => o.isNew).length;
  const lines = [
    `// Transport scripts (beta): ${objects.length} object${objects.length === 1 ? '' : 's'} in ${parts.length} part${parts.length === 1 ? '' : 's'}; ${fresh} ${fresh === 1 ? 'is' : 'are'} added where the target lacks ${fresh === 1 ? 'it' : 'them'}.`,
    '// Paste each part into a script window on the target and run them in order. Every part is safe to run again.',
    ...BUNDLE_NOTES.map(n => `// ${n}`),
    ...uploadLines(uploads),
    ...leftOutAndWarningLines(leftOut, warnings),
  ];
  return lines.join('\n') + '\n';
}

/** Created on or after `day` (YYYY-MM-DD)? From a scan row's ISO creation
 *  time (serverStampIso); false when it is unknown. */
export function createdOnOrAfter(createdIso: string | undefined, day: string): boolean {
  return !!createdIso && isScanDay(day) && createdIso.slice(0, 10) >= day;
}
