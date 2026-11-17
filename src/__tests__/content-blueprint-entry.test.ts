// @vitest-environment happy-dom
/**
 * Tests for src/content-blueprint-entry.ts — the lazily-injected Blueprint bundle's entry seam
 * The heavy editor (content-blueprint/*, lib/layout/*) is mocked out: what matters here
 * is the BRIDGE contract with content.ts, which can't be exercised through the real editor —
 *
 *   - on init it adopts the rid resolver content.ts published on `window.__crevBpResolver`,
 *   - it drains the one-shot `window.__crevBpResumePrefer` flag, then drains the
 *     `window.__crevBpPendingCmds` queue (commands content.ts buffered before this listener
 *     existed) IN ORDER and flips `window.__crevBpEntryReady`,
 *   - and it routes `window.__crevBpCmd` calls to enable/disable/resetOverlayCaches/setResumePrefer,
 *     while a `crev-bp-cmd` DOM event (which page script could dispatch) does nothing.
 *
 * Each case re-imports the module (vi.resetModules) so the once-per-load init logic runs against the
 * window state set up for that case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const enableBlueprint = vi.fn();
const disableBlueprint = vi.fn();
const setBlueprintRidResolver = vi.fn();
const setBlueprintResumePrefer = vi.fn();
const resetColorSets = vi.fn();
const resetFlowRefsCache = vi.fn();

vi.mock('../content-blueprint', () => ({
  enableBlueprint: (...a: unknown[]) => enableBlueprint(...a),
  disableBlueprint: (...a: unknown[]) => disableBlueprint(...a),
  setBlueprintRidResolver: (...a: unknown[]) => setBlueprintRidResolver(...a),
  setBlueprintResumePrefer: (...a: unknown[]) => setBlueprintResumePrefer(...a),
}));
vi.mock('../content-blueprint/colors', () => ({
  resetColorSets: (...a: unknown[]) => resetColorSets(...a),
}));
vi.mock('../content-blueprint/service', () => ({
  resetFlowRefsCache: (...a: unknown[]) => resetFlowRefsCache(...a),
}));

async function loadEntry(): Promise<void> {
  vi.resetModules();
  await import('../content-blueprint-entry');
}

beforeEach(() => {
  // Detach the previous case's command entry so command routing tests can't see a stale one from an
  // earlier load. This is exactly the teardown the re-injection guard runs in production.
  const w = window as unknown as Record<string, unknown>;
  try { (w.__crevBpEntryTeardown as (() => void) | undefined)?.(); } catch { /* noop */ }
  vi.clearAllMocks();
  // Reset the bridge hooks + re-injection guard between cases.
  delete w.__crevBpResolver;
  delete w.__crevBpResumePrefer;
  delete w.__crevBpEntryReady;
  delete w.__crevBpPendingCmds;
  delete w.__crevBpCmd;
  delete w.__crevBpEntryLoaded;
  delete w.__crevBpEntryTeardown;
});

