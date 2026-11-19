/**
 * Replace in Extended Code: plan the changes of a find and replace over
 * script texts, and write them with the editor's guards. Pure: no DOM, no
 * chrome.*; the caller supplies the port to the server (code-replace-port.ts).
 *
 * The plan (`planReplace`) is a list of matches per script, each with the
 * text it would change and what it becomes. When the find text is an object
 * reference (`t.some_id`) a match that sits in a string or a comment is
 * marked as such and starts unticked: it is text, not a use of the object.
 * Where a match sits comes from the code the links are made from: the
 * comments and strings `codeSpans` skips and the references `findCodeRefs`
 * reads (lib/code-refs.ts), so the replace and the editor's links agree.
 *
 * The write (`applyReplace`), per script, goes through `runCodeSave`, the
 * editor's save (editor-core/code-save.ts):
 *  1. the script is read again; when it is no longer the text the copy held,
 *     it is not written ("changed on the server");
 *  2. the new text is parsed on the server without running it
 *     (`wrapForSyntaxCheck`); a text the server cannot parse is not saved and
 *     the result carries the server's message;
 *  3. the script is written like a save in the editor and read back.
 * One script that is not saved never stops the others.
 *
 * The undo (`undoReplace`) writes the old texts back only where the server
 * still holds the text the replace wrote.
 */

import { codeSpans, findCodeRefs, type CodeRef, type CodeSpan } from './code-refs';
import { searchRegExp } from './code-search-match';
import { runCodeSave, type CodeFetchResult, type CodeWriteAnswer } from './code-save';
export { syntaxProblemText, wrapForSyntaxCheck } from './ec-syntax-check';

// ── the plan ──────────────────────────────────────────────────────

export interface ReplaceQuery {
  find: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One script: a property of an object and its text. */
export interface ReplaceScript { rid: string; prop: string; text: string }

/** Where a match sits: in code, in a string literal or in a comment. */
export type MatchKind = 'code' | 'string' | 'comment';

export interface ReplaceMatch {
  /** `rid|prop|n`: stable for one plan. */
  id: string;
  /** 1-based line. */
  line: number;
  /** Offsets in the script text: `start` inclusive, `end` exclusive. */
  start: number;
  end: number;
  /** The text the match replaces, and what it becomes. */
  old: string;
  replacement: string;
  kind: MatchKind;
  /** The line of the match, and the match's place on it. */
  lineText: string;
  from: number;
  to: number;
}

export interface ScriptPlan {
  rid: string;
  prop: string;
  text: string;
  matches: ReplaceMatch[];
}

export interface ReplacePlan {
  scripts: ScriptPlan[];
  matches: number;
  /** The find text is an object reference. */
  reference: boolean;
  /** What is wrong with the find text (nothing was planned). */
  problem?: string;
}

/** Properties whose text is not Extended Code (HTML, JavaScript, plain
 *  text): not parsed as Extended Code, and their strings and comments are not
 *  told apart. */
const NOT_EC_PROPS: ReadonlySet<string> = new Set(['html', 'javascript', 'text', 'longText']);
export const isEcScriptProp = (prop: string): boolean => !NOT_EC_PROPS.has(prop);

/** Is the whole find text one reference to an object (`t.some_id`,
 *  `t.get("some-id")`, `{some_id}`, `lookup(1234567)`)? */
export function isReferenceFind(find: string): boolean {
  const text = find.trim();
  if (!text) return false;
  const refs = findCodeRefs(text);
  return refs.length === 1 && refs[0].start === 0 && refs[0].end === text.length;
}

/** The text a regular expression's replacement stands for: `$1`, `$<name>`,
 *  `$&`, `` $` ``, `$'` and `$$`, as JavaScript's own replace reads them. */
export function expandReplacement(m: RegExpExecArray, line: string, replace: string): string {
  return replace.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (all, code: string) => {
    if (code === '$') return '$';
    if (code === '&') return m[0];
    if (code === '`') return line.slice(0, m.index);
    if (code === "'") return line.slice(m.index + m[0].length);
    if (code[0] === '<') return m.groups?.[code.slice(1, -1)] ?? all;
    const n = Number(code);
    if (n >= 1 && n < m.length) return m[n] ?? '';
    if (code.length === 2 && Number(code[0]) >= 1 && Number(code[0]) < m.length) return (m[Number(code[0])] ?? '') + code[1];
    return all;
  });
}

