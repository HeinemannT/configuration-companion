// Host scenarios: real server processes under a Desktop-faithful host (test/host/desktop.js), driven by a scripted
// browser and agents. Each review reproduction (p1, p2, p8 in the final review) has its regression here; the
// in-process ones are in ../regressions.test.js. Ports 47730-47789 only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rig, sleep, textOf, until } from './rig.js';
import { converse, ORIGIN } from './browser.js';
import { ScriptedAgent, nextStep } from './agent.js';

// Blocks of 5 ports, used in turn: the tests run one after another and each closes its copies.
let slot = 0;
const nextPort = () => 47730 + (slot++ % 11) * 5;
const brief = (page, words) => `Change request for a Corporater BMP page.\n\nPage: "${page}" (Scorecard, ID ${page.toLowerCase()})\n\n1. Comment on Table ID t1. The user says: "${words}"`;
const call = async (m, name, args = {}) => { const r = await m.call(name, args); assert.equal(r.error, undefined, `${name} failed: ${r.error}`); return textOf(r); };

test('A: the only copy replaced: its queued sketch is still handed out, numbers go on, a reply lands on the right sketch (p1, p6)', async () => {
  const r = await rig({ port: nextPort() });
  try {
    const a1 = await r.browser.push({ text: brief('Supplier risk', 'OLD sketch'), page: 'Supplier risk' });
    assert.equal(a1.number, 1);
    const s1 = (await r.browser.status()).session;
    await r.m().restart('replaced', 300);         // Desktop replaces its only copy
    const st = await until(() => r.browser.status(), 5000, 'status');
    assert.equal(st.session, s1, 'the session survives the copy');
    assert.equal(st.sketches[0].state, 'queued');
    const got = await call(r.m(), 'next_sketch');
    assert.match(got, /^Sketch 1 \(id [0-9a-f]{16}\)/);
    assert.match(got, /OLD sketch/);
    const a2 = await r.browser.push({ text: brief('Audit plan', 'NEW sketch'), page: 'Audit plan' });
    assert.equal(a2.number, 2, 'numbers never start again');
    assert.notEqual(a2.id, a1.id);
    assert.match(await call(r.m(), 'reply', { number: 1, status: 'done', text: 'Moved the supplier table.' }), /^Recorded/);
    const rows = (await r.browser.status()).sketches;
    assert.equal(rows.find(x => x.number === 1).reply.text, 'Moved the supplier table.');
    assert.equal(rows.find(x => x.number === 2).state, 'queued');
  } finally { await r.done(); }
});

test('A: a reply for a sketch never handed out is refused with the next step; next_sketch then hands it (p1 P3)', async () => {
  const r = await rig({ port: nextPort() });
  try {
    await r.browser.push({ text: brief('X', 'never delivered'), page: 'X' });
    const t = await call(r.m(), 'reply', { number: 1, status: 'done', text: 'x' });
    assert.match(t, /has not been handed to a chat yet/);
    assert.deepEqual(nextStep(t), { tool: 'next_sketch' });
    assert.match(await call(r.m(), 'next_sketch'), /^Sketch 1 /);
  } finally { await r.done(); }
});

test('A: bad reply inputs give texts with the next step, never a protocol error (p1 P9)', async () => {
  const r = await rig({ port: nextPort() });
  try {
    await r.browser.push({ text: brief('X', 'x'), page: 'X' });
    await call(r.m(), 'next_sketch');
    const raw = async (args) => { const x = await r.m().call('reply', args); assert.equal(x.error, undefined); assert.notEqual(x.result.isError, true); return textOf(x); };
    const long = await raw({ number: 1, status: 'done', text: 'y'.repeat(4001) });
    assert.match(long, /^Recorded\. Your text was longer than 4000 characters and was cut\. Call next_sketch now\.$/);
    assert.match(await raw({ number: 1, status: 'completed', text: 'y' }), /"completed" is not a status for reply\. Use one of: done, working, question or cannot\. Call reply again with number 1\./);
    assert.match(await raw({ number: 99, status: 'done', text: 'y' }), /Sketch 99 is not in this session \(kept: 1\)\. .*call next_sketch\./);
    assert.match(await raw({ number: '1', status: 'DONE', text: 'string number' }), /^Recorded/);
    assert.match(await raw({}), /reply needs the number/);
    assert.match(await raw({ number: 1, status: 'done' }), /reply needs a text.*Call reply again with number 1\./);
    assert.match(await raw({ number: 'abc!', status: 'done', text: 'x' }), /reply needs the number/);
    const extra = await r.m().call('reply', { number: 1, status: 'done', text: 'x', unknownField: true });
    assert.match(textOf(extra), /^Recorded/);
  } finally { await r.done(); }
});

