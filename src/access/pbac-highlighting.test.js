import {
  test
} from 'vitest';
import assert from 'node:assert/strict';
import {
  tokenizePBAC
} from './pbac-highlighting.js';
import { PBAC_COMPARISONS } from './pbac-syntax.js';
const tokens = value => tokenizePBAC(JSON.stringify(value, null, 2)).flat().filter(t => t.type);

test('PBAC roles, actions, expressions and operators are classified by their JSON field', () => {
  const list = tokens({
    Statement: [{
      Subject: ['role:manager'],
      Effect: 'Allow',
      Action: ['Read'],
      Resource: {
        All: [{
          Condition: {
            Left: 'new.type',
            Comparison: '=',
            Right: 'CeProject'
          }
        }, {
          HasAccessTo: {
            Reference: 'resource.parent',
            Roles: ['manager', 'auditor'],
            Action: 'Read',
            Grouping: 'Any'
          }
        }]
      }
    }]
  });
  const types = text => list.filter(t => t.text === JSON.stringify(text)).map(t => t.type);
  assert.deepEqual(types('manager'), ['role']);
  assert.deepEqual(types('auditor'), ['role']);
  assert.deepEqual(types('role:manager'), ['role']);
  assert.deepEqual(types('Read'), ['action', 'action']);
  assert.deepEqual(types('new.type'), ['reference']);
  assert.deepEqual(types('resource.parent'), ['reference']);
  assert.deepEqual(types('='), ['operator']);
  assert.deepEqual(types('Any'), ['logic']);
  assert.deepEqual(types('Statement'), ['structure']);
  assert.deepEqual(types('HasAccessTo'), ['logic']);
});
test('only native expression names and comparison aliases acquire PBAC colors', () => {
  const list = tokens({ Resource: { Any: [...PBAC_COMPARISONS].map(Comparison => ({ Condition: { Left: 'resource.name', Comparison, Right: 'review' } })) } });
  assert.equal(list.filter(t => t.type === 'operator').length, 15);
  for (const comparison of ['>=', '>', '<', '<=', 'contains', 'Equals']) {
    const unsupported = tokens({ Condition: { Left: 'resource.name', Comparison: comparison } });
    assert.equal(unsupported.find(t => t.text === JSON.stringify(comparison)).type, 'string');
  }
  assert.equal(tokens({ Resource: { Not: {} } }).find(t => t.text === '"Not"').type, 'key');
});
test('comments and ordinary values do not acquire PBAC meaning from their text', () => {
  const list = tokens({
    _comment: 'role:manager',
    Name: 'Read',
    HasRole: { Reference: 'resource.owner', Roles: ['manager'] },
    Other: ['manager'],
    Condition: {
      Right: 'ListPropertySetItem:review'
    }
  });
  assert.equal(list.find(t => t.text === '"role:manager"').type, 'comment');
  assert.equal(list.find(t => t.text === '"Read"').type, 'string');
  assert.deepEqual(list.filter(t => t.text === '"manager"').map(t => t.type), ['role', 'string']);
  assert.equal(list.find(t => t.text === '"ListPropertySetItem:review"').type, 'typed');
});

test('annotation aliases share a color at every PBAC object level', () => {
  const annotations = { description: 'role:manager', title: 'Read', comment: 'resource.name',
    comments: 'ContainsAny', note: 'user', notes: 'CeProject', annotations: { owner: 'role:auditor' },
    $comment: 'schema-style note', _comment: 'legacy note', Description: 'Capitalized note' };
  const expected = tokens(annotations).filter(t => !['punctuation', 'invalid'].includes(t.type));
  assert.ok(expected.length > 0);
  assert.ok(expected.every(t => t.type === 'comment'));
  for (const wrap of [
    a => ({ ...a }),
    a => ({ Statement: [a] }),
    a => ({ Statement: [{ Resource: { ...a, All: [] } }] }),
    a => ({ Resource: { All: [{ ...a, Any: [] }] } }),
    a => ({ Condition: { ...a, Left: 'resource.name', Comparison: '=', Right: 'literal' } }),
    a => ({ HasRole: { ...a, Reference: 'resource.owner', Roles: ['manager'] } }),
    a => ({ HasAccessTo: { ...a, Reference: 'resource.owner', Action: 'Read' } }),
  ]) {
    assert.deepEqual(tokens(wrap(annotations)).filter(t => t.type === 'comment').map(t => t.text), expected.map(t => t.text));
  }
});

test('structured annotations remain annotations without disguising literal data or unknown fields', () => {
  const annotations = { description: ['role:manager', [12, false, null, { Condition: { Left: 'resource.name' } }]],
    notes: { Action: ['Read'], Roles: ['manager'] } };
  const list = tokens({ annotations });
  assert.ok(list.filter(t => t.type !== 'punctuation').every(t => t.type === 'comment'));
  for (const Right of [annotations, [annotations], [[annotations]]]) {
    const literal = tokens({ Condition: { Left: 'resource.description', Comparison: '=', Right } });
    assert.equal(literal.filter(t => t.type === 'comment').length, 0);
    assert.deepEqual(literal.filter(t => t.type === 'reference').map(t => t.text), ['"resource.description"']);
  }
  const unknown = tokens({ Other: annotations, some_comment: 'note', DescriptionTypo: 'note' });
  assert.equal(unknown.filter(t => t.type === 'comment').length, 0);
  const escaped = tokenizePBAC('{"descr\\u0069ption":"role:manager"}').flat();
  assert.equal(escaped.find(t => t.text === '"role:manager"').type, 'comment');
});
test('escaped JSON and whitespace round-trip exactly, including a colon on the next line', () => {
  const source = '{\n "HasRole": { "R\\u006fles"\n : ["role:a\\"b"] }, "x": false, "n": -2.5e3, "z": null\n}';
  const lines = tokenizePBAC(source);
  assert.equal(lines.map(line => line.map(t => t.text).join('')).join('\n'), source);
  assert.equal(lines.flat().find(t => t.text === '"role:a\\"b"').type, 'role');
  assert.equal(lines.flat().filter(t => t.type === 'atom').length, 2);
});

