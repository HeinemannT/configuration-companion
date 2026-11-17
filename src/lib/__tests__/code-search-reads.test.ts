/**
 * The live search's reads (code-search serverSource, code-scope-read): what
 * is read, kept and narrowed stays within the limits, a type the server
 * cannot narrow is not searched (and named), and searches of the same place
 * at once share one read.
 */
import { describe, expect, it } from 'vitest';
import { runCodeSearch, serverSource, type CodeSearchHit } from '../code-search';
import { codeReadCache, READ_ALL_CHARS, settledStamp } from '../code-scope-read';
import { server, SIM_NOW, type SimObject } from './code-search-sim';

const ORG = { rid: '100', name: 'Group', parent: '' };
const SOURCES = [{ from: 'lookup(100)', root: 'organisation', path: ['100'] }];
const obj = (rid: string, type: string, code: string, stamp = 'Nov 1, 2026 10:00:00'): SimObject => ({ rid, type, id: `id${rid}`, name: `N ${rid}`, stamp, root: 'organisation', org: '100', code: { expression: code } });
const reads = (posts: string[][]) => posts.flat().filter(c => c.includes('"~CREV_R~1:I"'));
const readRids = (posts: string[][]) => reads(posts).filter(c => !/^_g := /m.test(c)).flatMap(c => [...c.matchAll(/lookup\((-?\d+)\)/g)].map(m => m[1]));
const bulkReads = (posts: string[][]) => reads(posts).filter(c => /^_g := /m.test(c));

