/**
 * Shared EC output framing and parsing.
 *
 * Free text (names, labels, code) travels in ONE encoding, the length-framed
 * row. The markers are constant, so the script text of a question does not
 * change from one call to the next: the server parses a script once per
 * distinct text and keeps the tree (BMP 5.6.17 filled its heap with parse
 * trees of scripts that were all different because of a random marker).
 *
 * Wire format (UTF-16 code units, which is what EC's `size()` and a JS
 * string's `length` both count):
 *
 *     ~CREV_R~ <n1>:<text1> <n2>:<text2> …   one row (no spaces)
 *     ~CREV_D~                               completion marker, once, last
 *
 * The parser reads a row position by position: a field is a decimal length,
 * a colon and exactly that many characters. Text inside a field is never
 * searched for a marker, so stored text that contains `~CREV_R~`, `~CREV_D~`,
 * digits, colons, quotes, backslashes, line breaks or any other character
 * comes back unchanged. A damaged or cut-off answer is an error, never a
 * short or shifted result (ec-parser.test.ts proves this on adversarial data).
 *
 * The markers have no angle brackets. BMP's `+` checks its operands for HTML,
 * and `<<<…>>>` reads as a tag: a growing result string built with such
 * markers was 5 to 15 times slower on the server (measured on BMP 5.6.17).
 */

import { formatEcLiteral } from './ec-guards';
import { measureScript } from './script-kinds';

const PIPE_SEP = '|||';

export interface EcFrame {
  /** Starts every row. */
  row: string;
  /** Completion marker, written once at the very end. */
  done: string;
}

/** The one frame. Constant on purpose (see the module comment). */
export const EC_FRAME: EcFrame = Object.freeze({ row: '~CREV_R~', done: '~CREV_D~' });

/** Kept for callers and golden tests: the same constant frame. */
export const STATIC_EC_FRAME: EcFrame = EC_FRAME;

/** The frame for one EC request: always the constant one. Kept as a
 *  function so that call sites read as before. */
export function createEcFrame(): EcFrame {
  return EC_FRAME;
}

/** EC string literal of the completion marker. */
export const EC_DONE_LITERAL = `"${EC_FRAME.done}"`;

/**
 * Growing EC result strings.
 *
 * BMP's EC copies the left operand of every string `+`, at roughly a
 * microsecond per character (measured on 5.6.17). `_r := _r + a + b + c`
 * therefore copies the whole result built so far once per term, and a
 * multi-object script costs about the square of its size: 24 badge rows took
 * 1.9 s, 12 took 0.3 s, while the same script without the growing string took
 * 35 ms. Two rules keep it about linear:
 *  - append a row in parentheses, so the long string is copied once per row;
 *  - collect rows of a few objects in a short chunk (`EC_CHUNK`) and add the
 *    chunk to the result every few objects.
 * A list that can run into the thousands is better built with `list.calculate( … row )` and one
 * `.join("")`, which is linear.
 */
export const EC_CHUNK = '_rc';

/** `acc := acc + (expr)`: one copy of the accumulator per appended row. */
export function appendEc(acc: string, expr: string): string {
  return `${acc} := ${acc} + (${expr})`;
}

/** Move the chunk into the result and start a new chunk. */
export function flushChunkEc(acc = '_r'): string[] {
  return [`${acc} := ${acc} + ${EC_CHUNK}`, `${EC_CHUNK} := ""`];
}

/** Lines for a loop body that flush the chunk every `every` rows, counted in
 *  `counter` (initialise it to 0 before the loop). */
export function countedFlushEc(counter: string, every: number, indent = '     '): string[] {
  return [
    `${indent}${counter} := ${counter} + 1`,
    `${indent}IF ${counter} >= ${every} THEN`,
    ...flushChunkEc().map(l => `${indent}     ${l}`),
    `${indent}     ${counter} := 0`,
    `${indent}ENDIF`,
  ];
}

