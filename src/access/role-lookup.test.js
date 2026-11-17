import { expect, it } from 'vitest';
import { roleStatements, rolePolicies, roleGrantGroups, grantTotals, roleAccess, statementOperations, roleAncestry, viaLabel } from './role-lookup.js';

const model = {
  roles: [
    { rid: '1', id: 'management', name: 'Risk management', parent: '' },
    { rid: '2', id: 'owner', name: 'Risk owner', parent: '1' },
    { rid: '3', id: 'other', name: 'Other', parent: '' },
  ],
  policies: [
    { rid: 'p1', name: 'Register', enabled: true, content: { Statement: [
      { Effect: 'Allow', Subject: ['role:management'], Action: ['Read'] },
      { Effect: 'Allow', Subject: ['role:owner'], Action: ['Update'] },
      { Effect: 'Deny', Subject: '*', Action: ['Delete'] },
      { Effect: 'Allow', Subject: ['role:other'], Action: ['Read'], Resource: { HasRole: { Reference: 'resource.parent', Roles: ['owner'] } } },
      { Effect: 'Allow', Subject: ['role:other'], Action: ['Read'] },
    ] } },
    { rid: 'p2', name: 'Broken', enabled: true, content: { Version: '1.0' } },
  ],
};

it('finds own, inherited, Everyone and condition statements, with where they come from', () => {
  const entries = roleStatements(model, '2');
  expect(entries.map(e => [e.index, e.via, e.from.name])).toEqual([
    [0, 'parent', 'Risk management'], [1, 'own', 'Risk owner'], [2, 'everyone', 'Everyone'], [3, 'condition', 'Risk owner'],
  ]);
  expect(entries.map(viaLabel)).toEqual(['via Risk management', 'names this role', 'via Everyone (*)', 'role checked in a condition']);
  expect(roleStatements(model, '1').map(e => e.index)).toEqual([0, 2]);
  expect(rolePolicies(model, '2')).toHaveLength(1);
  expect(roleStatements(model, 'missing')).toEqual([]);
});

it('stops on a parent cycle', () => {
  const roles = [{ rid: 'a', parent: 'b', id: 'a' }, { rid: 'b', parent: 'a', id: 'b' }];
  expect(roleAncestry(roles, 'a').map(r => r.rid)).toEqual(['a', 'b']);
});

it('groups grants by origin: directly, through each parent, through Everyone, then condition checks', () => {
  const groups = roleGrantGroups(model, '2');
  expect(groups.map(g => [g.title, g.statements, g.rows.map(r => r.index)])).toEqual([
    ['Naming this role', 1, [1]], ['Inherited from Risk management', 1, [0]], ['Granted to everyone (*)', 1, [2]], ['Checked in a condition', 1, [3]],
  ]);
  expect(groups.map(g => g.readOnly)).toEqual([false, true, true, false]);
  // A parent's page lists its own statement as direct, never the child's.
  expect(roleGrantGroups(model, '1').map(g => g.title)).toEqual(['Naming this role', 'Granted to everyone (*)']);
  expect(grantTotals(groups)).toEqual({ statements: 2, policies: 1, other: 2 });
  // Each group carries the header's count for its own rows, so the groups add up to the header.
  const sum = key => groups.reduce((n, g) => n + g.totals[key], 0);
  expect([sum('statements'), sum('other')]).toEqual([grantTotals(groups).statements, grantTotals(groups).other]);
  expect(groups.map(g => g.totals.statements)).toEqual(groups.map(g => g.rows.filter(r => r.counted).length));
});

it('rolls up a group as "any of" its counted rows; a stored Deny and a condition check never count', () => {
  const m = { roles: [{ rid: 'r', id: 'r', name: 'R', parent: '' }], policies: [{ rid: 'p', name: 'P', enabled: true, content: { Statement: [
    { Effect: 'Allow', Subject: ['role:r'], Action: ['Read'] },
    { Effect: 'Allow', Subject: ['role:r'], Action: ['Update', 'Read'] },
    { Effect: 'Deny', Subject: ['role:r'], Action: ['Create', 'Delete'] },
    { Effect: 'Allow', Subject: '*', Action: '*' },
    { Effect: 'Deny', Subject: '*', Action: ['Delete'] },
    { Effect: 'Allow', Subject: ['role:x'], Action: ['Delete'], Resource: { HasRole: { Reference: 'resource.parent', Roles: ['r'] } } },
  ] } }] };
  const [own, everyone, condition] = roleGrantGroups(m, 'r');
  expect(own.rollup).toEqual(['Read', 'Update']);
  expect(own.rows.map(r => r.counted)).toEqual([true, true, false]);
  expect(own.rows[2].ops).toEqual(['Create', 'Delete']);
  expect(everyone.rollup).toEqual(['Create', 'Read', 'Update', 'Delete']);
  expect(roleGrantGroups({ ...m, policies: [{ ...m.policies[0], content: { Statement: [m.policies[0].content.Statement[4]] } }] }, 'r')[0].rollup).toEqual([]);
  expect(condition.rollup).toEqual([]);
  expect(statementOperations({ Action: ['Delete', 'Create', 'Nope'] })).toEqual(['Create', 'Delete']);
});

it('counts nothing from a disabled or invalid policy, as the matrix does, and says why', () => {
  const grant = { Effect: 'Allow', Subject: ['role:r'], Action: ['Read'] };
  const m = { roles: [{ rid: 'r', id: 'r', name: 'R', parent: '' }], policies: [
    { rid: 'off', name: 'Off', enabled: false, content: { Statement: [grant] } },
    { rid: 'bad', name: 'Bad', enabled: true, valid: false, content: { Statement: [{ ...grant, Action: ['Update'] }] } },
    { rid: 'on', name: 'On', enabled: true, content: { Statement: [{ ...grant, Action: ['Delete'], Resource: { All: [{ Condition: { Left: 'resource.type', Comparison: '=', Right: 'CeRisk' } }] } }] } },
  ] };
  const [own] = roleGrantGroups(m, 'r');
  expect(own.rows.map(r => [r.policy.rid, r.block, r.counted])).toEqual([['off', 'Disabled', false], ['bad', 'Invalid', false], ['on', '', true]]);
  expect(own.rollup).toEqual(['Delete']);
  expect(grantTotals([own])).toEqual({ statements: 1, policies: 1, other: 2 });
  // Delete is granted only under a condition: on some objects, not on all.
  expect(roleAccess([own])).toEqual({ always: [], some: ['Delete'], none: ['Create', 'Read', 'Update'] });
  m.policies[2].content.Statement.push({ ...grant, Action: ['Delete', 'Read'] });
  expect(roleAccess(roleGrantGroups(m, 'r'))).toEqual({ always: ['Read', 'Delete'], some: [], none: ['Create', 'Update'] });
});

it('lists a grandparent role as its own group after the parent', () => {
  const m = { roles: [{ rid: 'g', id: 'g', name: 'Grand', parent: '' }, { rid: 'p', id: 'p', name: 'Parent', parent: 'g' }, { rid: 'c', id: 'c', name: 'Child', parent: 'p' }],
    policies: [{ rid: 'x', name: 'X', enabled: true, content: { Statement: [
      { Effect: 'Allow', Subject: ['role:g'], Action: ['Read'] }, { Effect: 'Allow', Subject: ['role:p'], Action: ['Update'] }] } }] };
  expect(roleGrantGroups(m, 'c').map(g => [g.title, g.rollup, g.readOnly])).toEqual([['Inherited from Parent', ['Update'], true], ['Inherited from Grand', ['Read'], true]]);
});