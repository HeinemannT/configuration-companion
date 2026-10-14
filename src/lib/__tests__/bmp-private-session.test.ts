import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

const base = 'https://bmp.test/Workspace/';
const consumeText = (response: Response) => response.text();
type Listener = (details: chrome.webRequest.OnHeadersReceivedDetails) => unknown;
let listeners: Set<Listener>;
let rules: Map<number, chrome.declarativeNetRequest.Rule>;
let cookieHeaders: string[];
let requests: Array<{ url: string; cookie: string; init: RequestInit }>;

beforeEach(() => {
  vi.resetModules();
  mockChromeStorage();
  listeners = new Set();
  rules = new Map();
  cookieHeaders = [];
  requests = [];
  vi.mocked(chrome.webRequest.onHeadersReceived.addListener).mockImplementation(listener => { listeners.add(listener); });
  vi.mocked(chrome.webRequest.onHeadersReceived.removeListener).mockImplementation(listener => { listeners.delete(listener); });
  vi.mocked(chrome.declarativeNetRequest.getSessionRules as () => Promise<chrome.declarativeNetRequest.Rule[]>).mockImplementation(async () => [...rules.values()]);
  vi.mocked(chrome.declarativeNetRequest.updateSessionRules as (options: chrome.declarativeNetRequest.UpdateRuleOptions) => Promise<void>).mockImplementation(async options => {
    for (const id of options.removeRuleIds ?? []) rules.delete(id);
    for (const rule of options.addRules ?? []) rules.set(rule.id, rule);
  });
  globalThis.fetch = vi.fn(async (input, init = {}) => {
    const url = String(input);
    const match = [...rules.values()].find(r => new RegExp(r.condition.regexFilter!).test(url));
    requests.push({ url, cookie: match?.action.requestHeaders?.[0].value ?? '', init });
    for (const listener of listeners) listener({ url, initiator: 'chrome-extension://test',
      responseHeaders: cookieHeaders.map(value => ({ name: 'Set-Cookie', value })),
    } as chrome.webRequest.OnHeadersReceivedDetails);
    return new Response('ok');
  });
});

