/**
 * The code search's change feed: the server's TreeEventCommand
 * (tree-events.ts) keeps the code read for searches (code-scope-read
 * codeReadCache) current, so a search lists the server once per session and
 * then follows the changes instead of listing again.
 *
 *  1. Before a listing starts, the feed takes a watermark (one
 *     `TreeEventCommand(-1)`), unless it follows the changes already. The
 *     polls made while the listing runs are logged; when the listing is
 *     complete they are applied to it, and what arrives meanwhile too, until
 *     nothing is left: only then does the listing go live (one application
 *     at a time, in poll order, so no poll is lost in the hand-over).
 *  2. While at least one code search window of that server profile holds
 *     its keep-alive port (keep-alive.ts), the worker polls every
 *     FEED_POLL_MS (and once when a window opens) and applies each poll to
 *     the listings the feed keeps (`CachedListing.feed`). Events are applied
 *     in pack order (a delete then a re-add of one RID ends added):
 *      - an object of the listing that was updated or moved is read again
 *        (stamp, code, where) with the constant per-object reader; a deleted
 *        one is dropped;
 *      - an added object, or an updated one not in the listing, is
 *        identified with the built-in tree-item read (type only; an unknown
 *        RID is left out, never a failed post). One of a code type is placed
 *        by its parent, else by its ancestors (one constant reader, the
 *        object as the context: buildAncestorsEc) matched against the
 *        listed sources and rows; inside a listed source it is read and
 *        added, outside every one it is ignored (and remembered);
 *      - an updated listed object, an updated source, and an updated object
 *        without code inside a listed source get their code descendants
 *        listed (the listing's own constant scripts on them as the context):
 *        an object added outside its parent's "children" slot is announced
 *        only as its parent's update. At most FEED_CHILD_CHECKS per poll.
 *      - a new object whose read failed is tried again at the next polls
 *        (FEED_RETRIES times), then the feed goes stale.
 *     The application of a poll whose answer arrived is never stopped by
 *     the search that asked for it ("Search again"): its signal only stops
 *     the waiting.
 *  3. The feed is stale, and the next search lists again, after a failed
 *     poll, more than FEED_GAP_MS between the sending of the last successful
 *     poll and the arrival of this one's answer (packs expire after 60 to
 *     120 s and the server gives no gap signal; a monotonic clock), more than
 *     FEED_MAX_RIDS objects in one poll, a change of type definitions
 *     (`propertiesChanged`), pack ids that go back, a fresh watermark below
 *     the stored one (a server restart; checked every FEED_CROSSCHECK_MS and
 *     on "Search again"), or a change that cannot be applied. A listing is
 *     never trusted across such a gap; one where an object cannot be placed
 *     (a source without a known RID) is no longer kept by the feed.
 *
 * Per server profile, client instance and connection: new credentials (a new
 * client) or a reconnect start again. Polls are user-class posts (a window is
 * open and waits for them) of the built-in index kind: the governor charges
 * them by measured time; with background work stopped after an overload
 * signal the feed stops too. The reads they cause are low-priority work,
 * paced. Nothing polls without a window: the timer runs only while a window
 * holds its port, and no poll keeps the worker alive by itself.
 */

import { CommandCapabilities } from './search-command';
import { classifyTreeEventFailure, laterPackId, type TreeEventAnswer, type TreeEventPack } from './tree-events';
import { buildAncestorsEc, buildSourceListEc, codeReadCache, listTypeGroups, parseAncestorsLog, parseSourceListLog, untrack as untrackListing, type CachedListing, type ListedRow } from './code-scope-read';
import { KNOWN_CODE_PROPS, propsOf, readObjects, type CodePropMap, type IndexClient, type ReadObject } from './code-index-sync';
import { CONTEXT_OBJECT } from './ec-parser';
import { CONTEXT_PER_POST } from './constants';
import { lowPrioritySignal } from './request-class';
import { Pacer } from './index-budget';
import type { ServerFeed } from './code-search';
import { onClientRetired } from './bmp-client';

/** How often a window's server is polled. */
export const FEED_POLL_MS = 15_000;
/** Longer than this between the last successful poll and an answer: events
 *  may be lost. */
export const FEED_GAP_MS = 50_000;
/** A poll's own time-out (the transport's; queue time counts in the gap). */
export const FEED_POLL_TIMEOUT_MS = 10_000;
/** More distinct objects than this in one poll: list again instead. */
export const FEED_MAX_RIDS = 200;
/** Objects whose code descendants are listed per poll; more: list again. */
export const FEED_CHILD_CHECKS = 20;
/** How often a fresh watermark is compared with the stored one. */
export const FEED_CROSSCHECK_MS = 3 * 60_000;
/** Polls a new object whose read failed is tried again at. */
export const FEED_RETRIES = 3;
/** Objects remembered as without code type, or outside every source. */
const REMEMBER_MAX = 20_000;

export interface FeedClient extends IndexClient {
  readTreeEvents(lastPackId: string, signal?: AbortSignal, timeoutMs?: number): Promise<TreeEventAnswer>;
  readTreeIdentities(rids: readonly string[], signal?: AbortSignal, perPost?: number): Promise<Map<string, { type?: string } | null>>;
  /** The load governor (overload: no polling). */
  governor?: { backgroundBlocked(): { why: 'overloaded' | 'slow' } | null };
}

/** The feed's capability record per server profile and connection. */
export const feedCapabilities = new CommandCapabilities();

/** A key unique to one client instance: a client made for new credentials
 *  never shares the feed or the kept code of the one before. */
