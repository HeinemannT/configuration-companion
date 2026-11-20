import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DESKTOP_BUNDLE_NAME, DESKTOP_EXTENSION_VERSION, LINK_APP, STATE_WORDS, deliverSketch, fetchStatus, fitSize, isNews, linkPorts, parseHello,
  portOrder, pushFor, rankCopies, requeueSketch, sendSketch, versionBelow, type LinkSocket,
} from '../claude-link';
import { WORKING_CHAT_OPENING, workingChatLink } from '../point-tell/desktop-policy';

type Answer = unknown;
type Behaviour =
  | 'refuse'                                 // connection refused: onerror
  | 'silent'                                 // accepts, never says anything
  | { hello?: unknown; ack?: Answer; drop?: boolean }  // a listener; `drop`: closes after a message without answering
  ;

/** A fake socket per port, scripted by `ports`. Records what was sent and which ports were tried. */
function fake(ports: Record<number, Behaviour>) {
  const tried: number[] = [];
  const sent: Array<{ port: number; data: Record<string, unknown> }> = [];
  const closed: number[] = [];
  const open = (url: string): LinkSocket => {
    const port = Number(/:(\d+)$/.exec(url)![1]);
    tried.push(port);
    const b = ports[port] ?? 'refuse';
    let n = 0;
    const ws: LinkSocket = {
      onopen: null, onmessage: null, onerror: null, onclose: null,
      send(data: string) {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        sent.push({ port, data: parsed });
        if (typeof b !== 'object') return;
        if (b.drop) { queueMicrotask(() => ws.onclose?.()); return; }
        if (b.ack === undefined) return;
        const reply = typeof b.ack === 'function' ? (b.ack as (m: Record<string, unknown>, n: number) => unknown)(parsed, n++) : b.ack;
        if (reply !== undefined) queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify(reply) }));
      },
      close() { closed.push(port); },
    };
    queueMicrotask(() => {
      if (b === 'refuse') ws.onerror?.();
      else if (typeof b === 'object' && b.hello !== undefined) ws.onmessage?.({ data: JSON.stringify(b.hello) });
    });
    return ws;
  };
  return { open, tried, sent, closed };
}

const HELLO = { type: 'hello', app: LINK_APP, v: 1 };
const HELLO_25 = { ...HELLO, version: '0.2.5' };
const HELLO_30 = { ...HELLO, version: '0.3.0', caps: ['id', 'key', 'follows', 'handover', 'requeue', 'config', 'facts'], limits: { text: 65536, picture: 4194304, reply: 4000 }, session: 's-1', wait: 45, configRev: 0 };
const ACK = { type: 'ack', v: 1, ok: true, number: 3, kept: 3, picture: true, queued: 2, agent: 'waiting' };
const push = { text: 'brief', page: 'Page' };
const fast = { timeoutMs: 20, ackTimeoutMs: 20 };

describe('ports', () => {
  it('lists the range and puts the remembered port first', () => {
    expect(linkPorts()).toEqual([47615, 47616, 47617, 47618, 47619]);
    expect(portOrder(null)).toEqual([47615, 47616, 47617, 47618, 47619]);
    expect(portOrder(47617)).toEqual([47617, 47615, 47616, 47618, 47619]);
    expect(portOrder(9999)).toEqual(linkPorts());
  });

  it('ranks copies newest first, then the remembered port, then the lower port', () => {
    const copies = [{ port: 47615, version: '0.2.5' }, { port: 47616 }, { port: 47617, version: '0.3.0' }, { port: 47618, version: '0.3.0' }];
    expect(rankCopies(copies).map(c => c.port)).toEqual([47617, 47618, 47615, 47616]);
    expect(rankCopies(copies, 47618).map(c => c.port)).toEqual([47618, 47617, 47615, 47616]);
    expect(rankCopies([{ port: 47616, version: '0.10.0' }, { port: 47615, version: '0.9.0' }]).map(c => c.port)).toEqual([47616, 47615]);
  });
});

