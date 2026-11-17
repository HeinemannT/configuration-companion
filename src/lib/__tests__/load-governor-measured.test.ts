/**
 * Read-only constant scripts are debited by measured time (load-governor
 * measuredScriptDebit): the code search's listing and reads follow the
 * server's speed. A slow or failing server sees the old cost, one per
 * command, at admission and after the answer; background work, full reads,
 * bytes and overload stops do not change. Also: the bucket's refill on a
 * clock set back, and the transport's wake timer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOVERNOR, LoadGovernor, measuredScriptDebit, type PostCost } from '../load-governor';
import { BmpTransport } from '../bmp-transport';
import { backgroundSignal } from '../request-class';
import { makeExtendedExecuteCommand, makeGetObjectCommand, registerBmpTypes } from '../bmp-types';
import { constantScript, varyingScript } from '../script-kinds';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

interface Post { commands: number; ms: number; kind: 'script' | 'index' }

/** One lane: each post waits what the governor says, starts, takes `ms`.
 *  `measured`: the scripts are marked read-only constant (the new rule);
 *  without it they count one per command (the old rule). */
function replay(posts: readonly Post[], opts: { measured: boolean; empty: boolean }) {
  const c = clock();
  const g = new LoadGovernor({ now: c.now });
  if (opts.empty) g.start('user', { commands: GOVERNOR.shared.commands.capacity, fullReads: 0 }, 0);
  let held = 0;
  let debited = 0;
  for (const p of posts) {
    const cost: PostCost = { commands: p.commands, fullReads: 0, ...(p.kind === 'index' ? { index: p.commands } : opts.measured ? { measured: p.commands } : {}) };
    for (let w = g.admit('user', cost); w > 0; w = g.admit('user', cost)) { c.advance(w); held += w; }
    g.start('user', cost, 0);
    c.advance(p.ms);
    debited += g.observe('user', cost, { ok: true, durationMs: p.ms, responseBytes: 2_000 });
  }
  return { held, debited, g, c };
}

/** The observed first search: a feed poll, 16 listing posts growing
 *  1, 2, 4, then 6, two timer polls, 9 read posts of 3 commands, a
 *  cross-check poll. `perCommandMs` per script command, 30 ms per poll. */
function observedRun(perCommandMs: number): Post[] {
  const poll: Post = { commands: 1, ms: 30, kind: 'index' };
  const listing = [1, 2, 4, ...Array.from({ length: 13 }, () => 6)].map(n => ({ commands: n, ms: perCommandMs * n, kind: 'script' as const }));
  const reads = Array.from({ length: 9 }, () => ({ commands: 3, ms: perCommandMs * 3, kind: 'script' as const }));
  return [poll, ...listing.slice(0, 8), poll, ...listing.slice(8), poll, ...reads, poll];
}

