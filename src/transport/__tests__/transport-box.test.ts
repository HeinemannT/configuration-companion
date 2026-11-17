/**
 * Find's one box: what the text means (a list, an exact ID, words that must
 * all match), the order inside an area under a fixed order of areas, the
 * labels of the buttons, a search that waits for a pause and aborts an older
 * one, and a folder taken whole (its count, what is left out, the draft, the
 * read at every comparison).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHOICE_ANY, TransportController } from '../transport-controller';
import { draftKey, linesText, readDraft, toDraft, transportLines, type CollectionItem } from '../transport-collection';
import {
  AREA_ORDER, areasValue, changedValue, holdsWords, isIdList, looksLikeId, rankOf, readBox, rowMatches, shortDay, sinceDay, subLabel, wordsOf,
} from '../transport-model';
import { belowResult, childrenResult, countsResult, ENV, fakeWorker, flush, memoryStore, objectsResult, readOk, row, rowsResult, scanResult, underResult, type Sent } from './fakes';

const make = (w: ReturnType<typeof fakeWorker>, store?: ReturnType<typeof memoryStore>) => new TransportController({ ...w.deps, ...(store ? { store } : {}) }, { since: '2026-11-08' });
const ok = (m: Sent, type: string, over: Record<string, unknown>) => ({ type, requestId: m.requestId, environment: ENV, ok: true, ...over }) as never;

afterEach(() => { vi.useRealTimers(); });

describe('what the box holds', () => {
  it('is an ID list only with a comma or a line break, or with several words that are all IDs or addresses', () => {
    expect(isIdList('swi_home, ceRiskAssessment.riskOwner')).toBe(true);
    expect(isIdList('a\nb')).toBe(true);
    expect(isIdList('risk, review')).toBe(true);
    expect(isIdList('risk,')).toBe(true);
    expect(isIdList('swi_home swi_risk')).toBe(true);
    expect(isIdList('t.a t.b')).toBe(true);
    expect(isIdList('ceRisk ceIssue')).toBe(true);
    expect(isIdList('1043877712044 1043877712301')).toBe(true);
    // Words, one of them not an ID: a text search where all words must match.
    expect(isIdList('risk review')).toBe(false);
    expect(isIdList('swi_home risk')).toBe(false);
    expect(isIdList('Home page')).toBe(false);
    expect(isIdList('swi_home')).toBe(false);
    expect(isIdList(',')).toBe(false);
    expect(isIdList('  ')).toBe(false);
    expect(['swi_home', 't.x', 'ceRisk', 'a.b', '77'].map(looksLikeId)).toEqual([true, true, true, true, true]);
    expect(['risk', 'Home', 'portal'].map(looksLikeId)).toEqual([false, false, false]);
  });

  it('reads the box: nothing under two characters, a list, or words with the longest searched and a single word tried as an ID', () => {
    expect(readBox('r')).toEqual({ kind: 'none' });
    expect(readBox('  a b ')).toEqual({ kind: 'none' });
    expect(readBox('swi_a, swi_b')).toEqual({ kind: 'ids', text: 'swi_a, swi_b' });
    expect(readBox('risk')).toEqual({ kind: 'words', words: ['risk'], longest: 'risk', single: 'risk' });
    expect(readBox('t.swi_home')).toEqual({ kind: 'words', words: ['swi_home'], longest: 'swi_home', single: 't.swi_home' });
    expect(readBox('Risk review of it')).toEqual({ kind: 'words', words: ['risk', 'review', 'of', 'it'], longest: 'review', single: null });
  });

  it('every word must be in the ID or the name, not in the class', () => {
    const r = row({ id: 'swi_risk_review', name: 'Quarterly check', className: 'Scorecard' });
    expect(wordsOf('Risk  t.review')).toEqual(['risk', 'review']);
    expect(holdsWords(r, ['risk', 'quarterly'])).toBe(true);
    expect(holdsWords(r, ['risk', 'missing'])).toBe(false);
    expect(holdsWords(r, ['scorecard'])).toBe(false);
    expect(rowMatches(r, { text: 'risk check', user: '', newOnly: false }, '')).toBe(true);
    expect(rowMatches(r, { text: 'risk scorecard', user: '', newOnly: false }, '')).toBe(false);
  });

  it('ranks the exact ID, then an ID that starts with the text, then the name, then the rest', () => {
    const rank = (id: string, name: string, words: string[]) => rankOf({ id, name }, words);
    expect([rank('risk', 'x', ['risk']), rank('risk_one', 'x', ['risk']), rank('b', 'Risk register', ['risk']), rank('a_risk', 'Zed', ['risk'])]).toEqual([0, 1, 2, 3]);
  });
});

describe('what a button says', () => {
  it('Changed shows its value; Areas the count or the only area', () => {
    const now = new Date(2026, 10, 17);
    expect(changedValue('any', '', '', false, now)).toBe('any date');
    expect(changedValue('7d', '2026-11-10', '', false, now)).toBe('7 days');
    expect(changedValue('today', '2026-11-17', 'tassilo', false, now)).toBe('today, tassilo');
    expect(changedValue('30d', '2026-10-18', '', true, now)).toBe('30 days, new only');
    expect(changedValue('last', '2026-11-12', '', false, now)).toBe('since 12 Nov');
    expect(changedValue('custom', '2025-03-01', 'admin', true, now)).toBe('since 1 Mar 2025, admin, new only');
    expect(shortDay('2026-11-12', now)).toBe('12 Nov');
    expect(areasValue(new Set(AREA_ORDER.slice(0, 10)))).toBe('10');
    expect(areasValue(new Set(['role'] as const))).toBe('Roles');
    expect(areasValue(new Set())).toBe('0');
    expect([sinceDay('any', now, null, ''), sinceDay('today', now, null, ''), sinceDay('7d', now, null, ''), sinceDay('30d', now, null, ''), sinceDay('last', now, '2026-11-12', ''), sinceDay('last', now, null, ''), sinceDay('custom', now, null, '2026-01-02')])
      .toEqual(['', '2026-11-17', '2026-11-10', '2026-10-18', '2026-11-12', '', '2026-01-02']);
  });

  it('the end button says everything under it without a filter, matches with one, and a folder taken whole says how many are in', () => {
    expect(subLabel({ mode: 'all', count: 48 })).toBe('+ 48 under it');
    expect(subLabel({ mode: 'all' })).toBe('+ under it');
    expect(subLabel({ mode: 'area', count: 21 })).toBe('All 21');
    expect(subLabel({ mode: 'hits', count: 12, done: false })).toBe('+ 12 matches');
    expect(subLabel({ mode: 'hits', count: 1, done: false })).toBe('+ 1 match');
    expect(subLabel({ mode: 'hits', count: 8, done: true })).toBe('All 8 matches');
    expect(subLabel({ mode: 'whole', total: 7, taken: 7 })).toBe('All 7 under it');
    expect(subLabel({ mode: 'whole', total: 7, taken: 6 })).toBe('All 6 of 7 under it');
  });
});

describe('the order of a search', () => {
  it('areas keep their fixed order; inside an area the exact ID comes first, then IDs that start with the text, then names', async () => {
    const weak = row({ id: 'a_risk', name: 'Zed' });
    const byName = row({ id: 'b', name: 'Risk register' });
    const start = row({ id: 'risk_one', name: 'One' });
    const exact = row({ id: 'risk', name: 'Risk' });
    const tpl = row({ id: 'risk_template' });
    const w = fakeWorker(m => (m.type === 'TRANSPORT_SEARCH'
      ? ok(m, 'TRANSPORT_SEARCH_RESULT', { root: m.root, text: m.text, rows: m.root === 'portal' ? [weak, byName, start, exact] : m.root === 'templateCategory' ? [tpl] : [] })
      : underResult(m, null)));
    const ctl = make(w);
    ctl.setBox('risk');
    await ctl.refind();
    // A single word is also tried as an ID (its group first); the areas follow in their fixed order.
    expect(ctl.areas.map(a => a.root)).toEqual(['under', ...AREA_ORDER.slice(0, 10)]);
    const order = (root: string) => ctl.groupTree(ctl.areas.find(a => a.root === root)!).tops.map(n => n.id);
    expect(order('portal')).toEqual(['risk', 'risk_one', 'b', 'a_risk']);
    expect(order('templateCategory')).toEqual(['risk_template']);
  });

  it('several words: the longest is searched, only rows holding every word stay', async () => {
    const both = row({ id: 'swi_risk_review', name: 'Review' });
    const one = row({ id: 'swi_review', name: 'Review' });
    const w = fakeWorker(m => (m.type === 'TRANSPORT_SEARCH' ? ok(m, 'TRANSPORT_SEARCH_RESULT', { root: m.root, text: m.text, rows: m.root === 'portal' ? [both, one] : [] }) : scanResult(m)));
    const ctl = make(w);
    ctl.setBox('risk review');
    await ctl.refind();
    const sent = w.sent.filter(m => m.type === 'TRANSPORT_SEARCH');
    expect(new Set(sent.map(m => m.text))).toEqual(new Set(['review']));
    expect(ctl.visibleRows(ctl.areas[0]).map(r => r.id)).toEqual(['swi_risk_review']);
    expect(ctl.found()).toBe(2);
  });

  it('a single ID typed alone also opens that object with what is under it, once', async () => {
    const home = row({ id: 'swi_home', name: 'Home' });
    const kid = row({ id: 'swi_home_kpis', name: 'Key figures', parentRid: home.rid });
    const w = fakeWorker(m => (m.type === 'TRANSPORT_SEARCH' ? ok(m, 'TRANSPORT_SEARCH_RESULT', { root: m.root, text: m.text, rows: m.root === 'portal' ? [home, kid] : [] }) : underResult(m, home, [kid])));
    const ctl = make(w);
    ctl.setBox('t.swi_home');
    await ctl.refind();
    expect(w.sent[0]).toMatchObject({ type: 'TRANSPORT_SCAN_UNDER', start: 't.swi_home' });
    expect(ctl.areas.map(a => a.root).slice(0, 2)).toEqual(['under', 'portal']);
    // What is under it is shown once, in its group, whatever the text says.
    expect(ctl.areas.find(a => a.root === 'portal')!.rows).toEqual([]);
    expect(ctl.visibleRows(ctl.areas[0]).map(r => r.id)).toEqual(['swi_home', 'swi_home_kpis']);
  });
});

describe('a search waits for a pause and an older one is aborted', () => {
  it('starts 300 ms after the last key, from two characters; a newer search aborts the older one', async () => {
    vi.useFakeTimers();
    const w = fakeWorker();
    const ctl = make(w);
    ctl.setBox('a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.sent).toHaveLength(0);
    ctl.setBox('ab cd');
    await vi.advanceTimersByTimeAsync(299);
    ctl.setBox('ab cde');
    await vi.advanceTimersByTimeAsync(299);
    expect(w.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.pending).toHaveLength(1);
    expect(w.pending[0].msg).toMatchObject({ type: 'TRANSPORT_SEARCH', root: 'portal', text: 'cde' });
    const first = w.pending[0];
    ctl.setBox('ab cdef');
    await vi.advanceTimersByTimeAsync(300);
    // The first request was cancelled and its answer is not used.
    expect(first.signal.aborted).toBe(true);
    expect(w.posted.map(m => m.type)).toEqual(['TRANSPORT_CANCEL']);
    expect(w.pending.at(-1)!.msg).toMatchObject({ type: 'TRANSPORT_SEARCH', root: 'portal', text: 'cdef' });
    expect(ctl.searchedText).toBe('ab cdef');
    ctl.dispose();
  });

  it('with a date set, the text only narrows the rows read: no new request', async () => {
    const a = row({ id: 'swi_risk' }), b = row({ id: 'swi_other' });
    const w = fakeWorker(m => scanResult(m, { rows: m.root === 'portal' ? [a, b] : [] }));
    const ctl = make(w);
    ctl.setChanged('7d');
    await flush(80);
    const reads = w.sent.length;
    expect(reads).toBe(10);
    ctl.setBox('risk');
    await flush();
    expect(w.sent).toHaveLength(reads);
    expect(ctl.visibleRows(ctl.areas[0]).map(r => r.id)).toEqual(['swi_risk']);
    // The box and the date cleared: the tree again, nothing of the results kept.
    ctl.setBox('');
    ctl.clearChanged();
    await flush();
    expect(ctl.findMode).toBe('browse');
    expect(ctl.areas).toEqual([]);
  });
});

describe('a folder taken whole', () => {
  const folder = row({ id: 'swi_risk', name: 'Risk', parentRid: '9007199254740001', parentId: 'PORTAL' });
  const a = row({ id: 'swi_risk_register', parentRid: folder.rid, sortIndex: 0 });
  const b = row({ id: 'swi_risk_review', parentRid: folder.rid, sortIndex: 1 });
  const auto = row({ id: '1043877712044', parentRid: folder.rid, sortIndex: 2 });
  const loose = row({ id: 'loose_one' }), loose2 = row({ id: 'loose_two' });
  let under = [a, b, auto];
  const answer = (m: Sent) => (m.type === 'TRANSPORT_SCAN_BELOW' ? belowResult(m, folder, under)
    : m.type === 'TRANSPORT_CHILDREN' ? childrenResult(m, m.root === 'portal' ? [folder, loose, loose2] : m.rid === folder.rid ? under : [])
      : m.type === 'TRANSPORT_ROWS' ? rowsResult(m, [folder, loose, loose2, ...under])
        : m.type === 'TRANSPORT_COUNTS' ? countsResult(m, {})
          : m.type === 'TRANSPORT_READ_OBJECTS' ? objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, [folder, loose, loose2, ...under].find(r => r.rid === rid)!.id)))
            : scanResult(m));

  async function taken(store?: ReturnType<typeof memoryStore>) {
    under = [a, b, auto];
    const w = fakeWorker(answer);
    const ctl = make(w, store);
    ctl.toggleBrowse('a:portal');
    await flush(60);
    ctl.toggleBrowse(folder.rid);
    await flush(60);
    await ctl.takeAll(folder.rid);
    return { w, ctl };
  }

  it('is one line: the objects under it are part of it, an ID BMP assigned is left out; footer text and count', async () => {
    const { ctl } = await taken();
    expect(ctl.collection.rids().sort()).toEqual([folder.rid, a.rid, b.rid].sort());
    expect(ctl.collection.get(folder.rid)!.whole).toEqual({ address: 't.swi_risk', ids: ['swi_risk', 'swi_risk_register', 'swi_risk_review', '1043877712044'], rids: [folder.rid, a.rid, b.rid, auto.rid], leftOut: [auto.rid] });
    expect(ctl.lines()).toEqual({ objects: 0, folders: 1 });
    expect(ctl.underCount(ctl.wholeFolder(folder.rid)!)).toEqual({ total: 3, taken: 2 });
    expect([ctl.coveredBy(a.rid), ctl.coveredBy(folder.rid), ctl.coveredBy(auto.rid)]).toEqual([true, false, false]);
    ctl.setTicked(loose.rid, true);
    ctl.setTicked(loose2.rid, true);
    expect(linesText(ctl.lines())).toBe('2 objects and 1 folder in the transport');
    expect(linesText({ objects: 12, folders: 2 })).toBe('12 objects and 2 folders in the transport');
    expect(linesText({ objects: 0, folders: 0 })).toBe('Nothing in the transport');
  });

  it('unticking one object inside keeps the folder as one line and records it as left out; ticking it again takes it back', async () => {
    const { ctl } = await taken();
    ctl.setTicked(b.rid, false);
    expect(ctl.lines()).toEqual({ objects: 0, folders: 1 });
    expect(ctl.collection.has(b.rid)).toBe(false);
    expect(ctl.collection.get(folder.rid)!.whole!.leftOut).toEqual([auto.rid, b.rid]);
    expect(ctl.underCount(ctl.wholeFolder(folder.rid)!)).toEqual({ total: 3, taken: 1 });
    ctl.setTicked(b.rid, true);
    expect(ctl.collection.get(folder.rid)!.whole!.leftOut).toEqual([auto.rid]);
    expect(ctl.coveredBy(b.rid)).toBe(true);
    // The folder itself leaves with everything under it.
    ctl.releaseWhole(folder.rid);
    expect(ctl.collection.size).toBe(0);
  });

  it('is read again at every comparison: what was added comes along, what was left out stays out, what is gone goes', async () => {
    const { w, ctl } = await taken();
    ctl.setTicked(b.rid, false);
    const fresh = row({ id: 'swi_risk_new', parentRid: folder.rid, sortIndex: 3 });
    const freshAuto = row({ id: '1043877712999', parentRid: folder.rid, sortIndex: 4 });
    under = [a, b, auto, fresh, freshAuto];
    ctl.setChoice(CHOICE_ANY);
    const sentBefore = w.sent.length;
    await ctl.buildBundle();
    expect(w.sent.slice(sentBefore)[0]).toMatchObject({ type: 'TRANSPORT_SCAN_BELOW', rid: folder.rid, since: '' });
    expect(ctl.collection.has(fresh.rid)).toBe(true);
    expect(ctl.collection.has(freshAuto.rid)).toBe(false);
    expect(ctl.collection.has(b.rid)).toBe(false);
    expect(ctl.collection.get(folder.rid)!.whole!.leftOut!.sort()).toEqual([auto.rid, b.rid, freshAuto.rid].sort());
    expect(ctl.bundle!.rids).toEqual([folder.rid, a.rid, fresh.rid]);
    // One of them deleted on the workspace: it is not in the folder any more.
    under = [b, auto];
    await ctl.buildBundle();
    expect(ctl.collection.has(a.rid)).toBe(false);
    expect(ctl.collection.get(folder.rid)!.whole!.rids).toEqual([folder.rid, b.rid, auto.rid]);
  });

  it('the draft keeps it with what was left out; a draft from before, without a left-out list, is still read', async () => {
    const store = memoryStore();
    const { ctl } = await taken(store);
    ctl.setTicked(b.rid, false);
    await flush();
    const next = make(fakeWorker(), store);
    await next.restoreDraft();
    expect(next.collection.get(folder.rid)!.whole!.leftOut).toEqual([auto.rid, b.rid]);
    expect(next.lines()).toEqual({ objects: 0, folders: 1 });
    expect(next.collection.has(b.rid)).toBe(false);
    // From before: the same folder without a left-out list.
    const items = ctl.collection.list().map((i): CollectionItem => (i.whole ? { ...i, whole: { address: i.whole.address, ids: i.whole.ids, rids: i.whole.rids } } : i));
    const old = readDraft(JSON.parse(JSON.stringify(toDraft(ENV, items, '2026-11-14T10:00:00.000Z'))), ENV)!;
    expect(old.find(i => i.rid === folder.rid)!.whole).toEqual({ address: 't.swi_risk', ids: expect.any(Array), rids: [folder.rid, a.rid, b.rid, auto.rid] });
    expect(transportLines(old)).toMatchObject({ objects: 0, folders: 1 });
    expect(store.data[draftKey(ENV)]).toBeDefined();
  });
});
