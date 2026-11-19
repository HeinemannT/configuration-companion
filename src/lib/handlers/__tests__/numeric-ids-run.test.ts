/**
 * NUMERIC_IDS_RUN: the IDs of up to 20 objects changed on the window's own
 * workspace. A committed run only with `confirmed`, only from a window, only
 * for items that are valid IDs, RIDs and spaces; the user's script kind; a
 * warning is an error; a committed run is never aborted once it started.
 */
import { describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../../types';

const SOURCE = 'p1@https://bmp.example.test/Work/';

type Exec = (code: string, rid: string | undefined, transactional: boolean, signal?: AbortSignal, timeoutMs?: number) => Promise<{ ok: boolean; log?: string; error?: string; hasWarning?: boolean; outcomeUnknown?: boolean }>;

async function harness(over: { exec?: Exec; display?: string } = {}) {
  vi.resetModules();
  const exec = vi.fn<Exec>(over.exec ?? (async () => ({ ok: true, log: 'answer' })));
  const logged: unknown[] = [];
  const profiles = [{ id: 'p1', label: 'Work', bmpUrl: 'https://bmp.example.test/Work/' }];
  const ctx = { profileId: 'p1', client: { serverUrl: 'https://bmp.example.test/Work/', executeEc: exec }, settings: { activeProfileId: 'p1', profiles }, logActivity: (...a: unknown[]) => { logged.push(a); } };
  vi.doMock('../../connection', () => ({ computeConnectionState: () => ({ display: over.display ?? 'connected' }) }));
  const { setSwContext } = await import('../../sw-context');
  setSwContext({ client: null, settings: { activeProfileId: 'p1', profiles }, settingsReady: Promise.resolve(), scopeFor: () => null } as never);
  await import('../transport');
  const { getHandler } = await import('../../handler-registry');
  return {
    exec, logged,
    handle: (msg: Record<string, unknown>, senderKind: 'frame' | 'content' = 'frame') => new Promise<Record<string, unknown>>(resolve => {
      void getHandler(msg.type as string)!(msg as never, (r: InspectorMessage) => resolve(r as never), { ctx: ctx as never, senderKind, isOneShot: true });
    }),
  };
}

const item = (n: number, over: Record<string, unknown> = {}) => ({ rid: `90071992547409${String(n).padStart(2, '0')}`, space: 't', className: 'ActionButton', name: 'x', from: String(5000 + n), to: `btn_${n}`, ...over });
const run = (over: Record<string, unknown> = {}) => ({ type: 'NUMERIC_IDS_RUN', requestId: 'n1', environment: SOURCE, items: [item(1), item(2)], transactional: false, ...over });

describe('NUMERIC_IDS_RUN', () => {
  it('runs a preview as the user\'s script, in the server\'s queue, and answers with the log', async () => {
    const h = await harness();
    const { classifyScript } = await import('../../script-kinds');
    expect(await h.handle(run())).toMatchObject({ type: 'NUMERIC_IDS_RUN_RESULT', requestId: 'n1', ok: true, log: 'answer' });
    const [code, rid, transactional, signal] = h.exec.mock.calls[0];
    expect([rid, transactional, signal instanceof AbortSignal]).toEqual([undefined, false, true]);
    expect(classifyScript(code).kind).toBe('user');
    expect(code).toContain('.change(id := "btn_1")');
    expect(h.logged).toHaveLength(0);
  });

  it('refuses a committed run that was not confirmed, and every other bad question, before anything is sent', async () => {
    const h = await harness();
    expect(await h.handle(run({ transactional: true }))).toMatchObject({ ok: false, refused: true, error: 'IDs change only after the change was confirmed.' });
    expect(await h.handle(run({ transactional: true, confirmed: 'yes' }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ transactional: 'true', confirmed: true }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ items: [] }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ items: Array.from({ length: 21 }, (_, i) => item(i + 1)) }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ items: [item(1, { to: 'bad id' })] }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ items: [item(1, { to: 'a") DELETE' })] }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ items: [item(1, { rid: '12a' })] }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ items: [item(1, { space: 'T.x' })] }))).toMatchObject({ refused: true });
    expect(await h.handle(run(), 'content')).toMatchObject({ refused: true });
    expect(await h.handle(run({ environment: 'p9@https://x.test/' }))).toMatchObject({ refused: true });
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('refuses a committed run while the connection is not confirmed', async () => {
    const h = await harness({ display: 'needs-login' });
    expect(await h.handle(run({ transactional: true, confirmed: true }))).toMatchObject({ refused: true });
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('commits a confirmed run without a signal and logs it', async () => {
    const h = await harness();
    expect(await h.handle(run({ transactional: true, confirmed: true }))).toMatchObject({ ok: true });
    const [, , transactional, signal, timeout] = h.exec.mock.calls[0];
    expect([transactional, signal, timeout]).toEqual([true, undefined, 120_000]);
    expect(h.logged).toHaveLength(1);
  });

  it('turns a warning into an error, and a lost answer of a commit into "may have been applied"', async () => {
    const warn = await harness({ exec: async () => ({ ok: true, hasWarning: true, log: 'Missing value for x' }) });
    expect(await warn.handle(run())).toMatchObject({ ok: false, error: expect.stringContaining('warning') });
    const lost = await harness({ exec: async () => ({ ok: false, error: 'timeout', outcomeUnknown: true }) });
    expect(await lost.handle(run({ transactional: true, confirmed: true }))).toMatchObject({ ok: false, outcomeUnknown: true });
    const thrown = await harness({ exec: async () => { throw new Error('connection lost'); } });
    expect(await thrown.handle(run({ transactional: true, confirmed: true }))).toMatchObject({ ok: false, outcomeUnknown: true, error: 'connection lost' });
  });
});
