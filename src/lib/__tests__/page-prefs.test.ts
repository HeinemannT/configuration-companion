/**
 * The page layer's preferences through the worker (handlers/page-prefs.ts):
 * the content script may ask for exactly one validated value per request, and
 * nothing it sends or receives reaches any other stored key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import type { InspectorMessage } from '../types';

const page = { id: 'test', url: 'https://bmp.test/Ws/', tab: { id: 3, url: 'https://bmp.test/Ws/' } } as unknown as chrome.runtime.MessageSender;
const frame = { id: 'test', url: 'chrome-extension://test/objectview/window.html', tab: { id: 3, url: 'https://bmp.test/Ws/' }, frameId: 2 } as unknown as chrome.runtime.MessageSender;
const stranger = { id: 'other-extension', url: 'chrome-extension://other/x.html' } as unknown as chrome.runtime.MessageSender;

async function setup() {
  vi.resetModules();
  mockChromeStorage();
  await chrome.storage.local.set({
    crev_settings: { profiles: [{ id: 'p', bmpPass: 'ciphertext' }], ai: { apiKeyEnc: 'key-ciphertext' } },
    crev_overlay_bounds_editor: { left: 10, top: 20, width: 800, height: 600 },
    // A key under the same prefix that is no window kind: not reachable.
    crev_overlay_bounds_x: { left: 1, top: 1, width: 1, height: 1 },
    crev_blueprint_portable_ids: { enabled: true, pattern: '{page}_{name}', extra: 'dropped' },
  });
  const ctx: any = { settingsReady: Promise.resolve(), logActivity: vi.fn(), settings: { profiles: [], activeProfileId: '' } };
  (await import('../sw-context')).setSwContext(ctx);
  const router = await import('../message-router');
  const send = (msg: Record<string, unknown>, sender = page) => new Promise<InspectorMessage>(resolve => {
    router.handleOneShotMessage(msg as InspectorMessage, sender, resolve);
  });
  return { send };
}

describe('page preferences through the worker', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('answers a content script one window placement and nothing else', async () => {
    const { send } = await setup();
    const reply = await send({ type: 'FRAME_BOUNDS_GET', kind: 'editor' });
    expect(reply).toEqual({ type: 'FRAME_BOUNDS_DATA', bounds: { left: 10, top: 20, width: 800, height: 600 } });
    // A kind that is not a window kind cannot name another key.
    for (const kind of ['x', '../settings', 'settings', '', 42, 'editor_x']) {
      expect(await send({ type: 'FRAME_BOUNDS_GET', kind })).toEqual({ type: 'FRAME_BOUNDS_DATA', bounds: null });
    }
    expect(JSON.stringify(await send({ type: 'FRAME_BOUNDS_GET', kind: 'diff' }))).not.toContain('ciphertext');
  });

  it('stores a valid placement and refuses a malformed one', async () => {
    const { send } = await setup();
    expect(await send({ type: 'FRAME_BOUNDS_SAVE', kind: 'diff', bounds: { left: 1, top: 2, width: 300, height: 200, extra: 'x' } }))
      .toEqual({ type: 'FRAME_BOUNDS_DATA', bounds: { left: 1, top: 2, width: 300, height: 200 } });
    expect((await chrome.storage.local.get('crev_overlay_bounds_diff')).crev_overlay_bounds_diff)
      .toEqual({ left: 1, top: 2, width: 300, height: 200 });
    for (const bounds of [null, 'x', { left: 1, top: 2, width: -5, height: 3 }, { left: Infinity, top: 0, width: 1, height: 1 },
      { left: 1e9, top: 0, width: 1, height: 1 }, { left: '1', top: 0, width: 1, height: 1 }]) {
      expect(await send({ type: 'FRAME_BOUNDS_SAVE', kind: 'diff', bounds })).toEqual({ type: 'FRAME_BOUNDS_DATA', bounds: null });
    }
    expect(await send({ type: 'FRAME_BOUNDS_SAVE', kind: 'crev_settings', bounds: { left: 1, top: 2, width: 3, height: 4 } }))
      .toEqual({ type: 'FRAME_BOUNDS_DATA', bounds: null });
    expect(((await chrome.storage.local.get('crev_settings')).crev_settings as any).profiles[0].bmpPass).toBe('ciphertext');
  });

  it('reads and writes the portable-ID recipe as its two fields only', async () => {
    const { send } = await setup();
    expect(await send({ type: 'PORTABLE_IDS_GET' })).toEqual({ type: 'PORTABLE_IDS_DATA', config: { enabled: true, pattern: '{page}_{name}' } });
    expect(await send({ type: 'PORTABLE_IDS_SAVE', config: { enabled: 'yes', pattern: '{class}_{name}', smuggled: 1 } }))
      .toEqual({ type: 'PORTABLE_IDS_DATA', config: { enabled: false, pattern: '{class}_{name}' } });
    expect((await chrome.storage.local.get('crev_blueprint_portable_ids')).crev_blueprint_portable_ids)
      .toEqual({ enabled: false, pattern: '{class}_{name}' });
    // A pattern that does not validate is refused; the stored recipe stays.
    for (const config of [{ enabled: true, pattern: '{unknown}' }, { enabled: true, pattern: `{name}${'x'.repeat(300)}` }, null]) {
      expect(await send({ type: 'PORTABLE_IDS_SAVE', config })).toMatchObject({ type: 'REQUEST_FAILED' });
    }
    expect(((await chrome.storage.local.get('crev_blueprint_portable_ids')).crev_blueprint_portable_ids as any).pattern).toBe('{class}_{name}');
  });

  it('accepts these requests from a content script only', async () => {
    const { send } = await setup();
    for (const msg of [{ type: 'FRAME_BOUNDS_GET', kind: 'editor' }, { type: 'PORTABLE_IDS_GET' },
      { type: 'FRAME_BOUNDS_SAVE', kind: 'editor', bounds: { left: 0, top: 0, width: 1, height: 1 } },
      { type: 'PORTABLE_IDS_SAVE', config: { enabled: true, pattern: '{name}' } }]) {
      expect(await send(msg, frame), `${msg.type} from a frame`).toMatchObject({ type: 'REQUEST_FAILED' });
      expect(await send(msg, stranger), `${msg.type} from another extension`).toMatchObject({ type: 'REQUEST_FAILED' });
    }
    expect(((await chrome.storage.local.get('crev_overlay_bounds_editor')).crev_overlay_bounds_editor as any).width).toBe(800);
  });
});
