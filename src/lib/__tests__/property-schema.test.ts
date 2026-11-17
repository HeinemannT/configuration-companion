import { describe, expect, it } from 'vitest';
import {
  ABSENT, categoryTitle, normalizeDecimal, changeLine, changeLineSize, classifyField, customModels, customSections, DATED_NO_CLEAR, encodeCustomValue, historicalChangeLine,
  allowedSourceOf, NOT_ALLOWED_OBJECT, parseFieldDescription, parseNumberInput, REASON_TEXT, sameReferences, storedClassAllows, storedEquals, storedValue, type DefinitionFacts,
} from '../property-schema';
import { ALLOWED, BY_TYPE_DEFINITION, BY_TYPE_REF, DEF, DEFINITIONS, FOREIGN_ITEM, FOREIGN_OBJECT, ITEMS, fields, schema, withByType } from './fixtures/property-fields';

describe('field description', () => {
  it('keeps every attribute of the FieldDto, in plain form', async () => {
    const all = await fields();
    const kind = all.find(f => f.id === DEF.kind)!;
    expect(kind).toMatchObject({
      name: DEF.kind, businessId: 'kind', displayName: 'Kind', category: 'Identity', sortIndex: 39, type: 'ListPropertySetItem',
      customField: true, editable: true, choice: true, reference: true, methodVisibility: 'NOTVISIBLE',
      options: ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'],
    });
    expect(kind.locationsWhereVisible).toContain('WEBEDITOR');
    const regions = all.find(f => f.id === DEF.regions)!;
    expect(regions).toMatchObject({ multiselect: true, collectionType: 'BusinessTreeObject', referenceConstraints: { allowBlank: true, allowedTypes: [] } });
    expect(regions.referenceConstraints?.sourceExpression).toContain('root.organisation');
    expect(all.find(f => f.id === 'description')!.expert).toEqual({ cs: true });
    expect(all.find(f => f.id === 'rid')!.readOnly).toBe(true);
    // Absent booleans stay absent (false).
    expect(all.find(f => f.id === DEF.enabled)!.historical).toBeUndefined();
    expect(parseFieldDescription(null)).toBeNull();
    expect(parseFieldDescription({})).toBeNull();
  });
});

