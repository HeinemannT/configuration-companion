/**
 * Settings cannot be wiped or lost silently (settings.ts):
 *  - a failed load leaves the extension in "settings could not be read":
 *    an edit then writes nothing, defaults never overwrite stored data;
 *  - a failed write is reported, the stored value stays, memory rolls back;
 *  - every overwrite keeps the previous stored value as one backup entry,
 *    used only when the main entry is missing or unreadable.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { warmServiceWorkerGraph } from './warm-imports';

// The router and every handler, once, before the tests (busy machines).
warmServiceWorkerGraph(mockChromeStorage);
import { DEFAULT_SETTINGS, type InspectorSettings } from '../types';

const STORED = {
  schemaVersion: 5, activeProfileId: 'p1', autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
  profiles: [{ id: 'p1', label: 'Prod', bmpUrl: 'https://bmp.test/Ws/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal', commandAuthRevision: 'r' }],
};

async function harness() {
  vi.resetModules();
  mockChromeStorage();
  (globalThis.chrome as any).tabs.query = vi.fn(async () => []);
  (globalThis.chrome as any).permissions = { getAll: vi.fn(async () => ({ origins: [] })), remove: vi.fn(), contains: vi.fn(async () => true) };
  (globalThis.chrome as any).scripting = { getRegisteredContentScripts: vi.fn(async () => []), registerContentScripts: vi.fn(), updateContentScripts: vi.fn(), unregisterContentScripts: vi.fn() };
  const ctx: any = {
    settingsReady: Promise.resolve(), logActivity: vi.fn(), toast: vi.fn(), sendToPanel: vi.fn(), sendToPanelByWindow: vi.fn(),
    broadcastToContent: vi.fn(), panelPortByWindow: new Map(), contentPorts: new Map(),
    settings: { ...DEFAULT_SETTINGS } as InspectorSettings,
  };
  (await import('../sw-context')).setSwContext(ctx);
  const settings = await import('../settings');
  await import('../message-router');
  const { getHandler } = await import('../handler-registry');
  const call = async (msg: Record<string, unknown>) => {
    const replies: any[] = [];
    await getHandler(msg.type as string)!(msg as never, r => replies.push(r), { isOneShot: true, panelWindowId: 1 });
    return replies;
  };
  return { ctx, settings, call };
}

describe('a failed settings load', () => {
  it('blocks every write: an edit after a failed read leaves the stored profiles intact', async () => {
    const h = await harness();
    await chrome.storage.local.set({ crev_settings: STORED });
    (chrome.storage.local.set as any).mockClear();
    // The read itself fails (worker start during a storage hiccup).
    const ok = await h.settings.loadSettingsFrom(undefined, false);
    expect(ok).toBe(false);
    expect(h.settings.settingsStatus()).toMatchObject({ status: 'failed' });
    const replies = await h.call({ type: 'SAVE_PROFILE', profile: { id: 'new', label: 'X', bmpUrl: 'https://x.test/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' } });
    expect(replies.at(-1)).toMatchObject({ type: 'PROFILE_VERDICT', ok: false, text: expect.stringMatching(/^Not saved\. Companion could not read its stored settings/) });
    await h.call({ type: 'SAVE_SETTINGS', settings: { enrichMode: 'widgets' } });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect((await chrome.storage.local.get('crev_settings')).crev_settings).toEqual(STORED);
    // In memory nothing pretends to be saved.
    expect(h.ctx.settings.profiles).toEqual([]);
  });

  it('treats an unreadable main entry without a backup as a failed load, not as an empty start', async () => {
    const h = await harness();
    const broken = { profiles: 'not-a-list' };
    await chrome.storage.local.set({ crev_settings: broken });
    expect(await h.settings.loadStoredSettings()).toBe(false);
    expect(await h.settings.saveSettings()).toMatchObject({ ok: false });
    expect((await chrome.storage.local.get('crev_settings')).crev_settings).toEqual(broken);
  });

  it('Retry reads the settings again and then allows writes', async () => {
    const h = await harness();
    await chrome.storage.local.set({ crev_settings: STORED });
    await h.settings.loadSettingsFrom(undefined, false);
    const replies = await h.call({ type: 'RETRY_SETTINGS_LOAD' });
    expect(replies[0]).toMatchObject({ type: 'SETTINGS_STATUS', status: 'loaded' });
    expect(h.ctx.settings.profiles.map((p: { id: string }) => p.id)).toEqual(['p1']);
    expect(await h.settings.saveSettings()).toEqual({ ok: true });
  });
});

describe('a failed settings write', () => {
  it('is reported to the caller and the panel, keeps the stored value, and rolls memory back', async () => {
    const h = await harness();
    await chrome.storage.local.set({ crev_settings: STORED });
    expect(await h.settings.loadStoredSettings()).toBe(true);
    (chrome.storage.local.set as any).mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    const replies = await h.call({ type: 'SAVE_PROFILE', profile: { id: 'p2', label: 'Dev', bmpUrl: 'https://dev.test/Ws/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' } });
    expect(replies.at(-1)).toMatchObject({ type: 'PROFILE_VERDICT', ok: false, text: expect.stringContaining('QUOTA_BYTES quota exceeded') });
    expect(replies.at(-1).text).not.toMatch(/^Saved/);
    expect(h.ctx.settings.profiles.map((p: { id: string }) => p.id)).toEqual(['p1']);
    expect((await chrome.storage.local.get('crev_settings')).crev_settings).toEqual(STORED);

    (chrome.storage.local.set as any).mockRejectedValueOnce(new Error('IO error'));
    const settingsReplies = await h.call({ type: 'SAVE_SETTINGS', settings: { enrichMode: 'widgets' } });
    expect(settingsReplies[0]).toMatchObject({ type: 'SETTINGS_SAVE_FAILED', error: expect.stringContaining('IO error') });
    expect(h.ctx.toast).toHaveBeenCalledWith(expect.stringContaining('IO error'), 'error');
    expect(h.ctx.settings.enrichMode).toBe('all');
  });
});

describe('the settings backup', () => {
  it('keeps the previous stored value as one backup entry on every overwrite', async () => {
    const h = await harness();
    await chrome.storage.local.set({ crev_settings: STORED });
    await h.settings.loadStoredSettings();
    await h.settings.updateSettings(s => ({ ...s, enrichMode: 'widgets' }));
    let raw: Record<string, any> = await chrome.storage.local.get(['crev_settings', 'crev_settings_backup']);
    expect(raw.crev_settings_backup).toEqual(STORED);
    expect(raw.crev_settings.enrichMode).toBe('widgets');
    await h.settings.updateSettings(s => ({ ...s, autoDetect: false }));
    raw = await chrome.storage.local.get(['crev_settings', 'crev_settings_backup']);
    expect(raw.crev_settings_backup.enrichMode).toBe('widgets');
    expect(raw.crev_settings_backup.autoDetect).toBe(true);
  });

  it('restores from the backup when the main entry is missing, and writes it back', async () => {
    const h = await harness();
    await chrome.storage.local.set({ crev_settings_backup: STORED });
    expect(await h.settings.loadStoredSettings()).toBe(true);
    expect(h.ctx.settings.profiles.map((p: { id: string }) => p.id)).toEqual(['p1']);
    expect(h.ctx.logActivity).toHaveBeenCalledWith('warn', 'Settings restored from the backup', expect.any(String), expect.objectContaining({ category: 'system' }));
    await vi.waitFor(async () => expect(((await chrome.storage.local.get('crev_settings')) as Record<string, any>).crev_settings?.profiles?.[0]?.id).toBe('p1'));
  });

  it('restores from the backup when the main entry is unreadable', async () => {
    const h = await harness();
    await chrome.storage.local.set({ crev_settings: 'garbage', crev_settings_backup: STORED });
    expect(await h.settings.loadStoredSettings()).toBe(true);
    expect(h.ctx.settings.profiles).toHaveLength(1);
  });

  it('does not use the backup when the main entry is readable', async () => {
    const h = await harness();
    const current = { ...STORED, profiles: [] };
    await chrome.storage.local.set({ crev_settings: current, crev_settings_backup: STORED });
    expect(await h.settings.loadStoredSettings()).toBe(true);
    expect(h.ctx.settings.profiles).toEqual([]);
  });

  it('a failed read says that a backup exists, and does not restore from it', async () => {
    const h = await harness();
    const ok = await h.settings.loadSettingsFrom(undefined, false, STORED);
    expect(ok).toBe(false);
    expect(h.settings.settingsStatus()).toMatchObject({ status: 'failed', backupAvailable: true });
    expect(h.ctx.settings.profiles).toEqual([]);
  });
});
