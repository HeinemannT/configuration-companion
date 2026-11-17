import { describe, expect, it } from 'vitest';
import { statementSummary, statementSentence, readsAs, moveStatement, duplicateStatement, removeStatement, expressionCounts, conditionWords } from './statement-model';

const roles = [{ rid: '9000000000000000001', id: 'risk_owner', name: 'Risk owner' }];
const typeCondition = (...types) => ({ Condition: { Left: 'resource.Type', Comparison: 'ContainsAny', Right: types } });

describe('statement summaries', () => {
  it('summarises effect, subjects, C R U D and the resource on one line', () => {
    const summary = statementSummary({ Effect: 'allow', Subject: ['role:risk_owner', 'user:jdoe'], Action: ['read', 'UPDATE'],
      Resource: { All: [typeCondition('CeRisk'), { Condition: { Left: 'resource.accountable_owner', Comparison: '=', Right: 'user' } }] } }, roles);
    expect(summary.effect).toBe('Allow');
    expect(summary.subjects.map(s => [s.kind, s.name, s.rid ?? ''])).toEqual([['role', 'Risk owner', roles[0].rid], ['user', 'jdoe', '']]);
    expect(summary.actions).toEqual({ Create: false, Read: true, Update: true, Delete: false });
    expect(summary.resource.text).toBe('type: CeRisk + 1 more condition');
  });

  it('names more than two types with a count, and keeps unknown role tokens visible', () => {
    const summary = statementSummary({ Effect: 'Allow', Subject: ['role:gone'], Action: 'Read',
      Resource: { All: [typeCondition('CeRisk', 'CeRiskAssessment', 'CeIssue')] } }, roles);
    expect(summary.resource.text).toBe('type: CeRisk, CeRiskAssessment +1');
    expect(summary.subjects[0]).toMatchObject({ kind: 'role', name: 'gone', known: false });
  });

  it('writes a single condition in words and counts nested groups', () => {
    expect(statementSummary({ Effect: 'Allow', Subject: '*', Action: ['Read'], Resource: { Condition: { Left: 'resource.model', Comparison: '!=', Right: 'DEFAULTS' } } }).resource.text)
      .toBe('all objects where model is not DEFAULTS');
    expect(statementSummary({ Effect: 'Allow', Subject: '*', Action: [], Resource: { All: [] } }).resource.text).toBe('all objects');
    const nested = { All: [typeCondition('CeControlMeasure'), { Any: [{ HasRole: { Reference: 'resource.performed_in', Roles: ['control_tester'] } },
      { HasAccessTo: { Reference: 'resource.parent_control' } }] }, { Condition: { Left: 'resource.status', Comparison: '!=', Right: 'Retired' } }] };
    expect(expressionCounts(nested)).toEqual({ conditions: 4, groups: 1 });
    expect(statementSummary({ Effect: 'Allow', Subject: '*', Action: 'Read', Resource: nested }).resource.text).toBe('type: CeControlMeasure + 3 more conditions, 1 group');
    expect(conditionWords({ HasRole: { Reference: 'resource.performed_in', Roles: ['control_tester'] } })).toBe('performed_in has role control_tester');
  });

  it('treats Everyone and Deny truthfully in the sentence', () => {
    expect(statementSentence({ Effect: 'Deny', Subject: '*', Action: ['Delete'], Resource: { All: [typeCondition('CeRiskAssessment')] } }))
      .toBe('Deny Everyone Delete on objects of type: CeRiskAssessment. The server ignores this statement. Deny grants nothing and blocks nothing.');
    expect(statementSentence({ Effect: 'Allow', Subject: ['role:risk_owner'], Action: ['Read', 'Update'], Resource: { All: [typeCondition('CeRisk')] } }, roles))
      .toBe('Risk owner may Read and Update objects of type: CeRisk.');
  });
});

