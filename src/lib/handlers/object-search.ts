/**
 * Object search on the server (lib/object-search.ts): objects whose name or
 * ID contains the query, across the configuration types, in read-only posts
 * of a few scripts (one script per type, so a type a server does not know
 * fails alone), paced, stopped on an overloaded server.
 * A new search on the same channel cancels the previous one.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { errorMessage } from '../logger';
import { chunkByScriptSize, createEcFrame } from '../ec-parser';
import { environmentToken } from '../environment';
import { codeIndexStore } from '../code-index-store';
import { codeTypes, CODE_ROOTS } from '../code-index-sync';
import { CommandCapabilities } from '../search-command';
import { cachedTypeCatalogue } from '../id-lookup';
import { commandNameSearch, dataRootCommandSafe, type CommandScope, type NameCommandPort } from '../object-name-command';
import { Pacer } from '../index-budget';
import { buildNameCatalogEc, CONFIG_TYPES, nameCatalogs, nameSearchPlan, narrowAnswer, parseNameCatalogLog, parseNameSearchByType, searchCatalog, SERVER_ROWS_PER_TYPE, type FoundObject, type NameCatalogEntry, type TypeSearchAnswer } from '../object-search';

const running = new Map<string, AbortController>();

/** What each server profile's connection answers to SearchCommand. */
export const searchCapabilities = new CommandCapabilities();

type Client = NonNullable<ReturnType<typeof ctxOf>['client']>;
const clientIds = new WeakMap<object, number>();
let nextClientId = 0;
/** One connection of a profile: a new client or a new command session is
 *  another connection (the capability record starts again). */
const sessionOf = (client: Client) => {
  let id = clientIds.get(client);
  if (id == null) { id = ++nextClientId; clientIds.set(client, id); }
  return `${id}|${client.sessionEpoch}`;
};
/** What the command searches per profile and connection: the model roots
 *  and the type catalogue's models (object-name-command CommandScope). Kept
 *  only when complete: an empty or partial answer is asked again by the
 *  next query. */
const scopeCache = new Map<string, Promise<CommandScope>>();

/** Types of data objects in CONFIG_TYPES: not searched by name here (the
 *  catalog path would read every one of them); the portal's search finds
 *  them, and the exact ID lookup. */
const DATA_TYPES: ReadonlySet<string> = new Set(['Organisation']);

/** Roots whose objects are data, not configuration (object-name-command
 *  CommandScope.dataRoots). */
export const DATA_ROOTS: ReadonlySet<string> = new Set(['organisation', 'risk', 'actionPlan', 'processManagement']);

async function readScope(client: Client): Promise<{ scope: CommandScope; complete: boolean }> {
  const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  // Two built-in reads (no script): the roots by ID, the type catalogue.
  const { roots, complete } = await client.rootRidsById(CODE_ROOTS.map(r => r.key), signal);
  const catalogue = await cachedTypeCatalogue(client);
  const typeModels = catalogue.models;
  const config = [...roots].filter(([k]) => !DATA_ROOTS.has(k)).map(([, r]) => r);
  const data = [...roots].filter(([k]) => DATA_ROOTS.has(k)).map(([, r]) => r);
  const scope: CommandScope = {
    roots: config.map(r => r.rid), models: [...new Set(config.map(r => r.model))],
    dataRoots: data.map(r => r.rid), dataModels: [...new Set(data.map(r => r.model))], typeModels,
  };
  return { scope, complete: complete && roots.size > 0 && Object.keys(typeModels).length > 0 };
}