function spanAt(spans: readonly CodeSpan[], pos: number, from: { i: number }): CodeSpan | null {
  while (from.i < spans.length && spans[from.i].end <= pos) from.i++;
  const s = spans[from.i];
  return s && s.start <= pos ? s : null;
}

/** The matches of one script (none when there are none). */
function planScript(script: ReplaceScript, re: RegExp, q: ReplaceQuery, reference: boolean, quick: ((text: string) => boolean) | null): ScriptPlan | null {
  const { text } = script;
  if (!text || (quick && !quick(text))) return null;
  const ec = isEcScriptProp(script.prop);
  const matches: ReplaceMatch[] = [];
  let spans: CodeSpan[] | null = null;
  let refs: CodeRef[] | null = null;
  const cursor = { i: 0 };
  let lineStart = 0;
  let line = 1;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? text.length : nl;
    const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, '');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        if (re.lastIndex > lineText.length) break;
        continue;
      }
      const start = lineStart + m.index;
      let kind: MatchKind = 'code';
      if (ec) {
        spans ??= codeSpans(text);
        const s = spanAt(spans, start, cursor);
        if (s) {
          kind = s.kind;
          // The literal argument of `get("…")` is a reference, not a string.
          if (reference) {
            refs ??= findCodeRefs(text);
            if (refs.some(r => r.form === 'get' && r.start <= start && start < r.end)) kind = 'code';
          }
        }
      }
      const replacement = q.regex ? expandReplacement(m, lineText, q.replace) : q.replace;
      // The same text in its place changes nothing.
      if (replacement === m[0]) continue;
      matches.push({
        id: `${script.rid}|${script.prop}|${matches.length}`, line, start, end: start + m[0].length,
        old: m[0], replacement, kind, lineText, from: m.index, to: m.index + m[0].length,
      });
    }
    if (nl < 0) break;
    lineStart = nl + 1;
    line++;
  }
  return matches.length ? { rid: script.rid, prop: script.prop, text, matches } : null;
}

/** Every match of the find text in `scripts`, with what each becomes. */
export function planReplace(scripts: Iterable<ReplaceScript>, q: ReplaceQuery): ReplacePlan {
  const reference = !q.regex && isReferenceFind(q.find);
  // An object reference ends where its ID ends: `t.a_b` is not `t.a`.
  const re = searchRegExp({ query: q.find, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord || reference, regex: q.regex });
  if ('error' in re) return { scripts: [], matches: 0, reference, problem: re.error };
  // Plain text: most scripts are skipped without a line-by-line search.
  const needle = q.caseSensitive ? q.find : q.find.toLowerCase();
  const quick = q.regex ? null : q.caseSensitive ? (t: string) => t.includes(needle) : (t: string) => t.toLowerCase().includes(needle);
  const out: ScriptPlan[] = [];
  let matches = 0;
  for (const s of scripts) {
    const p = planScript(s, re, q, reference, quick);
    if (!p) continue;
    out.push(p);
    matches += p.matches.length;
  }
  return { scripts: out, matches, reference };
}

/** Does a match start ticked? Matches in strings and comments do not, when
 *  the find text is an object reference. */
export const startsTicked = (m: ReplaceMatch, reference: boolean): boolean => !reference || m.kind === 'code';

// ── edits ─────────────────────────────────────────────────────────

/** A change to a script: the range `[start, end)` of its text becomes `text`. */
export type Edit = readonly [start: number, end: number, text: string];

export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const [s, e, t] of [...edits].sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + t + out.slice(e);
  return out;
}

export const editOf = (m: ReplaceMatch): Edit => [m.start, m.end, m.replacement];

/** The script after its ticked matches. */
export function textAfter(script: ScriptPlan, ticked: (m: ReplaceMatch) => boolean): string {
  return applyEdits(script.text, script.matches.filter(ticked).map(editOf));
}

/** What a script is, for the Log and the result. */
export interface ScriptLabel { type: string; name: string; businessId: string }

/** A script to write: its text as the copy held it and the edits to it. */
export interface ScriptChange extends ScriptLabel {
  rid: string;
  prop: string;
  opened: string;
  edits: Edit[];
}

export function changesOf(plan: ReplacePlan, ticked: (m: ReplaceMatch) => boolean, label: (rid: string) => ScriptLabel): ScriptChange[] {
  const out: ScriptChange[] = [];
  for (const s of plan.scripts) {
    const edits = s.matches.filter(ticked).map(editOf);
    if (edits.length) out.push({ rid: s.rid, prop: s.prop, opened: s.text, edits, ...label(s.rid) });
  }
  return out;
}

