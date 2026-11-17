import { expect, it, vi } from 'vitest';
import { createSchemaCache } from './schema-cache';

it('asks once per type and remembers a failure for the session', async () => {
  const load = vi.fn(async type => { if (type === 'CanBeOffline') throw new Error('Missing value for CanBeOffline'); });
  const cache = createSchemaCache(load);
  await Promise.all([cache.load('CeRisk'), cache.load('CeRisk')]);
  await cache.load('CeRisk');
  expect(load).toHaveBeenCalledTimes(1);
  expect(cache.has('CeRisk')).toBe(true);
  for (let i = 0; i < 3; i++) await expect(cache.load('CanBeOffline')).rejects.toThrow('Missing value');
  expect(load).toHaveBeenCalledTimes(2);
  expect(cache.failure('CanBeOffline').message).toContain('CanBeOffline');
  cache.forget('CanBeOffline');
  expect(cache.failure('CanBeOffline')).toBeUndefined();
  await expect(cache.load('CanBeOffline')).rejects.toThrow();
  expect(load).toHaveBeenCalledTimes(3);
});

it('ignores answers that arrive after a reload and accepts a refusal to store', async () => {
  let resolve;
  const cache = createSchemaCache(() => new Promise(r => { resolve = r; }));
  const first = cache.load('A'); await Promise.resolve(); cache.clear(); resolve(); await first;
  expect(cache.has('A')).toBe(false);
  const refused = createSchemaCache(async () => false);
  await refused.load('B');
  expect(refused.has('B')).toBe(false);
});