const clientIds = new WeakMap<object, number>();
let nextClientId = 1;
export function clientKey(client: object): string {
  let id = clientIds.get(client);
  if (id == null) { id = nextClientId++; clientIds.set(client, id); }
  return String(id);
}

/** A change that cannot be applied: the feed goes stale with this reason. */
class FeedError extends Error {}

// ── changes ───────────────────────────────────────────────────────────

/** What one poll (or several) changed, by RID: each RID's last event. */
export interface FeedChanges {
  deleted: Set<string>;
  updated: Set<string>;
  /** Added objects with their parent (null: not given). */
  added: Map<string, string | null>;
  /** Moved objects with their new parent. */
  relocated: Map<string, string | null>;
}

const emptyChanges = (): FeedChanges => ({ deleted: new Set(), updated: new Set(), added: new Map(), relocated: new Map() });
const isEmpty = (c: FeedChanges) => !c.deleted.size && !c.updated.size && !c.added.size && !c.relocated.size;

function event(c: FeedChanges, kind: 'add' | 'move' | 'update' | 'delete', rid: string, parent: string | null = null): void {
  if (kind === 'delete') { c.updated.delete(rid); c.added.delete(rid); c.relocated.delete(rid); c.deleted.add(rid); return; }
  c.deleted.delete(rid);
  if (kind === 'add') c.added.set(rid, parent);
  else if (kind === 'move') c.relocated.set(rid, parent);
  else c.updated.add(rid);
}

/** `next` applied after `into` (each RID's later event wins). */
export function mergeChanges(into: FeedChanges, next: FeedChanges): FeedChanges {
  for (const r of next.deleted) event(into, 'delete', r);
  for (const [r, p] of next.added) event(into, 'add', r, p);
  for (const [r, p] of next.relocated) event(into, 'move', r, p);
  for (const r of next.updated) event(into, 'update', r);
  return into;
}

/** The changes of a poll's packs in pack order, and the distinct RIDs. */
export function changesOf(packs: readonly TreeEventPack[]): { changes: FeedChanges; rids: number } {
  const c = emptyChanges();
  const all = new Set<string>();
  const ordered = [...packs].sort((a, b) => (BigInt(a.packId) < BigInt(b.packId) ? -1 : BigInt(a.packId) > BigInt(b.packId) ? 1 : 0));
  for (const p of ordered) {
    // One pack is one commit: an object is added, moved, changed or
    // deleted in it, not two of these.
    for (const a of p.added) { event(c, 'add', a.rid, a.parent); all.add(a.rid); }
    for (const m of p.relocated) { event(c, 'move', m.rid, m.parent); all.add(m.rid); }
    for (const r of p.updated) { event(c, 'update', r); all.add(r); }
    for (const r of p.deleted) { event(c, 'delete', r); all.add(r); }
    for (const r of p.reordered) all.add(r);
  }
  return { changes: c, rids: all.size };
}

// ── state ─────────────────────────────────────────────────────────────

export type FeedHealth = 'fresh' | 'stale' | 'off';

interface FeedState {
  profile: string;
  session: string;
  /** Taken from a counter that never restarts; listings carry it. */
  generation: number;
  watermark: string | null;
  /** Monotonic time the last successful poll (or watermark) was sent. */
  lastOkMono: number | null;
  /** The same on the wall clock (the footer's "as of"). */
  lastOkWall: number | null;
  lastCrossMono: number | null;
  /** Why the feed no longer follows the changes (null: it does). */
  stale: string | null;
  /** Polls received so far; listings remember where they started. */
  seq: number;
  /** The changes of each poll while a listing is being made. */
  log: Array<{ seq: number; changes: FeedChanges }>;
  pendingListings: number;
  /** Applications, one at a time in poll order. */
  chain: Promise<unknown>;
  /** Code kept with a stamp too young to trust after a gap (code-scope-read
   *  STAMP_SETTLE_MS): forgotten when the feed goes stale. */
  unsettled: Set<string>;
  nonCode: Set<string>;
  /** Objects outside every listed source (until a listing goes live). */
  outside: Set<string>;
  /** Ancestors read (nearest first), by RID. */
  ancestors: Map<string, string[]>;
  /** Parent of an added or moved object, from its event. */
  parents: Map<string, string>;
  /** Objects saved through Companion: read again at the next poll. */
  dirty: Set<string>;
  /** New objects whose read failed: tried again, with the tries so far. */
  retries: Map<string, number>;
  /** Listed objects whose read again failed, with the tries so far. */
  rereadTries: Map<string, number>;
  /** Updated objects whose code descendants are still to be listed (more
   *  than FEED_CHILD_CHECKS in one poll): checked at the next polls. */
  pendingChecks: Set<string>;
  /** Objects named by polls whose application is still queued. */
  backlog: number;
  polling: Promise<void> | null;
}

const states = new Map<string, FeedState>();
let nextGeneration = 1;
const profileOf = (env: string) => env.slice(0, Math.max(0, env.indexOf('@')));

function newState(profile: string, session: string): FeedState {
  return {
    profile, session, generation: nextGeneration++, watermark: null, lastOkMono: null, lastOkWall: null, lastCrossMono: null, stale: null,
    seq: 0, log: [], pendingListings: 0, chain: Promise.resolve(), unsettled: new Set(), nonCode: new Set(), outside: new Set(),
    ancestors: new Map(), parents: new Map(), dirty: new Set(), retries: new Map(), rereadTries: new Map(), pendingChecks: new Set(), backlog: 0, polling: null,
  };
}

/** The feed state of `env` for this connection (`session`): another
 *  session than before (a reconnect) drops watermark and listings. */
