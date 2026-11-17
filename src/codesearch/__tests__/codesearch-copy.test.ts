// @vitest-environment happy-dom
/**
 * The code search window with a complete local copy: opening it, searching,
 * "Used in code", switching filters, leaving it open and opening it again
 * send nothing that reaches the server (no index sync, no live search, no
 * keep-alive port that would hold the change feed). The footer says when the
 * copy was made and offers Refresh and Remove copy; only Refresh asks the
 * worker to update it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IndexedObject } from '../../lib/code-index-store';

type Msg = { type: string; [k: string]: unknown };
const ENV = 'p1@https://bmp.test/W/';
const AT = new Date(2026, 10, 13, 14, 2).getTime();
const sent: Msg[] = [];
const listeners: Array<(m: Msg) => void> = [];
const connect = vi.fn(() => ({
  postMessage: () => {}, disconnect: () => {},
  onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} },
}));

const TARGET = { rid: '9100000000000000001', businessId: 'shared_rate', name: 'Shared rate', type: 'ExtendedExpression' };
const status = (more: Record<string, unknown> = {}) => ({
  environment: ENV, state: 'ready', syncedAt: AT, builtAt: AT, objects: 3, bytes: 90, pending: 0, version: 4, copy: true,
  roots: [{ key: 'expression', name: 'Expressions', objects: 3, done: true }], ...more,
});
let current = status();

/** Messages the worker answers by asking the server. */
const SERVER_BOUND = ['CODE_INDEX_SYNC', 'CODE_SEARCH_START', 'CODE_SEARCH_ROOTS', 'CODE_INDEX_ESTIMATE', 'CODE_SEARCH_SCOPE', 'CODE_SEARCH_CODE', 'CODE_SEARCH_RESOLVE', 'RESOLVE_CODE_REFS'];
const serverBound = () => sent.filter(m => SERVER_BOUND.includes(m.type));

const deliver = (m: Msg) => { for (const l of listeners) l(m); };
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await frame(); } await new Promise(r => setTimeout(r, 0)); };

async function open(): Promise<void> {
  document.body.innerHTML = '<div id="search-root"></div>';
  vi.resetModules();
  const { codeIndexStore } = await import('../../lib/code-index-store');
  const { refsOf } = await import('../../lib/code-index-sync');
  const obj = (rid: string, name: string, code: string): IndexedObject => ({
    env: ENV, rid, type: 'ExtendedExpression', name, businessId: name.toLowerCase().replace(/ /g, '_'), where: 'Expressions',
    stamp: 'Nov 1, 2026 10:00:00', len: code.length, code: { expression: code }, refs: refsOf({ expression: code }), root: 'expression',
  });
  await codeIndexStore().put([
    { ...obj(TARGET.rid, TARGET.name, '_rate := 0.2'), businessId: TARGET.businessId },
    obj('9100000000000000002', 'Uses lookup', `_r := lookup(${TARGET.rid}).calculate()\n_today := today`),
    obj('9100000000000000003', 'Uses name', '_r := t.shared_rate.calculate()\n_x := today + 1'),
  ]);
  await import('../codesearch');
  await settle();
}

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'test',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      connect,
      lastError: undefined,
      onMessage: { addListener: (fn: (m: Msg) => void) => { listeners.push(fn); } },
      sendMessage: vi.fn(async (m: Msg) => {
        sent.push(m);
        if (m.type === 'CODE_INDEX_GET_STATUS' || m.type === 'CODE_INDEX_SYNC') return { type: 'CODE_INDEX_STATUS', status: current };
        if (m.type === 'GET_CONNECTION_STATE') return { type: 'CONNECTION_STATE', state: { display: 'connected', environment: ENV } };
        if (m.type === 'RESOLVE_CODE_REFS') {
          const keys = m.keys as string[];
          return { type: 'CODE_REFS_RESULT', ok: true, environment: ENV, results: Object.fromEntries(keys.map(k => [k, k === `t.${TARGET.businessId}` ? { found: true, target: { rid: TARGET.rid, type: TARGET.type, name: TARGET.name, businessId: TARGET.businessId } } : { found: false }])) };
        }
        return undefined;
      }),
    },
  };
  await open();
});
afterAll(() => { vi.useRealTimers(); });

