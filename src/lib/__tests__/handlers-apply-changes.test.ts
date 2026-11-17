/**
 * APPLY_OBJECT_CHANGES (object window property saves): the write is sent as
 * before, and a write whose answer was lost is reported as outcome unknown.
 */
import { describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

const mocks = vi.hoisted(() => ({ invalidateRid: vi.fn(async () => {}), incrementGeneration: vi.fn() }));
vi.mock('../enrichment', async importOriginal => ({
  ...(await importOriginal<typeof import('../enrichment')>()),
  invalidateRid: mocks.invalidateRid, incrementGeneration: mocks.incrementGeneration,
}));
vi.mock('../code-index-service', () => ({ noteSavedObject: vi.fn(), clearCodeIndex: vi.fn() }));

async function harness(applyObjectChanges: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  mockChromeStorage();
  const ctx: any = {
    client: { serverUrl: 'https://bmp.example/Steadfast/', applyObjectChanges },
    cache: { get: vi.fn(() => null) },
    logActivity: vi.fn(),
    toast: vi.fn(),
  };
  const { setSwContext } = await import('../sw-context');
  const { getHandler } = await import('../handler-registry');
  setSwContext(ctx);
  await import('../handlers/objects');
  const respond = vi.fn();
  await getHandler('APPLY_OBJECT_CHANGES')!({
    type: 'APPLY_OBJECT_CHANGES', rid: '9007199254740993', target: 'instance', changes: { shadow: false }, resetProps: [],
  } as any, respond, { isOneShot: true } as any);
  return { ctx, respond: respond.mock.calls[0][0] };
}

describe('APPLY_OBJECT_CHANGES', () => {
  it('sends the same change as before and answers ok', async () => {
    const apply = vi.fn(async () => ({ ok: true }));
    const h = await harness(apply);
    expect(apply).toHaveBeenCalledWith('9007199254740993', 'instance', { shadow: false }, []);
    expect(h.respond).toEqual({ type: 'APPLY_CHANGES_RESULT', rid: '9007199254740993', ok: true, error: undefined });
  });

  it('a lost answer is outcome unknown: "may have been applied", never "Save failed"', async () => {
    const apply = vi.fn(async () => ({ ok: false, error: 'EC execution timed out (60s)', outcomeUnknown: true }));
    const h = await harness(apply);
    expect(h.respond).toEqual({ type: 'APPLY_CHANGES_RESULT', rid: '9007199254740993', ok: false, error: 'EC execution timed out (60s)', outcomeUnknown: true });
    expect(h.ctx.toast).toHaveBeenCalledWith('No answer from BMP. The save may have been applied.', 'error');
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