test('A: a push whose answer was lost and is sent again with its key gives one sketch (p2 P2); old browsers without a key still push', async () => {
  const r = await rig({ port: nextPort() });
  try {
    const first = await r.browser.push({ text: brief('P', 'Delete widget W1'), page: 'P', key: 'retry-1', drop: true });
    assert.equal(first.dropped, true);
    await sleep(300);
    const again = await r.browser.push({ text: brief('P', 'Delete widget W1'), page: 'P', key: 'retry-1' });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(again.number, 1);
    const st = await r.browser.status();
    assert.equal(st.sketches.length, 1);
    r.browser.shape = 'old';
    const old = await r.browser.push({ text: brief('P', 'old browser'), page: 'P' });
    assert.equal(old.ok, true);
    assert.equal(old.number, 2);
  } finally { await r.done(); }
});

test('A: a new next_sketch ends the older wait of the same connection; the abandoned wait never wins the sketch (p2 P5)', async () => {
  const r = await rig({ port: nextPort(), wait: 6 });
  try {
    const m = r.m();
    // The host stopped caring about the first call without telling the server (no cancel), then the chat calls again.
    const p1 = m.client.callTool({ name: 'next_sketch', arguments: {} }, undefined, { timeout: 30_000 });
    await sleep(1500);
    const p2 = m.client.callTool({ name: 'next_sketch', arguments: {} }, undefined, { timeout: 30_000 });
    const t1 = textOf(await p1);
    assert.match(t1, /replaced by a newer next_sketch call\. Use the result of the newer call\. If you have none, call next_sketch again\./);
    await sleep(300);
    await r.browser.push({ text: brief('P', 'Third'), page: 'P' });
    assert.match(textOf(await p2), /^Sketch 1 /);
  } finally { await r.done(); }
});

test('A: a cancelled wait never takes a sketch', async () => {
  const r = await rig({ port: nextPort(), wait: 6 });
  try {
    const m = r.m();
    const ac = new AbortController();
    const p = m.client.callTool({ name: 'next_sketch', arguments: {} }, undefined, { timeout: 30_000, signal: ac.signal }).catch(e => e);
    await sleep(800);
    ac.abort();
    await p;
    await sleep(200);
    await r.browser.push({ text: brief('P', 'after cancel'), page: 'P' });
    await sleep(800);
    assert.equal((await r.browser.status()).sketches[0].state, 'queued', 'the cancelled wait left it');
    assert.match(await call(m, 'next_sketch'), /^Sketch 1 /);
  } finally { await r.done(); }
});

