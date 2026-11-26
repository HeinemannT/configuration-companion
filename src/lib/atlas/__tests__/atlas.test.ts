/**
 * Atlas: what the scripts' answers become (the properties, what they hold,
 * one object), the neighbours of a type, and the Extended Code of a route.
 */
import { describe, expect, it } from 'vitest';
import {
  ATLAS_FIELD as F, ATLAS_ROW as R, assembleAtlasModel, buildAtlasHeldEc, buildAtlasObjectEc, buildAtlasPropertiesEc,
  buildAtlasRouteRowsEc, heldRequests, parseAtlasHeld, parseAtlasHeldCounts, parseAtlasObject, parseAtlasProperties, parseAtlasRouteRows,
} from '../atlas-ec';
import { edgesBetween, fillText, findRoutes, findTypes, gridOrder, plainClassName, routeEc, routeLabel, typeName } from '../model';
import { addUsage, groupHits, noUsage, propsRead, readUsage, usageCounts } from '../usage';
import { SCRIPT_LIMITS } from '../../script-kinds';

const link = (fqn: string, className: string, label: string) => `${fqn}\u0003${className}\u0003${label}\u0004`;
const RISK = 'com.corporater.bmp.model.model.enterprise.CeRiskAssessment';
const CONTROL = 'com.corporater.bmp.model.model.enterprise.CeControlMeasure';

const PROPERTIES_LOG = [
  ['controls', 'Controls', 'HistoricalReferenceMethodConfig', 'true', '[]', '', link(RISK, 'Enterprise risk assessment', 'Controls')],
  ['accountable_owner', 'Accountable owner', 'ReferenceMethodConfig', 'false', '[User]', '', link(RISK, 'Enterprise risk assessment', 'Accountable owner') + link(CONTROL, 'Enterprise control measure', 'Owner')],
  ['risks_of_control', 'Risks', 'ReverseReferenceMethodConfig', '', '[CeRiskAssessment]', 'controls', link(CONTROL, 'Enterprise control measure', 'Risks')],
  ['unused_ref', 'Unused', 'ReferenceMethodConfig', 'false', '[]', '', link(RISK, 'Enterprise risk assessment', 'Unused')],
  ['not linked', 'Bad id', 'ReferenceMethodConfig', 'false', '[]', '', ''],
].map(r => r.join(F)).join(R) + R + '\n\nDuration : 73ms';

const model = () => {
  const properties = parseAtlasProperties(PROPERTIES_LOG);
  return assembleAtlasModel(properties, { CeRiskAssessment: { controls: ['CeControlMeasure'], accountable_owner: ['User'] }, CeControlMeasure: { accountable_owner: ['User', 'Group'] } });
};

describe('Atlas properties', () => {
  it('reads each reference with the classes it is linked to, and skips a row without a usable ID', () => {
    const p = parseAtlasProperties(PROPERTIES_LOG);
    expect(p.map(x => x.id)).toEqual(['controls', 'accountable_owner', 'risks_of_control', 'unused_ref']);
    expect(p[0]).toMatchObject({ multi: true, reverse: false, types: [], links: [{ cls: 'CeRiskAssessment', className: 'Enterprise risk assessment', label: 'Controls' }] });
    expect(p[1].types).toEqual(['User']);
    expect(p[1].links.map(l => l.cls)).toEqual(['CeRiskAssessment', 'CeControlMeasure']);
    expect(p[2]).toMatchObject({ reverse: true, forward: 'controls' });
  });

  it('asks per class for what its references hold, never for a reverse reference', () => {
    expect(heldRequests(parseAtlasProperties(PROPERTIES_LOG))).toEqual([
      { cls: 'CeControlMeasure', props: ['accountable_owner'] },
      { cls: 'CeRiskAssessment', props: ['accountable_owner', 'controls', 'unused_ref'] },
    ]);
  });

  it('splits the reads of one class so that no script passes the limit of a varying script', () => {
    const props = Array.from({ length: 30 }, (_, i) => `a_rather_long_property_id_${i}`);
    const scripts = buildAtlasHeldEc('CeRiskAssessment', props);
    expect(scripts.length).toBeGreaterThan(1);
    for (const s of scripts) { expect(s.length).toBeLessThanOrEqual(SCRIPT_LIMITS.varying); expect(s).toContain('SELECT CeRiskAssessment'); }
    expect(props.every(p => scripts.some(s => s.includes(`_x.${p}.whenMissing`)))).toBe(true);
    expect(() => buildAtlasHeldEc('Ce Risk; delete', ['a'])).toThrow();
    expect(buildAtlasHeldEc('CeRiskAssessment', ['bad id', 'x.y'])).toEqual([]);
  });

  it('reads what the references were seen to hold', () => {
    expect(parseAtlasHeld(`controls${F}CeControlMeasure${R}owner${F}User,Group${R}none${F}${R}\nDuration : 9ms`)).toEqual({ controls: ['CeControlMeasure'], owner: ['User', 'Group'], none: [] });
  });

  it('the properties script is one fixed text', () => {
    expect(buildAtlasPropertiesEc()).toBe(buildAtlasPropertiesEc());
    expect(buildAtlasPropertiesEc()).toContain('ReverseReferenceMethodConfig');
  });
});

