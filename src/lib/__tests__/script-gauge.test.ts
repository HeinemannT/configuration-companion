/**
 * The script gauge of the load governor (load-governor.ts rule 6): new
 * script text per rolling hour and in total, background posts with new text
 * wait when the hour's budget is used up, and the Log is told once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadGovernor, scriptKey, scriptSentence } from '../load-governor';
import { SCRIPT_COST, ScriptLedger } from '../script-ledger';
import { BmpTransport } from '../bmp-transport';
import { makeExtendedExecuteCommand, registerBmpTypes } from '../bmp-types';
import { JavaWriter } from '../java-serial';
import { narrowAnswer } from '../object-search';

afterEach(() => vi.unstubAllGlobals());

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
const post = (...texts: string[]) => ({ commands: texts.length, fullReads: 0, scripts: texts.map(scriptKey) });

describe('fewer scripts: a longer query narrows a complete earlier answer', () => {
  const rows = [
    { rid: '1', type: 'InputView', businessId: 'risk_view', name: 'Risk view' },
    { rid: '2', type: 'InputView', businessId: 'x', name: 'Risky' },
    { rid: '3', type: 'InputView', businessId: 'issue', name: 'Issue' },
  ];
  it('answers locally only from a complete answer for a contained query', () => {
    expect(narrowAnswer({ query: 'ris', rows, complete: true }, 'Risk')?.map(o => o.rid)).toEqual(['1', '2']);
    expect(narrowAnswer({ query: 'ris', rows, complete: true }, 'k_v')).toBeNull();
    expect(narrowAnswer({ query: 'ris', rows, complete: true }, 'risk_v')?.map(o => o.rid)).toEqual(['1']);
    expect(narrowAnswer({ query: 'ris', rows, complete: false }, 'risk')).toBeNull();
    expect(narrowAnswer({ query: 'risk', rows, complete: true }, 'ris')).toBeNull();
    expect(narrowAnswer(undefined, 'risk')).toBeNull();
  });
});

describe('the script gauge: Companion\'s window of the server\'s 2,000-entry parse cache', () => {
  const texts = (n: number, prefix = 's') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

  it('counts each distinct text once, by hash; a repeat is free and refreshes it', () => {
    const g = new LoadGovernor({ now: clock().now });
    g.start('user', post('1 + 1', 'lookup(1).name'), 0);
    g.start('user', post('1 + 1'), 0);
    g.start('background', post('lookup(1).name', '2 + 2'), 0);
    expect(g.scriptLoad()).toMatchObject({ entries: 3, chars: 24, largest: 14, share: 3 / 2000, estimatedServerBytes: 24 * 40, repeats: 2, distinct: 3, cacheEntries: 2000, backgroundStopped: false, serverCacheOff: null });
    expect(scriptKey('1 + 1')).toEqual(scriptKey('1 + 1'));
    expect(scriptKey('1 + 1').key).not.toBe(scriptKey('1 + 2').key);
  });

  it('keeps only the last 2,000 distinct texts, like the server', () => {
    const g = new LoadGovernor({ now: clock().now });
    g.setServerCacheOff(false);
    for (const t of texts(2_100)) g.start('user', post(t), 0);
    expect(g.scriptLoad().entries).toBe(2_000);
    expect(g.newScriptChars(post('s 0').scripts)).toBe(3); // evicted: new again
    expect(g.newScriptChars(post('s 2099').scripts)).toBe(0);
  });

  it('refuses background posts with a NEW text past the entry budget; never user posts or repeats', () => {
    const g = new LoadGovernor({ now: clock().now });
    for (const t of texts(SCRIPT_COST.backgroundEntries - 1)) g.start('user', post(t), 0);
    expect(g.admit('background', post('one more'))).toBe(0);
    g.start('background', post('one more'), 0);
    expect(g.scriptLoad().backgroundStopped).toBe(true);
    expect(g.admit('background', post('another'))).toBe(-2);
    expect(g.admit('background', post('s 3'))).toBe(0); // a repeat costs nothing
    expect(g.admit('user', post('another'))).toBe(0);
    // A server without a parse cache: nothing is kept, no budget applies.
    g.setServerCacheOff(true);
    expect(g.admit('background', post('another'))).toBe(0);
    expect(scriptSentence(g.scriptLoad())).toMatch(/noCache option is on/);
  });

  it('refuses background posts past the memory budget too', () => {
    const g = new LoadGovernor({ now: clock().now });
    g.start('user', post('x'.repeat(SCRIPT_COST.backgroundBytes / SCRIPT_COST.bytesPerChar)), 0);
    expect(g.admit('background', post('y'))).toBe(-2);
  });

  it('says so once while it lasts: the background limit to the Log, the large share to the panel', () => {
    const g = new LoadGovernor({ now: clock().now });
    const said: Array<[string, string]> = [];
    g.setNoticeListener('p1', (text, kind) => said.push([kind, text]));
    for (const t of texts(SCRIPT_COST.backgroundEntries + 5)) g.start('user', post(t), 0);
    expect(said.map(x => x[0])).toEqual(['background']);
    expect(said[0][1]).toMatch(/^Companion holds about 200 of the 2,000 parsed scripts this server keeps .* Background work paused/);
    expect(g.memoryNotice()).toBeNull();
    for (const t of texts(SCRIPT_COST.noticeEntries, 'more')) g.start('user', post(t), 0);
    expect(said.map(x => x[0])).toEqual(['background', 'memory']);
    expect(g.memoryNotice()).toMatch(/^Companion has added about 705 parsed scripts \(under 1 MB\) to this server's memory\. The server keeps them until it restarts\. An estimate since \d+ \w+; Companion has not seen the server restart since then\.$/);
  });

  it('keeps the window across a worker restart; a text unused for a week leaves it', async () => {
    const store = new Map<string, unknown>();
    const storage = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
    const c = clock(Date.parse('2026-11-12T08:00:00'));
    const first = new ScriptLedger({ now: c.now, key: 'k', storage });
    await first.ready;
    first.record(post('alpha', 'beta').scripts);
    await first.persist();
    const second = new ScriptLedger({ now: c.now, key: 'k', storage });
    await second.ready;
    expect(second.newChars(post('alpha', 'beta', 'gamma').scripts)).toBe(5);
    expect(second.totals()).toMatchObject({ entries: 2, chars: 9, distinct: 2 });
    for (const t of texts(2_000)) second.record([scriptKey(t)]);
    await second.persist();
    expect(JSON.stringify(store.get('k')).length).toBeLessThan(80_000);
    c.advance(SCRIPT_COST.staleMs + 1);
    const third = new ScriptLedger({ now: c.now, key: 'k', storage });
    await third.ready;
    expect(third.totals().entries).toBe(0);
    expect(third.has(scriptKey('s 5').key)).toBe(false);
  });

  it('empties the window when the change feed\'s pack counter goes back (a server restart), kept across worker restarts', async () => {
    const store = new Map<string, unknown>();
    const storage = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
    const c = clock(Date.parse('2026-11-12T08:00:00'));
    const ledger = new ScriptLedger({ now: c.now, key: 'k', storage });
    for (const t of texts(300)) ledger.record([scriptKey(t)]);
    // Pack ids are Java longs: compared as such, beyond 2^53.
    expect(await ledger.noteServerCounter('9007199254740993')).toBe(false);
    expect(await ledger.noteServerCounter('9007199254740995')).toBe(false);
    expect(ledger.totals()).toMatchObject({ entries: 300, restartSeen: false });
    c.advance(60_000);
    expect(await ledger.noteServerCounter('9007199254740994')).toBe(true);
    expect(ledger.totals()).toMatchObject({ entries: 0, distinct: 0, restartSeen: true, since: c.now() });
    await ledger.persist();
    const next = new ScriptLedger({ now: c.now, key: 'k', storage });
    await next.ready;
    expect(next.totals()).toMatchObject({ entries: 0, restartSeen: true, since: c.now() });
    // The mark came along: a higher id is no restart, a lower one is.
    expect(await next.noteServerCounter('9007199254740999')).toBe(false);
    expect(await next.noteServerCounter('12')).toBe(true);
  });

  it('first use with a ledger from an earlier build (no pack id stored): the first feed answer is the baseline, no reset', async () => {
    const store = new Map<string, unknown>([['k', { v: 3, since: 1, sent: 2, sentChars: 9, window: [[scriptKey('alpha').key, 5, 1_000_000, 0], [scriptKey('beta').key, 4, 1_000_000, 0]] }]]);
    const storage = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
    const ledger = new ScriptLedger({ now: clock().now, key: 'k', storage });
    expect(await ledger.noteServerCounter('40')).toBe(false);
    expect(ledger.totals()).toMatchObject({ entries: 2, restartSeen: false });
    expect(await ledger.noteServerCounter('30')).toBe(true);
  });

  it('"Server was restarted": the count of that server starts again, dated as set by you, the pause ends with one Log line', async () => {
    const c = clock(Date.parse('2026-11-13T09:00:00'));
    const mk = () => new LoadGovernor({ now: c.now });
    const g = mk(), other = mk();
    const said: Array<[string, string]> = [];
    g.setNoticeListener('p1', (text, kind) => said.push([kind, text]));
    g.setNoticeListener('p2', (text, kind) => said.push([kind, text]));
    for (const t of texts(SCRIPT_COST.backgroundEntries + 5)) { g.start('user', post(t), 0); other.start('user', post(t), 0); }
    await g.noteServerCounter('500');
    expect(said.map(x => x[0])).toEqual(['background']);
    c.advance(60_000);
    await g.resetScriptCount();
    expect(said.map(x => x[0])).toEqual(['background', 'background-end']);
    expect(said[1][1]).toMatch(/^Background work resumed: you reset the count after a server restart; Companion now holds about 0 parsed scripts \(under 1 MB\) in/);
    expect(said[1][1]).not.toMatch(/about less than|about under/);
    expect(g.scriptLoad()).toMatchObject({ entries: 0, backgroundStopped: false, restartSeen: true, restartSetByUser: true, since: c.now() });
    expect(scriptSentence(g.scriptLoad())).toMatch(/An estimate since the server was last seen restarting \(13 Nov, set by you\)\./);
    // Another server's count stays.
    expect(other.scriptLoad()).toMatchObject({ entries: SCRIPT_COST.backgroundEntries + 5, backgroundStopped: true, restartSeen: false });
    // The feed's last pack id is the new baseline: a lower one is a restart.
    await g.resetScriptCount();
    expect(said).toHaveLength(2);
    for (const t of texts(3, 'after')) g.start('user', post(t), 0);
    await g.noteServerCounter('499');
    expect(g.scriptLoad()).toMatchObject({ entries: 0, restartSetByUser: false });
  });

  it('logs the background limit once per server per change, also across worker restarts, and its end after a restart', async () => {
    const store = new Map<string, unknown>();
    const storage = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
    const c = clock();
    const life = async () => {
      const g = new LoadGovernor({ now: c.now, ledgerKey: 'k', ledgerStorage: storage });
      await g.ledger.ready;
      const said: Array<[string, string]> = [];
      // Two profiles of one server: the Log is told once.
      g.setNoticeListener('p1', (text, kind) => said.push([kind, text]));
      g.setNoticeListener('p2', (text, kind) => said.push([kind, text]));
      return { g, said };
    };
    const first = await life();
    for (const t of texts(SCRIPT_COST.backgroundEntries + 5)) first.g.start('user', post(t), 0);
    first.g.start('user', post('one more search'), 0);
    expect(first.said.map(x => x[0])).toEqual(['background']);
    expect(first.said[0][1]).toMatch(/An estimate since .*; Companion has not seen the server restart since then\./);
    await first.g.ledger.persist();
    // A new worker: the same state is not written again.
    const second = await life();
    for (let i = 0; i < 5; i++) second.g.start('user', post(`search ${i}`), 0);
    expect(second.said).toEqual([]);
    // The server restarted: the window empties and the end is written once.
    await second.g.noteServerCounter('500');
    await second.g.noteServerCounter('20');
    expect(second.said.map(x => x[0])).toEqual(['background-end']);
    expect(second.said[0][1]).toMatch(/^Background work resumed: the server restarted/);
    expect(second.g.scriptLoad()).toMatchObject({ entries: 0, backgroundStopped: false, restartSeen: true });
    expect(scriptSentence(second.g.scriptLoad())).toMatch(/An estimate since the server was last seen restarting \(/);
  });

  it('the transport gives the governor the text of every Extended Code command it posts', async () => {
    registerBmpTypes();
    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeString('END');
    const bytes = w.toBytes();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'application/x-java-serialized-object' } })));
    const auth = {
      sessionEpoch: 0,
      getLoginTicket: vi.fn().mockResolvedValue('t'),
      refreshLoginTicket: vi.fn(),
      rejectCommandAuthentication: vi.fn(),
      fetchCommand: vi.fn(async (_t: string, init: RequestInit, consume: (r: Response) => Promise<unknown>) => consume(await fetch('https://bmp.gauge.test/cs/command', init))),
    };
    const transport = new BmpTransport('https://bmp.gauge.test/', auth as never);
    await transport.sendStreamingCommand(makeExtendedExecuteCommand('"same" + 1'), 'read').catch(() => {});
    await transport.sendStreamingCommands([makeExtendedExecuteCommand('"same" + 1'), makeExtendedExecuteCommand('"other"')], 'read').catch(() => {});
    expect(transport.governor.scriptLoad()).toMatchObject({ distinct: 2, distinctChars: 10 + 7, repeats: 1 });
  });
});
