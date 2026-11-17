/**
 * The live code search's reads, with no search text on the server.
 *
 * The server keeps the parse tree of every distinct script text (2,000
 * entries, counted by entry, about 40 bytes of heap per character, kept until
 * a restart). A scan script that carries the search text is a new entry for
 * every new query. So the live search reads code with CONSTANT scripts only
 * and matches here:
 *
 *  1. List: per source (a root, a top-level organisation) and group of code
 *     types, one constant script with the source as the command's context
 *     lists every object that has code: RID, type, stamp
 *     (`lastModifiedDate`) and code length. Code is read with `output(…)`,
 *     never run (ec-code-safety). A typed search uses a listing of the same
 *     place up to LISTING_REUSE_MS old; "Search again" always lists again.
 *  2. Read what is new or changed (by stamp and length) since the last
 *     search: groups of many objects with one constant script per source and
 *     type (the source as the context, answers kept near BUDGET.targetBytes),
 *     single objects with the constant code read on the object
 *     (buildContextReadEc). The code is kept in this worker's memory for a
 *     while (READ_CACHE_IDLE_MS since the last search, at most
 *     READ_CACHE_MAX_CHARS characters per server).
 *  3. Match everything here (code-search runCodeSearch), so results are
 *     exact whatever the query: case, whole word, regular expressions.
 *
 * Above READ_ALL_CHARS of listed code (what fits the cache), the search does not read it
 * all: small VARYING scripts (at most SCRIPT_LIMITS.varying characters, one
 * per type or part of its properties) test the text on the server and return
 * RIDs only (buildHitScanEc); only those objects are read. The listing stays
 * constant.
 */

import { appendRowEc, chunkByScriptSize, CONTEXT_OBJECT, EC_CHUNK, EC_DONE_LITERAL, flushChunkEc, parseFramedLog, type EcFrame, EC_FRAME } from './ec-parser';
import { constantScript, SCRIPT_LIMITS, varyingScript } from './script-kinds';
import { ecStringLiteral, type Prefilter } from './code-search-match';
import { codeTypes, parseReadLog, propsOf, STATIC_CODE_PROPS, type CodePropMap, type ReadObject } from './code-index-sync';

const TYPE_NAME = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const PROP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const RID = /^-?\d{1,20}$/;
const SOURCE = /^(this\.object|root|root\.[a-z][A-Za-z0-9]{0,40})$/;

/** Code kept in memory per server (characters, about two bytes each). */
export const READ_CACHE_MAX_CHARS = 24_000_000;
/** Code kept in memory for every server together: one full server and
 *  small others. About 64 MB of strings in the worker at most (two bytes a
 *  character), plus the maps around them. */
export const READ_CACHE_TOTAL_CHARS = 32_000_000;
/** Characters the cache counts per object beyond its code (ReadCache.put). */
export const READ_CACHE_OBJECT_CHARS = 200;
/** A place whose listed code fits three quarters of the memory cap (with
 *  the cache's count per object; the rest is room for other places of the
 *  server and the objects the change feed adds) is read in full once and
 *  kept: every later search, a
 *  pattern too, is matched here without a post. Above it the server narrows
 *  first with small varying scripts. (Measured: the large partner server's
 *  default scope is 12,456 objects with 4.34 M characters, about 6.8 M as
 *  the cache counts it.) */
export const READ_ALL_CHARS = Math.floor(READ_CACHE_MAX_CHARS * 0.75);
/** A read plan of bulk scripts (each reads every object of its type in a
 *  source) over this many characters reads object by object instead. */
export const BULK_READ_MAX_CHARS = 8_000_000;
/** Above the cap, a search whose server narrowing picks more objects than
 *  this is not read object by object: it needs the local copy. */
export const NARROW_READ_MAX = 300;
/** Kept this long after the last search (while the worker lives). */
export const READ_CACHE_IDLE_MS = 20 * 60_000;
/** A listing (step 1) is used again by a typed search this long after it
 *  was made; "Search again" always lists again. */