describe('statement edits', () => {
  const content = { Version: '1.0', Statement: [{ Effect: 'Allow', n: 1 }, { Effect: 'Deny', n: 2 }, { Effect: 'Allow', n: 3, 'X-Keep': [1] }], Extra: { keep: true } };

  it('moves, duplicates and removes without touching other keys', () => {
    expect(moveStatement(content, 2, 0).Statement.map(s => s.n)).toEqual([3, 1, 2]);
    expect(Object.keys(moveStatement(content, 0, 1))).toEqual(['Version', 'Statement', 'Extra']);
    const duplicated = duplicateStatement(content, 2);
    expect(duplicated.Statement.map(s => s.n)).toEqual([1, 2, 3, 3]);
    expect(duplicated.Statement[3]).toEqual(content.Statement[2]);
    expect(duplicated.Statement[3]).not.toBe(content.Statement[2]);
    expect(removeStatement(content, 1).Statement.map(s => s.n)).toEqual([1, 3]);
    expect(content.Statement.map(s => s.n)).toEqual([1, 2, 3]);
    expect(() => moveStatement(content, 0, -1)).toThrow();
    expect(() => removeStatement({ Version: '1.0' }, 0)).toThrow(/no statement list/);
  });
});

describe('reads as', () => {
  it('names the types once and then only the remaining conditions', () => {
    const s = { Effect: 'Allow', Subject: '*', Action: ['Read'], Resource: { All: [typeCondition('ListPropertySetItem:type_risk', 'ListPropertySetItem:type_issue'),
      { Condition: { Left: 'resource.status', Comparison: '!=', Right: 'Retired' } }] } };
    expect(readsAs(s)).toBe('Everyone may Read objects of type: type_risk or type_issue, when status is not Retired.');
    expect(readsAs({ ...s, Resource: { All: [typeCondition('CeRisk')] } })).toBe('Everyone may Read objects of type: CeRisk.');
    expect(readsAs({ ...s, Resource: { Condition: { Left: 'resource.model', Comparison: '!=', Right: 'DEFAULTS' } } })).toBe('Everyone may Read all objects, when model is not DEFAULTS.');
  });
});
describe('statements that grant nothing', () => {
  const base = { Effect: 'Allow', Subject: ['role:risk_owner'], Action: ['Read'], Resource: { All: [] } };
  it('says so in plain words instead of an empty sentence', () => {
    const cases = [
      [{ ...base, Action: [] }, 'Grants nothing yet: no action is ticked.'],
      [{ ...base, Subject: [] }, 'Grants nothing yet: Who names no one.'],
      [{ ...base, Subject: undefined, Action: [] }, 'Grants nothing yet: Who names no one and no action is ticked.'],
      [{ ...base, Effect: undefined }, 'Grants nothing: the statement has no effect. Only Allow grants access.'],
      [{ ...base, Effect: 'Maybe' }, 'Grants nothing: the effect “Maybe” is not Allow. Only Allow grants access.'],
    ];
    for (const [statement, text] of cases) {
      expect(statementSentence(statement, roles)).toBe(text);
      expect(readsAs(statement, roles)).toBe(text);
      expect(statementSummary(statement, roles).nothing).toBe(text);
    }
    expect(statementSummary(base, roles).nothing).toBe('');
    expect(statementSentence({ Effect: 'Deny', Subject: [], Action: [], Resource: { All: [] } })).toBe('Deny no one on all objects. The server ignores this statement. Deny grants nothing and blocks nothing.');
    for (const [statement] of cases) expect(statementSentence(statement, roles) + readsAs(statement, roles)).not.toMatch(/no operation|Nobody may/);
  });

  it('names the objects in words when there is no type or several conditions', () => {
    expect(statementSentence(base, roles)).toBe('Risk owner may Read all objects.');
    expect(statementSentence({ ...base, Resource: { All: [{ Condition: { Left: 'resource.a', Comparison: '=', Right: 'x' } }, { Condition: { Left: 'resource.b', Comparison: '=', Right: 'y' } }] } }, roles))
      .toBe('Risk owner may Read objects that meet 2 conditions.');
    expect(statementSentence({ ...base, Resource: { All: [typeCondition('CeRisk', 'CeIssue'), { Condition: { Left: 'resource.a', Comparison: '=', Right: 'x' } }] } }, roles))
      .toBe('Risk owner may Read objects of type: CeRisk or CeIssue, when 1 more condition holds.');
  });
});
