/**
 * Messages between a Companion window (an extension page embedded in a BMP
 * page) and the content script of the page around it.
 *
 * The window posts only to the exact origin of its parent page and accepts
 * only messages from that parent window and origin. Object names (the frame
 * title) go to the parent only when that page belongs to a server Companion
 * is set up for: a foreign site that embeds a Companion page learns nothing.
 *
 * Chrome and Edge always provide `location.ancestorOrigins`; only test DOMs
 * lack it, and there the parent window check alone applies.
 */

function ancestorOrigins(): DOMStringList | undefined {
  try { return (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins; } catch { return undefined; }
}

/** The parent page's origin, or null when it is not an http(s) page. */
export function parentOrigin(): string | null {
  const list = ancestorOrigins();
  if (!list) return '*';
  const origin = list.length ? list[0] : '';
  return /^https?:\/\//.test(origin) ? origin : null;
}

/** Post to the parent page, at its exact origin. */
export function postToParent(msg: unknown): void {
  const origin = parentOrigin();
  if (!origin) return;
  try { window.parent.postMessage(msg, origin); } catch { /* parent gone */ }
}

/** A message from the parent page (its window and its origin). */
export function fromParent(e: MessageEvent): boolean {
  if (e.source !== window.parent) return false;
  const origin = parentOrigin();
  return origin === '*' || (!!origin && e.origin === origin);
}

let serverParent: Promise<boolean> | null = null;

/** Whether the parent page belongs to a server Companion is set up for: the
 *  worker resolves this window to that page's profile, and the profile's
 *  server has the parent's origin. */
export function parentIsServer(): Promise<boolean> {
  serverParent ??= (async () => {
    const origin = parentOrigin();
    if (!origin) return false;
    if (origin === '*') return true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' }) as { type?: string; state?: { environment?: string } } | undefined;
      const env = res?.type === 'CONNECTION_STATE' ? res.state?.environment ?? '' : '';
      const server = env.slice(env.indexOf('@') + 1);
      return !!server && new URL(server).origin === origin;
    } catch {
      return false;
    }
  })();
  return serverParent;
}

/** Tell the parent page the window's title (it names an object): only to a
 *  server page. */
export function postTitleToParent(label: string): void {
  void parentIsServer().then(ok => { if (ok) postToParent({ type: 'CREV_FRAME_TITLE', label }); });
}
