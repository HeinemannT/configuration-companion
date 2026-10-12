import { expect, test } from 'vitest';
import { referenceIdentity, selectedReferenceAccessor, chooseReference, editableReferenceValue, editReferenceText } from './reference-model.js';

const rid = '9223372036854775807';
const row = values => ({
  rid: '9000000000000000001', id: 'related_risk', name: 'Related risk', parent: '9000000000000000002',
  kind: 'OutwardsReferenceRoleDelegationRule', referenceConfig: rid, ...values
});

test('legacy qualified and split references resolve to the same class and accessor without changing storage', () => {
  const legacy = Object.freeze(row({ field: 'CeControlMeasure.relatedRisk' })),
    split = Object.freeze(row({ source: 'CeControlMeasure', field: 'relatedRisk' }));
  for (const record of [legacy, split]) {
    expect(referenceIdentity(record)).toMatchObject({ source: 'CeControlMeasure', accessor: 'relatedRisk', status: 'resolved',
      referenceConfig: rid, rawSource: record.source, rawField: record.field });
    expect(selectedReferenceAccessor(record, 'CeControlMeasure')).toBe('relatedRisk');
    expect(selectedReferenceAccessor(record, 'CeRiskAssessment')).toBe('');
  }
  expect(legacy.field).toBe('CeControlMeasure.relatedRisk');
  expect(legacy).not.toHaveProperty('source');
  expect(split.field).toBe('relatedRisk');
});

test('matching explicit and qualified classes are allowed but conflicting classes never preselect', () => {
  expect(referenceIdentity(row({ source: 'CeControlMeasure', field: 'CeControlMeasure.relatedRisk' }))).toMatchObject({
    source: 'CeControlMeasure', accessor: 'relatedRisk', status: 'resolved'
  });
  const conflict = row({ source: 'CeRiskAssessment', field: 'CeControlMeasure.relatedRisk' });
  expect(referenceIdentity(conflict)).toMatchObject({ source: '', accessor: '', status: 'conflict',
    rawSource: 'CeRiskAssessment', rawField: 'CeControlMeasure.relatedRisk', referenceConfig: rid });
  expect(selectedReferenceAccessor(conflict, 'CeControlMeasure')).toBe('');
  expect(selectedReferenceAccessor(conflict, 'CeRiskAssessment')).toBe('');
});

test('class matching is exact, including case, and does not guess from a plain accessor or RID', () => {
  const record = row({ source: 'CeControlMeasure', field: 'relatedRisk' });
  expect(selectedReferenceAccessor(record, 'ceControlMeasure')).toBe('');
  expect(selectedReferenceAccessor(record, ' CeControlMeasure')).toBe('');
  expect(referenceIdentity(row({ field: 'relatedRisk' }))).toMatchObject({ source: '', accessor: 'relatedRisk', status: 'unresolved' });
  expect(selectedReferenceAccessor(row({ field: 'relatedRisk' }), 'CeControlMeasure')).toBe('');
  expect(referenceIdentity(row({ source: '', field: '' }))).toMatchObject({ source: '', accessor: '', status: 'unresolved', referenceConfig: rid });
  expect(referenceIdentity(row({ field: rid }))).toMatchObject({ accessor: '', rawField: rid, referenceConfig: rid });
});

test('unknown raw values survive reads and class browsing without repair or namespace guessing', () => {
  for (const field of ['namespace.CeControlMeasure.relatedRisk', 'CeControlMeasure.', '.relatedRisk', ' CeControlMeasure.relatedRisk ',
    'related risk', 'relatedRisk[0]']) {
    const record = Object.freeze(row({ field }));
    expect(referenceIdentity(record)).toMatchObject({ rawField: field, status: 'unresolved', referenceConfig: rid });
    expect(selectedReferenceAccessor(record, 'CeControlMeasure')).toBe('');
    expect(record.field).toBe(field);
  }
  const unknownSource = row({ source: 'namespace.CeControlMeasure', field: 'CeControlMeasure.relatedRisk' });
  expect(referenceIdentity(unknownSource)).toMatchObject({ source: '', accessor: '', status: 'unresolved', rawSource: unknownSource.source });
  expect(referenceIdentity(row({ source: 'CeControlMeasure', field: 'unknown->reference' }))).toMatchObject({
    source: 'CeControlMeasure', accessor: '', rawField: 'unknown->reference', status: 'unresolved'
  });
});

