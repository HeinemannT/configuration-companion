/**
 * The local copy made from the code search's read (code-copy.ts) on a
 * simulated server:
 *  - the copy holds what the engine reads, and a search finds the same in
 *    both; its posts are a search's posts plus one summary;
 *  - a search that already read the server leaves the copy one post;
 *  - Refresh (the user's request, user class at low priority): one post
 *    when nothing changed; the summary, the listing and only the changed
 *    objects when something did; everything again when the summary cannot
 *    tell; a stopped or failed refresh leaves the copy as it was;
 *  - the estimate comes from the listing the build uses and is close to what
 *    the build costs (posts and time on a timed simulation);
 *  - on a slow server every post is background work, paced as before, and
 *    the copy sends fewer commands than the older builder;
 *  - a server too large to read in one go is copied source by source.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateCopy, syncCopy, type CopyOptions, type CopyRoots } from '../code-copy';
import { indexSource, resetListTimes, runCodeSearch, serverSource, storeReader, type ScanSource } from '../code-search';
import { codeReadCache, READ_ALL_CHARS, LISTING_REUSE_MS } from '../code-scope-read';
import { KNOWN_CODE_PROPS, syncCodeIndex, type SyncProgress } from '../code-index-sync';
import { MemoryCodeIndexStore, type IndexedObject } from '../code-index-store';
import { Pacer } from '../index-budget';
import { isAskedByUser, isLowPriority, requestClassOf } from '../request-class';
import { resetFeeds, setFeedClock } from '../code-feed';
import type { EcResult } from '../bmp-client';
import { goldenWorld } from './code-search-world';
import { ROOT_RIDS, server, type SimObject } from './code-search-sim';

const STAMP = 'Nov 1, 2026 10:00:00';
const LATER = 'Nov 2, 2026 10:00:00';
const ENV = 'p1@https://copy.example.test/W/';
const MAP = KNOWN_CODE_PROPS;
const SOURCES: ScanSource[] = [
  { from: 'root.templateCategory', rid: ROOT_RIDS.templateCategory, root: 'templateCategory', label: 'Templates' },
  { from: 'root.portal', rid: ROOT_RIDS.portal, root: 'portal', label: 'Portal' },
  { from: 'root.expression', rid: ROOT_RIDS.expression, root: 'expression', label: 'Expressions' },
  { from: 'lookup(100)', rid: '100', root: 'organisation', path: ['100'], label: 'Group' },
  { from: 'lookup(200)', rid: '200', root: 'organisation', path: ['200'], label: 'Administration' },
];
const ROOTS: CopyRoots = {
  order: ['templateCategory', 'portal', 'expression', 'organisation'],
  names: { templateCategory: 'Templates', portal: 'Portal', expression: 'Expressions', organisation: 'Organisation' },
  rids: { templateCategory: ROOT_RIDS.templateCategory, portal: ROOT_RIDS.portal, expression: ROOT_RIDS.expression, organisation: ROOT_RIDS.organisation },
  orgs: { 100: { name: 'Group', parent: '' }, 110: { name: 'Europe', parent: '100' }, 120: { name: 'Asia', parent: '100' }, 200: { name: 'Administration', parent: '' } },
};

/** The golden world with stamps a listing can compare (dates). */
function world(): { objects: SimObject[]; orgs: Array<{ rid: string; name: string; parent: string }> } {
  const { objects, orgs } = goldenWorld();
  return { objects: objects.map(o => ({ ...o, stamp: STAMP })), orgs };
}

const READ = '"~CREV_R~1:I"';
const kinds = (posts: string[][]) => {
  const all = posts.flat();
  return {
    summary: posts.filter(p => p.some(c => c.includes('~CREV_R~1:S'))).length,
    list: posts.filter(p => p.some(c => c.includes('~CREV_R~1:L'))).length,
    read: posts.filter(p => p.some(c => c.includes(READ))).length,
    bulk: all.filter(c => c.includes(READ) && /^_g := /m.test(c)).length,
  };
};
const readRids = (posts: string[][]) => posts.flat().filter(c => c.includes(READ) && !/^_g := /m.test(c)).flatMap(c => [...c.matchAll(/lookup\((-?\d+)\)/g)].map(m => m[1]));

