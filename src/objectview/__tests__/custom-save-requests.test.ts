// @vitest-environment happy-dom
/**
 * Saving custom properties from the object window, end to end through the
 * service worker handlers: how many server posts a save costs, that the
 * read after the save comes from the server, that a refused text value
 * reaches its row, "Not set" for a list item that may be blank, how
 * unset, empty and white-space values read in the review and the conflict
 * dialog, and references (one object, a user, a list of objects): their
 * allowed objects, the set comparisons and the added/removed review.
 *
 * Posts are counted on a fake client at the cost each client method has on
 * the wire (bmp-client.ts): a full object read is one post per 25 objects
 * (the load governor's start value), the field description one post, one
 * list set one post (`readListItems`) or all sets one post
 * (`readListItemSets`), the allowed objects of one or several reference
 * properties of one object one post, the write one post, a list item or
 * object reference none (`lookup(<rid>)`), and naming a badge again one post.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ABSENT, DATED_NO_CLEAR, DATED_NOTE, type AllowedObjects, type FieldDescription, type ListItem, type TypePropertySchema } from '../../lib/property-schema';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ALLOWED_NOT_LOADED, ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import type { SaveOutcome, SaveStep } from '../window/save-plan';
import type { ReviewEntry } from '../window/review';
import { mockChromeStorage } from '../../lib/__tests__/chrome-mock';
import {
  ALLOWED, DEF, DEFINITIONS, FOREIGN_OBJECT, ITEMS, LIST_SET, definitionProps, fields as fixtureFields, schema as fixtureSchema,
} from '../../lib/__tests__/fixtures/property-fields';

const posts = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock('../../lib/enrichment', async importOriginal => ({
  ...(await importOriginal<typeof import('../../lib/enrichment')>()),
  // Naming the badge again is one post (enrichBadges).
  invalidateRid: vi.fn(async () => { posts.log.push('enrich'); }),
  incrementGeneration: vi.fn(),
}));
vi.mock('../../lib/code-index-service', () => ({ noteSavedObject: vi.fn(), clearCodeIndex: vi.fn() }));

const RID = '4000000000000000001';
const ENV = 'p1@https://bmp.example/demo/';
const OW = 'chrome-extension://abcdef/objectview/window.html#1';
const FRAME = { senderKind: 'frame', senderTabId: 7, senderFrameId: 3, senderDocumentId: 'doc-a', senderUrl: OW };
const SENDER = { tabId: 7, frameId: 3, documentId: 'doc-a', url: OW };
const t = (text: string): PropValue => ({ kind: 'text', text });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

// ── a type like the one of the live save test: 31 custom properties, 4 list sets ──

const EXTRA_TEXT = Array.from({ length: 19 }, (_, i) => String(7300000000000000000n + BigInt(i)));
const EXTRA_LIST = Array.from({ length: 3 }, (_, i) => String(7310000000000000000n + BigInt(i)));
const extraSet = (i: number) => String(7320000000000000000n + BigInt(i));

async function bigFields(): Promise<FieldDescription[]> {
  const base = await fixtureFields();
  const text = EXTRA_TEXT.map((id, i): FieldDescription => ({
    name: id, id, businessId: `extra_${i}`, displayName: `Extra ${i}`, category: 'Extra', sortIndex: 100 + i, type: 'String', customField: true, editable: true,
  }));
  const lists = EXTRA_LIST.map((id, i): FieldDescription => ({
    name: id, id, businessId: `pick_${i}`, displayName: `Pick ${i}`, category: 'Extra', sortIndex: 200 + i, type: 'ListPropertySetItem', customField: true, editable: true, choice: true, reference: true,
  }));
  return [...base, ...text, ...lists];
}
const definitionOf = (rid: string): { configClass: string; listSetRid?: string } | undefined => {
  if (DEFINITIONS[rid]) return DEFINITIONS[rid];
  if (EXTRA_TEXT.includes(rid)) return { configClass: 'TextMethodConfig' };
  const i = EXTRA_LIST.indexOf(rid);
  return i >= 0 ? { configClass: 'ListMethodConfig', listSetRid: extraSet(i) } : undefined;
};

// ── the fake server ──────────────────────────────────────────────────

function object(over: Partial<FullObject> = {}): FullObject {
  return {
    rid: RID, type: 'CeProcess', name: 'Sample process', businessId: '110',
    props: { name: t('Sample process'), [DEF.note]: t(''), [DEF.summary]: t('') },
    references: { [DEF.kind]: [ITEMS[0].rid], [DEF.regions]: [SUPPLIER], [DEF.owner]: [ALICE] }, overridden: [], ...over,
  };
}

const [CUSTOMER, SUPPLIER, PARTNER] = ALLOWED[DEF.regions].map(i => i.rid);
const [ALICE, BOB] = ALLOWED[DEF.owner].map(i => i.rid);

const ACCESSOR: Record<string, string> = { note: DEF.note, summary: DEF.summary, weight: DEF.weight, kind: DEF.kind, regions: DEF.regions, owner: DEF.owner };

/** Apply the gate's change lines to the stored object (the forms the gate builds). */
function applyLines(o: FullObject, lines: readonly string[]): FullObject {
  const next: FullObject = { ...o, props: { ...o.props }, references: { ...o.references } };
  for (const line of lines) {
    const clear = /^_o\.clear\((\w+)\)$/.exec(line);
    if (clear) { delete next.references[ACCESSOR[clear[1]]]; delete next.props[ACCESSOR[clear[1]]]; continue; }
    const m = /^_o\.change\((\w+) := (.*)\)$/.exec(line);
    if (!m) throw new Error(`unexpected line ${line}`);
    const def = ACCESSOR[m[1]];
    const rhs = m[2];
    const ref = /^lookup\((\d+)\)$/.exec(rhs);
    const list = /^LIST\((.*)\)$/.exec(rhs);
    if (ref) next.references[def] = [ref[1]];
    else if (list) next.references[def] = [...list[1].matchAll(/lookup\((\d+)\)/g)].map(x => x[1]);
    else if (rhs.startsWith('"')) next.props[def] = t(JSON.parse(rhs) as string);
    else next.props[def] = { kind: 'number', text: rhs, num: Number(rhs) };
  }
  return next;
}

