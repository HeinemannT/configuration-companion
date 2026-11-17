import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from '../../__tests__/chrome-mock';
import { setSwContext } from '../../sw-context';
import { getContextRid, clearAllContextRids } from '../../context-rid';
import { getHandler } from '../../handler-registry';
vi.mock('../../tab-awareness', async importOriginal => ({
  ...(await importOriginal<typeof import('../../tab-awareness')>()),
  ensureContentScript: vi.fn(async () => true),
}));

import '../detection';
import '../history';
import '../objects';
import '../layout';

const RID = '8123456789012345678';

function ctx(extra: Record<string, unknown> = {}) {
  const c = {
    sendToPanel: vi.fn(),
    sendToPanelByTab: vi.fn(),
    sendToPanelByWindow: vi.fn(),
    logActivity: vi.fn(),
    toast: vi.fn(),
    history: { record: vi.fn(), getAll: vi.fn(() => [{ rid: RID }]) },
    favorites: { getAll: vi.fn(() => [{ rid: RID }]), toggle: vi.fn() },
    isInspectActive: vi.fn(() => false),
    blueprintActiveByWindow: new Map<number, boolean>(),
    blueprintTabByWindow: new Map<number, number>(),
    persistBlueprintState: vi.fn(),
    ...extra,
  };
  setSwContext(c as any);
  return c;
}

const run = async (msg: any, meta: any = { isOneShot: true }) => {
  const responses: unknown[] = [];
  await getHandler(msg.type)!(msg, r => responses.push(r), meta);
  return responses;
};

describe('current position (SET_CONTEXT_RID)', () => {
  beforeEach(() => { mockChromeStorage(); clearAllContextRids(); });

  it('a badge click stores the position for the sender tab and publishes it to that tab’s panel only', async () => {
    const c = ctx();
    await run({ type: 'SET_CONTEXT_RID', rid: RID, name: 'Risk', objectType: 'CeRisk', businessId: 'r1', source: 'badge' }, { senderTabId: 7, isOneShot: true });
    expect(getContextRid(7)).toEqual({ rid: RID, name: 'Risk', type: 'CeRisk', businessId: 'r1' });
    expect(c.sendToPanelByTab).toHaveBeenCalledWith(7, {
      type: 'CONTEXT_RID_DATA', rid: RID, name: 'Risk', objectType: 'CeRisk', businessId: 'r1', source: 'badge',
    });
    expect(c.sendToPanel).not.toHaveBeenCalled();
    // Badge clicks are too frequent for the Log tab; right-clicks are logged.
    expect(c.logActivity).not.toHaveBeenCalled();
    await run({ type: 'SET_CONTEXT_RID', rid: RID, source: 'contextmenu' }, { senderTabId: 7, isOneShot: true });
    expect(c.logActivity).toHaveBeenCalledTimes(1);
  });

  it('the side panel picker targets the active tab of its window', async () => {
    const c = ctx();
    (chrome.tabs as any).query = vi.fn(async () => [{ id: 9 }]);
    await run({ type: 'SET_CONTEXT_RID', rid: RID, source: 'picker' }, { panelWindowId: 3, isOneShot: false });
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 3 });
    expect(getContextRid(9)?.rid).toBe(RID);
    expect(c.sendToPanelByTab).toHaveBeenCalledWith(9, expect.objectContaining({ source: 'picker' }));
  });

  it('ignores a rid that is not BMP-shaped and an unknown source', async () => {
    const c = ctx();
    await run({ type: 'SET_CONTEXT_RID', rid: 'x' }, { senderTabId: 7, isOneShot: true });
    expect(getContextRid(7)).toBeUndefined();
    await run({ type: 'SET_CONTEXT_RID', rid: RID, source: 'evil' }, { senderTabId: 7, isOneShot: true });
    expect(c.sendToPanelByTab).toHaveBeenCalledWith(7, expect.not.objectContaining({ source: expect.anything() }));
  });
});

