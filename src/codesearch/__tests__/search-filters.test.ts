/**
 * The two-level filters of the code search window: the group tables
 * (Kind of code, Object type), the trees the menus draw, choosing a group
 * as a whole, the Where tree of roots and organisations, the result-bar
 * chips, and saved searches with the old filter values.
 */
import { describe, expect, it } from 'vitest';
import { CODE_KINDS, familyOfType, kindOfProp, TYPE_FAMILIES } from '../../lib/object-window-table';
import {
  chosenLabels, coverageLine, coverageText, familyTree, indexFacets, indexText, kindTree, optionsText, parseRecents, toggleEntry, topKinds, whereTree,
} from '../search-model';

/** Every code property and type the test server's index held. */
const PROPS = ['showExpression', 'expression', 'firstColorExpression', 'firstExpression', 'initExpression', 'afterExpression', 'editExpression', 'defaultExpression',
  'requiredExpression', 'parentDestinationExpression', 'colorExpression', 'linkExpression', 'backgroundColorExpression', 'refreshExpression', 'secondExpression',
  'secondColorExpression', 'destinationExpression', 'enableExpression', 'html', 'javascript', 'secondLinkExpression', 'text', 'useExpression', 'firstLinkExpression',
  'filterExpression', 'markerPlacementExpression', 'longText', 'variablesExpression', 'markerBorderColorExpression', 'customNavigationTargetExpressionOnComplete'];
const TYPES = ['ReferenceInput', 'CardPart', 'ExtendedExpression', 'ExtendedTable', 'BarChart', 'ActionButton', 'EditPageValidation', 'EditField', 'CreateObjectView',
  'Card', 'PieChart', 'HistoricalReferenceMethodConfig', 'CustomVisualizationExpression', 'ReferenceMethodConfig', 'Label', 'ButtonInput', 'ListInput', 'TextInput',
  'DateInput', 'CustomVisualization', 'TextElement', 'GanttChart', 'EditPage', 'NumberInput', 'BarLineChart', 'LockPolicy', 'ExtendedMethodConfig', 'LineChart',
  'RelationshipCard', 'EditPageInfo', 'FilteredComments', 'WaterfallChart', 'BooleanInput', 'ExtendedTargetConfig', 'RiskChart', 'Validation', 'CategoryAxisPlotline',
  'NumberAxisPlotline', 'ImageView', 'UserTaskPage', 'ExtendedTransport', 'NotificationTransportGroup', 'AreaChart', 'BubbleChart', 'RadarChart', 'PolarChart'];

