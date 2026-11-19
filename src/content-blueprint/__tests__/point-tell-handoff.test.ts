// @vitest-environment happy-dom
/**
 * Point and tell hands an answer to Blueprint: staged per note on the fresh model, grouped in the tray,
 * each note taken back on its own, and the notes settled only by an apply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showToast = vi.fn();
vi.mock('../../lib/toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('../colors', () => ({ colorInfo: (bid: string) => (bid === 'blue' ? { name: 'Corporate blue', rgb: 'rgb(0,0,255)' } : null), ensureColorSets: vi.fn() }));

import { History } from '../../lib/layout/history';
import { findNode } from '../../lib/layout/model';
import { buildPayload } from '../../lib/point-tell/payload';
import { stashStage, loadMarks, saveMarks, recordStaged, finishStaged } from '../../lib/point-tell/store';
import { fixtureModel } from '../../lib/point-tell/__tests__/fixture';
import { applyPendingStage, survivingNotes } from '../point-tell-handoff';
import { bp, resetState, model } from '../state';
import { trayPanel } from '../view-panels';
import { discardNote } from '../actions';

const RID = '7282092580979928955';
const marks = [
  { n: 1, text: 'Make this stand out', targets: ['btn_export'], at: 1 },
  { n: 2, text: 'Widen the table', targets: ['tbl_open_risks'], at: 2 },
  { n: 3, text: 'Add owner columns', targets: ['tbl_open_risks'], at: 3 },
];
const copy = () => buildPayload({ model: fixtureModel(), marks, colors: [{ id: 's', name: 's', folder: 'ColorRoot', colors: [{ bid: 'blue', name: 'Corporate blue', rgb: 'rgb(0,0,255)' }] }], liveTabId: null, scope: 'template', now: 1 }).snapshot;
const answer = JSON.stringify({ operations: [
  { note: 1, op: 'change', ref: 'o5', property: 'headerColor', value: 'k1' },
  { note: 1, op: 'change', ref: 'o5', property: 'shadow', value: true },
  { note: 2, op: 'change', ref: 'o1', property: 'columns', value: 6 },
  { note: 3, op: 'change', ref: 'o1', property: 'expression', value: '_t := 1' },
], questions: [{ note: 3, text: 'Which columns?' }] });

function load(): void {
  resetState();
  const base = fixtureModel();
  bp.baseline = base;
  bp.history = new History(base);
  bp.loadedRid = RID;
  bp.active = true;
}

beforeEach(() => { sessionStorage.clear(); showToast.mockClear(); load(); });

describe('applyPendingStage', () => {
  it('does nothing without a waiting answer', () => {
    applyPendingStage();
    expect(bp.history!.canUndo()).toBe(false);
    expect(bp.noteReports).toBeNull();
  });

  it('stages each note as one undo step, groups by note, opens the tray and says so', () => {
    stashStage(RID, { answer, snapshot: copy(), ready: 3 }, Date.now());
    applyPendingStage();
    // two notes changed something: two history pushes
    expect(bp.history!.canUndo()).toBe(true);
    bp.history!.undo();
    expect(bp.history!.canUndo()).toBe(true);
    bp.history!.undo();
    expect(bp.history!.canUndo()).toBe(false);
    bp.history!.redo(); bp.history!.redo();
    expect(bp.trayOpen).toBe(true);
    expect([...bp.noteOrigins]).toEqual(expect.arrayContaining([['btn_export', 1], ['tbl_open_risks', 2]]));
    expect(bp.noteReports!.map(r => r.n)).toEqual([1, 2, 3]);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('staged 3 changes from your notes'), 'info');
    // read once
    applyPendingStage();
    expect(bp.noteReports!.length).toBe(3);
  });

  it('says how many dropped out when the fresh page no longer allows them', () => {
    stashStage(RID, { answer, snapshot: copy(), ready: 5 }, Date.now());
    applyPendingStage();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('2 of the 5 changes could not be staged'), 'info');
  });

  it('an answer that cannot be read says why and stages nothing', () => {
    stashStage(RID, { answer: 'no json here', snapshot: copy(), ready: 1 }, Date.now());
    applyPendingStage();
    expect(bp.history!.canUndo()).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('No operations found'), 'info');
  });

  it('a stash for another page is left alone', () => {
    stashStage('999', { answer, snapshot: copy(), ready: 3 }, Date.now());
    applyPendingStage();
    expect(bp.history!.canUndo()).toBe(false);
    expect(sessionStorage.getItem('crev_pt_stage:999')).not.toBeNull();
  });
});

describe('the grouped tray', () => {
  function staged() {
    stashStage(RID, { answer, snapshot: copy(), ready: 3 }, Date.now());
    applyPendingStage();
    return trayPanel(bp.baseline!, model()!);
  }

  it('one group per note, with the change rows under it and what was left out in muted lines', () => {
    const tray = staged();
    const heads = [...tray.querySelectorAll('.bp-tray-note')].map(h => h.textContent);
    expect(heads[0]).toContain('1');
    expect(heads[0]).toContain('“Make this stand out”');
    expect(heads[1]).toContain('“Widen the table”');
    expect(heads[2]).toContain('“Add owner columns”');
    const skips = [...tray.querySelectorAll('.bp-tray-skip')].map(s => s.textContent);
    expect(skips.some(l => l?.startsWith('Change expression of ExtendedTable "Open risks"'))).toBe(true);
    expect(skips).toContain('Question: Which columns?');
    // the rows keep their numbered markers
    expect(tray.querySelectorAll('.bp-prow').length).toBe(2);
    expect(tray.querySelectorAll('.bp-mark').length).toBe(2);
  });

  it('a change Blueprint cannot stage offers the window that can make it', () => {
    const tray = staged();
    const buttons = [...tray.querySelectorAll('.bp-tray-skip button')].map(b => b.textContent);
    expect(buttons).toEqual(['Review in editor']);
  });

  it('without notes the tray is the plain list it always was', () => {
    bp.history!.push(fixtureModel());
    const tray = trayPanel(bp.baseline!, model()!);
    expect(tray.querySelector('.bp-tray-note')).toBeNull();
  });

  it('changes that came from no note sit under "Other changes"', () => {
    const tray = staged();
    bp.history!.push({ ...model()!, tabs: model()!.tabs.map(t => ({ ...t, name: t.name + '!' })) });
    const again = trayPanel(bp.baseline!, model()!);
    expect([...again.querySelectorAll('.bp-tray-note')].at(-1)?.textContent).toContain('Other changes');
    expect(tray.querySelector('.bp-tray-note')).not.toBeNull();
  });

  it('discard note takes one note back, as one step, and leaves the others', () => {
    staged();
    discardNote(1);
    const m = model()!;
    expect(findNode(m, 'btn_export')!.node.style ?? {}).toEqual({});
    expect(findNode(m, 'tbl_open_risks')!.node.cols.L).toBe(6);
    expect(bp.noteOrigins.has('btn_export')).toBe(false);
    expect(bp.noteOrigins.get('tbl_open_risks')).toBe(2);
  });
});

describe('settling notes', () => {
  it('a note survives while an object it touched is still in the plan, even when its row is shared with another note', () => {
    stashStage(RID, { answer: JSON.stringify({ operations: [
      { note: 1, op: 'change', ref: 'o5', property: 'shadow', value: true },
      { note: 2, op: 'move', ref: 'o5', to: { before: 'o4' } },
      { note: 3, op: 'change', ref: 'o1', property: 'columns', value: 6 },
    ] }), snapshot: copy(), ready: 3 }, Date.now());
    applyPendingStage();
    expect(survivingNotes(bp.noteReports, new Set(['btn_export']))).toEqual(new Set([1, 2]));
    expect(survivingNotes(bp.noteReports, new Set())).toEqual(new Set());
    discardNote(3);
    expect(survivingNotes(bp.noteReports, new Set(['btn_export', 'tbl_open_risks']))).toEqual(new Set([1, 2]));
    expect(survivingNotes(null, new Set(['x']))).toEqual(new Set());
  });

  it('an apply finishes the notes whose every operation was staged, and keeps the others as plain notes', () => {
    saveMarks(RID, { marks: marks.map(m => ({ ...m })), next: 4 });
    recordStaged(RID, { applied: [1, 2], kept: [3] });
    finishStaged(RID);
    expect(loadMarks(RID).marks.map(m => [m.n, m.staged])).toEqual([[3, undefined]]);
  });
});