describe('kind and editability', () => {
  it('derives the kind of each recorded field', async () => {
    const s = await schema();
    const by = Object.fromEntries(s.fields.map(f => [f.businessId, classifyField(f, s.definitions[f.id])]));
    expect(by.kind.kind).toBe('listItem');
    expect(by.regions.kind).toBe('referenceList');
    expect(by.owner.kind).toBe('principal');
    expect(by.enabled.kind).toBe('boolean');
    expect(by.note.kind).toBe('text');
    expect(by.weight).toMatchObject({ kind: 'number' });
    expect(by.weight.integer).toBeUndefined();
    expect(by.summary.kind).toBe('multiline');
    expect(by.review.kind).toBe('date');
    expect(by.body.kind).toBe('rich');
    expect(by.description.kind).toBe('rich');
    expect(by.showToolMenu.kind).toBe('boolean');
  });

  it('says why a property cannot be edited, in one line', async () => {
    const s = await schema();
    const verdict = (bid: string) => {
      const f = s.fields.find(x => x.businessId === bid)!;
      const m = classifyField(f, s.definitions[f.id]);
      return m.editability.ok ? 'ok' : m.editability.text;
    };
    expect(verdict('kind')).toBe('ok');
    expect(verdict('note')).toBe('ok');
    expect(verdict('weight')).toBe('ok');
    expect(verdict('summary')).toBe('ok');
    // Historical by the definition's class, although the description says
    // false: editable (written with a plain change).
    expect(verdict('enabled')).toBe('ok');
    // References whose definition has an expression: editable, also on a Historical class.
    expect(verdict('owner')).toBe('ok');
    expect(verdict('regions')).toBe('ok');
    expect(verdict('review')).toBe('Editing dates comes in a later version');
    expect(verdict('body')).toBe('Editing rich text comes in a later version');
    expect(verdict('score')).toBe('Calculated by Extended Code');
    expect(verdict('locked')).toBe('Read-only for this type');
    expect(verdict('secret')).toBe('Hidden for this type');
    expect(verdict('showToolMenu')).toBe('Not editable here');
    expect(verdict('rid')).toBe('Not editable here');
  });

  it('a historical boolean is editable only with the switch on', async () => {
    const s = await schema();
    const f = s.fields.find(x => x.businessId === 'enabled')!;
    const on = classifyField(f, s.definitions[f.id], { historicalWrites: true });
    expect(on.editability.ok).toBe(true);
    expect(on.historical).toBe(true);
    expect(on.dated).toBe(true);
    const off = classifyField(f, s.definitions[f.id], { historicalWrites: false });
    expect(off.editability).toEqual({ ok: false, reason: 'historical', text: 'Historical value: editing comes next' });
    expect(off.dated).toBeUndefined();
  });

  it('with the switch off every non-reference historical kind is read-only as historical', async () => {
    const s = await schema();
    const of = (bid: string, def: DefinitionFacts) => classifyField(s.fields.find(x => x.businessId === bid)!, def, { historicalWrites: false });
    for (const [bid, def] of [
      ['note', { configClass: 'HistoricalTextMethodConfig' }],
      ['summary', { configClass: 'HistoricalTextMethodConfig' }],
      ['weight', { configClass: 'HistoricalNumberMethodConfig' }],
      ['enabled', { configClass: 'HistoricalBooleanMethodConfig' }],
      ['kind', { configClass: 'HistoricalListMethodConfig', listSetRid: DEFINITIONS[DEF.kind].listSetRid }],
    ] as const) {
      expect(of(bid, def).editability, bid).toMatchObject({ ok: false, reason: 'historical' });
      expect(storedClassAllows(def.configClass, of(bid, def).kind, false), bid).toBe(false);
    }
  });

  it('dated: set on an editable historical text, absent on a plain one and on a read-only historical one', async () => {
    const s = await schema();
    const note = s.fields.find(x => x.businessId === 'note')!;
    const hist = classifyField(note, { configClass: 'HistoricalTextMethodConfig' });
    expect(hist).toMatchObject({ kind: 'text', historical: true, dated: true, editability: { ok: true } });
    const plain = classifyField(note, { configClass: 'TextMethodConfig' });
    expect(plain).toMatchObject({ kind: 'text', historical: false, editability: { ok: true } });
    expect(plain.dated).toBeUndefined();
    // Historical but read-only for another reason: not dated.
    const locked = classifyField({ ...note, readOnly: true }, { configClass: 'HistoricalTextMethodConfig' });
    expect(locked.editability.ok).toBe(false);
    expect(locked.dated).toBeUndefined();
  });

  it('a historical list item never offers "Not set"; a plain one that allows blank does', async () => {
    const s = await schema();
    const f = s.fields.find(x => x.businessId === 'kind')!;
    const listSetRid = DEFINITIONS[DEF.kind].listSetRid;
    const hist = classifyField(f, { configClass: 'HistoricalListMethodConfig', listSetRid, allowBlank: true });
    expect(hist).toMatchObject({ kind: 'listItem', historical: true, dated: true, editability: { ok: true } });
    expect(hist.allowBlank).toBeUndefined();
    expect(classifyField(f, { configClass: 'ListMethodConfig', listSetRid, allowBlank: true }).allowBlank).toBe(true);
  });

  it('a custom field without its definition facts is read-only', async () => {
    const s = await schema();
    const f = s.fields.find(x => x.businessId === 'note')!;
    expect(classifyField(f, undefined).editability).toMatchObject({ ok: false, reason: 'unread-definition' });
    const k = s.fields.find(x => x.businessId === 'kind')!;
    expect(classifyField(k, { configClass: 'ListMethodConfig' }).editability).toMatchObject({ ok: false, reason: 'unread-definition' });
  });
});