let t = Date.now();
const now = () => t;
const opts = (store: MemoryCodeIndexStore, more: Partial<CopyOptions> = {}): CopyOptions => ({
  store, env: ENV, searchEnv: `${ENV}#1`, sources: SOURCES, roots: ROOTS, map: MAP, signal: new AbortController().signal, now, ...more,
});
async function stored(store: MemoryCodeIndexStore): Promise<IndexedObject[]> {
  const out: IndexedObject[] = [];
  await store.scan(ENV, b => { out.push(...b); });
  return out;
}
const shape = (list: readonly IndexedObject[]) => list.map(({ env: _e, ...o }) => o).sort((a, b) => a.rid.localeCompare(b.rid));

beforeEach(() => { codeReadCache.clear(); resetFeeds(); resetListTimes(); t = Date.now(); });
afterEach(() => { codeReadCache.clear(); resetFeeds(); setFeedClock(() => Date.now(), { set: (fn, ms) => setTimeout(fn, ms), clear: x => clearTimeout(x) }); });

describe('the copy is the search\'s read', () => {
  it('holds the objects the engine reads; searches agree; it costs a search plus one summary post', async () => {
    const { objects, orgs } = world();
    const client = server(objects, { orgs, context: true });
    const store = new MemoryCodeIndexStore();
    const seen: SyncProgress[] = [];
    const res = await syncCopy(client, opts(store, { onProgress: p => seen.push({ ...p }) }));
    // The progress the window shows: listing, then n of m read, with the
    // requests sent so far (never fewer than before).
    expect(seen.some(p => p.phase === 'listing')).toBe(true);
    expect(seen.some(p => p.phase === 'reading' && p.toRead > 0 && p.read <= p.toRead)).toBe(true);
    const posts = seen.map(p => p.posts ?? 0);
    expect(posts.every((n, i) => !i || n >= posts[i - 1])).toBe(true);
    expect(Math.max(...posts)).toBeGreaterThan(0);
    // The engine's own read of the same place, in another cache.
    const engine = server(objects, { orgs, context: true });
    const read = await serverSource(engine, { env: 'engine', sources: SOURCES, map: MAP }).readAll(new AbortController().signal);
    expect(read.complete).toBe(true);
    const copy = await stored(store);
    expect(copy.length).toBeGreaterThan(300);
    expect(shape(copy)).toEqual(shape(read.objects));
    expect(res.meta).toMatchObject({ objects: copy.length, pending: 0 });
    expect(res.meta.builtAt).toBeTypeOf('number');
    // A search's posts, plus the summary the next check compares with.
    expect(client.posts.length).toBe(engine.posts.length + 1);
    expect(kinds(client.posts).summary).toBe(1);
    // Every search answers the same from the copy and from the server.
    const meta = res.meta;
    for (const text of ['today', 't.e1', '_extra := today', 'SELECT']) {
      for (const fold of [true, false]) {
        const a = await runCodeSearch({ mode: 'text', text, fold }, indexSource(meta, storeReader(store, ENV)), () => {});
        const b = await runCodeSearch({ mode: 'text', text, fold }, serverSource(engine, { env: 'engine', sources: SOURCES, map: MAP }), () => {});
        expect([a.matchedObjects, a.matches, a.rows]).toEqual([b.matchedObjects, b.matches, b.rows]);
      }
    }
  });

  it('after a search read the server, the copy sends only the summary', async () => {
    const { objects, orgs } = world();
    const client = server(objects, { orgs, context: true });
    await runCodeSearch({ mode: 'text', text: 'today' }, serverSource(client, { env: `${ENV}#1`, sources: SOURCES, map: MAP, now }), () => {});
    client.posts.length = 0;
    const store = new MemoryCodeIndexStore();
    t += LISTING_REUSE_MS / 2;
    await syncCopy(client, opts(store));
    expect(kinds(client.posts)).toEqual({ summary: 1, list: 0, read: 0, bulk: 0 });
    expect((await stored(store)).length).toBeGreaterThan(300);
  });
});