async function harness(opts: { fields?: () => Promise<FieldDescription[]>; blank?: readonly string[]; stored?: FullObject; normalise?: (o: FullObject) => FullObject } = {}) {
  vi.resetModules();
  mockChromeStorage();
  posts.log.length = 0;
  const server = { obj: opts.stored ?? object(), allowed: { ...ALLOWED } as Record<string, ListItem[]> };
  const calls: string[] = [];
  const client = {
    serverUrl: 'https://bmp.example/demo/', sessionEpoch: 1,
    fetchTypeFieldDescriptions: vi.fn(async () => { posts.log.push('fields'); return (opts.fields ?? bigFields)(); }),
    readFullObjects: vi.fn(async (rids: readonly string[]) => {
      for (let i = 0; i < rids.length; i += 25) posts.log.push(rids.includes(RID) ? 'object' : 'definitions');
      calls.push(`read ${rids.includes(RID) ? 'object' : 'definitions'}`);
      const objects: Record<string, FullObject> = {};
      for (const r of rids) {
        if (r === RID) { objects[r] = structuredClone(server.obj); continue; }
        const d = definitionOf(r);
        const props: Record<string, PropValue> = { ...definitionProps(r), ...(opts.blank?.includes(r) ? { allowBlank: { kind: 'boolean', text: 'true', bool: true } } : {}) };
        if (d) objects[r] = { rid: r, type: d.configClass, name: '', businessId: '', props, overridden: [], references: d.listSetRid ? { listPropertySet: [d.listSetRid] } : {} };
      }
      return { objects, errors: {} };
    }),
    readListItems: vi.fn(async (set: string): Promise<ListItem[]> => { posts.log.push('list items'); return set === LIST_SET ? ITEMS : [{ rid: `${set.slice(0, -1)}9`, id: 'x', name: 'X' }]; }),
    readListItemSets: vi.fn(async (sets: readonly string[]) => {
      posts.log.push('list items');
      return new Map<string, ListItem[] | Error>(sets.map(s => [s, s === LIST_SET ? ITEMS : [{ rid: `${s.slice(0, -1)}9`, id: 'x', name: 'X' }]]));
    }),
    resolveRefs: vi.fn(async (rids: readonly string[]) => new Map<string, string | Error>(rids.map(r => [r, `lookup(${r})`]))),
    // The allowed objects: one post for one definition (the window's read)
    // or for all definitions of a write (the gate's read).
    readAllowedObjects: vi.fn(async (_rid: string, def: string): Promise<AllowedObjects> => {
      posts.log.push('allowed objects');
      return { items: server.allowed[def] ?? [] };
    }),
    readAllowedObjectSets: vi.fn(async (_rid: string, defs: readonly string[]) => {
      posts.log.push('allowed objects');
      calls.push('read allowed objects');
      return new Map<string, AllowedObjects | Error>(defs.map(d => [d, { items: server.allowed[d] ?? [] }]));
    }),
    applyCustomChanges: vi.fn(async (_rid: string, lines: readonly string[]) => {
      posts.log.push('write');
      calls.push('write');
      server.obj = (opts.normalise ?? (o => o))(applyLines(server.obj, lines));
      return { ok: true };
    }),
  };
  const ctx: any = { client, settings: { activeProfileId: 'p1' }, cache: { get: vi.fn(() => null), invalidate: vi.fn() }, logActivity: vi.fn(), toast: vi.fn() };
  const { setSwContext } = await import('../../lib/sw-context');
  const { getHandler } = await import('../../lib/handler-registry');
  const trust = await import('../../lib/sender-trust');
  setSwContext(ctx);
  await import('../../lib/handlers/custom-properties');
  await import('../../lib/handlers/object-window');
  const call = async <R,>(msg: Record<string, unknown>): Promise<R> => {
    const respond = vi.fn();
    await getHandler(msg.type as never)!(msg as never, respond, { isOneShot: true, ...FRAME } as never);
    return respond.mock.calls[0][0] as R;
  };
  // The window's data source as main.ts builds it, on the worker's handlers.
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async (): Promise<ObjectRootPayload> => {
      await trust.noteFrameServed(SENDER, ENV, [RID], { root: RID });
      return { rid: RID, root: structuredClone(server.obj), rows: null, nodes: {}, posts: 1, ms: 1 };
    }),
    readSummaries: vi.fn(async () => ({ summaries: [] })),
    fieldList: vi.fn(async () => []),
    propertySchema: async type => {
      const res = await call<{ ok: boolean; schema?: TypePropertySchema; error?: string }>({ type: 'FETCH_PROPERTY_SCHEMA', className: type, environment: ENV });
      if (!res.ok || !res.schema) throw new Error(res.error);
      return res.schema;
    },
    allowedObjects: async (rid, definition, type) => {
      const res = await call<{ ok: boolean; items?: ListItem[]; tooMany?: boolean; error?: string }>({ type: 'FETCH_ALLOWED_OBJECTS', rid, definition, className: type, environment: ENV });
      if (!res.ok || !res.items) throw new Error(res.error);
      return { items: res.items, ...(res.tooMany ? { tooMany: true } : {}) };
    },
    readObjects: async rids => {
      const res = await call<{ objects: Record<string, FullObject>; errors: Record<string, string> }>({ type: 'READ_FULL_OBJECTS', rids, environment: ENV });
      return { objects: res.objects, errors: res.errors };
    },
    run: async (step: SaveStep): Promise<SaveOutcome> => {
      if (step.route !== 'APPLY_CUSTOM_CHANGES') throw new Error('not a custom step');
      const res = await call<{ ok: boolean; error?: string; notSent?: boolean; refused?: Array<{ definition: string; reason: string }>; conflict?: SaveOutcome['conflict']; object?: FullObject }>({
        type: 'APPLY_CUSTOM_CHANGES', environment: ENV, rid: step.rid, changes: step.changes, ...(step.expect ? { expect: step.expect } : {}),
      });
      const propErrors: Record<string, string> = {};
      for (const r of res.refused ?? []) for (const c of step.changes) if (!r.definition || r.definition === c.definition) propErrors[c.definition] ??= r.reason;
      return {
        ok: res.ok, ...(res.error ? { error: res.error } : {}), ...(res.notSent ? { notSent: true } : {}),
        ...(Object.keys(propErrors).length ? { propErrors } : {}),
        ...(res.conflict?.length ? { conflict: res.conflict, ...(res.object ? { object: res.object } : {}) } : {}),
      };
    },
  };
  let reviewText = '';
  let reviewEntries: ReviewEntry[] = [];
  let conflictText = '';
  const controller = new ObjectWindowController({ update: () => {} }, src, {
    confirmSave: async r => { reviewText = r.body.map(n => n.textContent).join('\n'); reviewEntries = r.entries; return true; },
    resolveConflict: async c => { conflictText = c.body.map(n => n.textContent).join('\n'); return 'cancel'; },
    unknownRereadDelayMs: 0,
  });
  await controller.open(RID);
  controller.nodeSelected(server.obj);
  await flush();
  const note = () => (controller as unknown as { saveNote?: string }).saveNote ?? '';
  return { controller, client, server, calls, note, src, review: () => reviewText, entries: () => reviewEntries, conflict: () => conflictText };
}

