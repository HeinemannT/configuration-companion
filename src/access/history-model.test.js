import {
  test
} from 'vitest';
import assert from 'node:assert/strict';
import {
  changePatch,
  historyContext,
  reverseChange,
  rolePolicyMatches,
  discardRecord,
  conflictingJSONDrafts,
  copyRoleDefinitions
} from './history-model.js';
const clone = v => JSON.parse(JSON.stringify(v));

test('history retains changed identities and ancestors, not 20,000 untouched records', () => {
  const before = base();
  before.policies = Array.from({ length: 5000 }, (_, i) => ({ rid: 'p' + i, id: 'p' + i, name: 'Policy', parent: '', content: { Statement: [{ Subject: '*', Action: 'Read', Resource: { Equals: { 'resource.type': 'Organisation' } } }] } }));
  before.globals = Array.from({ length: 20_000 }, (_, i) => ({ rid: 'g' + i, parent: before.roles[0].rid, mode: 'User', subject: String(9000000000000000000n + BigInt(i)) }));
  const after = clone(before); after.roles[0].name = 'Changed';
  const patch = changePatch(before, after), context = historyContext(before, patch);
  assert.equal(context.globals.length, 0); assert.equal(context.policies.length, 0);
  assert.ok(JSON.stringify(context).length < 1000);
  const undo = reverseChange(after, patch);
  assert.equal(undo.model.roles[0].name, before.roles[0].name);
  assert.equal(after.roles[0].name, 'Changed');
  assert.equal(undo.model.policies[100], after.policies[100]);
});
const base = () => ({
  roles: [{
    rid: '9000000000000000001',
    id: 'a',
    name: 'Role A',
    parent: ''
  }, {
    rid: '2',
    id: 'b',
    name: 'Role B',
    parent: ''
  }],
  policies: [{
    rid: 'p',
    name: 'Policy',
    enabled: true,
    parent: 'f',
    content: {
      Statement: [{
        Subject: ['role:a'],
        Action: ['Read'],
        Resource: {
          All: []
        }
      }]
    }
  }],
  scope: [],
  globals: [],
  folders: [{
    rid: 'f',
    id: 'folder',
    name: 'Folder',
    parent: ''
  }]
});
test('targeted undo keeps later edits to independent fields and records', () => {
  const before = base(),
    after = clone(before);
  after.roles[0].name = 'Renamed';
  const current = clone(after);
  current.policies[0].enabled = false;
  current.roles[0].parent = '2';
  const reversed = reverseChange(current, changePatch(before, after));
  assert.equal(reversed.model.roles[0].name, 'Role A');
  assert.equal(reversed.model.roles[0].parent, '2');
  assert.equal(reversed.model.policies[0].enabled, false);
});
test('targeted undo refuses to overwrite a later edit to the same field', () => {
  const before = base(),
    after = clone(before);
  after.roles[0].name = 'First';
  const current = clone(after);
  current.roles[0].name = 'Second';
  assert.match(reverseChange(current, changePatch(before, after)).reason, /later edit/);
  assert.equal(current.roles[0].name, 'Second');
});
test('role ID and updated policy references reverse together', () => {
  const before = base(),
    after = clone(before);
  after.roles[0].id = 'renamed';
  after.policies[0].content.Statement[0].Subject = ['role:renamed'];
  const result = reverseChange(after, changePatch(before, after));
  assert.deepEqual(result.model, before);
  const current = clone(after);
  current.policies.push({
    rid: 'later',
    content: {
      Statement: [{
        Subject: ['role:renamed']
      }]
    }
  });
  assert.match(reverseChange(current, changePatch(before, after)).reason, /depends/);
});
test('undoing creation cannot strand a later child, policy, or folder', () => {
  const before = base(),
    after = clone(before);
  after.folders.push({
    rid: 'new',
    id: 'new',
    parent: 'f'
  });
  const later = clone(after);
  later.policies[0].parent = 'new';
  assert.match(reverseChange(later, changePatch(before, after)).reason, /depends/);
  const roleAfter = clone(before);
  roleAfter.roles.push({
    rid: 'new-role',
    id: 'new',
    parent: ''
  });
  const roleLater = clone(roleAfter);
  roleLater.roles[1].parent = 'new-role';
  assert.match(reverseChange(roleLater, changePatch(before, roleAfter)).reason, /depends/);
});
test('policy structure edits remain atomic when later rules change', () => {
  const before = base(),
    after = clone(before);
  after.policies[0].content.Statement[0].Action = ['Update'];
  const later = clone(after);
  later.policies[0].content.Statement.push({
    Subject: '*',
    Action: ['Read']
  });
  assert.match(reverseChange(later, changePatch(before, after)).reason, /later edit/);
});
test('role previews find only the exact matching statements and paths', () => {
  const p = {
    content: {
      Statement: [{
        Subject: ['role:a'],
        Action: ['Read']
      }, {
        Subject: ['role:ab'],
        Action: ['Delete']
      }, {
        Subject: '*',
        Action: ['Update'],
        Resource: {
          All: [{
            HasRole: {
              Roles: ['a'],
              Reference: 'resource.parent'
            }
          }]
        }
      }]
    }
  };
  const matches = rolePolicyMatches(p, 'a');
  assert.deepEqual(matches.map(m => m.index), [0, 2]);
  assert.deepEqual(matches[0].refs, ['Subject']);
  assert.deepEqual(matches[1].refs, ['Resource.All.0.HasRole.Roles']);
  assert.deepEqual(matches.flatMap(m => m.statement.Action), ['Read', 'Update']);
});

