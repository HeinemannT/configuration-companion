/**
 * Tree rows without full object reads (lib/object-row-facts.ts): the
 * script reads code only as text length inside output(), in chunks of 50;
 * the light objects give the same row markers as full reads; Compare pairs
 * them without full reads and counts a pair's differences lazily.
 */
import { describe, expect, it } from 'vitest';
import { STATIC_EC_FRAME as F } from '../ec-parser';
import { findEvaluatingCodeReads } from '../ec-code-safety';
import { buildRowFactsEc, parseRowFactsLog, readRowFacts, ROW_FACTS_PER_SCRIPT, ROW_CODE_PROPS } from '../object-row-facts';
import { openObjectRoot, type ObjectReader } from '../object-window';
import { typeInfo } from '../object-window-table';
import { compareStructure } from '../compare-model';
import { assembleStructure } from '../object-structure';
import type { FullObject, PropValue } from '../object-read';
import { framedText as __framedText } from '../ec-parser';
/** One length-framed row (ec-parser). */
const R = (...f: unknown[]) => __framedText([f.map(String)], false);

const code = (text: string): PropValue => ({ kind: 'code', text, cls: 'CorpoExtendedExpression' });
const bool = (b: boolean): PropValue => ({ kind: 'boolean', text: String(b), bool: b });

/** Full reads of the sandbox input set's children, as the binary read
 *  returns them (the props the markers look at, and more). */
const full: Record<string, FullObject> = {
  '11': { rid: '11', type: 'TextInput', name: 'Text input', businessId: 'crev_qa_text_input', props: { showExpression: code(''), enableExpression: code(''), defaultExpression: code(''), refreshExpression: code(''), key: { kind: 'text', text: 'txt' } }, references: {}, overridden: [] },
  '12': { rid: '12', type: 'ButtonInput', name: 'Show button', businessId: 'crev_qa_btn_show', props: { expression: code('_product := 7 * 6'), showExpression: code('TRUE'), useShowExpression: bool(true), enableExpression: code(''), afterExpression: code(''), initExpression: code(''), defaultExpression: code(''), refreshExpression: code(''), destinationExpression: code(''), buttonType: { kind: 'enum', text: 'ACTION' } }, references: {}, overridden: [] },
  '13': { rid: '13', type: 'ButtonInput', name: 'Enable button', businessId: 'crev_qa_btn_enable', props: { expression: code('_stamp := today'), enableExpression: code('TRUE'), useEnableExpression: bool(false), showExpression: code(''), afterExpression: code(''), initExpression: code(''), defaultExpression: code(''), refreshExpression: code(''), destinationExpression: code('') }, references: {}, overridden: [] },
  '14': { rid: '14', type: 'ButtonInput', name: 'After button', businessId: 'crev_qa_btn_after', props: { expression: code('_sum := 2 + 3'), afterExpression: code('_done := today'), showExpression: code(''), enableExpression: code(''), initExpression: code(''), defaultExpression: code(''), refreshExpression: code(''), destinationExpression: code('') }, references: {}, overridden: [] },
};

/** What the row-facts script answers for those objects. */
function factsLog(objs: readonly FullObject[]): string {
  const rows: string[] = [];
  for (const o of objs) {
    rows.push(`${R(`O`, `${o.rid}`, `${o.type}`, `${o.name}`, `${o.businessId}`, ``)}`);
    for (const [p, v] of Object.entries(o.props)) {
      if (v.kind === 'code' && ROW_CODE_PROPS.includes(p) && v.text) rows.push(`${R(`C`, `${o.rid}`, `${p}`, `${v.text.length}`, ``, ``)}`);
      if (v.kind !== 'code' && ['key', 'useShowExpression', 'useEnableExpression', 'buttonType'].includes(p)) rows.push(`${R(`V`, `${o.rid}`, `${p}`, `${v.text}`, ``, ``)}`);
    }
  }
  return `${rows.join('')}${F.done}`;
}