export const LISTING_REUSE_MS = 30_000;
/** Listings kept per server (places: the roots, a Where choice …). */
const LISTINGS_PER_ENV = 16;
/** Servers whose code is kept at once (the least recently used goes). */
export const READ_CACHE_MAX_ENVS = 3;
/** A (source, type) with at least this many objects to read, and at least
 *  half of its objects, is read with the source's constant script; fewer
 *  are read object by object. */
export const BULK_MIN_OBJECTS = 2;
/** Code characters per bulk read command (the answer is built as one
 *  string on the server, which costs more than linear time). */
export const BULK_TARGET_CHARS = 400_000;

function checkSource(from: string): void {
  if (!SOURCE.test(from)) throw new Error(`Invalid source ${from}`);
}

function checkType(type: string, map: CodePropMap): void {
  if (!map[type] || !TYPE_NAME.test(type)) throw new Error(`Not a code type: ${type}`);
}

/** `_len` := the code length of `_o` (a known type), from the stored text. */
function lengthLines(type: string, map: CodePropMap, indent: string): string[] {
  const lines = [`${indent}_len := 0`];
  for (const p of propsOf(type, map)) {
    if (!PROP_NAME.test(p)) throw new Error(`Invalid property ${p}`);
    lines.push(
      `${indent}_v_${p} := output(_o.${p})`,
      `${indent}_w_${p} := _v_${p}.whenMissing("")`,
      `${indent}_len := _len + _w_${p}.size()`,
    );
  }
  return lines;
}

/**
 * The list of a source: per type, every object with code as an `L` row
 * (type, RID, stamp, code length). Constant: the source is the command's
 * context (`from` = `this.object`), or a root by its accessor (a finite
 * set); one script per group of types and code map.
 */
export function buildSourceListEc(types: readonly string[], map: CodePropMap = STATIC_CODE_PROPS, from: string = CONTEXT_OBJECT): string {
  checkSource(from);
  // Per type: one row per object (empty without code), joined once. The result text grows once per
  // type, not once per row or per chunk of rows.
  const lines = [`_g := ${from}`, '_r := ""', `${EC_CHUNK} := ""`];
  for (const type of types) {
    checkType(type, map);
    lines.push(
      `_l := SELECT ${type} FROM _g`,
      '_x := _l.calculate(',
      '     _o := self',
      ...lengthLines(type, map, '     '),
      '     _row := ""',
      '     IF _len > 0 THEN',
      ...appendRowEc('_row', ['"L"', `"${type}"`, 'str(_o.rid)', '_o.lastModifiedDate.whenMissing("")', '_len'], '          '),
      '     ENDIF',
      '     _row',
      ')',
      '_r := _r + _x.join("").whenMissing("")',
      '_x := ""',
      '_l := ""',
    );
  }
  // The server's time of the listing (the context's end is "now"), in the
  // stamps' own format: what settledStamp compares a stamp with.
  lines.push(...appendRowEc(EC_CHUNK, ['"T"', '""', '""', 'this.end', '""']));
  lines.push(...flushChunkEc(), `_r + ${EC_DONE_LITERAL}`);
  return constantScript('buildSourceListEc', lines.join('\n'));
}

/** Characters of one listing script (several types; constant). */
export const LIST_SCRIPT_CHARS = 20_000;

/** The code types of `map` in the groups one listing script lists each
 *  (buildSourceListEc): the same groups, so the same constant texts, for the
 *  search's listing and the change feed's check of an object's children. */
export function listTypeGroups(map: CodePropMap = STATIC_CODE_PROPS): string[][] {
  return chunkByScriptSize(codeTypes(map), t => buildSourceListEc(t, map, 'root'), LIST_SCRIPT_CHARS);
}

export interface ListedObject { rid: string; type: string; stamp: string; len: number }

