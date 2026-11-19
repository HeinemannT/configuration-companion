// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));

import { pt, resetState } from '../state';
import { addMark, clearMarks, closeEditor, deleteMark, hooks, markByNumber, openMark, openNew, restoreMarks, updateMark } from '../marks';
import { fixtureModel } from '../../lib/point-tell/__tests__/fixture';
import { loadMarks } from '../../lib/point-tell/store';

beforeEach(() => {
  sessionStorage.clear();
  resetState();
  pt.rid = '111';
  pt.model = fixtureModel();
  hooks.render = vi.fn();
});

describe('marks', () => {
  it('numbers each mark on the page and never reuses a number after a delete', () => {
    addMark({ text: 'one', targets: ['btn_export'] });
    addMark({ text: 'two', targets: ['btn_new_risk'] });
    deleteMark(1);
    addMark({ text: 'three', targets: [] });
    expect(pt.marks.map(m => [m.n, m.text])).toEqual([[2, 'two'], [3, 'three']]);
  });

  it('keeps nothing for no words and nothing else to say', () => {
    expect(addMark({ text: '   ', targets: [] })).toBeNull();
    expect(pt.marks).toHaveLength(0);
  });

  it('the note field: empty words keep no note, in a new field and in an old one', () => {
    openNew(['btn_export']);
    closeEditor(true, '  ');
    expect(pt.marks).toHaveLength(0);
    openNew(['btn_export']);
    closeEditor(true, 'Make this blue');
    expect(pt.marks).toHaveLength(1);
    openMark(1);
    expect(pt.editor).toMatchObject({ n: 1, text: 'Make this blue', page: false });
    closeEditor(true, '');
    expect(pt.marks).toHaveLength(0); // an emptied note on an object is deleted with its words
  });

  it('Escape in the field (no save) leaves the mark as it was', () => {
    addMark({ text: 'keep me', targets: ['btn_export'] });
    openMark(1);
    closeEditor(false);
    expect(markByNumber(1)?.text).toBe('keep me');
  });

  it('a page note has no target and is edited like any other', () => {
    openNew([]);
    expect(pt.editor?.page).toBe(true);
    closeEditor(true, 'Rename the first tab');
    updateMark(1, 'Rename the first tab to Summary');
    expect(pt.marks[0]).toMatchObject({ n: 1, targets: [], text: 'Rename the first tab to Summary' });
  });

  it('keeps the richer shape: meaning and ink travel through the store untouched', () => {
    addMark({
      text: '', targets: ['btn_export'],
      meaning: { kind: 'move', to: { before: 'btn_new_risk' }, words: 'before "New risk"' },
      ink: { strokes: [{ points: [[1, 1], [9, 9]] }], place: { tabId: 'tab_overview', row: 3 } },
    });
    pt.marks = []; pt.next = 1;
    restoreMarks();
    expect(pt.marks[0].meaning).toEqual({ kind: 'move', to: { before: 'btn_new_risk' }, words: 'before "New risk"' });
    expect(pt.marks[0].ink?.strokes[0].points).toEqual([[1, 1], [9, 9]]);
  });

  it('is stored per page, comes back, and the next number comes back with it', () => {
    addMark({ text: 'a', targets: [] });
    addMark({ text: 'b', targets: [] });
    deleteMark(2);
    pt.marks = []; pt.next = 1;
    restoreMarks();
    expect(pt.marks.map(m => m.n)).toEqual([1]);
    expect(pt.next).toBe(3);
    pt.rid = '222';
    restoreMarks();
    expect(pt.marks).toHaveLength(0);
  });

  it('Clear removes the marks of the page and starts the numbers again', () => {
    addMark({ text: 'a', targets: [] });
    clearMarks();
    expect(loadMarks('111').marks).toHaveLength(0);
    addMark({ text: 'b', targets: [] });
    expect(pt.marks[0].n).toBe(1);
  });

  it('draws after every change', () => {
    addMark({ text: 'a', targets: [] });
    deleteMark(1);
    expect(hooks.render).toHaveBeenCalledTimes(2);
  });
});
