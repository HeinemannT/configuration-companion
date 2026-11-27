/**
 * Code search engine: find text, or the references to one object, in the
 * Extended Code of a server.
 *
 * One function, `runCodeSearch(request, source, sink)`, serves the code
 * search window, "Used in code" and the AI tool. It reads objects from a
 * source in batches, matches each one completely (every property, every
 * line) and reports
 *  - the hits of the requested page (`offset`, `limit` objects) as they are
 *    found, and
 *  - exact totals and a coverage statement: how many objects of the scope
 *    were searched, of how many, from which source and how fresh.
 *
 * Sources:
 *  - `indexSource`: the local code index (code-index-store, made and
 *    refreshed on the user's request by code-copy). Every query is local: complete, case-insensitive,
 *    whole-word and regex alike, in milliseconds.
 *  - `serverSource`: the search without an index. No search text on the
 *    server (code-scope-read): constant scripts list every object with code
 *    and read what changed since the last search; the code read is kept in
 *    the worker and everything is matched here, so the result is complete. Above READ_ALL_CHARS of code
 *    to read, small varying scripts narrow on the server first.
 *
 * References come precomputed with `findCodeRefs` (lib/code-refs); a hit is
 * a reference whose key is the target's RID, or an `ns.id` key with the
 * target's business ID that resolves to the target (`resolveKeys`, one
 * batched post), so look-alike IDs in other ID spaces do not count.
 */

import { compileSearch, referencePrefilter, type Prefilter } from './code-search-match';
import { CONTEXT_OBJECT } from './ec-parser';
import type { FeedInfo, FeedTicket } from './code-feed';
import { BULK_MIN_OBJECTS, BULK_TARGET_CHARS, buildHitScanEcs, buildSourceCodeEc, buildSourceListEc, codeReadCache, listTypeGroups, parseHitScanLog, parseSourceCodeLog, parseSourceListLog, passesPrefilter, BULK_READ_MAX_CHARS, NARROW_READ_MAX, READ_ALL_CHARS, READ_CACHE_OBJECT_CHARS, settledStamp, type CachedListing, type ListedObject, type ListedRow } from './code-scope-read';
import { scriptKey } from './load-governor';
import { CONTEXT_PER_POST } from './constants';
import { foldIntoTemplate, propsOf, readObjects, STATIC_CODE_PROPS, toIndexed, type CodePropMap, type IndexClient, type Placement, type ReadObject } from './code-index-sync';
import { parseRefKey, refLabel, type CodeRefForm } from './code-refs';
import { isClassNamespace, resolveNamespace } from './namespace';
import type { CodeIndexMeta, CodeIndexStore, IndexedObject } from './code-index-store';
import type { RefResolution } from './code-ref-resolve';
import { ecResultError } from './error-kind';
import type { CodeSearchResult } from './types';
import { kindOfProp } from './object-window-table';
import { BUDGET, Pacer } from './index-budget';
import { backgroundSignal, lowPrioritySignal, queueWaitOf } from './request-class';
import type { EcResult } from './bmp-client';

// ── interface ─────────────────────────────────────────────────────

export interface CodeSearchTarget { rid: string; businessId: string; name?: string; type?: string }

export interface CodeSearchRequest {
  mode: 'text' | 'refs';
  /** Text mode: what to look for. */
  text?: string;
  /** Refs mode: the object whose references are listed. */
  target?: CodeSearchTarget;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Code types to search; all code types when left out. */
  types?: readonly string[];
  /** Code properties to search (`expression`, `showExpression` …); every
   *  property when left out. */
  props?: readonly string[];
  /** Objects of a subtree (RIDs the server listed); the whole server when
   *  left out. */
  scopeRids?: ReadonlySet<string>;
  /** Where: `root:<accessor>` (a root) or `org:<RID>` (an organisation and
   *  its sub-organisations); any of them. Everywhere when left out. */
  where?: readonly string[];
  /** Fold instances whose code is their template's into the template's
   *  row. Every object is still counted. */
  fold?: boolean;
  /** Hits reported for objects `offset` … `offset + limit - 1`. Every match
   *  is still counted. */
  offset?: number;
  limit?: number;
  /** Order of the objects: most matches first (default for text), by name,
   *  by location ("where", default for references), or as stored. */
  sort?: CodeSearchSort;
}

export type CodeSearchSort = 'matches' | 'name' | 'location' | 'stored';

export interface CodeSearchLine {
  line: number;
  text: string;
  /** Match ranges on `text`. */
  ranges: Array<[number, number]>;
  /** Characters cut from the start of a long line. */
  cut?: number;
  /** "Used in code": the reference as written, without a trailing code
   *  property (`t.x`, `o.x`, `t.get("x")`, `{x}`, `lookup(123)`). */
  form?: string;
}

export interface CodeSearchHit {
  rid: string;
  type: string;
  name: string;
  businessId: string;
  where: string;
  matches: number;
  props: CodeSearchProp[];
  root?: string;
  /** Organisation root: organisation RIDs, top-level first. */
  path?: string[];
  /** The template this object is an instance of. */
  tmpl?: string;
  /** An instance with code of its own (not folded). */
  overridden?: boolean;
  /** Folded: instances whose code is this row's code. */
  instances?: FoldedInstance[];
}

/** The matched lines of one property, with what the results show around
 *  them. A hit carries no full property text: the lines around each listed
 *  match (`CONTEXT_LINES` above and below) come with it, and the full text is
 *  read only when the user widens the context beyond them (or opens the
 *  object, which reads it anyway). */
export interface CodeSearchProp {
  prop: string;
  lines: CodeSearchLine[];
  /** Lines of the property (with `context`). */
  lineCount?: number;
  /** The lines around the listed matches that `lines` does not already hold
   *  in full, as [line number, text]. A line longer than
   *  `CONTEXT_LINE_CHARS` is left out (the full text is read for it). */
  around?: Array<[number, string]>;
}

/** Lines shown above and below a match when its context opens. */
export const CONTEXT_LINES = 3;
/** Longer lines are not carried as context. */
export const CONTEXT_LINE_CHARS = 2_000;

/** An instance folded into its template's row. */
export interface FoldedInstance { rid: string; name: string; businessId: string; where: string; type: string; path?: string[] }

export interface CodeSearchCoverage {
  source: 'index' | 'server';
  /** Objects with code that were searched. */
  searched: number;
  /** Objects with code in the scope. */
  total: number;
  complete: boolean;
  /** Index: when it was last brought up to date (ms). */
  indexedAt?: number | null;
  /** Index: `indexedAt` is a refresh's (the copy was checked then), not the
   *  time the copy was made. */
  checked?: boolean;
  /** Index: objects listed but not read yet (first build under way). */
  pending?: number;
  /** Types the source could not list. */
  failedTypes?: string[];
  /** An index built root by root: the roots read completely, those still
   *  to read, and of the organisation root the top-level organisations. */
  roots?: { done: string[]; pending: string[]; tops?: { done: number; total: number } };
  /** The search was limited (Where) to parts that are read completely. */
  scopedComplete?: boolean;
  /** Server: objects whose code this search read from the server (new or
   *  changed since the code read before, or everything the first time). The
   *  rest came from the code kept in the extension. */
  read?: number;
  /** Server: of `read`, objects read before at another stamp (changed
   *  since); the others are new to these searches (a wider scope). */
  readChanged?: number;
  /** Server: too much code to read it all, so the server narrowed the
   *  objects first; `read` of them were read and matched. */
  narrowed?: boolean;
  /** Server: when the listing this search used was made (ms, the worker's
   *  clock): the time of the last check for changed code. */
  checkedAt?: number;
  /** Server: the listing was not made for this search but kept from one a
   *  few seconds older (code-scope-read LISTING_REUSE_MS), or kept current
   *  by the change feed (`feedAt`). */
  listingReused?: boolean;
  /** Server: the change feed keeps the listing current; the time of its
   *  last successful check (ms, the worker's clock). */
  feedAt?: number;
}

export interface CodeSearchOutcome {
  matchedObjects: number;
  matches: number;
  /** Lines that hold a match (a line can hold several). */
  lines: number;
  /** Matched objects per type (the results). */
  byType: Record<string, number>;
  /** Matched objects per type with the property filter applied but not the
   *  type filter: what choosing that type gives. */
  typeCounts: Record<string, number>;
  /** Matched objects per property with the type filter applied but not the
   *  property filter: what choosing that property gives. */
  propCounts: Record<string, number>;
  /** Matched objects per "Kind of code" group (object-window-table
   *  CODE_KINDS), with the type and where filters applied. */
  kindCounts: Record<string, number>;
  /** Matched objects per `root:<accessor>` and `org:<RID>` (an organisation
   *  counts its sub-organisations), with the type and property filters
   *  applied but not Where. */
  whereCounts: Record<string, number>;
  /** Rows of the results: objects, with folded instances in their
   *  template's row (equal to matchedObjects without folding). */
  rows: number;
  /** More matched objects exist after this page. */
  more: boolean;
  coverage: CodeSearchCoverage;
  ms: number;
}

/** A searchable object: what the index stores, or what a server read gave. */
export type SearchableObject = Pick<IndexedObject, 'rid' | 'type' | 'name' | 'businessId' | 'where' | 'code' | 'refs'>
  & Partial<Pick<IndexedObject, 'root' | 'path' | 'tmpl' | 'inherits'>>;

/** An instance's code as it is on the server: its own properties, plus the
 *  template's text for the properties it inherits (`inherits`). */
export function effectiveObject(o: SearchableObject, byRid: ReadonlyMap<string, SearchableObject>): SearchableObject {
  if (!o.tmpl || !o.inherits?.length) return o;
  const t = byRid.get(o.tmpl);
  if (!t) return o;
  const code: Record<string, string> = {};
  const inh = new Set(o.inherits);
  for (const p of o.inherits) if (t.code[p]) code[p] = t.code[p];
  Object.assign(code, o.code);
  const refs = [...t.refs.filter(r => inh.has(r.p) && !(r.p in o.code)), ...o.refs];
  return { ...o, code, refs };
}

