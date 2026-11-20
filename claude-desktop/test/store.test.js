// The session store in one process: numbering, the queue, hand-outs, replies, requeue, the files, clean-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanOld, createSession, defaultBase, safeName, sessionName } from '../src/session.js';
import { configStore } from '../src/config.js';
import { withLock, LOCK_STALE_MS } from '../src/fsx.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sk = (n, extra = {}) => ({ text: `Page: "P${n}"\n\n1. mark one of ${n}\n2. mark two of ${n}`, page: `Page ${n}`, pageKey: `/p${n}`, picture: null, ...extra });
const fresh = () => mkdtempSync(join(tmpdir(), 'cc-store-'));
async function withStore(fn, o = {}) {
  const base = fresh();
  const s = createSession({ base, ...o });
  try { await fn(s, base); } finally { s.close(); rmSync(base, { recursive: true, force: true }); }
}
const take = async (s, ms = 50) => (await s.next(ms)).sketch ?? null;

test('store: numbers from 1, ids unique, the oldest waiting first, a wait that finds none gives {}', () => withStore(async (s) => {
  const a = s.add(sk(1)).sketch, b = s.add(sk(2)).sketch;
  assert.deepEqual([a.number, b.number], [1, 2]);
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.notEqual(a.id, b.id);
  assert.equal((await take(s)).number, 1);
  s.reply(1, 'done', 'ok');
  assert.equal((await take(s)).number, 2);
  s.reply(2, 'done', 'ok');
  assert.deepEqual(await s.next(30), {});
}));

test('store: a waiting next is answered when a sketch arrives', () => withStore(async (s) => {
  const p = s.next(3000);
  await new Promise(r => setTimeout(r, 50));
  s.add(sk(1));
  const r = await p;
  assert.equal(r.sketch.number, 1);
  assert.equal(r.handedBefore, false);
}));

test('store: a second next ends the first with superseded; an abort ends it with aborted; neither takes', () => withStore(async (s) => {
  const first = s.next(5000);
  await new Promise(r => setTimeout(r, 30));
  const second = s.next(5000);
  const f = await first;
  assert.equal(f.cut, 'superseded');
  assert.equal(s.waiting(), 1);
  const ac = new AbortController();
  const third = s.next(5000, ac.signal);
  assert.equal((await second).cut, 'superseded');
  ac.abort();
  assert.equal((await third).cut, 'aborted');
  assert.equal(s.waiting(), 0);
  s.add(sk(1));
  assert.equal(s.status().sketches[0].state, 'queued');
}));

test('store: reply rules: never handed is refused, unknown is refused, a long text is cut, working keeps it open', () => withStore(async (s) => {
  s.add(sk(1));
  assert.equal(s.reply(1, 'done', 'x').error, 'not-handed');
  assert.equal(s.reply(7, 'done', 'x').error, 'unknown');
  await take(s);
  const r = s.reply(1, 'working', 'y'.repeat(5000));
  assert.equal(r.cut, 4000);
  assert.equal(r.sketch.reply.text.length, 4000);
  const row = s.status().sketches[0];
  assert.deepEqual([row.state, row.open], ['working', true]);
  assert.equal(s.reply(1, 'done', 'Moved it.').sketch.state, 'done');
  assert.equal(s.status().sketches[0].open, false);
}));

test('store: the same copy gets its unanswered sketch again once; then the queue', () => withStore(async (s) => {
  s.add(sk(1)); s.add(sk(2));
  assert.equal((await take(s)).number, 1);
  const again = await s.next(50);
  assert.deepEqual([again.sketch.number, again.rehand, again.handedBefore], [1, true, true]);
  assert.equal((await take(s)).number, 2);
  assert.equal(s.status().sketches[0].handed, 2);
}));

test('store: requeue from any state but waiting; the history keeps the last reply; withdraw only while waiting', () => withStore(async (s) => {
  const a = s.add(sk(1)).sketch;
  s.add(sk(2));
  await take(s);
  s.reply(1, 'done', 'Made it blue.');
  const q = s.requeue({ id: a.id });
  assert.deepEqual([q.ok, q.number, q.state], [true, 1, 'queued']);
  const r = await s.next(50);
  assert.equal(r.sketch.number, 1);
  assert.equal(r.handedBefore, true);
  assert.equal(r.sketch.history.at(-1).reply.text, 'Made it blue.');
  assert.equal(s.withdraw({ number: 1 }).ok, false, 'taken: not withdrawn');
  assert.deepEqual(s.withdraw({ number: 2 }), { ok: true, id: s.status().sketches[1].id, number: 2, state: 'withdrawn' });
  assert.equal(s.reply(2, 'done', 'x').error, 'withdrawn');
  assert.equal(s.requeue({ number: 99 }).ok, false);
}));

test('store: a push key gives one sketch; the same key again returns the first', () => withStore(async (s) => {
  const a = s.add(sk(1, { key: 'k1' }));
  const b = s.add(sk(1, { key: 'k1' }));
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.sketch.number, a.sketch.number);
  assert.equal(s.add(sk(2, { key: 'k2' })).sketch.number, 2);
  assert.equal(s.size(), 2);
}));