test('Review discard protects dependent folder moves and identifies the policy to resolve', () => {
  const baseline = base(),
    current = clone(baseline);
  current.folders.push({
    rid: 'draft:123',
    id: 'new',
    name: 'New folder',
    parent: ''
  });
  current.policies[0].parent = 'draft:123';
  current.roles[1].name = 'Independent rename';
  const blocked = discardRecord(current, baseline, 'folders', 'draft:123');
  assert.match(blocked.reason, /depends/);
  assert.equal(blocked.dependents[0].rid, 'p');
  assert.equal(current.policies[0].parent, 'draft:123');
  const movedBack = discardRecord(current, baseline, 'policies', 'p').model;
  const removed = discardRecord(movedBack, baseline, 'folders', 'draft:123').model;
  assert.equal(removed.folders.length, 1);
  assert.equal(removed.roles[1].name, 'Independent rename');
});
test('Review discard refuses to strand a new role child or restore a hierarchy cycle', () => {
  const baseline = base(),
    current = clone(baseline);
  current.roles.push({
    rid: 'new',
    id: 'new',
    name: 'New parent',
    parent: ''
  });
  current.roles[1].parent = 'new';
  assert.match(discardRecord(current, baseline, 'roles', 'new').reason, /depends/);
  const old = base();
  old.roles[0].parent = '2';
  const next = clone(old);
  next.roles[0].parent = '';
  next.roles[1].parent = next.roles[0].rid;
  assert.match(discardRecord(next, old, 'roles', next.roles[0].rid).reason, /depends/);
});
test('JSON buffers block conflicting content or role identity changes, not unrelated undo', () => {
  const before = base(),
    after = clone(before);
  after.roles[1].name = 'Renamed';
  assert.deepEqual(conflictingJSONDrafts(changePatch(before, after), ['p']), []);
  after.policies[0].enabled = false;
  assert.deepEqual(conflictingJSONDrafts(changePatch(before, after), ['p']), []);
  after.policies[0].content.Statement[0].Action = ['Update'];
  assert.deepEqual(conflictingJSONDrafts(changePatch(before, after), ['p']), ['p']);
  const renamed = clone(before);
  renamed.roles[0].id = 'renamed';
  assert.deepEqual(conflictingJSONDrafts(changePatch(before, renamed), ['p']), ['p']);
});
test('duplicated role scope has fresh identities and preserves nested direction and metadata', () => {
  const model = base();
  model.scope = [{
    rid: 'branch',
    id: 'branch',
    parent: 'assignment',
    kind: 'InwardsReferenceRoleDelegationRule',
    field: 'tax_region',
    notes: {
      exact: true
    }
  }, {
    rid: 'assignment',
    id: 'assignment',
    parent: model.roles[0].rid,
    kind: 'RoleAssignment',
    source: 'Organisation',
    field: 'tax_responsible'
  }, {
    rid: 'other',
    parent: '2',
    kind: 'RoleAssignment',
    field: 'unrelated'
  }];
  let n = 0;
  const copied = copyRoleDefinitions(model, model.roles[0].rid, 'new-role', () => `draft:${++n}`);
  assert.equal(copied.length, 2);
  assert.equal(copied[0].parent, 'new-role');
  assert.equal(copied[1].parent, copied[0].rid);
  assert.equal(copied[1].field, 'tax_region');
  assert.notEqual(copied[1].id, 'branch');
  copied[1].notes.exact = false;
  assert.equal(model.scope[0].notes.exact, true);
  assert.equal(model.policies[0].content.Statement[0].Subject[0], 'role:a');
});
