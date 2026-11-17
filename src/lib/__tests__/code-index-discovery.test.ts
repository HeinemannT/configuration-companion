/**
 * Code index: which properties hold code (asked from the server), the index
 * state machine, cancel safety, and the object picker's rows.
 */
import { describe, expect, it, vi } from 'vitest';
import { STATIC_EC_FRAME as F } from '../ec-parser';
import { buildExistsEc, discoverCodeProps, parseExistsLog, syncCodeIndex, type DiscoveryClient, type IndexClient } from '../code-index-sync';
import { MemoryCodeIndexStore } from '../code-index-store';
import { compareHits, type CodeSearchHit } from '../code-search';
import { pickerRows, typedReference } from '../object-picker';
import type { FullObject } from '../object-read';
import { framedText as __framedText } from '../ec-parser';
/** One length-framed row (ec-parser). */
const R = (...f: unknown[]) => __framedText([f.map(String)], false);

vi.mock('../sw-context', () => ({ getCtx: () => ({}) }));
vi.mock('../messaging', () => ({ sendFireForget: vi.fn() }));
const { indexState } = await import('../code-index-service');

const code = (text: string) => ({ kind: 'code' as const, text });
const full = (rid: string, type: string, props: FullObject['props']): FullObject => ({ rid, type, name: rid, businessId: rid, props, references: {}, overridden: [] });

function client(over: Partial<IndexClient & DiscoveryClient> = {}): IndexClient & DiscoveryClient & { scripts: string[]; fullReads: string[][] } {
  const scripts: string[] = [];
  const fullReads: string[][] = [];
  return {
    scripts,
    fullReads,
    ensureLookupSupport: async () => true,
    resolveRefs: async rids => new Map(rids.map(r => [r, `lookup(${r})`])),
    fetchTypeCatalogue: async () => ({ types: {
      ButtonInput: { parents: [], concrete: true }, MyCustomInput: { parents: [], concrete: true }, OtherPage: { parents: [], concrete: true },
      AbstractInput: { parents: [], concrete: false }, 'bad.nameInput': { parents: [], concrete: true }, CeRiskAssessment: { parents: [], concrete: true },
      NoObjectsView: { parents: [], concrete: true },
    }, models: {} }),
    readFullObjects: async rids => {
      fullReads.push([...rids]);
      return {
        objects: Object.fromEntries(rids.map(r => [r, r === '101'
          ? full(r, 'MyCustomInput', { showExpression: code('t.x'), enableExpression: { kind: 'code', text: '' }, name: { kind: 'text', text: 'b' } })
          : full(r, 'OtherPage', { afterExpression: code('_a := 1'), title: { kind: 'text', text: 'x' } })])),
        errors: {},
      };
    },
    executeEcBatch: async codes => {
      scripts.push(...codes);
      return codes.map(c => {
        if (c.includes('_f := ""')) {
          const rows = [c.includes('SELECT MyCustomInput') ? 'MyCustomInput|101' : '', c.includes('SELECT OtherPage') ? 'OtherPage|201' : '', c.includes('SELECT NoObjectsView') ? 'NoObjectsView|' : ''].filter(Boolean);
          return { ok: true, log: `${rows.join('\n')}\n#DONE` };
        }
        if (c.includes('_x := root.')) return { ok: true, log: `${R(`R`, `portal`, `1`, `Portal`, ``)}${F.done}` };
        return { ok: true, log: F.done };
      });
    },
    ...over,
  };
}

