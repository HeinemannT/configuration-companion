/**
 * Keep the service worker running while a code search window is open.
 *
 * The code read for a search (code-scope-read `codeReadCache`) lives in the
 * worker's memory. Chrome stops an idle MV3 worker after about 30 s, and the
 * next search would read everything again. A code search window therefore
 * holds a long-lived port and sends a small ping about every 20 s; each
 * message counts as activity and resets the worker's idle timer. The worker
 * keeps no state for the pings. When the last window closes, its port
 * closes and nothing keeps the worker running.
 *
 * The open port also holds the change feed of the window's server profile
 * (code-feed.ts, resolved from the frame's tab): the worker polls it every
 * 15 s while a window of that profile holds its port, and stops when the
 * last one closes. No message on the port carries anything but the ping.
 *
 * Only the code search page may open this port (sender-trust
 * `mayHoldKeepAlivePort`); content scripts and the side panel never keep the
 * worker alive. The 20-minute idle eviction of the cache itself stays.
 */

import { mayHoldKeepAlivePort } from './sender-trust';

export const KEEPALIVE_PORT = 'codesearch-keepalive';
/** Below Chrome's 30 s idle limit, with room for a late timer. */
export const KEEPALIVE_PING_MS = 20_000;
const RETRY_FIRST_MS = 500;
/** Disconnects in a row without a ping that went through: then the page
 *  stops trying (a worker that keeps refusing, or no worker at all). */
export const KEEPALIVE_MAX_DROPS = 5;
/** What a worker that refuses the port posts before it disconnects. */
export const KEEPALIVE_REFUSED = 'KEEPALIVE_REFUSED';
const RETRY_MAX_MS = 30_000;

export interface KeepAlive {
  /** Close the port and stop pinging and reconnecting. */
  stop(): void;
}

interface KeepAliveDeps {
  connect(name: string): chrome.runtime.Port;
  lastError(): unknown;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(t: ReturnType<typeof setTimeout>): void;
}

const chromeDeps = (): KeepAliveDeps => ({
  connect: name => chrome.runtime.connect({ name }),
  lastError: () => chrome.runtime.lastError,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: t => clearTimeout(t),
});

const invalidated = (e: unknown) => /extension context invalidated/i.test(e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e ?? ''));

/** Open the keep-alive port and ping on it until `stop()`. A port that
 *  closes (the worker was restarted) is opened again after a short wait; an
 *  extension that was reloaded or removed ends it quietly, and so does a
 *  worker that says it refuses the port, or KEEPALIVE_MAX_DROPS
 *  disconnects in a row without one ping going through. */
export function startKeepAlive(deps: KeepAliveDeps = chromeDeps()): KeepAlive {
  let port: chrome.runtime.Port | null = null;
  let ping: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryMs = RETRY_FIRST_MS;
  let stopped = false;
  let drops = 0;

  const clear = () => {
    if (ping) { deps.clearTimer(ping); ping = null; }
    if (retry) { deps.clearTimer(retry); retry = null; }
  };
  const stop = () => {
    stopped = true;
    clear();
    const p = port;
    port = null;
    try { p?.disconnect(); } catch { /* already closed */ }
  };
  const again = () => {
    if (stopped || retry) return;
    retry = deps.setTimer(() => { retry = null; open(); }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };
  const schedulePing = () => {
    if (ping) deps.clearTimer(ping);
    ping = deps.setTimer(() => {
      ping = null;
      if (stopped || !port) return;
      try { port.postMessage({ type: 'PING' }); retryMs = RETRY_FIRST_MS; drops = 0; schedulePing(); }
      catch (e) {
        port = null;
        if (invalidated(e)) { stop(); return; }
        again();
      }
    }, KEEPALIVE_PING_MS);
  };
  function open(): void {
    if (stopped) return;
    let p: chrome.runtime.Port;
    try { p = deps.connect(KEEPALIVE_PORT); }
    catch (e) { if (invalidated(e)) stop(); else again(); return; }
    port = p;
    // The worker refuses this page: stop for good, no retry loop.
    p.onMessage?.addListener((m: unknown) => { if ((m as { type?: string } | null)?.type === KEEPALIVE_REFUSED) stop(); });
    p.onDisconnect.addListener(() => {
      // Reading lastError marks it as seen: no "Unchecked runtime.lastError".
      let err: unknown;
      try { err = deps.lastError(); } catch (e) { err = e; }
      if (port !== p) return;
      port = null;
      if (ping) { deps.clearTimer(ping); ping = null; }
      if (invalidated(err)) { stop(); return; }
      if (++drops >= KEEPALIVE_MAX_DROPS) { stop(); return; }
      again();
    });
    schedulePing();
  }

  open();
  return { stop };
}

/** Worker side: take a keep-alive port from the code search page and ignore
 *  its pings (the message itself is the activity); refuse any other sender.
 *  Returns whether the port was taken. Nothing is kept per port. */
export function acceptKeepAlivePort(port: chrome.runtime.Port, may: (s: chrome.runtime.MessageSender | undefined) => boolean = mayHoldKeepAlivePort): boolean {
  if (!may(port.sender)) {
    // Say so first: the page stops instead of reconnecting.
    try { port.postMessage({ type: KEEPALIVE_REFUSED }); } catch { /* already closed */ }
    try { port.disconnect(); } catch { /* already closed */ }
    return false;
  }
  port.onMessage.addListener(() => { /* a ping: receiving it is enough */ });
  // Read lastError so a closing window leaves no unchecked error behind.
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
  return true;
}