/** Posts of one save. */
async function counted(h: Awaited<ReturnType<typeof harness>>, edit: () => void): Promise<string[]> {
  edit();
  posts.log.length = 0;
  h.calls.length = 0;
  await h.controller.save();
  return [...posts.log];
}

describe('posts per save (window has the object and its schema)', () => {
  it('one text change: the object read (gate and changed-since-opened check), the write, the read after it', async () => {
    const h = await harness();
    const log = await counted(h, () => h.controller.editCustom(RID, DEF.note, 'QA'));
    expect(log).toEqual(['object', 'write', 'object']);
    expect(h.note()).toBe('Saved 1 change');
  });

  it('two properties in one save: still three posts', async () => {
    const h = await harness();
    const log = await counted(h, () => { h.controller.editCustom(RID, DEF.note, 'Two A'); h.controller.editCustom(RID, DEF.kind, ITEMS[1].rid); });
    expect(log).toEqual(['object', 'write', 'object']);
    expect(h.client.applyCustomChanges).toHaveBeenCalledWith(RID, ['_o.change(note := "Two A")', `_o.change(kind := lookup(${ITEMS[1].rid}))`]);
    expect(h.note()).toBe('Saved 2 changes');
  });

  it('a second save from the same window: three posts again (the schema of this session is reused)', async () => {
    const h = await harness();
    await counted(h, () => h.controller.editCustom(RID, DEF.note, ' QA2'));
    const log = await counted(h, () => h.controller.editCustom(RID, DEF.note, ' QA3'));
    expect(log).toEqual(['object', 'write', 'object']);
    expect(h.server.obj.props[DEF.note].text).toBe(' QA3');
    expect(h.client.fetchTypeFieldDescriptions).toHaveBeenCalledTimes(1);
  });

  it('a schema read longer ago than the gate allows is read again before the write (all list sets in one post)', async () => {
    const h = await harness();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    try {
      const log = await counted(h, () => h.controller.editCustom(RID, DEF.note, 'QA'));
      expect(log).toEqual(['object', 'fields', 'definitions', 'definitions', 'list items', 'write', 'object']);
    } finally { spy.mockRestore(); }
  });

  it('changed in BMP since opened: the object read only; nothing is written; Review needs no read of its own', async () => {
    const h = await harness();
    h.controller.editCustom(RID, DEF.note, 'from B');
    h.server.obj = object({ props: { ...object().props, [DEF.note]: t('from A') } });
    posts.log.length = 0;
    await h.controller.save();
    expect(posts.log).toEqual(['object']);
    expect(h.client.applyCustomChanges).not.toHaveBeenCalled();
    expect(h.conflict()).toContain('opened Not set');
    expect(h.conflict()).toContain('in BMP now from A · yours from B');
    expect(h.controller.dirtyCount).toBe(1);
  });
});

