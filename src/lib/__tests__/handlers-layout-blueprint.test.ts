/**
 * Tests for the SW-side Blueprint orchestration in src/lib/handlers/layout.ts (plan 018):
 *
 *   - INJECT_BLUEPRINT: content.ts's first-activation request → ensureBlueprintScript(senderTabId),
 *     gated on senderTabId being present.
 *   - BLUEPRINT_RESUME: content.ts's post-apply resume request → resolves the tab's window, applies
 *     the inspect↔blueprint exclusivity (turns inspect off if it was on), then sets blueprint ON
 *     pinned to that tab.
 *   - toggleBlueprint / setBlueprintActive: the BLUEPRINT_TOGGLE / Ctrl+Shift+B path — same
 *     exclusivity when turning blueprint on, plus the blueprintActiveByWindow bookkeeping.
 *   - BLUEPRINT_CLOSE: the overlay X explicitly closes the sender tab even when worker state drifted.
 *
 * ensureBlueprintScript and toggleInspect are exercised by their own test suites
 * (content-script-injection.test.ts; toggleInspect's own exclusivity in handlers/inspect.ts is out
 * of scope here) — this file only asserts layout.ts calls them correctly and applies the
 * mutual-exclusivity rule documented at layout.ts:14-18/36-38.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSwContext } from '../sw-context';
import type { InspectorMessage } from '../types';

const ensureBlueprintScript = vi.fn();
const ensureContentScript = vi.fn();
vi.mock('../tab-awareness', () => ({
  ensureBlueprintScript: (...a: unknown[]) => ensureBlueprintScript(...a),
  ensureContentScript: (...a: unknown[]) => ensureContentScript(...a),
}));

const toggleInspect = vi.fn();
vi.mock('../handlers/inspect', () => ({
  toggleInspect: (...a: unknown[]) => toggleInspect(...a),
}));

interface Harness {
  ctx: any;
  panelMsgs: InspectorMessage[];
  tabMessagesSent: Array<{ tabId: number; msg: unknown }>;
}

function makeHarness(overrides: { inspectActiveWindows?: Set<number>; supportsLookup?: boolean } = {}): Harness {
  const panelMsgs: InspectorMessage[] = [];
  const tabMessagesSent: Array<{ tabId: number; msg: unknown }> = [];
  const inspectActiveWindows = overrides.inspectActiveWindows ?? new Set<number>();

  (globalThis as any).chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: 100 }]),
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1 })),
      sendMessage: vi.fn((_tabId: number, msg: unknown) => {
        tabMessagesSent.push({ tabId: _tabId, msg });
        return Promise.resolve();
      }),
    },
    windows: {
      getLastFocused: vi.fn(async () => ({ id: 1 })),
    },
  };

  const ctx: any = {
    client: overrides.supportsLookup === undefined ? null : { supportsLookup: overrides.supportsLookup },
    blueprintActiveByWindow: new Map<number, boolean>(),
    blueprintTabByWindow: new Map<number, number>(),
    persistBlueprintState: vi.fn(),
    isInspectActive: vi.fn((windowId: number | undefined) => windowId != null && inspectActiveWindows.has(windowId)),
    logActivity: vi.fn(),
    toast: vi.fn(),
    sendToPanelByWindow: vi.fn((_w: number, m: InspectorMessage) => panelMsgs.push(m)),
    settings: { activeProfileId: 'p1' },
  };
  setSwContext(ctx);
  return { ctx, panelMsgs, tabMessagesSent };
}

beforeEach(() => {
  // NOTE: deliberately NOT calling vi.resetModules() — layout.ts's handlers read the shared
  // SwContext singleton (sw-context.ts) via getCtx(). Resetting the module registry per test would
  // re-evaluate sw-context.ts too, disconnecting the statically-imported setSwContext() above from
  // the fresh instance getCtx() would read inside a freshly re-imported handlers/layout. Dynamic
  // `import(...)` below is therefore just a cache hit after the first test — register() is
  // idempotent (overwrites by type), so re-"importing" is safe and matches the pattern in
  // objects-discovered.test.ts.
  ensureBlueprintScript.mockClear();
  ensureContentScript.mockClear();
  toggleInspect.mockClear();
});

describe('INJECT_BLUEPRINT handler', () => {
  it('injects content-blueprint.js into the sender tab when senderTabId is present', async () => {
    makeHarness();
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('INJECT_BLUEPRINT');
    expect(entry).toBeDefined();

    await entry!({ type: 'INJECT_BLUEPRINT' } as any, () => {}, { senderTabId: 42, isOneShot: true });

    expect(ensureBlueprintScript).toHaveBeenCalledTimes(1);
    expect(ensureBlueprintScript).toHaveBeenCalledWith(42);
  });

  it('is a no-op when senderTabId is missing', async () => {
    makeHarness();
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('INJECT_BLUEPRINT');

    await entry!({ type: 'INJECT_BLUEPRINT' } as any, () => {}, { isOneShot: true });

    expect(ensureBlueprintScript).not.toHaveBeenCalled();
  });

  it('does not inject Blueprint on a pre-5.6.3 BMP', async () => {
    makeHarness({ supportsLookup: false });
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');

    await getHandler('INJECT_BLUEPRINT')!({ type: 'INJECT_BLUEPRINT' } as any, () => {}, { senderTabId: 42, isOneShot: true });

    expect(ensureBlueprintScript).not.toHaveBeenCalled();
  });
});

describe('BLUEPRINT_RESUME handler', () => {
  it('when inspect is active in the tab\'s window: turns inspect off (exclusivity) then sets blueprint ON pinned to the sender tab', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set([1]) });
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('BLUEPRINT_RESUME');
    expect(entry).toBeDefined();

    await entry!({ type: 'BLUEPRINT_RESUME' } as any, () => {}, { senderTabId: 55, isOneShot: true });

    // chrome.tabs.get(55) resolved windowId 1; inspect was active there → toggleInspect(1) called
    // BEFORE blueprint is switched on (exclusivity).
    expect(toggleInspect).toHaveBeenCalledWith(1);
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true);
    // Pinned to the tab that reloaded (senderTabId), not "the window's active tab" — setBlueprintActive
    // was given tabId=55 explicitly, so it never needed chrome.tabs.query to resolve one.
    expect(h.ctx.blueprintTabByWindow.get(1)).toBe(55);
    expect((globalThis as any).chrome.tabs.query).not.toHaveBeenCalled();
    const toggleOrder = toggleInspect.mock.invocationCallOrder[0];
    const sendOrder = ((globalThis as any).chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(toggleOrder).toBeLessThan(sendOrder);
  });

  it('when inspect is NOT active: skips toggleInspect and just sets blueprint on', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set() });
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('BLUEPRINT_RESUME');

    await entry!({ type: 'BLUEPRINT_RESUME' } as any, () => {}, { senderTabId: 55, isOneShot: true });

    expect(toggleInspect).not.toHaveBeenCalled();
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true);
  });

  it('is a no-op when senderTabId is missing', async () => {
    makeHarness();
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('BLUEPRINT_RESUME');

    await entry!({ type: 'BLUEPRINT_RESUME' } as any, () => {}, { isOneShot: true });

    expect(toggleInspect).not.toHaveBeenCalled();
    expect((globalThis as any).chrome.tabs.get).not.toHaveBeenCalled();
  });
});

describe('BLUEPRINT_CLOSE handler', () => {
  it('closes Blueprint in the sender tab\'s window and sends OFF back to that exact tab', async () => {
    const h = makeHarness();
    h.ctx.blueprintActiveByWindow.set(1, true);
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('BLUEPRINT_CLOSE');
    expect(entry).toBeDefined();

    await entry!({ type: 'BLUEPRINT_CLOSE' } as any, () => {}, { senderTabId: 55, isOneShot: false });

    expect((globalThis as any).chrome.tabs.get).toHaveBeenCalledWith(55);
    expect((globalThis as any).chrome.tabs.query).not.toHaveBeenCalled();
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(false);
    expect(h.tabMessagesSent).toContainEqual({ tabId: 55, msg: { type: 'BLUEPRINT_STATE', active: false } });
    expect(h.panelMsgs).toContainEqual({ type: 'BLUEPRINT_STATE', active: false });
  });

  it('force-broadcasts OFF when the worker already thinks Blueprint is off', async () => {
    const h = makeHarness();
    h.ctx.blueprintActiveByWindow.set(1, false);
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const entry = getHandler('BLUEPRINT_CLOSE');

    await entry!({ type: 'BLUEPRINT_CLOSE' } as any, () => {}, { senderTabId: 55, isOneShot: true });

    expect(h.tabMessagesSent).toContainEqual({ tabId: 55, msg: { type: 'BLUEPRINT_STATE', active: false } });
    expect(h.ctx.persistBlueprintState).toHaveBeenCalledTimes(1);
  });
});

describe('toggleBlueprint', () => {
  it('blocks Blueprint on a pre-5.6.3 BMP and explains why', async () => {
    const h = makeHarness({ supportsLookup: false });
    const { toggleBlueprint } = await import('../handlers/layout');

    await toggleBlueprint(1);

    expect(h.ctx.blueprintActiveByWindow.get(1)).not.toBe(true);
    expect(h.ctx.toast).toHaveBeenCalledWith('Blueprint requires BMP 5.6.3 or newer.', 'info');
    expect(ensureContentScript).not.toHaveBeenCalled();
  });

  it('turning blueprint ON in a window where inspect is active turns inspect off first, then marks blueprint on', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set([1]) });
    const { toggleBlueprint } = await import('../handlers/layout');

    await toggleBlueprint(1);

    expect(toggleInspect).toHaveBeenCalledWith(1);
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true);
    const toggleOrder = toggleInspect.mock.invocationCallOrder[0];
    const sendOrder = ((globalThis as any).chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(toggleOrder).toBeLessThan(sendOrder);
  });

  it('turning blueprint ON in a window where inspect is inactive does not touch inspect', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set() });
    const { toggleBlueprint } = await import('../handlers/layout');

    await toggleBlueprint(1);

    expect(toggleInspect).not.toHaveBeenCalled();
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true);
  });

  it('toggling again turns blueprint back off (no exclusivity check on the way off)', async () => {
    const h = makeHarness({ inspectActiveWindows: new Set([1]) });
    const { toggleBlueprint } = await import('../handlers/layout');

    await toggleBlueprint(1); // on
    toggleInspect.mockClear();
    await toggleBlueprint(1); // off

    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(false);
    expect(toggleInspect).not.toHaveBeenCalled();
  });

  it('turning blueprint off targets its pinned tab after the user switches browser tabs', async () => {
    const h = makeHarness();
    const { setBlueprintActive } = await import('../handlers/layout');

    await setBlueprintActive(1, true, 55);
    // The active-tab query would now resolve tab 100, but OFF must return to the session owner (55).
    await setBlueprintActive(1, false);

    expect(h.tabMessagesSent.at(-1)).toEqual({ tabId: 55, msg: { type: 'BLUEPRINT_STATE', active: false } });
    expect((globalThis as any).chrome.tabs.query).not.toHaveBeenCalled();
    expect(h.ctx.blueprintTabByWindow.has(1)).toBe(false);
  });

  it('with no windowId argument, resolves the last-focused window', async () => {
    const h = makeHarness();
    const { toggleBlueprint } = await import('../handlers/layout');

    await toggleBlueprint();

    expect((globalThis as any).chrome.windows.getLastFocused).toHaveBeenCalled();
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true); // getLastFocused mock resolves {id:1}
  });

  it('setBlueprintActive is idempotent — a no-op re-set to the same state does not re-broadcast', async () => {
    const h = makeHarness();
    const { setBlueprintActive } = await import('../handlers/layout');

    await setBlueprintActive(1, true); // map starts empty (undefined !== true) — real transition
    expect(h.ctx.sendToPanelByWindow).toHaveBeenCalledTimes(1);
    h.ctx.sendToPanelByWindow.mockClear();

    await setBlueprintActive(1, true); // already true — true no-op, no re-broadcast
    expect(h.ctx.sendToPanelByWindow).not.toHaveBeenCalled();
  });

  it('persists blueprint state on a real transition so it survives an MV3 SW idle→restart (the fix for "Exit does nothing after the SW slept")', async () => {
    const h = makeHarness();
    const { setBlueprintActive } = await import('../handlers/layout');

    await setBlueprintActive(1, true);
    expect(h.ctx.persistBlueprintState).toHaveBeenCalledTimes(1);
    await setBlueprintActive(1, false);
    expect(h.ctx.persistBlueprintState).toHaveBeenCalledTimes(2);

    // A true no-op (already in that state) returns before persisting — nothing changed to persist.
    h.ctx.persistBlueprintState.mockClear();
    await setBlueprintActive(1, false);
    expect(h.ctx.persistBlueprintState).not.toHaveBeenCalled();
  });
});

describe('Blueprint request version gates', () => {
  it('keeps the source environment on a layout that finishes after a workspace switch', async () => {
    const h = makeHarness({ supportsLookup: true });
    h.ctx.client.serverUrl = 'https://a.test/';
    const service = await import('../layout-service');
    let finish!: (result: Awaited<ReturnType<typeof service.loadPage>>) => void;
    const load = vi.spyOn(service, 'loadPage').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const respond = vi.fn();
    const pending = getHandler('LAYOUT_LOAD')!({ type: 'LAYOUT_LOAD', rid: '42' } as any, respond, { isOneShot: true });
    h.ctx.settings.activeProfileId = 'p2';
    h.ctx.client = { serverUrl: 'https://b.test/' };
    finish({ kind: 'page', ctx: { pageClass: 'Scorecard', pageId: 'page' }, load: {} } as any);
    await pending;
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, env: 'p1@https://a.test/' }));
    load.mockRestore();
  });

  it('a newer Blueprint load from the same tab ends the older one (Point and tell loads and other tabs are left alone)', async () => {
    const h = makeHarness({ supportsLookup: true });
    h.ctx.client.serverUrl = 'https://a.test/';
    const service = await import('../layout-service');
    const signals: Array<AbortSignal | undefined> = [];
    const finishes: Array<() => void> = [];
    const load = vi.spyOn(service, 'loadPage').mockImplementation((_c, _rid, _p, _t, signal) => {
      signals.push(signal);
      return new Promise(resolve => { finishes.push(() => resolve({ kind: 'page', ctx: { pageClass: 'Scorecard', pageId: 'page' }, load: {} } as any)); });
    });
    const { getHandler } = await import('../handler-registry');
    const { LAYOUT_LOAD_SUPERSEDED } = await import('../handlers/layout');
    const run = (rid: string, senderTabId: number, extra: Record<string, unknown> = {}) => {
      const respond = vi.fn();
      const done = getHandler('LAYOUT_LOAD')!({ type: 'LAYOUT_LOAD', rid, ...extra } as any, respond, { senderTabId, isOneShot: true });
      return { respond, done };
    };
    const first = run('41', 5);
    const pointTell = run('41', 5, { for: 'point-tell' });
    const otherTab = run('41', 6);
    const second = run('42', 5);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[2]?.aborted).toBe(false);
    expect(signals[3]?.aborted).toBe(false);
    for (const f of finishes) f();
    await Promise.all([first.done, pointTell.done, otherTab.done, second.done]);
    expect(first.respond).toHaveBeenCalledWith({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: LAYOUT_LOAD_SUPERSEDED });
    for (const r of [pointTell, otherTab, second]) expect(r.respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    // A dropped load is not an error worth logging.
    expect(h.ctx.logActivity).not.toHaveBeenCalledWith('error', expect.anything(), expect.anything());
    load.mockRestore();
  });

  it('rejects load and apply requests before executing Blueprint code on an old BMP', async () => {
    makeHarness({ supportsLookup: false });
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    const loadRespond = vi.fn();
    const applyRespond = vi.fn();

    await getHandler('LAYOUT_LOAD')!({ type: 'LAYOUT_LOAD', rid: '123' } as any, loadRespond, { isOneShot: true });
    await getHandler('LAYOUT_APPLY')!({ type: 'LAYOUT_APPLY' } as any, applyRespond, { isOneShot: true });

    expect(loadRespond).toHaveBeenCalledWith({
      type: 'LAYOUT_LOAD_RESULT', ok: false, error: 'Blueprint requires BMP 5.6.3 or newer.',
    });
    expect(applyRespond).toHaveBeenCalledWith({
      type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, error: 'Blueprint requires BMP 5.6.3 or newer.',
    });
  });
});

describe('Blueprint exit check (every way out except the overlay X asks the tab first)', () => {
  function answer(h: Harness, ok: boolean): void {
    (globalThis as any).chrome.tabs.sendMessage = vi.fn((tabId: number, msg: { type: string }) => {
      h.tabMessagesSent.push({ tabId, msg });
      return Promise.resolve(msg.type === 'BLUEPRINT_REQUEST_EXIT' ? { ok } : undefined);
    });
  }

  it('Keep editing in the tab leaves Blueprint on (toggle and shortcut path)', async () => {
    const h = makeHarness({ supportsLookup: true });
    const { toggleBlueprint } = await import('../handlers/layout');
    h.ctx.blueprintActiveByWindow.set(1, true);
    h.ctx.blueprintTabByWindow.set(1, 55);
    answer(h, false);
    await toggleBlueprint(1);
    expect(h.tabMessagesSent).toContainEqual({ tabId: 55, msg: { type: 'BLUEPRINT_REQUEST_EXIT' } });
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(true);
    expect(h.tabMessagesSent.some(m => (m.msg as { type: string }).type === 'BLUEPRINT_STATE')).toBe(false);
  });

  it('Discard (or nothing unsaved) turns Blueprint off', async () => {
    const h = makeHarness({ supportsLookup: true });
    const { setBlueprintActive } = await import('../handlers/layout');
    h.ctx.blueprintActiveByWindow.set(1, true);
    h.ctx.blueprintTabByWindow.set(1, 55);
    answer(h, true);
    await expect(setBlueprintActive(1, false)).resolves.toBe(true);
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(false);
    expect(h.tabMessagesSent).toContainEqual({ tabId: 55, msg: { type: 'BLUEPRINT_STATE', active: false } });
  });

  it('a tab that cannot answer has nothing to keep', async () => {
    const h = makeHarness({ supportsLookup: true });
    const { blueprintMayExit } = await import('../handlers/layout');
    (globalThis as any).chrome.tabs.sendMessage = vi.fn(() => Promise.reject(new Error('no receiver')));
    await expect(blueprintMayExit(55)).resolves.toBe(true);
    void h;
  });

  it('the overlay X (BLUEPRINT_CLOSE) asked in the page already and is not asked again', async () => {
    const h = makeHarness({ supportsLookup: true });
    const { getHandler } = await import('../handler-registry');
    await import('../handlers/layout');
    h.ctx.blueprintActiveByWindow.set(1, true);
    answer(h, false);
    await getHandler('BLUEPRINT_CLOSE')!({ type: 'BLUEPRINT_CLOSE' } as any, vi.fn(), { senderTabId: 55 } as any);
    expect(h.tabMessagesSent.some(m => (m.msg as { type: string }).type === 'BLUEPRINT_REQUEST_EXIT')).toBe(false);
    expect(h.ctx.blueprintActiveByWindow.get(1)).toBe(false);
  });
});