/** An instance whose code is entirely its template's. */
export function isIdentical(o: SearchableObject, byRid: ReadonlyMap<string, SearchableObject>): boolean {
  if (!o.tmpl || !o.inherits?.length || Object.keys(o.code).length) return false;
  const t = byRid.get(o.tmpl);
  // Every code property of the template is the instance's too.
  return !!t && Object.keys(t.code).every(p => o.inherits!.includes(p));
}

/** Does the object lie in one of the Where keys? */
export function inWhere(o: Pick<SearchableObject, 'root' | 'path'>, where: readonly string[]): boolean {
  for (const k of where) {
    if (k.startsWith('root:') && o.root === k.slice(5)) return true;
    if (k.startsWith('org:') && o.path?.includes(k.slice(4))) return true;
  }
  return false;
}

/** How far a live scan is: the scan posts (places listed), then the reads of
 *  the candidates. */
export interface CodeSearchProgress {
  phase: 'scan' | 'read';
  /** Scan posts sent, of `posts`. */
  postsDone: number;
  posts: number;
  /** Candidates read, of `candidates` (known once the scan posts are done). */
  read: number;
  candidates: number;
  /** What the read phase reads: `all` the code of the place that is not
   *  kept from an earlier search (the first search, or after the worker
   *  restarted), or only the `hits` the server narrowed to. */
  reading?: 'all' | 'hits';
  /** Listing: objects with code listed so far, and the source being
   *  listed (1-based) of `sources`. */
  listed?: number;
  source?: number;
  sources?: number;
  /** Once listed: objects with code in the place and their code's size. */
  total?: number;
  chars?: number;
  /** Reading all: objects searched so far (kept ones and those read), of
   *  `total`. */
  searched?: number;
}

/** Objects read so far by a live scan, before the scan ends: their code is
 *  their own text as the server returned it (instances not yet folded). */
export type ScanPreview = (objects: readonly SearchableObject[], progress: CodeSearchProgress) => void;

export interface CodeSearchSource {
  kind: 'index' | 'server';
  /** Objects in batches (filtered by `req` where the source can).
   *  `preview` (optional): objects as they are read, with the progress. */
  scan(req: CodeSearchRequest, each: (batch: readonly SearchableObject[]) => boolean | void, signal: AbortSignal, preview?: ScanPreview): Promise<void>;
  /** Base of the coverage statement, after the scan. */
  coverage(searched: number, req: CodeSearchRequest): CodeSearchCoverage;
}

export interface CodeSearchOptions {
  signal?: AbortSignal;
  /** Resolve `ns.id` keys to objects ("Used in code"). */
  resolveKeys?(keys: string[]): Promise<Record<string, RefResolution>>;
  /** "Used in code" over every object of a complete copy: the keys the
   *  scanned objects answer (copyTargetKeys) are not resolved. Only for a
   *  scan of the whole copy. */
  namesFromCopy?: boolean;
  now?: () => number;
  /** A live scan's first results, before the whole scan is matched, sorted
   *  and folded: the matching objects of each read as it arrives (text
   *  search; "Used in code" reports progress only), with the progress. The
   *  final, complete answer still goes to the sink. */
  onPartial?(hits: CodeSearchHit[], progress: CodeSearchProgress): void;
  /** Hits carry the lines around each match (CodeSearchProp `around`): for
   *  results sent to a window, which has no copy of the code. */
  context?: boolean;
}

export const PAGE_OBJECTS = 200;
/** Lines kept per object in a hit (matches are still counted). */
const LINES_PER_OBJECT = 200;
/** Long lines are cut to this many characters around the first match. */
const LINE_CHARS = 600;
/** Hits are handed to the sink in groups of about this many. */
const SINK_BATCH = 20;

// ── matching ──────────────────────────────────────────────────────

/** The matches of one property: their count and the first lines. */
interface PropMatch { prop: string; n: number; lines: CodeSearchLine[] }

/** Every property of an object with a match (null: none). The filters are
 *  applied afterwards, so one match also gives the counts of the menus. */
type ObjectMatcher = (o: SearchableObject) => PropMatch[] | null;

function cutLine(text: string, ranges: Array<[number, number]>): { text: string; ranges: Array<[number, number]>; cut?: number } {
  if (text.length <= LINE_CHARS) return { text, ranges };
  const start = Math.max(0, (ranges[0]?.[0] ?? 0) - 200);
  const shown = text.slice(start, start + LINE_CHARS);
  const shifted = ranges.map(([a, b]) => [a - start, b - start] as [number, number]).filter(([a, b]) => a >= 0 && b <= shown.length);
  return { text: shown, ranges: shifted, ...(start ? { cut: start } : {}) };
}

/** A listed line that is its whole line: a longer line is cut to
 *  LINE_CHARS characters around its first match (`cut` is set only when the
 *  cut starts after the line's first character). */
export function isWholeLine(l: Pick<CodeSearchLine, 'text' | 'cut'>): boolean {
  return !l.cut && l.text.length < LINE_CHARS;
}

/** The lines around the listed matches of one property (CodeSearchProp). */
function contextOf(text: string, lines: readonly CodeSearchLine[]): { lineCount: number; around: Array<[number, string]> } {
  const all = text.split(/\r?\n/);
  const whole = new Set(lines.filter(isWholeLine).map(l => l.line));
  const want = new Set<number>();
  for (const l of lines) {
    for (let n = Math.max(1, l.line - CONTEXT_LINES); n <= Math.min(all.length, l.line + CONTEXT_LINES); n++) if (!whole.has(n)) want.add(n);
  }
  const around: Array<[number, string]> = [];
  for (const n of [...want].sort((a, b) => a - b)) {
    const t = all[n - 1] ?? '';
    if (t.length <= CONTEXT_LINE_CHARS) around.push([n, t]);
  }
  return { lineCount: all.length, around };
}

/** The hit of the matched properties; at most LINES_PER_OBJECT lines in all. */
function hitOf(o: SearchableObject, matched: readonly PropMatch[], context = false): CodeSearchHit {
  const props: CodeSearchHit['props'] = [];
  let matches = 0;
  let room = LINES_PER_OBJECT;
  for (const p of matched) {
    matches += p.n;
    const lines = p.lines.slice(0, Math.max(0, room));
    room -= lines.length;
    if (lines.length) props.push({ prop: p.prop, lines, ...(context ? contextOf(o.code[p.prop] ?? '', lines) : {}) });
  }
  return {
    rid: o.rid, type: o.type, name: o.name, businessId: o.businessId, where: o.where, matches, props,
    ...(o.root ? { root: o.root } : {}), ...(o.path?.length ? { path: o.path } : {}), ...(o.tmpl ? { tmpl: o.tmpl } : {}),
  };
}

function textMatcher(req: CodeSearchRequest): ObjectMatcher | { error: string } {
  const c = compileSearch({ query: req.text ?? '', caseSensitive: req.caseSensitive ?? true, wholeWord: !!req.wholeWord, regex: !!req.regex });
  if ('error' in c) return c;
  return o => {
    const out: PropMatch[] = [];
    for (const prop of Object.keys(o.code)) {
      const text = o.code[prop];
      if (!text) continue;
      let n = 0;
      const lines: CodeSearchLine[] = [];
      const all = text.split(/\r?\n/);
      for (let i = 0; i < all.length; i++) {
        const r = c.ranges(all[i]);
        if (!r.length) continue;
        n += r.length;
        if (lines.length < LINES_PER_OBJECT) lines.push({ line: i + 1, ...cutLine(all[i], r) });
      }
      if (n) out.push({ prop, n, lines });
    }
    return out.length ? out : null;
  };
}

/** The reference as written: `t.x`, `t.get("x")`, `{x}`, `lookup(123)`. */
function formLabel(key: string, form: string): string {
  const p = parseRefKey(key);
  return p ? refLabel({ ns: p.ns, id: p.id, form: form as CodeRefForm }) : form;
}

/**
 * The `ns.id` keys (each with the target's business ID) that a complete
 * copy answers without the server. An ID key names the object of its
 * namespace with that ID; an object's namespace comes from its class
 * (namespace.ts resolveNamespace, the rule the by-ID lookup plans with).
 *  - The target's own namespace: the key names the target when no other
 *    object of the copy has that ID in that namespace.
 *  - Another namespace: the key names some other object, or none.
 * Asked from the server (`ask`): every key when the target's class is not
 * known; a namespace no class maps to (its objects' classes are not known);
 * two objects with the ID in the target's namespace. Objects without code
 * are not in a copy: an object without code that shares the target's ID and
 * namespace is not seen.
 */
export function copyTargetKeys(
  target: CodeSearchTarget, named: Iterable<string>,
  objects: Iterable<Pick<SearchableObject, 'rid' | 'type' | 'businessId'>>,
): { keys: Set<string>; ask: string[] } {
  const all = [...named];
  const same: Array<Pick<SearchableObject, 'rid' | 'type'>> = [];
  let type = target.type;
  for (const o of objects) {
    if (o.rid === target.rid) type ??= o.type;
    else if (o.businessId === target.businessId) same.push(o);
  }
  if (!type || !target.businessId) return { keys: new Set(), ask: all };
  const own = resolveNamespace(type);
  const keys = new Set<string>();
  const ask: string[] = [];
  for (const k of all) {
    const p = parseRefKey(k);
    if (!p?.ns || p.id !== target.businessId || !isClassNamespace(p.ns)) { ask.push(k); continue; }
    if (p.ns !== own) continue;
    if (same.some(o => resolveNamespace(o.type) === own)) ask.push(k);
    else keys.add(k);
  }
  return { keys, ask };
}

/** Keys whose references point at `target`: its RID, plus every `ns.id`
 *  key with its business ID that resolves to it. `copy`: every object of a
 *  complete copy; the keys it answers are not asked (copyTargetKeys). */
