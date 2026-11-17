/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings":{"enableIframePageLoading":true}}
 *
 * Content-script re-injection (content.ts: the old instance's teardown, then
 * the new instance boots) keeps the open Companion windows: the new module
 * adopts the frames the old one handed over (content-frame-overlay
 * teardownFrameOverlayModule / adoptMountedFrames). One clean and one dirty
 * frame: both stay mounted with the same iframe, messages reach the new
 * module, nothing is doubled (frames, title bars, listeners), and the close
 * button and Escape still work; the dirty one still is never force-closed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type FrameOverlayModule = typeof import('../../content-frame-overlay');

const hosts = () => [...document.querySelectorAll<HTMLElement>('.crev-eo-host')];
const hostOf = (kind: string) => document.getElementById(`crev-frame-overlay-${kind}`)!;
const iframeOf = (kind: string) => hostOf(kind).querySelector('iframe')!;

function from(iframe: HTMLIFrameElement, data: Record<string, unknown>): void {
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: iframe.contentWindow });
  window.dispatchEvent(event);
}

const serverOf = (host: HTMLElement) => host.querySelector<HTMLElement>('.crev-eo-titlebar-server')!;
const identityParts = (host: HTMLElement) => [...serverOf(host).children].map(c => [c.className, c.textContent]);

async function freshModule(): Promise<FrameOverlayModule> {
  vi.resetModules();
  (globalThis as any).chrome = { storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } } };
  return import('../../content-frame-overlay');
}

/** Live listeners on the document, the window and connected elements. */
function listenerCounter() {
  const live = new Map<string, { target: EventTarget; type: string }>();
  const ids = new WeakMap<object, number>();
  let next = 0;
  const id = (o: object) => { if (!ids.has(o)) ids.set(o, ++next); return ids.get(o)!; };
  const capture = (o: unknown) => (typeof o === 'boolean' ? o : !!(o as { capture?: boolean } | undefined)?.capture);
  const key = (t: EventTarget, type: string, l: unknown, o: unknown) => `${id(t)}|${type}|${l ? id(l as object) : 0}|${capture(o)}`;
  // The objects that own addEventListener for the window, the document and
  // elements (happy-dom's classes, not Node's global EventTarget).
  const owner = (o: object, name: string): any => { let p: any = o; while (p && !Object.prototype.hasOwnProperty.call(p, name)) p = Object.getPrototypeOf(p); return p; };
  const spies: Array<{ mockRestore(): void }> = [];
  for (const name of ['addEventListener', 'removeEventListener'] as const) {
    for (const o of new Set([owner(window, name), owner(document, name), owner(document.createElement('div'), name)])) {
      const original = o[name] as (...args: any[]) => unknown;
      spies.push(vi.spyOn(o, name).mockImplementation(function (this: EventTarget, ...args: unknown[]) {
        const [type, l, opts] = args as [string, any, any];
        if (name === 'addEventListener') live.set(key(this, type, l, opts), { target: this, type });
        else live.delete(key(this, type, l, opts));
        return original.call(this, type, l, opts);
      }));
    }
  }
  const count = (target: EventTarget, type: string) => [...live.values()].filter(x => x.target === target && x.type === type).length;
  const connected = (type: string) => [...live.values()].filter(x => x.type === type && x.target !== document && x.target !== window && (x.target as Node).isConnected).length;
  return { count, connected, restore: () => { for (const s of spies) s.mockRestore(); } };
}

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.querySelectorAll('.crev-eo-host').forEach(h => h.remove());
  document.getElementById('crev-inspector-styles')?.remove();
  document.body.classList.remove('crev-task-open');
  delete (globalThis as any).chrome;
});

