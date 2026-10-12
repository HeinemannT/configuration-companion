import {
  test
} from 'vitest';
import assert from 'node:assert/strict';
import {
  resolveUser,
  userChoiceRows
} from './principal-model.js';
import {
  searchChoices
} from './picker-model.js';
const users = [{
    id: 'person_2',
    name: 'Taylor',
    rid: '9223372036854775806'
  },
  {
    id: 'person_1',
    name: 'Taylor',
    rid: '9223372036854775805'
  },
  {
    id: '12345',
    name: 'Numeric login',
    rid: '9223372036854775804'
  }
];
test('normal IDs resolve to exact 64-bit RID strings; numeric IDs are not RIDs', () => {
  assert.equal(resolveUser(users, ' person_1 ').rid, '9223372036854775805');
  assert.equal(resolveUser(users, '12345').rid, '9223372036854775804');
  assert.equal(resolveUser(users, '9223372036854775805'), null);
  assert.equal(resolveUser(users, 'Taylor'), null);
  assert.equal(resolveUser(users, ''), null);
  assert.equal(resolveUser(users, 'PERSON_1'), null);
});
test('search finds names and normal IDs, keeping identical names distinct', () => {
  const rows = userChoiceRows(users);
  assert.equal(searchChoices(rows, 'Taylor').length, 2);
  assert.deepEqual(searchChoices(rows, ' PERSON_1 ').map(r => r.rid), ['person_1']);
  assert.equal(searchChoices(rows, '9223372036854775805').length, 0);
  assert.equal(rows.find(r => r.id === 'person_1').secondary, 'person_1');
});
test('ambiguous IDs and corrupted numeric RIDs cannot be selected', () => {
  const ambiguous = [...users, {
    id: 'person_1',
    name: 'Someone else',
    rid: '2'
  }];
  assert.equal(resolveUser(ambiguous, 'person_1'), null);
  assert.ok(userChoiceRows(ambiguous).filter(r => r.id === 'person_1').every(r => r.reason));
  assert.equal(resolveUser([{
    id: 'bad',
    rid: Number('9223372036854775805')
  }], 'bad'), null);
});