/** Rows of buildSourceListEc. Throws on a cut-off or damaged answer. */
export function parseSourceListLog(log: string, frame: EcFrame = EC_FRAME): { rows: ListedObject[]; now?: string } {
  const rows: ListedObject[] = [];
  let now: string | undefined;
  for (const [kind, type, rid, stamp, len] of parseFramedLog(log, frame, 5)) {
    if (kind === 'T') { now = stamp.trim() || undefined; continue; }
    if (kind !== 'L' || !TYPE_NAME.test(type) || !RID.test(rid.trim())) throw new Error('The object list holds a damaged row');
    const n = Number(len.trim());
    rows.push({ rid: rid.trim(), type, stamp: stamp.trim(), len: Number.isFinite(n) ? n : 0 });
  }
  return { rows, ...(now ? { now } : {}) };
}

/** How long a stamp must be older than the server's time of its listing
 *  before the code read with it is kept. The stamp (`lastModifiedDate` as
 *  text, `Nov 1, 2026 10:00:00`) has whole seconds: an edit of the same
 *  length within the same second as the read would keep stamp and length,
 *  so an entry that young is used for its search but not kept. Five seconds
 *  also cover a little clock difference between the browser (the context's
 *  end) and the server. */
export const STAMP_SETTLE_MS = 5_000;

/** May code read with `stamp` be kept? Only when both texts read as dates
 *  and the stamp is STAMP_SETTLE_MS older than the listing; otherwise not
 *  (a format that does not parse keeps nothing). */
export function settledStamp(stamp: string, serverNow: string | undefined): boolean {
  if (!serverNow) return false;
  const s = Date.parse(stamp), n = Date.parse(serverNow);
  return Number.isFinite(s) && Number.isFinite(n) && s <= n - STAMP_SETTLE_MS;
}

/**
 * The code of every object of `type` in a source that has code: the rows of
 * buildContextReadEc (`I` identity, `C` code per property, read with
 * `output(…)`), so parseReadLog reads them. Constant per type and code map:
 * the source is the command's context. `part`/`parts` split a type's list
 * into parts by position (the n-th object goes to part n mod parts), each a
 * constant script of its own, so one answer stays near BULK_TARGET_CHARS.
 */
export function buildSourceCodeEc(type: string, map: CodePropMap = STATIC_CODE_PROPS, part = 0, parts = 1, from: string = CONTEXT_OBJECT): string {
  checkSource(from);
  checkType(type, map);
  if (!Number.isInteger(parts) || parts < 1 || parts > 64 || !Number.isInteger(part) || part < 0 || part >= parts) throw new Error('Invalid part');
  const props = [...new Set(propsOf(type, map))].sort();
  const lines = [`_g := ${from}`, '_r := ""', `${EC_CHUNK} := ""`, '_k := 0', '_n := 0', `_l := SELECT ${type} FROM _g`, '_l.forEach(_o:'];
  lines.push(...lengthLines(type, map, '     '));
  const take = parts > 1 ? `_len > 0 AND _n = ${part}` : '_len > 0';
  lines.push(
    `     IF ${take} THEN`,
    '          _oid := str(_o.rid)',
    ...appendRowEc(EC_CHUNK, ['"I"', '_oid', '_o.id.whenMissing("")', '_o.name.whenMissing("")', '_o.parent.name.whenMissing("")',
      '_o.parent.parent.name.whenMissing("")', '_o.lastModifiedDate.whenMissing("")', '_o.linkedTo.rid.whenMissing("")'], '          '),
    ...props.flatMap(p => appendRowEc(EC_CHUNK, ['"C"', '_oid', `"${p}"`, `output(_o.${p}.whenMissing(""))`], '          ')),
    '          _k := _k + 1',
    '          IF _k >= 4 THEN',
    ...flushChunkEc().map(l => `               ${l}`),
    '               _k := 0',
    '          ENDIF',
    '     ENDIF',
  );
  if (parts > 1) lines.push('     IF _len > 0 THEN', `          _n := _n + 1`, `          IF _n >= ${parts} THEN _n := 0 ENDIF`, '     ENDIF');
  lines.push(')', '_l := ""', ...flushChunkEc(), `_r + ${EC_DONE_LITERAL}`);
  // One name per type: each type has its own small set (parts) of texts.
  return constantScript(`buildSourceCodeEc:${type}`, lines.join('\n'));
}

