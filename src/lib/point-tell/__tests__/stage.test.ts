import { describe, expect, it } from 'vitest';
import { stageAnswer, type PtOpResult, type PtStageResult } from '../stage';
import { buildPayload } from '../payload';
import { parseAnswer } from '../parse-answer';
import { diff } from '../../layout/diff';
import { compile } from '../../layout/ec';
import { findNode, cloneModel } from '../../layout/model';
import { remove, rename, resize } from '../../layout/edit';
import { fixtureModel } from './fixture';
import type { PtMark, PtOp } from '../types';
import type { ColorSetData } from '../../types';

const colors: ColorSetData[] = [{ id: 's', name: 'Stock', folder: 'ColorRoot', colors: [{ bid: 'white', name: 'White', rgb: 'rgb(255,255,255)' }, { bid: 'blue', name: 'Corporate blue', rgb: 'rgb(10,79,158)' }] }];
// refs of the fixture: t1 tab_overview, c1 cont_top, o1 table, o2 chart, c2 cont_notes, o3 txt_info, o4 New risk, o5 Export, t2 tab_details, o6 dv_details
const marks: PtMark[] = [
  { n: 1, text: 'button', targets: ['btn_new_risk'], at: 1 },
  { n: 2, text: 'move export', targets: ['btn_export'], at: 2 },
  { n: 3, text: 'table', targets: ['tbl_open_risks'], at: 3 },
  { n: 4, text: 'page', targets: [], at: 4 },
  { n: 5, text: 'info', targets: ['txt_info'], at: 5 },
  { n: 6, text: 'chart', targets: ['chart_by_status'], at: 6 },
];
const copy = (model = fixtureModel()) => buildPayload({ model, marks, colors, liveTabId: 'tab_overview', scope: 'template', now: 1 }).snapshot;
const colorName = (bid: string) => ({ white: 'White', blue: 'Corporate blue' } as Record<string, string>)[bid];

const stage = (ops: Array<Partial<PtOp> & { op: PtOp['op'] }>, opts: { model?: ReturnType<typeof fixtureModel>; snapshotOf?: ReturnType<typeof fixtureModel> } = {}): PtStageResult => {
  const base = opts.model ?? fixtureModel();
  const answer = { operations: ops.map(o => ({ notes: [1], ...o }) as PtOp), questions: [], cannot: [] };
  return stageAnswer(base, copy(opts.snapshotOf ?? fixtureModel()), answer, { colorName });
};
const one = (r: PtStageResult, note = 1): PtOpResult => r.reports.find(x => x.n === note)!.results[0];
const ok = (r: PtOpResult) => { expect(r.reason, r.text).toBeUndefined(); expect(r.verdict).toBe('ok'); return r; };
const bad = (r: PtOpResult, reason: string | RegExp) => {
  expect(r.verdict).toBe('invalid');
  if (typeof reason === 'string') expect(r.reason).toBe(reason); else expect(r.reason).toMatch(reason);
  return r;
};

