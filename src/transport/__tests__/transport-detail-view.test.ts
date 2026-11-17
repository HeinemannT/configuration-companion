// @vitest-environment happy-dom
/**
 * The row details and lines of a comparison with a connected target that
 * had no view test: "Linked to classes", "Links" (also linked on the
 * target), "Unlinked from classes" with the delete switch, "Own values on
 * <Class>", "Links between steps" (links removed), the steps needs line,
 * the schedule line and the confirmation's schedule and class-link lines.
 */
import { describe, expect, it } from 'vitest';
import { CHECK_READY_LINE } from '../../lib/transport-patch';
import type { InspectorMessage } from '../../lib/types';
import { TransportController } from '../transport-controller';
import { mountTransportView, scheduleSentence, unlinkCount, unlinkSentence } from '../transport-view';
import { ENV, fakeWorker, flush, objectsResult, probeAnswer, propertyGenerate, readOk, row, scanResult, type ProbeTarget, type Sent } from './fakes';

const TARGET_ENV = 'p2@https://bmp.example.test/Test/';
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
const PROP_EDIT = "\nk.cc_type.change(id := 'cc_type', name := 'Type') //ListMethodConfig\n";
const inst = (cls: string, args: string) => {
  const t = `\nk.get('com.corporater.bmp.model.model.enterprise.${cls}.cc_type').change(id := 'com.corporater.bmp.model.model.enterprise.${cls}.cc_type'${args ? `, ${args}` : ''}) //ListMethodConfig\n`;
  return `${t.length}:${t}`;
};
const SRC_EDIT = "\nt.cc_src.change(id := 'cc_src', name := 'Source') //TableSourceConfig\n";
const SCHED_EDIT = "\nt.cc_sched.change(id := 'cc_sched', name := 'Nightly') //TransformerSchedule\n";

async function compared() {
  const flow = row({ id: 'cc_flow', className: 'FlowProject' });
  const src = row({ id: 'cc_src', className: 'TableSourceConfig', parentRid: flow.rid });
  const sched = row({ id: 'cc_sched', className: 'TransformerSchedule', parentRid: flow.rid });
  const type = row({ id: 'cc_type', className: 'ListMethodConfig', parentId: 'PROPERTY' });
  const reads: Record<string, ReturnType<typeof readOk>> = {
    [flow.rid]: readOk(flow.rid, 'cc_flow', { className: 'FlowProject', genedit: FLOW_TEXT, generate: undefined }),
    [src.rid]: readOk(src.rid, 'cc_src', { className: 'TableSourceConfig', genedit: SRC_EDIT, parentAddress: 't.cc_flow', parentId: 'cc_flow', flowStep: true, generate: undefined }),
    [sched.rid]: readOk(sched.rid, 'cc_sched', { className: 'TransformerSchedule', genedit: SCHED_EDIT, parentAddress: 't.cc_flow', parentId: 'cc_flow', generate: undefined }),
    [type.rid]: readOk(type.rid, 'cc_type', { className: 'ListMethodConfig', genedit: PROP_EDIT, parentAddress: '', parentIsRoot: true, parentId: 'PROPERTY', generate: undefined }),
  };
  // The target: the property linked to CeRisk only, the flow with a link of its own.
  const target: ProbeTarget = {
    'k.cc_type': { cls: 'ListMethodConfig', genedit: PROP_EDIT, generate: propertyGenerate('cc_type', ['CeRisk']), instances: inst('CeRisk', ''), parent: 'PROPERTY' },
    't.cc_flow': { cls: 'FlowProject', genedit: FLOW_TEXT, flow: 'cc_src>cc_dst;cc_x>cc_src;' },
    't.cc_src': { cls: 'TableSourceConfig', genedit: SRC_EDIT, parent: 'cc_flow' },
    't.cc_sched': { cls: 'TransformerSchedule', genedit: SCHED_EDIT, parent: 'cc_flow' },
    't.page': { cls: 'Category' },
  };
  const w = fakeWorker();
  w.targets = [{ environment: TARGET_ENV, label: 'Demo TEST', host: 'bmp.example.test' }];
  const ctl = new TransportController(w.deps, { since: '2026-11-08' });
  const result = (msg: Sent, over: Record<string, unknown>) => ({ type: 'TRANSPORT_PART_RESULT', requestId: msg.requestId, environment: ENV, target: msg.target, ok: true, ...over }) as InspectorMessage;
  w.answer = (m: Sent) => {
    if (m.type === 'TRANSPORT_READ_OBJECTS') return objectsResult(m, (m.rids as string[]).map(rid => reads[rid]));
    if (m.type === 'TRANSPORT_READ_CREATION') return { type: 'TRANSPORT_CREATION_RESULT', requestId: m.requestId, environment: ENV, ok: true, texts: (m.rids as string[]).map(rid => ({ rid, ok: true, generate: propertyGenerate('cc_type', ['CeTask']), instances: inst('CeTask', 'required := true') })) } as InspectorMessage;
    if (m.type === 'TRANSPORT_RUN_PART') {
      const probe = ctl.bundle!.target!.probe;
      const part = probe.parts.find(p => p.text === m.code);
      return result(m, { log: part ? probeAnswer(probe, target, { parts: [part.index] }) : `Transport check\n${CHECK_READY_LINE}` });
    }
    return scanResult(m, { rows: m.root === 'transformer' ? [flow, src, sched] : m.root === 'property' ? [type] : [] });
  };
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  mountTransportView(host, ctl, { now: () => new Date(2026, 10, 15, 12, 0, 0) });
  const $ = <T extends Element = HTMLElement>(s: string) => host.querySelector<T>(s);
  const $$ = <T extends Element = HTMLElement>(s: string) => [...host.querySelectorAll<T>(s)];
  await ctl.loadTargets();
  await ctl.scan();
  ctl.setGroupTicked('transformer', true);
  ctl.setGroupTicked('property', true);
  $<HTMLButtonElement>('.tr-open')!.click();
  await flush(20);
  $<HTMLButtonElement>('.tr-act')!.click();
  await flush(80);
  const open = (r: { rid: string }) => { $<HTMLButtonElement>(`.tr-tcaret[data-rid="${r.rid}"]`)!.click(); };
  const section = (r: { rid: string }, title: string) => $$(`.tr-detail[data-rid="${r.rid}"] .tr-dsec`).find(s => s.querySelector('.tr-dsec-h')?.textContent === title);
  return { w, ctl, $, $$, open, section, flow, type };
}

