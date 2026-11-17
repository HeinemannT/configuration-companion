/**
 * The local copy of a server's code ("Keep a copy on this computer"), made
 * from the code search's own read (code-search serverSource): the same
 * constant listing scripts, the same bulk reads per source and type, the
 * same read cache. A copy is that read written to the store (IndexedDB,
 * code-index-store), so it costs what a search costs, and a search that
 * already read the server leaves the build nothing to send but the summary.
 *
 * A copy is a snapshot. Once built, nothing is sent to the server for it
 * until the user presses Refresh: no check when a window opens, no change
 * feed, no check by age. The one change made without the server is the
 * user's own save through this extension (applySavedCode).
 *
 * Build: background work (load-governor's background budget, a 10 s limit
 * per post, refused during an overload cool-down), paced like the older
 * builder (index-budget Pacer: a pause after each post as long as the post
 * took, at least 500 ms). The change summary first (one post, before the
 * listing, so a change made during the read shows at the next refresh),
 * then the read; the objects are written when it is complete. A stopped
 * build keeps its meta without `builtAt` (paused: never searched as a
 * complete copy); the code read so far stays in the worker's read cache, so
 * Resume reads only the rest.
 *
 * Refresh (the user's request, user class at low priority, no pauses: as a
 * search reads): the change summary for the copy's own day window, asked
 * with the roots the copy was made with. A refresh with nothing changed is
 * that one post; the server's current roots and organisations (one more
 * post, unless the worker read them already) are read only for a listing.
 *  - The summary equals the stored one: nothing changed; nothing more is
 *    sent and the copy's time is the refresh's time.
 *  - The summary names changed types: the stored objects count as read and
 *    the place is listed again; only objects whose listed stamp or length
 *    differs from the copy are read.
 *  - No summary to compare (it failed, or the copy holds none): the place
 *    is listed and read again as a build reads it.
 * Until the refresh is complete the copy is not replaced: a stop or a
 * failure leaves the previous copy searchable. A source that could not be
 * listed keeps what the copy had of it.
 *
 * Fallback: a server whose listed code does not fit READ_ALL_CHARS is read
 * source by source (each root, each top-level organisation): each source is
 * listed again (the same commands as the whole listing, again) and read as
 * a search of that source reads it, then stored; Resume continues with the
 * sources not stored yet. A source that alone does not fit cannot be copied
 * and is named.
 *
 * Organisation objects are placed by their top-level organisation (the
 * search reads per top-level organisation); the window searches a deeper
 * organisation on the server.
 */

import { LIST_GROUP_MAX, serverSource, type CodeSearchProgress, type PlaceEstimate, type ScanSource, type ServerCodeSource, type ServerFeed } from './code-search';
import { codeTypes, readChangeSummary, refsOf, summaryChanges, type CodePropMap, type IndexClient, type StageCost, type Summary, type SyncProgress, type SyncResult } from './code-index-sync';
import { READ_ALL_CHARS } from './code-scope-read';
import { BUDGET, Pacer, ServerOverloadError } from './index-budget';
import { GOVERNOR } from './load-governor';
import { backgroundSignal, lowPrioritySignal } from './request-class';
import type { CodeIndexMeta, CodeIndexStore, IndexedObject, RootCoverage, StoredStamp } from './code-index-store';

/** The server's roots and organisations as the window shows them. */
export interface CopyRoots {
  /** Root accessors the server has, in order. */
  order: string[];
  names: Record<string, string>;
  rids: Record<string, string>;
  orgs: Record<string, { name: string; parent: string }>;
}

export interface CopyOptions {
  store: CodeIndexStore;
  /** The store's key: `<profile>@<server>`. */
  env: string;
  /** The search's read cache key (the environment and the client). */
  searchEnv: string;
  /** Every root, the organisation root by top-level organisation
   *  (code-index-service scanSourcesFor). */
  sources: readonly ScanSource[];
  roots: CopyRoots;
  map: CodePropMap;
  signal: AbortSignal;
  /** The live search's change feed, for a build's listing (the search's
   *  read it shares). A refresh does not use it. */
  feed?: ServerFeed;
  /** A refresh of a complete copy: `sources` and `roots` are the ones the
   *  copy was made with (its change summary needs only the roots), and this
   *  reads the server's current ones for the listing when the summary shows
   *  a change. Without it, `sources` and `roots` are used throughout. */
  current?: () => Promise<{ sources: readonly ScanSource[]; roots: CopyRoots }>;
  pacer?: Pacer;
  now?: () => number;
  onProgress?: (p: SyncProgress) => void;
}

