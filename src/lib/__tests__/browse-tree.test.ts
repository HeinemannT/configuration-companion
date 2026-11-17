import { describe, expect, it } from 'vitest';
import { browsePlan, buildAncestorsEc, flattenTree, idLookupPlan, isLookupableId, parseAncestors } from '../browse-tree';
import { buildRefRidsEc, groupRefExprs } from '../ref-rid';
import { buildStructureEcMany, parseStructureRows } from '../object-structure';
import type { FullObject } from '../object-read';
import type { ObjectRootPayload } from '../object-window';
import { framedLog } from './ec-frame-fixtures';

const o = (rid: string, type: string, name = '', businessId = ''): FullObject =>
  ({ rid, type, name, businessId, props: {}, references: {}, overridden: [] });
const payload = (root: FullObject, rows: Array<[string, string]>, nodes: FullObject[]): ObjectRootPayload =>
  ({ rid: root.rid, root, rows: rows.map(([rid, parent]) => ({ rid, parent })), nodes: Object.fromEntries(nodes.map(n => [n.rid, n])), posts: 2, ms: 1 });

describe('browsePlan', () => {
  const unlisted = (root: FullObject): ObjectRootPayload => ({ rid: root.rid, root, rows: null, nodes: {}, posts: 1, ms: 1 });
  const TPL = '5100000000000000009';

  it('a ModelPage with a custom reference lists its children and has no "Presented by"', () => {
    const page = { ...o('5278622719348993479', 'ModelPage', 'Risk Management'), references: { '6872637887740031545': ['5100000000000000001'] } };
    expect(browsePlan(unlisted(page))).toEqual({ presented: null, templateRid: null, children: true });
  });

  it('a data object shows its presenting template, not its children', () => {
    const risk = { ...o('1', 'CeRiskAssessment', 'Risk'), references: { template: [TPL] } };
    expect(browsePlan(unlisted(risk))).toEqual({ presented: 'none', templateRid: TPL, children: false });
  });

  it('a data object without a template says so and lists its children', () => {
    expect(browsePlan(unlisted(o('1', 'CeIssue', 'Issue')))).toEqual({ presented: 'none', templateRid: null, children: true });
  });

  it('a type with a structure rule keeps its listing', () => {
    expect(browsePlan({ ...unlisted(o('1', 'Scorecard')), rows: [] }).children).toBe(false);
  });
});

describe('flattenTree', () => {
  it('flattens the root tree pre-order with depth and child counts', () => {
    const p = payload(o('1', 'Scorecard', 'Page'), [['2', '1'], ['3', '2']], [o('2', 'InputView', 'View'), o('3', 'InputSet', 'Set')]);
    expect(flattenTree(p, null).map(n => [n.rid, n.depth, n.kids, n.group])).toEqual([['1', 0, 1, 0], ['2', 1, 1, 0], ['3', 2, 0, 0]]);
  });

  it('puts the presenting template after the object as group 1', () => {
    const own = payload(o('1', 'CeRiskAssessment', 'Risk'), [], []);
    const tpl = payload(o('9', 'EnterpriseTemplate', 'Risk template'), [['10', '9']], [o('10', 'Tab', 'General')]);
    expect(flattenTree(own, tpl).map(n => [n.rid, n.group, n.depth])).toEqual([['1', 0, 0], ['9', 1, 0], ['10', 1, 1]]);
  });
});

describe('ancestors', () => {
  it('reads up to three parents and keeps the two nearest that are not workspace roots, outermost first', () => {
    const ec = buildAncestorsEc('lookup(7282092580979928955)');
    expect(ec).toContain('_p := _o.parent');
    expect(ec.match(/IF _p != MISSING THEN/g)).toHaveLength(3);
    const log = framedLog([['7282092580979928955', 'Scorecard', 'Sandbox | QA'], ['4797501244326270080', 'Organisation', 'Admin|||istration'], ['3928739345485914909', 'OrganisationRoot', 'Organization']]);
    expect(parseAncestors(log).map(c => c.name)).toEqual(['Admin|||istration', 'Sandbox | QA']);
    expect(() => parseAncestors('')).toThrow(/incomplete/i);
  });
});

describe('exact ID lookup', () => {
  it('tries the typed namespace first, then every ID space, in small scripts, and refuses unsafe text', () => {
    const plan = idLookupPlan('ceras.113');
    // The ID is bound once per script; the first space that knows it wins.
    expect(plan.prelude).toEqual(['_k := "ceras.113"', '_s := "113"']);
    expect(plan.exprs[0]).toBe('ceras.get(_s)');
    expect(plan.exprs).toContain('t.get(_k)');
    const scripts = groupRefExprs(plan.exprs, plan.prelude).map(g => buildRefRidsEc(g!, plan.prelude));
    for (const s of scripts) { expect(s.length).toBeLessThanOrEqual(1_200); expect(s.split('\n')[0]).toBe('_k := "ceras.113"'); }
    expect(idLookupPlan('one_id').exprs).toEqual(idLookupPlan('other_id').exprs);
    expect(isLookupableId('a"b')).toBe(false);
    expect(() => idLookupPlan('x") + evil("')).toThrow();
  });
});

describe('several structure listings in one call', () => {
  it('shares one accumulator and returns it once', () => {
    const ec = buildStructureEcMany([
      { ref: 'lookup(1)', rule: { via: 'inputSet', depth: 3 } },
      { ref: 'lookup(2)', rule: { via: 'inputSet', depth: 3 } },
    ]);
    const lines = ec.split('\n');
    expect(lines.filter(l => l === '_r := ""')).toHaveLength(1);
    expect(lines.at(-1)).toBe('_r');
    expect(lines.filter(l => l === '_r')).toHaveLength(1);
    // One loop over the objects of one rule: the walk is written once.
    expect(ec).toContain('LIST(lookup(1), lookup(2)).forEach(_o:');
    expect(ec.match(/_o\.inputSet/g)).toHaveLength(1);
    expect(parseStructureRows('5|||2\n6|||5\n')).toEqual([{ rid: '5', parent: '2' }, { rid: '6', parent: '5' }]);
  });
});