/** Objects of a bulk read (parseReadLog rows). */
export function parseSourceCodeLog(log: string, frame: EcFrame = EC_FRAME): Map<string, ReadObject> {
  return parseReadLog(log, frame);
}

/** How many ancestors buildAncestorsEc returns at most (deeper objects
 *  are not placed). */
export const ANCESTOR_DEPTH = 40;

/** The ancestors of the context object, nearest first, as RIDs separated by
 *  commas, then `TOP=` and the class of the last one reached (`CUT` when
 *  ANCESTOR_DEPTH did not reach the top), then `#END` (parseAncestorsLog).
 *  Constant: one text. Used by the change feed to place a new code object
 *  under a listed source. */
export function buildAncestorsEc(): string {
  const lines = ['_p := this.object.parent', '_r := ""', '_t := ""'];
  for (let i = 0; i < ANCESTOR_DEPTH; i++) lines.push('IF _p != MISSING THEN', '     _r := _r + str(_p.rid) + ","', '     _t := str(_p.className.whenMissing(""))', '     _p := _p.parent', 'ENDIF');
  lines.push('IF _p != MISSING THEN', '     _t := "CUT"', 'ENDIF', '_r + "TOP=" + _t + "#END"');
  return constantScript('buildAncestorsEc', lines.join('\n'));
}

/** The answer of buildAncestorsEc: the RIDs, and whether they reach a
 *  model root (a class ending in `Root`); null for a damaged answer. A chain
 *  that is cut (too deep, or an ancestor this user cannot read) is not
 *  complete: nothing can be told from it. */
export function parseAncestorsLog(log: string): { chain: string[]; complete: boolean } | null {
  const line = log.split('\n').map(l => l.replace(/^Result : /, '').trim()).find(l => l.endsWith('#END'));
  if (line == null) return null;
  const body = line.slice(0, -4);
  const at = body.lastIndexOf('TOP=');
  if (at < 0) return null;
  const top = body.slice(at + 4);
  const chain = body.slice(0, at).split(',').map(s => s.trim()).filter(s => RID.test(s));
  return { chain, complete: top !== 'CUT' && /Root$/.test(top) };
}

// ── narrowing on the server above READ_ALL_CHARS (varying scripts) ──────

/** Characters a prefilter literal keeps in a varying script: a text that
 *  contains the needle contains its first part, so a shorter needle only
 *  lets more objects through, which the exact match here then drops. */
const NEEDLE_CHARS = 48;

function shortPrefilter(prefilter: Prefilter): Prefilter {
  if (prefilter.kind === 'indexOf') return { ...prefilter, needles: [...new Set(prefilter.needles.map(n => n.slice(0, NEEDLE_CHARS)))], exact: false };
  if (prefilter.kind === 'wildcard') {
    // `*a*b*c*`: keep the first pieces that fit; still `*…*`.
    const pieces = prefilter.pattern.split('*').filter(Boolean);
    const kept: string[] = [];
    let n = 2;
    for (const p of pieces) { if (n + p.length + 1 > NEEDLE_CHARS && kept.length) break; kept.push(p.slice(0, NEEDLE_CHARS)); n += p.length + 1; }
    return { ...prefilter, pattern: `*${kept.join('*')}*`, exact: false };
  }
  return prefilter;
}

function hitScanLines(type: string, props: readonly string[], prefilter: Prefilter, self = false): string[] {
  const lines: string[] = [];
  if (prefilter.kind === 'indexOf') prefilter.needles.forEach((n, i) => {
    const lit = ecStringLiteral(n);
    if (lit == null) throw new Error('A needle the server cannot be given');
    lines.push(`_q${i} := "${lit}"`);
  });
  else if (prefilter.kind === 'wildcard') lines.push(`_p := "${prefilter.pattern}"`);
  else throw new Error('Nothing to narrow on the server');
  // One value per object (its RID, or nothing), joined once: with a common term the hits run into the
  // thousands, and a text grown hit by hit is copied on every `+` (ec-parser.ts).
  lines.push(self ? '_l := LIST(this.object)' : `_l := SELECT ${type} FROM this.object`, '_rs := _l.calculate(', '_o := self', '_h := 0');
  for (const p of props) {
    if (!PROP_NAME.test(p)) throw new Error(`Invalid property ${p}`);
    lines.push(`_w := output(_o.${p})`, '_w := _w.whenMissing("")');
    if (prefilter.kind === 'wildcard') lines.push('IF _w = _p THEN _h := 1 ENDIF');
    else prefilter.needles.forEach((_, i) => lines.push(`IF _w.indexOf(_q${i}).whenMissing(-1) >= 0 THEN _h := 1 ENDIF`));
  }
  lines.push('(IF _h = 1 THEN str(_o.rid) + "," ELSE "" ENDIF)', ')', '_rs.join("") + "#END"');
  return lines;
}

