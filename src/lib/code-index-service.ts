/**
 * The code index of the current server, service-worker side: one sync at a
 * time per environment, its status for the search window, refreshes after
 * the extension's own saves, and deletion with the profile or the cache.
 *
 * State (one machine, derived from the stored meta and the running sync):
 *   none → building n of m → ready at time ⇄ refreshing
 *   building → paused at n of m (stopped, or the worker went away) → Resume
 *   building → failed (with the reason) · unavailable (no bulk read)
 * The stored meta is written after every committed post; `builtAt` is set
 * only when a sync reached its end, so a partial index is never ready.
 *
 * Nothing starts on install, connect, search or opening a window: the copy
 * is opt-in per server profile ("Keep a copy on this computer"), and once
 * built it changes only when the user presses Refresh (code-copy.ts) or
 * saves code through this extension (noteSavedObject). With a complete copy
 * the change feed is not held for its windows.
 * The worker never keeps the index in memory: the window searches it in its
 * own page, and the worker reads it in batches for the AI tool.
 */

import { getCtx, type SwContext } from './sw-context';
import { environmentToken } from './environment';
import { codeIndexStore, type CodeIndexMeta } from './code-index-store';
import { CODE_ROOTS, IndexUnavailableError, KNOWN_CODE_PROPS, ORG_ROOT, orgPath, readRootList, rootLabel, syncCodeIndex, type RootList, type SyncProgress } from './code-index-sync';
import { BUDGET, Pacer, ServerOverloadError } from './index-budget';
import { typeLabel } from './object-window-table';
import { indexSource, serverSource, storeReader, type CodeSearchSource, type ScanSource, type ServerFeed } from './code-search';
import { codeReadCache } from './code-scope-read';
import { bindFeed, clientKey, holdFeed, markFeedDirty, onProfileForgotten, releaseFeed, setFeedListener, type FeedClient } from './code-feed';
import { applySavedCode, estimateCopy, syncCopy, type CopyEstimate, type CopyRoots } from './code-copy';
import { sendFireForget } from './messaging';
import { errorMessage, log } from './logger';
import type { CodeIndexStatus } from './messages';

interface EnvState {
  sync: Promise<void> | null;
  controller: AbortController | null;
  progress?: SyncProgress;
  last?: CodeIndexStatus['last'];
  error?: string;
  /** The last sync was stopped by the user (or a clear): not a failure. */
  stopped?: boolean;
  unavailable?: boolean;
  /** The last sync stopped on an overloaded server. */
  overload?: boolean;
}

const states = new Map<string, EnvState>();

function stateOf(env: string): EnvState {
  let s = states.get(env);
  if (!s) { s = { sync: null, controller: null }; states.set(env, s); }
  return s;
}

/** The key of the code the live search keeps in this worker and of its
 *  change feed: the environment plus the client instance, so a client made
 *  for new credentials (another user, other rights) never gets what the one
 *  before kept. Null when not connected. */
export function searchEnvironment(ctx: SwContext = getCtx()): string | null {
  const env = currentEnvironment(ctx);
  return env && ctx.client ? `${env}#${clientKey(ctx.client)}` : null;
}

/** The environment of a profile-bound context (the window's own server). */
export function currentEnvironment(ctx: SwContext = getCtx()): string | null {
  return ctx.client && ctx.settings?.activeProfileId ? environmentToken(ctx) : null;
}

/** The state of the index of `env`. Pure; exported for tests. */
export function indexState(meta: CodeIndexMeta | null, s: Pick<EnvState, 'sync' | 'error' | 'stopped' | 'unavailable'>): CodeIndexStatus['state'] {
  if (s.unavailable) return 'unavailable';
  if (s.sync) return meta?.builtAt ? 'refreshing' : 'building';
  if (meta?.builtAt) return 'ready';
  if (s.error && !s.stopped) return 'failed';
  return meta ? 'paused' : 'none';
}

