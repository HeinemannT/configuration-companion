/**
 * The search results must not change when the engine's delivery changes
 * (paging in the window, streaming, smaller hits). A deterministic world of
 * templates, instances, organisations and roots is searched through the index
 * and through the live server scan with every option that shapes the result;
 * the answers are compared with digests recorded from the engine before the
 * change (`code-search-golden.json`).
 *
 * The digest covers every field the window shows: the outcome (counts, menus,
 * coverage, rows) and each hit's identity, place, matches and matched lines.
 * The full property text a hit used to carry (`code`) is not part of it: a
 * hit now carries the lines around each match instead, checked separately
 * against the stored code. The live "Used in code" coverage is left out of
 * its digest: it counted every object twice before (see the test below).
 *
 * Record again (only when a result change is intended):
 * `CREV_GOLDEN_WRITE=1 npx vitest run src/lib/__tests__/code-search-golden.test.ts`
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syncCodeIndex } from '../code-index-sync';
import { MemoryCodeIndexStore } from '../code-index-store';
import { CONTEXT_LINE_CHARS, CONTEXT_LINES, indexSource, runCodeSearch, serverSource, storeReader, type CodeSearchHit, type CodeSearchOutcome, type CodeSearchRequest, type ScanSource } from '../code-search';
import { server } from './code-search-sim';
import { goldenWorld } from './code-search-world';

const GOLDEN = fileURLToPath(new URL('./code-search-golden.json', import.meta.url));
const WRITE = !!process.env.CREV_GOLDEN_WRITE;

const resolveKeys = async (keys: string[]) => Object.fromEntries(keys.map(k => [k, k === 't.e1' || k === 'o.e1'
  ? { found: true as const, target: { rid: k === 't.e1' ? '3' : '5', type: 'ExtendedExpression', name: '', businessId: 'e1' } }
  : { found: false as const }]));

export const GOLDEN_REQUESTS: Array<[string, CodeSearchRequest]> = [
  ['today', { mode: 'text', text: 'today' }],
  ['today folded', { mode: 'text', text: 'today', fold: true }],
  ['today ignore case', { mode: 'text', text: 'TODAY', caseSensitive: false }],
  ['today whole word', { mode: 'text', text: 'today', wholeWord: true, fold: true }],
  ['regex', { mode: 'text', text: 'due_\\w+_reminder', regex: true }],
  ['by name', { mode: 'text', text: 'today', sort: 'name', fold: true }],
  ['by folder', { mode: 'text', text: 'today', sort: 'location' }],
  ['as stored', { mode: 'text', text: 'this.user', sort: 'stored' }],
  ['types', { mode: 'text', text: 'today', types: ['ActionButton'] }],
  ['props', { mode: 'text', text: 'today', props: ['afterExpression'] }],
  ['where root', { mode: 'text', text: 'today', where: ['root:templateCategory', 'root:expression'], fold: true }],
  ['where org', { mode: 'text', text: 'today', where: ['org:110'], fold: true }],
  ['page 2', { mode: 'text', text: 'today', offset: 100, limit: 100 }],
  ['used in code', { mode: 'refs', target: { rid: '3', businessId: 'e1' }, fold: true }],
  ['used in code unfolded', { mode: 'refs', target: { rid: '3', businessId: 'e1' }, sort: 'name' }],
];

/** What the window shows of a hit (its full property text excepted). */
export function shownHit(h: CodeSearchHit): unknown {
  return {
    rid: h.rid, type: h.type, name: h.name, businessId: h.businessId, where: h.where, matches: h.matches,
    props: h.props.map(p => ({ prop: p.prop, lines: p.lines.map(l => ({ line: l.line, text: l.text, ranges: l.ranges, cut: l.cut, form: l.form })) })),
    root: h.root, path: h.path, tmpl: h.tmpl, overridden: h.overridden, instances: h.instances,
  };
}

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);
// How the code was read (`read`, `readChanged`, `narrowed`) is not part of the answer.
const outcomeOf = (o: CodeSearchOutcome) => { const { ms: _ms, ...rest } = o; const { read: _r, readChanged: _c, narrowed: _n, checkedAt: _t, listingReused: _l, ...coverage } = rest.coverage; return { ...rest, coverage }; };

