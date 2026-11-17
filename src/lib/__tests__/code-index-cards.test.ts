/**
 * The light records of the code index (`cards`): syncs, the object pickers
 * and "Used in code" read them instead of every object's code, with the same
 * answers. Measured on a synthetic index: what each question reads.
 */
import { describe, expect, it } from 'vitest';
import { cardOf, MemoryCodeIndexStore, upgradeCodeIndexDb, type IndexedObject } from '../code-index-store';
import { indexSource, runCodeSearch, type CodeSearchHit } from '../code-search';
import { refsOf, syncCodeIndex } from '../code-index-sync';
import { usedInCodeFrom } from '../used-in-code';
import { goldenWorld } from './code-search-world';
import { server } from './code-search-sim';

const resolveKeys = async (keys: string[]) => Object.fromEntries(keys.map(k => [k, k === 't.e1'
  ? { found: true as const, target: { rid: '3', type: 'ExtendedExpression', name: '', businessId: 'e1' } }
  : { found: false as const }]));

async function builtIndex() {
  const { objects, orgs } = goldenWorld();
  const store = new MemoryCodeIndexStore();
  await syncCodeIndex(server(objects, { orgs }), store, 'e', { signal: new AbortController().signal, now: () => 1 });
  return store;
}

/** A synthetic index: 5,000 objects, 2-8 KB of code each. */
function bigIndex(): MemoryCodeIndexStore {
  const store = new MemoryCodeIndexStore();
  const list: IndexedObject[] = [];
  for (let i = 0; i < 5_000; i++) {
    const code = { expression: `_x := t.e1.expression\n${'_rows := SELECT CeRisk WHERE owner = this.user\n'.repeat(40 + (i % 120))}` };
    list.push({ env: 'e', rid: String(9_000_000_000_000_000_000n + BigInt(i)), type: 'ExtendedTable', name: `T ${i}`, businessId: `t${i}`, where: 'A › B', stamp: 's', len: code.expression.length, code, refs: refsOf(code), root: 'templateCategory' });
  }
  void store.put(list);
  return store;
}

describe('code index light records', () => {
  it('a card is the object without its code, with its code property names', () => {
    const o: IndexedObject = { env: 'e', rid: '9007199254740993', type: 'T', name: 'n', businessId: 'b', where: 'w', stamp: 's', len: 3, code: { expression: 'abc' }, refs: [], tmpl: '1', inherits: ['showExpression'] };
    expect(cardOf(o)).toEqual({ env: 'e', rid: '9007199254740993', type: 'T', name: 'n', businessId: 'b', where: 'w', stamp: 's', len: 3, refs: [], tmpl: '1', inherits: ['showExpression'], props: ['expression'] });
  });

  it('a sync reads stamps without loading any code', async () => {
    const store = await builtIndex();
    const before = { ...store.reads };
    const stamps = await store.stamps('e');
    expect(stamps.size).toBeGreaterThan(300);
    expect(store.reads.objects).toBe(before.objects);
    // A refresh after the build reads no object either.
    const { objects, orgs } = goldenWorld();
    const r0 = store.reads.objects;
    await syncCodeIndex(server(objects, { orgs }), store, 'e', { signal: new AbortController().signal, now: () => 2 });
    expect(store.reads.objects).toBe(r0);
  });

  it('"Used in code" from the cards gives the answer of a search over every object', async () => {
    const store = await builtIndex();
    const meta = await store.getMeta('e');
    const all: IndexedObject[] = [];
    await store.scan('e', b => { all.push(...b); });
    const full: CodeSearchHit[] = [];
    await runCodeSearch({ mode: 'refs', target: { rid: '3', businessId: 'e1' }, limit: 500 }, indexSource(meta, each => { each(all); return Promise.resolve(); }), h => full.push(...h), { resolveKeys });
    const cards: ReturnType<typeof cardOf>[] = [];
    await store.scanCards('e', b => { cards.push(...b); });
    const read0 = store.reads.objects;
    const fromCards = await usedInCodeFrom(store, 'e', cards, { rid: '3', businessId: 'e1' }, resolveKeys, meta);
    expect(fromCards).toEqual(full);
    expect(full.length).toBeGreaterThan(50);
    // Only the callers and their templates were read in full.
    expect(store.reads.objects - read0).toBeLessThan(all.length);
  });

  it('on a large index the small questions read a fraction of the bytes', async () => {
    const store = bigIndex();
    const r = () => ({ ...store.reads });
    const a = r();
    await store.scan('e', () => {});
    const whole = store.reads.chars - a.chars;
    const b = r();
    await store.stamps('e');
    const stampsChars = store.reads.chars - b.chars;
    console.log(`5,000 objects: whole index ${(whole / 1e6).toFixed(1)} M chars; stamps/picker from cards ${(stampsChars / 1e6).toFixed(1)} M chars`);
    expect(stampsChars).toBeLessThan(whole / 4);
  }, 60_000);
});

