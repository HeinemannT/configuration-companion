/**
 * Page info is refreshed only for something that shows it. With no side
 * panel and no Inspect in the tab's window, a render or a navigation sends
 * nothing to the page (no widget scan, no walk over the page's components,
 * no identity read); the tab's page context is marked stale, and a reader
 * that needs it later (the editor's EC `this`) asks the page once for the
 * page context only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHandler, type HandlerMeta } from '../handler-registry';
import { setSwContext, type SwContext } from '../sw-context';
import { clearAllContextRids, pageContextIsCurrent, setPageContext } from '../context-rid';
import { resolveTabPageContext } from '../page-context-resolver';
import '../handlers/detection';

const TAB = 7;
const WIN = 3;
let sent: Array<{ tabId: number; type: string }>;
let panels: Map<number, unknown>;
let inspect: boolean;

beforeEach(() => {
  sent = [];
  panels = new Map();
  inspect = false;
  clearAllContextRids();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { lastError: null },
    tabs: {
      get: vi.fn((id: number, cb?: (t: chrome.tabs.Tab) => void) => {
        const tab = { id, windowId: WIN, url: 'https://bmp.test/W/' } as chrome.tabs.Tab;
        if (cb) { cb(tab); return undefined; }
        return Promise.resolve(tab);
      }),
      query: vi.fn((_q: unknown, cb: (t: chrome.tabs.Tab[]) => void) => cb([{ id: TAB, windowId: WIN } as chrome.tabs.Tab])),
      sendMessage: vi.fn((tabId: number, m: { type: string }, cb?: (r: unknown) => void) => {
        sent.push({ tabId, type: m.type });
        const reply = m.type === 'GET_PAGE_CONTEXT' ? { type: 'PAGE_CONTEXT', rid: '726548820039520945', tabRid: '8331448214407565939' } : { type: 'PAGE_INFO', url: '', widgets: [] };
        if (cb) { cb(reply); return undefined; }
        return Promise.resolve(reply);
      }),
    },
  };
  const ctx = {
    panelPortByWindow: panels,
    contentPorts: new Map([[TAB, {}]]),
    isInspectActive: () => inspect,
    sendToPanelByTab: vi.fn(), sendToPanelByWindow: vi.fn(), sendToPanel: vi.fn(),
    cache: { get: () => ({ name: 'x', type: 'Scorecard', businessId: 'x' }) },
    client: null,
  } as unknown as SwContext;
  setSwContext(ctx);
});
afterEach(() => { delete (globalThis as { chrome?: unknown }).chrome; });

const meta = { senderTabId: TAB } as HandlerMeta;
const run = async (type: string, msg: Record<string, unknown> = {}) => {
  await getHandler(type)!({ type, ...msg } as never, () => {}, meta);
  await new Promise(r => setTimeout(r, 0));
};

describe('page info on demand', () => {
  it('sends nothing to the page for renders and navigations while nothing shows it', async () => {
    for (let i = 0; i < 5; i++) {
      await run('BMP_PAGE_RENDER_CHANGED');
      await run('BMP_URL_CHANGED');
      await run('PAGE_CONTEXT', { rid: `72654882003952094${i}` });
    }
    expect(sent).toEqual([]);
  });

  it('refreshes as before for an open panel or Inspect in the window', async () => {
    panels.set(WIN, {});
    await run('BMP_PAGE_RENDER_CHANGED');
    expect(sent.filter(s => s.type === 'GET_PAGE_INFO')).toHaveLength(1);
    panels.clear();
    inspect = true;
    await run('BMP_URL_CHANGED');
    expect(sent.filter(s => s.type === 'GET_PAGE_INFO')).toHaveLength(2);
  });

  it('a later reader asks the page once for its bound object (context only)', async () => {
    setPageContext(TAB, { rid: '1111111111111111111' });
    await run('BMP_PAGE_RENDER_CHANGED');
    expect(pageContextIsCurrent(TAB)).toBe(false);
    const pc = await resolveTabPageContext(TAB);
    expect(pc.rid).toBe('726548820039520945');
    expect(sent).toEqual([{ tabId: TAB, type: 'GET_PAGE_CONTEXT' }]);
    // Current now: the next reader asks nothing.
    await resolveTabPageContext(TAB);
    expect(sent).toHaveLength(1);
  });
});
