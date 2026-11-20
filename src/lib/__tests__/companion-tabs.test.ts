import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closePanelInWindow, companionTabActivated, companionTabClosed, companionTabSeen, initCompanionTabs, isCompanionTabUrl, openPanelOnTab, panelHiddenOn, resetCompanionTabs, sweepCompanionTabs } from '../companion-tabs';

const BASE = 'chrome-extension://abc/';
const ACCESS = BASE + 'access/access.html?environment=demo%40x';
const COLORS = BASE + 'colors-images/colors-images.html?environment=demo%40x#tab=colors';
const BMP = 'https://bmp.example/Steadfast/';

type Listener = (...a: never[]) => void;
let calls: string[];
let session: Record<string, unknown>;
let listeners: { created?: Listener; updated?: Listener; removed?: Listener; activated?: Listener };
let tabs: Array<{ id: number; url?: string; pendingUrl?: string }>;

const setOptions = vi.fn(async (o: { tabId: number; enabled: boolean }) => { calls.push(`options:${o.tabId}:${o.enabled}`); });
const open = vi.fn(async (o: { tabId: number }) => { calls.push(`open:${o.tabId}`); });
const close = vi.fn(async (o: { windowId: number }) => { calls.push(`close:${o.windowId}`); });
let info: Record<number, { active: boolean; windowId: number }>;

beforeEach(() => {
  resetCompanionTabs();
  calls = []; session = {}; listeners = {}; tabs = []; info = {};
  setOptions.mockClear(); open.mockClear(); close.mockClear();
  vi.stubGlobal('chrome', {
    runtime: { getURL: (p: string) => BASE + p },
    sidePanel: { setOptions, open, close },
    storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(session, o); } } },
    tabs: {
      query: async () => tabs,
      get: async (id: number) => { if (!info[id]) throw new Error('No tab'); return { id, ...info[id] }; },
      onCreated: { addListener: (l: Listener) => { listeners.created = l; } },
      onUpdated: { addListener: (l: Listener) => { listeners.updated = l; } },
      onActivated: { addListener: (l: Listener) => { listeners.activated = l; } },
      onRemoved: { addListener: (l: Listener) => { listeners.removed = l; } },
    },
  });
});

/** The async work a listener starts has no handle; wait for what it must do. */
const until = (cond: () => boolean) => vi.waitFor(() => { if (!cond()) throw new Error('not yet'); });

describe('isCompanionTabUrl', () => {
  it('knows the pages that open as a tab, with their query and hash, and nothing else', () => {
    expect(isCompanionTabUrl(ACCESS)).toBe(true);
    expect(isCompanionTabUrl(COLORS)).toBe(true);
    expect(isCompanionTabUrl(BASE + 'access/access.html')).toBe(true);
    expect(isCompanionTabUrl(BASE + 'access/access.html.evil')).toBe(false);
    expect(isCompanionTabUrl(BASE + 'editor/editor.html')).toBe(false);
    expect(isCompanionTabUrl(BMP)).toBe(false);
    expect(isCompanionTabUrl(undefined)).toBe(false);
  });
});

