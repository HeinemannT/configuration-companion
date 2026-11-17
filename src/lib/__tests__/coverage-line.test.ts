import { describe, expect, it } from 'vitest';
import { coverageText, timeOfDay } from '../coverage-line';
import { searchReportText } from '../object-search';
import { compareCoverage } from '../compare-model';
import { callsStatus } from '../../editor-core/code-links';

const NOON = new Date(2026, 10, 12, 14, 5).getTime();
const EARLIER = new Date(2026, 10, 12, 14, 2).getTime();

describe('coverageText', () => {
  it('says how many objects were searched, where, and when', () => {
    expect(coverageText({ kind: 'index', objects: 3025, at: EARLIER }, NOON)).toBe('Searched 3,025 objects in the copy from 12 Nov, 14:02.');
    expect(coverageText({ kind: 'live', objects: 3025, at: EARLIER }, NOON)).toBe('Searched 3,025 objects live at 14:02.');
    expect(coverageText({ kind: 'not-searched', reason: 'no index' })).toBe('Not searched: no index.');
  });

  it('names a search whose size the server does not tell', () => {
    expect(coverageText({ kind: 'live', objects: 0, what: 'the workspace', note: 'Also checked the objects you touched' }, NOON))
      .toBe('Searched the workspace live. Also checked the objects you touched.');
  });

  it('puts the date before the time on another day', () => {
    expect(timeOfDay(new Date(2026, 10, 10, 9, 7).getTime(), NOON)).toMatch(/9:07$|09:07$/);
    expect(timeOfDay(EARLIER, NOON)).toBe('14:02');
  });
});

describe('object search coverage', () => {
  it('names the index and the server search by name and ID', () => {
    expect(searchReportText({ index: { objects: 3025, at: EARLIER }, server: 'ok', portal: 'ok', at: NOON }, NOON))
      .toBe('Searched 3,025 objects in the copy from 12 Nov, 14:02. Searched the names and IDs of configuration and data objects on the server at 14:05.');
  });
  it('says what was not searched', () => {
    expect(searchReportText({ index: null, server: 'failed', portal: 'off', at: NOON }, NOON))
      .toBe('Not searched: no code copy on this computer. Not searched: the server search did not answer.');
    expect(searchReportText({ index: null, server: 'ok', portal: 'failed', at: NOON }, NOON))
      .toContain('Not searched: data objects, the portal search did not answer.');
  });
});

describe('Calls status', () => {
  it('states what was resolved and what was not', () => {
    expect(callsStatus({ total: 5, found: 3, notFound: 0, failed: 2, pending: 0 })).toBe('3 of 5 references resolved; 2 could not be read.');
    expect(callsStatus({ total: 2, found: 1, notFound: 1, failed: 0, pending: 0 })).toBe('1 of 2 references resolved; 1 not found.');
    expect(callsStatus({ total: 1, found: 1, notFound: 0, failed: 0, pending: 0 })).toBe('1 of 1 reference resolved.');
    expect(callsStatus({ total: 4, found: 0, notFound: 0, failed: 0, pending: 3 })).toBe('Looking up 3 of 4 references…');
  });
});

describe('Compare coverage', () => {
  const none = { a: [] as string[], b: [] as string[] };
  it('counts what was compared', () => {
    expect(compareCoverage({ total: 42, notComparable: none }, { total: 12, pending: 0 })).toEqual({ compared: '42 properties and 12 children compared.', left: '', complete: true });
  });
  it('names what was not compared', () => {
    const c = compareCoverage({ total: 1, notComparable: { a: ['x', 'y'], b: [] } }, { total: 12, pending: 2 },
      { a: { structureTruncatedAt: 5000 }, b: { structureError: 'timeout' } });
    expect(c.compared).toBe('1 property and 10 children compared.');
    expect(c.left).toBe('Not compared: 2 properties that exist on only one type; 2 children still being compared; children beyond the first 5,000 of A; the children of B (could not be listed).');
    expect(c.complete).toBe(false);
  });
});
