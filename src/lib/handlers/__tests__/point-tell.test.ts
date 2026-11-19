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

describe('POINT_TELL_STAGE', () => {
  it('opens Blueprint on the sender tab, with Inspect off', async () => {
    setupChrome([{ id: 3, windowId: 9, url: BMP }]);
    const ctx = makeCtx({ inspect: true });
    await (await handler('POINT_TELL_STAGE'))({ type: 'POINT_TELL_STAGE' } as never, () => {}, { isOneShot: true, senderTabId: 3, ctx } as never);
    expect(toggleInspect).toHaveBeenCalledWith(9);
    expect(setBlueprintActive).toHaveBeenCalledWith(9, true, 3);
  });

  it('is ignored without a sender tab, and may be sent by a content script', async () => {
    setupChrome([{ id: 3, windowId: 9, url: BMP }]);
    const ctx = makeCtx();
    await (await handler('POINT_TELL_STAGE'))({ type: 'POINT_TELL_STAGE' } as never, () => {}, { isOneShot: true, ctx } as never);
    expect(setBlueprintActive).not.toHaveBeenCalled();
    expect(MESSAGE_ACCESS.POINT_TELL_STAGE).toEqual(['content']);
  });
});

describe('POINT_TELL_READ_NOW', () => {
  const RID = '4000000000000000001';
  const run = async (items: unknown, client: unknown) => {
    setupChrome([{ id: 3, windowId: 9, url: BMP }]);
    const ctx = makeCtx();
    ctx.client = client;
    const respond = vi.fn();
    await (await handler('POINT_TELL_READ_NOW'))({ type: 'POINT_TELL_READ_NOW', items } as never, respond, { isOneShot: true, senderTabId: 3, ctx } as never);
    return { respond, ctx };
  };
  const prop = (text: string, kind = 'text') => ({ kind, text });

  it('reads the text properties and code of the noted objects in one batch, and says which code is too long', async () => {
    const readFullObjects = vi.fn(async () => ({
      objects: { [RID]: { props: { expression: prop('_t := 1', 'code'), html: prop('x'.repeat(9000), 'code'), javascript: prop('') } } },
      errors: {},
    }));
    const { respond } = await run([{ rid: RID, className: 'ExtendedTable' }], { readFullObjects });
    expect(readFullObjects).toHaveBeenCalledTimes(1);
    expect(readFullObjects).toHaveBeenCalledWith([RID]);
    expect(respond).toHaveBeenCalledWith({ type: 'POINT_TELL_NOW_DATA', ok: true, objects: { [RID]: { text: {}, code: { expression: '_t := 1' }, omitted: ['html'] } } });
  });

  it('reads nothing for objects with no text or code property, or an item that is not a rid', async () => {
    const readFullObjects = vi.fn();
    const { respond } = await run([{ rid: RID, className: 'PieChart' }, { rid: 'abc', className: 'ExtendedTable' }, null], { readFullObjects });
    expect(readFullObjects).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({ type: 'POINT_TELL_NOW_DATA', ok: true, objects: {} });
  });

  it('says so when the server is not connected, and when the read fails', async () => {
    expect((await run([{ rid: RID, className: 'ExtendedTable' }], null)).respond).toHaveBeenCalledWith({ type: 'POINT_TELL_NOW_DATA', ok: false, error: 'Not connected' });
    const failing = { readFullObjects: vi.fn(async () => { throw new Error('boom'); }) };
    expect((await run([{ rid: RID, className: 'ExtendedTable' }], failing)).respond).toHaveBeenCalledWith({ type: 'POINT_TELL_NOW_DATA', ok: false, error: 'boom' });
  });

  it('may be sent by a content script', () => {
    expect(MESSAGE_ACCESS.POINT_TELL_READ_NOW).toEqual(['content']);
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

describe('POINT_TELL_CREATE_PAGE', () => {
  const plan = { parentRid: '4797501244326270080', kind: 'Scorecard' as const, id: 'sc_new', name: 'New page' };
  const ok = (log: string, extra: object = {}) => ({ ok: true, log, outputEntries: [], hasWarning: false, hasError: false, ...extra });
  function client(execute: (code: string, tx: unknown) => unknown) {
    return { commandUser: 'admin', serverUrl: BMP, executeEc: vi.fn(async (code: string, _rid: unknown, tx: unknown) => execute(code, tx)) };
  }
  async function run(ctx: any, msg: object) {
    const out: any[] = [];
    await (await handler('POINT_TELL_CREATE_PAGE'))({ type: 'POINT_TELL_CREATE_PAGE', environment: 'env', plan, ...msg } as never, (r: unknown) => out.push(r), { isOneShot: true, ctx } as never);
    return out[0];
  }
  const withClient = (c: unknown) => { const ctx = makeCtx(); ctx.client = c; ctx.logActivity = vi.fn(); return ctx; };

  it('a preview that BMP answers with a warning (a duplicate ID) is refused with its sentence and writes nothing', async () => {
    const c = client(() => ok('x', { hasWarning: true, outputEntries: [{ logType: 'WARNING', message: "Id sc_new is already used and can't be assigned. A new id was assigned instead at line 2, column 28" }] }));
    const res = await run(withClient(c), { phase: 'preview' });
    expect(res).toMatchObject({ ok: false, error: "Id sc_new is already used and can't be assigned." });
    expect(c.executeEc).toHaveBeenCalledTimes(1);
    expect(c.executeEc.mock.calls[0][2]).toBe(false);
  });

  it('commit needs the receipt of a preview of the same plan, uses it once, writes, and reads back', async () => {
    const made = '<<<CREV_NEWPAGE>>>5065626956881177284|Scorecard|sc_new|4797501244326270080';
    const c = client((_code, tx) => ok(tx ? made : made));
    const ctx = withClient(c);
    expect(await run(ctx, { phase: 'commit' })).toMatchObject({ ok: false });
    const pre = await run(ctx, { phase: 'preview' });
    expect(pre.ok).toBe(true);
    expect(await run(ctx, { phase: 'commit', plan: { ...plan, name: 'Other' }, previewId: pre.previewId })).toMatchObject({ ok: false });
    const pre2 = await run(ctx, { phase: 'preview' });
    const done = await run(ctx, { phase: 'commit', previewId: pre2.previewId });
    expect(done).toMatchObject({ ok: true, rid: '5065626956881177284', id: 'sc_new' });
    expect(c.executeEc.mock.calls.filter(x => x[2] === true)).toHaveLength(1);
    expect(await run(ctx, { phase: 'commit', previewId: pre2.previewId })).toMatchObject({ ok: false });
  });

  it('a plan that could carry code never reaches the server, and a content script may send it', async () => {
    const c = client(() => ok(''));
    expect(await run(withClient(c), { phase: 'preview', plan: { ...plan, name: 'a\nb' } })).toMatchObject({ ok: false });
    expect(c.executeEc).not.toHaveBeenCalled();
    expect(MESSAGE_ACCESS.POINT_TELL_CREATE_PAGE).toEqual(['content']);
  });
});
