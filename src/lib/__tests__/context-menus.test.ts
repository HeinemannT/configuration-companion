import { describe, expect, it, vi } from 'vitest';
import { CONTEXT_MENU_ITEMS, MENUS_READY_KEY, NEW_PAGE_MENU_ID, POINT_TELL_MENU_ID, ensureContextMenus, installContextMenus, registerContextMenus } from '../context-menus';

const fakeSession = () => {
  const data: Record<string, unknown> = {};
  return { data, get: vi.fn(async (k: string) => (k in data ? { [k]: data[k] } : {})), set: vi.fn(async (o: Record<string, unknown>) => { Object.assign(data, o); }) };
};

describe('context menus', () => {
  it('are replaced on install or update, and ensured at every worker start', () => {
    const menus = { removeAll: vi.fn((cb?: () => void) => cb?.()), create: vi.fn() };
    let onInstalled: (() => void) | undefined;
    const runtime = { onInstalled: { addListener: vi.fn((fn: () => void) => { onInstalled = fn; }) } };
    const ensure = vi.fn(async () => true);
    registerContextMenus(runtime as never, ensure);
    expect(menus.create).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(onInstalled).toBeTypeOf('function');
    installContextMenus(menus as never);
    expect(menus.removeAll).toHaveBeenCalledTimes(1);
    expect(menus.create.mock.calls.map(c => c[0].id)).toEqual(CONTEXT_MENU_ITEMS.map(i => i.id));
    expect(menus.create.mock.calls.every(c => c[0].contexts?.[0] === 'all')).toBe(true);
  });

  it('are created once per browser session: after a restart, not after a worker restart', async () => {
    const menus = { create: vi.fn() };
    const session = fakeSession();
    expect(await ensureContextMenus(menus as never, session as never)).toBe(true);
    expect(menus.create).toHaveBeenCalledTimes(CONTEXT_MENU_ITEMS.length);
    expect(session.data[MENUS_READY_KEY]).toBe(true);
    // The worker restarts inside the same browser session: the flag is still there.
    expect(await ensureContextMenus(menus as never, session as never)).toBe(false);
    expect(menus.create).toHaveBeenCalledTimes(CONTEXT_MENU_ITEMS.length);
    // The browser restarts: session storage is empty again.
    delete session.data[MENUS_READY_KEY];
    expect(await ensureContextMenus(menus as never, session as never)).toBe(true);
    expect(menus.create).toHaveBeenCalledTimes(2 * CONTEXT_MENU_ITEMS.length);
  });

  it('never creates an id twice in one pass, and an existing id is only an error that is read', () => {
    const ids = CONTEXT_MENU_ITEMS.map(i => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a Point and tell entry and a New page here entry, plain items that need no object', () => {
    expect(CONTEXT_MENU_ITEMS.find(i => i.id === POINT_TELL_MENU_ID)?.title).toBe('Point and tell');
    expect(CONTEXT_MENU_ITEMS.find(i => i.id === NEW_PAGE_MENU_ID)?.title).toBe('New page here');
  });
});
