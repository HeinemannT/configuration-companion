import { describe, expect, it, vi } from 'vitest';
import { buildRefResolveEc, parseRefResolveLog, refExpression, resolveRefsIsolating, REF_BATCH_MAX } from '../code-ref-resolve';
import { CodeRefCache, pickCode } from '../code-ref-client';
import { STATIC_EC_FRAME, type EcFrame } from '../ec-parser';
import type { FullObject } from '../object-read';
import { framedText as __framedText } from '../ec-parser';
/** One length-framed row (ec-parser). */
const R = (...f: unknown[]) => __framedText([f.map(String)], false);

const F = STATIC_EC_FRAME;
const row = (cells: string[]) => R(...cells);
const log = (rows: string[][]) => rows.map(row).join('') + F.done;

describe('refExpression', () => {
  it('writes the dot form for plain IDs, a quoted get() otherwise, lookup() for RIDs', () => {
    expect(refExpression('t.ab_one')).toBe('t.ab_one');
    expect(refExpression('t.ab-two.v2')).toBe('t.get("ab-two.v2")');
    expect(refExpression('rid:9223372036854775807')).toBe('lookup(9223372036854775807)');
  });

  it('refuses anything that is not a reference key', () => {
    for (const k of ['t.a"+x', 'zz.foo', 'rid:12', 't.', '.x', 't.a\nb', 'T.foo']) expect(refExpression(k)).toBeNull();
  });
});

