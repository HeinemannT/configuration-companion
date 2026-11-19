import { describe, expect, it } from 'vitest';
import type { NumericContextRow, TransportOrigin, TransportScanRow } from '../../lib/transport-read';
import { MATCH } from '../transport-model';
import {
  areaTree, backLine, bmpReason, changeButtonText, creatorCounts, codeNote, confirmTitle, contextRow, entriesOf, entriesUnder, footerCount, isCandidate, NUMERIC_AREAS, NUMERIC_DEFAULT_AREAS,
  leftOutNote, notCheckedNote, proposalsFor, readText, resultLine, rowStates, showEntries, shownEntries, stampText, takenIds, type AreaScan, type NumericEntry,
} from '../numeric-ids-model';

const row = (rid: string, id: string, name: string, o: Partial<TransportScanRow> = {}): TransportScanRow => ({
  rid, id, name, className: 'ActionButton', modified: '', modifiedBy: '', modifiedById: '', created: '', parentRid: 'F1', parentId: 'folder_one', parentName: 'Folder one', sortIndex: 0, ...o,
});
const ctx = (rid: string, id: string, name: string, o: Partial<NumericContextRow> = {}): NumericContextRow => ({ rid, parentRid: 'ROOT', parentId: 'TEMPLATECATEGORY', sortIndex: 0, id, name, className: 'Category', ...o });
const sys = (): TransportOrigin => ({ rid: '', systemObject: false, createdBy: 'System' });
const dev = (): TransportOrigin => ({ rid: '', systemObject: false, createdBy: 'Tassilo' });

const scan = (rows: TransportScanRow[], context: NumericContextRow[] = [], root: AreaScan['root'] = 'templateCategory'): AreaScan => ({ root, rows, context, more: false, at: 1 });

describe('which objects are listed', () => {
  it('lists numbers, and leaves out properties, linked copies and IDs with letters', () => {
    expect(isCandidate(row('1', '5612', 'x'))).toBe(true);
    expect(isCandidate(row('1', '5612', 'x', { className: 'NumberMethodConfig' }))).toBe(false);
    expect(isCandidate(row('1', '5612', 'x', { className: 'ListPropertySetItem' }))).toBe(false);
    expect(isCandidate(row('1', '5612', 'x', { linkedTo: 'tmpl' }))).toBe(false);
    expect(isCandidate(row('1', '2fa_x', 'x'))).toBe(false);
    expect(isCandidate(row('1', '', 'x'))).toBe(false);
  });

  it('offers every area of Find but Properties', () => {
    expect(NUMERIC_AREAS).not.toContain('property');
    expect(NUMERIC_AREAS).toContain('templateCategory');
    expect(NUMERIC_DEFAULT_AREAS).not.toContain('property');
    expect(NUMERIC_DEFAULT_AREAS.every(r => NUMERIC_AREAS.includes(r))).toBe(true);
  });

  it("marks BMP's own by the system flag or the creator System, with the reason", () => {
    expect(bmpReason(undefined)).toBeNull();
    expect(bmpReason(dev())).toBeNull();
    expect(bmpReason({ rid: '', systemObject: false, createdBy: ' system ' })).toMatch(/System/);
    expect(bmpReason({ rid: '', systemObject: true, createdBy: 'Tassilo' })).toMatch(/system object/);
    expect(bmpReason({ rid: '', systemObject: false, createdBy: 'System' }, false)).toBeNull();
    expect(bmpReason({ rid: '', systemObject: true, createdBy: 'System' }, false)).toMatch(/system object/);
    expect(['admin', ' Admin '].map(u => creatorCounts(u))).toEqual([false, false]);
    expect(['tassilo', '', undefined].map(u => creatorCounts(u))).toEqual([true, true, true]);
    const s = scan([row('1', '316', 'My KPIs', { className: 'Tab' }), row('2', '5612', 'Cleanup')]);
    const entries = entriesOf(s, new Map([['1', sys()], ['2', dev()]]));
    expect(entries.map(e => [e.row.id, e.bmp, e.space])).toEqual([['316', true, 't'], ['5612', false, 't']]);
    expect(entries[0].why).toMatch(/System/);
  });

  it('puts an object whose origin is not known among the others', () => {
    expect(entriesOf(scan([row('1', '5', 'x')]), new Map())[0].bmp).toBe(false);
  });

  it('puts file resources in their own ID space', () => {
    expect(entriesOf(scan([row('1', '5', 'x', { className: 'FileResource' })]), new Map())[0].space).toBe('r');
  });
});

