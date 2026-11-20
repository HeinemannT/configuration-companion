// Settings and learned waits: plain bounded data only, the highest rev wins, waits shrink only on repeated cuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, clientMatches, configStore, configuredWait, learnedWaits, mergeConfig, validateConfig } from '../src/config.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'cc-config-'));

test('settings: the defaults: 45 s, the Claude Code CLI 100 s, no client name rule in code', () => {
  const c = mergeConfig();
  assert.equal(configuredWait(c, 'local-agent-mode-Configuration Companion'), 45);
  assert.equal(configuredWait(c, 'codex-mcp-client'), 45);
  assert.equal(configuredWait(c, 'claude-code'), 100);
  assert.equal(configuredWait(c, 'Claude-Code'), 100);
  assert.equal(configuredWait(c, 'claude-code-2'), 45, 'whole name, not a part');
  assert.deepEqual(DEFAULTS.wait.byClient, [{ match: 'claude-code', seconds: 100 }]);
  assert.ok(clientMatches('local-agent-mode-*', 'local-agent-mode-Configuration Companion'));
  assert.ok(!clientMatches('a.b', 'aXb'), 'a dot is a dot');
});

test('settings: every bound is checked; a wrong known key refuses the whole object; unknown keys dropped', () => {
  const bad = [
    null, [], { wait: 5 }, { wait: { default: 9 } }, { wait: { default: 601 } }, { wait: { byClient: [{ match: 'x(', seconds: 20 }] } },
    { wait: { byClient: Array.from({ length: 11 }, () => ({ match: 'x', seconds: 20 })) } },
    { texts: { nothingYet: 'x'.repeat(1001) } }, { texts: { nothingYet: 'bell\u0007' } }, { texts: { nothingYet: 3 } },
    { states: [{ name: 'done', open: false, word: 'x' }] }, { states: [{ name: 'Review', open: false, word: 'x' }] },
    { states: [{ name: 'review', open: 'no', word: 'x' }] }, { states: [{ name: 'review', open: true, word: 'w'.repeat(25) }] },
    { limits: { keep: 9 } }, { limits: { keepDays: 1.5 } }, { limits: { takenMinutes: 241 } }, { origins: ['nope'] },
    { texts: { nothingYet: 'x'.repeat(990) }, pad: 'p'.repeat(17000) },
  ];
  for (const b of bad) assert.equal(validateConfig(b).ok, false, JSON.stringify(b)?.slice(0, 80));
  const ok = validateConfig({ texts: { nothingYet: 'Line one.\nLine two.', unknownText: 'x' }, other: { x: 1 }, limits: { keep: 50, more: 1 } });
  assert.deepEqual(ok, { ok: true, config: { texts: { nothingYet: 'Line one.\nLine two.' }, limits: { keep: 50 } } });
});

test('settings: applied by rev, the highest wins; written to the folder and read by another copy', () => {
  const base = fresh();
  try {
    const a = configStore(base), b = configStore(base);
    assert.deepEqual(a.apply(2, { limits: { keep: 40 } }, 'x'.repeat(32)), { ok: true, rev: 2, applied: true });
    assert.deepEqual(a.apply(2, { limits: { keep: 50 } }), { ok: true, rev: 2, applied: false });
    assert.deepEqual(a.apply(1, { limits: { keep: 50 } }), { ok: true, rev: 2, applied: false });
    assert.equal(a.apply(0, {}).ok, false);
    assert.equal(a.apply(3, { limits: { keep: 5 } }).ok, false);
    assert.equal(b.reload().config.limits.keep, 40);
    assert.equal(b.get().rev, 2);
    const file = JSON.parse(readFileSync(join(base, '.config.json'), 'utf8'));
    assert.equal(file.by, 'x'.repeat(32));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('learned waits: one cut changes nothing; two near cuts shrink to the shorter minus 15 s, floor 15 s; never grows', () => {
  const base = fresh();
  try {
    const l = learnedWaits(base);
    const name = 'some-host', c = 45_000;
    assert.equal(l.cut(name, 19_000, c, c), null, 'under 20 s is no cut');
    assert.equal(l.cut(name, 30_000, c, c), null, 'one cut');
    assert.equal(l.get(name, c), null);
    assert.equal(l.cut(name, 31_000, c, c), 15_000, 'two near cuts: 30 - 15');
    assert.equal(l.get(name, c), 15_000);
    assert.equal(l.cut(name, 40_000, c, 15_000), null, 'a cut longer than the wait is no cut');
    const other = 'quitting-app';
    assert.equal(l.cut(other, 25_000, c, c), null);
    assert.equal(l.cut(other, 38_000, c, c), null, 'cuts far apart (a user Stop, an app quit) do not teach');
    assert.equal(l.cut(other, 39_000, c, c), 23_000);
    assert.equal(l.cut(other, 22_000, c, 23_000), 15_000, 'near the first cut: 22 - 15 is under the floor');
    assert.equal(l.get(other, 60_000), null, 'settings that give the client another wait drop what was learned');
    assert.equal(learnedWaits(base).get(name, c), 15_000, 'kept on disk');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