describe('buildRefResolveEc', () => {
  const ec = buildRefResolveEc(Array.from({ length: 10 }, (_, i) => `t.id_${i}`), F);

  it('reads code text with output() only, never by running it', () => {
    expect(ec).toContain('output(_o.expression.whenMissing(""))');
    expect(ec).not.toMatch(/:= _o\.expression/);
  });

  it('wraps inline IF in parentheses', () => {
    expect(ec).not.toMatch(/:=\s+IF\b/);
  });

  it('loops once over [index, object] pairs; rows go to a short chunk flushed every few objects', () => {
    const lines = ec.split('\n');
    // Old: one block per key (about 960 characters each, 9,641 for 10 keys).
    // New: one loop; only the list line grows (1,817 characters for 10 keys).
    expect(lines[0]).toBe(`_list := LIST(${Array.from({ length: 10 }, (_, i) => `LIST("${i}", t.id_${i})`).join(', ')})`);
    expect(lines.filter(l => /^\s*_rc := _rc \+ \(/.test(l)).length).toBe(1);
    expect(lines.filter(l => /^\s*_r := _r \+ _rc$/.test(l)).length).toBe(2);
    expect(lines.some(l => /^\s*_r := _r \+ \(/.test(l))).toBe(false);
    expect(ec.match(/_cls = "ExtendedExpression"/g)).toHaveLength(1);
    expect(lines.at(-1)).toBe(`_r + "${F.done}"`);
  });
});

describe('parseRefResolveLog', () => {
  it('maps rows to keys, keeps RIDs as strings, marks the rest not found', () => {
    const keys = ['t.a', 't.b', 'rid:1234567'];
    const out = parseRefResolveLog(log([
      ['0', '9223372036854775807', 'ExtendedExpression', 'A ||| name', 'a', 'expression'],
      ['1', '', '', '', '', ''],
      ['2', '1234567', 'Category', 'C', 'c', ''],
    ]), F, keys);
    expect(out['t.a']).toEqual({ found: true, target: { rid: '9223372036854775807', type: 'ExtendedExpression', name: 'A ||| name', businessId: 'a', codeProp: 'expression' } });
    expect(out['t.b']).toEqual({ found: false });
    expect(out['rid:1234567']).toEqual({ found: true, target: { rid: '1234567', type: 'Category', name: 'C', businessId: 'c' } });
  });

  it('throws on a cut-off answer', () => {
    expect(() => parseRefResolveLog(row(['0', '1', 'X', 'n', 'i', '']), F, ['t.a'])).toThrow();
  });
});

describe('resolveRefsIsolating', () => {
  const frame = (): EcFrame => F;
  const answer = (code: string) => {
    const pairs = [...code.split('\n')[0].matchAll(/LIST\("(\d+)", (.+?)\)(?=, LIST\("|\)$)/g)].map(m => [m[1], m[2]] as const);
    return log(pairs.filter(([, k]) => k !== 't.gone').map(([i, k]) => [i, String(1000000 + Number(i)), 'ExtendedExpression', k, k, '']));
  };

  it('answers the whole batch in one post', async () => {
    const run = vi.fn(async (code: string) => ({ ok: true, log: answer(code) }));
    const { results, posts } = await resolveRefsIsolating(['t.a1', 't.b2', 't.gone', 't.a1'], run, frame);
    expect(posts).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(results['t.a1']).toMatchObject({ found: true });
    expect(results['t.gone']).toEqual({ found: false });
  });

  it('isolates a key the server rejects and still answers the others', async () => {
    const run = vi.fn(async (code: string) => code.includes('t.get("bad-id")')
      ? { ok: false, error: 'Unknown method get' }
      : { ok: true, log: answer(code) });
    const { results } = await resolveRefsIsolating(['t.a1', 't.bad-id', 't.b2', 't.c3'], run, frame);
    expect(results['t.bad-id']).toEqual({ found: false, error: 'Unknown method get' });
    expect(results['t.a1']).toMatchObject({ found: true });
    expect(results['t.c3']).toMatchObject({ found: true });
  });

  it('rethrows a connection failure instead of splitting', async () => {
    const run = vi.fn(async () => ({ ok: false, error: 'Not connected to BMP', errorKind: 'network' as const }));
    await expect(resolveRefsIsolating(['t.a1', 't.b2'], run, frame)).rejects.toThrow('Not connected');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ID keys go to the by-ID lookup first: no script with an ID; the script only for what it did not answer', async () => {
    const run = vi.fn(async (code: string) => ({ ok: true, log: `|${code.includes('t.left_over') ? '1000009' : ''}|#END` }));
    const each = vi.fn(async (_code: string, rids: readonly string[]) => new Map(rids.map(r => [r, { ok: true, log: log([['0', r, 'ExtendedExpression', `n${r}`, `b${r}`, '']]) }] as const)));
    const byId = vi.fn(async (refs: ReadonlyArray<{ key: string; ns: string; id: string }>) => new Map(refs.map(r => [r.key, r.id === 'known' ? '9223372036854775806' : r.id === 'zz_no_such_id_xq' ? null : undefined] as const)));
    const { results } = await resolveRefsIsolating(['t.known', 't.zz_no_such_id_xq', 't.left_over', 'rid:1234567'], run, frame, each, byId);
    expect(byId).toHaveBeenCalledTimes(1);
    expect(byId.mock.calls[0][0].map(r => r.key).sort()).toEqual(['t.known', 't.left_over', 't.zz_no_such_id_xq']);
    expect(results['t.known']).toMatchObject({ found: true, target: { rid: '9223372036854775806' } });
    expect(results['t.zz_no_such_id_xq']).toEqual({ found: false });
    // Only the key the lookup could not answer is in a (varying) script.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain('t.left_over');
    expect(run.mock.calls[0][0]).not.toContain('known');
    expect(results['t.left_over']).toMatchObject({ found: true, target: { rid: '1000009' } });
    // A failed lookup: every ID key falls back to the script.
    const run2 = vi.fn(async () => ({ ok: true, log: '||#END' }));
    await resolveRefsIsolating(['t.known'], run2, frame, each, async () => { throw new Error('HTTP 500'); });
    expect(run2).toHaveBeenCalledTimes(1);
  });

  it('drops invalid keys without a post and caps the batch', async () => {
    const run = vi.fn(async (code: string) => ({ ok: true, log: answer(code) }));
    expect((await resolveRefsIsolating(['t.a"x'], run, frame)).posts).toBe(0);
    const many = Array.from({ length: REF_BATCH_MAX + 5 }, (_, i) => `t.k${i}`);
    await resolveRefsIsolating(many, run, frame);
    expect((run.mock.calls.at(-1)![0].match(/LIST\("\d+", /g) ?? []).length).toBe(REF_BATCH_MAX);
  });
});

const obj = (props: FullObject['props'], type = 'ExtendedExpression'): FullObject =>
  ({ rid: '42', type, name: 'n', businessId: 'b', props, references: {}, overridden: [] } as unknown as FullObject);

describe('pickCode', () => {
  it('prefers the hint, then the type blocks, then any code property', () => {
    expect(pickCode(obj({ expression: { kind: 'code', text: 'a' } }))).toEqual({ prop: 'expression', text: 'a' });
    expect(pickCode(obj({ afterExpression: { kind: 'code', text: 'x' }, expression: { kind: 'code', text: 'y' } }, 'ButtonInput'), 'afterExpression'))
      .toEqual({ prop: 'afterExpression', text: 'x' });
    expect(pickCode(obj({ name: { kind: 'text', text: 'n' } }, 'Category'))).toBeNull();
  });
});

describe('CodeRefCache', () => {
  it('asks once for unknown keys and keeps the answers', async () => {
    const resolve = vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(k => [k, { found: false as const }])));
    const cache = new CodeRefCache({ resolve, read: vi.fn() });
    const p = cache.request(['t.a', 't.b']);
    expect(cache.ref('t.a')).toBe('pending');
    await cache.request(['t.a']);
    await p;
    await cache.request(['t.a', 't.b']);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cache.ref('t.b')).toEqual({ found: false });
  });

  it('reads a target once and picks its code', async () => {
    const read = vi.fn(async () => ({ objects: { '42': obj({ expression: { kind: 'code', text: 'a\nb' } }) }, errors: {} }));
    const cache = new CodeRefCache({ resolve: vi.fn(), read });
    await cache.requestCode('42');
    await cache.requestCode('42');
    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.code('42')).toMatchObject({ prop: 'expression', text: 'a\nb' });
  });

  it('remembers a failed request only briefly', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => { throw new Error('offline'); });
    const cache = new CodeRefCache({ resolve, read: vi.fn() });
    await cache.request(['t.a']);
    expect(cache.ref('t.a')).toMatchObject({ found: false, error: 'offline' });
    vi.advanceTimersByTime(11_000);
    expect(cache.ref('t.a')).toBeUndefined();
    vi.useRealTimers();
  });
});