describe('the hello', () => {
  it('reads version, capabilities, limits, session, wait and settings revision; old hellos have none', () => {
    expect(parseHello(HELLO_30, 47615)).toEqual({ port: 47615, version: '0.3.0', caps: HELLO_30.caps, limits: { text: 65536, picture: 4194304, reply: 4000 }, session: 's-1', wait: 45, configRev: 0 });
    expect(parseHello(HELLO_25, 47616)).toEqual({ port: 47616, version: '0.2.5', caps: [], limits: {} });
    expect(parseHello(HELLO, 47616)).toEqual({ port: 47616, caps: [], limits: {} });
    expect(parseHello({ ...HELLO, session: null, caps: ['ok', 7, '<b>'] }, 1)).toMatchObject({ caps: ['ok'] });
    expect(parseHello({ ...HELLO, app: 'other' }, 1)).toBeNull();
    expect(parseHello({ ...HELLO, v: 2 }, 1)).toBeNull();
  });

  it('a push carries only the fields the copy has a capability for', () => {
    const full = { text: 't', key: 'k1', follows: { answers: 3 }, handover: { after: 'a' } };
    expect(pushFor(full, parseHello(HELLO_25, 1)!)).toEqual({ text: 't' });
    expect(pushFor(full, parseHello(HELLO_30, 1)!)).toEqual(full);
    expect(pushFor(full, parseHello({ ...HELLO, caps: ['key'] }, 1)!)).toEqual({ text: 't', key: 'k1' });
  });
});

describe('sendSketch', () => {
  it('asks every port at once and pushes to the one that answers', async () => {
    const f = fake({ 47615: { hello: HELLO, ack: ACK } });
    const r = await sendSketch(push, { open: f.open, ...fast });
    expect(r).toMatchObject({ ok: true, port: 47615, number: 3, picture: true, queued: 2, agent: 'waiting' });
    expect(f.tried.sort()).toEqual(linkPorts());
    expect(f.sent).toEqual([{ port: 47615, data: { v: 1, type: 'sketch', text: 'brief', page: 'Page' } }]);
    expect(f.closed).toContain(47615);
  });

  it('prefers the newest copy, also over the remembered port', async () => {
    const f = fake({ 47615: { hello: HELLO_25, ack: ACK }, 47617: { hello: HELLO_30, ack: { ...ACK, id: 'a1b2c3d4e5f60718' } } });
    const r = await sendSketch(push, { open: f.open, preferred: 47615, ...fast });
    expect(r).toMatchObject({ ok: true, port: 47617, id: 'a1b2c3d4e5f60718' });
    expect(f.sent.map(s => s.port)).toEqual([47617]);
    expect(f.closed).toContain(47615);
  });

  it('among copies of one version, the remembered port', async () => {
    const f = fake({ 47615: { hello: HELLO_25, ack: ACK }, 47618: { hello: HELLO_25, ack: ACK } });
    expect(await sendSketch(push, { open: f.open, preferred: 47618, ...fast })).toMatchObject({ ok: true, port: 47618 });
  });

  it('moves past a port that accepts and says nothing', async () => {
    const f = fake({ 47615: 'silent', 47616: { hello: HELLO, ack: ACK } });
    const r = await sendSketch(push, { open: f.open, ...fast });
    expect(r).toMatchObject({ ok: true, port: 47616 });
    expect(f.sent.map(s => s.port)).toEqual([47616]);
  });

  it('sends nothing to a port whose first message is not Companion\'s hello', async () => {
    const f = fake({ 47615: { hello: { type: 'hello', app: 'something-else', v: 1 } } });
    expect(await sendSketch(push, { open: f.open, ...fast })).toEqual({ ok: false, reason: 'none' });
    expect(f.sent).toEqual([]);
  });

  it('reports not listening when nothing answers on the whole range', async () => {
    const f = fake({});
    expect(await sendSketch(push, { open: f.open, ...fast })).toEqual({ ok: false, reason: 'none' });
  });

  it('reports a listener that did not keep the sketch', async () => {
    const f = fake({ 47615: { hello: HELLO, ack: { type: 'ack', ok: false, error: 'The text is larger than 64 KB.' } } });
    expect(await sendSketch(push, { open: f.open, ...fast })).toEqual({ ok: false, reason: 'refused', error: 'The text is larger than 64 KB.' });
  });

  it('reports no answer after the push as lost: it may be kept', async () => {
    expect(await sendSketch(push, { open: fake({ 47615: { hello: HELLO } }).open, ...fast })).toMatchObject({ ok: false, reason: 'lost' });
    expect(await sendSketch(push, { open: fake({ 47615: { hello: HELLO, drop: true } }).open, ...fast })).toMatchObject({ ok: false, reason: 'lost' });
  });

  it('treats a socket that cannot be made as nothing there', async () => {
    expect(await sendSketch(push, { open: () => { throw new Error('blocked'); }, ...fast })).toEqual({ ok: false, reason: 'none' });
  });

  it('gives Companion\'s settings first to a copy that holds an older revision, and only then', async () => {
    const config = { rev: 5, config: { texts: { nothingYet: 'x' } } };
    const answer = (m: Record<string, unknown>) => (m.type === 'config' ? { type: 'ack', v: 1, ok: true, rev: 5, applied: true } : { ...ACK, id: 'a1' });
    const f = fake({ 47615: { hello: HELLO_30, ack: answer } });
    await sendSketch(push, { open: f.open, config, ...fast });
    expect(f.sent.map(s => s.data.type)).toEqual(['config', 'sketch']);
    expect(f.sent[0]!.data).toEqual({ v: 1, type: 'config', rev: 5, config: config.config });
    const g = fake({ 47615: { hello: { ...HELLO_30, configRev: 5 }, ack: answer } });
    await sendSketch(push, { open: g.open, config, ...fast });
    expect(g.sent.map(s => s.data.type)).toEqual(['sketch']);
    const old = fake({ 47615: { hello: HELLO_25, ack: answer } });
    await sendSketch(push, { open: old.open, config, ...fast });
    expect(old.sent.map(s => s.data.type)).toEqual(['sketch']);
  });
});

