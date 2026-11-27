/**
 * Who may send which message (message-access.ts, sender-trust.ts) and what a
 * page may see of the settings (redactSettings).
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { warmServiceWorkerGraph } from './warm-imports';

// The router and every handler, once, before the tests (busy machines).
warmServiceWorkerGraph(mockChromeStorage);
import type { InspectorSettings } from '../types';

describe('message access table', () => {
  it('has an entry for every registered request type', async () => {
    vi.resetModules();
    mockChromeStorage();
    await import('../message-router');
    const { registeredTypes } = await import('../handler-registry');
    const { MESSAGE_ACCESS } = await import('../message-access');
    const missing = registeredTypes().filter(type => !(type in MESSAGE_ACCESS));
    expect(missing).toEqual([]);
  });

  it('lists no type that has no handler (a stale entry would hide a gap)', async () => {
    vi.resetModules();
    mockChromeStorage();
    await import('../message-router');
    const { registeredTypes } = await import('../handler-registry');
    const { MESSAGE_ACCESS } = await import('../message-access');
    const registered = new Set(registeredTypes());
    expect(Object.keys(MESSAGE_ACCESS).filter(type => !registered.has(type))).toEqual([]);
  });

  it('keeps credential, profile and code-execution messages away from content scripts', async () => {
    const { senderKindMay } = await import('../message-access');
    for (const type of ['GET_SETTINGS', 'SAVE_SETTINGS', 'SAVE_PROFILE', 'DELETE_PROFILE', 'SET_ACTIVE_PROFILE',
      'AI_SAVE_CONFIG', 'AI_REQUEST', 'AI_RUN_CHANGE', 'EC_EXECUTE', 'SAVE_PROPERTY', 'APPLY_OBJECT_CHANGES',
      'STUDIO_WRITE_RESOURCE', 'CODE_INDEX_REMOVE', 'RESET_ALL', 'CLEAR_CACHE', 'SITE_ACCESS_CHANGED']) {
      expect(senderKindMay('content', type), type).toBe(false);
    }
    // Profiles and settings: extension pages only, not even embedded windows.
    for (const type of ['GET_SETTINGS', 'SAVE_PROFILE', 'SET_ACTIVE_PROFILE', 'AI_SAVE_CONFIG', 'RESET_ALL']) {
      expect(senderKindMay('frame', type), type).toBe(false);
      expect(senderKindMay('extension', type), type).toBe(true);
    }
  });

  it('lets the content script send what it and Blueprint send, Blueprint apply included', async () => {
    const { senderKindMay } = await import('../message-access');
    for (const type of ['ENRICH_BADGES', 'OBJECTS_DISCOVERED', 'DETECTION_RESULT', 'PAGE_CONTEXT', 'LAYOUT_LOAD', 'LAYOUT_APPLY', 'OPEN_OBJECT_VIEW', 'PREFETCH_OBJECT_VIEW']) {
      expect(senderKindMay('content', type), type).toBe(true);
    }
    expect(senderKindMay('content', 'NOT_A_TYPE')).toBe(false);
    expect(senderKindMay('frame', 'NOT_A_TYPE')).toBe(false);
  });
});

describe('sender kinds', () => {
  const ext = (path: string, extra: Partial<chrome.runtime.MessageSender> = {}) =>
    ({ id: 'test', url: `chrome-extension://test/${path}`, ...extra }) as chrome.runtime.MessageSender;

  it('tells content scripts, embedded windows and extension pages apart', async () => {
    mockChromeStorage();
    const { senderKindOf } = await import('../sender-trust');
    expect(senderKindOf({ id: 'test', url: 'https://bmp.test/Ws/', tab: { id: 1 } as chrome.tabs.Tab })).toBe('content');
    expect(senderKindOf(ext('objectview/window.html', { tab: { id: 1 } as chrome.tabs.Tab, frameId: 4 }))).toBe('frame');
    expect(senderKindOf(ext('sidepanel/sidepanel.html'))).toBe('extension');
    expect(senderKindOf(ext('access/access.html', { tab: { id: 2 } as chrome.tabs.Tab, frameId: 0 }))).toBe('extension');
    expect(senderKindOf({ id: 'other-extension', url: 'chrome-extension://other/x.html' })).toBeNull();
    expect(senderKindOf({ id: 'test', url: 'https://bmp.test/' })).toBeNull(); // no tab: not a content script
  });

  it('refuses a content-script message one-shot and logs the refusal once as a diagnostic', async () => {
    vi.resetModules();
    mockChromeStorage();
    const ctx: any = { settingsReady: Promise.resolve(), logActivity: vi.fn(), settings: { profiles: [], activeProfileId: '' } };
    (await import('../sw-context')).setSwContext(ctx);
    const router = await import('../message-router');
    const page = { id: 'test', url: 'https://bmp.test/Ws/', tab: { id: 3, url: 'https://bmp.test/Ws/' } } as unknown as chrome.runtime.MessageSender;
    const replies: unknown[] = [];
    router.handleOneShotMessage({ type: 'SET_ACTIVE_PROFILE', profileId: 'x' }, page, r => replies.push(r));
    router.handleOneShotMessage({ type: 'SET_ACTIVE_PROFILE', profileId: 'x' }, page, r => replies.push(r));
    expect(replies).toEqual([
      expect.objectContaining({ type: 'REQUEST_FAILED', error: 'This request is not accepted from a page.' }),
      expect.objectContaining({ type: 'REQUEST_FAILED' }),
    ]);
    const logged = ctx.logActivity.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith('Refused SET_ACTIVE_PROFILE'));
    expect(logged).toHaveLength(1);
    expect(logged[0][3]).toEqual({ category: 'system', action: 'message-refused' });
  });

  it('"Server was restarted" is accepted from extension pages only (the Log): code search in a page and a content script are refused', async () => {
    vi.resetModules();
    mockChromeStorage();
    const resetScriptCount = vi.fn(async () => {});
    const ctx: any = { settingsReady: Promise.resolve(), logActivity: vi.fn(), settings: { profiles: [], activeProfileId: '' }, client: { governor: { resetScriptCount } } };
    (await import('../sw-context')).setSwContext(ctx);
    const router = await import('../message-router');
    const frame = { id: 'test', url: 'chrome-extension://test/codesearch/codesearch.html', tab: { id: 3, url: 'https://bmp.test/Ws/' } as chrome.tabs.Tab, frameId: 2 } as chrome.runtime.MessageSender;
    const page = { id: 'test', url: 'https://bmp.test/Ws/', tab: { id: 3, url: 'https://bmp.test/Ws/' } } as unknown as chrome.runtime.MessageSender;
    const replies: unknown[] = [];
    router.handleOneShotMessage({ type: 'RESET_SCRIPT_COUNT', profileId: 'other' }, frame, r => replies.push(r));
    router.handleOneShotMessage({ type: 'RESET_SCRIPT_COUNT', profileId: 'other' }, page, r => replies.push(r));
    expect(replies).toEqual([expect.objectContaining({ type: 'REQUEST_FAILED' }), expect.objectContaining({ type: 'REQUEST_FAILED' })]);
    expect(resetScriptCount).not.toHaveBeenCalled();
  });
});

describe('redactSettings', () => {
  const settings: InspectorSettings = {
    schemaVersion: 4, activeProfileId: 'a', autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
    profiles: [
      { id: 'a', label: 'A', bmpUrl: 'https://a.test/', bmpUser: 'cfg', bmpPass: 'secret-a', commandAuthMode: 'stored' },
      { id: 'b', label: 'B', bmpUrl: 'https://b.test/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' },
    ],
    ai: {
      provider: 'anthropic', model: 'm',
      keys: { anthropic: { apiKeyEnc: 'ciphertext-of-key', model: 'm' }, openai: { apiKeyEnc: 'ciphertext-of-other-key' } },
    },
  };

  it('replaces each password by a flag and the AI key by a marker, for the window’s profile', async () => {
    mockChromeStorage();
    const { redactSettings } = await import('../settings');
    const seen = redactSettings(settings, 'b');
    const text = JSON.stringify(seen);
    expect(text).not.toContain('secret-a');
    expect(text).not.toContain('ciphertext-of-key');
    expect(text).not.toContain('ciphertext-of-other-key');
    expect(seen.profiles.map(p => [p.bmpPass, p.hasStoredPassword])).toEqual([['', true], ['', false]]);
    expect(seen.ai?.keys.anthropic?.apiKeyEnc).toBe('set');
    expect(seen.ai?.keys.openai?.apiKeyEnc).toBe('set');
    expect(seen.activeProfileId).toBe('b');
    // The source is not changed.
    expect(settings.profiles[0].bmpPass).toBe('secret-a');
  });

  it('no settings answer of the profile handlers carries a stored password', async () => {
    vi.resetModules();
    mockChromeStorage();
    // No server answers the background sign-in a profile switch starts.
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const ctx: any = {
      settingsReady: Promise.resolve(), logActivity: vi.fn(), toast: vi.fn(), sendToPanel: vi.fn(), sendToPanelByWindow: vi.fn(),
      broadcastToContent: vi.fn(), panelPortByWindow: new Map(), contentPorts: new Map(),
      settings: structuredClone(settings),
    };
    (await import('../sw-context')).setSwContext(ctx);
    await (await import('../settings')).loadSettingsFrom(undefined);
    await import('../message-router');
    const { getHandler } = await import('../handler-registry');
    const replies: unknown[] = [];
    for (const msg of [{ type: 'GET_SETTINGS' }, { type: 'SET_ACTIVE_PROFILE', profileId: 'b' }]) {
      await getHandler(msg.type)!(msg as never, r => replies.push(r), { isOneShot: true, panelWindowId: 1 });
    }
    expect(replies.length).toBeGreaterThan(1);
    expect(JSON.stringify(replies)).not.toContain('secret-a');
    expect(JSON.stringify(replies)).not.toContain('ciphertext-of-key');
  });

  it('keeps the stored password when an edit sends an empty one, and removes it on request', async () => {
    vi.resetModules();
    mockChromeStorage();
    // No server answers the background sign-in a profile switch starts.
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    (globalThis.chrome as any).tabs.query = vi.fn(async () => []);
    (globalThis.chrome as any).permissions = { getAll: vi.fn(async () => ({ origins: [] })), remove: vi.fn(), contains: vi.fn(async () => true) };
    (globalThis.chrome as any).scripting = { getRegisteredContentScripts: vi.fn(async () => []), registerContentScripts: vi.fn(), updateContentScripts: vi.fn(), unregisterContentScripts: vi.fn() };
    const ctx: any = {
      settingsReady: Promise.resolve(), logActivity: vi.fn(), toast: vi.fn(), sendToPanel: vi.fn(), sendToPanelByWindow: vi.fn(),
      broadcastToContent: vi.fn(), panelPortByWindow: new Map(), contentPorts: new Map(),
      settings: { ...structuredClone(settings), activeProfileId: 'b' },
    };
    (await import('../sw-context')).setSwContext(ctx);
    await (await import('../settings')).loadSettingsFrom(undefined);
    await import('../message-router');
    const { getHandler } = await import('../handler-registry');
    const save = (profile: Record<string, unknown>) => getHandler('SAVE_PROFILE')!(
      { type: 'SAVE_PROFILE', profile: { id: 'a', label: 'A', bmpUrl: 'https://a.test/', bmpUser: 'cfg', bmpPass: '', commandAuthMode: 'stored', ...profile } } as never,
      () => {}, { isOneShot: true, panelWindowId: 9 });
    await save({});
    expect(ctx.settings.profiles[0].bmpPass).toBe('secret-a');
    await save({ clearPassword: true });
    expect(ctx.settings.profiles[0].bmpPass).toBe('');
    // What was stored carries neither the flag nor the plaintext.
    const stored = (await chrome.storage.local.get('crev_settings')).crev_settings;
    expect(JSON.stringify(stored)).not.toContain('secret-a');
    expect(JSON.stringify(stored)).not.toContain('clearPassword');
  });
});
