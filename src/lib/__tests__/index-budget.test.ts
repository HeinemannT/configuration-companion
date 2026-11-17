/**
 * The code index is gentle with the server (lib/index-budget.ts): pacing,
 * the budget per request, adaptive read size, the stop on an overloaded
 * server, and the scripts that never hold more than one list or read code
 * where they only list.
 */
import { describe, expect, it } from 'vitest';
import { STATIC_EC_FRAME as F } from '../ec-parser';
import { BUDGET, isOverload, packByRows, Pacer, ServerOverloadError } from '../index-budget';
import {
  buildBucketInventoryEc, buildCountEc, buildReadEc, buildSummaryEc, orgBucket, readObjects, rootBucket, sinceDay, summaryChanges,
  type IndexClient,
} from '../code-index-sync';
import type { EcResult } from '../bmp-client';
import { framedText as __framedText } from '../ec-parser';
/** One length-framed row (ec-parser). */
const R = (...f: unknown[]) => __framedText([f.map(String)], false);

function clock() {
  let t = 0;
  const pauses: number[] = [];
  return { now: () => t, advance: (ms: number) => { t += ms; }, sleep: async (ms: number) => { pauses.push(ms); t += ms; }, pauses };
}

describe('pacing', () => {
  it('pauses before each post as long as the previous post took, within bounds', async () => {
    const c = clock();
    const p = new Pacer({ now: c.now, sleep: c.sleep });
    for (const ms of [100, 3_000, 90_000, 10]) await p.post('x', 0, async () => { c.advance(ms); return [{ ok: true, log: '' }]; });
    expect(c.pauses).toEqual([BUDGET.minPauseMs, 3_000, BUDGET.maxPauseMs]);
    expect(p.log.map(r => r.pauseMs)).toEqual([0, BUDGET.minPauseMs, 3_000, BUDGET.maxPauseMs]);
  });

  it('stops at an answer that reads like an overloaded server, and records it', async () => {
    const p = new Pacer({ sleep: async () => {} });
    await expect(p.post('read', 40, async () => [{ ok: false, error: 'java.lang.OutOfMemoryError: Java heap space' }])).rejects.toBeInstanceOf(ServerOverloadError);
    await expect(p.post('read', 40, async () => { throw Object.assign(new Error('BMP timed out'), { kind: 'timeout' }); })).rejects.toBeInstanceOf(ServerOverloadError);
    expect(p.log).toHaveLength(2);
    for (const e of ['Command failed: HTTP 500', 'HTTP 502 Bad Gateway', 'GC overhead limit exceeded']) expect(isOverload({ ok: false, error: e }), e).toBe(true);
    expect(isOverload({ ok: false, error: 'Syntax error at line 2' })).toBe(false);
    expect(isOverload({ ok: true, log: 'a timed out sentence in code' })).toBe(false);
  });

  it('sizes the next read from the bytes per object of the last answer, and halves after a large or slow one', () => {
    const p = new Pacer();
    expect(p.readSize).toBe(40);
    // Over the cap: half, or what fits the target, whichever is smaller.
    p.adapt(BUDGET.maxBytes + 1, 100, 40);
    expect(p.readSize).toBe(19);
    p.adapt(10_000, BUDGET.slowMs + 1, 19);
    expect(p.readSize).toBe(9);
    // 1 KB an object: grows by at most half a step at a time, up to the cap.
    for (let i = 0; i < 20; i++) p.adapt(p.readSize * 1_000, 100, p.readSize);
    expect(p.readSize).toBe(BUDGET.maxReadObjects);
    // 30 KB an object (the read that answered 1.9 MB live): the next read
    // aims at the target size.
    p.adapt(100 * 30_000, 100, 100);
    expect(p.readSize).toBe(10);
    p.adapt(10 * 30_000, 100, 10);
    expect(p.readSize * 30_000).toBeLessThanOrEqual(BUDGET.targetBytes);
  });

  it('packs lists by expected rows, a heavy one alone', () => {
    expect(packByRows(['a', 'b', 'c', 'd'], x => ({ a: 900, b: 900, c: 5_000, d: 10 }[x]!), 2_000)).toEqual([['a', 'b'], ['c'], ['d']]);
  });
});