/** What the index does not cover, in words for the status line. */
function notCovered(meta: CodeIndexMeta | null): string[] {
  if (!meta) return [];
  const out: string[] = [];
  if (meta.notCovered?.length) out.push(`${meta.notCovered.join(', ')} (object list failed)`);
  if (meta.discovery?.unreadable.length) out.push(`${meta.discovery.unreadable.slice(0, 5).join(', ')}${meta.discovery.unreadable.length > 5 ? ` and ${meta.discovery.unreadable.length - 5} more types` : ''} (type not readable)`);
  if (meta.discovery?.error) out.push(`types not read (${meta.discovery.error}); only the built-in list is searched`);
  if (meta.builtAt && meta.failed) out.push(`${meta.failed} object${meta.failed === 1 ? '' : 's'} that could not be read`);
  for (const [type, n] of Object.entries(meta.incomplete ?? {})) {
    const label = typeLabel(type);
    out.push(`${n} ${n === 1 ? label : `${label}s`} not in the copy`);
  }
  for (const [root, why] of Object.entries(meta.uncounted ?? {})) {
    out.push(`${meta.roots?.[root]?.name ?? rootLabel(root)}: not checked for completeness (the count failed: ${why})`);
  }
  const outside = Object.entries(meta.outside ?? {});
  if (outside.length) {
    const n = outside.reduce((a, [, v]) => a + v, 0);
    out.push(`${n} object${n === 1 ? '' : 's'} outside the known roots (${outside.slice(0, 4).map(([t, v]) => `${t} ${v}`).join(', ')}${outside.length > 4 ? ' …' : ''})`);
  }
  return out;
}

export async function indexStatus(env: string): Promise<CodeIndexStatus> {
  const s = stateOf(env);
  let meta: CodeIndexMeta | null = null;
  try { meta = await codeIndexStore().getMeta(env); } catch (e) { log.swallow('codeIndex:meta', e); }
  const state = indexState(meta, s);
  const props = meta?.codeProps ? Object.values(meta.codeProps).reduce((n, p) => n + p.length, 0) : 0;
  const nc = notCovered(meta);
  return {
    environment: env, state,
    syncedAt: meta?.syncedAt ?? null, builtAt: meta?.builtAt ?? null,
    objects: meta?.objects ?? 0, bytes: meta?.bytes ?? 0, pending: meta?.pending ?? 0,
    // Persisted with the index: a worker restart cannot reuse a number.
    version: meta?.revision ?? 0,
    ...(meta?.codeProps ? { codeTypes: Object.keys(meta.codeProps).length, codeProps: props } : {}),
    ...(nc.length ? { notCovered: nc } : {}),
    ...(s.sync && s.progress ? { progress: { phase: s.progress.phase, read: s.progress.read, toRead: s.progress.toRead } } : {}),
    ...(!s.sync && meta && !meta.builtAt && meta.pending ? { progress: { phase: 'reading' as const, read: Math.max(0, meta.objects - meta.pending), toRead: meta.objects } } : {}),
    ...(s.last ? { last: s.last } : {}),
    ...(s.error && !s.stopped ? { error: s.error } : {}),
    ...(meta?.roots ? { roots: (meta.rootOrder ?? Object.keys(meta.roots)).filter(k => meta!.roots![k]).map(k => ({ key: k, ...meta!.roots![k] })) } : {}),
    ...(meta?.orgs ? { orgs: meta.orgs } : {}),
    ...(meta?.stage ? { stage: meta.stage } : {}),
    ...(s.overload || (meta?.overloadAt && Date.now() - meta.overloadAt < BUDGET.cooldownMs) ? { overload: true } : {}),
    ...(meta?.copy ? { copy: true } : {}),
    ...(s.stopped && !s.sync && meta?.builtAt ? { stopped: true } : {}),
  };
}

async function broadcast(env: string): Promise<void> {
  sendFireForget({ type: 'CODE_INDEX_STATUS', status: await indexStatus(env) });
}

/** The server of an environment (`<profile>@<server URL>`): one index job
 *  at a time per server, whatever the profile. */
