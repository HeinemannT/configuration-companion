/**
 * The message policy, enumerated through the router (message-router.ts) for
 * every registered request type and every sender kind: a type runs for a
 * sender exactly when message-access.ts allows it, whichever entry point
 * the message arrives on. message-access.test.ts checks the table itself;
 * this file checks that the router enforces it, so a new entry point or a
 * reordered check cannot let a content script reach an extension-only type.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { warmServiceWorkerGraph } from './warm-imports';
import type { InspectorMessage } from '../types';

// The router and every handler, once, before the tests (busy machines).
warmServiceWorkerGraph(mockChromeStorage);

const PAGE = 'https://bmp.example.test/Ws/';
const content = { id: 'test', url: PAGE, tab: { id: 7, url: PAGE }, frameId: 0 } as unknown as chrome.runtime.MessageSender;
const frame = { id: 'test', url: 'chrome-extension://test/objectview/window.html', tab: { id: 7, url: PAGE }, frameId: 3 } as unknown as chrome.runtime.MessageSender;
const sidePanel = { id: 'test', url: 'chrome-extension://test/sidepanel/sidepanel.html' } as unknown as chrome.runtime.MessageSender;
const otherExtension = { id: 'someone-else', url: 'chrome-extension://someone-else/page.html', tab: { id: 7, url: PAGE } } as unknown as chrome.runtime.MessageSender;

let types: string[] = [];
let ran: string[] = [];
let router: typeof import('../message-router');
let senderKindMay: typeof import('../message-access').senderKindMay;

/** The router over a plain context (no profile scopes), with every
 *  registered handler replaced by a probe that records its type. */
beforeAll(async () => {
  vi.resetModules();
  mockChromeStorage();
  const ctx = {
    settingsReady: Promise.resolve(), logActivity: vi.fn(), sendToPanel: vi.fn(), toast: vi.fn(),
    panelPortByWindow: new Map(), contentPorts: new Map(),
    settings: { profiles: [], activeProfileId: '' },
  };
  (await import('../sw-context')).setSwContext(ctx as never);
  router = await import('../message-router');
  const registry = await import('../handler-registry');
  ({ senderKindMay } = await import('../message-access'));
  types = registry.registeredTypes();
  for (const type of types) {
    registry.register(type as InspectorMessage['type'], (_msg, respond) => {
      ran.push(type);
      respond({ type: 'PROBE_DONE' } as unknown as InspectorMessage);
    });
  }
}, 60_000);

/** Send `type` one-shot from `sender`; resolves with the reply. */
function oneShot(type: string, sender: chrome.runtime.MessageSender): Promise<InspectorMessage> {
  return new Promise(resolve => {
    router.handleOneShotMessage({ type } as unknown as InspectorMessage, sender, resolve);
  });
}

describe('message policy, enforced by the router for every registered type', () => {
  it('knows enough types for the enumeration to mean something', () => {
    expect(types.length).toBeGreaterThan(100);
    expect(types.filter(t => !senderKindMay('content', t)).length).toBeGreaterThan(50);
  });

  it('one-shot from a content script: runs exactly the types a content script may send', async () => {
    ran = [];
    const refused: string[] = [];
    for (const type of types) {
      const reply = await oneShot(type, content) as { type: string; error?: string };
      if (reply.type === 'REQUEST_FAILED') {
        expect(reply.error, type).toBe('This request is not accepted from a page.');
        refused.push(type);
      }
    }
    expect(ran.sort()).toEqual(types.filter(t => senderKindMay('content', t)).sort());
    expect(refused.sort()).toEqual(types.filter(t => !senderKindMay('content', t)).sort());
  });

  it('content-script port: runs exactly the types a content script may send', async () => {
    ran = [];
    for (const type of types) await router.handleContentMessage({ type } as unknown as InspectorMessage, 7, PAGE);
    expect(ran.sort()).toEqual(types.filter(t => senderKindMay('content', t)).sort());
  });

  it('one-shot from a Companion window inside a page: runs exactly the types a frame may send', async () => {
    ran = [];
    for (const type of types) {
      const reply = await oneShot(type, frame) as { type: string; error?: string };
      if (reply.type === 'REQUEST_FAILED') expect(reply.error, type).toBe('This request is accepted only from Companion’s own pages.');
    }
    expect(ran.sort()).toEqual(types.filter(t => senderKindMay('frame', t)).sort());
  });

  it('one-shot from the side panel: runs every type', async () => {
    ran = [];
    for (const type of types) await oneShot(type, sidePanel);
    expect(ran.sort()).toEqual([...types].sort());
  });

  it('one-shot from another extension: runs nothing', async () => {
    ran = [];
    for (const type of types) expect((await oneShot(type, otherExtension)).type, type).toBe('REQUEST_FAILED');
    expect(ran).toEqual([]);
  });

  it('a panel port whose sender is a content script: runs nothing', async () => {
    ran = [];
    const port = { sender: content, postMessage: vi.fn() } as unknown as chrome.runtime.Port;
    for (const type of types) await router.handlePanelMessage({ type } as unknown as InspectorMessage, port);
    expect(ran).toEqual([]);
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('an unregistered type is not answered and runs nothing, from any sender', async () => {
    ran = [];
    for (const sender of [content, frame, sidePanel]) {
      expect(router.handleOneShotMessage({ type: 'NOT_A_TYPE' } as unknown as InspectorMessage, sender, () => {})).toBe(false);
    }
    expect(ran).toEqual([]);
  });
});