describe('references: kind and editability', () => {
  const model = async (bid: 'owner' | 'regions', def: DefinitionFacts | undefined, opts: { listTooLong?: boolean; historicalWrites?: boolean } = {}) => {
    const s = await schema();
    return classifyField(s.fields.find(x => x.businessId === bid)!, def, opts);
  };

  it('a reference with an expression is editable on both definition classes; the Historical one is dated', async () => {
    const plain = await model('owner', { configClass: 'ReferenceMethodConfig', hasExpression: true });
    expect(plain).toMatchObject({ kind: 'principal', historical: false, editability: { ok: true } });
    expect(plain.dated).toBeUndefined();
    const dated = await model('owner', DEFINITIONS[DEF.owner]);
    expect(dated).toMatchObject({ kind: 'principal', historical: true, dated: true, editability: { ok: true } });
    const list = await model('regions', DEFINITIONS[DEF.regions]);
    expect(list).toMatchObject({ kind: 'referenceList', historical: true, dated: true, editability: { ok: true } });
    // Independent of the historical switch, either way.
    expect((await model('owner', DEFINITIONS[DEF.owner], { historicalWrites: true })).editability.ok).toBe(true);
    expect((await model('owner', DEFINITIONS[DEF.owner], { historicalWrites: false })).editability.ok).toBe(true);
  });

  it('a definition without an expression and no allowed types named stays read-only: its objects cannot be determined', async () => {
    expect((await model('owner', { configClass: 'ReferenceMethodConfig' })).editability)
      .toEqual({ ok: false, reason: 'by-type', text: 'Its allowed objects could not be determined' });
    expect((await model('regions', { configClass: 'HistoricalReferenceMethodConfig' })).editability).toMatchObject({ reason: 'by-type' });
  });

  it('another definition class, a multiselect that disagrees, or too many allowed objects is read-only', async () => {
    expect((await model('owner', { configClass: 'ReverseReferenceMethodConfig', hasExpression: true })).editability).toMatchObject({ reason: 'not-stored' });
    expect((await model('regions', { configClass: 'ReferenceMethodConfig', hasExpression: true, multiselect: false })).editability).toMatchObject({ reason: 'kind-mismatch' });
    expect((await model('owner', { configClass: 'ReferenceMethodConfig', hasExpression: true, multiselect: true })).editability).toMatchObject({ reason: 'kind-mismatch' });
    expect((await model('owner', DEFINITIONS[DEF.owner], { listTooLong: true })).editability).toMatchObject({ reason: 'list-too-long', text: REASON_TEXT['list-too-long'] });
  });

  it('"Not set": never for a historical single reference, a clear for a plain one that allows blank, LIST() unless forbidden', async () => {
    // Historical single, allowBlank true: no clear (it would remove its history).
    expect((await model('owner', DEFINITIONS[DEF.owner])).allowBlank).toBeUndefined();
    expect((await model('owner', { configClass: 'ReferenceMethodConfig', hasExpression: true, allowBlank: true })).allowBlank).toBe(true);
    expect((await model('owner', { configClass: 'ReferenceMethodConfig', hasExpression: true, allowBlank: false })).allowBlank).toBeUndefined();
    expect((await model('owner', { configClass: 'ReferenceMethodConfig', hasExpression: true, allowBlank: true, required: true })).allowBlank).toBeUndefined();
    // A list: always, unless allowBlank false or required true.
    expect((await model('regions', DEFINITIONS[DEF.regions])).allowBlank).toBe(true);
    expect((await model('regions', { ...DEFINITIONS[DEF.regions], allowBlank: false })).allowBlank).toBeUndefined();
    expect((await model('regions', { ...DEFINITIONS[DEF.regions], required: true })).allowBlank).toBeUndefined();
  });
});