function stateOf(env: string, session: string): FeedState {
  const s = states.get(env);
  if (s && s.session === session) return s;
  // Listings and kept code: what was read in another session is not used.
  if (s) { codeReadCache.clearEnv(env); forgetUnsettled(env, s); }
  const next = newState(profileOf(env), session);
  states.set(env, next);
  return next;
}

/** Time since the last successful check was sent: the larger of the
 *  monotonic and the wall-clock gap (a sleeping machine stops the monotonic
 *  clock on some platforms; a wall clock set back is not trusted alone). */
function gapOf(s: FeedState, monoNow = mono(), wallNow = clock()): number {
  if (s.lastOkMono == null || s.lastOkWall == null) return Number.POSITIVE_INFINITY;
  return Math.max(monoNow - s.lastOkMono, Math.max(0, wallNow - s.lastOkWall));
}

function forgetUnsettled(env: string, s: FeedState): void {
  for (const rid of s.unsettled) codeReadCache.drop(env, rid);
  s.unsettled.clear();
}

let listener: ((env: string, info: FeedInfo) => void) | null = null;
/** Called after each poll and state change (the windows' footer). */
export function setFeedListener(fn: ((env: string, info: FeedInfo) => void) | null): void { listener = fn; }

export interface FeedInfo { health: FeedHealth; at: number | null; reason?: string }

function tell(env: string, s: FeedState): void {
  try { listener?.(env, infoOf(s)); } catch { /* a listener must not stop the feed */ }
}

function infoOf(s: FeedState | undefined): FeedInfo {
  if (!s || !s.watermark) return { health: 'off', at: null };
  if (s.stale) return { health: 'stale', at: s.lastOkWall, reason: s.stale };
  return { health: 'fresh', at: s.lastOkWall };
}

/** The feed no longer follows the changes of `env`: its listings are not
 *  used again (the next search lists again). */
function markStale(env: string, s: FeedState, reason: string): void {
  if (s.stale) return;
  s.stale = reason;
  s.log = [];
  s.dirty.clear();
  s.retries.clear();
  s.rereadTries.clear();
  s.pendingChecks.clear();
  codeReadCache.untrackListings(env);
  forgetUnsettled(env, s);
  tell(env, s);
}

/** Run `job` after every application queued before it. */
function enqueue<T>(s: FeedState, job: () => Promise<T>): Promise<T> {
  const run = s.chain.then(job, job);
  s.chain = run.catch(() => undefined);
  return run;
}

// ── clocks and timers ─────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null;
let timers: { set(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clear(t: ReturnType<typeof setTimeout>): void } = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: t => clearTimeout(t),
};
let clock: () => number = () => Date.now();
let mono: () => number = () => performance.now();

/** Tests: a fake wall clock, timers and monotonic clock. */
export function setFeedClock(now: () => number, t?: typeof timers, monotonic?: () => number): void {
  clock = now;
  if (t) timers = t;
  mono = monotonic ?? now;
}

// ── who holds a window open ───────────────────────────────────────────

/** What a window's port stands for: its server profile's environment and
 *  client, resolved when needed (the profile may connect later). */
export interface FeedHolder {
  resolve(): Promise<{ env: string; client: FeedClient; session: string } | null>;
}

const holders = new Map<object, FeedHolder & { env?: string }>();

/** Resolve the holders not resolved yet (a window opened before its
 *  profile was connected). */
async function resolveHolders(): Promise<Map<string, { client: FeedClient; session: string }>> {
  const byEnv = new Map<string, { client: FeedClient; session: string }>();
  for (const h of [...holders.values()]) {
    try {
      const r = await h.resolve();
      h.env = r?.env;
      if (r && !byEnv.has(r.env)) byEnv.set(r.env, { client: r.client, session: r.session });
    } catch { h.env = undefined; }
  }
  return byEnv;
}

/** A code search window opened its keep-alive port. A feed that follows
 *  the changes of its server is polled at once. */
export function holdFeed(key: object, holder: FeedHolder): void {
  const h: FeedHolder & { env?: string } = { ...holder };
  holders.set(key, h);
  void holder.resolve().then(r => {
    if (holders.get(key) !== h || !r) return;
    h.env = r.env;
    const s = states.get(r.env);
    if (s?.watermark && !s.stale && s.session === r.session) void pollFeed(r.env, r.client, r.session).catch(() => undefined);
  }).catch(() => undefined);
  schedule();
}

/** Its port closed (the window closed). The last window of a server ends
 *  the polling of that server; the last window at all stops the timer. */
export function releaseFeed(key: object): void {
  holders.delete(key);
  if (!holders.size && timer) { timers.clear(timer); timer = null; }
}

/** Does a window of `env` hold its port? */
export function feedHeld(env: string): boolean {
  for (const h of holders.values()) if (h.env === env) return true;
  return false;
}

function schedule(): void {
  if (!holders.size) { if (timer) { timers.clear(timer); timer = null; } return; }
  if (!timer) timer = timers.set(() => { timer = null; void tick(); }, FEED_POLL_MS);
}

/** One round: every server a window holds and the feed follows is polled. */
export async function tick(): Promise<void> {
  const byEnv = await resolveHolders();
  for (const [env, { client, session }] of byEnv) {
    const s = states.get(env);
    if (!s || s.session !== session || !s.watermark || s.stale) continue;
    // Not waited for: the next round is timed from now, whatever the
    // applications queued by this one take (a poll under way is joined).
    void pollFeed(env, client, session).catch(() => undefined);
  }
  schedule();
}

// ── listings ──────────────────────────────────────────────────────────

/** A listing in the making: the feed generation and the poll it started at. */
export interface FeedTicket { generation: number; seq: number }