describe('the read after a save comes from the server', () => {
  it('is sent after the write, and the row compares with what the server answers, not with what was sent', async () => {
    // The server stores the text without its trailing space.
    const h = await harness({ normalise: o => ({ ...o, props: { ...o.props, [DEF.note]: t(o.props[DEF.note].text.trimEnd()) } }) });
    // The window has read this object through the same route before the
    // save (a node selected in full): that answer must not come back.
    await h.src.readObjects([RID]);
    await counted(h, () => h.controller.editCustom(RID, DEF.note, 'QA '));
    expect(h.calls).toEqual(['read object', 'write', 'read object']);
    expect(h.note()).toBe('Not stored as sent: Note (note): "QA"');
    expect(h.controller.dirtyCount).toBe(1);
  });

  it('READ_FULL_OBJECTS has no cache and joins no other read: every request is a server read', async () => {
    const h = await harness();
    const { getHandler } = await import('../../lib/handler-registry');
    const read = () => getHandler('READ_FULL_OBJECTS')!({ type: 'READ_FULL_OBJECTS', rids: [RID], environment: ENV } as never, vi.fn(), { isOneShot: true, ...FRAME } as never);
    h.client.readFullObjects.mockClear();
    await Promise.all([read(), read()]);
    await read();
    expect(h.client.readFullObjects).toHaveBeenCalledTimes(3);
  });
});

describe('"Not set" for a list item that may be blank', () => {
  it('is written as a clear and counts as saved only when the read after it holds no item', async () => {
    const h = await harness({ blank: [DEF.kind] });
    expect(h.controller.editCustom(RID, DEF.kind, ABSENT)).toBeUndefined();
    posts.log.length = 0;
    await h.controller.save();
    expect(h.review()).toContain('First→Not set');
    expect(h.client.applyCustomChanges).toHaveBeenCalledWith(RID, ['_o.clear(kind)']);
    expect(posts.log).toEqual(['object', 'write', 'object']);
    expect(h.note()).toBe('Saved 1 change');
  });

  it('a clear the server does not take is "not stored as sent", never saved', async () => {
    const h = await harness({ blank: [DEF.kind], normalise: o => ({ ...o, references: { ...o.references, [DEF.kind]: [ITEMS[0].rid] } }) });
    h.controller.editCustom(RID, DEF.kind, ABSENT);
    await h.controller.save();
    expect(h.note()).toBe('Not stored as sent: Kind (kind): "First"');
    expect(h.controller.dirtyCount).toBe(1);
  });

  it('where the field does not allow blank, "Not set" is refused in the window and in the worker', async () => {
    const h = await harness();
    expect(h.controller.editCustom(RID, DEF.kind, ABSENT)).toBe('This property cannot be left not set');
    const { checkCustomChanges } = await import('../../lib/custom-property-gate');
    const s = await fixtureSchema();
    expect(checkCustomChanges(s, [{ definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: ABSENT }])).toEqual({
      ok: false, refused: [{ definition: DEF.kind, reason: 'This property cannot be left not set' }],
    });
    s.definitions = { ...s.definitions, [DEF.kind]: { ...s.definitions[DEF.kind], allowBlank: true } };
    expect(checkCustomChanges(s, [{ definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: ABSENT }])).toEqual({ ok: true, lines: ['_o.clear(kind)'] });
  });
});