describe('re-injection keeps the open windows', () => {
  it('one clean and one dirty frame survive, keep routing messages, close and Escape work, nothing doubles', async () => {
    const listeners = listenerCounter();
    try {
      const old = await freshModule();
      await old.mountFrameOverlay({ kind: 'objectview', url: 'about:blank', label: 'Object', defaultWidth: 900, defaultHeight: 600, resourceKey: 'objectview:window' });
      await old.mountFrameOverlay({ kind: 'editor', url: 'about:blank', label: 'Editor', defaultWidth: 900, defaultHeight: 600, resourceKey: 'editor:42' });
      const clean = iframeOf('objectview');
      const dirty = iframeOf('editor');
      from(clean, { type: 'CREV_FRAME_READY' });
      from(dirty, { type: 'CREV_FRAME_READY' });
      from(dirty, { type: 'CREV_FRAME_DIRTY', dirty: true });
      const before = {
        message: listeners.count(window, 'message'),
        keydown: listeners.count(document, 'keydown'),
        resize: listeners.count(window, 'resize'),
        focusin: listeners.connected('focusin'),
        click: listeners.connected('click'),
        pointerdown: listeners.connected('pointerdown'),
      };
      // Per frame: Escape, viewport resize, focus-to-front, two buttons, the title bar and 8 handles.
      expect(before).toEqual({ message: 1, keydown: 2, resize: 2, focusin: 2, click: 4, pointerdown: 18 });

      // Re-injection: the old instance's teardown, then the new module boots and adopts.
      old.teardownFrameOverlayModule();
      const m = await freshModule();
      expect(m.adoptMountedFrames()).toBe(2);

      // Both mounted, the same iframes (not reloaded), one title bar each.
      expect(hosts()).toHaveLength(2);
      expect(iframeOf('objectview')).toBe(clean);
      expect(iframeOf('editor')).toBe(dirty);
      for (const h of hosts()) {
        expect(h.querySelectorAll('.crev-eo-titlebar')).toHaveLength(1);
        expect(h.querySelectorAll('.crev-eo-resize')).toHaveLength(8);
        // Rebuilt handles sit after the iframe (painted above it), the east one included.
        const kids = [...h.children];
        const at = kids.indexOf(h.querySelector(':scope > iframe.crev-eo-iframe')!);
        expect(kids.slice(at + 1).map(c => c.className)).toEqual(
          ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => `crev-eo-resize crev-eo-resize--${d}`));
        expect(h.hasAttribute('data-crev-handover')).toBe(false);
        // The overlay invariant: positioning stays inline.
        expect(h.style.position).toBe('fixed');
        expect(h.style.zIndex).not.toBe('');
      }
      // No duplicate listeners: the same live counts as before.
      expect({
        message: listeners.count(window, 'message'),
        keydown: listeners.count(document, 'keydown'),
        resize: listeners.count(window, 'resize'),
        focusin: listeners.connected('focusin'),
        click: listeners.connected('click'),
        pointerdown: listeners.connected('pointerdown'),
      }).toEqual(before);
      expect(document.getElementById('crev-inspector-styles')).not.toBeNull();

      // Messages reach the new module.
      from(clean, { type: 'CREV_FRAME_TITLE', label: 'TextElement · Text' });
      expect(hostOf('objectview').querySelector('.crev-eo-titlebar-label')?.textContent).toBe('TextElement · Text');
      const post = vi.spyOn(clean.contentWindow!, 'postMessage');
      // Opening the same window again activates it (ready carried over): no second frame.
      expect(await m.mountFrameOverlay({ kind: 'objectview', url: 'about:blank', label: 'Object', defaultWidth: 900, defaultHeight: 600, resourceKey: 'objectview:window', activation: { type: 'objectview', rid: '7' } })).toBe('activated');
      expect(post).toHaveBeenCalledWith({ type: 'CREV_FRAME_ACTIVATE', activation: { type: 'objectview', rid: '7' } }, '*');
      expect(hosts()).toHaveLength(2);

      // The dirty one is still known as dirty: a close with no answer keeps it.
      vi.useFakeTimers();
      hostOf('editor').querySelector<HTMLButtonElement>('.crev-eo-close')!.click();
      vi.advanceTimersByTime(1_600);
      expect(hosts()).toHaveLength(2);
      vi.useRealTimers();

      // Escape on the focused clean frame asks it, and it closes on yes.
      post.mockClear();
      const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(clean);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      active.mockRestore();
      expect(post).toHaveBeenCalledWith({ type: 'CREV_OVERLAY_CLOSE_REQUEST' }, '*');
      from(clean, { type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok: true });
      expect(hosts()).toHaveLength(1);

      // The close button of the dirty one, after its own "discard" answer.
      hostOf('editor').querySelector<HTMLButtonElement>('.crev-eo-close')!.click();
      from(dirty, { type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok: true });
      expect(hosts()).toHaveLength(0);
      expect(listeners.count(document, 'keydown')).toBe(0);
      expect(listeners.count(window, 'resize')).toBe(0);
      expect(listeners.count(window, 'message')).toBe(1);
    } finally { listeners.restore(); }
  });

  it('a close in flight survives: the new instance listens for the "Discard" answer without asking again', async () => {
    const listeners = listenerCounter();
    try {
      const old = await freshModule();
      await old.mountFrameOverlay(EDITOR);
      const iframe = iframeOf('editor');
      from(iframe, { type: 'CREV_FRAME_DIRTY', dirty: true });
      hostOf('editor').querySelector<HTMLButtonElement>('.crev-eo-close')!.click();
      // The frame shows its "Discard unsaved changes?" prompt.
      from(iframe, { type: 'CREV_OVERLAY_CLOSE_PENDING' });
      expect(listeners.count(window, 'message')).toBe(2);
      old.teardownFrameOverlayModule();
      expect(listeners.count(window, 'message')).toBe(0);
      const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
      const m = await freshModule();
      vi.useFakeTimers();
      expect(m.adoptMountedFrames()).toBe(1);
      expect(listeners.count(window, 'message')).toBe(2);
      expect(post).not.toHaveBeenCalled();
      // Acknowledged before: no 1.5 s fallback while the user decides.
      vi.advanceTimersByTime(60_000);
      expect(hosts()).toHaveLength(1);
      from(iframe, { type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok: true });
      expect(hosts()).toHaveLength(0);
      expect(listeners.count(window, 'message')).toBe(1);
    } finally { listeners.restore(); }
  });

  it('a pending replace survives: the answer after re-injection opens the requested object', async () => {
    const old = await freshModule();
    await old.mountFrameOverlay({ ...EDITOR, resourceKey: 'editor:42', label: 'First' });
    const first = iframeOf('editor');
    expect(await old.mountFrameOverlay({ ...EDITOR, resourceKey: 'editor:84', label: 'Second' })).toBe('replacement-pending');
    old.teardownFrameOverlayModule();
    const m = await freshModule();
    m.adoptMountedFrames();
    from(first, { type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok: true });
    expect(iframeOf('editor')).not.toBe(first);
    expect(hostOf('editor').querySelector('.crev-eo-titlebar-label')?.textContent).toBe('Second');
  });

  it('focus returns to the control that opened the window, across the hand-over', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const old = await freshModule();
    await old.mountFrameOverlay(EDITOR);
    old.teardownFrameOverlayModule();
    expect(opener.getAttribute('data-crev-opener')).toBe('editor');
    const m = await freshModule();
    m.adoptMountedFrames();
    expect(opener.hasAttribute('data-crev-opener')).toBe(false);
    (hostOf('editor').querySelector('.crev-eo-close') as HTMLElement).focus();
    m.unmountFrameOverlay('editor');
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('maximized state and a pending activation are carried over', async () => {
    const old = await freshModule();
    await old.mountFrameOverlay({ ...EDITOR, activation: { type: 'editor', rid: '42', property: 'expression' } });
    const host = hostOf('editor');
    const before = { left: host.style.left, width: host.style.width };
    host.querySelector<HTMLButtonElement>('.crev-eo-max')!.click();
    expect(host.style.width).not.toBe(before.width);
    old.teardownFrameOverlayModule();
    const m = await freshModule();
    m.adoptMountedFrames();
    const max = host.querySelector<HTMLButtonElement>('.crev-eo-max')!;
    expect(max.title).toBe('Restore');
    max.click();
    expect({ left: host.style.left, width: host.style.width }).toEqual(before);
    // Not ready before the hand-over: the activation goes once the frame reports ready.
    const iframe = iframeOf('editor');
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    from(iframe, { type: 'CREV_FRAME_READY' });
    expect(post).toHaveBeenCalledWith({ type: 'CREV_FRAME_ACTIVATE', activation: { type: 'editor', rid: '42', property: 'expression' } }, '*');
  });

  it('carries the title bar identity over: server, user and session kind, split as before', async () => {
    const old = await freshModule();
    old.setFrameServer({ profileLabel: 'Test server', identities: { command: { status: 'connected', user: 'alex', source: 'stored-login' } } });
    await old.mountFrameOverlay(EDITOR);
    old.teardownFrameOverlayModule();
    const m = await freshModule();
    expect(m.adoptMountedFrames()).toBe(1);
    expect(identityParts(hostOf('editor'))).toEqual([
      ['crev-eo-srv-name', 'Test server'], ['crev-eo-srv-user', 'alex'], ['crev-eo-srv-kind', 'stored configuration login'],
    ]);
    expect(serverOf(hostOf('editor')).title).toBe('Works on Test server · alex · stored configuration login');
    // A window opened after the hand-over shows the same identity.
    await m.mountFrameOverlay({ kind: 'codesearch', url: 'about:blank', label: 'Code search', defaultWidth: 700, defaultHeight: 500 });
    expect(identityParts(hostOf('codesearch'))).toEqual(identityParts(hostOf('editor')));
    // The page's next connection state replaces it in every window.
    m.setFrameServer({ profileLabel: 'Steadfast', identities: { command: { status: 'connected', user: 'admin', source: 'portal-session' } } });
    for (const kind of ['editor', 'codesearch']) {
      expect(identityParts(hostOf(kind))).toEqual([
        ['crev-eo-srv-name', 'Steadfast'], ['crev-eo-srv-user', 'admin'], ['crev-eo-srv-kind', 'browser session'],
      ]);
    }
  });

  it('restores the stylesheet the old reset removed, and re-creates the overlap observer', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    try {
      const old = await freshModule();
      await old.mountFrameOverlay(EDITOR);
      expect(observe).toHaveBeenCalledTimes(1);
      old.teardownFrameOverlayModule();
      expect(disconnect).toHaveBeenCalledTimes(1);
      // content.ts resetContentState removes the stylesheet before the new instance boots.
      document.getElementById('crev-inspector-styles')?.remove();
      const m = await freshModule();
      m.adoptMountedFrames();
      expect(document.getElementById('crev-inspector-styles')).not.toBeNull();
      expect(observe).toHaveBeenCalledTimes(2);
    } finally { disconnect.mockRestore(); observe.mockRestore(); }
  });

  it('never adopts a second frame of a kind already open; that host keeps a close that asks first', async () => {
    const old = await freshModule();
    await old.mountFrameOverlay(EDITOR);
    const handed = hostOf('editor');
    const handedFrame = iframeOf('editor');
    from(handedFrame, { type: 'CREV_FRAME_DIRTY', dirty: true });
    old.teardownFrameOverlayModule();
    const m = await freshModule();
    await m.mountFrameOverlay(EDITOR);
    expect(m.adoptMountedFrames()).toBe(0);
    expect(hosts()).toHaveLength(2);
    expect(handed.querySelectorAll('.crev-eo-titlebar')).toHaveLength(1);
    expect(handed.querySelectorAll('.crev-eo-resize')).toHaveLength(0);
    // Its close asks the frame; dirty and silent: it stays.
    vi.useFakeTimers();
    const post = vi.spyOn(handedFrame.contentWindow!, 'postMessage');
    handed.querySelector<HTMLButtonElement>('.crev-eo-close')!.click();
    expect(post).toHaveBeenCalledWith({ type: 'CREV_OVERLAY_CLOSE_REQUEST' }, '*');
    vi.advanceTimersByTime(1_600);
    expect(handed.isConnected).toBe(true);
    vi.useRealTimers();
    handed.querySelector<HTMLButtonElement>('.crev-eo-close')!.click();
    from(handedFrame, { type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok: true });
    expect(handed.isConnected).toBe(false);
    // The adopted-by-mount frame is untouched; closing it clears the body flag.
    expect(document.body.classList.contains('crev-task-open')).toBe(true);
    m.unmountFrameOverlay('editor');
    expect(document.body.classList.contains('crev-task-open')).toBe(false);
  });

  it('a handed-over host with bad data or no iframe does not leave a stale body flag', async () => {
    const m = await freshModule();
    const bad = document.createElement('div');
    bad.className = 'crev-eo-host';
    bad.dataset.kind = 'editor';
    bad.setAttribute('data-crev-handover', '1');
    bad.setAttribute('data-crev-handover-state', '{not json');
    document.documentElement.append(bad);
    document.body.classList.add('crev-task-open');
    expect(m.adoptMountedFrames()).toBe(0);
    expect(bad.isConnected).toBe(false);
    expect(document.body.classList.contains('crev-task-open')).toBe(false);
  });
});

const EDITOR = { kind: 'editor' as const, url: 'about:blank', label: 'Editor', defaultWidth: 900, defaultHeight: 600 };
