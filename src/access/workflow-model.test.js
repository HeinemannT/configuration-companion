import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { unfinishedIdEdits, pendingRecordCount, changedRoleOwners, testsAfterApply, selectedTestContext, matchingSavedStatement, withoutTestResults } from './workflow-model.js';

const base = () => ({
  roles: [{ rid: '9000000000000000001', id: 'owner', name: 'Owner' }, { rid: 'other', id: 'other', name: 'Other' }],
  policies: [{ rid: 'policy', id: 'policy', content: { Statement: [{ Subject: 'role:owner' }] } }],
  scope: [{ rid: 'assignment', parent: '9000000000000000001' }, { rid: 'delegation', parent: 'assignment' }],
  globals: [{ rid: 'membership', parent: '9000000000000000001' }], folders: []
});

test('unfinished IDs ignore unchanged and removed records, but include empty edits', () => {
  const model = base(), drafts = new Map([[model.roles[0].rid, ''], ['other', 'other'], ['deleted', 'new_id']]);
  assert.deepEqual(unfinishedIdEdits(model, drafts).map(edit => [edit.kind, edit.record.rid, edit.value]),
    [['role', '9000000000000000001', '']]);
});

test('review counts each record once across model, JSON and unfinished ID edits', () => {
  const model = base(), edits = unfinishedIdEdits(model, new Map([['policy', 'new_policy']]));
  assert.equal(pendingRecordCount([{ r: model.policies[0] }, { r: model.scope[0] }], model.policies, edits), 2);
});

test('role markers cover edited descendants, removed memberships and both owners of a move', () => {
  const before = base(), model = structuredClone(before);
  model.scope[0].parent = 'other';
  model.globals = [];
  const owners = changedRoleOwners(model, before, [
    { key: 'scope', r: model.scope[1] }, { key: 'globals', r: before.globals[0] }
  ]);
  assert.deepEqual([...owners].sort(), ['9000000000000000001', 'other']);
  assert.equal(owners.has('assignment'), false);
});

test('apply remaps draft role and policy test keys while retaining request inputs and open docks', () => {
  const model = base(), roleRid = model.roles[0].rid;
  const input = { mode: 'role', subject: 'draft:123', action: 'Update', resource: '9000000000000000002',
    rename: 'New name', updateMode: 'custom', proposed: '{"type":"Organisation"}',
    proposedDrafts: { Create: '{"type":"Organisation","properties":{"name":"New"}}' },
    result: { running: true, trace: { allowed: true } } };
  const tests = new Map([['role:draft:123:0', input], ['policy:draft:456:0', input]]);
  const next = testsAfterApply(tests, new Set(tests.keys()), model, { 'draft:123': roleRid, 'draft:456': 'policy' });
  assert.deepEqual([...next.testOpen], [`role:${roleRid}:0`, 'policy:policy:0']);
  expect(next.tests.get(`role:${roleRid}:0`)).toEqual({ ...input, subject: roleRid, result: null, rerunRequired: true });
  assert.equal(input.result.running, true, 'Existing async runs retain a different test object');
  assert.notEqual(next.tests.get(`role:${roleRid}:0`).proposedDrafts, input.proposedDrafts);
});

test('apply preserves user identities, discards removed owner tests, and clears removed role subjects', () => {
  const model = base(), user = { mode: 'user', subject: '9000000000000000002', userId: 'someone', action: 'Read', resource: '55' };
  const next = testsAfterApply(new Map([
    ['policy:policy:0', user], ['role:deleted:0', user], ['policy:policy:8', user],
    ['role:other:0', { mode: 'role', subject: 'deleted' }]
  ]), new Set(), model);
  assert.equal(next.tests.size, 2);
  assert.equal(next.tests.get('policy:policy:0').subject, user.subject);
  assert.equal(next.tests.get('policy:policy:0').userId, user.userId);
  assert.equal(next.tests.get('role:other:0').subject, '');
});

