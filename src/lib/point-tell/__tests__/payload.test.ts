import { describe, expect, it } from 'vitest';
import { buildPayload, clipboardText, INSTRUCTION, simplifyStroke, nowOf, instructionFor, SHOT_LINE, HANDLED_LINE, TAB_LINE, NEW_PAGE_LINE } from '../payload';
import { addTypes, buildColours, buildVocabulary, changeableProps, newWidgetProps, STYLE_PROP_NAMES, toHex, VALUE_SPECS, COLOUR_CAP } from '../vocabulary';
import { PALETTE } from '../../layout/palette';
import { fixtureModel } from './fixture';
import type { PtMark } from '../types';
import type { ColorSetData } from '../../types';

const colors: ColorSetData[] = [
  { id: 'stock', name: 'Stock', folder: 'ColorRoot', colors: [{ bid: 'white', name: 'White', rgb: 'rgb(255,255,255)' }, { bid: 'blue', name: 'Corporate blue', rgb: 'rgb(10, 79, 158)' }] },
  { id: 'mine', name: 'Mine', folder: 'cat_mine', colors: [{ bid: 'red', name: 'Signal red', rgb: '#c62828' }] },
];

const marks: PtMark[] = [
  { n: 1, text: 'Make this button stand out.', targets: ['btn_new_risk'], at: 1 },
  { n: 2, text: 'Move Export left of New risk', targets: ['btn_export'], at: 2, meaning: { kind: 'move', to: { before: 'btn_new_risk' }, words: 'before "New risk"' }, ink: { strokes: [{ points: [[300, 460], [120, 458]] }], place: { tabId: 'tab_overview', row: 3, col: 1 } } },
  { n: 3, text: 'Call the first tab Summary.', targets: [], at: 3 },
  { n: 4, text: '', targets: ['txt_info'], at: 4, reading: 'Info', ink: { strokes: [{ points: [[100, 330], [300, 331], [500, 332], [500, 400], [100, 400], [100, 330]] }], place: { tabId: 'tab_overview', containerId: 'cont_notes', row: 2, col: 1, cols: 3, over: ['txt_info'] } } },
];

const build = () => buildPayload({ model: fixtureModel(), marks, colors, liveTabId: 'tab_overview', scope: 'template', now: 1234 });

const six: PtMark[] = [
  { n: 1, text: 'Make this the first button', targets: ['btn_export'], at: 1, reading: 'Move Export before New risk', meaning: { kind: 'move', to: { before: 'btn_new_risk' }, words: 'Move "Export" before "New risk"' }, ink: { strokes: [{ points: [[300, 460], [120, 458]], r: [2, 1] }], place: { tabId: 'tab_overview', row: 3, col: 1 }, anchor: { id: 'btn_export', box: { left: 266, top: 440, width: 166, height: 40 } } } },
  { n: 2, text: '', targets: ['chart_by_status'], at: 2, reading: 'Crossed out By status', meaning: { kind: 'crossed' }, ink: { strokes: [{ points: [[800, 130], [1000, 270]] }, { points: [[1000, 130], [800, 270]] }], place: { tabId: 'tab_overview', over: ['chart_by_status'] } } },
  { n: 3, text: 'A chart of risks by owner', targets: [], at: 3, reading: 'Add in row 3, columns 4-6', meaning: { kind: 'add', place: { after: 'btn_export' }, columns: 3, widget: 'chart', types: ['BarChart', 'LineChart'], words: 'after "Export", about 3 columns wide' }, ink: { strokes: [{ points: [[560, 436], [940, 494]] }], place: { tabId: 'tab_overview', row: 3, col: 4, cols: 3 } } },
  { n: 4, text: 'Add owner and due date', targets: ['tbl_open_risks'], at: 4, reading: 'Change Open risks', meaning: { kind: 'change' }, ink: { strokes: [{ points: [[110, 292], [300, 294]] }], place: { tabId: 'tab_overview', over: ['tbl_open_risks'] } } },
  { n: 5, text: '', targets: ['btn_new_risk', 'btn_export'], at: 5, reading: '2 objects', ink: { strokes: [{ points: [[90, 430], [440, 430], [440, 490], [90, 490], [90, 430]] }], place: { tabId: 'tab_overview', over: ['btn_new_risk', 'btn_export'] } } },
  { n: 6, text: 'Why this?', targets: ['txt_info'], at: 6, ink: { strokes: [{ points: [[300, 340], [330, 360]] }, { points: [[320, 380], [321, 381]] }], place: { tabId: 'tab_overview', containerId: 'cont_notes', row: 2, col: 1, cols: 1, over: ['txt_info'] } } },
];

