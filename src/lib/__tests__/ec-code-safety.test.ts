// @vitest-environment happy-dom
/**
 * The rule of ec-code-safety: no script the extension builds reads a code
 * property in a form that evaluates it. Runs `findEvaluatingCodeReads` over
 * the output of the script builders for representative inputs, including
 * every code property the extension knows and the discovered custom ones.
 */
import { describe, expect, it } from 'vitest';
import './chrome-mock';
import { ALLOWED_EVALUATIONS, findEvaluatingCodeReads, isCodeProperty, pathTouchesCode } from '../ec-code-safety';
import { ecResolveTemplate } from '../template-link';
import { STATIC_EC_FRAME } from '../ec-parser';
import { buildBucketInventoryEc, buildCountEc, buildExistsEc, buildInventoryEc, buildReadEc, buildSampleEc, buildRootListEc, buildSummaryEc, orgBucket, rootBucket, STATIC_CODE_PROPS } from '../code-index-sync';
import { buildHitScanEcs, buildSourceCodeEc, buildSourceListEc } from '../code-scope-read';
import { buildCodeScopeEc } from '../code-search-scope';
import { buildRefResolveEc } from '../code-ref-resolve';
import { buildNameSearchEc } from '../object-search';
import { buildIdentityEc } from '../handlers/code-search';
import { buildHoverResolveEc, hoverRefAllowed } from '../handlers/objects';
import { buildStructureEc, buildStructureEcMany } from '../object-structure';
import { buildSuggestEc } from '../compare-read';
import { buildAncestorsEc, idLookupPlan } from '../browse-tree';
import { buildRefRidsEc } from '../ref-rid';
import { buildConnectionsEc, buildInboundEc, buildJunctionEc } from '../connections';
import { buildEditFieldPropertyEc, buildEditFieldTypesEc, buildObjectPaneEc, buildPropertyApplicationsEc } from '../ec-codegen';
import { buildAccessSubjectsEc, buildColorSetsEc, buildLayoutTreeEc, EcQueryService } from '../ec-query-service';
import { buildContextQueryEc } from '../handlers/ai-tools';
import { buildStudioChildrenEc } from '../handlers/studio';
import { buildContextEc, buildEditPageFetchEc, buildFetchEc, buildFlowRefChildrenEc, buildFlowRefListEc } from '../layout/sync';
import { compileSearch } from '../code-search-match';

/** Every code property a server answered with on the test server, plus the
 *  static ones: the builders must stay safe for all of them. */
const DISCOVERED: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries(STATIC_CODE_PROPS).map(([t, p]) => [t, [...p]])),
  ButtonInput: ['expression', 'initExpression', 'afterExpression', 'defaultExpression', 'enableExpression', 'refreshExpression', 'showExpression', 'destinationExpression'],
  CardPart: ['secondExpression', 'firstColorExpression', 'firstExpression', 'firstLinkExpression', 'secondLinkExpression', 'secondColorExpression'],
  UserTaskPage: ['customNavigationTargetExpressionOnComplete'],
  ReferenceInput: ['enableExpression', 'showExpression', 'defaultExpression', 'refreshExpression', 'expression', 'filterExpression'],
  TextElement: ['text', 'longText'],
};
const F = STATIC_EC_FRAME;
const REF = 'lookup(123)';

function expectSafe(name: string, ec: string) {
  const bad = findEvaluatingCodeReads(ec);
  expect(bad.map(b => `${name}: ${b.prop} in …${b.context}…`)).toEqual([]);
}

describe('the checker', () => {
  it('knows code properties and leaves class names alone', () => {
    for (const p of ['expression', 'showExpression', 'customNavigationTargetExpressionOnComplete', 'html', 'javascript', 'text', 'longText']) expect(isCodeProperty(p)).toBe(true);
    for (const p of ['ExtendedExpression', 'name', 'id', 'rid', 'inputSet', '_v_expression']) expect(isCodeProperty(p)).toBe(false);
    expect(isCodeProperty('script', new Set(['script']))).toBe(true);
    expect(pathTouchesCode('t.x.expression')).toBe(true);
    expect(pathTouchesCode('ceras.foo.parent.owning_org')).toBe(false);
  });

  it('flags every evaluating form the probe found and passes the text forms', () => {
    const evaluating = [
      '_o.expression', 'str(_o.expression)', '_o.expression.whenMissing("")', '_v := _o.showExpression\noutput(_v)',
      'SELECT ButtonInput FROM root WHERE expression != ""', '_l.filter(expression = 42)', '_l.table(id, expression)',
      '_o.html.indexOf("x")', 'output(_o.expression).size() + _o.afterExpression.size()', '_o := t.x.expression',
    ];
    for (const ec of evaluating) expect(findEvaluatingCodeReads(ec), ec).not.toEqual([]);
    const safe = [
      'output(_o.expression)', 'output(_o.expression.whenMissing(""))', '_v := output(_o.expression)\n_v.whenMissing("").size()',
      'SELECT ButtonInput FROM root WHERE output(expression) = "x"', '_l.filter(output(showExpression) = "TRUE")',
      'output(lookup(1).parent.expression)', '_o.change(expression := "1")', '_cls = "ExtendedExpression"', '"code_expression"',
      '_r := _r + "\\"expression\\""',
    ];
    for (const ec of safe) expect(findEvaluatingCodeReads(ec), ec).toEqual([]);
  });
});

