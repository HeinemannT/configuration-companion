/**
 * Row facts never fail a whole tree (lib/object-row-facts.ts) and never
 * leave rows silently "(not read)" (lib/row-facts-status.ts):
 *  - every property is read as text through str(output(…)), whatever its
 *    kind; seen live: scorecard children failed the whole chunk with
 *    "Method size can only be on a list, text or map" on `"" + output(…)`;
 *  - a chunk the server rejects is halved within a small budget, and the
 *    objects that still fail come back with their identity and unknown
 *    markers;
 *  - a session or connection failure stops, keeps what was read, and says
 *    why in the connection sentences.
 */
import { describe, expect, it, vi } from 'vitest';
import { STATIC_EC_FRAME as F } from '../ec-parser';
import { findEvaluatingCodeReads } from '../ec-code-safety';
import { buildRowFactsEc, readRowFacts, ROW_CODE_PROPS, ROW_VALUE_PROPS, ROW_FACTS_PER_SCRIPT, type RowFactsReader } from '../object-row-facts';
import { rowFactsFailure, rowFactsNote } from '../row-facts-status';
import { describeConnection } from '../connection-copy';
import { unknownIdentityMap } from '../identity-map';
import { BmpRequestError } from '../error-kind';
import { openObjectRoot, type ObjectReader } from '../object-window';
import { readCompare, type CompareReader } from '../compare-read';
import type { FullObject } from '../object-read';
import { framedText as __framedText } from '../ec-parser';
/** One length-framed row (ec-parser). */
const R = (...f: unknown[]) => __framedText([f.map(String)], false);

const SIZE_ERROR = 'Error at line 271, column 11: Method size can only be on a list, text or map (near .size())';

/** Widgets under a scorecard and inputs under an input set: mixed types. */
const TYPES = ['TableView', 'ChartView', 'TextView', 'TabSet', 'Tab', 'InputView', 'ButtonInput', 'TextInput', 'Html', 'CustomVisualization'];

/** A fake server: answers the identity rows for every `lookup(N)` of
 *  the script, and fails a facts script that holds an object of `bad`. */
function server(opts: { bad?: ReadonlySet<string>; failAt?: number; failWith?: { error: string; errorKind?: 'not-signed-in' | 'network' } } = {}) {
  const posts: string[] = [];
  const client: RowFactsReader = {
    resolveRefs: async rids => new Map(rids.map(r => [r, `lookup(${r})`] as [string, string])),
    executeEc: vi.fn(async (code: string) => {
      posts.push(code);
      if (opts.failAt === posts.length && opts.failWith) return { ok: false, ...opts.failWith };
      const rids = [...code.matchAll(/lookup\((\d+)\)/g)].map(m => m[1]);
      const facts = code.includes('_s := ');
      if (facts && rids.some(r => opts.bad?.has(r))) return { ok: false, error: SIZE_ERROR };
      const rows = rids.map((r, i) => `${R(`O`, `${r}`, `${TYPES[i % TYPES.length]}`, `Name ${r}`, `id_${r}`, ``)}`);
      if (facts) rows.push(...rids.map(r => `${R(`C`, `${r}`, `showExpression`, `4`, ``, ``)}`));
      return { ok: true, log: `${rows.join('')}${F.done}` };
    }),
  };
  return { client, posts };
}

const rids = (n: number, from = 1000) => Array.from({ length: n }, (_, i) => String(from + i));