test('an incomplete explicit class can open its properties but has no selected accessor', () => {
  expect(referenceIdentity({ source: 'CeControlMeasure', field: '' })).toMatchObject({
    source: 'CeControlMeasure', accessor: '', status: 'incomplete'
  });
  expect(referenceIdentity({})).toMatchObject({ source: '', accessor: '', status: 'empty' });
  expect(selectedReferenceAccessor({ source: 'CeControlMeasure', field: '' }, 'CeControlMeasure')).toBe('');
});

test('only explicit selection creates canonical class/accessor fields and clears the retained MethodConfig RID', () => {
  const original = Object.freeze(row({ field: 'CeControlMeasure.relatedRisk', extra: 'keep' }));
  const chosen = chooseReference(original, 'CeRiskAssessment', 'relatedRisk');
  expect(chosen).toEqual({ ...original, source: 'CeRiskAssessment', field: 'relatedRisk', referenceConfig: '' });
  expect(chosen.rid).toBe(original.rid);
  expect(chosen.parent).toBe(original.parent);
  expect(chosen.extra).toBe('keep');
  expect(original.referenceConfig).toBe(rid);
  expect(original.field).toBe('CeControlMeasure.relatedRisk');
  expect(chooseReference(row({ source: 'CeRiskAssessment', field: 'relatedRisk' }), 'CeRiskAssessment', 'relatedRisk').referenceConfig).toBe('');
});

test('explicit choice can replace an unknown raw value but invalid picker values cannot alter it', () => {
  const original = Object.freeze(row({ source: 'unknown namespace', field: 'unknown->reference' }));
  expect(chooseReference(original, 'CeControlMeasure', 'relatedRisk')).toMatchObject({
    source: 'CeControlMeasure', field: 'relatedRisk', referenceConfig: ''
  });
  for (const [source, field] of [['', 'relatedRisk'], [' CeControlMeasure ', 'relatedRisk'], ['CeControlMeasure', ''],
    ['CeControlMeasure', 'CeControlMeasure.relatedRisk'], ['CeControlMeasure', 'related risk']]) {
    expect(() => chooseReference(original, source, field)).toThrow('Choose');
  }
  expect(original).toMatchObject({ source: 'unknown namespace', field: 'unknown->reference', referenceConfig: rid });
});

test('hierarchy delegations do not interpret stale reference metadata as an active property', () => {
  const record = Object.freeze(row({ kind: 'HierarchicalDownwardsRoleDelegationRule', source: 'CeControlMeasure', field: 'relatedRisk' }));
  expect(referenceIdentity(record)).toMatchObject({ source: '', accessor: '', status: 'hierarchical', rawField: 'relatedRisk', referenceConfig: rid });
  expect(selectedReferenceAccessor(record, 'CeControlMeasure')).toBe('');
  expect(() => chooseReference(record, 'CeControlMeasure', 'relatedRisk')).toThrow('Hierarchy');
  expect(record.referenceConfig).toBe(rid);
});

test('editable text qualifies unambiguous references and displays unknown or conflicting fields verbatim', () => {
  expect(editableReferenceValue(row({ source: 'CeControlMeasure', field: 'relatedRisk' }))).toBe('CeControlMeasure.relatedRisk');
  expect(editableReferenceValue(row({ field: 'CeControlMeasure.relatedRisk' }))).toBe('CeControlMeasure.relatedRisk');
  expect(editableReferenceValue(row({ source: 'CeRiskAssessment', field: 'CeControlMeasure.relatedRisk' }))).toBe('CeControlMeasure.relatedRisk');
  expect(editableReferenceValue(row({ source: 'CeControlMeasure', field: ' unknown -> reference ' }))).toBe(' unknown -> reference ');
  expect(editableReferenceValue(row({ field: 'relatedRisk' }))).toBe('relatedRisk');
  expect(editableReferenceValue(row({ source: 'CeControlMeasure' }))).toBe('');
  expect(editableReferenceValue({})).toBe('');
});