describe('the tree', () => {
  const s = scan(
    [row('10', '5612', 'Cleanup', { parentRid: 'F2' }), row('11', '5613', 'Other', { parentRid: 'F1' }), row('12', '316', 'My KPIs', { parentRid: 'F1', className: 'Tab' })],
    [ctx('F1', 'folder_one', 'Folder one'), ctx('F2', 'folder_two', 'Folder two', { parentRid: 'F1', parentId: 'folder_one' })],
  );
  const origins = new Map([['10', dev()], ['11', dev()], ['12', sys()]]);
  const entries = entriesOf(s, origins);
  const byRid = new Map(entries.map(e => [e.row.rid, e]));

  it('nests the objects in their folders, folders being the objects without a number', () => {
    const tree = areaTree(s);
    expect(tree.tops.map(n => n.id)).toEqual(['folder_one']);
    const one = tree.byKey.get('F1')!;
    expect(one.children.map(c => c.key).sort()).toEqual(['11', '12', 'F2']);
    expect(tree.byKey.get('F2')!.children.map(c => c.key)).toEqual(['10']);
    expect(tree.byKey.get('10')!.depth).toBe(2);
  });

  it("shows only the user's own rows with their folders, and BMP's apart", () => {
    const tree = areaTree(s);
    const own = showEntries(tree, byRid, false, { text: '' });
    expect(shownEntries(tree, own, byRid).map(e => e.row.id)).toEqual(['5612', '5613'].sort((a, b) => tree.byKey.get(a === '5612' ? '10' : '11')!.index - tree.byKey.get(b === '5612' ? '10' : '11')!.index));
    expect(own.state[tree.byKey.get('F1')!.index]).not.toBe(MATCH);
    expect(own.state[tree.byKey.get('F1')!.index]).toBeGreaterThan(0);
    const bmp = showEntries(tree, byRid, true, { text: '' });
    expect(shownEntries(tree, bmp, byRid).map(e => e.row.id)).toEqual(['316']);
    // F2 has nothing of BMP's under it: hidden.
    expect(bmp.state[tree.byKey.get('F2')!.index]).toBe(0);
  });

  it('narrows by the words of the box, in the old ID or the name', () => {
    const tree = areaTree(s);
    const ids = (text: string) => shownEntries(tree, showEntries(tree, byRid, false, { text }), byRid).map(e => e.row.id);
    expect(ids('cleanup')).toEqual(['5612']);
    expect(ids('5613')).toEqual(['5613']);
    expect(ids('t.5613')).toEqual(['5613']);
    expect(ids('nothing here')).toEqual([]);
  });

  it('lists what is under a folder for its tick', () => {
    const tree = areaTree(s);
    const show = showEntries(tree, byRid, false, { text: '' });
    expect(entriesUnder(tree, show, tree.byKey.get('F1')!, byRid).map(e => e.row.rid).sort()).toEqual(['10', '11']);
    expect(entriesUnder(tree, show, tree.byKey.get('F2')!, byRid).map(e => e.row.rid)).toEqual(['10']);
    const filtered = showEntries(tree, byRid, false, { text: 'other' });
    expect(entriesUnder(tree, filtered, tree.byKey.get('F1')!, byRid).map(e => e.row.rid)).toEqual(['11']);
  });

  it('draws a parent that is only a context line when it is not among the objects', () => {
    const lone = scan([row('1', '5', 'x', { parentRid: 'GONE', parentId: 'some_folder', parentName: 'Some folder' })]);
    const tree = areaTree(lone);
    expect(tree.byKey.get('p:GONE')).toBeDefined();
    expect(contextRow(ctx('F', 'a', 'A')).modified).toBe('');
  });
});

