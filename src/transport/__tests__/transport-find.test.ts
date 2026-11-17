/**
 * The Transport window's controller for round five, driven by a fake
 * worker: the transport survives every search; each way to find (changed
 * since, under an object, search, ID list, this page); the draft restored,
 * read again and cleared; what an object uses after a build and what uses
 * it on request; linked copies and templates.
 */
import { describe, expect, it } from 'vitest';
import type { TransportScanRow } from '../../lib/transport-read';
import { CHOICE_ANY, IDLIST, ONPAGE, parseIdList, TransportController } from '../transport-controller';
import { draftKey, toDraft } from '../transport-collection';
import { ENV, fakeWorker, flush, memoryStore, objectsResult, readOk, row, scanResult, underResult, type Sent } from './fakes';

const make = (w: ReturnType<typeof fakeWorker>, store?: ReturnType<typeof memoryStore>) => new TransportController({ ...w.deps, ...(store ? { store } : {}) }, { since: '2026-11-08' });
const ok = (m: Sent, type: string, over: Record<string, unknown>) => ({ type, requestId: m.requestId, environment: ENV, ok: true, ...over }) as never;
const findResult = (m: Sent, r?: TransportScanRow) => ok(m, 'TRANSPORT_FIND_RESULT', { address: m.address, ...(r ? { row: r } : { missing: true }) });

describe('the transport is a collection', () => {
  it('survives every search: a new search replaces the results, not the transport; rows in it show ticked', async () => {
    const a = row({ id: 'a_page' }), b = row({ id: 'b_card' });
    const w = fakeWorker(m => (m.type === 'TRANSPORT_SEARCH' ? ok(m, 'TRANSPORT_SEARCH_RESULT', { root: m.root, text: m.text, rows: m.root === 'portal' ? [b] : [] }) : scanResult(m, { rows: m.root === 'portal' ? [a] : [] })));
    const ctl = make(w);
    await ctl.scan();
    ctl.setTicked(a.rid, true);
    ctl.setScope('search');
    ctl.setQuery('card');
    await ctl.scan();
    expect(ctl.areas.flatMap(x => x.rows).map(r => r.id)).toEqual(['b_card']);
    expect(ctl.collection.list().map(i => i.row.id)).toEqual(['a_page']);
    ctl.setTicked(b.rid, true);
    expect(ctl.collection.list().map(i => i.row.id)).toEqual(['a_page', 'b_card']);
    // Unticking removes.
    ctl.setTicked(b.rid, false);
    expect(ctl.collection.size).toBe(1);
    // The area a row was found in is its place.
    expect(ctl.collection.get(a.rid)).toMatchObject({ area: 'portal', trail: [] });
  });

  it('the place of a row from its group: the rows above it, then its parent', async () => {
    const folder = row({ id: 'folder', name: 'Folder', parentRid: '1', parentId: 'PORTAL' });
    const child = row({ id: 'child', parentRid: folder.rid, parentId: 'folder' });
    const loose = row({ id: 'loose', parentRid: '77', parentId: 'cards', parentName: 'Cards' });
    const ctl = make(fakeWorker(m => scanResult(m, { rows: m.root === 'portal' ? [folder, child, loose] : [] })));
    await ctl.scan();
    ctl.setGroupTicked('portal', true);
    expect(ctl.collection.get(child.rid)!.trail).toEqual([{ id: 'folder', name: 'Folder' }]);
    expect(ctl.collection.get(loose.rid)!.trail).toEqual([{ id: 'cards', name: 'Cards' }]);
    expect(ctl.placeGroups().map(g => g.path.join(' › '))).toEqual(['Shared web', 'Shared web › Cards', 'Shared web › Folder']);
  });
});