describe('change', () => {
  it('name: valid, empty, too long, the same, the Result tab', () => {
    const r = stage([{ op: 'change', ref: 'o5', property: 'name', value: 'Download' }]);
    expect(ok(one(r)).text).toBe('Change name of ActionButton "Export" to "Download"');
    expect(findNode(r.final, 'btn_export')!.node.name).toBe('Download');
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'name', value: '  ' }])), 'A name is 1 to 120 characters.');
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'name', value: 'x'.repeat(121) }])), 'A name is 1 to 120 characters.');
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'name', value: 'Export' }])), 'No change: it already is "Export".');
    const m = fixtureModel();
    m.tabs.push({ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result', cols: { L: 6 }, children: [] });
    bad(one(stage([{ op: 'change', ref: 't3', property: 'name', value: 'x' }], { model: m, snapshotOf: m })), /not an object of the copied page|not something you may change on Tab/);
  });

  it('columns: valid, with the row warning; out of range; not a number; the same', () => {
    const r = stage([{ op: 'change', ref: 'o1', property: 'columns', value: 6 }], { });
    const res = ok(one(r, 1));
    expect(res.warning).toBe('"By status" moves to another row');
    expect(findNode(r.final, 'tbl_open_risks')!.node.cols.L).toBe(6);
    for (const value of [0, 7, 2.5, 'x', null]) bad(one(stage([{ op: 'change', ref: 'o1', property: 'columns', value }])), 'Columns are a whole number from 1 to 6.');
    bad(one(stage([{ op: 'change', ref: 'o1', property: 'columns', value: '4' }])), 'No change: it already is 4.');
    expect(ok(one(stage([{ op: 'change', ref: 'o1', property: 'columnsMedium', value: '3' }]))).text).toContain('columns on medium screens');
  });

  it('height: charts and URL views only, 20 or more', () => {
    const r = stage([{ op: 'change', ref: 'o2', property: 'height', value: 320 }]);
    expect(ok(one(r)).text).toBe('Change height of PieChart "By status" to 320 px');
    expect(findNode(r.final, 'chart_by_status')!.node.height).toBe(320);
    bad(one(stage([{ op: 'change', ref: 'o2', property: 'height', value: 10 }])), 'Height is a whole number of pixels, 20 or more.');
    bad(one(stage([{ op: 'change', ref: 'o1', property: 'height', value: 300 }])), '"height" is not something you may change on ExtendedTable.');
  });

  it('header and font color: a color ref, null for none, anything else refused', () => {
    const r = stage([{ op: 'change', ref: 'o5', property: 'headerColor', value: 'k2' }, { op: 'change', ref: 'o5', property: 'fontColor', value: 'k1' }]);
    expect(r.reports[0].results.map(x => x.text)).toEqual([
      'Change header color of ActionButton "Export" to Corporate blue',
      'Change font color of ActionButton "Export" to White',
    ]);
    expect(findNode(r.final, 'btn_export')!.node.style).toEqual({ headerColorBid: 'blue', fontColorBid: 'white' });
    expect(ok(one(stage([{ op: 'change', ref: 'o4', property: 'headerColor', value: null }]))).text).toBe('Change header color of ActionButton "New risk" to none');
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'headerColor', value: 'k9' }])), '"k9" is not one of the colors offered.');
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'headerColor', value: '#ff0000' }])), '"#ff0000" is not one of the colors offered.');
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'headerColor', value: 7 }])), '7 is not one of the colors offered.');
  });

  it('shadow, header bar, border, transparency', () => {
    expect(ok(one(stage([{ op: 'change', ref: 'o5', property: 'shadow', value: 'true' }]))).text).toContain('to on');
    expect(ok(one(stage([{ op: 'change', ref: 'o5', property: 'headerStyle', value: 'outside' }]))).text).toBe('Change header bar of ActionButton "Export" to Out');
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'borderStyle', value: 'dotted' }])), 'Border is one of LINE, NONE.');
    expect(ok(one(stage([{ op: 'change', ref: 'o5', property: 'transparency', value: 40 }]))).text).toContain('to 40');
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'transparency', value: 101 }])), 'Transparency is a whole number from 0 to 100.');
    bad(one(stage([{ op: 'change', ref: 'o4', property: 'shadow', value: true }])), 'No change: it already is on.'); // New risk has a shadow already
  });

  it('visibility; hiding on every screen says so', () => {
    expect(ok(one(stage([{ op: 'change', ref: 'o5', property: 'visibility', value: 'ADMINVISIBLEONLY' }]))).text).toContain('Admin only');
    const r = stage([{ op: 'change', ref: 'o5', property: 'visibility', value: 'NOVISIBLE' }]);
    expect(ok(one(r)).warning).toBe('The object is hidden on every screen size');
  });

  it('trait flags only where the layout read found the trait', () => {
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'showToolMenu', value: false }])), '"showToolMenu" is not something you may change on ActionButton.');
    const m = fixtureModel();
    m.tabs[0].children[2].style = { ...m.tabs[0].children[2].style, showToolMenu: true };
    const r = stage([{ op: 'change', ref: 'o4', property: 'showToolMenu', value: false }], { model: m, snapshotOf: m });
    expect(ok(one(r)).text).toContain('tools menu');
  });

  it('code and text: valid, but made in another window; anything else outside the vocabulary is refused', () => {
    const r = one(stage([{ op: 'change', ref: 'o1', property: 'expression', value: 'SELECT 1' }]));
    expect(r.verdict).toBe('open');
    expect(r.reason).toBeUndefined();
    expect(r.text).toBe('Change expression of ExtendedTable "Open risks"');
    expect(r.route).toMatchObject({ kind: 'code', id: 'tbl_open_risks', className: 'ExtendedTable', property: 'expression', value: 'SELECT 1' });
    const t = one(stage([{ op: 'change', ref: 'o4', property: 'buttonText', value: 'Create risk' }]));
    expect(t.verdict).toBe('open');
    expect(t.route).toMatchObject({ kind: 'text', property: 'buttonText', value: 'Create risk' });
    bad(one(stage([{ op: 'change', ref: 'o1', property: 'expression', value: '  ' }])), 'The new code of expression is missing.');
    bad(one(stage([{ op: 'change', ref: 'o4', property: 'buttonText', value: 7 }])), 'The new text of buttonText is missing.');
    expect(stage([{ op: 'change', ref: 'o1', property: 'expression', value: 'x' }]).review).toBe(1);
    expect(stage([{ op: 'change', ref: 'o1', property: 'expression', value: 'x' }]).notPossible).toBe(0);
    bad(one(stage([{ op: 'change', ref: 'o5', property: 'banana', value: 1 }])), '"banana" is not something you may change on ActionButton.');
    bad(one(stage([{ op: 'change', ref: 'o5', value: 1 }])), 'The change names no property.');
  });

  it('a removed object, an unknown ref, no ref', () => {
    const gone = remove(fixtureModel(), 'txt_info');
    const r = stage([{ op: 'change', ref: 'o3', property: 'name', value: 'x' }], { model: gone });
    bad(one(r), 'o3 (TextElement "Info") is no longer on this page.');
    bad(one(stage([{ op: 'change', ref: 'o99', property: 'name', value: 'x' }])), '"o99" is not an object of the copied page.');
    bad(one(stage([{ op: 'change', property: 'name', value: 'x' }])), 'The operation names no object.');
  });

  it('judged per operation: only what changed since the copy fails', () => {
    const now = resize(rename(fixtureModel(), 'btn_new_risk', 'New risk!'), 'btn_export', 'L', 3);
    const r = stage([
      { op: 'change', ref: 'o5', property: 'columns', value: 2 },       // Export was resized after the copy
      { op: 'change', ref: 'o4', property: 'name', value: 'Create' },    // New risk was renamed after the copy
      { op: 'change', ref: 'o4', property: 'columns', value: 2 },       // but its width is as copied: fine
      { op: 'change', ref: 'o1', property: 'columns', value: 5 },       // untouched: fine
    ], { model: now });
    const res = r.reports[0].results;
    bad(res[0], 'changed since the copy: was 1, is 3');
    bad(res[1], 'changed since the copy: was "New risk", is "New risk!"');
    ok(res[2]); ok(res[3]);
  });

  it('two operations on one property in one answer are not "changed since the copy"', () => {
    const r = stage([{ op: 'change', ref: 'o1', property: 'columns', value: 3 }, { op: 'change', ref: 'o1', property: 'columns', value: 5 }]);
    expect(r.reports[0].results.map(x => x.verdict)).toEqual(['ok', 'ok']);
    expect(findNode(r.final, 'tbl_open_risks')!.node.cols.L).toBe(5);
  });
});