describe('the row facts script for mixed types', () => {
  const ec = buildRowFactsEc(rids(12).map(rid => ({ rid, ref: `lookup(${rid})` })), F);

  it('reads every property as text through str(output(…)), never "" + value', () => {
    expect(ec).not.toContain('"" + output(');
    for (const p of [...ROW_CODE_PROPS, ...ROW_VALUE_PROPS]) expect(ec).toContain(`_s := str(output(_o.${p}.whenMissing("")))`);
    // Every size() is on _s or a row field _fN, and each comes from str(…): a text.
    const sizes = [...ec.matchAll(/([A-Za-z_][\w]*)\.size\(\)/g)].map(m => m[1]);
    expect(sizes.every(v => v === '_s' || /^_f\d+$/.test(v))).toBe(true);
    for (const line of ec.split('\n').filter(l => /^\s*_f\d+ := /.test(l))) expect(line).toMatch(/^\s*_f\d+ := str\(/);
    // One loop: the fact blocks are written once for all 12 objects.
    expect(ec.match(/_s := str\(output\(_o\.showExpression/g)).toHaveLength(1);
    for (const line of ec.split('\n').filter(l => /^\s*_s := /.test(l))) expect(line).toMatch(/^\s*_s := str\(output\(_o\.\w+\.whenMissing\(""\)\)\)$/);
    expect(findEvaluatingCodeReads(ec)).toEqual([]);
  });

  it('reads the identity as text too, so a rich name or ID cannot break a row', () => {
    expect(ec).toContain('str(_o.name.whenMissing(""))');
    expect(ec).toContain('str(_o.id.whenMissing(""))');
    expect(ec).toContain('str(_o.className.whenMissing(""))');
  });

  it('builds an identity-only script for the fallback, with no property reads', () => {
    const ids = buildRowFactsEc([{ rid: '5', ref: 'lookup(5)' }], F, { facts: false });
    expect(ids).toContain('"~CREV_R~1:O"');
    expect(ids).not.toContain('_s := ');
    expect(ids).not.toMatch(/Expression/);
  });
});

describe('reading row facts', () => {
  it('reads a clean tree in one post per 50 nodes', async () => {
    const { client, posts } = server();
    const res = await readRowFacts(client, rids(60), () => F);
    expect(posts).toHaveLength(2);
    expect(res.posts).toBe(2);
    expect(res.error).toBeUndefined();
    expect(Object.keys(res.objects)).toHaveLength(60);
  });

  it('one object whose facts fail costs a few posts; it keeps its identity, its markers are unknown', async () => {
    const { client } = server({ bad: new Set(['1017']) });
    const res = await readRowFacts(client, rids(ROW_FACTS_PER_SCRIPT), () => F);
    expect(res.error).toBeUndefined();
    expect(Object.keys(res.objects)).toHaveLength(ROW_FACTS_PER_SCRIPT);
    expect(res.objects['1017']).toMatchObject({ name: 'Name 1017', businessId: 'id_1017', lite: true, factsUnknown: true });
    expect(res.objects['1016'].factsUnknown).toBeUndefined();
    expect(res.objects['1016'].props.showExpression?.text).toBe('…');
    // 1 + 2 per halving level (6 for 50) + 1 identity post.
    expect(res.posts).toBeLessThanOrEqual(1 + 12 + 1);
  });

  it('a systematic failure (every object) stays bounded and still names every row', async () => {
    const { client } = server({ bad: new Set(rids(50)) });
    const res = await readRowFacts(client, rids(50), () => F);
    expect(res.posts).toBeLessThanOrEqual(1 + 12 + 1);
    expect(Object.values(res.objects).every(o => o.factsUnknown && o.name.startsWith('Name '))).toBe(true);
    expect(Object.keys(res.objects)).toHaveLength(50);
  });

  it('a lost session stops at once, keeps the chunks already read and says why', async () => {
    const { client, posts } = server({ failAt: 2, failWith: { error: 'BMP rejected portal authentication', errorKind: 'not-signed-in' } });
    const res = await readRowFacts(client, rids(120), () => F);
    expect(posts).toHaveLength(2);
    expect(Object.keys(res.objects)).toHaveLength(50);
    expect(res.error).toMatchObject({ kind: 'not-signed-in', rows: 70 });
  });

  it('an unreachable server while resolving references is reported, not thrown', async () => {
    const client: RowFactsReader = {
      resolveRefs: async () => { throw new BmpRequestError('Cannot reach BMP', 'network'); },
      executeEc: vi.fn(),
    };
    const res = await readRowFacts(client, rids(3), () => F);
    expect(res.error).toMatchObject({ kind: 'network', rows: 3 });
    expect(client.executeEc).not.toHaveBeenCalled();
  });

  it('an abort still throws', async () => {
    const ctl = new AbortController();
    const client: RowFactsReader = {
      resolveRefs: async () => { ctl.abort(); throw new DOMException('Aborted', 'AbortError'); },
      executeEc: vi.fn(),
    };
    await expect(readRowFacts(client, rids(3), () => F, ctl.signal)).rejects.toThrow();
  });
});

describe('the one line that says why', () => {
  const sentence = (display: 'needs-login' | 'unreachable') => describeConnection({
    display, identities: unknownIdentityMap(), version: null, responseMs: null, profileLabel: null, workspace: null, authError: null, networkOffline: false, lastUpdate: 0,
  }).sentence;

  it('uses the connection sentences for session and connection causes', () => {
    expect(rowFactsNote(rowFactsFailure(new BmpRequestError('401', 'not-signed-in')))).toContain(sentence('needs-login'));
    expect(rowFactsNote(rowFactsFailure(new BmpRequestError('fetch', 'network')))).toContain(sentence('unreachable'));
    // Text that crossed the message boundary without its kind.
    expect(rowFactsFailure(new Error('Not connected to BMP')).kind).toBe('not-signed-in');
    expect(rowFactsFailure(new Error('Cannot reach BMP at host')).kind).toBe('network');
  });

  it('names a script error briefly, on one line', () => {
    const line = rowFactsNote(rowFactsFailure(new Error(`${SIZE_ERROR}\n${'x'.repeat(400)}`)));
    expect(line).toMatch(/^Names and markers of the rows could not be read\. Error at line 271/);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(220);
  });
});

describe('the surfaces get the failure', () => {
  const root: FullObject = { rid: '1', type: 'InputSet', name: 'Set', businessId: 'set', props: {}, references: {}, overridden: [] };

  it('the object window payload carries it; the rows stay listed', async () => {
    const reader: ObjectReader = {
      readFullObjects: async () => ({ objects: { 1: root }, errors: {} }),
      fetchStructureRows: async () => Object.assign([{ rid: '11', parent: '1' }, { rid: '12', parent: '1' }], {}),
      readRowFacts: async () => ({ objects: {}, posts: 1, error: { message: 'Not signed in', kind: 'not-signed-in', rows: 2 } }),
    };
    const p = await openObjectRoot(reader, '1');
    expect(p.rows?.map(r => r.rid)).toEqual(['11', '12']);
    expect(p.rowFactsError).toMatchObject({ kind: 'not-signed-in' });
  });

  it('Compare lists the children and reports the facts failure apart from the listing', async () => {
    const r: CompareReader = {
      readFullObjects: async rids => ({ objects: Object.fromEntries(rids.map(x => [x, { ...root, rid: x }])), errors: {} }),
      fetchStructureRows: vi.fn(),
      resolveRef: async rid => `lookup(${rid})`,
      resolveRefs: async rs => new Map(rs.map(x => [x, `lookup(${x})`] as [string, string])),
      executeEc: async () => ({ ok: true, log: '11|||1\n21|||2\n' }),
      readRowFacts: async () => { throw new BmpRequestError(SIZE_ERROR, 'server'); },
    };
    const read = await readCompare(r, ['1', '2'], 10_000);
    for (const s of ['1', '2']) {
      expect(read.sides[s].structureError).toBeUndefined();
      expect(read.sides[s].rows).toHaveLength(1);
      expect(read.sides[s].rowFactsError).toMatchObject({ message: SIZE_ERROR, rows: 1 });
    }
  });
});
