/** An HTTP cookie jar owned by one command identity, never by a browser tab.
 *
 * Fetch cannot set Cookie or read Set-Cookie. MV3 supplies those two operations
 * through narrowly scoped, temporary DNR rules and a read-only webRequest listener.
 * Browser cookies are neither read nor written. Only the worker uses this module.
 */
import { CookieJar, type SerializedCookieJar } from 'tough-cookie';
import { assertHostAccess } from './site-access';
import { log } from './logger';

const RULE_START = 1_700_000_000;
const RULE_END = RULE_START + 10_000;
let nextRule = RULE_START;
let rulesReady: Promise<void> | undefined;

export class PrivateSessionError extends Error {}

/** A worker may have stopped between adding and removing a session rule. Its
 * nonce makes it inert, but remove it so it cannot retain session material. */
export function clearAbandonedPrivateSessionRules(): Promise<void> {
  if (!rulesReady) {
    rulesReady = (async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      const ids = rules.filter(r => r.id >= RULE_START && r.id < RULE_END).map(r => r.id);
      if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    })().catch(error => { rulesReady = undefined; throw error; });
  }
  return rulesReady;
}

export class BmpPrivateSession {
  private jar = new CookieJar();
  private active = new Set<AbortController>();
  private epoch = 0;
  private cookieRevision = 0;
  private readonly workspace: URL | null;

  constructor(workspaceUrl: string) {
    // A malformed saved profile must remain editable; reject it on use rather
    // than crashing the worker while it constructs its profile clients.
    try {
      this.workspace = new URL(workspaceUrl);
      if (!this.workspace.pathname.endsWith('/')) this.workspace.pathname += '/';
    } catch { this.workspace = null; }
  }

  clear(): void {
    this.epoch++;
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.jar = new CookieJar();
    this.cookieRevision++;
  }

  get revision(): number { return this.cookieRevision; }

  snapshot(): SerializedCookieJar {
    return this.jar.serializeSync()!;
  }

  restore(snapshot: SerializedCookieJar): void {
    this.clear();
    this.jar = CookieJar.deserializeSync(snapshot);
  }

  /** Keep cancellation and session ownership until the response is consumed,
   * not merely until fetch resolves its headers. */
  async request<T>(input: string | URL, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    if (!this.workspace) throw new PrivateSessionError('Enter a valid BMP workspace URL in Connect.');
    const url = new URL(input);
    if (url.origin !== this.workspace.origin || !url.pathname.startsWith(this.workspace.pathname)
      || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
      throw new PrivateSessionError('Private BMP session request is outside its workspace.');
    }
    const epoch = this.epoch;
    await assertHostAccess(url.href);
    if (!chrome.webRequest?.onHeadersReceived || !chrome.declarativeNetRequest) {
      throw new PrivateSessionError('Private BMP sessions are unavailable. Reload Companion after updating the extension.');
    }
    await clearAbandonedPrivateSessionRules();
    if (epoch !== this.epoch) throw new DOMException('Session cleared', 'AbortError');
    init.signal?.throwIfAborted();

    // A fresh URL makes every rule exclusive to this one extension request.
    url.hash = '';
    url.searchParams.set('__crev_session', crypto.randomUUID());
    const requestUrl = url.href;
    const cookie = this.jar.getCookieStringSync(requestUrl);
    const ruleId = nextRule++;
    if (nextRule >= RULE_END) nextRule = RULE_START;
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    this.active.add(controller);
    const capture = (details: chrome.webRequest.OnHeadersReceivedDetails): undefined => {
      if (epoch !== this.epoch || details.url !== requestUrl
        || details.initiator !== `chrome-extension://${chrome.runtime.id}`) return;
      for (const header of details.responseHeaders ?? []) {
        if (header.name.toLowerCase() !== 'set-cookie' || !header.value || header.value.length > 4096) continue;
        // RFC domain/path/expiry/secure handling belongs to a cookie implementation.
        // An invalid cookie must not turn a completed write into a transport failure.
        if (this.jar.setCookieSync(header.value, requestUrl, { ignoreError: true })) this.cookieRevision++;
      }
      return undefined;
    };
    let ruleInstalled = false;
    let listening = false;
    try {
      chrome.webRequest.onHeadersReceived.addListener(capture,
        { urls: [`${url.origin}/*`], types: ['xmlhttprequest'] }, ['responseHeaders', 'extraHeaders']);
      listening = true;
      if (cookie) {
        await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{
          id: ruleId, priority: 1,
          action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: [{ header: 'Cookie', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: cookie }] },
          condition: {
            regexFilter: `^${requestUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            isUrlFilterCaseSensitive: true,
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
          },
        }] });
        ruleInstalled = true;
      }
      signal.throwIfAborted();
      const response = await fetch(requestUrl, {
        ...init, signal, credentials: 'omit', redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      const result = await consume(response);
      signal.throwIfAborted();
      return result;
    } finally {
      this.active.delete(controller);
      if (listening) chrome.webRequest.onHeadersReceived.removeListener(capture);
      if (ruleInstalled) {
        // Cleanup failure must not hide a successful write and invite a replay.
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] })
          .catch(error => log.swallow('auth:removePrivateRule', error));
      }
    }
  }
}