describe('the live search\'s reads', () => {
  it('a type the server cannot narrow is not searched and named; the others are narrowed, nothing is read whole', async () => {
    // More code than READ_ALL_CHARS: the server narrows.
    const objects = [
      obj('1', 'ExtendedExpression', 'x'.repeat(READ_ALL_CHARS + 10)),
      obj('2', 'ExtendedExpression', '_a := needle'),
      obj('3', 'ExtendedTable', '_b := needle'),
      obj('4', 'ExtendedTable', '_c := other'),
    ];
    const client = server(objects, { orgs: [ORG], context: true, failNarrowType: 'ExtendedTable' });
    const hits: CodeSearchHit[] = [];
    const out = await runCodeSearch({ mode: 'text', text: 'needle' }, serverSource(client, { sources: SOURCES }), h => hits.push(...h));
    expect(hits.map(h => h.rid)).toEqual(['2']);
    // Only the hit was read; the failed type's objects were not read at all.
    expect(readRids(client.posts)).toEqual(['2']);
    expect(bulkReads(client.posts)).toEqual([]);
    expect(out.coverage).toMatchObject({ total: 4, complete: false, failedTypes: [expect.stringMatching(/^ExtendedTable in lookup\(100\) \(not narrowed/)] });
    expect(out.coverage.searched).toBe(2);
  });

  it('a few small changed objects next to large unchanged ones are read alone, never with the bulk script', async () => {
    const env = 'reads-test-small';
    const big = Array.from({ length: 8 }, (_, i) => obj(String(10 + i), 'ExtendedTable', `_t := ${i}\n${'y'.repeat(300_000)}`));
    const small = [obj('30', 'ExtendedTable', '_s := 1'), obj('31', 'ExtendedTable', '_s := 2')];
    const objects = [...big, ...small];
    const client = server(objects, { orgs: [ORG], context: true });
    await runCodeSearch({ mode: 'text', text: 'zzz' }, serverSource(client, { sources: SOURCES, env }), () => {});
    expect(bulkReads(client.posts).length).toBeGreaterThan(0);
    client.posts.length = 0;
    objects[8] = { ...small[0], stamp: 'Nov 2, 2026 10:00:00', code: { expression: '_s := 3' } };
    objects[9] = { ...small[1], stamp: 'Nov 2, 2026 10:00:00', code: { expression: '_s := 4' } };
    // Changed on the server meanwhile: Search again lists again.
    const out = await runCodeSearch({ mode: 'text', text: '_s :=' }, serverSource(client, { sources: SOURCES, env, fresh: true }), () => {});
    expect(bulkReads(client.posts)).toEqual([]);
    expect(readRids(client.posts).sort()).toEqual(['30', '31']);
    expect(out.matchedObjects).toBe(2);
    codeReadCache.clear();
  });

  it('when bulk reads would pass BULK_READ_MAX_CHARS, only what is needed is read, object by object', async () => {
    const env = 'reads-test-limit';
    const changed = [obj('40', 'ExtendedTable', `_a := 1\n${'z'.repeat(2_600_000)}`), obj('41', 'ExtendedTable', `_a := 2\n${'z'.repeat(2_600_000)}`)];
    const kept = obj('42', 'ExtendedTable', `_a := 3\n${'z'.repeat(3_000_000)}`);
    // The unchanged large one is kept from an earlier search.
    codeReadCache.put(env, kept.rid, { type: kept.type, stamp: kept.stamp, len: Object.values(kept.code).join('').length, o: { rid: kept.rid, businessId: kept.id, name: kept.name, parent: '', grandparent: '', stamp: kept.stamp, code: kept.code } });
    const client = server([...changed, kept], { orgs: [ORG], context: true });
    const out = await runCodeSearch({ mode: 'text', text: '_a :=' }, serverSource(client, { sources: SOURCES, env }), () => {});
    // A bulk read would read all three (8.2 M > BULK_READ_MAX_CHARS): one by one, 5.2 M.
    expect(bulkReads(client.posts)).toEqual([]);
    expect(readRids(client.posts).sort()).toEqual(['40', '41']);
    expect(out.matchedObjects).toBe(3);
    codeReadCache.clear();
  });

  it('code read within the stamp\'s resolution of the listing is used but not kept', async () => {
    expect(settledStamp('Nov 12, 2026 11:59:00', SIM_NOW)).toBe(true);
    expect(settledStamp('Nov 12, 2026 11:59:58', SIM_NOW)).toBe(false);
    expect(settledStamp('s', SIM_NOW)).toBe(false);
    expect(settledStamp('Nov 1, 2026 10:00:00', undefined)).toBe(false);
    const env = 'reads-test-fresh';
    const objects = [obj('50', 'ExtendedExpression', '_a := 1', 'Nov 12, 2026 11:59:59'), obj('51', 'ExtendedExpression', '_a := 2')];
    const client = server(objects, { orgs: [ORG], context: true });
    await runCodeSearch({ mode: 'text', text: '_a' }, serverSource(client, { sources: SOURCES, env }), () => {});
    client.posts.length = 0;
    await runCodeSearch({ mode: 'text', text: '_a' }, serverSource(client, { sources: SOURCES, env }), () => {});
    // The fresh one is read again; the settled one is kept.
    expect(readRids(client.posts)).toEqual(['50']);
    codeReadCache.clear();
  });

  it('nothing listed while the context support could not be checked is not "complete": it says so', async () => {
    const client = server([], { orgs: [ORG], context: true });
    client.contextCheck = 'unchecked';
    const out = await runCodeSearch({ mode: 'text', text: 'today' }, serverSource(client, { sources: SOURCES }), () => {});
    expect(out.coverage).toMatchObject({ total: 0, complete: false, failedTypes: [expect.stringMatching(/could not check this server's support/)] });
    client.contextCheck = 'supported';
    const ok = await runCodeSearch({ mode: 'text', text: 'today' }, serverSource(client, { sources: SOURCES }), () => {});
    expect(ok.coverage).toMatchObject({ total: 0, complete: true });
  });

  it('a typed search within 30 s uses the last listing; Search again, an older one or a save lists again', async () => {
    const env = 'reads-test-listing';
    const objects = Array.from({ length: 5 }, (_, i) => obj(String(80 + i), 'ExtendedExpression', `_w := ${i}`));
    const client = server(objects, { orgs: [ORG], context: true });
    const listings = () => client.posts.flat().filter(c => c.includes('~CREV_R~1:L')).length;
    // The worker's clock (the read cache keeps its own times by it).
    const t0 = Date.now();
    let t = t0;
    const src = (more: { fresh?: boolean } = {}) => serverSource(client, { sources: SOURCES, env, now: () => t, ...more });
    const first = await runCodeSearch({ mode: 'text', text: '_w' }, src(), () => {});
    expect(listings()).toBeGreaterThan(0);
    expect(first.coverage).toMatchObject({ read: 5, checkedAt: t0 });
    expect(first.coverage.listingReused).toBeUndefined();
    client.posts.length = 0;
    // Typed seconds later: nothing is sent at all.
    t += 12_000;
    const typed = await runCodeSearch({ mode: 'text', text: '_w := 3' }, src(), () => {});
    expect(client.posts).toEqual([]);
    expect(typed.coverage).toMatchObject({ searched: 5, read: 0, listingReused: true, checkedAt: t0 });
    expect(typed.matchedObjects).toBe(1);
    // "Search again" always lists, and its listing is the one kept next.
    const again = await runCodeSearch({ mode: 'text', text: '_w' }, src({ fresh: true }), () => {});
    expect(listings()).toBeGreaterThan(0);
    expect(again.coverage).toMatchObject({ read: 0, checkedAt: t0 + 12_000 });
    expect(again.coverage.listingReused).toBeUndefined();
    client.posts.length = 0;
    // 30 s after the last listing: listed again.
    t += 30_000;
    await runCodeSearch({ mode: 'text', text: '_w' }, src(), () => {});
    expect(listings()).toBeGreaterThan(0);
    client.posts.length = 0;
    // A save by Companion drops the listings of that server.
    t += 1_000;
    codeReadCache.forget(env, '82');
    await runCodeSearch({ mode: 'text', text: '_w' }, src(), () => {});
    expect(listings()).toBeGreaterThan(0);
    expect(readRids(client.posts)).toEqual(['82']);
    // Another server's listing is its own.
    client.posts.length = 0;
    await runCodeSearch({ mode: 'text', text: '_w' }, serverSource(client, { sources: SOURCES, env: 'reads-test-listing-2', now: () => t }), () => {});
    expect(listings()).toBeGreaterThan(0);
    codeReadCache.clear();
  });

  it('the coverage says how much was read from the server: all at first, then only what changed', async () => {
    const env = 'reads-test-coverage';
    const objects = Array.from({ length: 5 }, (_, i) => obj(String(70 + i), 'ExtendedExpression', `_v := ${i}`));
    const client = server(objects, { orgs: [ORG], context: true });
    const first = await runCodeSearch({ mode: 'text', text: '_v' }, serverSource(client, { sources: SOURCES, env }), () => {});
    expect(first.coverage).toMatchObject({ source: 'server', searched: 5, read: 5 });
    expect(first.coverage.narrowed).toBeUndefined();
    const again = await runCodeSearch({ mode: 'text', text: '_v' }, serverSource(client, { sources: SOURCES, env }), () => {});
    expect(again.coverage).toMatchObject({ searched: 5, read: 0 });
    objects[2] = { ...objects[2], stamp: 'Nov 2, 2026 10:00:00', code: { expression: '_v := changed' } };
    const changed = await runCodeSearch({ mode: 'text', text: '_v' }, serverSource(client, { sources: SOURCES, env, fresh: true }), () => {});
    expect(changed.coverage).toMatchObject({ searched: 5, read: 1, readChanged: 1 });
    codeReadCache.clear();
  });

  it('two searches of the same place at once share one read', async () => {
    const objects = Array.from({ length: 6 }, (_, i) => obj(String(60 + i), 'ExtendedExpression', `_v := ${i} today`));
    const one = server(objects, { orgs: [ORG], context: true });
    await runCodeSearch({ mode: 'text', text: 'today' }, serverSource(one, { sources: SOURCES, env: 'reads-test-one' }), () => {});
    const both = server(objects, { orgs: [ORG], context: true });
    const env = 'reads-test-both';
    const [a, b] = await Promise.all([
      runCodeSearch({ mode: 'text', text: 'today' }, serverSource(both, { sources: SOURCES, env }), () => {}),
      runCodeSearch({ mode: 'text', text: '_v' }, serverSource(both, { sources: SOURCES, env }), () => {}),
    ]);
    expect(a.matchedObjects).toBe(6);
    expect(b.matchedObjects).toBe(6);
    expect(both.posts.length).toBe(one.posts.length);
    codeReadCache.clear();
  });
});