describe('the panel on a tab holding a Companion page', () => {
  it('is turned off when the tab is created (by its pending address too), and left alone on a BMP tab', async () => {
    await companionTabSeen(7, ACCESS);
    await companionTabSeen(8, BMP);
    expect(calls).toEqual(['options:7:false']);
    expect(panelHiddenOn(7)).toBe(true);
    expect(panelHiddenOn(8)).toBe(false);
  });

  it('closes the window\'s panel too when the tab is the active one, and leaves it alone for a tab opened in the background', async () => {
    info[7] = { active: true, windowId: 3 };
    info[8] = { active: false, windowId: 3 };
    await companionTabSeen(7, ACCESS);
    await companionTabSeen(8, COLORS);
    expect(calls).toEqual(['options:7:false', 'close:3', 'options:8:false']);
  });

  it('does not fail where the panel cannot be closed (Chrome before 141) or none is open', async () => {
    info[7] = { active: true, windowId: 3 };
    close.mockRejectedValueOnce(new Error('No active side panel'));
    await expect(companionTabSeen(7, ACCESS)).resolves.toBeUndefined();
    vi.stubGlobal('chrome', { ...(globalThis as unknown as { chrome: object }).chrome, sidePanel: { setOptions, open } });
    await expect(closePanelInWindow(3)).resolves.toBeUndefined();
  });

  it('is turned off only once per tab, and back on when the tab goes to another page', async () => {
    await companionTabSeen(7, ACCESS);
    await companionTabSeen(7, ACCESS + '#tab=images');
    expect(calls).toEqual(['options:7:false']);
    await companionTabSeen(7, BMP);
    expect(calls).toEqual(['options:7:false', 'options:7:true']);
    expect(panelHiddenOn(7)).toBe(false);
    await companionTabSeen(7, BMP + 'x');
    expect(calls).toHaveLength(2);
  });

  it('is turned off again each time the tab becomes the active one (an open panel stays on a tab set earlier), but not on other tabs', async () => {
    await companionTabSeen(7, ACCESS);
    calls.length = 0;
    await companionTabActivated(7);
    await companionTabActivated(8);
    expect(calls).toEqual(['options:7:false']);
  });

  it('leaves no record behind when the tab closes, and resets the setting Chrome keeps for it', async () => {
    await companionTabSeen(7, COLORS);
    expect(session.crev_panel_hidden_tabs).toEqual([7]);
    await companionTabClosed(7);
    expect(session.crev_panel_hidden_tabs).toEqual([]);
    expect(calls).toEqual(['options:7:false', 'options:7:true']);
    await companionTabClosed(9);
    expect(calls).toHaveLength(2);
  });

  it('survives a worker restart: the stored tabs are enabled again when they leave the page', async () => {
    session.crev_panel_hidden_tabs = [7];
    await companionTabSeen(7, BMP);
    expect(calls).toEqual(['options:7:true']);
    expect(session.crev_panel_hidden_tabs).toEqual([]);
  });

  it('is turned off in tabs that already hold a page at start, and stored tabs that no longer exist are dropped', async () => {
    session.crev_panel_hidden_tabs = [99];
    tabs = [{ id: 1, url: BMP }, { id: 2, url: COLORS }, { id: 3, pendingUrl: ACCESS }];
    await sweepCompanionTabs();
    expect(calls).toEqual(['options:2:false', 'options:3:false']);
    expect([...(session.crev_panel_hidden_tabs as number[])].sort()).toEqual([2, 3]);
  });

  it('follows the tab events: created, a new address, closed; a reload or a title change does nothing', async () => {
    initCompanionTabs();
    await until(() => true);
    listeners.created!({ id: 7, pendingUrl: ACCESS } as never);
    await until(() => calls.includes('options:7:false'));
    listeners.updated!(7 as never, { status: 'loading' } as never, {} as never);
    listeners.updated!(7 as never, { title: 'Access' } as never, {} as never);
    listeners.updated!(7 as never, { url: BMP } as never, {} as never);
    await until(() => calls.includes('options:7:true'));
    expect(calls).toEqual(['options:7:false', 'options:7:true']);
    listeners.activated!({ tabId: 9 } as never);
    listeners.removed!(7 as never);
  });
});

describe('asking for the panel on such a tab', () => {
  it('turns it on for that tab and opens it, both started in the same step, and a new address in the page does not hide it again', async () => {
    await companionTabSeen(7, ACCESS);
    calls.length = 0;
    const done = openPanelOnTab(7);
    expect(calls).toEqual(['options:7:true', 'open:7']);
    await done;
    await companionTabSeen(7, ACCESS + '#tab=images');
    expect(calls).toEqual(['options:7:true', 'open:7']);
    // Going to a BMP page and back is a new visit: hidden again.
    await companionTabSeen(7, BMP);
    await companionTabSeen(7, ACCESS);
    expect(calls.at(-1)).toBe('options:7:false');
  });

  it('knows a Companion page from the address alone before the stored set has loaded', async () => {
    const done = openPanelOnTab(5, ACCESS);
    expect(calls).toEqual(['options:5:true', 'open:5']);
    await done;
  });

  it('only opens on any other tab', async () => {
    await openPanelOnTab(8, BMP);
    expect(calls).toEqual(['open:8']);
  });
});