async function targetKeys(target: CodeSearchTarget, candidates: Set<string>, opts: CodeSearchOptions, copy?: readonly SearchableObject[]): Promise<Set<string>> {
  const keys = new Set<string>([`rid:${target.rid}`]);
  let named = [...candidates].filter(k => !k.startsWith('rid:'));
  if (named.length && copy) {
    const local = copyTargetKeys(target, named, copy);
    for (const k of local.keys) keys.add(k);
    named = local.ask;
  }
  if (!named.length) return keys;
  if (!opts.resolveKeys) {
    // Without a resolver only the plain template space counts.
    for (const k of named) if (k === `t.${target.businessId}`) keys.add(k);
    return keys;
  }
  const res = await opts.resolveKeys(named);
  for (const k of named) {
    const r = res[k];
    if (r?.found && r.target.rid === target.rid) keys.add(k);
  }
  return keys;
}

function refsMatcher(keys: ReadonlySet<string>): ObjectMatcher {
  return o => {
    const byProp = new Map<string, PropMatch>();
    let lines: string[] | null = null;
    let lastProp = '';
    for (const r of o.refs) {
      if (!keys.has(r.k)) continue;
      if (r.p !== lastProp) { lines = (o.code[r.p] ?? '').split(/\r?\n/); lastProp = r.p; }
      const text = lines?.[r.l - 1] ?? '';
      const pm = byProp.get(r.p) ?? { prop: r.p, n: 0, lines: [] };
      pm.n++;
      const list = pm.lines;
      const prev = list[list.length - 1];
      if (prev && prev.line === r.l) prev.ranges.push([r.s - (prev.cut ?? 0), r.e - (prev.cut ?? 0)]);
      else if (list.length < LINES_PER_OBJECT) list.push({ line: r.l, ...cutLine(text, [[r.s, r.e]]), form: formLabel(r.k, r.f) });
      byProp.set(r.p, pm);
    }
    return byProp.size ? [...byProp.values()] : null;
  };
}

/** Run a search. `sink` gets the hits of the requested page in groups. */
export async function runCodeSearch(
  req: CodeSearchRequest,
  source: CodeSearchSource,
  sink: (hits: CodeSearchHit[]) => void,
  opts: CodeSearchOptions = {},
): Promise<CodeSearchOutcome> {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const signal = opts.signal ?? new AbortController().signal;
  const offset = Math.max(0, req.offset ?? 0);
  const limit = Math.max(1, req.limit ?? PAGE_OBJECTS);
  const types = req.types?.length ? new Set(req.types) : null;
  const props = req.props?.length ? new Set(req.props) : null;
  const where = req.where?.length ? req.where : null;
  // Instances read their inherited code from the template: every object is
  // collected first (the index is local; a server scan has no instances).
  // One scan per search: "Used in code" takes its candidate keys from the
  // same objects it then matches.
  const objects: SearchableObject[] = [];
  let match: ObjectMatcher;
  if (req.mode === 'refs') {
    const target = req.target;
    if (!target || !/^-?\d{1,20}$/.test(target.rid)) throw new Error('Choose the object whose references to find.');
    // Candidate keys come from the objects themselves: one resolve for all.
    const named = new Set<string>();
    await source.scan(req, batch => {
      signal.throwIfAborted();
      for (const o of batch) {
        objects.push(o);
        if (target.businessId) for (const r of o.refs) if (!r.k.startsWith('rid:') && r.k.slice(r.k.indexOf('.') + 1) === target.businessId) named.add(r.k);
      }
    }, signal, opts.onPartial ? (_o, p) => opts.onPartial!([], p) : undefined);
    // A complete copy holds every object with code: its names are answered here.
    const complete = !!opts.namesFromCopy && source.kind === 'index' && source.coverage(objects.length, req).complete;
    match = refsMatcher(await targetKeys(target, named, opts, complete ? objects : undefined));
  } else {
    const m = textMatcher(req);
    if ('error' in m) throw new Error(m.error);
    match = m;
    // First results while the scan runs: each read's matching objects, with
    // their own code (an instance's own text is its effective text).
    const preview: ScanPreview | undefined = opts.onPartial ? (batch, progress) => {
      const hits: CodeSearchHit[] = [];
      for (const o of batch) {
        if (req.scopeRids && !req.scopeRids.has(o.rid)) continue;
        if ((types && !types.has(o.type)) || (where && !inWhere(o, where))) continue;
        const found = match(o);
        const inProps = found && (props ? found.filter(p => props.has(p.prop)) : found);
        // Without the lines around: a first result is replaced by the final row.
        if (inProps?.length) hits.push(hitOf(o, inProps));
      }
      opts.onPartial!(hits, progress);
    } : undefined;
    await source.scan(req, batch => { signal.throwIfAborted(); for (const o of batch) objects.push(o); }, signal, preview);
  }
  let searched = 0;
  let matchedObjects = 0;
  let matches = 0;
  let lineCount = 0;
  const byType: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  const propCounts: Record<string, number> = {};
  const kindCounts: Record<string, number> = {};
  const whereCounts: Record<string, number> = {};
  const sort = req.sort ?? (req.mode === 'refs' ? 'location' : 'matches');
  const byRid = new Map<string, SearchableObject>();
  for (const o of objects) byRid.set(o.rid, o);
  // An instance with the template's code matches as the template does:
  // matched once per template.
  const sameAs = new Map<string, PropMatch[] | null>();
  const all: CodeSearchHit[] = [];
  const identical = new Set<string>();
  for (const o of objects) {
    if (req.scopeRids && !req.scopeRids.has(o.rid)) continue;
    // Every type and place is matched, so the menus can count what each
    // entry would give; only the chosen ones are searched and listed.
    const typeOk = !types || types.has(o.type);
    const whereOk = !where || inWhere(o, where);
    if (typeOk && whereOk) searched++;
    const same = isIdentical(o, byRid);
    let found: PropMatch[] | null;
    let eff: SearchableObject;
    if (same) {
      const t = byRid.get(o.tmpl!)!;
      eff = { ...o, code: t.code, refs: t.refs };
      if (!sameAs.has(t.rid)) sameAs.set(t.rid, match(t));
      found = sameAs.get(t.rid) ?? null;
    } else {
      eff = effectiveObject(o, byRid);
      found = match(eff);
    }
    if (!found) continue;
    const inProps = props ? found.filter(p => props.has(p.prop)) : found;
    if (inProps.length && whereOk) typeCounts[o.type] = (typeCounts[o.type] ?? 0) + 1;
    if (typeOk && inProps.length) {
      if (o.root) whereCounts[`root:${o.root}`] = (whereCounts[`root:${o.root}`] ?? 0) + 1;
      for (const org of o.path ?? []) whereCounts[`org:${org}`] = (whereCounts[`org:${org}`] ?? 0) + 1;
    }
    if (!typeOk || !whereOk) continue;
    const kinds = new Set<string>();
    for (const p of found) { propCounts[p.prop] = (propCounts[p.prop] ?? 0) + 1; kinds.add(kindOfProp(p.prop)); }
    for (const k of kinds) kindCounts[k] = (kindCounts[k] ?? 0) + 1;
    if (!inProps.length) continue;
    const hit = hitOf(eff, inProps, opts.context);
    if (o.tmpl && !same) hit.overridden = true;
    if (same) identical.add(o.rid);
    matchedObjects++;
    matches += hit.matches;
    for (const p of hit.props) lineCount += p.lines.length;
    byType[o.type] = (byType[o.type] ?? 0) + 1;
    all.push(hit);
  }
  signal.throwIfAborted();
  if (sort !== 'stored') all.sort(compareHits(sort));
  const rows = req.fold ? foldInstances(all, identical) : all;
  const page = rows.slice(offset, offset + limit);
  for (let i = 0; i < page.length; i += SINK_BATCH) sink(page.slice(i, i + SINK_BATCH));
  return {
    matchedObjects, matches, lines: lineCount, byType, typeCounts, propCounts, kindCounts, whereCounts, rows: rows.length,
    more: rows.length > offset + limit,
    coverage: source.coverage(searched, req), ms: Math.round(now() - t0),
  };
}

/** Rows with instances folded: an instance whose code is its template's
 *  joins the template's row; without the template among the results, the
 *  first such instance carries the row. Rows keep the order of their
 *  first object. */
export function foldInstances(hits: readonly CodeSearchHit[], identical: ReadonlySet<string>): CodeSearchHit[] {
  const rowOf = new Map<string, CodeSearchHit>();
  const rows: CodeSearchHit[] = [];
  for (const h of hits) if (!identical.has(h.rid)) { const r = { ...h }; rows.push(r); rowOf.set(h.rid, r); }
  for (const h of hits) {
    if (!identical.has(h.rid) || !h.tmpl) continue;
    const ref: FoldedInstance = { rid: h.rid, name: h.name, businessId: h.businessId, where: h.where, type: h.type, ...(h.path ? { path: h.path } : {}) };
    const host = rowOf.get(h.tmpl);
    if (host) { (host.instances ??= []).push(ref); continue; }
    const r: CodeSearchHit = { ...h, instances: [] };
    rowOf.set(h.tmpl, r);
    rows.push(r);
  }
  const firstAt = new Map<CodeSearchHit, number>();
  hits.forEach((h, i) => {
    const r = identical.has(h.rid) && h.tmpl ? rowOf.get(h.tmpl) : rowOf.get(h.rid);
    if (r && !firstAt.has(r)) firstAt.set(r, i);
  });
  return rows.sort((a, b) => (firstAt.get(a) ?? 0) - (firstAt.get(b) ?? 0));
}

const byName = (a: CodeSearchHit, b: CodeSearchHit) => (a.name || a.businessId).localeCompare(b.name || b.businessId) || a.rid.localeCompare(b.rid);

export function compareHits(sort: CodeSearchSort): (a: CodeSearchHit, b: CodeSearchHit) => number {
  if (sort === 'name') return byName;
  if (sort === 'location') return (a, b) => a.where.localeCompare(b.where) || byName(a, b);
  return (a, b) => b.matches - a.matches || byName(a, b);
}

// ── index source ──────────────────────────────────────────────────

/** Search the local index. `objects` may be a snapshot the caller keeps in
 *  memory (the search window); otherwise the store is read in batches. */
/** Index meta the coverage statement needs. */
export type CoverageMeta = Pick<CodeIndexMeta, 'pending' | 'builtAt' | 'objects' | 'syncedAt'> & Partial<Pick<CodeIndexMeta, 'roots' | 'rootOrder' | 'orgs' | 'stage'>>;

