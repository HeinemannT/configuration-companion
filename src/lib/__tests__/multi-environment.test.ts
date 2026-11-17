/**
 * Every request is bound to its own server profile (profile-scope.ts,
 * message-router.ts):
 *  - matchProfile picks the longest address match;
 *  - routing per sender kind: content script, embedded window (frame), side
 *    panel, extension page in its own tab;
 *  - two profiles in parallel never cross, also with interleaved requests;
 *  - focus and tab activation change only what a window shows, never where
 *    requests go, and write nothing to settings;
 *  - a write with a foreign environment is refused;
 *  - after a worker restart the window and tab state is rebuilt;
 *  - caches and clients are per profile.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { warmServiceWorkerGraph } from './warm-imports';

// The router and every handler, once, before the tests (busy machines).
warmServiceWorkerGraph(mockChromeStorage);
import { ObjectCache } from '../object-cache';
import type { InspectorMessage, InspectorSettings, ServerProfile } from '../types';
import type { SwContext } from '../sw-context';

const A_URL = 'https://a.example.test/Ws/';
const B_URL = 'https://b.example.test/Ws/';

function makeProfiles(): ServerProfile[] {
  return [
    { id: 'A', label: 'Server A', bmpUrl: A_URL, bmpUser: '', bmpPass: '', commandAuthMode: 'portal' },
    { id: 'B', label: 'Server B', bmpUrl: B_URL, bmpUser: '', bmpPass: '', commandAuthMode: 'portal' },
  ];
}

const extensionPage = (path = 'sidepanel/sidepanel.html', tab?: { id: number; url: string }, frameId = 0) =>
  ({ id: 'test', url: `chrome-extension://test/${path}`, ...(tab ? { tab, frameId } : {}) }) as unknown as chrome.runtime.MessageSender;
const contentScript = (tabId: number, url: string) =>
  ({ id: 'test', url, tab: { id: tabId, url }, frameId: 0 }) as unknown as chrome.runtime.MessageSender;

/** A worker-like base context: real profile scopes, panels per window. */
async function harness(profiles = makeProfiles()) {
  vi.resetModules();
  vi.restoreAllMocks();
  mockChromeStorage();
  vi.stubGlobal('navigator', { onLine: true });
  // No server answers: background health checks and sign-ins fail as for an
  // unreachable host. These tests are about routing, not about the answers.
  globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
  const panelMessages = new Map<number, InspectorMessage[]>();
  const scope = await import('../profile-scope');
  const settingsValue: InspectorSettings = {
    schemaVersion: 4, profiles, activeProfileId: 'A', autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
  };
  const panelPortByWindow = new Map<number, chrome.runtime.Port>();
  for (const w of [1, 2]) {
    panelMessages.set(w, []);
    panelPortByWindow.set(w, { postMessage: (m: InspectorMessage) => panelMessages.get(w)!.push(m) } as unknown as chrome.runtime.Port);
  }
  const base: any = {
    hasPanel: false, panelPortByWindow, contentPorts: new Map(), cache: new ObjectCache('_unbound'),
    history: { clear: vi.fn(), getAll: () => [], record: vi.fn() }, favorites: {}, scriptHistory: {}, stylePresets: {},
    settings: settingsValue,
    inspectActiveByWindow: new Map(), blueprintActiveByWindow: new Map(), blueprintTabByWindow: new Map(),
    isInspectActive: () => false, setInspectActive: vi.fn(), persistBlueprintState: vi.fn(),
    settingsReady: Promise.resolve(), logActivity: vi.fn(),
    sendToPanel: vi.fn(),
    sendToPanelByWindow: (w: number, m: InspectorMessage) => panelMessages.get(w)?.push(m),
    sendToPanelByTab: vi.fn(), broadcastToContent: vi.fn(), toast: vi.fn(),
    get client() { return null; },
    scopeFor: (id: string) => scope.scopeFor(id)?.ctx ?? null,
    sendToProfilePanels: (id: string, m: InspectorMessage) => {
      for (const w of panelPortByWindow.keys()) if (scope.displayProfileOf(w) === id) panelMessages.get(w)!.push(m);
    },
    broadcastToProfileContent: vi.fn(),
    boundForTab: (tabId: number) => scope.boundForTab(tabId),
    boundContexts: () => scope.liveScopes().map(s => s.ctx),
  };
  const sw = await import('../sw-context');
  sw.setSwContext(base as SwContext);
  const settings = await import('../settings');
  await settings.loadSettingsFrom(undefined);
  const registry = await import('../handler-registry');
  const router = await import('../message-router');
  const seen: Array<{ type: string; profileId?: string; server?: string }> = [];
  /** A probe on a type every sender kind may send: records where it ran. */
  registry.register('HOVER_LOOKUP', async (msg, respond, meta) => {
    const ctx = meta.ctx!;
    const delay = (msg as unknown as { delay?: number }).delay ?? 0;
    if (delay) await new Promise(r => setTimeout(r, delay));
    seen.push({ type: msg.type, profileId: ctx.profileId, server: ctx.client?.serverUrl });
    respond({ type: 'HOVER_RESULT', ok: true, profileId: ctx.profileId } as unknown as InspectorMessage);
  });
  const oneShot = (msg: Record<string, unknown>, sender: chrome.runtime.MessageSender) => new Promise<InspectorMessage>(resolve => {
    router.handleOneShotMessage({ type: 'HOVER_LOOKUP', ref: '1', ...msg } as unknown as InspectorMessage, sender, resolve);
  });
  return { base, scope, settings, router, registry, seen, oneShot, panelMessages, settingsValue };
}