describe('move', () => {
  it('before and after an object; "already there" is refused', () => {
    const r = stage([{ op: 'move', notes: [2], ref: 'o5', to: { before: 'o4' } }]);
    expect(ok(one(r, 2)).text).toBe('Move ActionButton "Export" before "New risk"');
    expect(findNode(r.final, 'btn_export')!.index).toBeLessThan(findNode(r.final, 'btn_new_risk')!.index);
    bad(one(stage([{ op: 'move', notes: [2], ref: 'o5', to: { after: 'o4' } }]), 2), 'It is already there.');
  });

  it('into a container or a tab; not into a widget', () => {
    const r = stage([{ op: 'move', notes: [2], ref: 'o5', to: { into: 'c2' } }]);
    expect(ok(one(r, 2)).text).toBe('Move ActionButton "Export" into "Notes"');
    expect(findNode(r.final, 'btn_export')!.parent!.id).toBe('cont_notes');
    expect(ok(one(stage([{ op: 'move', notes: [2], ref: 'o5', to: { into: 't2' } }]), 2)).text).toContain('into tab "Details"');
    bad(one(stage([{ op: 'move', notes: [2], ref: 'o5', to: { into: 'o4' } }]), 2), 'Only a tab or a container can hold an object.');
  });

  it('a place is exactly one of before, after or into', () => {
    bad(one(stage([{ op: 'move', notes: [2], ref: 'o5' }]), 2), 'A place is exactly one of before, after or into, with an object.');
    bad(one(stage([{ op: 'move', notes: [2], ref: 'o5', to: { before: 'o4', after: 'o3' } }]), 2), 'A place is exactly one of before, after or into, with an object.');
  });

  it('not relative to itself or inside itself', () => {
    bad(one(stage([{ op: 'move', notes: [2], ref: 'o5', to: { before: 'o5' } }]), 2), 'An object cannot be placed relative to itself.');
    bad(one(stage([{ op: 'move', notes: [2], ref: 'c1', to: { into: 'c1' } }]), 2), 'An object cannot be placed relative to itself.');
    bad(one(stage([{ op: 'move', notes: [2], ref: 'c1', to: { before: 'o1' } }]), 2), 'An object cannot be placed inside itself.');
  });

  it('the band rule: a widget between containers, a container after a widget', () => {
    bad(one(stage([{ op: 'move', notes: [2], ref: 'o5', to: { before: 'c2' } }]), 2), 'BMP shows widgets after all containers, and this place is between containers');
    bad(one(stage([{ op: 'move', notes: [2], ref: 'c1', to: { after: 'o4' } }]), 2), 'BMP shows containers before widgets. Place it beside a container instead');
  });

  it('tabs: beside another tab of the same tab set; not the Result tab; not into', () => {
    const r = stage([{ op: 'move', notes: [2], ref: 't2', to: { before: 't1' } }]);
    expect(ok(one(r, 2)).text).toBe('Move Tab "Details" before tab "Overview"');
    expect(r.final.tabs.map(t => t.id)).toEqual(['tab_details', 'tab_overview']);
    bad(one(stage([{ op: 'move', notes: [2], ref: 't2', to: { into: 't1' } }]), 2), 'A tab is placed before or after another tab.');
    bad(one(stage([{ op: 'move', notes: [2], ref: 't2', to: { before: 'o1' } }]), 2), 'A tab is placed before or after another tab.');
  });

  it('members of a group are placed in Blueprint', () => {
    const m = fixtureModel();
    m.tabs[0].children[3].className = 'ButtonGroup';
    m.tabs[0].children[3].children = [{ id: 'inner', kind: 'widget', className: 'ActionButton', name: 'Inner', cols: { L: 1 }, children: [] }];
    const r = stage([{ op: 'move', notes: [2], ref: 'o5', to: { before: 'inner' } }], { model: m, snapshotOf: m });
    expect(r.reports.find(x => x.n === 2)!.results[0].verdict).toBe('invalid');
  });
});

