import {
  test,
  expect
} from 'vitest';
import assert from 'node:assert/strict';
import {
  comparisonRows,
  comparisonLabels,
  comparisonHint,
  changeComparison,
  searchChoices,
  toggleChoice,
  nextChoice
} from './picker-model.js';
import { PBAC_COMPARISONS } from './pbac-syntax.js';
test('all native comparisons and aliases remain editable without rewriting imported tokens', () => {
  for (const token of PBAC_COMPARISONS) {
    const condition = { Left: 'new.tags', Comparison: token, Right: ['review', 'audit'], description: 'Retain' };
    expect(comparisonRows(token).find(r => r.rid === token)?.label).toBe(comparisonLabels[token]);
    expect(changeComparison(condition, token)).toEqual(condition);
  }
  expect(comparisonLabels.NotEqual).toBe('is not');
  expect(comparisonHint({ Comparison: 'Equal', Right: ['A', 'B'] })).toContain('whole collection');
  expect(comparisonHint({ Comparison: 'ExactTypeOf', Right: ['A'] })).toContain('not an array');
  expect(changeComparison({ Left: 'new.type', Right: '' }, 'Empty').Right).toEqual([]);
});
test('comparison changes retain arrays, metadata, and hidden values', () => {
  const c = {
    Left: 'new.tags',
    Comparison: '=',
    Right: 'review',
    custom: true
  };
  const any = changeComparison(c, 'ContainsAny');
  assert.deepEqual(any.Right, ['review']);
  assert.equal(c.Right, 'review');
  const all = {
    ...any,
    Right: ['review', 'audit']
  };
  for (const op of ['=', 'Empty', 'NotEmpty', 'NotContainsAll']) expect(changeComparison(all, op).Right).toEqual(all.Right);
  assert.equal(changeComparison(c, 'Empty').custom, true);
  assert.deepEqual(changeComparison({
    ...c,
    Right: ''
  }, 'ContainsAll').Right, []);
});
test('context prioritizes without hiding supported or imported comparisons', () => {
  const rows = comparisonRows('Custom', {
    multiple: true
  });
  assert.equal(rows[0].rid, 'ContainsAny');
  assert.equal(rows.length, 12);
  assert.equal(comparisonRows('=', {
    type: true
  })[0].rid, '=');
  const scalarGroups = [...new Set(comparisonRows('=', { type: true }).map(row => row.group))];
  assert.deepEqual(scalarGroups.slice(0, 2), ['Equality', 'Object type']);
  assert.equal(comparisonRows('ContainsAny', { type: true, multiple: true })[0].rid, 'ContainsAny');
  assert.equal(searchChoices(rows, 'one of')[0].rid, 'ContainsAny');
  assert.equal(searchChoices(rows, 'ContainsAny')[0].rid, 'ContainsAny');
  assert.equal(searchChoices(rows, 'blank')[0].rid, 'Empty');
});
test('selection survives filtering and handles Everyone exclusively', () => {
  assert.deepEqual(toggleChoice(['a', 'b'], 'c', '*'), ['a', 'b', 'c']);
  assert.deepEqual(toggleChoice(['a', 'b'], 'a', '*'), ['b']);
  assert.deepEqual(toggleChoice(['a', 'b'], '*', '*'), ['*']);
  assert.deepEqual(toggleChoice(['*'], 'a', '*'), ['a']);
});
test('navigation skips disabled rows, including both boundaries and empty results', () => {
  const rows = [{
    reason: 'disabled'
  }, {}, {
    reason: 'disabled'
  }, {}];
  assert.equal(nextChoice(rows, 0, 'Home'), 1);
  assert.equal(nextChoice(rows, 1, 'ArrowDown'), 3);
  assert.equal(nextChoice(rows, 3, 'ArrowUp'), 1);
  assert.equal(nextChoice(rows, 1, 'ArrowUp'), 1);
  assert.equal(nextChoice([], 0, 'End'), -1);
});
test('rule search uses the visible number, not its zero-based storage index', () => {
  const rows = [9, 10].map(i => ({
    rid: String(i),
    id: String(i + 1),
    label: 'Rule ' + (i + 1),
    searchId: false
  }));
  assert.deepEqual(searchChoices(rows, '10').map(r => r.label), ['Rule 10']);
});
