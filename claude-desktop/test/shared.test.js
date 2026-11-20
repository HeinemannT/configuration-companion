// Copies of the server on one folder, as Claude Desktop runs them: whichever copy the browser reaches and whichever
// copy the chat uses, they see one session, and each sketch is taken once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const sk = (n) => ({ text: `sketch ${n}`, page: `Page ${n}`, picture: null });
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('condition not met'); await new Promise(r => setTimeout(r, 20)); }
}

test('shared: copies starting together agree on one session; numbers run on across copies; a reply in B shows in A', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-shared-'));
  const copies = [createSession({ base }), createSession({ base }), createSession({ base })];
  try {
    const nums = copies.map((c, i) => c.add(sk(i)).sketch.number).sort();
    assert.deepEqual(nums, [1, 2, 3]);
    assert.ok(copies.every(c => c.session() === copies[0].session()));
    const r = await copies[1].next(100);
    copies[1].reply(r.sketch.number, 'done', 'from B');
    const row = copies[0].status().sketches.find(s => s.number === r.sketch.number);
    assert.equal(row.reply.text, 'from B');
    const revs = copies.map(c => c.status().rev);
    assert.ok(revs.every(v => v === revs[0]), 'every copy reports the same rev');
  } finally { for (const c of copies) c.close(); rmSync(base, { recursive: true, force: true }); }
});

test('shared: copies in separate processes take every sketch exactly once', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-shared-'));
  const pusher = createSession({ base });
  try {
    const run = () => {
      const child = spawn(process.execPath, [join(here, 'taker.js'), base, '2500'], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      return { ready: until(() => out.includes('ready')), done: new Promise(r => child.on('exit', () => r(JSON.parse(out.trim().split('\n').pop())))) };
    };
    const x = run(), y = run(), z = run();
    await Promise.all([x.ready, y.ready, z.ready]);
    const N = 30;
    for (let i = 1; i <= N; i++) { pusher.add(sk(i)); await new Promise(r => setTimeout(r, 15)); }
    const got = await Promise.all([x.done, y.done, z.done]);
    const all = got.flat().sort((p, q) => p - q);
    assert.deepEqual(all, Array.from({ length: N }, (_, i) => i + 1), `took ${JSON.stringify(got)}`);
    assert.ok(got.filter(g => g.length > 0).length >= 2, `more than one copy took some: ${got.map(g => g.length)}`);
    assert.ok(pusher.status().sketches.every(s => s.state === 'done'));
  } finally { pusher.close(); rmSync(base, { recursive: true, force: true }); }
});