test('typing an exact qualified reference explicitly replaces its class and clears stale configuration identity', () => {
  const original = Object.freeze(row({ source: 'CeRiskAssessment', field: 'unknown->reference', extra: 'keep' }));
  const edited = editReferenceText(original, 'CeControlMeasure.relatedRisk');
  expect(edited).toEqual({ ...original, source: 'CeControlMeasure', field: 'relatedRisk', referenceConfig: '' });
  expect(edited.rid).toBe(original.rid);
  expect(edited.parent).toBe(original.parent);
  expect(original.referenceConfig).toBe(rid);
  expect(original.field).toBe('unknown->reference');
  expect(editReferenceText(edited, 'CeControlMeasure.relatedRisk')).toEqual(edited);
});

test('typing a bare accessor retains an explicit source and can recover an unambiguous legacy source', () => {
  for (const original of [row({ source: 'CeControlMeasure', field: 'relatedRisk' }),
    row({ field: 'CeControlMeasure.relatedRisk' }), row({ source: '', field: 'CeControlMeasure.relatedRisk' })]) {
    const edited = editReferenceText(Object.freeze(original), 'responsibleControl');
    expect(edited).toMatchObject({ source: 'CeControlMeasure', field: 'responsibleControl', referenceConfig: '' });
    expect(editReferenceText(edited, 'responsibleControl')).toEqual(edited);
  }
  expect(editReferenceText(row({ field: 'unknown' }), 'responsibleControl')).not.toHaveProperty('source');
  expect(editReferenceText(row({ source: '', field: '' }), 'responsibleControl').source).toBe('');
});

test('text edits preserve unknown or conflicting stored sources unless the user explicitly types a qualified reference', () => {
  const conflict = row({ source: 'CeRiskAssessment', field: 'CeControlMeasure.relatedRisk' });
  expect(editReferenceText(conflict, 'owner')).toMatchObject({ source: 'CeRiskAssessment', field: 'owner', referenceConfig: '' });
  const unknown = row({ source: 'unknown namespace', field: 'CeControlMeasure.relatedRisk' });
  expect(editReferenceText(unknown, 'owner')).toMatchObject({ source: 'unknown namespace', field: 'owner', referenceConfig: '' });
  expect(editReferenceText(unknown, 'Organisation.owner')).toMatchObject({ source: 'Organisation', field: 'owner', referenceConfig: '' });
});

test('incomplete text, whitespace and unknown expressions remain verbatim while retaining the prior class', () => {
  const original = Object.freeze(row({ field: 'CeControlMeasure.relatedRisk' }));
  for (const text of ['', ' ', 'CeRiskAssessment.', '.owner', ' unknown -> reference ', 'namespace.Class.owner',
    ' CeRiskAssessment.owner ', 'CeRiskAssessment.owner\n', 'owner\r\n', 'owner\t', 'owner[0]', rid]) {
    const edited = editReferenceText(original, text);
    expect(edited).toMatchObject({ source: 'CeControlMeasure', field: text, referenceConfig: '', rid: original.rid, parent: original.parent });
    expect(editReferenceText(edited, text)).toEqual(edited);
    expect(editableReferenceValue(edited)).toBe(text);
  }
  expect(original.referenceConfig).toBe(rid);
  expect(original.field).toBe('CeControlMeasure.relatedRisk');
});

test('terminal line breaks cannot be interpreted as an exact class or accessor', () => {
  expect(referenceIdentity(row({ source: 'CeControlMeasure\n', field: 'relatedRisk' })).status).toBe('unresolved');
  expect(referenceIdentity(row({ field: 'CeControlMeasure.relatedRisk\n' })).status).toBe('unresolved');
  expect(referenceIdentity(row({ source: 'CeControlMeasure', field: 'relatedRisk\n' })).status).toBe('unresolved');
  expect(() => chooseReference(row({}), 'CeControlMeasure', 'relatedRisk\n')).toThrow('Choose');
});

test('hierarchy and invalid text edits fail without mutating the stored record', () => {
  const hierarchy = Object.freeze(row({ kind: 'HierarchicalUpwardsRoleDelegationRule', field: 'legacy' }));
  expect(editableReferenceValue(hierarchy)).toBe('legacy');
  expect(() => editReferenceText(hierarchy, 'CeControlMeasure.relatedRisk')).toThrow('Hierarchy');
  expect(hierarchy.referenceConfig).toBe(rid);
  const original = Object.freeze(row({ source: 'CeControlMeasure', field: 'relatedRisk' }));
  expect(() => editReferenceText(original, 123)).toThrow('Enter reference text');
  expect(original.field).toBe('relatedRisk');
  expect(original.referenceConfig).toBe(rid);
});
