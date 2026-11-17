/**
 * The constant, length-framed wire (ec-parser.ts): stored text cannot break
 * the parse of an answer, whatever it contains, and the same question is the
 * same script text (the server keeps one parse tree per distinct text).
 */
import { describe, expect, it } from 'vitest';
import {
  appendBlockEc, appendRowEc, createEcFrame, EC_FRAME, ecLiteralText, framedBlocks, framedText,
  parseFramedLog, parseSepBlocks, parseSepMultiObject, splitFramedRows, stableRidOrder,
} from '../ec-parser';
import { buildRowFactsEc } from '../object-row-facts';
import { buildSummariesEc } from '../object-summaries';
import { buildBatchCodeReadEc, buildBatchEnrichEc } from '../ec-query-service';
import { buildRefResolveEc } from '../code-ref-resolve';
import { findEvaluatingCodeReads } from '../ec-code-safety';

/** Values a stored name, label or code body can hold. */
const ADVERSARIAL = [
  '',
  'plain',
  EC_FRAME.row,
  EC_FRAME.done,
  `${EC_FRAME.row}3:abc${EC_FRAME.done}`,
  'x~CREV_R~1:y~CREV_D~z',
  '~CREV_',
  '12:34:56',
  '0:',
  '5',
  'line one\nline two\r\nline three\n',
  '\n\nleading and trailing\n\n',
  'say "hello" \\ back\\slash \\n not a newline',
  '\\',
  '"',
  'tab\tseparated',
  'Ünïcödé — 日本語 — emoji 🌍👩‍👩‍👧 — surrogate 😀',
  '|||a|b|||',
  '<<<CREV_PROPERTY_SEP>>>state_x<<<CREV_PROPERTY_SEP>>>missing',
  '~CREV_SEP~DONE',
  'x'.repeat(100_000),
];

/**
 * Evaluate the row expression a builder wrote, as BMP would: string literals
 * (EC escapes), `str(_fN.size())` (the UTF-16 length) and `_fN` (the value).
 */
