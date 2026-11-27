/**
 * Browse's "Locate on page": what the panel asks for (the object, the
 * ancestors that may stand in for it, the page tabs on its path) and what it
 * says about each answer.
 */
import { describe, expect, it } from 'vitest';
import type { BrowseNode } from '../browse-tree';
import { cleanLocateAnswer, cleanLocateTabs, layoutTabs, locateLine, locateRequest, type LayoutObject } from '../locate-plan';

const node = (rid: string, parent: string | null, type: string, name = rid, depth = 0): BrowseNode =>
  ({ rid, parent, depth, group: 0, type, name, businessId: `id${rid}`, kids: 0 });

// Page 1 > tab 10 "Overview" > chart 11; page 1 > tab 20 "Controls" > input set 21 > input 22;
// tab 20 > tab 30 "Details" (a nested strip) > table 31; page 1 > header 40 (outside any tab).
const tree: BrowseNode[] = [
  node('1', null, 'Scorecard', 'Risk page'),
  node('10', '1', 'Tab', 'Overview', 1),
  node('11', '10', 'Chart', 'Heat map', 2),
  node('20', '1', 'Tab', 'Controls', 1),
  node('21', '20', 'InputSet', 'Control inputs', 2),
  node('22', '21', 'Input', 'Owner', 3),
  node('30', '20', 'Tab', 'Details', 2),
  node('31', '30', 'Table', 'Tests', 3),
  node('40', '1', 'Text', 'Header', 1),
];

describe('locateRequest', () => {
  it('names the tab that holds the object and lets only ancestors inside that tab stand in', () => {
    expect(locateRequest(tree, '22')).toEqual({ rids: ['22', '21'], tabs: [{ rid: '20', name: 'Controls' }] });
    expect(locateRequest(tree, '11')).toEqual({ rids: ['11'], tabs: [{ rid: '10', name: 'Overview' }] });
  });

  it('lists nested tabs outermost first', () => {
    expect(locateRequest(tree, '31')).toEqual({ rids: ['31'], tabs: [{ rid: '20', name: 'Controls' }, { rid: '30', name: 'Details' }] });
  });

  it('a tab is found by its own button, after the tabs around it', () => {
    expect(locateRequest(tree, '30')).toEqual({ rids: ['30'], tabs: [{ rid: '20', name: 'Controls' }] });
    expect(locateRequest(tree, '10')).toEqual({ rids: ['10'], tabs: [] });
  });

  it('without a tab on the path the whole chain stands in, as before', () => {
    expect(locateRequest(tree, '40')).toEqual({ rids: ['40', '1'], tabs: [] });
  });

  it('an object outside the tree (or no tree) is asked for alone', () => {
    expect(locateRequest(tree, '999')).toEqual({ rids: ['999'], tabs: [] });
    expect(locateRequest(null, '22')).toEqual({ rids: ['22'], tabs: [] });
  });

  it('a tab without a name falls back to its ID', () => {
    const t = [node('1', null, 'Scorecard'), { ...node('2', '1', 'Tab', ''), businessId: 'TAB-2' }, node('3', '2', 'Chart')];
    expect(locateRequest(t, '3').tabs).toEqual([{ rid: '2', name: 'TAB-2' }]);
  });
});

describe('locateLine', () => {
  it('a ring on the page is a short status line', () => {
    expect(locateLine('22', { found: '22' })).toEqual({ where: 'status', text: 'Located on the page' });
    expect(locateLine('22', { found: '22', tab: 'Controls', switched: true })).toEqual({ where: 'status', text: 'Located on the tab Controls' });
    expect(locateLine('22', { found: '21' }, 'Control inputs')).toEqual({ where: 'status', text: 'Located its widget, Control inputs' });
    expect(locateLine('22', { found: '21', tab: 'Controls', switched: true }, 'Control inputs').text).toBe('Located its widget, Control inputs, on the tab Controls');
  });

  it('nothing ringed: a note at the row that says why', () => {
    expect(locateLine('22', { found: null, tab: 'Controls', why: 'other-tab' })).toEqual({ where: 'row', text: 'On the tab Controls. Open that tab to see it.' });
    // The tab was open already: the object is not shown there.
    expect(locateLine('22', { found: null, tab: 'Controls', why: 'not-shown' })).toEqual({ where: 'row', text: 'Not shown on the tab Controls as it is now.' });
    expect(locateLine('22', { found: null, tab: 'Controls', switched: true, why: 'not-shown' }).text).toBe('Not shown on the tab Controls as it is now.');
    expect(locateLine('22', { found: null, why: 'not-shown' }).text).toBe('Not shown on this page as it is now.');
    expect(locateLine('22', { found: null }).text).toBe('Not shown on this page as it is now.');
    expect(locateLine('22', { found: null, why: 'other-tab' }).text).toBe('Not shown on this page as it is now.');
    expect(locateLine('22', { found: null, why: 'page-behind' }).text).toMatch(/^The BMP page is not in front\./);
    expect(locateLine('22', { found: null, why: 'no-page' }).text).toBe('No BMP page is open in front in this window.');
  });

  it('never uses an em dash', () => {
    const answers = [{ found: null, why: 'page-behind' as const }, { found: null, why: 'no-page' as const }, { found: null, tab: 'X', why: 'other-tab' as const }];
    for (const a of answers) expect(locateLine('1', a).text).not.toMatch(/—/);
  });
});

