import { describe, expect, it } from 'vitest';
import { classSlug, classWord, idProblem, nameWords, proposeIds, sharedPrefix, sharedSuffix, slugOf, MAX_ID_LENGTH, basisText, type IdObject } from '../numeric-id-propose';

let n = 0;
const obj = (o: Partial<IdObject> & { id: string; name: string; className: string }): IdObject => ({ rid: o.rid ?? String(100_000 + ++n), parentRid: '1', space: 't', ...o });

describe('slugOf', () => {
  it('lowers case, joins words with an underscore and drops accents', () => {
    expect(slugOf('Open controls')).toBe('open_controls');
    expect(slugOf('  Résumé: Größe / 2026 ')).toBe('resume_grosse_2026');
    expect(slugOf('!!!')).toBe('');
    expect(nameWords('A-B_c')).toEqual(['a', 'b', 'c']);
  });
  it('cuts at a word and keeps a long first word', () => {
    expect(slugOf('alpha beta gamma delta epsilon zeta', 20)).toBe('alpha_beta_gamma');
    expect(slugOf('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij');
  });
});

describe('sharedPrefix', () => {
  it('takes the longest run of words most IDs start with', () => {
    expect(sharedPrefix(['btn_proto_run', 'btn_proto_stop'])).toBe('btn_proto');
    expect(sharedPrefix(['btn_run', 'btn_stop_x'])).toBe('btn');
    // Two of three share `tax_tpl_a`; all three share only `tax_tpl`, and the longer run wins when it is a majority.
    expect(sharedPrefix(['tax_tpl_a_x', 'tax_tpl_a_y', 'tax_tpl_b_z'])).toBe('tax_tpl_a');
    expect(sharedPrefix(['tax_tpl_a_x', 'tax_tpl_b_y', 'tax_tpl_c_z'])).toBe('tax_tpl');
  });
  it('needs two IDs, a majority and words after the prefix', () => {
    expect(sharedPrefix(['btn_run'])).toBeNull();
    expect(sharedPrefix(['a_x', 'b_y', 'c_z'])).toBeNull();
    expect(sharedPrefix(['lonely', 'single'])).toBeNull();
    expect(sharedPrefix(['icon_erm', 'icon_ctrl', 'plain'])).toBe('icon');
  });
});

describe('classWord', () => {
  it('knows common classes and abbreviates the others', () => {
    expect(classWord('ActionButton')).toBe('btn');
    expect(classWord('Tab')).toBe('tab');
    expect(classWord('SomeNewWidget')).toBe('snw');
    expect(classWord('Gadget')).toBe('gad');
    expect(classWord('')).toBe('obj');
  });
});

describe('classSlug and sharedSuffix', () => {
  it('splits a class name into words', () => {
    expect(classSlug('NameColumn')).toBe('name_column');
    expect(classSlug('EPMForm')).toBe('epm_form');
  });
  it('finds the word most IDs of a class end with', () => {
    expect(sharedSuffix(['a_tab', 'b_tab', 'c_tab', 'd_tab', 'e_x', 'f_tab'])).toBe('tab');
    // Too few IDs, no majority of 40%, a number as the last word: no suffix.
    expect(sharedSuffix(['a_tab', 'b_tab', 'c_tab'])).toBeNull();
    expect(sharedSuffix(['a_x', 'b_y', 'c_z', 'd_w', 'e_v', 'f_u'])).toBeNull();
    expect(sharedSuffix(['a_1', 'b_1', 'c_1', 'd_1', 'e_1'])).toBeNull();
  });
});

describe('idProblem', () => {
  it('accepts a readable ID', () => {
    expect(idProblem('btn_proto_cleanup')).toBeNull();
    expect(idProblem('A1')).toBeNull();
  });
  it('refuses what BMP or the code references cannot use', () => {
    expect(idProblem('')).toMatch(/Enter/);
    expect(idProblem('has space')).toMatch(/Letters/);
    expect(idProblem('5612')).toMatch(/letters/);
    expect(idProblem('9lives')).toMatch(/Start with a letter/);
    expect(idProblem('children')).toMatch(/BMP itself/);
    expect(idProblem('x'.repeat(MAX_ID_LENGTH + 1))).toMatch(/At most/);
    expect(idProblem('taken_one', id => (id === 'taken_one' ? 'Already used' : null))).toBe('Already used');
  });
});

describe('proposeIds', () => {
  it('follows the siblings of the same class', () => {
    const world = [
      obj({ id: 'btn_proto_run', name: 'Run', className: 'ActionButton' }),
      obj({ id: 'btn_proto_stop', name: 'Stop', className: 'ActionButton' }),
      obj({ id: 'lbl_other', name: 'Other', className: 'Label' }),
    ];
    const t = obj({ id: '5674', name: 'Cleanup', className: 'ActionButton' });
    const p = proposeIds([t], [...world, t]).get(t.rid)!;
    expect(p).toMatchObject({ id: 'btn_proto_cleanup', basis: 'siblings', prefix: 'btn_proto' });
    expect(basisText(p)).toContain('btn_proto');
  });

  it('uses the siblings of any class when the class alone has no pattern', () => {
    const world = [
      obj({ id: 'tax_tpl_control_progress_a', name: 'A', className: 'Label' }),
      obj({ id: 'tax_tpl_control_progress_b', name: 'B', className: 'Container' }),
    ];
    const t = obj({ id: '5733', name: 'Reassign', className: 'ExtendedCode' });
    expect(proposeIds([t], [...world, t]).get(t.rid)).toMatchObject({ id: 'tax_tpl_control_progress_reassign', basis: 'siblings' });
  });

  it('follows the parent when its children start with its ID', () => {
    const parent = obj({ rid: 'P', parentRid: '0', id: 'tab_prop_risk', name: 'Risk', className: 'Tab' });
    const kids = [obj({ parentRid: 'P', id: 'tab_prop_risk_r1', name: 'Row 1', className: 'Container' })];
    const t = obj({ parentRid: 'P', id: '5621', name: 'Owner', className: 'Label' });
    const p = proposeIds([t], [parent, ...kids, t]).get(t.rid)!;
    expect(p).toMatchObject({ id: 'tab_prop_risk_owner', basis: 'parent', prefix: 'tab_prop_risk' });
  });

  it('falls back on the most common first word of the class, then a short class word', () => {
    const world = ['icon_a', 'icon_b', 'icon_c', 'icon_d'].map((id, i) => obj({ parentRid: String(900 + i), id, name: id, className: 'ImageView' }));
    const t = obj({ parentRid: '777', id: '5701', name: 'ERM', className: 'ImageView' });
    expect(proposeIds([t], [...world, t]).get(t.rid)).toMatchObject({ id: 'icon_erm', basis: 'class' });
    const lone = obj({ parentRid: '778', id: '5702', name: 'Brand blue', className: 'Gadget' });
    expect(proposeIds([lone], [lone]).get(lone.rid)).toMatchObject({ id: 'brand_blue', basis: 'default' });
  });

  it('keeps a spaces apart: the same ID in another ID space is not a clash', () => {
    const a = obj({ id: 'btn_run', name: 'Run', className: 'Gadget', space: 'r' });
    const t = obj({ id: '5', name: 'Run', className: 'Gadget' });
    expect(proposeIds([t], [a, t]).get(t.rid)!.id).toBe('run');
  });

  it('is unique against every ID of the space and against the other proposals', () => {
    const existing = obj({ id: 'cleanup', name: 'x', className: 'ActionButton' });
    const a = obj({ id: '5001', name: 'Cleanup', className: 'ActionButton', rid: '1001' });
    const b = obj({ id: '5002', name: 'Cleanup', className: 'ActionButton', rid: '1002' });
    const c = obj({ id: '5003', name: 'Cleanup', className: 'ActionButton', rid: '1003' });
    const out = proposeIds([c, a, b], [existing, a, b, c]);
    // The existing ID makes the first free one `_2`; the batch goes in RID order.
    expect([out.get('1001')!.id, out.get('1002')!.id, out.get('1003')!.id]).toEqual(['cleanup_2', 'cleanup_3', 'cleanup_4']);
  });

  it('treats case alone as a clash and honours IDs taken outside the scan', () => {
    const existing = obj({ id: 'RUN', name: 'x', className: 'ActionButton' });
    const t = obj({ id: '5', name: 'Run', className: 'ActionButton' });
    expect(proposeIds([t], [existing, t]).get(t.rid)!.id).toBe('run_2');
    expect(proposeIds([t], [t], { taken: new Set(['t\u0000run']) }).get(t.rid)!.id).toBe('run_2');
  });

  it('gives valid, letter-first, bounded IDs for hard names', () => {
    const names = ['2026 plan', '', '日本語', 'x'.repeat(200), 'size', 'a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f'];
    const targets = names.map((name, i) => obj({ id: String(9000 + i), name, className: 'Container', rid: String(500 + i) }));
    const out = proposeIds(targets, targets);
    const ids = [...out.values()].map(p => p.id);
    for (const id of ids) {
      expect(idProblem(id)).toBeNull();
      expect(id).toMatch(/^[a-z]/);
      expect(id.length).toBeLessThanOrEqual(MAX_ID_LENGTH);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives the same answer whatever order the targets come in', () => {
    const world = [obj({ id: 'tbl_a', name: 'A', className: 'ExtendedTable' }), obj({ id: 'tbl_b', name: 'B', className: 'ExtendedTable' })];
    const ts = [1, 2, 3].map(i => obj({ id: String(7000 + i), name: 'Same', className: 'ExtendedTable', rid: String(300 + i) }));
    const all = [...world, ...ts];
    const one = [...proposeIds(ts, all)].map(([k, v]) => [k, v.id]).sort();
    const two = [...proposeIds([...ts].reverse(), [...all].reverse())].map(([k, v]) => [k, v.id]).sort();
    expect(two).toEqual(one);
  });

  it('does not reuse a long parent ID as a prefix', () => {
    const parent = obj({ rid: 'P', parentRid: '0', id: 'p'.repeat(60), name: 'Long', className: 'Tab' });
    const kid = obj({ parentRid: 'P', id: `${'p'.repeat(60)}_one`, name: 'One', className: 'Label' });
    const t = obj({ parentRid: 'P', id: '5', name: 'Two', className: 'Label' });
    expect(proposeIds([t], [parent, kid, t]).get(t.rid)).toMatchObject({ basis: 'default', id: 'two' });
  });

  it('ends with the word the workspace ends the IDs of the class with', () => {
    const world = ['org_risks_tab', 'asset_controls_tab', 'impact_overview_tab', 'issue_list_tab', 'work_tab'].map((id, i) => obj({ parentRid: String(800 + i), id, name: id, className: 'Tab' }));
    const t = obj({ parentRid: '777', id: '316', name: 'My KPIs', className: 'Tab' });
    expect(proposeIds([t], [...world, t]).get(t.rid)).toMatchObject({ id: 'my_kpis_tab', basis: 'default' });
    const already = obj({ parentRid: '777', id: '317', name: 'Archive tab', className: 'Tab' });
    expect(proposeIds([already], [...world, already]).get(already.rid)!.id).toBe('archive_tab');
  });

  it('makes an ID from the class when the name has no letters', () => {
    const t = obj({ parentRid: '778', id: '282', name: '', className: 'NameColumn' });
    expect(proposeIds([t], [t]).get(t.rid)!.id).toBe('name_column');
  });

  it('adds the parent to a name that clashes before it adds a number', () => {
    const pa = obj({ rid: 'PA', parentRid: '0', id: 'risk_form', name: 'Risk form', className: 'Container' });
    const pb = obj({ rid: 'PB', parentRid: '0', id: '4000', name: 'Control form', className: 'Container' });
    const a = obj({ rid: '1', parentRid: 'PA', id: '5001', name: 'Details', className: 'Label' });
    const b = obj({ rid: '2', parentRid: 'PB', id: '5002', name: 'Details', className: 'Label' });
    const out = proposeIds([a, b], [pa, pb, a, b]);
    expect([out.get('1')!.id, out.get('2')!.id]).toEqual(['details', 'control_form_details']);
  });
});