describe('payload', () => {
  it('has the page, the marks, the marked objects, the outline, the vocabulary and the answer format', () => {
    const { payload } = build();
    expect(Object.keys(payload)).toEqual(['page', 'marks', 'objects', 'outline', 'vocabulary', 'answerFormat']);
    expect(payload.page).toEqual({ type: 'Scorecard', id: 'sc_op_risk', name: 'Operational Risk', scope: 'template', shownTab: 't1' });
    expect(payload.marks.map(m => m.n)).toEqual([1, 2, 3, 4]);
    expect(Object.keys(payload.objects ?? {})).toEqual(['o4', 'o5', 'o3']);
  });

  it('golden: six mixed marks, each as drew, guess and says (no strokes, no shape, no ids)', () => {
    const { payload } = buildPayload({ model: fixtureModel(), marks: six, colors, liveTabId: 'tab_overview', scope: 'template', now: 1 });
    expect(payload.marks).toEqual([
      { n: 1, drew: 'arrow from o5 ending just before o4', guess: 'move o5 before o4', says: 'Make this the first button' },
      { n: 2, drew: 'cross over o2' },
      { n: 3, drew: 'square at row 3, columns 4-6, bars inside', guess: 'add a chart, 3 columns wide, after o5', says: 'A chart of risks by owner', handled: true },
      { n: 4, drew: 'underline under o1', says: 'Add owner and due date' },
      { n: 5, drew: 'circle around o4, o5' },
      { n: 6, drew: 'ink near o3', says: 'Why this?' },
    ]);
    const text = JSON.stringify(payload.marks);
    expect(text).not.toContain('points');
    expect(text).not.toContain('Move Export before');
  });

  it('a circle and a cross have no guess; a mark with no words has no says', () => {
    const { payload } = build();
    expect(payload.marks[3]).toEqual({ n: 4, drew: 'circle around o3' });
    const crossed = buildPayload({ model: fixtureModel(), marks: six, colors, liveTabId: 'tab_overview', scope: 'template', now: 1 }).payload.marks[1];
    expect(crossed).toEqual({ n: 2, drew: 'cross over o2' });
  });

  it('the objects hold what the outline does not say, once per marked object', () => {
    const { payload } = buildPayload({
      model: fixtureModel(), marks: [{ n: 1, text: 'owner column', targets: ['tbl_open_risks'], at: 1 }, { n: 2, text: 'also this', targets: ['tbl_open_risks', 'btn_new_risk'], at: 2 }], colors, liveTabId: null, scope: 'instance', now: 1,
      extras: { tbl_open_risks: { code: { expression: '_t := SELECT Risk' }, omitted: ['html'] } },
    });
    expect(payload.objects).toEqual({
      o1: { id: 'tbl_open_risks', code: { expression: '_t := SELECT Risk' }, codeTooLong: ['html'] },
      o4: { id: 'btn_new_risk', now: { headerColor: 'k3', shadow: true } },
    });
    expect(JSON.stringify(payload.marks)).not.toContain('SELECT');
  });

  it('the snapshot keeps the full "now" (with columns) and the structure behind each guess', () => {
    const { snapshot } = buildPayload({ model: fixtureModel(), marks: six, colors, liveTabId: 'tab_overview', scope: 'template', now: 1 });
    expect(snapshot.now.btn_new_risk).toEqual({ columns: 1, headerColor: 'k3', shadow: true });
    expect(snapshot.marks[2]).toMatchObject({ n: 3, guess: 'add a chart, 3 columns wide, after o5', handled: true, add: { widget: 'chart', types: ['BarChart', 'LineChart'], columns: 3, place: { after: 'o5' } } });
    expect(snapshot.marks[0]).toMatchObject({ move: { to: { before: 'o4' } } });
  });

  it('the instruction is the approved one, and the clipboard text is the instruction and exactly one JSON object', () => {
    const { payload, instruction } = build();
    const text = clipboardText(payload, instruction);
    expect(text.startsWith(INSTRUCTION)).toBe(true);
    expect(INSTRUCTION.split('\n')).toHaveLength(5);
    expect(INSTRUCTION).toContain('Trust `says` first, then `drew`, then `guess`.');
    const json = text.slice(instruction.length).trim();
    expect(JSON.parse(json).page.id).toBe('sc_op_risk');
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(json.split('\n').length).toBeLessThan(50);
  });

  it('the extra instruction lines come only with what they are about', () => {
    expect(instructionFor({ handled: false, tabs: false, newPage: false, screenshot: false })).not.toMatch(/handled|picture|does not exist|drew itself/);
    const all = instructionFor({ handled: true, tabs: true, newPage: true, screenshot: true });
    for (const l of [HANDLED_LINE, TAB_LINE, NEW_PAGE_LINE, SHOT_LINE]) expect(all).toContain(l);
    expect(SHOT_LINE).toBe('The attached picture shows the same numbers.');
    const withShot = buildPayload({ model: fixtureModel(), marks, colors, liveTabId: null, scope: 'template', now: 1, screenshot: true });
    expect(withShot.instruction.endsWith(SHOT_LINE)).toBe(true);
    expect(build().instruction).not.toContain(SHOT_LINE);
  });

  it('never carries a rid, nor a long number', () => {
    const text = clipboardText(build().payload);
    expect(text).not.toMatch(/\d{12,}/);
    expect(text).not.toContain('1000000000000000001');
  });

  it('snapshot: refs, colours, "now" and the marks as copied, with the page signature', () => {
    const { snapshot } = build();
    expect(snapshot.at).toBe(1234);
    expect(snapshot.scope).toBe('template');
    expect(snapshot.refs.find(r => r.ref === 'o5')?.id).toBe('btn_export');
    expect(snapshot.refs.find(r => r.ref === 'o1')?.rid).toBe('1000000000000000001'); // the page keeps the rid; the text does not
    expect(snapshot.colors).toEqual({ k1: 'red', k2: 'white', k3: 'blue' });
    expect(snapshot.now.btn_new_risk).toEqual({ columns: 1, headerColor: 'k3', shadow: true });
    expect(snapshot.marks[1]).toMatchObject({ n: 2, text: 'Move Export left of New risk', targets: ['btn_export'] });
    expect(snapshot.sig).toMatch(/^[0-9a-f]{8}$/);
  });

  it('golden: the vocabulary for the fixture page (types with the same properties share one entry)', () => {
    const v = build().payload.vocabulary;
    expect(v.properties['ExtendedTable, TextElement, ActionButton']).toEqual(['name', 'columns', 'columnsMedium', 'columnsSmall', 'headerColor', 'fontColor', 'shadow', 'headerStyle', 'borderStyle', 'transparency', 'visibility', 'shownOnLargeDisplay', 'shownOnMediumDisplay', 'shownOnSmallDisplay']);
    expect(v.properties.PieChart).toContain('height');
    expect(v.properties.Tab).toEqual(['name']);
    expect(v.properties.Container).toEqual(['name', 'columns', 'columnsMedium', 'columnsSmall']);
    expect(v.properties.newWidget).toContain('headerColor');
    expect(v.colors).toEqual(['k1 Signal red #c62828', 'k2 White #ffffff', 'k3 Corporate blue #0a4f9e']);
    expect(v.values.headerStyle).toEqual(['INSIDE', 'OUTSIDE', 'NONE']);
    expect(v.layout).toContain('{"into": tab or container ref}');
    expect(v.elsewhere['ExtendedTable']).toEqual(['expression', 'html', 'javascript']);
    expect(v.elsewhere['TextElement']).toEqual(['text', 'longText']);
    expect(v.elsewhere['ActionButton']).toEqual(['buttonText', 'expression', 'initExpression', 'afterExpression']);
    expect(v.elsewhereNote).toContain('"value"');
  });

  it('the answer format shows one operation of each kind, a question and a cannot', () => {
    const f = build().payload.answerFormat;
    expect(f.operations.map(o => (o as { op: string }).op)).toEqual(['change', 'move', 'add', 'delete']);
    expect(f.questions).toHaveLength(1);
    expect(f.cannot).toHaveLength(1);
  });

  it('a page with no colour set loaded still copies, without colours', () => {
    const { payload } = buildPayload({ model: fixtureModel(), marks, colors: null, liveTabId: null, scope: 'instance', now: 1 });
    expect(payload.vocabulary.colors).toEqual([]);
    expect(payload.page.shownTab).toBeUndefined();
    expect(payload.page.scope).toBeUndefined();
    expect(payload.objects?.o4).toEqual({ id: 'btn_new_risk', now: { shadow: true } });
  });

  it('an object a mark names that is no longer in the model is left out', () => {
    const { payload } = buildPayload({ model: fixtureModel(), marks: [{ n: 1, text: 'x', targets: ['gone'], at: 1 }], colors: null, liveTabId: null, scope: 'template', now: 1 });
    expect(payload.marks).toEqual([{ n: 1, says: 'x' }]);
    expect(payload.objects).toBeUndefined();
  });

  it('a page that does not exist yet says so and has no ID', () => {
    const { payload, instruction } = buildPayload({ model: fixtureModel(), marks: [], colors: null, liveTabId: null, scope: 'instance', now: 1, newPage: true });
    expect(payload.page).toEqual({ type: 'Scorecard', new: true, name: 'Operational Risk' });
    expect(instruction).toContain(NEW_PAGE_LINE);
  });
});