/** A later session: nothing of the build is kept in the worker's memory. */
function laterSession(client: { posts: string[][] }) {
  codeReadCache.clear();
  client.posts.length = 0;
}

/** The summary post fails (the server refuses it). */
function failSummary(client: ReturnType<typeof server>) {
  const pairs = client.executeEcPairs!.bind(client);
  const batch = client.executeEcBatch.bind(client);
  const isSummary = (code: string) => code.includes('~CREV_R~1:S');
  client.executeEcPairs = async (p, ...rest) => (p.some(x => isSummary(x.code)) ? p.map(() => ({ ok: false, error: 'denied' })) : pairs(p, ...rest));
  client.executeEcBatch = async (c, ...rest) => (c.some(isSummary) ? c.map(() => ({ ok: false, error: 'denied' })) : batch(c, ...rest));
}

describe('Refresh', () => {
  it('nothing changed: one request, nothing listed or read; the copy keeps its objects and takes the new time', async () => {
    const { objects, orgs } = world();
    const client = server(objects, { orgs, context: true });
    const store = new MemoryCodeIndexStore();
    const built = await syncCopy(client, opts(store));
    const before = await stored(store);
    laterSession(client);
    t += 3 * 86_400_000;
    const r = await syncCopy(client, opts(store, { searchEnv: `${ENV}#2` }));
    expect(r.unchanged).toBe(true);
    expect(client.posts).toHaveLength(1);
    expect(kinds(client.posts)).toEqual({ summary: 1, list: 0, read: 0, bulk: 0 });
    expect(shape(await stored(store))).toEqual(shape(before));
    expect(r.meta.syncedAt).toBe(t);
    expect(r.meta.revision).toBe(built.meta.revision);
  });

  it('one object changed: the summary, the listing and that one object only', async () => {
    const { objects, orgs } = world();
    const client = server(objects, { orgs, context: true });
    const store = new MemoryCodeIndexStore();
    await syncCopy(client, opts(store));
    const before = await stored(store);
    const i = objects.findIndex(o => o.type === 'ExtendedExpression' && o.rid.startsWith('9'));
    objects[i] = { ...objects[i], stamp: LATER, code: { expression: '_changed := today' } };
    laterSession(client);
    const r = await syncCopy(client, opts(store, { searchEnv: `${ENV}#2` }));
    expect(r.unchanged).toBeUndefined();
    expect(r.changed).toBe(1);
    const k = kinds(client.posts);
    expect(k.summary).toBe(1);
    expect(k.list).toBeGreaterThan(0);
    expect(k.bulk).toBe(0);
    expect(readRids(client.posts)).toEqual([objects[i].rid]);
    expect(client.posts).toHaveLength(1 + k.list + 1);
    expect((await store.get(ENV, objects[i].rid))?.code.expression).toBe('_changed := today');
    expect((await stored(store)).length).toBe(before.length);
  });

  it('a removed object leaves the copy; an added one joins it', async () => {
    const { objects, orgs } = world();
    const client = server(objects, { orgs, context: true });
    const store = new MemoryCodeIndexStore();
    await syncCopy(client, opts(store));
    const n = (await stored(store)).length;
    const gone = objects.findIndex(o => o.root === 'portal');
    const goneRid = objects[gone].rid;
    objects.splice(gone, 1);
    objects.push({ rid: '5000000000000000001', type: 'ExtendedExpression', id: 'new1', name: 'New', stamp: LATER, root: 'expression', code: { expression: '_new := 1' } });
    laterSession(client);
    const r = await syncCopy(client, opts(store, { searchEnv: `${ENV}#2` }));
    expect([r.changed, r.removed]).toEqual([1, 1]);
    expect(readRids(client.posts)).toEqual(['5000000000000000001']);
    expect(await store.get(ENV, goneRid)).toBeNull();
    expect((await stored(store)).length).toBe(n);
  });

  it('when the summary cannot tell, everything is read again', async () => {
    const { objects, orgs } = world();
    const client = server(objects, { orgs, context: true });
    const store = new MemoryCodeIndexStore();
    const built = await syncCopy(client, opts(store));
    const before = await stored(store);
    const engine = server(objects, { orgs, context: true });
    await serverSource(engine, { env: 'engine', sources: SOURCES, map: MAP }).readAll(new AbortController().signal);
    const readPosts = kinds(engine.posts).read;

    // The summary request fails.
    failSummary(client);
    laterSession(client);
    const r = await syncCopy(client, opts(store, { searchEnv: `${ENV}#2` }));
    const read = r.stages.find(x => x.stage === 'read')!.read;
    expect(read).toBe(before.length);
    expect(kinds(client.posts).read).toBe(readPosts);
    expect(shape(await stored(store))).toEqual(shape(before));
    // The copy keeps the summary it had.
    expect(r.meta.summary).toEqual(built.meta.summary);

    // The copy holds no summary: everything is read again too.
    const { summary: _s, ...noSummary } = r.meta;
    await store.putMeta(noSummary);
    const plain = server(objects, { orgs, context: true });
    laterSession(plain);
    const again = await syncCopy(plain, opts(store, { searchEnv: `${ENV}#3` }));
    expect(again.stages.find(x => x.stage === 'read')!.read).toBe(before.length);
    // Now it has one: nothing changed, one request.
    laterSession(plain);
    expect((await syncCopy(plain, opts(store, { searchEnv: `${ENV}#4` }))).unchanged).toBe(true);
    expect(plain.posts).toHaveLength(1);
  });

  it('is the user\'s request: user class at low priority, without the build\'s pauses', async () => {
    const { objects, orgs } = world();
    const client = server(objects, { orgs, context: true });
    const store = new MemoryCodeIndexStore();
    await syncCopy(client, opts(store));
    const i = objects.findIndex(o => o.root === 'portal');
    objects[i] = { ...objects[i], stamp: LATER, code: { expression: '_edited := 1' } };
    laterSession(client);
    const log = timed(client, 1);
    await syncCopy(client, opts(store, { searchEnv: `${ENV}#2` }));
    expect(log.length).toBeGreaterThan(2);
    expect(new Set(log.map(p => p.cls))).toEqual(new Set(['user']));
    expect(log.every(p => p.low)).toBe(true);
    for (let k = 1; k < log.length; k++) expect(log[k].at).toBe(log[k - 1].at + log[k - 1].ms);
  });

  it('stopped, it leaves the copy as it was; the next refresh starts again', async () => {
    const { objects, orgs } = world();
    const client = server(objects, { orgs, context: true });
    const store = new MemoryCodeIndexStore();
    const built = await syncCopy(client, opts(store));
    const before = await stored(store);
    for (const o of objects) if (o.type === 'ExtendedExpression') Object.assign(o, { stamp: LATER, code: { expression: `${Object.values(o.code)[0] ?? ''}\n_more := 1` } });
    laterSession(client);
    t += 60_000;
    // Stop at the first read post.
    const ac = new AbortController();
    const pairs = client.executeEcPairs!.bind(client);
    client.executeEcPairs = async (p, ...rest) => { if (p.some(x => x.code.includes(READ))) ac.abort(); return pairs(p, ...rest); };
    await expect(syncCopy(client, opts(store, { searchEnv: `${ENV}#2`, signal: ac.signal }))).rejects.toThrow();
    expect(shape(await stored(store))).toEqual(shape(before));
    expect(await store.getMeta(ENV)).toEqual(built.meta);
    // The next refresh brings the changes.
    client.executeEcPairs = pairs;
    laterSession(client);
    const r = await syncCopy(client, opts(store, { searchEnv: `${ENV}#3` }));
    expect(r.changed).toBeGreaterThan(0);
  });

  it('failed, it leaves the copy as it was', async () => {
    const { objects, orgs } = world();
    const store = new MemoryCodeIndexStore();
    const built = await syncCopy(server(objects, { orgs, context: true }), opts(store));
    const before = await stored(store);
    const i = objects.findIndex(o => o.root === 'portal');
    objects[i] = { ...objects[i], stamp: LATER, code: { expression: '_edited := 1' } };
    // An overloaded answer to the read.
    const busy = server(objects, { orgs, context: true, overload: code => code.includes(READ) });
    laterSession(busy);
    await expect(syncCopy(busy, opts(store, { searchEnv: `${ENV}#2` }))).rejects.toThrow();
    expect(shape(await stored(store))).toEqual(shape(before));
    expect(await store.getMeta(ENV)).toEqual(built.meta);
    // A source that cannot be listed.
    const failing = server(objects, { orgs, context: true });
    const pairs = failing.executeEcPairs!.bind(failing);
    failing.executeEcPairs = async (p, ...rest) => {
      const out = await pairs(p, ...rest);
      return out.map((r, k) => (p[k].code.includes('~CREV_R~1:L') && p[k].objectRid === ROOT_RIDS.portal ? { ok: false, error: 'denied' } : r));
    };
    laterSession(failing);
    await expect(syncCopy(failing, opts(store, { searchEnv: `${ENV}#3` }))).rejects.toThrow(/copy is unchanged/);
    expect(shape(await stored(store))).toEqual(shape(before));
    expect((await store.getMeta(ENV))?.syncedAt).toBe(built.meta.syncedAt);
  });
});

