/**
 * Message router dispatch — a throwing/rejecting handler must never leave
 * a request hanging or emit an unhandled rejection.
 *
 * handleContentMessage and handleOneShotMessage both invoke handlers
 * without awaiting them directly (the handler runs after settingsReady
 * resolves). Both paths must catch a rejection and log it; the one-shot
 * path additionally must guarantee a sendResponse call so the caller's
 * chrome.runtime.sendMessage promise resolves instead of hanging forever.
 *
 * handlePanelMessage already awaits its handler directly and is out of
 * scope for this suite (see plan 004).
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import type { InspectorMessage } from '../types';

// Every test registers its own handlers: the router's real handler modules
// (imported only to register themselves) are not loaded. That module graph
// is most of the service worker and took seconds to transform per file. A
// handler module missing from this list is loaded for real, which is slower
// but changes nothing here.
vi.mock('../handlers/inspect', () => ({}));
vi.mock('../handlers/profiles', () => ({}));
vi.mock('../handlers/objects', () => ({}));
vi.mock('../handlers/ec', () => ({}));
vi.mock('../handlers/json-shape', () => ({}));
vi.mock('../handlers/studio', () => ({}));
vi.mock('../handlers/access', () => ({}));
vi.mock('../handlers/access-workspace', () => ({}));
vi.mock('../handlers/enrichment', () => ({}));
vi.mock('../handlers/detection', () => ({}));
vi.mock('../handlers/history', () => ({}));
vi.mock('../handlers/windows', () => ({}));
vi.mock('../handlers/compare', () => ({}));
vi.mock('../handlers/object-search', () => ({}));
vi.mock('../handlers/object-window', () => ({}));
vi.mock('../handlers/custom-properties', () => ({}));
vi.mock('../handlers/browse', () => ({}));
vi.mock('../handlers/code-refs', () => ({}));
vi.mock('../handlers/code-search', () => ({}));
vi.mock('../handlers/transport', () => ({}));
vi.mock('../handlers/transport-window', () => ({}));
vi.mock('../handlers/bmp-goto', () => ({}));
vi.mock('../handlers/layout', () => ({}));
vi.mock('../handlers/site-access', () => ({}));
vi.mock('../handlers/ai', () => ({}));
vi.mock('../handlers/page-prefs', () => ({}));

/** Fresh module graph per test: resets the handler registry (module-level
 *  Map in handler-registry.ts) and re-establishes a minimal chrome mock
 *  before message-router.ts (and the handler files it imports for their
 *  registration side effects) is loaded. Mirrors the pattern used by
 *  per-window-inspect.test.ts. */
async function harness() {
  vi.resetModules();
  mockChromeStorage();

  const registryMod = await import('../handler-registry');
  const swCtxMod = await import('../sw-context');
  const routerMod = await import('../message-router');
  const loggerMod = await import('../logger');

  const ctx: any = {
    settingsReady: Promise.resolve(),
    sendToPanel: vi.fn(),
  };
  swCtxMod.setSwContext(ctx);

  return {
    register: registryMod.register,
    handleContentMessage: routerMod.handleContentMessage,
    handleOneShotMessage: routerMod.handleOneShotMessage,
    handlePanelMessage: routerMod.handlePanelMessage,
    log: loggerMod.log,
    ctx,
  };
}

/** A sender that is one of Companion's own pages (the side panel). */
function extensionPage(): chrome.runtime.MessageSender {
  return { id: chrome.runtime.id, url: chrome.runtime.getURL('sidepanel/sidepanel.html') } as chrome.runtime.MessageSender;
}

/** Flush both the microtask queue and one macrotask tick — enough for a
 *  chained .then().catch() (or a settingsReady.then() gate) to settle. */
function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('message-router — handleContentMessage', () => {
  it('swallows a handler rejection instead of producing an unhandled rejection', async () => {
    const h = await harness();
    const swallowSpy = vi.spyOn(h.log, 'swallow');
    h.register('BMP_PAGE_RENDER_CHANGED', async () => {
      throw new Error('content handler boom');
    });

    // Must not throw synchronously, and must not reject the returned promise.
    await expect(
      h.handleContentMessage({ type: 'BMP_PAGE_RENDER_CHANGED' } as unknown as InspectorMessage, 1),
    ).resolves.toBeUndefined();

    await flush();
    expect(swallowSpy).toHaveBeenCalledWith('router:content:BMP_PAGE_RENDER_CHANGED', expect.any(Error));
  });

  it('does not call log.swallow when the handler resolves normally', async () => {
    const h = await harness();
    const swallowSpy = vi.spyOn(h.log, 'swallow');
    const handler = vi.fn(async () => {});
    h.register('BMP_URL_CHANGED', handler);

    await h.handleContentMessage({ type: 'BMP_URL_CHANGED' } as unknown as InspectorMessage, 1);
    await flush();

    expect(handler).toHaveBeenCalled();
    expect(swallowSpy).not.toHaveBeenCalled();
  });
});