/**
 * The narrowing scripts of one search: per type (and, when its properties do
 * not fit, per part of them) one VARYING script, at most
 * SCRIPT_LIMITS.varying characters, run with each source as the command's
 * context. Each returns the RIDs of the objects whose code passes the
 * prefilter, comma separated, then `#END`. The same scripts serve every
 * source of the search.
 */
export function buildHitScanEcs(types: readonly string[], prefilter: Prefilter, map: CodePropMap = STATIC_CODE_PROPS, self = false): Array<{ type: string; code: string }> {
  const pf = shortPrefilter(prefilter);
  const out: Array<{ type: string; code: string }> = [];
  for (const type of types) {
    checkType(type, map);
    const props = [...new Set(propsOf(type, map))].sort();
    let group: string[] = [];
    const flush = () => { if (group.length) out.push({ type, code: varyingScript('buildHitScanEc', hitScanLines(type, group, pf, self).join('\n')) }); group = []; };
    for (const p of props) {
      const next = [...group, p];
      if (group.length && hitScanLines(type, next, pf, self).join('\n').length > SCRIPT_LIMITS.varying) flush();
      group.push(p);
    }
    flush();
  }
  return out;
}

/** The server's prefilter, here: does any code property of the object
 *  (`props`, the type's code properties) pass it? `indexOf`: a needle occurs
 *  (case-sensitive); `wildcard`: the text equals the pattern `*a*b*`
 *  (case-insensitive, as BMP compares). Every exact match passes it. */
export function passesPrefilter(code: Readonly<Record<string, string>>, props: readonly string[], prefilter: Prefilter): boolean {
  if (prefilter.kind === 'all') return true;
  const re = prefilter.kind === 'wildcard' ? wildcardRegExp(prefilter.pattern) : null;
  for (const p of props) {
    const t = code[p];
    if (!t) continue;
    if (re ? re.test(t) : prefilter.kind === 'indexOf' && prefilter.needles.some(n => t.includes(n))) return true;
  }
  return false;
}

