/**
 * Companion notices a server restart by itself (BmpClient.checkServerRestart,
 * script-ledger.ts): one change-feed read from '-1' when a command session
 * answers its first post, and at most once per five minutes per server
 * when the script count holds background work back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BmpClient } from '../bmp-client';
import { BmpTransport } from '../bmp-transport';
import { GOVERNOR, LoadGovernor, scriptKey } from '../load-governor';
import { SCRIPT_COST } from '../script-ledger';
import { makeExtendedExecuteCommand, registerBmpTypes } from '../bmp-types';
import { JavaWriter } from '../java-serial';
import { backgroundSignal } from '../request-class';
import { mockChromeStorage } from './chrome-mock';

const flag = globalThis as { __crevTestNoRestartCheck?: boolean };
beforeEach(() => { delete flag.__crevTestNoRestartCheck; });
afterEach(() => { flag.__crevTestNoRestartCheck = true; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = (...texts: string[]) => ({ commands: texts.length, fullReads: 0, scripts: texts.map(scriptKey) });
const texts = (n: number) => Array.from({ length: n }, (_, i) => `s ${i}`);
const pack = (packId: string) => [{ $class: 'com.corporater.TreeEventPack', packId }];

/** A client whose server holds `entries` of Companion's scripts, the feed's
 *  mark at 500; `answer` stands in for the server's TreeEventCommand answer. */
async function clientWithCount(url: string, entries: number, answer: () => Promise<unknown[]>) {
  mockChromeStorage();
  const client = new BmpClient(url, 'admin', 'pass');
  const g = client.governor;
  await g.ledger.ready;
  await g.noteServerCounter('500');
  for (const t of texts(entries)) g.start('user', post(t), 0);
  const transport = (client as unknown as { transport: BmpTransport }).transport;
  const sent = vi.spyOn(transport, 'sendStreamingCommands').mockImplementation(async () => answer());
  return { client, g, sent };
}

