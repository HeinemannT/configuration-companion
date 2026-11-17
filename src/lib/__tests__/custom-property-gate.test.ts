import { describe, expect, it, vi } from 'vitest';
import {
  allowedSources, checkCustomChanges, editableReferenceSource, forgetSchemas, isEditableReference, readTypeSchema, referenceDefinitions, typeSchema, type SchemaClient,
} from '../custom-property-gate';
import {
  ALLOWED, BY_TYPE_ALLOWED, BY_TYPE_REF, DEF, DEFINITIONS, FOREIGN_ITEM, FOREIGN_OBJECT, ITEMS, LIST_SET,
  byTypeDefinitionProps, definitionProps, fields, schema, withByType,
} from './fixtures/property-fields';
import { ABSENT, type AllowedObjects, type CustomChange } from '../property-schema';

const change = (c: Partial<CustomChange> & Pick<CustomChange, 'definition'>): CustomChange => ({ accessor: '', kind: 'text', value: '', ...c });

describe('the gate', () => {
  it('builds exactly one change() per accepted property', async () => {
    const s = await schema();
    const r = checkCustomChanges(s, [
      change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'He said "hi"' }),
      change({ definition: DEF.weight, accessor: 'weight', kind: 'number', value: '-2.75' }),
      change({ definition: DEF.summary, accessor: 'summary', kind: 'multiline', value: 'a\nb\tc' }),
      change({ definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: ITEMS[1].rid }),
    ]);
    expect(r).toEqual({ ok: true, lines: [
      '_o.change(note := "He said \\"hi\\"")',
      '_o.change(weight := -2.75)',
      '_o.change(summary := "a\\nb\\tc")',
      `_o.change(kind := lookup(${ITEMS[1].rid}))`,
    ] });
  });

  const refused = async (c: CustomChange) => {
    const r = checkCustomChanges(await schema(), [c]);
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.refused[0].reason;
  };

  it('refuses every wrong shape', async () => {
    // Not custom (a built-in by name, and a built-in addressed as if custom).
    expect(await refused(change({ definition: 'showToolMenu', accessor: 'showToolMenu', kind: 'boolean', value: 'true' }))).toBe('Not a property definition RID.');
    // A definition the object's type does not have (another type's property).
    expect(await refused(change({ definition: '1234567890123456789', accessor: 'note', kind: 'text', value: 'x' }))).toBe('Not a property of CeProcess.');
    expect(await refused(change({ definition: DEF.score, accessor: 'score', kind: 'number', value: '1' }))).toBe('Calculated by Extended Code');
    expect(await refused(change({ definition: DEF.locked, accessor: 'locked', kind: 'text', value: 'x' }))).toBe('Read-only for this type');
    expect(await refused(change({ definition: DEF.secret, accessor: 'secret', kind: 'text', value: 'x' }))).toBe('Hidden for this type');
    // A historical property: right value, wrong kind.
    expect(await refused(change({ definition: DEF.enabled, accessor: 'enabled', kind: 'text', value: 'true' }))).toBe('The value kind does not match the property.');
    expect(await refused(change({ definition: DEF.owner, accessor: 'owner', kind: 'listItem', value: ITEMS[0].rid }))).toBe('The value kind does not match the property.');
    expect(await refused(change({ definition: DEF.review, accessor: 'review', kind: 'text', value: '2026-01-01' }))).toBe('Editing dates comes in a later version');
    // Accessor that does not match the definition (an injection attempt included).
    expect(await refused(change({ definition: DEF.note, accessor: 'weight', kind: 'text', value: 'x' }))).toBe('The accessor does not match the property definition.');
    expect(await refused(change({ definition: DEF.note, accessor: 'note := 1, x', kind: 'text', value: 'x' }))).toBe('The accessor does not match the property definition.');
    // Wrong kind of value for the property.
    expect(await refused(change({ definition: DEF.note, accessor: 'note', kind: 'number', value: '1' }))).toBe('The value kind does not match the property.');
    expect(await refused(change({ definition: DEF.weight, accessor: 'weight', kind: 'number', value: 'lookup(1)' }))).toBe('Not a number');
    expect(await refused(change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'a\nb' }))).toBe('A single-line text cannot hold line breaks');
    expect(await refused({ definition: DEF.note, accessor: 'note', kind: 'text', value: 5 as unknown as string })).toBe('The value is not text');
    // A list item of another set.
    expect(await refused(change({ definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: FOREIGN_ITEM }))).toBe('Not an item of this property’s list');
  });

  it('refuses the whole post when one change is refused, and twice the same property', async () => {
    const s = await schema();
    const r = checkCustomChanges(s, [
      change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'ok' }),
      change({ definition: DEF.score, accessor: 'score', kind: 'number', value: '1' }),
    ]);
    expect(r).toEqual({ ok: false, refused: [{ definition: DEF.score, reason: 'Calculated by Extended Code' }] });
    const twice = checkCustomChanges(s, [
      change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'a' }),
      change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'b' }),
    ]);
    expect(twice.ok).toBe(false);
    expect(checkCustomChanges(s, []).ok).toBe(false);
  });

  it('refuses an oversized post', async () => {
    const r = checkCustomChanges(await schema(), [change({ definition: DEF.summary, accessor: 'summary', kind: 'multiline', value: 'x'.repeat(30_000) })]);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.refused[0].reason).toMatch(/too large/);
  });

  it('writes a historical value with a plain change; with the switch off it is refused', async () => {
    const s = await schema();
    const c = change({ definition: DEF.enabled, accessor: 'enabled', kind: 'boolean', value: 'false' });
    const plain = { ok: true, lines: ['_o.change(enabled := FALSE)'] };
    expect(checkCustomChanges(s, [c])).toEqual(plain);
    expect(checkCustomChanges(s, [c], { historicalWrites: true })).toEqual(plain);
    // An effective date is accepted and not used: no dated form.
    expect(checkCustomChanges(s, [c], { historicalWrites: true, effectiveDate: '2026-11-12' })).toEqual(plain);
    expect(checkCustomChanges(s, [c], { historicalWrites: false })).toEqual({
      ok: false, refused: [{ definition: DEF.enabled, reason: 'Historical value: editing comes next' }],
    });
    expect(checkCustomChanges(s, [c], { historicalWrites: false, effectiveDate: '2026-11-12' }).ok).toBe(false);
  });

  it('a historical text, number, boolean and list item each produce a plain change line', async () => {
    const s = await schema();
    s.definitions = {
      ...s.definitions,
      [DEF.note]: { configClass: 'HistoricalTextMethodConfig' },
      [DEF.summary]: { configClass: 'HistoricalTextMethodConfig' },
      [DEF.weight]: { configClass: 'HistoricalNumberMethodConfig' },
      [DEF.kind]: { configClass: 'HistoricalListMethodConfig', listSetRid: LIST_SET, allowBlank: true },
    };
    const all = [
      change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'New' }),
      change({ definition: DEF.summary, accessor: 'summary', kind: 'multiline', value: 'a\nb' }),
      change({ definition: DEF.weight, accessor: 'weight', kind: 'number', value: '3.5' }),
      change({ definition: DEF.enabled, accessor: 'enabled', kind: 'boolean', value: 'true' }),
      change({ definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: ITEMS[2].rid }),
    ];
    expect(checkCustomChanges(s, all, { effectiveDate: '2026-11-12' })).toEqual({ ok: true, lines: [
      '_o.change(note := "New")',
      '_o.change(summary := "a\\nb")',
      '_o.change(weight := 3.5)',
      '_o.change(enabled := TRUE)',
      `_o.change(kind := lookup(${ITEMS[2].rid}))`,
    ] });
    // With the switch off every one of them is refused as historical.
    const off = checkCustomChanges(s, all, { historicalWrites: false });
    expect(off).toEqual({ ok: false, refused: all.map(c => ({ definition: c.definition, reason: 'Historical value: editing comes next' })) });
  });

  it('a historical list item is never cleared, although its definition allows blank', async () => {
    const s = await schema();
    const kind = (value: string) => change({ definition: DEF.kind, accessor: 'kind', kind: 'listItem', value });
    // The plain list item that allows blank: a clear.
    s.definitions = { ...s.definitions, [DEF.kind]: { configClass: 'ListMethodConfig', listSetRid: LIST_SET, allowBlank: true } };
    expect(checkCustomChanges(s, [kind(ABSENT)])).toEqual({ ok: true, lines: ['_o.clear(kind)'] });
    // The historical one: refused, nothing is written.
    s.definitions = { ...s.definitions, [DEF.kind]: { configClass: 'HistoricalListMethodConfig', listSetRid: LIST_SET, allowBlank: true } };
    expect(checkCustomChanges(s, [kind(ABSENT)])).toEqual({
      ok: false, refused: [{ definition: DEF.kind, reason: 'This property cannot be left not set' }],
    });
    expect(checkCustomChanges(s, [kind(ITEMS[0].rid)])).toEqual({ ok: true, lines: [`_o.change(kind := lookup(${ITEMS[0].rid}))`] });
  });
});

