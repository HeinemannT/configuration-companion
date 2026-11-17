/**
 * Follow-up round of the custom property write path: choice fields, lookups
 * that never reach Object.prototype, the handler's own count guard, the
 * per-frame record (pinned root, coalesced writes, a Chrome without
 * documentId), the window's answer to a refused request, and change line
 * sizes from the generated text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { checkCustomChanges } from '../custom-property-gate';
import {
  changeLine, changeLineSize, classifyModel, legacyItemRef, MAX_CUSTOM_CHANGES, storedValue,
  type CustomChange, type FieldDescription, type TypePropertySchema,
} from '../property-schema';
import { RuntimeRequestError } from '../messaging';
import { customRequestFailure, LOST_RESPONSE, splitCustom } from '../../objectview/window/save-plan';
import type { CustomEntry } from '../../objectview/window/draft';
import { DEF, DEFINITIONS, ITEMS, LIST_SET, fields, schema } from './fixtures/property-fields';

afterEach(() => { vi.doUnmock('../custom-property-gate'); vi.useRealTimers(); });

const PICK = '7000000000000000030';
const MULTI = '7000000000000000031';

/** A schema with a String choice (class TextMethodConfig) and a multiselect
 *  list item field next to the fixture's single list item `kind`. */
async function choiceSchema(): Promise<TypePropertySchema> {
  const s = await schema();
  const base = { category: 'Extra', sortIndex: 70, customField: true, editable: true } as const;
  s.fields.push(
    { ...base, name: PICK, id: PICK, businessId: 'pick', displayName: 'Pick', type: 'String', choice: true, options: ['A', 'B'] } as FieldDescription,
    { ...base, name: MULTI, id: MULTI, businessId: 'multi', displayName: 'Multi', type: 'ListPropertySetItem', choice: true, multiselect: true, reference: true, options: ['First', 'Second'] } as FieldDescription,
  );
  s.definitions = { ...s.definitions, [PICK]: { configClass: 'TextMethodConfig' }, [MULTI]: { configClass: 'ListMethodConfig', listSetRid: LIST_SET } };
  s.listItems = { ...s.listItems, [MULTI]: ITEMS };
  return s;
}
const model = (s: TypePropertySchema, id: string) => classifyModel(s, s.fields.find(f => f.id === id)!);
const change = (c: Partial<CustomChange> & Pick<CustomChange, 'definition'>): CustomChange => ({ accessor: '', kind: 'text', value: '', ...c });

describe('choice fields (item 1)', () => {
  it('the measured choice shape (ListMethodConfig, ListPropertySetItem, choice + options) is a list item, written by item RID', async () => {
    const s = await choiceSchema();
    const m = model(s, DEF.kind);
    expect(m).toMatchObject({ kind: 'listItem', editability: { ok: true } });
    const ok = checkCustomChanges(s, [change({ definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: ITEMS[2].rid })]);
    expect(ok).toEqual({ ok: true, lines: [`_o.change(kind := lookup(${ITEMS[2].rid}))`] });
    // An option name is not an item RID; a choice-kind post is the wrong kind.
    expect(checkCustomChanges(s, [change({ definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: 'Third' })]).ok).toBe(false);
    expect(checkCustomChanges(s, [change({ definition: DEF.kind, accessor: 'kind', kind: 'choice', value: 'Third' })]).ok).toBe(false);
    // The read holds the chosen item under `references`.
    expect(storedValue({ props: {}, references: { [DEF.kind]: [ITEMS[2].rid] } }, DEF.kind, 'listItem')).toBe(ITEMS[2].rid);
  });

  it('a String choice with options stays read-only: its class and stored form were never measured', async () => {
    const s = await choiceSchema();
    expect(model(s, PICK)).toMatchObject({ kind: 'choice', options: ['A', 'B'], editability: { ok: false, reason: 'not-stored' } });
    const r = checkCustomChanges(s, [change({ definition: PICK, accessor: 'pick', kind: 'choice', value: 'A' })]);
    expect(r).toEqual({ ok: false, refused: [{ definition: PICK, reason: 'Not a plainly stored value: edited in Configuration Studio' }] });
  });

  it('a multiselect list item field is read-only, never written as one item', async () => {
    const s = await choiceSchema();
    expect(model(s, MULTI)).toMatchObject({ kind: 'referenceList', editability: { ok: false } });
    expect(checkCustomChanges(s, [change({ definition: MULTI, accessor: 'multi', kind: 'listItem', value: ITEMS[0].rid })]).ok).toBe(false);
  });
});

