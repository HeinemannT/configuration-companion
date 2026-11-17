/**
 * Extension storage is for Companion's own pages and the worker only.
 *
 * `chrome.storage.local` holds the server profiles (passwords encrypted with a
 * key derived from the public extension id), the AI key and every cache. By
 * default Chrome lets content scripts read it, and a content script runs next
 * to page code Companion does not control. The worker therefore restricts
 * both areas to trusted contexts at every start, before it reads or writes
 * anything. `chrome.storage.session` is trusted-only by default; it is set
 * again so that nothing can have widened it. `chrome.storage.sync` is not
 * used today; it is locked too (where the browser has the area and the
 * method), so a later use cannot start out readable by content scripts.
 *
 * Content scripts reach the few values they need through worker messages
 * that answer one validated value each (handlers/page-prefs.ts).
 */
import { log } from './logger';

type Lockable = { setAccessLevel?: (o: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void> };

export const TRUSTED_ONLY = 'TRUSTED_CONTEXTS' as const;

export async function lockExtensionStorage(): Promise<void> {
  const storage = (globalThis as { chrome?: { storage?: { local?: Lockable; session?: Lockable; sync?: Lockable } } }).chrome?.storage;
  for (const [name, area] of [['local', storage?.local], ['session', storage?.session], ['sync', storage?.sync]] as const) {
    if (typeof area?.setAccessLevel !== 'function') continue;
    try {
      await area.setAccessLevel({ accessLevel: TRUSTED_ONLY });
    } catch (e) {
      log.swallow(`storageAccess:${name}`, e);
    }
  }
}
