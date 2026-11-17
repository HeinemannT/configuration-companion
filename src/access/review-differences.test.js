import { describe, expect, it } from 'vitest';
import { conditionDifferences, statementDifferences, fieldDifference, fieldNameOf } from './review-differences';
import { diffStatements } from './policy-diff.js';

const roles = [{ rid: '1', id: 'risk_owner', name: 'Risk owner' }, { rid: '2', id: 'reviewer', name: 'Assessment reviewer' }];
const typeList = (values) => ({ Condition: { Left: 'resource.Type', Comparison: 'ContainsAny', Right: values.map(v => 'ListPropertySetItem:' + v) } });
const model = { Condition: { Left: 'resource.model', Comparison: '!=', Right: 'DEFAULTS' } };
const statement = (extra = {}) => ({ Effect: 'Allow', Subject: ['role:risk_owner'], Action: ['Read'],
  Resource: { All: [model, typeList(['type_risk', 'type_control'])] }, ...extra });
const change = (before, after) => diffStatements(before, after)[0];
const texts = (before, after) => statementDifferences(change([before], [after]), roles).map(d => d.text);

describe('differences in a condition list', () => {
  it('names an added value with the condition it went into, and only that value', () => {
    const [d, ...rest] = statementDifferences(change([statement()], [statement({ Resource: { All: [model, typeList(['type_risk', 'type_control', 'type_process'])] } })]), roles);
    expect(rest).toEqual([]);
    expect(d.text).toBe('Added type_process to “Type contains any”.');
    expect(d).toMatchObject({ part: 'On', kind: 'list', label: 'On · Type contains any', before: [], after: [{ text: 'type_process' }] });
  });

  it('names removed values and a changed single value', () => {
    expect(conditionDifferences({ All: [typeList(['a', 'b', 'c'])] }, { All: [typeList(['a'])] }).map(d => d.text)).toEqual(['Removed b and c from “Type contains any”.']);
    const changed = conditionDifferences({ All: [model] }, { All: [{ Condition: { ...model.Condition, Right: 'ARCHIVE' } }] });
    expect(changed.map(d => [d.text, d.before, d.after])).toEqual([['Changed “model is not” from DEFAULTS to ARCHIVE.', [{ text: 'DEFAULTS' }], [{ text: 'ARCHIVE' }]]]);
  });

  it('keeps a condition that only moved, and reports added, removed and flipped groups', () => {
    const status = { Condition: { Left: 'resource.status', Comparison: '=', Right: 'Open' } };
    expect(conditionDifferences({ All: [model, status] }, { All: [status, model] })).toEqual([]);
    expect(conditionDifferences({ All: [model] }, { All: [model, status] }).map(d => d.text)).toEqual(['Added the condition “status is Open”.']);
    expect(conditionDifferences({ All: [model, status] }, { All: [model] }).map(d => d.text)).toEqual(['Removed the condition “status is Open”.']);
    expect(conditionDifferences({ All: [{ All: [model] }] }, { All: [{ Any: [model] }] }).map(d => d.text)).toEqual(['Changed a group from All of to Any of.']);
  });
});

describe('differences in who and can', () => {
  it('says which operation was added or removed, for whom', () => {
    expect(texts(statement(), statement({ Action: ['Read', 'Update'] }))).toEqual(['Update added for Risk owner.']);
    expect(texts(statement({ Action: ['Read', 'Delete'] }), statement())).toEqual(['Delete removed for Risk owner.']);
  });

  it('says how the audience changed, and when it now reaches every user', () => {
    expect(texts(statement(), statement({ Subject: ['role:risk_owner', 'role:reviewer'] }))).toEqual(['Assessment reviewer added to who.']);
    const [everyone] = statementDifferences(change([statement()], [statement({ Subject: '*' })]), roles);
    expect(everyone.text).toBe('Changed who from Risk owner to Everyone. It now applies to every user.');
    expect(everyone.after).toEqual([{ text: 'Everyone', secondary: 'every user' }]);
  });
});

describe('statements added, removed and moved', () => {
  it('lists a new statement as Who, Can and On on the After side only', () => {
    const diffs = statementDifferences(change([statement()], [statement(), statement({ Subject: '*', Action: ['Read'] })]), roles);
    expect(diffs[0].text).toBe('Added statement 2. It applies to every user.');
    expect(diffs.slice(1).map(d => [d.label, d.before.length, d.after.map(v => v.text)])).toEqual([
      ['Who', 0, ['Everyone']], ['Can', 0, ['Read']], ['On', 0, ['model is not DEFAULTS and Type contains any type_risk, type_control']]]);
  });

  it('lists a removed statement on the Before side only, and a move by position', () => {
    const removed = statementDifferences(change([statement(), statement({ Action: ['Update'] })], [statement()]), roles);
    expect(removed[0].text).toBe('Removed statement 2.');
    expect(removed.slice(1).every(d => d.before.length && !d.after.length)).toBe(true);
    const a = statement(), b = statement({ Action: ['Update'] });
    expect(statementDifferences(change([a, b], [b, a]), roles).map(d => d.text)).toEqual(['Moved from position 1 to 2. The statement itself is unchanged.']);
  });
});

describe('field changes', () => {
  const row = { field: 'managers', referenceConfig: '9000000000000000901' };
  it('names the fields and keeps the RID secondary', () => {
    const d = fieldDifference(row, { field: 'viewers', referenceConfig: '9000000000000000902' }, () => undefined);
    expect(d.text).toBe('Changed the field from managers to viewers.');
    expect(d.before).toEqual([{ text: 'managers', secondary: 'RID 9000000000000000901' }]);
    expect(d.after).toEqual([{ text: 'viewers', secondary: 'RID 9000000000000000902' }]);
    expect(fieldDifference(row, { ...row }, () => undefined)).toBeNull();
  });

  it('never shows a bare RID: a blank definition is set on save, a missing field name is looked up', () => {
    const d = fieldDifference(row, { field: 'viewers', referenceConfig: '' }, () => undefined);
    expect(d.after).toEqual([{ text: 'viewers', secondary: 'RID set on save from the live schema' }]);
    const classes = { Organisation: [{ rid: '9000000000000000901', accessor: 'managers' }] };
    expect(fieldNameOf(classes, '9000000000000000901')).toBe('Organisation.managers');
    const named = fieldDifference({ referenceConfig: '9000000000000000901' }, { referenceConfig: '9000000000000000903' }, rid => fieldNameOf(classes, rid));
    expect(named.before[0]).toEqual({ text: 'Organisation.managers', secondary: 'RID 9000000000000000901' });
    expect(named.after[0].text).toBe('No field');
  });
});
