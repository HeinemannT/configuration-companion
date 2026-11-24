import { describe, expect, it } from 'vitest';
import { drewOf, guessOf, kindOf, gridWords, whereWords, type PhraseCtx } from '../phrases';
import { assignRefs } from '../refs';
import { draftTabs, withDrafts } from '../drafts';
import { buildPayload } from '../payload';
import { fixtureModel } from './fixture';
import type { PtMark } from '../types';

// Refs of the fixture page: t1 Overview, c1 "Col 6" (o1 Open risks, o2 By status), c2 Notes (o3 Info), o4 New risk, o5 Export, t2 Details, o6 Details.
const refs = assignRefs(fixtureModel());
const ctx: PhraseCtx = { refs, shownTab: 't1' };
const m = (n: number, extra: Partial<PtMark>): PtMark => ({ n, text: '', targets: [], at: n, ...extra });
const phrases = (mark: PtMark, c: PhraseCtx = ctx): [string | undefined, string | undefined] => [drewOf(mark, c), guessOf(mark, c)];

describe('drew and guess, one kind of mark at a time', () => {
  it('a note for the page says nothing was drawn', () => {
    const mark = m(1, { text: 'Rename the page' });
    expect(kindOf(mark)).toBe('note');
    expect(phrases(mark)).toEqual([undefined, undefined]);
  });

  it('a typed note on an object: a click', () => {
    const mark = m(1, { text: 'why?', targets: ['btn_export'] });
    expect(kindOf(mark)).toBe('click');
    expect(phrases(mark)).toEqual(['click on o5', undefined]);
  });

  it('a circle around one or several objects: no guess', () => {
    const ink = { strokes: [{ points: [[0, 0], [9, 9]] as Array<[number, number]> }], place: {} };
    expect(phrases(m(1, { targets: ['btn_export'], reading: 'Export', ink }))).toEqual(['circle around o5', undefined]);
    expect(phrases(m(2, { targets: ['btn_new_risk', 'btn_export'], reading: '2 objects', ink }))).toEqual(['circle around o4, o5', undefined]);
  });

  it('an arrow from empty space onto an object: pointing, no guess', () => {
    const mark = m(1, { targets: ['txt_info'], reading: 'Info', pointer: true, ink: { strokes: [{ points: [[0, 0], [9, 9]] }], place: {} } });
    expect(kindOf(mark)).toBe('pointer');
    expect(phrases(mark)).toEqual(['arrow pointing at o3', undefined]);
  });

  it('an arrow from an object: where it ends, and the move it probably means', () => {
    const arrow = (to: Record<string, string>): PtMark => m(1, { targets: ['btn_export'], meaning: { kind: 'move', to: to as never } });
    expect(phrases(arrow({ before: 'btn_new_risk' }))).toEqual(['arrow from o5 ending just before o4', 'move o5 before o4']);
    expect(phrases(arrow({ after: 'txt_info' }))).toEqual(['arrow from o5 ending just after o3', 'move o5 after o3']);
    expect(phrases(arrow({ into: 'cont_notes' }))).toEqual(['arrow from o5 ending inside c2', 'move o5 into c2']);
  });

  it('an arrow into a square (the pair): the square and the width in the guess', () => {
    const mark = m(1, {
      targets: ['btn_export'], meaning: { kind: 'move', to: { after: 'tbl_open_risks' }, columns: 2 },
      ink: { strokes: [{ points: [[0, 0], [9, 9]] }], place: { tabId: 'tab_overview', row: 3, col: 5, cols: 2 } },
    });
    expect(kindOf(mark)).toBe('pair');
    expect(phrases(mark)).toEqual(['arrow from o5 into a square at row 3, columns 5-6', 'move o5 after o1, 2 columns wide']);
  });

  it('a cross: only where it is, never a guess', () => {
    const mark = m(1, { text: 'hide it', targets: ['chart_by_status'], meaning: { kind: 'crossed' } });
    expect(phrases(mark)).toEqual(['cross over o2', undefined]);
  });

  it('an underline: under the object, no guess', () => {
    const mark = m(1, { targets: ['txt_info'], meaning: { kind: 'change' } });
    expect(phrases(mark)).toEqual(['underline under o3', undefined]);
  });

  it('a square on empty space: where it is, what is inside, what it probably adds', () => {
    const sq = (widget: 'table' | 'chart' | 'button' | 'text' | undefined, columns: number | undefined): PtMark => m(1, {
      meaning: { kind: 'add', place: { after: 'btn_export' }, ...(columns ? { columns } : {}), ...(widget ? { widget, types: ['X'] } : {}) },
      ink: { strokes: [{ points: [[0, 0], [9, 9]] }], place: { tabId: 'tab_overview', row: 3, col: 4, cols: 3 } },
    });
    expect(phrases(sq('table', 3))).toEqual(['square at row 3, columns 4-6, lines inside', 'add a table, 3 columns wide, after o5']);
    expect(phrases(sq('chart', 2))).toEqual(['square at row 3, columns 4-6, bars inside', 'add a chart, 2 columns wide, after o5']);
    expect(phrases(sq('button', 1))).toEqual(['square at row 3, columns 4-6, a small rounded box', 'add a button, 1 column wide, after o5']);
    expect(phrases(sq('text', undefined))).toEqual(['square at row 3, columns 4-6, wavy lines inside', 'add text, after o5']);
    expect(phrases(sq(undefined, 3))).toEqual(['square at row 3, columns 4-6', 'add a widget, 3 columns wide, after o5']);
  });

  it('a square in a container, or on a tab BMP is not showing, names it', () => {
    const mark = m(1, {
      meaning: { kind: 'add', place: { into: 'cont_notes' }, columns: 6 },
      ink: { strokes: [{ points: [[0, 0], [9, 9]] }], place: { tabId: 'tab_overview', containerId: 'cont_notes', row: 2, col: 1, cols: 6 } },
    });
    expect(phrases(mark)).toEqual(['square in c2 at row 2, columns 1-6', 'add a widget, 6 columns wide, into c2']);
    const other = m(2, { meaning: { kind: 'add', place: { into: 'tab_details' } }, ink: { strokes: [{ points: [[0, 0], [9, 9]] }], place: { tabId: 'tab_details', row: 2, col: 1 } } });
    expect(phrases(other)).toEqual(['square on t2 at row 2, column 1', 'add a widget, into t2']);
  });

  it('a tab shape on the tab row: after, before, or the first tab', () => {
    const tab = (place: never): PtMark => m(3, { text: 'Contracts', meaning: { kind: 'add', tab: true, place } });
    const drafts = (mark: PtMark): PhraseCtx => ({ refs: assignRefs(withDrafts(fixtureModel(), draftTabs([mark]))), shownTab: 't1' });
    const after = tab({ after: 'tab_details' } as never);
    expect([drewOf(after, drafts(after)), guessOf(after, drafts(after), draftTabs([after])[0])]).toEqual(['tab shape after t2 on the tab row', 'add a tab after t2, as n1']);
    const before = tab({ before: 'tab_overview' } as never);
    expect([drewOf(before, drafts(before)), guessOf(before, drafts(before), draftTabs([before])[0])]).toEqual(['tab shape before t1 on the tab row', 'add a tab before t1, as n1']);
    const first = tab({ into: 'draft:page' } as never);
    expect([drewOf(first, drafts(first)), guessOf(first, drafts(first), draftTabs([first])[0])]).toEqual(['tab shape on the tab row', 'add a tab, as n1']);
  });

  it('ink that was not understood: near what it touches, else where it is', () => {
    const ink = (place: object) => ({ strokes: [{ points: [[0, 0], [9, 9]] as Array<[number, number]> }], place });
    expect(phrases(m(1, { targets: ['btn_export'], ink: ink({}) }))).toEqual(['ink near o5', undefined]);
    expect(phrases(m(2, { ink: ink({ tabId: 'tab_overview', row: 2, col: 3, cols: 2 }) }))).toEqual(['ink at row 2, columns 3-4', undefined]);
    expect(phrases(m(3, { ink: ink({}) }))).toEqual(['ink on the page', undefined]);
  });

  it('an object no longer on the page is not named', () => {
    expect(phrases(m(1, { text: 'x', targets: ['gone'] }))).toEqual([undefined, undefined]);
  });
});