describe('budgeted reads', () => {
  it('reads at most the pacer\'s size per script, one script a post', async () => {
    const posts: string[][] = [];
    const client: IndexClient = {
      ensureLookupSupport: async () => true,
      resolveRefs: async rids => new Map(rids.map(r => [r, `lookup(${r})`])),
      executeEcBatch: async codes => {
        posts.push([...codes]);
        return codes.map((code): EcResult => {
          const rids = [...code.matchAll(/lookup\((\d+)\)/g)].map(m => m[1]);
          return { ok: true, log: `${rids.map(r => R('I', r, 'id', 'n', 'p', 'g', 's', '')).join('')}${F.done}` };
        });
      },
    };
    const items = Array.from({ length: 95 }, (_, i) => ({ rid: String(1000 + i), type: 'ExtendedTable', props: ['expression'] }));
    const pacer = new Pacer({ sleep: async () => {} });
    pacer.readSize = 30;
    await readObjects(client, items, new AbortController().signal, undefined, pacer);
    expect(posts.every(p => p.length === 1)).toBe(true);
    expect(posts.map(p => p[0].match(/lookup\(/g)!.length).every(n => n <= 45)).toBe(true);
    expect(posts.reduce((n, p) => n + p[0].match(/lookup\(/g)!.length, 0)).toBe(95);
  });
});

describe('reads sized from the previous answer', () => {
  /** A server whose objects of type Big hold 190 KB of code each (the read
   *  that answered 1.87 MB live had a few such objects). */
  function bigServer() {
    const posts: Array<{ rids: string[]; bytes: number }> = [];
    const client: IndexClient = {
      ensureLookupSupport: async () => true,
      resolveRefs: async rids => new Map(rids.map(r => [r, `lookup(${r})`])),
      executeEcBatch: async codes => codes.map((code): EcResult => {
        const rids = [...code.matchAll(/lookup\((\d+)\)/g)].map(m => m[1]);
        const body = rids.map(r => R('I', r, 'id', 'n', 'p', 'g', 's', '') + R('C', r, 'expression', 'x'.repeat(Number(r) >= 5000 ? 190_000 : 800))).join('');
        const log = `${body}${F.done}`;
        posts.push({ rids, bytes: log.length });
        return { ok: true, log };
      }),
    };
    return { client, posts };
  }

  it('starts each type small and keeps later reads near the target', async () => {
    const { client, posts } = bigServer();
    const items = [
      ...Array.from({ length: 300 }, (_, i) => ({ rid: String(1000 + i), type: 'Small', props: ['expression'] })),
      ...Array.from({ length: 40 }, (_, i) => ({ rid: String(5000 + i), type: 'Big', props: ['expression'] })),
    ];
    await readObjects(client, items, new AbortController().signal, undefined, new Pacer({ sleep: async () => {} }));
    // One type a script; the first read of each type holds 10 objects.
    expect(posts.every(p => new Set(p.rids.map(r => (Number(r) >= 5000 ? 'Big' : 'Small'))).size === 1)).toBe(true);
    const big = posts.filter(p => Number(p.rids[0]) >= 5000);
    expect(big[0].rids).toHaveLength(BUDGET.firstReadObjects);
    // After the first 1.9 MB answer, the big objects are read one or two at a time.
    expect(big[0].bytes).toBeGreaterThan(1_800_000);
    expect(big.slice(1).every(p => p.bytes <= BUDGET.maxBytes)).toBe(true);
    expect(big.reduce((n, p) => n + p.rids.length, 0)).toBe(40);
    // The small type grows from 10 towards the cap, within the target size.
    const small = posts.filter(p => Number(p.rids[0]) < 5000);
    expect(small[0].rids).toHaveLength(BUDGET.firstReadObjects);
    expect(Math.max(...small.map(p => p.rids.length))).toBeGreaterThan(BUDGET.readObjects);
    expect(small.every(p => p.bytes <= BUDGET.targetBytes)).toBe(true);
  });
});

describe('scripts that never hold much', () => {
  it('counts one list at a time and lists without reading code', () => {
    const count = buildCountEc(['EditField', 'ExtendedTable'], 'this.object', true);
    expect(count.match(/_l := ""/g)).toHaveLength(2);
    expect(count).toContain('WHERE organisation = _g');
    const list = buildBucketInventoryEc(orgBucket('5'), ['ExtendedTable', 'ActionButton'], F);
    expect(list).not.toContain('output(');
    expect(list.match(/_l := ""/g)).toHaveLength(2);
  });

  it('lists changed objects with the day as a literal in the WHERE clause (the proven form)', () => {
    const ec = buildBucketInventoryEc(rootBucket('portal'), ['EditField'], F, { since: '2026-11-09' });
    expect(ec).toContain('_l := SELECT EditField FROM _g WHERE lastModifiedDate >= date("2026-11-09")');
    expect(ec).not.toContain('.filter(');
    expect(ec).not.toMatch(/_d\b/);
    const own = buildBucketInventoryEc(orgBucket('5', true), ['ExtendedTable'], F, { since: '2026-11-09' });
    expect(own).toContain('WHERE organisation = _g AND lastModifiedDate >= date("2026-11-09")');
    expect(() => buildBucketInventoryEc(rootBucket('portal'), ['EditField'], F, { since: '2026-11-09"); x(' })).toThrow();
    expect(sinceDay(Date.parse('2026-11-11T10:00:00Z'))).toBe('2026-11-09');
  });

  it('summarises counts and newest changes per source in one small script', () => {
    const ec = buildSummaryEc(['ExtendedTable', 'EditField'], ['root', 'root.portal'], '2026-11-09', F);
    expect(ec.match(/WHERE lastModifiedDate >= date\("2026-11-09"\)/g)).toHaveLength(4);
    expect(ec).not.toContain('output(');
    expect(ec.match(/_l := ""/g)).toHaveLength(4);
    expect(ec.match(/_c := ""/g)).toHaveLength(4);
    const prev = { 'root|A': { n: 3, c: 1, m: 'x' }, 'root|B': { n: 2, c: 0, m: '' } };
    expect(summaryChanges(prev, { 'root|A': { n: 3, c: 1, m: 'x' }, 'root|B': { n: 2, c: 0, m: '' } }).types.size).toBe(0);
    expect(summaryChanges(prev, { 'root|A': { n: 3, c: 2, m: 'y' }, 'root|B': { n: 1, c: 0, m: '' } })).toEqual({ types: new Set(['A', 'B']), counted: new Set(['B']) });
  });

  it('reads code text only, with no comparison on the server', () => {
    const ec = buildReadEc([{ rid: '1', ref: 'lookup(1)', type: 'ExtendedTable', props: ['expression'] }], F);
    expect(ec).toContain('output(_o.expression.whenMissing(""))');
    expect(ec).not.toContain('indexOf');
    expect(ec).toContain('linkedTo.rid');
  });
});