describe('add', () => {
  it('a widget after another, with a name and properties; staged with a temporary id', () => {
    const r = stage([{ op: 'add', notes: [4], type: 'PieChart', name: 'By owner', place: { after: 'o4' }, properties: { columns: 2, height: 300, headerColor: 'k2', shadow: true } }]);
    const res = one(r, 4);
    expect(ok(res).text).toBe('Add PieChart "By owner" after "New risk"');
    const node = findNode(r.final, res.ids[0])!.node;
    expect(node).toMatchObject({ className: 'PieChart', name: 'By owner', cols: { L: 2 }, height: 300, style: { headerColorBid: 'blue', shadow: true } });
    expect(r.origins[res.ids[0]]).toBe(4);
  });

  it('into a container, before an object, and the nearest legal place when a widget is asked between containers', () => {
    expect(ok(one(stage([{ op: 'add', notes: [4], type: 'TextElement', name: 'Intro', place: { into: 'c1' } }]), 4)).text).toBe('Add TextElement "Intro" into "Col 6"');
    expect(ok(one(stage([{ op: 'add', notes: [4], type: 'TextElement', name: 'Intro', place: { before: 'o4' } }]), 4)).text).toBe('Add TextElement "Intro" before "New risk"');
    const r = stage([{ op: 'add', notes: [4], type: 'TextElement', name: 'Intro', place: { before: 'c2' } }]);
    const res = one(r, 4);
    ok(res);
    expect(res.warning).toBe('That place is between containers, so it is added after the last container.');
  });

  it('a container, a tab; a type that cannot be added; a missing place or name; a property it may not have', () => {
    expect(ok(one(stage([{ op: 'add', notes: [4], type: 'Container', name: 'Side', place: { after: 'c2' }, properties: { columns: 2 } }]), 4)).text).toBe('Add Container "Side" after "Notes"');
    expect(ok(one(stage([{ op: 'add', notes: [4], type: 'Tab', name: 'Summary', place: { after: 't1' } }]), 4)).text).toBe('Add Tab "Summary" after tab "Overview"');
    expect(one(stage([{ op: 'add', notes: [4], type: 'Tab', name: 'Summary' }]), 4).verdict).toBe('ok'); // one tab set: no place needed
    bad(one(stage([{ op: 'add', notes: [4], type: 'Dragon', name: 'x', place: { after: 'o4' } }]), 4), /not a type you may add/);
    bad(one(stage([{ op: 'add', notes: [4], type: 'TextElement', name: 'x' }]), 4), 'A place is exactly one of before, after or into, with an object.');
    bad(one(stage([{ op: 'add', notes: [4], type: 'TextElement', name: '', place: { after: 'o4' } }]), 4), 'A name is 1 to 120 characters.');
    bad(one(stage([{ op: 'add', notes: [4], type: 'ExtendedTable', name: 'x', place: { after: 'o4' }, properties: { height: 200 } }]), 4), '"height" is not something a new ExtendedTable may be given.');
    bad(one(stage([{ op: 'add', notes: [4], type: 'TextElement', name: 'x', place: { into: 'o4' } }]), 4), 'Only a tab or a container can hold a new object.');
  });

  it('names created with "as" can be used by later operations, in this note or another', () => {
    const r = stage([
      { op: 'add', notes: [4], type: 'Container', name: 'Extra', place: { after: 'c2' }, as: 'n1' },
      { op: 'add', notes: [4], type: 'TextElement', name: 'In extra', place: { into: 'n1' } },
      { op: 'move', notes: [5], ref: 'o3', to: { into: 'n1' } },
    ]);
    expect(r.reports.flatMap(x => x.results).map(x => x.verdict)).toEqual(['ok', 'ok', 'ok']);
    const extra = r.reports.find(x => x.n === 4)!.results[0].ids[0];
    expect(findNode(r.final, extra)!.node.children.map(c => c.name).sort()).toEqual(['In extra', 'Info']);
  });

  it('a name that looks like a ref or is taken is refused', () => {
    bad(one(stage([{ op: 'add', notes: [4], type: 'Container', place: { after: 'c2' }, as: 'o9' }]), 4), '"o9" is already a name; use another with "as".');
    const r = stage([
      { op: 'add', notes: [4], type: 'Container', place: { after: 'c2' }, as: 'n1' },
      { op: 'add', notes: [4], type: 'Container', place: { after: 'c2' }, as: 'n1' },
    ]);
    expect(r.reports.find(x => x.n === 4)!.results.map(x => x.verdict)).toEqual(['ok', 'invalid']);
  });
});

