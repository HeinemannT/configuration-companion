/**
 * Badge naming ("enrichment" in code and protocol names): reads the name, ID,
 * type and template of the rids a page's badges show, caches them per
 * profile and sends them to the tabs that asked (BADGE_ENRICHMENT).
 */
import type { BmpObject } from './types';
import { getCtx as baseCtx, type SwContext } from './sw-context';
import { errorMessage, log } from './logger';
import { BADGE_CHUNK_SIZE, ENRICHMENT_RETRY_DELAY, MAX_PERMANENTLY_FAILED } from './constants';
import { backgroundSignal } from './request-class';

/** Registered by connection.ts at init to break circular dependency.
 *  Returns 'checking' before registration — safe default (won't skip enrichment). */
let _getConnectionDisplay: ((ctx?: SwContext) => string) | null = null;
export function registerConnectionDisplayFn(fn: (ctx?: SwContext) => string): void {
  _getConnectionDisplay = fn;
}
function getConnectionDisplay(ctx?: SwContext): string {
  return _getConnectionDisplay?.(ctx) ?? 'checking';
}
/** Asks connection.ts for fresh reachability evidence (throttled there). A
 *  skipped enrichment is a sign that the user is working on the page now, so
 *  it is a good moment to re-check rather than wait for the recovery alarm. */
let _requestReachability: ((ctx?: SwContext) => void) | null = null;
export function registerReachabilityRequestFn(fn: (ctx?: SwContext) => void): void {
  _requestReachability = fn;
}

/** How long the first rids of an idle queue wait for more to join them.
 *  A page renders in stages and every frame sends its own ENRICH_BADGES, so
 *  a short window turns several one-rid posts into one. Later chunks need no
 *  window: they are formed when the previous post finishes, from every rid
 *  that arrived meanwhile. */
export const COALESCE_WINDOW_MS = 15;


type EnrichmentData = {
  businessId?: string;
  type?: string;
  name?: string;
  templateBusinessId?: string;
  /** Optional template-cascade pointer used by the side-panel widget
   *  pill column for objects with a multi-level template hierarchy.
   *  Same shape as `EnrichmentEntry.cascade` in lib/types.ts. */
  cascade?: { rid: string; businessId?: string; type?: string; name?: string };
};

/** Who asked for a rid: content tab ids, or NO_TAB for an internal caller
 *  (an edit invalidating a rid, a test). A rid is dropped when every tab
 *  that asked for it has left its page; NO_TAB is never dropped. */
const NO_TAB = -1;

interface Waiter { rids: Set<string>; resolve(): void }



/** A cache entry is a usable badge identity only when the server enrichment
 *  wrote it. A search hit or a DOM discovery carries a name and a type but no
 *  business ID or template, so it must not count as enriched. */
export function hasCompleteIdentity(obj: BmpObject | undefined): obj is BmpObject {
  // Only a server read sets both; a page-reported record never counts
  // (validate-inbound.ts sanitizePageObject, merge.ts).
  return obj?.identityEnriched === true && obj.source !== 'dom' && obj.source !== 'fiber';
}

/**
 * Badge naming for one server profile. Each profile has its own queue,
 * dedupe and failure memory, its own client and cache (through the bound
 * context `getCtx` returns), and answers only the tabs that asked.
 */