test('store: every open sketch stays kept beyond the window; closed ones beyond it drop from the list (B8)', () => withStore(async (s) => {
  for (let i = 1; i <= 45; i++) s.add(sk(i));
  assert.equal(s.size(), 45, 'all open ones kept');
  for (let i = 1; i <= 45; i++) { const x = await take(s, 10); s.reply(x.number, 'done', 'ok'); }
  assert.equal(s.size(), 30);
  assert.equal(s.list().at(-1).number, 16);
  assert.equal(s.reply(3, 'done', 'still answerable').sketch.number, 3, 'a reply to a closed sketch out of the window still lands');
}));

test('store: numbers never start again: not after clear, not after a new session', () => withStore(async (s, base) => {
  s.add(sk(1)); s.add(sk(2));
  assert.equal(s.clear(), 2);
  assert.equal(s.add(sk(3)).sketch.number, 3);
  const other = createSession({ base });
  try { assert.equal(other.add(sk(4)).sketch.number, 4, 'a second copy goes on'); } finally { other.close(); }
  assert.equal(JSON.parse(readFileSync(join(base, '.numbers.json'), 'utf8')).last, 4);
}));

test('store: a session ends when a sketch arrives after it was idle for limits.sessionHours, never by a copy stopping', () => withStore(async (s, base) => {
  s.add(sk(1));
  const first = s.session();
  s.close();
  const again = createSession({ base });
  try {
    assert.equal(again.session(), first, 'the next copy joins the same session');
    const real = Date.now;
    Date.now = () => real() + 13 * 3_600_000;
    try {
      const r = again.add(sk(2));
      assert.notEqual(again.session(), first);
      assert.equal(r.sketch.number, 2);
    } finally { Date.now = real; }
  } finally { again.close(); }
}));

test('store: a taken sketch of a gone copy goes back to waiting; a working one only after limits.takenMinutes', () => withStore(async (s, base) => {
  const other = createSession({ base, aliveMs: 200 });
  s.add(sk(1)); s.add(sk(2));
  assert.equal((await take(other)).number, 1);
  other.reply(1, 'working', 'on it');
  assert.equal((await take(other)).number, 2);
  other.close();                                    // gone: its file is removed
  const r = await s.next(50);
  assert.deepEqual([r.sketch.number, r.handedBefore], [2, true]);
  s.reply(2, 'done', 'ok');
  assert.equal(s.status().sketches[0].state, 'working', 'a working sketch is left with its chat');
  const real = Date.now;
  Date.now = () => real() + 21 * 60_000;
  try {
    const w = await s.next(50);
    assert.deepEqual([w.sketch.number, w.handedBefore], [1, true]);
  } finally { Date.now = real; }
}, { aliveMs: 200 }));

test('store: the clock set back: revs still grow, a lease does not expire at once (p8)', () => withStore(async (s, base) => {
  s.add(sk(1));
  await take(s);
  const before = s.status().rev;
  const real = Date.now;
  Date.now = () => real() - 3_600_000;
  try {
    const other = createSession({ base });
    try {
      other.add(sk(2));
      assert.ok(other.status().rev > before, 'status rev grew');
      assert.ok(other.status().sketches.at(-1).rev > before, 'the new row rev is above the old status rev');
      const r = await other.next(50);
      assert.equal(r.sketch.number, 2, 'sketch 1 stays with its taker');
    } finally { other.close(); }
  } finally { Date.now = real; }
}));

test('store: the status rev is never ahead of its rows: it is published after the record (soak finding)', () => withStore(async (s, base) => {
  s.add(sk(1)); s.add(sk(2));
  await take(s);
  const metaFile = join(s.folder(), '.sketches', '1.json');
  const before = JSON.parse(readFileSync(metaFile, 'utf8')).rev;
  s.reply(1, 'done', 'ok');
  const st = s.status();
  assert.equal(st.rev, Math.max(...st.sketches.map(r => r.rev)));
  assert.ok(JSON.parse(readFileSync(join(base, '.numbers.json'), 'utf8')).rev <= JSON.parse(readFileSync(metaFile, 'utf8')).rev);
  assert.ok(st.rev > before);
}));

test('store: idle waiting is cheap: a 3 s wait with 30 kept sketches reads the bell, not the records (p8)', () => withStore(async (s) => {
  for (let i = 1; i <= 30; i++) s.add({ ...sk(i), text: 'brief '.repeat(2000) });
  for (let i = 1; i <= 30; i++) { await take(s, 5); s.reply(i, 'done', 'ok'); }
  const c0 = process.cpuUsage();
  const t0 = Date.now();
  await s.next(3000);
  const c = process.cpuUsage(c0);
  const cpu = (c.user + c.system) / 1000;
  assert.ok(cpu < 300, `cpu ${cpu.toFixed(0)} ms over ${Date.now() - t0} ms`);
}));