test('A: a sketch whose taker was killed is handed to the other chat, saying it was handed out before (p2 P4)', async () => {
  const r = await rig({ port: nextPort(), copies: 2 });
  try {
    await r.browser.push({ text: brief('P', 'Fourth'), page: 'P' });
    assert.match(await call(r.m(0), 'next_sketch'), /^Sketch 1 /);
    assert.match(await call(r.m(1), 'next_sketch'), /^Nothing yet/);
    // The taker waits in next_sketch when it is killed: status must not count its wait (p2: "agent" stayed "recent"/waiting).
    const dying = r.m(0).client.callTool({ name: 'next_sketch', arguments: {} }, undefined, { timeout: 30_000 }).catch(() => null);
    await sleep(400);
    r.m(0).kill('test');
    await dying;
    // The kill is not instant on every system: ask until the copy is seen as gone.
    let after = await r.browser.status();
    for (const end = Date.now() + 5_000; after.sketches[0].takenBy.alive !== false && Date.now() < end;) { await sleep(100); after = await r.browser.status(); }
    assert.equal(after.waiters, 0, 'a killed copy does not count as waiting');
    assert.equal(after.sketches[0].takenBy.alive, false, 'the taker is shown as gone');
    const t0 = Date.now();
    let got = '';
    while (!/^Sketch 1 /.test(got) && Date.now() - t0 < 15_000) got = await call(r.m(1), 'next_sketch');
    assert.match(got, /This sketch was handed out before/);
    assert.match(got, /Check what is already done in BMP before you change anything\./);
    assert.ok(Date.now() - t0 < 8000, `requeued within one wait (${Date.now() - t0} ms)`);
  } finally { await r.done(); }
});

test('A: the same connection calling next_sketch again without replying gets its sketch again, once', async () => {
  const r = await rig({ port: nextPort() });
  try {
    await r.browser.push({ text: brief('P', 'lost result'), page: 'P' });
    await r.browser.push({ text: brief('Q', 'second'), page: 'Q' });
    assert.match(await call(r.m(), 'next_sketch'), /^Sketch 1 /);
    const again = await call(r.m(), 'next_sketch');
    assert.match(again, /^Sketch 1 /);
    assert.match(again, /You took this sketch at \d\d:\d\d and did not reply\./);
    assert.match(await call(r.m(), 'next_sketch'), /^Sketch 2 /, 'only once: then the queue');
    const st = await r.browser.status();
    assert.equal(st.sketches[0].handed, 2);
  } finally { await r.done(); }
});

test('A: the link: unknown types and versions answered, idle sockets closed, the ninth socket gets through (p2 P7)', async () => {
  const r = await rig({ port: nextPort() });
  try {
    const port = r.ports[0];
    const v2 = await converse(port, { type: 'sketch', text: 'x', v: 2 });
    assert.equal(v2.answer.ok, false);
    const unknown = await converse(port, { type: 'shout', ref: 'r1' });
    assert.deepEqual([unknown.answer.ok, unknown.answer.unknown, unknown.answer.got, unknown.answer.ref], [false, true, 'shout', 'r1']);
    assert.ok((await converse(port, { type: 'status' }, { origin: 'https://evil.example' })).none);
    assert.ok((await converse(port, { type: 'status' }, { origin: 'moz-extension://abc' })).none);
    const { default: WebSocket } = await import('ws');
    const held = [];
    for (let i = 0; i < 9; i++) held.push(new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN }));
    await sleep(500);
    const real = await converse(port, { type: 'status' });
    assert.equal(real.answer.type, 'status', 'the real extension gets through');
    for (const s of held) s.terminate();
  } finally { await r.done(); }
});

test('A: more open sketches than the kept window are all handed out (B8)', async () => {
  const r = await rig({ port: nextPort() });
  try {
    for (let i = 1; i <= 36; i++) assert.equal((await r.browser.push({ text: brief(`P${i}`, `n${i}`), page: `P${i}` })).number, i);
    const seen = [];
    for (let i = 0; i < 36; i++) {
      const t = await call(r.m(), 'next_sketch');
      const n = Number(/^Sketch (\d+) /.exec(t)?.[1]);
      seen.push(n);
      await call(r.m(), 'reply', { number: n, status: 'done', text: `ok ${n}` });
    }
    assert.deepEqual(seen, Array.from({ length: 36 }, (_, i) => i + 1));
    assert.match(await call(r.m(), 'next_sketch'), /^Nothing yet/);
  } finally { await r.done(); }
});

