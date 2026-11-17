/** Compare model (lib/compare-model.ts) and read path (lib/compare-read.ts), without a server. */
import { describe, expect, it, vi } from 'vitest';
import type { FullObject, ObjectSummary, PropValue } from '../object-read';
import { OBJECT_NO_DATA } from '../object-read';
import {
  compareProperties, compareStructure, diffCode, foldCode, matchChildren, matchCustomDefinitions, structView, wordDiff,
} from '../compare-model';
import { assembleStructure } from '../object-structure';
import { buildSuggestEc, parseSuggestLog, readCompare, rowsUnder, type CompareReader } from '../compare-read';

const txt = (text: string): PropValue => ({ kind: 'text', text });
const code = (text: string): PropValue => ({ kind: 'code', text });
const bool = (b: boolean): PropValue => ({ kind: 'boolean', text: String(b), bool: b });

function obj(rid: string, type: string, props: Record<string, PropValue>, references: Record<string, string[]> = {}, extra: Partial<FullObject> = {}): FullObject {
  return {
    rid, type, name: props.name?.text ?? '', businessId: props.id?.text ?? '', props, references, overridden: [], ...extra,
  };
}

const button = (rid: string, over: Record<string, PropValue> = {}, refs: Record<string, string[]> = {}) => obj(rid, 'ButtonInput', {
  name: txt('Run'), id: txt(`btn_${rid}`), uuid: txt(rid), fullPath: txt(`/1/${rid}`), createdTime: { kind: 'time', text: `2026-01-0${rid.length % 9} 10:00 UTC` },
  description: txt(''), expression: code('_a := 1\n_b := 2'), useShowExpression: bool(false), showExpression: code(''),
  buttonType: { kind: 'enum', text: 'EXPRESSION' }, successMessage: txt('Done'), sortIndex: { kind: 'number', text: '1', num: 1 },
  ...over,
}, { parent: ['900000001'], createdBy: ['900000002'], ...refs });

describe('compareProperties', () => {
  it('groups rows as the object window does and keeps identity out of the count', () => {
    const p = compareProperties(button('1000001'), button('1000002', { successMessage: txt('Finished') }));
    expect(p.sections.map(s => s.title)).toEqual(['Behaviour', 'Properties', 'All properties']);
    const props = p.sections.find(s => s.title === 'Properties')!;
    expect(props.groups.map(g => g.title)).toEqual(['General', 'Configuration', 'Action execution feedback']);
    expect(props.groups[0].rows.map(r => r.label)).toEqual(['Name', 'Description']);
    // id, uuid, fullPath and createdTime differ but are identity facts.
    const keys = p.sections.flatMap(s => s.groups.flatMap(g => g.rows.map(r => r.key)));
    for (const k of ['p:id', 'p:uuid', 'p:fullPath', 'p:createdTime', 'r:parent', 'r:createdBy']) expect(keys).not.toContain(k);
    expect(p.differ).toBe(1);
    const row = props.groups[2].rows.find(r => r.key === 'p:successMessage')!;
    expect([row.a?.text, row.b?.text, row.equal]).toEqual(['Done', 'Finished', false]);
    expect(p.identity.a.businessId).toBe('btn_1000001');
    expect(p.identity.b.parent).toBe('900000001');
  });

  it('puts the gate before its expression in Behaviour', () => {
    const p = compareProperties(button('1000001'), button('1000002'));
    expect(p.sections[0].groups[0].rows.map(r => r.key)).toEqual(['p:useShowExpression', 'p:showExpression', 'p:expression']);
  });

  it('marks properties one read did not return (older server) as only in A or B, never throws', () => {
    const older = button('1000002');
    delete older.props.successMessage;
    delete older.props.buttonType;
    const p = compareProperties(button('1000001'), older);
    const rows = p.sections.flatMap(s => s.groups.flatMap(g => g.rows));
    expect(rows.find(r => r.key === 'p:successMessage')).toMatchObject({ only: 'a', b: null, equal: false });
    expect(rows.find(r => r.key === 'p:buttonType')).toMatchObject({ only: 'a' });
    // A read with almost nothing in it still compares.
    const bare = obj('1000003', 'ButtonInput', { name: txt('Run') });
    expect(() => compareProperties(button('1000001'), bare)).not.toThrow();
    expect(compareProperties(bare, bare).differ).toBe(0);
  });

  it('a property only on one side that is empty there is not a difference', () => {
    const b = button('1000002');
    delete b.props.description;
    const p = compareProperties(button('1000001'), b);
    expect(p.sections.flatMap(s => s.groups.flatMap(g => g.rows)).find(r => r.key === 'p:description')).toMatchObject({ only: 'a', equal: true });
  });

  it('compares shared properties of two types and lists the others as not comparable', () => {
    const view = obj('2000001', 'InputView', { name: txt('Form'), description: txt('x'), persistence: { kind: 'enum', text: 'SESSION' } }, { inputSet: ['2000009'] });
    const set = obj('2000002', 'InputSet', { name: txt('Form set'), description: txt('x') });
    const p = compareProperties(view, set);
    expect(p.sameType).toBe(false);
    expect(p.total).toBe(2);
    expect(p.differ).toBe(1);
    expect(p.notComparable.a).toEqual(expect.arrayContaining(['Persistence', 'Input set']));
    expect(p.notComparable.b).toEqual([]);
  });

  it('compares references by target, not by order, and names them through summaries', () => {
    const a = obj('3000001', 'Organisation', { name: txt('A') }, { template: ['7'], managers: ['11', '12'] });
    const b = obj('3000002', 'Organisation', { name: txt('B') }, { template: ['7'], managers: ['12', '11'] });
    const p = compareProperties(a, b);
    const rows = p.sections.flatMap(s => s.groups.flatMap(g => g.rows));
    expect(rows.find(r => r.key === 'r:managers')).toMatchObject({ kind: 'ref', equal: true });
    expect(rows.find(r => r.key === 'p:name')).toMatchObject({ equal: false });
  });

  it('ignores whitespace in code when asked', () => {
    const a = button('1000001', { expression: code('_a := 1\n_b := 2') });
    const b = button('1000002', { expression: code('_a  :=  1\n\t_b := 2') });
    expect(compareProperties(a, b).differ).toBe(1);
    expect(compareProperties(a, b, { ignoreWhitespace: true }).differ).toBe(0);
  });
});