/** The roots of an index that is still being built root by root (null
 *  once every root is read). */
export function partialRoots(meta: CoverageMeta | null): CodeSearchCoverage['roots'] | null {
  if (!meta?.roots) return null;
  const order = meta.rootOrder ?? Object.keys(meta.roots);
  const done = order.filter(k => meta.roots![k]?.done);
  const pending = order.filter(k => meta.roots![k] && !meta.roots![k].done);
  if (!pending.length) return null;
  const org = meta.roots.organisation;
  return { done, pending, ...(org?.tops != null ? { tops: { done: org.topsDone ?? 0, total: org.tops } } : {}) };
}

/** Is everything a Where key names read completely? */
export function whereCovered(key: string, meta: CoverageMeta | null): boolean {
  const roots = meta?.roots;
  if (!roots) return false;
  if (key.startsWith('root:')) return !!roots[key.slice(5)]?.done;
  if (key.startsWith('org:')) {
    const org = roots.organisation;
    if (!org) return false;
    if (org.done) return true;
    let top = key.slice(4);
    for (let i = 0; i < 32 && meta?.orgs?.[top]?.parent; i++) top = meta.orgs[top].parent;
    return !!org.topsRead?.includes(top);
  }
  return false;
}

/** Search the local index. `objects` may be a snapshot the caller keeps in
 *  memory (the search window); otherwise the store is read in batches. */
export function indexSource(meta: CoverageMeta | null, read: (each: (batch: readonly SearchableObject[]) => boolean | void) => Promise<void>): CodeSearchSource {
  return {
    kind: 'index',
    scan: (_req, each) => read(each),
    coverage: (searched, req) => {
      const pending = meta?.pending ?? 0;
      const built = !!meta?.builtAt;
      const partial = built ? null : partialRoots(meta);
      // A subtree's total is what the server listed for it.
      const listed = meta?.objects ?? 0;
      const scopedComplete = !built && !!req.where?.length && req.where.every(k => whereCovered(k, meta));
      const total = req.scopeRids ? Math.max(req.scopeRids.size, searched)
        : (built && !pending) || scopedComplete ? searched
        // Still being read: all code types are counted by the object list;
        // one type only by what is read plus what is still to read.
        : req.types ? searched + pending : Math.max(listed, searched);
      return {
        source: 'index', searched, total,
        complete: ((built && pending === 0) || scopedComplete) && (!req.scopeRids || searched >= req.scopeRids.size),
        indexedAt: meta?.syncedAt ?? null,
        ...(meta?.syncedAt != null && meta.builtAt != null && meta.syncedAt !== meta.builtAt ? { checked: true } : {}),
        ...(pending ? { pending } : {}),
        ...(partial ? { roots: partial } : {}),
        ...(scopedComplete ? { scopedComplete: true } : {}),
      };
    },
  };
}

export function storeReader(store: CodeIndexStore, env: string) {
  return (each: (batch: readonly SearchableObject[]) => boolean | void) => store.scan(env, each);
}

// ── server source (fallback) ──────────────────────────────────────

function prefilterOf(req: CodeSearchRequest): Prefilter {
  if (req.mode === 'refs') return referencePrefilter({ rid: req.target?.rid ?? '', businessId: req.target?.businessId ?? '' });
  const c = compileSearch({ query: req.text ?? '', caseSensitive: req.caseSensitive ?? true, wholeWord: !!req.wholeWord, regex: !!req.regex });
  if ('error' in c) throw new Error(c.error);
  return c.prefilter;
}

/** One place the live scan reads: a root (`root.portal`), a top-level
 *  organisation or an organisation (`lookup(<RID>)`), or an object the user
 *  chose (Under …). */
export interface ScanSource {
  from: string;
  /** The source object's RID: then the scan script reaches it as the
   *  command's context, and one script serves every source. */
  rid?: string;
  root?: string;
  path?: string[];
  label?: string;
}

/** A listing post aims at this long; one over LIST_POST_SLOW_MS sends the
 *  next one command alone; at most LIST_GROUP_MAX commands share a post.
 *  Measured on a large server: one command per post mostly answers under
 *  1 s, the slowest took 10 s; twelve in one post took 20 s. */
export const LIST_POST_TARGET_MS = 2_000;
export const LIST_POST_SLOW_MS = 5_000;
export const LIST_GROUP_MAX = 6;

/** Commands in the next listing post, from the last post: `size` commands
 *  asked, `sent` sent, `ms` taken. Grows at most twofold, toward
 *  LIST_POST_TARGET_MS at the last post's time per command (see
 *  listGroups for the per-command rules). */
export function nextListGroup(size: number, ms: number, sent = size): number {
  if (ms > LIST_POST_SLOW_MS) return 1;
  const per = Math.max(1, ms) / Math.max(1, sent);
  const target = Math.floor(LIST_POST_TARGET_MS / per);
  return Math.max(1, Math.min(LIST_GROUP_MAX, size * 2, target));
}

/** How long each listing command took (ms), per server environment,
 *  source and group of types, in this worker's life. */
const listTimes = new Map<string, number>();
const LIST_TIMES_MAX = 5_000;

/**
 * Plan of the listing posts, one post at a time (`take`, then `done` with
 * the post's time). Rules:
 *  - a command that took over LIST_POST_TARGET_MS before goes alone, and a
 *    group stops before the known times of its commands reach the target;
 *  - otherwise the group size follows nextListGroup (1 at first, at most
 *    LIST_GROUP_MAX);
 *  - after a post over LIST_POST_SLOW_MS, posts carry one command until two
 *    posts in a row were under LIST_POST_TARGET_MS.
 * Worst case of one post in flight: a single command (up to its 120 s
 * time-out), or a group whose commands each took at most 2 s before (about
 * 2 s together), or, for commands not timed yet in this worker's life, a
 * group of up to LIST_GROUP_MAX of them sized from fast posts just before:
 * at most LIST_GROUP_MAX times the slowest untimed command, once; the next
 * post is then single.
 */
export function listGroups<T extends { key: string }>(cmds: readonly T[]): { take(): T[]; done(group: readonly T[], ms: number): void } {
  let i = 0;
  let size = 1;
  let single = false;
  let fast = 0;
  return {
    take() {
      const group: T[] = [];
      const limit = single ? 1 : size;
      let known = 0;
      while (group.length < limit && i < cmds.length) {
        const t = listTimes.get(cmds[i].key);
        if (t != null && t > LIST_POST_TARGET_MS && group.length) break;
        if (t != null && group.length && known + t > LIST_POST_TARGET_MS) break;
        group.push(cmds[i++]);
        known += t ?? 0;
        if (t != null && t > LIST_POST_TARGET_MS) break;
      }
      return group;
    },
    done(group, ms) {
      // One command: its own time. Several: each gets the whole post's time
      // (an upper bound) unless it has a time already.
      for (const c of group) if (group.length === 1 || !listTimes.has(c.key)) {
        listTimes.delete(c.key);
        listTimes.set(c.key, ms);
      }
      while (listTimes.size > LIST_TIMES_MAX) listTimes.delete(listTimes.keys().next().value!);
      if (ms > LIST_POST_SLOW_MS) { single = true; fast = 0; size = 1; return; }
      if (single) {
        fast = ms <= LIST_POST_TARGET_MS ? fast + 1 : 0;
        if (fast >= 2) { single = false; size = nextListGroup(1, ms, 1); }
        return;
      }
      size = nextListGroup(size, ms, group.length);
    },
  };
}

/** Posts the next listing of these commands (their keys) takes, by the
 *  rules of listGroups with the times known now (a post takes the known
 *  times of its commands; an unknown one is taken as fast). Nothing is
 *  recorded. */
export function plannedListPosts(keys: readonly string[]): number {
  let i = 0;
  let size = 1;
  let single = false;
  let fast = 0;
  let posts = 0;
  while (i < keys.length) {
    const limit = single ? 1 : size;
    let n = 0;
    let known = 0;
    while (n < limit && i < keys.length) {
      const t = listTimes.get(keys[i]);
      if (t != null && t > LIST_POST_TARGET_MS && n) break;
      if (t != null && n && known + t > LIST_POST_TARGET_MS) break;
      n++; i++;
      known += t ?? 0;
      if (t != null && t > LIST_POST_TARGET_MS) break;
    }
    posts++;
    const ms = known;
    if (ms > LIST_POST_SLOW_MS) { single = true; fast = 0; size = 1; continue; }
    if (single) {
      fast = ms <= LIST_POST_TARGET_MS ? fast + 1 : 0;
      if (fast >= 2) { single = false; size = nextListGroup(1, ms, 1); }
      continue;
    }
    size = nextListGroup(size, ms, n);
  }
  return posts;
}

/** Tests: forget the listing commands' times. */
export function resetListTimes(): void { listTimes.clear(); }

/** The change feed of one server profile as the live search uses it
 *  (code-feed.ts, bound by code-index-service). */
export interface ServerFeed {
  /** "Search again": poll now and apply what changed. */
  refresh(signal: AbortSignal): Promise<void>;
  /** Resolves when the changes received are applied (or `signal` aborts). */
  settled(signal: AbortSignal): Promise<void>;
  /** Does the feed keep this listing current? */
  current(l: CachedListing<ListedRow>): boolean;
  /** Before a listing: the watermark (null: no feed for this listing). */
  begin(signal: AbortSignal): Promise<FeedTicket | null>;
  /** The listing is complete: apply what changed meanwhile, then keep it
   *  with `put` (at once when the feed cannot keep it; never when not `ok`).
   *  True when the feed keeps it current. */
  finish(ticket: FeedTicket, listing: CachedListing<ListedRow>, ok: boolean, put: () => void): Promise<boolean>;
  abandon(): void;
  /** Code kept with a stamp too young to trust after a gap. */
  unsettled(rid: string): void;
  info(): FeedInfo;
}

/** One bulk read command: every object of `type` in a source (one part). */
interface BulkPart { src: string; type: string; parts: number; part: number; chars: number; items: Listed[] }

