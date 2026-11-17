/**
 * Code search engine without a server: matching, prefilters, the index
 * build and refresh against a simulated BMP, the server-scan fallback and
 * find references.
 */
import { describe, expect, it } from 'vitest';
import { STATIC_EC_FRAME as F } from '../ec-parser';
import { STATIC_CODE_PROPS } from '../code-index-sync';
import { compileSearch, requiredLiteral, wildcardPattern, referencePrefilter } from '../code-search-match';
import {
  buildInventoryEc, buildReadEc, parseInventoryLog, parseReadLog, refreshIndexedObjects, syncCodeIndex,
  foldIntoTemplate,
  IndexUnavailableError,
} from '../code-index-sync';
import { MemoryCodeIndexStore } from '../code-index-store';
import { ServerOverloadError } from '../index-budget';
import {
  collectCodeSearch, indexSource, isIdentical, NeedsIndexError, type SearchableObject, runCodeSearch, serverSource, storeReader,
  type CodeSearchHit, type CodeSearchOptions, type CodeSearchRequest,
} from '../code-search';
import { orgWorld, server, sim } from './code-search-sim';
import { framedText as __framedText } from '../ec-parser';
import { SCRIPT_MAX_CHARS } from '../ec-parser';
import { framedText } from '../ec-parser';
import { classifyScript } from '../script-kinds';
import type { EcResult } from '../bmp-client';
/** One length-framed row (ec-parser). */
const R = (...f: unknown[]) => __framedText([f.map(String)], false);


async function built(objects = sim()) {
  const client = server(objects);
  const store = new MemoryCodeIndexStore();
  await syncCodeIndex(client, store, 'p1@https://bmp.test/W/', { signal: new AbortController().signal, now: () => 1000 });
  const meta = await store.getMeta('p1@https://bmp.test/W/');
  return { client, store, meta, source: indexSource(meta, storeReader(store, 'p1@https://bmp.test/W/')) };
}

async function search(req: CodeSearchRequest, src: Awaited<ReturnType<typeof built>>['source'], resolveKeys?: CodeSearchOptions['resolveKeys']) {
  const hits: CodeSearchHit[] = [];
  const outcome = await runCodeSearch(req, src, h => hits.push(...h), { resolveKeys });
  return { hits, outcome };
}

// ── matching ──────────────────────────────────────────────────────

describe('query compilation', () => {
  it('builds a case-insensitive wildcard from the safe pieces only', () => {
    expect(wildcardPattern('whenMissing')).toBe('*whenMissing*');
    expect(wildcardPattern('a*b?{c}"d\\e')).toBe('*a*b*c*d*e*');
    expect(wildcardPattern('Ärger')).toBe('*rger*');
    expect(wildcardPattern('{}')).toBeNull();
  });

  it('chooses the prefilter by case and options', () => {
    const p = (o: Partial<Parameters<typeof compileSearch>[0]>) => {
      const c = compileSearch({ query: 'today', caseSensitive: true, wholeWord: false, regex: false, ...o });
      if ('error' in c) throw new Error(c.error);
      return c.prefilter;
    };
    expect(p({})).toEqual({ kind: 'indexOf', needles: ['today'], exact: true });
    expect(p({ caseSensitive: false })).toEqual({ kind: 'wildcard', pattern: '*today*', exact: true });
    expect(p({ query: ':=', caseSensitive: false })).toEqual({ kind: 'indexOf', needles: [':='], exact: true });
    expect(p({ wholeWord: true })).toMatchObject({ kind: 'indexOf', exact: false });
    expect(p({ query: 'when\\w+', regex: true })).toEqual({ kind: 'indexOf', needles: ['when'], exact: false });
    expect(p({ query: 'a|b', regex: true })).toEqual({ kind: 'all', exact: false });
  });

  it('finds the fixed text a regular expression requires', () => {
    expect(requiredLiteral('due_\\w+')).toBe('due_');
    expect(requiredLiteral('colou?r')).toBe('colo');
    expect(requiredLiteral('(a|b)xyz')).toBe('xyz');
    expect(requiredLiteral('[abc]+def{2}gh')).toBe('def');
    expect(requiredLiteral('x\\.y')).toBe('x.y');
  });

  it('marks every match on a line, whole words only when asked', () => {
    const c = compileSearch({ query: 'today', caseSensitive: false, wholeWord: true, regex: false });
    if ('error' in c) throw new Error(c.error);
    expect(c.ranges('Today, todays, _today, today')).toEqual([[0, 5], [23, 28]]);
    expect(compileSearch({ query: '(', caseSensitive: true, wholeWord: false, regex: true })).toHaveProperty('error');
  });

  it('prefilters references on the business ID and the RID', () => {
    expect(referencePrefilter({ rid: '12345', businessId: 'x_y' })).toEqual({ kind: 'indexOf', needles: ['x_y', '12345'], exact: false });
  });
});