describe('read-only constant scripts are debited by measured time', () => {
  it('the rule: one per 200 ms of measured time, at least one, never more than one per command; continuous at 200 ms', () => {
    expect(measuredScriptDebit(6, 300)).toBe(2);
    expect(measuredScriptDebit(6, 10)).toBe(1);
    expect(measuredScriptDebit(1, 199)).toBe(1);
    expect(measuredScriptDebit(6, 1_199)).toBe(6);
    expect(measuredScriptDebit(6, 1_001)).toBe(6);
    expect(measuredScriptDebit(6, 1_000)).toBe(5);
    expect(measuredScriptDebit(6, 1_200)).toBe(6);
    expect(measuredScriptDebit(6, 30_000)).toBe(6);
  });

  it('never more load than the old rule: 1-20 commands, 10-400 ms per command', () => {
    // The old rule admits at most 4 commands a second; at 200 ms each that is 0.8 s of server time per second.
    // From 200 ms per command the new cost equals the old one, so the bound there is the old rule's own.
    const perSecond = GOVERNOR.shared.commands.perMinute / 60;
    const bound = (m: number) => perSecond * Math.max(GOVERNOR.measured.slowMsPerCommand, m);
    for (let k = 1; k <= 20; k++) {
      for (let m = 10; m <= 400; m += 5) {
        const cost = measuredScriptDebit(k, k * m);
        expect(cost).toBeLessThanOrEqual(k);
        // At the steady rate a post of `cost` tokens goes perMinute/60/cost times a second.
        const serverMsPerSecond = (GOVERNOR.shared.commands.perMinute / 60 / cost) * k * m;
        expect(serverMsPerSecond, `${k} x ${m} ms`).toBeLessThanOrEqual(bound(m) + 1e-9);
        if (m >= GOVERNOR.measured.slowMsPerCommand) expect(cost).toBe(k);
      }
    }
    // The same through the governor, from an empty bucket: server time over elapsed time.
    for (const k of [1, 3, 6, 20]) {
      for (const m of [10, 50, 150, 199, 200, 400]) {
        const run = replay(Array.from({ length: 40 }, () => ({ commands: k, ms: k * m, kind: 'script' as const })), { measured: true, empty: true });
        const fraction = (40 * k * m) / (run.c.now() - 1_000_000);
        expect(fraction, `${k} x ${m} ms`).toBeLessThanOrEqual(bound(m) / 1_000 + 1e-9);
      }
    }
  });

  it('replays the observed first search (25 posts at about 50 ms) from an empty bucket: held under 8 s, not 25 s', () => {
    const before = replay(observedRun(50 / 3), { measured: false, empty: true });
    const after = replay(observedRun(50 / 3), { measured: true, empty: true });
    // About 50 ms per post: 16.7 ms per command of a 3-command read, 8 ms per command of a 6-command group.
    expect(before.held).toBeGreaterThan(25_000);
    expect(after.held).toBeLessThan(8_000);
    expect(after.debited).toBeLessThan(before.debited);
    // At least one command per post: never faster than the steady rate's four posts a second.
    expect(after.debited).toBeGreaterThanOrEqual(observedRun(50).length);
  });

  it('a slow server (1 s per command) is held at least as long as before, and debited the same', () => {
    const before = replay(observedRun(1_000), { measured: false, empty: true });
    const after = replay(observedRun(1_000), { measured: true, empty: true });
    expect(after.held).toBeGreaterThanOrEqual(before.held);
    expect(after.debited).toBe(before.debited);
  });

  it('at 50, 200, 1,000 and 5,000 ms per command: cheaper only when fast; from 200 ms the same holds and debits as before', () => {
    for (const per of [50, 200, 1_000, 5_000]) {
      for (const empty of [true, false]) {
        const before = replay(observedRun(per), { measured: false, empty });
        const after = replay(observedRun(per), { measured: true, empty });
        expect(after.debited).toBeLessThanOrEqual(before.debited);
        if (per >= GOVERNOR.measured.slowMsPerCommand) {
          expect(after.debited, `${per} ms`).toBe(before.debited);
          expect(after.held, `${per} ms`).toBeGreaterThanOrEqual(before.held);
        } else {
          expect(after.debited).toBeLessThan(before.debited);
        }
      }
    }
  });

  it('a server that turns slow: the slow post is charged in full and the next one is admitted at the old cost', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    g.start('user', { commands: GOVERNOR.shared.commands.capacity, fullReads: 0 }, 0);
    const post = (ms: number) => {
      const cost: PostCost = { commands: 6, fullReads: 0, measured: 6 };
      let held = 0;
      for (let w = g.admit('user', cost); w > 0; w = g.admit('user', cost)) { c.advance(w); held += w; }
      g.start('user', cost, 0);
      c.advance(ms);
      return { held, debit: g.observe('user', cost, { ok: true, durationMs: ms, responseBytes: 100 }) };
    };
    for (let i = 0; i < 5; i++) post(60);
    expect(post(6_000).debit).toBe(6);
    // The next such post is admitted at the old cost: it waits for six
    // commands, five more (1.25 s) than a one-command post.
    g.start('user', { commands: GOVERNOR.shared.commands.capacity, fullReads: 0 }, 0);
    const w6 = g.admit('user', { commands: 6, fullReads: 0, measured: 6 });
    const w1 = g.admit('user', { commands: 1, fullReads: 0 });
    expect(w6 - w1).toBeGreaterThanOrEqual(1_249);
    expect(post(60).debit).toBe(1);
    // A failure: the old cost, and the next post starts at it.
    const failed: PostCost = { commands: 6, fullReads: 0, measured: 6 };
    g.start('user', failed, 0);
    expect(g.observe('user', failed, { ok: false, durationMs: 20, responseBytes: 0 })).toBe(6);
    // Bucket near empty now: the next post must wait for six commands, not one.
    const h = new LoadGovernor({ now: c.now });
    h.start('user', { commands: GOVERNOR.shared.commands.capacity, fullReads: 0 }, 0);
    const bad: PostCost = { commands: 6, fullReads: 0, measured: 6 };
    h.start('user', bad, 0);
    h.observe('user', bad, { ok: false, durationMs: 20, responseBytes: 0 });
    c.advance(10_000); // 40 commands refilled, the debt was 6
    expect(h.admit('user', { commands: 6, fullReads: 0, measured: 6 })).toBe(0);
    expect(h.admit('user', { commands: 40, fullReads: 0, measured: 40 })).toBeGreaterThan(0);
  });

  it('a refund never lifts the bucket above its burst', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    const cost: PostCost = { commands: 6, fullReads: 0, measured: 6 };
    g.start('user', cost, 0); // no time known yet: six
    c.advance(10 * 60_000); // full again meanwhile
    expect(g.observe('user', cost, { ok: true, durationMs: 50, responseBytes: 100 })).toBe(1);
    g.start('user', { commands: GOVERNOR.shared.commands.capacity, fullReads: 0 }, 0);
    expect(g.admit('user', { commands: 1, fullReads: 0 })).toBe(250);
  });

  it('background work, scripts that are not read-only constant ones and full reads keep one per command', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    const bg: PostCost = { commands: 6, fullReads: 0, measured: 6 };
    g.start('background', bg, 0);
    expect(g.observe('background', bg, { ok: true, durationMs: 30, responseBytes: 100 })).toBe(6);
    const mixed: PostCost = { commands: 6, fullReads: 0, measured: 5 };
    g.start('user', mixed, 0);
    expect(g.observe('user', mixed, { ok: true, durationMs: 30, responseBytes: 100 })).toBe(6);
    const plain: PostCost = { commands: 6, fullReads: 0 };
    g.start('user', plain, 0);
    expect(g.observe('user', plain, { ok: true, durationMs: 30, responseBytes: 100 })).toBe(6);
    // The background budget (burst 20) is unchanged: 14 left.
    expect(g.admit('background', { commands: 14, fullReads: 0 })).toBe(0);
    expect(g.admit('background', { commands: 15, fullReads: 0 })).toBeGreaterThan(0);
  });

  it('an overload signal still stops background work and costs the old debit', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    const cost: PostCost = { commands: 3, fullReads: 0, measured: 3 };
    g.start('user', cost, 0);
    expect(g.observe('user', cost, { ok: false, durationMs: 50, responseBytes: 0, overload: true, detail: 'HTTP 503' })).toBe(3);
    expect(g.admit('background', { commands: 1, fullReads: 0 })).toBe(-1);
  });
});

