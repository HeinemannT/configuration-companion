import { describe, expect, it, vi } from 'vitest';
import type { FullObject } from '../object-read';
import { assembleStructure, buildStructureEc, parseStructureRows } from '../object-structure';
import { openObjectRoot, RootReadError, type ObjectReader } from '../object-window';

function obj(rid: string, type: string, extra: Partial<FullObject> = {}): FullObject {
  return { rid, type, name: `${type} ${rid.slice(-3)}`, businessId: rid.slice(-4), props: {}, references: {}, overridden: [], ...extra };
}

const VIEW = '1304972940111718401';
const SET = '1521507040334396171';
const GROUP = '5228949194259858465';
const BTN = '2081208944661642130';
const MAIL = '5228949194259867602';

describe('structure EC', () => {
  it('follows the via accessor and walks the requested levels', () => {
    const ec = buildStructureEc(`lookup(${VIEW})`, { via: 'inputSet', depth: 3 });
    expect(ec).toContain('_s := _o.inputSet');
    expect(ec).toContain('_s.children().forEach(_c1:');
    expect(ec).toContain('_c2.children().forEach(_c3:');
    expect(ec).not.toContain('_c4');
    expect(ec.trim().endsWith('_r')).toBe(true);
  });

  it('rejects an unsafe accessor', () => {
    expect(() => buildStructureEc('lookup(1)', { via: 'x); delete(', depth: 1 })).toThrow();
  });

  it('parses rows, dropping malformed and duplicate lines', () => {
    const rows = parseStructureRows(`${SET}|||${VIEW}\ngarbage\n${BTN}|||${SET}\n${BTN}|||${SET}\nMISSING|||${SET}\n`);
    expect(rows).toEqual([{ rid: SET, parent: VIEW }, { rid: BTN, parent: SET }]);
  });
});

describe('assembleStructure', () => {
  const rows = [
    { rid: SET, parent: VIEW }, { rid: GROUP, parent: SET }, { rid: BTN, parent: GROUP }, { rid: MAIL, parent: BTN },
    { rid: '999999999999', parent: '111111111111' },
  ];

  it('builds a pre-order tree; nodes without a read stay in place with obj null', () => {
    const tree = assembleStructure(obj(VIEW, 'InputView'), rows, { [SET]: obj(SET, 'InputSet'), [BTN]: obj(BTN, 'ButtonInput') });
    expect(tree.order).toEqual([VIEW, SET, GROUP, BTN, MAIL]);
    expect(tree.nodes[MAIL].depth).toBe(4);
    expect(tree.nodes[GROUP].obj).toBeNull();
    expect(tree.nodes['999999999999']).toBeUndefined();
  });

  it('is root-only when the listing failed', () => {
    const tree = assembleStructure(obj(VIEW, 'InputView'), null, {});
    expect(tree.order).toEqual([VIEW]);
    expect(tree.nodes[VIEW].children).toEqual([]);
  });
});