describe('matchProfile — longest-prefix winner', () => {
  it('matches each environment by origin and path', async () => {
    const { settings } = await harness();
    expect(settings.matchProfile(`${A_URL}?rid=1`, makeProfiles())?.id).toBe('A');
    expect(settings.matchProfile(`${B_URL}x`, makeProfiles())?.id).toBe('B');
    expect(settings.matchProfile('https://c.example.test/Ws/', makeProfiles())).toBeNull();
  });

  it('prefers the longer prefix and respects segment boundaries', async () => {
    const { settings } = await harness();
    const profiles: ServerProfile[] = [
      { id: 'root', label: 'r', bmpUrl: 'https://h.test/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' },
      { id: 'ws', label: 'w', bmpUrl: 'https://h.test/Corpo/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' },
    ];
    expect(settings.matchProfile('https://h.test/Corpo/x?rid=1', profiles)?.id).toBe('ws');
    expect(settings.matchProfile('https://h.test/CorpoTest/', profiles)?.id).toBe('root');
  });
});

describe('routing per sender kind', () => {
  it('a content script goes to the profile of its tab’s page', async () => {
    const h = await harness();
    h.scope.noteTabUrl(11, `${A_URL}?rid=1`);
    h.scope.noteTabUrl(12, `${B_URL}?rid=1`);
    await h.oneShot({}, contentScript(11, `${A_URL}?rid=1`));
    await h.oneShot({}, contentScript(12, `${B_URL}?rid=1`));
    expect(h.seen.map(s => s.profileId)).toEqual(['A', 'B']);
    expect(h.seen.map(s => s.server)).toEqual([A_URL, B_URL]);
  });

  it('a page that belongs to no stored server is refused with a clear sentence', async () => {
    const h = await harness();
    const reply = await h.oneShot({}, contentScript(13, 'https://other.example.invalid/Ws/'));
    expect(reply).toMatchObject({ type: 'REQUEST_FAILED', error: 'This page does not belong to a server Companion is set up for.' });
    expect(h.seen).toEqual([]);
  });

  it('a Companion window embedded in a page goes to the profile of the page around it', async () => {
    const h = await harness();
    await h.oneShot({}, extensionPage('objectview/window.html', { id: 21, url: `${B_URL}?rid=5` }, 7));
    expect(h.seen).toEqual([expect.objectContaining({ profileId: 'B', server: B_URL })]);
  });

  it('the side panel goes to the profile its window shows', async () => {
    const h = await harness();
    h.scope.setWindowDisplay(1, 'A', false);
    h.scope.setWindowDisplay(2, 'B', false);
    const replies: InspectorMessage[] = [];
    const port = (w: number) => ({ postMessage: (m: InspectorMessage) => replies.push(m), sender: extensionPage() }) as unknown as chrome.runtime.Port;
    h.base.panelPortByWindow.set(1, port(1));
    h.base.panelPortByWindow.set(2, port(2));
    await h.router.handlePanelMessage({ type: 'HOVER_LOOKUP', ref: '1' } as unknown as InspectorMessage, h.base.panelPortByWindow.get(2));
    await h.router.handlePanelMessage({ type: 'HOVER_LOOKUP', ref: '1' } as unknown as InspectorMessage, h.base.panelPortByWindow.get(1));
    expect(h.seen.map(s => s.profileId)).toEqual(['B', 'A']);
  });

  it('an extension page in its own tab goes to the profile it names; an unknown one is refused', async () => {
    const h = await harness();
    await h.oneShot({ environment: `B@${B_URL}` }, extensionPage('access/access.html', { id: 30, url: 'chrome-extension://test/access/access.html' }));
    expect(h.seen).toEqual([expect.objectContaining({ profileId: 'B' })]);
    const reply = await h.oneShot({ environment: 'gone@https://x.invalid/' }, extensionPage('access/access.html', { id: 30, url: 'chrome-extension://test/access/access.html' }));
    expect(reply).toMatchObject({ type: 'REQUEST_FAILED' });
    expect(h.seen).toHaveLength(1);
  });
});