describe('custom properties', () => {
  const summaries: Record<string, ObjectSummary> = {
    1111111: { rid: '1111111', type: 'PropertyDefinition', name: 'Owner', businessId: 'p_owner' },
    2222222: { rid: '2222222', type: 'PropertyDefinition', name: 'Owner', businessId: 'p_owner' },
    3333333: { rid: '3333333', type: 'PropertyDefinition', name: 'Budget', businessId: 'p_budget' },
    4444444: { rid: '4444444', type: 'PropertyDefinition', name: 'Budget', businessId: 'p_budget_2' },
    5555555: { rid: '5555555', type: 'PropertyDefinition', name: 'Score', businessId: 'p_score' },
  };

  it('pairs definitions by rid, then business ID, then name', () => {
    const m = matchCustomDefinitions(['1111111', '3333333', '5555555'], ['2222222', '4444444', '9999999', '5555555'], summaries);
    expect(Object.fromEntries(m)).toEqual({ 5555555: '5555555', 2222222: '1111111', 4444444: '3333333' });
  });

  it('matches custom properties of two data objects by definition, not by raw key', () => {
    const a = obj('6000001', 'CeRisk', { name: txt('R1'), 1111111: txt('Ann'), 5555555: txt('3') }, { template: ['8'] });
    const b = obj('6000002', 'CeRisk', { name: txt('R2'), 2222222: txt('Ann'), 6666666: txt('x') }, { template: ['8'] });
    const p = compareProperties(a, b, { summaries });
    const custom = p.sections[0].groups.find(g => g.title === 'Custom')!.rows;
    expect(custom.find(r => r.label === 'Owner')).toMatchObject({ equal: true, a: { text: 'Ann' }, b: { text: 'Ann' } });
    expect(custom.find(r => r.label === 'Score')).toMatchObject({ only: 'a' });
    expect(custom.find(r => r.label === 'Custom property')).toMatchObject({ only: 'b' });
  });
});