describe('group tables', () => {
  it('puts every property in the group the owner approved, by table or by name', () => {
    const want: Record<string, string[]> = {
      expressions: ['expression', 'firstExpression', 'secondExpression', 'filterExpression', 'markerPlacementExpression'],
      actions: ['initExpression', 'afterExpression', 'refreshExpression'],
      conditions: ['showExpression', 'enableExpression', 'editExpression', 'requiredExpression', 'useExpression'],
      defaults: ['defaultExpression'],
      navigation: ['destinationExpression', 'parentDestinationExpression', 'linkExpression', 'firstLinkExpression', 'secondLinkExpression'],
      appearance: ['colorExpression', 'backgroundColorExpression', 'firstColorExpression', 'secondColorExpression'],
      custom: ['html', 'javascript', 'text'],
    };
    for (const [k, props] of Object.entries(want)) for (const p of props) expect(kindOfProp(p), p).toBe(k);
    // Not in the table: by name pattern.
    expect(kindOfProp('headerColorExpression')).toBe('appearance');
    expect(kindOfProp('onSaveExpression')).toBe('actions');
    expect(kindOfProp('visibleExpression')).toBe('conditions');
    expect(kindOfProp('someNewExpression')).toBe('expressions');
    expect(kindOfProp('weird')).toBe('other');
    expect(PROPS.every(p => kindOfProp(p) !== 'other')).toBe(true);
    expect(new Set(CODE_KINDS.flatMap(k => k.props)).size).toBe(CODE_KINDS.flatMap(k => k.props).length);
  });

  it('puts every type in exactly one family; only LockPolicy is Other on the test server', () => {
    const fam = Object.fromEntries(TYPES.map(t => [t, familyOfType(t)]));
    expect(fam).toMatchObject({
      ExtendedTable: 'tables', FilteredComments: 'tables', BarChart: 'charts', RiskChart: 'charts', CategoryAxisPlotline: 'charts',
      TextInput: 'inputs', EditField: 'inputs', Label: 'inputs', ActionButton: 'buttons', ButtonInput: 'buttons',
      EditPage: 'pages', CreateObjectView: 'pages', UserTaskPage: 'pages', ImageView: 'pages', Card: 'cards', CardPart: 'cards', RelationshipCard: 'cards',
      ExtendedMethodConfig: 'calc', ReferenceMethodConfig: 'calc', HistoricalReferenceMethodConfig: 'calc', ExtendedExpression: 'expressions',
      ExtendedTransport: 'notify', NotificationTransportGroup: 'notify', ExtendedTargetConfig: 'notify',
      CustomVisualization: 'custom', CustomVisualizationExpression: 'custom', TextElement: 'text',
    });
    expect(TYPES.filter(t => familyOfType(t) === 'other')).toEqual(['LockPolicy']);
    expect(familyOfType('SomethingNew')).toBe('other');
    const listed = TYPE_FAMILIES.flatMap(f => f.types);
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe('two-level menus', () => {
  const propCounts = { expression: 12, showExpression: 4, enableExpression: 2, afterExpression: 3 };
  const kindCounts = { expressions: 12, conditions: 5, actions: 3 };

  it('groups properties by purpose with counts on both levels, most first', () => {
    const tree = kindTree(Object.keys(propCounts), propCounts, kindCounts, []);
    expect(tree.map(e => [e.label, e.n])).toEqual([['Expressions', 12], ['Actions', 3], ['Conditions', 5]]);
    const cond = tree.find(e => e.key === 'kind:conditions')!;
    expect(cond.children!.map(c => [c.label, c.n])).toEqual([['Show expression', 4], ['Enable expression', 2]]);
  });

  it('chooses a group as a whole, and shows a part of it as mixed', () => {
    let chosen: string[] = [];
    const tree = () => kindTree(Object.keys(propCounts), propCounts, kindCounts, chosen);
    chosen = toggleEntry(chosen, tree().find(e => e.key === 'kind:conditions')!);
    expect(chosen.sort()).toEqual(['enableExpression', 'showExpression']);
    expect(tree().find(e => e.key === 'kind:conditions')!.on).toBe(true);
    expect(chosenLabels(tree(), chosen)).toEqual(['Conditions']);
    chosen = toggleEntry(chosen, tree().find(e => e.key === 'kind:conditions')!.children![0]);
    expect(tree().find(e => e.key === 'kind:conditions')!.on).toBe('some');
    expect(chosenLabels(tree(), chosen)).toEqual(['Enable expression']);
    chosen = toggleEntry(chosen, tree().find(e => e.key === 'kind:conditions')!);
    expect(chosen.sort()).toEqual(['enableExpression', 'showExpression']);
  });

  it('sums a family from its types and filters by label', () => {
    const t = familyTree(['ExtendedTable', 'BarChart', 'PieChart', 'ActionButton'], { ExtendedTable: 5, BarChart: 2, PieChart: 1, ActionButton: 0 }, []);
    expect(t.map(e => [e.label, e.n])).toEqual([['Tables', 5], ['Charts', 3], ['Buttons', 0]]);
    expect(familyTree(['ExtendedTable', 'BarChart'], undefined, [], 'bar').map(e => e.children!.map(c => c.key))).toEqual([['BarChart']]);
  });

  it('lists the roots that hold code with their names, organisations inside', () => {
    const roots = [
      { key: 'templateCategory', name: 'Template category', objects: 900 },
      { key: 'risk', name: 'Risk', objects: 0 },
      { key: 'organisation', name: 'Organization', objects: 3000 },
    ];
    const orgs = { 1: { name: 'Group', parent: '' }, 2: { name: 'Europe', parent: '1' }, 3: { name: 'Admin', parent: '' } };
    const counts = { 'root:templateCategory': 4, 'root:organisation': 9, 'org:1': 7, 'org:2': 5, 'org:3': 2 };
    const t = whereTree(roots, orgs, counts, []);
    expect(t.map(e => [e.label, e.n])).toEqual([['Template category', 4], ['Organization', 9]]);
    const org = t[1];
    expect(org.children!.map(c => [c.label, c.n])).toEqual([['Group', 7], ['Admin', 2]]);
    expect(org.children![0].children!.map(c => c.label)).toEqual(['Europe']);
    // Choosing an organisation covers its sub-organisations.
    const chosen = toggleEntry([], org.children![0]);
    expect(chosen).toEqual(['org:1']);
    const again = whereTree(roots, orgs, counts, chosen);
    expect(again[1].on).toBe('some');
    expect(again[1].children![0].children![0].on).toBe(true);
    expect(chosenLabels(again, chosen)).toEqual(['Group']);
    // Choosing the root replaces the organisations chosen inside it.
    expect(toggleEntry(chosen, again[1])).toEqual(['root:organisation']);
  });

  it('counts the index before a query, inherited code included', () => {
    const f = indexFacets([
      { type: 'ExtendedTable', code: {}, inherits: ['expression'], root: 'organisation', path: ['1', '2'] },
      { type: 'ActionButton', code: { showExpression: 'x' }, root: 'templateCategory' },
    ]);
    expect(f).toMatchObject({ props: { expression: 1, showExpression: 1 }, kinds: { expressions: 1, conditions: 1 }, where: { 'root:organisation': 1, 'org:1': 1, 'org:2': 1, 'root:templateCategory': 1 } });
  });

  it('offers the top kinds of code of the results as chips', () => {
    expect(topKinds(kindCounts, []).map(k => k.label)).toEqual(['Expressions', 'Conditions', 'Actions']);
    expect(topKinds(kindCounts, ['showExpression', 'enableExpression'])).toEqual([]);
  });
});

describe('saved searches and coverage sentences', () => {
  it('keeps old saved searches (real types and properties) working, and new ones with their places', () => {
    const old = parseRecents([{ mode: 'text', query: 'x', caseSensitive: true, types: ['ExtendedTable'], props: ['showExpression'] }, { mode: 'text', query: 'y', codeOf: 'tables' }]);
    expect(old[0]).toMatchObject({ types: ['ExtendedTable'], props: ['showExpression'] });
    expect(old[0].where).toBeUndefined();
    expect(old[1].types).toEqual(['ExtendedTable']);
    const fresh = parseRecents([{ mode: 'text', query: 'z', types: [], props: [], where: [{ key: 'root:portal', label: 'Portal' }, { key: 'bad key', label: 'x' }] }]);
    expect(fresh[0].where).toEqual([{ key: 'root:portal', label: 'Portal' }]);
    expect(optionsText(fresh[0])).toMatch(/^Portal · Any type/);
  });

  it('says what a root-by-root build covers', () => {
    const roots = [
      { key: 'templateCategory', name: 'Template category', done: true }, { key: 'portal', name: 'Portal', done: true },
      { key: 'expression', name: 'Expression', done: true }, { key: 'page', name: 'Page', done: true },
      { key: 'organisation', name: 'Organization', done: false, tops: 19, topsDone: 4 },
    ];
    expect(coverageLine(roots)).toBe('Template category, Portal, Expression and 1 more ready; Organization: 4 of 19');
    expect(indexText({ state: 'building', syncedAt: null, objects: 10, pending: 3, roots, stage: 'organisation' }))
      .toBe('Making the copy: Template category, Portal, Expression and 1 more ready; Organization: 4 of 19. Search covers what is ready.');
    expect(coverageLine(roots.map(r => ({ ...r, done: true })))).toBeNull();
    expect(coverageText({ source: 'index', searched: 40, total: 40, complete: true, scopedComplete: true })).toBe('Searched 40 objects with code: the chosen part is read completely.');
    expect(coverageText({ source: 'index', searched: 40, total: 90, complete: false, roots: { done: ['portal'], pending: ['organisation'], tops: { done: 4, total: 19 } } }))
      .toBe('Searched 40 objects with code in the parts read so far; organisation: 4 of 19 top-level organisations read so far.');
  });
});