export async function goldenSources() {
  const { objects, orgs } = goldenWorld();
  const store = new MemoryCodeIndexStore();
  await syncCodeIndex(server(objects, { orgs }), store, 'e', { signal: new AbortController().signal, now: () => 1 });
  const meta = await store.getMeta('e');
  const sources: ScanSource[] = [
    { from: 'root.expression', root: 'expression' }, { from: 'root.templateCategory', root: 'templateCategory' }, { from: 'root.portal', root: 'portal' },
    { from: 'lookup(100)', root: 'organisation', path: ['100'] }, { from: 'lookup(200)', root: 'organisation', path: ['200'] },
  ];
  return {
    objects, orgs,
    index: () => indexSource(meta, storeReader(store, 'e')),
    server: () => serverSource(server(objects, { orgs, context: true }), { sources }),
  };
}

describe('code search results are unchanged (recorded digests)', () => {
  it('index and live scan give the recorded answers for every option', async () => {
    const src = await goldenSources();
    const got: Record<string, { n: number; hits: string; outcome: string; matched: number; matches: number }> = {};
    for (const [kind, make] of [['index', src.index], ['server', src.server]] as const) {
      for (const [name, req] of GOLDEN_REQUESTS) {
        const hits: CodeSearchHit[] = [];
        const out = await runCodeSearch(req, make(), h => hits.push(...h), { resolveKeys });
        got[`${kind}: ${name}`] = { n: hits.length, matched: out.matchedObjects, matches: out.matches, hits: digest(hits.map(shownHit)), outcome: digest(kind === 'server' && req.mode === 'refs' ? { ...outcomeOf(out), coverage: undefined } : outcomeOf(out)) };
      }
    }
    if (WRITE || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
      return;
    }
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof got;
    expect(got).toEqual(want);
  });

  // The one recorded change: "Used in code" on the live scan scanned the
  // server twice (candidate keys, then the matches), and its coverage
  // counted every object twice. One scan now; the coverage is the text
  // search's over the same places.
  it('"Used in code" scans the server once and counts each object once', async () => {
    const { objects, orgs } = goldenWorld();
    const sources: ScanSource[] = [{ from: 'root.expression', root: 'expression' }, { from: 'root.templateCategory', root: 'templateCategory' }];
    const textClient = server(objects, { orgs });
    const text = await runCodeSearch({ mode: 'text', text: 'e1' }, serverSource(textClient, { sources }), () => {});
    const refsClient = server(objects, { orgs });
    const refs = await runCodeSearch({ mode: 'refs', target: { rid: '3', businessId: 'e1' } }, serverSource(refsClient, { sources }), () => {}, { resolveKeys });
    const scans = (c: { posts: string[][] }) => c.posts.filter(p => p[0].includes('_hit := FALSE')).length;
    expect(scans(refsClient)).toBe(scans(textClient));
    expect(refs.coverage.total).toBe(text.coverage.total);
    expect(refs.coverage.complete).toBe(true);
  });

  it('a hit carries the lines around each match, equal to the stored code', async () => {
    const { objects } = goldenWorld();
    const src = await goldenSources();
    const byRid = new Map(objects.map(o => [o.rid, o]));
    for (const req of [GOLDEN_REQUESTS[0][1], GOLDEN_REQUESTS[13][1]]) {
      const hits: CodeSearchHit[] = [];
      await runCodeSearch({ ...req, limit: 10_000 }, src.server(), h => hits.push(...h), { resolveKeys, context: true });
      let checked = 0;
      for (const h of hits) for (const p of h.props) {
        const lines = (byRid.get(h.rid)!.code[p.prop] ?? '').split(/\r?\n/);
        expect(p.lineCount).toBe(lines.length);
        const known = new Map<number, string>(p.around ?? []);
        for (const l of p.lines) if (!l.cut && l.text.length === lines[l.line - 1].length) known.set(l.line, l.text);
        for (const l of p.lines) for (let n = Math.max(1, l.line - CONTEXT_LINES); n <= Math.min(lines.length, l.line + CONTEXT_LINES); n++) {
          // A line too long to carry is read with the full text instead.
          if (lines[n - 1].length > CONTEXT_LINE_CHARS) { expect(known.has(n)).toBe(false); continue; }
          expect(known.get(n)).toBe(lines[n - 1]);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(100);
    }
  });
});