describe('the row facts script', () => {
  it('reads code only as text length inside output(), never the code itself', () => {
    const ec = buildRowFactsEc([{ rid: '11', ref: 'lookup(11)' }, { rid: '12', ref: 'lookup(12)' }], F);
    expect(findEvaluatingCodeReads(ec)).toEqual([]);
    // Text of any value: a boolean, an enum or a widget's text has no size() (seen live).
    expect(ec).toContain('_s := str(output(_o.showExpression.whenMissing("")))');
    expect(ec).toContain('_s := str(output(_o.required.whenMissing("")))');
    expect(ec).toContain('str(_s.size())');
    expect(ec).not.toMatch(/"C"[^\n]*\+ _s\b(?!\.size)/);
  });

  it('reads 50 nodes a post', async () => {
    const posts: string[] = [];
    const client = {
      resolveRefs: async (rids: readonly string[]) => new Map(rids.map(r => [r, `lookup(${r})`] as [string, string])),
      executeEc: async (c: string) => { posts.push(c); return { ok: true, log: F.done }; },
    };
    const res = await readRowFacts(client, Array.from({ length: 120 }, (_, i) => String(1000 + i)), () => F);
    expect(res.posts).toBe(3);
    expect(posts.map(p => p.match(/lookup\(/g)!.length)).toEqual([ROW_FACTS_PER_SCRIPT, ROW_FACTS_PER_SCRIPT, 20]);
  });

  it('gives the same tree markers as full reads', () => {
    const lite = parseRowFactsLog(factsLog(Object.values(full)), F);
    const slots = typeInfo('InputSet').slots;
    for (const rid of Object.keys(full)) {
      expect(lite[rid]).toMatchObject({ lite: true, name: full[rid].name, type: full[rid].type, businessId: full[rid].businessId });
      expect(slots.map(s => s.test(lite[rid])), rid).toEqual(slots.map(s => s.test(full[rid])));
    }
    expect(lite['11'].props.key?.text).toBe('txt');
    expect(lite['12'].props.buttonType?.text).toBe('ACTION');
  });
});

describe('the object window reads only the root in full', () => {
  it('lists the structure, reads the root, and gets the rows from their facts', async () => {
    const fullReads: string[][] = [];
    const root: FullObject = { rid: '1', type: 'InputSet', name: 'Set', businessId: 'set', props: {}, references: {}, overridden: [] };
    const reader: ObjectReader = {
      readFullObjects: async rids => { fullReads.push([...rids]); return { objects: Object.fromEntries(rids.filter(r => r === '1').map(r => [r, root])), errors: {} }; },
      fetchStructureRows: async () => Object.assign(Object.keys(full).map(rid => ({ rid, parent: '1' })), {}),
      readRowFacts: async rids => ({ objects: parseRowFactsLog(factsLog(rids.map(r => full[r])), F), posts: 1 }),
    };
    const payload = await openObjectRoot(reader, '1');
    expect(fullReads).toEqual([['1']]);
    expect(Object.values(payload.nodes).every(o => o.lite)).toBe(true);
    expect(payload.posts).toBe(3); // root, structure, row facts
  });
});

describe('Compare without full reads of the children', () => {
  it('matches children by their facts and leaves the property count of a pair for later', () => {
    const lite = parseRowFactsLog(factsLog(Object.values(full)), F);
    const side = (rootRid: string, kids: Record<string, FullObject>) => assembleStructure({ rid: rootRid, type: 'InputSet', name: 'S', businessId: rootRid, props: {}, references: {}, overridden: [] },
      Object.keys(kids).map(rid => ({ rid, parent: rootRid })), kids);
    const b = { ...lite['12'], rid: '22' };
    const res = compareStructure(side('1', { 12: lite['12'] }), side('2', { 22: b }));
    expect(res.rows[1]).toMatchObject({ pending: true, status: 'same' });
    expect(res.pending).toBe(1);
    // Once both sides are read in full, the pair is counted.
    const done = compareStructure(side('1', { 12: full['12'] }), side('2', { 22: { ...full['12'], rid: '22', props: { ...full['12'].props, expression: code('_product := 6 * 7') } } }));
    expect(done.rows[1]).toMatchObject({ status: 'changed', diffs: 1 });
    expect(done.pending).toBe(0);
  });
});