describe('deliverSketch: a retry never makes a second sketch', () => {
  it('a server with key gets the same key again after a lost answer and answers with the first sketch', async () => {
    const pushes: unknown[] = [];
    let first = true;
    const f = fake({ 47615: { hello: HELLO_30, ack: (m: Record<string, unknown>) => {
      if (m.type !== 'sketch') return undefined;
      pushes.push(m.key);
      if (first) { first = false; return undefined; }             // the first answer is lost
      return { ...ACK, id: 'a1', number: 7, duplicate: true };
    } } });
    const r = await deliverSketch({ ...push, key: 'k-1' }, { open: f.open, ...fast });
    expect(r).toMatchObject({ ok: true, number: 7, id: 'a1', dup: true });
    expect(pushes).toEqual(['k-1', 'k-1']);
  });

  it('an older server is looked up in its list after a lost answer: the row of this page made since the send is the sketch', async () => {
    const since = Date.now();
    const row = { number: 4, at: new Date(since + 50).toISOString(), page: 'Page', pageKey: 'pk', state: 'queued', rev: 1 };
    const older = { ...row, number: 3, at: new Date(since - 60_000).toISOString() };
    let sketches = 0;
    const f = fake({ 47615: { hello: HELLO_25, ack: (m: Record<string, unknown>) => {
      if (m.type === 'sketch') { sketches++; return undefined; }
      return { type: 'status', v: 1, rev: 1, agent: 'none', sketches: [older, row] };
    } } });
    const r = await deliverSketch({ ...push, pageKey: 'pk' }, { open: f.open, ...fast }, { since });
    expect(r).toMatchObject({ ok: true, number: 4, found: true });
    expect(sketches).toBe(1);
  });

  it('a retry by the page (the worker gave no answer) looks first and sends nothing when the sketch is there', async () => {
    const since = Date.now();
    let sketches = 0;
    const f = fake({ 47615: { hello: HELLO_25, ack: (m: Record<string, unknown>) => {
      if (m.type === 'sketch') { sketches++; return ACK; }
      return { type: 'status', v: 1, rev: 1, agent: 'none', sketches: [{ number: 9, at: new Date(since + 10).toISOString(), page: '', pageKey: 'pk', state: 'queued', rev: 1 }] };
    } } });
    expect(await deliverSketch({ ...push, pageKey: 'pk' }, { open: f.open, ...fast }, { retry: true, since })).toMatchObject({ ok: true, number: 9, found: true });
    expect(sketches).toBe(0);
  });

  it('a retry with a key goes straight to the server, which keeps it once', async () => {
    const keys: unknown[] = [];
    const f = fake({ 47615: { hello: HELLO_30, ack: (m: Record<string, unknown>) => (m.type === 'sketch' ? (keys.push(m.key), { ...ACK, id: 'a1', duplicate: true }) : { type: 'status', v: 1, rev: 1, agent: 'none', sketches: [] }) } });
    expect(await deliverSketch({ ...push, key: 'k-2' }, { open: f.open, ...fast }, { retry: true })).toMatchObject({ ok: true, dup: true });
    expect(keys).toEqual(['k-2']);
  });
});