describe('words and code', () => {
  it('marks the changed words only', () => {
    expect(wordDiff('Create assessment', 'Create assessment now')).toEqual({ a: [], b: [[17, 21]] });
    const w = wordDiff('_new.change(due := today + 14)', '_new.change(due := today + 30)');
    expect(w.a).toEqual([[27, 29]]);
    expect(w.b).toEqual([[27, 29]]);
  });

  it('joins neighbouring changed words across the space between them', () => {
    expect(wordDiff('a b c', 'a x y c').b).toEqual([[2, 5]]);
  });

  it('pairs removed and added lines into changed lines with word ranges', () => {
    const d = diffCode('_a := 1\n_b := 2\n_c := 3', '_a := 1\n_b := 5\n_c := 3\n_d := 4');
    expect(d.rows.map(r => r.op)).toEqual(['eq', 'ch', 'eq', 'add']);
    expect(d.rows[1]).toMatchObject({ na: 2, nb: 2, ra: [[6, 7]], rb: [[6, 7]] });
    expect([d.added, d.removed, d.changed]).toEqual([2, 1, 1]);
  });

  it('treats whitespace-only changes as equal when whitespace is ignored', () => {
    const a = 'IF x THEN\n  y\nENDIF';
    const b = 'IF  x THEN\n\ty\n\nENDIF';
    const plain = diffCode(a, b);
    expect(plain.changed + plain.added).toBeGreaterThan(0);
    const ws = diffCode(a, b, { ignoreWhitespace: true });
    expect(ws.rows.map(r => [r.op, !!r.ws])).toEqual([['eq', true], ['eq', true], ['add', true], ['eq', false]]);
    expect([ws.added, ws.removed]).toEqual([0, 0]);
  });

  it('folds long unchanged runs and keeps context', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l15', 'L15');
    const d = diffCode(a, b);
    const v = foldCode(d.rows, 3);
    expect(v.filter(x => 'fold' in x).map(x => ('fold' in x ? x.count : 0))).toEqual([12, 11]);
    const open = foldCode(d.rows, 3, new Set([0]));
    expect(open.filter(x => 'fold' in x)).toHaveLength(1);
  });
});

describe('structure', () => {
  const page = (rid: string, kids: Array<[string, string, string, string?]>, linked?: string) => {
    const root = obj(rid, 'Scorecard', { name: txt(`P${rid}`) }, linked ? { linkedTo: [linked] } : {});
    const nodes: Record<string, FullObject> = {};
    for (const [krid, id, name, link] of kids) nodes[krid] = obj(krid, 'TextElement', { name: txt(name), id: txt(id) }, link ? { linkedTo: [link] } : {});
    return assembleStructure(root, kids.map(([krid]) => ({ rid: krid, parent: rid })), nodes);
  };

  it('matches children by template link, then ID, then name and type', () => {
    const ta = page('100', [['101', 'intro', 'Intro'], ['102', 'notes', 'Notes'], ['103', 'gone', 'Gone'], ['104', 'tpl', 'T']]);
    const tb = page('200', [['201', 'intro', 'Intro'], ['202', 'notes_ops', 'Notes'], ['203', 'new', 'New'], ['204', '1330', '', '104']]);
    const kids = (t: typeof ta) => t.nodes[t.rootRid].children.map(r => ({ node: t.nodes[r], obj: t.nodes[r].obj }));
    const m = matchChildren(kids(ta), kids(tb));
    expect(m.map(x => [x.a?.node.rid ?? null, x.b?.node.rid ?? null, x.by ?? null])).toEqual([
      // 203 comes before 204 in B, so it stays before the pair 104/204.
      ['101', '201', 'id'], ['102', '202', 'name'], ['103', null, null], [null, '203', null], ['104', '204', 'link'],
    ]);
    const s = compareStructure(ta, tb);
    expect([s.total, s.byLink, s.byId, s.byName, s.onlyA, s.onlyB]).toEqual([5, 1, 1, 1, 1, 1]);
    // Notes differs in its ID only: that is identity, not a difference.
    expect(s.rows.find(r => r.a?.rid === '102')?.status).toBe('same');
  });

  it('folds runs of equal siblings when differences only is on', () => {
    const ta = page('100', [['101', 'a', 'A'], ['102', 'b', 'B'], ['103', 'c', 'C']]);
    const tb = page('200', [['201', 'a', 'A'], ['202', 'b', 'B'], ['203', 'c', 'C changed']]);
    const s = compareStructure(ta, tb);
    expect(s.differ).toBe(1);
    const v = structView(s.rows, true);
    expect(v.map(x => ('equal' in x ? `eq${x.equal.length}` : x.row.status))).toEqual(['changed', 'eq2', 'changed']);
    expect(structView(s.rows, false)).toHaveLength(4);
    const key = (v[1] as { key: string }).key;
    expect(structView(s.rows, true, new Set([key]))).toHaveLength(4);
  });
});

