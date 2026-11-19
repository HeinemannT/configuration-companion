// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assignRefs, resolveRef, tableOf } from '../refs';
import { buildOutline, pageSignature } from '../outline';
import {
  decodeMarks, encodeMarks, loadMarks, saveMarks, decodeCopy, saveCopy, loadCopy, stashStage, takeStage, STAGE_TTL_MS, markNotesApplied, decodeMark, recordStaged, finishStaged, clearStaged,
} from '../store';
import { cloneModel } from '../../layout/model';
import { resize, rename, setStyle, insertRelative, remove } from '../../layout/edit';
import { fixtureModel } from './fixture';
import type { PtCopySnapshot, PtMark } from '../types';

describe('refs', () => {
  it('numbers tabs, containers and widgets separately, in outline order', () => {
    const t = assignRefs(fixtureModel());
    expect(t.entries.map(e => `${e.ref}:${e.id}`)).toEqual([
      't1:tab_overview', 'c1:cont_top', 'o1:tbl_open_risks', 'o2:chart_by_status', 'c2:cont_notes', 'o3:txt_info', 'o4:btn_new_risk', 'o5:btn_export',
      't2:tab_details', 'o6:dv_details',
    ]);
  });

  it('resolves by id, then by rid, and not at all when the object is gone', () => {
    const m = fixtureModel();
    const t = assignRefs(m);
    expect(resolveRef(m, t, 'O1')?.node.id).toBe('tbl_open_risks');
    expect(resolveRef(m, t, ' o1 ')?.node.id).toBe('tbl_open_risks');
    const changed = cloneModel(m);
    changed.tabs[0].children[0].children[0].id = 'tbl_renumbered'; // BMP assigned another id, same rid
    expect(resolveRef(changed, t, 'o1')?.node.id).toBe('tbl_renumbered');
    expect(resolveRef(remove(m, 'btn_export'), t, 'o5')).toBeNull();
    expect(resolveRef(m, t, 'o99')).toBeNull();
    expect(resolveRef(m, t, 42)).toBeNull();
  });

  it('a table rebuilt from a snapshot resolves the same', () => {
    const m = fixtureModel();
    const t = tableOf(assignRefs(m).entries);
    expect(resolveRef(m, t, 'c2')?.node.name).toBe('Notes');
  });
});

describe('outline', () => {
  it('lists refs, types, columns and rows, and no rid', () => {
    const m = fixtureModel();
    const out = buildOutline(m, assignRefs(m));
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/\d{12,}/);
    expect(out[0]).toMatchObject({ ref: 't1', type: 'Tab', name: 'Overview' });
    const kids = out[0].children!;
    expect(kids.map(k => [k.ref, k.columns, k.row])).toEqual([['c1', 6, 1], ['c2', 6, 2], ['o4', 1, 3], ['o5', 1, 3]]);
    expect(kids[0].children!.map(k => [k.ref, k.columns, k.row])).toEqual([['o1', 4, 1], ['o2', 2, 1]]);
  });

  it('marks a tab BMP would not show', () => {
    const m = fixtureModel();
    m.tabs[1].children = [];
    expect(buildOutline(m, assignRefs(m))[1].hidden).toBe(true);
  });
});

