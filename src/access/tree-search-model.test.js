import { expect, test } from 'vitest';
import { roleSearchResults } from './tree-search-model.js';

const model = {
  roles: [
    { rid: '9000000000000000001', id: 'regional_owner', name: 'Regional owner', parent: '' },
    { rid: '9000000000000000002', id: 'other', name: 'Other', parent: '9000000000000000001' },
  ],
  scope: [
    { rid: 'a', parent: '9000000000000000001', kind: 'RoleAssignment', source: 'CeRiskAssessment', field: 'riskOwner' },
    { rid: 'd', parent: 'a', kind: 'InwardsReferenceRoleDelegationRule', field: 'CeControlMeasure.relatedRisk' },
    { rid: 'e', parent: 'd', kind: 'HierarchicalDownwardsRoleDelegationRule', field: '' },
    { rid: 'unrelated', parent: '9000000000000000002', kind: 'RoleAssignment', source: 'CeProject', field: 'projectOwner' },
  ],
  globals: [{ rid: 'global', parent: '9000000000000000001', subjectName: 'Test person', subjectId: 'test_person' }],
};

test('definition searches find source classes and fields without searching memberships', () => {
  for (const query of ['CeRiskAssessment', 'riskOwner']) {
    const results = roleSearchResults(model, query);
    expect(results).toHaveLength(1);
    expect(results[0].role.rid).toBe('9000000000000000001');
    expect(results[0].roleMatch).toBe(false);
    expect([...results[0].matches]).toEqual(['a']);
  }
  expect(roleSearchResults(model, 'test_person')).toEqual([]);
});

test('delegation searches retain their assignment and delegation ancestor path', () => {
  const result = roleSearchResults(model, 'descendant objects', row =>
    row.kind === 'HierarchicalDownwardsRoleDelegationRule' ? 'Descendant objects' : '')[0];
  expect([...result.matches]).toEqual(['e']);
  expect([...result.definitions]).toEqual(['a', 'd', 'e']);
  expect(roleSearchResults(model, 'relatedRisk')[0].definitions).toEqual(new Set(['a', 'd']));
  expect(result.definitions.has('unrelated')).toBe(false);
});

test('role identity matches remain direct results and use exact-ID priority', () => {
  const result = roleSearchResults(model, 'regional_owner')[0];
  expect(result.roleMatch).toBe(true);
  expect(result.matches.size).toBe(0);
  expect(roleSearchResults(model, '9000000000000000002')[0].role.id).toBe('other');
});