describe('a comparison with class links, own values per class and links between steps', () => {
  it('the row details; the class link only on the target is shown, not removed', async () => {
    const { ctl, $, open, section, flow, type } = await compared();
    expect(ctl.bundle!.target!.patch).toBeDefined();
    open(type);
    expect(section(type, 'Linked to classes')!.querySelector('.tr-dsec-b')!.textContent).toBe('CeTask');
    expect(section(type, 'Links')!.querySelector('.tr-dsec-b')!.textContent).toBe('Also linked on the target: CeRisk');
    const own = section(type, 'Own values on CeTask')!;
    expect(own.querySelector('.tr-vals')!.textContent).toContain('required');
    open(flow);
    const links = section(flow, 'Links between steps')!.querySelector('.tr-dsec-b')!.textContent;
    expect(links).toContain('cc_dst > cc_out');
    expect(links).toContain('Links between steps removed: cc_x > cc_src');
    // The steps needs line and the schedule line.
    expect($('[data-need="steps"]')!.textContent).toBe('2 steps of flow projects are not in this transportAdd them');
    expect($('[data-need="schedules"]')!.textContent).toBe(scheduleSentence(1, 'Demo TEST'));
    // The delete switch is there for the class link alone.
    expect($('.tr-onlyblk > summary')!.textContent).toBe('1 class link only on Demo TEST');
    expect($('.tr-sum')!.textContent).not.toContain('class link');
  });

  it('with the delete switch: unlinked, counted, and said in the confirmation with the schedule line', async () => {
    const { ctl, $, open, section, type } = await compared();
    ctl.setDeleteExtra(true);
    await flush(10);
    const p = ctl.bundle!.target!.patch!;
    expect(p.unlinks).toEqual([{ address: 'k.cc_type', className: 'CeRisk' }]);
    expect(p.parts.find(x => x.step === 'delete')!.text).toContain([
      '_lc := c.get(CeRisk.name)',
      'IF _lc != MISSING AND k.cc_type != MISSING THEN',
      '     _lx := str(_lc.id) + "." + str(k.cc_type.id)',
      '     _li := k.get(_lx)',
      '     IF _li != MISSING AND _li.linkedTo != MISSING AND str(_li.linkedTo.id) = str(k.cc_type.id) THEN',
      '          k.get(_lx).delete()',
      '     ELSE ""',
      '     ENDIF',
      'ELSE ""',
      'ENDIF',
    ].join('\n'));
    open(type);
    expect(section(type, 'Unlinked from classes')!.querySelector('.tr-dsec-b')!.textContent).toBe('CeRisk');
    expect(section(type, 'Links')).toBeUndefined();
    expect($('.tr-sum')!.textContent).toContain(unlinkCount(1));
    // Danger first (the class link removed), then needs you, then to know.
    expect([...document.querySelectorAll<HTMLElement>('.tr-needs .tr-need')].map(e => [e.dataset.need, e.dataset.level])).toEqual([
      ['target-only', 'danger'], ['steps', 'needs'], ['schedules', 'know'],
    ]);
    expect($('.tr-onlyblk .tr-fl-t')!.textContent).toBe('Delete objects only Demo TEST has');
    $<HTMLButtonElement>('.tr-apply')!.click();
    expect($('.tr-confirm-counts')!.textContent).toContain(unlinkCount(1));
    expect($('.tr-confirm-unlink')!.textContent).toBe(unlinkSentence(1));
    expect(unlinkSentence(2)).toBe('2 class links are removed: the values of the property on objects of these classes are lost.');
    expect($('.tr-confirm-schedules')!.textContent).toBe(scheduleSentence(1, 'Demo TEST'));
  });
});
