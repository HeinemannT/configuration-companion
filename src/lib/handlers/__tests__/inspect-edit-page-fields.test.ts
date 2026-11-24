/**
 * INSPECT_EDIT_PAGE_FIELDS reads a form's whole layout. A newer read from the
 * same tab, or the tab leaving its page, ends the older one: its waiting posts
 * leave the queue and its answer says it was superseded (the content script
 * drops it: its request counter moved on).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSwContext } from '../../sw-context';
import { getHandler } from '../../handler-registry';

const loads = vi.hoisted(() => ({ signals: [] as Array<AbortSignal | undefined>, finish: [] as Array<() => void> }));
vi.mock('../../layout-service', () => ({
  loadPage: (_c: unknown, _rid: string, _p: unknown, _t: unknown, signal?: AbortSignal) => {
    loads.signals.push(signal);
    return new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('BMP request cancelled')));
      loads.finish.push(() => resolve(null));
    });
  },
  loadPageStructure: vi.fn(), applyPage: vi.fn(), loadBlastRadius: vi.fn(), loadFlowRefs: vi.fn(),
  loadFlowSettings: vi.fn(), loadFlowRefChildren: vi.fn(), preflightPortableIds: vi.fn(),
}));
vi.mock('../../tab-awareness', async importOriginal => ({
  ...(await importOriginal<typeof import('../../tab-awareness')>()),
  ensureContentScript: vi.fn(async () => undefined),
}));

import { EDIT_PAGE_FIELDS_SUPERSEDED } from '../inspect';
import '../detection';

const RID_A = '4081032302720082045';
const RID_B = '4081032302720082046';

beforeEach(() => {
  loads.signals.length = 0;
  loads.finish.length = 0;
  (globalThis as any).chrome = {
    runtime: { lastError: null },
    tabs: { get: vi.fn(), query: vi.fn() },
  };
  setSwContext({ client: { supportsLookup: true }, isInspectActive: () => false, panelPortByWindow: new Map() } as any);
});

const ask = (editPageRid: string, senderTabId: number) => {
  const respond = vi.fn();
  const done = getHandler('INSPECT_EDIT_PAGE_FIELDS')!({ type: 'INSPECT_EDIT_PAGE_FIELDS', editPageRid } as any, respond, { senderTabId, isOneShot: true });
  return { respond, done };
};

describe('INSPECT_EDIT_PAGE_FIELDS supersede', () => {
  it('a newer read from the same tab ends the older one; other tabs keep theirs', async () => {
    const first = ask(RID_A, 7);
    const other = ask(RID_A, 8);
    const second = ask(RID_B, 7);
    expect(loads.signals.map(s => s?.aborted)).toEqual([true, false, false]);
    loads.finish[1]();
    loads.finish[2]();
    await Promise.all([first.done, other.done, second.done]);
    expect(first.respond).toHaveBeenCalledWith({ type: 'INSPECT_EDIT_PAGE_FIELDS_RESULT', ok: false, error: EDIT_PAGE_FIELDS_SUPERSEDED });
    // Not superseded: answered as before (no form projection in the stub's empty model).
    expect(second.respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.stringContaining('no inspectable') }));
    expect(other.respond).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('no inspectable') }));
  });

  it('the tab leaving its page ends its read', async () => {
    const read = ask(RID_A, 7);
    await getHandler('BMP_URL_CHANGED')!({ type: 'BMP_URL_CHANGED', left: true } as any, () => {}, { senderTabId: 7, isOneShot: false });
    expect(loads.signals[0]?.aborted).toBe(true);
    await read.done;
    expect(read.respond).toHaveBeenCalledWith({ type: 'INSPECT_EDIT_PAGE_FIELDS_RESULT', ok: false, error: EDIT_PAGE_FIELDS_SUPERSEDED });
  });
});
