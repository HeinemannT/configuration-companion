import type { SavedWorkspace } from './workspace';
import type { DraftStore } from './storage';

/** Debounce view activity, serialize transactions, and retain a close guard after
 * failure. Factories are sampled at dispatch, so queued saves cannot overwrite
 * newer edits with a stale snapshot or pay for an extra full-graph clone. */
export function createWorkspacePersistence(open: () => Promise<DraftStore>, onError: (error: unknown) => void) {
  let pending: (() => SavedWorkspace) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<void> = Promise.resolve();
  let connection: Promise<DraftStore> | undefined;
  let inFlight = 0, failed = false;

  function flush(): Promise<void> {
    clearTimeout(timer);
    const read = pending; pending = undefined;
    if (!read) return tail;
    inFlight++;
    tail = tail.catch(() => {}).then(async () => {
      let store: DraftStore | undefined;
      try {
        store = await (connection ??= open());
        await store.write(read);
        failed = false;
      } catch (error) {
        store?.close(); connection = undefined; failed = true;
        throw error;
      } finally { inFlight--; }
    });
    return tail;
  }
  return {
    persist(read: () => SavedWorkspace, immediate = false): Promise<void> {
      pending = read; clearTimeout(timer);
      if (immediate) return flush();
      timer = setTimeout(() => { void flush().catch(onError); }, 350);
      return Promise.resolve();
    },
    get pending() { return !!pending || inFlight > 0 || failed; }
  };
}