describe('the gate: references', () => {
  const [a, b, c] = ALLOWED[DEF.regions].map(i => i.rid);
  const [alice, bob] = ALLOWED[DEF.owner].map(i => i.rid);
  const allowed = new Map<string, AllowedObjects | Error>([[DEF.regions, { items: ALLOWED[DEF.regions] }], [DEF.owner, { items: ALLOWED[DEF.owner] }]]);
  const regions = (value: string) => change({ definition: DEF.regions, accessor: 'regions', kind: 'referenceList', value });
  const owner = (value: string) => change({ definition: DEF.owner, accessor: 'owner', kind: 'principal', value });

  it('writes a plain change (also on a Historical definition), a list in the order sent, and an empty list', async () => {
    const s = await schema();
    expect(checkCustomChanges(s, [regions(`${c},${a}`), owner(bob)], { allowed })).toEqual({ ok: true, lines: [
      `_o.change(regions := LIST(lookup(${c}), lookup(${a})))`,
      `_o.change(owner := lookup(${bob}))`,
    ] });
    expect(checkCustomChanges(s, [regions(ABSENT)], { allowed })).toEqual({ ok: true, lines: ['_o.change(regions := LIST())'] });
    // The historical switch does not change how references are written.
    expect(checkCustomChanges(s, [owner(alice)], { allowed, historicalWrites: true, effectiveDate: '2026-11-12' })).toEqual({ ok: true, lines: [`_o.change(owner := lookup(${alice}))`] });
    // The older server's reference form.
    expect(checkCustomChanges(s, [owner(alice)], { allowed, itemRef: r => `REF(${r})` })).toEqual({ ok: true, lines: [`_o.change(owner := REF(${alice}))`] });
  });

  it('"Not set" of a single reference: a clear only on a plain definition that allows blank', async () => {
    const s = await schema();
    expect(checkCustomChanges(s, [owner(ABSENT)], { allowed })).toEqual({
      ok: false, refused: [{ definition: DEF.owner, reason: 'A dated reference cannot be cleared here: clearing removes its history' }],
    });
    s.definitions = { ...s.definitions, [DEF.owner]: { configClass: 'ReferenceMethodConfig', hasExpression: true, allowBlank: true } };
    expect(checkCustomChanges(s, [owner(ABSENT)], { allowed })).toEqual({ ok: true, lines: ['_o.clear(owner)'] });
    s.definitions = { ...s.definitions, [DEF.regions]: { ...DEFINITIONS[DEF.regions], required: true } };
    expect(checkCustomChanges(s, [regions(ABSENT)], { allowed })).toEqual({
      ok: false, refused: [{ definition: DEF.regions, reason: 'This property cannot be left not set' }],
    });
  });

  it('refuses each bad reference with its own reason, never hiding the others', async () => {
    const s = await schema();
    const r = checkCustomChanges(s, [
      regions(`${a},${a}`),
      owner(`${alice},${bob}`),
      change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'ok' }),
    ], { allowed });
    expect(r).toEqual({ ok: false, refused: [
      { definition: DEF.regions, reason: 'An object is in the list twice' },
      { definition: DEF.owner, reason: 'This property holds one object only' },
    ] });
    const one = async (c: CustomChange, opts: Parameters<typeof checkCustomChanges>[2] = { allowed }) => {
      const res = checkCustomChanges(await schema(), [c], opts);
      return res.ok ? 'ok' : res.refused[0].reason;
    };
    expect(await one(regions(`${a},x`))).toBe('Not an object RID');
    expect(await one(regions(`${a},${FOREIGN_OBJECT}`))).toBe('Not one of the objects this property allows');
    // An object another reference property allows is still not this one's.
    expect(await one(owner(a))).toBe('Not one of the objects this property allows');
    // Kind and definition must match.
    expect(await one(change({ definition: DEF.owner, accessor: 'owner', kind: 'referenceList', value: alice }))).toBe('The value kind does not match the property.');
    expect(await one(change({ definition: DEF.regions, accessor: 'regions', kind: 'reference', value: a }))).toBe('The value kind does not match the property.');
    // The allowed objects: missing, failed, too many.
    expect(await one(owner(alice), {})).toBe('The objects this property allows could not be read.');
    expect(await one(owner(alice), { allowed: new Map([[DEF.owner, new Error('boom')]]) })).toBe('The objects this property allows could not be read: boom');
    expect(await one(owner(alice), { allowed: new Map([[DEF.owner, { items: ALLOWED[DEF.owner], tooMany: true }]]) })).toBe('The list is too long to choose from here');
    // A definition without an expression whose types are not named is refused before any read.
    const byType = await schema();
    byType.definitions = { ...byType.definitions, [DEF.owner]: { configClass: 'HistoricalReferenceMethodConfig' } };
    expect(checkCustomChanges(byType, [owner(alice)], { allowed })).toEqual({
      ok: false, refused: [{ definition: DEF.owner, reason: 'Its allowed objects could not be determined' }],
    });
    expect(referenceDefinitions(byType, [owner(alice), regions(a)])).toEqual([DEF.regions]);
  });

  it('a list may keep an object it holds that is no longer allowed; only added objects must be allowed', async () => {
    const s = await schema();
    const stored = new Map([[DEF.regions, [FOREIGN_OBJECT, a]]]);
    // Keeps the stored foreign object and adds an allowed one.
    expect(checkCustomChanges(s, [regions(`${FOREIGN_OBJECT},${a},${b}`)], { allowed, stored })).toEqual({ ok: true, lines: [
      `_o.change(regions := LIST(lookup(${FOREIGN_OBJECT}), lookup(${a}), lookup(${b})))`,
    ] });
    // A newly added object outside the set is still refused.
    const other = '7599999999999999998';
    expect(checkCustomChanges(s, [regions(`${FOREIGN_OBJECT},${other}`)], { allowed, stored })).toEqual({
      ok: false, refused: [{ definition: DEF.regions, reason: 'Not one of the objects this property allows' }],
    });
    // Without the stored map the kept object is refused, as before.
    expect(checkCustomChanges(s, [regions(`${FOREIGN_OBJECT},${a}`)], { allowed }).ok).toBe(false);
    // A single reference is unaffected: holding an object does not allow it.
    expect(checkCustomChanges(s, [owner(FOREIGN_OBJECT)], { allowed, stored: new Map([[DEF.owner, [FOREIGN_OBJECT]]]) })).toEqual({
      ok: false, refused: [{ definition: DEF.owner, reason: 'Not one of the objects this property allows' }],
    });
  });

  it('asks for the allowed objects of editable references sent with their own kind, each once', async () => {
    const s = await schema();
    expect(referenceDefinitions(s, [
      regions(a), regions(b), owner(alice),
      change({ definition: DEF.kind, accessor: 'kind', kind: 'reference', value: ITEMS[0].rid }),
      change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'x' }),
      change({ definition: 'constructor', accessor: 'x', kind: 'reference', value: a }),
    ])).toEqual([DEF.regions, DEF.owner]);
    expect(isEditableReference(s, DEF.owner)).toBe(true);
    expect(isEditableReference(s, DEF.kind)).toBe(false);
    expect(isEditableReference(s, '__proto__')).toBe(false);
  });
});