/**
 * A timed simulation: each post takes POST_MS plus ROW_MS per object row the
 * server writes (listed or read), on the test's clock; the pacer sleeps on
 * the same clock.
 */
function timed(client: ReturnType<typeof server>, rowMs: number, perCommandMs = 0) {
  const POST_MS = 30;
  const log: Array<{ at: number; ms: number; commands: number; cls: string; low: boolean; asked: boolean }> = [];
  const rawBatch = client.executeEcBatch.bind(client);
  const rawPairs = client.executeEcPairs!.bind(client);
  const rawEach = client.executeEcEach!.bind(client);
  let depth = 0;
  const rows = (rs: readonly EcResult[]) => rs.reduce((n, r) => n + (r.log?.match(/~CREV_R~1:[LIS]/g)?.length ?? 0), 0);
  const rec = async <T>(commands: number, signal: AbortSignal | undefined, run: () => Promise<T>, results: (x: T) => EcResult[]): Promise<T> => {
    if (depth) return run();
    depth++;
    try {
      const at = t;
      const out = await run();
      const ms = POST_MS + rows(results(out)) * rowMs + commands * perCommandMs;
      t += ms;
      log.push({ at, ms, commands, cls: requestClassOf(signal).requestClass, low: isLowPriority(signal), asked: isAskedByUser(signal) });
      return out;
    } finally { depth--; }
  };
  client.executeEcBatch = (codes, signal, ms) => rec(codes.length, signal, () => rawBatch(codes, signal, ms), r => r);
  client.executeEcPairs = (pairs, signal, ms) => rec(pairs.length, signal, () => rawPairs(pairs, signal, ms), r => r);
  client.executeEcEach = (code, rids, signal, ms) => rec(rids.length, signal, () => rawEach(code, rids, signal, ms), r => [...r.values()]);
  return log;
}
const clockPacer = () => new Pacer({ now, sleep: async ms => { t += ms; }, firstReadObjects: 40 });

