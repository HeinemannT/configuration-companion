/**
 * The load governor (lib/load-governor.ts): budgets per minute, queueing
 * that never drops a post, adaptive full reads per post, the early warning
 * on slow light requests and the cool-down after an overload signal; and
 * the transport that puts every post through it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandDebit, GOVERNOR, LoadGovernor, loadSentence } from '../load-governor';
import { BmpTransport } from '../bmp-transport';
import { backgroundSignal } from '../request-class';
import { makeGetObjectCommand, makeTreeItemCommand, registerBmpTypes } from '../bmp-types';
import { buildSummariesEc, parseSummariesLog, readSummaries } from '../object-summaries';
import { STATIC_EC_FRAME as F } from '../ec-parser';
import { findEvaluatingCodeReads } from '../ec-code-safety';
import { framedText as __framedText } from '../ec-parser';
/** One length-framed row (ec-parser). */
const R = (...f: unknown[]) => __framedText([f.map(String)], false);

afterEach(() => vi.unstubAllGlobals());

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('budgets', () => {
  it('lets a burst through, then makes posts wait for the steady rate', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    // One object window open at its 400-node cap goes at once (the burst).
    for (let i = 0; i < 16; i++) { expect(g.admit('user', { commands: 25, fullReads: 25 })).toBe(0); g.start('user', { commands: 25, fullReads: 25 }, 0); }
    const wait = g.admit('user', { commands: 25, fullReads: 25 });
    // 25 reads at 200 a minute: 7.5 s.
    expect(wait).toBeGreaterThan(7_000);
    expect(wait).toBeLessThanOrEqual(7_500);
    expect(g.state()).toMatchObject({ state: 'waiting' });
    expect(loadSentence(g.state(), c.now())).toMatch(/^Waiting for the server/);
    c.advance(wait);
    expect(g.admit('user', { commands: 25, fullReads: 25 })).toBe(0);
  });

  it('holds background work to a much smaller budget than user work', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    for (let i = 0; i < 2; i++) { expect(g.admit('background', { commands: 5, fullReads: 5 })).toBe(0); g.start('background', { commands: 5, fullReads: 5 }, 0); }
    expect(g.admit('background', { commands: 5, fullReads: 5 })).toBeGreaterThan(9_000); // 30 reads a minute
    expect(g.admit('user', { commands: 5, fullReads: 5 })).toBe(0);
  });

  it('charges response bytes after the answer: a large one delays the next post', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    g.start('user', { commands: 1, fullReads: 9 }, 0);
    g.observe('user', { commands: 1, fullReads: 9 }, { ok: true, durationMs: 800, responseBytes: 20_000_000 });
    expect(g.admit('user', { commands: 1, fullReads: 0 })).toBeGreaterThan(0);
  });
});

