/**
 * The Add of an object is made from its parent, class and genedit
 * arguments, with or without children: no creation read for it. Only a
 * property definition gets its `generate(true)` text read, for the classes
 * it is linked to: its Add carries one link line per class, and a
 * comparison links a class the target does not link it to, never one it
 * links already, and never unlinks.
 */
import { describe, expect, it, vi } from 'vitest';
import { framedText } from '../../lib/ec-parser';
import { classifyScript } from '../../lib/script-kinds';
import {
  assembleBundle, isPropertyDefinition, linkedClasses, NO_PARENT_DETAIL, PROPERTY_LINKS_COMMENT, SYSTEM_OBJECT_DETAIL, type BundleInput,
} from '../../lib/transport-bundle';
import { assemblePatch, buildProbe, linkedCopyDetail, parseProbeAnswer, propertyDefinitionRids, PROBE_MARKER, PROBE_VERSION, type ProbeAnswer } from '../../lib/transport-patch';
import { buildTransportCreationEc, parseTransportCreationLog, readTransportCreation } from '../../lib/transport-read';
import type { EcResult } from '../../lib/bmp-client';
import { CHOICE_ANY, CHOICE_PASTE, TransportController } from '../transport-controller';
import { creationResult, fakeWorker, objectsResult, probeAnswer, propertyGenerate, readOk, row, scanResult, type ProbeTarget, type Sent } from './fakes';

const RID = '9007199254740993';
const PROP_EDIT = "\nk.cc_type.change(id := 'cc_type', name := 'Type', category := 'General') //ListMethodConfig\n";

/** A property definition at `k.cc_type`, linked here to `links` (no
 *  generate text read when undefined). */
const prop = (links: string[] | undefined, over: Partial<BundleInput> = {}): BundleInput => ({
  rid: '9007199254741101', id: 'cc_type', className: 'ListMethodConfig', isNew: false, genedit: PROP_EDIT,
  parentAddress: '', parentIsRoot: true, parentId: 'PROPERTY', previousAddress: '', nextAddress: '',
  ...(links ? { generate: propertyGenerate('cc_type', links) } : {}), ...over,
});

/** The answer of the target for `inputs`: the property with `links` there. */
function compared(inputs: BundleInput[], targetLinks: string[] | null): ProbeAnswer {
  const probe = buildProbe(inputs);
  const target: ProbeTarget = targetLinks ? { 'k.cc_type': { cls: 'ListMethodConfig', genedit: PROP_EDIT, generate: propertyGenerate('cc_type', targetLinks), parent: 'PROPERTY' } } : {};
  const r = parseProbeAnswer(probeAnswer(probe, target), probe);
  if (!r.ok) throw new Error(r.error);
  return r.answer;
}

describe('which objects are property definitions', () => {
  it('a class ending in MethodConfig at k.<ID>, not SystemMethodConfig', () => {
    expect(isPropertyDefinition('ListMethodConfig', 'k.type')).toBe(true);
    expect(isPropertyDefinition('TextMethodConfig')).toBe(true);
    expect(isPropertyDefinition('SystemMethodConfig', 'k.x')).toBe(false);
    expect(isPropertyDefinition('ListMethodConfig', 't.type')).toBe(false);
    expect(isPropertyDefinition('Category', 'k.type')).toBe(false);
  });

  it('the classes of its link lines, as a set; lines that link another variable are not its', () => {
    const text = "_lmc := root.property.add(ListMethodConfig, id := 'type')\n  c.get(CeTask.name).link(_lmc)\n  c.get(Scorecard.name).link(_lmc)\n  c.get(CeTask.name).link(_lmc)\n  c.get(CeRisk.name).link(_other)";
    expect(linkedClasses(text)).toEqual(['CeTask', 'Scorecard']);
    expect(linkedClasses(propertyGenerate('x', ['Scorecard', 'CeTask']))).toEqual(linkedClasses(propertyGenerate('x', ['CeTask', 'Scorecard'])));
    expect(linkedClasses('')).toBeNull();
  });
});

