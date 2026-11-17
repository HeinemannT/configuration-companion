import { describe, expect, it } from 'vitest';
import { findCodeRefs, groupCodeRefs, parseRefKey, refKey, refLabel } from '../code-refs';

const pick = (text: string) => findCodeRefs(text).map(r => ({ text: text.slice(r.start, r.end), key: r.key, form: r.form, prop: r.prop, line: r.line }));

describe('findCodeRefs: forms', () => {
  it('finds an ID space reference and links its trailing .expression', () => {
    expect(pick('_v := t.ab_validate.expression')).toEqual([
      { text: 't.ab_validate.expression', key: 't.ab_validate', form: 'dot', prop: 'expression', line: 1 },
    ]);
  });

  it('reports a non-code trailing property but does not link it', () => {
    const [r] = findCodeRefs('_n := t.ab_template.name');
    expect(r.prop).toBe('name');
    expect('_n := t.ab_template.name'.slice(r.start, r.end)).toBe('t.ab_template');
  });

  it('does not treat a method call as the trailing property', () => {
    const [r] = findCodeRefs('t.ab_legacy.expression.whenMissing(MISSING)');
    expect(r.prop).toBe('expression');
    const [m] = findCodeRefs('t.ab_list.whenMissing(LIST())');
    expect(m.prop).toBeUndefined();
    expect(m.end).toBe('t.ab_list'.length);
  });

  it('finds every known namespace and skips unknown prefixes', () => {
    expect(pick('ceras.r_1 + o.org_a + k.prop_x + zz.nope + u.jdoe').map(r => r.key)).toEqual(['ceras.r_1', 'o.org_a', 'k.prop_x', 'u.jdoe']);
  });

  it('keeps numeric business IDs and the two-character minimum', () => {
    expect(pick('t.5663 + t.42 + t.x').map(r => r.key)).toEqual(['t.5663', 't.42']);
  });

  it('finds a literal get() with IDs containing - and .', () => {
    expect(pick('_a := t.get("ab-check.v2").expression\n_b := o.get(\'org-1\')')).toEqual([
      { text: 't.get("ab-check.v2").expression', key: 't.ab-check.v2', form: 'get', prop: 'expression', line: 1 },
      { text: "o.get('org-1')", key: 'o.org-1', form: 'get', prop: undefined, line: 2 },
    ]);
  });

  it('allows spaces inside get( … )', () => {
    expect(pick('t.get( "x_y" )').map(r => r.key)).toEqual(['t.x_y']);
  });

  it('does not take a computed get() argument', () => {
    expect(pick('t.get(_id)')).toEqual([]);
    expect(pick('t.get("ab_" + _kind)')).toEqual([]);
    expect(pick('t.get("")')).toEqual([]);
  });

  it('still finds references inside a computed get() argument', () => {
    expect(pick('t.get(t.ab_key.expression)').map(r => r.key)).toEqual(['t.ab_key']);
  });

  it('finds the brace call as t.<id>.expression', () => {
    expect(pick('IF {expr_heartbeat} THEN')).toEqual([
      { text: '{expr_heartbeat}', key: 't.expr_heartbeat', form: 'brace', prop: 'expression', line: 1 },
    ]);
    expect(pick('{5663}').map(r => r.key)).toEqual(['t.5663']);
    expect(pick('{x} + { a }')).toEqual([]);
  });

  it('finds lookup() with a bare or quoted RID', () => {
    expect(pick('lookup(8510842252680580489).name + lookup("1234567").expression')).toEqual([
      { text: 'lookup(8510842252680580489)', key: 'rid:8510842252680580489', form: 'lookup', prop: 'name', line: 1 },
      { text: 'lookup("1234567").expression', key: 'rid:1234567', form: 'lookup', prop: 'expression', line: 1 },
    ]);
    expect(pick('lookup(_rid) + lookup(123)')).toEqual([]);
  });

  it('keeps 64-bit RIDs as exact strings', () => {
    const [r] = findCodeRefs('lookup(9223372036854775807)');
    expect(r.id).toBe('9223372036854775807');
    expect(typeof r.id).toBe('string');
  });

  it('finds rid=… and rid:… as the editor did', () => {
    expect(pick('// x\n_t := rid=1234567 + RID:7654321').map(r => r.key)).toEqual(['rid:1234567', 'rid:7654321']);
    expect(pick('rid:=1234567')).toEqual([]);
  });
});

