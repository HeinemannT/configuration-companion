/**
 * The object count of the code index (countTargets): the root or the
 * organisation travels as the command's context, so the number of distinct
 * script texts is bounded by the type list, not by the number of roots;
 * a place that cannot be counted is named, never skipped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { checkCompleteness, countGroups, countTargets, rootBucket, type IndexClient } from '../code-index-sync';
import { classifyScript, constantScript, CONSTANT_TEXTS_PER_BUILDER, resetScriptKinds, scriptLimitProblem } from '../script-kinds';
import { Pacer } from '../index-budget';
import { server, ROOT_RIDS, type SimObject } from './code-search-sim';
import type { EcResult } from '../bmp-client';
import { chunkByScriptSize, framedText, STATIC_EC_FRAME as F } from '../ec-parser';

afterEach(() => resetScriptKinds());

const TYPES = Array.from({ length: 300 }, (_, i) => `CodeType${String(i).padStart(3, '0')}`);
const ROOTS = Array.from({ length: 40 }, (_, i) => ({ key: `root${i}`, rid: String(5000 + i) }));

/** A server that counts `n(root, type)` objects; records every text. */
function counter(opts: { context: boolean; refuse?: (source: string) => boolean }) {
  const texts: string[] = [];
  const n = (root: string, type: string) => (Number(root.replace(/\D/g, '')) * 7 + Number(type.slice(8))) % 5;
  const answer = (code: string, source: string): EcResult => {
    texts.push(code);
    if (opts.refuse?.(source)) return { ok: false, error: 'Count refused', errorKind: 'server' };
    const root = source.startsWith('root.') ? source.slice(5) : ROOTS.find(r => r.rid === source)!.key;
    const rows = [...code.matchAll(/SELECT (\w+) FROM _g/g)].map(m => ['N', '*', m[1], String(n(root, m[1]))]);
    return { ok: true, log: `${framedText(rows, false)}${F.done}` };
  };
  const client: IndexClient = {
    ensureLookupSupport: async () => true,
    resolveRefs: async () => new Map(),
    executeEcBatch: async codes => codes.map(code => answer(code, /^_g := (\S+)$/m.exec(code)![1])),
    ...(opts.context ? {
      executeEcPairs: async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => pairs.map(p => answer(p.code, p.objectRid!)),
      ensureContextSupport: async () => true,
    } : {
      executeEcPairs: async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => pairs.map(() => ({ ok: false, error: 'not supported' })),
      ensureContextSupport: async () => false,
    }),
  };
  return { client, texts, n };
}