describe('unset, empty and white space in words', () => {
  it('an empty text reads "Not set" in the review; leading or trailing white space is quoted', async () => {
    const h = await harness();
    h.controller.editCustom(RID, DEF.note, ' QA');
    await h.controller.save();
    expect(h.review()).toContain('Not set→" QA"');
    expect(h.review()).not.toContain('Empty');
  });

  it('the conflict dialog quotes them too', async () => {
    const h = await harness();
    h.controller.editCustom(RID, DEF.note, 'mine ');
    h.server.obj = object({ props: { ...object().props, [DEF.note]: t(' from A') } });
    await h.controller.save();
    expect(h.conflict()).toContain('opened Not set');
    expect(h.conflict()).toContain('in BMP now " from A" · yours "mine "');
  });
});

// ── references ──────────────────────────────────────────────────────

describe('references: allowed objects, staging, posts', () => {
  /** A harness with the allowed objects of both reference rows loaded. */
  async function loaded(opts: Parameters<typeof harness>[0] = {}) {
    const h = await harness(opts);
    h.controller.loadAllowed(RID, DEF.regions);
    h.controller.loadAllowed(RID, DEF.owner);
    await flush();
    return h;
  }

  it('nothing is staged before the allowed objects are read; the row says loading, then done', async () => {
    const h = await harness();
    expect(h.controller.editReferences(RID, DEF.regions, [CUSTOMER])).toBe(ALLOWED_NOT_LOADED);
    expect(h.controller.referenceRow(RID, DEF.regions)?.editability).toMatchObject({ ok: false, text: ALLOWED_NOT_LOADED });
    h.controller.loadAllowed(RID, DEF.regions);
    expect(h.controller.allowedFor(RID, DEF.regions)).toEqual({ phase: 'loading' });
    await flush();
    expect(h.controller.allowedFor(RID, DEF.regions)).toEqual({ phase: 'done', items: ALLOWED[DEF.regions] });
    // Read once per window: asking again sends nothing.
    posts.log.length = 0;
    h.controller.loadAllowed(RID, DEF.regions);
    await flush();
    expect(posts.log).toEqual([]);
    const row = h.controller.referenceRow(RID, DEF.regions)!;
    expect(row).toMatchObject({ kind: 'referenceList', editability: { ok: true }, value: SUPPLIER, outside: [], mayBeEmpty: true, dated: true });
    expect(row.selected).toEqual([{ rid: SUPPLIER, name: 'Supplier onboarding', id: '108', known: true }]);
  });

  it('a failed or too long read leaves the row read-only and says why', async () => {
    const h = await harness();
    h.client.readAllowedObjects.mockRejectedValueOnce(new Error('Expression failed'));
    h.controller.loadAllowed(RID, DEF.owner);
    await flush();
    expect(h.controller.allowedFor(RID, DEF.owner)).toEqual({ phase: 'error', error: 'Expression failed' });
    expect(h.controller.referenceRow(RID, DEF.owner)?.editability).toMatchObject({ ok: false, text: 'Expression failed' });
    h.client.readAllowedObjects.mockResolvedValueOnce({ items: ALLOWED[DEF.owner], tooMany: true });
    h.controller.loadAllowed(RID, DEF.owner, { refresh: true });
    await flush();
    expect(h.controller.referenceRow(RID, DEF.owner)?.editability).toMatchObject({ ok: false, reason: 'list-too-long' });
    expect(h.controller.editReferences(RID, DEF.owner, [BOB])).toBe('The list is too long to choose from here');
  });

  it('a list change: the review lists added and removed objects by name and ID; four posts', async () => {
    const h = await loaded();
    const log = await counted(h, () => expect(h.controller.editReferences(RID, DEF.regions, [CUSTOMER, PARTNER])).toBeUndefined());
    // The object read, the allowed objects of the gate, the write, the read after it.
    expect(log).toEqual(['object', 'allowed objects', 'write', 'object']);
    expect(h.client.applyCustomChanges).toHaveBeenCalledWith(RID, [`_o.change(regions := LIST(lookup(${CUSTOMER}), lookup(${PARTNER})))`]);
    expect(h.review()).toContain('+ Customer onboarding (110)');
    expect(h.review()).toContain('+ Partner onboarding (112)');
    expect(h.review()).toContain('− Supplier onboarding (108)');
    // The review says what changes; that the property is historical shows in its row.
    expect(h.review()).not.toContain(DATED_NOTE);
    expect(h.review()).not.toContain('historical');
    const entry = h.entries().find(e => e.prop === DEF.regions)!;
    expect(entry.refs?.added.map(r => r.rid)).toEqual([CUSTOMER, PARTNER]);
    expect(entry.refs?.removed.map(r => r.rid)).toEqual([SUPPLIER]);
    expect(entry.refs?.kept).toBe(0);
    expect(entry.dated).toBe(true);
    expect(h.note()).toBe('Saved 1 change');
    expect(h.server.obj.references[DEF.regions]).toEqual([CUSTOMER, PARTNER]);
  });

  it('two reference changes and a text in one save: still one read of the allowed objects', async () => {
    const h = await loaded();
    const log = await counted(h, () => {
      h.controller.editReferences(RID, DEF.regions, [SUPPLIER, CUSTOMER]);
      h.controller.editReferences(RID, DEF.owner, [BOB]);
      h.controller.editCustom(RID, DEF.note, 'QA');
    });
    expect(log).toEqual(['object', 'allowed objects', 'write', 'object']);
    expect(h.review()).toContain('Alice (alice)→Bob (bob)');
    expect(h.note()).toBe('Saved 3 changes');
  });

  it('order is not a change: the same objects in another order stage nothing', async () => {
    const h = await loaded({ stored: object({ references: { [DEF.kind]: [ITEMS[0].rid], [DEF.regions]: [SUPPLIER, CUSTOMER] } }) });
    expect(h.controller.editReferences(RID, DEF.regions, [CUSTOMER, SUPPLIER])).toBeUndefined();
    expect(h.controller.dirtyCount).toBe(0);
  });

  it('the read after the save compares as a set: another stored order is saved', async () => {
    const h = await loaded({ normalise: o => ({ ...o, references: { ...o.references, [DEF.regions]: [...(o.references[DEF.regions] ?? [])].reverse() } }) });
    h.controller.editReferences(RID, DEF.regions, [CUSTOMER, PARTNER]);
    await h.controller.save();
    expect(h.server.obj.references[DEF.regions]).toEqual([PARTNER, CUSTOMER]);
    expect(h.note()).toBe('Saved 1 change');
    expect(h.controller.dirtyCount).toBe(0);
  });

  it('an ok answer without a write is "not stored as sent", never saved', async () => {
    const stored = object();
    const h = await loaded({ normalise: () => structuredClone(stored) });
    h.controller.editReferences(RID, DEF.owner, [BOB]);
    await h.controller.save();
    expect(h.note()).toBe('Not stored as sent: Owner (owner): "Alice (alice)"');
    expect(h.controller.dirtyCount).toBe(1);
  });

  it('changed in BMP: another order is not a change; other objects are, and the dialog names them', async () => {
    const h = await loaded({ stored: object({ references: { [DEF.kind]: [ITEMS[0].rid], [DEF.regions]: [SUPPLIER, CUSTOMER] } }) });
    h.controller.editReferences(RID, DEF.regions, [PARTNER]);
    // Reordered in BMP since opened: saved.
    h.server.obj = object({ references: { [DEF.kind]: [ITEMS[0].rid], [DEF.regions]: [CUSTOMER, SUPPLIER] } });
    await h.controller.save();
    expect(h.note()).toBe('Saved 1 change');
    // Changed in BMP since opened: held, named.
    h.controller.editReferences(RID, DEF.regions, [CUSTOMER]);
    h.server.obj = object({ references: { [DEF.kind]: [ITEMS[0].rid], [DEF.regions]: [SUPPLIER] } });
    posts.log.length = 0;
    await h.controller.save();
    expect(posts.log).toEqual(['object', 'allowed objects']);
    expect(h.conflict()).toContain('opened Partner onboarding (112)');
    expect(h.conflict()).toContain('in BMP now Supplier onboarding (108) · yours Customer onboarding (110)');
  });

  it('the gate reads the allowed objects again: an object no longer allowed is refused, nothing is written', async () => {
    const h = await loaded();
    h.controller.editReferences(RID, DEF.regions, [CUSTOMER]);
    // The set depends on the object's data: it has changed on the server.
    h.server.allowed = { ...h.server.allowed, [DEF.regions]: ALLOWED[DEF.regions].filter(i => i.rid !== CUSTOMER) };
    await h.controller.save();
    expect(h.client.applyCustomChanges).not.toHaveBeenCalled();
    expect((h.controller as unknown as { draft: { propErrorFor(r: string, p: string): string | undefined } }).draft.propErrorFor(RID, DEF.regions))
      .toBe('Not one of the objects this property allows');
    expect(h.controller.dirtyCount).toBe(1);
  });

  it('the window refuses what the gate would: outside the set, twice, a dated clear', async () => {
    const h = await loaded();
    expect(h.controller.editReferences(RID, DEF.regions, [CUSTOMER, FOREIGN_OBJECT])).toBe('Not one of the objects this property allows');
    expect(h.controller.editReferences(RID, DEF.regions, [CUSTOMER, CUSTOMER])).toBe('An object is in the list twice');
    expect(h.controller.editReferences(RID, DEF.owner, [ALICE, BOB])).toBe('This property holds one object only');
    expect(h.controller.editReferences(RID, DEF.owner, [])).toBe(DATED_NO_CLEAR);
    // A list may be emptied: written as LIST().
    expect(h.controller.editReferences(RID, DEF.regions, [])).toBeUndefined();
    await h.controller.save();
    expect(h.client.applyCustomChanges).toHaveBeenCalledWith(RID, ['_o.change(regions := LIST())']);
    expect(h.review()).toContain('− Supplier onboarding (108)');
    expect(h.note()).toBe('Saved 1 change');
  });

  it('a stored object no longer allowed is named as outside the set', async () => {
    const h = await harness();
    h.server.allowed = { ...h.server.allowed, [DEF.regions]: ALLOWED[DEF.regions].filter(i => i.rid !== SUPPLIER) };
    h.controller.loadAllowed(RID, DEF.regions);
    await flush();
    expect(h.controller.referenceRow(RID, DEF.regions)?.outside).toEqual([SUPPLIER]);
  });
});

