/**
 * APPLY_CUSTOM_CHANGES: the service worker is the gate. A refused change
 * never reaches the server (no write is sent); a window inside a page may
 * write only an object it read on the same environment.
 */
import { describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { DEF, DEFINITIONS, ITEMS, LIST_SET, fields } from './fixtures/property-fields';

vi.mock('../enrichment', async importOriginal => ({
  ...(await importOriginal<typeof import('../enrichment')>()),
  invalidateRid: vi.fn(async () => {}), incrementGeneration: vi.fn(),
}));
vi.mock('../code-index-service', () => ({ noteSavedObject: vi.fn(), clearCodeIndex: vi.fn() }));

const RID = '9007199254740993';
const ENV = 'p1@https://bmp.example/demo/';
const OW = 'chrome-extension://abcdef/objectview/window.html#1';
const FRAME_A = { senderKind: 'frame', senderTabId: 7, senderFrameId: 3, senderDocumentId: 'doc-a', senderUrl: OW };
const SENDER_A = { tabId: 7, frameId: 3, documentId: 'doc-a', url: OW };

async function harness() {
  vi.resetModules();
  mockChromeStorage();
  const applyCustomChanges = vi.fn(async () => ({ ok: true }));
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
    applyCustomChanges,
  };
  const ctx: any = { client, settings: { activeProfileId: 'p1' }, cache: { get: vi.fn(() => null) }, logActivity: vi.fn(), toast: vi.fn() };
  const { setSwContext } = await import('../sw-context');
  const { getHandler } = await import('../handler-registry');
  const trust = await import('../sender-trust');
  setSwContext(ctx);
  await import('../handlers/custom-properties');
  const send = async (msg: Record<string, unknown>, meta: Record<string, unknown> = FRAME_A) => {
    const respond = vi.fn();
    await getHandler('APPLY_CUSTOM_CHANGES')!({ type: 'APPLY_CUSTOM_CHANGES', rid: RID, environment: ENV, ...msg } as any, respond, { isOneShot: true, ...meta } as any);
    return respond.mock.calls[0][0];
  };
  return { client, ctx, send, trust };
}

describe('sender allow-list', () => {
  it('frames may send the custom write and the schema read; a page may not', async () => {
    const { senderKindMay } = await import('../message-access');
    for (const type of ['APPLY_CUSTOM_CHANGES', 'FETCH_PROPERTY_SCHEMA']) {
      expect(senderKindMay('frame', type)).toBe(true);
      expect(senderKindMay('content', type)).toBe(false);
      expect(senderKindMay('extension', type)).toBe(true);
    }
  });

  it('records per window document what it was served; nothing else, nobody else', async () => {
    mockChromeStorage();
    const { noteFrameServed, frameMayWrite, forgetFrameTab, resetFrameReads, FRAME_SERVED_PER_KEY } = await import('../sender-trust');
    resetFrameReads();
    const NEVER = '7000000000000000098';
    await noteFrameServed(SENDER_A, ENV, [RID, 'not-a-rid', undefined]);
    expect(await frameMayWrite(SENDER_A, ENV, RID)).toBe(true);
    // Never served, or served to a different frame, tab or server profile.
    expect(await frameMayWrite(SENDER_A, ENV, NEVER)).toBe(false);
    expect(await frameMayWrite(SENDER_A, ENV, 'not-a-rid')).toBe(false);
    expect(await frameMayWrite(SENDER_A, 'p2@x', RID)).toBe(false);
    expect(await frameMayWrite({ ...SENDER_A, frameId: 4, documentId: 'doc-b' }, ENV, RID)).toBe(false);
    expect(await frameMayWrite({ ...SENDER_A, tabId: 8 }, ENV, RID)).toBe(false);
    expect(await frameMayWrite({}, ENV, RID)).toBe(false);
    // Only an object window frame is recorded or allowed (not another embedded window).
    const editor = { ...SENDER_A, frameId: 5, url: 'chrome-extension://abcdef/editor/editor.html' };
    await noteFrameServed(editor, ENV, [RID]);
    expect(await frameMayWrite(editor, ENV, RID)).toBe(false);
    expect(await frameMayWrite({ ...SENDER_A, url: undefined }, ENV, RID)).toBe(false);
    // Kept across a worker restart (session storage, written after the tick).
    await new Promise(r => setTimeout(r, 0));
    resetFrameReads();
    expect(await frameMayWrite(SENDER_A, ENV, RID)).toBe(true);
    // A new document in the same frame: the old record is gone, also for the old document.
    const reloaded = { ...SENDER_A, documentId: 'doc-a2' };
    expect(await frameMayWrite(reloaded, ENV, RID)).toBe(false);
    await noteFrameServed(reloaded, ENV, [NEVER]);
    expect(await frameMayWrite(SENDER_A, ENV, RID)).toBe(false);
    expect(await frameMayWrite(reloaded, ENV, NEVER)).toBe(true);
    // The cap: the oldest served objects drop out first.
    const many = Array.from({ length: FRAME_SERVED_PER_KEY + 10 }, (_, i) => String(7400000000000000000n + BigInt(i)));
    await noteFrameServed(reloaded, ENV, many);
    expect(await frameMayWrite(reloaded, ENV, many[0])).toBe(false);
    expect(await frameMayWrite(reloaded, ENV, many[9])).toBe(false);
    expect(await frameMayWrite(reloaded, ENV, many[10])).toBe(true);
    expect(await frameMayWrite(reloaded, ENV, many[many.length - 1])).toBe(true);
    // A tab that loads a new page or closes drops everything.
    await forgetFrameTab(7);
    expect(await frameMayWrite(reloaded, ENV, many[many.length - 1])).toBe(false);
  });
});

