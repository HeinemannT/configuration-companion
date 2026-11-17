import { describe, expect, it, vi } from 'vitest';
import { CONTEXT_MENU_ITEMS, installContextMenus, registerContextMenus } from '../context-menus';

describe('context menus', () => {
  it('are created on install or update, not on a worker wake', () => {
    const menus = { removeAll: vi.fn((cb?: () => void) => cb?.()), create: vi.fn() };
    let onInstalled: (() => void) | undefined;
    const runtime = { onInstalled: { addListener: vi.fn((fn: () => void) => { onInstalled = fn; }) } };
    // A wake: the worker starts and registers its listener; nothing is created.
    registerContextMenus(runtime as never);
    expect(menus.create).not.toHaveBeenCalled();
    expect(onInstalled).toBeTypeOf('function');
    // Install or update: the entries are replaced.
    installContextMenus(menus as never);
    expect(menus.removeAll).toHaveBeenCalledTimes(1);
    expect(menus.create.mock.calls.map(c => c[0].id)).toEqual(CONTEXT_MENU_ITEMS.map(i => i.id));
    expect(menus.create.mock.calls.every(c => c[0].contexts?.[0] === 'all')).toBe(true);
  });
});