describe('"Used in code" with a complete copy: names answered from the copy', () => {
  const obj = (rid: string, type: string, businessId: string, code: string): IndexedObject => ({ env: 'e', rid, type, name: businessId, businessId, where: '', stamp: 's', len: code.length, code: { expression: code }, refs: refsOf({ expression: code }) });
  const target = { rid: '9100000000000000001', businessId: 'rate', type: 'ExtendedExpression' };
  const world = [
    obj(target.rid, 'ExtendedExpression', 'rate', '_r := 0.2'),
    obj('9100000000000000002', 'ExtendedExpression', 'calls_t', '_x := t.rate.calculate()'),
    // `k.rate`: the property namespace; no property `rate` is in the copy.
    obj('9100000000000000003', 'ExtendedExpression', 'calls_k', '_x := k.rate'),
  ];
  const complete = { env: 'e', builtAt: 1, syncedAt: 1, objects: 3, bytes: 0, types: [], pending: 0 };
  async function run(objects: IndexedObject[], meta = complete) {
    const store = new MemoryCodeIndexStore();
    await store.put(objects);
    const asked: string[][] = [];
    const resolve = async (keys: string[]) => { asked.push([...keys].sort()); return Object.fromEntries(keys.map(k => [k, { found: false as const }])); };
    const hits = await usedInCodeFrom(store, 'e', objects.map(cardOf), target, resolve, meta);
    return { asked, hits: hits.map(h => h.businessId) };
  }

  it("the target's own namespace names the target, another namespace does not: nothing is asked", async () => {
    expect(await run(world)).toEqual({ asked: [], hits: ['calls_t'] });
  });

  it('two objects with the ID in that namespace, or a copy that is not complete: the server is asked', async () => {
    const twin = obj('9100000000000000004', 'Category', 'rate', '_c := 1');
    expect((await run([...world, twin])).asked).toEqual([['t.rate']]);
    expect((await run(world, { ...complete, pending: 2 })).asked).toEqual([['k.rate', 't.rate']]);
  });

  it('without the target class every name is asked', async () => {
    const store = new MemoryCodeIndexStore();
    const others = world.slice(1);
    await store.put(others);
    const asked: string[][] = [];
    await usedInCodeFrom(store, 'e', others.map(cardOf), { rid: target.rid, businessId: 'rate' }, async keys => { asked.push([...keys].sort()); return {}; }, complete);
    expect(asked).toEqual([['k.rate', 't.rate']]);
  });
});

describe('opening an index built before the cards', () => {
  it('fills the cards from the stored objects in the upgrade, without a rebuild', () => {
    const stored: IndexedObject[] = [
      { env: 'e', rid: '9007199254740993', type: 'T', name: 'a', businessId: 'a', where: '', stamp: 's1', len: 1, code: { expression: 'x' }, refs: [] },
      { env: 'e', rid: '9007199254740995', type: 'T', name: 'b', businessId: 'b', where: '', stamp: 's2', len: 1, code: {}, refs: [], tmpl: '9007199254740993', inherits: ['expression'] },
    ];
    const created: Record<string, unknown[]> = {};
    const names = new Set(['objects', 'meta']);
    const db = {
      objectStoreNames: { contains: (n: string) => names.has(n) },
      createObjectStore: (n: string) => { names.add(n); created[n] = []; return { put: (v: unknown) => { created[n].push(v); } }; },
    };
    let i = 0;
    const cursorReq: { result: unknown; onsuccess: (() => void) | null } = { result: null, onsuccess: null };
    const step = () => { cursorReq.result = i < stored.length ? { value: stored[i], continue: () => { i++; step(); } } : null; cursorReq.onsuccess?.(); };
    const tx = { objectStore: () => ({ openCursor: () => { queueMicrotask(step); return cursorReq; } }) };
    upgradeCodeIndexDb(db as never, tx as never, 1);
    return new Promise<void>(resolve => setTimeout(() => {
      expect(created.cards).toEqual(stored.map(cardOf));
      expect(created.objects).toBeUndefined();
      resolve();
    }, 0));
  });
});
