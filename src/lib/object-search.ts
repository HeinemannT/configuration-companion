/**
 * Object search: find a configuration object by name, bare ID or RID.
 * One search behind the shared object picker (lib/object-picker.ts) and
 * the side panel's Browse search.
 *
 * Sources, merged in this order as they answer:
 *  1. an exact RID or an exact business ID in every ID space (BROWSE_RESOLVE,
 *     one post);
 *  2. the local code index (instant; name and ID of every object with code);
 *  3. a read-only server search by name and ID across the configuration
 *     types (OBJECT_SEARCH: one post holding one script per type, each
 *     building its result in chunks);
 *  4. the portal quick search (data objects).
 * A new query cancels the sources of the previous one.
 *
 * This file holds the pure parts (EC builder and parser, local match,
 * merge order) and the window-side orchestration, which takes its message
 * senders as parameters. No chrome.* here.
 */

import { appendRowEc, EC_CHUNK, EC_DONE_LITERAL, EC_FRAME, flushChunkEc, parseFramedLog, type EcFrame } from './ec-parser';
import { formatEcLiteral } from './ec-guards';
import { constantScript, SCRIPT_LIMITS, varyingScript } from './script-kinds';
import { TYPES } from './object-window-table';
import { coverageText, timeOfDay } from './coverage-line';

export interface FoundObject {
  rid: string;
  name: string;
  type: string;
  businessId: string;
  /** Where it lives ("Grandparent › Parent"), when the source knows. */
  where?: string;
  /** How it was found: exact RID or ID, or by name / ID. */
  exact?: boolean;
}

/** Pause after the exact and local answers before the server search. */
export const SERVER_SEARCH_DELAY_MS = 100;

/** Rows kept per type by the server search. */
export const SERVER_ROWS_PER_TYPE = 25;
const CHUNK_ROWS = 20;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;

/** Configuration types the server search reads besides the code types:
 *  the object window's table plus the common input and layout classes. A
 *  class a server does not know fails only its own script. */
export const CONFIG_TYPES: readonly string[] = [...new Set([
  ...Object.keys(TYPES),
  'TextInput', 'NumberInput', 'ReferenceInput', 'BooleanInput', 'ButtonGroup',
  'Tab', 'View', 'Card', 'Category', 'ExtendedExpression', 'Report', 'Organisation',
])].filter(t => TYPE_NAME.test(t));

/** Read-only EC for one type: objects whose name or ID contains `query`
 *  (case-insensitive), at most `cap` rows, in chunks, framed. */
export function buildNameSearchEc(type: string | readonly string[], query: string, _frame: EcFrame = EC_FRAME, cap = SERVER_ROWS_PER_TYPE): string {
  // Several types share one script (fewer distinct texts per query: each is
  // one entry of the server's 2,000-entry parse cache). A `[#, type]` row
  // starts each type's rows.
  const types = typeof type === 'string' ? [type] : [...type];
  for (const t of types) if (!TYPE_NAME.test(t)) throw new Error(`Not a type name: ${t}`);
  const q = formatEcLiteral(query.trim().toLowerCase());
  // The query and the types are the only parts that change; the query is
  // the first line.
  return varyingScript('buildNameSearchEc', [
    `_q := "${q}"`,
    '_r := ""', `${EC_CHUNK} := ""`, '_k := 0',
    ...types.flatMap(t => typeSearchLines(t, cap)),
    ...flushChunkEc(),
    `_r + ${EC_DONE_LITERAL}`,
  ].join('\n'));
}

/** The varying name searches for `types`: one script each, sent only when
 *  it fits SCRIPT_LIMITS.varying. A query whose escaped text does not fit
 *  (quotes and backslashes count twice) leaves that type not searched,
 *  never a refused script. */
export function nameSearchPlan(types: readonly string[], query: string, frame: EcFrame = EC_FRAME): { send: Array<{ type: string; code: string }>; notSearched: string[] } {
  const send: Array<{ type: string; code: string }> = [];
  const notSearched: string[] = [];
  for (const type of types) {
    const code = buildNameSearchEc(type, query, frame);
    if (code.length <= SCRIPT_LIMITS.varying) send.push({ type, code }); else notSearched.push(type);
  }
  return { send, notSearched };
}

/** Objects of one type the name catalog keeps; a type with more is
 *  searched on the server with buildNameSearchEc (a small varying script). */
export const CATALOG_ROWS_PER_TYPE = 4_000;

/**
 * The name catalog of a group of types, for searches matched here: per type
 * a `[#, type]` row, every object as `rid, class, ID, name` (at most
 * CATALOG_ROWS_PER_TYPE, in the server's order) and a `[N, count]` row with
 * how many there are. CONSTANT: no query in the text (one script per group
 * of types).
 */