// ── the row (real view) ─────────────────────────────────────────────

function mountView(obj: FullObject, schema: TypePropertySchema) {
  const run = vi.fn<ObjectWindowSource['run']>(async () => ({ ok: true }));
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async (): Promise<ObjectRootPayload> => ({ rid: RID, root: obj, rows: null, nodes: {}, posts: 1, ms: 1 })),
    readSummaries: vi.fn(async () => ({ summaries: [] })),
    fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => ({ objects: { [RID]: obj }, errors: {} })),
    propertySchema: vi.fn(async () => schema),
    run,
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers: ViewHandlers = {
    navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), retry: vi.fn(), copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(),
    selected: o => controller.nodeSelected(o),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    editCustom: (rid, prop, value) => controller.editCustom(rid, prop, value),
    revert: (rid, prop) => controller.revert(rid, prop),
    toggleReset: vi.fn(), discard: vi.fn(), save: () => { void controller.save(); }, setTarget: vi.fn(), compare: vi.fn(), access: vi.fn(),
  };
  controller = new ObjectWindowController(new ObjectWindowView(root, handlers), src, { confirmSave: async () => true, unknownRereadDelayMs: 0 });
  return { root, controller, run };
}
const row = (root: HTMLElement, key: string) => root.querySelector<HTMLElement>(`.ow-pr2[data-key="${key}"]`)!;
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

