import { describe, expect, it } from 'vitest';
import { diffStatements, changeSentence, revertStatementChange, policyChanges } from './policy-diff.js';

const roles = [{ rid: '1', id: 'risk_owner', name: 'Risk owner' }, { rid: '2', id: 'reviewer', name: 'Assessment reviewer' }];
const s = (subject, actions, extra = {}) => ({ Effect: 'Allow', Subject: ['role:' + subject], Action: actions,
  Resource: { All: [{ Condition: { Left: 'resource.type', Comparison: '=', Right: 'CeRisk' } }] }, ...extra });

describe('semantic statement diff', () => {
  it('matches by position, then content, then position again', () => {
    const before = [s('a', ['Read']), s('b', ['Read']), s('c', ['Read'])];
    const after = [s('a', ['Read']), s('c', ['Read']), s('b', ['Read', 'Update']), s('d', ['Read'])];
    const changes = diffStatements(before, after);
    expect(changes.map(c => [c.type, c.beforeIndex, c.afterIndex, c.moved])).toEqual([['changed', 1, 2, true], ['added', -1, 3, undefined]]);
    expect(changeSentence(changes[0], roles)).toBe('b may now also Update. Read is unchanged. It also moved from position 2 to 3.');
    expect(diffStatements(before, before)).toEqual([]);
    // A removal shifts later statements; they are not reported as moved.
    expect(diffStatements(before, [before[0], before[2]]).map(c => [c.type, c.beforeIndex])).toEqual([['removed', 1]]);
    expect(diffStatements(before, [before[2], before[0], before[1]]).map(c => [c.type, c.beforeIndex, c.afterIndex])).toEqual([['moved', 2, 0]]);
  });

  it('ignores key order but reports token-only changes honestly', () => {
    const a = s('a', ['Read']), reordered = { Resource: a.Resource, Action: a.Action, Subject: a.Subject, Effect: a.Effect };
    expect(diffStatements([a], [reordered])).toEqual([]);
    const [change] = diffStatements([a], [{ ...a, Action: ['READ'] }]);
    expect(change.parts).toEqual([{ field: 'action-tokens' }]);
  });

  it('writes changes as sentences with what stayed the same', () => {
    const [changed] = diffStatements([s('risk_owner', ['Read', 'Update'])], [s('risk_owner', ['Read', 'Update', 'Delete'])]);
    expect(changeSentence(changed, roles)).toBe('Risk owner may now also Delete. Read and Update are unchanged.');
    const [added] = diffStatements([], [s('reviewer', ['Read'])]);
    expect(changeSentence(added, roles)).toBe('Assessment reviewer may Read objects of type: CeRisk.');
    const [effect] = diffStatements([s('a', ['Read'])], [{ ...s('a', ['Read']), Effect: 'Deny' }]);
    expect(changeSentence(effect, roles)).toContain('The server ignores this statement. Deny grants nothing and blocks nothing.');
    const [subjects] = diffStatements([s('risk_owner', ['Read'])], [{ ...s('risk_owner', ['Read']), Subject: ['role:reviewer'] }]);
    expect(changeSentence(subjects, roles)).toBe('Now also applies to Assessment reviewer. No longer applies to Risk owner.');
  });

  it('reverts one change at a time', () => {
    const before = [s('a', ['Read']), s('b', ['Read']), s('c', ['Read'])];
    const after = [s('c', ['Read']), s('a', ['Read', 'Delete']), s('x', ['Read'])];
    let current = after;
    for (let guard = 0; guard < 5; guard++) {
      const [change] = diffStatements(before, current);
      if (!change) break;
      current = revertStatementChange(current, before, change);
    }
    expect(current).toEqual(before);
  });

  it('lists policy field changes before statement changes', () => {
    const before = { name: 'P', enabled: true, parent: '', content: { Version: '1.0', Statement: [s('a', ['Read'])] } };
    const after = { ...before, enabled: false, content: { Version: '1.1', Statement: [s('a', ['Read']), s('b', ['Read'])] } };
    expect(policyChanges(before, after, roles).map(e => e.kind + ':' + (e.field ?? e.change.type))).toEqual(['field:enabled', 'statement:added', 'field:content']);
  });
});