test('apply keeps selected objects and remotely found users while preferring refreshed user identities', () => {
  const old = { id: 'known', rid: '10', name: 'Previous name' }, fresh = { ...old, rid: '11', name: 'Current name' },
    remote = { id: 'remote', rid: '9000000000000000002', name: 'Remote user' },
    context = { objects: [{ rid: 'object', name: 'Object' }, { rid: 'unused' }], prototypes: [{ rid: 'prototype' }] };
  const selected = selectedTestContext([
    { mode: 'user', userId: 'known', resource: 'object' }, { mode: 'user', userId: 'remote', resource: 'prototype' }
  ], context, [old, remote, { id: 'unused', rid: '99' }], [fresh]);
  assert.deepEqual(selected, { objects: [context.objects[0]], prototypes: context.prototypes, users: [fresh, remote] });
  assert.deepEqual(selectedTestContext([], context, [old, remote], [fresh]), { objects: [], prototypes: [], users: [] });
});

test('saved rule attribution requires an unchanged statement at the same position', () => {
  const saved = { content: { Statement: [{ Effect: 'Allow', Action: ['Read'] }, { Effect: 'Deny', Action: ['Update'] }] } };
  const draft = structuredClone(saved);
  draft.name = 'Renamed policy';
  expect(matchingSavedStatement(draft, saved, 0)).toBe(saved.content.Statement[0]);
  draft.content.Statement.reverse();
  expect(matchingSavedStatement(draft, saved, 0)).toBeNull();
  expect(matchingSavedStatement(draft, saved, 1)).toBeNull();
  draft.content.Statement.reverse();
  draft.content.Statement[0].Action = ['Create'];
  expect(matchingSavedStatement(draft, saved, 0)).toBeNull();
  expect(matchingSavedStatement(draft, saved, 1)).toBe(saved.content.Statement[1]);
  for (const index of [-1, 0.5, 2, '0']) expect(matchingSavedStatement(draft, saved, index)).toBeNull();
  expect(matchingSavedStatement(draft, undefined, 0)).toBeNull();
  expect(matchingSavedStatement(undefined, saved, 0)).toBeNull();
});

test('invalidation detaches all results while preserving incomplete inputs and inactive scenarios', () => {
  const request = { action: 'Update', resource: '9000000000000000002', proposed: '{unfinished', result: { running: true },
    scenarios: { Create: { proposed: '{"type":"CeComment","properties":{"count":0}}', createNumberDrafts: { count: '1e' },
      createLabels: { '9000000000000000003': 'Destination' }, createFields: ['count'], createInitialized: true,
      result: { trace: { result: false } }, rerunRequired: true } } };
  const next = withoutTestResults(request);
  expect(next).toEqual({ ...request, result: null, rerunRequired: false,
    scenarios: { Create: { ...request.scenarios.Create, result: null, rerunRequired: false } } });
  next.scenarios.Create.createNumberDrafts.count = '2';
  expect(request.scenarios.Create.createNumberDrafts.count).toBe('1e');
  expect(request.result.running).toBe(true);
  expect(request.scenarios.Create.result.trace.result).toBe(false);
});

test('apply retains object-scoped tests and clears results in every action scenario', () => {
  const key = 'object:9000000000000000002';
  const request = { mode: 'role', subject: 'draft:123', action: 'Read', resource: '9000000000000000002', result: { running: true },
    scenarios: { Update: { proposed: '{invalid', updateMode: 'custom', result: { trace: { result: true } } } } };
  const next = testsAfterApply(new Map([[key, request]]), new Set([key]), base(), { 'draft:123': base().roles[0].rid });
  expect(next.testOpen.has(key)).toBe(true);
  expect(next.tests.get(key)).toEqual({ ...request, subject: base().roles[0].rid, result: null, rerunRequired: true,
    scenarios: { Update: { ...request.scenarios.Update, result: null, rerunRequired: true } } });
});