describe('Atlas model', () => {
  it('joins the named and the observed targets; a reference nothing uses has none', () => {
    const m = model();
    expect(m.types.CeRiskAssessment.name).toBe('Enterprise risk assessment');
    const edge = (from: string, prop: string) => m.edges.find(e => e.from === from && e.prop === prop)!;
    expect(edge('CeRiskAssessment', 'controls')).toMatchObject({ to: ['CeControlMeasure'], multi: true, declared: false });
    expect(edge('CeRiskAssessment', 'accountable_owner')).toMatchObject({ to: ['User'], declared: true });
    expect(edge('CeControlMeasure', 'accountable_owner')).toMatchObject({ to: ['Group', 'User'], declared: false, label: 'Owner' });
    expect(edge('CeRiskAssessment', 'unused_ref').to).toEqual([]);
    expect(m.reverses).toEqual([{ on: 'CeControlMeasure', prop: 'risks_of_control', label: 'Risks', forward: 'controls' }]);
  });

  it('names a class BMP gives no name, and finds types by word', () => {
    const m = model();
    expect(typeName(m, 'ListPropertySetItem')).toBe('List property set item');
    expect(plainClassName('BPMNProcess')).toBe('BPMN process');
    expect(findTypes(m, 'risk').map(t => t.cls)).toEqual(['CeRiskAssessment']);
    expect(findTypes(m, 'enterprise control').map(t => t.cls)).toEqual(['CeControlMeasure']);
    expect(findTypes(m, 'user')[0].cls).toBe('User');
    expect(findTypes(m, 'zzz')).toEqual([]);
  });
});

describe('Atlas route', () => {
  it('one step is the plain read', () => {
    expect(routeEc([])).toBe('this.object');
    expect(routeEc([{ dir: 'out', prop: 'controls' }])).toBe('this.object.controls');
    expect(routeEc([{ dir: 'out', prop: 'controls' }], 'this')).toBe('this.controls');
    expect(routeEc([{ dir: 'in', prop: 'controls' }])).toBe('this.object.rref(controls)');
    expect(routeEc([{ dir: 'in', prop: 'controls', alias: 'risks_of_control' }])).toBe('this.object.risks_of_control');
  });

  it('a longer route collects per object', () => {
    expect(routeEc([{ dir: 'out', prop: 'controls' }, { dir: 'in', prop: 'subject' }, { dir: 'out', prop: 'owner' }], 'this')).toBe([
      '_s1 := LIST().merge(this.controls.whenMissing(LIST()))',
      '_s2 := LIST()',
      '_s1.forEach(_x: _s2 := _s2.union(LIST().merge(_x.rref(subject))))',
      '_s3 := LIST()',
      '_s2.forEach(_x: _s3 := _s3.union(LIST().merge(_x.owner.whenMissing(LIST()))))',
      '_s3',
    ].join('\n'));
  });

  it('refuses a step that is not a property ID', () => {
    expect(() => routeEc([{ dir: 'out', prop: 'a.delete()' }])).toThrow();
  });

});

