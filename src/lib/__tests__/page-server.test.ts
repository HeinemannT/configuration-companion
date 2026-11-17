/**
 * Item 6: with two windows on two servers, a page's requests run against its
 * own server; window focus changes only what that window shows.
 * Item 10: /health 404 or non-JSON 200 is not proof of a workspace.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { warmServiceWorkerGraph } from './warm-imports';

// The router and every handler, once, before the tests (busy machines).
warmServiceWorkerGraph(mockChromeStorage);
import { ObjectCache } from '../object-cache';
import type { ServerProfile } from '../types';

const A: ServerProfile = { id: 'a', label: 'Server A', bmpUrl: 'https://a.test/Ws/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' };
const B: ServerProfile = { id: 'b', label: 'Server B', bmpUrl: 'https://b.test/Ws/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' };

async function harness(front: { id: number; url: string; windowId: number }) {
  vi.resetModules();
  vi.restoreAllMocks();
  mockChromeStorage();
  vi.stubGlobal('navigator', { onLine: true });
  // No portal answers: the background identity probe fails as for an
  // unreachable host. These tests are about routing.
  globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
  let focusListener: ((windowId: number) => void) | null = null;
  const tabsByWindow = new Map<number, { id: number; url: string }>([[1, { id: 11, url: 'https://a.test/Ws/?rid=1' }], [2, { id: 22, url: 'https://b.test/Ws/?rid=2' }]]);
  Object.assign(globalThis.chrome as any, {
    tabs: {
      query: vi.fn(async (q: { windowId?: number; lastFocusedWindow?: boolean }) => {
        if (q.lastFocusedWindow) return [front];
        const t = q.windowId != null ? tabsByWindow.get(q.windowId) : undefined;
        return t ? [t] : [];
      }),
      onActivated: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() },
      get: vi.fn(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener: vi.fn((fn: (id: number) => void) => { focusListener = fn; }) },
      onRemoved: { addListener: vi.fn() },
    },
  });
  const bmp = await import('../bmp-client');
  vi.spyOn(bmp.BmpClient, 'checkHealth').mockResolvedValue({ up: true, reachable: true, responseMs: 4 });
  vi.spyOn(bmp.BmpClient, 'getBuildNumber').mockResolvedValue({ status: 'unavailable' });
  vi.spyOn(bmp.BmpClient.prototype, 'testConnection').mockResolvedValue({ ok: true, message: 'ok', authenticated: true });
  const store = () => ({ switchProfile: vi.fn(async () => {}), clear: vi.fn(), load: vi.fn() });
  const ctx: any = {
    client: null, hasPanel: false, panelPortByWindow: new Map(), contentPorts: new Map(), cache: new ObjectCache(),
    history: store(), favorites: store(), scriptHistory: store(), stylePresets: store(),
    settings: { schemaVersion: 4, profiles: [A, B], activeProfileId: 'a', autoDetect: true, saveTarget: 'instance', enrichMode: 'all' },
    blueprintActiveByWindow: new Map(), blueprintTabByWindow: new Map(), persistBlueprintState: vi.fn(),
    settingsReady: Promise.resolve(), logActivity: vi.fn(), sendToPanel: vi.fn(), sendToPanelByWindow: vi.fn(),
    sendToPanelByTab: vi.fn(), broadcastToContent: vi.fn(), toast: vi.fn(),
  };
  const scope = await import('../profile-scope');
  ctx.scopeFor = (id: string) => scope.scopeFor(id)?.ctx ?? null;
  ctx.boundForTab = (tabId: number) => scope.boundForTab(tabId);
  ctx.boundContexts = () => scope.liveScopes().map(s => s.ctx);
  (await import('../sw-context')).setSwContext(ctx);
  const settings = await import('../settings');
  await settings.loadSettingsFrom(undefined);
  (chrome.storage.local.set as any).mockClear();
  const registry = await import('../handler-registry');
  const router = await import('../message-router');
  const handled: Array<string | undefined> = [];
  registry.register('OBJECTS_DISCOVERED', (_msg, _respond, meta) => { handled.push(meta.ctx?.profileId); });
  const tabs = await import('../tab-awareness');
  tabs.registerTabListeners();
  return { ctx, router, handled, focus: (id: number) => focusListener!(id), tabs, scope };
}

describe('page requests stay on the page’s server', () => {
  it('answers a background window’s page from its own server, without switching anything', async () => {
    // Window 1 (server A) is in front; window 2 shows a page on server B.
    const h = await harness({ id: 11, url: 'https://a.test/Ws/?rid=1', windowId: 1 });
    h.scope.noteTabUrl(22, 'https://b.test/Ws/?rid=2');
    h.scope.noteTabUrl(11, 'https://a.test/Ws/?rid=1');
    await h.router.handleContentMessage({ type: 'OBJECTS_DISCOVERED', objects: [] }, 22, undefined);
    await h.router.handleContentMessage({ type: 'OBJECTS_DISCOVERED', objects: [] }, 11, undefined);
    await vi.waitFor(() => expect(h.handled).toHaveLength(2));
    expect(h.handled).toEqual(['b', 'a']);
    expect(h.ctx.settings.activeProfileId).toBe('a');
  });

  it('answers empty badge enrichment to a page Companion is not set up for', async () => {
    const h = await harness({ id: 11, url: 'https://a.test/Ws/?rid=1', windowId: 1 });
    const port = { postMessage: vi.fn() };
    h.ctx.contentPorts.set(33, port);
    await h.router.handleContentMessage({ type: 'ENRICH_BADGES', rids: ['1'] }, 33, 'https://c.test/Other/?rid=2');
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'BADGE_ENRICHMENT', enrichments: { 1: {} } });
  });

  it('does not block page facts such as detection results', async () => {
    const h = await harness({ id: 11, url: 'https://a.test/Ws/?rid=1', windowId: 1 });
    const registry = await import('../handler-registry');
    const seen = vi.fn();
    registry.register('DETECTION_RESULT', seen);
    await h.router.handleContentMessage({ type: 'DETECTION_RESULT', confidence: 1, signals: [], isBmp: true } as any, 33, 'https://c.test/Other/');
    expect(seen).toHaveBeenCalled();
  });

  it('refuses a message a content script may not send, and logs it once', async () => {
    const h = await harness({ id: 11, url: 'https://a.test/Ws/?rid=1', windowId: 1 });
    await h.router.handleContentMessage({ type: 'SET_ACTIVE_PROFILE', profileId: 'b' }, 11, 'https://a.test/Ws/?rid=1');
    await h.router.handleContentMessage({ type: 'SET_ACTIVE_PROFILE', profileId: 'b' }, 11, 'https://a.test/Ws/?rid=1');
    expect(h.ctx.settings.activeProfileId).toBe('a');
    const refusals = h.ctx.logActivity.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith('Refused SET_ACTIVE_PROFILE'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0][3]).toMatchObject({ category: 'system', action: 'message-refused' });
  });
});

describe('window focus changes only what that window shows', () => {
  it('follows the focused window’s active tab in that window only', async () => {
    const h = await harness({ id: 11, url: 'https://a.test/Ws/?rid=1', windowId: 1 });
    await h.tabs.handleWindowFocus(2);
    expect(h.scope.displayProfileOf(2)).toBe('b');
    await h.tabs.handleWindowFocus(1);
    expect(h.scope.displayProfileOf(1)).toBe('a');
    expect(h.scope.displayProfileOf(2)).toBe('b');
    // The last profile picked by hand is not rewritten by focus.
    expect(h.ctx.settings.activeProfileId).toBe('a');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('registers a focus listener that ignores "no window focused"', async () => {
    const h = await harness({ id: 11, url: 'https://a.test/Ws/?rid=1', windowId: 1 });
    h.focus(-1);
    await new Promise(r => setTimeout(r, 10));
    expect(h.ctx.settings.activeProfileId).toBe('a');
  });
});

describe('BmpClient.checkHealth workspace detection', () => {
  async function check(responses: Record<string, { status: number; body: string; type?: string }>) {
    vi.resetModules();
    vi.restoreAllMocks();
    mockChromeStorage();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const key = Object.keys(responses).find(k => url.endsWith(k));
      const r = key ? responses[key] : { status: 404, body: 'Not found', type: 'text/plain' };
      return new Response(r.body || null, { status: r.status, headers: r.type ? { 'content-type': r.type } : {} });
    }));
    const bmp = await import('../bmp-client');
    return bmp.BmpClient.checkHealth('https://bmp.test/Ws/');
  }

  it('BMP 5.6 answers /health with an empty 404: the workspace probe confirms it is up', async () => {
    const r = await check({
      health: { status: 404, body: '' },
      'cs/authentication': { status: 200, body: '{"defaultLocale":"en","userName":null}', type: 'application/json' },
    });
    expect(r).toMatchObject({ up: true, reachable: true });
  });

  it('a wrong path (404 everywhere) is not a workspace', async () => {
    const r = await check({});
    expect(r).toMatchObject({ up: false, reachable: true, notWorkspace: true });
    expect(r.detail).toMatch(/HTTP 404/);
  });

  it('a catch-all web server answering HTML 200 is not a workspace', async () => {
    const html = { status: 200, body: '<!doctype html><html></html>', type: 'text/html' };
    const r = await check({ health: html, 'cs/authentication': html });
    expect(r).toMatchObject({ notWorkspace: true });
  });

  it('a JSON health status is still authoritative', async () => {
    expect(await check({ health: { status: 200, body: '{"status":"up"}', type: 'application/json' } })).toMatchObject({ up: true });
    expect(await check({ health: { status: 200, body: '{"status":"down"}', type: 'application/json' } })).toMatchObject({ up: false, reachable: true });
    const down = await check({ health: { status: 503, body: '' } });
    expect(down).toMatchObject({ up: false, reachable: true });
    expect(down.notWorkspace).toBeFalsy();
  });
});