function commandPort(client: Client, profile: string): NameCommandPort {
  const session = sessionOf(client);
  return {
    profile, session,
    scope(signal) {
      const key = `${profile}|${session}`;
      let p = scopeCache.get(key);
      if (!p) {
        const read = readScope(client);
        p = read.then(r => r.scope);
        scopeCache.set(key, p);
        read.then(r => { if (!r.complete) scopeCache.delete(key); }, () => scopeCache.delete(key));
        while (scopeCache.size > 16) scopeCache.delete(scopeCache.keys().next().value!);
      }
      return raceAbort(p, signal);
    },
    // Any failure throws; commandNameSearch counts it and the catalogs answer.
    // A time-out is not tried again: the command is left alone for this
    // connection (slowCommand) and the catalogs answer.
    search: async (commands, signal, scope = 'config') => {
      // Enforced here too: nothing but the exact ID lookup reaches a data root.
      const known = await scopeCache.get(`${profile}|${session}`)?.catch(() => null);
      if (!dataRootCommandSafe(commands, known?.dataRoots ?? [])) throw new Error('A data-root search must be the exact ID lookup');
      try { return await client.runSearchCommands(commands, signal, COMMAND_TIMEOUT_MS); }
      catch (e) {
        // A time-out marks only its own scope: a slow data-root lookup does
        // not take the command from the configuration roots, nor the reverse.
        if (!signal.aborted && /timed out|time-?out/i.test(e instanceof Error ? e.message : String(e))) slowCommand.add(`${profile}|${session}|${scope}`);
        throw e;
      }
    },
    identities: (rids, signal) => client.readTreeIdentities(rids, signal),
  };
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** The last server answer per server and type, for a while: a longer query
 *  is narrowed here (object-search narrowAnswer). Bounded and short-lived:
 *  objects renamed meanwhile are found again by the next search. */
const lastAnswers = new Map<string, TypeSearchAnswer & { at: number }>();
const ANSWER_TTL_MS = 60_000;
const ANSWER_MAX = 400;
function rememberAnswer(key: string, answer: TypeSearchAnswer): void {
  lastAnswers.delete(key);
  lastAnswers.set(key, { ...answer, at: Date.now() });
  while (lastAnswers.size > ANSWER_MAX) lastAnswers.delete(lastAnswers.keys().next().value!);
  const old = Date.now() - ANSWER_TTL_MS;
  for (const [k, v] of lastAnswers) if (v.at < old) lastAnswers.delete(k);
}
const SEARCH_TIMEOUT_MS = 60_000;
/** The search command's own time-out: it has no result limit, so a slow
 *  answer means the server is loading many objects; it is not waited for. */
export const COMMAND_TIMEOUT_MS = 8_000;
/** A catalog post's time-out (constant scripts, names and IDs only). */
const CATALOG_TIMEOUT_MS = 15_000;
/** Connections whose search command timed out: not used again by them. */
const slowCommand = new Set<string>();
export const SLOW_COMMAND_NOTICE = 'This server\'s search is slow; showing configuration objects only.';

const CATALOG_TYPES_PER_POST = 24;
/** Characters of one catalog script (constant, several types). */
const CATALOG_SCRIPT_CHARS = 12_000;
/** Clients whose writes already drop their server's catalogs. */
const watched = new WeakSet<object>();

/** Read the catalogs of `types` into `entry`, a post at a time. A script a
 *  server rejects (a class it does not know) is asked again type by type,
 *  so that class fails alone (`entry.failed`). */
async function readCatalogs(client: NonNullable<ReturnType<typeof ctxOf>['client']>, types: readonly string[], entry: NameCatalogEntry): Promise<void> {
  const frame = createEcFrame();
  const pacer = new Pacer({ minPauseMs: 0, maxPauseMs: 0 });
  const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS * 4);
  const take = (log: string) => { for (const [t, c] of parseNameCatalogLog(log, frame)) entry.types.set(t, c); };
  for (let i = 0; i < types.length; i += CATALOG_TYPES_PER_POST) {
    const slice = types.slice(i, i + CATALOG_TYPES_PER_POST);
    const groups = chunkByScriptSize(slice, g => buildNameCatalogEc(g), CATALOG_SCRIPT_CHARS);
    const results = await pacer.post('object search', 0, () => client.executeEcBatch(groups.map(g => buildNameCatalogEc(g)), signal, CATALOG_TIMEOUT_MS), signal);
    // A post that timed out is not asked again type by type: its types are
    // not searched (the server is slow; more posts would not help).
    if (results.every(r => r.errorKind === 'timeout')) { for (const t of slice) entry.failed.add(t); continue; }
    const retry: string[] = [];
    results.forEach((r, j) => {
      if (r.ok && r.log != null) { try { take(r.log); return; } catch { /* asked again below */ } }
      if (groups[j].length > 1) retry.push(...groups[j]); else entry.failed.add(groups[j][0]);
    });
    if (!retry.length) continue;
    const single = await pacer.post('object search', 0, () => client.executeEcBatch(retry.map(t => buildNameCatalogEc([t])), signal, CATALOG_TIMEOUT_MS), signal);
    single.forEach((r, j) => {
      if (!r.ok || r.log == null) { entry.failed.add(retry[j]); return; }
      try { take(r.log); } catch { entry.failed.add(retry[j]); }
    });
  }
}
/** Scripts (types) per post: each reads names and IDs only, at most 25
 *  rows (about 24 × 25 × 200 bytes ≈ 120 KB at most). */