describe('Atlas object', () => {
  it('reads the object\'s own RID, ID, name and class; the RID stays text', () => {
    expect(parseAtlasObject(['8265908289559776224', '101', 'ERP service interruption', 'CeRiskAssessment'].join(F) + R + '\n\nDuration : 3ms'))
      .toEqual({ rid: '8265908289559776224', id: '101', name: 'ERP service interruption', cls: 'CeRiskAssessment' });
    expect(parseAtlasObject('Error')).toBeNull();
    expect(buildAtlasObjectEc()).toBe(buildAtlasObjectEc());
    expect(buildAtlasObjectEc()).toContain('_s := this.object');
  });
});

describe('Atlas counts', () => {
  it('reads how many objects a class has, how many were looked at and how many fill each reference', () => {
    const log = `#${F}412${F}200${R}controls${F}CeControlMeasure${F}184${R}owner${F}${F}NA${R}\nDuration : 9ms`;
    expect(parseAtlasHeldCounts(log)).toEqual({ count: 412, seen: 200, filled: { controls: 184, owner: 0 } });
    expect(parseAtlasHeld(log)).toEqual({ controls: ['CeControlMeasure'], owner: [] });
    const script = buildAtlasHeldEc('CeRiskAssessment', ['controls'])[0];
    expect(script).toContain('_q.size()');
    expect(script).toContain('.sum()');
  });

  it('puts the counts on the types and the references, and words them', () => {
    const properties = parseAtlasProperties(PROPERTIES_LOG);
    const m = assembleAtlasModel(properties, { CeRiskAssessment: { controls: ['CeControlMeasure'] } }, [], { CeRiskAssessment: { count: 412, seen: 200, filled: { controls: 184, unused_ref: 0 } } });
    expect(m.types.CeRiskAssessment).toMatchObject({ count: 412, seen: 200 });
    const controls = m.edges.find(e => e.prop === 'controls')!;
    expect(controls.filled).toBe(184);
    expect(fillText(m, controls)).toBe('184 of the first 200');
    expect(fillText({ ...m, types: { ...m.types, CeRiskAssessment: { cls: 'CeRiskAssessment', name: 'x', count: 19, seen: 19 } } }, { ...controls, filled: 12 })).toBe('12 of 19');
    expect(fillText(m, m.edges.find(e => e.from === 'CeControlMeasure')!)).toBe('');
    expect(edgesBetween(m, 'CeRiskAssessment', 'CeControlMeasure').map(e => e.prop)).toEqual(['controls']);
    expect(gridOrder(m)[0]).toBe('CeRiskAssessment');
  });
});