describe('content-blueprint-entry init', () => {
  it('adopts the rid resolver content.ts published on window', async () => {
    const resolver = () => 'rid-123';
    (window as any).__crevBpResolver = resolver;

    await loadEntry();

    expect(setBlueprintRidResolver).toHaveBeenCalledWith(resolver);
  });

  it('does not enable when the pending-command queue is empty, and marks itself ready', async () => {
    (window as any).__crevBpResolver = () => 'rid-1';
    await loadEntry();
    expect(enableBlueprint).not.toHaveBeenCalled();
    expect((window as any).__crevBpEntryReady).toBe(true);
  });

  it('drains a buffered enable command from the pending queue on init, then clears the queue + marks ready', async () => {
    (window as any).__crevBpResolver = () => 'rid-1';
    (window as any).__crevBpPendingCmds = [{ cmd: 'enable' }];

    await loadEntry();

    expect(enableBlueprint).toHaveBeenCalledTimes(1);
    expect((window as any).__crevBpPendingCmds).toBeUndefined();
    expect((window as any).__crevBpEntryReady).toBe(true);
  });

  it('B1 REGRESSION: drains buffered [enable, disable] IN ORDER, ending disabled — the raced disable is not dropped', async () => {
    (window as any).__crevBpResolver = () => 'rid-1';
    // The exact sequence content.ts buffers when the user toggles Blueprint on then off during the
    // first-injection window. Pre-fix, only enable had a fallback and the disable was lost, leaving
    // Blueprint stuck ON against the user's last action.
    (window as any).__crevBpPendingCmds = [{ cmd: 'enable' }, { cmd: 'disable' }];

    await loadEntry();

    expect(enableBlueprint).toHaveBeenCalledTimes(1);
    expect(disableBlueprint).toHaveBeenCalledTimes(1);
    // Order preserved: enable before disable, so the terminal state is disabled.
    expect(enableBlueprint.mock.invocationCallOrder[0])
      .toBeLessThan(disableBlueprint.mock.invocationCallOrder[0]);
    expect((window as any).__crevBpPendingCmds).toBeUndefined();
  });

  it('drains a stashed resume-prefer BEFORE draining the pending queue, then clears it', async () => {
    (window as any).__crevBpResumePrefer = 'instance';
    (window as any).__crevBpPendingCmds = [{ cmd: 'enable' }];

    await loadEntry();

    expect(setBlueprintResumePrefer).toHaveBeenCalledWith('instance');
    expect((window as any).__crevBpResumePrefer).toBeUndefined();
    // Order matters: enableBlueprint reads resumePrefer synchronously, so prefer must land first.
    const preferOrder = setBlueprintResumePrefer.mock.invocationCallOrder[0];
    const enableOrder = enableBlueprint.mock.invocationCallOrder[0];
    expect(preferOrder).toBeLessThan(enableOrder);
  });

  it('marks the re-injection guard + parks a teardown on window', async () => {
    await loadEntry();
    expect((window as any).__crevBpEntryLoaded).toBe(true);
    expect(typeof (window as any).__crevBpEntryTeardown).toBe('function');
  });

  it('a re-injection tears the previous instance down before booting', async () => {
    await loadEntry();
    // Simulate the SW re-injecting content-blueprint.js: the flag + a prior teardown are already on
    // window. The fresh module load must call the previous teardown (→ disableBlueprint).
    await loadEntry();
    expect(disableBlueprint).toHaveBeenCalledTimes(1);
  });
});

describe('command routing', () => {
  const dispatch = (detail: unknown) =>
    (window as unknown as { __crevBpCmd: (d: unknown) => void }).__crevBpCmd(detail);

  it('ignores the old DOM event channel, which page script can dispatch', async () => {
    await loadEntry();
    for (const detail of [{ cmd: 'enable' }, { cmd: 'disable' }, { cmd: 'select', rid: '1234567' }]) {
      document.dispatchEvent(new CustomEvent('crev-bp-cmd', { detail }));
    }
    expect(enableBlueprint).not.toHaveBeenCalled();
    expect(disableBlueprint).not.toHaveBeenCalled();
  });

  it('drops a command whose shape is not one of the known ones', async () => {
    await loadEntry();
    for (const detail of [null, 'enable', { cmd: 'apply' }, { cmd: 'select', rid: 'x' }, { cmd: 'setResumePrefer', prefer: 'all' }]) dispatch(detail);
    expect(enableBlueprint).not.toHaveBeenCalled();
    expect(setBlueprintResumePrefer).not.toHaveBeenCalled();
  });

  it('a re-injection replaces the entry; the old teardown leaves the new one alone', async () => {
    await loadEntry();
    const first = (window as unknown as { __crevBpCmd: unknown }).__crevBpCmd;
    await loadEntry();
    const second = (window as unknown as { __crevBpCmd: unknown }).__crevBpCmd;
    expect(second).toBeTypeOf('function');
    expect(second).not.toBe(first);
  });

  it('enable → enableBlueprint', async () => {
    await loadEntry();
    dispatch({ cmd: 'enable' });
    expect(enableBlueprint).toHaveBeenCalledTimes(1);
  });

  it('disable → disableBlueprint', async () => {
    await loadEntry();
    dispatch({ cmd: 'disable' });
    expect(disableBlueprint).toHaveBeenCalledTimes(1);
  });

  it('resetOverlayCaches → resetColorSets + resetFlowRefsCache', async () => {
    await loadEntry();
    dispatch({ cmd: 'resetOverlayCaches' });
    expect(resetColorSets).toHaveBeenCalledTimes(1);
    expect(resetFlowRefsCache).toHaveBeenCalledTimes(1);
  });

  it('setResumePrefer → setBlueprintResumePrefer with the target', async () => {
    await loadEntry();
    dispatch({ cmd: 'setResumePrefer', prefer: 'template' });
    expect(setBlueprintResumePrefer).toHaveBeenCalledWith('template');
  });
});