/**
 * The read plan of `need` (objects to read) within `listed`: many objects of
 * one type in one source with that source's bulk script (it reads EVERY
 * object of the type there), the rest one by one. A bulk read is chosen only
 * when the objects to be read are at least half of what it reads, in
 * characters; bulk reads over BULK_READ_MAX_CHARS read object by object.
 */
function planReads(listed: readonly Listed[], need: readonly Listed[], srcRid: (it: Listed) => string | undefined, bulkOk: boolean): { bulk: BulkPart[]; single: Listed[] } {
  const bulk: BulkPart[] = [];
  const single: Listed[] = [];
  if (bulkOk) {
    const groups = new Map<string, Listed[]>();
    for (const it of need) { const k = `${srcRid(it) ?? ''}|${it.type}`; groups.set(k, [...(groups.get(k) ?? []), it]); }
    for (const [k, items] of groups) {
      const rid = k.slice(0, k.indexOf('|'));
      const all = listed.filter(x => x.src === items[0].src && x.type === items[0].type);
      const allChars = all.reduce((n, it) => n + Math.max(0, it.len), 0);
      const needChars = items.reduce((n, it) => n + Math.max(0, it.len), 0);
      if (!rid || items.length < BULK_MIN_OBJECTS || needChars * 2 < allChars) { single.push(...items); continue; }
      const parts = partsFor(allChars);
      for (let part = 0; part < parts; part++) bulk.push({ src: rid, type: items[0].type, parts, part, chars: Math.ceil(allChars / parts), items });
    }
  } else single.push(...need);
  if (plannedReadChars(bulk, single) > BULK_READ_MAX_CHARS && bulk.length) {
    // The bulk reads would read more than the limit: read only what is
    // needed, object by object.
    for (const b of bulk) for (const it of b.items) if (!single.includes(it)) single.push(it);
    bulk.length = 0;
  }
  return { bulk, single };
}

/** Bulk parts packed into posts of about BULK_POST_CHARS characters. */
function bulkPostsOf(bulk: readonly BulkPart[]): BulkPart[][] {
  const posts: BulkPart[][] = [];
  for (const b of bulk) {
    const last = posts.at(-1);
    if (last && last.reduce((n, x) => n + x.chars, 0) + b.chars <= BULK_POST_CHARS) last.push(b); else posts.push([b]);
  }
  return posts;
}

/** Posts of the object-by-object reads (readObjects: one type a post, at
 *  most `perPost` objects, the context path's CONTEXT_PER_POST a post). */
function singlePostsOf(single: readonly Listed[], perPost: number): number {
  const byType = new Map<string, number>();
  for (const it of single) byType.set(it.type, (byType.get(it.type) ?? 0) + 1);
  let n = 0;
  for (const c of byType.values()) n += Math.ceil(c / Math.max(1, Math.min(perPost, CONTEXT_PER_POST)));
  return n;
}

/** What one place costs to read (the estimate of a local copy): the
 *  listing it was made from and the read plan of what is not kept. */
export interface PlaceEstimate {
  /** Objects with code listed, and their code's characters. */
  objects: number;
  chars: number;
  /** The place fits READ_ALL_CHARS: it is read in one go. */
  readAll: boolean;
  /** Objects to read (not kept from an earlier read) and their characters. */
  toRead: number;
  toReadChars: number;
  /** The listing: posts, commands and the server's time (ms); `reused`: it
   *  was kept from a listing made before (its cost is what that one took). */
  list: { posts: number; commands: number; ms: number; reused: boolean };
  /** The reads: posts and commands (a bulk part is one command, an object
   *  read alone is one), and the objects the bulk parts read. */
  read: { posts: number; commands: number; bulkObjects: number; singles: number };
  /** Sources the listing could not list (not in the estimate). */
  failedSources: string[];
  /** Too much to read in one go: the place is read source by source; each
   *  source is listed again (its own listing), then read. */
  perSource?: { sources: number; listCommands: number };
}

/** A complete read of one place, as a local copy stores it. */
export interface PlaceRead {
  /** The place fits READ_ALL_CHARS (else nothing was read: `objects` is
   *  empty and the caller reads it source by source). */
  readAll: boolean;
  /** Every listed object was read and every source listed. */
  complete: boolean;
  /** The objects (env ''), instances folded into their template. */
  objects: IndexedObject[];
  listed: number;
  chars: number;
  failedSources: string[];
  /** Listed objects whose code could not be read. */
  unread: string[];
  /** Objects read from the server by this read (the rest was kept). */
  read: number;
}

/** A server source with the reads a local copy uses: the same listing and
 *  read as a search, kept or shared with one. */
export interface ServerCodeSource extends CodeSearchSource {
  /** List the place (or use a kept listing) and plan its read; nothing is
   *  read. The listing is kept for the read that follows. */
  estimate(signal: AbortSignal): Promise<PlaceEstimate>;
  /** List and read the whole place, as a search does, and hand the result
   *  over as stored objects. `onProgress`: the search's progress. */
  readAll(signal: AbortSignal, onProgress?: (p: CodeSearchProgress) => void): Promise<PlaceRead>;
  /** Start from stored objects: their code is kept as if read, so the next
   *  read reads only the objects whose listed stamp or length differs. */
  adopt(objects: readonly IndexedObject[]): void;
}

/** Bulk read answers per post (characters of code, about). */
const BULK_POST_CHARS = 1_200_000;

/** A pattern the server cannot narrow (a regular expression without a
 *  fixed part) in a scope too large to read whole: refused in the live scan. */
export const NEEDS_INDEX_TEXT = 'This server holds too much code to search it this way without a local copy. Search under one object, or keep a copy of the code on this computer.';
export class NeedsIndexError extends Error {
  constructor() { super(NEEDS_INDEX_TEXT); this.name = 'NeedsIndexError'; }
}

/** Smallest power of two ≥ n (1…64): a type's part count is one of seven
 *  values, so its bulk read scripts stay a small constant set. */
function partsFor(chars: number): number {
  let p = 1;
  while (p < 64 && chars / p > BULK_TARGET_CHARS) p *= 2;
  return p;
}

let anonymousCache = 0;

interface Listed extends ListedObject { src: number }

/** What a search of one place knows before it narrows or matches: the
 *  listing, the code it holds (cached or just read) and whether that is
 *  all of it. Shared by searches of the same place that run at once. */
interface ReadPlan {
  listed: Listed[];
  have: Map<string, ReadObject>;
  /** Every listed object's code was read (or tried): match here. */
  readAll: boolean;
  /** Objects whose code this read fetched from the server. */
  readCount: number;
  /** Of those, objects read before at another stamp (changed since). */
  changedCount: number;
  failedSources: string[];
  /** When the listing was made, and whether it was kept from an earlier
   *  search instead of made for this one. */
  checkedAt?: number;
  listingReused: boolean;
  /** The change feed keeps the listing current. */
  feedKept: boolean;
  /** The read plan of what is not kept, and the listing's cost. */
  bulk: BulkPart[];
  single: Listed[];
  listCost: PlaceEstimate['list'];
  /** The keys of the listing's commands (listGroups). */
  listKeys: string[];
  placeOf(it: Listed): Placement;
  srcRid(it: Listed): string | undefined;
  srcFrom(it: Listed): string;
}

/** Someone waiting for a shared read: its preview and its signal. */
interface PlanSubscriber { emit(objects: readonly SearchableObject[] | null, progress: CodeSearchProgress): void; signal: AbortSignal }
interface SharedRead { promise: Promise<ReadPlan>; subscribers: Set<PlanSubscriber>; controller: AbortController; progress: CodeSearchProgress }
/** Reads under way, per server environment and place. */
const sharedReads = new Map<string, SharedRead>();

/**
 * The live search (the default without an index), with no search text on the
 * server (code-scope-read): every source is listed with constant scripts
 * (RID, type, stamp, code length), what is new or changed since the last
 * search is read with constant scripts (the source, or the object, as the
 * command's context), and everything is matched here, so whole word,
 * patterns and "Used in code" (`findCodeRefs`) are exact. The code read is
 * kept for a while (codeReadCache), so a later search reads only what
 * changed; two searches of the same place at once share one read. When more
 * than READ_ALL_CHARS characters would be read, small varying scripts narrow
 * on the server first (buildHitScanEcs) and only the hits are read; a type
 * that cannot be narrowed is reported as not searched, never read whole.
 * Instances whose template is among the searched objects are folded as in
 * the index (the read returns the template link).
 *
 * Sources and listed objects travel as the command's context
 * (`executeEcPairs` / `executeEcEach`); a configuration root without a
 * known RID is named by its accessor. `opts.env` keys the read cache (the
 * server environment); without it the source keeps its reads to itself.
 * `opts.itemsNow`: the server's time of the scope listing (`opts.items`).
 */