describe('Atlas routes between two types', () => {
  // Risk → Control (controls, 12 of 20) → User (performer 10 of 10; reviewer 0 of 10); Risk → User direct (owner 5 of 20; deputy 20 of 20);
  // Activity → Risk (subject), Activity → User (assignee, 4 of 8).
  const edge = (from: string, prop: string, to: string, filled?: number) => ({ from, prop, label: prop, multi: true, to: [to], declared: false, ...(filled != null ? { filled } : {}) });
  const m = {
    types: {
      Risk: { cls: 'Risk', name: 'Risk', count: 20, seen: 20 }, Control: { cls: 'Control', name: 'Control', count: 10, seen: 10 },
      Activity: { cls: 'Activity', name: 'Activity', count: 8, seen: 8 }, User: { cls: 'User', name: 'User' },
    },
    edges: [edge('Risk', 'controls', 'Control', 12), edge('Control', 'performer', 'User', 10), edge('Control', 'reviewer', 'User', 0), edge('Risk', 'owner', 'User', 5),
      edge('Risk', 'deputy', 'User', 20), edge('Activity', 'subject', 'Risk', 8), edge('Activity', 'assignee', 'User', 4)],
    reverses: [], sample: 200, unread: [],
  };

  it('finds every way in one or two steps, along and against references', () => {
    expect(findRoutes(m, 'Risk', 'User').map(routeLabel)).toEqual(['deputy', 'owner', 'controls › performer', 'rref(subject) › assignee', 'controls › reviewer']);
    expect(findRoutes(m, 'User', 'Risk').map(routeLabel)).toContain('rref(performer) › rref(controls)');
    expect(findRoutes(m, 'Risk', 'Risk')).toEqual([]);
    expect(findRoutes({ ...m, edges: [...m.edges, edge('Risk', 'related', 'Risk', 2)] }, 'Risk', 'Risk').map(routeLabel)).toEqual(['related', 'rref(related)']);
    expect(findRoutes({ types: {}, edges: [], reverses: [], sample: 200, unread: [] }, 'Risk', 'User')).toEqual([]);
    expect(findRoutes(m, 'Control', 'Activity').map(r => r.classes)).toEqual([['Control', 'Risk', 'Activity'], ['Control', 'User', 'Activity'], ['Control', 'User', 'Activity']]);
  });

  it('ranks the shortest first, then by how much the data fills them, and a way that gives nothing last', () => {
    const routes = findRoutes(m, 'Risk', 'User');
    expect(routes.map(r => [r.steps.length, r.fill, r.empty])).toEqual([[1, 1, false], [1, 0.25, false], [2, 0.6, false], [2, 0.2, false], [2, 0, true]]);
  });

  it('breaks a tie in the data by how often this server\'s code uses the way', () => {
    const tie = { ...m, edges: m.edges.map(e => (e.prop === 'owner' ? { ...e, filled: 20 } : e)) };
    expect(findRoutes(tie, 'Risk', 'User').slice(0, 2).map(routeLabel)).toEqual(['deputy', 'owner']);
    const used = findRoutes(tie, 'Risk', 'User', { owner: 9, deputy: 1 });
    expect(used.slice(0, 2).map(routeLabel)).toEqual(['owner', 'deputy']);
    expect(used[0].used).toBe(9);
    // A two-step way is as used as its least used step.
    expect(findRoutes(m, 'Risk', 'User', { controls: 66, performer: 3 }).find(r => routeLabel(r) === 'controls › performer')!.used).toBe(3);
  });

  it('a way through a type that was never counted has no known fill and comes after the counted ones', () => {
    const open = { ...m, edges: [...m.edges, edge('Risk', 'vendor', 'User')] };
    const routes = findRoutes(open, 'Risk', 'User').filter(r => r.steps.length === 1);
    expect(routes.map(routeLabel)).toEqual(['deputy', 'owner', 'vendor']);
    expect(routes[2].fill).toBeNull();
  });
});

describe('Atlas route rows', () => {
  it('reads one row per way through the steps with nested lists, never one text grown row by row', () => {
    const ec = buildAtlasRouteRowsEc('CeRiskAssessment', [{ dir: 'out', prop: 'controls' }, { dir: 'in', prop: 'subject' }]);
    expect(ec).toContain('LIST().merge(LIST().merge(SELECT CeRiskAssessment).first(100))');
    expect(ec).toContain('_x1.controls.whenMissing(LIST())');
    expect(ec).toContain('_x2.rref(subject)');
    expect(ec.match(/\.join\(""\)/g)).toHaveLength(3);
    expect(ec).not.toMatch(/:= _\w+ \+/);
    expect(ec.length).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
    expect(buildAtlasRouteRowsEc(null, [{ dir: 'in', prop: 'controls', alias: 'risks_of_control' }])).toContain('_a := LIST().merge(this.object)');
    expect(() => buildAtlasRouteRowsEc('Ce Risk', [{ dir: 'out', prop: 'a' }])).toThrow();
    expect(() => buildAtlasRouteRowsEc('CeRisk', [{ dir: 'out', prop: 'a.delete()' }])).toThrow();
    expect(() => buildAtlasRouteRowsEc('CeRisk', [])).toThrow();
  });

  it('parses the rows; RIDs stay text', () => {
    const row = (...o: string[][]) => o.map(x => x.join(F)).join(F) + F + R;
    const log = row(['8265908289559776224', '101', 'ERP service interruption', 'CeRiskAssessment'], ['5389231803581962914', '103', 'ERP recovery validation', 'CeControlMeasure'])
      + row(['x', '', '', ''], ['1', '', '', '']) + '\n\nDuration : 5ms';
    expect(parseAtlasRouteRows(log, 2)).toEqual([[
      { rid: '8265908289559776224', id: '101', name: 'ERP service interruption', cls: 'CeRiskAssessment' },
      { rid: '5389231803581962914', id: '103', name: 'ERP recovery validation', cls: 'CeControlMeasure' },
    ]]);
    expect(parseAtlasRouteRows(log, 3)).toEqual([]);
    // A reference may hold several types: only the rows of the route's types are its rows.
    expect(parseAtlasRouteRows(log, 2, ['CeRiskAssessment', 'CeControlMeasure'])).toHaveLength(1);
    expect(parseAtlasRouteRows(log, 2, ['CeRiskAssessment', 'CeAsset'])).toEqual([]);
  });
});

