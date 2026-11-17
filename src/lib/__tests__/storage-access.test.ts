/**
 * Extension storage is closed to content scripts (storage-access.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { lockExtensionStorage } from '../storage-access';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.(ts|js)$/.test(name) && !/\.test\.(ts|js)$/.test(name) ? [path] : [];
  });
}

describe('extension storage access level', () => {
  it('restricts local and session storage to trusted contexts', async () => {
    const local = vi.fn(async () => {});
    const session = vi.fn(async () => {});
    (globalThis as any).chrome = { storage: { local: { setAccessLevel: local }, session: { setAccessLevel: session } } };
    await lockExtensionStorage();
    expect(local).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(session).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('restricts sync storage too, and skips it where the browser has no sync area or no access levels', async () => {
    const sync = vi.fn(async () => {});
    (globalThis as any).chrome = { storage: { local: { setAccessLevel: vi.fn(async () => {}) }, session: { setAccessLevel: vi.fn(async () => {}) }, sync: { setAccessLevel: sync } } };
    await lockExtensionStorage();
    expect(sync).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    const session = vi.fn(async () => {});
    (globalThis as any).chrome = { storage: { local: { setAccessLevel: vi.fn(async () => {}) }, session: { setAccessLevel: session } } };
    await expect(lockExtensionStorage()).resolves.toBeUndefined();
    (globalThis as any).chrome = { storage: { local: {}, session: { setAccessLevel: session }, sync: { get: vi.fn() } } };
    await expect(lockExtensionStorage()).resolves.toBeUndefined();
    expect(session).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one area refuses', async () => {
    const session = vi.fn(async () => {});
    (globalThis as any).chrome = { storage: { local: { setAccessLevel: vi.fn(async () => { throw new Error('no'); }) }, session: { setAccessLevel: session } } };
    await expect(lockExtensionStorage()).resolves.toBeUndefined();
    expect(session).toHaveBeenCalled();
  });

  it('is the first storage step of the service worker', () => {
    const sw = readFileSync('src/service-worker.ts', 'utf8');
    const lock = sw.indexOf('lockExtensionStorage()');
    expect(lock).toBeGreaterThan(0);
    // Every storage call of the worker's own start-up comes after it.
    const firstStorage = sw.search(/chrome\.storage\.(local|session)\.(get|set|remove)\(/);
    expect(lock).toBeLessThan(firstStorage);
    expect(sw).toMatch(/storageLocked\.then\(\(\) => Promise\.all\(/);
  });

  it('nothing widens storage access to untrusted contexts', () => {
    const offenders = sources('src').filter(file => /TRUSTED_AND_UNTRUSTED_CONTEXTS/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
