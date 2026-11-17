import { expect, it, vi } from 'vitest';
import { createLazyEditor } from './lazy-editor.js';

it('mounts only the latest connected host and reuses the loaded module', async () => {
  let resolve;
  const load = vi.fn(() => new Promise(done => { resolve = done; }));
  const loader = createLazyEditor(load), first = vi.fn(), latest = vi.fn(), failed = vi.fn();
  const old = loader.mount({ isConnected: true }, first, failed);
  loader.cancel();
  const current = loader.mount({ isConnected: true }, latest, failed);
  const create = vi.fn(); resolve({ createJSONEditor: create });
  await Promise.all([old, current]);
  expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledWith(create);
  await loader.mount({ isConnected: false }, first, failed);
  expect(first).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
});

it('ignores failures for abandoned views and retries a failed import', async () => {
  let reject;
  const create = vi.fn(), load = vi.fn().mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }))
    .mockResolvedValue({ createJSONEditor: create });
  const loader = createLazyEditor(load), ready = vi.fn(), failed = vi.fn();
  const old = loader.mount({ isConnected: true }, ready, failed);
  loader.cancel(); reject(new Error('Import failed')); await old;
  expect(failed).not.toHaveBeenCalled();
  await loader.mount({ isConnected: true }, ready, failed);
  expect(ready).toHaveBeenCalledWith(create); expect(load).toHaveBeenCalledTimes(2);
});

it('reports an active import failure so the view can offer retry', async () => {
  const error = new Error('Offline'), failed = vi.fn();
  await createLazyEditor(() => Promise.reject(error)).mount({ isConnected: true }, vi.fn(), failed);
  expect(failed).toHaveBeenCalledWith(error);
});
