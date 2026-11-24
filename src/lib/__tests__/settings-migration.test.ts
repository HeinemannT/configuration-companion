import { describe, expect, it } from 'vitest';
import { migrateAiSettingsToV5, migrateStoredSettings } from '../settings';

describe('migrateStoredSettings', () => {
  it('migrates a legacy flat profile with complete credentials to stored commands', () => {
    const settings: any = { bmpUrl: 'https://x/Ws/', bmpUser: 'admin', bmpPass: 'enc:secret' };
    expect(migrateStoredSettings(settings)).toBe(true);
    expect(settings.schemaVersion).toBe(5);
    expect(settings.bmpUrl).toBeUndefined();
    expect(settings.profiles).toHaveLength(1);
    expect(settings.profiles[0]).toMatchObject({
      bmpUrl: 'https://x/Ws/',
      bmpUser: 'admin',
      bmpPass: 'enc:secret',
      commandAuthMode: 'stored',
    });
    expect(settings.profiles[0].authMode).toBeUndefined();
    expect(settings.profiles[0].commandAuthRevision).toEqual(expect.any(String));
    expect(settings.commandAuthMigrationNotices).toEqual([
      { profileId: settings.profiles[0].id, user: 'admin' },
    ]);
  });

  it.each([
    ['session', 'portal', 'admin', 'enc:x'],
    ['password', 'stored', 'admin', 'enc:x'],
    ['auto', 'stored', 'admin', 'enc:x'],
    ['auto', 'portal', 'admin', ''],
    ['auto', 'portal', '', 'enc:x'],
  ] as const)('maps legacy %s to %s deterministically', (authMode, expected, bmpUser, bmpPass) => {
    const settings: any = {
      schemaVersion: 3,
      profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser, bmpPass, authMode }],
      activeProfileId: 'a',
    };
    expect(migrateStoredSettings(settings)).toBe(true);
    expect(settings.schemaVersion).toBe(5);
    expect(settings.profiles[0].commandAuthMode).toBe(expected);
    expect(settings.profiles[0].authMode).toBeUndefined();
  });

  it('v4 → v5 moves the one AI key, still encrypted, to its provider without loss', () => {
    const settings: any = {
      schemaVersion: 4,
      profiles: [{
        id: 'a', label: 'A', bmpUrl: 'u', bmpUser: 'admin', bmpPass: 'enc:x',
        commandAuthMode: 'stored', commandAuthRevision: 'rev-1',
      }],
      activeProfileId: 'a',
      ai: {
        provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnc: 'enc:key',
        lastTest: { ok: true, ms: 321, at: 1700000000000 },
      },
    };
    expect(migrateStoredSettings(settings)).toBe(true);
    expect(settings.schemaVersion).toBe(5);
    expect(settings.profiles[0].commandAuthRevision).toBe('rev-1');
    expect(settings.ai).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      keys: {
        deepseek: {
          apiKeyEnc: 'enc:key',
          model: 'deepseek-v4-flash',
          lastTest: { ok: true, ms: 321, at: 1700000000000, model: 'deepseek-v4-flash' },
        },
      },
    });
    // Idempotent once on v5.
    expect(migrateStoredSettings(settings)).toBe(false);
    expect(settings.ai.keys.deepseek.apiKeyEnc).toBe('enc:key');
  });

  it('v4 → v5 keeps a custom provider catalogue and its key in the custom entry', () => {
    const customProvider = {
      name: 'Gateway', vendor: 'gw', apiType: 'openai',
      models: [{ id: 'agent', name: 'Agent', url: 'https://gw.test/v1', toolCalling: true }],
    };
    const settings: any = {
      schemaVersion: 4, profiles: [], activeProfileId: '',
      ai: { provider: 'custom', model: 'agent', apiKeyEnc: 'enc:gw', customProvider },
    };
    migrateStoredSettings(settings);
    expect(settings.ai).toEqual({
      provider: 'custom', model: 'agent', customProvider,
      keys: { custom: { apiKeyEnc: 'enc:gw', model: 'agent' } },
    });
  });

  it('v4 → v5 turns an AI entry without a key into empty keys, and leaves absent AI absent', () => {
    expect(migrateAiSettingsToV5({ provider: 'openai', model: 'gpt-5.2', apiKeyEnc: '' }))
      .toEqual({ provider: 'openai', model: 'gpt-5.2', keys: {} });
    const settings: any = { schemaVersion: 4, profiles: [], activeProfileId: '' };
    migrateStoredSettings(settings);
    expect(settings.ai).toBeUndefined();
  });

  it('migrateAiSettingsToV5 never overwrites an existing per-provider key', () => {
    expect(migrateAiSettingsToV5({
      provider: 'openai', model: 'gpt-5.2', apiKeyEnc: 'enc:stale',
      keys: { openai: { apiKeyEnc: 'enc:current' } },
    })).toEqual({ provider: 'openai', model: 'gpt-5.2', keys: { openai: { apiKeyEnc: 'enc:current' } } });
  });

  it('removes the obsolete standalone paint mask', () => {
    const settings: any = {
      schemaVersion: 5,
      profiles: [],
      activeProfileId: '',
      paintProps: ['headerColor'],
    };
    expect(migrateStoredSettings(settings)).toBe(true);
    expect(settings.paintProps).toBeUndefined();
    expect(migrateStoredSettings(settings)).toBe(false);
  });

  it('does not throw on malformed profiles data', () => {
    const settings: any = { schemaVersion: 1, profiles: 'corrupt' };
    expect(() => migrateStoredSettings(settings)).not.toThrow();
    expect(settings.schemaVersion).toBe(5);
  });
});
