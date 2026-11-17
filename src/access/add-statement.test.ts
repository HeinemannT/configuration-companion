import { expect, it } from 'vitest';
import { policyChoices, withRoleStatement, namesRole, NEW_POLICY } from './add-statement';

const role = { id: 'risk_review', name: 'Risk review' };
const policy = (rid: string, name: string, subject: unknown) => ({ rid, id: name.toLowerCase().replace(/ /g, '_'), name, parent: 'f1', content: { Version: '1.0', Statement: [{ Effect: 'Allow', Subject: subject, Action: ['Read'] }] } });

it('lists policies naming the role first, then all others, then New policy', () => {
  const policies = [policy('3', 'Zeta', ['role:risk_review']), policy('1', 'Alpha', '*'), policy('2', 'Beta', ['role:other']), policy('4', 'Gamma', ['role:other', 'role:risk_review'])];
  const rows = policyChoices(policies, role, p => p.parent === 'f1' ? 'Shared' : '');
  expect(rows.map(r => [r.group, r.label])).toEqual([
    ['Naming this role', 'Gamma'], ['Naming this role', 'Zeta'], ['All policies', 'Alpha'], ['All policies', 'Beta'], ['New', 'New policy…']]);
  expect(rows[0].secondary).toBe('gamma · Shared');
  expect(rows.at(-1)!.rid).toBe(NEW_POLICY);
  expect(namesRole(policies[1], 'risk_review')).toBe(false);
});

it('appends a statement whose Who is the role, keeping the other statements and keys', () => {
  const content = { Version: '1.0', Note: 'kept', Statement: [{ Effect: 'Allow', Subject: '*' }] };
  const { content: next, index } = withRoleStatement(content, 'risk_review');
  expect(index).toBe(1);
  expect(next).toEqual({ Version: '1.0', Note: 'kept', Statement: [content.Statement[0], { Subject: ['role:risk_review'], Effect: 'Allow', Action: [], Resource: { All: [] } }] });
  expect(content.Statement).toHaveLength(1);
  expect(withRoleStatement({ Version: '1.0' }, 'r').index).toBe(0);
});

it('sorts every group by the name as shown, ignoring leading spaces and case, with numbers in order', () => {
  const policies = [policy('1', ' Forms and Surveys Management', '*'), policy('2', ' Legacy Forms Management', '*'), policy('3', 'Action buttons', '*'),
    policy('4', 'access 10', '*'), policy('5', 'Access 9', '*'), policy('6', 'Zeta', '*')];
  expect(policyChoices(policies, role).filter(r => r.group === 'All policies').map(r => r.label)).toEqual([
    'Access 9', 'access 10', 'Action buttons', 'Forms and Surveys Management', 'Legacy Forms Management', 'Zeta']);
});