describe('the gate: references by type', () => {
  const procedure = (value: string) => change({ definition: BY_TYPE_REF, accessor: 'procedure', kind: 'reference', value });
  const [p1, p2] = BY_TYPE_ALLOWED.map(i => i.rid);

  it('writes an object of the by-type set and refuses one outside it with the same text', async () => {
    const s = withByType(await schema());
    const allowed = new Map<string, AllowedObjects | Error>([[BY_TYPE_REF, { items: BY_TYPE_ALLOWED }]]);
    expect(checkCustomChanges(s, [procedure(p2)], { allowed })).toEqual({ ok: true, lines: [`_o.change(procedure := lookup(${p2}))`] });
    expect(checkCustomChanges(s, [procedure(ABSENT)], { allowed })).toEqual({ ok: true, lines: ['_o.clear(procedure)'] });
    expect(checkCustomChanges(s, [procedure(FOREIGN_OBJECT)], { allowed })).toEqual({
      ok: false, refused: [{ definition: BY_TYPE_REF, reason: 'Not one of the objects this property allows' }],
    });
    // An object an advanced property allows is not in the by-type set.
    expect(checkCustomChanges(s, [procedure(ALLOWED[DEF.owner][0].rid)], { allowed }).ok).toBe(false);
    // No fresh set: refused, as for the advanced mode.
    expect(checkCustomChanges(s, [procedure(p1)])).toEqual({ ok: false, refused: [{ definition: BY_TYPE_REF, reason: 'The objects this property allows could not be read.' }] });
    expect(checkCustomChanges(s, [procedure(p1)], { allowed: new Map([[BY_TYPE_REF, { items: BY_TYPE_ALLOWED, tooMany: true }]]) }).ok).toBe(false);
  });

  it('asks for its set with the type names from the schema; a limited one is refused without a read', async () => {
    const s = withByType(await schema());
    const owner = change({ definition: DEF.owner, accessor: 'owner', kind: 'principal', value: ALLOWED[DEF.owner][0].rid });
    expect(referenceDefinitions(s, [owner, procedure(p1)])).toEqual([DEF.owner, BY_TYPE_REF]);
    expect(allowedSources(s, [DEF.owner, BY_TYPE_REF, DEF.note])).toEqual(new Map([
      [DEF.owner, { mode: 'advanced' }],
      [BY_TYPE_REF, { mode: 'by-type', types: ['CeProcedure'], exactClass: true }],
    ]));
    for (const over of [{ def: { hasSelectionRoots: true } }, { def: { filtered: true } }, { constraints: { allowedTypes: [] } }]) {
      const limited = withByType(await schema(), over);
      expect(editableReferenceSource(limited, BY_TYPE_REF)).toBeUndefined();
      expect(referenceDefinitions(limited, [procedure(p1)])).toEqual([]);
      expect(checkCustomChanges(limited, [procedure(p1)], { allowed: new Map([[BY_TYPE_REF, { items: BY_TYPE_ALLOWED }]]) }).ok).toBe(false);
    }
  });
});