describe('private BMP HTTP sessions', () => {
  it('keeps malformed profiles constructible so the user can correct them', async () => {
    const { BmpPrivateSession } = await import('../bmp-private-session');
    const session = new BmpPrivateSession('https://bad host/');
    await expect(session.request(base, {}, consumeText)).rejects.toThrow('valid BMP workspace URL');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reuses its own cookie with a unique rule, never the browser cookie jar', async () => {
    const { BmpPrivateSession } = await import('../bmp-private-session');
    const session = new BmpPrivateSession(base);
    cookieHeaders = ['JSESSIONID=private; Path=/Workspace; HttpOnly; Secure'];
    await session.request(`${base}cs/login`, {}, consumeText);
    cookieHeaders = [];
    await session.request(`${base}cs/command?a=*`, { credentials: 'include', redirect: 'follow' }, consumeText);
    expect(requests.map(r => r.cookie)).toEqual(['', 'JSESSIONID=private']);
    expect(requests[1].init).toMatchObject({ credentials: 'omit', redirect: 'manual', cache: 'no-store' });
    const additions = vi.mocked(chrome.declarativeNetRequest.updateSessionRules).mock.calls
      .flatMap(([o]) => o.addRules ?? []);
    expect(additions[0].condition).toMatchObject({ initiatorDomains: ['test'], resourceTypes: ['xmlhttprequest'] });
    const pattern = new RegExp(additions[0].condition.regexFilter!);
    expect(pattern.test(requests[1].url + 'extra')).toBe(false);
    expect(pattern.test(requests[1].url.replace('bmp.test', 'bmpXtest'))).toBe(false);
    expect(pattern.test(requests[1].url.replace('a=*', 'a=anything'))).toBe(false);
    expect(rules.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it('honors cookie path, expiry, secure and domain rules', async () => {
    const { BmpPrivateSession } = await import('../bmp-private-session');
    const session = new BmpPrivateSession(base);
    cookieHeaders = ['session=first; Path=/Workspace', 'bad=other; Domain=evil.test',
      'gone=x; Max-Age=0', 'restricted=x; Path=/Workspace/other', 'secure=x; Secure; Path=/Workspace'];
    await session.request(`${base}cs/login`, {}, consumeText);
    cookieHeaders = ['session=second; Path=/Workspace', 'secure=; Max-Age=0; Path=/Workspace'];
    await session.request(`${base}cs/command`, {}, consumeText);
    expect(requests[1].cookie).toBe('session=first; secure=x');
    cookieHeaders = [];
    await session.request(`${base}cs/command`, {}, consumeText);
    expect(requests[2].cookie).toBe('session=second');
  });

  it('keeps profiles separate and restores a session without a new login', async () => {
    const { BmpPrivateSession } = await import('../bmp-private-session');
    const alice = new BmpPrivateSession(base);
    const bob = new BmpPrivateSession(base);
    cookieHeaders = ['session=alice; Path=/'];
    await alice.request(`${base}cs/login`, {}, consumeText);
    cookieHeaders = ['session=bob; Path=/'];
    await bob.request(`${base}cs/login`, {}, consumeText);
    cookieHeaders = [];
    const restored = new BmpPrivateSession(base);
    restored.restore(alice.snapshot());
    await Promise.all([restored.request(`${base}cs/command`, {}, consumeText), bob.request(`${base}cs/command`, {}, consumeText)]);
    expect(requests.slice(2).map(r => r.cookie).sort()).toEqual(['session=alice', 'session=bob']);
    alice.clear();
    await alice.request(`${base}cs/command`, {}, consumeText);
    expect(requests.at(-1)?.cookie).toBe('');
  });

  it('refuses sibling workspaces, other hosts and URL credentials before networking', async () => {
    const { BmpPrivateSession } = await import('../bmp-private-session');
    const session = new BmpPrivateSession(base);
    for (const url of ['https://bmp.test/Other/cs/login', 'https://bmp.test/Workspace2/cs/login',
      'https://else.test/Workspace/cs/login', 'https://u:p@bmp.test/Workspace/cs/login']) {
      await expect(session.request(url, {}, consumeText)).rejects.toThrow('outside its workspace');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('removes credentials and listeners after a failed request', async () => {
    const { BmpPrivateSession } = await import('../bmp-private-session');
    const session = new BmpPrivateSession(base);
    cookieHeaders = ['session=private; Path=/'];
    await session.request(`${base}cs/login`, {}, consumeText);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network'));
    await expect(session.request(`${base}cs/command`, {}, consumeText)).rejects.toThrow('network');
    expect(rules.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it('does not send a request if logout happens while its rule is being installed', async () => {
    const { BmpPrivateSession } = await import('../bmp-private-session');
    const session = new BmpPrivateSession(base);
    cookieHeaders = ['session=private; Path=/'];
    await session.request(`${base}cs/login`, {}, consumeText);
    let finish!: () => void;
    vi.mocked(chrome.declarativeNetRequest.updateSessionRules as (options: chrome.declarativeNetRequest.UpdateRuleOptions) => Promise<void>).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = session.request(`${base}cs/command`, {}, consumeText);
    await vi.waitFor(() => expect(finish).toBeDefined());
    session.clear();
    finish();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    expect(session.snapshot().cookies).toEqual([]);
  });

  it('cleans abandoned rules on worker start without touching other extension rules', async () => {
    rules.set(1700000001, { id: 1700000001 } as chrome.declarativeNetRequest.Rule);
    rules.set(123, { id: 123 } as chrome.declarativeNetRequest.Rule);
    const { clearAbandonedPrivateSessionRules } = await import('../bmp-private-session');
    await Promise.all([clearAbandonedPrivateSessionRules(), clearAbandonedPrivateSessionRules()]);
    expect([...rules.keys()]).toEqual([123]);
    expect(chrome.declarativeNetRequest.getSessionRules).toHaveBeenCalledTimes(1);
  });

  it('keeps the body cancellable after headers arrive and removes the temporary rule', async () => {
    const { BmpPrivateSession } = await import('../bmp-private-session');
    const session = new BmpPrivateSession(base);
    cookieHeaders = ['session=private; Path=/'];
    await session.request(`${base}cs/login`, {}, consumeText);
    let started = false;
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
      const response = new Response('pending');
      vi.spyOn(response, 'text').mockImplementation(() => new Promise((_resolve, reject) => {
        started = true;
        init!.signal!.addEventListener('abort', () => reject(new DOMException('Session cleared', 'AbortError')), { once: true });
      }));
      return response;
    });
    const pending = session.request(`${base}cs/command`, {}, consumeText).catch(error => error);
    await vi.waitFor(() => expect(started).toBe(true));
    expect(rules.size).toBe(1);
    session.clear();
    await expect(pending).resolves.toMatchObject({ name: 'AbortError' });
    expect(rules.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it('fails closed when private-session support is unavailable', async () => {
    const { BmpPrivateSession } = await import('../bmp-private-session');
    delete (chrome as unknown as Record<string, unknown>).webRequest;
    await expect(new BmpPrivateSession(base).request(`${base}cs/login`, {}, consumeText)).rejects.toThrow('Reload Companion');
    expect(fetch).not.toHaveBeenCalled();
  });
});