describe('the object count', () => {
  it('40 roots and 300 types: a handful of texts, the same for every root, all constant', async () => {
    const { client, texts, n } = counter({ context: true });
    const { counts, failed } = await countTargets(client, ROOTS.map(r => ({ bucket: rootBucket(r.key), rid: r.rid })), TYPES);
    expect(failed.size).toBe(0);
    const distinct = new Set(texts);
    expect(distinct.size).toBe(countGroups(TYPES).length);
    expect(distinct.size).toBeLessThanOrEqual(12);
    for (const t of distinct) {
      expect(t).not.toMatch(/root\.|lookup\(/);
      expect(classifyScript(t).kind).toBe('constant');
    }
    // A count of other roots, or of whole groups, asks nothing new.
    const first = countGroups(TYPES).slice(0, 2).flat();
    await countTargets(client, ROOTS.slice(30).map(r => ({ bucket: rootBucket(r.key), rid: r.rid })), first, { all: TYPES });
    expect(new Set(texts).size).toBe(distinct.size);
    // Every root and type is counted, with the server's number.
    expect(counts.size).toBe(40 * 300);
    for (const r of ROOTS) for (const t of TYPES.slice(0, 20)) expect(counts.get(`r:${r.key}|${t}`)).toBe(n(r.key, t));
  });

  it('a few types of many: one small text per type, still the same for every root', async () => {
    const { client, texts } = counter({ context: true });
    await countTargets(client, ROOTS.map(r => ({ bucket: rootBucket(r.key), rid: r.rid })), ['CodeType007', 'CodeType123'], { all: TYPES });
    expect(new Set(texts).size).toBe(2);
    for (const t of texts) expect(t.length).toBeLessThan(400);
  });

  it('a server that ignores the context: the root in the text, one text per root and type group', async () => {
    const { client, texts, n } = counter({ context: false });
    const { counts, failed } = await countTargets(client, ROOTS.slice(0, 13).map(r => ({ bucket: rootBucket(r.key), rid: r.rid })), TYPES);
    expect(failed.size).toBe(0);
    expect(new Set(texts).size).toBe(13 * countGroups(TYPES).length);
    for (const t of texts) expect(classifyScript(t).kind).toBe('constant');
    expect(counts.get('r:root3|CodeType042')).toBe(n('root3', 'CodeType042'));
  });

  it('gives the same results as the per-root form on a fixture', async () => {
    const objects: SimObject[] = [
      { rid: '1', type: 'ExtendedTable', id: 'a', name: 'A', stamp: 's', root: 'templateCategory', code: { expression: 'x' } },
      { rid: '2', type: 'ExtendedTable', id: 'b', name: 'B', stamp: 's', root: 'templateCategory', code: { expression: 'x' } },
      { rid: '3', type: 'ActionButton', id: 'c', name: 'C', stamp: 's', root: 'portal', code: { expression: 'x' } },
      { rid: '4', type: 'ExtendedExpression', id: 'd', name: 'D', stamp: 's', root: 'expression', code: { expression: 'x' } },
    ];
    const types = ['ActionButton', 'ExtendedExpression', 'ExtendedTable'];
    const roots = ['templateCategory', 'portal', 'expression'];
    const byContext = await countTargets(server(objects, { context: true }), roots.map(k => ({ bucket: rootBucket(k), rid: ROOT_RIDS[k] })), types);
    const byText = await countTargets(server(objects), roots.map(k => ({ bucket: rootBucket(k) })), types);
    expect(byContext.failed.size + byText.failed.size).toBe(0);
    expect(byContext.counts).toEqual(byText.counts);
    expect(byContext.counts.get('r:templateCategory|ExtendedTable')).toBe(2);
    expect(byContext.counts.get('r:portal|ExtendedTable')).toBe(0);
  });

  it('a root refused as a context is counted with its name in the text', async () => {
    const { client, texts, n } = counter({ context: true, refuse: s => s === ROOTS[2].rid });
    const { counts, failed } = await countTargets(client, ROOTS.slice(0, 4).map(r => ({ bucket: rootBucket(r.key), rid: r.rid })), TYPES.slice(0, 10));
    expect(failed.size).toBe(0);
    expect(counts.get('r:root2|CodeType004')).toBe(n('root2', 'CodeType004'));
    expect(texts.some(t => t.includes('_g := root.root2'))).toBe(true);
  });

  it('a root that cannot be counted is reported with the reason, the others are counted', async () => {
    const { client } = counter({ context: true, refuse: s => s === ROOTS[1].rid || s === `root.${ROOTS[1].key}` });
    const { counts, failed } = await countTargets(client, ROOTS.slice(0, 3).map(r => ({ bucket: rootBucket(r.key), rid: r.rid })), TYPES);
    expect([...failed]).toEqual([['r:root1', 'Count refused']]);
    expect([...counts.keys()].some(k => k.startsWith('r:root1|'))).toBe(false);
    expect([...counts.keys()].filter(k => k.startsWith('r:root0|'))).toHaveLength(300);
    expect([...counts.keys()].filter(k => k.startsWith('r:root2|'))).toHaveLength(300);
  });

  it('the completeness check names a root it could not count', async () => {
    const objects: SimObject[] = [
      { rid: '1', type: 'ExtendedTable', id: 'a', name: 'A', stamp: 's', root: 'templateCategory', code: { expression: 'x' } },
      { rid: '3', type: 'ActionButton', id: 'c', name: 'C', stamp: 's', root: 'portal', code: { expression: 'x' } },
    ];
    const client = server(objects, { context: true, failCount: g => g === `lookup(${ROOT_RIDS.portal})` || g === 'root.portal' });
    const out = await checkCompleteness({
      client, pacer: new Pacer({ minPauseMs: 0, maxPauseMs: 0 }), signal: new AbortController().signal, stored: new Map(), empty: {},
      counters: { read: 0, changed: 0, removed: 0, failed: 0, bytes: 0, failedRids: new Set() }, rootRids: ROOT_RIDS,
    }, ['templateCategory', 'portal'], ['ActionButton', 'ExtendedTable']);
    expect(out.uncounted).toEqual({ portal: 'Count refused' });
    expect(out.missing).toEqual({ ExtendedTable: 1 });
  });
});

describe('script marks', () => {
  it('splitting a list measures its trial texts without marking them', () => {
    const groups = chunkByScriptSize(TYPES, g => constantScript('probe', g.join(',')), 500);
    expect(groups.length).toBeGreaterThan(1);
    // Neither a trial text nor a group is marked by the split itself.
    expect(classifyScript(TYPES.slice(0, 2).join(',')).kind).toBe('varying');
    expect(classifyScript(groups[0].join(',')).kind).toBe('varying');
    for (let i = 0; i < CONSTANT_TEXTS_PER_BUILDER; i++) constantScript('probe', `"${i}"`);
    expect(classifyScript(`"${CONSTANT_TEXTS_PER_BUILDER - 1}"`).kind).toBe('constant');
  });

  it('a refused text of a builder past its distinct texts says so, not that it is too long', () => {
    const pad = ' '.repeat(1_300);
    for (let i = 0; i <= CONSTANT_TEXTS_PER_BUILDER; i++) constantScript('runaway', `"${i}"${pad}`);
    const problem = scriptLimitProblem(classifyScript(`"${CONSTANT_TEXTS_PER_BUILDER}"${pad}`));
    expect(problem).toMatch(new RegExp(`runaway made more than ${CONSTANT_TEXTS_PER_BUILDER} different scripts`));
    expect(problem).not.toMatch(/limit of 1200/);
  });
});