describe('discovering code properties from the server, gently', () => {
  it('asks only about unknown types named like configuration types, one list at a time', () => {
    const ec = buildExistsEc(['MyCustomInput', 'OtherPage'], ['root', 'root.portal']);
    expect(ec.match(/_l := SELECT/g)).toHaveLength(4);
    expect(ec.match(/_l := ""/g)).toHaveLength(4);
    expect(() => buildExistsEc(['bad.name'], ['root'])).toThrow();
    expect(parseExistsLog('Result : MyCustomInput|101\nOtherPage|\n#DONE')).toEqual(new Map([['MyCustomInput', '101']]));
  });

  it('samples one object of each unknown type with objects, two objects a read, and keeps the known table', async () => {
    const c = client();
    const d = await discoverCodeProps(c, new AbortController().signal);
    expect(c.scripts.join('\n')).not.toContain('SELECT ButtonInput'); // known: not asked
    expect(c.scripts.join('\n')).not.toContain('CeRiskAssessment'); // not a configuration name
    expect(c.fullReads).toEqual([['101', '201']]);
    expect(d.map.MyCustomInput).toEqual(['showExpression', 'enableExpression']); // an empty code slot names a code property too
    expect(d.map.OtherPage).toEqual(['afterExpression']);
    expect(d.map.ExtendedTable).toEqual(['expression']); // the known table stays
    expect(d).toMatchObject({ types: 6, withObjects: 2, sampled: 2 });
  });

  it('keeps the list per server and extension version, until the user forces it', async () => {
    const c = client();
    const store = new MemoryCodeIndexStore();
    await syncCodeIndex(c, store, 'p@u', { signal: new AbortController().signal, now: () => 1, version: '1.0' });
    const meta = await store.getMeta('p@u');
    expect(meta?.codeProps?.OtherPage).toEqual(['afterExpression']);
    expect(meta?.discoveryKey).toBe('v1.0');
    // Listed with the discovered types.
    expect(c.scripts.some(s => s.includes('SELECT OtherPage FROM _g'))).toBe(true);
    const again = client({ fetchTypeCatalogue: vi.fn(async () => { throw new Error('should not be asked'); }) });
    await syncCodeIndex(again, store, 'p@u', { signal: new AbortController().signal, now: () => 2, version: '1.0', full: true });
    expect(again.fetchTypeCatalogue).not.toHaveBeenCalled();
    const newer = client();
    const spy = vi.spyOn(newer, 'fetchTypeCatalogue');
    await syncCodeIndex(newer, store, 'p@u', { signal: new AbortController().signal, now: () => 3, version: '1.1', full: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('names a failed inspection and keeps the known list', async () => {
    const store = new MemoryCodeIndexStore();
    await syncCodeIndex(client({ fetchTypeCatalogue: async () => { throw new Error('denied'); } }), store, 'p@u', { signal: new AbortController().signal });
    expect((await store.getMeta('p@u'))?.discovery?.error).toBe('denied');
  });

  it('never writes after it was cancelled', async () => {
    const store = new MemoryCodeIndexStore();
    const ac = new AbortController();
    const c = client({ executeEcBatch: async codes => { ac.abort(); return codes.map(() => ({ ok: true, log: F.done })); } });
    await expect(syncCodeIndex(c, store, 'p@u', { signal: ac.signal })).rejects.toThrow();
    expect(await store.getMeta('p@u')).toBeNull();
  });
});

describe('index state machine', () => {
  const meta = (o: object) => ({ env: 'e', syncedAt: null, builtAt: null, objects: 10, bytes: 1, types: [], pending: 4, ...o });
  it('tells building, paused, failed, ready and refreshing apart', () => {
    const running = Promise.resolve();
    expect(indexState(null, { sync: null })).toBe('none');
    expect(indexState(meta({}), { sync: running })).toBe('building');
    expect(indexState(meta({}), { sync: null, stopped: true, error: 'x' })).toBe('paused');
    expect(indexState(meta({}), { sync: null })).toBe('paused');
    expect(indexState(meta({}), { sync: null, error: 'timed out' })).toBe('failed');
    expect(indexState(meta({ builtAt: 5, pending: 0 }), { sync: null })).toBe('ready');
    expect(indexState(meta({ builtAt: 5 }), { sync: running })).toBe('refreshing');
    expect(indexState(meta({ builtAt: 5 }), { sync: null, unavailable: true })).toBe('unavailable');
  });
});

describe('result order', () => {
  const h = (rid: string, name: string, matches: number, where: string): CodeSearchHit => ({ rid, type: 'T', name, businessId: rid, where, matches, props: [] });
  it('sorts by matches, name or location', () => {
    const hits = [h('1', 'b', 2, 'Z'), h('2', 'a', 5, 'Y'), h('3', 'c', 2, 'X')];
    expect([...hits].sort(compareHits('matches')).map(x => x.rid)).toEqual(['2', '1', '3']);
    expect([...hits].sort(compareHits('name')).map(x => x.rid)).toEqual(['2', '1', '3']);
    expect([...hits].sort(compareHits('location')).map(x => x.rid)).toEqual(['3', '2', '1']);
  });
});

describe('object picker rows', () => {
  const cur = { rid: '1', name: 'Current' };
  it('offers the current and recent objects before typing, a typed reference and hits after', () => {
    expect(pickerRows('', { current: cur, recent: [cur, { rid: '2', name: 'R' }] }, null).map(r => [r.group, r.obj?.rid])).toEqual([['Current object', '1'], ['Recent', '2']]);
    expect(pickerRows('t.assessment_basis_values', { recent: [] }, [{ rid: '3' }]).map(r => r.key)).toEqual(['t:t.assessment_basis_values', 's:3']);
    expect(typedReference('2877899500232289329')).toBe('2877899500232289329');
    expect(typedReference('risk')).toBeNull();
  });
});
