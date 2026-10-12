import { beforeEach, expect, it, vi } from 'vitest';
const { ctx } = vi.hoisted(() => ({ ctx: { client: { serverUrl: 'https://example.test/' }, settings: { activeProfileId: 'demo' } } }));
vi.mock('../sw-context', () => ({ getCtx: () => ctx }));
vi.mock('./service', () => ({ handleAccessRequest: vi.fn() }));
import { openAccessWorkspace } from '../handlers/access-workspace';

const environment = 'demo@https://example.test/';
const url = 'chrome-extension://test/access/access.html?environment=' + encodeURIComponent(environment);
let tabs: Array<{ id: number; windowId: number; url: string; index: number; active?: boolean }>;
beforeEach(() => {
  ctx.settings.activeProfileId = 'demo';
  tabs = [];
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => 'chrome-extension://test/' + path, sendMessage: vi.fn().mockResolvedValue({ ok: true }) },
    tabs: { query: vi.fn(async (query: chrome.tabs.QueryInfo) => tabs.filter(tab => (!query.active || tab.active) && (query.windowId == null || tab.windowId === query.windowId))),
      get: vi.fn(async (id: number) => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw Error('Tab closed'); return tab; }),
      move: vi.fn().mockResolvedValue({}),
      create: vi.fn(async ({ url }: { url: string }) => { const tab = { id: 7, windowId: 4, index: 1, url }; tabs.push(tab); return tab; }), update: vi.fn().mockResolvedValue({}) },
    windows: { update: vi.fn().mockResolvedValue({}) },
  });
});
it('coalesces concurrent tab creation while retaining the second explicit destination', async () => {
  await Promise.all([openAccessWorkspace(), openAccessWorkspace({ kind: 'role', rid: '9000000000000000001' }, environment)]);
  expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'ACCESS_WORKSPACE_NAVIGATE', tabId: 7, environment, destination: { kind: 'role', rid: '9000000000000000001' } });
  expect(chrome.tabs.update).not.toHaveBeenCalledWith(7, expect.objectContaining({ url: expect.anything() }));
});
it('resumes a matching tab without a reload, route change or navigation message', async () => {
  tabs.push({ id: 7, windowId: 4, index: 1, url: url + '#open=booting' });
  await openAccessWorkspace();
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
});

it('opens immediately after the source tab in the calling panel window', async () => {
  tabs.push({ id: 3, windowId: 4, index: 5, active: true, url: 'https://example.test/' });
  tabs.push({ id: 9, windowId: 6, index: 2, active: true, url: 'https://unrelated.test/' });
  await openAccessWorkspace(undefined, undefined, { panelWindowId: 4 });
  expect(chrome.tabs.create).toHaveBeenCalledWith({ url, windowId: 4, index: 6, openerTabId: 3 });
});

it.each([{ windowId: 4, index: 1, target: 5 }, { windowId: 4, index: 9, target: 6 }, { windowId: 8, index: 1, target: 6 }])(
  'places a resumed draft beside its origin without reloading: %j', async ({ windowId, index, target }) => {
    tabs.push({ id: 3, windowId: 4, index: 5, url: 'https://example.test/' });
    tabs.push({ id: 7, windowId, index, url });
    await openAccessWorkspace(undefined, undefined, { senderTabId: 3 });
    expect(chrome.tabs.move).toHaveBeenCalledWith(7, { windowId: 4, index: target });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(4, { focused: true });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

it('still opens when the originating tab has closed', async () => {
  await openAccessWorkspace(undefined, undefined, { senderTabId: 999 });
  expect(chrome.tabs.create).toHaveBeenCalledWith({ url });
});
it('carries an initial destination and refuses context from a different connection', async () => {
  const destination = { kind: 'policy' as const, rid: '123', statement: 2 };
  await openAccessWorkspace(destination, environment);
  expect(tabs[0].url).toBe(url + '#open=' + encodeURIComponent(JSON.stringify(destination)));
  await expect(openAccessWorkspace(destination, 'other@https://example.test/')).rejects.toThrow('connection');
  expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
});

it('refuses an object link without provenance, while the toolbar can still resume Access', async () => {
  await expect(openAccessWorkspace({ kind: 'role', rid: '9000000000000000001' })).rejects.toThrow('connection is unknown');
  expect(chrome.tabs.query).not.toHaveBeenCalled();
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  await openAccessWorkspace();
  expect(chrome.tabs.create).toHaveBeenCalledOnce();
});

it('does not reinterpret an old card RID in the newly selected profile', async () => {
  ctx.settings.activeProfileId = 'other';
  await expect(openAccessWorkspace({ kind: 'role', rid: '9000000000000000001' }, environment)).rejects.toThrow('connection');
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it('refuses a queued launch when its connection changes while locating the opener', async () => {
  const pending = openAccessWorkspace({ kind: 'role', rid: '9000000000000000001' }, environment);
  ctx.settings.activeProfileId = 'other';
  await expect(pending).rejects.toThrow('connection changed');
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});