function createEnricher(getCtx: () => SwContext) {
  const enrichedRids = new Set<string>();
  const permanentlyFailed = new Map<string, number>(); // RID → failure timestamp
  const FAILED_TTL = 60_000; // re-allow enrichment after 60s
  let enrichmentGeneration = 0;
  /** Aborted when the generation changes: drops waiting badge posts. */
  let generationAbort = new AbortController();
  /** Rids waiting for a post, in arrival order, with the tabs that asked. */
  const pending = new Map<string, Set<number>>();
  /** Rids of the post being sent (or waiting in the transport queue). */
  const inFlight = new Map<string, Set<number>>();
  /** Rids whose post failed once and wait for their one retry. */
  const retrying = new Map<string, Set<number>>();
  /** Rids already retried once: a second batch failure is final. */
  const retried = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let windowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Generation whose drain loop is running (-1: none). A loop of an older
   *  generation may still wait for its last post; it must not block the new one. */
  let drainingGen = -1;
  let currentSupersede: AbortController | null = null;
  let waiters: Waiter[] = [];
  /** Counters of one busy period (from idle to idle), for the activity log. */
  let cycle = { resolved: 0, failed: new Set<string>() };

  /** Check if a RID is still within its failure TTL */
  function isStillFailed(rid: string): boolean {
    const failedAt = permanentlyFailed.get(rid);
    if (!failedAt) return false;
    if (Date.now() - failedAt > FAILED_TTL) {
      permanentlyFailed.delete(rid);
      return false;
    }
    return true;
  }

  /** Evict oldest entries from permanentlyFailed if over cap */
  function capPermanentlyFailed() {
    if (permanentlyFailed.size <= MAX_PERMANENTLY_FAILED) return;
    const excess = permanentlyFailed.size - MAX_PERMANENTLY_FAILED;
    let count = 0;
    for (const rid of permanentlyFailed.keys()) {
      if (count >= excess) break;
      permanentlyFailed.delete(rid);
      count++;
    }
  }

  function hasWork(): boolean {
    return pending.size > 0 || inFlight.size > 0 || retrying.size > 0;
  }

  /** Drop all queued work of this generation; resolve every waiting caller. */
  function dropAllWork(): void {
    pending.clear();
    inFlight.clear();
    retrying.clear();
    retried.clear();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (windowTimer) { clearTimeout(windowTimer); windowTimer = null; }
    currentSupersede?.abort();
    currentSupersede = null;
    const all = waiters;
    waiters = [];
    for (const waiter of all) waiter.resolve();
    cycle = { resolved: 0, failed: new Set() };
  }

  function resetEnrichment() {
    enrichedRids.clear();
    permanentlyFailed.clear();
    dropAllWork();
  }

  /** Drop one rid from the cache + dedup state and fetch a fresh
   *  enrichment for it. Called after SAVE_PROPERTY / APPLY_OBJECT_CHANGES
   *  succeed — otherwise the badge and the object window would
   *  keep showing the pre-save name / type until manual cache clear.
   *
   *  Best-effort: if the BMP client isn't connected, we still wipe the
   *  local cache (so we don't serve stale data) but skip the re-fetch. */
  async function invalidateRid(rid: string): Promise<void> {
    const ctx = getCtx();
    ctx.cache.invalidate(rid);
    enrichedRids.delete(rid);
    permanentlyFailed.delete(rid);
    if (!ctx.client) return;
    // Name the badge again. enrichBadges delivers the names to the tabs
    // that asked for them (BADGE_ENRICHMENT).
    await enrichBadges([rid]);
  }

  /** Publish an identity the caller has just read from BMP (a save's
   *  verification read), instead of reading it again: cache it and update the
   *  badges. */
  function publishIdentity(rid: string, data: EnrichmentData): void {
    const ctx = getCtx();
    ctx.cache.invalidate(rid);
    permanentlyFailed.delete(rid);
    storeResults([rid], { [rid]: data }, true, false);
  }

  function incrementGeneration() {
    enrichmentGeneration++;
    enrichedRids.clear();
    permanentlyFailed.clear();
    const hadWork = hasWork();
    // Waiting posts leave the transport queue. A post already in flight is not
    // interrupted (that would free the command lane while BMP still works on
    // it); its answer is discarded because the generation no longer matches.
    generationAbort.abort();
    generationAbort = new AbortController();
    dropAllWork();
    if (hadWork) {
      try { getCtx().logActivity('info', 'Stopped naming the page badges: the server profile changed'); }
      catch (e) { log.swallow('enrich:cancelLog', e); }
    }
  }

  /** A tab left its page (its content port closed). Rids only that tab asked
   *  for are dropped before they are sent; a waiting badge post whose rids all
   *  belonged to departed tabs leaves the transport queue. */
  function releaseTab(tabId: number): void {
    const settled: string[] = [];
    for (const map of [pending, retrying]) {
      for (const [rid, tabs] of map) {
        if (!tabs.delete(tabId) || tabs.size > 0) continue;
        map.delete(rid);
        settled.push(rid);
      }
    }
    if (inFlight.size > 0) {
      for (const tabs of inFlight.values()) tabs.delete(tabId);
      if ([...inFlight.values()].every(tabs => tabs.size === 0)) currentSupersede?.abort();
    }
    settle(settled);
    if (!hasWork() && retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function settle(rids: Iterable<string>): void {
    const list = [...rids];
    if (list.length === 0) return;
    const open: Waiter[] = [];
    for (const waiter of waiters) {
      for (const rid of list) waiter.rids.delete(rid);
      if (waiter.rids.size === 0) waiter.resolve();
      else open.push(waiter);
    }
    waiters = open;
  }

  function broadcastEmpty(rids: readonly string[], owners?: ReadonlyMap<string, ReadonlySet<number>>): void {
    if (rids.length === 0) return;
    const empty: Record<string, EnrichmentData> = {};
    for (const rid of rids) empty[rid] = {};
    deliver(empty, owners);
  }

  /** Send badge names only to the tabs that asked for them. A rid an internal
   *  caller asked for (NO_TAB), or one without known owners, goes to this
   *  profile's tabs; never to another server's tabs (cloned servers share
   *  RIDs, so a name from one must not land on the other). */
  function deliver(enrichments: Record<string, EnrichmentData>, owners?: ReadonlyMap<string, ReadonlySet<number>>): void {
    const ctx = getCtx();
    if (!owners) { ctx.broadcastToContent({ type: 'BADGE_ENRICHMENT', enrichments }); return; }
    const byTab = new Map<number, Record<string, EnrichmentData>>();
    const everywhere: Record<string, EnrichmentData> = {};
    for (const [rid, data] of Object.entries(enrichments)) {
      const tabs = owners.get(rid);
      if (!tabs || tabs.size === 0 || tabs.has(NO_TAB)) { everywhere[rid] = data; continue; }
      for (const tab of tabs) {
        const forTab = byTab.get(tab) ?? {};
        forTab[rid] = data;
        byTab.set(tab, forTab);
      }
    }
    for (const [tab, forTab] of byTab) {
      const port = ctx.contentPorts?.get(tab);
      if (!port) continue;
      try { port.postMessage({ type: 'BADGE_ENRICHMENT', enrichments: forTab }); }
      catch (e) { log.swallow('enrich:deliver', e); }
    }
    if (Object.keys(everywhere).length) ctx.broadcastToContent({ type: 'BADGE_ENRICHMENT', enrichments: everywhere });
  }

  function requesterOwners(rids: readonly string[], tabId: number | undefined): Map<string, Set<number>> | undefined {
    if (tabId == null) return undefined;
    return new Map(rids.map(rid => [rid, new Set([tabId])]));
  }

  /** Answer cache hits to the tab that asked (all tabs when the caller is not
   *  a tab). Other tabs ask for their own rids. */
  function sendToRequester(tabId: number | undefined, enrichments: Record<string, EnrichmentData>): void {
    const ctx = getCtx();
    const message = { type: 'BADGE_ENRICHMENT' as const, enrichments };
    const port = tabId != null ? ctx.contentPorts?.get(tabId) : undefined;
    if (port) {
      try { port.postMessage(message); return; } catch (e) { log.swallow('enrich:sendToRequester', e); }
    }
    ctx.broadcastToContent(message);
  }

  /**
   * Ask for badge identities. Cache hits are answered at once. The other rids
   * join one queue shared by every message, frame and tab, and are sent as few
   * background posts as the chunk size allows; each post's results are
   * broadcast as soon as it returns. Resolves when every rid of this call has
   * an answer (identity, empty for a failure, or dropped as superseded).
   */
  async function enrichBadges(rids: string[], tabId?: number): Promise<void> {
    const ctx = getCtx();
    if (!ctx.client) {
      // Answer empty enrichments so content labels stop shimmer-loading
      broadcastEmpty(rids, requesterOwners(rids, tabId));
      ctx.logActivity('warn', 'Page badges not named: not connected');
      return;
    }

    // Skip enrichment when server is known-unreachable or still authenticating.
    // We call getConnectionDisplay() (lazy import) to avoid circular dependency
    // since connection.ts imports incrementGeneration from this module.
    const connDisplay = getConnectionDisplay(ctx);
    if (connDisplay === 'unreachable' || connDisplay === 'server-down' || connDisplay === 'not-workspace') {
      broadcastEmpty(rids, requesterOwners(rids, tabId));
      _requestReachability?.(ctx);
      ctx.logActivity('info', 'Page badges not named: the server cannot be reached');
      return;
    }

    const requester = tabId ?? NO_TAB;
    const cacheHits: Record<string, EnrichmentData> = {};
    const alreadyFailed: string[] = [];
    const waitFor = new Set<string>();
    for (const raw of new Set(rids.map(r => r.trim()))) {
      const rid = raw;
      if (!rid) continue;
      const cached = ctx.cache.get(rid);
      if (hasCompleteIdentity(cached)) {
        // A page asks only for what it shows; answer from the cache even when
        // this worker sent the identity before (a reloaded page has lost it).
        cacheHits[rid] = { businessId: cached.businessId, type: cached.type, name: cached.name, templateBusinessId: cached.templateBusinessId, cascade: cached.cascade };
        enrichedRids.add(rid);
        continue;
      }
      enrichedRids.delete(rid);
      const queued = pending.get(rid) ?? inFlight.get(rid) ?? retrying.get(rid);
      if (queued) { queued.add(requester); waitFor.add(rid); continue; }
      if (isStillFailed(rid)) { alreadyFailed.push(rid); continue; }
      pending.set(rid, new Set([requester]));
      waitFor.add(rid);
    }
    log.debug('enrich', `enrichBadges: ${rids.length} incoming, ${waitFor.size} queued, ${Object.keys(cacheHits).length} cached, ${alreadyFailed.length} failed`);

    if (alreadyFailed.length > 0) broadcastEmpty(alreadyFailed, requesterOwners(alreadyFailed, tabId));
    if (Object.keys(cacheHits).length > 0) {
      sendToRequester(tabId, cacheHits);
      if (waitFor.size === 0) {
        // Cache hits are routine — debug only, not the activity feed.
        log.debug('enrich', `Enriched ${Object.keys(cacheHits).length} (cached)`);
        ctx.sendToPanel({ type: 'CACHE_STATS', count: ctx.cache.size });
      }
    }
    if (waitFor.size === 0) return;

    const done = new Promise<void>(resolve => { waiters.push({ rids: waitFor, resolve }); });
    scheduleDrain();
    return done;
  }

  function scheduleDrain(): void {
    if (drainingGen === enrichmentGeneration || windowTimer || pending.size === 0) return;
    windowTimer = setTimeout(() => {
      windowTimer = null;
      void drain();
    }, COALESCE_WINDOW_MS);
  }

  /** Send pending rids one chunk at a time until none is left. One badge post
   *  waits in the transport at a time, so rids that arrive meanwhile join the
   *  next chunk instead of a post of their own. */
  async function drain(): Promise<void> {
    const gen = enrichmentGeneration;
    if (drainingGen === gen) return;
    drainingGen = gen;
    const ctx = getCtx();
    try {
      if (pending.size > 0 && cycle.resolved === 0 && cycle.failed.size === 0) {
        ctx.logActivity('info', `Naming ${pending.size} page badges…`);
      }
      while (pending.size > 0 && gen === enrichmentGeneration && ctx.client) {
        const chunk: string[] = [];
        for (const [rid, tabs] of pending) {
          if (chunk.length >= BADGE_CHUNK_SIZE) break;
          pending.delete(rid);
          inFlight.set(rid, tabs);
          chunk.push(rid);
        }
        await sendChunk(chunk, gen);
      }
    } finally {
      if (drainingGen === gen) drainingGen = -1;
    }
    if (gen !== enrichmentGeneration) return;
    if (pending.size > 0) { scheduleDrain(); return; }
    if (retrying.size > 0 || inFlight.size > 0) return;
    finishCycle();
  }

  async function sendChunk(chunk: string[], gen: number): Promise<void> {
    const ctx = getCtx();
    const supersede = new AbortController();
    currentSupersede = supersede;
    const signal = backgroundSignal({ supersede: AbortSignal.any([generationAbort.signal, supersede.signal]) });
    let outcome: { results: Record<string, EnrichmentData>; error?: string };
    try {
      outcome = await ctx.client!.batchEnrich(chunk, signal);
    } catch (e) {
      outcome = { results: {}, error: errorMessage(e) };
    }
    if (currentSupersede === supersede) currentSupersede = null;
    if (gen !== enrichmentGeneration) return; // dropAllWork already settled the callers

    const owners = new Map(chunk.map(rid => [rid, inFlight.get(rid) ?? new Set<number>()]));
    for (const rid of chunk) inFlight.delete(rid);

    if (supersede.signal.aborted) {
      // Every tab that asked had left its page. A tab may have asked for some
      // of these rids again since (a reloaded page): those are still wanted.
      const wanted = chunk.filter(rid => (owners.get(rid)?.size ?? 0) > 0);
      if (outcome.error) {
        // Dropped from the queue before it was sent: send the wanted rids
        // with the next chunk; the rest needed no answer.
        for (const rid of wanted) pending.set(rid, owners.get(rid)!);
        settle(chunk.filter(rid => !wanted.includes(rid)));
        return;
      }
      // Answered: keep everything (the next visit is warm); broadcast only
      // when someone still waits; report nothing as failed.
      const found = storeResults(chunk, outcome.results, wanted.length > 0, true, owners);
      fail(wanted.filter(rid => !found.has(rid)), owners);
      settle(chunk);
      return;
    }

    if (outcome.error) {
      ctx.logActivity('warn', `Batch failed: ${outcome.error}`);
      const again = chunk.filter(rid => !retried.has(rid) && !hasCompleteIdentity(ctx.cache.get(rid)));
      const final = chunk.filter(rid => !again.includes(rid));
      if (final.length) {
        ctx.logActivity('warn', `Batch retry failed (${outcome.error}): ${final.length} RIDs skipped`);
        fail(final.filter(rid => !hasCompleteIdentity(ctx.cache.get(rid))), owners);
        settle(final);
      }
      if (again.length) scheduleRetry(again.map(rid => [rid, owners.get(rid)!] as const));
      return;
    }

    const found = storeResults(chunk, outcome.results, true, true, owners);
    fail(chunk.filter(rid => !found.has(rid)), owners);
    settle(chunk);
  }

  /** Cache and broadcast the identities BMP returned; the rids it answered. */
  function storeResults(chunk: readonly string[], results: Record<string, EnrichmentData>, broadcast: boolean, count = true, owners?: ReadonlyMap<string, ReadonlySet<number>>): Set<string> {
    const ctx = getCtx();
    const hits: Record<string, EnrichmentData> = {};
    const objects: BmpObject[] = [];
    const now = Date.now();
    for (const rid of chunk) {
      const data = results[rid];
      if (!data) continue;
      hits[rid] = data;
      enrichedRids.add(rid);
      permanentlyFailed.delete(rid);
      retried.delete(rid);
      objects.push({
        rid,
        businessId: data.businessId,
        type: data.type,
        name: data.name,
        templateBusinessId: data.templateBusinessId,
        identityEnriched: true,
        enrichedAt: now,
        cascade: data.cascade,
        source: 'server',
        discoveredAt: now,
        updatedAt: now,
      });
    }
    if (objects.length > 0) {
      ctx.cache.putAll(objects);
      if (count) cycle.resolved += objects.length;
      if (broadcast) deliver(hits, owners);
    }
    return new Set(Object.keys(hits));
  }

  /** Final failure: clear the loading badge and do not ask again for a while.
   *  A rid another caller resolved meanwhile keeps its identity. */
  function fail(rids: readonly string[], owners?: ReadonlyMap<string, ReadonlySet<number>>): void {
    const unresolved = rids.filter(rid => !enrichedRids.has(rid));
    for (const rid of unresolved) {
      permanentlyFailed.set(rid, Date.now());
      retried.delete(rid);
      cycle.failed.add(rid);
    }
    capPermanentlyFailed();
    broadcastEmpty(unresolved, owners);
  }

  function scheduleRetry(entries: ReadonlyArray<readonly [string, Set<number>]>): void {
    for (const [rid, tabs] of entries) {
      retried.add(rid);
      retrying.set(rid, tabs);
    }
    if (retryTimer) return;
    const jitter = Math.random() * ENRICHMENT_RETRY_DELAY * 0.3;
    const retryDelay = ENRICHMENT_RETRY_DELAY + jitter;
    getCtx().logActivity('info', `Retrying ${retrying.size} RIDs of failed batch(es) in ${Math.round(retryDelay / 1000)}s…`);
    const gen = enrichmentGeneration;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (gen !== enrichmentGeneration) return;
      for (const [rid, tabs] of retrying) {
        const queued = pending.get(rid);
        if (queued) for (const tab of tabs) queued.add(tab);
        else pending.set(rid, tabs);
      }
      retrying.clear();
      if (pending.size === 0) { if (!hasWork()) finishCycle(); return; }
      void drain();
    }, retryDelay);
  }

  function finishCycle(): void {
    const ctx = getCtx();
    const { resolved, failed } = cycle;
    cycle = { resolved: 0, failed: new Set() };
    const unresolved = [...failed].filter(rid => !enrichedRids.has(rid));
    if (resolved === 0 && unresolved.length === 0) return;
    ctx.logActivity(unresolved.length ? 'warn' : 'success',
      `Named ${resolved} page badge${resolved !== 1 ? 's' : ''}${unresolved.length ? `; ${unresolved.length} could not be loaded` : ''}`);
    ctx.sendToPanel({ type: 'CACHE_STATS', count: ctx.cache.size });
    // Flush cache to storage immediately — setTimeout-based batching won't
    // survive SW suspension, and enrichment is the main cache write path.
    ctx.cache.flush().catch(e => log.swallow('enrich:cacheFlush', e));
  }

  /** Clear enrichment state and trigger re-enrichment on all connected tabs */
  function refreshEnrichment() {
    const ctx = getCtx();
    incrementGeneration();
    ctx.logActivity('info', 'Refreshing the page badges…');
    ctx.broadcastToContent({ type: 'RE_ENRICH' });
  }

  return { enrichBadges, invalidateRid, publishIdentity, incrementGeneration, releaseTab, resetEnrichment, refreshEnrichment };
}