// ── the syntax check ──────────────────────────────────────────────

export type SyntaxAnswer =
  | { ok: true }
  /** `verdict`: the server read the script and refused it; else the check itself failed. */
  | { ok: false; message: string; verdict: boolean };

// ── the write ─────────────────────────────────────────────────────

export interface ReplacePort {
  /** The stored text of properties (STUDIO_FETCH_CODE). */
  fetch(rid: string, props: string[]): Promise<CodeFetchResult>;
  /** Parse a text on the server without running it. */
  check(text: string): Promise<SyntaxAnswer>;
  /** Write one property (SAVE_PROPERTY). `undefined`: no answer arrived. */
  write(rid: string, label: ScriptLabel, prop: string, value: string): Promise<CodeWriteAnswer | undefined>;
  pause?(ms: number): Promise<void>;
}

export type ScriptStatus = 'saved' | 'changed' | 'syntax' | 'failed' | 'unknown';

export interface ScriptResult extends ScriptLabel {
  rid: string;
  prop: string;
  status: ScriptStatus;
  /** Why it was not saved, or a note on a saved one. */
  message?: string;
  /** Changes made (ticked matches of the script). */
  changes: number;
  /** The text before and the edits written; with `status: 'saved'` these
   *  restore the script. */
  before: string;
  edits: Edit[];
}

export const CHANGED_ON_SERVER = 'Changed on the server';
export const isSaved = (r: Pick<ScriptResult, 'status'>): boolean => r.status === 'saved';

/** Write the changes, one script after the other. `onResult` follows each. */
export async function applyReplace(
  changes: readonly ScriptChange[],
  port: ReplacePort,
  opts: { signal?: AbortSignal; check?: boolean; onResult?: (r: ScriptResult, done: number, total: number) => void } = {},
): Promise<ScriptResult[]> {
  const out: ScriptResult[] = [];
  for (const c of changes) {
    const r = opts.signal?.aborted
      ? result(c, 'failed', 'Not started: stopped')
      : await writeOne(c, applyEdits(c.opened, c.edits), port, opts.check !== false);
    out.push(r);
    opts.onResult?.(r, out.length, changes.length);
  }
  return out;
}

const result = (c: ScriptChange, status: ScriptStatus, message?: string): ScriptResult => ({
  rid: c.rid, prop: c.prop, type: c.type, name: c.name, businessId: c.businessId, status,
  ...(message ? { message } : {}), changes: c.edits.length, before: c.opened, edits: c.edits,
});

/** One script: read again and compare, parse, write, read back. */
async function writeOne(c: ScriptChange, value: string, port: ReplacePort, check: boolean): Promise<ScriptResult> {
  let refused: Extract<SyntaxAnswer, { ok: false }> | null = null;
  let res: Awaited<ReturnType<typeof runCodeSave>>;
  try {
    res = await runCodeSave({ [c.prop]: { value, opened: c.opened } }, {
      fetch: props => port.fetch(c.rid, props),
      write: async (prop, v) => {
        if (check && isEcScriptProp(prop)) {
          const a = await port.check(v);
          if (!a.ok) { refused = a; return { ok: false, error: a.message, notSent: true }; }
        }
        return port.write(c.rid, c, prop, v);
      },
      // Nothing is overwritten: a script that changed is left as it is.
      decide: async () => 'cancel',
      ...(port.pause ? { pause: port.pause } : {}),
    });
  } catch (e) {
    return result(c, 'failed', e instanceof Error ? e.message : String(e));
  }
  if (res.kind === 'cancelled') {
    return res.check.state === 'changed'
      ? result(c, 'changed', CHANGED_ON_SERVER)
      : result(c, 'failed', `Could not read it: ${res.check.state === 'unreadable' ? res.check.error : ''}`.trim());
  }
  if (res.kind === 'review') return result(c, 'changed', CHANGED_ON_SERVER);
  const o = res.props[0];
  if (!o) return result(c, 'failed', 'Nothing was saved');
  const r = refused as Extract<SyntaxAnswer, { ok: false }> | null;
  switch (o.kind) {
    case 'saved': return result(c, 'saved');
    case 'stored-differs': return result(c, 'saved', 'The server stores a different text');
    case 'saved-unverified': return result(c, 'saved', 'Saved; the read back failed');
    case 'failed': return r ? result(c, r.verdict ? 'syntax' : 'failed', r.message) : result(c, 'failed', o.error);
    default:
      return o.outcome === 'saved' ? result(c, 'saved', 'No answer at first; the read back shows it was saved')
        : o.outcome === 'not-saved' ? result(c, 'failed', 'No answer from the server; it was not saved')
        : result(c, 'unknown', 'No answer from the server; whether it was saved is not known');
  }
}

