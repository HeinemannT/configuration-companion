/**
 * Item 8: an undecryptable stored password is never used or saved again.
 * Item 9: a failed settings load never changes site-access grants.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

async function settingsHarness() {
  vi.resetModules();
  mockChromeStorage();
  const swCtx = await import('../sw-context');
  const ctx: any = {
    client: null, hasPanel: false, panelPortByWindow: new Map(), contentPorts: new Map(),
    cache: { switchProfile: vi.fn(async () => {}), clear: vi.fn() },
    history: { switchProfile: vi.fn(async () => {}) },
    favorites: { switchProfile: vi.fn(async () => {}) },
    scriptHistory: { switchProfile: vi.fn(async () => {}) },
    stylePresets: { switchProfile: vi.fn(async () => {}) },
    settings: { schemaVersion: 4, profiles: [], activeProfileId: '', autoDetect: true, saveTarget: 'instance', enrichMode: 'all' },
    settingsReady: Promise.resolve(), logActivity: vi.fn(), sendToPanel: vi.fn(), broadcastToContent: vi.fn(),
  };
  swCtx.setSwContext(ctx);
  const settings = await import('../settings');
  settings.createSettingsReady();
  return { ctx, settings, crypto: await import('../crypto') };
}

describe('decrypt', () => {
  it('round-trips with the same extension ID', async () => {
    const { crypto } = await settingsHarness();
    expect(await crypto.decrypt(await crypto.encrypt('s3cret'))).toBe('s3cret');
  });

  it('throws instead of returning the ciphertext when the key changed', async () => {
    const h = await settingsHarness();
    const cipher = await h.crypto.encrypt('s3cret');
    // Another extension ID (an unpacked build loaded from another folder).
    vi.resetModules();
    (globalThis.chrome as any).runtime.id = 'another-extension-id';
    const other = await import('../crypto');
    await expect(other.decrypt(cipher)).rejects.toBeInstanceOf(other.DecryptError);
    await expect(other.decrypt('not base64 at all!')).rejects.toBeInstanceOf(other.DecryptError);
    (globalThis.chrome as any).runtime.id = 'test';
  });
});

describe('loading a profile whose password cannot be decrypted', () => {
  it('drops the value, flags the profile, and saves the flag instead of the ciphertext', async () => {
    const h = await settingsHarness();
    const stored = {
      schemaVersion: 4, activeProfileId: 'p1', autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
      profiles: [{ id: 'p1', label: 'Prod', bmpUrl: 'https://bmp.test/Ws/', bmpUser: 'cfg', bmpPass: 'AAAAciphertextFromAnotherKeyAAAA', commandAuthMode: 'stored' }],
    };
    const ok = await h.settings.loadSettingsFrom(stored);
    expect(ok).toBe(true);
    const p = h.ctx.settings.profiles[0];
    expect(p.bmpPass).toBe('');
    expect(p.passwordUnreadable).toBe(true);
    await h.settings.saveSettings();
    const written = (chrome.storage.local.set as any).mock.calls.at(-1)[0].crev_settings;
    expect(written.profiles[0].bmpPass).toBe('');
    expect(written.profiles[0].passwordUnreadable).toBe(true);
    expect(JSON.stringify(written)).not.toContain('ciphertextFromAnotherKey');
  });
});

describe('a failed settings load (item 9)', () => {
  it('blocks grant reconciliation so no grant is revoked', async () => {
    const h = await settingsHarness();
    const remove = vi.fn(async () => true);
    (globalThis.chrome as any).permissions = {
      getAll: vi.fn(async () => ({ origins: ['https://bmp.test/*'] })),
      remove, contains: vi.fn(async () => true),
    };
    (globalThis.chrome as any).scripting = {
      getRegisteredContentScripts: vi.fn(async () => []), unregisterContentScripts: vi.fn(), registerContentScripts: vi.fn(),
    };
    const ok = await h.settings.loadSettingsFrom(undefined, false);
    expect(ok).toBe(false);
    expect(h.settings.settingsLoadedCleanly()).toBe(false);
    const access = await import('../site-access');
    await access.reconcileProfileOrigins([], undefined);
    expect(remove).not.toHaveBeenCalled();
  });

  it('still reconciles after a clean load', async () => {
    const h = await settingsHarness();
    const remove = vi.fn(async () => true);
    (globalThis.chrome as any).permissions = {
      getAll: vi.fn(async () => ({ origins: ['https://old.test/*'] })),
      remove, contains: vi.fn(async () => true),
    };
    (globalThis.chrome as any).scripting = {
      getRegisteredContentScripts: vi.fn(async () => []), unregisterContentScripts: vi.fn(), registerContentScripts: vi.fn(),
    };
    await h.settings.loadSettingsFrom({ schemaVersion: 4, profiles: [], activeProfileId: '' });
    const access = await import('../site-access');
    await access.reconcileProfileOrigins([], undefined);
    expect(remove).toHaveBeenCalledWith({ origins: ['https://old.test/*'] });
  });
});