type Enricher = ReturnType<typeof createEnricher>;
const enrichers = new Map<string, { ctx: SwContext; enricher: Enricher }>();
let unbound: Enricher | null = null;

function enricherFor(ctx?: SwContext): Enricher {
  if (ctx?.profileId) {
    let entry = enrichers.get(ctx.profileId);
    if (!entry || entry.ctx !== ctx) {
      const bound = ctx;
      entry = { ctx: bound, enricher: createEnricher(() => bound) };
      enrichers.set(ctx.profileId, entry);
    }
    return entry.enricher;
  }
  return unbound ??= createEnricher(() => baseCtx());
}

/** Every enricher that exists (the unbound one in tests). */
function everyEnricher(): Enricher[] {
  const list = [...enrichers.values()].map(entry => entry.enricher);
  if (unbound) list.push(unbound);
  return list;
}

export const enrichBadges = (rids: string[], tabId?: number, ctx?: SwContext): Promise<void> => enricherFor(ctx).enrichBadges(rids, tabId);
export const invalidateRid = (rid: string, ctx?: SwContext): Promise<void> => enricherFor(ctx).invalidateRid(rid);
export const publishIdentity = (rid: string, data: EnrichmentData, ctx?: SwContext): void => enricherFor(ctx).publishIdentity(rid, data);
export const incrementGeneration = (ctx?: SwContext): void => enricherFor(ctx).incrementGeneration();
export const resetEnrichment = (ctx?: SwContext): void => enricherFor(ctx).resetEnrichment();
export const refreshEnrichment = (ctx?: SwContext): void => enricherFor(ctx).refreshEnrichment();
/** A tab left its page: every profile drops what only that tab asked for. */
export function releaseTab(tabId: number): void {
  for (const enricher of everyEnricher()) enricher.releaseTab(tabId);
}
/** Forget a profile's badge state (the profile was deleted). */
export function disposeEnricher(profileId: string): void { enrichers.delete(profileId); }