// ── the record and the undo ───────────────────────────────────────

/** What the last replace of one server changed: enough to put the texts back. */
export interface ReplaceRecord {
  v: 1;
  environment: string;
  /** ISO time. */
  at: string;
  find: string;
  replace: string;
  /** The scripts that were saved. */
  scripts: Array<ScriptLabel & { rid: string; prop: string; before: string; edits: Edit[] }>;
}

export const replaceRecordKey = (environment: string): string => `crev_replace_undo:${environment}`;

export function buildReplaceRecord(environment: string, q: Pick<ReplaceQuery, 'find' | 'replace'>, results: readonly ScriptResult[], at: Date = new Date()): ReplaceRecord | null {
  const scripts = results.filter(isSaved).map(r => ({ rid: r.rid, prop: r.prop, type: r.type, name: r.name, businessId: r.businessId, before: r.before, edits: r.edits }));
  return scripts.length ? { v: 1, environment, at: at.toISOString(), find: q.find, replace: q.replace, scripts } : null;
}

/** Read a stored record; null for anything else. */
export function readReplaceRecord(value: unknown, environment: string): ReplaceRecord | null {
  const r = value as ReplaceRecord | null;
  if (!r || typeof r !== 'object' || r.v !== 1 || r.environment !== environment || typeof r.at !== 'string' || !Array.isArray(r.scripts) || !r.scripts.length) return null;
  for (const s of r.scripts) {
    if (!s || typeof s.rid !== 'string' || typeof s.prop !== 'string' || typeof s.before !== 'string' || !Array.isArray(s.edits)) return null;
  }
  return r;
}

export const UNDONE_CHANGED = 'Changed on the server since the replace; left as it is';

/** Put the texts back, where the server still holds the text the replace wrote. */
export async function undoReplace(
  record: ReplaceRecord,
  port: ReplacePort,
  opts: { onResult?: (r: ScriptResult, done: number, total: number) => void } = {},
): Promise<ScriptResult[]> {
  const out: ScriptResult[] = [];
  for (const s of record.scripts) {
    const written = applyEdits(s.before, s.edits);
    const c: ScriptChange = { rid: s.rid, prop: s.prop, type: s.type, name: s.name, businessId: s.businessId, opened: written, edits: [[0, written.length, s.before]] };
    const r = await writeOne(c, s.before, port, false);
    const res: ScriptResult = r.status === 'changed' ? { ...r, message: UNDONE_CHANGED } : { ...r, before: s.before, edits: s.edits, changes: s.edits.length };
    out.push(res);
    opts.onResult?.(res, out.length, record.scripts.length);
  }
  return out;
}

/** The record without the scripts that were put back (null: none left). */
export function recordAfterUndo(record: ReplaceRecord, results: readonly ScriptResult[]): ReplaceRecord | null {
  const back = new Set(results.filter(isSaved).map(r => `${r.rid}|${r.prop}`));
  const scripts = record.scripts.filter(s => !back.has(`${s.rid}|${s.prop}`));
  return scripts.length ? { ...record, scripts } : null;
}

// ── words ─────────────────────────────────────────────────────────

const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

/** "Change 7…" on the button. */
export const changeButtonText = (matches: number): string => `Change ${matches.toLocaleString('en')}…`;

/** The confirmation's question. */
export function confirmQuestion(matches: number, objects: number): string {
  return `Change ${n(matches, 'match', 'matches')} in ${n(objects, 'object')}?`;
}

/** "4 saved, 1 not saved". */
export function resultSummary(results: readonly Pick<ScriptResult, 'status'>[]): { saved: number; notSaved: number } {
  const saved = results.filter(isSaved).length;
  return { saved, notSaved: results.length - saved };
}

export const changesText = (count: number): string => n(count, 'change');

/** The same by object: an object is saved when every script of it was. */
export function objectSummary(results: readonly Pick<ScriptResult, 'rid' | 'status'>[]): { saved: number; notSaved: number } {
  const bad = new Set(results.filter(r => r.status !== 'saved').map(r => r.rid));
  const all = new Set(results.map(r => r.rid));
  return { saved: all.size - bad.size, notSaved: bad.size };
}
