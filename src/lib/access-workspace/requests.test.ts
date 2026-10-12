import { expect, it, vi } from 'vitest';
import type { BmpClient } from '../bmp-client';
import { shareRead } from './requests';

it('shares in-flight reads per client and key, without caching later reads', async () => {
  const client = {} as BmpClient, other = {} as BmpClient;
  const read = vi.fn().mockResolvedValue(['original']);
  const a = shareRead(client, 'schema:Organisation', read);
  expect(shareRead(client, 'schema:Organisation', read)).toBe(a);
  await Promise.all([a, shareRead(other, 'schema:Organisation', read), shareRead(client, 'schema:CeTask', read)]);
  expect(read).toHaveBeenCalledTimes(3);
  read.mockResolvedValue(['changed']);
  expect(await shareRead(client, 'schema:Organisation', read)).toEqual(['changed']);
  expect(read).toHaveBeenCalledTimes(4);
});
it('cancels the underlying read only when every subscriber has left', async () => {
  const client = {} as BmpClient, a = new AbortController(), b = new AbortController();
  let signal: AbortSignal | undefined;
  const read = vi.fn((s: AbortSignal) => { signal = s; return new Promise<string>((_resolve, reject) => s.addEventListener('abort', () => reject(Error('aborted')))); });
  const first = shareRead(client, 'search', read, a.signal), second = shareRead(client, 'search', read, b.signal);
  await Promise.resolve();
  a.abort(); await expect(first).rejects.toThrow('cancelled'); expect(signal?.aborted).toBe(false);
  b.abort(); await expect(second).rejects.toThrow('cancelled'); expect(signal?.aborted).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
  expect(await shareRead(client, 'search', async () => 'fresh')).toBe('fresh');
});
it('releases a failed request so a deliberate retry can succeed', async () => {
  const client = {} as BmpClient;
  const read = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce('fresh');
  await expect(shareRead(client, 'load', read)).rejects.toThrow('offline');
  expect(await shareRead(client, 'load', read)).toBe('fresh');
});