const PROTO_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
const RID = '9007199254740993';
const ENV = 'p1@https://bmp.example/demo/';

async function handler(opts: { gateAlwaysOk?: boolean } = {}) {
  vi.resetModules();
  mockChromeStorage();
  vi.doMock('../enrichment', async importOriginal => ({ ...(await importOriginal<typeof import('../enrichment')>()), invalidateRid: vi.fn(async () => {}), incrementGeneration: vi.fn() }));
  vi.doMock('../code-index-service', () => ({ noteSavedObject: vi.fn(), clearCodeIndex: vi.fn() }));
  const gate = vi.fn(() => ({ ok: true as const, lines: ['_o.change(note := "x")'] }));
  if (opts.gateAlwaysOk) {
    vi.doMock('../custom-property-gate', async importOriginal => ({ ...(await importOriginal<typeof import('../custom-property-gate')>()), checkCustomChanges: gate }));
  }
  const client = {
    serverUrl: 'https://bmp.example/demo/', sessionEpoch: 1,
    fetchTypeFieldDescriptions: vi.fn(async () => fields()),
    readFullObjects: vi.fn(async (rids: readonly string[]) => ({
      objects: Object.fromEntries(rids.map(r => [r, r === RID
        ? { rid: r, type: 'CeProcess', name: 'Sample', businessId: 's1', props: {}, references: {}, overridden: [] }
        : { rid: r, type: DEFINITIONS[r]?.configClass ?? 'X', name: '', businessId: '', props: {}, overridden: [], references: DEFINITIONS[r]?.listSetRid ? { listPropertySet: [LIST_SET] } : {} }])),
      errors: {},
    })),
    readListItems: vi.fn(async () => ITEMS),
    resolveRefs: vi.fn(async (rids: readonly string[]) => new Map<string, string | Error>(rids.map(r => [r, `lookup(${r})`]))),
    applyCustomChanges: vi.fn(async () => ({ ok: true })),
  };
  const ctx: any = { client, settings: { activeProfileId: 'p1' }, cache: { get: vi.fn(() => null) }, logActivity: vi.fn(), toast: vi.fn() };
  const { setSwContext } = await import('../sw-context');
  const { getHandler } = await import('../handler-registry');
  setSwContext(ctx);
  await import('../handlers/custom-properties');
  const send = async (changes: unknown[]) => {
    const respond = vi.fn();
    await getHandler('APPLY_CUSTOM_CHANGES')!({ type: 'APPLY_CUSTOM_CHANGES', rid: RID, environment: ENV, changes } as any, respond, { isOneShot: true, senderKind: 'extension' } as any);
    return respond.mock.calls[0][0];
  };
  return { client, send, gate };
}

describe('lookups by own key only (item 2)', () => {
  it.each(PROTO_KEYS)('a list item change for definition "%s" gets the gate refusal, never "schema could not be read"', async key => {
    const h = await handler();
    const res = await h.send([{ definition: key, accessor: 'kind', kind: 'listItem', value: ITEMS[0].rid }]);
    expect(res).toEqual({
      type: 'APPLY_CUSTOM_CHANGES_RESULT', rid: RID, ok: false, notSent: true,
      error: 'Not a property definition RID.', refused: [{ definition: key, reason: 'Not a property definition RID.' }],
    });
    expect(h.client.resolveRefs).not.toHaveBeenCalled();
    expect(h.client.applyCustomChanges).not.toHaveBeenCalled();
  });

  it.each(PROTO_KEYS)('schema, gate and read helpers ignore Object.prototype for "%s"', async key => {
    const s = await schema();
    const f: FieldDescription = { name: key, id: key, businessId: 'kind2', displayName: 'K', category: '', sortIndex: 1, type: 'ListPropertySetItem', customField: true, editable: true };
    expect(model({ ...s, fields: [...s.fields, f] }, key).editability).toMatchObject({ ok: false, reason: 'unread-definition' });
    expect(checkCustomChanges(s, [change({ definition: key, accessor: 'kind', kind: 'listItem', value: ITEMS[0].rid })]).ok).toBe(false);
    expect(storedValue({ props: {}, references: {} }, key, 'listItem')).toBe('\u0000absent');
  });
});

