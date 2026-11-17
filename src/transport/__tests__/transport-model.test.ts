/** The Transport window's pure helpers: dates, short times, users, the
 *  download name, numeric IDs, the patch summary, and the list as a tree. */
import { describe, expect, it } from 'vitest';
import { TRANSPORT_DEFAULT_ROOTS, TRANSPORT_ROOTS } from '../../lib/transport-bundle';
import {
  AREA_LABELS, AREA_ORDER, areasSummary, buildGroupTree, bundleSummary, CONTEXT, dayText, defaultSince, downloadName, fileSafe, hasShownChildren, HIDDEN,
  isNumericId, MATCH,
  patchSummary, shortTime, showTree, subtreeCount, usersOf, visibleNodes,
} from '../transport-model';
import { row } from './fakes';

describe('transport model', () => {
  it('lists every root once, defaults first', () => {
    expect([...AREA_ORDER].sort()).toEqual([...TRANSPORT_ROOTS].sort());
    expect(AREA_ORDER.slice(0, TRANSPORT_DEFAULT_ROOTS.length).sort()).toEqual([...TRANSPORT_DEFAULT_ROOTS].sort());
    expect(Object.keys(AREA_LABELS).sort()).toEqual([...TRANSPORT_ROOTS].sort());
  });

  it('defaults to seven days ago and prints days and times shortly', () => {
    expect(defaultSince(new Date(2026, 10, 15, 9))).toBe('2026-11-08');
    expect(defaultSince(new Date(2026, 2, 3))).toBe('2026-02-24');
    expect(dayText('2026-11-08')).toBe('8 Nov 2026');
    const now = new Date(2026, 10, 15);
    expect(shortTime('2026-11-14T10:05:00', 'Nov 14, 2026 10:05:00', now)).toBe('14 Nov 10:05');
    expect(shortTime('2025-03-01T08:00:00', 'Mar 1, 2025 08:00:00', now)).toBe('1 Mar 2025');
    expect(shortTime(undefined, 'yesterday-ish', now)).toBe('yesterday-ish');
  });

  it('summarises areas and bundles', () => {
    expect(areasSummary(new Set(TRANSPORT_DEFAULT_ROOTS))).toBe('10 areas');
    expect(areasSummary(new Set(['role'] as const))).toBe('Roles');
    expect(areasSummary(new Set())).toBe('No areas');
    expect(bundleSummary(12, 5, 6)).toBe('12 objects, 5 new, in 6 parts');
    expect(bundleSummary(1, 0, 1)).toBe('1 object, 0 new, in 1 part');
    expect(bundleSummary(3, null, 4)).toBe('3 objects in 4 parts');
  });

  it('builds the user list from the rows', () => {
    const users = usersOf([row({ modifiedBy: 'Zed', modifiedById: 'u9' }), row({ modifiedBy: 'Amy', modifiedById: 'u2' }), row({ modifiedBy: 'Zed', modifiedById: 'u9' }), row({ modifiedBy: '', modifiedById: '' })]);
    expect(users).toEqual([{ key: 'u2', label: 'Amy' }, { key: 'u9', label: 'Zed' }]);
  });

  it('makes a file-safe download name', () => {
    expect(downloadName('Demo DEV', '2026-11-08')).toBe('transport-Demo-DEV-2026-11-08.txt');
    expect(downloadName('Prüfung / Test: 2', '2026-11-08')).toBe('transport-Prufung-Test-2-2026-11-08.txt');
    expect(downloadName('', '2026-11-08')).toBe('transport-workspace-2026-11-08.txt');
    expect(downloadName('Demo DEV', '2026-11-08', 'probe')).toBe('transport-probe-Demo-DEV-2026-11-08.txt');
    expect(downloadName('Demo DEV', '2026-11-08', 'patch')).toBe('transport-patch-Demo-DEV-2026-11-08.txt');
    expect(downloadName('Demo DEV', 'my_module-2026-11-08', 'probe')).toBe('transport-probe-Demo-DEV-my_module-2026-11-08.txt');
    expect(fileSafe('..\\..\\x')).toBe('x');
    expect(fileSafe('a'.repeat(100))).toHaveLength(60);
  });

  it('tells a numeric ID from a named one', () => {
    expect(isNumericId({ id: '40213' })).toBe(true);
    expect(isNumericId({ id: 'el_40213' })).toBe(false);
    expect(isNumericId({ id: '' })).toBe(false);
  });

  it('summarises a patch without counts of zero', () => {
    const none = { create: 0, change: 0, move: 0, same: 0, rename: 0, delete: 0, targetOnly: 0, leftOut: 0 };
    expect(patchSummary({ ...none, create: 2, change: 3, move: 4, same: 5, leftOut: 1 })).toBe('2 to add · 3 to change · 4 to move · 5 the same · 1 left out');
    expect(patchSummary({ ...none, change: 1 })).toBe('1 to change');
    expect(patchSummary({ ...none, rename: 1, delete: 3, targetOnly: 9 })).toBe('3 to delete · 1 ID to change');
    expect(patchSummary(none)).toBe('No objects');
  });
});

