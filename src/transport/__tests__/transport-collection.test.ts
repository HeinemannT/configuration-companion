/**
 * The transport as a collection, pure: the ordered set by RID, the draft
 * (written, read back, checked), the list grouped by place with its path,
 * the states and the summary line after a comparison, what the objects use,
 * and the model of the map (boxes, connectors counted as objects, missing
 * counts, the fold past twelve places).
 */
import { describe, expect, it } from 'vitest';
import type { PatchCounts, PatchReviewObject } from '../../lib/transport-patch';
import {
  draftKey, draftLine, itemStates, MAP_LEFT_MAX, mapModel, OTHER_PLACES, placeGroups, readDraft, rootOfId, stateCounts, summaryLine, toDraft, TransportCollection, useKind, usesIndex,
  type CollectionItem,
} from '../transport-collection';
import { row } from './fakes';

const ENV = 'p1@https://bmp.example.test/Work/';
const item = (over: Partial<CollectionItem> & { row: CollectionItem['row'] }): CollectionItem => ({ rid: over.row.rid, trail: [], readAt: '2026-11-14T09:00:00.000Z', ...over });

describe('the collection', () => {
  it('an ordered set by RID: adding twice keeps the first, removing is explicit, update keeps the place', () => {
    const c = new TransportCollection();
    const a = item({ row: row({ id: 'a' }) }), b = item({ row: row({ id: 'b' }) });
    expect(c.add(a)).toBe(true);
    expect(c.add(b)).toBe(true);
    expect(c.add({ ...a, trail: [{ id: 'x', name: 'X' }] })).toBe(false);
    expect(c.list().map(i => i.row.id)).toEqual(['a', 'b']);
    expect(c.get(a.rid)!.trail).toEqual([]);
    c.update(a.rid, { gone: true });
    expect(c.rids()).toEqual([a.rid, b.rid]);
    expect(c.get(a.rid)!.gone).toBe(true);
    expect(c.remove(a.rid)).toBe(true);
    expect(c.remove(a.rid)).toBe(false);
    expect(c.size).toBe(1);
    c.replace();
    expect(c.size).toBe(0);
  });

  it('a draft per workspace: written and read back; another workspace or a damaged value is no draft', () => {
    const a = item({ row: row({ id: 'a', linkedTo: 'tpl' }), area: 'portal', trail: [{ id: 'f', name: 'Folder' }], whole: { address: 't.a', ids: ['a'], rids: ['1'] } });
    const b = item({ row: row({ id: 'b' }), gone: true });
    expect(draftKey(ENV)).toBe(`crev_transport_draft:${ENV}`);
    const d = JSON.parse(JSON.stringify(toDraft(ENV, [a, b], '2026-11-15T10:00:00.000Z')));
    expect(readDraft(d, ENV)).toEqual([a, b]);
    expect(readDraft(d, 'p2@https://other.test/')).toBeNull();
    expect(readDraft({ ...d, v: 2 }, ENV)).toBeNull();
    // A draft from before markers were removed: their fields are not read.
    const old = structuredClone(d);
    Object.assign(old.items[0].row, { noTransport: true, noUpdate: true, noDelete: false, markedBy: { noUpdate: 'f', noTransport: 'g' } });
    expect(readDraft(old, ENV)).toEqual([a, b]);
    expect(readDraft(null, ENV)).toBeNull();
    // A damaged object is left out; the RID stays text.
    const bad = { ...d, items: [{ ...d.items[0], row: { ...d.items[0].row, rid: Number('9007199254740993') } }, d.items[1], d.items[1]] };
    expect(readDraft(bad, ENV)!.map(i => i.row.id)).toEqual(['b']);
  });

  it('the draft line: the oldest read, the count; the year only when it is another', () => {
    const now = new Date(2026, 10, 16);
    const items = [item({ row: row(), readAt: '2026-11-14T09:00:00.000Z' }), item({ row: row(), readAt: '2026-11-16T09:00:00.000Z' })];
    expect(draftLine(items, now)).toBe('Draft from 14 Nov, 2 objects');
    expect(draftLine([item({ row: row(), readAt: '2025-12-01T00:00:00.000Z' })], now)).toBe('Draft from 1 Dec 2025, 1 object');
  });
});