const input = () => document.querySelector<HTMLInputElement>('.cs-q')!;
async function typeSearch(text: string): Promise<void> {
  input().value = text;
  input().dispatchEvent(new Event('input'));
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
}
const shown = () => document.querySelectorAll('.cs-gh').length;
async function usedInCode(): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'CREV_FRAME_ACTIVATE', activation: { type: 'codesearch', mode: 'refs', target: TARGET } } }));
  await settle();
}

describe('a window with a complete copy', () => {
  it('opening it sends nothing to the server and holds no keep-alive port', () => {
    expect(serverBound()).toEqual([]);
    expect(sent.map(m => m.type)).toContain('CODE_INDEX_GET_STATUS');
    expect(connect).not.toHaveBeenCalled();
  });

  it('three searches, a filter change and 60 s idle send nothing', async () => {
    await typeSearch('today');
    expect(shown()).toBe(2);
    // The result line names the copy as the footer does.
    expect(document.querySelector('.cs-status .cov')?.textContent).toMatch(/^Searched 3 objects with code \(copy from 13 Nov, 14:02\) in \d+\.\d s\.$/);
    await typeSearch('0.2');
    expect(shown()).toBe(1);
    await typeSearch('calculate');
    expect(shown()).toBe(2);
    document.querySelector<HTMLButtonElement>('.cs-tg[aria-label="Match case"]')!.click();
    await settle();
    // Left open: focus comes and goes, a minute passes.
    vi.useFakeTimers();
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event('focus'));
    vi.useRealTimers();
    await settle();
    expect(serverBound()).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('"Used in code" sends nothing: the copy answers the name t.shared_rate itself', async () => {
    await usedInCode();
    expect(shown()).toBe(2);
    await usedInCode();
    expect(shown()).toBe(2);
    expect(serverBound()).toEqual([]);
  });

  it('the footer says when the copy was made and offers Refresh and Remove copy', async () => {
    const idx = () => document.querySelector('.cs-status .idx')?.textContent;
    const links = () => [...document.querySelectorAll<HTMLButtonElement>('.cs-status .facts button')];
    expect(idx()).toBe('Searching the copy from 13 Nov, 14:02.');
    expect(links().map(b => b.textContent)).toEqual(expect.arrayContaining(['Refresh', 'Remove copy']));
    // Refresh is the one thing that asks the worker to update the copy.
    links().find(b => b.textContent === 'Refresh')!.click();
    await settle();
    expect(sent.filter(m => m.type === 'CODE_INDEX_SYNC')).toEqual([expect.objectContaining({ user: true })]);
    // While it runs: progress and Stop; searches still use the copy.
    deliver({ type: 'CODE_INDEX_STATUS', status: status({ state: 'refreshing', progress: { phase: 'reading', read: 1, toRead: 3 } }) });
    await settle();
    expect(idx()).toBe('Refreshing the copy from 13 Nov, 14:02: 1 of 3 objects done… Searches use the copy until the refresh is done.');
    links().find(b => b.textContent === 'Stop')!.click();
    expect(sent.at(-1)?.type).toBe('CODE_INDEX_CANCEL');
    deliver({ type: 'CODE_INDEX_STATUS', status: status({ stopped: true }) });
    await settle();
    expect(idx()).toBe('Searching the copy from 13 Nov, 14:02. The refresh was stopped; the copy is unchanged.');
    const later = new Date(2026, 10, 13, 16, 30).getTime();
    deliver({ type: 'CODE_INDEX_STATUS', status: status({ syncedAt: later, version: 5 }) });
    await settle();
    // A refresh confirmed the copy as of its own time.
    expect(idx()).toBe('Searching the copy, checked 13 Nov, 16:30.');
  });

  it('closing and opening it again sends nothing to the server', async () => {
    sent.length = 0;
    connect.mockClear();
    current = status();
    await open();
    await typeSearch('today');
    expect(shown()).toBe(2);
    expect(serverBound()).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });
});
