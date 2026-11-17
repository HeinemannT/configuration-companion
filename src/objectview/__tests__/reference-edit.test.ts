import { describe, expect, it } from 'vitest';
import { ABSENT } from '../../lib/property-schema';
import { allowedKey, outsideAllowed, refDiffLines, referenceDiff, referenceText, refLabel, refName } from '../window/reference-edit';
import { ALLOWED, DEF, FOREIGN_OBJECT } from '../../lib/__tests__/fixtures/property-fields';

const items = ALLOWED[DEF.regions];
const [CUSTOMER, SUPPLIER, PARTNER] = items.map(i => i.rid);
const summaries = { [FOREIGN_OBJECT]: { rid: FOREIGN_OBJECT, name: 'Old region', type: 'Organisation', businessId: 'r9' } };

describe('reference values in words', () => {
  it('names objects from the allowed set, then the summaries, else by RID', () => {
    expect(referenceText(`${CUSTOMER},${FOREIGN_OBJECT},7000000000000000077`, items, summaries))
      .toBe('Customer onboarding (110), Old region (r9), 7000000000000000077');
    expect(referenceText(ABSENT, items)).toBe('Not set');
    expect(refLabel(refName(CUSTOMER, [{ rid: CUSTOMER, id: 'same', name: 'same' }]))).toBe('same');
    expect(refLabel(refName(CUSTOMER, [{ rid: CUSTOMER, id: '', name: 'Only name' }]))).toBe('Only name');
    expect(refName('1', items)).toEqual({ rid: '1', name: '', id: '', known: false });
  });

  it('a list change is what is added and removed; order alone changes nothing', () => {
    const diff = referenceDiff(`${SUPPLIER},${CUSTOMER}`, `${CUSTOMER},${PARTNER}`, items);
    expect(diff.added.map(r => r.rid)).toEqual([PARTNER]);
    expect(diff.removed.map(r => r.rid)).toEqual([SUPPLIER]);
    expect(diff.kept).toBe(1);
    expect(refDiffLines(diff)).toEqual(['+ Partner onboarding (112)', '− Supplier onboarding (108)']);
    expect(refDiffLines(referenceDiff(`${SUPPLIER},${CUSTOMER}`, `${CUSTOMER},${SUPPLIER}`, items))).toEqual([]);
    expect(refDiffLines(referenceDiff(ABSENT, CUSTOMER, items))).toEqual(['+ Customer onboarding (110)']);
    expect(refDiffLines(referenceDiff(CUSTOMER, ABSENT, items))).toEqual(['− Customer onboarding (110)']);
  });

  it('names stored objects the allowed set no longer holds, once it is loaded', () => {
    expect(outsideAllowed(`${CUSTOMER},${FOREIGN_OBJECT}`, { phase: 'done', items })).toEqual([FOREIGN_OBJECT]);
    expect(outsideAllowed(`${CUSTOMER},${FOREIGN_OBJECT}`, { phase: 'loading' })).toEqual([]);
    expect(outsideAllowed(ABSENT, { phase: 'done', items })).toEqual([]);
    expect(allowedKey('1', '2')).toBe('1:2');
  });
});