describe('places', () => {
  it('grouped by parent; the path from the area and the names above; objects by sibling order', () => {
    const cards = item({ row: row({ id: 'cards', name: 'Cards', parentRid: '5', parentId: 'admin', sortIndex: 2 }), area: 'portal', trail: [{ id: 'admin', name: 'Administration' }] });
    const b = item({ row: row({ id: 'b', parentRid: cards.rid, sortIndex: 1 }), area: 'portal', trail: [] });
    const a = item({ row: row({ id: 'a', parentRid: cards.rid, sortIndex: 0 }), area: 'portal', trail: [] });
    const top = item({ row: row({ id: 'top', parentRid: '1', parentId: 'PORTAL' }) });
    const lone = item({ row: row({ id: 'lone', parentRid: '9', parentId: 'some_folder', parentName: 'Some folder' }) });
    const kpi = item({ row: row({ id: 'kpi', parentRid: '2', parentId: 'PROPERTY' }) });
    const groups = placeGroups([b, cards, a, top, lone, kpi]);
    expect(groups.map(g => [g.path.join(' › '), g.items.map(i => i.row.id)])).toEqual([
      ['Shared web', ['top']],
      ['Shared web › Administration', ['cards']],
      ['Shared web › Administration › Cards', ['a', 'b']],
      ['Properties', ['kpi']],
      ['some_folder · Some folder', ['lone']],
    ]);
    expect(groups[2].topPath).toEqual(['Shared web', 'Administration']);
    expect(groups[1].topKey).toBe(groups[2].topKey);
    expect(rootOfId('TEMPLATECATEGORY')).toBe('templateCategory');
    expect(rootOfId('cards')).toBeUndefined();
  });
});

const counts = (over: Partial<PatchCounts> = {}): PatchCounts => ({ create: 0, change: 0, move: 0, same: 0, rename: 0, delete: 0, targetOnly: 0, leftOut: 0, ...over });

describe('after a comparison', () => {
  it('a state per object with the reason as title; one summary line; compact counts per box', () => {
    const review = [
      { rid: '1', address: 't.a', className: 'X', isNew: false, outcome: 'create', values: [] },
      { rid: '2', address: 't.b', className: 'X', isNew: false, outcome: 'move', values: [], place: { labels: ['moved after t.a'] } },
      { rid: '3', address: 't.c', className: 'X', isNew: false, outcome: 'change', values: [], renamedFrom: 't.old' },
      { rid: '4', address: 't.d', className: 'X', isNew: false, outcome: 'same', values: [] },
    ] as PatchReviewObject[];
    const states = itemStates(review, [{ rid: '5', id: 'e', className: 'X', reason: 'linked-copy', detail: 'A linked copy is not added: link t.tpl under its parent on the target.' }]);
    expect([...states].map(([rid, s]) => [rid, s.state, s.title])).toEqual([
      ['5', 'left', 'A linked copy is not added: link t.tpl under its parent on the target.'], ['1', 'add', undefined], ['2', 'move', 'moved after t.a'], ['3', 'rename', 'From t.old'], ['4', 'same', undefined],
    ]);
    expect(summaryLine(counts({ create: 5, change: 20, move: 2, same: 10 }))).toBe('5 to add · 20 to change · 2 to move · 10 the same');
    expect(summaryLine(counts({ create: 1, delete: 2, leftOut: 1 }))).toBe('1 to add · 2 to delete · 1 left out');
    expect(stateCounts(['1', '1', '4'], states)).toBe('2 to add');
    expect(stateCounts(['4'], states)).toBe('the same');
    expect(stateCounts(['9'], states)).toBe('');
  });
});

