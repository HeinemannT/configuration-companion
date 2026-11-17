/**
 * Keep-alive port of the code search window (keep-alive.ts): pings while
 * open, reconnects after a worker restart, ends quietly after an extension
 * reload, and only the code search page may hold it (sender-trust).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acceptKeepAlivePort, KEEPALIVE_MAX_DROPS, KEEPALIVE_PING_MS, KEEPALIVE_PORT, KEEPALIVE_REFUSED, startKeepAlive } from '../keep-alive';
import { mayHoldKeepAlivePort } from '../sender-trust';

interface FakePort {
  name: string;
  sent: unknown[];
  disconnected: boolean;
  postMessage(m: unknown): void;
  disconnect(): void;
  onDisconnect: { addListener(fn: () => void): void };
  onMessage: { addListener(fn: (m: unknown) => void): void };
  fireDisconnect(): void;
  deliver(m: unknown): void;
  sender?: chrome.runtime.MessageSender;
}

function fakePort(name: string, sender?: chrome.runtime.MessageSender): FakePort {
  const onDis: Array<() => void> = [];
  const onMsg: Array<(m: unknown) => void> = [];
  const p: FakePort = {
    name, sent: [], disconnected: false, sender,
    postMessage(m) { if (p.disconnected) throw new Error('Attempting to use a disconnected port object'); p.sent.push(m); },
    disconnect() { p.disconnected = true; },
    onDisconnect: { addListener: fn => { onDis.push(fn); } },
    onMessage: { addListener: fn => { onMsg.push(fn); } },
    fireDisconnect() { p.disconnected = true; for (const f of onDis) f(); },
    deliver(m) { for (const f of onMsg) f(m); },
  };
  return p;
}

function deps(opts: { lastError?: () => unknown; connectThrows?: () => Error | null } = {}) {
  const ports: FakePort[] = [];
  const lastError = vi.fn(opts.lastError ?? (() => undefined));
  return {
    ports, lastError,
    d: {
      connect: (name: string) => {
        const err = opts.connectThrows?.();
        if (err) throw err;
        const p = fakePort(name);
        ports.push(p);
        return p as unknown as chrome.runtime.Port;
      },
      lastError,
      setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimer: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    },
  };
}

beforeEach(() => { vi.useRealTimers(); });

describe('code search keep-alive', () => {
  it('opens the keep-alive port and pings about every 20 s until stopped', () => {
    vi.useFakeTimers();
    const { ports, d } = deps();
    const ka = startKeepAlive(d);
    expect(ports).toHaveLength(1);
    expect(ports[0].name).toBe(KEEPALIVE_PORT);
    expect(KEEPALIVE_PING_MS).toBeLessThan(30_000);
    vi.advanceTimersByTime(KEEPALIVE_PING_MS);
    vi.advanceTimersByTime(KEEPALIVE_PING_MS);
    expect(ports[0].sent).toHaveLength(2);
    ka.stop();
    expect(ports[0].disconnected).toBe(true);
    vi.advanceTimersByTime(KEEPALIVE_PING_MS * 3);
    expect(ports[0].sent).toHaveLength(2);
    expect(ports).toHaveLength(1);
  });

  it('reconnects after the worker was restarted, reading lastError', () => {
    vi.useFakeTimers();
    const { ports, d, lastError } = deps({ lastError: () => ({ message: 'Could not establish connection.' }) });
    startKeepAlive(d);
    ports[0].fireDisconnect();
    expect(lastError).toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(ports).toHaveLength(2);
    vi.advanceTimersByTime(KEEPALIVE_PING_MS);
    expect(ports[1].sent).toHaveLength(1);
  });

  it('retries a connect that throws while the worker starts', () => {
    vi.useFakeTimers();
    let fail = true;
    const { ports, d } = deps({ connectThrows: () => (fail ? new Error('worker starting') : null) });
    startKeepAlive(d);
    expect(ports).toHaveLength(0);
    fail = false;
    vi.advanceTimersByTime(1_000);
    expect(ports).toHaveLength(1);
  });

  it('ends quietly when the extension was reloaded', () => {
    vi.useFakeTimers();
    const { ports, d } = deps({ lastError: () => ({ message: 'Extension context invalidated.' }) });
    startKeepAlive(d);
    ports[0].fireDisconnect();
    vi.advanceTimersByTime(120_000);
    expect(ports).toHaveLength(1);
  });

  it('stops when the worker says it refuses the port', () => {
    vi.useFakeTimers();
    const { ports, d } = deps();
    startKeepAlive(d);
    ports[0].deliver({ type: KEEPALIVE_REFUSED });
    ports[0].fireDisconnect();
    vi.advanceTimersByTime(300_000);
    expect(ports).toHaveLength(1);
  });

  it('stops after a few disconnects in a row without a ping going through', () => {
    vi.useFakeTimers();
    const { ports, d } = deps();
    startKeepAlive(d);
    for (let i = 0; i < KEEPALIVE_MAX_DROPS + 3; i++) {
      ports.at(-1)!.fireDisconnect();
      // Long enough for the reconnect (backoff ≤ 8 s here), short of a ping.
      vi.advanceTimersByTime(KEEPALIVE_PING_MS - 2_000);
    }
    expect(ports).toHaveLength(KEEPALIVE_MAX_DROPS);
  });

  it('a ping that went through starts the count again', () => {
    vi.useFakeTimers();
    const { ports, d } = deps();
    startKeepAlive(d);
    for (let i = 0; i < KEEPALIVE_MAX_DROPS * 2; i++) {
      vi.advanceTimersByTime(KEEPALIVE_PING_MS);
      ports.at(-1)!.fireDisconnect();
      vi.advanceTimersByTime(1_000);
    }
    expect(ports).toHaveLength(KEEPALIVE_MAX_DROPS * 2 + 1);
  });

  it('a ping on a port that closed meanwhile reconnects instead of throwing', () => {
    vi.useFakeTimers();
    const { ports, d } = deps();
    startKeepAlive(d);
    ports[0].disconnected = true; // closed without an event yet
    expect(() => vi.advanceTimersByTime(KEEPALIVE_PING_MS)).not.toThrow();
    vi.advanceTimersByTime(1_000);
    expect(ports).toHaveLength(2);
  });
});

describe('keep-alive sender check', () => {
  beforeEach(() => {
    (globalThis as any).chrome = { runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}`, lastError: undefined } };
  });
  const page = (path: string, extra: Partial<chrome.runtime.MessageSender> = {}) =>
    ({ id: 'test', url: `chrome-extension://test/${path}`, ...extra }) as chrome.runtime.MessageSender;

  it('lets only the code search page hold the port', () => {
    expect(mayHoldKeepAlivePort(page('codesearch/codesearch.html', { tab: { id: 1 } as chrome.tabs.Tab, frameId: 3 }))).toBe(true);
    expect(mayHoldKeepAlivePort(page('codesearch/codesearch.html?x=1'))).toBe(true);
    expect(mayHoldKeepAlivePort(page('sidepanel/sidepanel.html'))).toBe(false);
    expect(mayHoldKeepAlivePort(page('objectview/window.html', { tab: { id: 1 } as chrome.tabs.Tab, frameId: 3 }))).toBe(false);
    // A content script: the extension's id, but the page's URL.
    expect(mayHoldKeepAlivePort({ id: 'test', url: 'https://bmp.test/Ws/codesearch/codesearch.html', tab: { id: 1 } as chrome.tabs.Tab })).toBe(false);
    expect(mayHoldKeepAlivePort({ id: 'other', url: 'chrome-extension://test/codesearch/codesearch.html' })).toBe(false);
    expect(mayHoldKeepAlivePort(undefined)).toBe(false);
  });

  it('the worker refuses and closes a port from any other sender', () => {
    const bad = fakePort(KEEPALIVE_PORT, page('sidepanel/sidepanel.html'));
    expect(acceptKeepAlivePort(bad as unknown as chrome.runtime.Port)).toBe(false);
    expect(bad.sent).toEqual([{ type: KEEPALIVE_REFUSED }]);
    expect(bad.disconnected).toBe(true);
    const good = fakePort(KEEPALIVE_PORT, page('codesearch/codesearch.html', { tab: { id: 1 } as chrome.tabs.Tab, frameId: 2 }));
    expect(acceptKeepAlivePort(good as unknown as chrome.runtime.Port)).toBe(true);
    expect(good.disconnected).toBe(false);
  });
});