/** Objects written per store transaction. */
const WRITE_BATCH = 500;

const sourceKey = (s: ScanSource) => `${s.from}|${s.rid ?? ''}`;

/** The search's read of `sources`. A build is background work and shares
 *  the live search's feed; a refresh is the user's request and lists again. */
function copySource(client: IndexClient, o: Pick<CopyOptions, 'searchEnv' | 'map' | 'feed' | 'now'>, sources: readonly ScanSource[], pacer?: Pacer, refresh = false): ServerCodeSource {
  return serverSource(client, {
    env: o.searchEnv, sources, map: o.map,
    ...(refresh ? { fresh: true } : { background: true, ...(o.feed ? { feed: o.feed } : {}) }),
    ...(pacer ? { pacer } : {}), ...(o.now ? { now: o.now } : {}),
  });
}

async function storedObjects(store: CodeIndexStore, env: string): Promise<IndexedObject[]> {
  const out: IndexedObject[] = [];
  await store.scan(env, batch => { out.push(...batch); });
  return out;
}

const sameStamp = (s: StoredStamp, o: IndexedObject) => s.stamp === o.stamp && s.len === o.len && s.type === o.type && s.root === o.root
  && (s.path ?? []).join(',') === (o.path ?? []).join(',') && s.tmpl === o.tmpl && (s.inherits ?? 0) === (o.inherits?.length ?? 0);

/** Write `objects` where they differ from the store; remove the stored
 *  objects of `inScope` that the read no longer holds. */
async function writeObjects(store: CodeIndexStore, env: string, objects: readonly IndexedObject[], signal: AbortSignal, inScope: (s: StoredStamp, rid: string) => boolean = () => true): Promise<{ changed: number; removed: number }> {
  const stored = await store.stamps(env);
  const keep = new Set(objects.map(o => o.rid));
  const put = objects.filter(o => { const s = stored.get(o.rid); return !s || !sameStamp(s, o); }).map(o => ({ ...o, env }));
  const gone = [...stored].filter(([rid, s]) => !keep.has(rid) && inScope(s, rid)).map(([rid]) => rid);
  for (let i = 0; i < put.length; i += WRITE_BATCH) {
    signal.throwIfAborted();
    await store.put(put.slice(i, i + WRITE_BATCH));
  }
  signal.throwIfAborted();
  if (gone.length) await store.remove(env, gone);
  return { changed: put.length, removed: gone.length };
}

/** Does a stored object lie in `src`? */
const inSource = (src: ScanSource) => (s: StoredStamp) => src.from === 'root' || (s.root === src.root && (src.root !== 'organisation' || s.top === src.path?.[0]));

function rootsCoverage(roots: CopyRoots, stored: Iterable<StoredStamp>, done: (key: string) => boolean): Record<string, RootCoverage> {
  const per: Record<string, number> = {};
  for (const s of stored) if (s.root) per[s.root] = (per[s.root] ?? 0) + 1;
  return Object.fromEntries(roots.order.map(k => [k, { name: roots.names[k] ?? k, objects: per[k] ?? 0, done: done(k) }]));
}

/**
 * Build the copy, or refresh a built one (see the file comment). Throws on
 * a stop (the signal), an overloaded server (ServerOverloadError) or a copy
 * that cannot be completed (named sources).
 */