test('Desktop restart with queued sketches: every copy killed and started together, the queue is handed out in order', async () => {
  const r = await rig({ port: nextPort(), copies: 3 });
  try {
    for (let i = 1; i <= 3; i++) await r.browser.push({ text: brief(`P${i}`, `q${i}`), page: `P${i}` });
    await r.host.restartAll(100);
    await sleep(300);
    for (let i = 1; i <= 3; i++) {
      const t = await call(r.m(1), 'next_sketch');
      assert.match(t, new RegExp(`^Sketch ${i} `));
      assert.doesNotMatch(t, /handed out before/);
      await call(r.m(1), 'reply', { number: i, status: 'done', text: `d${i}` });
    }
    assert.equal((await r.browser.push({ text: brief('P4', 'q4'), page: 'P4' })).number, 4);
  } finally { await r.done(); }
});

test('three copies, two looping agents, a kill between take and result: every sketch closed, each handed once unless said so', async () => {
  const r = await rig({ port: nextPort(), copies: 3, wait: 2 });
  try {
    const agents = [0, 1].map(i => new ScriptedAgent({ name: `chat${i}`, manager: r.m(i), ledger: r.ledger, questions: 0, working: 0.2, bad: 0.1 }).start());
    const live = [];
    for (let i = 1; i <= 14; i++) {
      const ack = await r.browser.push({ text: brief(`P${i}`, `s${i}`), page: `P${i}` });
      r.ledger.pushed(ack, { key: ack.key });
      if (i === 5 || i === 10) { await sleep(Math.floor(Math.random() * 15)); r.m(i === 5 ? 0 : 1).restart('chaos', 400); r.ledger.counts.kills++; }
      await sleep(150 + Math.floor(Math.random() * 300));
      if (i % 4 === 0) { const all = await r.browser.statusAll(); r.ledger.compareCopies(all); live.push(all.length); }
    }
    await until(async () => { const st = await r.browser.status(); return st && st.sketches.every(s => !s.open); }, 60_000, 'every sketch closed');
    for (const a of agents) a.stopped = true;
    await Promise.all(agents.map(a => a.done));
    r.ledger.finalCheck(await r.browser.status());
    assert.deepEqual(r.ledger.violations, []);
    assert.ok(live.every(n => n === 3), 'three copies answer status');
  } finally { await r.done(); }
});

test('an unwritable folder: the server runs, pushes are refused with a reason, tools give a next step', async () => {
  const dir = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'cc-ro-'));
  const file = join(dir, 'not-a-folder');
  writeFileSync(file, 'x');
  const r = await rig({ port: nextPort(), base: join(file, 'Sessions') });
  try {
    const ack = await r.browser.push({ text: brief('P', 'x'), page: 'P' });
    assert.equal(ack.refused, true);
    assert.match(ack.error, /could not be saved/);
    assert.deepEqual(nextStep(await call(r.m(), 'next_sketch')), { tool: 'next_sketch' });
    assert.deepEqual(nextStep(await call(r.m(), 'reply', { number: 1, status: 'done', text: 'x' })), { tool: 'next_sketch' });
    assert.match(await call(r.m(), 'list_sketches'), /call next_sketch/i);
    assert.equal(r.m().alive, true, 'still running');
  } finally { await r.done(); }
});