describe('fetchStatus', () => {
  const ROW = { number: 1, at: '2026-11-20T10:00:00.000Z', page: 'Page', pageKey: 'k', state: 'done', rev: 4, reply: { text: 'Done.', at: '2026-11-20T10:01:00.000Z' } };
  const STATUS = { type: 'status', v: 1, rev: 4, agent: 'recent', sketches: [ROW, { nope: true }] };

  it('an older listener: the rows that are well formed, the version, which copies answered', async () => {
    const f = fake({ 47616: { hello: HELLO_25, ack: STATUS } });
    const r = await fetchStatus({ open: f.open, ...fast });
    expect(r).toEqual({ ok: true, port: 47616, rev: 4, agent: 'recent', sketches: [ROW], version: '0.2.5', caps: [], answered: [{ port: 47616, version: '0.2.5' }] });
    expect(f.sent[0]!.data).toEqual({ v: 1, type: 'status' });
  });

  it('0.3.0: ids, taken facts, copies, wait, session and the settings revision; an unknown state reads by whether it is open', async () => {
    const row = { id: 'a1b2', number: 8, at: '2026-11-20T10:00:00.000Z', page: 'P', pageKey: 'k', state: 'taken', open: true, rev: 9, takenAt: '2026-11-20T10:00:05.000Z', takenBy: { copy: 'c1', client: 'cli', alive: false }, requeued: 1 };
    const custom = { id: 'c3', number: 9, at: '2026-11-20T10:00:00.000Z', state: 'review', open: true, word: 'Waiting for review', rev: 10 };
    const gone = { id: 'c4', number: 10, at: '2026-11-20T10:00:00.000Z', state: 'withdrawn', open: false, rev: 11 };
    const msg = { type: 'status', v: 1, rev: 11, agent: 'waiting', session: 's-1', wait: 45, configRev: 7, copies: [{ copy: 'c1', client: 'cli', alive: true, waiting: 1, beatAt: 'b', lastCallAt: 'l', wait: 45 }], sketches: [row, custom, gone] };
    const r = await fetchStatus({ open: fake({ 47615: { hello: HELLO_30, ack: msg } }).open, ...fast });
    expect(r).toMatchObject({ ok: true, version: '0.3.0', session: 's-1', wait: 45, configRev: 7, copies: [{ copy: 'c1', client: 'cli', alive: true, waiting: 1, beatAt: 'b', lastCallAt: 'l' }] });
    if (!r.ok) throw new Error('not ok');
    expect(r.sketches[0]).toEqual({ id: 'a1b2', number: 8, at: row.at, page: 'P', pageKey: 'k', state: 'taken', rev: 9, takenAt: row.takenAt, takenBy: { copy: 'c1', client: 'cli', alive: false }, requeued: 1 });
    expect(r.sketches[1]).toMatchObject({ state: 'working', word: 'Waiting for review' });
    expect(r.sketches[2]).toMatchObject({ state: 'done', word: 'Withdrawn' });
  });

  it('asks the next copy when the best one says nothing', async () => {
    const f = fake({ 47615: { hello: HELLO_30 }, 47616: { hello: HELLO_25, ack: STATUS } });
    expect(await fetchStatus({ open: f.open, ...fast })).toMatchObject({ ok: true, port: 47616 });
  });

  it('is not ok when nothing listens, and an unknown agent word reads as none', async () => {
    expect(await fetchStatus({ open: fake({}).open, ...fast })).toEqual({ ok: false });
    const f = fake({ 47615: { hello: HELLO, ack: { ...STATUS, agent: 'sleeping', sketches: [] } } });
    expect(await fetchStatus({ open: f.open, ...fast })).toMatchObject({ ok: true, agent: 'none', sketches: [] });
  });

  it('carries no version from a listener too old to say it, or a malformed one', async () => {
    expect(await fetchStatus({ open: fake({ 47615: { hello: HELLO, ack: STATUS } }).open, ...fast })).not.toHaveProperty('version');
    const odd = fake({ 47615: { hello: { ...HELLO, version: '<b>1</b>' }, ack: STATUS } });
    expect(await fetchStatus({ open: odd.open, ...fast })).not.toHaveProperty('version');
  });
});