const kindChange = { definition: DEF.kind, accessor: 'kind', kind: 'listItem', value: ITEMS[1].rid };

describe('APPLY_CUSTOM_CHANGES', () => {
  it('writes a gated change for an object the window opened, re-reading the type schema', async () => {
    const h = await harness();
    await h.trust.noteFrameServed(SENDER_A, ENV, [RID]);
    const res = await h.send({ changes: [kindChange] });
    expect(res).toEqual({ type: 'APPLY_CUSTOM_CHANGES_RESULT', rid: RID, ok: true });
    expect(h.client.applyCustomChanges).toHaveBeenCalledWith(RID, [`_o.change(kind := lookup(${ITEMS[1].rid}))`]);
    expect(h.client.fetchTypeFieldDescriptions).toHaveBeenCalledWith('CeProcess', undefined);
    expect(h.client.resolveRefs).toHaveBeenCalledWith([ITEMS[1].rid]);
  });

  it('writes a list item in the pre-lookup form of an older server', async () => {
    const h = await harness();
    await h.trust.noteFrameServed(SENDER_A, ENV, [RID]);
    const legacy = `LIST(t.get("kind_second")).filter(str(rid) = "${ITEMS[1].rid}").first()`;
    h.client.resolveRefs.mockResolvedValueOnce(new Map([[ITEMS[1].rid, legacy]]));
    await h.send({ changes: [kindChange] });
    expect(h.client.applyCustomChanges).toHaveBeenCalledWith(RID, [`_o.change(kind := ${legacy})`]);
  });

  it('an item an older server cannot resolve is refused; no script is sent', async () => {
    const h = await harness();
    await h.trust.noteFrameServed(SENDER_A, ENV, [RID]);
    h.client.resolveRefs.mockResolvedValueOnce(new Map<string, string | Error>([[ITEMS[1].rid, new Error('Cannot resolve object')]]));
    expect(await h.send({ changes: [kindChange] })).toMatchObject({
      ok: false, notSent: true, refused: [{ definition: DEF.kind, reason: 'The item could not be resolved on this server' }],
    });
    expect(h.client.applyCustomChanges).not.toHaveBeenCalled();
  });

  it('a window may write only what it was served; the refusal is named on the rows', async () => {
    const h = await harness();
    const notOpened = 'This window has not opened this object. Reload the window.';
    expect(await h.send({ changes: [kindChange] })).toEqual({
      type: 'APPLY_CUSTOM_CHANGES_RESULT', rid: RID, ok: false, notSent: true, error: notOpened, refused: [{ definition: '', reason: notOpened }],
    });
    await h.trust.noteFrameServed({ ...SENDER_A, frameId: 9, documentId: 'other' }, ENV, [RID]);
    expect((await h.send({ changes: [kindChange] })).ok).toBe(false);
    await h.trust.noteFrameServed(SENDER_A, ENV, [RID]);
    expect((await h.send({ changes: [kindChange], environment: 'p2@https://other/' })).notSent).toBe(true);
    // A web page (content script) is refused even in the bound tab.
    expect(await h.send({ changes: [kindChange] }, { senderKind: 'content', senderTabId: 7 })).toMatchObject({ ok: false, notSent: true, error: 'This request is not accepted from a page.' });
    expect(h.client.applyCustomChanges).not.toHaveBeenCalled();
    expect(h.client.readFullObjects).not.toHaveBeenCalled();
  });

  it('refuses tampered changes in the worker: nothing is sent to the server', async () => {
    const h = await harness();
    await h.trust.noteFrameServed(SENDER_A, ENV, [RID]);
    const calculated = await h.send({ changes: [{ definition: DEF.score, accessor: 'score', kind: 'number', value: '1' }] });
    expect(calculated).toMatchObject({ ok: false, notSent: true, error: 'Calculated by Extended Code', refused: [{ definition: DEF.score, reason: 'Calculated by Extended Code' }] });
    const wrongKind = await h.send({ changes: [{ definition: DEF.enabled, accessor: 'enabled', kind: 'text', value: 'false' }] });
    expect(wrongKind).toMatchObject({ ok: false, notSent: true, refused: [{ definition: DEF.enabled, reason: 'The value kind does not match the property.' }] });
    const builtIn = await h.send({ changes: [{ definition: 'showToolMenu', accessor: 'showToolMenu', kind: 'boolean', value: 'true' }] });
    expect(builtIn).toMatchObject({ ok: false, notSent: true });
    const injected = await h.send({ changes: [{ definition: DEF.note, accessor: 'note := lookup(1), x', kind: 'text', value: 'x' }] });
    expect(injected).toMatchObject({ ok: false, notSent: true });
    const tooMany = await h.send({ changes: Array.from({ length: 101 }, () => kindChange) });
    expect(tooMany).toMatchObject({ ok: false, notSent: true, error: 'At most 100 changes per write.' });
    expect(h.client.applyCustomChanges).not.toHaveBeenCalled();
    expect(h.ctx.logActivity).toHaveBeenCalledWith('warn', expect.stringContaining('Refused a property change'), expect.any(String), expect.anything());
  });

  it('writes a historical value with a plain change, no dated form', async () => {
    const h = await harness();
    await h.trust.noteFrameServed(SENDER_A, ENV, [RID]);
    const res = await h.send({ changes: [{ definition: DEF.enabled, accessor: 'enabled', kind: 'boolean', value: 'false' }] });
    expect(res).toEqual({ type: 'APPLY_CUSTOM_CHANGES_RESULT', rid: RID, ok: true });
    expect(h.client.applyCustomChanges).toHaveBeenCalledWith(RID, ['_o.change(enabled := FALSE)']);
  });

  it('passes the client result shapes on: oversize is not sent, a warning after a commit is not a failure', async () => {
    const h = await harness();
    h.client.applyCustomChanges.mockResolvedValueOnce({ ok: false, notSent: true, error: 'The change is too large to send (25001 characters).' } as never);
    expect(await h.send({ changes: [kindChange] }, { senderKind: 'extension' })).toMatchObject({ ok: false, notSent: true });
    h.client.applyCustomChanges.mockResolvedValueOnce({ ok: true, warning: 'Value adjusted' } as never);
    expect(await h.send({ changes: [kindChange] }, { senderKind: 'extension' })).toMatchObject({ ok: true, warning: 'Value adjusted' });
    expect(h.ctx.toast).toHaveBeenCalledTimes(1); // the oversize refusal only, never the warning
  });

  it('an extension page needs no frame binding; a lost answer is outcome unknown', async () => {
    const h = await harness();
    h.client.applyCustomChanges.mockResolvedValueOnce({ ok: false, error: 'timed out', outcomeUnknown: true } as never);
    const res = await h.send({ changes: [kindChange] }, { senderKind: 'extension' });
    expect(res).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(h.client.applyCustomChanges).toHaveBeenCalledTimes(1);
  });
});
