import { describe, expect, it } from 'vitest';
import { JavaEnum, type JavaClassDesc } from '../java-serial';
import { isExpressionPropName, parseFullObject, parseReferences, savesViaExtendedCode, toPropValue } from '../object-read';

const desc = (name: string): JavaClassDesc => ({ name, uid: 0n, flags: 0, fields: [], parent: null });
const rid = (id: bigint) => ({ $class: 'com.corporater.base.generation.system.Rid', identifier: id });
/** 64-bit rid above Number.MAX_SAFE_INTEGER — must survive as an exact string. */
const BIG = 8230411327538902142n;

function sampleRead() {
  return {
    $class: 'com.corporater.bmp.dto.integration.IntegrationObjectResponse',
    response: {
      props: {
        _rid: rid(2081208944661642130n),
        _type: { $class: 'com.corporater.base.generation.system.TypeKey', typeId: 'ButtonInput' },
        name: 'Write',
        id: '5629',
        description: '',
        useShowExpression: { $class: 'java.lang.Boolean', value: false },
        sortIndex: { $class: 'java.lang.Integer', value: 2 },
        bigNumber: { $class: 'java.lang.Long', value: BIG },
        buttonType: new JavaEnum(desc('com.corporater.bmp.web.ButtonInputType'), 'expression'),
        expression: { $class: 'com.corporater.bmp.value.type.expression.CorpoExtendedExpression', value: 'key_a.change(x := 1)' },
        showExpression: '',
        information: { $class: 'com.corporater.bmp.value.type.HtmlText', value: '<b>Hi</b>' },
        createdTime: { $class: 'com.corporater.bmp.base.date.CorpoTime', ms: 1778772366000n, calendarType: null, formattedValue: null },
        refreshTypes: { $class: 'com.corporater.collection.SeqListImpl', delegate: { $class: 'java.util.ArrayList', $elements: ['A', 'B'] } },
        '6706820787741909129': 'custom value',
        oddity: { $class: 'com.example.Unmapped', foo: { bar: 1 } },
      },
      references: {
        $class: 'java.util.HashMap',
        $map: {
          parent: { $class: 'java.util.ArrayList', $elements: [rid(1521507040334396171n)] },
          inputSet: { $class: 'java.util.ArrayList', $elements: [rid(BIG)] },
          '2270032381513260657': { $class: 'java.util.ArrayList', $elements: [rid(1321649004718035948n)] },
          writeAccessors: { $class: 'java.util.ArrayList', $elements: [] },
        },
      },
      overridden: { $class: 'java.util.HashSet', $elements: ['sortIndex', 'expression'] },
      mutated: { $class: 'java.util.HashSet', $elements: [] },
    },
  };
}

describe('parseFullObject', () => {
  it('keeps identity, with the rid as an exact string', () => {
    const obj = parseFullObject(sampleRead())!;
    expect(obj.rid).toBe('2081208944661642130');
    expect(obj.type).toBe('ButtonInput');
    expect(obj.name).toBe('Write');
    expect(obj.businessId).toBe('5629');
    expect(obj.props._rid).toBeUndefined();
  });

  it('derives value kinds from the boxed classes', () => {
    const p = parseFullObject(sampleRead())!.props;
    expect(p.useShowExpression).toMatchObject({ kind: 'boolean', bool: false });
    expect(p.sortIndex).toMatchObject({ kind: 'number', num: 2, text: '2' });
    expect(p.bigNumber).toEqual({ kind: 'number', text: BIG.toString() });
    expect(p.buttonType).toMatchObject({ kind: 'enum', text: 'expression', enumClass: 'ButtonInputType' });
    expect(p.expression).toMatchObject({ kind: 'code', text: 'key_a.change(x := 1)' });
    expect(p.showExpression).toMatchObject({ kind: 'code', text: '' });
    expect(p.description).toMatchObject({ kind: 'text', text: '' });
    expect(p.information).toMatchObject({ kind: 'html', text: '<b>Hi</b>' });
    expect(p.createdTime.kind).toBe('time');
    expect(p.createdTime.text).toMatch(/^2026-05-14/);
    expect(p.refreshTypes).toMatchObject({ kind: 'list', items: ['A', 'B'] });
    expect(p.oddity.kind).toBe('unknown');
  });

  it('keeps custom properties keyed by their numeric property rid', () => {
    const obj = parseFullObject(sampleRead())!;
    expect(obj.props['6706820787741909129']).toMatchObject({ kind: 'text', text: 'custom value' });
    expect(obj.references['2270032381513260657']).toEqual(['1321649004718035948']);
  });

  it('reads references as role → rid strings and overridden names', () => {
    const obj = parseFullObject(sampleRead())!;
    expect(obj.references.parent).toEqual(['1521507040334396171']);
    expect(obj.references.inputSet).toEqual([BIG.toString()]);
    expect(obj.references.writeAccessors).toEqual([]);
    expect(obj.overridden).toEqual(['sortIndex', 'expression']);
  });

  it('accepts the bare ObjectData and rejects non-object reads', () => {
    expect(parseFullObject(sampleRead().response)?.rid).toBe('2081208944661642130');
    expect(parseFullObject(null)).toBeNull();
    expect(parseFullObject({ $class: 'x.ServerExceptionResponse', message: 'boom' })).toBeNull();
  });

  it('tolerates a read without references or overridden (older servers)', () => {
    const obj = parseFullObject({ props: { _rid: rid(42n), name: 'n' } })!;
    expect(obj.references).toEqual({});
    expect(obj.overridden).toEqual([]);
    expect(obj.type).toBe('');
  });
});

