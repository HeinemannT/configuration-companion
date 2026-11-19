import { describe, expect, it } from 'vitest';
import type { LModel } from '../types';
import { compile } from '../ec';
import { cloneModel } from '../model';
import { addFlowChild, flowDiff, setFlowSetting, stagedSettings } from '../flow';
import { buildFlowSettingsEc, flowSettingsFor, parseFlowSettings, settingsAssignments, settingsWords } from '../flow-settings';

const M = '<<<CREV_FLST>>>';
const model = (): LModel => ({
  pageId: 'p', pageClass: 'Scorecard', tabsetId: 'ts', target: 'instance', tabs: [],
  flows: { w1: { ownerId: 'w1', ownerRid: 'r_w1', ownerClass: 'CreateObjectView', kind: 'editpage', refId: 'page1', refRid: 'r_page1', refClass: 'EditPage',
    children: [{ id: 'f1', rid: '8462927774283323091', className: 'EditField', name: 'Edit field' }] } },
} as unknown as LModel);

describe('settings of a form element', () => {
  it('offers a short list per class and none for a class that is not listed', () => {
    expect(flowSettingsFor('EditField').map(s => s.prop)).toEqual(['required', 'placeholder']);
    expect(flowSettingsFor('ReferenceInput').map(s => s.prop)).toEqual(['key', 'allowBlank', 'multiselect']);
    expect(flowSettingsFor('ButtonGroup')).toEqual([]);
  });

  it('writes only listed properties, text escaped and yes/no as TRUE/FALSE', () => {
    expect(settingsAssignments('EditField', { required: true, placeholder: 'Say "why"', name: 'x' }))
      .toEqual(['required := TRUE', 'placeholder := "Say \\"why\\""']);
    expect(settingsAssignments('EditField', { required: false })).toEqual(['required := FALSE']);
    expect(settingsAssignments('Unknown', { required: true })).toEqual([]);
    expect(settingsWords('EditField', { required: true, placeholder: 'Why' })).toBe('Required: yes, Placeholder: "Why"');
  });

  it('reads every listed setting, empty where the server sent none', () => {
    const ec = buildFlowSettingsEc('9007837798074769804', 'ReferenceInput');
    expect(ec).toContain('_o := lookup(9007837798074769804)');
    expect(ec).toContain('str(_o.allowBlank.whenMissing(""))');
    expect(() => buildFlowSettingsEc('1); delete', 'ReferenceInput')).toThrow();
    expect(parseFlowSettings(`${M}key|tax | entity\n${M}allowBlank|true\n`, 'ReferenceInput'))
      .toEqual({ key: 'tax | entity', allowBlank: true, multiselect: false });
  });

  it('stages a change on an existing element and drops it when it equals the stored value', () => {
    const base = model();
    const on = setFlowSetting(base, 'page1', 'f1', 'EditField', 'required', true, false);
    expect(stagedSettings(on, 'page1', 'f1')).toEqual({ required: true });
    expect(cloneModel(on).flowEdits?.f1?.settings).toEqual({ className: 'EditField', values: { required: true } });
    expect(compile(flowDiff(base, on), on).script).toBe('t.f1.change(required := TRUE)');
    expect(setFlowSetting(on, 'page1', 'f1', 'EditField', 'required', false, false).flowEdits ?? {}).toEqual({});
  });

  it('keeps the settings of a new element on it and writes them right after its add', () => {
    const base = model();
    const added = addFlowChild(base, 'page1', 'EditField', 'Edit field');
    let m = setFlowSetting(added.model, 'page1', added.id, 'EditField', 'placeholder', 'Why');
    m = setFlowSetting(m, 'page1', added.id, 'EditField', 'required', true);
    expect(stagedSettings(m, 'page1', added.id)).toEqual({ placeholder: 'Why', required: true });
    expect(stagedSettings(cloneModel(m), 'page1', added.id)).toEqual({ placeholder: 'Why', required: true });
    const script = compile(flowDiff(base, m), m).script;
    expect(script).toMatch(/_ff0 := .*\.add\(EditField, name := "Edit field"\)/);
    expect(script).toContain('_ff0.change(required := TRUE, placeholder := "Why")');
    // Off and empty are where a new element starts: taking them back leaves nothing to write.
    const off = setFlowSetting(setFlowSetting(m, 'page1', added.id, 'EditField', 'required', false), 'page1', added.id, 'EditField', 'placeholder', '');
    expect(stagedSettings(off, 'page1', added.id)).toEqual({});
    expect(compile(flowDiff(base, off), off).script).not.toContain('.change(');
  });
});
