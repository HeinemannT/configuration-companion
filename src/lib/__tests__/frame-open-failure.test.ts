/**
 * The side panel's header buttons (code editor, code search, Inspect,
 * Blueprint) open on the active tab of the panel's window. When that tab is
 * not a BMP page with the page tools, the panel gets one line saying why
 * (PANEL_NOTICE), instead of nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSwContext } from '../sw-context';
import { frameOpenFailure, NO_PAGE_NOTICE } from '../frame-open-failure';
import { CONNECTION_NEEDS_ACCESS_SENTENCE } from '../connection-copy';

const openExtendedWindow = vi.fn<() => Promise<string>>(async () => 'failed');
const openCodeSearchWindow = vi.fn<() => Promise<string>>(async () => 'failed');
vi.mock('../editor', () => ({ openExtendedWindow, openEditorWindow: vi.fn(), buildEditorContext: vi.fn() }));
vi.mock('../codesearch-launcher', () => ({ openCodeSearchWindow }));
vi.mock('../tab-awareness', () => ({ ensureContentScript: vi.fn(async () => {}), ensureBlueprintScript: vi.fn(async () => {}) }));

const BMP = 'https://bmp.example.test/Work/';
const PANEL_WINDOW = 7;

interface FakeTab { id: number; windowId: number; url: string }

function setupChrome(tabs: FakeTab[], opts: { granted?: boolean; reach?: boolean } = {}) {
  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => { const t = tabs.find(x => x.id === id); if (!t) throw new Error('No tab'); return t; }),
      query: vi.fn(async (q: { windowId?: number; active?: boolean }) => tabs.filter(t => q.windowId == null || t.windowId === q.windowId).slice(0, q.active ? 1 : undefined)),
      sendMessage: vi.fn(async () => { if (!opts.reach) throw new Error('Could not establish connection. Receiving end does not exist.'); return undefined; }),
    },
    permissions: { contains: vi.fn(async () => opts.granted !== false) },
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
    windows: { getLastFocused: vi.fn(async () => ({ id: PANEL_WINDOW })) },
  };
}

function makeCtx() {
  const ctx: any = {
    settings: { profiles: [{ id: 'p', bmpUrl: BMP }], activeProfileId: 'p' },
    sendToPanelByWindow: vi.fn(),
    contentPorts: new Map(),
    blueprintActiveByWindow: new Map<number, boolean>(),
    blueprintTabByWindow: new Map<number, number>(),
    inspect: new Map<number, boolean>(),
    isInspectActive(w: number) { return this.inspect.get(w) === true; },
    setInspectActive(w: number, v: boolean) { this.inspect.set(w, v); },
    persistBlueprintState: vi.fn(),
    logActivity: vi.fn(),
    toast: vi.fn(),
    client: null,
  };
  setSwContext(ctx);
  return ctx;
}

const meta = (ctx: unknown) => ({ isOneShot: false, panelWindowId: PANEL_WINDOW, ctx }) as never;
const notices = (ctx: any) => ctx.sendToPanelByWindow.mock.calls.filter((c: any[]) => c[1].type === 'PANEL_NOTICE');

async function handler(type: string, file: string) {
  const { getHandler } = await import('../handler-registry');
  await import(file);
  return getHandler(type as never)!;
}

beforeEach(() => {
  openExtendedWindow.mockReset().mockResolvedValue('failed');
  openCodeSearchWindow.mockReset().mockResolvedValue('failed');
});

describe('why a header button opened nothing', () => {
  it('no tab, a tab that is not a server page, a granted server page: open a BMP page', async () => {
    setupChrome([{ id: 1, windowId: PANEL_WINDOW, url: 'https://other.example.test/' }, { id: 2, windowId: PANEL_WINDOW, url: BMP }]);
    expect(await frameOpenFailure(undefined, [BMP])).toBe('no-page');
    expect(await frameOpenFailure(99, [BMP])).toBe('no-page');
    expect(await frameOpenFailure(1, [BMP])).toBe('no-page');
    expect(await frameOpenFailure(2, [BMP])).toBe('no-page');
  });

  it('a known server whose site is not granted: the site-access sentence', async () => {
    setupChrome([{ id: 2, windowId: PANEL_WINDOW, url: `${BMP}page` }], { granted: false });
    expect(await frameOpenFailure(2, [BMP])).toBe('site-not-granted');
  });
});

describe('header buttons', () => {
  it('code editor without a tab in the window: the panel is told to open a BMP page', async () => {
    setupChrome([]);
    const ctx = makeCtx();
    await (await handler('OPEN_EXTENDED', '../handlers/ec'))({ type: 'OPEN_EXTENDED' } as never, () => {}, meta(ctx));
    expect(notices(ctx)).toEqual([[PANEL_WINDOW, { type: 'PANEL_NOTICE', failure: 'no-page', text: NO_PAGE_NOTICE }]]);
  });

  it('code editor that opened: nothing is said', async () => {
    setupChrome([{ id: 2, windowId: PANEL_WINDOW, url: BMP }], { reach: true });
    openExtendedWindow.mockResolvedValue('mounted');
    const ctx = makeCtx();
    await (await handler('OPEN_EXTENDED', '../handlers/ec'))({ type: 'OPEN_EXTENDED' } as never, () => {}, meta(ctx));
    expect(notices(ctx)).toEqual([]);
  });

  it('code search on a server page whose site is not granted: the site-access sentence', async () => {
    setupChrome([{ id: 2, windowId: PANEL_WINDOW, url: BMP }], { granted: false });
    const ctx = makeCtx();
    await (await handler('OPEN_CODE_SEARCH', '../handlers/code-search'))({ type: 'OPEN_CODE_SEARCH' } as never, () => {}, meta(ctx));
    expect(notices(ctx)).toEqual([[PANEL_WINDOW, { type: 'PANEL_NOTICE', failure: 'site-not-granted', text: CONNECTION_NEEDS_ACCESS_SENTENCE }]]);
  });

  it('Inspect on a tab without the page tools: the panel is told', async () => {
    setupChrome([{ id: 3, windowId: PANEL_WINDOW, url: 'https://other.example.test/' }]);
    const ctx = makeCtx();
    await (await handler('TOGGLE_INSPECT', '../handlers/inspect'))({ type: 'TOGGLE_INSPECT' } as never, () => {}, meta(ctx));
    expect(notices(ctx)).toEqual([[PANEL_WINDOW, { type: 'PANEL_NOTICE', failure: 'no-page', text: NO_PAGE_NOTICE }]]);
  });

  it('Inspect on a BMP page that takes it: nothing is said', async () => {
    setupChrome([{ id: 3, windowId: PANEL_WINDOW, url: BMP }], { reach: true });
    const ctx = makeCtx();
    await (await handler('TOGGLE_INSPECT', '../handlers/inspect'))({ type: 'TOGGLE_INSPECT' } as never, () => {}, meta(ctx));
    expect(notices(ctx)).toEqual([]);
    expect(ctx.isInspectActive(PANEL_WINDOW)).toBe(true);
  });

  it('Blueprint without a tab: it stays off and the panel is told', async () => {
    setupChrome([]);
    const ctx = makeCtx();
    await (await handler('BLUEPRINT_TOGGLE', '../handlers/layout'))({ type: 'BLUEPRINT_TOGGLE' } as never, () => {}, meta(ctx));
    expect(notices(ctx)).toEqual([[PANEL_WINDOW, { type: 'PANEL_NOTICE', failure: 'no-page', text: NO_PAGE_NOTICE }]]);
    expect(ctx.blueprintActiveByWindow.get(PANEL_WINDOW)).toBe(false);
    expect(ctx.sendToPanelByWindow).toHaveBeenLastCalledWith(PANEL_WINDOW, expect.objectContaining({ type: 'PANEL_NOTICE' }));
    expect(ctx.sendToPanelByWindow.mock.calls.map((c: any[]) => c[1]).filter((m: any) => m.type === 'BLUEPRINT_STATE').at(-1)).toEqual({ type: 'BLUEPRINT_STATE', active: false });
  });

  it('Blueprint on a server page whose site is not granted: it stays off, site-access sentence', async () => {
    setupChrome([{ id: 4, windowId: PANEL_WINDOW, url: BMP }], { granted: false });
    const ctx = makeCtx();
    await (await handler('BLUEPRINT_TOGGLE', '../handlers/layout'))({ type: 'BLUEPRINT_TOGGLE' } as never, () => {}, meta(ctx));
    expect(notices(ctx).map((c: any[]) => c[1].failure)).toEqual(['site-not-granted']);
    expect(ctx.blueprintActiveByWindow.get(PANEL_WINDOW)).toBe(false);
    expect(ctx.blueprintTabByWindow.has(PANEL_WINDOW)).toBe(false);
  });
});
