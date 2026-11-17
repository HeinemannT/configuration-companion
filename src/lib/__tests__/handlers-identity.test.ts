import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENVIRONMENT_CHANGED_ERROR } from '../environment';
import { mockChromeStorage } from './chrome-mock';

const mocks = vi.hoisted(() => ({
  saveIdentity: vi.fn(),
  invalidateRid: vi.fn(async () => {}),
  publishIdentity: vi.fn(),
}));

vi.mock('../identity-save', () => ({ saveIdentity: mocks.saveIdentity }));
vi.mock('../enrichment', () => ({ invalidateRid: mocks.invalidateRid, publishIdentity: mocks.publishIdentity }));

async function harness(client: Record<string, unknown> | null = { serverUrl: 'https://bmp.example/Steadfast/' }) {
  vi.resetModules();
  mockChromeStorage();
  const ctx: any = {
    client,
    cache: { get: vi.fn(() => null) },
    logActivity: vi.fn(),
  };
  const { setSwContext } = await import('../sw-context');
  const { getHandler } = await import('../handler-registry');
  setSwContext(ctx);
  await import('../handlers/ec');
  return { handler: getHandler('SAVE_IDENTITY')!, saveProperty: getHandler('SAVE_PROPERTY')!, ctx };
}

const message = {
  type: 'SAVE_IDENTITY',
  rid: '9007199254740993',
  businessId: 'new_id',
  name: 'New name',
  templateBusinessId: 'new_template',
} as const;

describe('SAVE_IDENTITY handler adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveIdentity.mockResolvedValue({
      ok: true,
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
  });

  it('delegates the workflow, preserves the response envelope, and refreshes verified identity', async () => {
    const h = await harness();
    const respond = vi.fn();

    await h.handler(message as any, respond, { isOneShot: true });

    expect(mocks.saveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ lookupIdentity: expect.any(Function), applyIdentityChanges: expect.any(Function) }),
      message.rid,
      // Only the identity fields of the message, never its envelope.
      { businessId: 'new_id', name: 'New name', templateBusinessId: 'new_template' },
      expect.any(Function), undefined);
    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: true,
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
    expect(h.ctx.logActivity).toHaveBeenCalledWith(
      'success',
      expect.stringContaining('Saved identity'),
      undefined,
      expect.objectContaining({ action: 'save-property' }),
    );
    expect(mocks.invalidateRid).toHaveBeenCalledWith(message.rid, expect.anything());
  });

  it('updates the badges from the verification read instead of reading the identity again', async () => {
    const verified = { businessId: 'new_id', name: 'New name', type: 'Scorecard', templateBusinessId: 'new_template' };
    const lookupIdentity = vi.fn(async () => verified);
    const h = await harness({ serverUrl: 'https://bmp.example/Steadfast/', lookupIdentity, applyIdentityChanges: vi.fn() });
    mocks.saveIdentity.mockImplementation(async (port: { lookupIdentity(rid: string, o?: { fresh?: boolean }): Promise<unknown> }, rid: string) => {
      await port.lookupIdentity(rid);
      await port.lookupIdentity(rid, { fresh: true });
      return { ok: true, businessId: 'new_id', name: 'New name', templateBusinessId: 'new_template' };
    });

    await h.handler(message as any, vi.fn(), { isOneShot: true });

    expect(lookupIdentity).toHaveBeenCalledTimes(2);
    expect(mocks.publishIdentity).toHaveBeenCalledWith(message.rid, verified, expect.anything());
    expect(mocks.invalidateRid).not.toHaveBeenCalled();
  });

  it('forwards a workflow failure without success effects', async () => {
    const h = await harness();
    const respond = vi.fn();
    mocks.saveIdentity.mockResolvedValue({
      ok: false,
      field: 'businessId',
      error: 'Use letters, numbers, and underscores for the ID.',
    });

    await h.handler(message as any, respond, { isOneShot: true });

    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      field: 'businessId',
      error: 'Use letters, numbers, and underscores for the ID.',
    });
    expect(h.ctx.logActivity).not.toHaveBeenCalled();
    expect(mocks.invalidateRid).not.toHaveBeenCalled();
  });

  it('rejects a stale environment before entering the workflow', async () => {
    const h = await harness();
    h.ctx.settings = { activeProfileId: 'current' };
    const respond = vi.fn();

    await h.handler({ ...message, environment: 'other@https://bmp.example/Steadfast/' } as any, respond, { isOneShot: true });

    expect(mocks.saveIdentity).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      error: ENVIRONMENT_CHANGED_ERROR,
      notSent: true,
    });
  });
  it('rejects a disconnected save without entering the workflow', async () => {
    const h = await harness(null);
    const respond = vi.fn();

    await h.handler(message as any, respond, { isOneShot: true });

    expect(mocks.saveIdentity).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      error: 'Not connected',
      notSent: true,
    });
  });

  it('keeps unexpected workflow errors in the handler activity boundary', async () => {
    const h = await harness();
    const respond = vi.fn();
    mocks.saveIdentity.mockRejectedValue(new Error('Bridge offline'));

    await h.handler(message as any, respond, { isOneShot: true });

    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      error: 'Bridge offline',
    });
    expect(h.ctx.logActivity).toHaveBeenCalledWith(
      'error',
      // Never a bare RID in the sentence (the RID stays in the entry's object).
      'Identity save failed on an object',
      'Bridge offline',
      expect.objectContaining({ action: 'save-property' }),
    );
    expect(mocks.invalidateRid).not.toHaveBeenCalled();
  });
});