describe('ways to find', () => {
  it('Search: the ticked areas, at least two characters, one request per area; a cut area says more', async () => {
    const w = fakeWorker(m => ok(m, 'TRANSPORT_SEARCH_RESULT', { root: m.root, text: m.text, rows: m.root === 'portal' ? [row({ id: 'risk_card' })] : [], ...(m.root === 'property' ? { more: true } : {}) }));
    const ctl = make(w);
    ctl.setScope('search');
    ctl.setQuery(' r ');
    expect(ctl.canScan()).toBe(false);
    ctl.setQuery(' risk ');
    expect(ctl.canScan()).toBe(true);
    await ctl.scan();
    const sent = w.sent.filter(m => m.type === 'TRANSPORT_SEARCH');
    expect(sent.map(m => m.root)).toEqual(['portal', 'templateCategory', 'property', 'expression', 'externalResource', 'transformer', 'defaults', 'page', 'nodeType', 'classConfig']);
    expect(sent[0]).toMatchObject({ environment: ENV, text: 'risk' });
    expect(ctl.searchedText).toBe('risk');
    expect(ctl.areas.find(a => a.root === 'property')!.more).toBe(true);
    // A search reads no rest.
    expect(ctl.canReadRest(ctl.areas.find(a => a.root === 'property')!)).toBe(false);
    // Nothing but the search is read.
    expect(w.sent.filter(m => m.type !== 'TRANSPORT_SEARCH')).toEqual([]);
  });

  it('ID list: addresses or IDs separated by spaces, commas or lines; each looked up once; unknown ones not found, others not IDs', async () => {
    expect(parseIdList('t.a, k.b\nc;  t.A  o.x x-y')).toEqual({ addresses: ['t.a', 'k.b', 't.c', 't.get("x-y")'], invalid: ['o.x'], more: false });
    // A .get form is one entry, spaces and separators in its quotes included.
    expect(parseIdList(`t.get("a b, c") k.get('d;e')`)).toEqual({ addresses: ['t.get("a b, c")', 'k.get("d;e")'], invalid: [], more: false });
    const found = row({ id: 'a' }), kpi = row({ id: 'b', className: 'Kpi' });
    const w = fakeWorker(m => findResult(m, m.address === 't.a' ? found : m.address === 'k.b' ? kpi : undefined));
    const ctl = make(w);
    ctl.setScope('ids');
    ctl.setIdText('t.a, k.b\nc o.x');
    await ctl.scan();
    expect(w.sent.map(m => [m.type, m.address])).toEqual([['TRANSPORT_FIND', 't.a'], ['TRANSPORT_FIND', 'k.b'], ['TRANSPORT_FIND', 't.c']]);
    const a = ctl.areas[0];
    expect([a.root, ctl.groupLabel(a), a.rows.map(r => r.id), a.notFound, a.invalid]).toEqual([IDLIST, 'ID list', ['b', 'a'], ['t.c'], ['o.x']]);
    ctl.setGroupTicked(IDLIST, true);
    expect(ctl.collection.size).toBe(2);
    // Nothing that reads as an ID: said, nothing sent.
    ctl.setIdText('o.x o.y');
    await ctl.scan();
    expect(ctl.error).toMatch(/^No IDs found/);
    expect(w.sent).toHaveLength(3);
  });

  it('This page: the RIDs from the page, then their rows 25 per request; Stop ends it', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ id: `w${i}` }));
    const w = fakeWorker(m => (m.type === 'TRANSPORT_PAGE_OBJECTS'
      ? ok(m, 'TRANSPORT_PAGE_OBJECTS_RESULT', { rids: rows.map(r => r.rid) })
      : ok(m, 'TRANSPORT_ROWS_RESULT', { rows: (m.rids as string[]).map(rid => ({ rid, row: rows.find(r => r.rid === rid)! })) })));
    const ctl = make(w);
    ctl.setScope('page');
    await ctl.scan();
    expect(w.sent.map(m => [m.type, (m.rids as string[] | undefined)?.length])).toEqual([['TRANSPORT_PAGE_OBJECTS', undefined], ['TRANSPORT_ROWS', 25], ['TRANSPORT_ROWS', 5]]);
    expect([ctl.areas[0].root, ctl.groupLabel(ctl.areas[0]), ctl.found()]).toEqual([ONPAGE, 'This page', 30]);
    // Stop between batches.
    const held = fakeWorker();
    const c2 = make(held);
    c2.setScope('page');
    const done = c2.scan();
    await flush();
    const p = held.pending.shift()!;
    p.resolve(ok(p.msg, 'TRANSPORT_PAGE_OBJECTS_RESULT', { rids: rows.map(r => r.rid) }));
    await flush();
    c2.stopScan();
    await done;
    expect(held.posted.map(m => m.type)).toEqual(['TRANSPORT_CANCEL']);
    expect(c2.outcome?.kind).toBe('stopped');
  });

  it('One tick is the object alone, also the origin of an object read in full', async () => {
    const module = row({ id: 'my_module', className: 'Category' });
    const tab = row({ id: 'my_tab', parentRid: module.rid });
    const ctl = make(fakeWorker(m => underResult(m, module, [tab])));
    ctl.setScope('under');
    ctl.setStart('my_module');
    await ctl.scan();
    ctl.setTicked(module.rid, true);
    expect(ctl.collection.rids()).toEqual([module.rid]);
    expect(ctl.collection.get(module.rid)!.whole).toBeUndefined();
  });
});