describe('index reads are debited by measured time', () => {
  it('counts twenty built-in index reads as one command, at least one per post', () => {
    expect(commandDebit({ commands: 44, index: 44 })).toBe(3);
    expect(commandDebit({ commands: 2, index: 2 })).toBe(1);
    expect(commandDebit({ commands: 12 })).toBe(12);
    // A post that mixes index reads and scripts: each script counts one.
    expect(commandDebit({ commands: 12, index: 10 })).toBe(3);
    expect(commandDebit({ commands: 200, index: 200 })).toBe(10);
  });

  it('charges an index-only post one command per 250 ms of measured time when that is more', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    const fast = { commands: 10, fullReads: 0, index: 10 };
    g.start('user', fast, 0);
    expect(g.observe('user', fast, { ok: true, durationMs: 40, responseBytes: 3_000 })).toBe(1);
    const slow = { commands: 10, fullReads: 0, index: 10 };
    g.start('user', slow, 0);
    expect(g.observe('user', slow, { ok: true, durationMs: 5_000, responseBytes: 3_000 })).toBe(20);
    // A failed (timed-out) index post is charged for its time too.
    g.start('user', slow, 0);
    expect(g.observe('user', slow, { ok: false, durationMs: 1_000, responseBytes: 0 })).toBe(4);
    expect(g.counters.debited).toBe(25);
    expect(g.counters.commands).toBe(30);
    // Scripts are never discounted by a fast answer.
    const ec = { commands: 12, fullReads: 0 };
    g.start('user', ec, 0);
    expect(g.observe('user', ec, { ok: true, durationMs: 10, responseBytes: 100 })).toBe(12);
  });

  it('ten picker queries and five listings fit the burst; heavy work keeps its budget', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    // One picker query as measured: by-ID lookups (32 + 12), the search
    // (2), identities (up to 200), the portal search and a summary script.
    const query = [{ commands: 32, index: 32 }, { commands: 12, index: 12 }, { commands: 2, index: 2 }, { commands: 200, index: 200 }, { commands: 1 }, { commands: 1 }];
    for (let q = 0; q < 10; q++) for (const p of query) {
      const cost = { fullReads: 0, ...p };
      expect(g.admit('user', cost)).toBe(0);
      g.start('user', cost, 0);
      g.observe('user', cost, { ok: true, durationMs: 60, responseBytes: 2_000 });
      c.advance(500);
    }
    for (let s = 0; s < 5; s++) {
      const listing = { commands: 12, fullReads: 0 };
      for (let k = 0; k < 3; k++) { expect(g.admit('user', listing)).toBe(0); g.start('user', listing, 0); c.advance(300); }
    }
    // The same number of scripts would have waited: 450 scripts at once,
    // then the steady rate.
    const h = new LoadGovernor({ now: c.now });
    for (let i = 0; i < 37; i++) { h.start('user', { commands: 12, fullReads: 0 }, 0); }
    expect(h.admit('user', { commands: 12, fullReads: 0 })).toBeGreaterThan(0);
    // Full reads are not index reads: their budget is unchanged.
    for (let i = 0; i < 16; i++) g.start('user', { commands: 25, fullReads: 25 }, 0);
    expect(g.admit('user', { commands: 25, fullReads: 25 })).toBeGreaterThan(7_000);
  });

  it('background index reads still draw from the small background budget', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    const cost = { commands: 200, fullReads: 0, index: 200 };
    g.start('background', cost, 0);
    g.observe('background', cost, { ok: true, durationMs: 3_000, responseBytes: 10_000 });
    // 12 commands debited of a burst of 20: the next such post waits.
    expect(g.admit('background', cost)).toBeGreaterThan(0);
    expect(g.admit('user', cost)).toBe(0);
  });
});

describe('adaptive full reads per post', () => {
  it('starts at 25, halves on large or slow answers and grows back', () => {
    const g = new LoadGovernor();
    expect(g.fullReadsPerPost).toBe(25);
    g.observe('user', { commands: 25, fullReads: 25 }, { ok: true, durationMs: 300, responseBytes: 4_300_000 });
    expect(g.fullReadsPerPost).toBe(12);
    g.observe('user', { commands: 12, fullReads: 12 }, { ok: true, durationMs: 6_000, responseBytes: 100_000 });
    expect(g.fullReadsPerPost).toBe(6);
    g.observe('user', { commands: 6, fullReads: 6 }, { ok: true, durationMs: 6_000, responseBytes: 100_000 });
    expect(g.fullReadsPerPost).toBe(GOVERNOR.minFullReadsPerPost);
    for (let i = 0; i < 10; i++) g.observe('user', { commands: 5, fullReads: 5 }, { ok: true, durationMs: 100, responseBytes: 50_000 });
    expect(g.fullReadsPerPost).toBe(25);
  });
});

describe('early warning and cool-down', () => {
  it('pauses background work when light requests slow down against the baseline', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    const light = (ms: number) => g.observe('user', { commands: 1, fullReads: 0 }, { ok: true, durationMs: ms, responseBytes: 500 });
    for (let i = 0; i < GOVERNOR.light.baselineSamples; i++) light(60);
    for (let i = 0; i < GOVERNOR.light.recentSamples; i++) light(2_400);
    expect(g.state()).toMatchObject({ state: 'slow' });
    expect(g.admit('background', { commands: 1, fullReads: 0 })).toBeGreaterThan(60_000);
    expect(g.admit('user', { commands: 1, fullReads: 0 })).toBe(0);
    c.advance(GOVERNOR.light.pauseMs);
    expect(g.admit('background', { commands: 1, fullReads: 0 })).toBe(0);
  });

  it('stops background work for 30 minutes after an overload signal; user work goes on', () => {
    const c = clock();
    const g = new LoadGovernor({ now: c.now });
    g.observe('background', { commands: 1, fullReads: 0 }, { ok: false, durationMs: 60_000, responseBytes: 0, overload: true, detail: 'BMP timed out' });
    expect(g.admit('background', { commands: 1, fullReads: 0 })).toBe(-1);
    expect(g.admit('user', { commands: 1, fullReads: 0 })).toBe(0);
    expect(loadSentence(g.state(), c.now())).toBe('The server answered like an overloaded one: background work stopped for 30 min.');
    c.advance(GOVERNOR.cooldownMs);
    expect(g.admit('background', { commands: 1, fullReads: 0 })).toBe(0);
  });
});

