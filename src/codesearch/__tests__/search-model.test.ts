import { describe, expect, it } from 'vitest';
import type { CodeSearchHit } from '../../lib/code-search';
import {
  addRecent, checkedText, coverageText, dateTimeText, durationText, facetEntries, filterButtonText, filterWords, indexFacets, indexText, navRows, optionsText, parseRecents, propLabel,
  removeRecent, step, summaryText, toggle, topTypes, typeLabel, RECENTS_MAX, type RecentSearch,
} from '../search-model';

const hit = (rid: string, lines: number[]): CodeSearchHit => ({
  rid, type: 'ExtendedExpression', name: rid, businessId: rid, where: '', matches: lines.length,
  props: [{ prop: 'expression', lineCount: 10, around: [], lines: lines.map(l => ({ line: l, text: 'x', ranges: [[0, 1]] })) }],
});

describe('keyboard navigation over grouped results', () => {
  it('walks every shown match across objects, skipping collapsed objects', () => {
    const hits = [hit('1', [2, 4, 6, 8]), hit('2', [1])];
    const rows = navRows(hits, new Set(), new Set());
    expect(rows.map(r => r.key)).toEqual(['1:expression:2', '1:expression:4', '1:expression:6', '2:expression:1']);
    expect(navRows(hits, new Set(), new Set(['1'])).length).toBe(5);
    expect(navRows(hits, new Set(['1']), new Set()).map(r => r.key)).toEqual(['2:expression:1']);
    expect(step(rows, null, 1)).toBe('1:expression:2');
    expect(step(rows, '1:expression:6', 1)).toBe('2:expression:1');
    expect(step(rows, '2:expression:1', 1)).toBe('2:expression:1');
    expect(step(rows, '1:expression:2', -1)).toBe('1:expression:2');
  });
});

describe('recent searches', () => {
  const r = (query: string, extra: Partial<RecentSearch> = {}): RecentSearch => ({ mode: 'text', query, caseSensitive: true, wholeWord: false, regex: false, types: [], props: [], ...extra });
  it('keeps the newest first, without duplicates, bounded and clearable', () => {
    let list: RecentSearch[] = [];
    for (let i = 0; i < 12; i++) list = addRecent(list, r(`q${i}`));
    expect(list).toHaveLength(RECENTS_MAX);
    list = addRecent(list, r('q5'));
    expect(list[0].query).toBe('q5');
    expect(list.filter(x => x.query === 'q5')).toHaveLength(1);
    expect(addRecent(list, r('q5', { caseSensitive: false })).filter(x => x.query === 'q5')).toHaveLength(2);
    expect(removeRecent(list, r('q5')).some(x => x.query === 'q5')).toBe(false);
    expect(parseRecents([r('a'), { mode: 'refs', query: 'x' }, 7, null])).toEqual([r('a')]);
  });
});

describe('saved searches of the earlier version', () => {
  it('converts the old "Code of" groups to types and ignores unknown values', () => {
    const old = [
      { mode: 'text', query: 'a', caseSensitive: true, wholeWord: false, regex: false, codeOf: 'all' },
      { mode: 'text', query: 'b', caseSensitive: false, wholeWord: true, regex: false, codeOf: 'expr' },
      { mode: 'text', query: 'c', caseSensitive: true, wholeWord: false, regex: true, codeOf: 'actions' },
      { mode: 'text', query: 'd', caseSensitive: true, wholeWord: false, regex: false, codeOf: 'nonsense', types: 'x' },
      { mode: 'text', query: 'e', types: ['ExtendedTable', 7, 'bad name;'], props: ['showExpression'] },
    ];
    const got = parseRecents(old);
    expect(got.map(g => g.types)).toEqual([[], ['ExtendedExpression'], ['ActionButton', 'ButtonInput', 'Label'], [], ['ExtendedTable']]);
    expect(got.map(g => g.props)).toEqual([[], [], [], [], ['showExpression']]);
    expect(got.every(g => !('codeOf' in g))).toBe(true);
    expect(got[4]).toMatchObject({ caseSensitive: true, wholeWord: false, regex: false });
    expect(optionsText(got[2])).toBe('Everywhere · Action button +2 · pattern · match case');
    expect(optionsText({ ...got[4], props: ['showExpression', 'expression'] })).toBe('Everywhere · Extended table · Show expression +1 · match case');
  });
});

