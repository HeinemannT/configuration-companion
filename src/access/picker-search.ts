export type SearchState<T> =
  | { phase: 'loading' }
  | { phase: 'complete'; result: T }
  | { phase: 'failed'; error: string };

/** One picker, one latest query. Repeated renders do not repeat a request;
 * retry does. Generation identity rejects late replies even for A → B → A. */
export function createPickerSearch<T>(publish: (state: SearchState<T>) => void) {
  type Query = { key: string; load: (signal: AbortSignal) => Promise<T>; controller: AbortController };
  let current: Query | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    current?.controller.abort();
    current = undefined;
  };
  const update = (key: string, load: Query['load']) => {
    if (current?.key === key) return;
    cancel();
    const query: Query = { key, load, controller: new AbortController() };
    current = query;
    timer = setTimeout(() => {
      void Promise.resolve().then(() => {
        query.controller.signal.throwIfAborted();
        return load(query.controller.signal);
      }).then(result => {
        if (current === query) publish({ phase: 'complete', result });
      }, error => {
        if (current === query) publish({ phase: 'failed', error: error instanceof Error ? error.message : String(error) });
      });
    }, 220);
    publish({ phase: 'loading' });
  };
  const retry = () => {
    if (!current) return;
    const { key, load } = current;
    cancel();
    update(key, load);
  };
  return { update, retry, cancel };
}