describe('two profiles in parallel', () => {
  it('interleaved requests never cross servers', async () => {
    const h = await harness();
    h.scope.noteTabUrl(11, A_URL);
    h.scope.noteTabUrl(12, B_URL);
    await Promise.all([
      h.oneShot({ delay: 30 }, contentScript(11, A_URL)),
      h.oneShot({ delay: 5 }, contentScript(12, B_URL)),
      h.oneShot({ delay: 15 }, contentScript(11, A_URL)),
      h.oneShot({ delay: 1 }, contentScript(12, B_URL)),
    ]);
    expect(h.seen).toHaveLength(4);
    for (const s of h.seen) expect(s.server).toBe(s.profileId === 'A' ? A_URL : B_URL);
    // Each profile has its own client, created once.
    expect(h.scope.scopeFor('A')!.ctx.client).toBe(h.scope.scopeFor('A')!.ctx.client);
    expect(h.scope.scopeFor('A')!.ctx.client).not.toBe(h.scope.scopeFor('B')!.ctx.client);
  });

  it('caches and stores are per profile', async () => {
    const h = await harness();
    const a = h.scope.scopeFor('A')!.ctx;
    const b = h.scope.scopeFor('B')!.ctx;
    a.cache.put({ rid: '9007199254740993', name: 'From A', source: 'server', discoveredAt: 0, updatedAt: 0 });
    expect(b.cache.get('9007199254740993')).toBeUndefined();
    expect(a.history).not.toBe(b.history);
    expect(a.settings.activeProfileId).toBe('A');
    expect(b.settings.activeProfileId).toBe('B');
    // The global "last used" profile is untouched by bound contexts.
    expect(h.settingsValue.activeProfileId).toBe('A');
  });

  it('a credential change replaces only that profile’s client', async () => {
    const h = await harness();
    const a = h.scope.scopeFor('A')!.ctx.client;
    const b = h.scope.scopeFor('B')!.ctx.client;
    h.base.settings = { ...h.base.settings, profiles: h.base.settings.profiles.map((p: ServerProfile) => p.id === 'A' ? { ...p, commandAuthRevision: 'new' } : p) };
    h.scope.refreshScopes();
    expect(h.scope.scopeFor('A')!.ctx.client).not.toBe(a);
    expect(h.scope.scopeFor('B')!.ctx.client).toBe(b);
  });
});