describe('the named exceptions', () => {
  it('allow exactly the enterprise template selector, in its exact form', () => {
    expect(ALLOWED_EVALUATIONS.map(e => e.name)).toEqual(['enterprise-template-selector']);
    expect(findEvaluatingCodeReads(ecResolveTemplate('_o', '_t').join('\n'))).toEqual([]);
    expect(findEvaluatingCodeReads(ecResolveTemplate('_inst', '_tmpl', '  ').join('\n'))).toEqual([]);
    // Anything else that reads a template expression still fails.
    expect(findEvaluatingCodeReads('_x := _o.templateExpression.expression')).not.toEqual([]);
    expect(findEvaluatingCodeReads('_tExpression := _o.templateExpression\n_v := _tExpression.expression')).not.toEqual([]);
    expect(findEvaluatingCodeReads('_tExpression := _o.templateExpression\nIF _tExpression = MISSING THEN _t := MISSING ELSE _t := _tExpression.expression ENDIF\n_o.expression')).toHaveLength(1);
  });
});

describe('every script builder reads code only through output()', () => {
  it('code index: sample, root list, inventory, read', () => {
    expectSafe('sample', buildSampleEc(Object.keys(DISCOVERED)));
    expectSafe('roots', buildRootListEc(['organisation', 'portal', 'templateCategory'], F));
    const types = Object.keys(DISCOVERED);
    expectSafe('exists', buildExistsEc(types, ['root', 'root.portal']));
    expectSafe('summary', buildSummaryEc(types, ['root', 'root.portal'], '2026-11-09', F));
    expectSafe('count', buildCountEc(types, 'this.object', true));
    expectSafe('count by root', buildCountEc(types, 'root.portal'));
    for (const b of [rootBucket('portal'), orgBucket('5'), orgBucket('5', true)]) {
      expectSafe('list', buildBucketInventoryEc(b, types, F));
      expectSafe('list changed', buildBucketInventoryEc(b, types, F, { since: '2026-11-09' }));
      expectSafe('list RIDs', buildBucketInventoryEc(b, types, F, { ridsOnly: true }));
    }
    for (const [type, props] of Object.entries(DISCOVERED)) {
      expectSafe(`inventory ${type}`, buildInventoryEc(type, F, { map: DISCOVERED }));
      expectSafe(`inventory ${type} scoped`, buildInventoryEc(type, F, { map: DISCOVERED, from: 'root.portal' }));
      expectSafe(`read ${type}`, buildReadEc([{ rid: '1', ref: REF, type, props }], F));
    }
  });

  it('code search server scan, for every prefilter kind', () => {
    for (const q of ['foo', 'a*b', '^x.*$']) {
      const c = compileSearch({ query: q, caseSensitive: false, wholeWord: false, regex: q.startsWith('^') });
      if ('error' in c) throw new Error(c.error);
      if (c.prefilter.kind !== 'all') {
        for (const s of buildHitScanEcs(Object.keys(DISCOVERED), c.prefilter, DISCOVERED)) expectSafe(`narrow ${q} ${s.type}`, s.code);
        for (const s of buildHitScanEcs(Object.keys(DISCOVERED), c.prefilter, DISCOVERED, true)) expectSafe(`narrow scope ${q} ${s.type}`, s.code);
      }
    }
    expectSafe('source list', buildSourceListEc(Object.keys(DISCOVERED), DISCOVERED));
    expectSafe('source list by root', buildSourceListEc(Object.keys(DISCOVERED), DISCOVERED, 'root.portal'));
    for (const type of Object.keys(DISCOVERED)) {
      expectSafe(`source code ${type}`, buildSourceCodeEc(type, DISCOVERED));
      expectSafe(`source code ${type} part`, buildSourceCodeEc(type, DISCOVERED, 1, 4));
    }
  });

  it('the scope of a search under an object', () => {
    for (const type of ['InputView', 'ActionButton', 'CreateObjectView', 'ExtendedExpression']) expectSafe(`scope ${type}`, buildCodeScopeEc(REF, type, F, DISCOVERED));
  });

  it('references, picker, identity, hover, structure, compare, browse, connections', () => {
    expectSafe('refs', buildRefResolveEc(['t.a', 'rid:5', 'o.b-c'], F));
    expectSafe('picker', buildNameSearchEc('ExtendedExpression', 'today', F));
    expectSafe('identity', buildIdentityEc(REF));
    expectSafe('hover', buildHoverResolveEc('t.x', F));
    expect(hoverRefAllowed('t.x.parent')).toBe(true);
    expect(hoverRefAllowed('t.x.expression')).toBe(false);
    expect(hoverRefAllowed('t.x.showExpression.name')).toBe(false);
    expectSafe('structure', buildStructureEc(REF, { via: 'inputSet', depth: 3 }));
    expectSafe('structure many', buildStructureEcMany([{ ref: REF, rule: { depth: 2 } }, { ref: REF, rule: { via: 'actionObject', depth: 1 } }]));
    expect(() => buildStructureEc(REF, { via: 'expression', depth: 1 })).toThrow();
    expectSafe('compare', buildSuggestEc(REF, { templateRef: 'lookup(2)', parentRef: 'lookup(3)' }));
    expectSafe('ancestors', buildAncestorsEc(REF, F));
    expectSafe('id lookup', buildRefRidsEc(idLookupPlan('t.some_id').exprs, idLookupPlan('t.some_id').prelude));
    const fields = [{ accessor: 'owner', label: 'Owner', direction: 'out' as const }, { accessor: 'expression', label: 'x', direction: 'in' as const }];
    expectSafe('connections', buildConnectionsEc(REF, fields, F));
    expectSafe('junction', buildJunctionEc(['1', '2'], fields, F));
    expectSafe('inbound', buildInboundEc(REF, F));
  });

  it('object pane, edit fields, property applications, access, layout tree, colours', () => {
    expectSafe('pane', buildObjectPaneEc(REF, ['headerStyle', 'transparency', 'width']));
    expectSafe('edit field property', buildEditFieldPropertyEc(REF, ['CeRisk']));
    expectSafe('edit field types', buildEditFieldTypesEc(REF));
    expectSafe('property applications', buildPropertyApplicationsEc(REF));
    expectSafe('access subjects', buildAccessSubjectsEc(F));
    expectSafe('layout tree', buildLayoutTreeEc(REF));
    expectSafe('colour sets', buildColorSetsEc());
  });

  it('Blueprint reads', () => {
    const ctx = { pageId: '4957', pageRid: '451704949656267090', pageClass: 'Scorecard', tabsetId: 'crev_demo_tabset', target: 'template' as const, hasTemplate: true };
    expectSafe('fetch', buildFetchEc(ctx));
    expectSafe('fetch structure', buildFetchEc(ctx, { projection: 'structure' }));
    expectSafe('flow refs', buildFlowRefListEc('InputSet'));
    expectSafe('flow children', buildFlowRefChildrenEc('crev_qa_inputset'));
    expectSafe('edit page', buildEditPageFetchEc('crev_qa_edit_page'));
    expectSafe('context', buildContextEc('451704949656267090'));
  });

  it('AI context query reads code fields as text and refuses a code filter', () => {
    expectSafe('context query', buildContextQueryEc(REF, 'ActionButton', undefined, ['expression', 'showExpression', 'name']));
    expect(() => buildContextQueryEc(REF, 'ActionButton', undefined, [], 'expression', 'x')).toThrow(/code/i);
  });

  it('studio: CVO data inputs', () => {
    expectSafe('studio children', buildStudioChildrenEc('crev_cvo'));
  });

  it('query service methods (scripts captured from a fake server)', async () => {
    const scripts: string[] = [];
    const svc = new EcQueryService(async code => { scripts.push(code); return { ok: true, log: '' }; }, async rid => `lookup(${rid})`, []);
    const all = Object.values(DISCOVERED).flat();
    await svc.fetchCodeViaEc('1', all).catch(() => {});
    await svc.batchFetchCode(['1', '2'], all).catch(() => {});
    await svc.fetchEditorContext('1', ['showExpression', 'afterExpression']).catch(() => {});
    await svc.fetchSelectedProperties('1', [{ accessor: 'expression', reference: false }, { accessor: 'showExpression', reference: true }, { accessor: 'name', reference: false }]).catch(() => {});
    await svc.fetchObjectPane('1').catch(() => {});
    await svc.batchEnrich(['1', '2']).catch(() => {});
    expect(scripts.length).toBeGreaterThanOrEqual(6);
    scripts.forEach((s, i) => expectSafe(`service script ${i}`, s));
  });
});