describe('compare read', () => {
  const full = (rid: string, type = 'ButtonInput', refs: Record<string, string[]> = {}) => obj(rid, type, { name: txt(rid) }, refs);

  function reader(over: Partial<CompareReader> = {}) {
    const calls: string[][] = [];
    const r: CompareReader = {
      readFullObjects: vi.fn(async (rids: readonly string[]) => {
        calls.push([...rids]);
        const objects: Record<string, FullObject> = {};
        const errors: Record<string, string> = {};
        for (const rid of rids) {
          if (rid === '4040404') errors[rid] = OBJECT_NO_DATA;
          else if (rid.startsWith('3')) objects[rid] = full(rid, 'InputSet', { parent: ['7000001'] });
          else objects[rid] = full(rid, 'ButtonInput', { parent: ['7000001'] });
        }
        return { objects, errors };
      }),
      fetchStructureRows: vi.fn(),
      resolveRef: vi.fn(async (rid: string) => `lookup(${rid})`),
      executeEc: vi.fn(async () => ({ ok: true, log: '3000011|||3000001\n3000012|||3000011\n3000021|||3000002\n' })),
      ...over,
    };
    return { r, calls };
  }

  it('reads both sides in one post, lists both structures in one post and names everything in one more', async () => {
    const { r, calls } = reader();
    const read = await readCompare(r, ['3000001', '3000002'], 10_000);
    expect(read.posts).toBe(3);
    expect(calls[0]).toEqual(['3000001', '3000002']);
    expect(r.executeEc).toHaveBeenCalledTimes(1);
    expect(calls[1]).toEqual(expect.arrayContaining(['3000011', '3000012', '3000021', '7000001']));
    expect(read.sides['3000001'].rows?.map(x => x.rid)).toEqual(['3000011', '3000012']);
    expect(Object.keys(read.sides['3000002'].nodes)).toEqual(['3000021']);
    expect(read.summaries['7000001'].name).toBe('7000001');
  });

  it('reads no structure for types without one and reports a missing object as not found', async () => {
    const { r } = reader();
    const read = await readCompare(r, ['1000001', '4040404'], 10_000);
    expect(r.executeEc).not.toHaveBeenCalled();
    expect(read.sides['4040404']).toMatchObject({ root: null, notFound: true });
    expect(read.sides['1000001'].rows).toBeNull();
  });

  it('keeps the roots when the listing fails', async () => {
    const { r } = reader({ executeEc: vi.fn(async () => ({ ok: false, error: 'EC failed' })) });
    const read = await readCompare(r, ['3000001'], 10_000);
    expect(read.sides['3000001']).toMatchObject({ structureError: 'EC failed', rows: null });
    expect(read.sides['3000001'].root?.rid).toBe('3000001');
  });

  it('finds rows below a root in a shared listing', () => {
    const rows = [{ rid: '2', parent: '1' }, { rid: '4', parent: '3' }, { rid: '5', parent: '2' }];
    expect(rowsUnder(rows, '1').map(r => r.rid)).toEqual(['2', '5']);
    expect(rowsUnder(rows, '3').map(r => r.rid)).toEqual(['4']);
  });

  it('builds and parses the suggestion listing', () => {
    const ec = buildSuggestEc('lookup(1)', { templateRef: 'lookup(2)', parentRef: 'lookup(3)' });
    expect(ec).toContain('_t.rref(linkedTo)');
    expect(ec).toContain('_o.rref(linkedTo)');
    expect(ec).toContain('_p.children()');
    expect(buildSuggestEc('lookup(1)', {})).not.toContain('_p :=');
    const rows = parseSuggestLog('instance|||111111|||a_ops|||ButtonInput|||Run | ops\nsibling|||222222|||b|||ButtonInput|||B\nnoise\ninstance|||111111|||a_ops|||ButtonInput|||dup');
    expect(rows).toEqual([
      { kind: 'instance', rid: '111111', businessId: 'a_ops', type: 'ButtonInput', name: 'Run | ops' },
      { kind: 'sibling', rid: '222222', businessId: 'b', type: 'ButtonInput', name: 'B' },
    ]);
  });
});