export async function syncCopy(client: IndexClient, o: CopyOptions): Promise<SyncResult> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const prev = await o.store.getMeta(o.env);
  // An index of the older builder is replaced by a copy.
  const copyPrev = prev?.copy ? prev : null;
  const built = !!copyPrev?.builtAt;
  const signal = built ? lowPrioritySignal(o.signal) : backgroundSignal({ signal: o.signal });
  const pacer = o.pacer ?? new Pacer(built ? { minPauseMs: 0, maxPauseMs: 0, firstReadObjects: BUDGET.readObjects } : { firstReadObjects: BUDGET.readObjects });
  const today = new Date(now()).toISOString().slice(0, 10);
  const stages: StageCost[] = [];
  const result = (meta: CodeIndexMeta, extra: Partial<SyncResult>): SyncResult => ({
    meta, first: !built, changed: 0, removed: 0, failed: 0, bytes: 0, ...extra,
    posts: pacer.log.length, ms: now() - t0, stages, requests: pacer.log,
  });
  const overload = (e: unknown) => signal.aborted || e instanceof ServerOverloadError;

  // The summary for the copy's own day window: its answer compares with the
  // stored one.
  const day = built ? copyPrev!.summaryDay ?? today : today;
  let summary: Summary | undefined;
  try { summary = await readChangeSummary(client, o.map, o.roots.order, day, signal, pacer); }
  catch (e) { if (overload(e)) throw e; }
  const canTell = built && !!summary && !!copyPrev!.summary && !!copyPrev!.summaryDay;
  if (canTell && !summaryChanges(copyPrev!.summary, summary!).types.size) {
    // Nothing changed since the copy: nothing more is sent.
    signal.throwIfAborted();
    const meta: CodeIndexMeta = { ...copyPrev!, syncedAt: now(), summary: summary!, summaryDay: day };
    await o.store.putMeta(meta);
    o.onProgress?.({ phase: 'done', read: 0, toRead: 0, objects: meta.objects });
    stages.push({ stage: 'check', posts: pacer.log.length, ms: now() - t0, read: 0 });
    return result(meta, { unchanged: true });
  }
  // The listing reads the server's current roots and organisations (a
  // refresh asks for them only now, after its summary showed a change).
  const place = built && o.current ? await o.current() : { sources: o.sources, roots: o.roots };
  signal.throwIfAborted();
  const src = copySource(client, o, place.sources, pacer, built);
  // The summary names what changed: the stored objects count as read, so
  // only objects whose listed stamp or length differs are read. Without a
  // summary to compare, everything is read again.
  if (canTell) src.adopt(await storedObjects(o.store, o.env));

  // A build in progress has no builtAt: stopped, it is paused, never used
  // as a complete copy.
  const meta: CodeIndexMeta = built ? { ...copyPrev!, copy: { ...copyPrev!.copy } } : {
    env: o.env, syncedAt: null, builtAt: null, objects: 0, bytes: 0, types: codeTypes(o.map), pending: 0,
    revision: (prev?.revision ?? 0) + 1, codeProps: { ...o.map } as Record<string, string[]>, codePropsAt: null,
    roots: rootsCoverage(o.roots, [], () => false), rootOrder: [...o.roots.order], orgs: o.roots.orgs, rootRids: o.roots.rids,
    copy: { ...(prev?.copy?.perSource ? { perSource: true, sourcesDone: prev.copy.sourcesDone ?? [] } : {}) },
  };
  if (!built) { signal.throwIfAborted(); await o.store.putMeta(meta); }

  let last: CodeSearchProgress | null = null;
  const progress = (p: CodeSearchProgress) => {
    last = p;
    o.onProgress?.({ phase: p.phase === 'scan' ? 'listing' : 'reading', read: Math.min(p.total ?? p.candidates, p.searched ?? p.read), toRead: p.total ?? p.candidates, objects: meta.objects });
  };
  const keepProgress = async () => {
    const p = last as CodeSearchProgress | null;
    if (built || !p?.total) return;
    try { await o.store.putMeta({ ...meta, objects: p.total, pending: Math.max(0, p.total - (p.searched ?? 0)) }); } catch { /* the stop is what is reported */ }
  };
  /** A refresh that stopped after it wrote some objects: the copy stays
   *  usable, and the window loads it again. */
  const keepRefreshed = async () => {
    if (!built) return;
    try {
      const stored = await o.store.stamps(o.env);
      await o.store.putMeta({ ...copyPrev!, objects: stored.size, revision: (copyPrev!.revision ?? 0) + 1 });
    } catch { /* the stop is what is reported */ }
  };

  const t1 = now();
  const p1 = pacer.log.length;
  let read;
  try {
    read = meta.copy?.perSource ? null : await src.readAll(signal, progress);
  } catch (e) { await keepProgress(); throw e; }
  let changed = 0;
  let removed = 0;
  let unread: string[] = [];
  let readCount = 0;
  const failedSources: string[] = [];
  let wrote = false;
  try {
    if (read?.readAll) {
      readCount = read.read;
      unread = read.unread;
      failedSources.push(...read.failedSources);
      signal.throwIfAborted();
      // A refresh with a source that could not be listed keeps the copy as it is.
      if (built && failedSources.length) throw new Error(`The code of ${failedSources.join(', ')} could not be listed. The copy is unchanged; Refresh tries again.`);
      // A source that could not be listed keeps what the copy had of it; an
      // object that could not be read keeps its stored code.
      const skip = new Set(unread);
      wrote = true;
      const w = await writeObjects(o.store, o.env, read.objects, signal, failedSources.length ? () => false : (_s, rid) => !skip.has(rid));
      changed = w.changed;
      removed = w.removed;
      delete meta.copy!.perSource;
      delete meta.copy!.sourcesDone;
    } else {
      // Too much code to read in one go: source by source.
      meta.copy = { ...meta.copy, perSource: true, sourcesDone: built ? [] : [...(meta.copy?.sourcesDone ?? [])] };
      if (!built) await o.store.putMeta(meta);
      for (const s of place.sources) {
        if (meta.copy.sourcesDone!.includes(sourceKey(s))) continue;
        const one = copySource(client, o, [s], pacer, built);
        let r;
        try { r = await one.readAll(signal, progress); } catch (e) { await keepProgress(); throw e; }
        if (!r.readAll) throw new Error(`${s.label ?? s.from} alone holds ${(r.chars / 1e6).toFixed(1)} M characters of code, more than one read can hold (${Math.round(READ_ALL_CHARS / 1e6)} M with what is counted per object): the copy cannot be completed.`);
        readCount += r.read;
        unread.push(...r.unread);
        failedSources.push(...r.failedSources);
        meta.copy.sourcesDone = [...meta.copy.sourcesDone!, sourceKey(s)];
        // A refresh keeps the stored objects of a source it could not list.
        if (built && r.failedSources.length) continue;
        const skip = new Set(r.unread);
        wrote = true;
        const w = await writeObjects(o.store, o.env, r.objects, signal, r.failedSources.length ? () => false : (st, rid) => inSource(s)(st) && !skip.has(rid));
        changed += w.changed;
        removed += w.removed;
        if (!built) { signal.throwIfAborted(); await o.store.putMeta(meta); }
      }
      unread = [...new Set(unread)];
    }
  } catch (e) {
    if (wrote) await keepRefreshed();
    throw e;
  }
  stages.push({ stage: 'read', posts: pacer.log.length - p1, ms: now() - t1, read: readCount });

  const stored = await o.store.stamps(o.env);
  const at = now();
  meta.objects = stored.size;
  meta.bytes = [...stored.values()].reduce((n, s) => n + s.len, 0);
  meta.roots = rootsCoverage(place.roots, stored.values(), () => !failedSources.length);
  meta.rootOrder = [...place.roots.order];
  meta.orgs = place.roots.orgs;
  meta.rootRids = place.roots.rids;
  meta.pending = unread.length;
  meta.failed = unread.length;
  if (changed || removed || !built) meta.revision = (meta.revision ?? 0) + 1;
  // The new summary only when everything listed was read; otherwise a
  // refresh keeps the copy's older one (the next refresh then lists and
  // reads what changed since it) and a build stores none.
  if (summary && !unread.length && !failedSources.length) { meta.summary = summary; meta.summaryDay = day; }
  else if (!built) { delete meta.summary; delete meta.summaryDay; }
  if (failedSources.length) {
    // Not complete: never searched as a complete copy.
    if (!built) { meta.objects = stored.size; signal.throwIfAborted(); await o.store.putMeta(meta); }
    else await keepRefreshed();
    throw new Error(built
      ? `The code of ${failedSources.join(', ')} could not be listed; the copy keeps what it had of it. Refresh tries again.`
      : `The code of ${failedSources.join(', ')} could not be listed, so the copy is not complete. Resume tries again.`);
  }
  if (meta.copy?.perSource) meta.copy = { ...meta.copy, sourcesDone: [] };
  meta.syncedAt = at;
  meta.builtAt = meta.builtAt ?? at;
  meta.lastFullAt = at;
  signal.throwIfAborted();
  await o.store.putMeta(meta);
  o.onProgress?.({ phase: 'done', read: readCount, toRead: readCount, objects: meta.objects });
  return result(meta, { changed, removed, failed: unread.length });
}

