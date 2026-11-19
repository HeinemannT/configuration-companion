import { describe, expect, it } from 'vitest';
import { directOps, answerText, isName } from '../direct';
import { draftTabs, withDrafts } from '../drafts';
import { buildPayload } from '../payload';
import { assignRefs } from '../refs';
import { parseAnswer } from '../parse-answer';
import { stageAnswer } from '../stage';
import { fixtureModel } from './fixture';
import { findNode } from '../../layout/model';
import type { PtMark } from '../types';

const tab1: PtMark = { n: 1, text: 'Contracts', targets: [], at: 1, reading: 'Tab after Details', meaning: { kind: 'add', tab: true, place: { after: 'tab_details' }, words: 'after tab "Details"' } };
const table: PtMark = {
  n: 2, text: 'Open contracts', targets: [], at: 2, reading: 'Table', ink: { strokes: [{ points: [[0, 0], [9, 9]] }], place: { tabId: 'draft:1', row: 1, col: 1, cols: 6 } },
  meaning: { kind: 'add', place: { into: 'draft:1' }, widget: 'table', types: ['ExtendedTable'], columns: 6 },
};
const build = (model: ReturnType<typeof fixtureModel>, marks: PtMark[]) => buildPayload({ model, marks, colors: null, liveTabId: 'tab_overview', scope: 'template', now: 1 });

describe('drawn tabs', () => {
  it('a drawn tab is a draft beside its anchor, in the anchor tab set, and never changes the model', () => {
    const base = fixtureModel();
    const d = draftTabs([tab1]);
    expect(d).toEqual([{ ref: 'n1', id: 'draft:1', name: 'Contracts', anchor: 'tab_details' }]);
    const m = withDrafts(base, d);
    expect(m.tabs.map(t => t.id)).toEqual(['tab_overview', 'tab_details', 'draft:1']);
    expect(m.tabs[2].tabsetId).toBe('ts');
    expect(base.tabs).toHaveLength(2);
  });

  it('a tab drawn before a tab goes before it; one drawn after a draft goes after that draft', () => {
    const first: PtMark = { ...tab1, meaning: { kind: 'add', tab: true, place: { before: 'tab_overview' } } };
    const second: PtMark = { n: 3, text: 'Notes', targets: [], at: 3, meaning: { kind: 'add', tab: true, place: { after: 'draft:1' } } };
    const m = withDrafts(fixtureModel(), draftTabs([first, second]));
    expect(m.tabs.map(t => t.id)).toEqual(['draft:1', 'draft:3', 'tab_overview', 'tab_details']);
  });

  it('refs of drawn tabs are n1, n2 and the outline marks them new', () => {
    const { payload } = build(fixtureModel(), [tab1, table]);
    expect(payload.outline.map(o => [o.ref, o.name, o.new ?? null])).toEqual([['t1', 'Overview', null], ['t2', 'Details', null], ['n1', 'Contracts', true]]);
    expect(payload.marks[0]).toEqual({ n: 1, drew: 'tab shape after t2 on the tab row', guess: 'add a tab after t2, as n1', says: 'Contracts', handled: true });
    expect(payload.marks[1]).toEqual({ n: 2, drew: 'square on n1 at row 1, columns 1-6, lines inside', guess: 'add a table, 6 columns wide, into n1', says: 'Open contracts', handled: true });
  });

  it('the snapshot keeps the drafts out of the page refs and holds what the marks say on their own', () => {
    const { snapshot } = build(fixtureModel(), [tab1, table]);
    expect(snapshot.refs.some(r => r.id.startsWith('draft:'))).toBe(false);
    expect(snapshot.drafts).toEqual([{ ref: 'n1', id: 'draft:1', name: 'Contracts', anchor: 'tab_details' }]);
    expect(snapshot.direct?.map(o => [o.notes[0], o.op, o.type, o.name])).toEqual([[1, 'add', 'Tab', 'Contracts'], [2, 'add', 'ExtendedTable', 'Open contracts']]);
  });
});

