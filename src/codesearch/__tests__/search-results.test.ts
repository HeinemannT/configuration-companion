/**
 * One scan per query: the window keeps every row and pages through them;
 * a live scan shows its first results per read, before it ends, and the
 * final answer is the same as without them.
 */
import { describe, expect, it } from 'vitest';
import { indexSource, runCodeSearch, serverSource, type CodeSearchHit, type CodeSearchProgress, type CodeSearchSource, type SearchableObject } from '../../lib/code-search';
import { PAGE_ROWS, ResultList, runAll } from '../search-results';
import { server, type SimObject } from '../../lib/__tests__/code-search-sim';

function world(n: number): SearchableObject[] {
  return Array.from({ length: n }, (_, i) => ({
    rid: String(9_000_000_000_000_000_000n + BigInt(i)), type: 'ExtendedExpression', name: `Object ${String(i).padStart(4, '0')}`,
    businessId: `o${i}`, where: 'R › F', code: { expression: `a := 1\n_d := today${i % 3 ? '\n_e := today' : ''}` }, refs: [],
  }));
}

/** A local source that counts its scans. */
function counting(objects: SearchableObject[]): CodeSearchSource & { scans: number } {
  const base = indexSource({ builtAt: 1, pending: 0, objects: objects.length, syncedAt: 1 }, each => { each(objects); return Promise.resolve(); });
  const src = { ...base, scans: 0, scan: (...a: Parameters<CodeSearchSource['scan']>) => { src.scans++; return base.scan(...a); } };
  return src;
}

describe('result pages', () => {
  it('"Show more" pages through the rows of one scan: zero further scans', async () => {
    const src = counting(world(530));
    const list = new ResultList();
    const out = await runAll({ mode: 'text', text: 'today' }, src, list);
    expect(src.scans).toBe(1);
    expect(out).toMatchObject({ matchedObjects: 530, rows: 530, more: true });
    expect(list.hits).toHaveLength(PAGE_ROWS);
    expect(list.showMore()).toBe(200);
    expect(list.showMore()).toBe(130);
    expect(list.outcome?.more).toBe(false);
    expect(src.scans).toBe(1);
    // The same rows, in the same order, as paging through the engine did.
    const pages: CodeSearchHit[] = [];
    for (let offset = 0; offset < 530; offset += 200) await runCodeSearch({ mode: 'text', text: 'today', offset, limit: 200 }, counting(world(530)), h => pages.push(...h));
    expect(list.hits.map(h => h.rid)).toEqual(pages.map(h => h.rid));
    expect(list.hits).toEqual(pages);
  });

  it('keeps the shown page count for a quiet re-run', () => {
    expect(new ResultList(400).shown).toBe(400);
    expect(new ResultList(0).shown).toBe(PAGE_ROWS);
  });

  it('shows the rows found so far until the complete answer arrives', () => {
    const list = new ResultList();
    const h = (rid: string) => ({ rid } as CodeSearchHit);
    list.addPartial([h('2'), h('1')], { phase: 'read', postsDone: 1, posts: 1, read: 2, candidates: 9 });
    expect(list.hits.map(x => x.rid)).toEqual(['2', '1']);
    expect(list.progress?.read).toBe(2);
    list.addRows([h('1'), h('2'), h('3')]);
    expect(list.hits.map(x => x.rid)).toEqual(['1', '2', '3']);
  });
});

describe('live scan first results', () => {
  it('reports matching objects per read, then the same final answer as without', async () => {
    const objects: SimObject[] = Array.from({ length: 120 }, (_, i) => ({
      rid: String(8_000_000_000_000_000_000n + BigInt(i)), type: i % 2 ? 'ExtendedTable' : 'ExtendedExpression', id: `x${i}`, name: `X ${i}`, stamp: 's',
      code: { expression: i % 4 ? `_a := today\n_b := ${i}` : `_a := ${i}` },
    }));
    const partial: Array<{ n: number; p: CodeSearchProgress }> = [];
    const client = server(objects);
    const seen = new Set<string>();
    const finalHits: CodeSearchHit[] = [];
    const out = await runCodeSearch({ mode: 'text', text: 'today', limit: 1000 }, serverSource(client), h => finalHits.push(...h), {
      onPartial: (hits, p) => { partial.push({ n: hits.length, p }); for (const h of hits) seen.add(h.rid); },
    });
    const reads = client.posts.filter(p => p[0].includes('"~CREV_R~1:I"')).length;
    expect(reads).toBeGreaterThan(1);
    // Progress: the listing post, then one report per read with its
    // objects. No search text on the server: every object with code is
    // read (and kept for the next search), the 90 matches are found here.
    expect(partial.find(x => x.p.postsDone > 0)!.p).toMatchObject({ phase: 'scan', postsDone: 1, posts: 1 });
    const readReports = partial.filter(x => x.p.phase === 'read' && x.p.read > 0);
    expect(readReports).toHaveLength(reads);
    expect(readReports.at(-1)!.p).toMatchObject({ read: 120, candidates: 120 });
    expect(client.posts.flat().some(code => code.includes('today'))).toBe(false);
    // Every final hit was shown early, and nothing else.
    expect([...seen].sort()).toEqual(finalHits.map(h => h.rid).sort());
    // The final answer is the one without first results.
    const plain: CodeSearchHit[] = [];
    const out2 = await runCodeSearch({ mode: 'text', text: 'today', limit: 1000 }, serverSource(server(objects)), h => plain.push(...h));
    expect(finalHits).toEqual(plain);
    // Same answer; only the time of the listing differs.
    const noTime = (o: typeof out) => ({ ...o, ms: 0, coverage: { ...o.coverage, checkedAt: 0 } });
    expect(noTime(out)).toEqual(noTime(out2));
  });
});