export function buildNameCatalogEc(types: readonly string[], cap = CATALOG_ROWS_PER_TYPE): string {
  for (const t of types) if (!TYPE_NAME.test(t)) throw new Error(`Not a type name: ${t}`);
  const lines = ['_r := ""', `${EC_CHUNK} := ""`, '_k := 0'];
  for (const type of types) {
    lines.push(
      ...appendRowEc(EC_CHUNK, ['"#"', `"${type}"`]),
      '_n := 0',
      `_list := SELECT ${type} FROM root`,
      '_list.forEach(_o:',
      `     IF _n < ${cap} THEN`,
      ...appendRowEc(EC_CHUNK, ['_o.rid', '_o.className', '_o.id.whenMissing("")', '_o.name.whenMissing("")'], '          '),
      '          _k := _k + 1',
      `          IF _k >= ${CHUNK_ROWS * 2} THEN`,
      ...flushChunkEc().map(l => `               ${l}`),
      '               _k := 0',
      '          ENDIF',
      '     ENDIF',
      '     _n := _n + 1',
      ')',
      ...appendRowEc(EC_CHUNK, ['"N"', '_n']),
      '_list := ""',
    );
  }
  lines.push(...flushChunkEc(), `_r + ${EC_DONE_LITERAL}`);
  return constantScript('buildNameCatalogEc', lines.join('\n'));
}

/** One type's catalog: its objects in the server's order, and whether
 *  they are all of them. */
export interface TypeCatalog { rows: FoundObject[]; complete: boolean }

/** Parse buildNameCatalogEc. Throws on a cut-off answer. */
export function parseNameCatalogLog(log: string, frame: EcFrame = EC_FRAME): Map<string, TypeCatalog> {
  const out = new Map<string, TypeCatalog>();
  let cur: TypeCatalog | null = null;
  for (const row of parseFramedLog(log, frame)) {
    if (row.length === 2 && row[0] === '#') { cur = { rows: [], complete: false }; out.set(row[1], cur); continue; }
    if (row.length === 2 && row[0] === 'N' && cur) { cur.complete = Number(row[1].trim()) <= cur.rows.length; continue; }
    if (row.length !== 4 || !cur) continue;
    const [rid, type, id, name] = row;
    if (!/^-?\d{1,20}$/.test(rid.trim())) continue;
    cur.rows.push({ rid: rid.trim(), type: type.trim(), businessId: id.trim(), name });
  }
  return out;
}

/** Name catalogs are kept this long after their last use. */
export const NAME_CATALOG_TTL_MS = 60_000;
/** Servers whose catalogs are kept at once (the least recently used goes). */
export const NAME_CATALOG_ENVS = 4;

/** The catalogs of one server environment, and the reads under way. */
export interface NameCatalogEntry { at: number; types: Map<string, TypeCatalog>; failed: Set<string>; loading: Map<string, Promise<void>> }

/** Name catalogs per server environment (service worker memory). */
class NameCatalogs {
  private readonly envs = new Map<string, NameCatalogEntry>();
  /** The entry of `env`, used now (its time is reset on every use). */
  of(env: string, now = Date.now()): NameCatalogEntry {
    for (const [k, v] of this.envs) if (now - v.at >= NAME_CATALOG_TTL_MS && !v.loading.size) this.envs.delete(k);
    let e = this.envs.get(env);
    if (e) this.envs.delete(env);
    else e = { at: now, types: new Map(), failed: new Set(), loading: new Map() };
    e.at = now;
    this.envs.set(env, e);
    while (this.envs.size > NAME_CATALOG_ENVS) this.envs.delete(this.envs.keys().next().value!);
    return e;
  }
  /** Drop the catalogs of `env` (an object was written there). */
  forget(env: string): void { this.envs.delete(env); }
  /** Drop every catalog, or those of one profile (`<profile>@…`): clear
   *  local data. */
  clear(profileId?: string): void {
    if (profileId == null) { this.envs.clear(); return; }
    for (const k of [...this.envs.keys()]) if (k.startsWith(`${profileId}@`)) this.envs.delete(k);
  }
}
export const nameCatalogs = new NameCatalogs();

/** What the server's search (buildNameSearchEc) answers for one type, from
 *  its complete catalog: name or ID contains the query (lower case), the
 *  first `cap` in the server's order. */
