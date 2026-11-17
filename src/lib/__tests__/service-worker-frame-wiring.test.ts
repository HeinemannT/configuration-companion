/**
 * service-worker.ts wires the frame record's clean-up to the tab events: a
 * tab that starts loading a new page, or closes, drops what its object
 * windows were served (sender-trust.ts). The worker module is imported for
 * real against a chrome stub that records every listener.
 */
import { describe, expect, it, vi } from 'vitest';

// The frame clean-up is wired by the worker itself (sender-trust's
// watchFrameTabs); the message router and its handlers are not part of it,
// and loading them took seconds per run.
vi.mock('../message-router', () => ({
  handleContentMessage: vi.fn(), handlePanelMessage: vi.fn(), handleOneShotMessage: vi.fn(),
  toggleInspect: vi.fn(), toggleBlueprint: vi.fn(),
}));

type Listener = (...args: unknown[]) => unknown;

/** A chrome stub: every member is callable and answers undefined (or a
 *  resolved promise); every `addListener` is recorded per event path. */
function chromeStub(listeners: Map<string, Listener[]>, store: Record<string, unknown>): unknown {
  const make = (path: string): unknown => new Proxy(function () { /* stub */ }, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'addListener') return (fn: Listener) => { listeners.set(path, [...(listeners.get(path) ?? []), fn]); };
      if (path === 'runtime' && prop === 'id') return 'test';
      if (path === 'runtime' && prop === 'getURL') return (p: string) => `chrome-extension://test/${p}`;
      if (path === 'runtime' && prop === 'lastError') return undefined;
      if (path === 'storage.session' && prop === 'get') return async (k: string) => (typeof k === 'string' ? { [k]: store[k] } : {});
      if (path === 'storage.session' && prop === 'set') return async (o: Record<string, unknown>) => { Object.assign(store, o); };
      return make(path ? `${path}.${prop}` : prop);
    },
    apply(_t, _this, args) {
      const cb = args.find(a => typeof a === 'function') as Listener | undefined;
      if (cb && !path.endsWith('addListener')) { try { cb(undefined); } catch { /* stub */ } }
      return Promise.resolve(undefined);
    },
  });
  return make('');
}

describe('service-worker.ts frame record wiring', () => {
  it('drops a tab\'s frame records when the tab starts loading a new page or closes', async () => {
    vi.resetModules();
    const listeners = new Map<string, Listener[]>();
    const store: Record<string, unknown> = {};
    (globalThis as { chrome?: unknown }).chrome = chromeStub(listeners, store);
    vi.stubGlobal('self', { addEventListener: () => { /* stub */ } });
    const trust = await import('../sender-trust');
    await import('../../service-worker');
    const updated = listeners.get('tabs.onUpdated') ?? [];
    const removed = listeners.get('tabs.onRemoved') ?? [];
    expect(updated.length).toBeGreaterThan(0);
    const OW = 'chrome-extension://test/objectview/window.html#1';
    const win = { tabId: 7, frameId: 3, documentId: 'doc', url: OW };
    await trust.noteFrameServed(win, 'p1@x', ['7000000000000000001']);
    // A finished load or a title change keeps the record.
    for (const fn of updated) fn(7, { status: 'complete' }, {});
    for (const fn of updated) fn(7, { title: 'x' }, {});
    await new Promise(r => setTimeout(r, 0));
    expect(await trust.frameMayWrite(win, 'p1@x', '7000000000000000001')).toBe(true);
    // A new page in the tab drops it; another tab is untouched.
    await trust.noteFrameServed({ ...win, tabId: 8 }, 'p1@x', ['7000000000000000002']);
    for (const fn of updated) fn(7, { status: 'loading' }, {});
    await new Promise(r => setTimeout(r, 0));
    expect(await trust.frameMayWrite(win, 'p1@x', '7000000000000000001')).toBe(false);
    expect(await trust.frameMayWrite({ ...win, tabId: 8 }, 'p1@x', '7000000000000000002')).toBe(true);
    // Closing the tab drops it too.
    for (const fn of removed) fn(8, {});
    await new Promise(r => setTimeout(r, 0));
    expect(await trust.frameMayWrite({ ...win, tabId: 8 }, 'p1@x', '7000000000000000002')).toBe(false);
  });
});
