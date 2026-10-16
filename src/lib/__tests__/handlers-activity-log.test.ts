import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSwContext } from '../sw-context';

const invalidateRid = vi.fn(async () => {});
vi.mock('../enrichment', () => ({ invalidateRid }));

function makeContext(result: Record<string, unknown>) {
  const ctx: any = {
    client: {
      executeEc: vi.fn(async () => result),
      saveProperty: vi.fn(async () => result),
      saveCodeViaEc: vi.fn(async () => result),
    },
    cache: {
      get: vi.fn(() => ({
        rid: 'rid-1',
        name: 'Risk register',
        businessId: 'sc_risk_register',
        type: 'ModelPage',
      })),
    },
    history: { record: vi.fn() },
    scriptHistory: { record: vi.fn() },
    logActivity: vi.fn(),
    toast: vi.fn(),
  };
  setSwContext(ctx);
  return ctx;
}

async function handler(type: 'EC_EXECUTE' | 'SAVE_PROPERTY') {
  const { getHandler } = await import('../handler-registry');
  await import('../handlers/ec');
  return getHandler(type)!;
}

beforeEach(() => {
  invalidateRid.mockClear();
});

describe('action activity logging', () => {
  it.each(['EC_EXECUTE', 'SAVE_PROPERTY'] as const)('keeps late %s outcomes attached to the original workspace', async type => {
    const ctx = makeContext({ ok: true });
    ctx.settings = { activeProfileId: 'old' };
    ctx.client.serverUrl = 'https://old.test/';
    ctx.client.commandUser = 'original-user';
    ctx.client.authMode = 'stored';
    let finish!: (result: unknown) => void;
    const operation = type === 'EC_EXECUTE' ? ctx.client.executeEc : ctx.client.saveProperty;
    operation.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const respond = vi.fn();
    const pending = (await handler(type))({ type, code: '1', rid: 'rid-1', objectRid: 'rid-1',
      property: 'name', value: 'Example', environment: 'old@https://old.test/' } as any, respond, { isOneShot: true });
    ctx.settings.activeProfileId = 'new';
    ctx.client = { serverUrl: 'https://new.test/' };
    finish({ ok: true });
    await pending;
    expect(ctx.scriptHistory.record).not.toHaveBeenCalled();
    expect(ctx.history.record).not.toHaveBeenCalled();
    expect(invalidateRid).not.toHaveBeenCalled();
    expect(ctx.logActivity).toHaveBeenCalledWith('success', expect.any(String), undefined,
      expect.objectContaining({ profileId: 'old', commandActor: 'original-user', commandAuthSource: 'stored-login' }));
  });
  it('rejects an editor command loaded from a different BMP environment', async () => {
    const ctx = makeContext({ ok: true });
    ctx.settings = { activeProfileId: 'current' };
    ctx.client.serverUrl = 'https://current.test/BMP';
    const respond = vi.fn();

    await (await handler('EC_EXECUTE'))({
      type: 'EC_EXECUTE',
      code: 'output("must not run")',
      transactional: true,
      environment: 'old@https://old.test/BMP',
    } as any, respond, { isOneShot: true });

    expect(ctx.client.executeEc).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      type: 'EC_RESULT',
      ok: false,
      error: expect.stringContaining('environment changed'),
    }));
  });

  it('records useful EC output but excludes noisy BMP warnings', async () => {
    const ctx = makeContext({
      ok: true,
      outputEntries: [
        { logType: 'WARNING', message: 'Very frequent BMP warning', result: false },
        { logType: 'SHOW_RESULT', message: 'Updated 4 objects', result: false },
      ],
    });
    const respond = vi.fn();

    await (await handler('EC_EXECUTE'))({
      type: 'EC_EXECUTE',
      code: 'output("done")',
      objectRid: 'rid-1',
      property: 'expression',
      transactional: true,
    } as any, respond, { isOneShot: true });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ type: 'EC_RESULT', ok: true }));
    expect(ctx.logActivity).toHaveBeenCalledWith(
      'success',
      expect.stringContaining('Executed EC on Risk register · expression'),
      'SHOW_RESULT: Updated 4 objects',
      expect.objectContaining({
        category: 'execution',
        action: 'execute',
        object: expect.objectContaining({ rid: 'rid-1', businessId: 'sc_risk_register' }),
      }),
    );
    expect(JSON.stringify(ctx.logActivity.mock.calls)).not.toContain('Very frequent BMP warning');
  });

  it('records ordinary save failures, not only thrown requests', async () => {
    const ctx = makeContext({ ok: false, error: 'Validation rejected the value' });

    await (await handler('SAVE_PROPERTY'))({
      type: 'SAVE_PROPERTY',
      rid: 'rid-1',
      objectType: 'ModelPage',
      property: 'name',
      value: 'Changed name',
    } as any, vi.fn(), { isOneShot: true });

    expect(ctx.logActivity).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Save failed for name on Risk register'),
      'Validation rejected the value',
      expect.objectContaining({ category: 'change', action: 'save-property' }),
    );
    expect(invalidateRid).not.toHaveBeenCalled();
  });
});