/** Is a listing of generation `generation` current: the feed follows the
 *  changes, polled successfully within FEED_GAP_MS, and a window holds it?
 *  Another session (`session`) drops the old state. */
export function feedCurrent(env: string, generation: number | undefined, session?: string): boolean {
  const old = states.get(env);
  if (session != null && old && old.session !== session) { stateOf(env, session); return false; }
  const s = states.get(env);
  if (!s || generation == null || s.generation !== generation || s.stale || !s.watermark || s.lastOkMono == null) return false;
  if (gapOf(s) > FEED_GAP_MS) return false;
  return feedHeld(env);
}

export function feedInfo(env: string): FeedInfo {
  const s = states.get(env);
  if (s?.watermark && !s.stale && s.lastOkMono != null && gapOf(s) > FEED_GAP_MS) return { health: 'stale', at: s.lastOkWall, reason: 'too long since the last check' };
  return infoOf(s);
}

/** Before a listing: a watermark, unless the feed follows the changes
 *  already (then none is taken). Null when the feed cannot be used (no
 *  window holds it, unsupported, suspended, or the watermark failed). */
export async function beginListing(env: string, client: FeedClient, session: string, signal?: AbortSignal): Promise<FeedTicket | null> {
  if (!feedHeld(env)) await resolveHolders();
  if (!feedHeld(env)) return null;
  const s = stateOf(env, session);
  const now = clock();
  if (!feedCapabilities.usable(s.profile, session, 'feed', now)) return null;
  const following = s.watermark && !s.stale && s.lastOkMono != null && gapOf(s) <= FEED_GAP_MS;
  if (!following) {
    const sent = mono();
    const sentWall = clock();
    let answer: TreeEventAnswer;
    try {
      answer = await client.readTreeEvents('-1', signal, FEED_POLL_TIMEOUT_MS);
    } catch (e) {
      signal?.throwIfAborted();
      feedCapabilities.record(s.profile, session, 'feed', 'failed', (e instanceof Error ? e.message : String(e)).slice(0, 300), now);
      return null;
    }
    if (states.get(env) !== s) return null;
    if (!answer.ok || !answer.packs.length) {
      feedCapabilities.record(s.profile, session, 'feed', answer.ok ? 'failed' : classifyTreeEventFailure(answer.message, answer.stackTrace), answer.ok ? 'No watermark in the answer' : answer.message.slice(0, 300), now);
      return null;
    }
    feedCapabilities.record(s.profile, session, 'feed', 'answered', undefined, now);
    codeReadCache.untrackListings(env);
    forgetUnsettled(env, s);
    s.generation = nextGeneration++;
    s.watermark = answer.packs.reduce((w, p) => laterPackId(w, p.packId), answer.packs[0].packId);
    s.lastOkMono = sent;
    s.lastCrossMono = sent;
    s.lastOkWall = sentWall;
    s.stale = null;
    s.log = [];
    s.dirty.clear();
    s.retries.clear();
    s.rereadTries.clear();
    s.pendingChecks.clear();
    s.outside.clear();
    tell(env, s);
  }
  s.pendingListings++;
  return { generation: s.generation, seq: s.seq };
}

function listingDone(s: FeedState): void {
  s.pendingListings = Math.max(0, s.pendingListings - 1);
  if (!s.pendingListings) s.log = [];
}

/**
 * The listing of `ticket` is complete (`ok`: every source was listed). The
 * polls logged since it started are applied to it, then those that arrived
 * meanwhile, until none is left; then `put` keeps it and the feed keeps it
 * current, with no await in between. Runs in turn with the polls'
 * applications, and is not stopped by the search's signal. A listing that
 * is not complete is not kept.
 */
export function finishListing(env: string, client: FeedClient, ticket: FeedTicket, listing: CachedListing<ListedRow>, ok: boolean, put: () => void): Promise<boolean> {
  const s = states.get(env);
  if (!s) { if (ok) put(); return Promise.resolve(false); }
  return enqueue(s, async () => {
    try {
      if (!ok) return false;
      const live = () => !s.stale && states.get(env) === s && s.generation === ticket.generation;
      if (!live()) { put(); return false; }
      listing.feed = ticket.generation;
      let applied = ticket.seq;
      for (;;) {
        const missed = s.log.filter(e => e.seq > applied);
        if (!missed.length) break;
        const merged = missed.reduce((c, e) => mergeChanges(c, e.changes), emptyChanges());
        applied = missed[missed.length - 1].seq;
        try { await applyChanges(env, client, s, [listing], merged); }
        catch (e) { markStale(env, s, e instanceof FeedError ? e.message : 'the changes made during the listing could not be read'); }
        if (!live()) { untrackListing(listing); put(); return false; }
      }
      listing.feedSeq = applied;
      if (listing.feed !== ticket.generation) { put(); return false; }
      // Every source is listed: nothing is outside that was not before.
      s.outside.clear();
      put();
      return true;
    } finally {
      listingDone(s);
    }
  });
}

/** A listing in the making stopped (the search was stopped or failed). */
export function abandonListing(env: string): void {
  const s = states.get(env);
  if (s) listingDone(s);
}

/** Code kept for a listing the feed covers, with a stamp too young to be
 *  trusted after a gap: forgotten when the feed goes stale. */
export function noteUnsettled(env: string, rid: string): void {
  states.get(env)?.unsettled.add(rid);
}

/** Companion saved this object: read it again at the next poll. */
export function markFeedDirty(env: string, rid: string): void {
  const s = states.get(env);
  if (s?.watermark && !s.stale) s.dirty.add(rid);
}

// ── polls ─────────────────────────────────────────────────────────────