export function searchCatalog(catalog: TypeCatalog, query: string, cap = SERVER_ROWS_PER_TYPE): FoundObject[] {
  const q = query.trim().toLowerCase();
  const out: FoundObject[] = [];
  for (const o of catalog.rows) {
    if (out.length >= cap) break;
    if (o.name.toLowerCase().includes(q) || o.businessId.toLowerCase().includes(q)) out.push(o);
  }
  return out;
}

function typeSearchLines(type: string, cap: number): string[] {
  return [
    ...appendRowEc(EC_CHUNK, ['"#"', `"${type}"`]),
    '_n := 0',
    `_list := SELECT ${type} FROM root`,
    '_list.forEach(_o:',
    `     IF _n < ${cap} AND (_o.name.whenMissing("").toLowerCase.indexOf(_q) >= 0 OR _o.id.whenMissing("").toLowerCase.indexOf(_q) >= 0) THEN`,
    ...appendRowEc(EC_CHUNK, ['_o.rid', '_o.className', '_o.id.whenMissing("")', '_o.name.whenMissing("")'], '          '),
    '          _n := _n + 1',
    '          _k := _k + 1',
    `          IF _k >= ${CHUNK_ROWS} THEN`,
    ...flushChunkEc().map(l => `               ${l}`),
    '               _k := 0',
    '          ENDIF',
    '     ENDIF',
    ')',
    '_list := ""',
  ];
}

/** The rows per searched type (`[#, type]` rows start each type). */
export function parseNameSearchByType(log: string, frame: EcFrame = EC_FRAME): Map<string, FoundObject[]> {
  const out = new Map<string, FoundObject[]>();
  let cur: FoundObject[] | null = null;
  for (const row of parseFramedLog(log, frame)) {
    if (row.length === 2 && row[0] === '#') { cur = []; out.set(row[1], cur); continue; }
    if (row.length !== 4 || !cur) continue;
    const [rid, type, id, name] = row;
    if (!/^-?\d{1,20}$/.test(rid.trim())) continue;
    cur.push({ rid: rid.trim(), type: type.trim(), businessId: id.trim(), name });
  }
  return out;
}

/** What the server answered for one type and query: the rows, and whether
 *  they are all the objects that match (fewer than the cap). */
export interface TypeSearchAnswer { query: string; rows: FoundObject[]; complete: boolean }

/** The rows of an earlier, complete answer that also answer `query`: a
 *  query that contains the earlier one matches a subset of its objects (the
 *  same test as the server's: lower case, name or ID contains). Null when
 *  the earlier answer cannot answer it. */
export function narrowAnswer(prev: TypeSearchAnswer | undefined, query: string): FoundObject[] | null {
  const q = query.trim().toLowerCase();
  if (!prev || !prev.complete || !q.includes(prev.query)) return null;
  return prev.rows.filter(o => o.name.toLowerCase().includes(q) || o.businessId.toLowerCase().includes(q));
}

export function parseNameSearchLog(log: string, frame: EcFrame): FoundObject[] {
  const out: FoundObject[] = [];
  for (const row of parseFramedLog(log, frame)) {
    if (row.length !== 4) continue; // `[#, type]` rows start a type
    const [rid, type, id, name] = row;
    if (!/^-?\d{1,20}$/.test(rid.trim())) continue;
    out.push({ rid: rid.trim(), type: type.trim(), businessId: id.trim(), name });
  }
  return out;
}

/** How well an object answers a query: 0 exact ID or name, 1 prefix, 2 contains, 3 not at all. */
export function matchRank(o: { name?: string; businessId?: string; rid: string }, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 3;
  const name = (o.name ?? '').toLowerCase(), id = (o.businessId ?? '').toLowerCase();
  if (id === q || name === q || o.rid === q) return 0;
  if (id.startsWith(q) || name.startsWith(q)) return 1;
  if (id.includes(q) || name.includes(q)) return 2;
  return 3;
}

/** Local index match by name and ID, best first, at most `max`. */
export function matchLocal<T extends { rid: string; name: string; businessId: string }>(objects: readonly T[], query: string, max = 30): T[] {
  const hits: Array<{ o: T; r: number }> = [];
  for (const o of objects) {
    const r = matchRank(o, query);
    if (r < 3) hits.push({ o, r });
  }
  return hits.sort((a, b) => a.r - b.r || a.o.name.localeCompare(b.o.name)).slice(0, max).map(h => h.o);
}

/** Merge a source's hits into the list: exact hits first, then by match
 *  rank, each object once (the first source to name it keeps its row). */
