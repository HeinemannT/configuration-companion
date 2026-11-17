// Property lists per type, read once per session. A failed lookup is remembered,
// so a re-render never asks the server again for a type that is not a class
// (for example a custom resource type such as CanBeOffline).
export type SchemaLoader = (type: string) => unknown;
export function createSchemaCache(load: SchemaLoader) {
  const loaded = new Set<string>(), pending = new Map<string, Promise<void>>(), failed = new Map<string, Error>();
  let generation = 0;
  return {
    loaded, failed,
    has: (type: string) => loaded.has(type),
    failure: (type: string) => failed.get(type),
    /** Resolves when loaded; rejects with the remembered error for a known failure. */
    load(type: string): Promise<void> {
      if (!type || loaded.has(type)) return Promise.resolve();
      if (failed.has(type)) return Promise.reject(failed.get(type) as Error);
      if (pending.has(type)) return pending.get(type) as Promise<void>;
      const started = generation;
      const promise: Promise<void> = Promise.resolve().then(() => load(type)).then(
        (accept: unknown) => { if (started === generation && accept !== false) loaded.add(type); },
        (error: unknown) => { if (started === generation) failed.set(type, error instanceof Error ? error : new Error(String(error))); throw error; })
        .finally(() => { if (pending.get(type) === promise) pending.delete(type); });
      pending.set(type, promise);
      return promise;
    },
    /** An explicit retry asks again. */
    forget(type: string) { failed.delete(type); },
    clear() { generation++; loaded.clear(); pending.clear(); failed.clear(); },
  };
}