describe('uses and the map', () => {
  const texts = [
    { rid: '1', genedit: "t.a.change(id := 'a', list := t.lps, kpi := k.kpi1, expr := 't.b.name + k.kpi2') //X" },
    { rid: '2', genedit: "t.b.change(id := 'b', org := o.org1, kpi := k.kpi1) //X" },
    { rid: '3', genedit: "t.c.change(id := 'c', file := t.f1) //X" },
  ];
  const facts = (k: string) => (k === 't.lps' ? { className: 'ListPropertySet' } : k === 't.f1' ? { className: 'FileResource', name: 'Logo' } : {});

  it('per object the addresses it uses; outside the transport each used object once, with kind, state and who uses it', () => {
    const u = usesIndex(texts, new Set(['t.a', 't.b', 't.c']), facts, k => (k === 'k.kpi2' ? 'missing' : 'target'));
    expect(u.perObject.get('1')).toEqual(['k.kpi1', 'k.kpi2', 't.b', 't.lps']);
    expect(u.outside.map(o => [o.address, o.kind, o.state, o.by])).toEqual([
      ['k.kpi1', 'properties', 'target', ['1', '2']], ['k.kpi2', 'properties', 'missing', ['1']], ['o.org1', 'organisations', 'target', ['2']],
      ['t.f1', 'files', 'target', ['3']], ['t.lps', 'lists', 'target', ['1']],
    ]);
    expect(useKind('t.x', undefined, 'templateCategory')).toBe('templates');
    expect(useKind('t.x', 'ExtendedExpression')).toBe('expressions');
    expect(useKind('t.x')).toBe('other');
  });

  it('two columns: places by weight, kinds of used objects; one connector per pair counted in distinct objects; missing in each', () => {
    const items = [
      item({ row: row({ rid: '1', id: 'a', parentRid: '10', parentId: 'f1' }), area: 'portal', trail: [{ id: 'f1', name: 'Admin' }] }),
      item({ row: row({ rid: '2', id: 'b', parentRid: '10', parentId: 'f1' }), area: 'portal', trail: [{ id: 'f1', name: 'Admin' }] }),
      item({ row: row({ rid: '3', id: 'c', parentRid: '11', parentId: 'PROPERTY' }) }),
    ];
    const groups = placeGroups(items);
    const states = itemStates([{ rid: '1', address: 't.a', className: 'X', isNew: false, outcome: 'create', values: [] }, { rid: '2', address: 't.b', className: 'X', isNew: false, outcome: 'change', values: [] }] as PatchReviewObject[], []);
    const before = mapModel(groups, new Map(), null);
    expect(before.left.map(b => [b.label, b.rids.length, b.counts])).toEqual([['Shared web › Admin', 2, ''], ['Properties', 1, '']]);
    expect(before.right).toEqual([]);
    const u = usesIndex(texts, new Set(['t.a', 't.b', 't.c']), facts, k => (k === 'k.kpi2' ? 'missing' : 'target'));
    const m = mapModel(groups, states, u);
    expect(m.left[0].counts).toBe('1 to add · 1 to change');
    expect(m.right.map(r => [r.label, r.keys.length, r.missing])).toEqual([['Lists', 1, 0], ['Properties', 2, 1], ['Organisations', 1, 0], ['Files', 1, 0]]);
    // k.kpi1 is used by two objects of the same box: one object on the connector.
    expect(m.links.map(l => [l.left === m.left[0].key ? 'admin' : 'props', l.right, l.keys.length, l.missing])).toEqual([
      ['admin', 'lists', 1, 0], ['admin', 'properties', 2, 1], ['admin', 'organisations', 1, 0], ['props', 'files', 1, 0],
    ]);
  });

  it('classes that fit no kind: one box per class, the most objects first, at most six; the rest in "Other objects"', () => {
    const classes = ['CorpoColor', 'CorpoColor', 'CorpoColor', 'Category', 'Category', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
    const refs = classes.map((_, i) => `x${i} := t.u${i}`).join(', ');
    const u = usesIndex([{ rid: '1', genedit: `t.a.change(${refs}) //X` }], new Set(['t.a']), k => ({ className: classes[Number(k.slice(3))] }), () => 'unknown');
    const items = [item({ row: row({ rid: '1', id: 'a', parentRid: '1', parentId: 'PORTAL' }) })];
    const m = mapModel(placeGroups(items), new Map(), u);
    expect(m.right.map(r => [r.label, r.keys.length])).toEqual([
      ['CorpoColor', 3], ['Category', 2], ['A1', 1], ['A2', 1], ['A3', 1], ['A4', 1], ['Other objects', 2],
    ]);
    expect(m.links.map(l => l.right)).toContain('class:CorpoColor');
  });

  it('past twelve places, the rest in one box "Other places (n)"', () => {
    const items = Array.from({ length: 15 }, (_, i) => item({ row: row({ id: `o${i}`, parentRid: String(100 + i), parentId: `f${i}` }), area: 'portal', trail: [{ id: `f${i}`, name: `Folder ${String(i).padStart(2, '0')}` }] }));
    const m = mapModel(placeGroups(items), new Map(), null);
    expect(m.left).toHaveLength(MAP_LEFT_MAX);
    expect(m.left.at(-1)).toMatchObject({ key: OTHER_PLACES, label: 'Other places (4)' });
    expect(m.left.at(-1)!.rids).toHaveLength(4);
  });
});