/** Poll now and apply what changed (the timer, a window opening, "Search
 *  again" with `crossCheck`). A poll under way is joined. `signal` stops
 *  the post while it waits or runs; once its answer arrived, the
 *  application is not stopped. */
export function pollFeed(env: string, client: FeedClient, session: string, signal?: AbortSignal, crossCheck = false): Promise<void> {
  const s = states.get(env);
  if (!s || s.session !== session || !s.watermark || s.stale) return Promise.resolve();
  if (s.polling) return s.polling;
  const run = (async () => {
    const sent = mono();
    const now = clock();
    if (gapOf(s, sent, now) > FEED_GAP_MS) { markStale(env, s, 'more than 50 s since the last check'); return; }
    if (client.governor?.backgroundBlocked()?.why === 'overloaded') { markStale(env, s, 'the server answered like an overloaded one'); return; }
    if (!feedCapabilities.usable(s.profile, session, 'feed', now)) { markStale(env, s, 'the change feed is not available'); return; }
    const from = s.watermark!;
    let answer: TreeEventAnswer;
    try {
      answer = await client.readTreeEvents(from, signal, FEED_POLL_TIMEOUT_MS);
    } catch (e) {
      if (signal?.aborted) return; // no answer: nothing moved
      feedCapabilities.record(s.profile, session, 'feed', 'failed', (e instanceof Error ? e.message : String(e)).slice(0, 300), now);
      markStale(env, s, 'the change feed could not be read');
      return;
    }
    const arrived = mono();
    if (states.get(env) !== s || s.stale) return;
    // The answer may have waited in the queue: what counts is when it came.
    if (gapOf(s, arrived, clock()) > FEED_GAP_MS) { markStale(env, s, 'the check came back more than 50 s after the last one'); return; }
    if (!answer.ok) {
      feedCapabilities.record(s.profile, session, 'feed', classifyTreeEventFailure(answer.message, answer.stackTrace), answer.message.slice(0, 300), now);
      markStale(env, s, 'the change feed answered with an error');
      return;
    }
    feedCapabilities.record(s.profile, session, 'feed', 'answered', undefined, now);
    const w = BigInt(from);
    if (answer.packs.some(p => BigInt(p.packId) < w)) { markStale(env, s, 'the change feed went back (another server node)'); return; }
    if (answer.packs.some(p => p.propertiesChanged)) { markStale(env, s, 'type definitions changed'); return; }
    const { changes, rids } = changesOf(answer.packs.filter(p => BigInt(p.packId) > w));
    if (rids > FEED_MAX_RIDS) { markStale(env, s, `more than ${FEED_MAX_RIDS} objects changed at once`); return; }
    for (const r of s.dirty) if (!changes.deleted.has(r) && !changes.added.has(r)) changes.updated.add(r);
    s.dirty.clear();
    for (const r of s.retries.keys()) if (!changes.deleted.has(r) && !changes.updated.has(r) && !changes.relocated.has(r)) changes.added.set(r, changes.added.get(r) ?? s.parents.get(r) ?? null);
    s.watermark = answer.packs.reduce((x, p) => laterPackId(x, p.packId), from);
    s.lastOkMono = sent;
    s.lastOkWall = now;
    const seq = ++s.seq;
    if (s.pendingListings) s.log.push({ seq, changes });
    // A server restart starts its counter again: a fresh watermark below
    // the stored one shows it (the answers after n would stay empty).
    if (crossCheck || s.lastCrossMono == null || arrived - s.lastCrossMono > FEED_CROSSCHECK_MS) {
      s.lastCrossMono = arrived;
      let fresh: TreeEventAnswer | null = null;
      try { fresh = await client.readTreeEvents('-1', undefined, FEED_POLL_TIMEOUT_MS); } catch { fresh = null; }
      if (!fresh?.ok || !fresh.packs.length) { markStale(env, s, 'the change feed could not be checked'); return; }
      if (fresh.packs.every(p => BigInt(p.packId) < BigInt(s.watermark!))) { markStale(env, s, 'the server\'s change counter went back (a restart)'); return; }
    }
    // The application is queued, not waited for by the next poll: polls
    // stay on time while many objects are read again. The objects waiting
    // to be applied are bounded like one poll's.
    const named = changes.deleted.size + changes.updated.size + changes.added.size + changes.relocated.size;
    if (s.backlog + named > FEED_MAX_RIDS) { markStale(env, s, `more than ${FEED_MAX_RIDS} changed objects waiting to be applied`); return; }
    s.backlog += named;
    s.polling = null;
    try { await enqueue(s, () => applyToLive(env, client, s, seq, changes)); }
    finally { s.backlog = Math.max(0, s.backlog - named); }
    if (!s.stale) tell(env, s);
  })().finally(() => { if (s.polling === run) s.polling = null; });
  s.polling = run;
  return run;
}

/** Resolves when every queued application of `env` is done. */
export function feedSettled(env: string): Promise<void> {
  const s = states.get(env);
  return s ? s.chain.then(() => undefined, () => undefined) : Promise.resolve();
}

/** Apply a poll to the live listings that have not seen it yet. */
async function applyToLive(env: string, client: FeedClient, s: FeedState, seq: number, changes: FeedChanges): Promise<void> {
  if (s.stale || states.get(env) !== s) return;
  const listings = codeReadCache.feedListings(env, s.generation).filter(l => (l.feedSeq ?? -1) < seq);
  if (listings.length && (!isEmpty(changes) || s.pendingChecks.size)) {
    try { await applyChanges(env, client, s, listings, changes); }
    catch (e) { markStale(env, s, e instanceof FeedError ? e.message : 'a changed object could not be read'); return; }
  }
  for (const l of listings) if (l.feed === s.generation) l.feedSeq = seq;
}

