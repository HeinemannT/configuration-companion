/**
 * The objects a reference property allows for one object: the script (the
 * object as the command's context, the definition by reference, no
 * expression text), the parse with its cap, the batched client call, and
 * FETCH_ALLOWED_OBJECTS in the service worker.
 */
import { describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { framedText } from '../ec-parser';
import { LIST_ITEMS_MAX, type AllowedSource } from '../property-schema';
import {
  ALLOWED, BY_TYPE_ALLOWED, BY_TYPE_REF, DEF, DEFINITIONS, FOREIGN_OBJECT, ITEMS, LIST_SET, byTypeDefinitionProps, definitionProps, fields, withByType,
} from './fixtures/property-fields';

vi.mock('../code-index-service', () => ({ noteSavedObject: vi.fn(), clearCodeIndex: vi.fn() }));

const RID = '9007199254740993';
const ENV = 'p1@https://bmp.example/demo/';
const OW = 'chrome-extension://abcdef/objectview/window.html#1';
const FRAME = { senderKind: 'frame', senderTabId: 7, senderFrameId: 3, senderDocumentId: 'doc-a', senderUrl: OW };
const SENDER = { tabId: 7, frameId: 3, documentId: 'doc-a', url: OW };
const rows = (items: ReadonlyArray<{ rid: string; id: string; name: string }>) => items.map(i => [i.rid, i.id, i.name]);

describe('the allowed-objects script and its parse', () => {
  it('names the definition by reference and calculates its expression on the context object', async () => {
    mockChromeStorage();
    const { buildAllowedObjectsEc } = await import('../bmp-client');
    const code = buildAllowedObjectsEc(`lookup(${DEF.owner})`);
    expect(code).toContain('_o := this.object');
    expect(code).toContain(`_c := _o.calculate(lookup(${DEF.owner}).expression).first()`);
    expect(code).toContain(`IF _n <= ${LIST_ITEMS_MAX + 1} THEN`);
    // The same text for every object.
    expect(code).not.toContain(RID);
  });

  it('parses framed rows, cuts past the cap and says so; a damaged answer throws', async () => {
    mockChromeStorage();
    const { parseAllowedObjects } = await import('../bmp-client');
    expect(parseAllowedObjects(framedText(rows(ALLOWED[DEF.owner])))).toEqual({ items: ALLOWED[DEF.owner] });
    const many = Array.from({ length: LIST_ITEMS_MAX + 1 }, (_, i) => ({ rid: String(7600000000000000000n + BigInt(i)), id: `u${i}`, name: `User ${i}` }));
    const cut = parseAllowedObjects(framedText(rows(many)));
    expect(cut.tooMany).toBe(true);
    expect(cut.items).toHaveLength(LIST_ITEMS_MAX);
    expect(() => parseAllowedObjects(framedText(rows(ALLOWED[DEF.owner])).replace('~CREV_D~', ''))).toThrow();
    expect(() => parseAllowedObjects(framedText([['not-a-rid', 'x', 'y']]))).toThrow();
  });
});

describe('the by-type script', () => {
  it('one type, exact class: a literal SELECT cut to the cap, filtered by className; the same rows and cap', async () => {
    mockChromeStorage();
    const { buildAllowedByTypeEc } = await import('../bmp-client');
    const code = buildAllowedByTypeEc(['CeProcedure'], true);
    expect(code).toContain('_c := LIST()');
    expect(code).toContain('_t := SELECT CeProcedure');
    expect(code).toContain(`_c := _c.merge(_t.filter(className = "CeProcedure").first(${LIST_ITEMS_MAX + 1}))`);
    expect(code).toContain(`IF _n <= ${LIST_ITEMS_MAX + 1} THEN`);
    expect(code).toContain('_i.id.whenMissing("")');
    // No expression, no definition, no object in the text.
    expect(code).not.toMatch(/calculate|expression|lookup\(/);
    // The same text every time it is asked.
    expect(buildAllowedByTypeEc(['CeProcedure', 'CeProcedure'], true)).toBe(code);
  });

  it('several types: one SELECT each, joined without duplicates; exact class off is a plain SELECT', async () => {
    mockChromeStorage();
    const { buildAllowedByTypeEc } = await import('../bmp-client');
    const code = buildAllowedByTypeEc(['CeProcedure', 'CeProcess'], false);
    expect(code.match(/_t := SELECT \w+/g)).toEqual(['_t := SELECT CeProcedure', '_t := SELECT CeProcess']);
    const merge = `_c := _c.merge(_t.first(${LIST_ITEMS_MAX + 1}))`;
    expect(code.split('\n').filter(l => l.includes('.merge(')).map(l => l.trim())).toEqual([merge, merge]);
    expect(code).not.toContain('className');
    expect(buildAllowedByTypeEc(['CeProcedure', 'CeProcess'], true).match(/className = "\w+"/g)).toEqual(['className = "CeProcedure"', 'className = "CeProcess"']);
  });

  it('refuses no type or a name that is not a type name', async () => {
    mockChromeStorage();
    const { buildAllowedByTypeEc } = await import('../bmp-client');
    expect(() => buildAllowedByTypeEc([], true)).toThrow('No allowed types');
    for (const bad of ['Ce Procedure', 'X WHERE 1', '"x"', 'a'.repeat(65)]) expect(() => buildAllowedByTypeEc(['CeProcess', bad], true)).toThrow('Invalid type');
  });

  it('its answer is parsed by the same parser, with the same cap', async () => {
    mockChromeStorage();
    const { parseAllowedObjects } = await import('../bmp-client');
    expect(parseAllowedObjects(framedText(rows(BY_TYPE_ALLOWED)))).toEqual({ items: BY_TYPE_ALLOWED });
    const many = Array.from({ length: LIST_ITEMS_MAX + 1 }, (_, i) => ({ rid: String(7700000000000000000n + BigInt(i)), id: `p${i}`, name: `Procedure ${i}` }));
    const cut = parseAllowedObjects(framedText(rows(many)));
    expect(cut.tooMany).toBe(true);
    expect(cut.items).toHaveLength(LIST_ITEMS_MAX);
  });
});

describe('BmpClient.readAllowedObjectSets', () => {
  it('reads every definition of one object in one post; a failed definition fails alone', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');
    const BAD = '7000000000000000099';
    client.resolveRefs = vi.fn(async (rids: readonly string[]) => new Map(rids.map(r => [r, `lookup(${r})`])));
    client.executeEcScriptsOn = vi.fn(async (codes: string[]) => codes.map(code => (code.includes(BAD)
      ? { ok: false, error: 'No expression' }
      : { ok: true, log: framedText(rows(code.includes(DEF.owner) ? ALLOWED[DEF.owner] : ALLOWED[DEF.regions])) })));
    const read = await client.readAllowedObjectSets(RID, [DEF.owner, DEF.regions, BAD, DEF.owner]);
    expect(client.executeEcScriptsOn).toHaveBeenCalledTimes(1);
    const [codes, objectRid] = client.executeEcScriptsOn.mock.calls[0] as [string[], string];
    expect(objectRid).toBe(RID);
    expect(codes).toHaveLength(3);
    expect(read.get(DEF.owner)).toEqual({ items: ALLOWED[DEF.owner] });
    expect(read.get(DEF.regions)).toEqual({ items: ALLOWED[DEF.regions] });
    expect(read.get(BAD)).toEqual(new Error('No expression'));
    // One definition: the same path.
    expect(await client.readAllowedObjects(RID, DEF.owner)).toEqual({ items: ALLOWED[DEF.owner] });
    await expect(client.readAllowedObjects(RID, BAD)).rejects.toThrow('No expression');
  });

  it('mixes an advanced and a by-type definition in one post; only the advanced one is resolved', async () => {
    mockChromeStorage();
    const { BmpClient, buildAllowedByTypeEc } = await import('../bmp-client');
    const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');
    client.resolveRefs = vi.fn(async (rids: readonly string[]) => new Map(rids.map(r => [r, `lookup(${r})`])));
    client.executeEcScriptsOn = vi.fn(async (codes: string[]) => codes.map(code => ({
      ok: true, log: framedText(rows(code.includes('SELECT CeProcedure') ? BY_TYPE_ALLOWED : ALLOWED[DEF.owner])),
    })));
    const sources = new Map<string, AllowedSource>([[BY_TYPE_REF, { mode: 'by-type', types: ['CeProcedure'], exactClass: true }], [DEF.owner, { mode: 'advanced' }]]);
    const read = await client.readAllowedObjectSets(RID, [DEF.owner, BY_TYPE_REF], undefined, sources);
    expect(client.resolveRefs).toHaveBeenCalledTimes(1);
    expect(client.resolveRefs.mock.calls[0][0]).toEqual([DEF.owner]);
    expect(client.executeEcScriptsOn).toHaveBeenCalledTimes(1);
    const [codes, objectRid] = client.executeEcScriptsOn.mock.calls[0] as [string[], string];
    expect(objectRid).toBe(RID);
    expect(codes).toEqual([expect.stringContaining(`_o.calculate(lookup(${DEF.owner}).expression)`), buildAllowedByTypeEc(['CeProcedure'], true)]);
    expect(read.get(DEF.owner)).toEqual({ items: ALLOWED[DEF.owner] });
    expect(read.get(BY_TYPE_REF)).toEqual({ items: BY_TYPE_ALLOWED });
    // By type alone: no resolution at all; the single read takes the source too.
    client.resolveRefs.mockClear();
    expect(await client.readAllowedObjects(RID, BY_TYPE_REF, undefined, sources.get(BY_TYPE_REF))).toEqual({ items: BY_TYPE_ALLOWED });
    expect(client.resolveRefs).not.toHaveBeenCalled();
    // A bad type name fails its own definition only, before any post.
    client.executeEcScriptsOn.mockClear();
    const bad = await client.readAllowedObjectSets(RID, [BY_TYPE_REF], undefined, new Map([[BY_TYPE_REF, { mode: 'by-type', types: ['x y'], exactClass: true }]]));
    expect(bad.get(BY_TYPE_REF)).toBeInstanceOf(Error);
    expect(client.executeEcScriptsOn).not.toHaveBeenCalled();
  });

  it('an older server: the definition in its pre-lookup form; one it cannot resolve is not read', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');
    client.resolveRefs = vi.fn(async () => new Map<string, string | Error>([[DEF.owner, 'cfg.get("owner_def")'], [DEF.regions, new Error('not found')]]));
    client.executeEcScriptsOn = vi.fn(async (codes: string[]) => codes.map(() => ({ ok: true, log: framedText([]) })));
    const read = await client.readAllowedObjectSets(RID, [DEF.owner, DEF.regions]);
    expect(client.executeEcScriptsOn.mock.calls[0][0]).toEqual([expect.stringContaining('_o.calculate(cfg.get("owner_def").expression)')]);
    expect(read.get(DEF.owner)).toEqual({ items: [] });
    expect(read.get(DEF.regions)).toEqual(new Error('not found'));
    await expect(client.readAllowedObjectSets('1; x', [DEF.owner])).rejects.toThrow();
  });
});

