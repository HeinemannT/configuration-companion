/**
 * Every write names the server it was read from (lib/environment.ts). For
 * each write message, a write whose environment is another server, or that
 * names none on a profile-bound context, is refused before the client is
 * touched. The Studio writes have their own cases in
 * handlers-studio-writes.test.ts; the per-sender routing is in
 * multi-environment.test.ts.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { warmServiceWorkerGraph } from './warm-imports';
import type { InspectorMessage } from '../types';

warmServiceWorkerGraph(mockChromeStorage);

const SERVER = 'https://bmp.example.test/Ws/';
const HERE = `A@${SERVER}`;
const RID = '9007199254740993';

/** A client that records every method called on it. Only the fields the
 *  environment token and the connection checks read have values. */
function recordingClient() {
  const called: string[] = [];
  const fields: Record<string, unknown> = { serverUrl: SERVER, auth: { sessionEpoch: 1 }, supportsLookup: undefined };
  const client = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in fields) return fields[prop];
      if (prop === 'then') return undefined; // not a thenable
      return (...args: unknown[]) => { called.push(prop); void args; return Promise.resolve({ ok: true }); };
    },
  });
  return { client, called };
}

let getHandler: typeof import('../handler-registry').getHandler;
let ctx: Record<string, unknown>;
let called: string[];

beforeAll(async () => {
  vi.resetModules();
  mockChromeStorage();
  const rec = recordingClient();
  called = rec.called;
  ctx = {
    client: rec.client,
    settings: {
      activeProfileId: 'A',
      profiles: [
        { id: 'A', label: 'Server A', bmpUrl: SERVER, bmpUser: '', bmpPass: '', commandAuthMode: 'portal' },
        { id: 'B', label: 'Server B', bmpUrl: 'https://other.example.test/Ws/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' },
      ],
    },
    cache: { get: vi.fn(() => undefined), set: vi.fn(), delete: vi.fn() },
    settingsReady: Promise.resolve(),
    logActivity: vi.fn(), toast: vi.fn(), sendToPanel: vi.fn(), broadcastToContent: vi.fn(),
    panelPortByWindow: new Map(), contentPorts: new Map(),
  };
  (await import('../sw-context')).setSwContext(ctx as never);
  await import('../message-router');
  ({ getHandler } = await import('../handler-registry'));
  const { environmentToken } = await import('../environment');
  // The fixture's own token is the one the cases call "here".
  expect(environmentToken(ctx as never)).toBe(HERE);
}, 60_000);

/** Write messages and where each carries its environment. */
const WRITES: Array<{ type: string; key: 'environment' | 'env'; msg: Record<string, unknown> }> = [
  { type: 'EC_EXECUTE', key: 'environment', msg: { code: 'output("x")', transactional: true, objectRid: RID } },
  { type: 'SAVE_PROPERTY', key: 'environment', msg: { rid: RID, property: 'expression', value: 'x', objectType: 'TextElement' } },
  { type: 'SAVE_IDENTITY', key: 'environment', msg: { rid: RID, businessId: 'new_id', name: 'New name' } },
  { type: 'APPLY_OBJECT_CHANGES', key: 'environment', msg: { rid: RID, changes: [{ property: 'name', value: 'x' }] } },
  { type: 'LAYOUT_APPLY', key: 'env', msg: { ctx: { target: 'instance' }, ops: [] } },
  { type: 'ACCESS_WORKSPACE_REQUEST', key: 'environment', msg: { request: { operation: 'apply' } } },
];

async function send(type: string, msg: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const replies: Record<string, unknown>[] = [];
  await getHandler(type)!({ type, ...msg } as unknown as InspectorMessage, r => replies.push(r as unknown as Record<string, unknown>), { isOneShot: true, ctx: ctx as never });
  return replies;
}

describe('a write is refused unless it names this server', () => {
  it('lists only registered write types', () => {
    for (const w of WRITES) expect(getHandler(w.type), w.type).toBeTypeOf('function');
  });

  it.each(WRITES)('$type: another server’s environment is refused, nothing reaches the client', async ({ type, key, msg }) => {
    called.length = 0;
    const replies = await send(type, { ...msg, [key]: `B@https://other.example.test/Ws/` });
    expect(called).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ ok: false });
    expect(String(replies[0].error)).toMatch(/server|Nothing was (saved|written)/);
  });

  it.each(WRITES)('$type: the same server under another profile is refused too', async ({ type, key, msg }) => {
    called.length = 0;
    const replies = await send(type, { ...msg, [key]: `B@${SERVER}` });
    expect(called).toEqual([]);
    expect(replies[0]).toMatchObject({ ok: false });
  });

  // Controls: with this server's own token the guard lets the write through,
  // so the refusals above are the environment check and nothing else.
  it.each(WRITES)('$type: this server’s environment is not refused', async ({ type, key, msg }) => {
    const refusal = (await send(type, { ...msg, [key]: `B@${SERVER}` }))[0].error;
    const replies = await send(type, { ...msg, [key]: HERE }).catch(() => []);
    expect(replies[0]?.error).not.toBe(refusal);
  });

  it.each(WRITES.filter(w => ['EC_EXECUTE', 'SAVE_PROPERTY', 'SAVE_IDENTITY', 'APPLY_OBJECT_CHANGES'].includes(w.type)))('$type: this server’s environment reaches the client (the probe sees calls)', async ({ type, key, msg }) => {
    called.length = 0;
    await send(type, { ...msg, [key]: HERE }).catch(() => undefined);
    expect(called.length).toBeGreaterThan(0);
  });

  it.each(WRITES)('$type: no environment at all is refused on a profile-bound context', async ({ type, msg }) => {
    called.length = 0;
    const replies = await send(type, msg);
    expect(called).toEqual([]);
    expect(replies[0]).toMatchObject({ ok: false });
  });
});
