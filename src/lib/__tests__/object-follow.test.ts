import { describe, expect, it } from 'vitest';
import { assembleStructure, attachRows } from '../object-structure';
import { followRule, typeInfo } from '../object-window-table';
import type { FullObject } from '../object-read';

const o = (rid: string, type: string, props: FullObject['props'] = {}): FullObject =>
  ({ rid, type, name: rid, businessId: rid, props, references: {}, overridden: [] } as unknown as FullObject);

describe('follow rule (type table)', () => {
  it('follows the action object of an action button only', () => {
    const action = o('2', 'ButtonInput', { buttonType: { kind: 'enum', text: 'ButtonInputType.action' } });
    const expr = o('3', 'ButtonInput', { buttonType: { kind: 'enum', text: 'ButtonInputType.expression' } });
    expect(followRule(action)).toMatchObject({ via: 'actionObject', depth: 1 });
    expect(followRule(expr)).toBeNull();
    expect(followRule(o('4', 'ButtonInput'))).toBeNull();
    expect(followRule(null)).toBeNull();
    expect(typeInfo('InputView').follow).toBeUndefined();
  });
});

describe('attachRows', () => {
  const root = o('1', 'InputSet');
  const tree = assembleStructure(root, [{ rid: '2', parent: '1' }, { rid: '5', parent: '1' }], { '2': o('2', 'ButtonInput'), '5': o('5', 'ButtonInput') });

  it('hangs referenced rows and their children under the node, in order', () => {
    const next = attachRows(tree, [
      { rid: '10', parent: '2', referenced: true },
      { rid: '11', parent: '10' },
      { rid: '12', parent: '10' },
    ], { '10': o('10', 'NotificationTransportGroup'), '11': o('11', 'ExtendedTransport') });
    expect(next.order).toEqual(['1', '2', '10', '11', '12', '5']);
    expect(next.nodes['10']).toMatchObject({ parent: '2', depth: 2, referenced: true });
    expect(next.nodes['11'].referenced).toBeUndefined();
    expect(next.nodes['12'].obj).toBeNull();
    // the input tree is unchanged
    expect(tree.nodes['2'].children).toEqual([]);
  });

  it('skips rows without a parent in the tree and nodes already present', () => {
    expect(attachRows(tree, [{ rid: '9', parent: '99' }, { rid: '5', parent: '2', referenced: true }], {})).toBe(tree);
  });
});