describe('references by type: kind and editability', () => {
  const byType = async (over: Parameters<typeof withByType>[1] = {}) => {
    const s = withByType(await schema(), over);
    const f = s.fields.find(x => x.id === BY_TYPE_REF)!;
    return { f, def: s.definitions[BY_TYPE_REF], model: classifyField(f, s.definitions[BY_TYPE_REF]) };
  };

  it('is editable when the field description names valid types and nothing limits it further', async () => {
    const { f, def, model } = await byType();
    expect(f.referenceConstraints).toMatchObject({ allowedTypes: ['CeProcedure'], allowOnlyExactClass: true, advanced: false });
    expect(model).toMatchObject({ kind: 'reference', historical: false, allowBlank: true, editability: { ok: true } });
    expect(allowedSourceOf(f, def)).toEqual({ mode: 'by-type', types: ['CeProcedure'], exactClass: true });
    // Several types, each once; exact class off.
    const two = await byType({ constraints: { allowedTypes: ['CeProcedure', 'CeProcess', 'CeProcedure'], allowOnlyExactClass: false } });
    expect(two.model.editability.ok).toBe(true);
    expect(allowedSourceOf(two.f, two.def)).toEqual({ mode: 'by-type', types: ['CeProcedure', 'CeProcess'], exactClass: false });
  });

  it('selection roots, a filter, no types or an invalid type name keep it read-only, each with its reason', async () => {
    const roots = REASON_TEXT['selection-roots'];
    expect(roots).toBe('Limited to selection roots: editing comes in a later version');
    expect((await byType({ def: { hasSelectionRoots: true } })).model.editability).toEqual({ ok: false, reason: 'selection-roots', text: roots });
    expect((await byType({ constraints: { selectionRoots: '[Enterprise procedure]' } })).model.editability).toMatchObject({ reason: 'selection-roots' });
    expect((await byType({ def: { filtered: true } })).model.editability)
      .toEqual({ ok: false, reason: 'filtered', text: 'Limited by a filter: editing comes in a later version' });
    expect((await byType({ constraints: { allowedTypes: [] } })).model.editability)
      .toEqual({ ok: false, reason: 'by-type', text: 'Its allowed objects could not be determined' });
    for (const bad of ['Ce Procedure', '1Ce', 'CeProcedure; x', 'a'.repeat(65)]) {
      const r = await byType({ constraints: { allowedTypes: ['CeProcess', bad] } });
      expect(r.model.editability, bad).toMatchObject({ reason: 'by-type' });
      expect(allowedSourceOf(r.f, r.def)).toBeUndefined();
    }
    // Roots win over a filter, a filter over missing types.
    expect((await byType({ def: { hasSelectionRoots: true, filtered: true }, constraints: { allowedTypes: [] } })).model.editability).toMatchObject({ reason: 'selection-roots' });
    expect((await byType({ def: { filtered: true }, constraints: { allowedTypes: [] } })).model.editability).toMatchObject({ reason: 'filtered' });
  });

  it('a kind mismatch still wins, and the usual conditions still apply', async () => {
    expect((await byType({ def: { multiselect: true, hasSelectionRoots: true } })).model.editability).toMatchObject({ reason: 'kind-mismatch' });
    expect((await byType({ def: { configClass: 'ReverseReferenceMethodConfig' } })).model.editability).toMatchObject({ reason: 'not-stored' });
    const s = withByType(await schema());
    const f = s.fields.find(x => x.id === BY_TYPE_REF)!;
    expect(classifyField({ ...f, editable: false }, BY_TYPE_DEFINITION).editability).toMatchObject({ reason: 'read-only' });
    expect(classifyField({ ...f, customField: false }, BY_TYPE_DEFINITION).editability).toMatchObject({ reason: 'built-in' });
    expect(classifyField(f, BY_TYPE_DEFINITION, { listTooLong: true }).editability).toMatchObject({ reason: 'list-too-long' });
  });

  it('an advanced definition is unchanged: roots, a filter or types do not matter there', async () => {
    const adv = await byType({ def: { hasExpression: true, hasSelectionRoots: true, filtered: true }, constraints: { allowedTypes: [] } });
    expect(adv.model.editability.ok).toBe(true);
    expect(allowedSourceOf(adv.f, adv.def)).toEqual({ mode: 'advanced' });
    const s = await schema();
    expect(allowedSourceOf(s.fields.find(x => x.id === DEF.owner)!, DEFINITIONS[DEF.owner])).toEqual({ mode: 'advanced' });
  });

  it('"Not set" follows the same rules: the definition allowBlank first, then the field description one', async () => {
    expect((await byType()).model.allowBlank).toBe(true);
    expect((await byType({ def: { allowBlank: false } })).model.allowBlank).toBeUndefined();
    expect((await byType({ def: { allowBlank: undefined } })).model.allowBlank).toBe(true);
    expect((await byType({ def: { allowBlank: undefined }, constraints: { allowBlank: false } })).model.allowBlank).toBeUndefined();
    expect((await byType({ def: { required: true } })).model.allowBlank).toBeUndefined();
  });
});