describe('picker suggestions for Compare', () => {
  it('lists the caller groups between the current object and the recent ones, each object once', async () => {
    const { pickerRows } = await import('../object-picker');
    const rows = pickerRows('', {
      groups: [{ title: 'Template and instances', items: [{ rid: '1', tag: 'template' }, { rid: '2' }] }, { title: 'Same type next to this object', items: [{ rid: '3' }, { rid: '2' }] }],
      recent: [{ rid: '3' }, { rid: '4' }], recentTitle: 'Recently opened',
    }, null);
    expect(rows.map(r => [r.group, r.obj?.rid])).toEqual([
      ['Template and instances', '1'], ['Template and instances', '2'], ['Same type next to this object', '3'], ['Recently opened', '4'],
    ]);
  });

  it('puts hits of the same type first when the caller ranks them', async () => {
    const { pickerRows } = await import('../object-picker');
    const rows = pickerRows('run', { recent: [] }, [{ rid: '1', type: 'Label' }, { rid: '2', type: 'ButtonInput' }], o => (o.type === 'ButtonInput' ? 0 : 1));
    expect(rows.map(r => r.obj?.rid)).toEqual(['2', '1']);
  });
});

describe('review fixes', () => {
  it('keeps internal property names and shows unsplittable enum values as stored', async () => {
    const { enumText } = await import('../compare-model');
    expect(enumText('model.TEMPLATECATEGORY')).toBe('TEMPLATECATEGORY');
    expect(enumText('buttonType.EXPRESSION_TYPE')).toBe('Expression type');
    const a = obj('8000001', 'Scorecard', { name: txt('S'), _templateLinkedTo: bool(true), templateLinkedTo: bool(true) });
    const b = obj('8000002', 'Scorecard', { name: txt('S'), _templateLinkedTo: bool(false), templateLinkedTo: bool(false) });
    const rows = compareProperties(a, b).sections.flatMap(s => s.groups.flatMap(g => g.rows.map(r => [g.title, r.label])));
    expect(rows).toContainEqual(['Technical', '_templateLinkedTo']);
    expect(rows).toContainEqual(['', 'Template linked to']);
  });

  it('does not count template plumbing between a template and its instance', async () => {
    const { isTemplatePair } = await import('../compare-model');
    const tpl = obj('8100001', 'Scorecard', { name: txt('Admin'), link: bool(false), model: { kind: 'enum', text: 'TEMPLATECATEGORY' }, sortIndex: { kind: 'number', text: '8', num: 8 } });
    const inst = obj('8100002', 'Scorecard', { name: txt('Admin'), link: bool(true), model: { kind: 'enum', text: 'ORGANISATION' }, sortIndex: { kind: 'number', text: '0', num: 0 } }, { linkedTo: ['8100001'] });
    expect(isTemplatePair(tpl, inst)).toBe(true);
    const p = compareProperties(tpl, inst);
    expect(p.templatePair).toBe(true);
    const rows = p.sections.flatMap(s => s.groups.flatMap(g => g.rows));
    expect(rows.filter(r => r.template).map(r => r.key).sort()).toEqual(['p:link', 'p:model', 'r:linkedTo']);
    expect(p.differ).toBe(1); // sort index stays a difference
    expect(compareProperties(obj('1', 'Scorecard', { name: txt('x'), link: bool(false) }), obj('2', 'Scorecard', { name: txt('x'), link: bool(true) })).differ).toBe(1);
  });

  it('pairs only similar lines and shows unrelated texts as having no line in common', async () => {
    const { lineSimilarity } = await import('../compare-model');
    expect(lineSimilarity('_new.change(due := today + 14)', '_new.change(due := today + 30)')).toBeGreaterThan(0.8);
    expect(lineSimilarity('/* a comment */', '_basis := t.values.expression')).toBeLessThan(0.4);
    const d = diffCode('x := 1\n/* old note */\ny := 2', 'x := 1\n_basis := t.assessment.expression\ny := 2');
    expect(d.rows.map(r => r.op)).toEqual(['eq', 'del', 'add', 'eq']);
    expect(d.disjoint).toBe(false);
    expect(diffCode('_sum := 2 + 3', '/* other */').disjoint).toBe(true);
  });

  it('matches the same object first and starts the trees where one root lies inside the other', () => {
    const inputs = (ids: string[]) => Object.fromEntries(ids.map(r => [r, obj(r, 'TextInput', { name: txt(`In ${r}`), id: txt(`in_${r}`) })]));
    const set = obj('900', 'InputSet', { name: txt('Set') });
    const view = obj('800', 'InputView', { name: txt('View') }, { inputSet: ['900'] });
    const ta = assembleStructure(view, [{ rid: '900', parent: '800' }, { rid: '901', parent: '900' }, { rid: '902', parent: '900' }], { 900: set, ...inputs(['901', '902']) });
    const tb = assembleStructure(set, [{ rid: '901', parent: '900' }, { rid: '902', parent: '900' }], inputs(['901', '902']));
    const s = compareStructure(ta, tb);
    expect(s.anchor).toEqual({ side: 'a', rid: '900' });
    expect([s.onlyA, s.onlyB, s.bySame, s.differ]).toEqual([0, 0, 2, 0]);
  });
});