describe('proposals, values and problems', () => {
  const s = scan(
    [row('10', '5612', 'Cleanup'), row('11', '5613', 'Cleanup'), row('12', '5614', 'Third')],
    [ctx('F1', 'folder_one', 'Folder one'), ctx('20', 'cleanup', 'Taken name', { parentRid: 'F1', className: 'ActionButton' })],
  );
  const entries = entriesOf(s, new Map());
  const proposals = proposalsFor(entries, [s]);

  it('proposes unique IDs against the IDs read', () => {
    expect([...proposals.values()].map(p => p.id).sort()).toEqual(['cleanup_2', 'folder_one_cleanup', 'third']);
    expect(takenIds([s]).has('t\u0000cleanup')).toBe(true);
  });

  it('reports a typed ID that is invalid, used by an object, or typed twice, and only counts ticked rows twice', () => {
    const taken = takenIds([s]);
    const ticked = new Set(['10', '11', '12']);
    const base = rowStates(entries, proposals, new Map(), ticked, taken);
    expect([...base.values()].every(v => v.problem === null)).toBe(true);
    const edits = new Map([['10', 'cleanup'], ['11', 'same_one'], ['12', 'same_one']]);
    const states = rowStates(entries, proposals, edits, ticked, taken);
    expect(states.get('10')!.problem).toMatch(/Already used/);
    expect(states.get('11')!.problem).toMatch(/another row/);
    expect(states.get('12')!.problem).toMatch(/another row/);
    // Not ticked: the clash does not count for the other row.
    const some = rowStates(entries, proposals, edits, new Set(['11']), taken);
    expect(some.get('11')!.problem).toBeNull();
    expect(rowStates(entries, proposals, new Map([['10', '5612']]), ticked, taken).get('10')!.problem).toMatch(/letters/);
    expect(rowStates(entries, proposals, new Map([['10', 'a b']]), ticked, taken).get('10')!.problem).toMatch(/Letters/);
    expect(rowStates(entries, proposals, new Map(), ticked, taken, new Map([['10', 'Already used by another object']])).get('10')!.problem).toMatch(/Already used/);
  });

  it('compares IDs without regard to case', () => {
    const taken = takenIds([s]);
    expect(rowStates(entries, proposals, new Map([['12', 'CLEANUP']]), new Set(['12']), taken).get('12')!.problem).toMatch(/Already used/);
  });
});

describe('words', () => {
  it('says the counts and the lines in BMP words', () => {
    expect(footerCount(24, 38)).toBe('24 of 38');
    expect(footerCount(1200, 1500)).toBe('1,200 of 1,500');
    expect(changeButtonText(24)).toBe('Change 24 IDs');
    expect(changeButtonText(1)).toBe('Change 1 ID');
    expect(confirmTitle(24, 'Steadfast demo')).toBe('Change 24 IDs in Steadfast demo');
    expect(confirmTitle(1, '')).toBe('Change 1 ID');
    expect(codeNote(23)).toBe('Also changes code in 23 objects.');
    expect(codeNote(1)).toBe('Also changes code in 1 object.');
    expect(notCheckedNote('no code copy on this computer')).toBe('Code is not checked: no code copy on this computer.');
  });

  it('says what happened', () => {
    expect(resultLine({ changed: 22, codeObjects: 9, codeNotSaved: 0, notChanged: 2 })).toBe('Changed 22 IDs and code in 9 objects. 2 not changed.');
    expect(resultLine({ changed: 1, codeObjects: 0, codeNotSaved: 0, notChanged: 0 })).toBe('Changed 1 ID.');
    expect(resultLine({ changed: 3, codeObjects: 1, codeNotSaved: 2, notChanged: 0 })).toBe('Changed 3 IDs and code in 1 object. 2 scripts still name an old ID.');
    expect(backLine({ ids: 3, code: 2, heldBack: 0, notBack: 0 })).toBe('Changed back 3 IDs and 2 scripts.');
    expect(backLine({ ids: 1, code: 0, heldBack: 1, notBack: 1 })).toBe('Changed back 1 ID. 1 ID could not go back. 1 script left as it is.');
  });

  it('shows the date read', () => {
    const now = new Date(2026, 10, 19, 12, 0, 0);
    expect(readText(null, now)).toBe('');
    expect(readText(new Date(2026, 10, 19, 10, 5).getTime(), now)).toBe('Read 19 Nov 10:05');
    expect(readText(new Date(2025, 0, 2, 9, 7).getTime(), now)).toBe('Read 2 Jan 2025 09:07');
  });

  it('writes a time in local time and says how many rows were left out', () => {
    expect(stampText(new Date(2026, 10, 19, 15, 3).getTime(), new Date(2026, 10, 19))).toBe('19 Nov 15:03');
    expect(leftOutNote(1)).toBe('1 row left out: the new ID is already used.');
    expect(leftOutNote(3)).toBe('3 rows left out: the new ID is already used.');
  });

  it('exposes the entry type for the view', () => {
    const e: NumericEntry | undefined = entriesOf(scan([row('1', '5', 'x')]), new Map())[0];
    expect(e.area).toBe('templateCategory');
  });
});