const serverOf = (env: string) => env.slice(env.indexOf('@') + 1);
const busyServers = new Set<string>();

/** Start or join a sync of the current server's index. Only the user's
 *  request (`user`: Make copy, Refresh or Resume) starts one; without it
 *  nothing is sent. `force` (Refresh of an index of the older builder)
 *  replaces it with a copy. */
export async function startIndexSync(force = false, user = force, roots?: readonly string[], ctx: SwContext = getCtx()): Promise<string | null> {
  const env = currentEnvironment(ctx);
  const client = ctx.client;
  if (!env || !client) return null;
  const s = stateOf(env);
  if (!user || s.sync || busyServers.has(serverOf(env))) return env;
  let meta: CodeIndexMeta | null = null;
  try { meta = await codeIndexStore().getMeta(env); } catch (e) { log.swallow('codeIndex:meta', e); }
  if (s.sync || busyServers.has(serverOf(env))) return env;
  const controller = new AbortController();
  s.controller = controller;
  s.error = undefined;
  s.stopped = false;
  s.overload = false;
  busyServers.add(serverOf(env));
  let lastSent = 0;
  let lastStage: string | undefined;
  let version = '0';
  try { version = chrome.runtime.getManifest().version; } catch { /* tests */ }
  const onProgress = (p: SyncProgress) => {
    s.progress = p;
    // At most a few status messages a second; a stage change at once
    // (the window may search from there on).
    const t = Date.now();
    const stageChanged = p.stage !== lastStage;
    lastStage = p.stage;
    if (t - lastSent > 250 || p.phase === 'done' || stageChanged) { lastSent = t; void broadcast(env); }
  };
  // The copy is made from the search's own read (code-copy) on a client with
  // the context path; an index of the older builder is refreshed as it was
  // until the user refreshes or rebuilds it.
  const asCopy = !!client.executeEcPairs && (!meta || !!meta.copy || force || !meta.builtAt);
  s.sync = (async () => {
    try {
      const res = asCopy ? await runCopy(ctx, controller.signal, onProgress) : await syncCodeIndex(client, codeIndexStore(), env, {
        signal: controller.signal,
        rediscover: force,
        full: force,
        version,
        // The user's choice: configuration roots first, organisation
        // instances as a second step (the stored root order is kept).
        ...(roots?.length ? { roots } : meta?.rootOrder ? { roots: meta.rootOrder } : {}),
        onProgress,
      });
      s.unavailable = false;
      s.last = {
        changed: res.changed, removed: res.removed, ms: res.ms, posts: res.posts, at: Date.now(), ...(res.first ? { first: true } : {}),
        stages: res.stages, requests: res.requests, ...(res.unchanged ? { unchanged: true } : {}),
      };
      log.info('codeIndex:sync', `${res.changed} read, ${res.removed} removed, ${res.posts} posts, ${res.bytes} bytes, ${res.ms} ms; ${res.stages.map(x => `${x.stage} ${x.posts} posts ${x.ms} ms`).join('; ')}`);
    } catch (e) {
      if (controller.signal.aborted) s.stopped = true;
      else if (e instanceof IndexUnavailableError) s.unavailable = true;
      else if (e instanceof ServerOverloadError) {
        // Stop at once; nothing automatic until the cooldown has passed.
        s.overload = true;
        s.error = `The server answered like an overloaded one (${e.message.split('\n')[0].slice(0, 160)}). Copying stopped and does not start again by itself for ${Math.round(BUDGET.cooldownMs / 60_000)} minutes.`;
        try {
          const m = await codeIndexStore().getMeta(env);
          if (m) await codeIndexStore().putMeta({ ...m, overloadAt: Date.now() });
        } catch (x) { log.swallow('codeIndex:overload', x); }
      } else s.error = errorMessage(e);
      log.swallow('codeIndex:sync', e);
    } finally {
      s.sync = null;
      s.controller = null;
      s.progress = undefined;
      busyServers.delete(serverOf(env));
      if (states.get(env) === s) void broadcast(env);
    }
  })();
  void broadcast(env);
  return env;
}