export function mergeFound(list: readonly FoundObject[], add: readonly FoundObject[], query: string): FoundObject[] {
  const seen = new Map(list.map(o => [o.rid, o]));
  const out = [...list];
  for (const o of add) {
    const had = seen.get(o.rid);
    if (had) { if (o.exact && !had.exact) had.exact = true; continue; }
    seen.set(o.rid, o);
    out.push(o);
  }
  return out
    .map((o, i) => ({ o, i, k: o.exact ? -1 : matchRank(o, query) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map(x => x.o);
}

export interface ObjectSearchSources {
  /** Exact RID or business ID (one post). */
  exact(query: string, signal: AbortSignal): Promise<FoundObject | null>;
  /** Local code index; null when it is not ready. */
  local(query: string, signal: AbortSignal): Promise<FoundObject[] | null>;
  /** Server search by name and ID. `skipIndexed`: the local index answered
   *  for the code types. */
  server(query: string, skipIndexed: boolean, signal: AbortSignal): Promise<FoundObject[]>;
  /** Portal quick search (data objects). */
  portal?(query: string, signal: AbortSignal): Promise<FoundObject[]>;
  /** What the index held when `local` answered (for the coverage line). */
  indexInfo?(): { objects: number; at: number | null } | null;
  /** The server search's line for the user after `server` answered (a cut:
   *  "More objects match than are listed. Type more to narrow."). */
  serverNotice?(): string | null;
}

/** What one search covered: which sources answered. */
export interface SearchReport {
  index: { objects: number; at: number | null } | null;
  server: 'ok' | 'failed';
  portal: 'ok' | 'failed' | 'off';
  at: number;
  /** The server search's line for the user (shown with the results too). */
  notice?: string;
}

/** The coverage sentences of a finished search, for an empty result:
 *  "Searched 3,025 objects in the copy from 13 Nov, 14:02. Searched the names and
 *  IDs of configuration and data objects on the server at 14:05." */
export function searchReportText(r: SearchReport, now = Date.now()): string {
  const out: string[] = [];
  out.push(r.index ? coverageText({ kind: 'index', objects: r.index.objects, at: r.index.at }, now) : coverageText({ kind: 'not-searched', reason: 'no code copy on this computer' }));
  if (r.server === 'failed') out.push(coverageText({ kind: 'not-searched', reason: 'the server search did not answer' }));
  else out.push(`Searched the names and IDs of ${r.portal === 'ok' ? 'configuration and data objects' : 'configuration objects'} on the server at ${timeOfDay(r.at, now)}.`);
  if (r.portal === 'failed' && r.server === 'ok') out.push(coverageText({ kind: 'not-searched', reason: 'data objects, the portal search did not answer' }));
  return out.join(' ');
}

/** Run every source; `emit` gets the merged list after each answer. The
 *  promise resolves with the final list. A source that fails is skipped
 *  (the others still answer); when all fail, the first error is thrown. */
export async function searchObjects(query: string, sources: ObjectSearchSources, signal: AbortSignal, emit: (found: FoundObject[]) => void, report?: (r: SearchReport) => void): Promise<FoundObject[]> {
  let found: FoundObject[] = [];
  const errors: unknown[] = [];
  let answered = 0;
  const take = (hits: readonly FoundObject[] | null) => {
    if (signal.aborted || !hits) return;
    found = mergeFound(found, hits, query);
    emit(found);
  };
  const guard = async <T>(p: Promise<T>): Promise<T | null> => {
    try { const v = await p; answered++; return v; } catch (e) { if (!signal.aborted) errors.push(e); return null; }
  };
  const exact = guard(sources.exact(query, signal)).then(o => take(o ? [{ ...o, exact: true }] : []));
  const local = await guard(sources.local(query, signal));
  take(local);
  // The server part starts only after the exact and local answers are
  // shown and the user has paused: the picker waits ~200 ms before it
  // searches, this adds the rest of ~300 ms; a keystroke meanwhile aborts.
  await exact;
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, SERVER_SEARCH_DELAY_MS);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  signal.throwIfAborted();
  let serverOk = false, portalOk = false;
  await Promise.all([
    guard(sources.server(query, !!local, signal)).then(v => { serverOk = v !== null; take(v); }),
    sources.portal ? guard(sources.portal(query, signal)).then(v => { portalOk = v !== null; take(v); }) : Promise.resolve(),
  ]);
  signal.throwIfAborted();
  const notice = serverOk ? sources.serverNotice?.() : null;
  report?.({ index: local ? sources.indexInfo?.() ?? null : null, server: serverOk ? 'ok' : 'failed', portal: !sources.portal ? 'off' : portalOk ? 'ok' : 'failed', at: Date.now(), ...(notice ? { notice } : {}) });
  if (!answered && errors.length) throw errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]));
  return found;
}
