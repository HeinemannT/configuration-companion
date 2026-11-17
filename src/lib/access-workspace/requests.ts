import type { BmpClient } from '../bmp-client';

interface SharedRead { promise: Promise<unknown>; controller: AbortController; subscribers: number; }
const pending = new WeakMap<BmpClient, Map<string, SharedRead>>();
/** Share simultaneous identical reads, never retain results across edits or reloads. */
export function shareRead<T>(client: BmpClient, key: string, read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error('Request cancelled.'));
  let requests = pending.get(client);
  if (!requests) { requests = new Map(); pending.set(client, requests); }
  let shared = requests.get(key);
  if (!shared) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return read(controller.signal); }).finally(() => { if (requests.get(key)?.promise === promise) requests.delete(key); });
    shared = { promise, controller, subscribers: 0 }; requests.set(key, shared);
  }
  const current = shared;
  current.subscribers++;
  if (!signal) { void current.promise.finally(() => { current.subscribers--; }).catch(() => {}); return current.promise as Promise<T>; }
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const release = () => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); current.subscribers--; };
    const abort = () => {
      release();
      if (!current.subscribers) { current.controller.abort(); if (requests.get(key) === current) requests.delete(key); }
      reject(new Error('Request cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    current.promise.then(value => { release(); resolve(value as T); }, error => { release(); reject(error instanceof Error ? error : new Error(String(error))); });
  });
}
export const readTypeFields = (client: BmpClient, type: string, signal?: AbortSignal) => shareRead(client, 'fields:' + type, sharedSignal => client.fetchTypeFields(type, sharedSignal), signal);