test('store: a lock left by a dead holder is broken; a held one makes others wait', () => {
  const base = fresh();
  try {
    const path = join(base, '.lock');
    writeFileSync(path, 'dead-holder');
    const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
    utimesSync(path, old, old);
    assert.equal(withLock(path, () => 42), 42);
    assert.equal(existsSync(path), false);
    writeFileSync(path, 'live-holder');
    assert.throws(() => withLock(path, () => 1, { waitMs: 100 }), (e) => e.code === 'LOCKED');
    // A copy killed while it held the lock: its process is gone, so the lock is passed over at once (soak finding).
    writeFileSync(path, '999999-deadbeef');
    const t0 = Date.now();
    assert.equal(withLock(path, () => 7, { waitMs: 100 }), 7);
    assert.ok(Date.now() - t0 < 100);
    writeFileSync(path, `${process.pid}-alive`);
    assert.throws(() => withLock(path, () => 1, { waitMs: 100 }), (e) => e.code === 'LOCKED', 'a live holder keeps it');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('store: settings states: a closed one closes, an open one stays listed; reply words follow the settings', () => withStore(async (s, base) => {
  writeFileSync(join(base, '.config.json'), JSON.stringify({ rev: 1, config: { states: [{ name: 'review', open: true, word: 'In review' }] } }));
  s.settings.reload();
  assert.deepEqual(s.replyStates(), ['done', 'working', 'question', 'cannot', 'review']);
  s.add(sk(1));
  await take(s);
  s.reply(1, 'review', 'Please look.');
  const row = s.status().sketches[0];
  assert.deepEqual([row.state, row.open, row.word], ['review', true, 'In review']);
}));

test('files: session folder, numbered sketch folders, brief, picture, reply, index; dot files are bookkeeping', () => withStore(async (s, base) => {
  s.add(sk(1, { picture: { mime: 'image/png', data: PNG } }));
  await take(s);
  s.reply(1, 'done', 'Moved the table.');
  const dir = s.folder();
  const names = readdirSync(dir);
  assert.ok(names.includes('index.md'));
  const sketchDir = names.find(n => n.startsWith('01 '));
  assert.equal(sketchDir, '01 Page 1');
  assert.deepEqual(readdirSync(join(dir, sketchDir)).sort(), ['brief.md', 'picture.png', 'reply.md']);
  assert.match(readFileSync(join(dir, 'index.md'), 'utf8'), /\| 01 \| .* \| Page 1 \| done \| Moved the table\. \|/);
  const ptr = JSON.parse(readFileSync(join(base, '.current.json'), 'utf8'));
  assert.equal(ptr.fmt, 1);
  assert.match(ptr.id, /^s-[0-9a-f]{12}$/);
}));

test('files: a folder that cannot be written refuses the sketch with an error', () => {
  const base = fresh();
  const file = join(base, 'file');
  writeFileSync(file, 'x');
  const s = createSession({ base: join(file, 'Sessions') });
  try {
    assert.throws(() => s.add(sk(1)));
    assert.deepEqual(s.status().sketches, []);
  } finally { s.close(); rmSync(base, { recursive: true, force: true }); }
});

test('files: old sessions are deleted, the current one and other folders are left alone', () => {
  const base = fresh();
  try {
    const s = createSession({ base });
    s.add(sk(1));
    const cur = s.folder();
    s.close();
    const old = join(base, '2026-01-01 10-00');
    mkdirSync(old);
    mkdirSync(join(base, 'Keep me'));
    const t = (Date.now() - 8 * 86_400_000) / 1000;
    for (const d of [old, join(base, 'Keep me'), cur]) utimesSync(d, t, t);
    assert.deepEqual(cleanOld(base, 7), ['2026-01-01 10-00']);
    assert.ok(existsSync(cur));
    assert.ok(existsSync(join(base, 'Keep me')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('files: names and the default place; an unfilled manifest placeholder counts as not set', () => {
  assert.equal(sessionName(new Date(2026, 10, 20, 14, 32)), '2026-11-20 14-32');
  assert.equal(safeName('a/b:c*?'), 'a b c');
  assert.equal(safeName(''), 'Sketch');
  assert.equal(defaultBase({}, '/home/u'), join('/home/u', 'Configuration Companion', 'Sessions'));
  assert.equal(defaultBase({ COMPANION_FOLDER: '${user_config.folder}' }, '/home/u'), join('/home/u', 'Configuration Companion', 'Sessions'));
  assert.equal(defaultBase({ COMPANION_FOLDER: '/x/y' }, '/home/u'), '/x/y');
});

test('settings file: a person may write the object alone; a bad file is not used and says why', () => {
  const base = fresh();
  try {
    writeFileSync(join(base, '.config.json'), JSON.stringify({ limits: { keep: 12 } }));
    const c = configStore(base);
    assert.equal(c.get().config.limits.keep, 12);
    writeFileSync(join(base, '.config.json'), '{ "limits": { "keep": 5 } }');
    const st = c.reload();
    assert.equal(st.config.limits.keep, 30);
    assert.match(st.error, /limits\.keep is not between 10 and 500/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