test('settings changed mid-run by the browser: texts, states, wait, limits; fixed steps stay; bad or older settings refused', async () => {
  const r = await rig({ port: nextPort(), wait: 0 });
  try {
    assert.equal((await r.browser.status()).configRev, 0);
    const bad = await r.browser.config(1, { wait: { default: 5 } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /wait\.default is not between 10 and 600/);
    const locked = await r.browser.config(1, { origins: ['b'.repeat(32)] });
    assert.equal(locked.ok, false, 'cannot shut itself out');
    const ok = await r.browser.config(3, {
      wait: { byClient: [{ match: 'local-agent-mode-*', seconds: 12 }] },
      texts: { nothingYet: 'Still nothing.', afterDone: 'Thanks, noted.' },
      states: [{ name: 'review', open: false, word: 'For review' }],
      limits: { replyChars: 300 },
      future: { ignored: true },
    });
    assert.deepEqual([ok.ok, ok.applied, ok.rev], [true, true, 3]);
    assert.deepEqual([(await r.browser.config(2, {})).applied], [false], 'a lower rev is not applied');
    const st = await until(async () => { const s = await r.browser.status(); return s.configRev === 3 && s.wait === 12 ? s : null; }, 4000, 'settings in force');
    assert.equal(st.wait, 12);
    assert.equal((await converse(r.ports[0], { type: 'status' })).hello.configRev, 3);
    await r.browser.push({ text: brief('P', 'x'), page: 'P' });
    const h = await call(r.m(), 'next_sketch');
    assert.match(h, /call reply with number 1 \(status done, working, question, cannot or review\)\. Then call next_sketch\.$/);
    const t = await call(r.m(), 'reply', { number: 1, status: 'review', text: 'z'.repeat(400) });
    assert.match(t, /^Thanks, noted\. Your text was longer than 300 characters and was cut\. Call next_sketch now\.$/);
    const row = (await r.browser.status()).sketches[0];
    assert.deepEqual([row.state, row.open, row.word, row.reply.text.length], ['review', false, 'For review', 300]);
    assert.ok(existsSync(join(r.base, '.config.json')));
  } finally { await r.done(); }
});

test('old browser shapes: push and status as 0.19.1 to feat/0.18 send and read them', async () => {
  const r = await rig({ port: nextPort(), shape: 'old' });
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const ack = await r.browser.push({ text: 'Answer to sketch 9: the left one', page: 'Home', pageKey: '/home', picture: { mime: 'image/png', data: png, drawn: true } });
    assert.deepEqual([ack.ok, ack.number, ack.picture, ack.queued, ['waiting', 'recent', 'none'].includes(ack.agent)], [true, 1, true, 1, true]);
    const before = await r.browser.status();
    const row = before.sketches[0];
    // What claude-link.ts isRow() needs, and the fields the dock reads.
    assert.equal(typeof row.number, 'number'); assert.equal(typeof row.at, 'string'); assert.equal(typeof row.state, 'string');
    assert.equal(row.pageKey, '/home'); assert.equal(typeof row.rev, 'number');
    assert.ok(['waiting', 'recent', 'none'].includes(before.agent));
    assert.match(before.version ?? (await converse(r.ports[0], { type: 'status' })).hello.version, /^\d+\.\d+\.\d+$/);
    const h = await call(r.m(), 'next_sketch');
    assert.match(h, /The picture is drawn from the page layout/);
    assert.match(h, /Sketch 9 is no longer kept\./);
    await call(r.m(), 'reply', { number: 1, status: 'done', text: 'Done.' });
    const after = await r.browser.status();
    assert.ok(after.rev > before.rev && after.sketches[0].rev > row.rev, 'revs grow for the "news" mark');
    assert.ok(['queued', 'taken', 'working', 'done', 'question', 'cannot'].includes(after.sketches[0].state));
  } finally { await r.done(); }
});

test('Send again and withdraw: a done sketch comes back saying so, with its last reply; a withdrawn one is never handed', async () => {
  const r = await rig({ port: nextPort() });
  try {
    const a = await r.browser.push({ text: brief('P', 'redo me'), page: 'P' });
    const b = await r.browser.push({ text: brief('Q', 'withdraw me'), page: 'Q' });
    assert.match(await call(r.m(), 'next_sketch'), /^Sketch 1 /);
    await call(r.m(), 'reply', { number: 1, status: 'done', text: 'Made it blue.' });
    const w = await r.browser.withdraw(b.id);
    assert.deepEqual([w.ok, w.state], [true, 'withdrawn']);
    const q = await r.browser.requeue(a.id);
    assert.deepEqual([q.ok, q.number, q.state], [true, 1, 'queued']);
    const again = await call(r.m(), 'next_sketch');
    assert.match(again, /^Sketch 1 .*\n\nThis sketch was handed out before, last at \d\d:\d\d\. It has no answer yet\./s);
    assert.match(again, /The last reply to it was \(done\): "Made it blue\."/);
    assert.match(await call(r.m(), 'reply', { number: 2, status: 'done', text: 'x' }), /withdrew sketch 2/);
    await call(r.m(), 'reply', { number: 1, status: 'done', text: 'Made it green.' });
    assert.match(await call(r.m(), 'next_sketch'), /^Nothing yet/);
  } finally { await r.done(); }
});

