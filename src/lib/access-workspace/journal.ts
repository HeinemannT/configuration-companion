import type { AccessModel, AccessSnapshot } from './model';

export interface ApplyJournal {
  id: string; environment: string; phase: 'writing' | 'verifying' | 'finishing' | 'complete';
  at: string; baseline: AccessModel; draft: AccessModel; submittedDraft: AccessModel; temporaryIds: Record<string, string>;
  result?: { snapshot: AccessSnapshot; mapping: Record<string, string>; operationId: string };
}

/** Policy catalogues exceed chrome.storage.local's shared quota. Store the
 * durable journal in IndexedDB, and only a small recovery pointer in storage. */
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('companion-access-operations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('applies');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Cannot open apply recovery storage.'));
    request.onblocked = () => reject(new Error('Apply recovery storage is blocked.'));
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('applies', mode), request = action(tx.objectStore('applies'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Could not persist apply recovery state.'));
    });
  } finally { db.close(); }
}
export const readJournal = (id: string): Promise<ApplyJournal | undefined> => transaction('readonly', store => store.get(id));
export const writeJournal = (value: ApplyJournal): Promise<IDBValidKey> => transaction('readwrite', store => store.put(value, value.id));
export const removeJournal = (id: string): Promise<undefined> => transaction('readwrite', store => store.delete(id));
