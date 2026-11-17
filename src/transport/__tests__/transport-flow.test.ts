/**
 * Flow projects (their steps, the links between steps), the own values of
 * linked properties per class, visibility rules, logs and schedules.
 */
import { describe, expect, it } from 'vitest';
import { framedText } from '../../lib/ec-parser';
import {
  argumentReferences, assembleBundle, guardBlockEc, classConfigAddress, classInstances, isNeverListed, LOG_DETAIL, operationProperties, parseFlowText, parseObjectText,
  PROPERTY_LINKS_COMMENT, type BundleInput,
} from '../../lib/transport-bundle';
import { assemblePatch, buildProbe, parseProbeAnswer, type ProbeAnswer } from '../../lib/transport-patch';
import { buildTransportScanEc, buildTransportSearchEc, parseTransportScanLog } from '../../lib/transport-read';
import { SCRIPT_LIMITS } from '../../lib/script-kinds';
import { placeGroups, type CollectionItem } from '../transport-collection';
import { scheduleSentence } from '../transport-view';
import { CHOICE_ANY, TransportController } from '../transport-controller';
import { fakeWorker, objectsResult, probeAnswer, propertyGenerate, readOk, row, scanResult, type ProbeTarget, type Sent } from './fakes';

const FLOW_TEXT = [
  '',
  "t.cc_flow.change(id := 'cc_flow', name := 'Flow') //FlowProject",
  "t.cc_flow.configObjects.item(0).change(id := 'cc_src', name := 'Source') //TableSourceConfig",
  "t.cc_flow.configObjects.item(1).change(id := 'cc_dst', name := 'Target') //ExtendedTargetConfig",
  "t.cc_flow.configObjects.item(2).change(id := 'cc_out', name := 'Out') //ExtendedTargetConfig",
  't.cc_flow.transLinks.item(0).change(from := t.cc_src, to := t.cc_dst) //TransLink',
  't.cc_flow.transLinks.item(1).change(from := t.cc_dst, to := t.cc_out) //TransLink',
  '',
].join('\n');

const input = (id: string, className: string, genedit: string, over: Partial<BundleInput> = {}): BundleInput => ({
  rid: String(9007199254741000n + BigInt(id.length * 7 + id.charCodeAt(id.length - 1))), id, className, isNew: false, genedit,
  parentAddress: 't.cc_folder', previousAddress: '', nextAddress: '', ...over,
});
const FLOW = input('cc_flow', 'FlowProject', FLOW_TEXT);
const step = (id: string, cls = 'ExtendedTargetConfig', name = 'Target', over: Partial<BundleInput> = {}) =>
  input(id, cls, `t.${id}.change(id := '${id}', name := '${name}') //${cls}`, { parentAddress: 't.cc_flow', flowStep: true, ...over });

function answer(inputs: BundleInput[], target: ProbeTarget): ProbeAnswer {
  const probe = buildProbe(inputs);
  const r = parseProbeAnswer(probeAnswer(probe, target), probe);
  if (!r.ok) throw new Error(r.error);
  return r.answer;
}