const wildcards = new Map<string, RegExp>();
function wildcardRegExp(pattern: string): RegExp {
  let re = wildcards.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`, 'i');
    if (wildcards.size > 64) wildcards.clear();
    wildcards.set(pattern, re);
  }
  return re;
}

/** RIDs of a narrowing script's answer. Throws when it was cut off. */
export function parseHitScanLog(log: string): string[] {
  const line = log.split('\n').map(l => l.replace(/^Result : /, '').trim()).find(l => l.endsWith('#END'));
  if (line == null) throw new Error('The narrowing scan came back incomplete');
  return line.slice(0, -4).split(',').map(s => s.trim()).filter(s => RID.test(s));
}

// ── the read cache ───────────────────────────────────────────────────

export interface CachedObject { type: string; stamp: string; len: number; o: ReadObject; chars: number }

/** A place's listing as made at `at` (the time its first post was sent).
 *  `feed`: the change feed's generation that keeps this listing current
 *  (code-feed.ts); while that generation is fresh, the listing is used
 *  however old it is, and the feed edits its rows in place. `srcRids`: the
 *  RID of each source (by the rows' `src` index), so the feed can place a
 *  new object under its parent's source. */
export interface CachedListing<T> {
  at: number;
  rows: T[];
  serverNow?: string;
  feed?: number;
  /** The last poll of the feed applied to this listing (code-feed). */
  feedSeq?: number;
  /** Per source (by `src`): its RID, `*` for the whole server (every
   *  object lies under it), undefined when not known (a root without RID). */
  srcRids?: ReadonlyArray<string | undefined>;
  map?: CodePropMap;
  /** What making the listing cost: posts, commands and the server's time
   *  (ms, without the wait in the lane). Absent for a listing made from a
   *  stored copy. */
  cost?: { posts: number; commands: number; ms: number };
}

/** The change feed no longer keeps `l` current and may have missed a
 *  change: it is not used again, not even under LISTING_REUSE_MS. */
export function untrack(l: CachedListing<unknown>): void {
  delete l.feed;
  l.at = Number.NEGATIVE_INFINITY;
}

/** A listed object with the index of its source (code-search Listed). */
export interface ListedRow extends ListedObject { src: number }

/** Code read lately, per server environment: kept while searches go on. */
type CacheEnv = { used: number; chars: number; objects: Map<string, CachedObject>; listings: Map<string, CachedListing<unknown>> };

class ReadCache {
  private readonly envs = new Map<string, CacheEnv>();
  /** Key endings (`#<client>`) of retired clients: nothing is kept for them
   *  again (a search still running for one keeps its reads to itself). */
  private readonly retired = new Set<string>();

  /** Nothing more is kept for keys ending in `suffix`; theirs go now. */
  retire(suffix: string): void {
    this.retired.add(suffix);
    for (const k of [...this.envs.keys()]) if (k.endsWith(suffix)) this.envs.delete(k);
  }

  private isRetired(env: string): boolean {
    const at = env.lastIndexOf('#');
    return at >= 0 && this.retired.has(env.slice(at));
  }

  /** Drop object `k` of `e` for room: a listing the change feed keeps that
   *  holds it is not complete in memory any more (not used again). */
  private evict(e: CacheEnv, k: string): void {
    const v = e.objects.get(k);
    if (!v) return;
    e.objects.delete(k);
    e.chars -= v.chars;
    for (const l of e.listings.values()) if (l.feed != null && (l.rows as ListedRow[]).some(r => r.rid === k)) untrack(l);
  }

  private total(): number {
    let n = 0;
    for (const e of this.envs.values()) n += e.chars;
    return n;
  }

  private of(env: string, now: number): CacheEnv {
    if (this.isRetired(env)) return { used: now, chars: 0, objects: new Map(), listings: new Map() };
    for (const [k, v] of this.envs) if (now - v.used > READ_CACHE_IDLE_MS) this.envs.delete(k);
    let e = this.envs.get(env);
    if (e) this.envs.delete(env);
    else e = { used: now, chars: 0, objects: new Map(), listings: new Map() };
    e.used = now;
    // Map order is use order: the least recently used server goes first.
    this.envs.set(env, e);
    while (this.envs.size > READ_CACHE_MAX_ENVS) this.envs.delete(this.envs.keys().next().value!);
    return e;
  }

  /** The object as read, when its stamp and length are still these. */
  get(env: string, rid: string, stamp: string, len: number, now = Date.now()): CachedObject | undefined {
    const e = this.of(env, now);
    const c = e.objects.get(rid);
    if (!c || c.stamp !== stamp || c.len !== len) return undefined;
    // Map order is use order: the least recently used goes first.
    e.objects.delete(rid);
    e.objects.set(rid, c);
    return c;
  }

  put(env: string, rid: string, value: Omit<CachedObject, 'chars'>, now = Date.now()): void {
    const e = this.of(env, now);
    const old = e.objects.get(rid);
    if (old) { e.chars -= old.chars; e.objects.delete(rid); }
    const chars = Object.values(value.o.code).reduce((n, t) => n + t.length, 0) + 200;
    e.objects.set(rid, { ...value, chars });
    e.chars += chars;
    while (e.chars > READ_CACHE_MAX_CHARS && e.objects.size > 1) this.evict(e, e.objects.keys().next().value!);
    // Every server together: the least recently used other server goes
    // first, then this one's oldest objects.
    while (this.total() > READ_CACHE_TOTAL_CHARS) {
      const other = [...this.envs.keys()].find(k => this.envs.get(k) !== e);
      if (other) { this.envs.delete(other); continue; }
      if (e.objects.size <= 1) break;
      this.evict(e, e.objects.keys().next().value!);
    }
  }

  /** Drop the kept code and listings of `env` (another session). */
  clearEnv(env: string): void {
    this.envs.delete(env);
  }

  /** The listing of `place` when it is younger than LISTING_REUSE_MS, or
   *  when `current` says the change feed keeps it current (code-feed.ts). */
  listing<T>(env: string, place: string, now = Date.now(), current?: (l: CachedListing<T>) => boolean): CachedListing<T> | undefined {
    const l = this.envs.get(env)?.listings.get(place) as CachedListing<T> | undefined;
    if (!l) return undefined;
    if (l.feed != null && current?.(l)) return l;
    // The check may have dropped it (another connection of the profile).
    if (this.envs.get(env)?.listings.get(place) !== l) return undefined;
    if (now - l.at >= LISTING_REUSE_MS || now < l.at) return undefined;
    return l;
  }

  /** The listings of `env` the change feed keeps current (generation `feed`). */
  feedListings(env: string, feed: number): Array<CachedListing<ListedRow>> {
    const e = this.envs.get(env);
    if (!e) return [];
    return [...e.listings.values()].filter(l => l.feed === feed) as Array<CachedListing<ListedRow>>;
  }

  /** The feed no longer keeps the listings of `env` current, and changes
   *  may have been missed: none of them is used again (the next search
   *  lists again). */
  untrackListings(env: string): void {
    for (const l of this.envs.get(env)?.listings.values() ?? []) if (l.feed != null) untrack(l);
  }

  /** Drop the listings of `env` (reconnect, profile switch). */
  dropListings(env: string): void {
    this.envs.get(env)?.listings.clear();
  }

  /** Drop one object (the feed saw it deleted or without code). */
  drop(env: string, rid: string): void {
    const e = this.envs.get(env);
    const c = e?.objects.get(rid);
    if (e && c) { e.objects.delete(rid); e.chars -= c.chars; }
  }

  /** Keep a complete listing of `place` (a listing with a failed source is
   *  not kept). */
  putListing<T>(env: string, place: string, listing: CachedListing<T>, now = Date.now()): void {
    const e = this.of(env, now);
    e.listings.delete(place);
    e.listings.set(place, listing);
    while (e.listings.size > LISTINGS_PER_ENV) e.listings.delete(e.listings.keys().next().value!);
  }

  /** Was this object read before (at any stamp)? Says whether a read is
   *  of a changed object or of one new to the searches. */
  knows(env: string, rid: string): boolean {
    return !!this.envs.get(env)?.objects.has(rid);
  }

  /** Drop one object of `env` (Companion saved it), and the listings of
   *  `env`: they hold its old stamp. A listing the change feed keeps current
   *  stays: its row of the object loses its stamp, so the next search reads
   *  the object again, and the feed's update event refreshes the row.
   *  Returns whether a feed-kept listing holds the object. */
  forget(env: string, rid: string): boolean {
    const e = this.envs.get(env);
    let kept = false;
    for (const [place, l] of [...(e?.listings ?? new Map<string, CachedListing<unknown>>())]) {
      if (l.feed == null) { e!.listings.delete(place); continue; }
      for (const r of l.rows as ListedRow[]) if (r.rid === rid) { r.stamp = ''; kept = true; }
    }
    const c = e?.objects.get(rid);
    if (e && c) { e.objects.delete(rid); e.chars -= c.chars; }
    return kept;
  }

  /** Drop everything, or every server of one profile (`<profile>@…`):
   *  clear local data. */
  clear(profileId?: string): void {
    if (profileId == null) { this.envs.clear(); return; }
    for (const k of [...this.envs.keys()]) if (k.startsWith(`${profileId}@`)) this.envs.delete(k);
  }
}

export const codeReadCache = new ReadCache();
