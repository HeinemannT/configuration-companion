import { expect, it } from 'vitest';
import { genericField, genericFields, propertyChoices } from './pbac-fields.js';

it('offers only native built-ins without a class and never invents a bare new object', () => {
  expect(genericFields('resource').map(f => f.expression)).toEqual([
    'resource.type', 'resource.id', 'resource.parent', 'resource.linkedTo', 'resource.createdBy', 'resource.model', 'resource',
  ]);
  expect(genericFields('new').map(f => f.expression)).toEqual([
    'new.type', 'new.id', 'new.parent', 'new.linkedTo', 'new.createdBy', 'new.model',
  ]);
  for (const expression of ['new', 'resource.name', 'resource.systemObject', 'resource.parent.name', 'user.type']) {
    expect(genericField(expression)).toBeUndefined();
  }
  expect(genericField('resource.createdBy').principal).toBe(true);
  expect(genericField('new.createdBy').principal).toBe(false);
});

it('keeps reference suggestions typed and merges real properties without duplicate generic fields', () => {
  expect(genericFields('resource', true).map(f => f.expression)).toEqual(['resource.parent', 'resource.linkedTo', 'resource.createdBy']);
  const rows = propertyChoices('resource', [
    { accessor: 'type', label: 'Native type' },
    { accessor: 'name', label: 'Name', system: true },
    { accessor: 'owners', label: 'Risk owners', reference: true },
  ], 'CeRiskAssessment');
  expect(rows.filter(r => r.rid === 'resource.type')).toHaveLength(1);
  expect(rows.find(r => r.rid === 'resource.name').group).toBe('System properties');
  expect(rows.find(r => r.rid === 'resource.owners')).toMatchObject({ icon: 'link', group: 'CeRiskAssessment properties' });
});
