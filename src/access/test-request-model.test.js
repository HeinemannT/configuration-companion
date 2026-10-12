import {
  test
} from 'vitest';
import assert from 'node:assert/strict';
import {
  renameExample,
  proposedForTest,
  switchTestAction
} from './test-request-model.js';
const object = {
  rid: '9223372036854775806',
  type: 'Organisation',
  name: 'Example region'
};
test('quick Update simulates only the displayed name and keeps type context', () => {
  const check = {
    action: 'Update'
  };
  assert.deepEqual(proposedForTest(check, object), {
    type: 'Organisation',
    properties: {
      name: renameExample(object)
    }
  });
  assert.deepEqual(check, {
    action: 'Update'
  });
  assert.equal(object.name, 'Example region');
  assert.throws(() => proposedForTest({
    ...check,
    rename: object.name
  }, object), /different name/);
  assert.throws(() => proposedForTest({
    ...check,
    rename: ''
  }, object), /new name/);
  assert.throws(() => proposedForTest(check, null), /Choose an object/);
});
test('custom proposed values preserve the exact changes and string reference identities', () => {
  const proposed = {
    type: 'Organisation',
    properties: {
      name: 'New region',
      enabled: false
    },
    references: {
      owner: '9223372036854775805'
    },
    parent_rid: null
  };
  assert.deepEqual(proposedForTest({
    action: 'Update',
    updateMode: 'custom',
    proposed: JSON.stringify(proposed)
  }, object), proposed);
  for (const invalid of ['{}', '[]', 'bad JSON', '{"type":"Other"}', '{"type":"Organisation","name":"wrong nesting"}',
      '{"type":"Organisation","references":{"owner":123}}'
    ]) assert.throws(() => proposedForTest({
    action: 'Update',
    updateMode: 'custom',
    proposed: invalid
  }, object));
  assert.equal(proposedForTest({
    action: 'Read',
    proposed: 'bad JSON'
  }, object), undefined);
});
test('Create and Update scenarios restore the whole request without reusing a current result', () => {
  const initial = {
    action: 'Update',
    resource: object.rid,
    rename: 'Renamed',
    proposed: '{"type":"Organisation"}',
    result: {
      request: true
    }
  };
  const create = switchTestAction(initial, 'Create');
  assert.equal(create.resource, '');
  assert.equal(create.proposed, '{}');
  assert.equal(create.result, null);
  create.proposed = '{"type":"CeControlMeasure"}';
  const update = switchTestAction(create, 'Update');
  assert.equal(update.proposed, initial.proposed);
  assert.equal(update.resource, object.rid);
  assert.equal(update.rename, initial.rename);
  assert.equal(update.result.stale, true);
  assert.equal(switchTestAction({
    ...update,
    resource: object.rid
  }, 'Read').resource, object.rid);
  assert.equal(initial.result.request, true);
});
