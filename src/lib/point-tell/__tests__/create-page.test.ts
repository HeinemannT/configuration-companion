import { describe, expect, it } from 'vitest';
import { buildCreatePageEc, buildReadBackEc, checkCreatePage, parseCreatePage, proposePageId } from '../create-page';

const plan = { parentRid: '4797501244326270080', kind: 'Scorecard' as const, id: 'sc_supplier_contracts', name: 'Supplier contracts' };

describe('creating the empty page', () => {
  it('golden: the script', () => {
    expect(buildCreatePageEc(plan)).toBe([
      '_p := lookup(4797501244326270080)',
      '_n := _p.add(Scorecard, id := "sc_supplier_contracts", name := "Supplier contracts")',
      '"<<<CREV_NEWPAGE>>>" + str(_n.rid) + "|" + _n.className.whenMissing("") + "|" + _n.id.whenMissing("") + "|" + str(_n.parent.rid.whenMissing(""))',
    ].join('\n'));
  });

  it('no id: BMP gives one; a model page; the name is escaped', () => {
    const ec = buildCreatePageEc({ ...plan, kind: 'ModelPage', id: '', name: 'A "quoted" name' });
    expect(ec).toContain('_p.add(ModelPage, name := "A \\"quoted\\" name")');
    expect(ec).not.toContain('id :=');
  });

  it('refuses what could carry code: the kind, the rid, the id, a name with a line break', () => {
    expect(checkCreatePage({ ...plan, kind: 'Scorecard) + x(' as never })).toBeTruthy();
    expect(checkCreatePage({ ...plan, parentRid: '1) + lookup(2' })).toBeTruthy();
    expect(checkCreatePage({ ...plan, id: 'a"b' })).toBeTruthy();
    expect(checkCreatePage({ ...plan, id: '9abc' })).toBeTruthy();
    expect(checkCreatePage({ ...plan, name: 'one\ntwo' })).toBeTruthy();
    expect(checkCreatePage({ ...plan, name: '  ' })).toBeTruthy();
    expect(checkCreatePage(plan)).toBeNull();
    expect(() => buildCreatePageEc({ ...plan, parentRid: 'x' })).toThrow();
  });

  it('reads the answer: rid, class, id and parent, as strings', () => {
    expect(parseCreatePage('x\n<<<CREV_NEWPAGE>>>5065626956881177284|Scorecard|crev_qa|4797501244326270080\nDuration')).toEqual({ rid: '5065626956881177284', className: 'Scorecard', id: 'crev_qa', parentRid: '4797501244326270080' });
    expect(parseCreatePage('nothing')).toBeNull();
    expect(buildReadBackEc('5065626956881177284')).toContain('lookup(5065626956881177284)');
  });

  it('proposes an id from the name', () => {
    expect(proposePageId('Scorecard', 'Supplier contracts')).toBe('sc_supplier_contracts');
    expect(proposePageId('ModelPage', 'Übersicht Lieferanten')).toBe('mp_ubersicht_lieferanten');
    expect(proposePageId('Scorecard', 'Risks', 'scx_')).toBe('scx_risks');
    expect(proposePageId('Scorecard', '???')).toBe('');
  });
});