describe('grid words', () => {
  it('rows and columns', () => {
    expect(gridWords({ row: 2, col: 5, cols: 2 })).toBe('row 2, columns 5-6');
    expect(gridWords({ row: 2, col: 5, cols: 9 })).toBe('row 2, columns 5-6');
    expect(gridWords({ row: 1, col: 3 })).toBe('row 1, column 3');
    expect(gridWords({ row: 4 })).toBe('row 4');
    expect(gridWords({})).toBe('');
  });
  it('the shown tab is not named; another tab, a container and the new page are', () => {
    expect(whereWords({ tabId: 'tab_overview', row: 1, col: 1 }, ctx)).toBe('at row 1, column 1');
    expect(whereWords({ tabId: 'tab_details', containerId: 'cont_top', row: 1 }, ctx)).toBe('on t2 in c1 at row 1');
    expect(whereWords({ tabId: 'draft:page', row: 1, col: 1 }, ctx)).toBe('on the new page at row 1, column 1');
  });
});

describe('a drawn page, a paper page, a templated page, as copied', () => {
  const tab1: PtMark = { n: 1, text: 'Contracts', targets: [], at: 1, meaning: { kind: 'add', tab: true, place: { after: 'tab_details' } } };

  it('marks on a drawn tab are on its ref; a drawn tab is handled', () => {
    const table: PtMark = {
      n: 2, text: 'Open contracts', targets: [], at: 2,
      ink: { strokes: [{ points: [[0, 0], [9, 9]] }], place: { tabId: 'draft:1', row: 1, col: 1, cols: 3 } },
      meaning: { kind: 'add', place: { into: 'draft:1' }, widget: 'table', types: ['ExtendedTable'], columns: 3 },
    };
    const sentence: PtMark = { ...table, n: 3, text: 'A table of all contracts by status, please.', ink: { ...table.ink!, place: { tabId: 'draft:1', row: 2, col: 1, cols: 6 } }, meaning: { kind: 'add', place: { into: 'draft:1' }, widget: 'table', types: ['ExtendedTable'], columns: 6 } };
    const { payload } = buildPayload({ model: fixtureModel(), marks: [tab1, table, sentence], colors: null, liveTabId: 'tab_overview', scope: 'instance', now: 1 });
    expect(payload.marks).toEqual([
      { n: 1, drew: 'tab shape after t2 on the tab row', guess: 'add a tab after t2, as n1', says: 'Contracts', handled: true },
      { n: 2, drew: 'square on n1 at row 1, columns 1-3, lines inside', guess: 'add a table, 3 columns wide, into n1', says: 'Open contracts' },
      { n: 3, drew: 'square on n1 at row 2, columns 1-6, lines inside', guess: 'add a table, 6 columns wide, into n1', says: 'A table of all contracts by status, please.' },
    ]);
  });

  it('a paper page: the page is new, has no ID, and the tabs are the drawn ones', () => {
    const empty = { ...fixtureModel(), pageId: 'draft:page', pageName: 'Risk overview', tabs: [], resultOnly: true };
    const first: PtMark = { n: 1, text: 'Overview', targets: [], at: 1, meaning: { kind: 'add', tab: true, place: { into: 'draft:page' } } };
    const { payload, instruction } = buildPayload({ model: empty, marks: [first], colors: null, liveTabId: null, scope: 'instance', now: 1, newPage: true });
    expect(payload.page).toEqual({ type: 'Scorecard', new: true, name: 'Risk overview' });
    expect(payload.marks[0]).toEqual({ n: 1, drew: 'tab shape on the tab row', guess: 'add a tab, as n1', says: 'Overview', handled: true });
    expect(payload.outline).toEqual([{ ref: 'n1', type: 'Tab', name: 'Overview', new: true }]);
    expect(instruction).toContain('does not exist yet');
  });

  it('a templated page says the objects belong to a shared template', () => {
    const { payload } = buildPayload({ model: fixtureModel(), marks: [m(1, { text: 'x', targets: ['btn_export'] })], colors: null, liveTabId: 'tab_overview', scope: 'template', now: 1 });
    expect(payload.page).toMatchObject({ scope: 'template', shownTab: 't1' });
    expect(payload.marks[0]).toEqual({ n: 1, drew: 'click on o5', says: 'x' });
  });
});