describe('the estimate', () => {
  it('comes from the listing the build uses and is within a small factor of what the build costs', async () => {
    const { objects, orgs } = world();
    const client = server(objects, { orgs, context: true });
    const log = timed(client, 20);
    const store = new MemoryCodeIndexStore();
    const est = await estimateCopy(client, { searchEnv: `${ENV}#1`, sources: SOURCES, map: MAP, now, signal: new AbortController().signal });
    expect(est.objects).toBe(objects.filter(o => Object.values(o.code).join('').length).length);
    expect(est.readAll).toBe(true);
    // The listing is old by the time the user builds: listed again.
    t += 2 * LISTING_REUSE_MS;
    log.length = 0;
    const t0 = t;
    const res = await syncCopy(client, opts(store, { pacer: clockPacer() }));
    const seconds = (t - t0) / 1000;
    expect(res.meta.objects).toBe(est.objects);
    // Posts: the estimate names them.
    expect(log.length).toBe(est.posts);
    expect(res.posts).toBe(est.posts);
    // Time: within a factor of 1.5 either way.
    expect(seconds / est.seconds).toBeGreaterThan(1 / 1.5);
    expect(seconds / est.seconds).toBeLessThan(1.5);
    console.log(`estimate: ${est.posts} posts, ${est.seconds} s; build: ${res.posts} posts, ${seconds.toFixed(1)} s`);
  });
});

