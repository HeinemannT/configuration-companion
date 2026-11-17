import { expect, it } from 'vitest';
import { isEveryoneRole, mergeEveryoneGroups, ALL_USERS_GROUP } from './everyone-role';
import { roleGrantGroups } from './role-lookup.js';

it('recognises the built-in audience by name or ID at the top level only', () => {
  expect(isEveryoneRole({ id: 'roleEveryone', name: 'All staff' })).toBe(true);
  expect(isEveryoneRole({ id: 'everyone', name: 'Everyone' })).toBe(true);
  expect(isEveryoneRole({ id: 'x', name: 'Everyone', parent: '7' })).toBe(false);
  expect(isEveryoneRole({ id: 'risk_review', name: 'Risk review' })).toBe(false);
  expect(isEveryoneRole(null)).toBe(false);
});

const model = (roleId, name = 'Everyone') => ({
  roles: [{ rid: '1', id: roleId, name, parent: '' }],
  policies: [{ rid: 'p', id: 'p', name: 'P', enabled: true, content: { Statement: [
    { Effect: 'Allow', Subject: ['role:' + roleId], Action: ['Create'] },
    { Effect: 'Allow', Subject: '*', Action: ['Read'] },
    { Effect: 'Deny', Subject: '*', Action: ['Delete'] },
  ] } }],
});

it('merges the statements naming the Everyone role with the "*" statements into one editable group', () => {
  const groups = roleGrantGroups(model('roleEveryone'), '1');
  expect(groups.map(g => [g.title, g.origin, g.readOnly, g.rows.length])).toEqual([[ALL_USERS_GROUP, 'all-users', false, 3]]);
  expect(groups[0].rollup).toEqual(['Create', 'Read']);
  // The ignored Deny is listed but not counted.
  expect(groups[0].totals).toEqual({ statements: 2, policies: 1, other: 1 });
});

it('leaves other roles with their own groups', () => {
  expect(roleGrantGroups(model('risk_review', 'Risk review'), '1').map(g => g.title)).toEqual(['Naming this role', 'Granted to everyone (*)']);
  expect(mergeEveryoneGroups([])).toEqual([]);
});