describe('the schema read', () => {
  const client = (epoch = 1) => {
    const c = {
      sessionEpoch: epoch,
      fetchTypeFieldDescriptions: vi.fn(async () => fields()),
      readFullObjects: vi.fn(async (rids: readonly string[]) => ({
        objects: Object.fromEntries(rids.filter(r => DEFINITIONS[r]).map(r => [r, {
          rid: r, type: DEFINITIONS[r].configClass, name: '', businessId: '', props: definitionProps(r), overridden: [],
          references: DEFINITIONS[r].listSetRid ? { listPropertySet: [DEFINITIONS[r].listSetRid!] } : {},
        }])),
        errors: {},
      })),
      readListItems: vi.fn(async (set: string) => (set === LIST_SET ? ITEMS : [])),
    };
    return c as typeof c & SchemaClient;
  };

  it('reads the description, the definition classes in one read, and the list items', async () => {
    const c = client();
    const s = await readTypeSchema(c, 'CeProcess');
    expect(c.readFullObjects).toHaveBeenCalledTimes(1);
    expect(s.definitions[DEF.enabled].configClass).toBe('HistoricalBooleanMethodConfig');
    expect(s.definitions[DEF.kind].listSetRid).toBe(LIST_SET);
    expect(s.listItems[DEF.kind]).toEqual(ITEMS);
    expect(c.readListItems).toHaveBeenCalledTimes(1);
    // Reference definitions: the facts that decide editability and "Not set";
    // the expression itself is not kept.
    expect(s.definitions[DEF.owner]).toEqual({ configClass: 'HistoricalReferenceMethodConfig', allowBlank: true, multiselect: false, hasExpression: true });
    expect(s.definitions[DEF.regions]).toEqual({ configClass: 'HistoricalReferenceMethodConfig', multiselect: true, hasExpression: true });
    await expect(readTypeSchema(c, 'x; y')).rejects.toThrow('Invalid type');
  });

  it('a by-type definition: roots and a filter from the definition read, the types from the field description', async () => {
    const read = async (props: Record<string, string>) => {
      const c = client();
      c.fetchTypeFieldDescriptions.mockImplementation(async () => withByType({ type: 'CeProcess', fields: await fields(), definitions: {}, listItems: {} }).fields);
      c.readFullObjects.mockImplementation(async (rids: readonly string[]) => ({
        objects: Object.fromEntries(rids.filter(r => r === BY_TYPE_REF).map(r => [r, {
          rid: r, type: 'ReferenceMethodConfig', name: '', businessId: '', props: byTypeDefinitionProps(props), overridden: [], references: {},
        }])),
        errors: {},
      }));
      const s = await readTypeSchema(c, 'CeProcess');
      return { def: s.definitions[BY_TYPE_REF], source: editableReferenceSource(s, BY_TYPE_REF) };
    };
    // As measured: types, expression and filter read as "", filtered false.
    expect(await read({})).toEqual({
      def: { configClass: 'ReferenceMethodConfig', allowBlank: true, multiselect: false },
      source: { mode: 'by-type', types: ['CeProcedure'], exactClass: true },
    });
    expect((await read({ selectionRoots: '[Enterprise procedure]' })).def).toMatchObject({ hasSelectionRoots: true });
    expect((await read({ selectionRoots: '[]' })).def.hasSelectionRoots).toBeUndefined();
    expect(await read({ filtered: 'true' })).toMatchObject({ def: { filtered: true }, source: undefined });
    expect((await read({ expression: 'root.portal.children()' })).source).toEqual({ mode: 'advanced' });
  });

  it('is cached per client for the session and dropped on a new session', async () => {
    const c = client();
    forgetSchemas(c);
    await typeSchema(c, 'CeProcess');
    await typeSchema(c, 'ceprocess');
    expect(c.fetchTypeFieldDescriptions).toHaveBeenCalledTimes(1);
    await typeSchema(c, 'CeProcess', { refresh: true });
    expect(c.fetchTypeFieldDescriptions).toHaveBeenCalledTimes(2);
    c.sessionEpoch = 2;
    await typeSchema(c, 'CeProcess');
    expect(c.fetchTypeFieldDescriptions).toHaveBeenCalledTimes(3);
    // Another profile's client has its own cache.
    const other = client();
    await typeSchema(other, 'CeProcess');
    expect(other.fetchTypeFieldDescriptions).toHaveBeenCalledTimes(1);
  });

  it('a definition that cannot be read leaves its rows read-only', async () => {
    const c = client();
    c.readFullObjects.mockRejectedValueOnce(new Error('read failed'));
    const s = await readTypeSchema(c, 'CeProcess');
    expect(s.unreadDefinitions?.[DEF.note]).toBe('read failed');
    const r = checkCustomChanges(s, [change({ definition: DEF.note, accessor: 'note', kind: 'text', value: 'x' })]);
    expect(r).toEqual({ ok: false, refused: [{ definition: DEF.note, reason: 'Its definition could not be read' }] });
  });
});
