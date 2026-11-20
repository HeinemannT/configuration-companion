/**
 * Point and tell, the worker's part: the panel's toggle reaches the window's
 * active tab, and the page's state is passed on to that window's panel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSwContext } from '../../sw-context';
import { NO_PAGE_NOTICE } from '../../frame-open-failure';
import { MESSAGE_ACCESS } from '../../message-access';

const ensureContentScript = vi.fn(async () => {});
vi.mock('../../tab-awareness', () => ({ ensureContentScript, ensureBlueprintScript: vi.fn(async () => {}) }));
const toggleInspect = vi.fn(async () => null);
const setBlueprintActive = vi.fn(async () => true);
vi.mock('../inspect', () => ({ toggleInspect }));
vi.mock('../layout', () => ({ setBlueprintActive }));
vi.mock('../../environment', async (orig) => ({ ...(await orig<object>()), environmentMatches: () => true, environmentToken: () => 'env' }));

const BMP = 'https://bmp.example.test/Work/';
const PANEL_WINDOW = 7;

interface FakeTab { id: number; windowId: number; url: string }

function setupChrome(tabs: FakeTab[], opts: { reach?: boolean } = {}) {
  const sendMessage = vi.fn(async () => { if (!opts.reach) throw new Error('Could not establish connection. Receiving end does not exist.'); return undefined; });
  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => { const t = tabs.find(x => x.id === id); if (!t) throw new Error('No tab'); return t; }),
      query: vi.fn(async (q: { windowId?: number; active?: boolean }) => tabs.filter(t => q.windowId == null || t.windowId === q.windowId).slice(0, q.active ? 1 : undefined)),
      sendMessage,
    },
    permissions: { contains: vi.fn(async () => true) },
    windows: { getLastFocused: vi.fn(async () => ({ id: PANEL_WINDOW })) },
  };
  return sendMessage;
}

function makeCtx(opts: { inspect?: boolean; blueprint?: boolean } = {}) {
  const ctx: any = {
    settings: { profiles: [{ id: 'p', bmpUrl: BMP }], activeProfileId: 'p' }, sendToPanelByWindow: vi.fn(),
    isInspectActive: () => opts.inspect === true,
    blueprintActiveByWindow: new Map<number, boolean>(opts.blueprint ? [[PANEL_WINDOW, true]] : []),
  };
  setSwContext(ctx);
  return ctx;
}

async function handler(type: string) {
  const { getHandler } = await import('../../handler-registry');
  await import('../point-tell');
  return getHandler(type as never)!;
}

beforeEach(() => { ensureContentScript.mockClear(); toggleInspect.mockClear(); setBlueprintActive.mockClear(); setBlueprintActive.mockResolvedValue(true); });

describe('TOGGLE_POINT_TELL', () => {
  it('goes to the active tab of the panel window, shaped like the Inspect toggle', async () => {
    const sendMessage = setupChrome([{ id: 3, windowId: PANEL_WINDOW, url: BMP }], { reach: true });
    const ctx = makeCtx();
    await (await handler('TOGGLE_POINT_TELL'))({ type: 'TOGGLE_POINT_TELL' } as never, () => {}, { isOneShot: false, panelWindowId: PANEL_WINDOW, ctx } as never);
    expect(ensureContentScript).toHaveBeenCalledWith(3);
    expect(sendMessage).toHaveBeenCalledWith(3, { type: 'TOGGLE_POINT_TELL' });
    // The page answers with its own state; the worker does not guess it.
    expect(ctx.sendToPanelByWindow).not.toHaveBeenCalled();
  });

  it('on a tab without the page tools: the panel is told why', async () => {
    setupChrome([{ id: 3, windowId: PANEL_WINDOW, url: 'https://other.example.test/' }]);
    const ctx = makeCtx();
    await (await handler('TOGGLE_POINT_TELL'))({ type: 'TOGGLE_POINT_TELL' } as never, () => {}, { isOneShot: false, panelWindowId: PANEL_WINDOW, ctx } as never);
    expect(ctx.sendToPanelByWindow).toHaveBeenCalledWith(PANEL_WINDOW, { type: 'PANEL_NOTICE', failure: 'no-page', text: NO_PAGE_NOTICE });
  });

  it('turns Inspect and Blueprint off first, Blueprint through its own exit check', async () => {
    const sendMessage = setupChrome([{ id: 3, windowId: PANEL_WINDOW, url: BMP }], { reach: true });
    const ctx = makeCtx({ inspect: true, blueprint: true });
    await (await handler('TOGGLE_POINT_TELL'))({ type: 'TOGGLE_POINT_TELL' } as never, () => {}, { isOneShot: false, panelWindowId: PANEL_WINDOW, ctx } as never);
    expect(toggleInspect).toHaveBeenCalledWith(PANEL_WINDOW);
    expect(setBlueprintActive).toHaveBeenCalledWith(PANEL_WINDOW, false);
    expect(sendMessage).toHaveBeenCalledWith(3, { type: 'TOGGLE_POINT_TELL' });
  });

  it('stays off when the user keeps editing in Blueprint', async () => {
    const sendMessage = setupChrome([{ id: 3, windowId: PANEL_WINDOW, url: BMP }], { reach: true });
    setBlueprintActive.mockResolvedValue(false);
    const ctx = makeCtx({ blueprint: true });
    await (await handler('TOGGLE_POINT_TELL'))({ type: 'TOGGLE_POINT_TELL' } as never, () => {}, { isOneShot: false, panelWindowId: PANEL_WINDOW, ctx } as never);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('leaves other modes alone when neither is on', async () => {
    setupChrome([{ id: 3, windowId: PANEL_WINDOW, url: BMP }], { reach: true });
    const ctx = makeCtx();
    await (await handler('TOGGLE_POINT_TELL'))({ type: 'TOGGLE_POINT_TELL' } as never, () => {}, { isOneShot: false, panelWindowId: PANEL_WINDOW, ctx } as never);
    expect(toggleInspect).not.toHaveBeenCalled();
    expect(setBlueprintActive).not.toHaveBeenCalled();
  });

  it('is sent by the side panel only', () => {
    expect(MESSAGE_ACCESS.TOGGLE_POINT_TELL).toEqual([]);
  });
});

describe('POINT_TELL_STATE', () => {
  it('goes from the page to the panel of the page\'s window', async () => {
    setupChrome([{ id: 3, windowId: 9, url: BMP }]);
    const ctx = makeCtx();
    await (await handler('POINT_TELL_STATE'))({ type: 'POINT_TELL_STATE', active: true } as never, () => {}, { isOneShot: true, senderTabId: 3, ctx } as never);
    expect(ctx.sendToPanelByWindow).toHaveBeenCalledWith(9, { type: 'POINT_TELL_STATE', active: true });
  });

  it('is ignored without a sender tab or with anything but a boolean', async () => {
    setupChrome([{ id: 3, windowId: 9, url: BMP }]);
    const ctx = makeCtx();
    const run = await handler('POINT_TELL_STATE');
    await run({ type: 'POINT_TELL_STATE', active: true } as never, () => {}, { isOneShot: true, ctx } as never);
    await run({ type: 'POINT_TELL_STATE', active: 'yes' } as never, () => {}, { isOneShot: true, senderTabId: 3, ctx } as never);
    expect(ctx.sendToPanelByWindow).not.toHaveBeenCalled();
  });

  it('may be sent by a content script', () => {
    expect(MESSAGE_ACCESS.POINT_TELL_STATE).toEqual(['content']);
  });
});

describe('POINT_TELL_SERVER', () => {
  it('names the server profile the page belongs to, and may be sent by a content script', async () => {
    setupChrome([{ id: 3, windowId: 9, url: BMP }]);
    const ctx = makeCtx();
    ctx.settings.profiles[0].label = 'Steadfast DEV';
    const respond = vi.fn();
    await (await handler('POINT_TELL_SERVER'))({ type: 'POINT_TELL_SERVER' } as never, respond, { isOneShot: true, senderTabId: 3, ctx } as never);
    expect(respond).toHaveBeenCalledWith({ type: 'POINT_TELL_SERVER_DATA', name: 'Steadfast DEV' });
    expect(MESSAGE_ACCESS.POINT_TELL_SERVER).toEqual(['content']);
  });
});

describe('POINT_TELL_VOICE', () => {
  const run = async (stored: unknown, msg: Record<string, unknown>) => {
    setupChrome([{ id: 3, windowId: 9, url: BMP }]);
    const set = vi.fn(async () => {});
    (globalThis as any).chrome.storage = { local: { get: vi.fn(async () => ({ crev_pt_voice: stored })), set } };
    const respond = vi.fn();
    await (await handler('POINT_TELL_VOICE'))({ type: 'POINT_TELL_VOICE', ...msg } as never, respond, { isOneShot: true, senderTabId: 3, ctx: makeCtx() } as never);
    return { respond, set };
  };

  it('answers with the stored setting, off by default, and stores nothing for a plain ask', async () => {
    const { respond, set } = await run(undefined, {});
    expect(respond).toHaveBeenCalledWith({ type: 'POINT_TELL_VOICE_DATA', prefs: { on: false, lang: 'auto', noticed: false } });
    expect(set).not.toHaveBeenCalled();
  });

  it('"Turn on" sets the same setting as Preferences and counts the confirm as the notice', async () => {
    const { respond, set } = await run({ on: false, lang: 'de-DE', noticed: false }, { on: true });
    expect(set).toHaveBeenCalledWith({ crev_pt_voice: { on: true, lang: 'de-DE', noticed: true } });
    expect(respond).toHaveBeenCalledWith({ type: 'POINT_TELL_VOICE_DATA', prefs: { on: true, lang: 'de-DE', noticed: true } });
  });

  it('keeps what is stored when it is on already, and records that the notice was shown', async () => {
    const on = await run({ on: true, lang: 'auto', noticed: true }, { on: true });
    expect(on.set).not.toHaveBeenCalled();
    const seen = await run({ on: true, lang: 'auto', noticed: false }, { noticed: true });
    expect(seen.set).toHaveBeenCalledWith({ crev_pt_voice: { on: true, lang: 'auto', noticed: true } });
  });
});

describe('togglePointTell (shortcut and right-click entry)', () => {
  it('goes to the tab that was invoked, with the other modes off first', async () => {
    const sendMessage = setupChrome([{ id: 3, windowId: 9, url: BMP }, { id: 4, windowId: 9, url: BMP }], { reach: true });
    const ctx = makeCtx({ inspect: true });
    ctx.blueprintActiveByWindow = new Map<number, boolean>();
    await import('../point-tell');
    const { togglePointTell } = await import('../point-tell');
    await togglePointTell(ctx, { tabId: 4 });
    expect(toggleInspect).toHaveBeenCalledWith(9);
    expect(ensureContentScript).toHaveBeenCalledWith(4);
    expect(sendMessage).toHaveBeenCalledWith(4, { type: 'TOGGLE_POINT_TELL' });
  });
});

describe('the Point and tell command and menu entry', () => {
  it('are wired in the worker', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sw = readFileSync(join(__dirname, '../../../service-worker.ts'), 'utf8');
    expect(sw).toContain("command === 'toggle-point-tell'");
    expect(sw).toContain('menuIdEarly === POINT_TELL_MENU_ID');
  });
});

describe('Point and tell is one way', () => {
  it('has no message that stages in Blueprint, asks for a place or writes a page', async () => {
    await handler('TOGGLE_POINT_TELL');
    const { getHandler } = await import('../../handler-registry');
    for (const type of ['POINT_TELL_STAGE', 'POINT_TELL_PARENTS', 'POINT_TELL_CREATE_PAGE']) {
      expect(getHandler(type as never)).toBeUndefined();
      expect(MESSAGE_ACCESS).not.toHaveProperty(type);
    }
  });
});

describe('the Claude Desktop link', () => {
  it('tries one test port alone when the worker was given one, else the range with the remembered port first', async () => {
    const { linkDeps, LINK_TEST_PORT_KEY } = await import('../point-tell');
    const held: Record<string, unknown> = { crev_claude_link_port: 47616 };
    (globalThis as any).chrome = { storage: { session: { get: vi.fn(async () => ({ ...held })) } } };
    expect(await linkDeps()).toEqual({ preferred: 47616 });
    held[LINK_TEST_PORT_KEY] = 47650;
    expect(await linkDeps()).toEqual({ basePort: 47650, count: 1, preferred: 47616 });
    held.crev_claude_link_test_port_count = 3;
    expect(await linkDeps()).toEqual({ basePort: 47650, count: 3, preferred: 47616 });
    held.crev_claude_link_test_port_count = 9;
    expect(await linkDeps()).toMatchObject({ basePort: 47650, count: 1 });
    delete held.crev_claude_link_test_port_count;
    for (const odd of [80, 70000, '47650', 47650.5]) {
      held[LINK_TEST_PORT_KEY] = odd;
      expect(await linkDeps(), String(odd)).toEqual({ preferred: 47616 });
    }
  });

  it('opens the Claude Desktop page next to the asking tab, or brings its open tab forward', async () => {
    const page = 'chrome-extension://abc/claude-setup/claude-setup.html';
    const tabs: Array<{ id: number; windowId: number; index: number; url: string }> = [{ id: 3, windowId: PANEL_WINDOW, index: 2, url: BMP }];
    const create = vi.fn(async (p: { url: string }) => { tabs.push({ id: 9, windowId: PANEL_WINDOW, index: 3, url: p.url }); });
    const update = vi.fn(async () => undefined);
    (globalThis as any).chrome = {
      runtime: { getURL: (p: string) => `chrome-extension://abc/${p}` },
      tabs: { query: vi.fn(async () => tabs), get: vi.fn(async (id: number) => tabs.find(t => t.id === id)), create, update },
      windows: { update: vi.fn(async () => undefined) },
    };
    const open = await handler('OPEN_CLAUDE_SETUP');
    await open({ type: 'OPEN_CLAUDE_SETUP' } as never, () => {}, { isOneShot: true, senderTabId: 3, ctx: makeCtx() } as never);
    expect(create).toHaveBeenCalledWith({ url: page, windowId: PANEL_WINDOW, index: 3, openerTabId: 3 });
    await open({ type: 'OPEN_CLAUDE_SETUP' } as never, () => {}, { isOneShot: true, senderTabId: 3, ctx: makeCtx() } as never);
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(9, { active: true });
    expect(MESSAGE_ACCESS.OPEN_CLAUDE_SETUP).toEqual(['content']);
  });
});
