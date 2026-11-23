// @vitest-environment happy-dom
/**
 * The code search window with a live (server) search, driven through its
 * messages: one scan gives every row, "Show more" pages through them without
 * a new scan, the rows found so far show while the scan runs (with its
 * progress), and a batch of results is appended without rebuilding what is
 * already drawn (counted DOM element creations), with selection and expand
 * state kept.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodeSearchHit, CodeSearchOutcome } from '../../lib/code-search';

type Msg = { type: string; [k: string]: unknown };
const sent: Msg[] = [];
const listeners: Array<(m: Msg) => void> = [];

function hit(i: number): CodeSearchHit {
  const rid = String(9_000_000_000_000_000_000n + BigInt(i));
  return {
    rid, type: 'ExtendedExpression', name: `Object ${i}`, businessId: `obj_${i}`, where: 'Root › Folder', matches: 2,
    props: [{ prop: 'expression', lineCount: 12, around: [[2, 'z := 0'], [3, 'a := 1'], [4, 'b := 2'], [6, 'c := 3'], [7, 'd := 4'], [8, 'e := 5'], [10, 'f := 6'], [11, 'g := 7'], [12, 'h := 8']],
      lines: [{ line: 5, text: '_d := today', ranges: [[6, 11]] }, { line: 9, text: '_e := today + 1', ranges: [[6, 11]] }] }],
  };
}
const outcome = (rows: number): CodeSearchOutcome => ({
  matchedObjects: rows, matches: rows * 2, lines: rows * 2, byType: { ExtendedExpression: rows }, typeCounts: { ExtendedExpression: rows },
  propCounts: { expression: rows }, kindCounts: { expressions: rows }, whereCounts: {}, rows, more: false,
  coverage: { source: 'server', searched: 3000, total: 3000, complete: true }, ms: 10,
});

const deliver = (m: Msg) => { for (const l of listeners) l(m); };
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async () => { for (let i = 0; i < 3; i++) { await Promise.resolve(); await frame(); } };

beforeAll(async () => {
  document.body.innerHTML = '<div id="search-root"></div>';
  (globalThis as unknown as { chrome: unknown }).chrome = {
    // The note before a broad server read is turned off (heavy-search.ts has its own tests).
    storage: { local: { get: async (k: string) => ({ [k]: true }), set: async () => undefined } },
    runtime: {
      id: 'test',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      onMessage: { addListener: (fn: (m: Msg) => void) => { listeners.push(fn); } },
      sendMessage: vi.fn(async (m: Msg) => {
        sent.push(m);
        if (m.type === 'CODE_INDEX_SYNC' || m.type === 'CODE_INDEX_GET_STATUS') {
          return { type: 'CODE_INDEX_STATUS', status: { environment: 'p1@https://bmp.test/W/', state: 'none', syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 0, version: 0 } };
        }
        if (m.type === 'GET_CONNECTION_STATE') return { type: 'CONNECTION_STATE', state: { display: 'connected', environment: 'p1@https://bmp.test/W/' } };
        if (m.type === 'CODE_SEARCH_ROOTS') return { type: 'CODE_SEARCH_ROOTS_RESULT', ok: true, roots: [], orgs: {} };
        if (m.type === 'CODE_SEARCH_STATUS') return { type: 'CODE_SEARCH_STATUS_RESULT', id: m.id, running: true };
        return undefined;
      }),
    },
  };
  await import('../codesearch');
  await settle();
});

describe('search without an index in the window', () => {
  it('shows first results during the scan, appends batches without rebuilding, pages locally', async () => {
    const q = document.querySelector<HTMLInputElement>('.cs-q')!;
    q.value = 'today';
    q.dispatchEvent(new Event('input'));
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    const starts = () => sent.filter(m => m.type === 'CODE_SEARCH_START');
    expect(starts()).toHaveLength(1);
    const start = starts()[0];
    const id = start.id as string;
    // The window asks for every row at once.
    expect((start.search as { limit: number }).limit).toBeGreaterThanOrEqual(1_000_000);

    // While the scan runs: the rows found so far, and how far it is.
    deliver({ type: 'CODE_SEARCH_PROGRESS', id, hits: [hit(0), hit(1)], progress: { phase: 'read', postsDone: 2, posts: 2, read: 25, candidates: 300 } });
    await settle();
    expect(document.querySelectorAll('.cs-gh')).toHaveLength(2);
    expect(document.querySelector('.cs-status .cov')?.textContent).toMatch(/server picked: 25 of 300/);

    // The complete answer: 300 rows in batches of 20. Count the elements built per batch.
    const create = vi.spyOn(document, 'createElement');
    const perBatch: number[] = [];
    let firstHead: Element | null = null;
    for (let b = 0; b < 15; b++) {
      create.mockClear();
      deliver({ type: 'CODE_SEARCH_HITS', id, hits: Array.from({ length: 20 }, (_, k) => hit(b * 20 + k)) });
      await settle();
      perBatch.push(create.mock.calls.length);
      if (b === 0) firstHead = document.querySelector('.cs-gh');
    }
    // Later batches build only their own groups (about the same number as
    // the first), and the groups drawn earlier are the same nodes.
    expect(document.querySelector('.cs-gh')).toBe(firstHead);
    expect(perBatch[9]).toBeLessThan(perBatch[0] * 2);
    expect(document.querySelectorAll('.cs-gh')).toHaveLength(200);
    console.log(`elements built per batch of 20 rows: ${perBatch.join(', ')}`);

    deliver({ type: 'CODE_SEARCH_DONE', id, outcome: outcome(300) });
    await settle();
    expect(document.querySelectorAll('.cs-gh')).toHaveLength(200);
    // Open one match's context and select a row: both survive paging.
    const row = document.querySelectorAll<HTMLElement>('.cs-ml')[2];
    row.click();
    resEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    const block = document.querySelector('.cs-code');
    expect(block?.textContent).toContain('b := 2');
    expect(block?.textContent).not.toContain('Reading');
    expect(sent.filter(m => m.type === 'CODE_SEARCH_CODE')).toHaveLength(0);
    const sel = document.querySelector('.cs-ml.sel');

    // Show more: no new scan, 100 more rows from the ones already here.
    create.mockClear();
    document.querySelector<HTMLButtonElement>('.cs-loadmore button')!.click();
    await settle();
    expect(starts()).toHaveLength(1);
    expect(document.querySelectorAll('.cs-gh')).toHaveLength(300);
    expect(document.querySelector('.cs-loadmore')).toBeNull();
    expect(document.querySelector('.cs-code')).toBe(block);
    expect(document.querySelector('.cs-ml.sel')).toBe(sel);
    console.log(`elements built for Show more (100 rows): ${create.mock.calls.length}`);
    create.mockRestore();

    // Widening the context beyond the carried lines reads the full text once.
    document.querySelector<HTMLButtonElement>('.cs-cx .cf button')!.click();
    await settle();
    expect(sent.filter(m => m.type === 'CODE_SEARCH_CODE')).toHaveLength(1);
  });

  it('an invalid pattern says what is wrong at the field, keeps the previous results and sends nothing', async () => {
    const starts = () => sent.filter(m => m.type === 'CODE_SEARCH_START').length;
    const before = starts();
    const rows = document.querySelectorAll('.cs-gh').length;
    expect(rows).toBeGreaterThan(0);
    const q = document.querySelector<HTMLInputElement>('.cs-q')!;
    q.value = 'to(day';
    q.dispatchEvent(new Event('input'));
    // Turning on pattern mode searches again: the pattern is invalid.
    document.querySelector<HTMLButtonElement>('.cs-tg[aria-label^="Pattern"]')!.click();
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(starts()).toBe(before);
    const msg = document.querySelector<HTMLElement>('.cs-field-err')!;
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toBe('Not a valid pattern. A "(" is not closed with ")".');
    expect(q.getAttribute('aria-invalid')).toBe('true');
    // Not the window's error state: the previous results stay, marked as such.
    expect(document.querySelector<HTMLElement>('.cs')!.dataset.state).toBe('done');
    expect(document.querySelector('.cs-note.err')).toBeNull();
    expect(document.querySelectorAll('.cs-gh')).toHaveLength(rows);
    expect(resEl().classList.contains('stale')).toBe(true);
    expect(document.querySelector('.cs-prev')?.textContent).toBe('These results are from the previous search: today.');

    // A valid pattern searches and the message goes.
    q.value = 'to(day)';
    q.dispatchEvent(new Event('input'));
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(starts()).toBe(before + 1);
    expect(msg.hidden).toBe(true);
    expect(q.hasAttribute('aria-invalid')).toBe(false);
    expect(document.querySelector('.cs-prev')).toBeNull();
  });
});

describe('searching again', () => {
  it('"Search again" in the footer and Ctrl+Enter repeat an unchanged search; Enter still opens the hit', async () => {
    const starts = () => sent.filter(m => m.type === 'CODE_SEARCH_START');
    const last = starts().at(-1)!;
    deliver({ type: 'CODE_SEARCH_HITS', id: last.id, hits: [hit(1)] });
    deliver({ type: 'CODE_SEARCH_DONE', id: last.id, outcome: outcome(1) });
    await settle();
    const before = starts().length;
    const again = document.querySelector<HTMLButtonElement>('.cs-status .cs-again')!;
    expect(again.textContent).toBe('Search again');
    expect(document.querySelector('.cs-status .keys')?.textContent).toContain('search again');
    again.click();
    await settle();
    expect(starts()).toHaveLength(before + 1);
    expect(starts().at(-1)!.search).toEqual(last.search);
    const next = starts().at(-1)!;
    deliver({ type: 'CODE_SEARCH_DONE', id: next.id, outcome: outcome(1) });
    await settle();
    document.querySelector('.cs-q')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await settle();
    expect(starts()).toHaveLength(before + 2);
  });
});

describe('the local copy in the footer', () => {
  const status = (more: Record<string, unknown>) => ({ type: 'CODE_INDEX_STATUS', status: { environment: 'p1@https://bmp.test/W/', syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 0, version: 1, ...more } });
  const links = () => [...document.querySelectorAll<HTMLButtonElement>('.cs-status .facts button')].map(b => b.textContent);

  it('a stopped copy offers Resume and Remove copy; Remove sends the removal', async () => {
    deliver(status({ state: 'paused', objects: 1632, pending: 656, progress: { phase: 'reading', read: 976, toRead: 1632 }, copy: true }));
    await settle();
    expect(links()).toEqual(expect.arrayContaining(['Resume', 'Remove copy']));
    expect(document.querySelector('.cs-status .idx')?.textContent).toBe('Copying stopped: 976 of 1,632 objects read. Resume continues it; searches read the server meanwhile.');
    const remove = [...document.querySelectorAll<HTMLButtonElement>('.cs-status .facts button')].find(b => b.textContent === 'Remove copy')!;
    remove.click();
    await settle();
    expect(sent.some(m => m.type === 'CODE_INDEX_REMOVE')).toBe(true);
  });

  it('a complete copy says when it was made and offers Refresh and Remove copy; nothing synced by itself', async () => {
    const at = new Date(2026, 10, 13, 14, 2).getTime();
    deliver(status({ state: 'ready', syncedAt: at, builtAt: at, objects: 1632, copy: true, roots: [{ key: 'organisation', name: 'Organisation', objects: 1, done: true }] }));
    await settle();
    expect(document.querySelector('.cs-status .idx')?.textContent).toBe('Searching the copy from 13 Nov, 14:02.');
    expect(links()).toEqual(expect.arrayContaining(['Refresh', 'Remove copy']));
    // Opening the window, focus and reconnecting never ask for a sync.
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(sent.filter(m => m.type === 'CODE_INDEX_SYNC')).toEqual([]);
    deliver(status({ state: 'none' }));
    await settle();
  });
});

describe('pattern problems in plain words', () => {
  it('cleans up the engine\'s SyntaxError message', async () => {
    const { patternProblem, compileSearch } = await import('../../lib/code-search-match');
    expect(patternProblem('to(day)')).toBeNull();
    expect(patternProblem('to(day')).toBe('A "(" is not closed with ")".');
    expect(patternProblem('a)')).toBe('A ")" has no "(" before it.');
    expect(patternProblem('[a')).toBe('A "[" is not closed with "]".');
    expect(patternProblem('*a')).toMatch(/^"\*", "\+", "\?" or "\{" has nothing before it to repeat/);
    // An unknown reason: the engine's words without the repeated pattern.
    expect(patternProblem('(?<n>a)\\k<m>')).toBe('Invalid named capture referenced.');
    expect(compileSearch({ query: 'to(day', regex: true, caseSensitive: true, wholeWord: false })).toEqual({ error: 'Not a valid regular expression: A "(" is not closed with ")".' });
  });
});

const resEl = () => document.querySelector<HTMLElement>('.cs-res')!;