describe('delete', () => {
  it('a widget; a container says where its widgets go; a tab is not deleted here', () => {
    expect(ok(one(stage([{ op: 'delete', notes: [2], ref: 'o5' }]), 2)).text).toBe('Delete ActionButton "Export"');
    expect(ok(one(stage([{ op: 'delete', notes: [2], ref: 'c1' }]), 2)).warning).toBe('Its widgets move to the tab.');
    bad(one(stage([{ op: 'delete', notes: [2], ref: 't2' }]), 2), 'Tabs are deleted in Blueprint.');
  });
  it('what is deleted is gone for the next operation', () => {
    const r = stage([{ op: 'delete', notes: [2], ref: 'o5' }, { op: 'change', notes: [2], ref: 'o5', property: 'name', value: 'x' }], {});
    expect(r.reports.find(x => x.n === 2)!.results.map(x => x.verdict)).toEqual(['ok', 'invalid']);
  });
});

describe('notes', () => {
  it('one step per note, in note order, however the answer is ordered; each op knows its note', () => {
    const r = stage([
      { op: 'change', notes: [3], ref: 'o1', property: 'columns', value: 5 },
      { op: 'change', notes: [1], ref: 'o4', property: 'columns', value: 2 },
      { op: 'change', notes: [3], ref: 'o2', property: 'columns', value: 1 },
      { op: 'delete', notes: [2], ref: 'o5' },
    ]);
    expect(r.steps.map(s => s.note)).toEqual([1, 2, 3]);
    expect(findNode(r.steps[0].model, 'btn_new_risk')!.node.cols.L).toBe(2);
    expect(findNode(r.steps[0].model, 'tbl_open_risks')!.node.cols.L).toBe(4);       // note 3 not yet
    expect(findNode(r.steps[2].model, 'tbl_open_risks')!.node.cols.L).toBe(5);
    expect(r.origins).toMatchObject({ btn_new_risk: 1, btn_export: 2, tbl_open_risks: 3, chart_by_status: 3 });
    expect(r.ready).toBe(4);
  });

  it('a move is credited to its note even when the compiler moves the neighbour', () => {
    const r = stage([
      { op: 'change', notes: [1], ref: 'o1', property: 'columns', value: 5 },
      { op: 'move', notes: [2], ref: 'o5', to: { before: 'o4' } },
    ]);
    expect(r.steps.map(s => s.note)).toEqual([1, 2]);
    const noted = Object.values(r.origins);
    expect(noted).toContain(1);
    expect(noted).toContain(2); // some object is in the plan because of note 2, whichever one the compiler names
    expect(Object.keys(r.origins).every(id => id.length > 0)).toBe(true);
  });

  it('a note whose operations all fail adds no step; a note the answer ignored says so', () => {
    const r = stage([{ op: 'change', notes: [1], ref: 'o4', property: 'columns', value: 99 }]);
    expect(r.steps).toEqual([]);
    expect(r.reports.find(x => x.n === 5)!.unaddressed).toBe(true);
    expect(r.reports.find(x => x.n === 1)!.unaddressed).toBe(false);
    expect(r.ready).toBe(0);
    expect(r.notPossible).toBe(1);
  });

  it('an operation for a note that does not exist, or for no note', () => {
    const r = stage([{ op: 'delete', notes: [42], ref: 'o5' }, { op: 'delete', notes: [], ref: 'o4' }]);
    expect(r.reports.find(x => x.n === 42)!.results[0].reason).toBe('There is no note 42.');
    expect(r.reports.find(x => x.n === 0)!.results[0].reason).toBe('The operation names no note.');
    expect(r.steps).toEqual([]);
  });

  it('questions and cannot go with their notes and count as not possible', () => {
    const answer = parseAnswer('{"operations":[],"questions":[{"note":3,"text":"Which columns?"}],"cannot":[{"note":3,"text":"Table contents are code."},{"text":"general"}]}');
    if (!answer.ok) throw new Error('parse');
    const r = stageAnswer(fixtureModel(), copy(), answer.answer);
    expect(r.reports.find(x => x.n === 3)).toMatchObject({ questions: ['Which columns?'], cannot: ['Table contents are code.'], unaddressed: false });
    expect(r.reports.find(x => x.n === 0)!.cannot).toEqual(['general']);
    expect(r.notPossible).toBe(2);
  });

  it('an unknown verb is refused by name', () => {
    const r = stage([{ op: 'unknown', verb: 'explode', notes: [1] }]);
    bad(one(r), '"explode" is not an operation. Use change, move, add or delete.');
  });
});

