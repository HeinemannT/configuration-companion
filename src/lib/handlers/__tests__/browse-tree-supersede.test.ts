/**
 * BROWSE_TREE while the user moves through pages: a read for another page
 * from the same panel window ends the older one. The older rid is answered
 * at once as superseded (the panel asks again when it shows that page), its
 * waiting posts get an aborted signal, and nothing else is sent for it. The
 * shared root read (an object window may have joined it) is not aborted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../../types';

const PAGE_A = '9007199254740993001';
const PAGE_B = '9007199254740993002';

const roots = vi.hoisted(() => ({
  pending: new Map<string, (v: unknown) => void>(),
  calls: [] as string[],
}));
vi.mock('../object-window', () => ({
  readObjectRoot: (rid: string) => {
    roots.calls.push(rid);
    return new Promise(resolve => roots.pending.set(rid, resolve));
  },
}));

const payload = (rid: string) => ({
  rid,
  root: { rid, type: 'Scorecard', name: 'Page', businessId: 'page', references: {}, properties: {} },
  rows: [],
  nodes: {},
  posts: 1,
  ms: 1,
});

let getHandler: (type: string) => any;
let signals: Array<{ rid: string; signal?: AbortSignal }>;

beforeEach(async () => {
  vi.resetModules();
  roots.pending.clear();
  roots.calls.length = 0;
  signals = [];
  const { setSwContext } = await import('../../sw-context');
  setSwContext({
    client: {
      serverUrl: 'https://bmp.example.test/W/',
      executeEcOn: vi.fn(async (_code: string, rid: string, signal?: AbortSignal) => {
        signals.push({ rid, signal });
        return { ok: true, log: '' };
      }),
    },
    settings: { activeProfileId: 'p' },
  } as any);
  await import('../browse');
  ({ getHandler } = await import('../../handler-registry'));
});

const flush = () => new Promise(r => setTimeout(r, 0));

describe('BROWSE_TREE supersede', () => {
  it('a read for another page from the same window drops the older one at once', async () => {
    const a: InspectorMessage[] = [];
    const b: InspectorMessage[] = [];
    const runA = getHandler('BROWSE_TREE')({ type: 'BROWSE_TREE', rid: PAGE_A }, (m: InspectorMessage) => a.push(m), { panelWindowId: 1, isOneShot: false });
    await flush();
    const runB = getHandler('BROWSE_TREE')({ type: 'BROWSE_TREE', rid: PAGE_B }, (m: InspectorMessage) => b.push(m), { panelWindowId: 1, isOneShot: false });

    // A is told at once, so the panel never keeps it loading or shows an error.
    expect(a.at(-1)).toMatchObject({ type: 'BROWSE_TREE_DATA', rid: PAGE_A, ok: false, superseded: true });
    expect(signals.find(s => s.rid === PAGE_A)?.signal?.aborted).toBe(true);

    // A's shared root read lands later: nothing more goes out for A.
    const answeredA = a.length;
    roots.pending.get(PAGE_A)!(payload(PAGE_A));
    await runA;
    expect(a).toHaveLength(answeredA);
    expect(a.some(m => m.type === 'BROWSE_TREE_DATA' && m.ok && m.tree)).toBe(false);

    // B is answered as usual.
    await flush();
    roots.pending.get(PAGE_B)!(payload(PAGE_B));
    await runB;
    expect(b.at(-1)).toMatchObject({ type: 'BROWSE_TREE_DATA', rid: PAGE_B, ok: true, tree: { rootRid: PAGE_B } });
    expect(signals.find(s => s.rid === PAGE_B)?.signal?.aborted).toBe(false);
  });

  it('reads of the same page and reads of other windows are not dropped', async () => {
    const a1: InspectorMessage[] = [];
    const a2: InspectorMessage[] = [];
    const other: InspectorMessage[] = [];
    const run1 = getHandler('BROWSE_TREE')({ type: 'BROWSE_TREE', rid: PAGE_A }, (m: InspectorMessage) => a1.push(m), { panelWindowId: 1, isOneShot: false });
    await flush();
    const resolveFirst = roots.pending.get(PAGE_A)!;
    const run2 = getHandler('BROWSE_TREE')({ type: 'BROWSE_TREE', rid: PAGE_A }, (m: InspectorMessage) => a2.push(m), { panelWindowId: 1, isOneShot: false });
    const run3 = getHandler('BROWSE_TREE')({ type: 'BROWSE_TREE', rid: PAGE_B }, (m: InspectorMessage) => other.push(m), { panelWindowId: 2, isOneShot: false });
    await flush();
    expect([...a1, ...a2].some(m => m.type === 'BROWSE_TREE_DATA' && m.superseded)).toBe(false);
    resolveFirst(payload(PAGE_A));
    roots.pending.get(PAGE_A)!(payload(PAGE_A));
    roots.pending.get(PAGE_B)!(payload(PAGE_B));
    await Promise.all([run1, run2, run3]);
    expect(a1.at(-1)).toMatchObject({ ok: true, tree: { rootRid: PAGE_A } });
    expect(a2.at(-1)).toMatchObject({ ok: true, tree: { rootRid: PAGE_A } });
    expect(other.at(-1)).toMatchObject({ ok: true, tree: { rootRid: PAGE_B } });
  });
});
