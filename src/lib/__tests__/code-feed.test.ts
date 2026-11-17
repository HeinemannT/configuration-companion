/**
 * The code search's change feed (code-feed.ts) with the live search
 * (code-search serverSource) on a simulated server:
 *  - the watermark is taken before the first listing post, and an edit made
 *    while the listing and its reads run is not lost;
 *  - each event kind: an update or a move of a listed object reads it again,
 *    a delete drops it, an added object of a code type under a listed
 *    object is read and added, a code object added where it cannot be placed
 *    makes the next search list again, other types are ignored (and asked
 *    for once), an unknown RID is left out;
 *  - the stale rules (more than 200 objects, more than 50 s, a failed poll,
 *    type definitions, pack ids going back) and that the next search then
 *    lists again;
 *  - a typed search on a fresh feed sends nothing; "Search again" polls and
 *    does not list; the 30 s rule without a window;
 *  - polling runs while a window holds its port and stops with the last one;
 *    per server profile;
 *  - the adaptive listing group size and the streaming coverage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listGroups, nextListGroup, resetListTimes, runCodeSearch, serverSource, LIST_GROUP_MAX, type CodeSearchProgress } from '../code-search';
import { searchEnvironment } from '../code-index-service';
import { classifyScript } from '../script-kinds';
import { noteQueueWait } from '../request-class';
import { codeReadCache, LISTING_REUSE_MS, listTypeGroups, READ_ALL_CHARS, READ_CACHE_MAX_CHARS, READ_CACHE_TOTAL_CHARS } from '../code-scope-read';
import {
  bindFeed, feedSettled, setFeedListener, changesOf, clearFeeds, FEED_CHILD_CHECKS, forgetProfileSearch, mergeChanges, FEED_GAP_MS, FEED_MAX_RIDS, FEED_POLL_MS, feedCapabilities, feedCurrent, feedDebug, feedHeld, holdFeed, markFeedDirty, pollFeed, releaseFeed, resetFeeds, setFeedClock, tick, type FeedClient,
} from '../code-feed';
import type { TreeEventAnswer, TreeEventPack } from '../tree-events';
import { server, type SimObject } from './code-search-sim';
import { coverageText, progressText } from '../../codesearch/search-model';

const ORG = { rid: '100', name: 'Group', parent: '' };
const SOURCES = [{ from: 'lookup(100)', root: 'organisation', path: ['100'] }];
const STAMP = 'Nov 1, 2026 10:00:00';
const obj = (rid: string, code: string, more: Partial<SimObject> = {}): SimObject => ({ rid, type: 'ExtendedExpression', id: `id${rid}`, name: `N ${rid}`, stamp: STAMP, root: 'organisation', org: '100', code: { expression: code }, ...more });

let t = Date.now();
let pending: (() => void) | null = null;
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  resetFeeds();
  codeReadCache.clear();
  t = Date.now();
  pending = null;
  setFeedClock(() => t, { set: fn => { pending = fn; return 1 as never; }, clear: () => { pending = null; } });
});
afterEach(() => { resetFeeds(); codeReadCache.clear(); setFeedClock(() => Date.now(), { set: (fn, ms) => setTimeout(fn, ms), clear: x => clearTimeout(x) }); });

/** A simulated server with a change feed: `emit` stores a pack. */
function world(objects: SimObject[], opts: { types?: Record<string, string>; orgs?: Array<{ rid: string; name: string; parent: string }> } = {}) {
  const base = server(objects, { orgs: opts.orgs ?? [ORG, { rid: '999', name: 'Other', parent: '' }], context: true });
  const packs: TreeEventPack[] = [];
  let next = 10n;
  const feedCalls: string[] = [];
  const idCalls: string[][] = [];
  let fail = false;
  const client = Object.assign(base, {
    async readTreeEvents(last: string): Promise<TreeEventAnswer> {
      feedCalls.push(last);
      if (fail) throw new Error('HTTP 500');
      if (last === '-1') return { ok: true, packs: [{ packId: String(next++), propertiesChanged: false, added: [], deleted: [], relocated: [], reordered: [], updated: [] }] };
      return { ok: true, packs: packs.filter(p => BigInt(p.packId) > BigInt(last)) };
    },
    async readTreeIdentities(rids: readonly string[]) {
      idCalls.push([...rids]);
      const out = new Map<string, { type?: string } | null>();
      for (const r of rids) {
        const o = objects.find(x => x.rid === r);
        const type = o?.type ?? opts.types?.[r];
        if (type) out.set(r, { type });
      }
      return out;
    },
  }) as typeof base & FeedClient;
  const emit = (e: Partial<TreeEventPack>) => { packs.push({ packId: String(next++), propertiesChanged: false, added: [], deleted: [], relocated: [], reordered: [], updated: [], ...e }); };
  const listings = () => base.posts.filter(p => p.some(c => /_g := lookup\(100\)/.test(c) && c.includes('~CREV_R~1:L'))).length;
  return { client, emit, feedCalls, idCalls, listings, fail: (v: boolean) => { fail = v; } };
}

const ENV = 'p1@https://bmp.test/';
function hold(env: string, client: FeedClient, session = '1') {
  const key = {};
  holdFeed(key, { resolve: async () => ({ env, client, session }) });
  return key;
}
const search = (client: FeedClient, text: string, more: { fresh?: boolean; env?: string; session?: string; feed?: boolean; onPartial?: (p: CodeSearchProgress) => void; sources?: typeof SOURCES } = {}) => {
  const env = more.env ?? ENV;
  const src = serverSource(client, { sources: more.sources ?? SOURCES, env, now: () => t, ...(more.fresh ? { fresh: true } : {}), ...(more.feed === false ? {} : { feed: bindFeed(env, client, more.session ?? '1') }) });
  return runCodeSearch({ mode: 'text', text }, src, () => {}, more.onPartial ? { onPartial: (_h, p) => more.onPartial!(p) } : {});
};