describe('references: values', () => {
  const allowed = new Set(ALLOWED[DEF.regions].map(i => i.rid));
  const [a, b, c] = ALLOWED[DEF.regions].map(i => i.rid);

  it('encodes a single reference, a list in the order given, and an empty list', () => {
    expect(encodeCustomValue('reference', a, { items: allowed })).toEqual({ rhs: `lookup(${a})` });
    expect(encodeCustomValue('principal', a, { items: allowed, itemRef: r => `REF${r}` })).toEqual({ rhs: `REF${a}` });
    expect(encodeCustomValue('referenceList', `${c},${a}`, { items: allowed })).toEqual({ rhs: `LIST(lookup(${c}), lookup(${a}))` });
    expect(encodeCustomValue('referenceList', ABSENT, { items: allowed, allowBlank: true })).toEqual({ rhs: 'LIST()' });
    expect(encodeCustomValue('reference', ABSENT, { items: allowed, allowBlank: true })).toEqual({ clear: true });
  });

  it('refuses duplicates, more than one object for a single reference, non-RIDs, objects outside the set, and a forbidden clear', () => {
    expect(encodeCustomValue('referenceList', `${a},${b},${a}`, { items: allowed })).toEqual({ error: 'An object is in the list twice' });
    expect(encodeCustomValue('reference', `${a},${b}`, { items: allowed })).toEqual({ error: 'This property holds one object only' });
    expect(encodeCustomValue('referenceList', `${a},lookup(1)`, { items: allowed })).toEqual({ error: 'Not an object RID' });
    expect(encodeCustomValue('referenceList', `${a},`, { items: allowed })).toEqual({ error: 'Not an object RID' });
    expect(encodeCustomValue('reference', '', { items: allowed })).toEqual({ error: 'Not an object RID' });
    expect(encodeCustomValue('referenceList', `${a},${FOREIGN_OBJECT}`, { items: allowed })).toEqual({ error: NOT_ALLOWED_OBJECT });
    expect(encodeCustomValue('reference', a)).toEqual({ error: NOT_ALLOWED_OBJECT });
    expect(encodeCustomValue('reference', ABSENT, { items: allowed, historical: true })).toEqual({ error: DATED_NO_CLEAR });
    expect(encodeCustomValue('reference', ABSENT, { items: allowed })).toEqual({ error: 'This property cannot be left not set' });
    expect(encodeCustomValue('referenceList', ABSENT, { items: allowed })).toEqual({ error: 'This property cannot be left not set' });
    expect(encodeCustomValue('reference', a, { items: allowed, itemRef: () => undefined })).toEqual({ error: 'The object could not be resolved on this server' });
  });

  it('reads stored references; a list compares as a set, a single reference by RID', () => {
    const obj = { props: {}, references: { [DEF.regions]: [b, a], [DEF.owner]: [] as string[] } };
    expect(storedValue(obj, DEF.regions, 'referenceList')).toBe(`${b},${a}`);
    // An empty list and an absent key are both "not set".
    expect(storedValue(obj, DEF.owner, 'principal')).toBe(ABSENT);
    expect(storedValue({ props: {}, references: {} }, DEF.owner, 'principal')).toBe(ABSENT);
    expect(storedEquals('referenceList', `${a},${b}`, `${b},${a}`)).toBe(true);
    expect(storedEquals('referenceList', `${a},${b}`, a)).toBe(false);
    expect(storedEquals('referenceList', `${a},${b}`, `${a},${c}`)).toBe(false);
    expect(storedEquals('referenceList', ABSENT, ABSENT)).toBe(true);
    expect(storedEquals('referenceList', a, ABSENT)).toBe(false);
    expect(storedEquals('reference', a, a)).toBe(true);
    expect(storedEquals('principal', a, b)).toBe(false);
    expect(sameReferences(ABSENT, '')).toBe(true);
  });

  it('sizes a reference change with each object at its longer reference form', () => {
    const value = `${a},${b}`;
    const lookup = changeLine('_o', 'regions', `LIST(lookup(${a}), lookup(${b}))`).length;
    const unknown = changeLineSize({ accessor: 'regions', kind: 'referenceList', value });
    // Business IDs unknown: the upper estimate per object.
    expect(unknown).toBeGreaterThan(lookup + 600);
    // Known: the pre-lookup form, longer than lookup(), shorter than the estimate.
    const known = changeLineSize({ accessor: 'regions', kind: 'referenceList', value }, () => '110');
    expect(known).toBeGreaterThan(lookup);
    expect(known).toBeLessThan(unknown);
    expect(changeLineSize({ accessor: 'owner', kind: 'reference', value: ABSENT })).toBe('_o.clear(owner)'.length);
    expect(changeLineSize({ accessor: 'regions', kind: 'referenceList', value: ABSENT })).toBe('_o.change(regions := LIST())'.length);
  });
});