describe('no discount while the governor is overloaded or slow, or without a recent time', () => {
  /** Posts of 6 commands at 60 ms through one governor, from an empty bucket. */
  function lane(g: LoadGovernor, c: ReturnType<typeof clock>, n: number, measured: boolean) {
    let held = 0;
    let debit = 0;
    for (let i = 0; i < n; i++) {
      const cost: PostCost = { commands: 6, fullReads: 0, ...(measured ? { measured: 6 } : {}) };
      for (let w = g.admit('user', cost); w > 0; w = g.admit('user', cost)) { c.advance(w); held += w; }
      g.start('user', cost, 0);
      c.advance(60);
      debit += g.observe('user', cost, { ok: true, durationMs: 60, responseBytes: 100 });
    }
    return { held, debit };
  }

  it('fast listing posts, then an out-of-memory answer: the following posts go at the old rate', () => {
    const run = (measured: boolean) => {
      const c = clock();
      const g = new LoadGovernor({ now: c.now });
      lane(g, c, 6, measured);
      // The answer body said OutOfMemory (BmpClient.executeEcBatch), after the post was settled.
      g.noteOverload('java.lang.OutOfMemoryError: Java heap space');
      c.advance(10 * 60_000); // both buckets full again, still inside the 30 min cool-down
      g.start('user', { commands: GOVERNOR.shared.commands.capacity, fullReads: 0 }, 0);
      return lane(g, c, 20, measured);
    };
    const before = run(false);
    const after = run(true);
    expect(after.debit).toBe(before.debit);
    expect(after.held).toBe(before.held);
  });

  it('the slow state (light posts four times slower than the baseline) also ends the discount', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    lane(g, c, 3, true);
    const light = (ms: number) => g.observe('user', { commands: 1, fullReads: 0 }, { ok: true, durationMs: ms, responseBytes: 500 });
    for (let i = 0; i < GOVERNOR.light.baselineSamples; i++) light(60);
    for (let i = 0; i < GOVERNOR.light.recentSamples; i++) light(2_400);
    expect(g.state()).toMatchObject({ state: 'slow' });
    expect(lane(g, c, 3, true).debit).toBe(18);
    // After the pause, the first post starts at the old cost again (history cleared).
    c.advance(GOVERNOR.light.pauseMs);
    g.start('user', { commands: GOVERNOR.shared.commands.capacity, fullReads: 0 }, 0);
    const w6 = g.admit('user', { commands: 6, fullReads: 0, measured: 6 });
    const w1 = g.admit('user', { commands: 1, fullReads: 0 });
    expect(w6 - w1).toBeGreaterThanOrEqual(1_249);
  });

  it('the history expires after 30 s without such a post', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    lane(g, c, 2, true);
    g.start('user', { commands: GOVERNOR.shared.commands.capacity, fullReads: 0 }, 0);
    const startWait = () => g.admit('user', { commands: 6, fullReads: 0, measured: 6 }) - g.admit('user', { commands: 1, fullReads: 0 });
    expect(startWait()).toBe(0);
    c.advance(GOVERNOR.measured.historyMs + 1);
    g.start('user', { commands: GOVERNOR.shared.commands.capacity, fullReads: 0 }, 0);
    expect(startWait()).toBeGreaterThanOrEqual(1_249);
  });
});