describe('value helpers', () => {
  it('treats *Expression strings as code', () => {
    expect(toPropValue('afterExpression', 'x').kind).toBe('code');
    expect(toPropValue('useShowExpression', true).kind).toBe('boolean');
    expect(toPropValue('title', 'x').kind).toBe('text');
  });

  it('parses $entries maps and string rids', () => {
    expect(parseReferences({ $entries: [['parent', ['123456789012345678901']]] })).toEqual({ parent: ['123456789012345678901'] });
    expect(parseReferences(undefined)).toEqual({});
  });
});

describe('save route for SAVE_PROPERTY', () => {
  const EXPRESSION_SLOTS = [
    'expression', 'afterExpression', 'enableExpression', 'showExpression', 'initExpression',
    'refreshExpression', 'destinationExpression', 'defaultExpression', 'requiredExpression',
    'editExpression', 'validateExpression',
  ];

  it('sends every expression slot through Extended Code when only the name is known', () => {
    for (const p of EXPRESSION_SLOTS) expect(savesViaExtendedCode(p), p).toBe(true);
  });

  it('keeps the script props and TextElement bodies on Extended Code', () => {
    for (const p of ['html', 'javascript', 'text', 'longText']) expect(savesViaExtendedCode(p), p).toBe(true);
    expect(savesViaExtendedCode('text', 'text')).toBe(true);
  });

  it('never routes the boolean gates or plain properties to Extended Code by name', () => {
    for (const p of ['useShowExpression', 'useEnableExpression', 'description', 'name', 'shadow']) {
      expect(isExpressionPropName(p), p).toBe(false);
      expect(savesViaExtendedCode(p), p).toBe(false);
    }
  });

  it('lets the read kind decide when the caller passes it', () => {
    expect(savesViaExtendedCode('customScript', 'code')).toBe(true);
    expect(savesViaExtendedCode('useShowExpression', 'boolean')).toBe(false);
    expect(savesViaExtendedCode('afterExpression', 'code')).toBe(true);
    // An unknown kind says nothing; the name decides.
    expect(savesViaExtendedCode('afterExpression', 'unknown')).toBe(true);
  });

  it('agrees with the kind the read reports for a CorpoExtendedExpression value', () => {
    const v = toPropValue('afterExpression', { $class: 'com.corporater.bmp.value.type.expression.CorpoExtendedExpression', value: '' });
    expect(v.kind).toBe('code');
    expect(savesViaExtendedCode('afterExpression', v.kind)).toBe(true);
  });
});

describe('empty collections', () => {
  it('reads an empty SeqListImpl or java.util list as an empty list, never its class name', async () => {
    const { toPropValue } = await import('../object-read');
    for (const raw of [
      { $class: 'com.corporater.collection.SeqListImpl' },
      { $class: 'com.corporater.collection.SeqListImpl', delegate: null },
      { $class: 'java.util.Collections$EmptyList' },
    ]) {
      expect(toPropValue('refreshTypes', raw)).toEqual({ kind: 'list', text: '', items: [] });
    }
    // A structured value whose class merely ends in "List" keeps its class.
    expect(toPropValue('conditions', { $class: 'com.corporater.bmp.ConditionGroupList' })).toMatchObject({ kind: 'unknown', cls: 'ConditionGroupList' });
  });
});