describe('the handler\'s own count guard (item 3)', () => {
  it('refuses more than the limit before the read, the gate and any write (gate bypassed)', async () => {
    const h = await handler({ gateAlwaysOk: true });
    const one = { definition: DEF.note, accessor: 'note', kind: 'text', value: 'x' };
    const res = await h.send(Array.from({ length: MAX_CUSTOM_CHANGES + 1 }, () => one));
    expect(res).toEqual({ type: 'APPLY_CUSTOM_CHANGES_RESULT', rid: RID, ok: false, notSent: true, error: `At most ${MAX_CUSTOM_CHANGES} changes per write.` });
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.client.readFullObjects).not.toHaveBeenCalled();
    expect(h.client.applyCustomChanges).not.toHaveBeenCalled();
    // At the limit the (bypassed) gate decides and the write goes out.
    await h.send(Array.from({ length: MAX_CUSTOM_CHANGES }, () => one));
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.client.applyCustomChanges).toHaveBeenCalledTimes(1);
  });
});

describe('the per-frame record (item 4)', () => {
  const OW = 'chrome-extension://abcdef/objectview/window.html#1';
  const WIN = { tabId: 7, frameId: 3, documentId: 'doc-a', url: OW };

  async function trust() {
    vi.resetModules();
    const store = mockChromeStorage();
    const t = await import('../sender-trust');
    t.resetFrameReads();
    return { t, store, set: vi.mocked(chrome.storage.session.set) };
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  it('an answer with more nodes than the cap keeps its root', async () => {
    const { t } = await trust();
    const root = '7500000000000000000';
    const nodes = Array.from({ length: t.FRAME_SERVED_PER_KEY + 20 }, (_, i) => String(7400000000000000000n + BigInt(i)));
    await t.noteFrameServed(WIN, ENV, nodes, { root });
    expect(await t.frameMayWrite(WIN, ENV, root)).toBe(true);
    expect(await t.frameMayWrite(WIN, ENV, nodes[nodes.length - 1])).toBe(true);
    expect(await t.frameMayWrite(WIN, ENV, nodes[0])).toBe(false);
    // Later reads of other objects do not push it out either.
    await t.noteFrameServed(WIN, ENV, nodes.map(n => n.replace(/^74/, '76')));
    expect(await t.frameMayWrite(WIN, ENV, root)).toBe(true);
    // The pin survives a worker restart.
    await tick();
    t.resetFrameReads();
    expect(await t.frameMayWrite(WIN, ENV, root)).toBe(true);
  });

  it('writes session storage only when the set changed, once per tick', async () => {
    const { t, set } = await trust();
    await t.noteFrameServed(WIN, ENV, ['7000000000000000001']);
    await t.noteFrameServed(WIN, ENV, ['7000000000000000002']);
    await t.noteFrameServed(WIN, ENV, ['7000000000000000003'], { root: '7000000000000000004' });
    expect(set).not.toHaveBeenCalled();
    await tick();
    expect(set).toHaveBeenCalledTimes(1);
    // The same objects served again: nothing to write.
    await t.noteFrameServed(WIN, ENV, ['7000000000000000001', '7000000000000000002']);
    await t.noteFrameServed(WIN, ENV, [], { root: '7000000000000000004' });
    await tick();
    expect(set).toHaveBeenCalledTimes(1);
    await t.noteFrameServed(WIN, ENV, ['7000000000000000005']);
    await tick();
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('without documentId the frame URL is the document: another URL in the frame drops the record', async () => {
    const { t } = await trust();
    const legacy = { tabId: 7, frameId: 3, url: OW };
    await t.noteFrameServed(legacy, ENV, ['7000000000000000001']);
    expect(await t.frameMayWrite(legacy, ENV, '7000000000000000001')).toBe(true);
    const moved = { ...legacy, url: 'chrome-extension://abcdef/objectview/window.html#2' };
    expect(await t.frameMayWrite(moved, ENV, '7000000000000000001')).toBe(false);
    await t.noteFrameServed(moved, ENV, ['7000000000000000002']);
    // The old URL's record is gone, also when the old URL comes back.
    expect(await t.frameMayWrite(legacy, ENV, '7000000000000000001')).toBe(false);
    expect(await t.frameMayWrite(moved, ENV, '7000000000000000002')).toBe(true);
  });
});

describe('a refused request is "Not saved", a lost answer "may have saved" (item 6)', () => {
  const changes = [{ definition: DEF.note }, { definition: DEF.weight }];

  it('a REQUEST_FAILED reply (nothing sent) names the reason on every row', () => {
    const reason = 'This request is accepted only from Companion’s own pages.';
    expect(customRequestFailure(new RuntimeRequestError(reason, 'runtime'), changes)).toEqual({
      ok: false, notSent: true, error: reason, propErrors: { [DEF.note]: reason, [DEF.weight]: reason },
    });
    const undelivered = new Error('Could not establish connection. Receiving end does not exist.');
    expect(customRequestFailure(new RuntimeRequestError(undelivered.message, 'runtime', { cause: undelivered }), changes)).toMatchObject({ notSent: true });
  });

  it('a time-out, no answer or a closed port: may have saved', () => {
    const lost = { ok: false, error: LOST_RESPONSE, unknown: true };
    expect(customRequestFailure(new RuntimeRequestError('Request timed out', 'timeout'), changes)).toEqual(lost);
    expect(customRequestFailure(new RuntimeRequestError('Extension service worker did not respond', 'no-response'), changes)).toEqual(lost);
    const closed = new Error('The message port closed before a response was received.');
    expect(customRequestFailure(new RuntimeRequestError(closed.message, 'runtime', { cause: closed }), changes)).toEqual(lost);
    expect(customRequestFailure(new Error('anything'), changes)).toEqual(lost);
  });
});

describe('change line size from the generated text (item 7)', () => {
  const sized = (c: Pick<CustomChange, 'accessor' | 'value' | 'kind'>, itemId?: string) => changeLineSize(c, itemId);

  it('equals the line the gate builds for every kind', async () => {
    const s = await schema();
    const cases: CustomChange[] = [
      { definition: DEF.note, accessor: 'note', kind: 'text', value: 'a "quoted" \\ value' },
      { definition: DEF.summary, accessor: 'summary', kind: 'multiline', value: 'one\ntwo' },
      { definition: DEF.weight, accessor: 'weight', kind: 'number', value: '007.50' },
      { definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: ITEMS[1].rid },
    ];
    for (const c of cases) {
      const r = checkCustomChanges(s, [c]);
      expect(r.ok, c.accessor).toBe(true);
      const line = r.ok ? r.lines[0] : '';
      if (c.kind !== 'listItem') { expect(sized(c), c.accessor).toBe(line.length); continue; }
      // A list item: the longer of the gate's lookup() line and the pre-lookup line.
      const legacy = checkCustomChanges(s, [c], { itemRef: rid => legacyItemRef(rid, 'x') });
      expect(sized(c, 'x')).toBe(legacy.ok ? legacy.lines[0].length : -1);
      expect(sized(c, 'x')).toBeGreaterThan(line.length);
    }
    expect(sized({ accessor: 'enabled', kind: 'boolean', value: 'true' })).toBe('_o.change(enabled := TRUE)'.length);
  });

  it('a list item counts with its pre-lookup reference, exactly as the client builds it', async () => {
    mockChromeStorage();
    const { BmpClient } = await import('../bmp-client');
    const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass');
    client.assumeOldBmp();
    const id = 'kind_"second"\\x';
    client.cache = { get: () => ({ businessId: id, type: 'ListPropertySetItem' }) };
    const ref = await client.resolveRef(ITEMS[1].rid);
    expect(legacyItemRef(ITEMS[1].rid, id)).toBe(ref);
    expect(sized({ accessor: 'kind', kind: 'listItem', value: ITEMS[1].rid }, id)).toBe(changeLine('_o', 'kind', ref).length);
    // Longer than the old flat 400 when the business ID is long: never under-counted.
    const long = 'k'.repeat(300);
    expect(sized({ accessor: 'kind', kind: 'listItem', value: ITEMS[1].rid }, long)).toBe(changeLine('_o', 'kind', legacyItemRef(ITEMS[1].rid, long)).length);
    expect(sized({ accessor: 'kind', kind: 'listItem', value: ITEMS[1].rid }, long)).toBeGreaterThan(400);
  });

  it('the save split uses those sizes', () => {
    const e = (i: number, value: string): { prop: string; entry: CustomEntry } => ({ prop: `p${i}`, entry: { kind: 'custom', definition: `p${i}`, accessor: 'note', valueKind: 'text', value, base: '' } });
    const one = `_o.change(note := "${'x'.repeat(100)}")`.length + 1;
    expect(splitCustom([e(1, 'x'.repeat(100)), e(2, 'x'.repeat(100))], one * 2).posts.map(p => p.length)).toEqual([2]);
    expect(splitCustom([e(1, 'x'.repeat(100)), e(2, 'x'.repeat(100))], one * 2 - 1).posts.map(p => p.length)).toEqual([1, 1]);
  });
});