describe('grouping', () => {
  it('one section per category in sortIndex order of its first property; misc and empty are Other', async () => {
    const models = customModels(await schema());
    expect(models.every(m => m.custom)).toBe(true);
    const secs = customSections(models);
    expect(secs.map(s => s.title)).toEqual(['Identity', 'Other', 'Scoring']);
    expect(secs[0].rows.map(r => r.accessor)).toEqual(['note', 'kind']);
    expect(secs[1].rows.map(r => r.accessor)).toEqual(['regions', 'owner', 'enabled', 'review', 'body']);
    expect(categoryTitle('#L#defaultTypes.misc')).toBe('Other');
    expect(categoryTitle('  ')).toBe('Other');
    expect(categoryTitle('Ownership')).toBe('Ownership');
  });
});

describe('values', () => {
  it('reads stored values by kind, ABSENT when not set; list items from references', () => {
    const obj = {
      props: { [DEF.enabled]: { kind: 'boolean', text: 'true', bool: true }, [DEF.weight]: { kind: 'number', text: '2.5', num: 2.5 } },
      references: { [DEF.kind]: [ITEMS[0].rid] },
    };
    expect(storedValue(obj, DEF.enabled, 'boolean')).toBe('true');
    expect(storedValue(obj, DEF.weight, 'number')).toBe('2.5');
    expect(storedValue(obj, DEF.kind, 'listItem')).toBe(ITEMS[0].rid);
    expect(storedValue(obj, DEF.note, 'text')).toBe(ABSENT);
    expect(storedValue(obj, DEF.regions, 'listItem')).toBe(ABSENT);
  });

  it('compares by kind', () => {
    expect(storedEquals('number', '2.50', '2.5')).toBe(true);
    expect(storedEquals('number', '2', '3')).toBe(false);
    expect(storedEquals('boolean', 'true', 'true')).toBe(true);
    expect(storedEquals('listItem', ITEMS[0].rid, ITEMS[1].rid)).toBe(false);
    expect(storedEquals('text', '', ABSENT)).toBe(true);
    expect(storedEquals('listItem', ITEMS[0].rid, ABSENT)).toBe(false);
    expect(storedEquals('number', '0', ABSENT)).toBe(false);
    expect(storedEquals('multiline', 'a\r\nb', 'a\nb')).toBe(true);
  });

  it('parses numbers the user types: the plain form only, nothing guessed', () => {
    expect(parseNumberInput(' 12 ', false)).toEqual({ value: '12' });
    expect(parseNumberInput('007.50', false)).toEqual({ value: '7.5' });
    expect(parseNumberInput('2,5', false)).toEqual({ error: 'Use a point as the decimal separator, without grouping' });
    expect(parseNumberInput('1,234', false)).toEqual({ error: 'Use a point as the decimal separator, without grouping' });
    expect(parseNumberInput('1 2', false)).toEqual({ error: 'Not a number' });
    expect(parseNumberInput('.5', false)).toEqual({ error: 'Not a number' });
    expect(parseNumberInput('-.5', false)).toEqual({ error: 'Not a number' });
    expect(parseNumberInput('5.', false)).toEqual({ error: 'Not a number' });
    expect(parseNumberInput('abc', false)).toEqual({ error: 'Not a number' });
    expect(parseNumberInput('', false)).toEqual({ error: 'Enter a number' });
    expect(parseNumberInput('1e5', false)).toEqual({ error: 'Not a number' });
    expect(parseNumberInput('2.5', true)).toEqual({ error: 'Enter a whole number' });
    expect(parseNumberInput('-7', true)).toEqual({ value: '-7' });
    expect(parseNumberInput('-0', true)).toEqual({ value: '0' });
    expect(parseNumberInput('123456789012345678', true)).toEqual({ value: '123456789012345678' });
    expect(parseNumberInput('1234567890123456789', true)).toEqual({ error: 'Too many digits' });
  });

  it('compares numbers as decimals, never through a JS number', () => {
    expect(normalizeDecimal('-000.100')).toBe('-0.1');
    expect(normalizeDecimal('1e3')).toBeNull();
    // 18-digit integers differing in the last digit are different values.
    expect(storedEquals('number', '123456789012345678', '123456789012345679')).toBe(false);
    expect(storedEquals('number', '123456789012345678', '0123456789012345678.0')).toBe(true);
    // 0.1 + 0.2 style: 0.30000000000000004 is not 0.3.
    expect(storedEquals('number', '0.3', '0.30000000000000004')).toBe(false);
    expect(storedEquals('number', '0.3', '0.30')).toBe(true);
    // An edit of the last digit is staged, not dropped as "unchanged".
    expect(storedEquals('number', '900000000000000001', '900000000000000000')).toBe(false);
  });

  it('reads a stored number from its exact text, else from its numeric value', () => {
    const at = (text: string, num?: number) => storedValue({ props: { [DEF.weight]: { kind: 'number', text, ...(num !== undefined ? { num } : {}) } }, references: {} }, DEF.weight, 'number');
    expect(at('123456789012345678')).toBe('123456789012345678');
    expect(at('1,234.5', 1234.5)).toBe('1234.5');
    expect(at('1.5E-7', 1.5e-7)).toBe('0.00000015');
    expect(at('2.50', 2.5)).toBe('2.5');
  });

  it('encodes each kind with the guards, refusing what does not fit', () => {
    const items = new Set(ITEMS.map(i => i.rid));
    expect(encodeCustomValue('text', 'a "b" \\ c')).toEqual({ rhs: '"a \\"b\\" \\\\ c"' });
    expect(encodeCustomValue('text', 'two\nlines')).toEqual({ error: 'A single-line text cannot hold line breaks' });
    expect(encodeCustomValue('multiline', 'two\r\nlines')).toEqual({ rhs: '"two\\nlines"' });
    expect(encodeCustomValue('number', '12.5')).toEqual({ rhs: '12.5' });
    expect(encodeCustomValue('number', '1); _x := lookup(1')).toEqual({ error: 'Not a number' });
    expect(encodeCustomValue('number', '1.5', { integer: true })).toEqual({ error: 'Not a whole number' });
    expect(encodeCustomValue('boolean', 'true')).toEqual({ rhs: 'TRUE' });
    expect(encodeCustomValue('boolean', 'TRUE')).toEqual({ error: 'Not On or Off' });
    expect(encodeCustomValue('listItem', ITEMS[2].rid, { items })).toEqual({ rhs: `lookup(${ITEMS[2].rid})` });
    expect(encodeCustomValue('listItem', '123) OR (1', { items })).toEqual({ error: 'Not an item RID' });
    expect(encodeCustomValue('listItem', FOREIGN_ITEM, { items })).toEqual({ error: 'Not an item of this property’s list' });
    expect(encodeCustomValue('choice', 'B', { options: ['A', 'B'] })).toEqual({ rhs: '"B"' });
    expect(encodeCustomValue('choice', 'C', { options: ['A', 'B'] })).toEqual({ error: 'Not one of the allowed values' });
  });

  it('builds one change() per property; the historical form carries the date twice', () => {
    expect(changeLine('_o', 'note', '"x"')).toBe('_o.change(note := "x")');
    expect(() => changeLine('_o', 'a := 1, b', '"x"')).toThrow();
    expect(historicalChangeLine('_o', 'enabled', 'TRUE', '2026-11-01'))
      .toBe('_o.calculate(self.change(enabled := TRUE), date("2026-11-01"), date("2026-11-01"))');
    expect(() => historicalChangeLine('_o', 'enabled', 'TRUE', '1.11.2026')).toThrow();
  });

  it('every fixture definition is used', () => {
    expect(Object.keys(DEFINITIONS)).toHaveLength(Object.keys(DEF).length);
  });
});