describe('the bucket and the clock', () => {
  it('a clock set back does not drain the bucket', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    c.advance(-60 * 60_000);
    expect(g.admit('user', { commands: 450, fullReads: 0 })).toBe(0);
  });
});

describe('the transport marks read-only constant scripts', () => {
  function mockAuth() {
    return {
      sessionEpoch: 0,
      getLoginTicket: vi.fn().mockResolvedValue('t'),
      refreshLoginTicket: vi.fn().mockResolvedValue('t'),
      invalidateLoginTicket: vi.fn(),
      rejectCommandAuthentication: vi.fn(),
      fetchCommand: vi.fn(async (_t: string, init: RequestInit, consume: (r: Response) => Promise<unknown>) => consume(await fetch('https://bmp.test/W/cs/command', init))),
    };
  }

  it('constant reads are measured; varying scripts and writes count one each', async () => {
    registerBmpTypes();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 })));
    const transport = new BmpTransport('https://bmp.test/M/', mockAuth() as never);
    const constant = [0, 1, 2].map(i => makeExtendedExecuteCommand(constantScript('measuredTest', `_x := ${i}`)));
    const varying = [0, 1, 2].map(i => makeExtendedExecuteCommand(varyingScript('measuredTestV', `_v := ${i}`)));
    const writes = [0, 1, 2].map(i => makeExtendedExecuteCommand(constantScript('measuredTestW', `_w := ${i}`), { transactional: true }));
    // The answer [9] is not a stream: the post is debited before decoding fails.
    await transport.sendStreamingCommands(constant, 'read').catch(() => undefined);
    await transport.sendStreamingCommands(constant, 'read').catch(() => undefined);
    await transport.sendStreamingCommands(varying, 'read').catch(() => undefined);
    await transport.sendStreamingCommands(writes, 'write').catch(() => undefined);
    const debits = transport.governor.recentPosts.map(p => p.debit);
    expect(debits).toEqual([1, 1, 3, 3]);
  });

  it('only commands sent with transactional === false count, whatever intent the caller gives', async () => {
    registerBmpTypes();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 })));
    const transport = new BmpTransport('https://bmp.test/T7/', mockAuth() as never);
    const text = (i: number) => constantScript('measuredTestT', `_t := ${i}`);
    const tx = [0, 1, 2].map(i => makeExtendedExecuteCommand(text(i), { transactional: true }));
    const unset = [0, 1, 2].map(i => ({ ...makeExtendedExecuteCommand(text(i)), transactional: undefined }));
    await transport.sendStreamingCommands(tx, 'read').catch(() => undefined);
    await transport.sendStreamingCommands(unset, 'read').catch(() => undefined);
    await transport.sendStreamingCommand(tx[0], 'read').catch(() => undefined);
    await transport.sendCommands(unset, 'read').catch(() => undefined);
    expect(transport.governor.recentPosts.map(p => p.debit)).toEqual([3, 3, 1, 3]);
    expect(transport.governor.recentPosts.map(p => p.commands)).toEqual([3, 3, 1, 3]);
  });

  it('a user post that may go soon is not held to the timer of a background post that waits longer', async () => {
    vi.useFakeTimers();
    registerBmpTypes();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = new BmpTransport('https://bmp.test/K/', mockAuth() as never);
    const g = transport.governor;
    // The background budget is deep in debt (a minute away); the shared one is empty.
    g.start('background', { commands: 140, fullReads: 0 }, 0);
    g.start('user', { commands: 310, fullReads: 0 }, 0);
    const stop = new AbortController();
    const bg = transport.sendCommands([makeGetObjectCommand('1')], 'read', backgroundSignal({ signal: stop.signal })).catch(() => 'dropped');
    await vi.advanceTimersByTimeAsync(10);
    const user = transport.sendCommands([makeGetObjectCommand('2')], 'read');
    // One command at 240 a minute: 250 ms.
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user;
    stop.abort();
    expect(await bg).toBe('dropped');
  });
});