describe('the list as a tree', () => {
  const P = '9007199254740001', Q = '9007199254740002';
  const ids = (nodes: ReadonlyArray<{ id: string }>) => nodes.map(n => n.id);

  it('nests a row under its parent row, siblings by sort index; a parent off the list is a context line; rows under the root are first level', () => {
    const folder = row({ id: 'folder', parentRid: P, parentId: 'PORTAL', sortIndex: 2 });
    const b = row({ id: 'b', parentRid: folder.rid, parentId: 'folder', sortIndex: 1 });
    const a = row({ id: 'a', parentRid: folder.rid, parentId: 'folder', sortIndex: 0 });
    const top = row({ id: 'top', parentRid: P, parentId: 'portal', sortIndex: 1 });
    const orphan = row({ id: 'orphan', parentRid: Q, parentId: 'elsewhere', parentName: 'Elsewhere' });
    const loose = row({ id: 'loose' });
    const rows = [b, orphan, folder, a, top, loose];
    const tree = buildGroupTree(rows, { rootIds: ['portal'] });
    expect(ids(tree.tops)).toEqual(['loose', 'top', 'folder', 'elsewhere']);
    expect(ids(tree.order)).toEqual(['loose', 'top', 'folder', 'a', 'b', 'elsewhere', 'orphan']);
    expect(tree.order.map(n => n.depth)).toEqual([0, 0, 0, 1, 1, 0, 1]);
    const ctx = tree.byKey.get(`p:${Q}`)!;
    expect(ctx).toMatchObject({ rid: Q, id: 'elsewhere', name: 'Elsewhere' });
    expect(ctx.row).toBeUndefined();
    const f = tree.byKey.get(folder.rid)!;
    expect(tree.order.slice(f.index, f.end).map(n => n.id)).toEqual(['folder', 'a', 'b']);
    // The same rows in another order give the same tree.
    expect(ids(buildGroupTree([...rows].reverse(), { rootIds: ['PORTAL'] }).order)).toEqual(ids(tree.order));
  });

  it('under an object the starting object is the one top node, a context line when it is not among the rows; a cycle is cut', () => {
    const start = row({ id: 'start', parentRid: P });
    const kid = row({ id: 'kid', parentRid: start.rid });
    const deep = row({ id: 'deep', parentRid: Q, parentId: 'mid', parentName: 'Mid' });
    const t = buildGroupTree([kid, deep], { top: { rid: start.rid, id: 'start', name: 'Start' } });
    expect(ids(t.tops)).toEqual(['start']);
    expect(t.tops[0].row).toBeUndefined();
    expect(t.order.map(n => `${n.depth}:${n.id}`)).toEqual(['0:start', '1:kid', '1:mid', '2:deep']);
    const withRow = buildGroupTree([start, kid], { top: { rid: start.rid, id: 'start', name: 'Start' } });
    expect(withRow.tops[0].row).toBe(start);
    const x = row({ id: 'x' }), y = row({ id: 'y' });
    x.parentRid = y.rid; y.parentRid = x.rid;
    const cyc = buildGroupTree([x, y]);
    expect(cyc.order).toHaveLength(2);
    expect(cyc.tops).toHaveLength(1);
  });

  it('shows matches with their ancestors (context), hides the rest; the subtree count leaves out numeric IDs; closed nodes hide their children', () => {
    const f = row({ id: 'folder' });
    const m = row({ id: 'match_me', parentRid: f.rid });
    const n = row({ id: '123', parentRid: f.rid });
    const k = row({ id: 'keep', parentRid: f.rid });
    const o = row({ id: 'other' });
    const tree = buildGroupTree([f, m, n, k, o]);
    const all = showTree(tree, () => true);
    const fn = tree.byKey.get(f.rid)!;
    expect(subtreeCount(fn, all)).toBe(3);
    expect(hasShownChildren(fn, all)).toBe(true);
    expect(ids(visibleNodes(tree, all, () => false))).toEqual(['folder', '123', 'keep', 'match_me', 'other']);
    expect(ids(visibleNodes(tree, all, x => x === fn))).toEqual(['folder', 'other']);
    expect(ids(visibleNodes(tree, all, () => false, fn))).toEqual(['123', 'keep', 'match_me']);
    const some = showTree(tree, r => r.id === 'match_me');
    expect(ids(visibleNodes(tree, some, () => false))).toEqual(['folder', 'match_me']);
    expect([some.state[fn.index], some.state[tree.byKey.get(m.rid)!.index]]).toEqual([CONTEXT, MATCH]);
    expect(some.state[tree.byKey.get(o.rid)!.index]).toBe(HIDDEN);
    expect(subtreeCount(fn, some)).toBe(1);
  });

  it('builds and shows 10,000 rows quickly', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => row({ id: `r${i}`, parentRid: i < 100 ? '' : `${9_007_199_254_740_993n + BigInt(Math.floor(i / 100))}` }));
    const t0 = performance.now();
    const tree = buildGroupTree(rows);
    const show = showTree(tree, r => r.id.endsWith('7'));
    visibleNodes(tree, show, () => false);
    expect(tree.order).toHaveLength(10_000 + tree.order.filter(n => !n.row).length);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});
