/**
 * Explicit command-auth strategies. There is no runtime fallback: portal mode
 * never submits a password and stored mode never touches /cs/authentication.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { JavaEnum, JavaWriter, type JavaClassDesc } from '../java-serial';
import { registerBmpTypes } from '../bmp-types';
import { BmpTransport } from '../bmp-transport';

const enumDesc = (name: string): JavaClassDesc => ({
  name,
  uid: 0n,
  flags: 0x12,
  fields: [],
  parent: null,
});

function directTicketBytes(user = 'config.user'): Uint8Array {
  registerBmpTypes();
  const writer = new JavaWriter();
  writer.writeStreamHeader();
  writer.writeObject({
    $type: 'com.corporater.bmp.base.system.auth.LoginTicket',
    key: 9223372036854775707n,
    clientUserAgent: new JavaEnum(enumDesc('com.corporater.bmp.base.system.auth.ClientUserAgent'), 'STUDIO'),
    onBehalfOfId: user,
    onBehalfOfType: new JavaEnum(enumDesc('com.corporater.bmp.base.system.auth.OnBehalfOfType'), 'USER'),
    principalId: user,
    principalType: new JavaEnum(enumDesc('com.corporater.bmp.base.system.auth.PrincipalType'), 'USER'),
  });
  return writer.toBytes();
}

beforeEach(() => {
  mockChromeStorage();
  vi.restoreAllMocks();
});

describe('BmpAuth explicit strategies', () => {
  it.each(['html', 'redirect'] as const)('pauses queued stored commands after a gateway %s response', async kind => {
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'user', 'secret', `gateway-${kind}`, 'stored');
    const bytes = directTicketBytes('user');
    globalThis.fetch = vi.fn(async input => String(input).includes('/cs/login?')
      ? new Response(bytes as Uint8Array<ArrayBuffer>)
      : kind === 'html' ? new Response('<html>sign in</html>', { headers: { 'Content-Type': 'text/html' } })
        : new Response(null, { status: 302, headers: { Location: 'https://sso.test/' } }));
    const transport = new BmpTransport('https://bmp.test/', auth);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => transport.sendRequest(new Uint8Array([1]), 1000, 'read')));
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2); // one login and one command, no background retry storm
    await auth.retryAuthentication();
    await expect(transport.sendRequest(new Uint8Array([1]), 1000, 'read')).rejects.toMatchObject({ kind: 'auth' });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each(['stored', 'portal'] as const)('discards late %s bodies and queued writes after logout', async mode => {
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'user', 'secret', `late-body-${mode}`, mode);
    const bytes = directTicketBytes('user');
    let finishBody!: (body: ArrayBuffer) => void;
    globalThis.fetch = vi.fn(async input => {
      const url = String(input);
      if (url.includes('/cs/login?')) return new Response(bytes as Uint8Array<ArrayBuffer>);
      if (url.endsWith('graphql')) return new Response(JSON.stringify({ data: { authorizationCode: { code: 'code' } } }));
      if (url.endsWith('cstoken')) return new Response(JSON.stringify({ accessToken: 'jwt', refreshToken: 'refresh' }));
      if (url.endsWith('ticket')) return new Response('user;STUDIO;42');
      const response = new Response('result');
      // Simulate a response whose headers arrived, but whose body is still downloading.
      vi.spyOn(response, 'arrayBuffer').mockImplementation(() => new Promise(resolve => { finishBody = resolve; }));
      return response;
    });
    const transport = new BmpTransport('https://bmp.test/', auth);
    const pending = transport.sendRequest(new Uint8Array([1]), 1000, 'read').catch(error => error);
    const queued = transport.sendRequest(new Uint8Array([2]), 1000, 'write').catch(error => error);
    await vi.waitFor(() => expect(finishBody).toBeDefined());
    auth.logout();
    finishBody(new ArrayBuffer(1));
    await expect(pending).resolves.toMatchObject({ kind: 'auth', message: expect.stringContaining('superseded') });
    await expect(queued).resolves.toMatchObject({ attempts: 0, message: expect.stringContaining('superseded') });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/cs/command?'))).toHaveLength(1);
    expect(auth.commandUser).toBeNull();
  });

  it.each(['read', 'write'] as const)('keeps %s command recovery bounded across queued requests', async intent => {
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'user', 'secret', 'blocked-command', 'stored');
    const bytes = directTicketBytes('user');
    globalThis.fetch = vi.fn(async input => String(input).includes('/cs/login?')
      ? new Response(bytes as Uint8Array<ArrayBuffer>) : new Response('', { status: 401 }));
    const transport = new BmpTransport('https://bmp.test/', auth);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => transport.sendRequest(new Uint8Array([1]), 1000, intent)));
    expect(results.every(r => r.status === 'rejected')).toBe(true);
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls.filter(url => url.includes('/cs/login?'))).toHaveLength(intent === 'read' ? 2 : 1);
    expect(urls.filter(url => url.includes('/cs/command?'))).toHaveLength(intent === 'read' ? 2 : 1);
  });

  it('sends the portal bearer on commands without browser cookies', async () => {
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', '', '', 'portal-command', 'portal');
    globalThis.fetch = vi.fn(async input => {
      if (String(input).endsWith('graphql')) return new Response(JSON.stringify({ data: { authorizationCode: { code: 'code' } } }));
      if (String(input).endsWith('cstoken')) return new Response(JSON.stringify({ accessToken: 'jwt-private', refreshToken: 'rt' }));
      return new Response('user;STUDIO;42');
    });
    const ticket = await auth.getLoginTicket();
    await auth.fetchCommand(ticket, { method: 'POST', body: 'command' }, response => response.text());
    const [, options] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer jwt-private');
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'manual' });
  });

  it('stops rejected stored login retries until an explicit reconnect', async () => {
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'user', 'wrong', 'rejected', 'stored');
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 }));
    await expect(auth.getLoginTicket()).rejects.toMatchObject({ code: 'auth-failed' });
    await expect(auth.getLoginTicket()).rejects.toMatchObject({ code: 'auth-failed' });
    await expect(auth.refreshLoginTicket()).rejects.toMatchObject({ code: 'auth-failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await auth.retryAuthentication();
    await expect(auth.getLoginTicket()).rejects.toMatchObject({ code: 'auth-failed' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('allows recovery from a temporary network failure without resubmitting a rejected password', async () => {
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'user', 'secret', 'network', 'stored');
    const bytes = directTicketBytes('user');
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(bytes as Uint8Array<ArrayBuffer>));
    await expect(auth.getLoginTicket()).rejects.toThrow('could not reach BMP');
    expect(await auth.getLoginTicket()).toContain('user;STUDIO;');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps rejected credentials paused after a worker restart until explicit reconnect', async () => {
    const { BmpAuth, commandAuthSessionKey } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'user', 'wrong', 'persist-rejection', 'stored', 'revision');
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 }));
    await expect(auth.getLoginTicket()).rejects.toThrow('rejected');
    await vi.waitFor(async () => {
      expect((await chrome.storage.session.get(commandAuthSessionKey('persist-rejection')))[commandAuthSessionKey('persist-rejection')])
        .toMatchObject({ kind: 'rejected' });
    });
    const restarted = new BmpAuth('https://bmp.test/', 'user', 'wrong', 'persist-rejection', 'stored', 'revision');
    await expect(restarted.getLoginTicket()).rejects.toThrow('rejected');
    expect(fetch).toHaveBeenCalledTimes(1);
    // Reconnect works even before the replacement client has restored its session.
    const cold = new BmpAuth('https://bmp.test/', 'user', 'wrong', 'persist-rejection', 'stored', 'revision');
    await cold.retryAuthentication();
    await expect(cold.getLoginTicket()).rejects.toThrow('rejected');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not persist a temporary login service outage as a rejected account', async () => {
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'user', 'secret', 'outage', 'stored');
    const bytes = directTicketBytes('user');
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(bytes as Uint8Array<ArrayBuffer>));
    await expect(auth.getLoginTicket()).rejects.toMatchObject({ retryable: true });
    expect(await auth.getLoginTicket()).toContain('user;STUDIO;');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('orders old-client teardown before replacement session persistence', async () => {
    const { BmpAuth, commandAuthSessionKey } = await import('../bmp-auth');
    const bytes = directTicketBytes('user');
    globalThis.fetch = vi.fn(async () => new Response(bytes as Uint8Array<ArrayBuffer>));
    const realSet = chrome.storage.session.set.bind(chrome.storage.session);
    let finish!: () => void;
    vi.mocked(chrome.storage.session.set as (value: Record<string, unknown>) => Promise<void>).mockImplementationOnce(value => new Promise<void>(resolve => {
      finish = () => { void realSet(value).then(resolve); };
    }));
    const old = new BmpAuth('https://bmp.test/', 'user', 'old-password', 'replaced', 'stored', 'old');
    await old.getLoginTicket();
    await vi.waitFor(() => expect(finish).toBeDefined());
    old.logout();
    const replacement = new BmpAuth('https://bmp.test/', 'user', 'new-password', 'replaced', 'stored', 'new');
    await replacement.getLoginTicket();
    finish();
    await vi.waitFor(async () => {
      const saved = (await chrome.storage.session.get(commandAuthSessionKey('replaced')))[commandAuthSessionKey('replaced')] as
        { stamp: { revision: string }; cookies?: unknown } | undefined;
      expect(saved?.stamp.revision).toBe('new');
      expect(saved?.cookies).toBeDefined();
    });
  });

  it('does not restore an old ticket-only stored login envelope', async () => {
    const { BmpAuth, commandAuthSessionKey } = await import('../bmp-auth');
    await chrome.storage.session.set({ [commandAuthSessionKey('legacy')]: {
      version: 2, kind: 'direct-ticket', ticket: 'old;STUDIO;1', commandUser: 'old',
      stamp: { profileId: 'legacy', workspaceUrl: 'https://bmp.test/', mode: 'stored', username: 'user', revision: '' },
    } });
    const auth = new BmpAuth('https://bmp.test/', 'user', 'secret', 'legacy', 'stored');
    const bytes = directTicketBytes('user');
    globalThis.fetch = vi.fn(async () => new Response(bytes as Uint8Array<ArrayBuffer>));
    expect(await auth.getLoginTicket()).toContain('user;STUDIO;');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('will not adopt authentication from a different workspace or account', async () => {
    const { BmpAuth } = await import('../bmp-auth');
    const source = new BmpAuth('https://bmp.test/', 'user', 'secret', 'same', 'stored');
    const bytes = directTicketBytes('user');
    globalThis.fetch = vi.fn(async () => new Response(bytes as Uint8Array<ArrayBuffer>));
    await source.getLoginTicket();
    for (const target of [new BmpAuth('https://bmp.test/Other/', 'user', 'secret', 'same', 'stored'),
      new BmpAuth('https://bmp.test/', 'someoneElse', 'secret', 'same', 'stored')]) {
      target.absorbAuth(source);
      expect(target.commandUser).toBeNull();
    }
  });

  it('does not let a portal token exchange complete after logout', async () => {
    let releaseToken!: (response: Response) => void;
    const tokenResponse = new Promise<Response>(resolve => { releaseToken = resolve; });
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith('graphql')) return { ok: true, status: 200, redirected: false, url,
        json: async () => ({ data: { authorizationCode: { code: 'late-code' } } }) } as Response;
      if (url.endsWith('cstoken')) return tokenResponse;
      return new Response('late.user;STUDIO;42');
    });
    globalThis.fetch = fetchSpy;
    const { BmpAuth, commandAuthSessionKey } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', '', '', 'late-portal', 'portal');

    const pending = auth.getLoginTicket();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    auth.logout();
    releaseToken(new Response(JSON.stringify({ accessToken: 'late-jwt', refreshToken: 'late-rt' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));

    await expect(pending).rejects.toMatchObject({ code: 'auth-failed' });
    expect(auth.jwt).toBeNull();
    expect(auth.commandUser).toBeNull();
    await vi.waitFor(async () => {
      const stored = await chrome.storage.session.get(commandAuthSessionKey('late-portal'));
      expect(stored[commandAuthSessionKey('late-portal')]).toBeUndefined();
    });
  });

  it('does not let a stored direct login complete after logout', async () => {
    let releaseLogin!: (response: Response) => void;
    const loginResponse = new Promise<Response>(resolve => { releaseLogin = resolve; });
    globalThis.fetch = vi.fn(() => loginResponse);
    const { BmpAuth, commandAuthSessionKey } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'config.user', 'secret', 'late-stored', 'stored', 'rev-1');

    const pending = auth.getLoginTicket();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    auth.logout();
    const bytes = directTicketBytes('config.user');
    releaseLogin(new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));

    await expect(pending).rejects.toMatchObject({ code: 'auth-failed' });
    expect(auth.commandUser).toBeNull();
    await vi.waitFor(async () => {
      const stored = await chrome.storage.session.get(commandAuthSessionKey('late-stored'));
      expect(stored[commandAuthSessionKey('late-stored')]).toBeUndefined();
    });
  });

  it('portal mode borrows the browser session and never posts stored credentials', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith('graphql')) {
        return { ok: true, status: 200, redirected: false, url,
          json: async () => ({ data: { authorizationCode: { code: 'code-1' } } }) } as Response;
      }
      if (url.endsWith('cstoken')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'jwt-1', refreshToken: 'rt-1' }) } as Response;
      }
      if (url.endsWith('ticket')) return new Response('portal.user;STUDIO;42');
      return new Response('', { status: 404 });
    });
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'dormant', 'secret', 'p1', 'portal');

    expect(await auth.getLoginTicket()).toBe('portal.user;STUDIO;42');
    expect(auth.commandUser).toBe('portal.user');
    expect(fetchSpy.mock.calls.some(([url]) => url.toString().includes('cs/authentication'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => url.toString().includes('cs/login'))).toBe(false);
  });

  it('does not let a token redirect collapse dev.rico into rico authentication', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('graphql')) {
        return { ok: true, status: 200, redirected: false, url,
          json: async () => ({ data: { authorizationCode: { code: 'dev-code' } } }) } as Response;
      }
      expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store' });
      return {
        ok: true,
        status: 200,
        redirected: true,
        url: 'https://rico.dlh.de/rico/cstoken',
        json: async () => ({ accessToken: 'wrong-workspace-jwt' }),
      } as Response;
    });
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://dev.rico.dlh.de/rico/', '', '', 'dev-rico', 'portal');

    await expect(auth.getLoginTicket()).rejects.toMatchObject({
      code: 'exchange-failed',
      message: expect.stringContaining('configured workspace'),
    });
    expect(auth.jwt).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('persists the portal actor binding separately from the command principal', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith('graphql')) return { ok: true, status: 200, redirected: false, url,
        json: async () => ({ data: { authorizationCode: { code: 'code-1' } } }) } as Response;
      if (url.endsWith('cstoken')) return { ok: true, status: 200,
        json: async () => ({ accessToken: 'jwt-1', refreshToken: 'rt-1' }) } as Response;
      return new Response('admin;STUDIO;42');
    });
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', '', '', 'bound', 'portal');
    await auth.getLoginTicket();
    auth.bindPortalActor('3663406580886322153');
    await vi.waitFor(async () => {
      const stored = await chrome.storage.session.get('crev_command_auth_v2_bound');
      expect(stored.crev_command_auth_v2_bound).toMatchObject({ portalActor: '3663406580886322153' });
    });

    const restored = new BmpAuth('https://bmp.test/', '', '', 'bound', 'portal');
    await restored.restoreFromSession();
    expect(restored.commandUser).toBe('admin');
    expect(restored.portalActor).toBe('3663406580886322153');
    restored.logout();
    expect(restored.portalActor).toBeNull();
  });

  it('stored mode obtains a direct ticket with cookies omitted and never probes portal auth', async () => {
    const bytes = directTicketBytes();
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.credentials).toBe('omit');
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { status: 200 });
    });
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'config.user', 'secret', 'p2', 'stored', 'rev-1');

    expect(await auth.getLoginTicket()).toBe('config.user;STUDIO;9223372036854775707');
    expect(auth.commandUser).toBe('config.user');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0];
    const loginUrl = new URL(input.toString());
    expect(loginUrl.pathname).toBe('/cs/login');
    expect(loginUrl.searchParams.get('username')).toBe('config.user');
    expect(loginUrl.searchParams.get('password')).toBe('secret');
    expect(init?.body).toBeUndefined();
    expect(fetchSpy.mock.calls.some(([url]) => url.toString().includes('cs/authentication'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => url.toString().includes('graphql'))).toBe(false);
  });

  it('stored mode rejects HTML without falling back to the portal identity', async () => {
    const fetchSpy = vi.fn(async () => new Response('<html>login</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'config.user', 'wrong', 'p3', 'stored', 'rev-1');

    await expect(auth.getLoginTicket()).rejects.toMatchObject({ code: 'auth-failed' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('deduplicates direct login and restores only the matching credential revision', async () => {
    const bytes = directTicketBytes('config.user');
    const fetchSpy = vi.fn(async () =>
      new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const first = new BmpAuth('https://bmp.test/', 'config.user', 'secret', 'p5', 'stored', 'rev-1');

    const tickets = await Promise.all([
      first.getLoginTicket(),
      first.getLoginTicket(),
      first.getLoginTicket(),
    ]);
    expect(new Set(tickets)).toEqual(new Set(['config.user;STUDIO;9223372036854775707']));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const stored = await chrome.storage.session.get('crev_command_auth_v2_p5');
      expect(stored.crev_command_auth_v2_p5).toMatchObject({ kind: 'direct-ticket' });
    });

    const restored = new BmpAuth('https://bmp.test/', 'config.user', 'secret', 'p5', 'stored', 'rev-1');
    expect(await restored.getLoginTicket()).toBe(tickets[0]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const rotated = new BmpAuth('https://bmp.test/', 'config.user', 'new-secret', 'p5', 'stored', 'rev-2');
    expect(await rotated.getLoginTicket()).toBe(tickets[0]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('portal mode reports the browser-session problem instead of using dormant credentials', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 401,
      redirected: false,
      url: 'https://bmp.test/graphql',
    } as Response));
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'dormant', 'secret', 'p4', 'portal');

    await expect(auth.getLoginTicket()).rejects.toMatchObject({ code: 'needs-login' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('portal mode rejects a successful HTML ticket response', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith('graphql')) {
        return { ok: true, status: 200, redirected: false, url,
          json: async () => ({ data: { authorizationCode: { code: 'code-1' } } }) } as Response;
      }
      if (url.endsWith('cstoken')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'jwt-1' }) } as Response;
      }
      return new Response('<html>sign in</html>', { status: 200 });
    });
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', '', '', 'p6', 'portal');

    await expect(auth.getLoginTicket()).rejects.toMatchObject({
      code: 'exchange-failed',
      message: expect.stringContaining('invalid command ticket'),
    });
  });
});