describe('filter menus', () => {
  it('lists every index key with the counts of the query, most first, chosen ones kept', () => {
    const entries = facetEntries(['ExtendedTable', 'ButtonInput', 'ExtendedMethodConfig'], { ButtonInput: 4, ExtendedTable: 9, CardPart: 2 }, ['ExtendedMethodConfig'], typeLabel);
    expect(entries.map(e => [e.key, e.label, e.n, e.on])).toEqual([
      ['ExtendedTable', 'Extended table', 9, false],
      ['ButtonInput', 'Button', 4, false],
      ['CardPart', 'Card part', 2, false],
      ['ExtendedMethodConfig', 'Extended method config', 0, true],
    ]);
    // The filter field matches labels and internal names.
    expect(facetEntries(['ButtonInput', 'ExtendedTable'], undefined, [], typeLabel, 'button').map(e => e.key)).toEqual(['ButtonInput']);
    expect(facetEntries(['ButtonInput'], undefined, [], typeLabel, 'buttoninput')[0]).toEqual({ key: 'ButtonInput', label: 'Button', on: false });
  });

  it('counts the index per type and per property that holds code', () => {
    expect(indexFacets([
      { type: 'ButtonInput', code: { expression: 'x', showExpression: '' } },
      { type: 'ButtonInput', code: { showExpression: 'y' } },
      { type: 'ExtendedTable', code: { expression: 'z' } },
    ])).toMatchObject({ types: { ButtonInput: 2, ExtendedTable: 1 }, props: { expression: 2, showExpression: 1 } });
  });

  it('names the choice and offers the top three types of the results', () => {
    expect(filterButtonText([], typeLabel, 'Any type')).toBe('Any type');
    expect(filterButtonText(['ActionButton', 'ButtonInput'], typeLabel, 'Any type')).toBe('Action button +1');
    expect(filterWords(['ActionButton', 'ButtonInput', 'Label'], typeLabel, 'any type')).toBe('Action button, Button or Label');
    expect(toggle(toggle([], 'a'), 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
    const by = { ExtendedTable: 235, ExtendedExpression: 140, ActionButton: 99, Label: 3 };
    expect(topTypes(by, []).map(t => `${t.label} ${t.n}`)).toEqual(['Extended table 235', 'Extended expression 140', 'Action button 99']);
    expect(topTypes(by, ['ExtendedTable'])).toEqual([]);
  });

  it('uses the object window labels for properties, else the name in words', () => {
    expect(['expression', 'showExpression', 'initExpression', 'destinationExpression', 'html', 'javascript', 'firstColorExpression', 'longText'].map(propLabel))
      .toEqual(['Expression', 'Show expression', 'Init expression', 'Destination expression', 'HTML', 'JavaScript', 'First color expression', 'Long text']);
    expect(['ExtendedTable', 'ButtonInput', 'ExtendedTransport', 'ExtendedMethodConfig', 'ExtendedExpression', 'NumberInput', 'InputView', ''].map(typeLabel))
      .toEqual(['Extended table', 'Button', 'Extended transport', 'Extended method config', 'Extended expression', 'Number input', 'Input view', 'Object']);
  });
});

describe('sentences', () => {
  it('says what was searched and how fresh the index is', () => {
    const today = new Date(2026, 10, 11, 14, 2).getTime();
    expect(coverageText({ source: 'index', searched: 3573, total: 3573, complete: true, indexedAt: today }, today, undefined, 40)).toBe('Searched 3,573 objects with code (copy from 11 Nov, 14:02) in 0.0 s.');
    // A refresh confirmed the copy at that time.
    expect(coverageText({ source: 'index', searched: 3573, total: 3573, complete: true, indexedAt: today, checked: true }, today, undefined, 40)).toBe('Searched 3,573 objects with code (copy checked 11 Nov, 14:02) in 0.0 s.');
    expect(coverageText({ source: 'index', searched: 1340, total: 3573, complete: false, pending: 2233 }, today)).toBe('Searched 1,340 of 3,573 objects with code: the copy is still being made.');
    expect(coverageText({ source: 'server', searched: 10, total: 12, complete: false, failedTypes: ['Label'] }, today, 'unavailable')).toBe('A copy cannot be made of this server. Searched 10 of 12 objects. No code changed on the server since the last search. Not searched: Label.');
    expect(coverageText({ source: 'server', searched: 12, total: 12, complete: true, read: 12 }, today, 'building')).toBe('The copy is still being made. Read 12 objects from the server. Kept while this window is open.');
  });

  it('says plainly what a search without an index did: read once, kept, matched here', () => {
    const today = new Date(2026, 10, 11, 14, 2).getTime();
    // First search: everything read from the server.
    expect(coverageText({ source: 'server', searched: 3025, total: 3025, complete: true, read: 3025 }, today, 'none', 1900)).toBe('Read 3,025 objects from the server in 1.9 s. Kept while this window is open.');
    // Later searches: the code kept from before, only changes read again.
    expect(coverageText({ source: 'server', searched: 3025, total: 3025, complete: true, read: 0 }, today, 'none', 300)).toBe('Searched 3,025 objects in 0.3 s. No code changed on the server since the last search.');
    expect(coverageText({ source: 'server', searched: 3025, total: 3025, complete: true, read: 4, readChanged: 4 }, today, 'none', 400)).toBe('Searched 3,025 objects in 0.4 s. 4 changed objects read again from the server; the rest was kept from the last search.');
    // A wider scope: the objects new to this search are not "changed".
    expect(coverageText({ source: 'server', searched: 3025, total: 3025, complete: true, read: 2323 }, today, 'none', 900)).toBe('Searched 3,025 objects in 0.9 s. 2,323 more objects read from the server; the rest was kept from the last search.');
    expect(coverageText({ source: 'server', searched: 3025, total: 3025, complete: true, read: 2327, readChanged: 4 }, today, 'none', 900)).toBe('Searched 3,025 objects in 0.9 s. 4 changed objects read again and 2,323 more read from the server; the rest was kept from the last search.');
    // Narrowed, everything kept: never "0 objects read".
    expect(coverageText({ source: 'server', searched: 90000, total: 90000, complete: true, read: 0, narrowed: true }, today, 'none', 300)).not.toContain(" 0 objects");
    // Too much code to read whole: the server picks the candidates first.
    expect(coverageText({ source: 'server', searched: 90000, total: 90000, complete: true, read: 37, narrowed: true }, today, 'none', 4100)).toBe('Searched 90,000 objects in 4.1 s. There is too much code to read it all, so the server first picked the objects that may match; 37 objects read from the server and matched here.');
    // A typed search a few seconds after the last: the listing was kept, so
    // the line says when the server was asked for changes.
    expect(coverageText({ source: 'server', searched: 3025, total: 3025, complete: true, read: 0, listingReused: true, checkedAt: today - 12_000 }, today, 'none', 80)).toBe('Searched 3,025 objects in 0.1 s. Checked for changes 12 s ago.');
    expect(coverageText({ source: 'server', searched: 3025, total: 3025, complete: true, read: 2, listingReused: true, checkedAt: today - 4_000 }, today, 'none', 200)).toBe('Searched 3,025 objects in 0.2 s. 2 more objects read from the server; the rest was kept from the last search. Checked for changes 4 s ago.');
    // A listing made for this search: no time, as before.
    expect(coverageText({ source: 'server', searched: 3025, total: 3025, complete: true, read: 0, checkedAt: today }, today, 'none', 300)).toBe('Searched 3,025 objects in 0.3 s. No code changed on the server since the last search.');
    expect(checkedText(today - 300, today)).toBe('Checked for changes just now.');
    expect(checkedText(today - 90_000, today)).toBe('Checked for changes at 14:00.');
    const none = indexText({ state: 'none', syncedAt: null, objects: 0, pending: 0 });
    expect(none).toBe('No copy on this computer. When you search, the code is read from the server once and kept while this window is open.');
    for (const s of [coverageText({ source: 'server', searched: 1, total: 1, complete: true, read: 1 }, today, 'none'), none]) expect(s).not.toMatch(/\blive\b|instant/i);
    expect(indexText({ state: 'ready', syncedAt: today, objects: 3573, pending: 0, codeTypes: 40, last: { changed: 3, removed: 0 }, notCovered: ['Label (object list failed)'] }, today)).toBe('Searching the copy from 11 Nov, 14:02: 3,573 objects with code in 40 object types, 3 objects changed since the previous refresh. Not searched: Label (object list failed).');
    // A copy: the date it was made or last refreshed is the whole statement,
    // however old it is.
    for (const at of [today, today - 4_000, today - 40 * 86_400_000]) {
      const line = indexText({ state: 'ready', syncedAt: at, objects: 1632, pending: 0, codeTypes: 41, copy: true }, today);
      expect(line).toBe(`Searching the copy from ${dateTimeText(at, today)}.`);
      expect(line).not.toMatch(/current|checked|outdated|old|stale|ago/i);
    }
    // Built, then refreshed: the refresh's time says the copy was checked then.
    const built = today - 3 * 3_600_000;
    expect(indexText({ state: 'ready', syncedAt: built, builtAt: built, objects: 1632, pending: 0, copy: true }, today)).toBe('Searching the copy from 11 Nov, 11:02.');
    expect(indexText({ state: 'ready', syncedAt: today, builtAt: built, objects: 1632, pending: 0, copy: true }, today)).toBe('Searching the copy, checked 11 Nov, 14:02.');
    expect(indexText({ state: 'refreshing', syncedAt: today, builtAt: built, objects: 1632, pending: 0, copy: true }, today)).toBe('Refreshing the copy, checked 11 Nov, 14:02: asking the server what changed… Searches use the copy until the refresh is done.');
    // Stopped while still listing: nothing to count.
    expect(indexText({ state: 'paused', syncedAt: null, objects: 0, pending: 0, copy: true }, today)).toBe('Copying stopped before anything was read. Searches read the server meanwhile.');
    expect(dateTimeText(today, today)).toBe('11 Nov, 14:02');
    expect(dateTimeText(new Date(2025, 0, 3, 9, 5).getTime(), today)).toBe('3 Jan 2025, 09:05');
    // A refresh under way: what it does, step by step.
    const refreshing = { state: 'refreshing', syncedAt: today, objects: 1632, pending: 0, copy: true };
    expect(indexText(refreshing, today)).toBe('Refreshing the copy from 11 Nov, 14:02: asking the server what changed… Searches use the copy until the refresh is done.');
    expect(indexText({ ...refreshing, progress: { phase: 'listing', read: 0, toRead: 0 } }, today)).toBe('Refreshing the copy from 11 Nov, 14:02: listing the code on the server… Searches use the copy until the refresh is done.');
    expect(indexText({ ...refreshing, progress: { phase: 'reading', read: 1600, toRead: 1632 } }, today)).toBe('Refreshing the copy from 11 Nov, 14:02: 1,600 of 1,632 objects done… Searches use the copy until the refresh is done.');
    // A stopped or failed refresh: the copy and its date are unchanged.
    expect(indexText({ state: 'ready', syncedAt: today, objects: 1632, pending: 0, copy: true, stopped: true }, today)).toBe('Searching the copy from 11 Nov, 14:02. The refresh was stopped; the copy is unchanged.');
    expect(indexText({ state: 'ready', syncedAt: today, objects: 1632, pending: 0, copy: true, error: 'Not connected.' }, today)).toBe('Searching the copy from 11 Nov, 14:02. The refresh failed: Not connected. The copy is unchanged.');
    expect(durationText(40)).toBe('40 s');
    expect(durationText(170)).toBe('3 min');
    expect(durationText(4_200)).toBe('1 h 10 min');
    expect(indexText({ state: 'paused', syncedAt: null, objects: 3573, pending: 2173, progress: { read: 1400, toRead: 3573 } })).toBe('Copying stopped: 1,400 of 3,573 objects read. Resume continues it; searches read the server meanwhile.');
    expect(indexText({ state: 'failed', syncedAt: null, objects: 0, pending: 0, error: 'timed out' })).toBe('The copy could not be made: timed out. Searches read the server.');
    expect(indexText({ state: 'building', syncedAt: null, objects: 0, pending: 0, progress: { read: 400, toRead: 3573 } })).toBe('Making the copy: 400 of 3,573 objects read.');
    // A read of the whole server: its roots are done only at the end, so it counts objects.
    const undone = [{ key: 'portal', name: 'Portal', done: false }, { key: 'page', name: 'Page', done: false }];
    expect(indexText({ state: 'building', syncedAt: null, objects: 0, pending: 0, roots: undone, progress: { read: 400, toRead: 3573 } })).toBe('Making the copy: 400 of 3,573 objects read.');
    expect(summaryText({ matchedObjects: 4, matches: 6, lines: 5, byType: {}, typeCounts: {}, propCounts: {}, kindCounts: {}, whereCounts: {}, rows: 4, more: false, ms: 1, coverage: { source: 'index', searched: 1, total: 1, complete: true } }, 'refs')).toBe('6 places on 5 lines in 4 objects');
  });
});
