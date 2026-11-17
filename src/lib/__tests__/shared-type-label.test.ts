// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { propLabel, typeLabel } from '../object-window-table';
import { typeTile } from '../../editor-core/code-links';
import { whereLine } from '../../sidepanel/tabs/browse/view';

// One label per type and property, whichever surface shows it.
describe('surfaces use the shared labels', () => {
  const TYPES = ['CeAssuranceActivity', 'ExtendedExpression', 'ExtendedMethodConfig', 'InputSet', 'ButtonInput', 'Scorecard'];

  it('object window code links', () => {
    for (const t of TYPES) expect(typeTile(t).title).toBe(typeLabel(t));
  });

  it('Browse results', () => {
    for (const t of TYPES) expect(whereLine({ rid: '1', name: 'x', type: t, id: '', path: [], onPage: false })).toBe(typeLabel(t));
    expect(whereLine({ rid: '1', name: 'x', type: '', id: '', path: [], onPage: false })).toBeNull();
  });

  it('property words in the Calls rows', () => {
    expect(propLabel('firstColorExpression')).toBe('First color expression');
  });
});

describe('type labels read as words; the identifier is "ID"', () => {
  it('every type, with or without a table entry', async () => {
    const { typeLabel, typeInfo, propLabel } = await import('../object-window-table');
    for (const [type, words] of [['InputSet', 'Input set'], ['InputView', 'Input view'], ['EditPage', 'Edit page'], ['ActionButton', 'Action button'], ['ExtendedExpression', 'Extended expression'], ['CeAssuranceActivity', 'Assurance activity']]) {
      expect(typeLabel(type)).toBe(words);
      expect(typeInfo(type).label).toBe(words);
    }
    expect(propLabel('id')).toBe('ID');
  });
});