describe('page signature', () => {
  const sig = pageSignature;
  it('is the same for a re-read of the same page', () => {
    expect(sig(fixtureModel())).toBe(sig(cloneModel(fixtureModel())));
  });
  it('changes with a rename, a resize, a move, a delete and a style change', () => {
    const m = fixtureModel();
    const base = sig(m);
    const all = [
      sig(rename(m, 'btn_export', 'Download')),
      sig(resize(m, 'btn_export', 'L', 2)),
      sig(insertRelative(m, 'btn_export', 'btn_new_risk', true)),
      sig(remove(m, 'btn_export')),
      sig(setStyle(m, 'btn_export', { headerColorBid: 'red' })),
    ];
    for (const s of all) expect(s).not.toBe(base);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('store', () => {
  beforeEach(() => sessionStorage.clear());
  const mark = (n: number, extra: Partial<PtMark> = {}): PtMark => ({ n, text: `note ${n}`, targets: ['btn_export'], at: 1000 + n, ...extra });

  it('round-trips marks with the richer shape: meaning and ink', () => {
    const rich = mark(2, {
      targets: ['btn_export', 'btn_new_risk'],
      meaning: { kind: 'move', to: { before: 'btn_new_risk' }, words: 'before "New risk"' },
      ink: { strokes: [{ points: [[1, 2], [3, 4]] }], place: { tabId: 'tab_overview', row: 3, col: 2, cols: 1, over: ['btn_export'] } },
      staged: true,
    });
    const back = decodeMarks(encodeMarks({ marks: [mark(1, { targets: [] }), rich], next: 3 }));
    expect(back.marks).toEqual([mark(1, { targets: [] }), rich]);
    expect(back.next).toBe(3);
  });

  it('never reuses a number: next stays above every stored mark', () => {
    expect(decodeMarks(encodeMarks({ marks: [mark(7)], next: 2 })).next).toBe(8);
  });

  it('reads anything unreadable as an empty set', () => {
    for (const raw of [null, '', 'not json', '[]', '{"v":2,"marks":[]}', '{"v":1}', '{"v":1,"marks":"x"}']) {
      expect(decodeMarks(raw)).toEqual({ marks: [], next: 1 });
    }
  });

  it('drops malformed marks and duplicates, and unknown fields', () => {
    const raw = JSON.stringify({ v: 1, next: 1, marks: [mark(1), { n: 'x' }, null, mark(1, { text: 'dup' }), { n: 0, text: '' }, { n: 2, text: 't', targets: [3, 'a'], extra: 1, meaning: { kind: 'dance' }, ink: { strokes: [{ points: [['a', 1]] }] } }] });
    const set = decodeMarks(raw);
    expect(set.marks.map(m => m.n)).toEqual([1, 2]);
    expect(set.marks[1]).toEqual({ n: 2, text: 't', targets: ['a'], at: 0 });
  });

  it('keeps marks per page in sessionStorage; an empty set removes the entry', () => {
    expect(saveMarks('111', { marks: [mark(1)], next: 2 })).toBe(true);
    expect(loadMarks('111').marks).toHaveLength(1);
    expect(loadMarks('222').marks).toHaveLength(0);
    saveMarks('111', { marks: [], next: 5 });
    expect(sessionStorage.getItem('crev_pt_marks:111')).toBeNull();
  });

  it('says so when the browser refuses to store', () => {
    const spy = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try { expect(saveMarks('111', { marks: [mark(1)], next: 2 })).toBe(false); } finally { spy.mockRestore(); }
  });

  const snap = (): PtCopySnapshot => ({
    at: 5, sig: 'abc', scope: 'template',
    refs: assignRefs(fixtureModel()).entries, colors: { k1: 'blue' }, now: { btn_export: { columns: 1 } },
    marks: [{ n: 1, text: 'x', targets: ['btn_export'] }],
  });

  it('round-trips a copy snapshot and ignores a damaged one', () => {
    saveCopy('111', snap());
    expect(loadCopy('111')).toEqual(snap());
    expect(decodeCopy('{"v":1,"at":"x"}')).toBeNull();
    expect(decodeCopy('nope')).toBeNull();
  });

  it('the stage stash is read once, and not after its time', () => {
    expect(stashStage('111', { answer: '{"operations":[]}', snapshot: snap(), ready: 3 }, 1000)).toBe(true);
    const got = takeStage('111', 1000 + 5000);
    expect(got?.answer).toBe('{"operations":[]}');
    expect(got?.snapshot.sig).toBe('abc');
    expect(got?.ready).toBe(3);
    expect(takeStage('111', 1000 + 5000)).toBeNull();
    stashStage('111', { answer: 'x', snapshot: snap(), ready: 1 }, 1000);
    expect(takeStage('111', 1000 + STAGE_TTL_MS)).toBeNull();
  });

  it('applied marks go; marks with something left over stay, no longer staged', () => {
    saveMarks('111', { marks: [mark(1, { staged: true }), mark(2, { staged: true }), mark(3)], next: 4 });
    const left = markNotesApplied('111', [1, 2], [2]);
    expect(left.marks.map(m => m.n)).toEqual([2, 3]);
    expect(left.marks.every(m => m.staged === undefined)).toBe(true);
    expect(loadMarks('111').marks.map(m => m.n)).toEqual([2, 3]);
  });

  it('staged notes: an apply settles the ones it finished; leaving without applying clears the flags', () => {
    saveMarks('111', { marks: [mark(1), mark(2), mark(3)], next: 4 });
    recordStaged('111', { applied: [1], kept: [2] });
    expect(loadMarks('111').marks.map(m => [m.n, m.staged === true])).toEqual([[1, true], [2, true], [3, false]]);
    const left = finishStaged('111');
    expect(left?.marks.map(m => [m.n, m.staged])).toEqual([[2, undefined], [3, undefined]]);
    expect(finishStaged('111')).toBeNull(); // the record is spent
    saveMarks('222', { marks: [mark(1), mark(2)], next: 3 });
    recordStaged('222', { applied: [1], kept: [] });
    clearStaged('222');
    expect(loadMarks('222').marks.map(m => m.staged)).toEqual([undefined, undefined]);
    expect(finishStaged('222')).toBeNull();
  });

  it('a note whose changes were taken back before the apply is not finished by it', () => {
    saveMarks('111', { marks: [mark(1), mark(2)], next: 3 });
    recordStaged('111', { applied: [1, 2], kept: [] });
    const left = finishStaged('111', new Set([2]));
    expect(left?.marks.map(m => m.n)).toEqual([1]);
  });

  it('decodeMark: a mark needs a positive whole number', () => {
    expect(decodeMark({ n: 1.5, text: '' })).toBeNull();
    expect(decodeMark({ n: 3 })).toEqual({ n: 3, text: '', targets: [], at: 0 });
  });
});

describe('link map', () => {
  it('joins the rid the page shows to the template widget id, only where there is a link', async () => {
    const { linkMap } = await import('../links');
    const m = fixtureModel();
    m.tabs[0].children[0].children[0].rid = '4000000000000000001';
    m.tabs[0].children[0].children[0].linkedTemplate = { rid: '4000000000000000009', id: 'tbl_open_risks', className: 'ExtendedTable', name: 'Open risks' };
    m.tabs[0].children[3].rid = '4000000000000000002'; // an instance-only widget: no link
    expect(linkMap(m)).toEqual({ '4000000000000000001': 'tbl_open_risks' });
  });
});
