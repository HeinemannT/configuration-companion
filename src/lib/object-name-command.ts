/**
 * The object-name search on BMP's own SearchCommand (search-command.ts):
 * one post per query, over the ID and the name of the types the caller asked
 * for, under the model roots. No Extended Code: no script text.
 *
 * The post holds two commands, one over `id` and one over `name`, so every
 * hit is known to match by ID, by name or both. The hit's tree text is the
 * name for most types and never carries the business ID, so the kept hits'
 * IDs come from one post of TreeItemCommands (a built-in read, no script).
 *
 * Same objects as the catalog path (handlers/object-search.ts):
 *  - The catalog path reads `SELECT <type> FROM root`: every object of the
 *    type, in every model. The command searches the model roots CODE_ROOTS
 *    lists (13 keys, GetPropertiesByIdCommand with the ROOT id space). A
 *    type goes to the command only when every model that holds it (type
 *    catalogue, LoadTypeConfigCommand) is the model of one of those roots;
 *    any other type is searched by the catalog path in the same query
 *    (`catalogTypes`, `routeTypes`).
 *  - Matching is the catalog path's: the name or the ID contains the query,
 *    case-insensitive, literally. The server's hits are filtered with that
 *    test once the IDs are known, and a query holding `*`, `?`, a quote or a
 *    backslash (which the index may read as syntax) goes to the catalog path
 *    whole.
 *  - Rows: per type at most SERVER_ROWS_PER_TYPE, types in the caller's
 *    order. The window ranks them (object-search mergeFound: exact ID or
 *    name first, then prefix, then contains).
 *  - A cut (more than SERVER_ROWS_PER_TYPE of a type, or more than
 *    IDENTITY_READS_MAX hits in all) is said in `notice`.
 *
 * `null` means "the catalog path answers this whole query": the command is
 * not supported or suspended, or it failed this time, for whatever reason
 * (recorded in the capability record, except an abort).
 */

import { matchRank, SERVER_ROWS_PER_TYPE, type FoundObject } from './object-search';
import { classifySearchFailure, type CommandCapabilities, type SearchAnswer, type SearchCommandOptions, type SearchHit } from './search-command';

/** Hits whose identity is read for one query, at most. */
export const IDENTITY_READS_MAX = 200;
/** Hits read per type beyond the rows a type shows (SERVER_ROWS_PER_TYPE):
 *  room for hits whose ID read shows they do not match literally. */
export const IDENTITY_SPARE_PER_TYPE = 5;

