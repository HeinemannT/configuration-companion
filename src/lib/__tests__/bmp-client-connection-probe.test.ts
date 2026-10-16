import { afterEach, describe, expect, it, vi } from 'vitest';
import { BmpClient } from '../bmp-client';
import { AUTH_TIMEOUT } from '../constants';
import { mockChromeStorage } from './chrome-mock';

afterEach(() => vi.unstubAllGlobals());

describe('BmpClient connection probe', () => {
  it('uses the short auth deadline instead of occupying the EC lane for 30 seconds', async () => {
    mockChromeStorage();
    const client = new BmpClient(
      'https://bmp.test/Workspace/',
      'admin',
      'pass',
      'profile',
      'stored',
    );
    client.applyVersionFlags('5.5.4.9');
    vi.spyOn((client as any).auth, 'getLoginTicket').mockResolvedValue('admin;STUDIO;1');
    const execute = vi.spyOn(client, 'executeEc').mockResolvedValue({ ok: true, log: '1' });

    await expect(client.testConnection()).resolves.toMatchObject({ ok: true, authenticated: true });
    expect(execute).toHaveBeenCalledWith('1', undefined, false, undefined, AUTH_TIMEOUT);
  });

  it.each([{}, { log: '' }, { log: 'Duration : 1ms' }, { log: '1', hasWarning: true }])(
    'does not mark an empty or unrecognized command reply connected: %j', async response => {
      mockChromeStorage();
      const client = new BmpClient('https://bmp.test/', 'admin', 'pass');
      vi.spyOn(client.auth, 'getLoginTicket').mockResolvedValue('admin;STUDIO;1');
      vi.spyOn(client, 'executeEc').mockResolvedValue({ ok: true, ...response });
      await expect(client.testConnection()).resolves.toMatchObject({ ok: false, authenticated: true });
    },
  );

  it('keeps an indeterminate capability failure out of the connected state', async () => {
    mockChromeStorage();
    const client = new BmpClient('https://bmp.test/', 'admin', 'pass');
    vi.spyOn(client.auth, 'getLoginTicket').mockResolvedValue('admin;STUDIO;1');
    vi.spyOn(client, 'executeEc')
      .mockResolvedValueOnce({ ok: true, log: '1\nDuration : 1ms' })
      .mockResolvedValueOnce({ ok: false, error: 'BMP command authentication expired' });
    await expect(client.testConnection()).resolves.toMatchObject({
      ok: false, message: 'BMP command authentication expired', authenticated: true,
    });
    expect(client.supportsLookup).toBeNull();
  });

  it('distinguishes authenticated, unavailable, and transient build-number outcomes', async () => {
    mockChromeStorage();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '5.6.10.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })));

    await expect(BmpClient.getBuildNumber('https://bmp.test/Workspace/'))
      .resolves.toEqual({ status: 'auth-required' });
    await expect(BmpClient.getBuildNumber('https://bmp.test/Workspace/'))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(BmpClient.getBuildNumber('https://bmp.test/Workspace/'))
      .resolves.toEqual({ status: 'transient' });
    await expect(BmpClient.getBuildNumber('https://bmp.test/Workspace/'))
      .resolves.toEqual({ status: 'known', version: '5.6.10.0' });
  });

  it.each(['unknown', '12345', '', 'Corporater BMP'])('does not treat unparseable version %j as modern', async version => {
    mockChromeStorage();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ version }))));
    await expect(BmpClient.getBuildNumber('https://bmp.test/'))
      .resolves.toEqual({ status: 'unavailable' });
  });
});