export const SEARCH_TYPES_PER_POST = 24;

register('OBJECT_SEARCH_CANCEL', (msg, _respond, meta) => {
  const ch = String(msg.channel ?? '');
  running.get(ch)?.abort();
  running.delete(ch);
});

/** The catalog path for `types` (see the comments inside); null when the
 *  search was stopped meanwhile. */
async function catalogSearch(client: Client, env: string, types: readonly string[], query: string, signal: AbortSignal): Promise<{ objects: FoundObject[]; notSearched: string[] } | null> {
    // The user waits: no pauses between posts (user class), but the budget
    // per post and the stop on an overloaded server (index-budget). The
    // next keystroke cancels it (OBJECT_SEARCH_CANCEL).
    const pacer = new Pacer({ minPauseMs: 0, maxPauseMs: 0 });
    const objects: FoundObject[] = [];
    const notSearched: string[] = [];
    // No query on the server for most types: their name catalog (one
    // CONSTANT script per group of types, kept NAME_CATALOG_TTL_MS from its last use) answers
    // here, with the server's test. Only a type with more objects than the
    // catalog keeps is searched with a small varying script.
    const frame = createEcFrame();
    // A write of this connection (a created, renamed, moved or deleted
    // object) drops the catalogs of its server: the next search reads them.
    if (!watched.has(client)) { watched.add(client); client.onWrite(() => nameCatalogs.forget(env)); }
    const entry = nameCatalogs.of(env, Date.now());
    // One catalog read per server at a time, not tied to this search: the
    // next keystroke does not throw away a read under way.
    const missing = types.filter(t => !entry.types.has(t) && !entry.failed.has(t));
    if (missing.length) {
      const key = missing.join(',');
      let load = entry.loading.get(key);
      if (!load) {
        load = readCatalogs(client, missing, entry).finally(() => entry.loading.delete(key));
        entry.loading.set(key, load);
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
        load!.then(() => resolve(), reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
      if (signal.aborted) return null;
    }
    const catalogs = entry.types;
    for (const t of types) if (entry.failed.has(t)) notSearched.push(t);
    // Typing "ris" then "risk": a large type whose server answer for "ris"
    // was complete answers "risk" here, without a new script.
    const asked: string[] = [];
    for (const t of types) {
      const c = catalogs.get(t);
      if (c?.complete) { objects.push(...searchCatalog(c, query)); continue; }
      if (!c) continue; // not searched (notSearched)
      const key = `${env}|${t}`;
      const prev = lastAnswers.get(key);
      const local = narrowAnswer(prev && Date.now() - prev.at < ANSWER_TTL_MS ? prev : undefined, query);
      if (local) objects.push(...local); else asked.push(t);
    }
    // One small varying script per large type (at most 1,200 characters).
    const plan = nameSearchPlan(asked, query, frame);
    notSearched.push(...plan.notSearched);
    for (let i = 0; i < plan.send.length; i += SEARCH_TYPES_PER_POST) {
      const slice = plan.send.slice(i, i + SEARCH_TYPES_PER_POST);
      const results = await pacer.post('object search', 0, () => client.executeEcBatch(slice.map(s => s.code), signal, CATALOG_TIMEOUT_MS), signal);
      if (signal.aborted) return null;
      results.forEach((r, j) => {
        if (!r.ok || r.log == null) { notSearched.push(slice[j].type); return; }
        try {
          for (const [t, rows] of parseNameSearchByType(r.log, frame)) {
            objects.push(...rows);
            rememberAnswer(`${env}|${t}`, { query: query.toLowerCase(), rows, complete: rows.length < SERVER_ROWS_PER_TYPE });
          }
        } catch { notSearched.push(slice[j].type); }
      });
    }
  return { objects, notSearched };
}

register('OBJECT_SEARCH', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const client = ctx.client;
  const query = typeof msg.query === 'string' ? msg.query.trim().slice(0, 200) : '';
  const channel = String(msg.channel ?? '').slice(0, 80);
  if (!client) { respond({ type: 'OBJECT_SEARCH_RESULT', query, ok: false, objects: [], error: 'Not connected to BMP' }); return; }
  if (query.length < 2) { respond({ type: 'OBJECT_SEARCH_RESULT', query, ok: true, objects: [] }); return; }
  running.get(channel)?.abort();
  const controller = new AbortController();
  running.set(channel, controller);
  try {
    // Configuration types only (the catalogs read every object of a type:
    // data types are left to the portal's search).
    let types = CONFIG_TYPES.filter(t => !DATA_TYPES.has(t));
    // The window searched the local code index: the code types are covered.
    const env = environmentToken(ctx);
    const meta = await codeIndexStore().getMeta(env).catch(() => null);
    const indexed = new Set(codeTypes(meta?.codeProps));
    if (msg.skipIndexed === true) types = types.filter(t => !indexed.has(t));
    else types = [...new Set([...types, ...indexed])];
    // The server's own search command first (no script text): one post for
    // the types it covers; the catalogs answer the types it does not cover
    // (object-name-command routeTypes). Not supported, suspended or failed
    // this time: the catalogs answer the whole query.
    const port = commandPort(client, ctx.profileId ?? env);
    const slowKey = `${port.profile}|${port.session}`;
    // Configuration roots by name and ID; the data roots only as an exact
    // business-ID lookup (object-name-command). Each scope stops alone
    // after a time-out.
    const configSlow = slowCommand.has(`${slowKey}|config`);
    const dataSlow = slowCommand.has(`${slowKey}|data`);
    const viaCommand = configSlow && dataSlow ? null : await commandNameSearch(port, searchCapabilities, query, types, controller.signal, { config: !configSlow, dataExact: !dataSlow });
    if (controller.signal.aborted) return;
    const slow = slowCommand.has(`${slowKey}|config`);
    const catalogTypes = viaCommand ? viaCommand.catalogTypes : types;
    const cat = catalogTypes.length ? await catalogSearch(client, env, catalogTypes, query, controller.signal) : { objects: [], notSearched: [] };
    if (!cat || controller.signal.aborted) return;
    // Rows by type in the caller's order, as one path would give them.
    const at = new Map(types.map((t, i) => [t, i]));
    const objects = [...(viaCommand?.objects ?? []), ...cat.objects].map((o, i) => ({ o, i })).sort((x, y) => (at.get(x.o.type) ?? 1e9) - (at.get(y.o.type) ?? 1e9) || x.i - y.i).map(x => x.o);
    const notice = slow ? SLOW_COMMAND_NOTICE : viaCommand?.notice;
    respond({ type: 'OBJECT_SEARCH_RESULT', query, ok: true, objects, types: types.length, notSearched: cat.notSearched, via: viaCommand ? 'command' : 'catalog', ...(notice ? { notice } : {}) });
  } catch (e) {
    if (controller.signal.aborted) return;
    respond({ type: 'OBJECT_SEARCH_RESULT', query, ok: false, objects: [], error: errorMessage(e) });
  } finally {
    if (running.get(channel) === controller) running.delete(channel);
  }
});