describe('the creation script', () => {
  it('runs generate(true) only for a class whose name holds MethodConfig; no descendants walk', () => {
    const code = buildTransportCreationEc();
    expect(classifyScript(code).kind).toBe('constant');
    expect(code).toContain([
      '_c := str(_o.className)', '_x := _c.indexOf("MethodConfig").whenMissing(-1)', 'IF _x > 0 THEN', '     _t := str(_o.generate(true))',
      // Its instances: its own values per class.
      '     _v := ""', '     _o.rref(linkedTo).forEach(_i:', '          _h := str(_i.genedit())', '          _v := _v + str(_h.size()) + ":" + _h', '     )',
      'ELSE', '     _v := ""', '     _f := "N"', 'ENDIF',
    ].map(l => `     ${l}`).join('\n'));
    expect(code).not.toContain('descendants');
    expect(code).not.toContain('FileResource');
    expect(parseTransportCreationLog(framedText([[RID, 'N', '', '']]), RID)).toEqual({ other: true });
    expect(parseTransportCreationLog(framedText([[RID, '', 'x', '']]), RID)).toEqual({ text: 'x', instances: '' });
  });

  it('another object gives no text', async () => {
    const pairs = vi.fn(async (ps: ReadonlyArray<{ code: string; objectRid?: string }>) => ps.map(p => ({ ok: true, log: framedText([[p.objectRid!, 'N', '', '']]) }) as EcResult));
    expect(await readTransportCreation({ executeEcPairs: pairs }, [RID])).toEqual([{ rid: RID, ok: false, error: 'It is not a property definition.' }]);
  });
});

describe('the Add from values', () => {
  const folder = (over: Partial<BundleInput> = {}): BundleInput => ({
    rid: RID, id: 'cc_mod', className: 'Category', isNew: true,
    genedit: "\nt.cc_mod.change(id := 'cc_mod', name := 'Module', description := 'A \\'quoted\\' text') //Category\n",
    parentAddress: 't.cc_folder', previousAddress: '', nextAddress: '', ...over,
  });

  it('<parent>.add(<Class>, <genedit arguments>), with or without children', () => {
    const b = assembleBundle([folder()]);
    expect(b.parts.find(p => p.step === 'create')!.text).toContain(['IF t.cc_mod = MISSING THEN', "     t.cc_folder.add(Category, id := 'cc_mod', name := 'Module', description := 'A \\'quoted\\' text')", 'ELSE ""', 'ENDIF'].join('\n'));
    expect(b.leftOut).toEqual([]);
    // A child of a root: the root is the parent; never-carried values are left out.
    const r = assembleBundle([folder({ parentAddress: '', parentIsRoot: true, parentId: 'PORTAL', genedit: "t.cc_mod.change(id := 'cc_mod', steadfastAgentConfiguration := 'x') //Category" })]);
    expect(r.parts.find(p => p.step === 'create')!.text).toContain("     root.portal.add(Category, id := 'cc_mod')");
  });

  it('without a parent it is left out; a system object is never added', () => {
    expect(assembleBundle([folder({ parentAddress: '' })]).leftOut).toMatchObject([{ reason: 'unreadable', detail: NO_PARENT_DETAIL }]);
    const sys = assembleBundle([folder({ systemObject: true })]);
    expect(sys.parts.some(p => p.step === 'create')).toBe(false);
    const smc = assembleBundle([{ rid: RID, id: 'x', className: 'SystemMethodConfig', isNew: true, genedit: '' }]);
    expect(smc.leftOut).toMatchObject([{ reason: 'no-text', detail: SYSTEM_OBJECT_DETAIL }]);
    // In a comparison: the target lacks it, it stays out.
    const input = folder({ systemObject: true, isNew: false });
    const probe = buildProbe([input]);
    const answer = parseProbeAnswer(probeAnswer(probe, { 't.cc_folder': { cls: 'Category' } }), probe);
    if (!answer.ok) throw new Error(answer.error);
    expect(assemblePatch([input], answer.answer).leftOut).toMatchObject([{ id: 'cc_mod', detail: SYSTEM_OBJECT_DETAIL }]);
  });
});