describe('focus and tab activation', () => {
  it('change only what that window shows, never where requests go, and write no settings', async () => {
    const h = await harness();
    h.scope.noteTabUrl(11, A_URL);
    h.scope.noteTabUrl(12, B_URL);
    h.scope.setWindowDisplay(1, 'A', false);
    h.scope.setWindowDisplay(2, 'A', false);
    const writes = (chrome.storage.local.set as any).mock.calls.length;
    for (let i = 0; i < 10; i++) {
      h.scope.followFrontTab(i % 2 ? 1 : 2, i % 2 ? A_URL : B_URL);
    }
    expect(h.scope.displayProfileOf(1)).toBe('A');
    expect(h.scope.displayProfileOf(2)).toBe('B');
    expect((chrome.storage.local.set as any).mock.calls.length).toBe(writes);
    expect(h.settingsValue.activeProfileId).toBe('A');
    // The automatic switch says nothing about "Switched to".
    const switched = h.panelMessages.get(2)!.filter(m => m.type === 'PROFILE_SWITCHED') as Array<{ manual?: boolean }>;
    expect(switched.length).toBeGreaterThan(0);
    expect(switched.every(m => m.manual === false)).toBe(true);
    // Requests still go by page, whatever the windows show.
    await h.oneShot({}, contentScript(11, A_URL));
    expect(h.seen.at(-1)!.profileId).toBe('A');
  });

  it('a profile picked by hand sticks in that window against an immediate auto-detect back', async () => {
    const h = await harness();
    h.scope.setWindowDisplay(1, 'A', false);
    h.settings.setManualOverride(1, 'A');
    h.scope.setWindowDisplay(1, 'B', true);
    h.scope.followFrontTab(1, A_URL);
    expect(h.scope.displayProfileOf(1)).toBe('B');
    // Another window is not affected by that pick.
    h.scope.followFrontTab(2, A_URL);
    expect(h.scope.displayProfileOf(2)).toBe('A');
  });
});

describe('writes carry their environment', () => {
  it('refuses a write whose environment is another server, naming both, and writes nothing', async () => {
    const h = await harness();
    await import('../handlers/ec');
    const b = h.scope.scopeFor('B')!;
    await b.ready;
    const saveCodeViaEc = vi.spyOn(b.ctx.client!, 'saveCodeViaEc');
    const saveProperty = vi.spyOn(b.ctx.client!, 'saveProperty');
    const replies: InspectorMessage[] = [];
    await h.registry.getHandler('SAVE_PROPERTY')!({
      type: 'SAVE_PROPERTY', rid: '9007199254740993', property: 'expression', value: 'x', objectType: 'TextElement',
      environment: `A@${A_URL}`,
    } as unknown as InspectorMessage, r => replies.push(r), { isOneShot: true, ctx: b.ctx });
    expect(saveCodeViaEc).not.toHaveBeenCalled();
    expect(saveProperty).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({
      type: 'SAVE_RESULT', ok: false, notSent: true,
      error: 'This window was opened for “Server A”, but its page now belongs to “Server B”. Nothing was saved. Reload the window to work on “Server B”.',
    });
  });
});

describe('after a worker restart', () => {
  it('rebuilds tab URLs and what each window shows from the browser', async () => {
    const h = await harness();
    (chrome as any).windows = {
      getAll: vi.fn(async () => [
        { id: 1, tabs: [{ id: 11, active: true, url: `${A_URL}?rid=1` }] },
        { id: 2, tabs: [{ id: 12, active: false, url: `${A_URL}?rid=2` }, { id: 13, active: true, url: `${B_URL}?rid=3` }] },
      ]),
    };
    await h.scope.restoreWindowState();
    expect(h.scope.displayProfileOf(1)).toBe('A');
    expect(h.scope.displayProfileOf(2)).toBe('B');
    expect(h.scope.profileOfTab(12)).toBe('A');
    expect(h.scope.profileOfTab(13)).toBe('B');
  });

  it('keeps a window’s manual pick across the restart', async () => {
    const h = await harness();
    await chrome.storage.session.set({ crev_display_by_window: { 1: { profileId: 'B', manual: true } } });
    (chrome as any).windows = { getAll: vi.fn(async () => [{ id: 1, tabs: [{ id: 11, active: true, url: A_URL }] }]) };
    await h.scope.restoreWindowState();
    expect(h.scope.displayProfileOf(1)).toBe('B');
  });
});
