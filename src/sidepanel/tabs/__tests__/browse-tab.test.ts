/**
 * Browse tab wiring: requests, late answers, the Here tree with the current
 * position, and the degraded state, through handleMessage / render.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectorMessage, BmpObject } from '../../../lib/types';
import type { BrowseTree } from '../../../lib/browse-tree';
import { SEARCH_DEBOUNCE } from '../../../lib/constants';
import { S } from '../../state';
import { BrowseTab, TREE_REFRESH_DEBOUNCE } from '../browse-tab';

const PAGE = '7282092580979928955';
const VIEW = '2184360149894601037';
const DATE = '6257687149819435840';

const tree: BrowseTree = {
  rootRid: PAGE, crumbs: [{ rid: '4797501244326270080', type: 'Organisation', name: 'Administration' }],
  presented: null, fallback: false, posts: 3, ms: 90,
  nodes: [
    { rid: PAGE, parent: null, depth: 0, group: 0, type: 'Scorecard', name: 'CREV QA Sandbox', businessId: 'crev_qa_sandbox', kids: 1 },
    { rid: VIEW, parent: PAGE, depth: 1, group: 0, type: 'InputView', name: 'CREV QA Input view', businessId: 'crev_qa_inputview', kids: 1 },
    { rid: DATE, parent: VIEW, depth: 2, group: 0, type: 'DateInput', name: 'CREV QA Date input', businessId: 'crev_qa_date_input', kids: 0 },
  ],
};
const obj = (rid: string, o: Partial<BmpObject> = {}): BmpObject => ({ rid, source: 'server', discoveredAt: 0, updatedAt: 0, ...o });

function setup() {
  const sent: InspectorMessage[] = [];
  const opened: string[] = [];
  const tab = new BrowseTab(m => { sent.push(m); }, rid => { opened.push(rid); });
  const panel = document.createElement('div');
  panel.className = 'tab-panel active';
  document.body.replaceChildren(panel);
  const show = () => tab.render(panel);
  return { tab, sent, opened, panel, show };
}

const type = (panel: HTMLElement, q: string) => {
  const input = panel.querySelector<HTMLInputElement>('#browse-q')!;
  input.value = q;
  input.dispatchEvent(new Event('input'));
};

describe('BrowseTab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    S.page = { rid: PAGE };
    S.context = { rid: PAGE, name: 'CREV QA Sandbox', type: 'Scorecard' };
    S.connState = { ...S.connState, display: 'connected' };
    S.favoriteEntries = [];
  });
  afterEach(() => vi.useRealTimers());

  it('asks for the page tree on activation; the loading mark sits in the location line, not in a line of its own', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    show();
    expect(sent).toContainEqual({ type: 'BROWSE_TREE', rid: PAGE, typeHint: 'Scorecard' });
    expect(panel.querySelector('.bw-sk.crumb [role="status"]')?.getAttribute('aria-label')).toBe('Reading page structure');
    expect(panel.querySelector('.bw-status')).toBeNull();
    // The crumbs answer first: the line shows them while the rows load.
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, crumbs: tree.crumbs });
    show();
    expect([...panel.querySelectorAll('.bw-crumb')].map(c => c.textContent)).toEqual(['Administration', 'CREV QA Sandbox']);
    expect(panel.querySelector('.bw-crumbs [role="status"]')).not.toBeNull();
    expect(panel.querySelectorAll('.bw-sk:not(.crumb)').length).toBeGreaterThan(0);
  });

  it('never shows the previous page\'s tree after navigating', () => {
    const { tab, panel, show } = setup();
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    tab.handleMessage({ type: 'PAGE_INFO', url: 'x', widgets: [], rid: '5100000000000000001' });
    show();
    expect(panel.querySelector('.bw-row[role="treeitem"]')).toBeNull();
    expect(panel.querySelectorAll('.bw-sk').length).toBeGreaterThan(0);
  });

  it('a reloading page reporting "no object" for a moment keeps its tree; a page really gone clears', () => {
    const { tab, panel, show } = setup();
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    S.page = null;
    tab.handleMessage({ type: 'PAGE_INFO', url: 'x', widgets: [] });
    show();
    expect(panel.querySelectorAll('.bw-row[role="treeitem"]').length).toBe(3);
    S.page = { rid: PAGE };
    tab.handleMessage({ type: 'PAGE_INFO', url: 'x', widgets: [], rid: PAGE });
    vi.advanceTimersByTime(1000);
    show();
    expect(panel.querySelectorAll('.bw-row[role="treeitem"]').length).toBe(3);
    S.page = null;
    tab.handleMessage({ type: 'PAGE_INFO', url: 'x', widgets: [] });
    vi.advanceTimersByTime(1000);
    show();
    expect(panel.querySelector('.bw-row[role="treeitem"]')).toBeNull();
  });

  it('shows a data object\'s own rows first, then "Presented by" folded with its count', () => {
    const { tab, panel, show } = setup();
    const OBJ = '5200000000000000001';
    const TPL = '5200000000000000002';
    S.page = { rid: OBJ };
    S.context = { rid: OBJ, name: 'Ransomware', type: 'CeRisk' };
    tab.activate();
    const own: BrowseTree = { rootRid: OBJ, crumbs: [], presented: 'loading', fallback: false, posts: 2, ms: 300,
      nodes: [{ rid: OBJ, parent: null, depth: 0, group: 0, type: 'CeRisk', name: 'Ransomware', businessId: '113', kids: 0 }] };
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: OBJ, environment: 'p@x', ok: true, tree: own });
    show();
    expect(panel.querySelectorAll('.bw-row[role="treeitem"]').length).toBe(1);
    const head = () => panel.querySelector<HTMLElement>('[data-sec="tpl"]')!;
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(head().querySelector('[role="status"]')).not.toBeNull();
    const full: BrowseTree = { ...own, presented: 'loaded', nodes: [...own.nodes,
      { rid: TPL, parent: null, depth: 0, group: 1, type: 'EnterpriseTemplate', name: 'Risk design', businessId: 'risk_tpl', kids: 1 },
      { rid: '5200000000000000003', parent: TPL, depth: 1, group: 1, type: 'InputView', name: 'Risk view', businessId: 'risk_iv', kids: 0 }] };
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: OBJ, environment: 'p@x', ok: true, tree: full });
    show();
    expect(head().textContent).toContain('2');
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(panel.querySelectorAll('.bw-row[role="treeitem"]').length).toBe(3);
    head().click();
    expect(panel.querySelectorAll('.bw-row[role="treeitem"]').length).toBe(1);
    // The user's fold survives a fresh read of the same page.
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: OBJ, environment: 'p@x', ok: true, tree: full });
    show();
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(panel.querySelectorAll('.bw-row[role="treeitem"]').length).toBe(1);
  });

  it('shows the empty "Presented by" group open, with its note', () => {
    const { tab, panel, show } = setup();
    const OBJ = '5200000000000000001';
    S.page = { rid: OBJ };
    S.context = { rid: OBJ, name: 'Ransomware', type: 'CeRisk' };
    tab.activate();
    const none: BrowseTree = { rootRid: OBJ, crumbs: [], presented: 'none', fallback: false, posts: 2, ms: 300,
      nodes: [{ rid: OBJ, parent: null, depth: 0, group: 0, type: 'CeRisk', name: 'Ransomware', businessId: '113', kids: 0 }] };
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: OBJ, environment: 'p@x', ok: true, tree: none });
    show();
    expect(panel.textContent).toContain('Presented by');
    expect(panel.textContent).toContain('No template presents this object.');
    expect(panel.querySelector('[data-sec="tpl"][aria-expanded="false"]')).toBeNull();
  });

  it('draws the tree and marks the current position, not by colour alone', () => {
    const { tab, panel, show } = setup();
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    S.context = { rid: DATE, name: 'CREV QA Date input' };
    tab.handleMessage({ type: 'CONTEXT_RID_DATA', rid: DATE, source: 'badge' });
    show();
    const cur = panel.querySelector<HTMLElement>('.bw-row.cur')!;
    expect(cur.dataset.rid).toBe(DATE);
    expect(cur.getAttribute('aria-current')).toBe('location');
    expect(cur.querySelector('.bw-mark')).not.toBeNull();
    expect([...panel.querySelectorAll('.bw-crumb')].map(c => c.textContent)).toEqual(['Administration', 'CREV QA Sandbox']);
  });

  it('a row opens the object window; Shift on copy copies the RID', () => {
    const { tab, opened, panel, show } = setup();
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    show();
    panel.querySelector<HTMLElement>(`.bw-row[data-rid="${VIEW}"]`)!.click();
    expect(opened).toEqual([VIEW]);
    const copy = panel.querySelector<HTMLElement>(`.bw-row[data-rid="${DATE}"] [data-act="copy"]`)!;
    copy.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(write).toHaveBeenLastCalledWith(DATE);
    copy.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(write).toHaveBeenLastCalledWith('crev_qa_date_input');
  });

  it('a click on the mono ID copies it without opening; Shift-click copies the RID', () => {
    const { tab, opened, panel, show } = setup();
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    show();
    const id = panel.querySelector<HTMLElement>(`.bw-row[data-rid="${VIEW}"] .bw-id`)!;
    id.click();
    expect(write).toHaveBeenLastCalledWith('crev_qa_inputview');
    id.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(write).toHaveBeenLastCalledWith(VIEW);
    expect(opened).toEqual([]);
  });

  it('the ID is one column at the end of the label: a long one is cut in two spans with its text whole, a short one is plain, and the current marker sits before it', () => {
    const { tab, panel, show } = setup();
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    show();
    const id = (rid: string) => panel.querySelector<HTMLElement>(`.bw-row[data-rid="${rid}"] .bw-id`)!;
    expect(id(VIEW).classList.contains('mid')).toBe(true);
    expect(id(VIEW).querySelector('.h')?.textContent).toBe('crev_qa_inpu');
    expect(id(VIEW).querySelector('.t')?.textContent).toBe('tview');
    expect(id(VIEW).textContent).toBe('crev_qa_inputview');
    expect(id(VIEW).title).toContain('crev_qa_inputview');
    const cur = panel.querySelector<HTMLElement>(`.bw-row[data-rid="${PAGE}"] .bw-lbl`)!;
    expect([...cur.children].map(c => c.className.split(' ')[0])).toEqual(['bw-nm', 'bw-mark', 'bw-id']);
    expect(panel.querySelector('.bw-row > .bw-mark')).toBeNull();
  });

  it('the auto-selected first result keeps its ID: actions show only for a keyboard selection', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    show();
    type(panel, 'crev qa');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE + 5);
    void sent;
    show();
    const first = panel.querySelector<HTMLElement>('.bw-row.res')!;
    expect(first.classList.contains('sel')).toBe(true);
    expect(first.classList.contains('kf')).toBe(false);
    const input = panel.querySelector<HTMLInputElement>('#browse-q')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(panel.querySelector('.bw-row.kf')).not.toBeNull();
  });

  it('Esc with an empty query drops the selection before leaving the field', () => {
    const { tab, panel, show } = setup();
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    show();
    const input = panel.querySelector<HTMLInputElement>('#browse-q')!;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(panel.querySelector('.bw-row.kb')).not.toBeNull();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.querySelector('.bw-row.kb')).toBeNull();
  });

  it('hides the type filter while there is no query', () => {
    const { tab, panel, show } = setup();
    tab.activate();
    show();
    expect(panel.querySelector<HTMLElement>('.ui-tbtn')!.hidden).toBe(true);
    type(panel, 'risk');
    expect(panel.querySelector<HTMLElement>('.ui-tbtn')!.hidden).toBe(false);
  });

  it('typing searches after the debounce: touched objects, live page 1, configuration objects by name, and the exact lookup', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    show();
    sent.length = 0;
    type(panel, 'crev_qa_date_input');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE + 5);
    expect(sent.map(m => m.type)).toEqual(['GET_CACHE', 'BROWSE_SEARCH', 'OBJECT_SEARCH', 'BROWSE_RESOLVE']);
    expect(sent[2]).toMatchObject({ query: 'crev_qa_date_input', channel: 'browse' });
    expect(sent[1]).toMatchObject({ query: 'crev_qa_date_input', page: 1 });
  });

  it('shows the configuration search\'s cut ("Showing the first N …") with the results', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    show();
    type(panel, 'risk');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE + 5);
    const live = sent.find(m => m.type === 'BROWSE_SEARCH') as Extract<InspectorMessage, { type: 'BROWSE_SEARCH' }>;
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: live.gen, page: 1, ok: true, objects: [], totalHits: 0 });
    expect(tab.handleMessage({ type: 'OBJECT_SEARCH_RESULT', query: 'risk', ok: true, objects: [{ rid: '5000000000000000002', name: 'Risk view', type: 'InputView', businessId: 'risk_view' }], notice: 'Showing the first 200. Type more to narrow.' })).toBe(true);
    show();
    expect([...panel.querySelectorAll('.bw-note')].map(n => n.textContent)).toContain('Showing the first 200. Type more to narrow.');
  });

  it('drops a live answer from an older generation or query', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    show();
    type(panel, 'risk');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE + 5);
    const first = sent.find(m => m.type === 'BROWSE_SEARCH') as Extract<InspectorMessage, { type: 'BROWSE_SEARCH' }>;
    type(panel, 'risks');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE + 5);
    expect(tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: first.gen, ok: true, objects: [obj('5000000000000000001', { name: 'Old' })] })).toBe(false);
  });

  it('Show more asks for the next page and appends it', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    show();
    type(panel, 'risk');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE + 5);
    const search = sent.filter(m => m.type === 'BROWSE_SEARCH').at(-1) as Extract<InspectorMessage, { type: 'BROWSE_SEARCH' }>;
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: search.gen, ok: true, totalHits: 206, objects: [obj('5000000000000000001', { name: 'Risk one' })] });
    show();
    panel.querySelector<HTMLElement>('[data-act="more"]')!.click();
    expect(sent.at(-1)).toMatchObject({ type: 'BROWSE_SEARCH', query: 'risk', page: 2 });
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: search.gen, page: 2, ok: true, totalHits: 206, objects: [obj('5000000000000000002', { name: 'Risk two' })] });
    show();
    expect([...panel.querySelectorAll('.bw-row.res')].map(r => (r as HTMLElement).dataset.rid)).toEqual(['5000000000000000001', '5000000000000000002']);
  });

  it('Show more: page 1\'s identity pass arriving after the click neither counts as page 2 nor drops it', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    show();
    type(panel, 'risk');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE + 5);
    const search = sent.filter(m => m.type === 'BROWSE_SEARCH').at(-1) as Extract<InspectorMessage, { type: 'BROWSE_SEARCH' }>;
    const p1 = [obj('5000000000000000001', { name: 'Risk one' })];
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: search.gen, page: 1, ok: true, totalHits: 206, objects: p1 });
    show();
    panel.querySelector<HTMLElement>('[data-act="more"]')!.click();
    show();
    const busy = panel.querySelector<HTMLElement>('#bw-more')!;
    expect(busy.getAttribute('aria-busy')).toBe('true');
    // Page 1's identity pass, then page 2 and its identity pass.
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: search.gen, page: 1, ok: true, totalHits: 206, objects: [{ ...p1[0], businessId: 'r1' }] });
    show();
    expect(panel.querySelector('#bw-more')?.getAttribute('aria-busy')).toBe('true');
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: search.gen, page: 2, ok: true, totalHits: 206, objects: [obj('5000000000000000002', { name: 'Risk two' })] });
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: search.gen, page: 2, ok: true, totalHits: 206, objects: [obj('5000000000000000002', { name: 'Risk two', businessId: 'r2' })] });
    show();
    expect([...panel.querySelectorAll('.bw-row.res')].map(r => (r as HTMLElement).dataset.rid)).toEqual(['5000000000000000001', '5000000000000000002']);
    expect(panel.querySelector('.bw-row.res .bw-id')?.textContent).toBe('r1');
    // The header counts the rows listed, not the index's total.
    expect([...panel.querySelectorAll('.bw-grp')].find(g => g.textContent?.startsWith('Workspace'))?.textContent).toBe('Workspace2');
  });

  it('Show more disappears when the last page came back empty', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    show();
    type(panel, 'risk');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE + 5);
    const search = sent.filter(m => m.type === 'BROWSE_SEARCH').at(-1) as Extract<InspectorMessage, { type: 'BROWSE_SEARCH' }>;
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: search.gen, page: 1, ok: true, totalHits: 60, objects: [obj('5000000000000000001', { name: 'Risk one' })] });
    show();
    panel.querySelector<HTMLElement>('[data-act="more"]')!.click();
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: search.gen, page: 2, ok: true, totalHits: 60, objects: [] });
    show();
    expect(panel.querySelector('#bw-more')).toBeNull();
  });

  it('hands the query to code search', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    show();
    type(panel, 'risk');
    panel.querySelector<HTMLElement>('[data-act="code"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'OPEN_CODE_SEARCH', query: 'risk' });
  });

  it('without a portal session says so in one line and still lists touched objects', () => {
    const { tab, sent, panel, show } = setup();
    tab.activate();
    show();
    type(panel, 'risk');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE + 5);
    const search = sent.filter(m => m.type === 'BROWSE_SEARCH').at(-1) as Extract<InspectorMessage, { type: 'BROWSE_SEARCH' }>;
    tab.handleMessage({ type: 'CACHE_DATA', filter: 'risk', objects: [obj('5000000000000000009', { name: 'Risk touched' })] });
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: search.gen, ok: false, error: 'Portal login required for workspace search.' });
    show();
    expect(panel.querySelectorAll('.bw-note').length).toBe(1);
    expect(panel.querySelector('.bw-note')?.textContent).toContain('Not signed in to the portal');
    expect(panel.querySelector('.bw-grp')?.textContent).toContain('Touched objects');
  });

  it('clears workspace-scoped state on a profile switch', () => {
    const { tab, panel, show } = setup();
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    tab.handleMessage({ type: 'PROFILE_SWITCHED', profileId: 'next', label: 'Next' });
    S.page = null;
    show();
    expect(panel.querySelector('.bw-row[role="treeitem"]')).toBeNull();
  });
});

describe('BrowseTab after a saved change', () => {
  const saved = (id: number): InspectorMessage => ({ type: 'ACTIVITY_ENTRY', entry: { id, time: id, level: 'success', message: 'Saved', category: 'change' } });
  const trees = (sent: InspectorMessage[]) => sent.filter(m => m.type === 'BROWSE_TREE').length;
  beforeEach(() => {
    vi.useFakeTimers();
    S.page = { rid: PAGE };
    S.context = { rid: PAGE, name: 'CREV QA Sandbox', type: 'Scorecard' };
    S.connState = { ...S.connState, display: 'connected' };
    S.favoriteEntries = [];
  });
  afterEach(() => { vi.useRealTimers(); S.activeTab = 'connect'; });

  it('reads nothing while hidden, and the page tree once when shown again', () => {
    const { tab, sent } = setup();
    S.activeTab = 'browse';
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    expect(trees(sent)).toBe(1);
    S.activeTab = 'log';
    tab.deactivate();
    for (let i = 1; i <= 4; i++) tab.handleMessage(saved(i));
    vi.advanceTimersByTime(5_000);
    expect(trees(sent)).toBe(1);
    S.activeTab = 'browse';
    tab.activate();
    expect(trees(sent)).toBe(2);
    expect(sent.filter(m => m.type === 'BROWSE_TREE').at(-1)).toMatchObject({ type: 'BROWSE_TREE', rid: PAGE });
  });

  it('while shown, a burst of saves re-reads the tree once', () => {
    const { tab, sent } = setup();
    S.activeTab = 'browse';
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    for (let i = 1; i <= 3; i++) { tab.handleMessage(saved(i)); vi.advanceTimersByTime(100); }
    expect(trees(sent)).toBe(1);
    vi.advanceTimersByTime(TREE_REFRESH_DEBOUNCE);
    expect(trees(sent)).toBe(2);
  });
});