describe('openObjectRoot', () => {
  function reader(overrides: Partial<ObjectReader> = {}): ObjectReader & { reads: string[][] } {
    const all: Record<string, FullObject> = {
      [VIEW]: obj(VIEW, 'InputView'), [SET]: obj(SET, 'InputSet'), [BTN]: obj(BTN, 'ButtonInput'),
    };
    const reads: string[][] = [];
    return {
      reads,
      readFullObjects: vi.fn(async (rids: readonly string[]) => {
        reads.push([...rids]);
        const objects: Record<string, FullObject> = {};
        for (const r of rids) if (all[r]) objects[r] = all[r];
        return { objects, errors: {} };
      }),
      fetchStructureRows: vi.fn(async () => [{ rid: SET, parent: VIEW }, { rid: BTN, parent: SET }]),
      ...overrides,
    };
  }

  it('with a type hint: one listing, then ONE batched read of root + nodes', async () => {
    const r = reader();
    const p = await openObjectRoot(r, VIEW, 'InputView');
    expect(r.fetchStructureRows).toHaveBeenCalledWith(VIEW, { via: 'inputSet', depth: 3 }, undefined);
    expect(r.reads).toEqual([[VIEW, SET, BTN]]);
    expect(p.posts).toBe(2);
    expect(p.root.rid).toBe(VIEW);
    expect(Object.keys(p.nodes).sort()).toEqual([BTN, SET].sort());
  });

  it('without a hint: reads the root first, then lists and batches the nodes', async () => {
    const r = reader();
    const p = await openObjectRoot(r, VIEW);
    expect(r.reads).toEqual([[VIEW], [SET, BTN]]);
    expect(p.posts).toBe(3);
  });

  it('unknown type: root only, no listing', async () => {
    const r = reader({ readFullObjects: vi.fn(async () => ({ objects: { '123456789': obj('123456789', 'BrandNewWidget') }, errors: {} })) });
    const p = await openObjectRoot(r, '123456789');
    expect(r.fetchStructureRows).not.toHaveBeenCalled();
    expect(p.rows).toBeNull();
    expect(p.posts).toBe(1);
  });

  it('a failed listing is soft: the root still opens', async () => {
    const r = reader({ fetchStructureRows: vi.fn(async () => { throw new Error('EC: unknown accessor inputSet'); }) });
    const p = await openObjectRoot(r, VIEW, 'InputView');
    expect(p.rows).toBeNull();
    expect(p.structureError).toContain('inputSet');
    expect(p.root.rid).toBe(VIEW);
    expect(r.reads).toEqual([[VIEW]]);
  });

  it('a node batch that fails on a connection error falls back to reading the root alone', async () => {
    let calls = 0;
    const r = reader();
    const inner = r.readFullObjects;
    r.readFullObjects = vi.fn(async (rids: readonly string[], signal?: AbortSignal) => {
      if (calls++ === 0) throw new Error('Not connected to BMP');
      return inner(rids, signal);
    });
    const p = await openObjectRoot(r, VIEW, 'InputView');
    expect(p.root.rid).toBe(VIEW);
    expect(p.nodes).toEqual({});
    expect(p.nodeErrors?.[SET]).toContain('Not connected');
  });

  it('a batch that one node fails is halved until that node is isolated; the rest loads', async () => {
    const r = reader();
    const inner = r.readFullObjects;
    r.readFullObjects = vi.fn(async (rids: readonly string[], signal?: AbortSignal) => {
      if (rids.includes(SET)) { r.reads.push([...rids]); throw new Error('ObjectProfileMappingImpl cannot be cast to BusinessTreeObject'); }
      return inner(rids, signal);
    });
    const p = await openObjectRoot(r, VIEW, 'InputView');
    expect(p.root.rid).toBe(VIEW);
    expect(Object.keys(p.nodes)).toEqual([BTN]);
    expect(p.nodeErrors).toEqual({ [SET]: 'ObjectProfileMappingImpl cannot be cast to BusinessTreeObject' });
    // [VIEW, SET, BTN] → [VIEW, SET] → [VIEW] ok, [SET] fails → [BTN] ok.
    expect(r.reads).toEqual([[VIEW, SET, BTN], [VIEW, SET], [VIEW], [SET], [BTN]]);
    expect(p.posts).toBe(1 + 5);
  });

  it('a root that fails on its own after isolation is fatal', async () => {
    const r = reader();
    r.readFullObjects = vi.fn(async (rids: readonly string[]) => {
      if (rids.includes(VIEW)) throw new Error('ClassCastException');
      return { objects: {}, errors: {} };
    });
    await expect(openObjectRoot(r, VIEW, 'InputView')).rejects.toBeInstanceOf(RootReadError);
  });

  it('a hinted batch that reports the root missing is not followed by a second root read', async () => {
    const r = reader({ readFullObjects: vi.fn(async () => ({ objects: {}, errors: { [VIEW]: 'Object not found' } })) });
    await expect(openObjectRoot(r, VIEW, 'InputView')).rejects.toThrow('Object not found');
    expect(r.readFullObjects).toHaveBeenCalledTimes(1);
    expect(r.fetchStructureRows).toHaveBeenCalledTimes(1);
  });

  it('only a failed root read is fatal', async () => {
    const r = reader({ readFullObjects: vi.fn(async () => ({ objects: {}, errors: { [VIEW]: 'Object not found' } })) });
    await expect(openObjectRoot(r, VIEW)).rejects.toBeInstanceOf(RootReadError);
  });
});
