// @vitest-environment happy-dom
/**
 * The Transport window's view over a controller with a fake worker.
 *
 *  - Find: the tabs, the one box and its three buttons (Changed, Areas,
 *    This page), Stop while something is read, the tree of areas read as it
 *    opens, folders taken whole, group notes and tags (a linked copy, an auto
 *    ID), the count in the footer and the tab, result trees with their carets
 *    and "+ n matches", reading the rest.
 *  - Transport: the empty sentence, the list by place, remove, a row that
 *    opens in place, scripts without comparison with what the objects use,
 *    "Find what uses this", the pasted comparison with its answer field,
 *    the map, the template line, the draft line with Refresh and Clear.
 *  - The transport log.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CHOICE_ANY, CHOICE_PASTE, TransportController } from '../transport-controller';
import { draftKey, toDraft } from '../transport-collection';
import {
  BUILD_TO_SEE, closeWherePopover, NOT_SEARCHED, NOT_TRANSPORTED, NOTHING_USES, COMPARE_TO_SEE, EMPTY_TRANSPORT, TRANSPORT_PURPOSE, DRAFT_NOTE, TARGET_DEFAULT_TITLE, mountTransportView, NUMERIC_ID_TITLE, PROBE_LEAD,
} from '../transport-view';
import {
  belowResult, childrenResult, countsResult, ENV, fakeWorker, flush, HOLD, logResult, memoryStore, objectsResult, patchCase, probeAnswer, readOk, row, rowsResult, scanResult, underResult, type FakeWorker, type Sent,
} from './fakes';

const SINCE = '2026-11-08';
const NOW = () => new Date(2026, 10, 15, 12, 0, 0);

function setup(answer?: FakeWorker['answer'], store?: ReturnType<typeof memoryStore>) {
  const w = fakeWorker(answer);
  const ctl = new TransportController({ ...w.deps, ...(store ? { store } : {}) }, { since: SINCE });
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const copies: string[] = [];
  const downloads: Array<{ name: string; text: string }> = [];
  const view = mountTransportView(host, ctl, {
    now: NOW,
    copy: async text => { copies.push(text); return true; },
    download: (name, text) => { downloads.push({ name, text }); },
  });
  const $ = <T extends Element = HTMLElement>(s: string) => host.querySelector<T>(s);
  const $$ = <T extends Element = HTMLElement>(s: string) => [...host.querySelectorAll<T>(s)];
  const tick = (rid: string, on = true) => {
    const box = $<HTMLInputElement>(`.tr-ck[data-rid="${rid}"]`)!;
    box.checked = on;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { w, ctl, host, view, copies, downloads, $, $$, tick };
}

const ok = (m: Sent, type: string, over: Record<string, unknown>) => ({ type, requestId: m.requestId, environment: ENV, ok: true, ...over }) as never;

describe('tabs and the one box', () => {
  it('opens on Find: one box and three buttons, no Find button and no way to choose; Stop is hidden', () => {
    const { $, $$ } = setup();
    expect($$('.tr-tab').map(t => [t.textContent, t.getAttribute('aria-selected')])).toEqual([['Find', 'true'], ['Transport', 'false']]);
    expect($('.tr-find')!.hidden).toBe(false);
    expect($('.tr-transport')!.hidden).toBe(true);
    expect($<HTMLInputElement>('.tr-q')!.placeholder).toBe('ID or name, or paste IDs');
    expect([$('.tr-changed')!.textContent, $('.tr-where')!.textContent, $('.tr-page')!.textContent]).toEqual(['Changed: any date', 'Areas: 10', 'This page']);
    for (const gone of ['.tr-go', '.tr-scope', '.tr-start', '.tr-query', '.tr-ids', '.tr-usince']) expect($(gone), gone).toBeNull();
    expect($('.tr-stop')!.hidden).toBe(true);
    expect($('.tr-selcount')!.textContent).toBe('Nothing in the transport');
    expect($<HTMLButtonElement>('.tr-open')!.disabled).toBe(true);
  });

  it('the Changed menu: presets, since the last transport only when there is one, a date, By and New only after a day; a clear control', async () => {
    const store = memoryStore();
    const { $, $$, ctl, w } = setup(m => scanResult(m, { rows: [] }), store);
    $<HTMLButtonElement>('.tr-changed')!.click();
    expect($('.pop-changed')!.hidden).toBe(false);
    expect($$('.tr-sinceseg button').filter(b => !b.hidden).map(b => b.textContent)).toEqual(['Any date', 'Today', '7 days', '30 days']);
    expect($<HTMLSelectElement>('.tr-user')!.disabled).toBe(true);
    expect($('.tr-changedclear')!.hidden).toBe(true);
    $<HTMLButtonElement>('.tr-sinceseg button[data-since="7d"]')!.click();
    await flush(80);
    expect($('.tr-changed')!.textContent).toBe('Changed: 7 days');
    expect($<HTMLInputElement>('.tr-since')!.value).toBe('2026-11-08');
    expect($<HTMLSelectElement>('.tr-user')!.disabled).toBe(false);
    expect(w.sent.filter(m => m.type === 'TRANSPORT_SCAN').map(m => m.since)).toEqual(Array(10).fill('2026-11-08'));
    // A date typed in.
    const date = $<HTMLInputElement>('.tr-since')!;
    date.value = '2026-11-01';
    date.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect($('.tr-changed')!.textContent).toBe('Changed: since 1 Nov');
    // New only joins the value.
    $<HTMLButtonElement>('.tr-new')!.click();
    expect($('.tr-changed')!.textContent).toBe('Changed: since 1 Nov, new only');
    $<HTMLButtonElement>('.tr-changedclear')!.click();
    await flush();
    expect([$('.tr-changed')!.textContent, ctl.filters.newOnly]).toEqual(['Changed: any date', false]);
    expect($('.tr-changedclear')!.hidden).toBe(true);
    expect(ctl.findMode).toBe('browse');
    // The day of the last apply kept for this workspace.
    ctl.lastApply = { at: new Date(2026, 10, 12, 20).toISOString() } as never;
    ctl.setChanged('last');
    await flush();
    expect($('.tr-changed')!.textContent).toBe('Changed: since 12 Nov');
    expect($$('.tr-sinceseg button').filter(b => !b.hidden).map(b => b.textContent)).toContain('Since the last transport');
  });

  it('the Areas menu: plain labels, defaults ticked, opt-in ones after a divider; a clear control when it is not the default', () => {
    const { $, $$, host, ctl } = setup();
    $<HTMLButtonElement>('.tr-where')!.click();
    expect($('.pop-areas')!.hidden).toBe(false);
    const labels = $$('.pop-areas > *').map(e => (e.classList.contains('tr-pop-sep') ? '|' : e.textContent));
    expect(labels).toEqual(['Shared web', 'Templates', 'Properties', 'Expressions', 'External resources', 'Transformers', 'Defaults', 'Pages', 'Node types', 'Visibility rules', '|',
      'Notifications', 'Roles', 'Access profiles', 'Access policies', NOT_TRANSPORTED]);
    expect($('.pop-areas > :last-child')!.className).toBe('tr-pop-note');
    expect(NOT_TRANSPORTED).toBe('Not transported: Process Management, custom periods, organisations and their linked copies.');
    expect($('.tr-areasclear')!.hidden).toBe(true);
    const roles = $$<HTMLInputElement>('.tr-area-ck').find(b => b.dataset.root === 'role')!;
    roles.checked = true;
    roles.dispatchEvent(new Event('change', { bubbles: true }));
    expect($('.tr-where')!.textContent).toBe('Areas: 11');
    expect($('.tr-areasclear')!.hidden).toBe(false);
    expect(closeWherePopover(host)).toBe(true);
    expect($('.pop-areas')!.hidden).toBe(true);
    $<HTMLButtonElement>('.tr-areasclear')!.click();
    expect([$('.tr-where')!.textContent, ctl.defaultAreas]).toEqual(['Areas: 10', true]);
  });

  it('a search by text: matches counted in areas; Stop while it runs; a cut area says so', async () => {
    vi.useFakeTimers();
    try {
      const { $, ctl, w } = setup(m => (m.type === 'TRANSPORT_SEARCH' ? ok(m, 'TRANSPORT_SEARCH_RESULT', { root: m.root, text: m.text, rows: m.root === 'portal' ? [row({ id: 'risk_card' })] : [], ...(m.root === 'portal' ? { more: true } : {}) }) : underResult(m, null)));
      const q = $<HTMLInputElement>('.tr-q')!;
      q.value = 'risk';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      expect(w.sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(300);
      // A single word that can be an ID is also looked up as one.
      await vi.advanceTimersByTimeAsync(10);
      expect(w.sent.slice(0, 2)).toMatchObject([{ type: 'TRANSPORT_SCAN_UNDER', start: 't.risk' }, { type: 'TRANSPORT_SEARCH', root: 'portal', text: 'risk' }]);
      expect($('.tr-find .tr-status')!.textContent).toBe('1 match in 1 area');
      expect($('.tr-grp[data-root="portal"] .tr-gnote')!.textContent).toBe('More than 500 matches: make the text longer');
      expect(ctl.findMode).toBe('results');
    } finally { vi.useRealTimers(); }
  });

  it('Stop shows only while something is read, and stops it', async () => {
    const { $, w, ctl } = setup();
    ctl.setBox('ab cd');
    void ctl.refind();
    await flush();
    expect($('.tr-stop')!.hidden).toBe(false);
    expect($('.tr-find .tr-status')?.textContent).toBe('Reading Shared web · 1 of 10 · 0 found');
    const p = w.pending.shift()!;
    p.resolve({ type: 'TRANSPORT_SEARCH_RESULT', requestId: p.msg.requestId, environment: ENV, root: 'portal', text: 'ab', ok: true, rows: [row(), row()] } as never);
    await flush();
    expect($('.tr-find .tr-status')?.textContent).toBe('Reading Templates · 2 of 10 · 2 found');
    $<HTMLButtonElement>('.tr-stop')!.click();
    await flush();
    expect(w.posted.map(m => m.type)).toEqual(['TRANSPORT_CANCEL']);
    expect($('.tr-stop')!.hidden).toBe(true);
    expect($('.tr-find .tr-status')?.textContent).toBe('Stopped after 1 of 10 areas · 2 found');
  });

  it('a pasted list: the group "ID list" with what was not found and what is no ID; Add the n found', async () => {
    const found = row({ id: 'a' });
    const { $, ctl, host } = setup(m => ok(m, 'TRANSPORT_FIND_RESULT', { address: m.address, ...(m.address === 't.a' ? { row: found } : { missing: true }) }));
    const q = $<HTMLInputElement>('.tr-q')!;
    // Lines pasted into the box become one line of IDs separated by commas.
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } };
    paste.clipboardData = { getData: () => 't.a\nt.b\no.c' };
    q.dispatchEvent(paste);
    expect(q.value).toBe('t.a, t.b, o.c');
    expect(paste.defaultPrevented).toBe(true);
    await ctl.refind();
    await flush();
    expect($('.tr-grp .tr-gt .t')!.textContent).toBe('ID list');
    expect([...$('.tr-grp')!.querySelectorAll('.tr-gnote')].map(n => n.textContent)).toEqual(['Not found: t.b', 'Not IDs: o.c']);
    expect($('.tr-find .tr-status')!.textContent).toBe('1 of 2 foundAdd the 1 found');
    expect(host.querySelectorAll('.tr-selcount')[0].textContent).toBe('Nothing in the transport');
    $<HTMLButtonElement>('.tr-addfound')!.click();
    expect($('.tr-selcount')!.textContent).toBe('1 object in the transport');
  });

  it('a request the worker refused shows one line, not an empty screen', async () => {
    const { $, ctl } = setup(msg => scanResult(msg, { ok: false, rows: undefined, error: 'This request is not accepted from a page.' }));
    ctl.setChanged('7d');
    await flush();
    expect($('.tr-find .tr-status')?.classList.contains('err')).toBe(true);
    expect($('.tr-find .tr-status')?.textContent).toBe('This request is not accepted from a page.');
  });

  it('This page is a button that shows the objects of the page as a result; pressing it again, or its clear control, returns to the tree', async () => {
    const onPage = row({ id: 'on_page' });
    const { $, ctl } = setup(m => (m.type === 'TRANSPORT_PAGE_OBJECTS' ? ok(m, 'TRANSPORT_PAGE_OBJECTS_RESULT', { rids: [onPage.rid] }) : m.type === 'TRANSPORT_ROWS' ? rowsResult(m, [onPage]) : scanResult(m)));
    $<HTMLButtonElement>('.tr-page')!.click();
    expect($('.tr-page')!.getAttribute('aria-pressed')).toBe('true');
    expect($('.tr-pageclear')!.hidden).toBe(false);
    await flush(40);
    expect($('.tr-grp .tr-gt .t')!.textContent).toBe('This page');
    expect($('.tr-find .tr-status')!.textContent).toBe('1 object on this page');
    $<HTMLButtonElement>('.tr-page')!.click();
    await flush();
    expect([ctl.onPage, ctl.findMode, $('.tr-pageclear')!.hidden]).toEqual([false, 'browse', true]);
  });
});

describe('the tree', () => {
  const folder = row({ id: 'swi_home', name: 'Home', className: 'Scorecard', parentRid: '9007199254740001', parentId: 'PORTAL' });
  const a = row({ id: 'swi_home_kpis', name: 'Key figures', parentRid: folder.rid, sortIndex: 0 });
  const b = row({ id: 'swi_home_news', name: 'News', parentRid: folder.rid, sortIndex: 1 });
  const auto = row({ id: '1043877712044', name: 'Banner', parentRid: folder.rid, sortIndex: 2 });
  const known = [folder, a, b, auto];
  const counts = (m: Sent) => countsResult(m, m.roots ? Object.fromEntries((m.roots as string[]).map(r => [r, 21])) : Object.fromEntries((m.rids as string[]).map(r => [r, r === folder.rid ? 3 : 0])));
  const answer = (m: Sent) => (m.type === 'TRANSPORT_COUNTS' ? counts(m)
    : m.type === 'TRANSPORT_CHILDREN' ? childrenResult(m, m.root === 'portal' ? [folder] : m.rid === folder.rid ? [a, b, auto] : [])
      : m.type === 'TRANSPORT_ROWS' ? rowsResult(m, known)
        : m.type === 'TRANSPORT_SCAN_BELOW' ? belowResult(m, folder, [a, b, auto])
          : scanResult(m));

  async function opened() {
    const s = setup(answer);
    s.ctl.startBrowse();
    await flush(40);
    return s;
  }

  it('the areas are collapsed rows with their counts, in the fixed order; "All 21" on each', async () => {
    const { $, $$, w } = await opened();
    expect($$('.tr-grp.browse').map(g => g.dataset.root)).toEqual(['portal', 'templateCategory', 'property', 'expression', 'externalResource', 'transformer', 'defaults', 'page', 'nodeType', 'classConfig']);
    expect($('.tr-grp.browse .tr-gt')!.textContent).toBe('Shared web21');
    expect($('.tr-grp.browse .tr-gh .tr-sub')!.textContent).toBe('All 21');
    expect($$('.tr-row')).toHaveLength(0);
    expect(w.sent.map(m => m.type)).toEqual(['TRANSPORT_COUNTS']);
    expect(w.sent[0].roots).toHaveLength(10);
  });

  it('opening an area reads its children once, with a Reading line; a count follows the rows; the row says n under it', async () => {
    const { $, $$, w, ctl } = await opened();
    w.answer = m => (m.type === 'TRANSPORT_COUNTS' ? HOLD : answer(m));
    $<HTMLButtonElement>('.tr-grp.browse .tr-gt')!.click();
    expect($('.tr-grp.browse .tr-note')!.textContent).toBe('Reading');
    await flush(40);
    expect($$('.tr-row').map(r => r.querySelector('.tr-id')!.textContent)).toEqual(['swi_home']);
    // The count is a second request: until it arrives the row has no number.
    expect($('.tr-row .tr-under')!.textContent).toBe('');
    const p = w.pending.shift()!;
    p.resolve(counts(p.msg as Sent));
    await flush();
    expect($('.tr-row .tr-under')!.textContent).toBe('3 under it');
    expect($('.tr-row .tr-sub')!.textContent).toBe('Only this');
    // Closing and opening again reads nothing more.
    const reads = () => w.sent.filter(m => m.type === 'TRANSPORT_CHILDREN').length;
    $<HTMLButtonElement>('.tr-grp.browse .tr-gt')!.click();
    $<HTMLButtonElement>('.tr-grp.browse .tr-gt')!.click();
    expect(reads()).toBe(1);
    expect(ctl.browseOpen.has('a:portal')).toBe(true);
  });

  it('a tick on a folder takes it with everything under it; Only this takes the folder alone, + n under it then adds the rest', async () => {
    const { $, ctl, tick } = await opened();
    $<HTMLButtonElement>('.tr-grp.browse .tr-gt')!.click();
    await flush(40);
    const sub = () => $<HTMLButtonElement>(`.tr-row[data-rid="${folder.rid}"] .tr-sub`)!;
    const box = () => $<HTMLInputElement>(`.tr-ck[data-rid="${folder.rid}"]`)!;
    // One tick: the folder whole. The ID BMP assigned is left out.
    tick(folder.rid);
    await flush(40);
    expect($('.tr-selcount')!.textContent).toBe('1 folder in the transport');
    expect([box().checked, sub().textContent, sub().classList.contains('on')]).toEqual([true, '2 of 3 under it', true]);
    // Unticking the folder takes all of it out again.
    tick(folder.rid, false);
    expect(ctl.collection.size).toBe(0);
    // The folder alone, then the rest.
    expect(sub().textContent).toBe('Only this');
    sub().click();
    expect(ctl.collection.rids()).toEqual([folder.rid]);
    expect($('.tr-selcount')!.textContent).toBe('1 object in the transport');
    expect(sub().textContent).toBe('+ 3 under it');
    sub().click();
    await flush(40);
    expect($('.tr-selcount')!.textContent).toBe('1 folder in the transport');
  });

  it('a folder above 500 objects is taken on the second tick only', async () => {
    const { $, w, ctl, tick } = await opened();
    w.answer = m => (m.type === 'TRANSPORT_COUNTS' ? countsResult(m as Sent, Object.fromEntries((((m as Sent).rids ?? (m as Sent).roots) as string[]).map(r => [r, 900]))) : answer(m as Sent));
    $<HTMLButtonElement>('.tr-grp.browse .tr-gt')!.click();
    await flush(40);
    const under = () => $(`.tr-row[data-rid="${folder.rid}"] .tr-under`)!.textContent;
    expect(under()).toBe('900 under it');
    tick(folder.rid);
    await flush(40);
    expect(ctl.collection.size).toBe(0);
    expect(under()).toBe('Tick again to add 901');
    expect($<HTMLInputElement>(`.tr-ck[data-rid="${folder.rid}"]`)!.checked).toBe(false);
    tick(folder.rid);
    await flush(40);
    expect($('.tr-selcount')!.textContent).toBe('1 folder in the transport');
  });

  it('a tick on a child is the object alone; + n under it takes the folder whole: one line, a pressed button, a bar on its rows', async () => {
    const { $, $$, ctl, tick } = await opened();
    $<HTMLButtonElement>('.tr-grp.browse .tr-gt')!.click();
    await flush(40);
    $<HTMLButtonElement>(`.tr-row[data-rid="${folder.rid}"] .tr-caret`)!.click();
    await flush(40);
    tick(a.rid);
    expect(ctl.collection.rids()).toEqual([a.rid]);
    expect($('.tr-selcount')!.textContent).toBe('1 object in the transport');
    const sub = () => $<HTMLButtonElement>(`.tr-row[data-rid="${folder.rid}"] .tr-sub`)!;
    expect($(`.tr-row[data-rid="${folder.rid}"] .tr-under`)!.textContent).toBe('3 under it');
    tick(folder.rid);
    await flush(40);
    expect($('.tr-selcount')!.textContent).toBe('1 folder in the transport');
    expect($('.tr-tab[data-tab="transport"]')!.textContent).toBe('Transport 1');
    expect([sub().textContent, sub().getAttribute('aria-pressed'), sub().classList.contains('on')]).toEqual(['2 of 3 under it', 'true', true]);
    // The ID BMP assigned is left out; the others are in, with the bar.
    expect($$('.tr-row.cov').map(r => r.querySelector('.tr-id')!.textContent)).toEqual(['swi_home_kpis', 'swi_home_news']);
    expect($<HTMLInputElement>(`.tr-ck[data-rid="${auto.rid}"]`)!.checked).toBe(false);
    // Unticking one inside keeps the folder as one line.
    tick(b.rid, false);
    expect($('.tr-selcount')!.textContent).toBe('1 folder in the transport');
    expect(sub().textContent).toBe('1 of 3 under it');
    // The pressed button takes everything out again.
    sub().click();
    expect(ctl.collection.size).toBe(0);
    expect($('.tr-selcount')!.textContent).toBe('Nothing in the transport');
  });
});

describe('results', () => {
  it('groups with notes, rows with tags; every row has a tick box; a linked copy is tagged with its template; areas keep their order', async () => {
    const plain = row({ id: 'keep_here' });
    const fresh = row({ id: 'new_page', createdIso: '2026-11-10T08:00:00' });
    const copy = row({ id: 'a_copy', linkedTo: 'tpl_card' });
    const { $, $$, ctl } = setup(msg => {
      if (msg.root === 'portal') return scanResult(msg, { rows: [plain, fresh, copy] });
      if (msg.root === 'templateCategory') return scanResult(msg, { missingRoot: true });
      if (msg.root === 'property') return scanResult(msg, { ok: false, rows: undefined, error: 'Script failed', errorKind: 'server' });
      if (msg.root === 'expression') return scanResult(msg, { rows: [row()], more: true });
      return scanResult(msg);
    });
    ctl.setChanged('7d');
    await flush(40);
    expect($$('.tr-grp').map(g => g.dataset.root)).toEqual(['portal', 'templateCategory', 'property', 'expression']);
    const note = (root: string) => $(`.tr-grp[data-root="${root}"] .tr-gnote`)?.textContent;
    expect(note('templateCategory')).toBe('Not on this workspace');
    expect(note('property')).toBe('Script failedTry again');
    expect(note('expression')).toBe('More than 2,000 changes: choose a later dateRead the rest');
    const rowOf = (rid: string) => $(`.tr-row[data-rid="${rid}"]`)!;
    expect(rowOf(plain.rid).querySelector('.tr-ck')).not.toBeNull();
    expect(rowOf(plain.rid).querySelector('.tr-tags')?.textContent).toBe('');
    expect(rowOf(fresh.rid).querySelector('.tr-tags')?.textContent).toBe('new');
    expect(rowOf(fresh.rid).querySelector('.tr-when')?.textContent).toBe('14 Nov 10:05');
    const linked = rowOf(copy.rid).querySelector<HTMLElement>('.tr-tag.linked')!;
    expect([linked.textContent, linked.title]).toEqual(['linked copy', 'Linked to tpl_card']);
    $<HTMLButtonElement>('.tr-grp[data-root="property"] .tr-retry')!.click();
    await flush();
    expect(ctl.areas.find(a => a.root === 'property')?.status).toBe('failed');
  });

  it('a tick adds to the transport: the footer and the tab count; a filter that hides the row leaves it in; Open transport switches tabs', async () => {
    const rows = [row({ id: 'a1' }), row({ id: 'a2' })];
    const { $, ctl, tick } = setup(msg => scanResult(msg, { rows: msg.root === 'portal' ? rows : [] }));
    ctl.setChanged('7d');
    await flush(40);
    expect($('.tr-selcount')?.textContent).toBe('Nothing in the transport');
    tick(rows[0].rid);
    expect($('.tr-selcount')?.textContent).toBe('1 object in the transport');
    expect($('.tr-tab[data-tab="transport"]')!.textContent).toBe('Transport 1');
    expect($<HTMLInputElement>(`.tr-ck[data-rid="${rows[0].rid}"]`)!.checked).toBe(true);
    ctl.setFilters({ text: 'a2' });
    expect($('.tr-selcount')?.textContent).toBe('1 object in the transport');
    $<HTMLButtonElement>('.tr-open')!.click();
    expect(ctl.tab).toBe('transport');
    expect($('.tr-find')!.hidden).toBe(true);
    expect($('.tr-transport')!.hidden).toBe(false);
  });

  it('the header button adds the shown matches, not a row with a numeric ID, which has a tag', async () => {
    const auto = row({ id: '40213' });
    const named = row({ id: 'el_named' });
    const { $, ctl } = setup(msg => scanResult(msg, { rows: msg.root === 'portal' ? [auto, named] : [] }));
    ctl.setChanged('7d');
    await flush(40);
    const tag = $(`.tr-row[data-rid="${auto.rid}"] .tr-tag.auto`)!;
    expect([tag.textContent, tag.title]).toEqual(['auto ID', NUMERIC_ID_TITLE]);
    const head = $<HTMLButtonElement>('.tr-grp[data-root="portal"] .tr-gh .tr-sub')!;
    expect(head.textContent).toBe('+ 1 match');
    head.click();
    expect($<HTMLInputElement>(`.tr-ck[data-rid="${auto.rid}"]`)!.checked).toBe(false);
    expect($<HTMLInputElement>(`.tr-ck[data-rid="${named.rid}"]`)!.checked).toBe(true);
    expect($<HTMLButtonElement>('.tr-grp[data-root="portal"] .tr-gh .tr-sub')!.textContent).toBe('All 1 match');
  });
});

describe('the result list as a tree', () => {
  const P = '9007199254740001';
  function treeCase() {
    const folder = row({ id: 'folder', parentRid: P, parentId: 'PORTAL' });
    const a = row({ id: 'a_child', parentRid: folder.rid, sortIndex: 0 });
    const b = row({ id: 'b_child', parentRid: folder.rid, sortIndex: 1 });
    const deep = row({ id: 'deep', parentRid: a.rid });
    const orphan = row({ id: 'orphan', parentRid: '9007199254749999', parentId: 'outside_folder', parentName: 'Outside' });
    return { folder, a, b, deep, orphan, rows: [folder, a, b, deep, orphan] };
  }

  it('rows nest by parent; a parent off the list is a context line; a caret closes and opens its node', async () => {
    const c = treeCase();
    const { $, $$, ctl } = setup(msg => scanResult(msg, { rows: msg.root === 'portal' ? c.rows : [] }));
    ctl.setChanged('7d');
    await flush(40);
    const ids = () => $$('.tr-grp[data-root="portal"] .tr-row').map(l => `${l.dataset.depth}:${l.querySelector('.tr-id')!.textContent}`);
    expect(ids()).toEqual(['0:folder', '1:a_child', '2:deep', '1:b_child', '0:outside_folder', '1:orphan']);
    expect($('.tr-row.ctx')!.querySelector('.tr-ck')).toBeNull();
    $<HTMLButtonElement>(`.tr-row[data-rid="${c.folder.rid}"] .tr-caret`)!.click();
    expect(ctl.collection.size).toBe(0);
    expect(ids()).toEqual(['0:folder', '0:outside_folder', '1:orphan']);
    $<HTMLButtonElement>(`.tr-row[data-rid="${c.folder.rid}"] .tr-caret`)!.click();
    expect(ids()).toHaveLength(6);
  });

  it('under a filter the button says + n matches and takes the matches under the row, not the row; again removes them', async () => {
    const c = treeCase();
    const { $, ctl } = setup(msg => scanResult(msg, { rows: msg.root === 'portal' ? c.rows : [] }));
    ctl.setChanged('7d');
    await flush(40);
    const sub = () => $<HTMLButtonElement>(`.tr-row[data-rid="${c.folder.rid}"] .tr-sub`)!;
    expect([sub().textContent, sub().getAttribute('aria-pressed'), sub().classList.contains('on')]).toEqual(['+ 3 matches', 'false', false]);
    sub().click();
    expect(ctl.collection.size).toBe(3);
    expect(ctl.inTransport(c.folder.rid)).toBe(false);
    expect([sub().textContent, sub().getAttribute('aria-pressed')]).toEqual(['All 3 matches', 'true']);
    expect($('.tr-selcount')!.textContent).toBe('3 objects in the transport');
    sub().click();
    expect(ctl.collection.size).toBe(0);
  });

  it('a cut group offers Read the rest and shows its progress', async () => {
    const first = Array.from({ length: 2_000 }, () => row());
    const { $, w, ctl } = setup(msg => scanResult(msg, msg.root === 'portal' ? { rows: first, more: true } : {}));
    ctl.setChanged('7d');
    await flush(40);
    w.answer = undefined;
    $<HTMLButtonElement>('.tr-grp[data-root="portal"] .tr-rest')!.click();
    await flush();
    expect(w.pending[0].msg).toMatchObject({ type: 'TRANSPORT_CHILDREN', root: 'portal' });
    const p = w.pending.shift()!;
    p.resolve({ type: 'TRANSPORT_CHILDREN_RESULT', requestId: p.msg.requestId, environment: p.msg.environment, ok: true, rids: ['9007199254741001'] } as never);
    await flush();
    expect($('.tr-find .tr-status')!.textContent).toBe('Reading the rest of Shared web · 2,000 objects read');
    expect($('.tr-stop')!.hidden).toBe(false);
  });
});

describe('the transport tab', () => {
  async function filled() {
    const folder = row({ id: 'cards', name: 'Cards', parentRid: '9007199254740001', parentId: 'PORTAL' });
    const a = row({ id: 'card_a', name: 'Card A', parentRid: folder.rid, sortIndex: 1 });
    const b = row({ id: 'card_b', name: 'Card B', parentRid: folder.rid, sortIndex: 0 });
    const texts: Record<string, string> = {
      [folder.rid]: "t.cards.change(id := 'cards', name := 'Cards') //Category",
      [a.rid]: "t.card_a.change(id := 'card_a', kpi := k.my_kpi, peer := t.card_b, org := o.org1) //TextElement",
      [b.rid]: "t.card_b.change(id := 'card_b') //TextElement",
    };
    const s = setup(m => {
      if (m.type === 'TRANSPORT_READ_OBJECTS') return objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, 'x', { genedit: texts[rid] })));
      if (m.type === 'TRANSPORT_USED_BY') return ok(m, 'TRANSPORT_USED_BY_RESULT', { rid: m.rid, users: Array.from({ length: 9 }, (_, i) => ({ rid: String(8000000000000000000n + BigInt(i)), id: `u${i}`, className: i < 6 ? 'TextElement' : 'Card', name: `U${i}` })), more: false });
      return scanResult(m, { rows: m.root === 'portal' ? [folder, a, b] : [] });
    });
    await s.ctl.scan();
    s.ctl.setGroupTicked('portal', true);
    s.ctl.showTab('transport');
    return { ...s, folder, a, b };
  }

  it('the empty sentence says what to do', () => {
    const { $, ctl } = setup();
    ctl.showTab('transport');
    expect($('.tr-tempty')!.hidden).toBe(false);
    expect($('.tr-tempty')!.textContent).toBe(EMPTY_TRANSPORT);
    expect($<HTMLButtonElement>('.tr-act')!.disabled).toBe(true);
  });

  it('the list by place: the parent\'s path, objects by sibling order; remove from the transport', async () => {
    const { $, $$, ctl, a, b, tick } = await filled();
    expect($$('.tr-pgt .t').map(t => t.textContent)).toEqual(['Shared web', 'Shared web › Cards']);
    expect($$('.tr-pg:last-child .tr-trow .tr-id').map(e => e.textContent)).toEqual(['card_b', 'card_a']);
    expect($$('.tr-trow .tr-tag[data-state]')).toHaveLength(0);
    const rm = $<HTMLButtonElement>(`.tr-rm[data-rid="${a.rid}"]`)!;
    expect([rm.title, rm.getAttribute('aria-label')]).toEqual(['Remove from transport', 'Remove card_a from transport']);
    rm.click();
    expect(ctl.inTransport(a.rid)).toBe(false);
    expect($('.tr-tab[data-tab="transport"]')!.textContent).toBe('Transport 2');
    // The tick on Find follows.
    ctl.showTab('find');
    expect($<HTMLInputElement>(`.tr-ck[data-rid="${a.rid}"]`)!.checked).toBe(false);
    tick(b.rid, false);
    expect(ctl.collection.size).toBe(1);
  });

  it('"Used by" that finds nothing says what is not searched', async () => {
    const { $, w, ctl, folder } = await filled();
    ctl.setChoice(CHOICE_ANY);
    await ctl.buildBundle();
    const answer = w.answer!;
    w.answer = m => (m.type === 'TRANSPORT_USED_BY' ? ok(m, 'TRANSPORT_USED_BY_RESULT', { rid: m.rid, users: [] }) : answer(m));
    ctl.toggleRow(folder.rid);
    $<HTMLButtonElement>(`.tr-detail[data-rid="${folder.rid}"] .tr-usedby-go`)!.click();
    await flush(10);
    expect($(`.tr-detail[data-rid="${folder.rid}"] .tr-usedby`)!.textContent).toBe(NOTHING_USES);
    expect(NOTHING_USES).toBe('Nothing found. Expressions outside this transport are not searched.');
  });

  it('an object the read says does not exist: not found, out of the scripts, counted in the draft line', async () => {
    const { $, w, ctl, a } = await filled();
    const answer = w.answer!;
    w.answer = m => (m.type === 'TRANSPORT_READ_OBJECTS'
      ? objectsResult(m, (m.rids as string[]).map(rid => (rid === a.rid ? { rid, ok: false, error: 'The object does not exist (any more).', missing: true } : readOk(rid, 'x', { genedit: `t.o${rid.slice(-3)}.change(id := 'o${rid.slice(-3)}') //X` }))))
      : answer(m));
    ctl.setChoice(CHOICE_ANY);
    await ctl.buildBundle();
    expect(ctl.collection.get(a.rid)!.gone).toBe(true);
    expect(ctl.bundle!.rids).not.toContain(a.rid);
    expect(ctl.bundle!.result!.objects).toHaveLength(2);
    expect(ctl.stale).toBe(false);
    expect($(`.tr-trow[data-rid="${a.rid}"] .tr-tag.gone`)!.textContent).toBe('not found');
    expect($(`.tr-trow[data-rid="${a.rid}"] .tr-tag[data-state]`)).toBeNull();
    expect($('.tr-draft-t')!.textContent).toBe('3 objects · 1 not found');
  });

  it('a row opens in place; before a build: what it uses is not known yet', async () => {
    const { $, a } = await filled();
    $<HTMLButtonElement>(`.tr-tcaret[data-rid="${a.rid}"]`)!.click();
    const detail = $(`.tr-detail[data-rid="${a.rid}"]`)!;
    expect([...detail.querySelectorAll('.tr-dsec-h')].map(h => h.textContent)).toEqual(['Uses', 'Used by']);
    expect(detail.textContent).toContain(COMPARE_TO_SEE);
    expect(detail.querySelector('.tr-usedby-go')!.textContent).toBe('Find what uses this');
  });

  it('scripts without comparison: the summary with Copy all, the scripts closed after the list; uses and parents apart; facts read; Used by', async () => {
    const { $, $$, w, ctl, a, b } = await filled();
    w.facts = m => ({ type: 'TRANSPORT_FACTS_RESULT', requestId: m.requestId, environment: ENV, ok: true,
      facts: (m.addresses as string[]).map(x => (x === 'k.my_kpi' ? { address: x, rid: '7000000000000000001', className: 'TextMethodConfig', parentId: 'PROPERTY', name: 'My KPI' } : { address: x, missing: true })) }) as never;
    const sel = $<HTMLSelectElement>('.tr-target')!;
    sel.value = CHOICE_ANY;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect($('.tr-act')!.textContent).toBe('Build scripts');
    $<HTMLButtonElement>('.tr-act')!.click();
    await flush(30);
    expect($('.tr-sum')!.textContent).toBe('3 objects in 3 scripts');
    // Copy all and Download on the summary line; the scripts closed, after the list.
    expect($$('.tr-sumline .tr-actions button').map(x => x.textContent)).toEqual(['Copy all', 'Download']);
    expect($<HTMLDetailsElement>('.tr-scripts')!.open).toBe(false);
    expect($('.tr-scripts .tr-copyall')).toBeNull();
    const order = [...$('.tr-tmain')!.children].map(e => e.className.split(' ')[0]);
    expect(order.indexOf('tr-tlist')).toBeLessThan(order.indexOf('tr-scriptsbox'));
    expect(order.indexOf('tr-scriptsbox')).toBeLessThan(order.indexOf('tr-optsbox'));
    expect($$('.tr-need .tr-need-t').map(x => x.textContent)).toEqual([
      'Uses 2 objects that are not in this transport',
      '3 objects are under a parent that is not in this transport',
    ]);
    expect($$('.tr-need').map(x => x.dataset.level)).toEqual(['needs', 'needs']);
    expect($$('.tr-need .tr-addref').map(x => x.dataset.need)).toEqual(['uses', 'parents']);
    // The facts of the used objects were read on their own.
    expect(w.factsSent.map(m => m.addresses)).toEqual([['k.my_kpi', 'o.org1']]);
    $<HTMLButtonElement>(`.tr-tcaret[data-rid="${a.rid}"]`)!.click();
    const chips = $$(`.tr-detail[data-rid="${a.rid}"] .tr-chip`);
    expect(chips.map(c => [c.querySelector('.tr-chip-a')!.textContent, c.querySelector('.tr-chip-n')?.textContent ?? '', c.dataset.state])).toEqual([
      ['k.my_kpi', 'My KPI', 'unknown'], ['o.org1', '', 'not-found'], ['t.card_b', 'Card B', 'transport'],
    ]);
    // Used by, before any click: the objects of this transport that use it.
    $<HTMLButtonElement>(`.tr-tcaret[data-rid="${b.rid}"]`)!.click();
    const usedB = $(`.tr-detail[data-rid="${b.rid}"] .tr-usedby`)!;
    expect([...usedB.querySelectorAll('.tr-chip-a')].map(x => x.textContent)).toEqual(['card_a']);
    $<HTMLButtonElement>(`.tr-tcaret[data-rid="${b.rid}"]`)!.click();
    // A chip of an object in the transport shows it.
    (chips[2] as HTMLButtonElement).click();
    expect(ctl.openRows.has(b.rid)).toBe(true);
    expect(w.sent.some(m => m.type === 'TRANSPORT_USED_BY')).toBe(false);
    $<HTMLButtonElement>(`.tr-detail[data-rid="${a.rid}"] .tr-usedby-go`)!.click();
    await flush(10);
    expect(w.sent.filter(m => m.type === 'TRANSPORT_USED_BY').map(m => m.rid)).toEqual([a.rid]);
    const used = $(`.tr-detail[data-rid="${a.rid}"] .tr-usedby`)!;
    expect(used.querySelector('.tr-help')!.textContent).toBe('9 objects');
    expect([...used.querySelectorAll('.tr-usedby-cls li')].map(l => l.textContent)).toEqual(['TextElement · 6', 'Card · 3']);
    expect(used.querySelector('.tr-usedby-note')!.textContent).toBe(NOT_SEARCHED);
    // Before the build, the map said what to do; after it, the kinds of used objects.
    $<HTMLButtonElement>('.tr-viewseg button[data-view="map"]')!.click();
    expect($('.tr-tlist')!.hidden).toBe(true);
    expect($$('.tr-mleft .tr-mbox .tr-mbox-t').map(t => t.textContent)).toEqual(['Shared web › Cards', 'Shared web']);
    expect($$('.tr-mright .tr-mbox .tr-mbox-t').map(t => t.textContent)).toEqual(['Properties', 'Organisations']);
    expect($$('.tr-mright .tr-mbox .tr-mbox-n').map(t => t.textContent)).toEqual(['1 object', '1 object']);
    expect($$('.tr-mlinks .tr-mlink').map(l => [l.getAttribute('data-right'), l.querySelector('text')!.textContent])).toEqual([['properties', '1'], ['organisations', '1']]);
    $<HTMLButtonElement>('.tr-mright .tr-mbox[data-kind="properties"]')!.click();
    expect($('.tr-mpanel-h')!.textContent).toBe('Properties · 1 object');
    expect($$('.tr-mpanel .tr-mrow').map(r => r.dataset.key)).toEqual(['k.my_kpi']);
    $<HTMLButtonElement>('.tr-mpanel .tr-showin')!.click();
    expect(ctl.transportView).toBe('list');
    expect(ctl.openRows.has(a.rid)).toBe(true);
  });

  it('the map before a build: the places only, and what to do', async () => {
    const { $, $$, ctl } = await filled();
    ctl.setChoice(CHOICE_ANY);
    ctl.setTransportView('map');
    // The top-level places: the area and the first folder, the most objects first.
    expect($$('.tr-mleft .tr-mbox').map(b => [b.querySelector('.tr-mbox-t')!.textContent, b.querySelector('.tr-mbox-n')!.textContent])).toEqual([['Shared web › Cards', '2 objects'], ['Shared web', '1 object']]);
    expect($('.tr-mright .tr-help')!.textContent).toBe(BUILD_TO_SEE);
    $<HTMLButtonElement>('.tr-mleft .tr-mbox')!.click();
    expect($('.tr-mpanel-h')!.textContent).toBe('Shared web › Cards · 2 objects');
    expect($$('.tr-mpanel .tr-mrow .tr-ro-a').map(e => e.textContent)).toEqual(['card_b', 'card_a']);
    // A second click on the box closes the panel.
    $<HTMLButtonElement>('.tr-mleft .tr-mbox')!.click();
    expect($('.tr-mpanel-h')).toBeNull();
  });

  it('a pasted comparison: the comparison script with one sentence, the answer field and its errors; an answer gives the states', async () => {
    const c = patchCase();
    const s = setup(c.answer);
    await s.ctl.scan();
    s.ctl.setGroupTicked('portal', true);
    s.ctl.setChoice(CHOICE_PASTE);
    s.ctl.showTab('transport');
    s.$<HTMLButtonElement>('.tr-act')!.click();
    await flush(20);
    const t = () => s.ctl.bundle!.target!;
    expect(s.$<HTMLDetailsElement>('.tr-step')!.open).toBe(true);
    expect(s.$('.tr-step > summary')!.textContent).toMatch(/^Comparison script · \d+ parts?$/);
    expect(s.$('.tr-step .tr-lead')!.textContent).toBe(PROBE_LEAD);
    expect(s.$$('.tr-step .tr-card-t').map(e => e.textContent)).toEqual(t().probe.parts.map(p => `Part ${p.index} of ${p.total} · Compare · run with Preview`));
    s.$<HTMLButtonElement>('.tr-step .tr-copyall')!.click();
    await vi.waitFor(() => expect(s.copies).toEqual([t().probe.text]));
    const area = s.$<HTMLTextAreaElement>('.tr-answer')!;
    const paste = async (text: string) => {
      area.value = text;
      area.dispatchEvent(new Event('input', { bubbles: true }));
      s.$<HTMLButtonElement>('.tr-readans')!.click();
      await flush(20);
    };
    expect(s.$('.tr-readans')!.textContent).toBe('Read answer');
    await paste('nothing useful');
    expect(s.$('.tr-answer-err')!.textContent).toBe('No answer found. Run the comparison script with Preview on the target and copy the whole answer.');
    await paste(probeAnswer(t().probe, c.target));
    expect(s.$('.tr-answer-err')!.textContent).toBe('');
    expect(s.$('.tr-sum')!.textContent).toBe('1 to add · 1 to change · 1 the same · 1 left out');
    expect(s.$<HTMLDetailsElement>('.tr-step')!.open).toBe(false);
    // The scripts to paste on the target: copied from the summary line.
    s.$<HTMLButtonElement>('.tr-sumline .tr-copyall')!.click();
    await vi.waitFor(() => expect(s.copies.at(-1)).toBe(t().patch!.text));
    const changed = c.rows.find(r => r.id === 'el_change')!;
    s.$<HTMLButtonElement>(`.tr-tcaret[data-rid="${changed.rid}"]`)!.click();
    const vals = s.$$(`.tr-detail[data-rid="${changed.rid}"] .tr-val`).map(v => [v.dataset.name, v.querySelector('.tr-val-a')!.textContent]);
    expect(vals).toEqual([['name', 'changed'], ['description', 'kept']]);
    // Options in a quiet block.
    expect(s.$('.tr-optblk > summary')!.textContent).toBe('Options');
    const clash = c.rows.find(r => r.id === 'el_clash')!;
    const tag = s.$<HTMLElement>(`.tr-trow[data-rid="${clash.rid}"] .tr-tag[data-state]`)!;
    expect([tag.textContent, tag.title]).toEqual(['left out', 'On the target t.el_clash is of class ExtendedTable.']);
  });

  it('objects under Templates: one line without a button, the warning for scripts without comparison', async () => {
    const tpl = row({ id: 'tpl_ind', parentRid: '3', parentId: 'TEMPLATECATEGORY' });
    const s = setup(m => (m.type === 'TRANSPORT_READ_OBJECTS' ? objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, 'tpl_ind')))
        : scanResult(m, { rows: m.root === 'templateCategory' ? [tpl] : [] })));
    await s.ctl.scan();
    s.ctl.setGroupTicked('templateCategory', true);
    s.ctl.setChoice(CHOICE_ANY);
    s.ctl.showTab('transport');
    await s.ctl.buildBundle();
    const blk = s.$('.tr-tplblk')!;
    expect(blk.querySelector('.tr-need-t')!.textContent).toBe('1 object is a template: a change reaches every linked copy');
    expect(blk.dataset.level).toBe('know');
    expect(blk.querySelector('.tr-warnline')!.textContent).toMatch(/^These scripts change every value of a template on the target/);
    expect(blk.querySelector('button')).toBeNull();
    expect(s.w.sent.map(m => m.type).filter(t => t !== 'TRANSPORT_SCAN' && t !== 'TRANSPORT_READ_OBJECTS')).toEqual([]);
    // Its row, opened: one line, no count.
    s.$<HTMLButtonElement>(`.tr-tcaret[data-rid="${tpl.rid}"]`)!.click();
    const sec = s.$$('.tr-dsec').find(x => x.querySelector('.tr-dsec-h')?.textContent === 'Template')!;
    expect(sec.querySelector('.tr-dsec-b')!.textContent).toBe('A change reaches every linked copy.');
  });

  it('a draft: restored when the window opens with its date; Refresh reads again; Clear empties it with Undo', async () => {
    const a = row({ id: 'kept_a' });
    const store = memoryStore({
      [draftKey(ENV)]: toDraft(ENV, [{ rid: a.rid, row: a, area: 'portal', trail: [], readAt: '2026-11-14T09:00:00.000Z' }], '2026-11-14T09:00:00.000Z'),
    });
    const s = setup(m => ok(m, 'TRANSPORT_ROWS_RESULT', { rows: (m.rids as string[]).map(rid => ({ rid, missing: true })) }), store);
    await s.ctl.restoreDraft();
    s.ctl.showTab('transport');
    expect(s.$('.tr-draft-t')!.textContent).toBe('Draft from 14 Nov, 1 object');
    expect(s.$('.tr-purpose')!.textContent).toBe(TRANSPORT_PURPOSE);
    expect(s.$('.tr-draftnote')!.hidden).toBe(false);
    expect(s.$('.tr-draftnote')!.textContent).toBe(DRAFT_NOTE);
    expect(s.$('.tr-target')!.getAttribute('title')).toBe(TARGET_DEFAULT_TITLE);
    const refresh = s.$<HTMLButtonElement>('.tr-refresh')!;
    expect(refresh.hidden).toBe(false);
    refresh.click();
    await flush(10);
    expect(s.$('.tr-draft-t')!.textContent).toBe('Draft from 15 Nov, 1 object · 1 not found');
    expect(s.$('.tr-draftnote')!.hidden).toBe(true);
    expect(s.$(`.tr-trow[data-rid="${a.rid}"] .tr-tag.gone`)!.textContent).toBe('not found');
    s.$<HTMLButtonElement>('.tr-clearall')!.click();
    expect(s.$('.tr-tempty')!.textContent).toBe(`${EMPTY_TRANSPORT} Undo the clear`);
    s.$<HTMLButtonElement>('.tr-undo-btn')!.click();
    expect(s.ctl.collection.size).toBe(1);
  });

  it('under an object without a day, read in full: the comparison says what only the target has', async () => {
    const module = row({ id: 'my_module', className: 'Category' });
    const tab = row({ id: 'my_tab', parentRid: module.rid });
    const s = setup(m => (m.type === 'TRANSPORT_READ_OBJECTS' ? objectsResult(m, (m.rids as string[]).map(rid => readOk(rid, rid === module.rid ? 'my_module' : 'my_tab'))) : m.type === 'TRANSPORT_SCAN_BELOW' ? belowResult(m, module, [tab]) : underResult(m, module, [tab])));
    s.ctl.setScope('under');
    s.ctl.setStart('my_module');
    await s.ctl.scan();
    await s.ctl.takeAll(module.rid);
    s.ctl.setChoice(CHOICE_PASTE);
    await s.ctl.buildBundle();
    const t = s.ctl.bundle!.target!;
    await s.ctl.readAnswer(probeAnswer(t.probe, { 't.my_module': { cls: 'TextElement', genedit: "\nt.my_module.change(id := 'my_module', name := 'Name my_module') //TextElement\n" }, 't.my_tab': { cls: 'TextElement', genedit: "\nt.my_tab.change(id := 'my_tab', name := 'Name my_tab') //TextElement\n", parent: 'my_module' }, 't.page': { cls: 'Category' } }, { listing: [{ id: 'my_tab', parent: 'my_module' }, { id: 'extra', parent: 'my_module' }] }));
    const only = s.$<HTMLDetailsElement>('.tr-onlyblk')!;
    expect(only.querySelector('summary')!.textContent).toBe('1 object only on the target');
    expect(only.querySelector('.tr-delx')!.getAttribute('aria-checked')).toBe('false');
  });
});

describe('transport log', () => {
  const entry = (over: Record<string, string> = {}) => ({ rid: '9007199254740995', id: 'cc_tr_1', name: 'Release 12', description: 'Added 1, changed 2.', created: 'Nov 14, 2026 10:05:00', createdIso: '2026-11-14T10:05:00', createdBy: 'Editor One', ...over });

  it('Log reads on click, over the tab; entries with their description on expand; Back returns', async () => {
    const { $, $$, w } = setup(msg => logResult(msg, { entries: [entry(), entry({ rid: '9007199254740996', id: 'cc_tr_0', name: 'First', description: '' })], more: true }));
    expect(w.sent).toHaveLength(0);
    $<HTMLButtonElement>('.tr-logbtn')!.click();
    await flush();
    expect(w.sent.map(m => m.type)).toEqual(['TRANSPORT_LOG']);
    expect($('.tr-logview')!.hidden).toBe(false);
    expect($('.tr-find')!.hidden).toBe(true);
    const [first, second] = $$('.tr-le');
    expect(first.tagName).toBe('DETAILS');
    expect([...first.querySelectorAll('.tr-le-h > span')].map(s => s.textContent)).toEqual(['Release 12', '14 Nov 10:05', 'Editor One']);
    expect(second.tagName).toBe('DIV');
    expect($('.tr-logview .tr-limits')?.textContent).toBe('Showing the newest 2 entries.');
    $<HTMLButtonElement>('.tr-logview .tr-back')!.click();
    expect($('.tr-logview')!.hidden).toBe(true);
    expect($('.tr-find')!.hidden).toBe(false);
  });

  it('says when the workspace has no log, and shows a failure', async () => {
    const { $, ctl, w } = setup(msg => logResult(msg, { missingLog: true }));
    await ctl.openLog();
    expect($('.tr-logview .tr-empty')?.textContent).toBe('No transport log on this workspace yet.');
    w.answer = msg => logResult(msg, { ok: false, entries: undefined, error: 'The transport log could not be read: EC error' });
    await ctl.readLog();
    expect($('.tr-logview .tr-status')?.classList.contains('err')).toBe(true);
    expect($('.tr-logview .tr-status')?.textContent).toBe('The transport log could not be read: EC error');
  });
});

describe('round 16: Copy IDs, the narrow window', () => {
  it('Copy IDs next to Clear copies the addresses one per line and says Copied for two seconds', async () => {
    vi.useFakeTimers();
    try {
      const a = row({ id: 'cc_a' });
      const b = row({ id: 'cc_def', className: 'TextMethodConfig' });
      const s = setup(m => scanResult(m, { rows: m.root === 'portal' ? [a, b] : [] }));
      await s.ctl.scan();
      s.ctl.setGroupTicked('portal', true);
      s.ctl.showTab('transport');
      const copy = s.$<HTMLButtonElement>('.tr-copyids')!;
      expect(copy.nextElementSibling!.className).toContain('tr-clearall');
      expect(copy.textContent).toBe('Copy IDs');
      copy.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.copies).toEqual([s.ctl.transportAddresses().join('\n')]);
      expect(s.copies[0].split('\n').sort()).toEqual(['k.cc_def', 't.cc_a']);
      expect(copy.textContent).toBe('Copied');
      await vi.advanceTimersByTimeAsync(1500);
      expect(copy.textContent).toBe('Copied');
      await vi.advanceTimersByTimeAsync(600);
      expect(copy.textContent).toBe('Copy IDs');
    } finally {
      vi.useRealTimers();
    }
  });

  it('at 640 px the class of a row goes under its name, in Find and in Transport rows', () => {
    const css = readFileSync(resolve(__dirname, '../transport.css'), 'utf8');
    const narrow = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(narrow).not.toMatch(/\.tr-cls(?!:empty)[^{]*\{\s*display:\s*none/);
    expect(narrow).toMatch(/\.tr-row \.tr-cls, \.tr-trow \.tr-cls \{ grid-row: 2; font-size: var\(--ui-fs-xs\)/);
    expect(narrow).toMatch(/\.tr-row \.tr-cls \{ grid-column: 2; \}/);
    expect(narrow).toMatch(/\.tr-trow \.tr-cls \{ grid-column: 4; \}/);
  });
});
