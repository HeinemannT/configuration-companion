/**
 * EC_SYNTAX_CHECK: the Replace tab parses a changed script on the server
 * without running it. The script goes in a branch that never runs, as the
 * user's own text; only this server's environment is answered; a failed
 * request is told apart from the server refusing the script.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { warmServiceWorkerGraph } from './warm-imports';
import type { InspectorMessage } from '../types';

warmServiceWorkerGraph(mockChromeStorage);

const SERVER = 'https://bmp.example.test/Ws/';
const HERE = `A@${SERVER}`;

let getHandler: typeof import('../handler-registry').getHandler;
let ctx: Record<string, unknown>;
const executeEc = vi.fn();

beforeAll(async () => {
  vi.resetModules();
  mockChromeStorage();
  ctx = {
    client: { serverUrl: SERVER, auth: { sessionEpoch: 1 }, supportsLookup: undefined, executeEc },
    settings: { activeProfileId: 'A', profiles: [{ id: 'A', label: 'Server A', bmpUrl: SERVER, bmpUser: '', bmpPass: '', commandAuthMode: 'portal' }] },
    cache: { get: vi.fn(() => undefined), set: vi.fn(), delete: vi.fn() },
    settingsReady: Promise.resolve(),
    logActivity: vi.fn(), toast: vi.fn(), sendToPanel: vi.fn(), broadcastToContent: vi.fn(),
    panelPortByWindow: new Map(), contentPorts: new Map(),
  };
  (await import('../sw-context')).setSwContext(ctx as never);
  await import('../message-router');
  ({ getHandler } = await import('../handler-registry'));
}, 60_000);

async function check(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const replies: Record<string, unknown>[] = [];
  await getHandler('EC_SYNTAX_CHECK')!({ type: 'EC_SYNTAX_CHECK', ...msg } as unknown as InspectorMessage, r => replies.push(r as unknown as Record<string, unknown>), { isOneShot: true, ctx: ctx as never });
  return replies[0];
}

describe('EC_SYNTAX_CHECK', () => {
  it('parses the script in a branch that never runs, as read-only', async () => {
    executeEc.mockResolvedValueOnce({ ok: true, log: 'parsed' });
    expect(await check({ code: '_a := 1\n_b := 2', environment: HERE })).toEqual({ type: 'EC_SYNTAX_RESULT', ok: true });
    expect(executeEc).toHaveBeenLastCalledWith('IF 1 = 2 THEN\n_a := 1\n_b := 2\nENDIF\n"parsed"', undefined, false);
  });

  it('says the server refused the script, with its message', async () => {
    executeEc.mockResolvedValueOnce({ ok: false, log: 'Encountered " "ENDIF" "ENDIF "" at line 5, column 1.' });
    expect(await check({ code: 'x', environment: HERE })).toEqual({ type: 'EC_SYNTAX_RESULT', ok: false, verdict: true, message: 'Encountered " "ENDIF" "ENDIF "" at line 5, column 1.' });
  });

  it('does not take a failed request for a verdict on the script', async () => {
    executeEc.mockResolvedValueOnce({ ok: false, error: 'Network error', errorKind: 'network' });
    expect(await check({ code: 'x', environment: HERE })).toMatchObject({ ok: false, verdict: false, message: 'Network error' });
  });

  it('answers nothing for another server', async () => {
    executeEc.mockClear();
    const r = await check({ code: 'x', environment: `B@${SERVER}` });
    expect(r).toMatchObject({ type: 'EC_SYNTAX_RESULT', ok: false });
    expect(executeEc).not.toHaveBeenCalled();
  });
});