/** Every character the gate refuses in a text value. */
const REFUSED = [
  ...Array.from({ length: 0x20 }, (_, c) => c).filter(c => c !== 0x09 && c !== 0x0a && c !== 0x0d),
  0x7f, 0x2028, 0x2029,
].map(c => String.fromCharCode(c));
const CONTROL = 'Not saved: The text holds a control character that cannot be saved';

beforeEach(() => { document.body.textContent = ''; });

describe('a refused text value reaches the row', () => {
  it('single-line: each refused character keeps the editor open with the value and the reason; nothing is staged', async () => {
    const { root, controller, run } = mountView(object(), await fixtureSchema());
    await controller.open(RID);
    await flush();
    for (const ch of REFUSED) {
      row(root, DEF.note).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
      const input = row(root, DEF.note).querySelector<HTMLInputElement>('input.ow-ped-in')!;
      input.value = `a${ch}b`;
      input.dispatchEvent(new Event('input'));
      key(input, 'Enter');
      const again = row(root, DEF.note).querySelector<HTMLInputElement>('input.ow-ped-in');
      expect(again, `U+${ch.charCodeAt(0).toString(16)}`).not.toBeNull();
      expect(again!.value).toBe(`a${ch}b`);
      expect(row(root, DEF.note).querySelector('.ow-ped .ow-perr')?.textContent).toBe(CONTROL);
      expect(controller.dirtyCount).toBe(0);
      key(again!, 'Escape');
    }
    // Leaving the field does not drop it either.
    row(root, DEF.note).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    const input = row(root, DEF.note).querySelector<HTMLInputElement>('input.ow-ped-in')!;
    input.value = 'a\u0007b';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    expect(row(root, DEF.note).querySelector<HTMLInputElement>('input.ow-ped-in')?.value).toBe('a\u0007b');
    expect(row(root, DEF.note).querySelector('.ow-ped .ow-perr')?.textContent).toBe(CONTROL);
    expect(run).not.toHaveBeenCalled();
  });

  it('single-line: a line break is refused with its reason; a tab is kept', async () => {
    const { root, controller } = mountView(object(), await fixtureSchema());
    await controller.open(RID);
    await flush();
    expect(controller.editCustom(RID, DEF.note, 'a\nb')).toBe('A single-line text cannot hold line breaks');
    row(root, DEF.note).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    const input = row(root, DEF.note).querySelector<HTMLInputElement>('input.ow-ped-in')!;
    input.value = 'a\nb';
    input.dispatchEvent(new Event('input'));
    key(input, 'Enter');
    if (input.value.includes('\n')) {
      expect(row(root, DEF.note).querySelector('.ow-ped .ow-perr')?.textContent).toBe('Not saved: A single-line text cannot hold line breaks');
      expect(controller.dirtyCount).toBe(0);
    } else {
      // A browser input drops the line break itself.
      expect(controller.dirtyCount).toBe(1);
    }
    expect(controller.editCustom(RID, DEF.note, 'a\tb')).toBeUndefined();
  });

  it('multi-line: each refused character keeps the editor open with the reason; a line break is staged', async () => {
    const { root, controller } = mountView(object(), await fixtureSchema());
    await controller.open(RID);
    await flush();
    for (const ch of REFUSED) {
      row(root, DEF.summary).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
      const ta = row(root, DEF.summary).querySelector<HTMLTextAreaElement>('.ow-pop textarea')!;
      ta.value = `one${ch}\ntwo`;
      ta.dispatchEvent(new Event('input'));
      key(ta, 'Enter', { ctrlKey: true });
      const again = row(root, DEF.summary).querySelector<HTMLTextAreaElement>('.ow-pop textarea');
      expect(again, `U+${ch.charCodeAt(0).toString(16)}`).not.toBeNull();
      expect(again!.value).toBe(`one${ch}\ntwo`);
      expect(row(root, DEF.summary).querySelector('.ow-pop .ow-perr')?.textContent).toBe(CONTROL);
      expect(controller.dirtyCount).toBe(0);
      key(again!, 'Escape');
    }
    row(root, DEF.summary).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    const ta = row(root, DEF.summary).querySelector<HTMLTextAreaElement>('.ow-pop textarea')!;
    ta.value = 'one\ntwo';
    ta.dispatchEvent(new Event('input'));
    key(ta, 'Enter', { ctrlKey: true });
    expect(row(root, DEF.summary).querySelector('.ow-pop')).toBeNull();
    expect(controller.dirtyCount).toBe(1);
  });
});

