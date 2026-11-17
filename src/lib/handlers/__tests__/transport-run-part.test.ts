/**
 * TRANSPORT_TARGETS and TRANSPORT_RUN_PART: the other connected workspaces,
 * and one part run on one of them. A committed run only with `confirmed`,
 * never over the `user` script limit, never on the window's own workspace
 * or one that is not connected; preview and committed runs go to the
 * target's client in its queue; a committed run that started is not
 * aborted by a cancel.
 */
import { describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../../types';

const SOURCE = 'p1@https://bmp.example.test/Work/';
const TARGET = 'p2@https://bmp.example.test/Test/';

type Exec = (code: string, rid: string | undefined, transactional: boolean, signal?: AbortSignal, timeoutMs?: number) => Promise<{ ok: boolean; log?: string; error?: string; errorKind?: string; outcomeUnknown?: boolean }>;

interface Harness {
  handle(msg: Record<string, unknown>, senderKind?: 'frame' | 'content'): Promise<Record<string, unknown>>;
  exec: ReturnType<typeof vi.fn<Exec>>;
  display: { value: string };
  logged: unknown[];
}

async function harness(): Promise<Harness> {
  vi.resetModules();
  const exec = vi.fn<Exec>(async () => ({ ok: true, log: 'answer' }));
  const display = { value: 'connected' };
  const logged: unknown[] = [];
  const profiles = [
    { id: 'p1', label: 'Work', bmpUrl: 'https://bmp.example.test/Work/' },
    { id: 'p2', label: 'Test', bmpUrl: 'https://bmp.example.test/Test/' },
    { id: 'p3', label: 'Off', bmpUrl: 'https://off.example.test/' },
  ];
  const ctxFor = (id: string, url: string, executeEc: Exec | null) => ({
    profileId: id,
    client: executeEc ? { serverUrl: url, executeEc } : null,
    settings: { activeProfileId: id, profiles },
    logActivity: (...args: unknown[]) => { logged.push(args); },
  });
  const source = ctxFor('p1', 'https://bmp.example.test/Work/', vi.fn<Exec>(async () => ({ ok: true, log: 'source' })));
  const target = ctxFor('p2', 'https://bmp.example.test/Test/', exec);
  const off = ctxFor('p3', 'https://off.example.test/', null);
  vi.doMock('../../profile-scope', () => ({
    scopeFor: (id: string) => ({ p1: { ctx: source, ready: Promise.resolve() }, p2: { ctx: target, ready: Promise.resolve() }, p3: { ctx: off, ready: Promise.resolve() } } as Record<string, unknown>)[id] ?? null,
  }));
  vi.doMock('../../connection', () => ({ computeConnectionState: () => ({ display: display.value }) }));
  const { setSwContext } = await import('../../sw-context');
  setSwContext({ client: null, settings: { activeProfileId: 'p1', profiles }, settingsReady: Promise.resolve(), scopeFor: () => null } as never);
  await import('../transport');
  const { getHandler } = await import('../../handler-registry');
  return {
    exec, display, logged,
    handle: (msg, senderKind = 'frame') => new Promise(resolve => {
      void getHandler(msg.type as string)!(msg as never, (r: InspectorMessage) => resolve(r as never), { ctx: source as never, senderKind, isOneShot: true });
    }),
  };
}

const run = (over: Record<string, unknown> = {}) => ({ type: 'TRANSPORT_RUN_PART', requestId: 'r1', environment: SOURCE, target: TARGET, code: '_r := 1\n_r', transactional: false, ...over });

describe('TRANSPORT_TARGETS', () => {
  it('lists the other stored profiles whose connection is confirmed, with label and host', async () => {
    const h = await harness();
    expect(await h.handle({ type: 'TRANSPORT_TARGETS', requestId: 't1', environment: SOURCE })).toMatchObject({
      type: 'TRANSPORT_TARGETS_RESULT', ok: true, targets: [{ environment: TARGET, label: 'Test', host: 'bmp.example.test' }],
    });
    h.display.value = 'needs-login';
    expect(await h.handle({ type: 'TRANSPORT_TARGETS', requestId: 't2', environment: SOURCE })).toMatchObject({ ok: true, targets: [] });
    expect(await h.handle({ type: 'TRANSPORT_TARGETS', requestId: 't3', environment: SOURCE }, 'content')).toMatchObject({ ok: false, refused: true });
  });
});

describe('TRANSPORT_RUN_PART', () => {
  it('runs a preview on the target, marked as the user\'s script, and answers with its log', async () => {
    const h = await harness();
    const { classifyScript } = await import('../../script-kinds');
    const res = await h.handle(run());
    expect(res).toMatchObject({ type: 'TRANSPORT_PART_RESULT', requestId: 'r1', target: TARGET, ok: true, log: 'answer' });
    expect(h.exec).toHaveBeenCalledTimes(1);
    const [code, rid, transactional, signal] = h.exec.mock.calls[0];
    expect([code, rid, transactional, signal instanceof AbortSignal]).toEqual(['_r := 1\n_r', undefined, false, true]);
    expect(classifyScript(code).kind).toBe('user');
  });

  it('refuses a committed run without the confirmation of the apply', async () => {
    const h = await harness();
    expect(await h.handle(run({ transactional: true }))).toMatchObject({ ok: false, refused: true, error: 'A committed part runs only after the apply was confirmed.' });
    expect(await h.handle(run({ transactional: true, confirmed: 'yes' }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ transactional: 'true', confirmed: true }))).toMatchObject({ refused: true });
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('runs a confirmed committed part without a signal (never aborted) and logs it on the target', async () => {
    const h = await harness();
    const res = await h.handle(run({ transactional: true, confirmed: true }));
    expect(res).toMatchObject({ ok: true });
    const [, , transactional, signal, timeout] = h.exec.mock.calls[0];
    expect([transactional, signal, timeout]).toEqual([true, undefined, 120_000]);
    expect(h.logged).toHaveLength(1);
  });

  it('refuses a script over the user limit, an empty one, a page sender, the own workspace and one not connected', async () => {
    const h = await harness();
    expect(await h.handle(run({ code: 'x'.repeat(25_001) }))).toMatchObject({ refused: true, error: expect.stringContaining('over Companion\'s limit of 25000') });
    expect(await h.handle(run({ code: '  ' }))).toMatchObject({ refused: true });
    expect(await h.handle(run(), 'content')).toMatchObject({ refused: true });
    expect(await h.handle(run({ target: SOURCE }))).toMatchObject({ refused: true, error: 'Not another workspace.' });
    expect(await h.handle(run({ target: 'p3@https://off.example.test/' }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ target: 'p2@https://elsewhere.test/' }))).toMatchObject({ refused: true });
    expect(await h.handle(run({ environment: 'p9@https://x.test/' }))).toMatchObject({ refused: true });
    h.display.value = 'reconnecting';
    expect(await h.handle(run({ transactional: true, confirmed: true }))).toMatchObject({ refused: true });
    expect(h.exec).not.toHaveBeenCalled();
    // At the limit it is sent.
    h.display.value = 'connected';
    expect(await h.handle(run({ code: 'x'.repeat(25_000) }))).toMatchObject({ ok: true });
  });

  it('passes on a failure and an unknown outcome', async () => {
    const h = await harness();
    h.exec.mockResolvedValueOnce({ ok: false, error: 'EC execution timed out (120s)', errorKind: 'timeout', outcomeUnknown: true });
    expect(await h.handle(run({ transactional: true, confirmed: true }))).toMatchObject({ ok: false, error: 'EC execution timed out (120s)', errorKind: 'timeout', outcomeUnknown: true });
  });

  it('a cancel does not stop a committed part that runs, and keeps a queued one from starting', async () => {
    const h = await harness();
    let finish: (v: { ok: boolean; log: string }) => void = () => {};
    h.exec.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const first = h.handle(run({ requestId: 'a', transactional: true, confirmed: true }));
    const second = h.handle(run({ requestId: 'b', transactional: true, confirmed: true }));
    await new Promise(r => setTimeout(r, 0));
    void h.handle({ type: 'TRANSPORT_CANCEL', requestId: 'a' });
    void h.handle({ type: 'TRANSPORT_CANCEL', requestId: 'b' });
    finish({ ok: true, log: 'stored' });
    expect(await first).toMatchObject({ ok: true, log: 'stored' });
    expect(await second).toMatchObject({ ok: false, cancelled: true });
    expect(h.exec).toHaveBeenCalledTimes(1);
  });
});