type ServerRoots = { roots: Array<{ key: string; name: string; rid?: string }>; orgs: Record<string, { name: string; parent: string }> };

const copyRootsOf = (info: ServerRoots): CopyRoots => ({
  order: info.roots.map(r => r.key),
  names: Object.fromEntries(info.roots.map(r => [r.key, r.name])),
  rids: Object.fromEntries(info.roots.filter(r => r.rid).map(r => [r.key, r.rid!])),
  orgs: info.orgs,
});

/** The roots and organisations a complete copy was made with (stored in
 *  its meta); null for anything else. */
function keptRoots(meta: CodeIndexMeta | null): ServerRoots | null {
  if (!meta?.copy || !meta.builtAt || !meta.rootOrder?.length || !meta.orgs) return null;
  return {
    roots: meta.rootOrder.map(k => ({ key: k, name: meta.roots?.[k]?.name ?? rootLabel(k), ...(meta.rootRids?.[k] ? { rid: meta.rootRids[k] } : {}) })),
    orgs: meta.orgs,
  };
}

/** What a copy of `env` reads: the search's cache key, every root (the
 *  organisation root by top-level organisation), the code map and the
 *  change feed. The server's root list is one small request the first time
 *  in a worker's life; a refresh of a complete copy (`refresh`) starts with
 *  the roots stored with the copy and reads the server's only for a listing
 *  (code-copy `current`). */
async function copyInputs(ctx: SwContext, refresh = false) {
  const client = ctx.client!;
  const env = currentEnvironment(ctx)!;
  const meta = await codeIndexStore().getMeta(env).catch(() => null);
  const searchEnv = searchEnvironment(ctx) ?? env;
  const feed = serverFeedFor(searchEnv, client);
  const base = { client, env, searchEnv, map: meta?.codeProps ?? KNOWN_CODE_PROPS, ...(feed ? { feed } : {}) };
  const current = async () => {
    const info = await serverRoots(ctx);
    if (!info) throw new Error('Not connected');
    return { sources: sourcesFrom(info), roots: copyRootsOf(info) };
  };
  const kept = refresh ? keptRoots(meta) : null;
  if (kept) return { ...base, sources: sourcesFrom(kept), roots: copyRootsOf(kept), current };
  return { ...base, ...(await current()) };
}

async function runCopy(ctx: SwContext, signal: AbortSignal, onProgress: (p: SyncProgress) => void) {
  const inputs = await copyInputs(ctx, true);
  return syncCopy(inputs.client, { ...inputs, store: codeIndexStore(), signal, onProgress });
}

/** What a copy of the current server would cost: the search's listing
 *  (kept for the build that follows) and its read plan. */
