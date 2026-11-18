import { describe, expect, it } from 'vitest';
import type { FullObject } from '../../lib/object-read';
import { changeInputs } from '../window/changes';
import type { DraftEntry } from '../window/draft';
import type { ObjectResult } from '../window/save-plan';

const obj = (description: string): FullObject => ({
  rid: '10', type: 'Kpi', name: 'Sales', businessId: 'kpi_sales',
  props: { description: { kind: 'text', text: description } },
  references: {}, overridden: [],
} as unknown as FullObject);

const value = (v: string, base: string): DraftEntry => ({ kind: 'value', value: v, base });
const label = (_rid: string, prop: string) => prop.toUpperCase();
const shown = (_rid: string, _prop: string, _e: DraftEntry, v: string) => v;
const result = (over: Partial<ObjectResult>): ObjectResult => ({ rid: '10', saved: [], attempted: true, ...over });

describe('changeInputs', () => {
  it('reports a saved value with the opened value', () => {
    const out = changeInputs([result({ saved: [{ prop: 'description', entry: value('new', 'old') }] })], { 10: obj('new') }, { 10: obj('old') }, label, shown);
    expect(out).toEqual([{ rid: '10', name: 'Sales', businessId: 'kpi_sales', objectType: 'Kpi', prop: 'description', label: 'DESCRIPTION', before: 'old', after: 'new' }]);
  });

  it('marks a write the re-read does not confirm', () => {
    const saved = [{ prop: 'description', entry: value('new', 'old') }];
    expect(changeInputs([result({ saved })], {}, { 10: obj('old') }, label, shown)[0].unchecked).toBe(true);
    expect(changeInputs([result({ saved })], { 10: obj('other') }, { 10: obj('old') }, label, shown)[0].unchecked).toBe(true);
  });

  it('reports a reset without a value after', () => {
    const out = changeInputs([result({ saved: [{ prop: 'description', entry: { kind: 'reset', base: 'mine' } }] })], { 10: obj('tpl') }, { 10: obj('mine') }, label, shown);
    expect(out[0]).toMatchObject({ before: 'mine', after: '', reset: true });
    expect(out[0]).not.toHaveProperty('unchecked');
  });

  it('reports a lost answer only when the value may be stored', () => {
    const unknown = [{ prop: 'description', entry: value('new', 'old') }];
    expect(changeInputs([result({ unknown })], { 10: obj('old') }, { 10: obj('old') }, label, shown)).toEqual([]);
    expect(changeInputs([result({ unknown })], { 10: obj('new') }, { 10: obj('old') }, label, shown)).toHaveLength(1);
    expect(changeInputs([result({ unknown })], {}, { 10: obj('old') }, label, shown)[0].unchecked).toBe(true);
  });

  it('reports nothing for an object that was held back', () => {
    expect(changeInputs([result({ attempted: false })], {}, { 10: obj('old') }, label, shown)).toEqual([]);
  });
});
