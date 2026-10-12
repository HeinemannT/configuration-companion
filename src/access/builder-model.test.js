import {
  test
} from 'vitest';
import assert from 'node:assert/strict';
import {
  transformExpression,
  expressionKind,
  duplicateIndices
} from './builder-model.js';
test('annotations do not hide native expressions or get discarded by edits', () => {
  const expression = { All: [{ Condition: { Left: 'new.type', Right: 'Organisation' }, description: 'New object type' }],
    description: 'Purpose', comment: 'Keep this', notes: ['Review'], Any: null };
  assert.equal(expressionKind(expression), 'All');
  assert.equal(expressionKind(expression.All[0]), 'Condition');
  assert.deepEqual(transformExpression(expression, ['All', 0], 'duplicate').All, [expression.All[0], expression.All[0]]);
  assert.equal(expressionKind({ All: [], Any: [] }), '');
});
const a = {
    Condition: {
      Left: 'resource.type',
      Comparison: '=',
      Right: 'Organisation'
    }
  },
  b = {
    HasRole: {
      Reference: 'resource.tax_region',
      Roles: ['regional_owner']
    }
  };
test('grouping changes only the selected subtree and preserves its exact contents', () => {
  const root = {
    All: [a, b],
    _comment: 'keep me'
  };
  const next = transformExpression(root, ['All', 1], 'any');
  assert.deepEqual(next, {
    All: [a, {
      Any: [b]
    }],
    _comment: 'keep me'
  });
  assert.deepEqual(root, {
    All: [a, b],
    _comment: 'keep me'
  });
  assert.deepEqual(transformExpression(next, ['All', 1], 'unwrap'), root);
});
test('duplicate and reorder preserve related-role checks and source AST', () => {
  const root = {
    All: [a, b]
  };
  const duplicated = transformExpression(root, ['All', 1], 'duplicate');
  assert.deepEqual(duplicated.All, [a, b, b]);
  assert.deepEqual(transformExpression(root, ['All', 1], 'up').All, [b, a]);
  assert.deepEqual(root.All, [a, b]);
  assert.throws(() => transformExpression(root, ['All', 0], 'up'), /end/);
});
test('duplicate detection handles key order but retains comments and boolean scope', () => {
  const reordered = {
    Condition: {
      Right: 'Organisation',
      Left: 'resource.type',
      Comparison: '='
    }
  };
  assert.deepEqual([...duplicateIndices([a, reordered, {
    ...a,
    _comment: 'annotated'
  }, b])], [
    [1, 0]
  ]);
  assert.throws(() => transformExpression({
    Any: [a, b]
  }, [], 'unwrap'), /one condition/);
  assert.throws(() => transformExpression({
    All: [a],
    _comment: 'annotation'
  }, [], 'unwrap'), /extra fields/);
});