describe('the load on a slow server (1 s per command)', () => {
  it('every post is background work, paced as before, with fewer commands and less server time than the older builder', async () => {
    const { objects, orgs } = world();
    const copyClient = server(objects, { orgs, context: true });
    const copyLog = timed(copyClient, 0, 1_000);
    const copyPacer = clockPacer();
    await syncCopy(copyClient, opts(new MemoryCodeIndexStore(), { pacer: copyPacer }));

    const oldClient = server(objects, { orgs, context: true });
    const oldLog = timed(oldClient, 0, 1_000);
    await syncCodeIndex(oldClient, new MemoryCodeIndexStore(), ENV, { signal: new AbortController().signal, now, pacer: clockPacer() });

    for (const log of [copyLog, oldLog]) expect(new Set(log.map(p => p.cls))).toEqual(new Set(['background']));
    // Started only by the user: the script gauge never refuses these posts
    // (load-governor rule 6); pacing, budgets and the overload stop stay.
    for (const log of [copyLog, oldLog]) expect(log.every(p => p.asked)).toBe(true);
    // The pacer's rule holds for the copy: after each post a pause as long as
    // it took (at least 500 ms), so the server works at most half the time.
    for (let k = 1; k < copyLog.length; k++) {
      const prev = copyLog[k - 1];
      expect(copyLog[k].at - (prev.at + prev.ms)).toBeGreaterThanOrEqual(Math.max(500, Math.min(prev.ms, 30_000)));
    }
    const total = (log: typeof copyLog) => [log.reduce((n, p) => n + p.commands, 0), log.reduce((n, p) => n + p.ms, 0)];
    const [copyCommands, copyMs] = total(copyLog);
    const [oldCommands, oldMs] = total(oldLog);
    expect(copyCommands).toBeLessThan(oldCommands);
    expect(copyMs).toBeLessThan(oldMs);
    console.log(`slow server: copy ${copyLog.length} posts, ${copyCommands} commands; older builder ${oldLog.length} posts, ${oldCommands} commands`);
  });
});

describe('a server too large to read in one go', () => {
  it('is copied source by source, and the estimate says so', async () => {
    const big = (rid: string, org: string): SimObject => ({ rid, type: 'ExtendedExpression', id: `b${rid}`, name: 'Big', stamp: STAMP, root: 'organisation', org, code: { expression: `_big := 1\n${'z'.repeat(Math.ceil(READ_ALL_CHARS / 2) + 1_000)}` } });
    const objects: SimObject[] = [
      big('4000000000000000001', '100'), big('4000000000000000002', '200'),
      { rid: '4000000000000000003', type: 'ExtendedExpression', id: 'e', name: 'E', stamp: STAMP, root: 'expression', code: { expression: '_small := 1' } },
    ];
    const client = server(objects, { orgs: [{ rid: '100', name: 'Group', parent: '' }, { rid: '200', name: 'Administration', parent: '' }], context: true });
    const est = await estimateCopy(client, { searchEnv: `${ENV}#1`, sources: SOURCES, map: MAP, now, signal: new AbortController().signal });
    expect(est.readAll).toBe(false);
    expect(est.perSource).toBeDefined();
    const store = new MemoryCodeIndexStore();
    const seen: SyncProgress[] = [];
    const res = await syncCopy(client, opts(store, { onProgress: p => seen.push({ ...p }) }));
    expect(res.meta.builtAt).toBeTypeOf('number');
    expect(res.meta.copy?.perSource).toBe(true);
    // The progress names the place being read and its number.
    const places = seen.filter(p => p.place);
    expect(places.length).toBeGreaterThan(0);
    expect(places.every(p => p.sources === SOURCES.length && p.source! >= 1 && p.source! <= SOURCES.length)).toBe(true);
    expect((await stored(store)).map(o => o.rid).sort()).toEqual(objects.map(o => o.rid).sort());
    codeReadCache.clear();
  });
});