describe('the restart check', () => {
  it('on session start: a pack id below the stored mark is a restart, the count empties and statuses are told', async () => {
    const { client, g, sent } = await clientWithCount('https://bmp.restart-a.test/', SCRIPT_COST.backgroundEntries + 3, async () => pack('20'));
    expect(g.scriptBudgetUsed()).toBe(true);
    const restarts = vi.fn();
    g.onRestart(restarts);
    client.checkServerRestart('session');
    await vi.waitFor(() => expect(g.scriptLoad().entries).toBe(0));
    expect(sent).toHaveBeenCalledTimes(1);
    // One small read: one TreeEventCommand, read-only, background, no script.
    const [commands, intent, signal] = sent.mock.calls[0];
    expect(commands).toHaveLength(1);
    expect(intent).toBe('read');
    const { requestClassOf } = await import('../request-class');
    expect(requestClassOf(signal).requestClass).toBe('background');
    expect(g.scriptLoad()).toMatchObject({ restartSeen: true, restartSetByUser: false, backgroundStopped: false });
    expect(restarts).toHaveBeenCalledTimes(1);
    // The same session is not checked twice.
    client.checkServerRestart('session');
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('a pack id at or above the mark changes nothing', async () => {
    const { client, g } = await clientWithCount('https://bmp.restart-b.test/', 5, async () => pack('600'));
    client.checkServerRestart('session');
    await vi.waitFor(async () => { await g.ledger.persist(); expect(g.scriptLoad().entries).toBe(5); });
    expect(g.scriptLoad().restartSeen).toBe(false);
  });

  it('the refusal path checks at most once per five minutes per server', async () => {
    let t = 10_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    const { client, sent } = await clientWithCount('https://bmp.restart-c.test/', SCRIPT_COST.backgroundEntries, async () => pack('600'));
    client.checkServerRestart('refused');
    client.checkServerRestart('refused');
    client.checkServerRestart('limit');
    expect(sent).toHaveBeenCalledTimes(1);
    t += GOVERNOR.restartCheckMs - 1;
    client.checkServerRestart('refused');
    expect(sent).toHaveBeenCalledTimes(1);
    t += 1;
    client.checkServerRestart('limit');
    expect(sent).toHaveBeenCalledTimes(2);
    // A second client of the same server shares the limit.
    const other = new BmpClient('https://bmp.restart-c.test/', 'admin', 'pass', 'p2');
    const otherSent = vi.spyOn((other as unknown as { transport: BmpTransport }).transport, 'sendStreamingCommands').mockResolvedValue(pack('600'));
    other.checkServerRestart('refused');
    expect(otherSent).not.toHaveBeenCalled();
  });

  it('a failing check changes nothing and throws nothing', async () => {
    const { client, g, sent } = await clientWithCount('https://bmp.restart-d.test/', SCRIPT_COST.backgroundEntries + 1, async () => { throw new Error('HTTP 503'); });
    const before = g.scriptLoad();
    expect(() => client.checkServerRestart('session')).not.toThrow();
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 0));
    expect(g.scriptLoad()).toMatchObject({ entries: before.entries, restartSeen: false, backgroundStopped: true });
  });

  it('a feed read counts as the check of its session and of the five minutes', async () => {
    const { client, sent } = await clientWithCount('https://bmp.restart-e.test/', SCRIPT_COST.backgroundEntries, async () => pack('600'));
    await client.readTreeEvents('-1');
    client.checkServerRestart('session');
    client.checkServerRestart('refused');
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe('the governor\'s rate limit', () => {
  it('claims one check per GOVERNOR.restartCheckMs; a forced claim restarts the wait; a clock set back allows one', () => {
    let t = 1_000_000;
    const g = new LoadGovernor({ now: () => t });
    expect(g.claimRestartCheck()).toBe(true);
    expect(g.claimRestartCheck()).toBe(false);
    t += GOVERNOR.restartCheckMs;
    expect(g.claimRestartCheck(true)).toBe(true);
    t += GOVERNOR.restartCheckMs - 1;
    expect(g.claimRestartCheck()).toBe(false);
    t -= 10 * GOVERNOR.restartCheckMs;
    expect(g.claimRestartCheck()).toBe(true);
  });
});

describe('the transport tells the client when to check', () => {
  function transportFor(url: string, auth: { sessionEpoch: number }) {
    registerBmpTypes();
    const w = new JavaWriter();
    w.writeStreamHeader();
    w.writeString('END');
    const bytes = w.toBytes();
    const fetched = vi.fn(async () => new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'application/x-java-serialized-object' } }));
    vi.stubGlobal('fetch', fetched);
    Object.assign(auth, {
      getLoginTicket: vi.fn().mockResolvedValue('t'),
      refreshLoginTicket: vi.fn(),
      rejectCommandAuthentication: vi.fn(),
      fetchCommand: vi.fn(async (_t: string, init: RequestInit, consume: (r: Response) => Promise<unknown>) => consume(await fetch(`${url}cs/command`, init))),
    });
    const transport = new BmpTransport(url, auth as never);
    const why: string[] = [];
    transport.setRestartCheck(w => why.push(w));
    return { transport, why, fetched };
  }

  it('once at the first answer of each command session, not per post', async () => {
    const auth = { sessionEpoch: 0 };
    const { transport, why } = transportFor('https://bmp.session.test/', auth);
    await transport.sendStreamingCommand(makeExtendedExecuteCommand('1'), 'read').catch(() => {});
    await transport.sendStreamingCommand(makeExtendedExecuteCommand('2'), 'read').catch(() => {});
    expect(why).toEqual(['session']);
    auth.sessionEpoch = 1; // signed in again
    await transport.sendStreamingCommand(makeExtendedExecuteCommand('3'), 'read').catch(() => {});
    expect(why).toEqual(['session', 'session']);
  });

  it('when the governor refuses a background post for the script count', async () => {
    const { transport, why, fetched } = transportFor('https://bmp.refused.test/', { sessionEpoch: 0 });
    for (const t of texts(SCRIPT_COST.backgroundEntries)) transport.governor.start('user', post(t), 0);
    const refused = await transport.sendStreamingCommand(makeExtendedExecuteCommand('"new"'), 'read', backgroundSignal()).then(() => null, (e: Error) => e);
    expect(refused?.message).toMatch(/^Background work paused/);
    expect(fetched).not.toHaveBeenCalled();
    expect(why).toEqual(['refused']);
  });
});