describe('an arrow with no operation, as copied', () => {
  const ink = { strokes: [{ points: [[0, 0], [9, 9]] as Array<[number, number]> }], place: { tabId: 'tab_overview', row: 4, col: 3 } };
  it('from one object to another, to empty space, and on empty space: what was drawn, no guess', () => {
    const both = m(1, { targets: ['txt_info', 'btn_export'], reading: 'Arrow from Info to Export', arrow: { from: 'txt_info', to: 'btn_export' }, ink });
    expect(kindOf(both)).toBe('direction');
    expect(phrases(both)).toEqual(['arrow from o3 to o5', undefined]);
    expect(phrases(m(2, { targets: ['txt_info'], reading: 'Arrow from Info', arrow: { from: 'txt_info', end: { tabId: 'tab_overview', row: 5, col: 4 }, near: { id: 'btn_export', side: 'below' } }, ink })))
      .toEqual(['arrow from o3 to empty space below o5 at row 5, column 4', undefined]);
    expect(phrases(m(3, { reading: 'Arrow', arrow: {}, ink }))).toEqual(['arrow on empty space at row 4, column 3', undefined]);
    expect(phrases(m(4, { targets: ['txt_info'], reading: 'Arrow inside Info', arrow: { from: 'txt_info', to: 'txt_info' }, ink }))).toEqual(['arrow inside o3', undefined]);
  });
  it('without its reading (dropped) it is ink', () => {
    expect(kindOf(m(1, { targets: ['txt_info'], arrow: { from: 'txt_info' }, ink }))).toBe('ink');
  });
});