describe('Atlas usage', () => {
  const wanted = new Set(['controls', 'owner']);
  const object = (rid: string, type: string, code: Record<string, string>) => ({ env: 'e', rid, type, name: `n${rid}`, businessId: `b${rid}`, where: 'Risks › Oversight', stamp: '', len: 0, code, refs: [] });

  it('finds a property read with a dot or through rref, each once per text, and not a longer ID', () => {
    expect(propsRead('this.object.controls.filter(a) + x.rref( owner ) + y.controls', wanted)).toEqual(['controls', 'owner']);
    expect(propsRead('this.controls_old + ownerName + "controls"', wanted)).toEqual([]);
  });

  it('collects the hits per property and groups them by the type that holds the code', () => {
    const byProp: Record<string, ReturnType<typeof groupHits>[number]['hits']> = {};
    addUsage(byProp, [object('1', 'ExtendedTable', { expression: 't.controls', filter: 'x.owner' }), object('2', 'BarChart', { expression: 'a.controls' }), object('3', 'ExtendedTable', { expression: 'b.controls' })], wanted);
    expect(byProp.controls.map(h => h.rid)).toEqual(['1', '2', '3']);
    expect(byProp.owner[0]).toMatchObject({ rid: '1', codeProp: 'filter', where: 'Risks › Oversight' });
    expect(groupHits(byProp.controls).map(g => [g.type, g.hits.length])).toEqual([['ExtendedTable', 2], ['BarChart', 1]]);
  });

  it('reads the copy when there is one, and says why not when there is none', async () => {
    const scan = async (_env: string, each: (b: ReturnType<typeof object>[]) => void) => { each([object('1', 'ExtendedTable', { expression: 't.controls' })]); };
    const ready = await readUsage({ scan } as never, { environment: 'e', state: 'ready', syncedAt: 5, builtAt: 1 } as never, ['controls']);
    expect(ready).toMatchObject({ state: 'ready', objects: 1, at: 5 });
    expect(usageCounts(ready)).toEqual({ controls: 1 });
    expect(await readUsage({ scan } as never, { environment: 'e', state: 'none' } as never, ['controls'])).toMatchObject({ state: 'none', canMake: true });
    expect(noUsage({ state: 'building', progress: { phase: 'reading', read: 3, toRead: 9 } })).toMatchObject({ canMake: false, making: { read: 3, toRead: 9 } });
    expect(noUsage({ state: 'unavailable' }).canMake).toBe(false);
    expect(noUsage(null).canMake).toBe(false);
    expect(usageCounts(null)).toEqual({});
  });
});

describe('Atlas names and property settings', () => {
  it('shows an enterprise class as CE, keeps the full name for the card, and leaves other types alone', async () => {
    const { fullTypeName } = await import('../model');
    const m = model();
    expect(typeName(m, 'CeRiskAssessment')).toBe('CE Risk Assessment');
    expect(fullTypeName(m, 'CeRiskAssessment')).toBe('Enterprise risk assessment');
    expect(typeName({ ...m, types: { Organisation: { cls: 'Organisation', name: 'Enterprise unit' } } }, 'Organisation')).toBe('Enterprise unit');
    expect(typeName(m, 'User')).toBe('User');
    expect(findTypes(m, 'ce risk').map(t => t.cls)).toEqual(['CeRiskAssessment']);
  });

  it('reads whether a reference is historical and advanced', () => {
    const row = (cls: string, advanced: string) => ['p_' + advanced, 'P', cls, 'true', '[]', '', link(RISK, 'Enterprise risk assessment', 'P'), advanced].join(F);
    const m = assembleAtlasModel(parseAtlasProperties([row('HistoricalReferenceMethodConfig', 'true'), row('ReferenceMethodConfig', 'false')].join(R) + R), {});
    expect(m.edges.map(e => [e.prop, e.historical ?? false, e.advanced ?? false])).toEqual([['p_false', false, false], ['p_true', true, true]]);
    expect(buildAtlasPropertiesEc()).toContain('_x.advanced');
  });
});