describe('FETCH_ALLOWED_OBJECTS', () => {
  async function harness(byTypeProps: Record<string, string> = {}, references: Record<string, string[]> = {}) {
    vi.resetModules();
    mockChromeStorage();
    const client = {
      serverUrl: 'https://bmp.example/demo/', sessionEpoch: 1,
      // The fixture's fields plus a reference by type.
      fetchTypeFieldDescriptions: vi.fn(async () => withByType({ type: 'CeProcess', fields: await fields(), definitions: {}, listItems: {} }).fields),
      readFullObjects: vi.fn(async (rids: readonly string[]) => ({
        objects: Object.fromEntries(rids.flatMap(r => {
          if (r === RID) return [[r, { rid: r, type: 'CeProcess', name: 'Sample', businessId: 's1', props: {}, references: references as Record<string, string[] | undefined>, overridden: [] }]];
          if (r === BY_TYPE_REF) return [[r, { rid: r, type: 'ReferenceMethodConfig', name: '', businessId: '', props: byTypeDefinitionProps(byTypeProps), overridden: [], references: {} }]];
          return DEFINITIONS[r] ? [[r, {
            rid: r, type: DEFINITIONS[r].configClass, name: '', businessId: '', props: definitionProps(r), overridden: [],
            references: DEFINITIONS[r].listSetRid ? { listPropertySet: [LIST_SET] } : {},
          }]] : [];
        })),
        errors: {},
      })),
      readListItems: vi.fn(async () => ITEMS),
      resolveRefs: vi.fn(async (rids: readonly string[]) => new Map<string, string | Error>(rids.map(r => [r, `lookup(${r})`]))),
      readAllowedObjects: vi.fn(async (_rid: string, def: string, _signal?: AbortSignal, _source?: AllowedSource) => ({ items: def === BY_TYPE_REF ? BY_TYPE_ALLOWED : ALLOWED[def] ?? [] })),
      readAllowedObjectSets: vi.fn(async (_rid: string, defs: readonly string[], _signal?: AbortSignal, _sources?: ReadonlyMap<string, AllowedSource>) =>
        new Map(defs.map(d => [d, { items: d === BY_TYPE_REF ? BY_TYPE_ALLOWED : ALLOWED[d] ?? [] }]))),
      applyCustomChanges: vi.fn(async (_rid: string, _lines: readonly string[]) => ({ ok: true })),
    };
    const ctx: any = { client, settings: { activeProfileId: 'p1' }, cache: { get: vi.fn(() => null) }, logActivity: vi.fn(), toast: vi.fn() };
    const { setSwContext } = await import('../sw-context');
    const { getHandler } = await import('../handler-registry');
    const trust = await import('../sender-trust');
    setSwContext(ctx);
    await import('../handlers/custom-properties');
    const send = async (msg: Record<string, unknown>, meta: Record<string, unknown> = FRAME) => {
      const respond = vi.fn();
      await getHandler('FETCH_ALLOWED_OBJECTS')!({ type: 'FETCH_ALLOWED_OBJECTS', rid: RID, className: 'CeProcess', environment: ENV, ...msg } as any, respond, { isOneShot: true, ...meta } as any);
      return respond.mock.calls[0][0];
    };
    const apply = async (changes: unknown[]) => {
      const respond = vi.fn();
      await getHandler('APPLY_CUSTOM_CHANGES')!({ type: 'APPLY_CUSTOM_CHANGES', rid: RID, environment: ENV, changes } as any, respond, { isOneShot: true, ...FRAME } as any);
      return respond.mock.calls[0][0];
    };
    return { client, send, apply, trust };
  }

  it('reads the allowed objects of an editable reference of an object the window opened', async () => {
    const h = await harness();
    await h.trust.noteFrameServed(SENDER, ENV, [RID]);
    expect(await h.send({ definition: DEF.owner })).toEqual({
      type: 'ALLOWED_OBJECTS_RESULT', rid: RID, definition: DEF.owner, ok: true, items: ALLOWED[DEF.owner], environment: ENV,
    });
    h.client.readAllowedObjects.mockResolvedValueOnce({ items: ALLOWED[DEF.regions], tooMany: true } as never);
    expect(await h.send({ definition: DEF.regions })).toMatchObject({ ok: true, tooMany: true });
  });

  it('refuses another property kind, a page, a frame that did not open the object, and a bad RID; nothing is read', async () => {
    const h = await harness();
    await h.trust.noteFrameServed(SENDER, ENV, [RID]);
    expect(await h.send({ definition: DEF.note })).toMatchObject({ ok: false, error: 'Not an editable reference property of this type.' });
    expect(await h.send({ definition: DEF.owner }, { ...FRAME, senderKind: 'content' })).toMatchObject({ ok: false });
    expect(await h.send({ definition: DEF.owner, rid: '7000000000000000098' })).toMatchObject({ ok: false });
    expect(await h.send({ definition: DEF.owner, rid: '1) OR (1' })).toMatchObject({ ok: false });
    expect(await h.send({ definition: DEF.owner, className: 'x; y' })).toMatchObject({ ok: false, error: 'Invalid type name' });
    expect(h.client.readAllowedObjects).not.toHaveBeenCalled();
  });

  it('a reference by type: read by its type names from the schema; the window sends only the definition', async () => {
    const h = await harness();
    await h.trust.noteFrameServed(SENDER, ENV, [RID]);
    expect(await h.send({ definition: BY_TYPE_REF })).toMatchObject({ ok: true, items: BY_TYPE_ALLOWED });
    expect(h.client.readAllowedObjects).toHaveBeenLastCalledWith(RID, BY_TYPE_REF, undefined, { mode: 'by-type', types: ['CeProcedure'], exactClass: true });
    // The advanced one names its mode too.
    await h.send({ definition: DEF.owner });
    expect(h.client.readAllowedObjects).toHaveBeenLastCalledWith(RID, DEF.owner, undefined, { mode: 'advanced' });
  });

  it('a reference by type with selection roots or a filter is not read', async () => {
    for (const props of [{ selectionRoots: '[Enterprise procedure]' }, { filtered: 'true' }] as Array<Record<string, string>>) {
      const h = await harness(props);
      await h.trust.noteFrameServed(SENDER, ENV, [RID]);
      expect(await h.send({ definition: BY_TYPE_REF })).toMatchObject({ ok: false, error: 'Not an editable reference property of this type.' });
      expect(h.client.readAllowedObjects).not.toHaveBeenCalled();
    }
  });

  it('a write mixing both modes reads all sets in one post and refuses an object outside the by-type set', async () => {
    const h = await harness();
    await h.trust.noteFrameServed(SENDER, ENV, [RID]);
    const owner = { definition: DEF.owner, accessor: 'owner', kind: 'principal', value: ALLOWED[DEF.owner][1].rid };
    const procedure = (value: string) => ({ definition: BY_TYPE_REF, accessor: 'procedure', kind: 'reference', value });
    expect(await h.apply([owner, procedure(BY_TYPE_ALLOWED[0].rid)])).toMatchObject({ ok: true });
    expect(h.client.readAllowedObjectSets).toHaveBeenCalledTimes(1);
    expect(h.client.readAllowedObjectSets).toHaveBeenCalledWith(RID, [DEF.owner, BY_TYPE_REF], undefined, new Map<string, AllowedSource>([
      [DEF.owner, { mode: 'advanced' }],
      [BY_TYPE_REF, { mode: 'by-type', types: ['CeProcedure'], exactClass: true }],
    ]));
    expect(h.client.applyCustomChanges).toHaveBeenCalledWith(RID, [
      `_o.change(owner := lookup(${ALLOWED[DEF.owner][1].rid}))`,
      `_o.change(procedure := lookup(${BY_TYPE_ALLOWED[0].rid}))`,
    ]);
    h.client.applyCustomChanges.mockClear();
    expect(await h.apply([procedure(FOREIGN_OBJECT)])).toMatchObject({
      ok: false, notSent: true, refused: [{ definition: BY_TYPE_REF, reason: 'Not one of the objects this property allows' }],
    });
    expect(h.client.applyCustomChanges).not.toHaveBeenCalled();
  });

  it('a list write passes what the object holds now to the gate and resolves a kept object', async () => {
    const [a] = ALLOWED[DEF.regions].map(i => i.rid);
    const h = await harness({}, { [DEF.regions]: [FOREIGN_OBJECT] });
    await h.trust.noteFrameServed(SENDER, ENV, [RID]);
    const regions = { definition: DEF.regions, accessor: 'regions', kind: 'referenceList', value: `${FOREIGN_OBJECT},${a}` };
    expect(await h.apply([regions])).toMatchObject({ ok: true });
    expect(h.client.resolveRefs).toHaveBeenCalledWith([FOREIGN_OBJECT, a]);
    expect(h.client.applyCustomChanges).toHaveBeenCalledWith(RID, [`_o.change(regions := LIST(lookup(${FOREIGN_OBJECT}), lookup(${a})))`]);
    // An object it does not hold is still refused and not resolved.
    h.client.resolveRefs.mockClear();
    h.client.applyCustomChanges.mockClear();
    const other = '7599999999999999998';
    expect(await h.apply([{ ...regions, value: `${FOREIGN_OBJECT},${other}` }])).toMatchObject({
      ok: false, refused: [{ definition: DEF.regions, reason: 'Not one of the objects this property allows' }],
    });
    expect(h.client.resolveRefs).toHaveBeenCalledWith([FOREIGN_OBJECT]);
    expect(h.client.applyCustomChanges).not.toHaveBeenCalled();
  });
});