// ── index build and refresh ───────────────────────────────────────

describe('code index sync', () => {
  it('lists without angle brackets in the growing result and parses the list', () => {
    const ec = buildInventoryEc('ExtendedTable', F);
    expect(ec).not.toMatch(/[<>]{2}/);
    expect(ec).toContain('_rc := _rc + (');
    expect(ec).toContain('_r := _r + _rc');
    expect(parseInventoryLog(`${R(`1`, `Nov 1, 2026`, `12`)}${F.done}`, F)).toEqual([{ rid: '1', stamp: 'Nov 1, 2026', len: 12 }]);
    expect(() => parseInventoryLog(`${R(`1`, `x`, `1`)}`, F)).toThrow(/incomplete/);
  });

  it('reads code in one loop over the list and parses rows whose code holds commas and line breaks', () => {
    const ec = buildReadEc([{ rid: '5', ref: 'lookup(5)', type: 'ButtonInput', props: ['expression', 'initExpression', 'afterExpression', 'defaultExpression'] }], F);
    expect(ec).toContain('LIST(lookup(5)).forEach(_o:');
    expect(ec).toContain('output(_o.afterExpression.whenMissing(""))');
    const log = `${R(`I`, `5`, `id`, `Name, with comma`, `P`, `G`, `s`)}${R(`C`, `5`, `expression`, `a, b\n, c`)}${F.done}`;
    const o = parseReadLog(log, F).get('5')!;
    expect(o).toMatchObject({ name: 'Name, with comma', parent: 'P', grandparent: 'G' });
    expect(o.code.expression).toBe('a, b\n, c');
  });

  it('builds paced in small posts; a check with nothing changed is one request', async () => {
    const objects = sim();
    const client = server(objects);
    const store = new MemoryCodeIndexStore();
    const env = 'p1@u';
    const day = (d: string) => () => Date.parse(`${d}T10:00:00Z`);
    for (const o of objects) o.day = '2026-10-01';
    const first = await syncCodeIndex(client, store, env, { signal: new AbortController().signal, now: day('2026-11-01') });
    expect(first.changed).toBe(4);
    // One read per type (a type's first read is small).
    expect(first.requests.map(r => r.op)).toEqual(['roots', 'count', 'list', 'read code', 'read code', 'read code', 'completeness', 'summary']);
    // Small scripts (a large question is split, ec-parser SCRIPT_TARGET_CHARS),
    // each post after a pause as long as the post before.
    expect(client.posts.every(p => p.every(code => code.length <= SCRIPT_MAX_CHARS))).toBe(true);
    expect(first.requests.slice(1).every(r => r.pauseMs >= 500)).toBe(true);
    expect((await store.get(env, '9007199254740995'))?.refs.map(r => r.k)).toContain('rid:9007199254740993');
    const quiet = await syncCodeIndex(client, store, env, { signal: new AbortController().signal, now: day('2026-11-02') });
    expect(quiet).toMatchObject({ changed: 0, removed: 0, posts: 1, unchanged: true });
    expect(quiet.requests[0]).toMatchObject({ op: 'summary', objects: 0 });
    expect(quiet.requests[0].bytes).toBeLessThan(10_000);
    objects[2] = { ...objects[2], stamp: 'Nov 2, 2026 10:00:00', day: '2026-11-02', code: { expression: 'changed' } };
    objects.splice(3, 1);
    const next = await syncCodeIndex(client, store, env, { signal: new AbortController().signal, now: day('2026-11-03') });
    // Summary, the changed objects of the changed types, a count for the
    // type whose count moved, one read.
    expect(next.requests.map(r => r.op)).toEqual(['summary', 'list changed', 'read code', 'count']);
    expect(next).toMatchObject({ changed: 1, removed: 1 });
    expect((await store.get(env, '9007199254740997'))?.code.expression).toBe('changed');
    expect(await store.get(env, '9007199254740999')).toBeNull();
    expect((await store.getMeta(env))).toMatchObject({ objects: 3, pending: 0 });
  });

  it('stops at the first answer of an overloaded server, without retrying', async () => {
    const objects = sim();
    let n = 0;
    const client = server(objects, { overload: code => code.includes('"~CREV_R~1:I"') && ++n > 0 });
    const store = new MemoryCodeIndexStore();
    await expect(syncCodeIndex(client, store, 'e', { signal: new AbortController().signal })).rejects.toBeInstanceOf(ServerOverloadError);
    expect(n).toBe(1);
    expect(client.posts.flat().filter(c => c.includes('"~CREV_R~1:I"')).length).toBe(1);
  });

  it('isolates an unreadable object by halving its read, paced', async () => {
    const objects = sim();
    const store = new MemoryCodeIndexStore();
    const res = await syncCodeIndex(server(objects, { failRid: '9007199254740997' }), store, 'e', { signal: new AbortController().signal });
    expect(res.failed).toBe(1);
    expect(await store.get('e', '9007199254740999')).not.toBeNull();
    expect(await store.get('e', '9007199254740997')).toBeNull();
    expect((await store.getMeta('e'))?.failed).toBe(1);
  });

  it('refuses a server without lookup()', async () => {
    await expect(syncCodeIndex(server(sim(), { lookup: false }), new MemoryCodeIndexStore(), 'e', { signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(IndexUnavailableError);
  });

  it('re-reads a saved object alone', async () => {
    const objects = sim();
    const { store, client } = await built(objects);
    objects[0].code.expression = 'saved';
    expect(await refreshIndexedObjects(client, store, 'p1@https://bmp.test/W/', ['9007199254740993'], new AbortController().signal)).toBe(1);
    expect((await store.get('p1@https://bmp.test/W/', '9007199254740993'))?.code.expression).toBe('saved');
  });

  it('deletes the index of one profile only', async () => {
    const store = new MemoryCodeIndexStore();
    await syncCodeIndex(server(sim()), store, 'a@u', { signal: new AbortController().signal });
    await syncCodeIndex(server(sim()), store, 'b@u', { signal: new AbortController().signal });
    await store.clear({ profileId: 'a' });
    expect(await store.getMeta('a@u')).toBeNull();
    expect(await store.getMeta('b@u')).not.toBeNull();
  });
});

// ── search ────────────────────────────────────────────────────────

describe('runCodeSearch on the index', () => {
  it('is complete and case-insensitive across every object and property', async () => {
    const { source } = await built();
    const cs = await search({ mode: 'text', text: 'today' }, source);
    expect(cs.hits.map(h => h.rid).sort()).toEqual(['9007199254740993', '9007199254740997', '9007199254740999']);
    expect(cs.outcome.coverage).toMatchObject({ source: 'index', searched: 4, total: 4, complete: true });
    const ci = await search({ mode: 'text', text: 'TODAY', caseSensitive: false }, source);
    expect(ci.outcome.matches).toBe(5); // today, TODAY (comment), Today, todays, today
    const ww = await search({ mode: 'text', text: 'today', caseSensitive: false, wholeWord: true }, source);
    expect(ww.outcome.matches).toBe(4);
    const rx = await search({ mode: 'text', text: 'when\\w+', regex: true }, source);
    expect(rx.hits[0].props[0].lines[0]).toMatchObject({ line: 3, ranges: [[6, 17]] });
  });

  it('pages objects but counts all, and filters by type and subtree', async () => {
    const { source } = await built();
    const page = await search({ mode: 'text', text: 'today', caseSensitive: false, limit: 1, offset: 1 }, source);
    expect(page.hits).toHaveLength(1);
    expect(page.outcome).toMatchObject({ matchedObjects: 3, more: true });
    const typed = await search({ mode: 'text', text: 'today', types: ['ButtonInput'] }, source);
    expect(typed.hits.map(h => h.props[0].prop)).toEqual(['afterExpression']);
    const scoped = await search({ mode: 'text', text: 'today', scopeRids: new Set(['9007199254740997', '1']) }, source);
    expect(scoped.outcome.coverage).toMatchObject({ searched: 1, total: 2, complete: false });
  });

  it('filters by property and counts what each type and property filter would give', async () => {
    const { source } = await built();
    const any = await search({ mode: 'text', text: 'today', caseSensitive: false }, source);
    expect(any.outcome.typeCounts).toEqual({ ExtendedExpression: 1, ExtendedTable: 1, ButtonInput: 1 });
    expect(any.outcome.propCounts).toEqual({ expression: 2, afterExpression: 1 });
    // Type filter: the type counts still show the other types; the property
    // counts follow the chosen type.
    const typed = await search({ mode: 'text', text: 'today', caseSensitive: false, types: ['ButtonInput'] }, source);
    expect(typed.outcome).toMatchObject({ matchedObjects: 1, byType: { ButtonInput: 1 }, propCounts: { afterExpression: 1 } });
    expect(typed.outcome.typeCounts).toEqual(any.outcome.typeCounts);
    expect(typed.outcome.coverage.searched).toBe(1);
    // Property filter: only that property's lines and matches; the property
    // counts still show the others, the type counts follow the property.
    const prop = await search({ mode: 'text', text: 'today', caseSensitive: false, props: ['expression'] }, source);
    expect(prop.hits.map(h => h.type).sort()).toEqual(['ExtendedExpression', 'ExtendedTable']);
    expect(prop.hits.every(h => h.props.every(p => p.prop === 'expression'))).toBe(true);
    expect(prop.outcome.propCounts).toEqual(any.outcome.propCounts);
    expect(prop.outcome.typeCounts).toEqual({ ExtendedExpression: 1, ExtendedTable: 1 });
    // A menu count is the number of results after choosing that entry.
    for (const [t, n] of Object.entries(any.outcome.typeCounts)) {
      expect((await search({ mode: 'text', text: 'today', caseSensitive: false, types: [t] }, source)).outcome.matchedObjects).toBe(n);
    }
    for (const [p, n] of Object.entries(any.outcome.propCounts)) {
      expect((await search({ mode: 'text', text: 'today', caseSensitive: false, props: [p] }, source)).outcome.matchedObjects).toBe(n);
    }
    // Both filters: an object needs a match in a chosen property.
    const both = await search({ mode: 'text', text: 'today', caseSensitive: false, types: ['ButtonInput'], props: ['expression'] }, source);
    expect(both.outcome.matchedObjects).toBe(0);
    expect(both.outcome.propCounts).toEqual({ afterExpression: 1 });
  });

  it('finds references with the shared finder: comments, strings and other ID spaces do not count', async () => {
    const { source } = await built();
    const resolveKeys = async (keys: string[]) => Object.fromEntries(keys.map(k => [k, k === 't.assessment_basis_values'
      ? { found: true as const, target: { rid: '9007199254740993', type: 'ExtendedExpression', name: '', businessId: 'assessment_basis_values' } }
      : { found: true as const, target: { rid: '1', type: 'CeRisk', name: '', businessId: 'assessment_basis_values' } }]));
    const r = await search({ mode: 'refs', target: { rid: '9007199254740993', businessId: 'assessment_basis_values' } }, source, resolveKeys);
    expect(r.hits.map(h => h.rid)).toEqual(['9007199254740995']);
    expect(r.hits[0].props[0].lines.map(l => [l.line, l.form])).toEqual([[1, 't.assessment_basis_values'], [4, '{assessment_basis_values}'], [5, 'lookup(9007199254740993)']]);
  });
});

describe('server scan fallback', () => {
  it('scans candidates in one post, reads them and reports what it covered', async () => {
    const client = server(sim(), { lookup: false });
    const hits: CodeSearchHit[] = [];
    const out = await runCodeSearch({ mode: 'text', text: 'Today', caseSensitive: false }, serverSource(client), h => hits.push(...h));
    expect(hits.map(h => h.rid).sort()).toEqual(['9007199254740993', '9007199254740997', '9007199254740999']);
    expect(out.coverage).toMatchObject({ source: 'server', searched: 4, total: 4, complete: true });
    // One listing post (here the whole server, every type in it), then the
    // reads; the search text is never sent: the code is matched here.
    expect(client.posts.every(p => p.every(code => code.length <= SCRIPT_MAX_CHARS))).toBe(true);
    expect(client.posts.filter(p => p.some(code => code.includes('~CREV_R~1:L'))).length).toBe(1);
    expect(client.posts[0].join('\n').match(/_l := SELECT/g)).toHaveLength(Object.keys(STATIC_CODE_PROPS).length);
    expect(client.posts.flat().some(code => /today/i.test(code))).toBe(false);
  });

  it('feeds the AI tool flat property results', async () => {
    const { source } = await built();
    const r = await collectCodeSearch(source, 'today', { cap: 2 });
    expect(r.results.length).toBe(2);
    expect(r.complete).toBe(true);
  });
});


const ids = (hs: CodeSearchHit[]) => hs.flatMap(h => [h.rid, ...(h.instances ?? []).map(i => i.rid)]).sort();

describe('code index by root', () => {
  it('records the root and the organisation path of every object, and stores template code once', async () => {
    const { orgs, objects } = orgWorld();
    const client = server(objects, { orgs });
    const store = new MemoryCodeIndexStore();
    const res = await syncCodeIndex(client, store, 'e', { signal: new AbortController().signal, now: () => 1 });
    expect(res.stages.map(s => s.stage)).toEqual(['roots list', 'roots', 'organisation', 'fold', 'completeness']);
    expect((await store.get('e', '1'))).toMatchObject({ root: 'templateCategory', code: { expression: 'SELECT CeRisk WHERE due < today' } });
    expect((await store.get('e', '3'))?.root).toBe('expression');
    const inst = await store.get('e', '1002');
    expect(inst).toMatchObject({ root: 'organisation', path: ['100', '110'], tmpl: '1', inherits: ['expression'], code: {} });
    const over = await store.get('e', '1006');
    expect(over).toMatchObject({ tmpl: '2', inherits: ['expression'], code: { afterExpression: '_y := today' } });
    const meta = await store.getMeta('e');
    expect(meta?.roots).toMatchObject({
      templateCategory: { name: 'Template category', objects: 2, done: true },
      organisation: { name: 'Organization', objects: 7, done: true, tops: 2, topsDone: 2 },
    });
    expect(meta?.orgs?.['110']).toEqual({ name: 'Europe', parent: '100' });
    // Every top-level organisation is its own list.
    expect([...new Set(client.posts.flat().filter(c => /_g := lookup\(\d+\)/.test(c)).map(c => /lookup\((\d+)\)/.exec(c)![1]))]).toEqual(['100', '200']);
  });

  it('is searchable after the first stage, and says what is covered', async () => {
    const { orgs, objects } = orgWorld();
    const store = new MemoryCodeIndexStore();
    const seen: Array<{ stage?: string; done: string[] }> = [];
    const client = server(objects, { orgs });
    const exec = client.executeEcBatch.bind(client);
    client.executeEcBatch = async (codes, signal, t) => {
      const m = await store.getMeta('e');
      if (codes.some(c => /_g := lookup/.test(c)) && m) seen.push({ stage: m.stage, done: Object.entries(m.roots ?? {}).filter(([, r]) => r.done).map(([k]) => k) });
      return exec(codes, signal, t);
    };
    await syncCodeIndex(client, store, 'e', { signal: new AbortController().signal, now: () => 1 });
    expect(seen[0]).toEqual({ stage: 'organisation', done: ['templateCategory', 'expression'] });
    // A search during stage 2: complete for a covered root, partial otherwise.
    const done = (await store.getMeta('e'))!;
    const meta = { ...done, builtAt: null, stage: 'organisation' as const, roots: { ...done.roots!, organisation: { name: 'Organization', objects: 2, done: false, tops: 2, topsDone: 1, topsRead: ['100'] } } };
    const src = indexSource(meta, storeReader(store, 'e'));
    const scoped = await search({ mode: 'text', text: 'today', where: ['root:templateCategory'] }, src);
    expect(scoped.outcome.coverage).toMatchObject({ complete: true, scopedComplete: true });
    expect((await search({ mode: 'text', text: 'today', where: ['org:110'] }, src)).outcome.coverage.complete).toBe(true);
    expect((await search({ mode: 'text', text: 'today', where: ['org:200'] }, src)).outcome.coverage.complete).toBe(false);
    const all = await search({ mode: 'text', text: 'today' }, src);
    expect(all.outcome.coverage).toMatchObject({ complete: false, roots: { done: ['templateCategory', 'expression'], pending: ['organisation'], tops: { done: 1, total: 2 } } });
  });

  it('folds instances into their template: the same matches, fewer rows', async () => {
    const { orgs, objects } = orgWorld();
    const store = new MemoryCodeIndexStore();
    await syncCodeIndex(server(objects, { orgs }), store, 'e', { signal: new AbortController().signal, now: () => 1 });
    const src = indexSource(await store.getMeta('e'), storeReader(store, 'e'));
    const plain = await search({ mode: 'text', text: 'today' }, src);
    const folded = await search({ mode: 'text', text: 'today', fold: true }, src);
    // Unfolded: every object with its own effective code.
    expect(plain.outcome.matchedObjects).toBe(10);
    expect(plain.hits.find(h => h.rid === '1002')?.props[0].lines[0].text).toBe('SELECT CeRisk WHERE due < today');
    expect(folded.outcome).toMatchObject({ matchedObjects: 10, matches: plain.outcome.matches, rows: 4 });
    const table = folded.hits.find(h => h.rid === '1')!;
    expect(table.instances?.map(i => i.rid).sort()).toEqual(['1000', '1002', '1004']);
    const over = folded.hits.find(h => h.rid === '1006')!;
    expect(over).toMatchObject({ overridden: true, tmpl: '2' });
    expect(over.props.map(p => p.prop).sort()).toEqual(['afterExpression', 'expression']);
    // The same set of objects, folded or not.
    expect(ids(folded.hits)).toEqual(ids(plain.hits));
    // Under one organisation the template is not in the results: the first
    // instance carries the row.
    const under = await search({ mode: 'text', text: 'today', fold: true, where: ['org:110'] }, src);
    expect(under.hits.map(h => h.rid).sort()).toEqual(['1002', '1003', '1006']);
    expect(under.outcome.whereCounts).toMatchObject({ 'org:100': 5, 'org:110': 3, 'org:200': 2, 'root:templateCategory': 2 });
  });

  it('finds references inherited from the template', async () => {
    const { orgs, objects } = orgWorld();
    for (const o of objects) if (o.rid === '1' || o.tmpl === '1') o.code = { expression: '_e := t.e1.expression' };
    const store = new MemoryCodeIndexStore();
    await syncCodeIndex(server(objects, { orgs }), store, 'e', { signal: new AbortController().signal, now: () => 1 });
    const src = indexSource(await store.getMeta('e'), storeReader(store, 'e'));
    const resolve = async (keys: string[]) => Object.fromEntries(keys.map(k => [k, { found: true as const, target: { rid: '3', type: 'ExtendedExpression', name: '', businessId: 'e1' } }]));
    const r = await search({ mode: 'refs', target: { rid: '3', businessId: 'e1' }, fold: true }, src, resolve);
    expect(r.outcome.matchedObjects).toBe(4);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].instances).toHaveLength(3);
  });

  it('reads an instance again only when its own stamp changes, and detects removal per list', async () => {
    const { orgs, objects } = orgWorld();
    const client = server(objects, { orgs });
    const store = new MemoryCodeIndexStore();
    await syncCodeIndex(client, store, 'e', { signal: new AbortController().signal, now: () => Date.parse('2026-11-01T10:00:00Z') });
    for (const o of objects) o.day = '2026-10-01';
    // The template changes; its instances follow it (inherited), unread.
    objects[0] = { ...objects[0], stamp: 's2', day: '2026-11-02', code: { expression: 'SELECT CeRisk WHERE due < today + 7' } };
    // One instance is edited: read again, compared with the new template.
    const edited = objects.find(o => o.rid === '1002')!;
    Object.assign(edited, { stamp: 's3', day: '2026-11-02', code: { expression: 'SELECT CeRisk WHERE due < today + 7' } });
    // An instance is deleted.
    objects.splice(objects.findIndex(o => o.rid === '1005'), 1);
    const res = await syncCodeIndex(client, store, 'e', { signal: new AbortController().signal, now: () => Date.parse('2026-11-03T10:00:00Z') });
    expect(res.removed).toBe(1);
    expect(await store.get('e', '1005')).toBeNull();
    expect(res.changed).toBe(2); // the template and the edited instance
    expect(await store.get('e', '1002')).toMatchObject({ inherits: ['expression'], code: {} });
    expect(await store.get('e', '1000')).toMatchObject({ inherits: ['expression'], code: {} });
  });

  it('places an object without an organisation of its own under the organisation it was listed in', async () => {
    const { orgs, objects } = orgWorld();
    objects.push({ rid: '1100', type: 'CustomVisualizationExpression', id: 'cve', name: 'Data input', stamp: 's', root: 'organisation', top: '200', code: { expression: '${table.t.x}' } });
    const store = new MemoryCodeIndexStore();
    await syncCodeIndex(server(objects, { orgs }), store, 'e', { signal: new AbortController().signal, now: () => 1 });
    expect(await store.get('e', '1100')).toMatchObject({ root: 'organisation', path: ['200'] });
  });

  it('keeps objects without an organisation when a list is split, and names what the index misses', async () => {
    const { orgs, objects } = orgWorld();
    objects.push({ rid: '1101', type: 'ExtendedTable', id: 'x', name: 'Org-less table', stamp: 's', root: 'organisation', top: '100', code: { expression: 'today' } });
    const client = server(objects, { orgs });
    const store = new MemoryCodeIndexStore();
    await syncCodeIndex(client, store, 'e', { signal: new AbortController().signal, now: () => 1, listRows: 1 });
    expect(await store.get('e', '1101')).toMatchObject({ path: ['100'] });
    expect(client.posts.flat().some(c => c.includes('organisation.rid.whenMissing("")) = ""'))).toBe(true);
    expect((await store.getMeta('e'))?.incomplete).toBeUndefined();
    // An object the lists never reach is counted by the completeness check.
    const hidden = { rid: '1200', type: 'ExtendedTable', id: 'h', name: 'Hidden', stamp: 's', root: 'organisation', top: '999', code: { expression: 'x' } };
    const store2 = new MemoryCodeIndexStore();
    await syncCodeIndex(server([...objects, hidden], { orgs }), store2, 'e', { signal: new AbortController().signal, now: () => 1 });
    expect((await store2.getMeta('e'))?.incomplete).toEqual({ ExtendedTable: 1 });
  });

  it('splits a list too large for one script into the organisation and its sub-organisations', async () => {
    const { orgs, objects } = orgWorld();
    const client = server(objects, { orgs });
    const store = new MemoryCodeIndexStore();
    // A budget of one row a list: the top organisation with two tables is
    // listed as its own objects and its sub-organisation.
    await syncCodeIndex(client, store, 'e', { signal: new AbortController().signal, now: () => 1, listRows: 1 });
    expect(await store.get('e', '1000')).toMatchObject({ path: ['100'] });
    expect(await store.get('e', '1002')).toMatchObject({ path: ['100', '110'] });
    expect(client.posts.flat().some(c => c.includes('_g := lookup(100)') && c.includes('organisation = _g') && c.includes('_l.calculate('))).toBe(true);
    expect(client.posts.flat().some(c => c.includes('_g := lookup(110)') && c.includes('_l.calculate('))).toBe(true);
  });
});

describe('instances folded here, not on the server', () => {
  it('keeps a property once when the text is the template’s, and folds a row only when every template property is inherited', async () => {
    const o = { rid: '2', businessId: 'b', name: 'n', parent: '', grandparent: '', stamp: 's', tmpl: '1', code: { expression: 'a*b', afterExpression: 'own' } };
    expect(foldIntoTemplate(o, { code: { expression: 'a*b', afterExpression: 'x' } })).toMatchObject({ code: { afterExpression: 'own' }, inherits: ['expression'] });
    expect(foldIntoTemplate(o, null)).toBe(o);
    const t: SearchableObject = { rid: '1', type: 'T', name: 't', businessId: 't', where: '', code: { expression: 'x', showExpression: 'y' }, refs: [] };
    const i: SearchableObject = { rid: '2', type: 'T', name: 'i', businessId: 'i', where: '', code: {}, refs: [], tmpl: '1', inherits: ['expression'] };
    const byRid = new Map([['1', t], ['2', i]]);
    expect(isIdentical(i, byRid)).toBe(false); // the template's show expression is not the instance's
    expect(isIdentical({ ...i, inherits: ['expression', 'showExpression'] }, byRid)).toBe(true);
  });
});

describe('live search without an index', () => {
  it('reads one source a post, tags the results with their root and folds instances found together', async () => {
    const { orgs, objects } = orgWorld();
    const client = server(objects, { orgs, context: true });
    const src = serverSource(client, { sources: [{ from: 'root.templateCategory', root: 'templateCategory' }, { from: 'lookup(100)', root: 'organisation', path: ['100'] }] });
    const hits: CodeSearchHit[] = [];
    const out = await runCodeSearch({ mode: 'text', text: 'today', fold: true }, src, h => hits.push(...h));
    // The template root and one organisation: an organisation goes alone.
    expect(client.posts.filter(p => p[0].includes('~CREV_R~1:L'))).toHaveLength(2);
    // Templates and the instances under organisation 100 (and its sub-organisation).
    expect(out.matchedObjects).toBe(2 + 5);
    expect(hits.find(h => h.rid === '1')?.instances?.map(i => i.rid).sort()).toEqual(['1000', '1002']);
    expect(hits.find(h => h.rid === '1006')).toMatchObject({ overridden: true, root: 'organisation' });
    expect(out.whereCounts['root:templateCategory']).toBe(2);
  });

  it('reads a small server whole, so a pattern without fixed text is searched too', async () => {
    const client = server(sim());
    const out = await runCodeSearch({ mode: 'text', text: '(to|in)day', regex: true }, serverSource(client), () => {});
    expect(out.matchedObjects).toBe(3);
    expect(out.coverage).toMatchObject({ searched: 4, total: 4, complete: true });
  });

  it('keeps what it read: a second search reads only what changed', async () => {
    const objects = sim();
    const client = server(objects);
    const src = () => serverSource(client, { env: 'cache-test' });
    await runCodeSearch({ mode: 'text', text: 'today' }, src(), () => {});
    const reads = () => client.posts.filter(p => p[0].includes('"~CREV_R~1:I"')).flatMap(p => [...p[0].matchAll(/lookup\((-?\d+)\)/g)].map(m => m[1]));
    expect(reads().sort()).toEqual(objects.map(o => o.rid).sort());
    client.posts.length = 0;
    objects[2] = { ...objects[2], stamp: 'Nov 2, 2026 10:00:00', code: { expression: 'today again' } };
    const hits: CodeSearchHit[] = [];
    // Changed on the server meanwhile: Search again lists again.
    const out = await runCodeSearch({ mode: 'text', text: 'again' }, serverSource(client, { env: 'cache-test', fresh: true }), h => hits.push(...h));
    expect(reads()).toEqual([objects[2].rid]);
    expect(hits.map(h => h.rid)).toEqual([objects[2].rid]);
    expect(out.coverage).toMatchObject({ searched: 4, total: 4, complete: true });
  });

  it('above the read-all limit: small varying scripts narrow on the server, a pattern without fixed text is refused', async () => {
    // A client with the context path whose server holds too much code to read whole.
    const posts: Array<Array<{ code: string; objectRid?: string }>> = [];
    const big = { rid: '11', type: 'ExtendedExpression', stamp: 's', len: 30_000_000 };
    const hit = { rid: '12', type: 'ExtendedExpression', stamp: 's', len: 20 };
    const answer = (code: string): EcResult => {
      if (code.includes('~CREV_R~1:L')) return { ok: true, log: [big, hit].map(o => framedText([['L', o.type, o.rid, o.stamp, String(o.len)]], false)).join('') + '~CREV_D~' };
      if (code.includes('#END')) return { ok: true, log: '12,#END' };
      if (code.includes('~CREV_R~1:I')) return { ok: true, log: framedText([['I', '12', 'e12', 'E 12', 'P', 'G', 's', ''], ['C', '12', 'expression', 'x := "needle"']], true) };
      return { ok: false, error: 'unexpected' };
    };
    const client = {
      ensureLookupSupport: async () => true,
      resolveRefs: async (rids: readonly string[]) => new Map(rids.map(r => [r, `lookup(${r})`])),
      executeEcBatch: async (codes: readonly string[]) => codes.map(answer),
      executeEcPairs: async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => { posts.push([...pairs]); return pairs.map(p => answer(p.code)); },
      executeEcEach: async (code: string, rids: readonly string[]) => { posts.push(rids.map(objectRid => ({ code, objectRid }))); return new Map(rids.map(r => [r, answer(code)])); },
    };
    const src = () => serverSource(client, { sources: [{ from: 'root.expression', rid: '5', root: 'expression' }], map: { ExtendedExpression: ['expression'] } });
    await expect(runCodeSearch({ mode: 'text', text: '(a|b)', regex: true }, src(), () => {})).rejects.toBeInstanceOf(NeedsIndexError);
    posts.length = 0;
    const hits: CodeSearchHit[] = [];
    const out = await runCodeSearch({ mode: 'text', text: 'needle' }, src(), h => hits.push(...h));
    const narrow = posts.flat().filter(p => p.code.includes('#END'));
    expect(narrow.length).toBeGreaterThan(0);
    for (const p of narrow) { expect(p.code.length).toBeLessThanOrEqual(1_200); expect(p.objectRid).toBe('5'); expect(classifyScript(p.code).kind).toBe('varying'); }
    // Only the hit is read; the listing stays constant.
    expect(posts.flat().filter(p => p.code.includes('~CREV_R~1:I')).map(p => p.objectRid)).toEqual(['12']);
    for (const p of posts.flat().filter(p => p.code.includes('~CREV_R~1:L'))) expect(classifyScript(p.code).kind).toBe('constant');
    expect(hits.map(h => h.rid)).toEqual(['12']);
    expect(out.coverage).toMatchObject({ searched: 2, total: 2, complete: true });
  });

  it('scans a listed scope object by object and reads only the candidates', async () => {
    const client = server(sim());
    // The scope "under an object" (code-search-scope): the button and the two expressions.
    const items = [
      { rid: '9007199254740999', type: 'ButtonInput' },
      { rid: '9007199254740993', type: 'ExtendedExpression' },
      { rid: '9007199254740995', type: 'ExtendedExpression' },
    ];
    const hits: CodeSearchHit[] = [];
    const out = await runCodeSearch({ mode: 'text', text: 'today', caseSensitive: false }, serverSource(client, { items }), h => hits.push(...h));
    // No search text on the server: the listed objects are read, matched here.
    expect(client.posts.flat().some(code => /today/i.test(code))).toBe(false);
    expect(hits.map(h => h.rid).sort()).toEqual(['9007199254740993', '9007199254740999']);
    // The coverage is the listed scope: every listed object has code.
    expect(out.coverage).toMatchObject({ source: 'server', searched: 3, total: 3, complete: true });
    const reads = client.posts.filter(p => p[0].includes('"~CREV_R~1:I"'));
    expect(reads.flatMap(p => [...p[0].matchAll(/lookup\((-?\d+)\)/g)].map(m => m[1])).sort()).toEqual(items.map(i => i.rid).sort());
  });

  it('a pattern without fixed text is allowed on a listed scope', async () => {
    const client = server(sim());
    const out = await runCodeSearch({ mode: 'text', text: '(a|b)', regex: true }, serverSource(client, { items: [{ rid: '9007199254740993', type: 'ExtendedExpression' }] }), () => {});
    expect(out.coverage.total).toBe(1);
  });

  it('confirms "Used in code" with the reference finder: comments and strings do not count', async () => {
    const client = server(sim());
    const hits: CodeSearchHit[] = [];
    const resolveKeys = async (keys: string[]) => Object.fromEntries(keys.map(k => [k, { found: true as const, target: { rid: '9007199254740993', type: 'ExtendedExpression', name: '', businessId: 'assessment_basis_values' } }]));
    await runCodeSearch({ mode: 'refs', target: { rid: '9007199254740993', businessId: 'assessment_basis_values' } }, serverSource(client), h => hits.push(...h), { resolveKeys });
    // The table names o.assessment_basis_values only in another ID space; the expression has it in code.
    expect(hits.map(h => h.rid)).toContain('9007199254740995');
    expect(hits.find(h => h.rid === '9007199254740995')!.props[0].lines.map(l => l.line)).toEqual([1, 4, 5]);
  });
});
