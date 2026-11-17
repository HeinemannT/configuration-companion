/** Production-facing coverage for object and context handlers that do not yet
 * have a narrower dedicated suite. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { warmImports } from './warm-imports';

// The client and the handlers these tests load, once, before the tests.
warmImports(() => Promise.all([import('../bmp-client'), import('../handlers/detection'), import('../handler-registry'), import('../context-rid')]), mockChromeStorage, { reset: false });

describe('batchEnrich returns error when all refs fail', () => {
  it('returns the server error when every object fails, without resolving references', async () => {
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass', 'test');
    client.applyVersionFlags('5.6.7.2');

    // References are not needed any more (the object is the command's context).
    (client as any).resolveRef = vi.fn(async () => { throw new Error('not found'); });
    (client as any).executeEc = vi.fn(async () => ({ ok: false, error: 'Object not found' }));

    const result = await client.batchEnrich(['111', '222']);
    expect(result.results).toEqual({});
    expect(result.error).toContain('Object not found');
    expect((client as any).resolveRef).not.toHaveBeenCalled();
  });

  it('succeeds when some refs resolve', async () => {
    const { BmpClient } = await import('../bmp-client');
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass', 'test');
    client.applyVersionFlags('5.6.7.2');

    // Mock resolveRef: first succeeds, second fails
    let callCount = 0;
    (client as any).resolveRef = vi.fn(async (rid: string) => {
      callCount++;
      if (callCount === 1) return `lookup(${rid})`;
      throw new Error('not found');
    });

    // Mock executeEc to return valid output
    (client as any).executeEc = vi.fn(async () => ({
      ok: true,
      log: '~CREV_R~' + ['111', 'bid_1', 'Scorecard', 'Name1', 'tmpl1', '', '', '', ''].map(f => `${f.length}:${f}`).join('') + '~CREV_D~',
    }));

    const result = await client.batchEnrich(['111', '222']);
    expect(result.error).toBeUndefined();
    expect(result.results['111']).toBeDefined();
    expect(result.results['111'].businessId).toBe('bid_1');
    expect(result.results['111'].templateBusinessId).toBe('tmpl1');
  });
});

import { mockChromeStorage } from './chrome-mock';
import { setSwContext } from '../sw-context';

function makeHandlerCtx(overrides: any = {}) {
  const panelMessages: any[] = [];
  const activities: Array<{ level: string; message: string }> = [];
  const ctx: any = {
    client: null,
    hasPanel: false,
    panelPortByWindow: new Map(),
    contentPorts: new Map(),
    cache: { get: vi.fn(() => null), put: vi.fn(), putAll: vi.fn(), size: 0 },
    history: { record: vi.fn() },
    favorites: { toggle: vi.fn(), getAll: vi.fn(() => []) },
    scriptHistory: { record: vi.fn() },
    stylePresets: { getAll: vi.fn(() => []), save: vi.fn(), remove: vi.fn(), load: vi.fn(), switchProfile: vi.fn(async () => {}) } as any,
    settings: { schemaVersion: 1, profiles: [], activeProfileId: null, autoDetect: true, saveTarget: 'template', enrichMode: 'widgets' },
    inspectActive: false,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn((level: string, message: string) => activities.push({ level, message })),
    sendToPanel: vi.fn((msg: any) => panelMessages.push(msg)),
    sendToPanelByWindow: vi.fn(),
    sendToPanelByTab: vi.fn(),
    broadcastToContent: vi.fn(),
    toast: vi.fn(),
    _panelMessages: panelMessages,
    _activities: activities,
    ...overrides,
  };
  return ctx;
}

describe('GET_CONTEXT_RID handler', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('sends context RID data for active tab', async () => {
    // Mock chrome.tabs.query to synchronously invoke callback
    // Promise-form of chrome.tabs.query (MV3 Chrome supports both).
    // Our handler uses the Promise form via async/await.
    (globalThis as any).chrome.tabs.query = vi.fn(async () => [{ id: 42 }]);
    (globalThis as any).chrome.tabs.get = vi.fn(async () => ({ url: undefined }));

    const { setContextRid } = await import('../context-rid');
    setContextRid(42, { rid: '999', name: 'TestObj', type: 'Scorecard', businessId: 'sc1' });

    const ctx = makeHandlerCtx();
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/detection');
    const entry = getHandler('GET_CONTEXT_RID');
    expect(entry).toBeDefined();

    await entry!({ type: 'GET_CONTEXT_RID' } as any, () => {}, { isOneShot: false });

    // sendToPanel is called inside the chrome.tabs.query callback (synchronous mock)
    expect(ctx.sendToPanel).toHaveBeenCalled();
    const msg = ctx._panelMessages[0];
    expect(msg.type).toBe('CONTEXT_RID_DATA');
    expect(msg.rid).toBe('999');
    expect(msg.name).toBe('TestObj');
    expect(msg.objectType).toBe('Scorecard');
    expect(msg.businessId).toBe('sc1');
  });

  it('sends undefined rid when no active tab', async () => {
    (globalThis as any).chrome.tabs.query = vi.fn(async () => []);
    (globalThis as any).chrome.tabs.get = vi.fn(async () => ({ url: undefined }));

    const ctx = makeHandlerCtx();
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/detection');
    const entry = getHandler('GET_CONTEXT_RID');

    await entry!({ type: 'GET_CONTEXT_RID' } as any, () => {}, { isOneShot: false });

    expect(ctx.sendToPanel).toHaveBeenCalled();
    const msg = ctx._panelMessages[0];
    expect(msg.type).toBe('CONTEXT_RID_DATA');
    expect(msg.rid).toBeUndefined();
  });

  it('sends undefined fields when tab has no context entry', async () => {
    (globalThis as any).chrome.tabs.query = vi.fn(async () => [{ id: 77 }]);
    (globalThis as any).chrome.tabs.get = vi.fn(async () => ({ url: undefined }));

    const { deleteContextRid } = await import('../context-rid');
    deleteContextRid(77); // ensure no entry

    const ctx = makeHandlerCtx();
    setSwContext(ctx);

    const { getHandler } = await import('../handler-registry');
    await import('../handlers/detection');
    const entry = getHandler('GET_CONTEXT_RID');

    await entry!({ type: 'GET_CONTEXT_RID' } as any, () => {}, { isOneShot: false });

    const msg = ctx._panelMessages[0];
    expect(msg.rid).toBeUndefined();
    expect(msg.name).toBeUndefined();
  });
});