/** The text of an EC string literal (`"…"` with `\\ \" \n \r \t` escapes),
 *  or null when `expr` is not exactly one literal. */
export function ecLiteralText(expr: string): string | null {
  const m = /^"((?:[^"\\]|\\.)*)"$/s.exec(expr.trim());
  if (!m) return null;
  return m[1].replace(/\\(.)/gs, (_all, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

/** One length-framed field whose text is known now: `n:text`, unescaped. */
export function framedFieldText(text: string): string {
  return `${text.length}:${text}`;
}

/** EC lines that append one framed row to `acc`. Literal fields are framed
 *  here; every other field is evaluated once into `_fN` (as text, `str(…)`)
 *  so that its length and its text come from the same value. */
export function appendRowEc(acc: string, exprs: readonly string[], indent = ''): string[] {
  const lines: string[] = [];
  // Literal text (merged where two meet) or an EC expression.
  const tokens: Array<{ lit: string } | { ec: string }> = [{ lit: EC_FRAME.row }];
  const addLit = (text: string) => {
    const last = tokens[tokens.length - 1];
    if ('lit' in last) last.lit += text; else tokens.push({ lit: text });
  };
  exprs.forEach((expr, i) => {
    const lit = ecLiteralText(expr);
    if (lit != null) { addLit(framedFieldText(lit)); return; }
    const v = `_f${i}`;
    lines.push(`${indent}${v} := str(${expr})`);
    tokens.push({ ec: `str(${v}.size())` });
    addLit(':');
    tokens.push({ ec: v });
  });
  const expr = tokens.map(t => ('lit' in t ? `"${formatEcLiteral(t.lit)}"` : t.ec)).join(' + ');
  lines.push(`${indent}${appendEc(acc, expr)}`);
  return lines;
}

/** A `[key, value]` row: the block form of the frame. */
export function appendBlockEc(acc: string, key: string, expr: string, indent = ''): string[] {
  return appendRowEc(acc, [`"${key}"`, expr], indent);
}

// ── one shape per question ──────────────────────────────────────────

/** RIDs (decimal strings, possibly beyond 2^53) in one stable order without
 *  repeats: the same set of objects gives the same script text. */
export function stableRidOrder(rids: Iterable<string>): string[] {
  return [...new Set(rids)].sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * One loop over a literal list of objects instead of one block per object.
 * The list line is the only line that changes with the objects; every other
 * line is the same for every call, so the parse tree grows by one list
 * element per object, not by a block. Rows go into the chunk and the chunk
 * into the result every `every` objects (appendEc). A MISSING element (an
 * object that no longer exists) writes nothing.
 *
 * `refs`: EC references in the order the caller wants (stableRidOrder).
 * `body`: lines run for each existing object, bound to `loopVar`.
 */
export function objectLoopEc(refs: readonly string[], loopVar: string, body: readonly string[], every: number, opts: { listVar?: string; counter?: string } = {}): string[] {
  const list = opts.listVar ?? '_list';
  const counter = opts.counter ?? '_k';
  return [
    `${list} := LIST(${refs.join(', ')})`,
    '_r := ""',
    `${EC_CHUNK} := ""`,
    `${counter} := 0`,
    `${list}.forEach(${loopVar}:`,
    `     IF ${loopVar} != MISSING THEN`,
    ...body.map(l => `          ${l}`),
    '     ENDIF',
    ...countedFlushEc(counter, every),
    ')',
    ...flushChunkEc(),
    `_r + ${EC_DONE_LITERAL}`,
  ];
}

// ── script size ─────────────────────────────────────────────────────

/**
 * Hard limit on one script's text. BMP 5.6.17 keeps a parse tree per
 * distinct text in a cache of at most 2,000 entries (bounded by count, not
 * by size; about 40 bytes of heap per character), so one large text costs
 * as much as many small ones. The transport refuses a longer script with a
 * diagnostic instead of sending it (BmpTransport); a builder that can
 * produce one is a bug (ec-script-kinds.test.ts). The largest constant
 * scripts (the object pane, the row facts) are below it; a varying script
 * may have at most 1,200 (script-kinds.ts SCRIPT_LIMITS).
 */
export const SCRIPT_MAX_CHARS = 25_000;

/** What a split builder aims for per script (scans, scope, summaries). */
export const SCRIPT_TARGET_CHARS = 8_000;

/** Split `items` into groups whose script (`build`) stays within `max`
 *  characters; a single item always forms a group (its script may still be
 *  over: the transport refuses it). Greedy, in order. */
export function chunkByScriptSize<T>(items: readonly T[], build: (group: readonly T[]) => string, max = SCRIPT_TARGET_CHARS): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  for (const item of items) {
    const next = [...cur, item];
    // Measured only: the trial texts are not sent, so they are not marked
    // (script-kinds) and do not count as a builder's distinct texts.
    if (cur.length && measureScript(() => build(next)).length > max) { groups.push(cur); cur = [item]; } else cur = next;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ── constant scripts: the object as the command's context ───────────

/** The object a command runs on (its context), as an EC reference. A script
 *  that reaches its object only through this is the same text for every
 *  object (BmpClient.executeEcOn / executeEcEach). */
export const CONTEXT_OBJECT = 'this.object';

/** The body of an objectLoopEc, run once on the context object: the same
 *  rows, the same chunk, the same completion marker. */
export function contextObjectEc(loopVar: string, body: readonly string[]): string[] {
  return [
    `${loopVar} := ${CONTEXT_OBJECT}`,
    '_r := ""',
    `${EC_CHUNK} := ""`,
    `IF ${loopVar} != MISSING THEN`,
    ...body.map(l => `     ${l}`),
    'ENDIF',
    ...flushChunkEc(),
    `_r + ${EC_DONE_LITERAL}`,
  ];
}

// ── parsing ─────────────────────────────────────────────────────────

const INCOMPLETE = 'BMP returned an incomplete result (the answer was cut off)';
const DAMAGED = 'BMP returned a damaged row';

function isDigit(c: number): boolean { return c >= 48 && c <= 57; }

/** Read rows from `pos`. Stops at the completion marker (done: true) or at
 *  the end of the text (done: false). Throws on anything else. */
function scanRows(text: string, pos: number, frame: EcFrame): { rows: string[][]; done: boolean } {
  const rows: string[][] = [];
  for (;;) {
    if (text.startsWith(frame.row, pos)) {
      pos += frame.row.length;
      const fields: string[] = [];
      while (pos < text.length && isDigit(text.charCodeAt(pos))) {
        let end = pos;
        while (end < text.length && isDigit(text.charCodeAt(end)) && end - pos < 10) end++;
        if (end >= text.length) throw new Error(INCOMPLETE);
        if (text[end] !== ':') throw new Error(DAMAGED);
        const n = Number(text.slice(pos, end));
        const from = end + 1;
        if (from + n > text.length) throw new Error(INCOMPLETE);
        fields.push(text.slice(from, from + n));
        pos = from + n;
      }
      rows.push(fields);
      continue;
    }
    if (text.startsWith(frame.done, pos)) return { rows, done: true };
    if (pos >= text.length) return { rows, done: false };
    // A marker cut in the middle reads as cut off, anything else as damage.
    if ((frame.row.startsWith(text.slice(pos)) || frame.done.startsWith(text.slice(pos)))) return { rows, done: false };
    throw new Error(DAMAGED);
  }
}

function firstMarker(log: string, frame: EcFrame): number {
  const r = log.indexOf(frame.row);
  const d = log.indexOf(frame.done);
  if (r < 0) return d;
  if (d < 0) return r;
  return Math.min(r, d);
}

function checkWidth(rows: string[][], width?: number): string[][] {
  if (width != null) {
    for (const row of rows) if (row.length !== width) throw new Error(DAMAGED);
  }
  return rows;
}

/** Framed rows of a text that holds rows only (a field value that a script
 *  built from rows, or ''). With `width`, a row with another field count
 *  throws. */
export function splitFramedRows(text: string, frame: EcFrame = EC_FRAME, width?: number): string[][] {
  if (!text) return [];
  const { rows } = scanRows(text, 0, frame);
  return checkWidth(rows, width);
}

/** Parse a framed log: rows up to the completion marker. Text before the
 *  first marker (log noise) is ignored. Throws when the marker is missing
 *  (the response was cut off) or a row is damaged. */
export function parseFramedLog(log: string, frame: EcFrame = EC_FRAME, width?: number): string[][] {
  const start = firstMarker(log, frame);
  if (start < 0) throw new Error(INCOMPLETE);
  const { rows, done } = scanRows(log, start, frame);
  if (!done) throw new Error(INCOMPLETE);
  return checkWidth(rows, width);
}

/** The rows of several complete framed answers as one answer (split
 *  scripts, ec-parser chunkByScriptSize). Throws like parseFramedLog. */
export function mergeFramedLogs(logs: readonly string[], frame: EcFrame = EC_FRAME): string {
  return framedText(logs.flatMap(log => parseFramedLog(log, frame)), true, frame);
}

/** True when a framed log is complete and readable. */
export function isCompleteFramedLog(log: string | null | undefined, frame: EcFrame = EC_FRAME): boolean {
  if (log == null) return false;
  try { parseFramedLog(log, frame); return true; } catch { return false; }
}

/** `[key, value]` rows as a record. Empty values are left out (a missing
 *  block reads as empty). Throws on a cut-off or damaged answer. */
export function parseSepBlocks(log: string, frame: EcFrame = EC_FRAME): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of parseFramedLog(log, frame)) {
    if (row.length !== 2) throw new Error(DAMAGED);
    if (row[1]) out[row[0]] = row[1];
  }
  return out;
}

/** Multi-object `[key, value]` rows: an `OBJ` row with the object's RID
 *  starts each object (`SKIP` ignores it). */
export function parseSepMultiObject(log: string, frame: EcFrame = EC_FRAME): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const row of parseFramedLog(log, frame)) {
    if (row.length !== 2) throw new Error(DAMAGED);
    const [key, value] = row;
    if (key === 'OBJ') {
      const rid = value.trim();
      current = rid && rid !== 'SKIP' ? {} : null;
      if (current) result.set(rid, current);
    } else if (current && value) {
      current[key] = value;
    }
  }
  return result;
}

/** Parse pipe-delimited EC output lines into field arrays. Skips MISSING/SKIP RIDs and short lines. */
export function parsePipeLines(log: string, minFields: number): Array<string[]> {
  const results: Array<string[]> = [];
  for (const line of log.trim().split('\n')) {
    if (!line.includes(PIPE_SEP)) continue;
    const parts = line.split(PIPE_SEP);
    if (parts.length < minFields) continue;
    const rid = parts[0]?.trim();
    if (!rid || rid === 'MISSING' || rid === 'SKIP') continue;
    results.push(parts.map(p => p.trim()));
  }
  return results;
}

// ── test helpers (pure; used by unit tests to write canned answers) ──

/** A framed answer: rows, then the completion marker. */
export function framedText(rows: ReadonlyArray<ReadonlyArray<string>>, done = true, frame: EcFrame = EC_FRAME): string {
  return rows.map(row => frame.row + row.map(framedFieldText).join('')).join('') + (done ? frame.done : '');
}

/** `[key, value]` blocks as a framed answer. */
export function framedBlocks(blocks: Readonly<Record<string, string>>, done = true): string {
  return framedText(Object.entries(blocks), done);
}
