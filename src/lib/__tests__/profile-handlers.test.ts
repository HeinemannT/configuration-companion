/**
 * Profile create / save / select / delete through the worker handlers, the
 * save verdict (item 13), URL normalisation in the worker (item 1), the
 * always-answered connection test (item 7), and the sender check (item 15).
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { warmServiceWorkerGraph } from './warm-imports';

// The router and every handler, once, before the tests (busy machines).
warmServiceWorkerGraph(mockChromeStorage);
import { ObjectCache } from '../object-cache';
import type { InspectorMessage, ServerProfile } from '../types';

async function harness(frontTabUrl?: string) {
  vi.resetModules();
  vi.restoreAllMocks();
  mockChromeStorage();
  vi.stubGlobal('navigator', { onLine: true });
  (globalThis.chrome as any).tabs.query = vi.fn(async () => (frontTabUrl ? [{ id: 7, url: frontTabUrl }] : []));
  (globalThis.chrome as any).permissions = {
    getAll: vi.fn(async () => ({ origins: [] })), remove: vi.fn(async () => true), contains: vi.fn(async () => true),
  };
  (globalThis.chrome as any).scripting = {
    getRegisteredContentScripts: vi.fn(async () => []), unregisterContentScripts: vi.fn(), registerContentScripts: vi.fn(),
  };

  const bmp = await import('../bmp-client');
  vi.spyOn(bmp.BmpClient, 'checkHealth').mockResolvedValue({ up: true, reachable: true, responseMs: 4 });
  vi.spyOn(bmp.BmpClient, 'getBuildNumber').mockResolvedValue({ status: 'unavailable' });
  vi.spyOn(bmp.BmpClient.prototype, 'testConnection').mockResolvedValue({ ok: true, message: 'ok', authenticated: true });
  vi.spyOn(bmp.BmpClient.prototype, 'commandUser', 'get').mockReturnValue('admin');
  const portal = await import('../portal-identity');
  vi.spyOn(portal, 'probePortalIdentity').mockResolvedValue({ status: 'connected', user: 'admin', source: 'portal-session' });

  const store = () => ({ switchProfile: vi.fn(async () => {}), clear: vi.fn(), load: vi.fn() });
  const ctx: any = {
    client: null, hasPanel: true, panelPortByWindow: new Map(), contentPorts: new Map(), cache: new ObjectCache(),
    history: store(), favorites: store(), scriptHistory: store(), stylePresets: store(),
    settings: { schemaVersion: 4, profiles: [], activeProfileId: '', autoDetect: true, saveTarget: 'instance', enrichMode: 'all' },
    blueprintActiveByWindow: new Map(), blueprintTabByWindow: new Map(), persistBlueprintState: vi.fn(),
    settingsReady: Promise.resolve(), logActivity: vi.fn(), sendToPanel: vi.fn(), sendToPanelByWindow: vi.fn(),
    sendToPanelByTab: vi.fn(), broadcastToContent: vi.fn(), toast: vi.fn(),
  };
  (await import('../sw-context')).setSwContext(ctx);
  // A first start: nothing stored, settings count as read.
  await (await import('../settings')).loadSettingsFrom(undefined);
  (await import('../connection')).configureConnectionTiming({ retryDelayMs: 1 });
  const router = await import('../message-router');
  const registry = await import('../handler-registry');

  const call = async (msg: InspectorMessage) => {
    const replies: InspectorMessage[] = [];
    await registry.getHandler(msg.type)!(msg as never, r => replies.push(r), { isOneShot: false, panelWindowId: 1 });
    return replies;
  };
  return { ctx, router, call };
}

const profile = (change: Partial<ServerProfile> = {}): ServerProfile => ({
  id: 'p1', label: 'DEV', bmpUrl: 'dev.example.test/Ws', bmpUser: '', bmpPass: '', commandAuthMode: 'portal', ...change,
});

describe('SAVE_PROFILE', () => {
  it('normalises a scheme-less URL before storing it and answers with a verdict', async () => {
    const h = await harness();
    const replies = await h.call({ type: 'SAVE_PROFILE', profile: profile() });
    expect(h.ctx.settings.profiles[0].bmpUrl).toBe('https://dev.example.test/Ws/');
    expect(replies.map(r => r.type)).toEqual(['SETTINGS_DATA', 'PROFILE_VERDICT']);
    expect(replies[1]).toMatchObject({ type: 'PROFILE_VERDICT', profileId: 'p1', ok: true, text: 'Connected as admin' });
  });

  it('reduces a pasted deep link to the workspace root', async () => {
    const h = await harness();
    await h.call({ type: 'SAVE_PROFILE', profile: profile({ bmpUrl: 'https://dev.example.test/Ws/?isHome=true&rid=89157799329748734' }) });
    expect(h.ctx.settings.profiles[0].bmpUrl).toBe('https://dev.example.test/Ws/');
  });

  it('refuses an address that cannot be a workspace, saving nothing', async () => {
    const h = await harness();
    const replies = await h.call({ type: 'SAVE_PROFILE', profile: profile({ bmpUrl: 'ftp://dev.example.test/Ws' }) });
    expect(h.ctx.settings.profiles).toHaveLength(0);
    expect(replies[0]).toMatchObject({ type: 'PROFILE_VERDICT', ok: false });
  });

  it('makes a new profile active when its server is the page in front', async () => {
    const h = await harness('https://two.example.test/Ws2/?rid=1');
    await h.call({ type: 'SAVE_PROFILE', profile: profile({ id: 'a', bmpUrl: 'https://one.example.test/Ws/' }) });
    expect(h.ctx.settings.activeProfileId).toBe('a');
    const replies = await h.call({ type: 'SAVE_PROFILE', profile: profile({ id: 'b', label: 'Two', bmpUrl: 'two.example.test/Ws2' }) });
    expect(h.ctx.settings.activeProfileId).toBe('b');
    // Only the panel of the window whose page is in front switches, without
    // the "Switched to" sentence (not picked by hand).
    expect(h.ctx.sendToPanelByWindow).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'PROFILE_SWITCHED', profileId: 'b', manual: false }));
    expect(replies.at(-1)).toMatchObject({ type: 'PROFILE_VERDICT', profileId: 'b', ok: true });
  });

  it('keeps the active profile when the saved one is not in front, and says how to use it', async () => {
    const h = await harness('https://elsewhere.test/');
    await h.call({ type: 'SAVE_PROFILE', profile: profile({ id: 'a', bmpUrl: 'https://one.example.test/Ws/' }) });
    const replies = await h.call({ type: 'SAVE_PROFILE', profile: profile({ id: 'b', bmpUrl: 'https://two.example.test/Ws2/' }) });
    expect(h.ctx.settings.activeProfileId).toBe('a');
    expect(replies.at(-1)).toMatchObject({ type: 'PROFILE_VERDICT', profileId: 'b', text: expect.stringMatching(/Select this server/) });
  });

  it('clears the unreadable-password flag once a new password is entered', async () => {
    const h = await harness();
    h.ctx.settings = { ...h.ctx.settings, profiles: [profile({ commandAuthMode: 'stored', bmpUser: 'cfg', passwordUnreadable: true, bmpUrl: 'https://dev.example.test/Ws/' })], activeProfileId: 'p1' };
    await h.call({ type: 'SAVE_PROFILE', profile: profile({ commandAuthMode: 'stored', bmpUser: 'cfg', bmpPass: 'new', bmpUrl: 'https://dev.example.test/Ws/' }) });
    expect(h.ctx.settings.profiles[0].passwordUnreadable).toBeUndefined();
    expect(h.ctx.settings.profiles[0].bmpPass).toBe('new');
  });
});

describe('SET_ACTIVE_PROFILE and DELETE_PROFILE', () => {
  it('selects and deletes, moving the active profile to the remaining one', async () => {
    const h = await harness();
    await h.call({ type: 'SAVE_PROFILE', profile: profile({ id: 'a', bmpUrl: 'https://one.example.test/Ws/' }) });
    await h.call({ type: 'SAVE_PROFILE', profile: profile({ id: 'b', bmpUrl: 'https://two.example.test/Ws/' }) });
    await h.call({ type: 'SET_ACTIVE_PROFILE', profileId: 'b' });
    expect(h.ctx.settings.activeProfileId).toBe('b');
    const scopes = await import('../profile-scope');
    expect(scopes.displayProfileOf(1)).toBe('b');
    expect(scopes.scopeFor('b')!.ctx.client!.serverUrl).toBe('https://two.example.test/Ws/');
    expect(h.ctx.sendToPanelByWindow).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'PROFILE_SWITCHED', profileId: 'b', manual: true }));
    await h.call({ type: 'DELETE_PROFILE', profileId: 'b' });
    expect(h.ctx.settings.profiles.map((p: ServerProfile) => p.id)).toEqual(['a']);
    expect(h.ctx.settings.activeProfileId).toBe('a');
  });
});

describe('CONNECTION_TEST', () => {
  it('always answers with the resulting state, even when it did not change', async () => {
    const h = await harness();
    // No profile: the state stays "not-configured", so no broadcast happens.
    const replies = await h.call({ type: 'CONNECTION_TEST' });
    expect(replies).toEqual([expect.objectContaining({ type: 'CONNECTION_STATE', state: expect.objectContaining({ display: 'not-configured' }) })]);
  });
});

describe('sender check (item 15)', () => {
  const pageSender = { id: 'test', url: 'https://bmp.test/Ws/?rid=1', tab: { id: 3 } } as chrome.runtime.MessageSender;
  const panelSender = { id: 'test', url: 'chrome-extension://test/sidepanel/sidepanel.html' } as chrome.runtime.MessageSender;

  it('refuses GET_SETTINGS and SAVE_PROFILE from a content script', async () => {
    const h = await harness();
    h.ctx.settings.profiles = [profile({ bmpPass: 'secret', commandAuthMode: 'stored', bmpUrl: 'https://bmp.test/Ws/' })];
    const responses: InspectorMessage[] = [];
    h.router.handleOneShotMessage({ type: 'GET_SETTINGS' }, pageSender, r => responses.push(r));
    h.router.handleOneShotMessage({ type: 'SAVE_PROFILE', profile: profile({ bmpUrl: 'https://evil.test/' }) }, pageSender, r => responses.push(r));
    await new Promise(r => setTimeout(r, 10));
    expect(responses.every(r => r.type === 'REQUEST_FAILED')).toBe(true);
    expect(JSON.stringify(responses)).not.toContain('secret');
    expect(h.ctx.settings.profiles[0].bmpUrl).toBe('https://bmp.test/Ws/');
  });

  it('drops credential messages on a content port', async () => {
    const h = await harness();
    h.ctx.settings.profiles = [profile({ bmpUrl: 'https://bmp.test/Ws/' })];
    await h.router.handleContentMessage({ type: 'DELETE_PROFILE', profileId: 'p1' }, 3, 'https://bmp.test/Ws/');
    expect(h.ctx.settings.profiles).toHaveLength(1);
  });

  it('accepts them from the extension’s own pages', async () => {
    const h = await harness();
    h.ctx.settings.profiles = [profile({ bmpPass: 'secret', bmpUrl: 'https://bmp.test/Ws/' })];
    const responses: InspectorMessage[] = [];
    h.router.handleOneShotMessage({ type: 'GET_SETTINGS' }, panelSender, r => responses.push(r));
    await new Promise(r => setTimeout(r, 10));
    expect(responses[0]).toMatchObject({ type: 'SETTINGS_DATA' });
  });
});