describe('object window bookkeeping', () => {
  beforeEach(() => mockChromeStorage());

  it('RECORD_RECENT records a viewed object and refreshes Browse', async () => {
    const c = ctx();
    await run({ type: 'RECORD_RECENT', rid: RID, name: 'Risk', objectType: 'CeRisk', businessId: 'r1' });
    expect(c.history.record).toHaveBeenCalledWith(expect.objectContaining({ rid: RID, name: 'Risk', type: 'CeRisk', businessId: 'r1', action: 'viewed' }));
    expect(c.sendToPanel).toHaveBeenCalledWith({ type: 'HISTORY_DATA', entries: [{ rid: RID }] });
  });

  it('a pin from the object window also refreshes Browse’s Pinned list', async () => {
    const c = ctx();
    const res = await run({ type: 'TOGGLE_FAVORITE', rid: RID, name: 'Risk' });
    expect(res).toEqual([{ type: 'FAVORITES_DATA', entries: [{ rid: RID }] }]);
    expect(c.sendToPanel).toHaveBeenCalledWith({ type: 'FAVORITES_DATA', entries: [{ rid: RID }] });
  });
});

describe('FETCH_INBOUND for the window', () => {
  beforeEach(() => mockChromeStorage());

  it('page elements without a class schema still get the rref() scan, with its total', async () => {
    const executeEc = vi.fn(async () => ({ ok: true, log: `~CREV_R~1:i0:3:1112:iv4:View9:InputView~CREV_R~1:n1:1~CREV_D~\n` }));
    ctx({ client: { resolveRef: vi.fn(async () => `lookup(${RID})`), executeEc, executeEcOn: (c: string, rid: string, s?: AbortSignal) => (executeEc as any)(c, rid, false, s) } });
    const kn = await import('../../bmp-type-knowledge');
    vi.spyOn(kn.bmpTypeKnowledge, 'properties').mockResolvedValue({ ok: false, error: 'No properties returned (unknown class?)' } as any);
    const res = await run({ type: 'FETCH_INBOUND', rid: RID, className: 'InputSet' });
    expect(res).toEqual([expect.objectContaining({ ok: true, total: 1, targets: [expect.objectContaining({ rid: '111', type: 'InputView' })] })]);
  });

  it('FETCH_INBOUND_CANCEL aborts the waiting scan', async () => {
    let signal: AbortSignal | undefined;
    const executeEc = vi.fn((_c: string, _o: unknown, _t: boolean, s: AbortSignal) => {
      signal = s;
      return new Promise((_r, reject) => s.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    ctx({ client: { resolveRef: vi.fn(async () => `lookup(${RID})`), executeEc, executeEcOn: (c: string, rid: string, s?: AbortSignal) => (executeEc as any)(c, rid, false, s) } });
    const kn = await import('../../bmp-type-knowledge');
    vi.spyOn(kn.bmpTypeKnowledge, 'properties').mockResolvedValue({ ok: false, error: 'none' } as any);
    const pending = run({ type: 'FETCH_INBOUND', rid: RID, className: 'InputSet' });
    await new Promise(r => setTimeout(r, 0));
    await run({ type: 'FETCH_INBOUND_CANCEL', rid: RID });
    expect(signal?.aborted).toBe(true);
    expect(await pending).toEqual([expect.objectContaining({ ok: false, error: 'Cancelled' })]);
  });
});

describe('OPEN_BLUEPRINT_FOR', () => {
  beforeEach(() => mockChromeStorage());

  it('turns Blueprint on for the window’s tab and asks it to select the object', async () => {
    const c = ctx({ client: { supportsLookup: true } });
    (chrome.tabs as any).get = vi.fn(async () => ({ id: 5, windowId: 2 }));
    (chrome.tabs as any).sendMessage = vi.fn(async () => undefined);
    (chrome.tabs as any).query = vi.fn(async () => [{ id: 5 }]);
    await run({ type: 'OPEN_BLUEPRINT_FOR', rid: RID }, { senderTabId: 5, isOneShot: true });
    expect(c.blueprintActiveByWindow.get(2)).toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(5, { type: 'BLUEPRINT_SELECT', rid: RID });
  });
});
