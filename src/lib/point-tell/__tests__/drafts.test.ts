import { describe, expect, it } from 'vitest';
import { draftTabs, withDrafts } from '../drafts';
import { buildPayload } from '../payload';
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
    expect(payload.marks[1]).toEqual({ n: 2, drew: 'square on n1 at row 1, columns 1-6, lines inside', guess: 'add a table, 6 columns wide, into n1', says: 'Open contracts' });
  });

  it('the snapshot keeps the drafts out of the page refs', () => {
    const { snapshot } = build(fixtureModel(), [tab1, table]);
    expect(snapshot.refs.some(r => r.id.startsWith('draft:'))).toBe(false);
    expect(snapshot.drafts).toEqual([{ ref: 'n1', id: 'draft:1', name: 'Contracts', anchor: 'tab_details' }]);
  });
});

describe('staging a drawn tab', () => {
  it('stages the tab after its anchor and the widget an answer adds into it', () => {
    const { snapshot } = build(fixtureModel(), [tab1, table]);
    const parsed = parseAnswer(JSON.stringify({ operations: [{ note: 2, op: 'add', type: 'ExtendedTable', name: 'Open contracts', place: { into: 'n1' }, properties: { columns: 6 } }] }));
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