describe('vocabulary', () => {
  it('every palette type can be added', () => {
    const add = new Set(addTypes());
    for (const g of PALETTE) for (const i of g.items) expect(add.has(i.key), i.key).toBe(true);
    expect(add.has('Container') && add.has('Tab')).toBe(true);
  });

  it('is locked to the style catalog: every style property has a value spec', () => {
    for (const p of STYLE_PROP_NAMES) expect(Object.keys(VALUE_SPECS), p).toContain(p);
  });

  it('trait flags appear only where the layout read found the trait', () => {
    const m = fixtureModel();
    const btn = m.tabs[0].children[3];
    expect(changeableProps(btn)).not.toContain('disableSearch');
    btn.style = { ...btn.style, disableSearch: false, showToolMenu: true };
    expect(changeableProps(btn)).toEqual(expect.arrayContaining(['disableSearch', 'showToolMenu']));
  });

  it('the Result tab cannot be renamed; a new chart can be given a height, a new table cannot', () => {
    expect(changeableProps({ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result', cols: { L: 6 }, children: [] })).toEqual([]);
    expect(newWidgetProps('PieChart')).toContain('height');
    expect(newWidgetProps('ExtendedTable')).not.toContain('height');
  });

  it('colours: the workspace first, capped, with the ones in use kept', () => {
    const many: ColorSetData[] = [{ id: 's', name: 's', folder: 'ColorRoot', colors: Array.from({ length: 100 }, (_, i) => ({ bid: `c${i}`, name: `C${i}`, rgb: 'rgb(0,0,0)' })) }];
    expect(buildColours(many, []).length).toBe(COLOUR_CAP);
    const inUse = buildColours(many, ['c99']);
    expect(inUse.length).toBe(COLOUR_CAP + 1);
    expect(inUse[COLOUR_CAP].bid).toBe('c99');
    expect(buildColours(null, [])).toEqual([]);
    expect(buildColours([], [])).toEqual([]);
  });

  it('colours: one with the same name and value as another is shown once and shares its ref', () => {
    const dup: ColorSetData[] = [{ id: 's', name: 's', folder: 'cat', colors: [{ bid: 'a', name: 'Open', rgb: '#748695' }, { bid: 'b', name: 'Open', rgb: 'rgb(116,134,149)' }, { bid: 'c', name: 'Done', rgb: '#23836f' }] }];
    const c = buildColours(dup, ['b']);
    expect(c.map(x => [x.ref, x.bid, x.same ?? null])).toEqual([['k1', 'a', ['b']], ['k2', 'c', null]]);
  });

  it('hex conversion', () => {
    expect(toHex('rgb(10, 79, 158)')).toBe('#0a4f9e');
    expect(toHex('rgba(255,0,0,0.5)')).toBe('#ff0000');
    expect(toHex('#c62828')).toBe('#c62828');
  });

  it('buildVocabulary lists only the types on the page', () => {
    const v = buildVocabulary(fixtureModel(), []);
    expect(Object.keys(v.properties).join(', ')).toBe('Tab, Container, ExtendedTable, TextElement, ActionButton, PieChart, DescriptionView, newWidget');
  });
});

describe('ink', () => {
  it('a straight line stays two points; a long wobble is cut to the cap', () => {
    expect(simplifyStroke([[0, 0], [50, 1], [100, 0]])).toEqual([[0, 0], [100, 0]]);
    const wobble: Array<[number, number]> = Array.from({ length: 500 }, (_, i) => [i, Math.round(30 * Math.sin(i / 8))]);
    expect(simplifyStroke(wobble).length).toBeLessThanOrEqual(24);
    expect(simplifyStroke([[1.4, 2.6]])).toEqual([[1, 3]]);
  });
});

describe('nowOf', () => {
  it('a tab has no values; a widget off its defaults shows only what differs', () => {
    const m = fixtureModel();
    expect(nowOf(m.tabs[0], () => null)).toEqual({});
    const w = { ...m.tabs[0].children[3], style: { shadow: false, transparency: 0, headerStyle: 'OUTSIDE', borderStyle: 'LINE', visibility: 'VISIBLE' } };
    expect(nowOf(w, () => null)).toEqual({ columns: 1, headerStyle: 'OUTSIDE' });
  });
});