function evalRow(lines: string[], values: Record<string, string>): string {
  const vars: Record<string, string> = {};
  for (const line of lines) {
    const set = /^\s*(_f\d+) := str\((.*)\)$/.exec(line);
    if (set) { vars[set[1]] = values[set[2]] ?? ''; continue; }
    const append = /^\s*(\w+) := \1 \+ \((.*)\)$/.exec(line);
    if (!append) throw new Error(`unexpected line ${line}`);
    let out = '';
    for (const term of append[2].split(/ \+ (?=(?:[^"\\]|\\.)*(?:"(?:[^"\\]|\\.)*"(?:[^"\\]|\\.)*)*$)/)) {
      const lit = ecLiteralText(term);
      if (lit != null) { out += lit; continue; }
      const size = /^str\((_f\d+)\.size\(\)\)$/.exec(term);
      if (size) { out += String(vars[size[1]].length); continue; }
      if (/^_f\d+$/.test(term)) { out += vars[term]; continue; }
      throw new Error(`unexpected term ${term}`);
    }
    return out;
  }
  throw new Error('no row');
}

describe('the frame is constant', () => {
  it('has the same markers on every request, without angle brackets', () => {
    expect(createEcFrame()).toBe(createEcFrame());
    expect(EC_FRAME.row).not.toMatch(/[<>]/);
    expect(EC_FRAME.done).not.toMatch(/[<>]/);
  });
});

describe('adversarial stored text comes back unchanged', () => {
  it('round-trips every value through framedText and parseFramedLog', () => {
    const rows = ADVERSARIAL.map((v, i) => [String(i), v, v + v, 'end']);
    expect(parseFramedLog(framedText(rows), EC_FRAME, 4)).toEqual(rows);
  });

  it('round-trips values through the EC a builder writes (appendRowEc)', () => {
    for (const v of ADVERSARIAL) {
      const lines = appendRowEc('_r', ['"O"', '_o.name', '"literal with \\"quote\\" and ~CREV_R~ inside"', '_o.code']);
      const row = evalRow(lines, { '_o.name': v, '_o.code': `${v}\n${v}` });
      expect(parseFramedLog(`noise before ${row}${EC_FRAME.done}\nDuration : 3ms`, EC_FRAME, 4)).toEqual([
        ['O', v, 'literal with "quote" and ~CREV_R~ inside', `${v}\n${v}`],
      ]);
    }
  });

  it('keeps blocks exact, including text that looks like a marker or a block', () => {
    const blocks = Object.fromEntries(ADVERSARIAL.map((v, i) => [`k${i}`, v]));
    const parsed = parseSepBlocks(framedBlocks(blocks));
    for (const [k, v] of Object.entries(blocks)) expect(parsed[k] ?? '').toBe(v);
    const lines = appendBlockEc('_r', 'html', 'output(_o.html)');
    expect(parseSepBlocks(evalRow(lines, { 'output(_o.html)': '~CREV_D~ fake end' }) + EC_FRAME.done)).toEqual({ html: '~CREV_D~ fake end' });
  });

  it('keeps nested rows in a block value exact', () => {
    const inner = framedText(ADVERSARIAL.map(v => ['1', v]), false);
    const parsed = parseSepBlocks(framedBlocks({ list: inner, after: 'x' }));
    expect(splitFramedRows(parsed.list, EC_FRAME, 2).map(r => r[1])).toEqual(ADVERSARIAL);
    expect(parsed.after).toBe('x');
  });

  it('keeps objects apart in multi-object answers even when code holds an OBJ row', () => {
    const log = framedText([['OBJ', '1'], ['expression', framedText([['OBJ', '2']], false)], ['OBJ', '3'], ['html', 'h']]);
    const m = parseSepMultiObject(log);
    expect([...m.keys()]).toEqual(['1', '3']);
    expect(m.get('1')!.expression).toBe(framedText([['OBJ', '2']], false));
  });

  it('turns a cut-off or damaged answer into an error, never a short result', () => {
    const full = framedText([['a', 'b'], ['c', 'd'.repeat(50)]]);
    for (let cut = 0; cut < full.length; cut++) expect(() => parseFramedLog(full.slice(0, cut), EC_FRAME, 2)).toThrow(/incomplete|damaged/);
    expect(parseFramedLog(full, EC_FRAME, 2)).toEqual([['a', 'b'], ['c', 'd'.repeat(50)]]);
    // A changed length cannot shift a field silently: the width check or the
    // position check fails.
    expect(() => parseFramedLog(full.replace('1:b', '2:b'), EC_FRAME, 2)).toThrow();
    expect(() => parseFramedLog(`${EC_FRAME.row}x${EC_FRAME.done}`)).toThrow(/damaged/);
    expect(() => parseFramedLog('Result : nothing framed')).toThrow(/incomplete/);
  });
});

describe('identical question, identical text', () => {
  const items = (rids: string[]) => rids.map(rid => ({ rid, ref: `lookup(${rid})` }));
  const rids = ['9223372036854775807', '12', '9007199254740993', '5'];

  it('orders RIDs beyond 2^53 as decimal strings, without repeats', () => {
    expect(stableRidOrder([...rids, '12'])).toEqual(['5', '12', '9007199254740993', '9223372036854775807']);
  });

  it('writes the same script for the same objects, twice', () => {
    expect(buildRowFactsEc(items(rids))).toBe(buildRowFactsEc(items(rids)));
    expect(buildSummariesEc(items(rids))).toBe(buildSummariesEc(items(rids)));
    expect(buildBatchEnrichEc(rids.map(r => `lookup(${r})`))).toBe(buildBatchEnrichEc(rids.map(r => `lookup(${r})`)));
    expect(buildRefResolveEc(['t.a', 'rid:5'])).toBe(buildRefResolveEc(['t.a', 'rid:5']));
  });

  it('changes only the list line with the objects (one shape per question)', () => {
    const a = buildRowFactsEc(items(['1', '2'])).split('\n');
    const b = buildRowFactsEc(items(['3', '4', '5', '6', '7'])).split('\n');
    expect(a[0]).toBe('_list := LIST(lookup(1), lookup(2))');
    expect(a.slice(1)).toEqual(b.slice(1));
    const c = buildBatchCodeReadEc(['lookup(1)'], ['html', 'expression']).split('\n');
    const d = buildBatchCodeReadEc(['lookup(2)', 'lookup(3)'], ['expression', 'html']).split('\n');
    expect(c.slice(1)).toEqual(d.slice(1));
  });

  it('keeps code read as text in the loop shapes (ec-code-safety)', () => {
    for (const ec of [buildRowFactsEc(items(rids)), buildBatchCodeReadEc(['lookup(1)'], ['expression', 'showExpression']), buildRefResolveEc(['t.a'])]) {
      expect(findEvaluatingCodeReads(ec)).toEqual([]);
    }
  });
});