describe('the change feed', () => {
  it('takes the watermark before the first listing post; an edit made after the read is applied by the next poll, without listing again', async () => {
    const objects = [obj('1', '_a := 1'), obj('2', '_a := 2')];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    // The feed's first call comes before any listing post.
    const order: string[] = [];
    const exec = w.client.executeEcBatch;
    w.client.executeEcBatch = async (codes, s, ms) => { order.push('ec'); const r = await exec(codes, s, ms); return r; };
    const readFeed = w.client.readTreeEvents;
    w.client.readTreeEvents = async last => { order.push(`feed ${last}`); return readFeed(last); };
    const first = await search(w.client, 'needle');
    expect(order[0]).toBe('feed -1');
    expect(first.matchedObjects).toBe(0);
    expect(feedDebug(ENV)).toMatchObject({ watermark: '10', stale: null });
    // An edit after the code was read.
    objects[1] = { ...objects[1], stamp: 'Nov 12, 2026 12:00:01', code: { expression: '_a := needle' } };
    w.emit({ updated: ['2'] });
    t += FEED_POLL_MS;
    await pollFeed(ENV, w.client, '1');
    w.client.posts.length = 0;
    const after = await search(w.client, 'needle');
    expect(after.matchedObjects).toBe(1);
    expect(w.client.posts).toEqual([]);
    expect(after.coverage).toMatchObject({ listingReused: true, feedAt: t });
  });

  it('an edit polled while the listing still runs is applied to the new listing when it is complete', async () => {
    const objects = Array.from({ length: 4 }, (_, i) => obj(String(i + 1), `_a := ${i}`));
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    const exec = w.client.executeEcBatch;
    let done = false;
    w.client.executeEcBatch = async (codes, s, ms) => {
      const r = await exec(codes, s, ms);
      if (!done && codes.some(c => c.includes('~CREV_R~1:L'))) {
        done = true;
        // Listed with the old stamp; edited now; the poll comes in between.
        objects[0] = { ...objects[0], stamp: 'Nov 12, 2026 11:00:00', code: { expression: '_a := needle' } };
        w.emit({ updated: ['1'] });
        await pollFeed(ENV, w.client, '1');
      }
      return r;
    };
    const first = await search(w.client, 'needle');
    expect(first.matchedObjects).toBe(1);
    w.client.posts.length = 0;
    const again = await search(w.client, 'needle');
    expect(again.matchedObjects).toBe(1);
    expect(w.client.posts).toEqual([]);
  });

  it('each event kind: update, delete, move, add under a listed object, add that cannot be placed, other types, unknown RIDs', async () => {
    const objects = [obj('1', '_a := 1'), obj('2', '_a := 2'), obj('3', '_a := 3')];
    const w = world(objects, { types: { 900: 'Kpi' } });
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    // Update of a listed object: read again (and its children listed).
    objects[0] = { ...objects[0], stamp: 'Nov 12, 2026 11:00:00', code: { expression: '_a := changed' } };
    // Delete: dropped. Reorder: nothing read.
    objects.splice(2, 1);
    w.emit({ updated: ['1'], deleted: ['3'], reordered: ['100'] });
    // Added under a listed object (a "children" slot), of a code type.
    objects.push(obj('4', '_a := new', { parent: '2' }));
    w.emit({ added: [{ rid: '4', parent: '2' }] });
    // Other types are asked for once; unknown RIDs are left out.
    w.emit({ updated: ['900', '901'] });
    t += 1_000;
    w.client.posts.length = 0;
    await pollFeed(ENV, w.client, '1');
    expect(w.idCalls.flat().sort()).toEqual(['4', '900', '901']);
    let r = await search(w.client, '_a');
    expect(r.matchedObjects).toBe(3);
    expect(w.listings()).toBe(0);
    const typed = await search(w.client, 'changed');
    expect(typed.matchedObjects).toBe(1);
    // A non-code RID is not asked for again.
    w.emit({ updated: ['900'] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    expect(w.idCalls.flat().filter(x => x === '900')).toHaveLength(1);
    // A move to another listed parent: read again, still listed.
    objects[0] = { ...objects[0], parent: '2' };
    w.emit({ relocated: [{ rid: '1', parent: '2', oldParent: '100' }] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    r = await search(w.client, '_a');
    expect(r.matchedObjects).toBe(3);
    expect(w.listings()).toBe(0);
    // A new code object outside every listed source: ignored, no listing.
    objects.push(obj('5', '_a := elsewhere', { org: '999' }));
    w.emit({ added: [{ rid: '5', parent: '999' }] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    w.client.posts.length = 0;
    r = await search(w.client, '_a');
    expect(w.listings()).toBe(0);
    expect(r.matchedObjects).toBe(3);
  });

  it('an object added outside the "children" slot (announced as its parent\'s update) is found by listing the parent\'s code descendants', async () => {
    const objects = [obj('1', '_a := table')];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    objects.push(obj('2', '_a := column', { parent: '1' }));
    w.emit({ updated: ['1'] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    w.client.posts.length = 0;
    const r = await search(w.client, 'column');
    expect(r.matchedObjects).toBe(1);
    expect(w.client.posts).toEqual([]);
  });

  it('stale rules: more than 200 objects, type definitions, pack ids going back, a failed poll, more than 50 s; then the next search lists again', async () => {
    const cases: Array<[string, (w: ReturnType<typeof world>) => void | number]> = [
      ['many', w => w.emit({ updated: Array.from({ length: FEED_MAX_RIDS + 1 }, (_, i) => String(5000 + i)) })],
      ['props', w => w.emit({ propertiesChanged: true })],
      ['back', w => { (w.client as { readTreeEvents: FeedClient['readTreeEvents'] }).readTreeEvents = async () => ({ ok: true, packs: [{ packId: '3', propertiesChanged: false, added: [], deleted: [], relocated: [], reordered: [], updated: [] }] }); }],
      ['failed', w => w.fail(true)],
      ['gap', () => FEED_GAP_MS + 1],
    ];
    for (const [name, make] of cases) {
      resetFeeds();
      codeReadCache.clear();
      const objects = [obj('1', '_a := 1')];
      const w = world(objects);
      hold(ENV, w.client);
      await flush();
      await search(w.client, '_a');
      const gen = feedDebug(ENV)!.generation;
      expect(feedCurrent(ENV, gen)).toBe(true);
      const wait = make(w);
      t += typeof wait === 'number' ? wait : 1_000;
      await pollFeed(ENV, w.client, '1');
      expect(feedDebug(ENV)!.stale, name).not.toBeNull();
      expect(feedCurrent(ENV, gen), name).toBe(false);
      w.fail(false);
      w.client.posts.length = 0;
      // Past the 30 s fallback too.
      t += LISTING_REUSE_MS;
      await search(w.client, '_a');
      expect(w.listings(), name).toBeGreaterThan(0);
    }
  });

  it('a typed search on a fresh feed sends nothing; "Search again" polls and does not list; without a window the 30 s rule holds', async () => {
    const objects = [obj('1', '_a := 1'), obj('2', '_a := 2')];
    const w = world(objects);
    const key = hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    w.client.posts.length = 0;
    w.feedCalls.length = 0;
    // Long past the 30 s rule, but polled in time.
    for (let i = 0; i < 4; i++) { t += FEED_POLL_MS; await pollFeed(ENV, w.client, '1'); }
    w.feedCalls.length = 0;
    const typed = await search(w.client, '_a := 2');
    expect(typed.matchedObjects).toBe(1);
    expect(w.client.posts).toEqual([]);
    expect(w.feedCalls).toEqual([]);
    // Search again: one poll, no listing.
    const again = await search(w.client, '_a', { fresh: true });
    // The poll, and the watermark cross-check "Search again" makes.
    expect(w.feedCalls).toEqual(['10', '-1']);
    expect(w.listings()).toBe(0);
    expect(again.coverage).toMatchObject({ listingReused: true, feedAt: t });
    // The window closes: the feed no longer keeps the listing; past 30 s a
    // search lists again.
    releaseFeed(key);
    expect(feedHeld(ENV)).toBe(false);
    t += LISTING_REUSE_MS;
    await search(w.client, '_a');
    expect(w.listings()).toBeGreaterThan(0);
  });

  it('a save through Companion keeps the listing the feed follows: the object is read again, then the poll refreshes its row', async () => {
    const objects = [obj('1', '_a := 1'), obj('2', '_a := 2')];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    objects[1] = { ...objects[1], stamp: 'Nov 12, 2026 11:30:00', code: { expression: '_a := saved' } };
    expect(codeReadCache.forget(ENV, '2')).toBe(true);
    markFeedDirty(ENV, '2');
    w.client.posts.length = 0;
    const r = await search(w.client, 'saved');
    expect(r.matchedObjects).toBe(1);
    expect(w.listings()).toBe(0);
    expect(w.client.posts.flat().filter(c => c.includes('"~CREV_R~1:I"'))).toHaveLength(1);
    t += FEED_POLL_MS;
    await pollFeed(ENV, w.client, '1');
    w.client.posts.length = 0;
    expect((await search(w.client, 'saved')).matchedObjects).toBe(1);
    expect(w.client.posts).toEqual([]);
  });

  it('polls on a timer while a window holds its port and stops when the last one closes; per server profile', async () => {
    const a = world([obj('1', '_a := 1')]);
    const b = world([obj('1', '_a := 1')]);
    const ENV_B = 'p2@https://bmp.test/';
    const ka = hold(ENV, a.client);
    const kb = hold(ENV_B, b.client);
    await flush();
    await search(a.client, '_a');
    await search(b.client, '_a', { env: ENV_B });
    a.feedCalls.length = 0;
    b.feedCalls.length = 0;
    expect(pending).not.toBeNull();
    t += FEED_POLL_MS;
    pending!();
    await flush(); await flush();
    expect(a.feedCalls).toEqual(['10']);
    expect(b.feedCalls).toEqual(['10']);
    // An edit on profile A's server reads nothing on B's.
    a.emit({ updated: ['1'] });
    b.client.posts.length = 0;
    t += FEED_POLL_MS;
    await tick();
    expect(b.client.posts).toEqual([]);
    releaseFeed(ka);
    a.feedCalls.length = 0;
    t += FEED_POLL_MS;
    await tick();
    expect(a.feedCalls).toEqual([]);
    releaseFeed(kb);
    expect(pending).toBeNull();
  });

  it('a reconnect (another session) drops watermark and listing; an unsupported server keeps the 30 s rule', async () => {
    const w = world([obj('1', '_a := 1')]);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    w.client.posts.length = 0;
    t += 1_000;
    await search(w.client, '_a', { session: '2' });
    expect(w.listings()).toBeGreaterThan(0);
    expect(feedDebug(ENV)?.watermark).toBe('11');
    // Unsupported: no watermark, the listing is kept 30 s only.
    resetFeeds();
    codeReadCache.clear();
    const u = world([obj('1', '_a := 1')]);
    (u.client as { readTreeEvents: FeedClient['readTreeEvents'] }).readTreeEvents = async () => ({ ok: false, message: 'local class incompatible' });
    hold(ENV, u.client);
    await flush();
    await search(u.client, '_a');
    expect(feedCapabilities.get('p1', '1', 'feed')).toBe('unsupported');
    u.client.posts.length = 0;
    t += 10_000;
    await search(u.client, '_a');
    expect(u.listings()).toBe(0);
    t += LISTING_REUSE_MS;
    await search(u.client, '_a');
    expect(u.listings()).toBeGreaterThan(0);
  });
});

describe('listing in small steps', () => {
  it('the group size grows while posts are fast, falls back to one after a slow post, never above six', () => {
    expect(nextListGroup(1, 100)).toBe(2);
    expect(nextListGroup(2, 100)).toBe(4);
    expect(nextListGroup(4, 100)).toBe(LIST_GROUP_MAX);
    expect(nextListGroup(6, 100)).toBe(LIST_GROUP_MAX);
    // About 2 s per post at the last post's time per command.
    expect(nextListGroup(4, 1_600)).toBe(5);
    expect(nextListGroup(4, 4_000)).toBe(2);
    expect(nextListGroup(1, 3_000)).toBe(1);
    expect(nextListGroup(6, 5_001)).toBe(1);
  });

  it('the listing goes one command per post first, then in growing groups; progress counts objects and sources', async () => {
    const objects = Array.from({ length: 30 }, (_, i) => obj(String(i + 1), `_a := ${i}`, { org: String(100 + (i % 6)) }));
    const orgs = Array.from({ length: 6 }, (_, i) => ({ rid: String(100 + i), name: `O${i}`, parent: '' }));
    const client = server(objects, { orgs, context: true });
    // The texts as sent (the object travels as the command's context).
    const raw: string[] = [];
    const pairs = client.executeEcPairs!.bind(client);
    const each = client.executeEcEach!.bind(client);
    client.executeEcPairs = async (p, sg, ms) => { raw.push(...p.map(x => x.code)); return pairs(p, sg, ms); };
    client.executeEcEach = async (code, rids, sg, ms) => { raw.push(code); return each(code, rids, sg, ms); };
    const sources = orgs.map(g => ({ from: `lookup(${g.rid})`, root: 'organisation', path: [g.rid] }));
    const sizes: number[] = [];
    const exec = client.executeEcBatch;
    // The first posts take 300 ms per command.
    let clock = 0;
    client.executeEcBatch = async (codes, s, ms) => { if (codes.some(c => c.includes('~CREV_R~1:L'))) { sizes.push(codes.length); clock += 300 * codes.length; } return exec(codes, s, ms); };
    const seen: CodeSearchProgress[] = [];
    await runCodeSearch({ mode: 'text', text: '_a' }, serverSource(client, { sources, env: 'steps', now: () => clock }), () => {}, { onPartial: (_h, p) => seen.push({ ...p }) });
    expect(sizes[0]).toBe(1);
    expect(sizes[1]).toBe(2);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(LIST_GROUP_MAX);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(6 * listTypeGroups().length);
    const listing = seen.filter(p => p.phase === 'scan' && p.listed != null);
    expect(listing.at(-1)).toMatchObject({ listed: 30, sources: 6, source: 6 });
    expect(progressText(listing[1])).toMatch(/^Listing code on the server: \d+ objects? so far, source \d of 6…$/);
  });

  it('the wait in the lane (the load governor holding a post) does not shrink the groups: they follow the server time', async () => {
    resetListTimes();
    const objects = Array.from({ length: 30 }, (_, i) => obj(String(i + 1), `_a := ${i}`, { org: String(100 + (i % 6)) }));
    const orgs = Array.from({ length: 6 }, (_, i) => ({ rid: String(100 + i), name: `O${i}`, parent: '' }));
    const client = server(objects, { orgs, context: true });
    const sources = orgs.map(g => ({ from: `lookup(${g.rid})`, root: 'organisation', path: [g.rid] }));
    const sizes: number[] = [];
    const pairs = client.executeEcPairs!.bind(client);
    let clock = 0;
    // Every listing post is held 1.5 s by the governor, then answers in 50 ms per command.
    client.executeEcPairs = async (p, s, ms) => {
      if (p.some(x => x.code.includes('~CREV_R~1:L'))) { sizes.push(p.length); clock += 1_500 + 50 * p.length; noteQueueWait(s, 1_500); }
      return pairs(p, s, ms);
    };
    await runCodeSearch({ mode: 'text', text: '_a' }, serverSource(client, { sources, env: 'held', now: () => clock }), () => {});
    // Held time counted as server time (1.55 s for one command) kept every post single.
    expect(sizes.slice(0, 2)).toEqual([1, 2]);
    expect(sizes.length).toBeLessThan(6 * listTypeGroups().length);
  });
});

describe('results while reading', () => {
  it('kept code is searched first; the coverage counts what is searched so far, then the final sentence', async () => {
    const objects = Array.from({ length: 12 }, (_, i) => obj(String(i + 1), `_a := ${i}`));
    const client = server(objects, { orgs: [ORG], context: true });
    // Six are kept from an earlier search.
    for (const o of objects.slice(0, 6)) codeReadCache.put('stream', o.rid, { type: o.type, stamp: o.stamp, len: o.code.expression.length, o: { rid: o.rid, businessId: o.id, name: o.name, parent: '', grandparent: '', stamp: o.stamp, code: o.code } });
    const seen: CodeSearchProgress[] = [];
    let shown = 0;
    const out = await runCodeSearch({ mode: 'text', text: '_a' }, serverSource(client, { sources: SOURCES, env: 'stream' }), () => {}, { onPartial: (h, p) => { shown += h.length; seen.push({ ...p }); } });
    const reading = seen.filter(p => p.phase === 'read');
    expect(reading[0]).toMatchObject({ total: 12, searched: 6 });
    expect(reading.at(-1)).toMatchObject({ searched: 12 });
    expect(shown).toBe(12);
    expect(progressText(reading[0])).toBe('Reading code: 6 of 12 objects (86 characters)…');
    expect(progressText({ ...reading[0], chars: 4_336_604, total: 12_456, searched: 6_200 })).toBe('Reading code: 6,200 of 12,456 objects (4.3 M characters)…');
    expect(coverageText(out.coverage, Date.now(), undefined, 400)).toBe('Searched 12 objects in 0.4 s. 6 more objects read from the server; the rest was kept from the last search.');
  });

  it('footer: "Up to date as of 8 s ago." on a fresh feed, "Checked for changes" without it, and the stale sentence', () => {
    const c = { source: 'server' as const, searched: 12_456, total: 12_456, complete: true, read: 0, listingReused: true, checkedAt: 0, feedAt: 92_000 };
    expect(coverageText(c, 100_000, undefined, 400)).toBe('Searched 12,456 objects in 0.4 s. Up to date as of 8 s ago.');
    // A newer poll told by the worker.
    expect(coverageText(c, 100_000, undefined, 400, { health: 'fresh', at: 99_000 })).toBe('Searched 12,456 objects in 0.4 s. Up to date as of 1 s ago.');
    expect(coverageText(c, 100_000, undefined, 400, { health: 'stale', at: 92_000 })).toBe('Searched 12,456 objects in 0.4 s. The next search checks the server for changes again.');
    const { feedAt: _f, ...noFeed } = c;
    expect(coverageText({ ...noFeed, checkedAt: 88_000 }, 100_000, undefined, 400)).toBe('Searched 12,456 objects in 0.4 s. Checked for changes 12 s ago.');
  });
});

describe('the change feed: review fixes', () => {
  const readOf = (rid: string) => (c: string) => c.includes(`_o := lookup(${rid})`) && c.includes('"~CREV_R~1:I"');

  it('a poll that lands while the listing\'s missed changes are applied is not lost (atomic hand-over)', async () => {
    const objects = [obj('1', '_a := 1'), obj('2', '_a := 2')];
    const w = world(objects);
    // Read and kept once, without a window (no feed): the code of both
    // objects is in memory before anything is edited.
    await search(w.client, '_a');
    hold(ENV, w.client);
    await flush();
    // Past the 30 s rule: the next search lists again, with a watermark.
    t += LISTING_REUSE_MS + 1;
    const exec = w.client.executeEcBatch;
    let listed = false;
    let replayed = false;
    w.client.executeEcBatch = async (codes, sg, ms) => {
      const r = await exec(codes, sg, ms);
      if (!listed && codes.some(c => c.includes('~CREV_R~1:L'))) {
        listed = true;
        // Listed with the old stamps; object 1 edited now, its poll logged.
        objects[0] = { ...objects[0], stamp: 'Nov 12, 2026 11:00:00', code: { expression: '_a := first' } };
        w.emit({ updated: ['1'] });
        await pollFeed(ENV, w.client, '1');
      } else if (listed && !replayed && codes.some(readOf('1'))) {
        // The hand-over reads object 1 again: object 2 (kept with its old
        // stamp) is edited now and its poll lands during the hand-over.
        replayed = true;
        objects[1] = { ...objects[1], stamp: 'Nov 12, 2026 11:00:01', code: { expression: '_a := second' } };
        w.emit({ updated: ['2'] });
        t += 1;
        void pollFeed(ENV, w.client, '1');
        await flush(); await flush();
      }
      return r;
    };
    await search(w.client, '_a');
    expect(replayed).toBe(true);
    await feedSettled(ENV);
    w.client.posts.length = 0;
    const r = await search(w.client, 'second');
    expect(r.matchedObjects).toBe(1);
    expect(w.client.posts).toEqual([]);
  });

  it('an abort after the poll\'s answer arrived: every changed object of that poll is still applied', async () => {
    const objects = [obj('1', '_a := 1'), obj('2', '_a := 2')];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    objects[0] = { ...objects[0], stamp: 'Nov 12, 2026 11:00:00', code: { expression: '_a := one edited' } };
    objects[1] = { ...objects[1], stamp: 'Nov 12, 2026 11:00:00', code: { expression: '_a := two edited' } };
    w.emit({ updated: ['1', '2'] });
    const stop = new AbortController();
    const read = w.client.readTreeEvents;
    // The search that asked ("Search again") stops while the answer comes.
    (w.client as { readTreeEvents: FeedClient['readTreeEvents'] }).readTreeEvents = async (last, sg, ms) => { const a = await read(last, sg, ms); if (last !== '-1') stop.abort(); return a; };
    // ... and again between the two objects' reads.
    const exec = w.client.executeEcBatch;
    w.client.executeEcBatch = async (codes, sg, ms) => { const r = await exec(codes, sg, ms); if (codes.some(readOf('1'))) stop.abort(); return r; };
    t += 1_000;
    await pollFeed(ENV, w.client, '1', stop.signal);
    await feedSettled(ENV);
    w.client.executeEcBatch = exec;
    const s = feedDebug(ENV)!;
    w.client.posts.length = 0;
    const one = await search(w.client, 'one edited');
    const two = await search(w.client, 'two edited');
    // Applied (or the feed says stale and the search lists again): never fresh with an edit missing.
    if (s.stale == null) {
      expect([one.matchedObjects, two.matchedObjects]).toEqual([1, 1]);
      expect(w.client.posts).toEqual([]);
    } else expect(w.listings()).toBeGreaterThan(0);
    expect(s.stale).toBeNull();
  });

  it('the 50 s rule counts from the answer: a poll that waited in the queue comes back late and is not trusted; a wall clock going back changes nothing', async () => {
    const w = world([obj('1', '_a := 1')]);
    let wall = t;
    let mono = 0;
    setFeedClock(() => wall, { set: fn => { pending = fn; return 1 as never; }, clear: () => { pending = null; } }, () => mono);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    // The wall clock jumps back an hour; the monotonic one goes on.
    wall -= 3_600_000;
    mono += 10_000;
    await pollFeed(ENV, w.client, '1');
    expect(feedDebug(ENV)!.stale).toBeNull();
    const read = w.client.readTreeEvents;
    (w.client as { readTreeEvents: FeedClient['readTreeEvents'] }).readTreeEvents = async (last, sg, ms) => { mono += FEED_GAP_MS + 1; return read(last, sg, ms); };
    mono += 1_000;
    await pollFeed(ENV, w.client, '1');
    expect(feedDebug(ENV)!.stale).toMatch(/came back more than 50 s/);
  });

  it('places a new code object by its ancestors: several code-less containers below a listed source; outside every source it is ignored; a source without RID cannot place it', async () => {
    const objects = [
      obj('1', '_a := 1'),
      { ...obj('50', ''), type: 'Scorecard', code: {} },
      { ...obj('51', '', { parent: '50' }), type: 'InputSet', code: {} },
      { ...obj('52', '', { parent: '51' }), type: 'ButtonGroup', code: {} },
    ];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    // Added three levels below the source, under containers without code.
    objects.push(obj('60', '_a := deep', { parent: '52' }));
    w.emit({ added: [{ rid: '60', parent: '52' }] });
    // Code written for the first time into an object the listing did not hold.
    objects.push(obj('61', '', { parent: '51' }));
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    objects[objects.length - 1] = obj('61', '_a := first code', { parent: '51', stamp: 'Nov 12, 2026 11:00:00' });
    w.emit({ updated: ['61'] });
    // Outside every listed source: ignored and remembered.
    objects.push(obj('70', '_a := other org', { org: '999' }));
    w.emit({ added: [{ rid: '70', parent: '999' }] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    w.emit({ updated: ['70'] });
    t += 1_000;
    const ids = w.idCalls.flat().length;
    await pollFeed(ENV, w.client, '1');
    expect(w.idCalls.flat().length).toBe(ids);
    w.client.posts.length = 0;
    const r = await search(w.client, '_a');
    expect(r.matchedObjects).toBe(3);
    expect(w.listings()).toBe(0);
    expect(feedDebug(ENV)!.stale).toBeNull();
  });

  it('a source without a known RID cannot place a new object: that listing is not used again', async () => {
    const objects = [obj('1', '_a := 1', { root: 'portal', org: undefined })];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    const sources = [{ from: 'root.portal', root: 'portal' }] as unknown as typeof SOURCES;
    objects.push({ ...obj('40', '', { root: 'portal', org: undefined }), type: 'Scorecard', code: {} });
    await search(w.client, '_a', { sources });
    // Under a container without code: its ancestors reach no listed RID.
    objects.push(obj('2', '_a := 2', { root: 'portal', org: undefined, parent: '40' }));
    w.emit({ added: [{ rid: '2', parent: '40' }] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    w.client.posts.length = 0;
    const r = await search(w.client, '_a', { sources });
    expect(w.client.posts.flat().some(c => c.includes('_g := root.portal'))).toBe(true);
    expect(r.matchedObjects).toBe(2);
  });

  it('a new object whose read failed is read again at the next poll', async () => {
    const objects = [obj('1', '_a := 1')];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    objects.push(obj('2', '_a := late', { parent: '1' }));
    w.emit({ added: [{ rid: '2', parent: '1' }] });
    const exec = w.client.executeEcBatch;
    let fails = 1;
    w.client.executeEcBatch = async (codes, sg, ms) => (fails && codes.some(readOf('2')) ? (fails--, codes.map(() => ({ ok: false, error: 'cannot be read now', errorKind: 'server' as const }))) : exec(codes, sg, ms));
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    expect(feedDebug(ENV)!.retries).toBe(1);
    t += FEED_POLL_MS;
    await pollFeed(ENV, w.client, '1');
    expect(feedDebug(ENV)!.retries).toBe(0);
    w.client.posts.length = 0;
    expect((await search(w.client, 'late')).matchedObjects).toBe(1);
    expect(w.client.posts).toEqual([]);
  });

  it('an update of a container without code, or of a source, lists the code below it (children slot); more than 20 at once: stale with its reason', async () => {
    const objects = [obj('1', '_a := 1'), { ...obj('50', ''), type: 'Scorecard', code: {} }];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    objects.push(obj('2', '_a := slot', { parent: '50' }));
    w.emit({ updated: ['50'] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    objects.push(obj('3', '_a := under source'));
    w.emit({ updated: ['100'] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    w.client.posts.length = 0;
    expect((await search(w.client, '_a')).matchedObjects).toBe(3);
    expect(w.listings()).toBe(0);
    // A container stays a container: a later update is checked again.
    objects.push(obj('4', '_a := again', { parent: '50' }));
    w.emit({ updated: ['50'] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1');
    expect((await search(w.client, 'again')).matchedObjects).toBe(1);
    // More than 20 at once (a small package import): 20 now, the rest at
    // the next polls, no listing. A child added under the 25th shows after.
    const many = Array.from({ length: 25 }, (_, i) => obj(String(200 + i), `_a := ${i}`));
    objects.push(...many);
    resetFeeds(); codeReadCache.clear();
    const v = world(objects);
    hold(ENV, v.client);
    await flush();
    await search(v.client, '_a');
    objects.push(obj('300', '_a := under the last', { parent: '224' }));
    v.emit({ updated: many.map(o => o.rid) });
    t += 1_000;
    await pollFeed(ENV, v.client, '1');
    expect(feedDebug(ENV)!.stale).toBeNull();
    t += FEED_POLL_MS;
    await pollFeed(ENV, v.client, '1');
    v.client.posts.length = 0;
    expect((await search(v.client, 'under the last')).matchedObjects).toBe(1);
    expect(v.listings()).toBe(0);
    // More waiting than one poll may name: stale with that reason.
    const lots = Array.from({ length: 2 * FEED_MAX_RIDS }, (_, i) => obj(String(5_000 + i), `_b := ${i}`));
    objects.push(...lots);
    resetFeeds(); codeReadCache.clear();
    const u = world(objects);
    hold(ENV, u.client);
    await flush();
    await search(u.client, '_b');
    u.emit({ updated: lots.slice(0, FEED_MAX_RIDS).map(o => o.rid) });
    t += 1_000;
    await pollFeed(ENV, u.client, '1');
    u.emit({ updated: lots.slice(FEED_MAX_RIDS).map(o => o.rid) });
    t += 1_000;
    await pollFeed(ENV, u.client, '1');
    expect(feedDebug(ENV)!.stale).toBe(`more than ${FEED_MAX_RIDS} changed objects waiting to be checked`);
    expect(FEED_CHILD_CHECKS).toBe(20);
  });

  it('new credentials (another client of the same profile and URL): nothing kept before is served', async () => {
    const objects = [obj('1', '_a := secret')];
    const a = world(objects);
    const b = world(objects);
    const ctxOf = (client: unknown) => ({ client: Object.assign(client as object, { serverUrl: 'https://bmp.test/' }), settings: { activeProfileId: 'p1' } }) as never;
    const envA = searchEnvironment(ctxOf(a.client))!;
    const envB = searchEnvironment(ctxOf(b.client))!;
    expect(envA).not.toBe(envB);
    expect(envA.startsWith('p1@')).toBe(true);
    hold(envA, a.client);
    hold(envB, b.client);
    await flush();
    await search(a.client, '_a', { env: envA });
    const r = await search(b.client, '_a', { env: envB });
    expect(b.listings()).toBeGreaterThan(0);
    expect(r.coverage.read).toBe(1);
    // And the old one's state goes with the profile's new credentials.
    forgetProfileSearch('p1');
    expect(feedDebug(envA)).toBeNull();
  });

  it('per command times: a command that took over 2 s goes alone; after a post over 5 s, single posts until two fast ones', () => {
    resetListTimes();
    const cmds = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}` }));
    let plan = listGroups(cmds);
    const sizes: number[] = [];
    const time = (g: readonly { key: string }[]) => g.reduce((n, c) => n + (c.key === 'k5' ? 3_000 : 100), 0);
    for (let g = plan.take(); g.length; g = plan.take()) { sizes.push(g.length); plan.done(g, g.length === 1 ? time(g) : time(g)); }
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(12);
    // Second listing: k5 is known to be slow and goes alone.
    plan = listGroups(cmds);
    const groups: string[][] = [];
    for (let g = plan.take(); g.length; g = plan.take()) { groups.push(g.map(c => c.key)); plan.done(g, time(g)); }
    expect(groups.find(g => g.includes('k5'))).toEqual(['k5']);
    // A post over 5 s: single posts until two fast ones in a row.
    resetListTimes();
    plan = listGroups(cmds);
    const seen: number[] = [];
    const times = [100, 100, 6_000, 100, 100, 100, 100];
    for (let i = 0, g = plan.take(); g.length; g = plan.take(), i++) { seen.push(g.length); plan.done(g, times[i] ?? 100); }
    expect(seen.slice(0, 6)).toEqual([1, 2, 4, 1, 1, 2]);
  });

  it('the feed going stale during the read keeps no young code', async () => {
    const objects = [obj('1', '_a := young', { stamp: 'Nov 12, 2026 11:59:59' }), obj('2', '_a := old')];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    const exec = w.client.executeEcBatch;
    w.client.executeEcBatch = async (codes, sg, ms) => { if (codes.some(c => c.includes('"~CREV_R~1:I"'))) t += FEED_GAP_MS + 1; return exec(codes, sg, ms); };
    await search(w.client, '_a');
    expect(codeReadCache.get(ENV, '1', 'Nov 12, 2026 11:59:59', '_a := young'.length)).toBeUndefined();
  });

  it('a fresh watermark below the stored one (a server restart) makes the feed stale', async () => {
    const w = world([obj('1', '_a := 1')]);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    const read = w.client.readTreeEvents;
    (w.client as { readTreeEvents: FeedClient['readTreeEvents'] }).readTreeEvents = async (last, sg, ms) => (last === '-1' ? { ok: true, packs: [{ packId: '2', propertiesChanged: false, added: [], deleted: [], relocated: [], reordered: [], updated: [] }] } : read(last, sg, ms));
    t += 1_000;
    const reasons: string[] = [];
    setFeedListener((_e, info) => { if (info.reason) reasons.push(info.reason); });
    w.client.posts.length = 0;
    await search(w.client, '_a', { fresh: true });
    expect(reasons.some(r => /counter went back/.test(r))).toBe(true);
    // Not trusted across it: listed again under the new watermark.
    expect(w.listings()).toBeGreaterThan(0);
    expect(feedDebug(ENV)).toMatchObject({ watermark: '2', stale: null });
  });

  it('events in pack order: a delete then a re-add of the same object ends added; merged polls too', () => {
    const p = (id: string, e: Partial<TreeEventPack>): TreeEventPack => ({ packId: id, propertiesChanged: false, added: [], deleted: [], relocated: [], reordered: [], updated: [], ...e });
    const { changes } = changesOf([p('12', { added: [{ rid: '5', parent: '1' }] }), p('11', { deleted: ['5'] })]);
    expect([...changes.added.keys()]).toEqual(['5']);
    expect(changes.deleted.size).toBe(0);
    const merged = mergeChanges(changesOf([p('1', { updated: ['5'] })]).changes, changesOf([p('2', { deleted: ['5'] })]).changes);
    expect([...merged.deleted]).toEqual(['5']);
    expect(merged.updated.size).toBe(0);
  });

  it('a window opened before its profile was connected holds the feed once connected; opening a window polls at once', async () => {
    const w = world([obj('1', '_a := 1')]);
    let connected = false;
    holdFeed({}, { resolve: async () => (connected ? { env: ENV, client: w.client, session: '1' } : null) });
    await flush();
    connected = true;
    await search(w.client, '_a');
    expect(feedDebug(ENV)?.watermark).toBe('10');
    w.feedCalls.length = 0;
    t += 1_000;
    hold(ENV, w.client);
    await flush(); await flush();
    expect(w.feedCalls[0]).toBe('10');
  });

  it('generations are never reused after the feeds are cleared', async () => {
    const w = world([obj('1', '_a := 1')]);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    const g1 = feedDebug(ENV)!.generation;
    clearFeeds();
    codeReadCache.clear();
    await search(w.client, '_a');
    expect(feedDebug(ENV)!.generation).toBeGreaterThan(g1);
  });
});

describe('a large server whose code fits the cap', () => {
  it('12,456 objects and 4.34 M characters in 12 sources: read in full once, no varying text; a typed repeat and a pattern cost no post', async () => {
    const orgs = Array.from({ length: 12 }, (_, i) => ({ rid: String(100 + i), name: `O${i}`, parent: '' }));
    const per = Math.floor(4_340_000 / 12_456);
    const objects: SimObject[] = Array.from({ length: 12_456 }, (_, i) => obj(String(10_000 + i), `_v := ${i}\n${'x'.repeat(per - String(i).length - 7)}`, { org: String(100 + (i % 12)) }));
    const client = server(objects, { orgs, context: true });
    // The texts as sent (the object travels as the command's context).
    const raw: string[] = [];
    const pairs = client.executeEcPairs!.bind(client);
    const each = client.executeEcEach!.bind(client);
    client.executeEcPairs = async (p, sg, ms) => { raw.push(...p.map(x => x.code)); return pairs(p, sg, ms); };
    client.executeEcEach = async (code, rids, sg, ms) => { raw.push(code); return each(code, rids, sg, ms); };
    const sources = orgs.map(g => ({ from: `lookup(${g.rid})`, root: 'organisation', path: [g.rid] }));
    const src = () => serverSource(client, { sources, env: 'big', now: () => t });
    const first = await runCodeSearch({ mode: 'text', text: '_v := 12455' }, src(), () => {});
    expect(first.matchedObjects).toBe(1);
    expect(first.coverage).toMatchObject({ total: 12_456, searched: 12_456, read: 12_456 });
    expect(first.coverage.narrowed).toBeUndefined();
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.filter(c => classifyScript(c).kind !== 'constant')).toEqual([]);
    // Bulk reads: a handful of posts for the whole code.
    expect(client.posts.filter(p => p.some(c => /^_g := /m.test(c) && c.includes('"~CREV_R~1:I"'))).length).toBeLessThanOrEqual(6);
    client.posts.length = 0;
    t += 5_000;
    expect((await runCodeSearch({ mode: 'text', text: '_v := 7' }, src(), () => {})).matchedObjects).toBeGreaterThan(1);
    const pattern = await runCodeSearch({ mode: 'text', text: '_v := 1245[45]', regex: true }, src(), () => {});
    expect(pattern.matchedObjects).toBe(2);
    expect(client.posts).toEqual([]);
  });
});

describe('the change feed: third round', () => {
  const readOf = (rid: string) => (c: string) => c.includes(`_o := lookup(${rid})`) && c.includes('"~CREV_R~1:I"');

  it('the 50 s rule takes the larger of the monotonic and the wall-clock gap (a machine that slept)', async () => {
    const w = world([obj('1', '_a := 1')]);
    let wall = t;
    let m = 0;
    setFeedClock(() => wall, { set: fn => { pending = fn; return 1 as never; }, clear: () => { pending = null; } }, () => m);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    wall += FEED_GAP_MS + 10_000; // asleep: the monotonic clock did not move
    m += 1_000;
    await pollFeed(ENV, w.client, '1');
    expect(feedDebug(ENV)!.stale).toMatch(/more than 50 s/);
  });

  it('a long application does not hold the next poll: polls stay on time while reads queue', async () => {
    const objects = [obj('1', '_a := 1')];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    let release = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const exec = w.client.executeEcBatch;
    w.client.executeEcBatch = async (codes, sg, ms) => { if (codes.some(readOf('1'))) await gate; return exec(codes, sg, ms); };
    objects[0] = { ...objects[0], stamp: 'Nov 12, 2026 11:00:00', code: { expression: '_a := slow' } };
    w.emit({ updated: ['1'] });
    w.feedCalls.length = 0;
    t += FEED_POLL_MS;
    const first = pollFeed(ENV, w.client, '1');
    await flush(); await flush();
    t += FEED_POLL_MS;
    void pollFeed(ENV, w.client, '1');
    await flush();
    expect(w.feedCalls.filter(c => c !== '-1')).toHaveLength(2);
    release();
    await first;
    await feedSettled(ENV);
    expect(feedDebug(ENV)!.stale).toBeNull();
    expect((await search(w.client, 'slow')).matchedObjects).toBe(1);
  });

  it('a listed object that cannot be read again is tried a few polls, then the feed goes stale', async () => {
    const objects = [obj('1', '_a := 1')];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    const exec = w.client.executeEcBatch;
    w.client.executeEcBatch = async (codes, sg, ms) => (codes.some(readOf('1')) ? codes.map(() => ({ ok: false, error: 'no rights now', errorKind: 'server' as const })) : exec(codes, sg, ms));
    w.emit({ updated: ['1'] });
    for (let i = 0; i < 6 && !feedDebug(ENV)!.stale; i++) { t += FEED_POLL_MS; await pollFeed(ENV, w.client, '1'); await feedSettled(ENV); }
    expect(feedDebug(ENV)!.stale).toBe('a changed object could not be read again');
  });

  it('a cut ancestor chain cannot place an object: that place is listed again; a moved folder forgets what was placed through it', async () => {
    const objects = [obj('1', '_a := 1'), { ...obj('50', '', { org: '999' }), type: 'Scorecard', code: {} }];
    const w = world(objects);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    // Under a folder outside every listed source: ignored and remembered.
    objects.push(obj('60', '_a := in folder', { parent: '50', org: '999' }));
    w.emit({ added: [{ rid: '60', parent: '50' }] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1'); await feedSettled(ENV);
    // The folder moves into the listed source; a new object below it is
    // placed from the new chain, not judged outside from the old one.
    objects[1] = { ...objects[1], org: '100' };
    objects[2] = { ...objects[2], org: '100' };
    w.emit({ relocated: [{ rid: '50', parent: '100', oldParent: '999' }] });
    objects.push(obj('61', '_a := moved in', { parent: '50', org: '100' }));
    w.emit({ added: [{ rid: '61', parent: '50' }] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1'); await feedSettled(ENV);
    w.client.posts.length = 0;
    expect((await search(w.client, 'moved in')).matchedObjects).toBe(1);
    expect(w.listings()).toBe(0);
    // A chain cut at the depth limit: not "outside", the place is listed again.
    const exec = w.client.executeEcBatch;
    w.client.executeEcBatch = async (codes, sg, ms) => (codes.some(c => /_p := lookup\(62\)\.parent/.test(c)) ? codes.map(() => ({ ok: true, log: '52,51,TOP=CUT#END' })) : exec(codes, sg, ms));
    objects.push(obj('62', '_a := deep', { parent: '777', org: '999' }));
    w.emit({ added: [{ rid: '62', parent: '777' }] });
    t += 1_000;
    await pollFeed(ENV, w.client, '1'); await feedSettled(ENV);
    w.client.executeEcBatch = exec;
    w.client.posts.length = 0;
    await search(w.client, '_a');
    expect(w.listings()).toBeGreaterThan(0);
  });

  it('memory: an evicted object of a listing the feed keeps makes that listing unused; every server together stays under the total', () => {
    const big = (n: number) => ({ type: 'ExtendedExpression', stamp: 's', len: n, o: { rid: 'x', businessId: '', name: '', parent: '', grandparent: '', stamp: 's', code: { expression: 'x'.repeat(n) } } });
    codeReadCache.putListing('m1', 'place', { at: t, rows: [{ rid: 'a', type: 'ExtendedExpression', stamp: 's', len: 1, src: 0 }], feed: 1 });
    codeReadCache.put('m1', 'a', big(13_000_000));
    expect(codeReadCache.listing('m1', 'place', t, () => true)).toBeDefined();
    codeReadCache.put('m1', 'b', big(12_000_000));
    expect(codeReadCache.knows('m1', 'a')).toBe(false);
    expect(codeReadCache.listing('m1', 'place', t, () => true)).toBeUndefined();
    // Another server: the total cap drops the least recently used one.
    codeReadCache.put('m2', 'c', big(21_000_000));
    expect(codeReadCache.knows('m1', 'b')).toBe(false);
    expect(codeReadCache.knows('m2', 'c')).toBe(true);
    expect(READ_ALL_CHARS).toBeLessThan(READ_CACHE_MAX_CHARS);
    expect(READ_CACHE_TOTAL_CHARS).toBeLessThan(2 * READ_CACHE_MAX_CHARS);
  });

  it('another session of the same client drops kept code as well as listings', async () => {
    const w = world([obj('1', '_a := 1')]);
    hold(ENV, w.client);
    await flush();
    await search(w.client, '_a');
    expect(codeReadCache.knows(ENV, '1')).toBe(true);
    expect(feedCurrent(ENV, feedDebug(ENV)!.generation, '2')).toBe(false);
    expect(codeReadCache.knows(ENV, '1')).toBe(false);
  });
});