describe('the row: "Not set"', () => {
  it('a list item that may be blank offers "Not set" first; one that may not does not', async () => {
    const blank = await fixtureSchema();
    blank.listItems[DEF.kind] = ITEMS.slice(0, 3);
    blank.definitions = { ...blank.definitions, [DEF.kind]: { ...blank.definitions[DEF.kind], allowBlank: true } };
    const { root, controller } = mountView(object(), blank);
    await controller.open(RID);
    await flush();
    row(root, DEF.kind).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    const radios = [...row(root, DEF.kind).querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map(r => r.textContent)).toEqual(['Not set', 'First', 'Second', 'Third']);
    radios[0].click();
    expect(controller.dirtyCount).toBe(1);
    expect(row(root, DEF.kind).querySelector('.ow-pbox .pt')?.textContent).toBe('Not set');

    const strict = await fixtureSchema();
    strict.listItems[DEF.kind] = ITEMS.slice(0, 3);
    const m = mountView(object(), strict);
    await m.controller.open(RID);
    await flush();
    row(m.root, DEF.kind).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    expect([...row(m.root, DEF.kind).querySelectorAll('[role="radio"]')].map(r => r.textContent)).toEqual(['First', 'Second', 'Third']);
  });

  it('an empty text reads "Not set" in the row', async () => {
    const { root, controller } = mountView(object(), await fixtureSchema());
    await controller.open(RID);
    await flush();
    expect(row(root, DEF.note).querySelector('.ow-pbox .pt')?.textContent).toBe('Not set');
    expect(row(root, DEF.note).querySelector('.ow-pbox')?.classList.contains('unset')).toBe(true);
    expect(root.textContent).not.toContain('Empty');
  });
});