describe('direct operations', () => {
  it('a named tab, a named sketched widget and a move with no words', () => {
    const refs = assignRefs(withDrafts(fixtureModel(), draftTabs([tab1])));
    const move: PtMark = { n: 3, text: '', targets: ['btn_export'], at: 3, meaning: { kind: 'move', to: { before: 'btn_new_risk' } } };
    expect(directOps([tab1, table, move], refs)).toEqual([
      { notes: [1], op: 'add', type: 'Tab', name: 'Contracts', place: { after: 't2' }, as: 'n1' },
      { notes: [2], op: 'add', type: 'ExtendedTable', name: 'Open contracts', place: { into: 'n1' }, properties: { columns: 6 } },
      { notes: [3], op: 'move', ref: 'o5', to: { before: 'o4' } },
    ]);
  });

  it('never a crossed-out object, a move with words, an unnamed tab or a sentence for a widget', () => {
    const unnamed: PtMark = { ...tab1, text: '' };
    const refs = assignRefs(withDrafts(fixtureModel(), draftTabs([unnamed])));
    const crossed: PtMark = { n: 3, text: '', targets: ['btn_export'], at: 3, meaning: { kind: 'crossed' } };
    const move: PtMark = { n: 4, text: 'left please', targets: ['btn_export'], at: 4, meaning: { kind: 'move', to: { before: 'btn_new_risk' } } };
    const sentence: PtMark = { ...table, n: 5, text: 'A table of all contracts.' };
    expect(directOps([unnamed, crossed, move, sentence], refs)).toEqual([]);
    expect(isName('Open contracts')).toBe(true);
    expect(isName('Is this right?')).toBe(false);
    expect(isName('Chart of controls by test result for the last 12 months')).toBe(false);
    expect(isName('Show open risks by owner, with the number of controls')).toBe(false);
    expect(isName('Controls by test result')).toBe(true);
  });
});

describe('staging a drawn tab', () => {
  it('stages the tab after its anchor and the widget drawn on it into it, from the answer text of the direct operations', () => {
    const { snapshot } = build(fixtureModel(), [tab1, table]);
    const parsed = parseAnswer(answerText(snapshot.direct ?? []));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = stageAnswer(fixtureModel(), snapshot, parsed.answer);
    expect(r.reports.flatMap(x => x.results.map(y => [y.verdict, y.text]))).toEqual([['ok', 'Add Tab "Contracts" after tab "Details"'], ['ok', 'Add ExtendedTable "Open contracts" into tab "Contracts"']]);
    expect(r.final.tabs.map(t => t.name)).toEqual(['Overview', 'Details', 'Contracts']);
    expect(findNode(r.final, r.final.tabs[2].id)?.node.children.map(c => c.name)).toEqual(['Open contracts']);
    expect(r.reports[0].results[0].warning).toBeUndefined();
  });

  it('puts a tab between tabs, drops the answer\'s own add of the drawn tab and says an empty tab is not shown', () => {
    const between: PtMark = { ...tab1, meaning: { kind: 'add', tab: true, place: { after: 'tab_overview' } } };
    const { snapshot } = build(fixtureModel(), [between]);
    const answer = { operations: [{ notes: [1], op: 'add' as const, type: 'Tab', name: 'Contracts', place: { after: 't2' }, as: 'n1' }], questions: [], cannot: [] };
    const r = stageAnswer(fixtureModel(), snapshot, answer);
    expect(r.final.tabs.map(t => t.name)).toEqual(['Overview', 'Contracts', 'Details']);
    expect(r.reports[0].results).toHaveLength(1);
    expect(r.reports[0].results[0].warning).toBe('BMP shows a tab once it holds a widget.');
  });

  it('on a page with no tabs the first drawn tab makes the tab set', () => {
    const empty = { ...fixtureModel(), tabs: [], resultOnly: true };
    const first: PtMark = { ...tab1, meaning: { kind: 'add', tab: true, place: { into: 'draft:page' } } };
    const { snapshot } = build(empty, [first]);
    const r = stageAnswer(empty, snapshot, { operations: [], questions: [], cannot: [] });
    expect(r.reports[0].results[0].verdict).toBe('ok');
    expect(r.final.resultOnly).toBe(false);
    expect(r.final.tabs.map(t => t.name)).toEqual(['Contracts']);
    expect(r.final.tabsetName).toBe('Operational Risk Tabs');
  });
});