describe('findCodeRefs: what is not a reference', () => {
  it('ignores line comments', () => {
    expect(pick('// calls t.ab_old.expression\n_x := 1')).toEqual([]);
  });

  it('ignores block comments, also across lines', () => {
    expect(pick('/* t.ab_a\n t.ab_b */ t.ab_c')).toEqual([{ text: 't.ab_c', key: 't.ab_c', form: 'dot', prop: undefined, line: 2 }]);
  });

  it('ignores ordinary string literals, also with escapes and line breaks', () => {
    expect(pick('_s := "see t.ab_a and {ab_b}"\n_q := "a \\" t.ab_c"\n_m := "x\nt.ab_d" + t.ab_e')).toEqual([
      { text: 't.ab_e', key: 't.ab_e', form: 'dot', prop: undefined, line: 4 },
    ]);
  });

  it('ignores members of other values', () => {
    expect(pick('_x.t.foo + this.object.t_kind + _rec.o.bar')).toEqual([]);
  });

  it('ignores identifiers that only end like a namespace', () => {
    expect(pick('_list.size() + root.portal + format.ab')).toEqual([]);
  });

  it('copes with an unterminated string or comment', () => {
    expect(pick('t.ab_a + "open t.ab_b')).toHaveLength(1);
    expect(pick('t.ab_a /* open t.ab_b')).toHaveLength(1);
  });
});

describe('findCodeRefs: members of an ID space', () => {
  it('skips methods and members of the space itself', () => {
    expect(pick('t.children() + t.id + u.current + o.descendants(Organisation) + t.foo(1)')).toEqual([]);
  });

  it('links a trailing code property written after a space', () => {
    expect(pick('_x := t.ab_one .expression').map(r => r.text)).toEqual(['t.ab_one .expression']);
  });
});

describe('findCodeRefs: positions', () => {
  it('numbers lines from 1 and ranges cover the source text', () => {
    const text = 'IF TRUE THEN\n    _a := t.ab_one.expression\n    _b := t.get("ab-two")\nENDIF';
    const refs = findCodeRefs(text);
    expect(refs.map(r => r.line)).toEqual([2, 3]);
    expect(refs.map(r => text.slice(r.start, r.end))).toEqual(['t.ab_one.expression', 't.get("ab-two")']);
  });
});

describe('groupCodeRefs', () => {
  it('lists each object once with every line that names it', () => {
    const uses = groupCodeRefs(findCodeRefs('t.a1\nt.b2 + t.a1.expression\nt.get("a1")'));
    expect(uses.map(u => [u.key, u.lines])).toEqual([['t.a1', [1, 2, 3]], ['t.b2', [2]]]);
  });
});

describe('keys and labels', () => {
  it('round-trips keys', () => {
    expect(parseRefKey(refKey('t', 'ab-x.v2'))).toEqual({ ns: 't', id: 'ab-x.v2' });
    expect(parseRefKey(refKey('', '1234567'))).toEqual({ ns: '', id: '1234567' });
    expect(parseRefKey('zz.foo')).toBeNull();
    expect(parseRefKey('t.a"b')).toBeNull();
    expect(parseRefKey('rid:12')).toBeNull();
  });

  it('labels a reference the way it is written', () => {
    expect(refLabel({ ns: 't', id: 'a', form: 'dot' })).toBe('t.a');
    expect(refLabel({ ns: 't', id: 'a-b', form: 'get' })).toBe('t.get("a-b")');
    expect(refLabel({ ns: '', id: '1234567', form: 'lookup' })).toBe('lookup(1234567)');
  });
});