describe('message-router — handleOneShotMessage', () => {
  it('always calls sendResponse with a typed REQUEST_FAILED error when the handler throws before responding', async () => {
    const h = await harness();
    const swallowSpy = vi.spyOn(h.log, 'swallow');
    h.register('TEST_ONESHOT_THROW', () => {
      throw new Error('oneshot boom');
    });
    const sendResponse = vi.fn();

    const kept = h.handleOneShotMessage(
      { type: 'TEST_ONESHOT_THROW' } as unknown as InspectorMessage,
      extensionPage(),
      sendResponse,
    );
    expect(kept).toBe(true);

    await flush();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ type: 'REQUEST_FAILED', requestType: 'TEST_ONESHOT_THROW', error: 'oneshot boom' });
    expect(swallowSpy).toHaveBeenCalledWith('router:oneshot:TEST_ONESHOT_THROW', expect.any(Error));
  });

  it('happy path: handler responds normally and the fallback never fires', async () => {
    const h = await harness();
    const swallowSpy = vi.spyOn(h.log, 'swallow');
    h.register('TEST_ONESHOT_OK', (_msg, respond) => {
      respond({ type: 'TEST_ONESHOT_OK_RESULT', ok: true } as unknown as InspectorMessage);
    });
    const sendResponse = vi.fn();

    const kept = h.handleOneShotMessage(
      { type: 'TEST_ONESHOT_OK' } as unknown as InspectorMessage,
      extensionPage(),
      sendResponse,
    );
    expect(kept).toBe(true);

    await flush();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ type: 'TEST_ONESHOT_OK_RESULT', ok: true });
    expect(swallowSpy).not.toHaveBeenCalled();
  });

  it('hands the sender frame and document to the handler (per-window write binding)', async () => {
    const h = await harness();
    let seen: Record<string, unknown> | undefined;
    h.register('TEST_ONESHOT_META', (_msg, respond, meta) => { seen = meta as never; respond({ type: 'TEST_ONESHOT_META_RESULT' } as unknown as InspectorMessage); });
    const sender = { ...extensionPage(), frameId: 4, documentId: 'doc-1' } as chrome.runtime.MessageSender;
    h.handleOneShotMessage({ type: 'TEST_ONESHOT_META' } as unknown as InspectorMessage, sender, vi.fn());
    await flush();
    expect(seen).toMatchObject({ senderFrameId: 4, senderDocumentId: 'doc-1' });
    expect(seen?.senderUrl).toBeUndefined();
    // An embedded window (frame) also names its page, so the worker knows which window it is.
    const page = chrome.runtime.getURL('objectview/window.html#1');
    h.register('APPLY_CUSTOM_CHANGES', (_msg, respond, meta) => { seen = meta as never; respond({ type: 'X' } as unknown as InspectorMessage); });
    const frame = { ...sender, url: page, tab: { id: 7, url: 'https://bmp.test/x' } } as chrome.runtime.MessageSender;
    seen = undefined;
    h.handleOneShotMessage({ type: 'APPLY_CUSTOM_CHANGES' } as unknown as InspectorMessage, frame, vi.fn());
    await flush();
    expect(seen).toMatchObject({ senderKind: 'frame', senderTabId: 7, senderFrameId: 4, senderDocumentId: 'doc-1', senderUrl: page });
  });

  it('returns false and never touches sendResponse for an unregistered type', async () => {
    const h = await harness();
    const sendResponse = vi.fn();

    const kept = h.handleOneShotMessage(
      { type: 'TEST_ONESHOT_UNKNOWN' } as unknown as InspectorMessage,
      extensionPage(),
      sendResponse,
    );

    expect(kept).toBe(false);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe('message-router — handlePanelMessage', () => {
  it('replies with a typed REQUEST_FAILED on the panel port when the handler throws', async () => {
    const h = await harness();
    h.ctx.panelPortByWindow = new Map();
    h.register('TEST_PANEL_THROW', async () => {
      const { BmpRequestError } = await import('../error-kind');
      throw new BmpRequestError('Not signed in to BMP', 'not-signed-in');
    });
    const port = { postMessage: vi.fn() } as unknown as chrome.runtime.Port;
    // Before the fix the rejection escaped (`void handlePanelMessage`) and the
    // panel never got a reply.
    await expect(h.handlePanelMessage({ type: 'TEST_PANEL_THROW' } as unknown as InspectorMessage, port)).resolves.toBeUndefined();
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'REQUEST_FAILED', requestType: 'TEST_PANEL_THROW', error: 'Not signed in to BMP', errorKind: 'not-signed-in',
    });
  });
});