describe('the transport puts every post through the governor', () => {
  function fetchOk() {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
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

  it('queues background full reads over the budget instead of dropping them, and refuses them after an overload', async () => {
    registerBmpTypes();
    const fetchMock = fetchOk();
    const transport = new BmpTransport('https://bmp.test/W/', mockAuth() as never);
    const states: string[] = [];
    transport.setLoadObserver(s => states.push(s.state));
    const reads = (n: number) => Array.from({ length: n }, (_, i) => makeGetObjectCommand(String(1000 + i)));
    await transport.sendCommands(reads(10), 'read', backgroundSignal());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The background burst (10 full reads) is used up: the next post waits.
    const next = transport.sendCommands(reads(5), 'read', backgroundSignal());
    await new Promise(r => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(states).toContain('waiting');
    transport.governor.noteOverload('java.lang.OutOfMemoryError: Java heap space');
    await expect(next).rejects.toThrow(/Background work stopped/);
    expect(transport.governor.counters.fullReads).toBe(10);
  });

  it('tells the governor which commands are built-in index reads', async () => {
    registerBmpTypes();
    fetchOk();
    const transport = new BmpTransport('https://bmp.test/W/', mockAuth() as never);
    await transport.sendCommands(Array.from({ length: 40 }, (_, i) => makeTreeItemCommand(String(5000 + i))), 'read');
    await transport.sendCommands([makeGetObjectCommand('1001')], 'read');
    const [items, full] = transport.governor.recentPosts.slice(-2);
    expect(items).toMatchObject({ commands: 40, debit: 2 });
    expect(full).toMatchObject({ commands: 1, fullReads: 1, debit: 1 });
    expect(transport.governor.counters).toMatchObject({ commands: 41, debited: 3 });
  });
});

describe('summaries without full reads', () => {
  it('reads name, type and ID of many objects with a small script that touches no code', async () => {
    const ec = buildSummariesEc([{ rid: '1', ref: 'lookup(1)' }, { rid: '2', ref: 'lookup(2)' }], F);
    expect(findEvaluatingCodeReads(ec)).toEqual([]);
    expect(ec).not.toContain('output(');
    expect(parseSummariesLog(`${R(`1`, `ExtendedTable`, `Risks`, `t1`)}${F.done}`, F)).toEqual([{ rid: '1', type: 'ExtendedTable', name: 'Risks', businessId: 't1' }]);
    const posts: string[] = [];
    const client = {
      resolveRefs: async (rids: readonly string[]) => new Map(rids.map(r => [r, `lookup(${r})`] as [string, string])),
      executeEc: async (code: string) => { posts.push(code); return { ok: true, log: F.done }; },
    };
    const res = await readSummaries(client, Array.from({ length: 250 }, (_, i) => String(100 + i)), () => F);
    expect(res.posts).toBe(3);
  });
});

describe('a failed ticket request is an overload signal too', () => {
  it('stops background work after "Failed to obtain a command ticket (HTTP 502)"', async () => {
    const transport = new BmpTransport('https://bmp.test/T/', {
      sessionEpoch: 0,
      getLoginTicket: vi.fn().mockRejectedValue(new Error('Failed to obtain a command ticket (HTTP 502).')),
      refreshLoginTicket: vi.fn(), invalidateLoginTicket: vi.fn(), rejectCommandAuthentication: vi.fn(), fetchCommand: vi.fn(),
    } as never);
    registerBmpTypes();
    await expect(transport.sendCommands([makeGetObjectCommand('1')], 'read')).rejects.toThrow(/502/);
    expect(transport.governor.state()).toMatchObject({ state: 'overloaded' });
  });
});