export function serverSource(client: IndexClient, opts: { from?: string; map?: CodePropMap; pacer?: Pacer; sources?: readonly ScanSource[]; items?: ReadonlyArray<{ rid: string; type: string; stamp?: string; len?: number }>; itemsNow?: string; itemsAt?: number; itemsReused?: boolean; env?: string; fresh?: boolean; now?: () => number; feed?: ServerFeed; background?: boolean } = {}): ServerCodeSource {
  const now = opts.now ?? (() => Date.now());
  const map = opts.map ?? STATIC_CODE_PROPS;
  const env = opts.env ?? `anonymous:${++anonymousCache}`;
  let total = 0;
  let ruledOut = 0;
  let readCount = 0;
  let changedCount = 0;
  let narrowedScan = false;
  let checkedAt: number | undefined;
  let listingReused = false;
  let feedAt: number | undefined;
  /** Objects that could not be narrowed: not searched. */
  let notSearched = 0;
  const failedTypes: string[] = [];
  let failedSources: string[] = [];
  const ridOf = (s: ScanSource) => s.rid ?? /^lookup\((-?\d{1,20})\)$/.exec(s.from)?.[1];
  const sourceList: readonly ScanSource[] = opts.from ? [{ from: opts.from }] : opts.sources?.length ? opts.sources : [{ from: 'root' }];
  const placeKey = opts.items
    ? `items:${opts.items.length}:${scriptKey(opts.items.map(i => `${i.rid}:${i.stamp ?? ''}:${i.len ?? ''}`).join(',')).key}`
    : `sources:${sourceList.map(s => `${s.from}|${ridOf(s) ?? ''}`).join(',')}`;
  const placeKeyOf = `${placeKey}|${scriptKey(JSON.stringify(map)).key}`;
  // A forced listing ("Search again") does not join a read that may use a kept one.
  const shareKey = `${env}|${placeKeyOf}${opts.fresh ? '|fresh' : ''}`;

  /** List the place and read every object to be read, unless that is more
   *  than READ_ALL_CHARS characters (then only the listing). `listOnly`:
   *  the listing and the read plan, nothing read. */
  async function listAndRead(signal: AbortSignal, pacer: Pacer, emit: (objects: readonly SearchableObject[] | null) => void, progress: CodeSearchProgress, listOnly = false): Promise<ReadPlan> {
    const listCost: PlaceEstimate['list'] = { posts: 0, commands: 0, ms: 0, reused: false };
    const preview1 = (o: ReadObject, type: string, place: Placement): SearchableObject => ({ rid: o.rid, type, name: o.name, businessId: o.businessId, where: [o.grandparent, o.parent].filter(Boolean).join(' › '), code: o.code, refs: [], ...place });
    const listed: Listed[] = [];
    const seen = new Set<string>();
    const failed: string[] = [];
    let serverNow: string | undefined = opts.itemsNow;
    let placeOf: ReadPlan['placeOf'] = () => ({});
    let srcRid: ReadPlan['srcRid'] = () => undefined;
    let srcFrom: ReadPlan['srcFrom'] = () => 'root';
    let listedAt: number | undefined = opts.itemsAt;
    let reused = !!opts.items && !!opts.itemsReused;
    /** The change feed keeps this listing current (code-feed). */
    let feedKept = false;
    let ticket: FeedTicket | null = null;
    /** The listing the feed may keep current (asked again when it matters). */
    let trackedListing: CachedListing<Listed> | undefined;
    let listKeys: string[] = [];
    if (opts.items) {
      for (const it of opts.items) {
        if (!map[it.type] || seen.has(it.rid)) continue;
        seen.add(it.rid);
        listed.push({ rid: it.rid, type: it.type, stamp: it.stamp ?? '', len: it.len ?? 1, src: 0 });
      }
    } else {
      const all = [...sourceList];
      const viaContext = (s: ScanSource) => !!ridOf(s) && !!client.executeEcPairs;
      const fromOf = (s: ScanSource) => (viaContext(s) ? CONTEXT_OBJECT : s.from);
      const groups = listTypeGroups(map);
      const feed = opts.env ? opts.feed : undefined;
      // "Search again" asks the change feed first: a listing it keeps
      // current is used after that poll, without listing again.
      if (opts.fresh && feed) await feed.refresh(signal).catch(() => undefined);
      // Polls whose application is still queued are applied first: a kept
      // listing is used only with every change the feed received.
      else if (feed) await feed.settled(signal).catch(() => undefined);
      signal.throwIfAborted();
      // A typed search uses the listing of this place while the change feed
      // keeps it current, or for LISTING_REUSE_MS without the feed: listing
      // again costs a post per few sources and finds the same stamps.
      const current = feed ? (l: CachedListing<Listed>) => feed.current(l) : undefined;
      const cached = opts.env ? codeReadCache.listing<Listed>(env, placeKeyOf, now(), current) : undefined;
      const kept = cached && (!opts.fresh || (cached.feed != null && !!current?.(cached))) ? cached : undefined;
      if (kept) {
        listed.push(...kept.rows);
        serverNow ??= kept.serverNow;
        listedAt = kept.at;
        reused = true;
        Object.assign(listCost, kept.cost ?? {}, { reused: true });
        feedKept = kept.feed != null && !!current?.(kept);
        trackedListing = kept;
      } else listedAt = now();
      // The watermark before the first listing post: an edit made while
      // the listing runs is in a later pack (code-feed beginListing).
      ticket = !kept && feed ? await feed.begin(signal).catch(() => null) : null;
      // One command per source and group of types; sent in groups that grow
      // while posts are fast and fall back to one after a slow post
      // (nextListGroup), so each post stays near LIST_POST_TARGET_MS.
      // Anything that throws from here until the listing is handed over
      // gives the ticket back (the feed would log polls for it forever).
      let cmds: Array<{ si: number; key: string; code: string; objectRid?: string }>;
      try {
        listKeys = all.flatMap(src => groups.map((_t, gi) => `${env}|${src.from}|${ridOf(src) ?? ''}|${gi}|${placeKeyOf}`));
        cmds = kept ? [] : all.flatMap((src, si) => groups.map((t, gi) => ({ si, key: `${env}|${src.from}|${ridOf(src) ?? ''}|${gi}|${placeKeyOf}`, code: buildSourceListEc(t, map, fromOf(src)), ...(viaContext(src) ? { objectRid: ridOf(src)! } : {}) })));
      } catch (e) {
        if (ticket) feed?.abandon();
        throw e;
      }
      progress.posts = cmds.length;
      progress.sources = all.length;
      progress.listed = 0;
      const rowsOf = new Map<number, ListedObject[]>();
      const bad = new Set<number>();
      const seenNow = new Set<string>();
      let first: EcResult | undefined;
      const plan = listGroups(cmds);
      try {
        for (let i = 0; i < cmds.length;) {
          const group = plan.take();
          progress.source = group[0].si + 1;
          const t0 = now();
          const w0 = queueWaitOf(signal);
          const pairs = group.map(p => ({ code: p.code, ...(p.objectRid ? { objectRid: p.objectRid } : {}) }));
          const results = await pacer.post('list', 0, () => (client.executeEcPairs && group.some(p => p.objectRid) ? client.executeEcPairs(pairs, signal, 120_000) : client.executeEcBatch(group.map(p => p.code), signal, 120_000)), signal);
          // The server's time: the wait in the lane (other posts, the load
          // governor's hold) is not the server being slow.
          const serverMs = Math.max(0, now() - t0 - (queueWaitOf(signal) - w0));
          plan.done(group, serverMs);
          listCost.posts++;
          listCost.commands += group.length;
          listCost.ms += serverMs;
          first ??= results[0];
          results.forEach((r, k) => {
            const si = group[k].si;
            if (bad.has(si)) return;
            if (!r?.ok || r.log == null) { bad.add(si); return; }
            try {
              const got = parseSourceListLog(r.log);
              rowsOf.set(si, [...(rowsOf.get(si) ?? []), ...got.rows]);
              for (const o of got.rows) seenNow.add(o.rid);
              serverNow ??= got.now;
            } catch { bad.add(si); }
          });
          i += group.length;
          progress.postsDone = i;
          progress.listed = seenNow.size;
          progress.source = group[group.length - 1].si + 1;
          emit(null);
        }
      } catch (e) {
        if (ticket) feed?.abandon();
        throw e;
      }
      all.forEach((src, si) => {
        if (bad.has(si)) { failed.push(src.label ?? src.from); return; }
        for (const o of rowsOf.get(si) ?? []) {
          if (seen.has(o.rid)) continue;
          seen.add(o.rid);
          listed.push({ ...o, src: si });
        }
      });
      if (!listed.length && failed.length >= all.length && cmds.length) { if (ticket) feed?.abandon(); throw ecResultError(first ?? {}, 'The server scan failed'); }
      // Nothing listed while the server's support for the context object
      // could not be checked: not "complete with nothing", say so.
      if (!listed.length && client.contextCheck === 'unchecked' && all.some(s => viaContext(s))) failed.push('could not check this server\'s support for reads on an object');
      if (!kept && opts.env && listedAt != null) {
        // Each source's RID (the feed places new objects by it); `*`: the
        // whole server holds every object.
        const listing: CachedListing<Listed> = { at: listedAt, rows: [...listed], srcRids: all.map(s => (s.from === 'root' ? '*' : ridOf(s))), map, ...(serverNow ? { serverNow } : {}), cost: { posts: listCost.posts, commands: listCost.commands, ms: listCost.ms } };
        const put = () => codeReadCache.putListing<Listed>(env, placeKeyOf, listing, now());
        if (ticket && feed) {
          // The changes polled while this listing was made are applied to it
          // (objects read again); then it is kept and the feed keeps it
          // current, with nothing in between.
          feedKept = await feed.finish(ticket, listing, !failed.length, put);
          trackedListing = listing;
          // The rows as the feed left them (moved, dropped, added).
          listed.length = 0;
          listed.push(...listing.rows);
        } else if (!failed.length) put();
      }
      placeOf = it => { const s = all[it.src]; return { ...(s?.root ? { root: s.root } : {}), ...(s?.path ? { path: s.path } : {}) }; };
      srcRid = it => (viaContext(all[it.src]) ? ridOf(all[it.src]) : undefined);
      srcFrom = it => all[it.src].from;
    }

    // What to read: new or changed since the last search.
    const have = new Map<string, ReadObject>();
    const need: Listed[] = [];
    for (const it of listed) {
      const c = it.stamp ? codeReadCache.get(env, it.rid, it.stamp, it.len) : undefined;
      if (c && c.type === it.type) have.set(it.rid, c.o); else need.push(it);
    }
    // The plan (planReads): bulk scripts per source and type, the rest one
    // by one; the decision to read at all is made on what the plan really
    // reads.
    const { bulk, single } = planReads(listed, need, srcRid, !opts.items && !!client.executeEcPairs);
    // Everything listed fits the memory cap: read what is not kept, once,
    // and keep it (no object-count rule: a count limit made a large server
    // narrow on every search). Above it: narrow on the server.
    const listedChars = listed.reduce((n, it) => n + Math.max(0, it.len) + READ_CACHE_OBJECT_CHARS, 0);
    const readAll = listedChars <= READ_ALL_CHARS;
    const when = { ...(listedAt != null ? { checkedAt: listedAt } : {}), listingReused: reused, feedKept, bulk, single, listCost, listKeys };
    progress.total = listed.length;
    progress.chars = listed.reduce((n, it) => n + Math.max(0, it.len), 0);
    if (!readAll || listOnly) return { listed, have, readAll, readCount: 0, changedCount: 0, failedSources: failed, placeOf, srcRid, srcFrom, ...when };
    const changed = need.filter(it => codeReadCache.knows(env, it.rid)).length;

    progress.phase = 'read';
    progress.reading = 'all';
    progress.candidates = need.length;
    progress.searched = have.size;
    // The kept code is searched first (its matches show at once), then the
    // code as it is read.
    if (need.length && have.size) {
      const kept: SearchableObject[] = [];
      for (const it of listed) { const o = have.get(it.rid); if (o) kept.push(preview1(o, it.type, placeOf(it))); }
      emit(kept);
    } else emit(null);
    const byRid = new Map(listed.map(it => [it.rid, it] as const));
    // Kept for the next search only when its stamp is older than the
    // stamp's resolution (whole seconds) before the server's time of the
    // listing: an edit of the same length in the same second is then seen.
    // While the change feed keeps the listing current a younger stamp is
    // kept too (a later edit is announced); it is forgotten if the feed
    // goes stale (code-feed noteUnsettled).
    const keep = (it: Listed, o: ReadObject) => {
      have.set(it.rid, o);
      if (!it.stamp) return;
      if (settledStamp(it.stamp, serverNow)) codeReadCache.put(env, it.rid, { type: it.type, stamp: it.stamp, len: it.len, o });
      // The feed's state now, not when the read began: it may have gone
      // stale meanwhile (then nothing young is kept).
      else if (opts.feed && trackedListing && opts.feed.current(trackedListing)) { codeReadCache.put(env, it.rid, { type: it.type, stamp: it.stamp, len: it.len, o }); opts.feed.unsettled(it.rid); }
    };
    for (const post of bulkPostsOf(bulk)) {
      const parts = post.map(b => ({ code: buildSourceCodeEc(b.type, map, b.part, b.parts), objectRid: b.src }));
      const results = await pacer.post('read code', post.reduce((n, b) => n + Math.ceil(b.items.length / b.parts), 0), () => client.executeEcPairs!(parts, signal, 120_000), signal);
      const batch: SearchableObject[] = [];
      results.forEach((r, k) => {
        const b = post[k];
        let got: Map<string, ReadObject> | null = null;
        if (r?.ok && r.log != null) { try { got = parseSourceCodeLog(r.log); } catch { got = null; } }
        if (!got) {
          if (r?.errorKind && r.errorKind !== 'server') throw ecResultError(r, 'The code read failed');
          return; // this part's objects are read one by one below
        }
        for (const [rid, o] of got) {
          const it = byRid.get(rid);
          if (!it || it.type !== b.type) continue;
          const shown = have.has(rid);
          keep(it, o);
          // A bulk part reads every object of its type there: the kept ones
          // were searched already.
          if (!shown) batch.push(preview1(o, it.type, placeOf(it)));
        }
      });
      progress.read += post.reduce((n, b) => n + Math.ceil(b.items.length / b.parts), 0);
      progress.searched = Math.min(listed.length, have.size);
      emit(batch);
    }
    // Bulk parts that came back without some object (changed meanwhile,
    // or a failed part): object by object.
    for (const b of bulk) for (const it of b.items) if (!have.has(it.rid) && !single.includes(it)) single.push(it);
    if (single.length) {
      await readObjects(client, single.map(it => ({ rid: it.rid, type: it.type, props: propsOf(it.type, map) })), signal, async got => {
        const batch: SearchableObject[] = [];
        for (const [rid, o] of got) {
          const it = byRid.get(rid);
          if (!it) continue;
          keep(it, o);
          batch.push(preview1(o, it.type, placeOf(it)));
        }
        progress.read = Math.min(progress.candidates, progress.read + got.size);
        progress.searched = Math.min(listed.length, have.size);
        emit(batch);
      }, pacer);
    }
    return { listed, have, readAll, readCount: need.length, changedCount: changed, failedSources: failed, placeOf, srcRid, srcFrom, ...when };
  }

  /** The plan of this place: a read under way for the same place is joined
   *  (its progress and objects are passed on), else a new one starts. The
   *  shared read stops only when every search waiting for it stopped. */
  function planFor(signal: AbortSignal, pacer: Pacer, sub: Omit<PlanSubscriber, 'signal'>): Promise<ReadPlan> {
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    // A background read (a local copy) joins a search's read of the same
    // place under way (nothing is read twice); a search never joins a
    // background one (it would wait at the background pace).
    const key = opts.background && !sharedReads.has(shareKey) ? `${shareKey}|background` : shareKey;
    let job = sharedReads.get(key);
    if (!job) {
      const controller = new AbortController();
      const progress: CodeSearchProgress = { phase: 'scan', postsDone: 0, posts: 0, read: 0, candidates: 0 };
      const created: SharedRead = { subscribers: new Set(), controller, progress, promise: Promise.resolve(null as never) };
      // Low-priority user work: a user post (opening an object, a picker
      // query) goes between two of its posts (request-class). A local copy
      // build (`background`) is background work, as before (load-governor's
      // background budget); only the user starts one (`asked`), so the
      // script gauge does not refuse it.
      const base = opts.background ? backgroundSignal({ signal: controller.signal, asked: true }) : controller.signal;
      created.promise = listAndRead(lowPrioritySignal(base), pacer, objects => { for (const s of created.subscribers) s.emit(objects, { ...progress }); }, progress)
        .finally(() => { if (sharedReads.get(key) === created) sharedReads.delete(key); });
      // Every waiting search sees the failure; none left waiting is fine.
      created.promise.catch(() => undefined);
      sharedReads.set(key, created);
      job = created;
    }
    const me: PlanSubscriber = { ...sub, signal };
    const shared = job;
    shared.subscribers.add(me);
    sub.emit(null, { ...shared.progress });
    const leave = () => {
      shared.subscribers.delete(me);
      if (!shared.subscribers.size) shared.controller.abort();
    };
    signal.addEventListener('abort', leave, { once: true });
    return new Promise<ReadPlan>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')), { once: true });
      shared.promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', leave); shared.subscribers.delete(me); });
    });
  }

  return {
    kind: 'server',
    async scan(req, each, signal, preview) {
      const progress: CodeSearchProgress = { phase: 'scan', postsDone: 0, posts: 0, read: 0, candidates: 0 };
      const show = (objects: readonly SearchableObject[]) => { if (preview && !signal.aborted) preview(objects, { ...progress }); };
      const pacer = opts.pacer ?? new Pacer();
      const prefilter = prefilterOf(req);
      notSearched = 0;
      failedTypes.length = 0;
      const plan = await planFor(signal, pacer, {
        emit: (objects, p) => { Object.assign(progress, p); if (preview && !signal.aborted) preview(objects ?? [], { ...progress }); },
      });
      const { listed, have, placeOf, srcRid, srcFrom } = plan;
      failedSources = [...plan.failedSources];
      total = listed.length;
      readCount = plan.readCount;
      changedCount = plan.changedCount;
      checkedAt = plan.checkedAt;
      listingReused = plan.listingReused;
      // The time of the feed's last successful check, when it keeps this
      // listing current.
      // Not about matches the server picked (narrowed): those are not kept.
      feedAt = plan.feedKept && plan.readAll && opts.feed ? opts.feed.info().at ?? undefined : undefined;
      narrowedScan = !plan.readAll;
      let candidates: Listed[] = listed;
      if (!plan.readAll) {
        // Too much to read: narrow on the server (small varying scripts).
        // A pattern, or a term without fixed text, is not run this way on a
        // server whose code does not fit the local cap.
        if (prefilter.kind === 'all' || req.regex) throw new NeedsIndexError();
        // Narrowing on the server, not listing any more.
        delete progress.listed;
        delete progress.sources;
        const work = lowPrioritySignal(signal);
        const narrowed = await narrow(listed, prefilter, work, pacer, progress, srcRid, srcFrom, !!opts.items);
        const lost = new Set(narrowed.notNarrowed);
        candidates = listed.filter(it => narrowed.hits.has(it.rid) && !lost.has(it.rid));
        notSearched = narrowed.notNarrowed.length;
        failedTypes.push(...narrowed.failed);
        const toRead = candidates.filter(it => !have.has(it.rid));
        // A common term: hundreds of objects one by one at governor pace.
        if (toRead.length > NARROW_READ_MAX) throw new NeedsIndexError();
        readCount = toRead.length;
        changedCount = toRead.filter(it => codeReadCache.knows(env, it.rid)).length;
        progress.phase = 'read';
        progress.reading = 'hits';
        progress.read = 0;
        progress.candidates = toRead.length;
        show([]);
        if (toRead.length) {
          const byRid = new Map(listed.map(it => [it.rid, it] as const));
          await readObjects(client, toRead.map(it => ({ rid: it.rid, type: it.type, props: propsOf(it.type, map) })), work, async got => {
            const batch: SearchableObject[] = [];
            for (const [rid, o] of got) {
              const it = byRid.get(rid);
              if (!it) continue;
              have.set(rid, o);
              batch.push({ rid: o.rid, type: it.type, name: o.name, businessId: o.businessId, where: [o.grandparent, o.parent].filter(Boolean).join(' › '), code: o.code, refs: [], ...placeOf(it) });
            }
            progress.read += got.size;
            show(batch);
          }, pacer);
        }
      } else {
        // Read whole: the objects the server's prefilter would have passed
        // (the same test, here), so the coverage counts as it always did; an
        // object whose code could not be read stays a candidate.
        candidates = listed.filter(it => { const o = have.get(it.rid); return !o || passesPrefilter(o.code, propsOf(it.type, map), prefilter); });
      }
      ruledOut = total - candidates.length - notSearched;

      // The searched objects, instances folded.
      const out: SearchableObject[] = [];
      const inSet = new Set(candidates.map(it => it.rid));
      for (const it of candidates) {
        const o = have.get(it.rid);
        if (!o) continue;
        const t = o.tmpl && inSet.has(o.tmpl) ? have.get(o.tmpl) : undefined;
        out.push(toIndexed('', it.type, foldIntoTemplate(o, t ? { code: t.code } : null), undefined, placeOf(it)));
      }
      each(out);
    },
    coverage(searched) {
      const s = searched + ruledOut;
      const failed = [...failedTypes, ...failedSources];
      const how = { read: readCount, ...(changedCount ? { readChanged: changedCount } : {}), ...(narrowedScan ? { narrowed: true } : {}), ...(checkedAt != null ? { checkedAt } : {}), ...(listingReused ? { listingReused: true } : {}), ...(feedAt != null ? { feedAt } : {}) };
      if (opts.items) {
        // Every listed object has code: the list is the whole scope.
        return { source: 'server', searched: s, total: Math.max(total, opts.items.length), complete: failed.length === 0 && s >= opts.items.length, ...how, ...(failed.length ? { failedTypes: failed } : {}) };
      }
      return { source: 'server', searched: s, total, complete: failed.length === 0 && s >= total, ...how, ...(failed.length ? { failedTypes: failed } : {}) };
    },

    async estimate(signal) {
      const progress: CodeSearchProgress = { phase: 'scan', postsDone: 0, posts: 0, read: 0, candidates: 0 };
      // The caller's class (a background signal stays background).
      const plan = await listAndRead(lowPrioritySignal(signal), opts.pacer ?? new Pacer({ minPauseMs: 0, maxPauseMs: 0 }), () => {}, progress, true);
      const { listed, have } = plan;
      const sum = (xs: readonly Listed[]) => xs.reduce((n, it) => n + Math.max(0, it.len), 0);
      const need = listed.filter(it => !have.has(it.rid));
      const perPost = BUDGET.readObjects;
      const bulkOk = !opts.items && !!client.executeEcPairs;
      const readOf = (bulk: readonly BulkPart[], single: readonly Listed[]) => {
        const groups = new Set(bulk.map(b => `${b.src}|${b.type}`));
        const bulkObjects = listed.filter(it => groups.has(`${plan.srcRid(it) ?? ''}|${it.type}`)).length;
        return { posts: bulkPostsOf(bulk).length + singlePostsOf(single, perPost), commands: bulk.length + single.length, bulkObjects, singles: single.length };
      };
      let read = readOf(plan.bulk, plan.single);
      let perSource: PlaceEstimate['perSource'];
      if (!plan.readAll) {
        // Source by source: each source's own listing and read plan.
        read = { posts: 0, commands: 0, bulkObjects: 0, singles: 0 };
        const bySrc = new Map<number, Listed[]>();
        for (const it of listed) bySrc.set(it.src, [...(bySrc.get(it.src) ?? []), it]);
        for (const part of bySrc.values()) {
          const p = planReads(part, part.filter(it => !have.has(it.rid)), plan.srcRid, bulkOk);
          const r = readOf(p.bulk, p.single);
          read.posts += r.posts; read.commands += r.commands; read.bulkObjects += r.bulkObjects; read.singles += r.singles;
        }
        const groups = listTypeGroups(map).length;
        perSource = { sources: sourceList.length, listCommands: sourceList.length * groups };
      }
      return {
        objects: listed.length, chars: sum(listed), readAll: plan.readAll, toRead: need.length, toReadChars: sum(need),
        // The posts the build's listing takes when it lists again.
        list: { ...plan.listCost, posts: plannedListPosts(plan.listKeys) || plan.listCost.posts }, read, failedSources: [...plan.failedSources], ...(perSource ? { perSource } : {}),
      };
    },

    async readAll(signal, onProgress) {
      const pacer = opts.pacer ?? new Pacer();
      const plan = await planFor(signal, pacer, { emit: (_objects, p) => onProgress?.(p) });
      const chars = plan.listed.reduce((n, it) => n + Math.max(0, it.len), 0);
      const base = { listed: plan.listed.length, chars, failedSources: [...plan.failedSources], read: plan.readCount };
      if (!plan.readAll) return { ...base, readAll: false, complete: false, objects: [], unread: [] };
      const objects: IndexedObject[] = [];
      const unread: string[] = [];
      for (const it of plan.listed) {
        const o = plan.have.get(it.rid);
        if (!o) { unread.push(it.rid); continue; }
        // Gone since the listing, or without code now: not stored.
        if (!Object.keys(o.code).length) continue;
        const t = o.tmpl ? plan.have.get(o.tmpl) : undefined;
        const stored = toIndexed('', it.type, foldIntoTemplate(o, t ? { code: t.code } : null), { rid: it.rid, stamp: it.stamp, len: it.len }, plan.placeOf(it));
        // The listing's stamp: what the next listing is compared with.
        objects.push({ ...stored, stamp: it.stamp || o.stamp });
      }
      return { ...base, readAll: true, complete: !plan.failedSources.length && !unread.length, objects, unread };
    },

    adopt(objects) {
      const byRid = new Map<string, SearchableObject>(objects.map(o => [o.rid, o]));
      for (const o of objects) {
        // The code as the server holds it (an instance with its template's
        // text), as a read would have kept it.
        const eff = effectiveObject(o, byRid);
        const len = Object.values(eff.code).reduce((n, x) => n + x.length, 0);
        codeReadCache.put(env, o.rid, { type: o.type, stamp: o.stamp, len, o: { rid: o.rid, businessId: o.businessId, name: o.name, parent: o.where, grandparent: '', stamp: o.stamp, code: { ...eff.code }, ...(o.tmpl ? { tmpl: o.tmpl } : {}) } }, now());
      }
    },
  };

  /** The RIDs whose code passes the prefilter, from small varying scripts
   *  run with each source (or listed object) as the command's context. A
   *  script that fails or answers damaged leaves ITS type in its source (or
   *  its object) not narrowed: those objects are not searched, and named. */
  async function narrow(listed: readonly Listed[], prefilter: Prefilter, signal: AbortSignal, pacer: Pacer, progress: CodeSearchProgress,
    srcRid: (it: Listed) => string | undefined, srcFrom: (it: Listed) => string, self: boolean): Promise<{ hits: Set<string>; notNarrowed: string[]; failed: string[] }> {
    const hits = new Set<string>();
    const lost = new Set<string>();
    const failed = new Set<string>();
    const commands: Array<{ code: string; objectRid: string; type: string }> = [];
    if (self) {
      // A listed scope: each object as the context of its type's scripts.
      const scripts = new Map<string, string[]>();
      for (const it of listed) {
        if (!scripts.has(it.type)) scripts.set(it.type, buildHitScanEcs([it.type], prefilter, map, true).map(s => s.code));
        for (const code of scripts.get(it.type)!) commands.push({ code, objectRid: it.rid, type: it.type });
      }
    } else {
      // Per source, only the types it holds.
      const typesBySource = new Map<string, Set<string>>();
      for (const it of listed) {
        const rid = srcRid(it);
        if (!rid) throw new Error(`The server cannot narrow ${srcFrom(it)} without its RID`);
        typesBySource.set(rid, (typesBySource.get(rid) ?? new Set()).add(it.type));
      }
      for (const [rid, ts] of typesBySource) for (const s of buildHitScanEcs([...ts].sort(), prefilter, map)) commands.push({ code: s.code, objectRid: rid, type: s.type });
    }
    if (!client.executeEcPairs) throw new Error('The server cannot narrow this search: the client has no context path');
    const per = CONTEXT_PER_POST;
    progress.posts += Math.ceil(commands.length / per);
    const giveUp = (c: { objectRid: string; type: string }) => {
      for (const it of listed) {
        if (it.type !== c.type || (self ? it.rid !== c.objectRid : srcRid(it) !== c.objectRid)) continue;
        lost.add(it.rid);
        failed.add(self ? `${c.type} ${it.rid}` : `${c.type} in ${srcFrom(it)}`);
      }
    };
    for (let i = 0; i < commands.length; i += per) {
      const part = commands.slice(i, i + per);
      const results = await pacer.post('scan', 0, () => client.executeEcPairs!(part.map(c => ({ code: c.code, objectRid: c.objectRid })), signal, 120_000), signal);
      results.forEach((r, k) => {
        if (!r?.ok || r.log == null) {
          if (r?.errorKind && r.errorKind !== 'server') throw ecResultError(r, 'The server scan failed');
          giveUp(part[k]);
          return;
        }
        try { for (const rid of parseHitScanLog(r.log)) hits.add(rid); } catch { giveUp(part[k]); }
      });
      progress.postsDone++;
    }
    return { hits, notNarrowed: [...lost], failed: [...failed].map(f => `${f} (not narrowed on the server)`) };
  }
}