describe('requeueSketch', () => {
  it('puts a sketch back in line on a server with requeue', async () => {
    const f = fake({ 47615: { hello: HELLO_30, ack: { type: 'ack', v: 1, ok: true, id: 'a1', number: 4, state: 'queued' } } });
    expect(await requeueSketch('a1', { open: f.open, ...fast })).toEqual({ ok: true, number: 4 });
    expect(f.sent[0]!.data).toEqual({ v: 1, type: 'requeue', id: 'a1' });
  });

  it('sends nothing to an older server, and says so', async () => {
    const f = fake({ 47615: { hello: HELLO_25, ack: ACK } });
    expect(await requeueSketch('a1', { open: f.open, ...fast })).toEqual({ ok: false, reason: 'unsupported' });
    expect(f.sent).toEqual([]);
    expect(await requeueSketch('a1', { open: fake({}).open, ...fast })).toEqual({ ok: false, reason: 'none' });
  });
});

describe('fitSize', () => {
  it('scales the long side down and never up', () => {
    expect(fitSize(3136, 1568, 1568)).toEqual({ width: 1568, height: 784 });
    expect(fitSize(1000, 4000, 1568)).toEqual({ width: 392, height: 1568 });
    expect(fitSize(800, 600, 1568)).toEqual({ width: 800, height: 600 });
  });
});

describe('the shipped desktop extension', () => {
  it('has the version of claude-desktop/manifest.json, and the file name says it', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '../../../claude-desktop/manifest.json'), 'utf8')) as { version: string };
    expect(DESKTOP_EXTENSION_VERSION).toBe(manifest.version);
    expect(DESKTOP_BUNDLE_NAME).toBe(`configuration-companion-${manifest.version}.mcpb`);
  });

  it('compares versions by number; an unknown version is older', () => {
    expect(versionBelow('0.2.1', '0.2.2')).toBe(true);
    expect(versionBelow('0.2.2', '0.2.2')).toBe(false);
    expect(versionBelow('0.10.0', '0.2.2')).toBe(false);
    expect(versionBelow('1.0.0', '0.9.9')).toBe(false);
    expect(versionBelow(undefined, '0.2.2')).toBe(true);
    expect(versionBelow('dev', '0.2.2')).toBe(true);
  });
});

describe('the working chat', () => {
  it('links to a new Claude Desktop chat with the opening text, not sent', () => {
    const link = workingChatLink();
    expect(link.startsWith('claude://code/new?q=')).toBe(true);
    expect(decodeURIComponent(link.slice('claude://code/new?q='.length))).toBe(WORKING_CHAT_OPENING);
    expect(link.length).toBeLessThan(14000);
    expect(WORKING_CHAT_OPENING).toMatch(/next_sketch/);
    expect(WORKING_CHAT_OPENING).toMatch(/reply/);
    // The loop policy travels with it.
    expect(WORKING_CHAT_OPENING).toMatch(/Do not stop by yourself/);
    expect(WORKING_CHAT_OPENING).toMatch(/fails or times out, call next_sketch again/);
  });

  it('names every state in plain words and counts only answered sketches as news', () => {
    expect(Object.keys(STATE_WORDS).sort()).toEqual(['cannot', 'done', 'question', 'queued', 'taken', 'working']);
    expect(STATE_WORDS.queued).toBe('Waiting for Claude');
    const base = { number: 1, at: 'x', page: '', pageKey: '', state: 'done' as const, rev: 3 };
    const answered = { ...base, reply: { text: 'a', at: 'x' } };
    expect(isNews(answered, { '1': 2 })).toBe(true);
    expect(isNews(answered, { '1': 3 })).toBe(false);
    expect(isNews(answered, { '2': 9 })).toBe(true);
    expect(isNews(base, {})).toBe(false);
  });
});