/**
 * The user saved code through this extension and the server confirmed it:
 * the copy's object takes the saved text, so the next search finds it.
 * Nothing is sent to the server. `saved`: property → text as saved. Only
 * properties that hold code for the object's type are taken; an empty text
 * removes the property. The stamp stays, so the next Refresh reads the
 * object again (its stamp on the server is newer). Returns whether the copy
 * changed.
 */
export async function applySavedCode(store: CodeIndexStore, env: string, rid: string, saved: Readonly<Record<string, string>>): Promise<boolean> {
  const meta = await store.getMeta(env);
  if (!meta?.builtAt) return false;
  const o = await store.get(env, rid);
  if (!o) return false;
  const codeProps = new Set(meta.codeProps?.[o.type] ?? []);
  const code = { ...o.code };
  let inherits = o.inherits ? [...o.inherits] : undefined;
  let touched = false;
  for (const [prop, text] of Object.entries(saved)) {
    if (!codeProps.has(prop) && !(prop in code) && !inherits?.includes(prop)) continue;
    // Saved on the object: no longer the template's text.
    if (inherits?.includes(prop)) inherits = inherits.filter(p => p !== prop);
    if (text) code[prop] = text; else delete code[prop];
    touched = true;
  }
  if (!touched) return false;
  const len = Object.values(code).reduce((n, t) => n + t.length, 0);
  const { inherits: _old, ...rest } = o;
  await store.put([{ ...rest, code, len, refs: refsOf(code), ...(inherits?.length ? { inherits } : {}) }]);
  await store.putMeta({ ...meta, revision: (meta.revision ?? 0) + 1 });
  return true;
}

