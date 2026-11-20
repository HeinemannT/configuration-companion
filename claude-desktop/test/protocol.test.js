// The wire contract (PROTOCOL.md): what is accepted, what is refused, and the versions that must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPS, EXTENSION_VERSION, hostAllowed, originAllowed, parseMessage, parsePush, sketchRef } from '../src/protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const msg = (o) => JSON.stringify({ v: 1, ...o });

test('versions: manifest, package, lock, server and PROTOCOL.md agree', () => {
  assert.equal(EXTENSION_VERSION, '0.3.1');
  assert.equal(json('manifest.json').version, EXTENSION_VERSION);
  assert.equal(json('package.json').version, EXTENSION_VERSION);
  assert.equal(json('package-lock.json').version, EXTENSION_VERSION);
  assert.equal(json('package-lock.json').packages[''].version, EXTENSION_VERSION);
  const doc = readFileSync(join(root, 'PROTOCOL.md'), 'utf8');
  assert.match(doc, new RegExp(`version: '${EXTENSION_VERSION.replace(/\./g, '\\.')}'`));
  for (const c of CAPS) assert.ok(doc.includes(`'${c}'`), `PROTOCOL.md names cap ${c}`);
});

test('origin: only Chrome or Edge extension pages; an allow-list narrows it', () => {
  const a = `chrome-extension://${'a'.repeat(32)}`;
  assert.ok(originAllowed(a));
  assert.ok(!originAllowed('https://example.com'));
  assert.ok(!originAllowed(`moz-extension://${'a'.repeat(32)}`));
  assert.ok(!originAllowed(undefined));
  assert.ok(originAllowed(a, ['a'.repeat(32)]));
  assert.ok(!originAllowed(a, ['b'.repeat(32)]));
  assert.ok(hostAllowed('127.0.0.1:47615', 47615) && hostAllowed('localhost:47615', 47615));
  assert.ok(!hostAllowed('evil.example:47615', 47615) && !hostAllowed('127.0.0.1:1', 47615));
});

test('sketch: the 0.2.x shape is accepted as it was', () => {
  const r = parsePush(msg({ type: 'sketch', text: 'hi', page: '  A   page ', pageKey: '/a', picture: { mime: 'image/png', data: PNG, drawn: true } }));
  assert.equal(r.ok, true);
  assert.deepEqual([r.sketch.page, r.sketch.pageKey, r.sketch.picture.drawn], ['A page', '/a', true]);
  assert.equal(parsePush(msg({ type: 'sketch', text: 'x', picture: { mime: 'image/png', data: PNG, drawn: 'yes' } })).sketch.picture.drawn, undefined);
  assert.deepEqual(parsePush(msg({ type: 'status' })), { ok: true, status: true });
});

test('sketch: refused shapes and sizes', () => {
  const bad = [
    'not json', '[]', JSON.stringify({ v: 2, type: 'sketch', text: 'x' }), msg({ type: 'sketch' }), msg({ type: 'sketch', text: '   ' }),
    msg({ type: 'sketch', text: 'x'.repeat(64 * 1024 + 1) }), msg({ type: 'sketch', text: 'x', page: 3 }),
    msg({ type: 'sketch', text: 'x', picture: { mime: 'image/gif', data: PNG } }), msg({ type: 'sketch', text: 'x', picture: { mime: 'image/jpeg', data: PNG } }),
    msg({ type: 'sketch', text: 'x', picture: { mime: 'image/png', data: 'not base64!' } }),
    msg({ type: 'sketch', text: 'x', key: 'has space' }), msg({ type: 'sketch', text: 'x', key: 'k'.repeat(65) }),
    msg({ type: 'sketch', text: 'x', follows: { answers: 'not an id!' } }), msg({ type: 'sketch', text: 'x', follows: { corrects: [{ sketch: 1, marks: [0] }] } }),
    msg({ type: 'sketch', text: 'x', handover: { before: 5 } }),
  ];
  for (const b of bad) assert.equal(parseMessage(b).ok, false, b.slice(0, 80));
});

test('sketch: key, follows and handover, bounded; unknown fields ignored', () => {
  const r = parseMessage(msg({
    type: 'sketch', text: 'x', key: 'k-1_A', unknown: { deep: true },
    follows: { answers: '3', corrects: [{ sketch: 'abcdef0123456789', marks: [2, 2, 1] }], other: 1 },
    handover: { before: `a\u0007b${'z'.repeat(3000)}`, after: '', extra: 'x' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.sketch.key, 'k-1_A');
  assert.deepEqual(r.sketch.follows, { answers: { number: 3 }, corrects: [{ sketch: { id: 'abcdef0123456789' }, marks: [2, 1] }] });
  assert.equal(r.sketch.handover.before.length, 2000);
  assert.ok(!r.sketch.handover.before.includes('\u0007'));
  assert.equal(r.sketch.handover.after, undefined);
  assert.equal('unknown' in r.sketch, false);
});

test('other messages: requeue, withdraw, config, unknown types, ref', () => {
  assert.deepEqual(parseMessage(msg({ type: 'requeue', id: 'abcdef0123456789', ref: 'r' })), { ok: true, type: 'requeue', ref: { id: 'abcdef0123456789' }, tag: 'r' });
  assert.deepEqual(parseMessage(msg({ type: 'withdraw', number: 4 })).ref, { number: 4 });
  assert.equal(parseMessage(msg({ type: 'requeue' })).ok, false);
  assert.equal(parseMessage(msg({ type: 'config', rev: 2, config: {} })).type, 'config');
  const u = parseMessage(msg({ type: 'future-thing' }));
  assert.deepEqual([u.ok, u.unknown, u.got], [false, true, 'future-thing']);
  assert.deepEqual([sketchRef(3), sketchRef('7'), sketchRef(0), sketchRef(1.5), sketchRef('x y')], [{ number: 3 }, { number: 7 }, null, null, null]);
});

test('manifest: tools match the server, descriptions thin, user_config for folder and wait', () => {
  const m = json('manifest.json');
  assert.deepEqual(m.tools.map(t => t.name), ['next_sketch', 'reply', 'get_sketch', 'list_sketches', 'clear_session']);
  for (const t of m.tools) {
    assert.doesNotMatch(t.description, /\d+\.\d+\.\d+|\d+ ?s(econds)?\b|working, done|done, working/, `${t.name}: no version, wait or state list`);
    assert.ok(t.description.length < 220, `${t.name}: short`);
  }
  assert.equal(m.user_config.folder.type, 'directory');
  assert.equal(m.user_config.wait_seconds.type, 'number');
  assert.equal(m.server.mcp_config.env.COMPANION_FOLDER, '${user_config.folder}');
  assert.equal(m.server.mcp_config.env.COMPANION_WAIT_SECONDS, '${user_config.wait_seconds}');
});
