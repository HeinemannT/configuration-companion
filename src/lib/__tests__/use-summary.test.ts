import { describe, expect, it } from 'vitest';
import { useSummary } from '../use-summary';

describe('useSummary', () => {
  it('says nothing was found, never "unused"', () => {
    const s = useSummary({ inCode: [], listed: [], total: 0 });
    expect(s).toEqual({ found: false, headline: 'Nothing found that refers to this object.', notes: ['IDs that code builds at run time cannot be found.'] });
  });

  it('says when code was not checked', () => {
    expect(useSummary({ inCode: null, listed: [], total: 0 }).notes[0]).toBe('Code was not checked.');
  });

  it('counts an object found by both once', () => {
    expect(useSummary({ inCode: ['1', '2'], listed: ['2', '3'], total: 2 }).headline).toBe('3 objects refer to this object.');
    expect(useSummary({ inCode: [], listed: ['2'], total: 1 }).headline).toBe('1 object refers to this object.');
  });

  it('uses the scan count past the list and says "at least" when code adds more', () => {
    expect(useSummary({ inCode: [], listed: ['1'], total: 400 }).headline).toBe('400 objects refer to this object.');
    expect(useSummary({ inCode: ['9'], listed: ['1'], total: 400 }).headline).toBe('At least 400 objects refer to this object.');
  });

  it('names the instances', () => {
    expect(useSummary({ inCode: [], listed: ['1'], total: 1, instances: 1, instanceRids: ['1'] })).toMatchObject({ headline: '1 object refers to this object.', notes: ['It is the template of 1 object.'] });
    // The reference scan does not return instances: they count on their own.
    expect(useSummary({ inCode: [], listed: [], total: 0, instances: 30, instanceRids: ['5'] })).toMatchObject({ found: true, headline: '30 objects refer to this object.' });
  });
});