// ── applying ──────────────────────────────────────────────────────────

/** Where an object goes in `l`: the source index; OUTSIDE when it lies
 *  under no listed source; UNKNOWN when it cannot be told. */
const OUTSIDE = -2;
const UNKNOWN = -1;
function placeIn(l: CachedListing<ListedRow>, parent: string | null | undefined, chain: readonly string[] | null | undefined, rowOf: Map<string, ListedRow>): number {
  const srcs = l.srcRids ?? [];
  for (const a of [...(parent ? [parent] : []), ...(chain ?? [])]) {
    const row = rowOf.get(a);
    if (row) return row.src;
    const i = srcs.indexOf(a);
    if (i >= 0) return i;
  }
  const all = srcs.indexOf('*');
  if (all >= 0) return all;
  // Every ancestor up to the model root is known and none is a source:
  // outside, unless a source of this listing has no known RID. A chain cut
  // (too deep, an ancestor not readable: null) cannot tell.
  return chain && !srcs.some(r => r == null) ? OUTSIDE : UNKNOWN;
}

const lengthOf = (o: ReadObject) => Object.values(o.code).reduce((n, t) => n + t.length, 0);

/** The ancestors of `rids` (nearest first, up to the model root), read once
 *  each; null when the chain did not reach a model root (cut at
 *  ANCESTOR_DEPTH, or an ancestor not readable); undefined for an object
 *  they could not be read for. */
async function ancestorsOf(client: FeedClient, s: FeedState, rids: readonly string[], signal: AbortSignal): Promise<Map<string, string[] | null | undefined>> {
  const out = new Map<string, string[] | null | undefined>();
  const need = rids.filter(r => { const a = s.ancestors.get(r); if (a) out.set(r, a); return !a; });
  if (need.length && client.executeEcEach) {
    const answers = await client.executeEcEach(buildAncestorsEc(), need, signal, 60_000);
    for (const rid of need) {
      const r = answers.get(rid);
      if (r && !r.ok && r.errorKind && r.errorKind !== 'server') throw new FeedError('the place of a new object could not be read');
      let chain: string[] | null | undefined;
      if (r?.ok && r.log != null) {
        const a = parseAncestorsLog(r.log);
        chain = a ? (a.complete ? a.chain : null) : undefined;
      }
      out.set(rid, chain);
      if (chain) {
        if (s.ancestors.size >= REMEMBER_MAX) s.ancestors.clear();
        s.ancestors.set(rid, chain);
      }
    }
  }
  return out;
}

/**
 * Apply `changes` to `listings` (each edited in place) and to the code kept
 * for them. See the file comment for the rules. Runs on its own low-priority
 * signal (never the search's): it either completes or throws, and a throw
 * makes the feed stale.
 */