describe('a flow project', () => {
  it('its text: the project\'s values from the first statement, the steps in order, the links as address pairs', () => {
    const f = parseFlowText(FLOW_TEXT)!;
    expect(f.line).toEqual({ address: 't.cc_flow', args: "id := 'cc_flow', name := 'Flow'", className: 'FlowProject' });
    expect(f.steps.map(s => [s.id, s.className])).toEqual([['cc_src', 'TableSourceConfig'], ['cc_dst', 'ExtendedTargetConfig'], ['cc_out', 'ExtendedTargetConfig']]);
    expect(f.links).toEqual([{ from: 't.cc_src', to: 't.cc_dst' }, { from: 't.cc_dst', to: 't.cc_out' }]);
    expect(parseObjectText(FLOW_TEXT)).toEqual(f.line);
    // Another object's text with more statements is not read as one.
    expect(parseFlowText("t.x.change(id := 'x') //Category\nt.x.configObjects.item(0).change(id := 'y') //A")).toBeNull();
  });

  it('a step is added into the project\'s steps with configObject, from its values, and never moved', () => {
    const b = assembleBundle([step('cc_dst', 'ExtendedTargetConfig', 'Target', { isNew: true, previousAddress: 't.cc_src' })]);
    expect(b.parts.find(p => p.step === 'create')!.text).toContain("     t.cc_flow.add(ExtendedTargetConfig, configObject, id := 'cc_dst', name := 'Target')");
    expect(b.parts.some(p => p.step === 'order')).toBe(false);
    // Its Add gives all its values: in a comparison, no Change after it.
    const s = step('cc_dst', 'ExtendedTargetConfig', 'Target', { previousAddress: 't.cc_src' });
    const patch = assemblePatch([s], answer([s], { 't.cc_flow': { cls: 'FlowProject' }, 't.cc_src': { cls: 'TableSourceConfig' } }));
    expect(patch.review[0].outcome).toBe('create');
    expect(patch.parts.some(p => p.step === 'set' || p.step === 'order')).toBe(false);
  });

  it('links: compared as pairs; one only here is added, guarded so it is never added twice; one only on the target stays and is shown', () => {
    const steps = [step('cc_src', 'TableSourceConfig', 'Source'), step('cc_dst'), step('cc_out', 'ExtendedTargetConfig', 'Out')];
    const inputs = [FLOW, ...steps];
    const target: ProbeTarget = {
      't.cc_flow': { cls: 'FlowProject', genedit: FLOW_TEXT, flow: 'cc_src>cc_dst;cc_x>cc_src;', parent: 'cc_folder' },
      't.cc_src': { cls: 'TableSourceConfig', genedit: steps[0].genedit, parent: 'cc_flow' },
      't.cc_dst': { cls: 'ExtendedTargetConfig', genedit: steps[1].genedit, parent: 'cc_flow' },
      't.cc_out': { cls: 'ExtendedTargetConfig', genedit: steps[2].genedit, parent: 'cc_flow' },
      't.cc_folder': { cls: 'Category' },
    };
    const probe = buildProbe(inputs);
    const text = probe.parts[0].text;
    expect(text).toContain('     t.cc_flow.transLinks.forEach(_i: _s := _s + str(_i.from.id.whenMissing("")) + ">" + str(_i.to.id.whenMissing("")) + ";")');
    // Read before any genedit() of the part: after genedit() of a FlowProject its
    // transLinks hold one more link per link without steps (measured).
    expect(text.indexOf('transLinks.forEach')).toBeLessThan(text.indexOf('genedit()'));
    expect(text).toContain('     _r := _r + ("\\nF 9:t.cc_flow" + " " + str(_f1.size()) + ":" + _f1)');
    const patch = assemblePatch(inputs, answer(inputs, target));
    const r = patch.review.find(x => x.address === 't.cc_flow')!;
    expect(r).toMatchObject({ outcome: 'change', flowLinks: { add: ['cc_dst>cc_out'], targetOnly: ['cc_x>cc_src'] } });
    const link = patch.parts.filter(p => p.step === 'link').map(p => p.text).join('\n');
    expect(link).toContain([
      'IF t.cc_flow != MISSING AND t.cc_dst != MISSING AND t.cc_out != MISSING THEN',
      '     _s := ";"',
      '     t.cc_flow.transLinks.forEach(_i: _s := _s + str(_i.from.id.whenMissing("")) + ">" + str(_i.to.id.whenMissing("")) + ";")',
      '     IF _s.indexOf(";cc_dst>cc_out;").whenMissing(-1) < 0 THEN',
      '          t.cc_flow.add(TransLink, transLink, from := t.cc_dst, to := t.cc_out)',
      '     ELSE ""',
      '     ENDIF',
      'ELSE ""',
      'ENDIF',
    ].join('\n'));
    // The pair only on the target is removed first (no data in a link).
    const removal = [
      'IF t.cc_flow != MISSING THEN',
      '     t.cc_flow.transLinks.forEach(_i:',
      '          _k := str(_i.from.id.whenMissing("")) + ">" + str(_i.to.id.whenMissing(""))',
      '          IF _k = "cc_x>cc_src" THEN _i.delete() ELSE "" ENDIF',
      '     )',
      'ELSE ""',
      'ENDIF',
    ].join('\n');
    expect(link).toContain(removal);
    expect(link.indexOf(removal)).toBeLessThan(link.indexOf('add(TransLink'));
    expect(link).not.toContain('from := t.cc_src, to := t.cc_dst');
    expect(link).not.toContain('genedit');
    // The steps are compared as their own objects: the project's values are the same.
    expect(r.values.every(v => v.action === 'same')).toBe(true);
    // The Check compares the project's links text, before the loop that reads texts.
    const check = patch.parts.find(p => p.step === 'check')!.text;
    expect(check).toContain('     IF _s = "cc_src>cc_dst;cc_x>cc_src;" THEN');
    expect(check).toContain('CHANGED links between steps since the comparison t.cc_flow');
    expect(check.indexOf('transLinks.forEach')).toBeLessThan(check.indexOf('genedit()'));
    // The same pairs: the same.
    const same = assemblePatch(inputs, answer(inputs, { ...target, 't.cc_flow': { ...target['t.cc_flow']!, flow: 'cc_dst>cc_out;cc_src>cc_dst;' } }));
    expect(same.review.find(x => x.address === 't.cc_flow')!.outcome).toBe('same');
    expect(same.nothingToDo).toBe(true);
  });

  it('a new project: its steps after it in the Add part, its links in the Link part after them', () => {
    const fresh = { ...FLOW };
    const steps = [step('cc_src', 'TableSourceConfig', 'Source'), step('cc_dst'), step('cc_out', 'ExtendedTargetConfig', 'Out')];
    const inputs = [fresh, ...steps];
    const patch = assemblePatch(inputs, answer(inputs, { 't.cc_folder': { cls: 'Category' } }));
    const add = patch.parts.filter(p => p.step === 'create').map(p => p.text).join('\n');
    expect(add.indexOf('IF t.cc_flow = MISSING')).toBeLessThan(add.indexOf('IF t.cc_src = MISSING'));
    expect(add).toContain("     t.cc_folder.add(FlowProject, id := 'cc_flow', name := 'Flow')");
    const steps2 = patch.parts.map(p => p.step);
    expect(steps2.indexOf('link')).toBeGreaterThan(steps2.lastIndexOf('create'));
    expect(patch.parts.filter(p => p.step === 'link').map(p => p.text).join('\n').match(/add\(TransLink/g)).toHaveLength(2);
  });

  it('steps not in the transport: needed where the target lacks them or has other values', () => {
    const inputs = [FLOW, step('cc_src', 'TableSourceConfig', 'Source')];
    const probe = buildProbe(inputs);
    expect(probe.entries.filter(e => e.kind === 'step').map(e => e.address)).toEqual(['t.cc_dst', 't.cc_out']);
    const target: ProbeTarget = {
      't.cc_flow': { cls: 'FlowProject', genedit: FLOW_TEXT, flow: '' },
      't.cc_src': { cls: 'TableSourceConfig', genedit: inputs[1].genedit, parent: 'cc_flow' },
      't.cc_dst': { cls: 'ExtendedTargetConfig', genedit: "\nt.cc_dst.change(name := 'Target', id := 'cc_dst') //ExtendedTargetConfig\n" },
      't.cc_folder': { cls: 'Category' },
    };
    const patch = assemblePatch(inputs, answer(inputs, target));
    expect(patch.flowSteps).toEqual(['t.cc_out']);
    expect(assembleBundle(inputs).flowSteps).toEqual(['t.cc_dst', 't.cc_out']);
  });
});

describe('logs and schedules', () => {
  it('logs are never listed or transported; a schedule is said once', () => {
    const scan = (id: string, cls: string) => ['O', `${String(7000000000000000000n + BigInt(id.length))} 1 1 ${cls}`, id, id, 'Nov 15, 2026 10:00:00|Nov 1, 2026 09:00:00|', 'a|A', 'p', 'P'];
    const read = parseTransportScanLog(framedText([scan('log1', 'CorpoLog'), scan('warn22', 'CorpoWarningLog'), scan('folder333', 'LogFolder')]), 'transformer', '');
    expect(read.rows.map(r => r.className)).toEqual(['LogFolder']);
    expect(isNeverListed('CorpoLog')).toBe(true);
    expect(isNeverListed('LogFolder')).toBe(false);
    expect(assembleBundle([input('cc_log', 'CorpoLog', "t.cc_log.change(id := 'cc_log') //CorpoLog", { isNew: true })]).leftOut).toMatchObject([{ detail: LOG_DETAIL }]);
    expect(scheduleSentence(1)).toBe('1 schedule is in this transport: it runs on the target as it is set here.');
    expect(scheduleSentence(3)).toBe('3 schedules are in this transport: they run on the target as they are set here.');
  });
});

describe('own values of linked properties per class', () => {
  const PROP_EDIT = "\nk.cc_type.change(id := 'cc_type', name := 'Type') //ListMethodConfig\n";
  const inst = (cls: string, args: string) => {
    const t = `\nk.get('com.corporater.bmp.model.model.enterprise.${cls}.cc_type').change(id := 'com.corporater.bmp.model.model.enterprise.${cls}.cc_type'${args ? `, ${args}` : ''}) //ListMethodConfig\n`;
    return `${t.length}:${t}`;
  };
  const prop = (instances: string): BundleInput => ({
    rid: '9007199254741101', id: 'cc_type', className: 'ListMethodConfig', isNew: false, genedit: PROP_EDIT,
    parentAddress: '', parentIsRoot: true, parentId: 'PROPERTY', previousAddress: '', nextAddress: '',
    generate: propertyGenerate('cc_type', ['CeRisk', 'CeTask']), instances,
  });
  const target = (instances: string): ProbeTarget => ({ 'k.cc_type': { cls: 'ListMethodConfig', genedit: PROP_EDIT, generate: propertyGenerate('cc_type', ['CeRisk', 'CeTask']), parent: 'PROPERTY', instances } });

  it('read from the instances\' texts by class, without the id', () => {
    expect(classInstances(inst('CeTask', "required := true, name := 'Own label'") + inst('CeRisk', ''), 'cc_type')).toEqual([
      { className: 'CeRisk', values: [] },
      { className: 'CeTask', values: [{ name: 'required', value: 'true' }, { name: 'name', value: "'Own label'" }] },
    ]);
  });

  it('values that differ: changed per class after the links, counted to change; the Check looks at them', () => {
    const here = prop(inst('CeTask', "required := true, name := 'Own label'") + inst('CeRisk', ''));
    const there = inst('CeTask', 'required := false') + inst('CeRisk', '');
    const patch = assemblePatch([here], answer([here], target(there)));
    expect(patch.review[0]).toMatchObject({ outcome: 'change', own: [{ className: 'CeTask' }] });
    expect(patch.review[0].own![0].values.map(v => [v.name, v.action])).toEqual([['required', 'change'], ['name', 'set']]);
    const own = patch.parts.find(p => p.step === 'own')!;
    expect(own.text).toContain([
      '_lc := c.get(CeTask.name)',
      'IF _lc != MISSING AND k.cc_type != MISSING THEN',
      '     _lx := str(_lc.id) + "." + str(k.cc_type.id)',
      '     _li := k.get(_lx)',
      '     IF _li != MISSING THEN',
      "          k.get(_lx).change(required := true, name := 'Own label')",
      '     ELSE ""',
      '     ENDIF',
      'ELSE ""',
      'ENDIF',
    ].join('\n'));
    expect(own.text).not.toContain('CeRisk');
    const check = patch.parts.find(p => p.step === 'check')!.text;
    expect(check).toContain('     k.cc_type.rref(linkedTo).forEach(_i:');
    expect(check).toContain(`     IF _v.size() = ${there.length} AND _lk.size() = 2 THEN`);
    expect(check).toContain('CHANGED own values per class since the comparison k.cc_type');
  });

  it('values only on the target stay unless removed; the same values: the same', () => {
    const here = prop(inst('CeTask', '') + inst('CeRisk', ''));
    const kept = assemblePatch([here], answer([here], target(inst('CeTask', 'required := true') + inst('CeRisk', ''))), { clearExtra: false });
    expect(kept.review[0].outcome).toBe('same');
    expect(kept.parts.some(p => p.step === 'own')).toBe(false);
    const cleared = assemblePatch([here], answer([here], target(inst('CeTask', 'required := true') + inst('CeRisk', ''))), { clearExtra: true });
    expect(cleared.parts.find(p => p.step === 'own')!.text).toContain('          k.get(_lx).clear(required)');
  });

  it('a new property: its own values follow in their own step; scripts without comparison change them too', () => {
    const fresh = { ...prop(inst('CeTask', 'required := true')), isNew: true };
    const patch = assemblePatch([fresh], answer([fresh], {}));
    expect(patch.parts.find(p => p.step === 'own')!.text).toContain('k.get(_lx).change(required := true)');
    const b = assembleBundle([fresh]);
    expect(b.parts.find(p => p.step === 'own')!.text).toContain('k.get(_lx).change(required := true)');
    expect(b.parts.find(p => p.step === 'set')!.text).toContain(PROPERTY_LINKS_COMMENT);
  });
});

describe('visibility rules', () => {
  const RULE = input('cc_rule', 'ConditionRule', "t.cc_rule.change(id := 'cc_rule', name := 'Rule', operations := list('H#security_objectives', 'D#cc_type')) //ConditionRule", {
    parentAddress: '', parentIsRoot: true, parentId: 'com.corporater.bmp.model.model.enterprise.CeTask', isNew: true,
  });

  it('the area\'s scan lists only rules, with the day and the search', () => {
    const scan = buildTransportScanEc('classConfig', '2026-11-15');
    expect(scan).toContain('_g := root.classConfig');
    expect(scan).toContain('_g.descendants().filter(className = "ConditionRule").filter(lastModifiedDate > date("2026-11-15")).first(2001).forEach(_i:');
    expect(scan.length).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
    expect(buildTransportSearchEc('classConfig', 'abc')).toContain('.filter(className = "ConditionRule").filter(id = _q OR name = _q)');
    expect(buildTransportScanEc('portal', '2026-11-15')).not.toContain('ConditionRule');
    // Instances of linked properties and system properties are never rows.
    expect(isNeverListed('ListMethodConfig', 'cc_type')).toBe(true);
    expect(isNeverListed('SystemMethodConfig')).toBe(true);
    expect(isNeverListed('ListMethodConfig')).toBe(false);
  });

  it('added under its class from its values, never moved; its operations use properties', () => {
    expect(classConfigAddress('com.corporater.bmp.model.model.enterprise.CeTask')).toBe('c.get(CeTask.name)');
    const b = assembleBundle([RULE]);
    expect(b.parts.find(p => p.step === 'create')!.text).toContain("     c.get(CeTask.name).add(ConditionRule, id := 'cc_rule', name := 'Rule', operations := list('H#security_objectives', 'D#cc_type'))");
    expect(b.parts.some(p => p.step === 'order')).toBe(false);
    expect(operationProperties("operations := list('H#security_objectives', 'D#cc_type'), name := 'x'")).toEqual(['k.security_objectives', 'k.cc_type']);
    expect(argumentReferences("operations := list('H#security_objectives')")).toEqual(['k.security_objectives']);
    expect(b.warnings.filter(w => w.kind === 'outside-reference').map(w => w.address)).toEqual(['k.cc_type', 'k.security_objectives']);
  });

  it('its place group: Class <Class>', () => {
    const r = row({ id: 'cc_rule', className: 'ConditionRule', parentRid: '5', parentId: 'com.corporater.bmp.model.model.enterprise.CeTask', parentName: 'Task' });
    const item: CollectionItem = { rid: r.rid, row: r, area: 'classConfig', trail: [], readAt: '' };
    expect(placeGroups([item])[0].path).toEqual(['Visibility rules', 'Class CeTask']);
  });
});

describe('the window', () => {
  it('steps of a flow project not in the transport are needed and can be added; a schedule is counted', async () => {
    const flow = row({ id: 'cc_flow', className: 'FlowProject' });
    const sched = row({ id: 'cc_sched', className: 'TransformerSchedule', parentRid: flow.rid });
    const w = fakeWorker((m: Sent) => (m.type === 'TRANSPORT_READ_OBJECTS'
      ? objectsResult(m, (m.rids as string[]).map(rid => (rid === flow.rid
        ? readOk(rid, 'cc_flow', { className: 'FlowProject', genedit: FLOW_TEXT, generate: undefined })
        : readOk(rid, 'cc_sched', { className: 'TransformerSchedule', parentAddress: 't.cc_flow', generate: undefined }))))
      : scanResult(m, { rows: m.root === 'portal' ? [flow, sched] : [] })));
    const ctl = new TransportController(w.deps, { since: '2026-11-08' });
    await ctl.scan();
    ctl.setGroupTicked('portal', true);
    ctl.setChoice(CHOICE_ANY);
    await ctl.buildBundle();
    expect([...ctl.neededSteps().values()]).toEqual(['t.cc_src', 't.cc_dst', 't.cc_out']);
    expect(ctl.referencedAddresses('steps')).toEqual(['t.cc_src', 't.cc_dst', 't.cc_out']);
    expect(ctl.schedules()).toBe(1);
  });
});

describe('round 11 defects', () => {
  it('links that read as warnings or without a step are unknown: nothing is added, the row says so', () => {
    const steps = [step('cc_src', 'TableSourceConfig', 'Source'), step('cc_dst'), step('cc_out', 'ExtendedTargetConfig', 'Out')];
    const inputs = [FLOW, ...steps];
    const base: ProbeTarget = {
      't.cc_src': { cls: 'TableSourceConfig', genedit: steps[0].genedit, parent: 'cc_flow' },
      't.cc_dst': { cls: 'ExtendedTargetConfig', genedit: steps[1].genedit, parent: 'cc_flow' },
      't.cc_out': { cls: 'ExtendedTargetConfig', genedit: steps[2].genedit, parent: 'cc_flow' },
      't.cc_folder': { cls: 'Category' },
    };
    for (const flow of ['cc_src>cc_dst;Missing value for .from at line 232, column 61>Missing value for .to at line 232, column 85;', 'cc_src>cc_dst;>;']) {
      const patch = assemblePatch(inputs, answer(inputs, { ...base, 't.cc_flow': { cls: 'FlowProject', genedit: FLOW_TEXT, flow, parent: 'cc_folder' } }));
      const r = patch.review.find(x => x.address === 't.cc_flow')!;
      expect(r.flowLinks).toEqual({ add: [], targetOnly: [], unknown: true });
      expect(patch.text).not.toContain('add(TransLink');
    }
  });

  it('an object of the transport is never only on the target, whatever the source IDs say (step d added after the scan)', () => {
    const folder = input('cc_flows', 'Category', "t.cc_flows.change(id := 'cc_flows') //Category", { parentAddress: '' , parentIsRoot: true, parentId: 'TRANSFORMER' });
    const d = step('cc_d', 'ExtendedTargetConfig', 'D');
    const target: ProbeTarget = { 't.cc_flows': { cls: 'Category', genedit: folder.genedit, parent: 'TRANSFORMER' }, 't.cc_d': { cls: 'ExtendedTargetConfig', genedit: d.genedit, parent: 'cc_flow' }, 't.cc_flow': { cls: 'FlowProject' } };
    const listing = [{ id: 'cc_flow', parent: 'cc_flows', cls: 'FlowProject' }, { id: 'cc_d', parent: 'cc_flow', cls: 'ExtendedTargetConfig' }];
    const listed = (inputs: BundleInput[]) => {
      const probe = buildProbe(inputs, { listing: { start: 't.cc_flows' } });
      const r = parseProbeAnswer(probeAnswer(probe, target, { listing }), probe);
      if (!r.ok) throw new Error(r.error);
      return r.answer;
    };
    // The IDs of the old scan, without cc_d: without cc_d in the transport it is only on the target.
    const old = ['cc_flows', 'cc_flow'];
    expect(assemblePatch([folder], listed([folder]), { sourceIds: old }).targetOnly.map(o => o.id)).toEqual(['cc_d']);
    // With cc_d in the transport, never.
    const patch = assemblePatch([folder, d], listed([folder, d]), { sourceIds: old, deleteExtra: true });
    expect(patch.targetOnly).toEqual([]);
    expect(patch.deletes).toEqual([]);
  });
});

describe('round 12', () => {
  it('a call in code names no object: t.get(…), u.delete() on a variable', () => {
    expect(argumentReferences("expression := '_x := t.get(\"a\")\nk.get(_id)\nu.delete()\nu.membership\nt.real.name'")).toEqual(['t.a', 't.real', 'u.membership']);
  });
});

describe('round 14', () => {
  const PROP_EDIT = "\nk.cc_type.change(id := 'cc_type', name := 'Type') //ListMethodConfig\n";
  const prop: BundleInput = {
    rid: '9007199254741101', id: 'cc_type', className: 'ListMethodConfig', isNew: false, genedit: PROP_EDIT,
    parentAddress: '', parentIsRoot: true, parentId: 'PROPERTY', previousAddress: '', nextAddress: '', generate: propertyGenerate('cc_type', ['CeTask']), instances: '',
  };
  const target: ProbeTarget = { 'k.cc_type': { cls: 'ListMethodConfig', genedit: PROP_EDIT, generate: propertyGenerate('cc_type', ['CeIssue', 'CeTask']), instances: '', parent: 'PROPERTY' } };

  it('a class link only on the target: shown and kept without the delete switch; removed after the deletes with it', () => {
    const off = assemblePatch([prop], answer([prop], target), { clearExtra: false });
    expect(off.review[0]).toMatchObject({ outcome: 'same', links: { add: [], targetOnly: ['CeIssue'] } });
    expect(off.review[0].links).not.toHaveProperty('remove');
    expect(off.unlinks).toEqual([]);
    expect(off.linksOnlyOnTarget).toBe(1);
    expect(off.text).not.toContain('.delete()');
    const on = assemblePatch([prop], answer([prop], target), { clearExtra: false, deleteExtra: true });
    expect(on.review[0]).toMatchObject({ outcome: 'change', links: { remove: ['CeIssue'] } });
    expect(on.unlinks).toEqual([{ address: 'k.cc_type', className: 'CeIssue' }]);
    expect(on.parts.map(p => p.step)).toEqual(['check', 'delete', 'report']);
    expect(on.parts[1].text).toContain('     IF _li != MISSING AND _li.linkedTo != MISSING AND str(_li.linkedTo.id) = str(k.cc_type.id) THEN');
  });

  it('links between steps the target has that cannot be read are never removed', () => {
    const steps = [step('cc_src', 'TableSourceConfig', 'Source'), step('cc_dst'), step('cc_out', 'ExtendedTargetConfig', 'Out')];
    const inputs = [FLOW, ...steps];
    const t: ProbeTarget = {
      't.cc_flow': { cls: 'FlowProject', genedit: FLOW_TEXT, flow: 'cc_src>cc_dst;>;', parent: 'cc_folder' },
      't.cc_src': { cls: 'TableSourceConfig', genedit: steps[0].genedit, parent: 'cc_flow' },
      't.cc_dst': { cls: 'ExtendedTargetConfig', genedit: steps[1].genedit, parent: 'cc_flow' },
      't.cc_out': { cls: 'ExtendedTargetConfig', genedit: steps[2].genedit, parent: 'cc_flow' },
      't.cc_folder': { cls: 'Category' },
    };
    const patch = assemblePatch(inputs, answer(inputs, t));
    expect(patch.text).not.toContain('_i.delete()');
  });

  it('guards: one loop per class and ID space from three objects on; fewer stay single lines', () => {
    const two = guardBlockEc([{ address: 't.a', className: 'X' }, { address: 't.b', className: 'X' }]);
    expect(two).toHaveLength(4);
    const three = guardBlockEc([{ address: 't.a', className: 'X' }, { address: 't.b', className: 'X' }, { address: 't.c', className: 'X' }, { address: 't.get("d e")', className: 'Y' }]);
    expect(three).toEqual([
      '_w := ""',
      `IF t.get("d e") != MISSING AND t.get("d e").className != 'Y' THEN _w := _w + ' t.get("d e") (' + str(t.get("d e").className) + ')' ELSE "" ENDIF`,
      'list("a", "b", "c").forEach(_x:',
      '     _o := t.get(_x)',
      `     IF _o != MISSING AND _o.className != 'X' THEN _w := _w + " " + "t." + _x + " (" + str(_o.className) + ")" ELSE "" ENDIF`,
      ')',
      `IF _w.size() > 0 THEN error('Other classes than expected:' + _w + '. Nothing in this part was applied.') ELSE "" ENDIF`,
    ]);
  });
});