describe('a property definition', () => {
  it('its Add carries one link line per class (sorted), assigned to a variable; scripts without comparison say links come only with the Add', () => {
    const b = assembleBundle([prop(['Scorecard', 'CeTask'], { isNew: true })]);
    expect(b.parts.find(p => p.step === 'create')!.text).toContain([
      'IF k.cc_type = MISSING THEN',
      "     _pd := root.property.add(ListMethodConfig, id := 'cc_type', name := 'Type', category := 'General')",
      '     c.get(CeTask.name).link(_pd)',
      '     c.get(Scorecard.name).link(_pd)',
      'ELSE ""',
      'ENDIF',
    ].join('\n'));
    const change = b.parts.find(p => p.step === 'set')!.text;
    expect(change.split('\n').filter(l => l === PROPERTY_LINKS_COMMENT)).toHaveLength(1);
    // Without its text it cannot be added.
    expect(assembleBundle([prop(undefined, { isNew: true, creationError: 'Timed out' })]).leftOut).toMatchObject([{ reason: 'unreadable', detail: 'The text that adds it could not be read: Timed out.' }]);
  });

  it('the probe reads its generate(true) text after its O line; the key knows it', () => {
    const probe = buildProbe([prop(undefined)]);
    expect(probe.entries).toEqual([{ address: 'k.cc_type', kind: 'object', links: true, part: 1 }]);
    const text = probe.parts[0].text;
    expect(text).toContain('     _t := str(k.cc_type.generate(true))\n     _r := _r + ("\\nL 9:k.cc_type" + " " + str(_t.size()) + ":" + _t)');
    expect(text.indexOf('.generate(true)')).toBeGreaterThan(text.indexOf('.genedit()'));
    expect(probe.key).not.toBe(buildProbe([prop(undefined, { className: 'Category', genedit: PROP_EDIT.replace('ListMethodConfig', 'Category') })]).key);
    expect(PROBE_VERSION).toBe(9);
  });

  it('the answer gives the target\'s links as a set; an L line not after its O line is refused', () => {
    const a = compared([prop(['CeTask'])], ['Scorecard', 'CeTask']);
    expect(a.states['k.cc_type']).toMatchObject({ state: 'present', links: ['CeTask', 'Scorecard'] });
    const probe = buildProbe([prop(undefined)]);
    const bad = `${PROBE_MARKER} v${PROBE_VERSION} part 1/1 key ${probe.key}\nL 9:k.cc_type 2:xy\n${PROBE_MARKER} end part 1/1 key ${probe.key}`;
    expect(parseProbeAnswer(bad, probe)).toMatchObject({ ok: false, kind: 'incomplete' });
  });

  it('both have it, one class more here: one guarded link, counted to change; the Check looks at the links', () => {
    const input = prop(['CeTask', 'Scorecard']);
    const patch = assemblePatch([input], compared([input], ['CeTask']));
    const r = patch.review[0];
    expect(r).toMatchObject({ outcome: 'change', links: { add: ['Scorecard'], targetOnly: [] } });
    expect(patch.counts).toMatchObject({ change: 1, same: 0 });
    expect(patch.nothingToDo).toBe(false);
    expect(patch.parts.some(p => p.step === 'set')).toBe(false);
    const link = patch.parts.filter(p => p.step === 'link');
    expect(link).toHaveLength(1);
    expect(link[0].run).toBe('committed');
    expect(link[0].text).toContain([
      '_lc := c.get(Scorecard.name)',
      'IF _lc != MISSING AND k.cc_type != MISSING THEN',
      '     _lx := str(_lc.id) + "." + str(k.cc_type.id)',
      '     _lf := _lc.children.filter(id = _lx)',
      '     IF _lf.size() = 0 THEN',
      '          c.get(Scorecard.name).link(k.cc_type)',
      '     ELSE ""',
      '     ENDIF',
      'ELSE ""',
      'ENDIF',
    ].join('\n'));
    expect(link[0].text).not.toContain('CeTask');
    expect(link[0].text).toContain("IF k.cc_type != MISSING AND k.cc_type.className != 'ListMethodConfig'");
    // The Check: the size of its text there and a line for each class it had.
    const size = propertyGenerate('cc_type', ['CeTask']).length;
    const check = patch.parts.find(p => p.step === 'check')!.text;
    expect(check).toContain([
      'IF k.cc_type != MISSING THEN',
      '     _t := str(k.cc_type.generate(true))',
      '     _lk := ""',
      '     IF _t.indexOf("c.get(CeTask.name).link(").whenMissing(-1) > -1 THEN',
      '          _lk := _lk + "."',
      '     ELSE ""',
      '     ENDIF',
      `     IF _t.size() = ${size} AND _lk.size() = 1 THEN`,
      '          _ok := _ok + "."',
      '     ELSE',
      '          _r := _r + "\\nCHANGED links since the comparison k.cc_type"',
      '          _dv := _dv + "."',
      '     ENDIF',
      'ELSE ""',
      'ENDIF',
    ].join('\n'));
    const steps = patch.parts.map(p => p.step);
    expect(steps.indexOf('link')).toBeGreaterThan(steps.indexOf('check'));
  });

  it('the same links in another order: the same; a class only on the target: nothing written, shown', () => {
    const input = prop(['CeTask', 'Scorecard']);
    const same = assemblePatch([input], compared([input], ['Scorecard', 'CeTask']));
    expect(same.review[0]).toMatchObject({ outcome: 'same', links: { add: [], targetOnly: [] } });
    expect(same.nothingToDo).toBe(true);
    const extra = assemblePatch([input], compared([input], ['CeRisk', 'Scorecard', 'CeTask']));
    expect(extra.review[0]).toMatchObject({ outcome: 'same', links: { add: [], targetOnly: ['CeRisk'] } });
    expect(extra.nothingToDo).toBe(true);
    expect(extra.parts.map(p => p.step)).toEqual([]);
    expect(extra.text).not.toMatch(/\.link\(|unlink/);
  });

  it('the target lacks it: added with every link; without its text here it is left out', () => {
    const input = prop(['Scorecard']);
    const patch = assemblePatch([input], compared([input], null));
    expect(patch.review[0]).toMatchObject({ outcome: 'create', links: { add: ['Scorecard'], targetOnly: [] } });
    expect(patch.parts.find(p => p.step === 'create')!.text).toContain('     c.get(Scorecard.name).link(_pd)');
    expect(patch.parts.some(p => p.step === 'link')).toBe(false);
    const none = prop(undefined);
    expect(assemblePatch([none], compared([none], ['CeTask'])).leftOut).toMatchObject([{ reason: 'unreadable', detail: 'The text with its links could not be read.' }]);
  });

  it('only property definitions get their text read for a patch', () => {
    const plain: BundleInput = { rid: RID, id: 'cc_x', className: 'TextElement', isNew: true, genedit: "t.cc_x.change(id := 'cc_x') //TextElement", parentAddress: 't.page' };
    const copy = prop(undefined, { rid: '9007199254741103', id: 'cc_copy', genedit: PROP_EDIT.replace(/cc_type/g, 'cc_copy'), linkedTo: 'cc_type' });
    expect(propertyDefinitionRids([plain, prop(undefined), copy])).toEqual(['9007199254741101']);
  });
});

describe('a linked copy', () => {
  it('is not added: link its template under its parent on the target', () => {
    expect(linkedCopyDetail('tpl_card')).toBe('A linked copy is not added: link tpl_card under its parent on the target.');
  });
});

describe('the window', () => {
  const mod = row({ id: 'mod', className: 'Category', parentRid: '1', parentId: 'PORTAL' });
  const tab = row({ id: 'tab', parentRid: mod.rid });
  const type = row({ id: 'cc_type', className: 'ListMethodConfig', parentRid: '2', parentId: 'PROPERTY' });
  const read = (rid: string, withText: boolean) => (rid === mod.rid
    ? readOk(rid, 'mod', { className: 'Category', generate: undefined, genedit: "t.mod.change(id := 'mod', name := 'Name mod') //Category" })
    : rid === type.rid
      ? readOk(rid, 'cc_type', { className: 'ListMethodConfig', genedit: PROP_EDIT, parentAddress: '', parentIsRoot: true, parentId: 'PROPERTY', generate: withText ? propertyGenerate('cc_type', ['CeTask']) : undefined })
      : readOk(rid, 'tab', { generate: undefined }));

  async function built(choice: string) {
    const w = fakeWorker((m: Sent) => (m.type === 'TRANSPORT_READ_OBJECTS'
      ? objectsResult(m, (m.rids as string[]).map(rid => read(rid, ((m.creation as string[] | undefined) ?? []).includes(rid))))
      : m.type === 'TRANSPORT_READ_CREATION' ? creationResult(m, new Map(), { texts: (m.rids as string[]).map(rid => ({ rid, ok: true, generate: propertyGenerate('cc_type', ['CeTask']) })) })
        : scanResult(m, { rows: m.root === 'portal' ? [mod, tab] : m.root === 'property' ? [type] : [] })));
    const ctl = new TransportController(w.deps, { since: '2026-11-08' });
    await ctl.scan();
    ctl.setGroupTicked('portal', true);
    ctl.setGroupTicked('property', true);
    ctl.setChoice(choice);
    await ctl.buildBundle();
    return { w, ctl };
  }

  it('scripts without comparison: no creation read for a folder or its child; the property definition\'s links are read with it', async () => {
    const { w, ctl } = await built(CHOICE_ANY);
    expect(w.sent.filter(m => m.type === 'TRANSPORT_READ_OBJECTS').flatMap(m => (m.creation as string[] | undefined) ?? [])).toEqual([type.rid]);
    expect(w.sent.some(m => m.type === 'TRANSPORT_READ_CREATION')).toBe(false);
    const add = ctl.bundle!.result!.parts.find(p => p.step === 'create')!.text;
    expect(add).toContain("t.page.add(Category, id := 'mod', name := 'Name mod')");
    expect(add).toContain("t.page.add(TextElement, id := 'tab', name := 'Name tab')");
    expect(add).toContain('c.get(CeTask.name).link(_pd)');
  });

  it('a comparison: the target lacks all three; only the property definition\'s text is read, after the answer', async () => {
    const { w, ctl } = await built(CHOICE_PASTE);
    expect(w.sent.filter(m => m.type === 'TRANSPORT_READ_OBJECTS').flatMap(m => (m.creation as string[] | undefined) ?? [])).toEqual([]);
    const t = ctl.bundle!.target!;
    await ctl.readAnswer(probeAnswer(t.probe, { 't.page': { cls: 'Category' } }));
    expect(t.answerError).toBeUndefined();
    expect(w.sent.filter(m => m.type === 'TRANSPORT_READ_CREATION').map(m => m.rids)).toEqual([[type.rid]]);
    expect(t.patch!.review.map(r => [r.address, r.outcome])).toEqual([['k.cc_type', 'create'], ['t.mod', 'create'], ['t.tab', 'create']]);
  });

  it('a comparison: the target has the property definition with fewer links; its text is read and a link is added', async () => {
    const { w, ctl } = await built(CHOICE_PASTE);
    const t = ctl.bundle!.target!;
    await ctl.readAnswer(probeAnswer(t.probe, { 't.page': { cls: 'Category' }, 'k.cc_type': { cls: 'ListMethodConfig', genedit: PROP_EDIT, generate: propertyGenerate('cc_type', []), parent: 'PROPERTY' } }));
    expect(w.sent.filter(m => m.type === 'TRANSPORT_READ_CREATION').map(m => m.rids)).toEqual([[type.rid]]);
    expect(t.patch!.review.find(r => r.address === 'k.cc_type')).toMatchObject({ outcome: 'change', links: { add: ['CeTask'], targetOnly: [] } });
  });
});