async function applyChanges(env: string, client: FeedClient, s: FeedState, listings: ReadonlyArray<CachedListing<ListedRow>>, changes: FeedChanges): Promise<void> {
  const low = lowPrioritySignal(new AbortController().signal);
  const live = [...listings];
  if (!live.length) return;
  const map: CodePropMap = live[0].map ?? KNOWN_CODE_PROPS;
  const isCode = (type: string | undefined) => !!type && !!map[type];
  for (const [rid, p] of [...changes.added, ...changes.relocated]) {
    if (p) s.parents.set(rid, p);
    // A moved or new object may have left (or entered) every source.
    s.ancestors.delete(rid);
    s.outside.delete(rid);
  }
  if (changes.relocated.size) {
    // A moved folder moves what is below it: every placement remembered
    // through it is forgotten, and what was outside is asked again.
    for (const [rid, chain] of [...s.ancestors]) if (chain.some(a => changes.relocated.has(a))) s.ancestors.delete(rid);
    s.outside.clear();
  }
  if (s.parents.size > REMEMBER_MAX) s.parents.clear();
  const indexOf = (l: CachedListing<ListedRow>) => new Map(l.rows.map(r => [r.rid, r] as const));
  let index = live.map(indexOf);

  // Deleted: dropped.
  for (const rid of changes.deleted) {
    codeReadCache.drop(env, rid);
    s.unsettled.delete(rid);
    s.retries.delete(rid);
    s.ancestors.delete(rid);
    live.forEach((l, k) => { if (index[k].has(rid)) l.rows = l.rows.filter(r => r.rid !== rid); });
  }
  if (changes.deleted.size) index = live.map(indexOf);

  const known = (rid: string) => index.some(ix => ix.has(rid));
  const sourceIn = (l: CachedListing<ListedRow>, rid: string) => l.srcRids?.indexOf(rid) ?? -1;
  const isSource = (rid: string) => live.some(l => sourceIn(l, rid) >= 0);
  /** Objects to read again: RID → type. */
  const reread = new Map<string, string>();
  /** New objects: their type and source per listing. */
  const additions = new Map<string, { type: string; src: Map<number, number> }>();
  const addTo = (rid: string, type: string, li: number, src: number) => {
    const a = additions.get(rid) ?? { type, src: new Map<number, number>() };
    a.src.set(li, src);
    additions.set(rid, a);
  };

  for (const rid of [...changes.updated, ...changes.relocated.keys()]) {
    for (const ix of index) { const row = ix.get(rid); if (row) reread.set(rid, row.type); }
  }

  // Identify what no listing holds: code types are candidates; the others
  // are remembered as without code (their type does not change).
  const unknown = [...new Set([...changes.updated, ...changes.added.keys(), ...changes.relocated.keys()])]
    .filter(r => !known(r) && !isSource(r) && !s.nonCode.has(r) && !s.outside.has(r));
  const candidates = new Map<string, string>();
  if (unknown.length) {
    // A failed post throws: the feed goes stale (never a guess).
    let ids: Map<string, { type?: string } | null>;
    try { ids = await client.readTreeIdentities(unknown, low); } catch { throw new FeedError('the type of a changed object could not be read'); }
    for (const rid of unknown) {
      const id = ids.get(rid);
      if (!id) continue; // gone, or not visible to this user
      if (isCode(id.type)) candidates.set(rid, id.type!);
      else {
        if (s.nonCode.size >= REMEMBER_MAX) s.nonCode.clear();
        s.nonCode.add(rid);
      }
    }
  }

  // Updated objects without code: containers whose new code child may be
  // announced only by this update (a slot that is not "children").
  const containers = [...new Set([...changes.updated, ...s.pendingChecks])].filter(r => !known(r) && !isSource(r) && s.nonCode.has(r) && !s.outside.has(r));

  // Places: of moved rows, of candidates, of containers (by parent or ancestors).
  const moved = [...changes.relocated.keys()].filter(known);
  const placeRids = [...new Set([...moved, ...candidates.keys(), ...containers])];
  const needChain = placeRids.filter(rid => {
    const parent = changes.added.get(rid) ?? changes.relocated.get(rid) ?? s.parents.get(rid);
    return live.some((l, li) => placeIn(l, parent, undefined, index[li]) < 0);
  });
  const chains = needChain.length ? await ancestorsOf(client, s, needChain, low) : new Map<string, string[] | null | undefined>();
  const placeOf = (rid: string, li: number) => placeIn(live[li], changes.added.get(rid) ?? changes.relocated.get(rid) ?? s.parents.get(rid), chains.get(rid), index[li]);
  const untracked = new Set<number>();
  const untrack = (li: number) => { untracked.add(li); untrackListing(live[li]); };

  for (const rid of moved) {
    live.forEach((_l, li) => {
      const row = index[li].get(rid);
      if (!row) return;
      const src = placeOf(rid, li);
      if (src >= 0) row.src = src;
      else if (src === OUTSIDE) { live[li].rows = live[li].rows.filter(r => r.rid !== rid); reread.delete(rid); }
      else untrack(li);
    });
  }
  if (moved.length) index = live.map(indexOf);
  for (const [rid, type] of candidates) {
    let outsideAll = true;
    live.forEach((_l, li) => {
      const src = placeOf(rid, li);
      if (src >= 0) { addTo(rid, type, li, src); outsideAll = false; }
      else if (src === UNKNOWN) { untrack(li); outsideAll = false; }
    });
    if (outsideAll) s.outside.add(rid);
  }

  // Code descendants: of updated listed objects, updated sources, and
  // updated containers inside a listed source; with those carried over from
  // earlier polls.
  const checks: Array<{ rid: string; src: Map<number, number> }> = [];
  for (const rid of new Set([...s.pendingChecks, ...changes.updated])) {
    const src = new Map<number, number>();
    live.forEach((l, li) => {
      if (untracked.has(li)) return;
      const row = index[li].get(rid);
      if (row) { src.set(li, row.src); return; }
      const si = sourceIn(l, rid);
      if (si >= 0) { src.set(li, si); return; }
      if (containers.includes(rid)) {
        const p = placeOf(rid, li);
        if (p >= 0) src.set(li, p);
        // A container whose ancestors could not be read (gone, or not
        // readable for this user) holds nothing readable: skipped. One that
        // cannot be placed because a source has no RID: not trusted.
        else if (p === UNKNOWN && chains.get(rid) !== undefined) untrack(li);
      }
    });
    if (src.size) checks.push({ rid, src });
    else if (containers.includes(rid) && live.every((_l, li) => placeOf(rid, li) === OUTSIDE)) {
      if (s.outside.size >= REMEMBER_MAX) s.outside.clear();
      s.outside.add(rid);
    }
  }
  // At most FEED_CHILD_CHECKS a poll; the rest at the next polls (until
  // then a new object outside a "children" slot may be missing for a few
  // polls). More waiting than one poll may name: stale.
  s.pendingChecks.clear();
  for (const c of checks.splice(FEED_CHILD_CHECKS)) s.pendingChecks.add(c.rid);
  if (s.pendingChecks.size > FEED_MAX_RIDS) throw new FeedError(`more than ${FEED_MAX_RIDS} changed objects waiting to be checked`);
  if (checks.length && client.executeEcPairs) {
    const groups = listTypeGroups(map);
    const parts = checks.flatMap(c => groups.map(g => ({ c, code: buildSourceListEc(g, map, CONTEXT_OBJECT) })));
    for (let i = 0; i < parts.length; i += CONTEXT_PER_POST) {
      const chunk = parts.slice(i, i + CONTEXT_PER_POST);
      const results = await client.executeEcPairs(chunk.map(p => ({ code: p.code, objectRid: p.c.rid })), low, 60_000);
      results.forEach((r, k) => {
        const { c } = chunk[k];
        // The post failed: stale. The script failed on this object (one
        // that cannot hold others): nothing under it to add.
        if (!r?.ok || r.log == null) {
          if (r?.errorKind && r.errorKind !== 'server') throw new FeedError('the children of a changed object could not be listed');
          return;
        }
        let rows: ReturnType<typeof parseSourceListLog>['rows'];
        try { rows = parseSourceListLog(r.log).rows; } catch { throw new FeedError('the children of a changed object came back damaged'); }
        for (const d of rows) {
          for (const [li, src] of c.src) {
            if (untracked.has(li)) continue;
            const have = index[li].get(d.rid);
            if (have) { if (have.stamp !== d.stamp || have.len !== d.len) reread.set(d.rid, have.type); continue; }
            addTo(d.rid, d.type, li, src);
          }
        }
      });
    }
  }

  // Read what changed or is new (the constant per-object reader), paced as
  // other low-priority work.
  const items = [...reread].map(([rid, type]) => ({ rid, type }))
    .concat([...additions].filter(([rid]) => !reread.has(rid)).map(([rid, a]) => ({ rid, type: a.type })));
  if (!items.length) return;
  const typeOf = new Map(items.map(it => [it.rid, it.type] as const));
  const failedNew: string[] = [];
  await readObjects(client, items.map(it => ({ rid: it.rid, type: it.type, props: propsOf(it.type, map) })), low, async (got, failed) => {
    for (const [rid, o] of got) {
      const type = typeOf.get(rid) ?? '';
      const len = lengthOf(o);
      s.retries.delete(rid);
      s.rereadTries.delete(rid);
      if (!len) {
        // Gone (no identity row) or no code: off every listing.
        codeReadCache.drop(env, rid);
        s.unsettled.delete(rid);
        for (const l of live) l.rows = l.rows.filter(r => r.rid !== rid);
        continue;
      }
      codeReadCache.put(env, rid, { type, stamp: o.stamp, len, o });
      s.unsettled.add(rid);
      live.forEach((l, li) => {
        const row = l.rows.find(r => r.rid === rid);
        if (row) { row.stamp = o.stamp; row.len = len; return; }
        const src = additions.get(rid)?.src.get(li);
        if (src != null && !untracked.has(li)) l.rows.push({ rid, type, stamp: o.stamp, len, src });
      });
    }
    for (const rid of failed.keys()) {
      // A listed one: the next search reads it again; tried again at the
      // next poll too. A new one: tried again at the next polls.
      for (const l of live) for (const r of l.rows) if (r.rid === rid) r.stamp = '';
      if (additions.has(rid) && !reread.has(rid)) failedNew.push(rid); else s.dirty.add(rid);
    }
  }, new Pacer());
  for (const rid of failedNew) {
    const tries = (s.retries.get(rid) ?? 0) + 1;
    if (tries > FEED_RETRIES) throw new FeedError('a new object could not be read');
    s.retries.set(rid, tries);
  }
  for (const rid of s.dirty) {
    if (!reread.has(rid)) continue;
    const tries = (s.rereadTries.get(rid) ?? 0) + 1;
    if (tries > FEED_RETRIES) throw new FeedError('a changed object could not be read again');
    s.rereadTries.set(rid, tries);
  }
}