/** What a copy would cost, from the listing the build then uses (kept for
 *  it), in the units the window shows afterwards. */
export interface CopyEstimate extends PlaceEstimate {
  /** Posts and commands of the build (summary, listing, reads). */
  posts: number;
  commands: number;
  /** Expected time, paced and within the background budget. */
  seconds: number;
}

/** Characters of code per byte of answer, about (framing, non-ASCII). */
const BYTES_PER_CHAR = 1.1;
/** The time of one post beyond the work it carries (round trip), ms. */
const POST_OVERHEAD_MS = 50;

/**
 * The build's posts, commands and time from an estimate:
 *  - posts: one summary, the listing (made again unless still kept), the
 *    read plan's posts; source by source, each source's listing again;
 *  - time: the listing's measured server time per listed object stands for
 *    a read of one object too (both go through every code property of
 *    every object: the listing measures each text, the read returns it);
 *    each post is followed by a pause as long as it took, at least
 *    BUDGET.minPauseMs (index-budget); the background budget admits
 *    GOVERNOR.background.commands per minute after its burst, and its bytes
 *    per minute after theirs (load-governor). The largest of these is the
 *    time.
 */
export function copyCost(e: PlaceEstimate): { posts: number; commands: number; seconds: number } {
  const listPosts = e.list.posts || Math.ceil(e.list.commands / LIST_GROUP_MAX);
  const relistPosts = e.perSource ? Math.max(e.perSource.sources, Math.ceil(e.perSource.listCommands / LIST_GROUP_MAX)) : 0;
  const posts = 1 + listPosts + relistPosts + e.read.posts;
  const commands = 1 + e.list.commands + (e.perSource?.listCommands ?? 0) + e.read.commands;
  const perObject = e.objects ? e.list.ms / e.objects : 0;
  const listMs = e.list.ms * (e.perSource ? 2 : 1);
  const workMs = listMs + perObject * (e.read.bulkObjects + e.read.singles) + posts * POST_OVERHEAD_MS + (listPosts ? e.list.ms / listPosts : 0);
  const pausedMs = workMs + Math.max(posts * BUDGET.minPauseMs, workMs);
  const bg = GOVERNOR.background;
  const commandMs = (Math.max(0, commands - bg.commands.capacity) / bg.commands.perMinute) * 60_000;
  const bytes = e.toReadChars * BYTES_PER_CHAR;
  const byteMs = (Math.max(0, bytes - bg.bytes.capacity) / bg.bytes.perMinute) * 60_000;
  return { posts, commands, seconds: Math.ceil(Math.max(pausedMs, commandMs, byteMs) / 1000) };
}

/** List the place as the build will (the listing is kept for it) and say
 *  what the build costs. */
export async function estimateCopy(client: IndexClient, o: Pick<CopyOptions, 'searchEnv' | 'sources' | 'map' | 'feed' | 'now' | 'signal'>): Promise<CopyEstimate> {
  const e = await copySource(client, o, o.sources).estimate(o.signal);
  return { ...e, ...copyCost(e) };
}