export async function estimateServerCopy(ctx: SwContext = getCtx(), signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<CopyEstimate | null> {
  if (!currentEnvironment(ctx) || !ctx.client) return null;
  const inputs = await copyInputs(ctx);
  return estimateCopy(inputs.client, { ...inputs, signal });
}

export function cancelIndexSync(ctx: SwContext = getCtx()): void {
  const env = currentEnvironment(ctx);
  if (env) stateOf(env).controller?.abort();
}

/** After a save by the extension that the server confirmed. The live
 *  search's read of the object is old now. A local copy takes the saved
 *  code (`saved`: property -> text) without asking the server; a save
 *  without code text leaves the copy as it is (Refresh reads the object). */
export function noteSavedObject(rid: string, saved?: Readonly<Record<string, string>>, ctx: SwContext = getCtx()): void {
  const env = currentEnvironment(ctx);
  if (!env || !ctx.client) return;
  // A listing the change feed keeps stays; the object is read again at the
  // next poll.
  const searchEnv = searchEnvironment(ctx);
  if (searchEnv && codeReadCache.forget(searchEnv, rid)) markFeedDirty(searchEnv, rid);
  if (!saved || !Object.keys(saved).length) return;
  void (async () => {
    try {
      if (await applySavedCode(codeIndexStore(), env, rid, saved)) void broadcast(env);
    } catch (e) { log.swallow('codeIndex:saved', e); }
  })();
}

/** Delete the index of one profile, or every index. A running sync is
 *  stopped and awaited first, so it cannot write after the delete. */
export async function clearCodeIndex(profileId?: string): Promise<void> {
  const running: Array<Promise<void>> = [];
  for (const [env, s] of states) {
    if (profileId && !env.startsWith(`${profileId}@`)) continue;
    s.controller?.abort();
    if (s.sync) running.push(s.sync.catch(() => undefined));
  }
  await Promise.all(running);
  const cleared = [...states.keys()].filter(env => !profileId || env.startsWith(`${profileId}@`));
  for (const env of cleared) states.delete(env);
  try { await codeIndexStore().clear(profileId ? { profileId } : {}); }
  catch (e) { log.swallow('codeIndex:clear', e); }
  for (const env of cleared) void broadcast(env);
}

/** The server's roots (names) and organisations, read once per
 *  environment with one small request (no code). */
const rootLists = new Map<string, Promise<RootList>>();
export async function serverRoots(ctx: SwContext = getCtx()): Promise<ServerRoots | null> {
  const env = currentEnvironment(ctx);
  const client = ctx.client;
  if (!env || !client) return null;
  let p = rootLists.get(env);
  if (!p) {
    p = readRootList(client, CODE_ROOTS.map(r => r.key), AbortSignal.timeout(60_000), new Pacer({ minPauseMs: 0, maxPauseMs: 0 }));
    rootLists.set(env, p);
    p.catch(() => rootLists.delete(env));
  }
  const list = await p;
  return {
    roots: CODE_ROOTS.filter(r => list.roots.has(r.key)).map(r => ({ key: r.key, name: rootLabel(r.key, list.roots.get(r.key)), ...(list.rootRids?.get(r.key) ? { rid: list.rootRids.get(r.key)! } : {}) })),
    orgs: Object.fromEntries(list.orgs),
  };
}

/** Where the live scan reads for the Where keys (`root:<accessor>`,
 *  `org:<RID>`); every root when none is given. The organisation root is
 *  read top-level organisation by organisation, one post each. */
export async function scanSourcesFor(where: readonly string[] | undefined, ctx: SwContext = getCtx()): Promise<ScanSource[]> {
  const info = await serverRoots(ctx);
  return info ? sourcesFrom(info, where) : [];
}

function sourcesFrom(info: ServerRoots, where?: readonly string[]): ScanSource[] {
  const tops = Object.entries(info.orgs).filter(([, g]) => !g.parent).map(([rid]) => rid);
  const orgSources = (rids: readonly string[]) => rids.map(rid => ({ from: `lookup(${rid})`, rid, root: ORG_ROOT, path: orgPath(rid, info.orgs), label: info.orgs[rid]?.name ?? rid }));
  const keys = where?.length ? where : info.roots.map(r => `root:${r.key}`);
  const out: ScanSource[] = [];
  for (const k of keys) {
    if (k === `root:${ORG_ROOT}`) out.push(...orgSources(tops));
    else if (k.startsWith('root:') && info.roots.some(r => r.key === k.slice(5))) {
      const r = info.roots.find(x => x.key === k.slice(5))!;
      out.push({ from: `root.${r.key}`, ...(r.rid ? { rid: r.rid } : {}), root: r.key, label: r.name });
    }
    else if (k.startsWith('org:') && /^-?\d{1,20}$/.test(k.slice(4))) out.push(...orgSources([k.slice(4)]));
  }
  return out;
}

/** The code properties to scan without an index: the discovered list once
 *  known, else the shipped table of known code properties (KNOWN_CODE_PROPS;
 *  the smaller built-in list missed half the types, seen live). A search the user waits for: no
 *  pauses between posts (the budget per post and the overload stop stay).
 *  `scope`: the listed objects of a search "under an object"
 *  (code-search-scope); `where` is not used then. */
export async function serverScanSource(scope?: { items: ReadonlyArray<{ rid: string; type: string; len?: number; stamp?: string }>; now?: string; at?: number; reused?: boolean }, where?: readonly string[], ctx: SwContext = getCtx(), fresh = false): Promise<CodeSearchSource | null> {
  const env = currentEnvironment(ctx);
  const client = ctx.client;
  if (!env || !client) return null;
  const meta = await codeIndexStore().getMeta(env).catch(() => null);
  const sources = scope ? undefined : await scanSourcesFor(where, ctx);
  // A search the user waits for: no pauses between its posts, the budget
  // per post and the stop on an overloaded server stay (index-budget).
  // `env`: the code read is kept for the next search on this server
  // (code-scope-read codeReadCache), so only what changed is read again.
  // `fresh` ("Search again"): list again even when a listing of the same
  // place is a few seconds old (code-scope-read LISTING_REUSE_MS).
  const searchEnv = searchEnvironment(ctx) ?? env;
  const feed = serverFeedFor(searchEnv, client);
  return serverSource(client, { env: searchEnv, ...(feed ? { feed } : {}), ...(fresh ? { fresh: true } : {}), ...(scope ? { items: scope.items, ...(scope.now ? { itemsNow: scope.now } : {}), ...(scope.at != null ? { itemsAt: scope.at } : {}), ...(scope.reused ? { itemsReused: true } : {}) } : {}), ...(sources?.length ? { sources } : {}), map: meta?.codeProps ?? KNOWN_CODE_PROPS, pacer: new Pacer({ minPauseMs: 0, maxPauseMs: 0, firstReadObjects: BUDGET.readObjects }) });
}

/** The change feed of `env` (code-feed.ts) as the live search uses it, for
 *  this connection of the profile (a reconnect starts it again). */
function serverFeedFor(env: string, client: NonNullable<SwContext['client']>): ServerFeed | undefined {
  const fc = client as unknown as FeedClient;
  if (typeof fc.readTreeEvents !== 'function') return undefined;
  return bindFeed(env, fc, String(client.sessionEpoch));
}

/** A code search window's keep-alive port (keep-alive.ts) holds the change
 *  feed of its server profile: polled while it is open, not after the last
 *  one closed. `contextOf` gives the window's profile-bound context (the
 *  worker resolves it as the window's requests are routed). */
export function holdFeedForPort(port: chrome.runtime.Port, contextOf: () => Promise<SwContext | null>): void {
  holdFeed(port, {
    resolve: async () => {
      const ctx = await contextOf();
      const env = ctx ? searchEnvironment(ctx) : null;
      const client = ctx?.client;
      if (!ctx || !env || !client) return null;
      // A complete local copy answers the window's searches: the feed is
      // not polled for it.
      const local = currentEnvironment(ctx);
      if (local && (await codeIndexStore().getMeta(local).catch(() => null))?.builtAt) return null;
      return { env, client: client as unknown as FeedClient, session: String(client.sessionEpoch) };
    },
  });
  port.onDisconnect.addListener(() => releaseFeed(port));
}

// The windows' footer: how fresh the feed is, after each poll.
// New credentials for a profile: its opt-in local copy (IndexedDB, keyed
// profile@server) was read with the old rights and goes too.
onProfileForgotten(profileId => { void clearCodeIndex(profileId); });

// The windows know their server by its environment (without the client).
setFeedListener((env, info) => sendFireForget({ type: 'CODE_SEARCH_FEED', environment: env.replace(/#\d+$/, ''), health: info.health, at: info.at }));

/** The source the worker searches with (the AI tool): the index once it is
 *  built, the server scan before that. */
export async function workerSearchSource(ctx: SwContext = getCtx()): Promise<CodeSearchSource | null> {
  const env = currentEnvironment(ctx);
  if (!env || !ctx.client) return null;
  const meta = await codeIndexStore().getMeta(env).catch(() => null);
  if (meta?.builtAt) return indexSource(meta, storeReader(codeIndexStore(), env));
  return serverScanSource(undefined, undefined, ctx);
}