describe('worker checks', () => {
  const isRid = (r: string) => /^-?\d+$/.test(r);
  it('keeps rid-shaped tabs, trims names, at most four (the innermost)', () => {
    expect(cleanLocateTabs([{ rid: '1', name: ' A ' }, { rid: 'x', name: 'B' }, null, { rid: '2' }], isRid)).toEqual([{ rid: '1', name: 'A' }, { rid: '2', name: '' }]);
    expect(cleanLocateTabs('nope', isRid)).toEqual([]);
    expect(cleanLocateTabs(['1', '2', '3', '4', '5'].map(rid => ({ rid, name: rid })), isRid).map(t => t.rid)).toEqual(['2', '3', '4', '5']);
  });

  it('passes on only the known answer fields', () => {
    expect(cleanLocateAnswer({ found: '5', tab: 'Controls', switched: true, extra: 1 })).toEqual({ found: '5', tab: 'Controls', switched: true });
    expect(cleanLocateAnswer({ found: 5, why: 'bogus' })).toEqual({ found: null });
    expect(cleanLocateAnswer(undefined)).toEqual({ found: null });
    expect(cleanLocateAnswer({ found: null, why: 'other-tab', tab: 'T' })).toEqual({ found: null, why: 'other-tab', tab: 'T' });
  });
});

describe('layoutTabs', () => {
  // As on BMP 5.6.20: a template widget names its layout container; the
  // container's parents run tab > tab set > (container > tab > tab set) > Layout.
  const objects: Record<string, LayoutObject> = {
    w: { type: 'InputView', name: 'Work status', references: { container: ['c'], parent: ['tpl'] } },
    tpl: { type: 'EnterpriseTemplate', name: 'Action', references: {} },
    c: { type: 'Container', name: 'Container', references: { parent: ['t2'] } },
    t2: { type: 'Tab', name: 'Manage work', references: { parent: ['set'] } },
    set: { type: 'TabSet', name: 'Action', references: { parent: ['c0'] } },
    // A nested tab set: its own container on an outer tab.
    c0: { type: 'Container', name: 'Container', references: { parent: ['t1'] } },
    t1: { type: 'Tab', name: 'Overview', references: { parent: ['outer'] } },
    outer: { type: 'TabSet', name: 'Pages', references: { parent: ['layout'] } },
    layout: { type: 'Category', name: 'Layout', references: { parent: ['root'] } },
  };
  const reads: string[][] = [];
  const read = (rids: string[]) => { reads.push(rids); return Promise.resolve(Object.fromEntries(rids.map(r => [r, objects[r] ?? null]))); };

  it('finds the tabs of a widget from its layout container, outermost first, and stops at the category', async () => {
    reads.length = 0;
    expect(await layoutTabs(read, ['w', 'tpl'])).toEqual([{ rid: 't1', name: 'Overview' }, { rid: 't2', name: 'Manage work' }]);
    // The widget is read alone; its ancestors are not read when it names its container.
    expect(reads).toEqual([['w'], ['c'], ['t2'], ['set'], ['c0'], ['t1'], ['outer'], ['layout']]);
  });

  it('an ancestor that stands in names the container when the object has none', async () => {
    reads.length = 0;
    expect((await layoutTabs(read, ['x', 'w'])).map(t => t.rid)).toEqual(['t1', 't2']);
    expect(reads.slice(0, 2)).toEqual([['x'], ['w']]);
  });

  it('a refused batch of ancestors does not hide the widget\'s own container', async () => {
    const strict = (rids: string[]) => (rids.length > 1 ? Promise.reject(new Error('refused')) : read(rids));
    expect((await layoutTabs(strict, ['w', 'tpl', 'root'])).map(t => t.rid)).toEqual(['t1', 't2']);
  });

  it('no container: no tab, one read', async () => {
    reads.length = 0;
    expect(await layoutTabs(read, ['tpl'])).toEqual([]);
    expect(reads).toHaveLength(1);
    expect(await layoutTabs(read, [])).toEqual([]);
  });
});
