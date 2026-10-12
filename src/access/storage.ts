import type { SavedWorkspace } from './workspace';

interface Checkpoint extends SavedWorkspace { checkpointId?: string }
interface ViewState { checkpointId: string; state?: unknown; context?: unknown }
export interface DraftStore {
  /** Sample the latest state only when storage is ready, then capture it synchronously in put(). */
  write(read: () => SavedWorkspace): Promise<void>;
  close(): void;
}

/** Keep the v1 store and environment keys readable by existing installations.
 * An array key cannot collide with a legacy string environment key. */
const viewKey = (environment: string) => ['view', environment];
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('companion-access', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Cannot open draft storage.'));
    request.onblocked = () => reject(new Error('Draft storage is blocked by another Access tab.'));
  });
}

/** A stale view from another checkpoint/tab must never restore obsolete JSON drafts or IDs. */
export function restoreDraft(checkpoint?: Checkpoint, view?: ViewState): SavedWorkspace | undefined {
  if (checkpoint?.version !== 1) return undefined;
  return checkpoint.checkpointId && view?.checkpointId === checkpoint.checkpointId
    ? { ...checkpoint, state: view.state, context: view.context } : checkpoint;
}

export async function loadDraft(environment: string): Promise<SavedWorkspace | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('workspaces'), store = tx.objectStore('workspaces');
      const checkpoint = store.get(environment), view = store.get(viewKey(environment));
      tx.oncomplete = () => resolve(restoreDraft(checkpoint.result, view.result));
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Cannot read the local draft.'));
    });
  } finally { db.close(); }
}

/** Use one connection per tab. The persistence queue serializes these writes.
 * Full checkpoints retain the existing recovery format; ordinary navigation writes only state/context. */
export async function openDraftStore(environment: string): Promise<DraftStore> {
  const db = await database();
  let checkpointId: string | undefined, revision: number | undefined;
  return {
    close: () => db.close(),
    write(read) {
      return new Promise<void>((resolve, reject) => {
        // No await between reading mutable workspace state and IndexedDB's own
        // structured clone. A separate structuredClone here would copy it twice.
        const value = read();
        const capturedRevision = value.revision;
        const full = !checkpointId || capturedRevision === undefined || capturedRevision !== revision;
        const id = full ? crypto.randomUUID() : checkpointId!;
        const tx = db.transaction('workspaces', 'readwrite'), store = tx.objectStore('workspaces');
        try {
          if (full) {
            store.put({ ...value, checkpointId: id }, environment);
            store.delete(viewKey(environment));
          } else store.put({ checkpointId: id, state: value.state, context: value.context }, viewKey(environment));
        } catch (error) { tx.abort(); reject(error instanceof Error ? error : new Error(String(error))); return; }
        tx.oncomplete = () => { checkpointId = id; revision = capturedRevision; resolve(); };
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Draft save was interrupted.'));
      });
    }
  };
}

/** One-off full save used when recovering a verified apply receipt. */
export async function saveDraft(environment: string, value: SavedWorkspace): Promise<void> {
  const store = await openDraftStore(environment);
  try { await store.write(() => value); } finally { store.close(); }
}
