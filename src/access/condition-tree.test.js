import { describe, expect, it } from 'vitest';
import { conditionTree, rawNodes, flipGroup, insertCondition, removeCondition, setAt, groupDepth, groupSentence, insertedPath, addValue, removeValue } from './condition-tree';

const resource = () => ({ All: [
  { Condition: { Left: 'resource.Type', Comparison: 'ContainsAny', Right: ['ListPropertySetItem:type_control_measure'] } },
  { Any: [{ HasRole: { Reference: 'resource.performed_in', Roles: ['control_tester'] } },
    { HasAccessTo: { Reference: 'resource.parent_control', Grouping: 'any' } }] },
  { Condition: { Left: 'resource.status', Comparison: '!=', Right: 'Retired' }, description: 'Retired controls are frozen' },
] });

describe('condition tree', () => {
  it('builds groups, rows with real operators, and paths', () => {
    const tree = conditionTree(resource());
    expect(tree).toMatchObject({ kind: 'group', op: 'All', path: [] });
    expect(tree.children.map(c => c.kind)).toEqual(['condition', 'group', 'condition']);
    expect(tree.children[0]).toMatchObject({ left: 'resource.Type', comparison: 'ContainsAny', operator: 'contains any', list: true });
    expect(tree.children[1]).toMatchObject({ op: 'Any', path: ['All', 1] });
    expect(tree.children[1].children[1]).toMatchObject({ kind: 'hasAccessTo', grouping: 'Any', action: '', path: ['All', 1, 'Any', 1] });
    expect(tree.children[2]).toMatchObject({ operator: 'is not', note: 'Retired controls are frozen' });
    expect(groupDepth(tree.children[1].children[0].path)).toBe(2);
    expect(groupSentence(tree)).toBe('Type contains any type_control_measure and (performed_in has role control_tester or the user has access to parent_control) and status is not Retired');
  });

  it('marks what Rules cannot represent as raw instead of guessing', () => {
    const tree = conditionTree({ All: [
      { Condition: { Left: 'resource.x', Comparison: '=', Right: { nested: 1 } } },
      { Condition: { Left: 'resource.x', Comparison: '=', Right: 1, Extra: true } },
      { All: [], Any: [] },
      { HasRole: 'resource.owner' },
      { All: [], vendorKey: 1 },
    ] });
    expect(rawNodes(tree).map(n => n.path)).toEqual([['All', 0], ['All', 1], ['All', 2], ['All', 3], ['All', 4]]);
    expect(rawNodes(tree)[1].reason).toBe('Unknown keys: Extra.');
  });
});

describe('condition edits', () => {
  it('flips All and Any as the earlier editor did', () => {
    const flipped = flipGroup(resource(), ['All', 1]);
    expect(flipped.All[1].All).toHaveLength(2);
    expect(flipped.All[1].Any).toBeUndefined();
    expect(flipGroup(resource(), [])).toEqual({ Any: resource().All });
    expect(() => flipGroup(resource(), ['All', 0])).toThrow();
  });

  it('inserts into a group, wraps a single node, and removes', () => {
    expect(insertCondition(resource(), ['All', 1], 'Condition').All[1].Any[2]).toEqual({ Condition: { Left: 'resource.type', Comparison: '=', Right: '' } });
    expect(insertCondition({ Condition: { Left: 'new.type', Right: 'X' } }, [], 'HasRole', 'new'))
      .toEqual({ All: [{ Condition: { Left: 'new.type', Right: 'X' } }, { HasRole: { Reference: 'new.', Roles: [] } }] });
    expect(insertCondition(undefined, [], 'Any')).toEqual({ All: [{ Any: [] }] });
    expect(removeCondition(resource(), ['All', 1]).All).toHaveLength(2);
    expect(removeCondition(resource(), [])).toEqual({ All: [] });
    expect(setAt(resource(), ['All', 2, 'Condition', 'Right'], 'Active').All[2].Condition.Right).toBe('Active');
  });

  it('leaves raw JSON byte-identical when a sibling is edited', () => {
    const odd = { Condition: { Left: 'resource.x', Comparison: '=', Right: { z: 1, a: [2, { b: 3 }] }, Vendor: 'kept' }, comment: 'n' };
    const source = { Any: [odd, { Condition: { Left: 'resource.status', Comparison: '=', Right: 'Open' } }], description: 'outer' };
    const before = JSON.stringify(source.Any[0]);
    for (const edited of [
      setAt(source, ['Any', 1, 'Condition', 'Right'], 'Closed'),
      flipGroup(source, []),
      insertCondition(source, [], 'Condition'),
      removeCondition(source, ['Any', 1]),
    ]) expect(JSON.stringify((edited.Any ?? edited.All)[0])).toBe(before);
    expect(JSON.stringify(flipGroup(source, []))).toBe(JSON.stringify({ description: 'outer', All: source.Any }));
  });
});

describe('list values as chips and new-node paths', () => {
  const resource = { All: [{ Condition: { Left: 'resource.Type', Comparison: 'ContainsAny', Right: ['ListPropertySetItem:a', 'ListPropertySetItem:b'] } }, { Condition: { Left: 'resource.n', Comparison: 'ContainsAny', Right: [1, 2] } }] };
  it('removes and adds values, keeping JSON types and order', () => {
    expect(removeValue(resource, ['All', 0], 0).All[0].Condition.Right).toEqual(['ListPropertySetItem:b']);
    expect(addValue(resource, ['All', 0], ' ListPropertySetItem:c ').All[0].Condition.Right).toEqual(['ListPropertySetItem:a', 'ListPropertySetItem:b', 'ListPropertySetItem:c']);
    expect(addValue(resource, ['All', 1], '3').All[1].Condition.Right).toEqual([1, 2, 3]);
    expect(addValue(resource, ['All', 1], '2')).toBe(resource);
    expect(Object.keys(addValue(resource, ['All', 0], 'x').All[0].Condition)).toEqual(['Left', 'Comparison', 'Right']);
    expect(() => removeValue(resource, ['All', 0], 5)).toThrow();
  });
  it('names the path of an inserted node', () => {
    expect(insertedPath(resource, [])).toEqual(['All', 2]);
    expect(insertedPath({ Condition: {} }, [])).toEqual(['All', 1]);
    expect(insertedPath(undefined, [])).toEqual(['All', 0]);
    const next = insertCondition(resource, [], 'Condition');
    expect(next.All[2]).toBeDefined();
  });
});