describe('a real answer end to end: parse, judge, stage, compile', () => {
  const answer = `Here is the plan.\n\n\`\`\`json\n${JSON.stringify({
    format: 'companion.point-and-tell.answer/1',
    operations: [
      { note: 1, op: 'change', ref: 'o4', property: 'headerColor', value: 'k1' },
      { note: 1, op: 'change', ref: 'o4', property: 'fontColor', value: 'k2' },
      { note: 2, op: 'move', ref: 'o5', to: { before: 'o4' } },
      { note: 3, op: 'change', ref: 'o1', property: 'columns', value: 6 },
      { note: 5, op: 'add', type: 'TextElement', name: 'Owner', place: { after: 'o3' }, properties: { columns: 3 } },
      { note: 4, op: 'change', ref: 't1', property: 'name', value: 'Summary' },
    ],
    questions: [{ note: 5, text: 'What should the owner line say?' }],
    cannot: [{ note: 3, text: 'Owner and due date columns are table code.' }],
  })}\n\`\`\`\nAnything else?`;

  it('every valid change compiles to Extended Code without throwing, and each note shows in the diff', () => {
    const parsed = parseAnswer(answer);
    if (!parsed.ok) throw new Error(parsed.error);
    const base = fixtureModel();
    const r = stageAnswer(base, copy(), parsed.answer, { colorName });
    expect(r.reports.flatMap(x => x.results).every(x => x.verdict === 'ok')).toBe(true);
    expect(r.steps.map(s => s.note)).toEqual([1, 2, 3, 4, 5]);
    let before = cloneModel(base);
    for (const s of r.steps) {
      const changes = diff(before, s.model);
      expect(changes.length, `note ${s.note}`).toBeGreaterThan(0);
      before = s.model;
    }
    const plan = diff(base, r.final);
    expect(() => compile(plan, r.final)).not.toThrow();
    const ec = compile(plan, r.final).notes.map(n => n.ec).join('\n');
    expect(ec).toContain('headerColor');
    expect(ec).toContain('Summary');
  });
});
