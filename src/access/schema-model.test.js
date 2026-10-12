import {
  test
} from 'vitest';
import assert from 'node:assert/strict';
import {
  typeContext,
  listChoiceRows,
  selectedListItems,
  chooseListValue,
  fieldKind,
  changeField
} from './schema-model.js';
test('native reference storage keeps list and tag property pickers', () => {
  assert.equal(fieldKind({ configClass: 'HistoricalListMethodConfig', reference: true }), 'List');
  assert.equal(fieldKind({ configClass: 'TagMethodConfig', reference: true }), 'Tags');
  assert.equal(fieldKind({ configClass: 'SystemMethodConfig', reference: true }), 'Reference');
});
const prop = (accessor, setRid, token, rid) => ({
  accessor,
  listSet: {
    rid: setRid,
    items: [{
      rid,
      id: token.split(':')[1],
      name: 'Centrally maintained',
      token
    }]
  }
});
const org = [prop('tax_scope', '1', 'ListPropertySetItem:tax_scopeGlobal', '9000000000000000001'), prop('tax_rcmModel', '2',
  'ListPropertySetItem:anotherScope', '9205394100304593708')];
const window = {
  ACCESS_SCHEMA: {
    classes: {
      Organisation: org,
      CeRiskAssessment: [{
        accessor: 'domain_tags',
        listSet: {
          rid: '3',
          items: [{
            rid: '4',
            id: 'tag_dom_sox',
            name: 'SOX',
            token: 'Tag:tag_dom_sox'
          }]
        }
      }]
    }
  }
};
const type = (scope, name) => ({
  Condition: {
    Left: scope + '.type',
    Comparison: '=',
    Right: name
  }
});
const field = {
  Condition: {
    Left: 'resource.name',
    Comparison: '=',
    Right: 'Example'
  }
};
test('current and proposed object schemas remain independent', () => {
  const root = {
    All: [type('resource', 'Organisation'), type('new', 'CeProject'), field]
  };
  assert.deepEqual(typeContext(root, ['All', 2], 'resource'), ['Organisation']);
  assert.deepEqual(typeContext(root, ['All', 2], 'new'), ['CeProject']);
  assert.deepEqual(typeContext({
    All: [type('resource', 'Organisation'), field]
  }, ['All', 1], 'new'), []);
});
test('alternative branches cannot leak their type into other branches', () => {
  const root = {
    All: [{
      Any: [{
        All: [type('resource', 'Organisation'), field]
      }, {
        All: [type('resource', 'CeProject'), field]
      }]
    }]
  };
  assert.deepEqual(typeContext(root, ['All', 0, 'Any', 0, 'All', 1], 'resource'), ['Organisation']);
  assert.deepEqual(typeContext(root, ['All', 0, 'Any', 1, 'All', 1], 'resource'), ['CeProject']);
  assert.deepEqual(typeContext({
    Any: [type('resource', 'Organisation'), field]
  }, ['Any', 1], 'resource'), []);
});
test('an equality array is not mistaken for a type allowlist', () => {
  const root = {
    All: [{
      Condition: {
        Left: 'resource.type',
        Comparison: '=',
        Right: ['Organisation', 'CeProject']
      }
    }, field]
  };
  assert.deepEqual(typeContext(root, ['All', 1], 'resource'), []);
  root.All[0].Condition.Comparison = 'ContainsAny';
  assert.deepEqual(typeContext(root, ['All', 1], 'resource'), ['Organisation', 'CeProject']);
  root.All[0].Condition = { Left: 'resource.type', Comparison: 'Equal', Right: ['Organisation'] };
  assert.deepEqual(typeContext(root, ['All', 1], 'resource'), ['Organisation']);
  root.All[0].Condition.Comparison = 'ExactTypeOf';
  assert.deepEqual(typeContext(root, ['All', 1], 'resource'), []);
});
test('same-named real items remain bound to their own list and typed identity', () => {
  const origin = org.find(p => p.accessor === 'tax_scope'),
    rcm = org.find(p => p.accessor === 'tax_rcmModel');
  const a = listChoiceRows(origin).find(r => r.label === 'Centrally maintained'),
    b = listChoiceRows(rcm).find(r => r.label === 'Centrally maintained');
  assert.notEqual(a.setRid, b.setRid);
  assert.notEqual(a.token, b.token);
  assert.equal(chooseListValue(origin, [a.token], false), 'ListPropertySetItem:tax_scopeGlobal');
  assert.throws(() => chooseListValue(origin, [b.token], false), /this property/);
  assert.equal(typeof b.itemRid, 'string');
  assert.equal(b.itemRid, '9205394100304593708');
});
test('several selected items stay an array and tags keep the Tag namespace', () => {
  const p = org.find(p => p.accessor === 'tax_scope'),
    tokens = listChoiceRows(p).map(r => r.token);
  assert.deepEqual(chooseListValue(p, tokens, true), tokens);
  const tags = window.ACCESS_SCHEMA.classes.CeRiskAssessment.find(p => p.accessor === 'domain_tags');
  assert.equal(listChoiceRows(tags)[0].token, 'Tag:tag_dom_sox');
});
test('changing a field clears the previous value but keeps expression metadata', () => {
  const c = {
    Left: 'resource.tax_scope',
    Comparison: 'ContainsAny',
    Right: ['ListPropertySetItem:tax_scopeGlobal'],
    _comment: 'Keep this explanation'
  };
  assert.deepEqual(changeField(c, c.Left), c);
  assert.deepEqual(changeField(c, 'new.tax_rcmModel'), {
    ...c,
    Left: 'new.tax_rcmModel',
    Right: []
  });
  assert.equal(c.Right.length, 1);
});

test('selected list previews keep duplicate labels attached to typed IDs and unknown tokens', () => {
  const property = { listSet: { items: [
    { id: 'one', name: 'Same label', token: 'ListPropertySetItem:one' },
    { id: 'two', name: 'Same label', token: 'ListPropertySetItem:two' }
  ] } };
  const value = ['ListPropertySetItem:one', 'ListPropertySetItem:two', 'Tag:one'];
  assert.deepEqual(selectedListItems(property, value), [
    { token: value[0], label: 'Same label', id: 'one', known: true },
    { token: value[1], label: 'Same label', id: 'two', known: true },
    { token: value[2], label: 'Unresolved item', id: 'Tag:one', known: false }
  ]);
  assert.deepEqual(selectedListItems(property, ''), []);
});
