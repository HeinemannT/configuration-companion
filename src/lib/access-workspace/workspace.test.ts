import { describe, expect, it } from 'vitest';
import { emptyModel, type AccessSnapshot } from './model';
import { assertNoConflicts, buildApplyCode, buildApplyPlan, validateModel } from './write';
import { mergeDraft, verifyApplied } from './service';
import { normalizeProposed } from './trace';
import { frame, rawPolicyText } from './read';

function fixture(): AccessSnapshot {
  const model = emptyModel();
  model.roles.push({ rid: '9000000000000000001', id: 'reader', name: 'Reader', parent: '' });
  model.roles.push({ rid: '9000000000000000002', id: 'other', name: 'Other', parent: '' });
  return { model, environment: 'profile@https://example.test/', name: 'Test', loadedAt: '', roots: { roles: '100', policies: '200' }, users: [{ rid: '300', id: 'user', name: 'User', type: 'User' }], groups: [], classes: { Organisation: [{ rid: '400', accessor: 'owners', label: 'Owners', configClass: 'ReferenceMethodConfig', system: false, targets: '[User, Group]' }] } };
}
describe('access apply boundary', () => {
  it('sends field patches for large policies and skips changes for move-only edits', () => {
    const snapshot = fixture();
    snapshot.model.policies.push({ rid: '600', id: 'policy', name: 'Policy', parent: '', enabled: true, content: { Statement: [], Comment: 'x'.repeat(65536) } });
    snapshot.model.folders.push({ rid: '601', id: 'folder', name: 'Folder', parent: '' });
    const draft = structuredClone(snapshot.model); draft.policies[0].name = 'Renamed';
    const rename = buildApplyPlan(snapshot.model, draft, snapshot);
    expect(rename.code).toContain('change(name := "Renamed")'); expect(rename.code).not.toContain('contentAsString');
    expect(rename.code.length).toBeLessThan(2000);
    draft.policies[0].name = 'Policy'; draft.policies[0].parent = '601';
    const move = buildApplyPlan(snapshot.model, draft, snapshot);
    expect(move.code).toContain('.move(lookup(601))'); expect(move.code).not.toContain('.change(');
  });
  it('guards JSON edits against the exact saved text and gates mutations after all preconditions', () => {
    const snapshot = fixture();
    const policy = { rid: '600', id: 'policy', name: 'Policy', parent: '', enabled: true, content: { Statement: [] } };
    snapshot.model.policies.push(policy); rawPolicyText.set(policy, '{\n"Statement": []\n}');
    const draft = structuredClone(snapshot.model); draft.policies[0].content = { Statement: [], Comment: 'new' };
    const plan = buildApplyPlan(snapshot.model, draft, snapshot);
    expect(plan.code).toContain('_accessValid := false');
    expect(plan.code).toContain('LIST("{\\n\\"Statement\\": []\\n}") CONTAINS _policyText');
    expect(plan.code.indexOf('IF _accessValid THEN')).toBeLessThan(plan.code.indexOf('.change('));
    expect(plan.receipts.preview).not.toBe(plan.receipts.apply);
  });
  it('previews existing policy JSON on a disposable RID without changing its live configuration blob', () => {
    const snapshot = fixture();
    const policy = { rid: '600', id: 'policy', name: 'Policy', parent: '', enabled: true, content: { Statement: [] } };
    snapshot.model.policies.push(policy); rawPolicyText.set(policy, '{"Statement":[]}');
    const draft = structuredClone(snapshot.model);
    draft.roles[0].id = 'renamed';
    draft.policies[0].content = { Statement: [{ Subject: 'role:renamed', Effect: 'Allow', Action: 'Read', Resource: '*' }] };
    const plan = buildApplyPlan(snapshot.model, draft, snapshot);
    expect(plan.preview).not.toContain('lookup(600).change(');
    expect(plan.preview).toContain('_accessPolicyPreview0 := lookup(200).add(AccessPolicy, id := "companion_preview_');
    expect(plan.preview).toContain('enabled := false, contentAsString :=');
    expect(plan.preview).toContain('IF _accessPolicyPreview0.valid = false');
    expect(plan.preview).toContain('_policyText := output(lookup(600).contentAsString)');
    expect(plan.preview.indexOf('change(id := "renamed")')).toBeLessThan(plan.preview.indexOf('_accessPolicyPreview0 :='));
    expect(plan.code).toContain('lookup(600).change(contentAsString :=');
    expect(plan.code).toContain('IF lookup(600).valid = false');
    expect(plan.code).not.toContain('companion_preview_');
  });
  it('preserves unrelated server edits and refuses changes to the same record', () => {
    const { model: before } = fixture(), draft = structuredClone(before), live = structuredClone(before);
    draft.roles[0].name = 'Changed'; live.roles[1].name = 'External';
    expect(() => assertNoConflicts(before, draft, live)).not.toThrow();
    expect(mergeDraft(before, draft, live).roles.find(r => r.id === 'other')?.name).toBe('External');
    live.roles[0].name = 'Other change';
    expect(() => assertNoConflicts(before, draft, live)).toThrow('changed in BMP');
  });
  it('rejects cycles, missing parents and unknown delegation types', () => {
    const { model } = fixture(); model.roles[0].parent = model.roles[0].rid;
    expect(() => validateModel(model)).toThrow('cycle'); model.roles[0].parent = '500';
    expect(() => validateModel(model)).toThrow('another role'); model.roles[0].parent = '';
    model.scope.push({ rid: '501', id: 'unknown', name: '', parent: model.roles[0].rid, kind: 'User' });
    expect(() => validateModel(model)).toThrow('Assignments');
  });
  it('creates parents before children and escapes names without losing long RIDs', () => {
    const snapshot = fixture(), draft = structuredClone(snapshot.model);
    draft.roles.push({ rid: 'draft:child', id: 'child', name: 'Child', parent: 'draft:parent' }, { rid: 'draft:parent', id: 'parent', name: 'Name "quoted"\nline', parent: snapshot.model.roles[0].rid });
    const code = buildApplyCode(snapshot.model, draft, snapshot);
    expect(code).toContain('lookup(9000000000000000001).add(Role');
    expect(code).toContain('name := "Name \\"quoted\\"\\nline"');
    expect(code).toContain('_access0.add(Role, id := "child"');
  });
  it('rejects malformed IDs and a property outside the live schema', () => {
    const snapshot = fixture(), draft = structuredClone(snapshot.model);
    draft.roles[0].id = 'reader").delete()';
    expect(() => buildApplyCode(snapshot.model, draft, snapshot)).toThrow('business id');
    draft.roles[0].id = 'reader';
    draft.scope.push({ rid: 'draft:a', id: 'assignment', name: 'Assignment', parent: draft.roles[0].rid, kind: 'RoleAssignment', source: 'Organisation', field: 'missing' });
    expect(() => buildApplyCode(snapshot.model, draft, snapshot)).toThrow('Unknown reference');
    draft.scope[0].field = 'owners';
    expect(buildApplyCode(snapshot.model, draft, snapshot)).toContain('referenceConfig := lookup(400)');
  });
  it('preserves existing global memberships when adding one role', () => {
    const snapshot = fixture(); snapshot.model.globals.push({ rid: 'global:300:9000000000000000002', id: '', name: '', parent: snapshot.model.roles[1].rid, subject: '300', mode: 'User' });
    const draft = structuredClone(snapshot.model);
    draft.globals.push({ rid: 'draft:g', id: '', name: '', parent: snapshot.model.roles[0].rid, subject: '300', mode: 'User' });
    expect(buildApplyCode(snapshot.model, draft, snapshot)).toContain('roles := LIST(lookup(9000000000000000002), lookup(9000000000000000001))');
  });
  it('blocks deleting a role that gained a child or remains referenced by a policy', () => {
    const snapshot = fixture(), draft = structuredClone(snapshot.model), live = structuredClone(snapshot.model);
    draft.roles.shift(); live.roles.push({ rid: '3', id: 'child', name: 'Child', parent: snapshot.model.roles[0].rid });
    expect(() => assertNoConflicts(snapshot.model, draft, live)).toThrow('new children');
    draft.policies.push({ rid: 'draft:p', id: 'p', name: 'P', parent: '', enabled: false, content: { Statement: [{ Subject: 'role:reader' }] } });
    expect(() => buildApplyCode(snapshot.model, draft, snapshot)).toThrow('still reference');
  });
  it('verifies generated RIDs and refuses a partial readback', () => {
    const snapshot = fixture(), draft = structuredClone(snapshot.model), saved = structuredClone(snapshot.model);
    draft.roles.push({ rid: 'draft:new', id: 'new', name: 'New', parent: '' });
    expect(() => verifyApplied(snapshot.model, draft, saved)).toThrow('did not save');
    saved.roles.push({ ...draft.roles.at(-1)!, rid: '9000000000000000003' });
    expect(verifyApplied(snapshot.model, draft, saved)['draft:new']).toBe('9000000000000000003');
  });
  it('does not let an existing unresolved assignment block an unrelated role edit', () => {
    const snapshot = fixture();
    snapshot.model.scope.push({ rid: '500', id: 'legacy', name: 'Assignment', parent: snapshot.model.roles[0].rid, kind: 'RoleAssignment', source: '', field: '' });
    const draft = structuredClone(snapshot.model); draft.roles[1].name = 'Other renamed';
    expect(() => buildApplyCode(snapshot.model, draft, snapshot)).not.toThrow();
    draft.scope[0].name = 'Edited assignment';
    expect(() => buildApplyCode(snapshot.model, draft, snapshot)).toThrow('reference');
  });
  it('separates native moves from deletion and verifies retained delegation children', () => {
    const snapshot = fixture(), parent = snapshot.model.roles[0].rid;
    snapshot.model.scope.push(
      { rid: '500', id: 'assignment', name: 'A', parent, kind: 'RoleAssignment', source: 'Organisation', field: 'owners' },
      { rid: '501', id: 'down', name: 'Down', parent: '500', kind: 'HierarchicalDownwardsRoleDelegationRule', source: '', field: '' },
      { rid: '502', id: 'child', name: 'Child', parent: '501', kind: 'HierarchicalDownwardsRoleDelegationRule', source: '', field: '' },
    );
    const draft = structuredClone(snapshot.model); draft.scope[1].kind = 'HierarchicalUpwardsRoleDelegationRule';
    const plan = buildApplyPlan(snapshot.model, draft, snapshot);
    expect(plan.code).toContain('lookup(502).move(_access0)');
    expect(plan.code).not.toContain('.delete()');
    expect(plan.finish).toContain('lookup(501).delete()');
    const saved = structuredClone(draft); saved.scope[1].rid = '503'; saved.scope[2].parent = '503';
    expect(verifyApplied(snapshot.model, draft, saved)['502']).toBe('502');
    saved.scope.pop();
    expect(() => verifyApplied(snapshot.model, draft, saved)).toThrow('different values');
  });
  it('clears a principal’s last global role using an empty native list', () => {
    const snapshot = fixture(); snapshot.model.globals.push({ rid: 'global:300:9000000000000000001', id: '', name: '', parent: snapshot.model.roles[0].rid, subject: '300', mode: 'User' });
    const draft = structuredClone(snapshot.model); draft.globals = [];
    expect(buildApplyCode(snapshot.model, draft, snapshot)).toContain('lookup(300).change(roles := LIST())');
  });
  it('does not generate an empty conditional for a deletion-only staging command', () => {
    const snapshot = fixture(), draft = structuredClone(snapshot.model); draft.roles.pop();
    const plan = buildApplyPlan(snapshot.model, draft, snapshot);
    expect(plan.code).not.toMatch(/THEN\s*ENDIF/);
    expect(plan.code).not.toContain('.delete()');
    expect(plan.finish).toContain('IF _accessValid THEN\n lookup(9000000000000000002).delete()');
    expect(plan.finish).toContain('CONTAINS str(lookup(9000000000000000002).parent.rid)');
  });
});
describe('proposed values', () => {
  const fields = [{ id: 'Nameable.name', businessId: 'name', reference: false, multiselect: false }, { id: 'owners.native', businessId: 'owners', reference: true, multiselect: true }];
  it('maps business IDs to native fields and normalizes reference cardinality', () => {
    expect(normalizeProposed({ type: 'Organisation', properties: { name: 'New' }, references: { owners: '9000000000000000001' } }, fields)).toEqual({ type: 'Organisation', properties: { 'Nameable.name': 'New' }, references: { 'owners.native': ['9000000000000000001'] } });
  });
  it('rejects unknown fields, wrong categories and numeric RIDs', () => {
    expect(() => normalizeProposed({ type: 'Organisation', properties: { missing: 1 } }, fields)).toThrow('Unknown');
    expect(() => normalizeProposed({ type: 'Organisation', properties: { owners: '1' } }, fields)).toThrow('references');
    expect(() => normalizeProposed({ type: 'Organisation', references: { owners: 9 as unknown as string } }, fields)).toThrow('RID strings');
  });
});
it('framing preserves multiline JSON, quotes, pipes and long RIDs', () => {
  const f = frame(), values = ['policy', '9000000000000000001', '{\n"name":"a|b"\n}'];
  const encoded = f.delimiter + 'ROW' + f.delimiter + values.join(f.delimiter) + f.delimiter + 'END' + f.delimiter;
  expect(f.parse(encoded)).toEqual([values]);
});
