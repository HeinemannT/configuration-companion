/**
 * Code search at the scale of a large server, on synthetic data: 78,000
 * objects of code-bearing types, average code of about 840 characters, most
 * of it instances that repeat a template 19 times (5 % override it).
 * Measures local query time and memory for plain, ignore-case and regex
 * search and for "Used in code".
 *
 * `npm test` runs every query on 2,000 records and checks each finds
 * something. At full scale only with `npm run bench` (CREV_BENCH=1) or
 * CREV_SCALE=1: prints the numbers and fails when a query takes longer than
 * CREV_SCALE_MS (default 300 ms).
 */
import { describe, expect, it } from 'vitest';
import { refsOf } from '../code-index-sync';
import { indexSource, runCodeSearch, type CodeSearchRequest, type SearchableObject } from '../code-search';

const FULL = !!(process.env.CREV_SCALE || process.env.CREV_BENCH);
const LIMIT = Number(process.env.CREV_SCALE_MS ?? 300);

/** Deterministic pseudo-random numbers. */
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); }

const WORDS = ['_rows', 'SELECT', 'CeRiskAssessment', 'WHERE', 'owner', '=', 'this.user', 'AND', 'status', '!=', 't.closed', '.table(id, name, owner)',
  'IF', '_x', '>', '0', 'THEN', 'ENDIF', '.forEach(_r:', ')', 'whenMissing("")', 'today', 'lookup(', 'o.org_unit', 't.dashboard_table.expression', '+', '"text"', '// comment'];

function code(r: () => number, chars: number): string {
  const lines: string[] = [];
  let n = 0;
  while (n < chars) {
    const len = 4 + Math.floor(r() * 9);
    const line = Array.from({ length: len }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ') + (r() < 0.01 ? ' _d := t.due_date_reminder' : '');
    lines.push(line);
    n += line.length + 1;
  }
  return lines.join('\n');
}

function world(total = 78_000, repeat = 19): SearchableObject[] {
  const r = rng(7);
  const out: SearchableObject[] = [];
  const templates = Math.round(total / (repeat + 1));
  for (let i = 0; i < templates && out.length < total; i++) {
    const text = code(r, Math.round(200 + r() * 1300));
    const tmpl: SearchableObject = { rid: `9${String(i).padStart(18, '0')}`, type: 'ExtendedTable', name: `Table ${i}`, businessId: `table_${i}`, where: 'Templates › Pages', code: { expression: text }, refs: refsOf({ expression: text }), root: 'templateCategory' };
    out.push(tmpl);
    for (let k = 0; k < repeat && out.length < total; k++) {
      const over = r() < 0.05;
      const own = over ? `${text}\n_extra := today` : '';
      out.push({
        rid: `8${String(i * 100 + k).padStart(18, '0')}`, type: 'ExtendedTable', name: `Table ${i}`, businessId: `t_${i}_${k}`, where: 'Group › Unit',
        code: over ? { expression: own } : {}, refs: over ? refsOf({ expression: own }) : [], root: 'organisation', path: ['1', String(2 + (k % 18))],
        tmpl: tmpl.rid, inherits: over ? [] : ['expression'],
      });
    }
  }
  return out;
}

describe('code search at large-server scale (synthetic)', () => {
  it('answers plain, ignore-case, regex and "Used in code" queries within the budget', async () => {
    const heap0 = process.memoryUsage().heapUsed;
    const objects = FULL ? world() : world(2_000);
    const chars = objects.reduce((n, o) => n + Object.values(o.code).reduce((a, t) => a + t.length, 0), 0);
    const heap1 = process.memoryUsage().heapUsed;
    const src = indexSource({ builtAt: 1, pending: 0, objects: objects.length, syncedAt: 1 }, each => { each(objects); return Promise.resolve(); });
    const queries: Array<[string, CodeSearchRequest]> = [
      ['plain, rare', { mode: 'text', text: 'due_date_reminder', fold: true }],
      ['plain, everywhere', { mode: 'text', text: 'this.user', fold: true }],
      ['ignore case', { mode: 'text', text: 'DUE_DATE', caseSensitive: false, fold: true }],
      ['regex', { mode: 'text', text: 'due_\\w+_reminder', regex: true, fold: true }],
      ['plain, unfolded', { mode: 'text', text: 'due_date_reminder' }],
      ['used in code', { mode: 'refs', target: { rid: '1', businessId: 'dashboard_table' }, fold: true }],
    ];
    const rows: string[] = [`${objects.length} objects, ${(chars / 1e6).toFixed(1)} M characters stored, heap +${((heap1 - heap0) / 1e6).toFixed(0)} MB for the records`];
    for (const [label, req] of queries) {
      // One warm-up, then the measured run.
      const resolveKeys = async (keys: string[]) => Object.fromEntries(keys.map(k => [k, { found: true as const, target: { rid: '1', type: 'ExtendedTable', name: '', businessId: 'dashboard_table' } }]));
      await runCodeSearch(req, src, () => {}, { resolveKeys });
      const t0 = performance.now();
      const out = await runCodeSearch(req, src, () => {}, { resolveKeys });
      const ms = performance.now() - t0;
      rows.push(`${label.padEnd(16)} ${ms.toFixed(0).padStart(5)} ms  ${out.matchedObjects} objects in ${out.rows} rows, heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);
      if (FULL) {
        process.stdout.write(`${rows.at(-1)}\n`);
        expect(ms, label).toBeLessThan(LIMIT);
      }
      expect(out.matchedObjects, label).toBeGreaterThan(0);
    }
    if (FULL) console.log(rows.join('\n'));
  }, 120_000);
});