/** The feed of `env` as the live search uses it (code-search ServerFeed),
 *  for this connection (`session`) of the profile. */
export function bindFeed(env: string, client: FeedClient, session: string): ServerFeed {
  return {
    // "Search again": poll now (and check the watermark); the search's
    // signal stops only the waiting.
    refresh: signal => {
      const p = pollFeed(env, client, session, signal, true).then(() => feedSettled(env));
      return signal.aborted ? Promise.resolve() : Promise.race([p, new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true }))]);
    },
    settled: signal => (signal.aborted ? Promise.resolve() : Promise.race([feedSettled(env), new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true }))])),
    current: l => feedCurrent(env, l.feed, session),
    begin: signal => beginListing(env, client, session, signal),
    finish: (ticket, listing, ok, put) => finishListing(env, client, ticket, listing, ok, put),
    abandon: () => abandonListing(env),
    unsettled: rid => noteUnsettled(env, rid),
    info: () => feedInfo(env),
  };
}

/** Forget every feed (local data cleared, new credentials), or those of one
 *  profile. Generations are never reused. */
export function clearFeeds(profileId?: string): void {
  for (const env of [...states.keys()]) if (profileId == null || env.startsWith(`${profileId}@`)) { codeReadCache.untrackListings(env); states.delete(env); }
  if (profileId == null) feedCapabilities.clear(); else feedCapabilities.clear(profileId);
}

/** A client was retired (new credentials, profile deleted): its feeds and
 *  kept code go, and nothing is kept for it again (a search still running
 *  for it keeps its reads to itself). */
export function retireClient(client: object): void {
  const suffix = `#${clientKey(client)}`;
  codeReadCache.retire(suffix);
  for (const env of [...states.keys()]) if (env.endsWith(suffix)) { codeReadCache.untrackListings(env); states.delete(env); }
}
onClientRetired(retireClient);

/** Called with a profile whose credentials changed (the opt-in local copy
 *  of its code was read with the old rights: code-index-service clears it). */
const profileForgetters = new Set<(profileId: string) => void>();
export function onProfileForgotten(fn: (profileId: string) => void): void { profileForgetters.add(fn); }

/** New credentials for a profile (another client): its feeds, listings
 *  and kept code go (they were read with the rights of the one before). */
export function forgetProfileSearch(profileId: string): void {
  clearFeeds(profileId);
  codeReadCache.clear(profileId);
  for (const fn of profileForgetters) { try { fn(profileId); } catch { /* the others still run */ } }
}

/** Tests: forget everything. */
export function resetFeeds(): void {
  states.clear();
  holders.clear();
  if (timer) { timers.clear(timer); timer = null; }
  feedCapabilities.clear();
  listener = null;
}

/** Tests and diagnostics: the state of a feed. */
export function feedDebug(env: string): { watermark: string | null; generation: number; stale: string | null; lastOkAt: number | null; pending: number; retries: number } | null {
  const s = states.get(env);
  return s ? { watermark: s.watermark, generation: s.generation, stale: s.stale, lastOkAt: s.lastOkWall, pending: s.pendingListings, retries: s.retries.size } : null;
}