describe('the draft', () => {
  it('kept per workspace after each change, restored when the window opens; Clear removes it and Undo brings it back', async () => {
    const a = row({ id: 'a' });
    const store = memoryStore();
    const ctl = make(fakeWorker(m => scanResult(m, { rows: m.root === 'portal' ? [a] : [] })), store);
    await ctl.scan();
    ctl.setTicked(a.rid, true);
    await flush();
    const key = draftKey(ENV);
    expect(store.data[key]).toMatchObject({ v: 1, environment: ENV, items: [{ rid: a.rid }] });
    // Another window on the same workspace starts with it, without a request.
    const w2 = fakeWorker();
    const next = make(w2, store);
    await next.restoreDraft();
    expect(next.collection.list().map(i => i.row.id)).toEqual(['a']);
    expect(next.draftRestored).toBe(true);
    expect(w2.sent).toHaveLength(0);
    next.clearTransport();
    await flush();
    expect(store.data[key]).toBeUndefined();
    next.undoClear();
    await flush();
    expect(store.data[key]).toMatchObject({ items: [{ rid: a.rid }] });
  });

  it('Refresh reads the rows again by RID and marks the ones that are gone', async () => {
    const a = row({ id: 'a', name: 'Old' }), b = row({ id: 'b' });
    const store = memoryStore({
      [draftKey(ENV)]: toDraft(ENV, [a, b].map(r => ({ rid: r.rid, row: r, area: 'portal' as const, trail: [], readAt: '2026-11-14T09:00:00.000Z' })), '2026-11-14T09:00:00.000Z'),
    });
    const w = fakeWorker(m => ok(m, 'TRANSPORT_ROWS_RESULT', { rows: (m.rids as string[]).map(rid => (rid === a.rid ? { rid, row: { ...a, name: 'New' } } : { rid, missing: true })) }));
    const ctl = make(w, store);
    await ctl.restoreDraft();
    await ctl.refreshTransport();
    expect(w.sent.map(m => m.type)).toEqual(['TRANSPORT_ROWS']);
    expect(ctl.collection.get(a.rid)!.row).toMatchObject({ name: 'New' });
    expect(ctl.collection.get(b.rid)!.gone).toBe(true);
    expect(ctl.refresh).toMatchObject({ status: 'done', gone: 1 });
    // Gone objects are not read for a build.
    expect(ctl.transportItems().map(i => i.rid)).toEqual([a.rid]);
  });
});