/** Characters the search index may read as query syntax. */
const QUERY_SYNTAX = /[*?"\\]/;

/** What the command searches: the model roots and the models they hold,
 *  with each type's models (to route types, see the file comment). */
export interface CommandScope {
  /** The configuration roots: searched by default. */
  roots: string[];
  /** Models of `roots`. */
  models: string[];
  /** The data roots (organisation, risks, action plans, process
   *  management) and their models: a common word there matches tens of
   *  thousands of objects the server loads one by one (seen: 30 s and 60 s
   *  on a large server; a client time-out does not stop the server's work,
   *  and the command has no result limit). Never searched by name: only the
   *  exact business-ID form (an index term lookup, dataRootCommandSafe).
   *  Data objects by name: the portal's quick search. */
  dataRoots?: string[];
  dataModels?: string[];
  /** Type → the models that hold it (the type catalogue). */
  typeModels: Readonly<Record<string, readonly string[]>>;
}

export interface NameCommandPort {
  /** Server profile (the capability record's key) and its connection. */
  profile: string;
  session: string;
  scope(signal: AbortSignal): Promise<CommandScope>;
  /** Several SearchCommands in one post; one answer each, in order.
   *  `scope`: configuration roots, or the exact-ID lookup in data roots
   *  (each has its own "slow" mark). */
  search(commands: SearchCommandOptions[], signal: AbortSignal, scope?: 'config' | 'data'): Promise<SearchAnswer[]>;
  /** ID, type and tree text per RID (TreeItemCommand); null: not readable. */
  identities(rids: readonly string[], signal: AbortSignal): Promise<Map<string, Identity | null>>;
  now?(): number;
}

interface Identity { businessId?: string; type?: string; name?: string }

export interface CommandSearchResult {
  objects: FoundObject[];
  /** Types the catalog path searches in this query (models the command
   *  does not cover). */
  catalogTypes: string[];
  /** A short line for the user: a cut, or IDs that could not be read. */
  notice?: string;
}

/** Which of `types` the command covers, and which the catalog path keeps. */
export function routeTypes(types: readonly string[], scope: Pick<CommandScope, 'models' | 'typeModels'>, partial = false): { command: string[]; catalog: string[] } {
  const covered = new Set(scope.models);
  const command: string[] = [];
  const catalog: string[] = [];
  for (const t of types) {
    const models = scope.typeModels[t];
    // A type also held in a model the command does not search (a data root
    // by default) is searched where the command reaches: the data roots are
    // a step of their own (CommandScope.dataRoots).
    if (models?.length && (partial ? models.some(m => covered.has(m)) : models.every(m => covered.has(m)))) command.push(t); else catalog.push(t);
  }
  return { command, catalog };
}

/** Tree text without a leading business ID ("id name" → "name"). */
export function nameOfTreeText(text: string, businessId: string): string {
  if (businessId && text.startsWith(`${businessId} `)) return text.slice(businessId.length + 1);
  return text === businessId ? '' : text;
}

/** The catalog path's test (object-search searchCatalog): name or ID
 *  contains the query, case-insensitive, literally. */
export function literalMatch(o: { name: string; businessId: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !!q && (o.name.toLowerCase().includes(q) || o.businessId.toLowerCase().includes(q));
}

/**
 * Without the identity read: the ID and name a hit's tree text allows. A
 * tree text "id name" is split only when the first word must be the ID: the
 * hit matched by ID and not by name (so the name part cannot hold the
 * query) and that word holds the query. Anything else stays the name, with
 * no ID; never an ID left at the front of a name the user can tell.
 */
export function guessIdentity(text: string, byId: boolean, byName: boolean, query: string): { businessId: string; name: string } {
  const q = query.trim().toLowerCase();
  const sp = text.indexOf(' ');
  if (byId && !byName && sp > 0 && text.slice(0, sp).toLowerCase().includes(q)) return { businessId: text.slice(0, sp), name: text.slice(sp + 1) };
  if (byId && !byName && sp < 0 && text.toLowerCase().includes(q)) return { businessId: text, name: '' };
  return { businessId: '', name: text };
}

interface Found { hit: SearchHit; byId: boolean; byName: boolean; order: number }

/** A query that can be a business ID (no spaces, no search syntax). */
export const ID_SHAPED = /^[A-Za-z0-9_.:-]{2,120}$/;

/** May these commands go to the server? A command that reaches a data root
 *  must be the exact business-ID lookup (`exact`, field `id` only, an
 *  ID-shaped text); any other shape over a data root is refused. */
export function dataRootCommandSafe(commands: readonly SearchCommandOptions[], dataRoots: readonly string[]): boolean {
  const data = new Set(dataRoots);
  return commands.every(c => !c.roots.some(r => data.has(r))
    || (c.exact === true && c.fields.length === 1 && c.fields[0] === 'id' && ID_SHAPED.test(c.searchFor.trim())));
}

/** Search names and IDs with the command. See the file comment.
 *  `opts.config` (default true): search the configuration roots by name and
 *  ID. `opts.dataExact`: also look the query up as an exact business ID in
 *  the data roots, in a post of its own. */
export async function commandNameSearch(port: NameCommandPort, caps: CommandCapabilities, query: string, types: readonly string[], signal: AbortSignal, opts: { config?: boolean; dataExact?: boolean } = {}): Promise<CommandSearchResult | null> {
  const now = port.now?.() ?? Date.now();
  const q = query.trim();
  if (!q || QUERY_SYNTAX.test(q) || !types.length) return null;
  if (!caps.usable(port.profile, port.session, 'search', now)) return null;
  // The roots and the type catalogue come from built-in reads the server
  // always had; without them the catalog path answers (the command itself
  // is not to blame).
  let scope: CommandScope;
  try { scope = await port.scope(signal); } catch (e) { signal.throwIfAborted(); void e; return null; }
  if (!scope.roots.length) return null;
  const dataRoots = scope.dataRoots ?? [];
  // The data roots: the exact business-ID lookup only, in a post of its own
  // (a failure there does not touch the configuration search).
  const dataTypes = routeTypes(types, { models: scope.dataModels ?? [], typeModels: scope.typeModels }, true).command;
  let dataHits: SearchHit[] = [];
  if (opts.dataExact && dataRoots.length && dataTypes.length && ID_SHAPED.test(q)) {
    const cmd: SearchCommandOptions = { searchFor: q, roots: dataRoots, types: dataTypes, fields: ['id'], exact: true };
    if (!dataRootCommandSafe([cmd], dataRoots)) throw new Error('A data-root search must be the exact ID lookup');
    try {
      const [a] = await port.search([cmd], signal, 'data');
      if (a?.ok) dataHits = a.hits;
    } catch (e) { signal.throwIfAborted(); void e; }
  }
  // Types in a data model too are searched in the configuration roots.
  const route = routeTypes(types, scope, true);
  if (opts.config === false || !route.command.length) {
    if (!dataHits.length) return null;
    return finishHits(port, caps, q, [], dataHits, types, signal, now, [...types]);
  }
  const base = { searchFor: q, roots: scope.roots, types: route.command };
  const commands: SearchCommandOptions[] = [{ ...base, fields: ['id'] }, { ...base, fields: ['name'] }];
  if (!dataRootCommandSafe(commands, dataRoots)) throw new Error('A data-root search must be the exact ID lookup');
  let answers: SearchAnswer[];
  try {
    answers = await port.search(commands, signal, 'config');
  } catch (e) {
    signal.throwIfAborted();
    // Any failure of the post (HTTP error, time-out, damaged answer):
    // counted, and the catalog path answers.
    caps.record(port.profile, port.session, 'search', 'failed', (e instanceof Error ? e.message : String(e)).slice(0, 300), now);
    return null;
  }
  const bad = answers.find((a): a is Extract<SearchAnswer, { ok: false }> => !a.ok);
  if (bad || answers.length !== 2) {
    const message = bad?.message ?? 'The search answered the wrong number of commands';
    caps.record(port.profile, port.session, 'search', bad ? classifySearchFailure(bad.message, bad.stackTrace) : 'failed', message.slice(0, 300), now);
    return null;
  }
  if (answers.some(a => a.ok && !a.complete)) {
    caps.record(port.profile, port.session, 'search', 'failed', 'The search answer was cut off', now);
    return null;
  }
  caps.record(port.profile, port.session, 'search', 'answered', undefined, now);
  return finishHits(port, caps, q, answers, dataHits, [...new Set([...route.command, ...dataTypes])], signal, now, route.catalog);
}

/** The hits of the configuration search (`answers`: by ID, by name) and of
 *  the exact ID lookup in the data roots, as rows. */
async function finishHits(port: NameCommandPort, caps: CommandCapabilities, q: string, answers: readonly SearchAnswer[], dataHits: readonly SearchHit[], types: readonly string[], signal: AbortSignal, now: number, catalogTypes: string[]): Promise<CommandSearchResult> {
  const route = { command: [...types], catalog: catalogTypes };
  // Every hit once, with how it matched.
  const asked = new Set(route.command);
  const found = new Map<string, Found>();
  let order = 0;
  const take = (hit: SearchHit, byId: boolean) => {
    if (hit.type && !asked.has(hit.type)) return;
    const f = found.get(hit.rid) ?? { hit, byId: false, byName: false, order: order++ };
    if (byId) f.byId = true; else f.byName = true;
    if (!f.hit.type && hit.type) f.hit = hit;
    found.set(hit.rid, f);
  };
  answers.forEach((a, k) => { if (a.ok) for (const hit of a.hits) take(hit, k === 0); });
  for (const hit of dataHits) take(hit, true);
  // Best first, before the IDs are known: an ID hit may be exact, so it
  // ranks with the name prefixes (exact name first).
  const rank = (f: Found) => Math.min(f.byName ? matchRank({ rid: f.hit.rid, name: f.hit.text }, q) : 3, f.byId ? 1 : 3);
  const ranked = [...found.values()].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  // Only hits that can be shown are read: at most SERVER_ROWS_PER_TYPE per
  // type (a few more, for hits the literal test drops), the best first.
  let cut = false;
  const kept: Found[] = [];
  const perType = new Map<string, number>();
  for (const f of ranked) {
    if (kept.length >= IDENTITY_READS_MAX) { cut = true; break; }
    const t = f.hit.type;
    if (t) {
      const n = perType.get(t) ?? 0;
      if (n >= SERVER_ROWS_PER_TYPE + IDENTITY_SPARE_PER_TYPE) { cut = true; continue; }
      perType.set(t, n + 1);
    }
    kept.push(f);
  }

  let identity = new Map<string, Identity | null>();
  let idsFailed = false;
  try {
    identity = await port.identities(kept.map(f => f.hit.rid), signal);
    caps.record(port.profile, port.session, 'identity', 'answered', undefined, now);
  } catch (e) {
    signal.throwIfAborted();
    idsFailed = true;
    caps.record(port.profile, port.session, 'identity', 'failed', (e instanceof Error ? e.message : String(e)).slice(0, 300), now);
  }

  const byType = new Map<string, FoundObject[]>();
  for (const f of kept.sort((a, b) => a.order - b.order)) {
    const id = identity.get(f.hit.rid);
    if (id === null) continue; // not readable by this user
    const type = id?.type || f.hit.type;
    if (!type || !asked.has(type)) continue;
    let row: FoundObject;
    if (id) {
      const businessId = id.businessId ?? '';
      row = { rid: f.hit.rid, type, businessId, name: nameOfTreeText(id.name ?? f.hit.text, businessId) };
      if (!literalMatch(row, q)) continue;
    } else {
      row = { rid: f.hit.rid, type, ...guessIdentity(f.hit.text, f.byId, f.byName, q) };
      // Without the ID only the name can be checked; an ID hit is kept.
      if (!f.byId && !literalMatch(row, q)) continue;
    }
    const list = byType.get(type) ?? [];
    if (list.length >= SERVER_ROWS_PER_TYPE) { cut = true; continue; }
    list.push(row);
    byType.set(type, list);
  }
  const objects = route.command.flatMap(t => byType.get(t) ?? []);
  const notes = [
    // No number: the cut is per type, and the list also holds rows from other sources, so a count
    // here would not match the count the list shows.
    ...(cut ? ['More objects match than are listed. Type more to narrow.'] : []),
    ...(idsFailed ? ['IDs could not be read, so the list shows names only.'] : []),
  ];
  return { objects, catalogTypes: route.catalog, ...(notes.length ? { notice: notes.join(' ') } : {}) };
}