describe('SAVE_PROPERTY route choice', () => {
  function client() {
    return {
      serverUrl: 'https://bmp.example/Steadfast/',
      saveCodeViaEc: vi.fn(async () => ({ ok: true })),
      saveProperty: vi.fn(async () => ({ ok: true })),
    };
  }
  const save = (property: string, extra: Record<string, unknown> = {}) => ({
    type: 'SAVE_PROPERTY', rid: '2081208944661642130', objectType: 'ButtonInput', property, value: '// v', ...extra,
  });

  beforeEach(() => vi.clearAllMocks());

  it('saves every expression slot through Extended Code, also without a kind', async () => {
    for (const property of ['expression', 'afterExpression', 'enableExpression', 'showExpression', 'initExpression', 'refreshExpression', 'defaultExpression']) {
      const c = client();
      const h = await harness(c);
      const respond = vi.fn();
      await h.saveProperty(save(property) as any, respond, { isOneShot: true });
      expect(c.saveCodeViaEc, property).toHaveBeenCalledWith('2081208944661642130', property, '// v');
      expect(c.saveProperty, property).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith({ type: 'SAVE_RESULT', ok: true });
    }
  });

  it('uses the read kind when the caller passes it', async () => {
    const c = client();
    const h = await harness(c);
    await h.saveProperty(save('customScript', { valueKind: 'code' }) as any, vi.fn(), { isOneShot: true });
    expect(c.saveCodeViaEc).toHaveBeenCalledWith('2081208944661642130', 'customScript', '// v');
    await h.saveProperty(save('description', { valueKind: 'text' }) as any, vi.fn(), { isOneShot: true });
    expect(c.saveProperty).toHaveBeenCalledWith('2081208944661642130', 'ButtonInput', 'description', '// v');
  });

  it('keeps plain properties and gates on the binary update', async () => {
    const c = client();
    const h = await harness(c);
    await h.saveProperty(save('useShowExpression') as any, vi.fn(), { isOneShot: true });
    expect(c.saveProperty).toHaveBeenCalledWith('2081208944661642130', 'ButtonInput', 'useShowExpression', '// v');
    expect(c.saveCodeViaEc).not.toHaveBeenCalled();
  });

  it('a write whose answer was lost says so (outcome unknown), logged as a warning, not a failure', async () => {
    const c = client();
    c.saveCodeViaEc.mockResolvedValue({ ok: false, error: 'EC execution timed out (60s)', outcomeUnknown: true } as never);
    const h = await harness(c);
    const respond = vi.fn();
    await h.saveProperty(save('expression') as any, respond, { isOneShot: true });
    expect(respond).toHaveBeenCalledWith({ type: 'SAVE_RESULT', ok: false, error: 'EC execution timed out (60s)', outcomeUnknown: true });
    expect(h.ctx.logActivity).toHaveBeenCalledWith('warn', expect.stringContaining('the save may have been applied'), 'EC execution timed out (60s)', expect.anything());
    expect(c.saveCodeViaEc).toHaveBeenCalledTimes(1);
  });

  it('names the object in the Log by what the window knew, never by a bare RID', async () => {
    const c = client();
    const h = await harness(c);
    await h.saveProperty(save('expression', { objectLabel: { name: 'CREV QA After button', businessId: 'crev_qa_btn_after' } }) as any, vi.fn(), { isOneShot: true });
    await h.saveProperty(save('expression') as any, vi.fn(), { isOneShot: true });
    const lines = h.ctx.logActivity.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(lines[0]).toMatch(/^Saved expression on CREV QA After button \(ButtonInput\) \(\d+ms\)$/);
    expect(lines[1]).toMatch(/^Saved expression on a ButtonInput \(\d+ms\)$/);
    expect(lines.join(' ')).not.toContain('2081208944661642130');
  });

  it('marks a disconnected save as not sent', async () => {
    const h = await harness(null);
    const respond = vi.fn();
    await h.saveProperty(save('afterExpression') as any, respond, { isOneShot: true });
    expect(respond).toHaveBeenCalledWith({ type: 'SAVE_RESULT', ok: false, error: 'Not connected', notSent: true });
  });
});
