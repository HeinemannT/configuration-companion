// The socket in one process: hello, push, status, idle sockets, the socket limit, origins, Host, ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { createSession } from '../src/session.js';
import { startLink, MAX_CLIENTS } from '../src/link.js';
import { CAPS } from '../src/protocol.js';
import { converse, ORIGIN } from './host/browser.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function withLink(fn, o = {}) {
  const store = createSession();
  const link = await startLink(store, { basePort: 0, facts: () => ({ wait: 45 }), ...o });
  try { await fn(link.port, store); } finally { await link.close(); store.close(); }
}

test('link: the hello names version, caps, limits, session, wait and the settings rev', () => withLink(async (port, store) => {
  const r = await converse(port, { type: 'status' });
  assert.deepEqual([r.hello.type, r.hello.app, r.hello.v, r.hello.version, r.hello.fmt], ['hello', 'configuration-companion-link', 1, '0.3.1', 1]);
  assert.deepEqual(r.hello.caps, CAPS);
  assert.equal(r.hello.limits.text, 65536);
  assert.equal(r.hello.limits.reply, 4000);
  assert.deepEqual([r.hello.session, r.hello.wait, r.hello.configRev], [null, 45, 0]);
  store.add({ text: 'x', page: 'P' });
  assert.match((await converse(port, { type: 'status' })).hello.session, /^s-/);
}));

test('link: push acknowledges with id and number; status carries facts and no briefs', () => withLink(async (port) => {
  const a = (await converse(port, { type: 'sketch', text: 'secret brief', page: 'P', key: 'k1', ref: 'r1' })).answer;
  assert.deepEqual([a.type, a.ok, a.number, a.kept, a.queued, a.picture, a.ref], ['ack', true, 1, 1, 1, false, 'r1']);
  assert.match(a.id, /^[0-9a-f]{16}$/);
  const s = (await converse(port, { type: 'status' })).answer;
  assert.equal(s.type, 'status');
  assert.ok(!JSON.stringify(s).includes('secret brief'));
  assert.deepEqual(Object.keys(s.sketches[0]).sort(), ['at', 'handed', 'id', 'number', 'open', 'page', 'pageKey', 'requeued', 'rev', 'state'].sort());
  for (const k of ['rev', 'agent', 'session', 'waiters', 'lastCallAt', 'copies', 'version', 'configRev', 'now', 'wait']) assert.ok(k in s, k);
  assert.equal(s.copies[0].alive, true);
}));

test('link: an idle socket is closed; with more than the limit the oldest goes and the new one is served', () => withLink(async (port) => {
  const idle = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
  let closed = false;
  idle.on('close', () => { closed = true; });
  await sleep(600);
  assert.equal(closed, true, 'idle socket closed');
  const held = [];
  for (let i = 0; i < MAX_CLIENTS + 2; i++) held.push(new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN }));
  await sleep(200);
  const r = await converse(port, { type: 'status' });
  assert.equal(r.answer.type, 'status');
  for (const h of held) h.terminate();
}, { idleMs: 300 }));

test('link: refuses web pages, missing origins, foreign Host names, binary frames; settings origins narrow it', () => withLink(async (port, store) => {
  assert.ok((await converse(port, { type: 'status' }, { origin: 'https://example.com' })).none);
  assert.ok((await converse(port, { type: 'status' }, { headers: { Host: `evil.example:${port}` } })).none);
  const bin = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
    let n = 0;
    ws.on('message', (d) => { if (++n === 1) ws.send(Buffer.from([1, 2, 3])); else { ws.terminate(); resolve(JSON.parse(String(d))); } });
  });
  assert.equal(bin.ok, false);
  const self = 'a'.repeat(32);
  const r = (await converse(port, { type: 'config', rev: 1, config: { origins: [self] } })).answer;
  assert.deepEqual([r.ok, r.applied], [true, true]);
  store.settings.reload();
  await sleep(1100);
  assert.ok((await converse(port, { type: 'status' }, { origin: `chrome-extension://${'b'.repeat(32)}` })).none, 'another extension is shut out');
  assert.equal((await converse(port, { type: 'status' })).answer.configRev, 1);
}));

test('link: listens on loopback only and falls back to the next port when one is taken', async () => {
  const blocker = net.createServer().listen(47700, '127.0.0.1');
  await new Promise(r => blocker.once('listening', r));
  const store = createSession();
  try {
    const link = await startLink(store, { basePort: 47700, count: 3 });
    try {
      assert.equal(link.port, 47701);
      const r = await converse(47701, { type: 'status' });
      assert.equal(r.answer.type, 'status');
    } finally { await link.close(); }
  } finally { store.close(); blocker.close(); }
});
