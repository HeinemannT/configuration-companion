import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCtx: vi.fn(),
  launchFrame: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock('../sw-context', () => ({ getCtx: mocks.getCtx, boundCtxForTab: async (_tab: number | undefined, fallback?: unknown) => fallback ?? mocks.getCtx() }));
vi.mock('../frame-launcher', () => ({ launchFrame: mocks.launchFrame, resolveFrameTargetTabId: async (t?: { tabId?: number }) => t?.tabId ?? 1 }));
vi.mock('../handlers/object-window', () => ({ prefetchObjectRoot: mocks.prefetch }));

describe('object view launch ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCtx.mockReturnValue({
      settingsReady: Promise.resolve(),
      cache: {
        get: () => ({ name: 'Risk', type: 'CeRisk', businessId: 'risk.1' }),
      },
    });
    mocks.launchFrame.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('starts mounting before the optional title hint finishes writing', async () => {
    let finishWrite!: () => void;
    const storageSet = vi.fn(() => new Promise<void>(resolve => { finishWrite = resolve; }));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: { set: storageSet } },
    };

    const { openObjectViewWindow } = await import('../objectview-launcher');
    let completed = false;
    const opening = openObjectViewWindow('42', { tabId: 7 }).then(() => { completed = true; });

    await vi.waitFor(() => expect(mocks.launchFrame).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'objectview',
      path: 'objectview/window.html#42',
      resourceKey: 'objectview:window',
      activation: { type: 'objectview', rid: '42', name: 'Risk', objectType: 'CeRisk', businessId: 'risk.1' },
      tabId: 7,
    })));
    expect(storageSet).toHaveBeenCalledOnce();
    expect(completed).toBe(false);

    finishWrite();
    await opening;
    expect(completed).toBe(true);
  });

  it('starts the root read with the type the sender knows before the frame asks; the sender names win', async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: { set: vi.fn(async () => {}) } } };
    mocks.launchFrame.mockImplementation(async () => {
      // The read is already under way when the frame is mounted.
      expect(mocks.prefetch).toHaveBeenCalledWith('43', 'InputView', expect.anything());
    });
    const { openObjectViewWindow } = await import('../objectview-launcher');
    await openObjectViewWindow('43', { tabId: 7 }, { name: 'Input view', type: 'InputView', businessId: 'iv' });
    expect(mocks.launchFrame).toHaveBeenCalledWith(expect.objectContaining({
      label: 'InputView · Input view',
      activation: { type: 'objectview', rid: '43', name: 'Input view', objectType: 'InputView', businessId: 'iv' },
    }));
  });
});