describe('object search', () => {
  it('builds a chunked, framed name search per type and parses it', async () => {
    const { buildNameSearchEc, parseNameSearchLog } = await import('../object-search');
    const { EC_FRAME: frame, framedText } = await import('../ec-parser');
    const ec = buildNameSearchEc('InputView', 'CREV "QA"', frame);
    expect(ec).toContain('_list := SELECT InputView FROM root');
    expect(ec.split('\n')[0]).toBe('_q := "crev \\"qa\\""');
    expect(ec).toContain('.toLowerCase.indexOf(_q)');
    expect(ec).toContain('_r := _r + _rc');
    expect(() => buildNameSearchEc('Bad Type', 'x', frame)).toThrow();
    expect(parseNameSearchLog('noise' + framedText([['2184360149894601037', 'InputView', 'crev_qa_inputview', 'CREV QA Input view']]), frame))
      .toEqual([{ rid: '2184360149894601037', type: 'InputView', businessId: 'crev_qa_inputview', name: 'CREV QA Input view' }]);
    expect(() => parseNameSearchLog(framedText([['1', 'X']], false), frame)).toThrow(/incomplete/);
  });

  it('merges sources: exact first, then by match, each object once, as they answer', async () => {
    const { searchObjects } = await import('../object-search');
    const emitted: string[][] = [];
    const found = await searchObjects('crev_qa', {
      exact: async () => null,
      local: async () => [{ rid: '1', name: 'Other crev_qa thing', type: 'ExtendedExpression', businessId: 'x_crev_qa' }],
      server: async (_q, skip) => { expect(skip).toBe(true); return [{ rid: '2', name: 'CREV QA view', type: 'InputView', businessId: 'crev_qa' }, { rid: '1', name: 'dup', type: 'X', businessId: '' }]; },
      portal: async () => { throw new Error('portal down'); },
    }, new AbortController().signal, list => emitted.push(list.map(o => o.rid)));
    expect(found.map(o => o.rid)).toEqual(['2', '1']);
    expect(emitted.find(e => e.length)).toEqual(['1']);
    const exact = await searchObjects('1234567890123456789', {
      exact: async () => ({ rid: '1234567890123456789', name: 'R', type: 'T', businessId: 'r' }),
      local: async () => null,
      server: async (_q, skip) => { expect(skip).toBe(false); return []; },
    }, new AbortController().signal, () => {});
    expect(exact[0]).toMatchObject({ rid: '1234567890123456789', exact: true });
  });

  it('throws only when every source failed', async () => {
    const { searchObjects } = await import('../object-search');
    const fail = async () => { throw new Error('offline'); };
    await expect(searchObjects('x', { exact: fail, local: fail, server: fail }, new AbortController().signal, () => {})).rejects.toThrow('offline');
  });
});
