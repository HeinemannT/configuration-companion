import { beforeEach, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

async function harness() {
  vi.resetModules();
  mockChromeStorage();
  const ctx = { settings: { activeProfileId: 'original' },
    client: { serverUrl: 'https://bmp.example/', lookupIdentity: vi.fn() },
    cache: { get: vi.fn() } };
  const { setSwContext } = await import('../sw-context');
  const { getHandler } = await import('../handler-registry');
  setSwContext(ctx as unknown as Parameters<typeof setSwContext>[0]);
  await import('../handlers/objects');
  return { ctx, handler: getHandler('HOVER_LOOKUP')!, respond: vi.fn() };
}
beforeEach(() => vi.clearAllMocks());
const request = { type: 'HOVER_LOOKUP' as const, rid: '9007199254740993', environment: 'original@https://bmp.example/' };

it('checks a bound preview before reading either the cache or the BMP client', async () => {
  const { ctx, handler, respond } = await harness();
  ctx.settings.activeProfileId = 'different';
  ctx.cache.get.mockReturnValue({ type: 'Role', name: 'Wrong role' });
  await handler(request, respond, { isOneShot: true });
  expect(ctx.cache.get).not.toHaveBeenCalled();
  expect(ctx.client.lookupIdentity).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({ type: 'HOVER_LOOKUP_RESULT', rid: request.rid });
});

it.each(['profile', 'client'])('discards an in-flight lookup when the %s changes', async changed => {
  const { ctx, handler, respond } = await harness();
  let finish!: (value: unknown) => void;
  ctx.client.lookupIdentity.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = handler(request, respond, { isOneShot: true });
  if (changed === 'profile') ctx.settings.activeProfileId = 'different';
  else ctx.client = { ...ctx.client };
  finish({ type: 'Role', name: 'Late role' });
  await pending;
  expect(respond).toHaveBeenCalledWith({ type: 'HOVER_LOOKUP_RESULT', rid: request.rid });
});

it('still resolves a role in its captured connection', async () => {
  const { ctx, handler, respond } = await harness();
  ctx.client.lookupIdentity.mockResolvedValue({ type: 'Role', name: 'Expected role', businessId: 'expected' });
  await handler(request, respond, { isOneShot: true });
  expect(ctx.client.lookupIdentity).toHaveBeenCalledWith(request.rid);
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ name: 'Expected role', objectType: 'Role', businessId: 'expected' }));
});