test('adaptive wait: a host that cuts waits at 3 s twice makes the wait shrink under it; no reinstall', async () => {
  const r = await rig({ port: nextPort(), wait: 6, timeoutMs: 3000, env: { COMPANION_LEARN_SCALE: '0.1' } });
  try {
    const first = await r.m().call('next_sketch');
    assert.equal(first.error, 'timeout');
    const second = await r.m().call('next_sketch');
    assert.equal(second.error, 'timeout');
    const third = await r.m().call('next_sketch');
    assert.equal(third.error, undefined, 'the third wait fits');
    assert.match(textOf(third), /^Nothing yet/);
    assert.ok(third.ms < 3000);
    const learned = JSON.parse(readFileSync(join(r.base, '.learned.json'), 'utf8')).clients['local-agent-mode-Configuration Companion'];
    assert.ok(learned.waitMs >= 1500 && learned.waitMs <= 2000, `learned ${learned.waitMs}`);
    assert.equal(r.host.timeouts().length, 2);
  } finally { await r.done(); }
});

test('handover and follows from a new browser: text around the brief, structured answer and corrections, the fixed line last', async () => {
  const r = await rig({ port: nextPort() });
  try {
    const a = await r.browser.push({ text: 'Page: "Home"\n\n1. Comment on Card ID c1. The user says: "smaller"\n2. Comment on Chart ID c2. The user says: "blue"', page: 'Home' });
    await call(r.m(), 'next_sketch');
    await call(r.m(), 'reply', { number: 1, status: 'question', text: 'Which card?' });
    await r.browser.push({ text: 'The left one.', page: 'Home', follows: { answers: a.id }, handover: { before: 'Answer from the page for sketch {number}.', after: 'Say which card you changed.' } });
    const h = await call(r.m(), 'next_sketch');
    assert.match(h, /This is the user's answer to your question on sketch 1\. .*Reply with number 2; that also closes sketch 1\./s);
    assert.match(h, /Answer from the page for sketch 2\.\n\nThe left one\./);
    assert.match(h, /Say which card you changed\.\nConfiguration Companion 0\.3\.\d+\.\nSketch 2: when it is done, or you cannot do it, call reply with number 2 \(status done, working, question or cannot\)\. Then call next_sketch\.$/);
    assert.doesNotMatch(h, /The user sees the first sentence/, 'after replaces the built-in advice');
    const t = await call(r.m(), 'reply', { number: 2, status: 'done', text: 'Made the left card smaller.' });
    assert.match(t, /The same reply was recorded for sketch 1, whose question it answers\./);
    await r.browser.push({ text: '1. Comment on Chart ID c2. The user says: "green"', page: 'Home', follows: { corrects: [{ sketch: 1, marks: [2] }] } });
    const c = await call(r.m(), 'next_sketch');
    assert.match(c, /Marks in this sketch correct marks of an earlier sketch\.[\s\S]*the mark corrected:\n2\. Comment on Chart ID c2\. The user says: "blue"/);
    const rows = (await r.browser.status()).sketches;
    assert.equal(rows.find(x => x.number === 1).state, 'done');
  } finally { await r.done(); }
});

test('a copy that finds a folder of a newer format only reads, and says what to do', async () => {
  const r = await rig({ port: nextPort() });
  try {
    await r.browser.push({ text: brief('P', 'x'), page: 'P' });
    const ptr = JSON.parse(readFileSync(join(r.base, '.current.json'), 'utf8'));
    writeFileSync(join(r.base, '.current.json'), JSON.stringify({ ...ptr, fmt: 2 }));
    const ack = await r.browser.push({ text: brief('P', 'y'), page: 'P' });
    assert.match(ack.error, /newer version/);
    const t = await call(r.m(), 'next_sketch');
    assert.match(t, /only reads\. Tell the user in one line to restart Claude Desktop\. Call next_sketch again now\./);
  } finally { await r.done(); }
});