/** Characters a plan reads: each bulk part as listed, each object alone. */
export function plannedReadChars(bulk: ReadonlyArray<{ chars: number }>, single: ReadonlyArray<{ len: number }>): number {
  return bulk.reduce((n, b) => n + b.chars, 0) + single.reduce((n, it) => n + Math.max(0, it.len), 0);
}

// ── AI tool ───────────────────────────────────────────────────────

/** Flat property results for the AI `code_search` tool (capped). */
export async function collectCodeSearch(
  source: CodeSearchSource,
  query: string,
  opts: { types?: string[]; caseSensitive?: boolean; cap?: number; resolveKeys?: CodeSearchOptions['resolveKeys'] } = {},
): Promise<{ results: CodeSearchResult[]; capped: boolean; complete: boolean; error?: string }> {
  const cap = opts.cap ?? 30;
  const out: CodeSearchResult[] = [];
  try {
    const res = await runCodeSearch({ mode: 'text', text: query, caseSensitive: opts.caseSensitive ?? true, types: opts.types, limit: cap }, source, hits => {
      for (const h of hits) for (const p of h.props) out.push({ rid: h.rid, name: h.name, type: h.type, businessId: h.businessId, property: p.prop, matchingLines: p.lines.map(l => ({ lineNum: l.line, text: l.text })) });
    }, { resolveKeys: opts.resolveKeys });
    return {
      results: out.slice(0, cap), capped: res.more || out.length > cap, complete: res.coverage.complete,
      ...(res.coverage.complete ? {} : { error: `Searched ${res.coverage.searched} of ${res.coverage.total} objects` }),
    };
  } catch (e) {
    return { results: [], capped: false, complete: false, error: e instanceof Error ? e.message : String(e) };
  }
}