describe('uses, used by, linked copies, templates', () => {
  async function built() {
    const page = row({ id: 'my_page' });
    const copy = row({ id: 'my_copy', linkedTo: 'tpl_card' });
    const tpl = row({ id: 'tpl_card', parentRid: '3', parentId: 'TEMPLATECATEGORY' });
    const texts: Record<string, string> = {
      [page.rid]: "t.my_page.change(id := 'my_page', kpi := k.my_kpi, card := t.tpl_card) //TextElement",
      [copy.rid]: "t.my_copy.change(name := 'Own') //TextElement",
      [tpl.rid]: "t.tpl_card.change(id := 'tpl_card') //TextElement",
    };
    const w = fakeWorker(m => {
      if (m.type === 'TRANSPORT_READ_OBJECTS') return objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, 'x', { genedit: texts[rid] })));
      if (m.type === 'TRANSPORT_USED_BY') return ok(m, 'TRANSPORT_USED_BY_RESULT', { rid: m.rid, users: [{ rid: page.rid, id: 'my_page', className: 'TextElement', name: 'Page' }], more: true });
      return scanResult(m, { rows: m.root === 'portal' ? [page, copy] : m.root === 'templateCategory' ? [tpl] : [] });
    });
    const ctl = make(w);
    await ctl.scan();
    ctl.setGroupTicked('portal', true);
    ctl.setGroupTicked('templateCategory', true);
    return { w, ctl, page, copy, tpl };
  }

  it('before a build an object uses nothing known; after it, its uses with their state; the map gets its right column', async () => {
    const { ctl, page, tpl } = await built();
    expect(ctl.usesOf(page.rid)).toBeNull();
    expect(ctl.mapModel().right).toEqual([]);
    ctl.setChoice(CHOICE_ANY);
    await ctl.buildBundle();
    expect(ctl.usesOf(page.rid)!.map(u => [u.address, u.state, u.rid])).toEqual([['k.my_kpi', 'unknown', undefined], ['t.tpl_card', 'transport', tpl.rid]]);
    expect(ctl.mapModel().right.map(r => [r.kind, r.keys])).toEqual([['properties', ['k.my_kpi']]]);
  });

  it('a linked copy is never added; templates get the warning in scripts without comparison; nothing counts the copies', async () => {
    const { w, ctl, copy, tpl } = await built();
    ctl.setChoice(CHOICE_ANY);
    await ctl.buildBundle();
    const b = ctl.bundle!;
    expect(b.inputs!.find(i => i.rid === copy.rid)).toMatchObject({ linkedTo: 'tpl_card', isNew: false });
    expect(b.inputs!.find(i => i.rid === tpl.rid)).toMatchObject({ template: true });
    expect(w.sent.filter(m => m.type === 'TRANSPORT_READ_OBJECTS').flatMap(m => (m.creation as string[] | undefined) ?? [])).not.toContain(copy.rid);
    expect(b.result!.warnings.some(x => x.kind === 'template')).toBe(true);
    expect(ctl.templates().map(i => i.rid)).toEqual([tpl.rid]);
    expect(w.sent.map(m => m.type).filter(t => t !== 'TRANSPORT_SCAN' && t !== 'TRANSPORT_READ_OBJECTS')).toEqual([]);
  });

  it('"Find what uses this": one read for one object, on request; never run by itself', async () => {
    const { w, ctl, tpl } = await built();
    ctl.setChoice(CHOICE_ANY);
    await ctl.buildBundle();
    expect(w.sent.some(m => m.type === 'TRANSPORT_USED_BY')).toBe(false);
    await ctl.readUsedBy(tpl.rid);
    expect(w.sent.filter(m => m.type === 'TRANSPORT_USED_BY').map(m => m.rid)).toEqual([tpl.rid]);
    expect(ctl.usedBy.get(tpl.rid)).toMatchObject({ status: 'done', more: true, users: [{ id: 'my_page' }] });
  });
});