test('reference checks support native shorthand, reverse references, and case-insensitive enums', () => {
  const list = tokens({ Resource: { All: [
    { HasRole: 'new.owner' }, { HasAccessTo: 'reversed.parent' },
    { HasRole: { Reference: 'reversed.owner', Roles: ['reviewer'] } },
    { HasAccessTo: { Reference: 'resource.parent', Action: 'READ', Grouping: 'any', Roles: ['auditor'] } }
  ] }, Effect: 'allow', Action: ['read', 'UPDATE'] });
  assert.deepEqual(list.filter(t => t.type === 'reference').map(t => JSON.parse(t.text)),
    ['new.owner', 'reversed.parent', 'reversed.owner', 'resource.parent']);
  assert.deepEqual(list.filter(t => t.type === 'role').map(t => JSON.parse(t.text)), ['reviewer', 'auditor']);
  assert.equal(list.filter(t => t.type === 'action').length, 4);
  assert.equal(list.find(t => t.text === '"any"').type, 'logic');
});

test('subjects distinguish role and user selectors from the scalar wildcard and unsupported selectors', () => {
  const list = tokens({ Statement: [
    { Subject: ['role:reviewer', 'user:alex', 'group:team', '*'] },
    { Subject: '*' }, { Subject: 'role:reviewer' }
  ] });
  assert.deepEqual(list.filter(t => t.text === '"role:reviewer"').map(t => t.type), ['role', 'string']);
  assert.equal(list.find(t => t.text === '"user:alex"').type, 'subject');
  assert.equal(list.find(t => t.text === '"group:team"').type, 'string');
  assert.deepEqual(list.filter(t => t.text === '"*"').map(t => t.type), ['string', 'atom']);
});

test('right-side values follow TokenFactory semantics rather than expression-looking text', () => {
  for (const reverse of [false, true]) {
    const condition = (Left, Right) => ({ Condition: reverse ? { Right, Comparison: '=', Left } : { Left, Comparison: '=', Right } });
    const list = tokens({ Resource: { All: [
      condition('resource.createdBy', 'user'),
      condition('resource.name', 'resource.parent'),
      condition('resource.name', 'new.name'),
      condition('resource.name', 'user.name'),
      condition('resource.name', ['user']),
      condition('resource', 'Scorecard:landing'),
      condition('resource.status', ['ListPropertySetItem:approved']),
      condition('resource.name', 'Type_1:literal')
    ] } });
    assert.deepEqual(list.filter(t => t.text === '"user"').map(t => t.type), ['reference', 'string']);
    for (const literal of ['resource.parent', 'new.name', 'user.name', 'Type_1:literal'])
      assert.equal(list.find(t => t.text === JSON.stringify(literal)).type, 'string');
    assert.deepEqual(list.filter(t => t.type === 'typed').map(t => JSON.parse(t.text)), ['Scorecard:landing', 'ListPropertySetItem:approved']);
  }
});

test('literal objects and metadata cannot create fake PBAC role, action or logic tokens', () => {
  const literal = { All: [], Roles: ['reviewer'], Subject: ['role:reviewer'], Action: ['Read'], Left: 'resource.name', Comparison: '=', _comment: 'literal' };
  const list = tokens({ Condition: { Left: 'resource.customData', Comparison: '=', Right: literal }, Extra: literal });
  assert.equal(list.filter(t => ['role', 'subject', 'action', 'comment'].includes(t.type)).length, 0);
  assert.deepEqual(list.filter(t => t.type === 'logic').map(t => JSON.parse(t.text)), ['Condition']);
  assert.equal(list.filter(t => t.type === 'operator').length, 1);
  assert.equal(list.filter(t => t.type === 'reference').length, 1);
});
test('incomplete JSON remains lossless and uses recoverable syntax colors', () => {
  for (const source of ['{"Roles": ["unfinished', '{"Condition":{"Right":["Type:a",', '{"Subject": ["role:r"]', '{"a": tru', '']) {
    const result = tokenizePBAC(source).flat();
    assert.equal(result.map(t => t.text).join(''), source);
  }
  assert.equal(tokenizePBAC('{"x":"unfinished').flat().at(-1).type, 'invalid');
});

test('a complete Right array determines reference colors, regardless of order or line breaks', () => {
  for (const Right of [['ListPropertySetItem:a', 'literal'], ['literal', 'ListPropertySetItem:a'], ['ListPropertySetItem:a', 1], ['ListPropertySetItem:a', ['ListPropertySetItem:b']]]) {
    const list = tokens({ Condition: { Right, Comparison: 'ContainsAny', Left: 'resource.name' } });
    assert.equal(list.filter(t => t.type === 'typed').length, 0);
  }
  const typed = tokens({ Condition: { Right: ['ListPropertySetItem:a', 'ListPropertySetItem:b'], Left: 'resource.name' } });
  assert.equal(typed.filter(t => t.type === 'typed').length, 2);
  for (const Left of ['resource.type', 'new.type', 'resource.model']) {
    assert.equal(tokens({ Condition: { Left, Right: ['Organisation'] } }).find(t => t.text === '"Organisation"').type, 'typed');
  }
});
