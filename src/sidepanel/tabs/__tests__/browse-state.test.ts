import { describe, expect, it } from 'vitest';
import type { BmpObject } from '../../../lib/types';
import type { BrowseNode } from '../../../lib/browse-tree';
import {
  availability, buildResults, currentRow, defaultCollapsed, emptyLive, isIdLike, isRidQuery, LONG_TREE,
  listsOpenByDefault, locationPath, moveSelection, rank, typeMatches, visibleTree, type ResultsInput,
} from '../browse/state';

// Rids are Java longs: always strings, beyond Number.MAX_SAFE_INTEGER.
const PAGE = '7282092580979928955';
const VIEW = '2184360149894601037';
const SET = '8795475243508603072';
const DATE = '6257687149819435840';
const TEXT = '1413836227132136227';

const node = (rid: string, parent: string | null, depth: number, name: string, businessId: string, type: string, kids = 0, group: 0 | 1 = 0): BrowseNode =>
  ({ rid, parent, depth, name, businessId, type, kids, group });

const TREE: BrowseNode[] = [
  node(PAGE, null, 0, 'CREV QA Sandbox', 'crev_qa_sandbox', 'Scorecard', 1),
  node(VIEW, PAGE, 1, 'CREV QA Input view', 'crev_qa_inputview', 'InputView', 1),
  node(SET, VIEW, 2, 'CREV QA Input set', 'crev_qa_inputset', 'InputSet', 2),
  node(TEXT, SET, 3, 'CREV QA Text input', 'crev_qa_text_input', 'TextInput'),
  node(DATE, SET, 3, 'CREV QA Date input', 'crev_qa_date_input', 'DateInput'),
];

const obj = (rid: string, o: Partial<BmpObject> = {}): BmpObject => ({ rid, source: 'server', discoveredAt: 0, updatedAt: 0, ...o });

function input(over: Partial<ResultsInput> = {}): ResultsInput {
  return {
    query: '', scope: 'here', type: 'all', nodes: TREE, cache: [], live: emptyLive(), resolved: null,
    avail: { tree: true, live: true }, ...over,
  };
}

describe('query kinds', () => {
  it('detects a pasted RID only for 15 to 20 digits; short numbers are IDs', () => {
    expect(isRidQuery('9223372036854775807')).toBe(true);
    expect(isRidQuery(' 7282092580979928955 ')).toBe(true);
    expect(isRidQuery('113')).toBe(false);
    expect(isRidQuery('crev_qa_text')).toBe(false);
  });

  it('treats one ID-shaped token as worth an exact lookup', () => {
    expect(isIdLike('crev_qa_text')).toBe(true);
    expect(isIdLike('ceras.113')).toBe(true);
    expect(isIdLike('risk owner')).toBe(false);
    expect(isIdLike('x')).toBe(false);
  });
});

describe('ranking', () => {
  it('ranks a name start before a word start before a match inside a word, and drops non-matches', () => {
    const list = [
      { name: 'Comment input', id: 'a' },
      { name: 'Inputs overview', id: 'b' },
      { name: 'Reinput', id: 'c' },
      { name: 'Risk', id: 'd' },
    ];
    expect(rank(list, ['input']).map(x => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('needs every token, in the name or the ID', () => {
    expect(rank([{ name: 'Date input', id: 'crev_qa_date' }], ['date', 'crev']).length).toBe(1);
    expect(rank([{ name: 'Date input', id: 'x' }], ['date', 'crev']).length).toBe(0);
  });

  it('filters by family', () => {
    expect(typeMatches('CeRiskAssessment', 'enterprise')).toBe(true);
    expect(typeMatches('Scorecard', 'enterprise')).toBe(false);
    expect(typeMatches('Scorecard', 'web')).toBe(true);
    expect(typeMatches('', 'web')).toBe(false);
    expect(typeMatches('', 'all')).toBe(true);
  });
});

describe('grouped results', () => {
  it('puts an exact business ID on this page first as a single go-to row and keeps it out of the groups', () => {
    const r = buildResults(input({ query: 'crev_qa_date_input' }));
    expect(r.goTo?.rid).toBe(DATE);
    // The second line says where it is (inside the page), not how it matched.
    expect(r.goTo?.path).toEqual(['CREV QA Input view', 'CREV QA Input set']);
    expect(r.onPage.map(e => e.rid)).not.toContain(DATE);
  });

  it('resolves an exact RID from the lookup and shows nothing else', () => {
    const rid = '8186111290175263756';
    const r = buildResults(input({
      query: rid,
      resolved: { rid, type: 'ButtonGroup', name: 'CREV QA Button group', businessId: 'crev_qa_button_group' },
    }));
    expect(r.isRid).toBe(true);
    expect(r.goTo).toMatchObject({ rid, name: 'CREV QA Button group' });
    expect(r.goTo?.path).toEqual([]);
    expect(r.onPage).toEqual([]);
    expect(r.empty).toBe(false);
  });

  it('says what an empty answer searched', () => {
    const live = { ...emptyLive(), query: 'zzz', status: 'ready' as const };
    expect(buildResults(input({ query: 'zzz', live })).coverage).toBe('Searched the workspace live. Also checked the 5 objects on this page and the objects you touched.');
    expect(buildResults(input({ query: 'zzz', scope: 'workspace', live })).coverage).toBe('Searched the workspace live. Also checked the objects you touched.');
    expect(buildResults(input({ query: 'zzz', avail: { tree: true, live: false } })).coverage).toBe('Not searched: live search is unavailable, so only the objects you touched were checked.');
    expect(buildResults(input({ query: 'zzz', live: { ...live, status: 'error', error: 'Timed out.' } })).coverage).toBe('Not searched: the server search failed (Timed out).');
  });

  it('reports an unknown RID as empty', () => {
    expect(buildResults(input({ query: '1234567890123456789' })).empty).toBe(true);
  });

  it('shows on-page matches with their path inside the page, then workspace hits not already on the page', () => {
    const live = { ...emptyLive(), query: 'input', status: 'ready' as const, page: 1,
      items: [obj(DATE, { name: 'CREV QA Date input', type: 'DateInput' }), obj('5000000000000000001', { name: 'Comment input', type: 'TextInput', pageName: 'Issue edit page' })] };
    const r = buildResults(input({ query: 'input', live }));
    const date = r.onPage.find(e => e.rid === DATE)!;
    // The page's own name is left out: the group header already says it.
    expect(date.path).toEqual(['CREV QA Input view', 'CREV QA Input set']);
    expect(r.onPage.find(e => e.rid === VIEW)!.path).toEqual([]);
    expect(r.rest.label).toBe('Workspace');
    expect(r.rest.items.map(e => e.rid)).toEqual(['5000000000000000001']);
    expect(r.rest.items[0].path).toEqual(['Issue edit page']);
  });

  it('gives a workspace hit its location (page, then web parent) without repeats or itself', () => {
    expect(locationPath({ rid: '1', name: 'Risk', pageRid: '2', pageName: 'Risks', webParentRid: '3', webParentName: 'Risk register' })).toEqual(['Risks', 'Risk register']);
    expect(locationPath({ rid: '1', name: 'Risk', pageRid: '2', pageName: 'Risks', webParentRid: '2', webParentName: 'Risks' })).toEqual(['Risks']);
    // A page found by search is its own page location: nothing to say.
    expect(locationPath({ rid: '2', name: 'Risks', pageRid: '2', pageName: 'Risks' })).toEqual([]);
  });

  it('keeps the template name in the path of a presenting template row', () => {
    const TPL = '9000000000000000001';
    const WIDGET = '9000000000000000002';
    const nodes = [...TREE, node(TPL, null, 0, 'Risk page design', 'risk_tpl', 'EnterpriseTemplate', 1, 1), node(WIDGET, TPL, 1, 'Risk input view', 'risk_iv', 'InputView', 0, 1)];
    const r = buildResults(input({ query: 'risk input', nodes }));
    expect(r.onPage.find(e => e.rid === WIDGET)?.path).toEqual(['Risk page design']);
  });

  it('scope Workspace has no on-page group and keeps the on-page objects in Workspace', () => {
    const live = { ...emptyLive(), query: 'input', status: 'ready' as const, page: 1, items: [obj(DATE, { name: 'CREV QA Date input', type: 'DateInput' })] };
    const r = buildResults(input({ query: 'input', scope: 'workspace', live }));
    expect(r.onPage).toEqual([]);
    expect(r.rest.items.map(e => e.rid)).toEqual([DATE]);
  });

  it('marks Workspace loading until the live answer for this query arrives, still listing touched matches', () => {
    const cache = [obj('5000000000000000002', { name: 'Input source', type: 'TextMethodConfig' })];
    const r = buildResults(input({ query: 'input', cache, live: { ...emptyLive(), query: 'inp', status: 'ready' } }));
    expect(r.rest.loading).toBe(true);
    expect(r.rest.items.map(e => e.rid)).toEqual(['5000000000000000002']);
    expect(r.empty).toBe(false);
  });

  it('holds touched objects back while another live page exists, so Show more always adds rows', () => {
    const cache = [obj('5000000000000000002', { name: 'Risk touched' })];
    const base = { ...emptyLive(), query: 'risk', status: 'ready' as const, page: 1, items: [obj('5000000000000000003', { name: 'Risk' })] };
    expect(buildResults(input({ query: 'risk', cache, live: { ...base, more: true } })).rest.items.map(e => e.rid)).toEqual(['5000000000000000003']);
    expect(buildResults(input({ query: 'risk', cache, live: base })).rest.items.map(e => e.rid)).toEqual(['5000000000000000003', '5000000000000000002']);
  });

  it('offers Show more only when another page exists', () => {
    const base = { ...emptyLive(), query: 'risk', status: 'ready' as const, page: 1, items: [obj('5000000000000000003', { name: 'Risk' })] };
    expect(buildResults(input({ query: 'risk', live: { ...base, more: true } })).rest.more).toBe(true);
    expect(buildResults(input({ query: 'risk', live: base })).rest.more).toBe(false);
  });

  it('applies the type filter to every group', () => {
    const live = { ...emptyLive(), query: 'input', status: 'ready' as const, page: 1, items: [obj('5000000000000000004', { name: 'Input risk', type: 'CeRiskAssessment' })] };
    const r = buildResults(input({ query: 'input', type: 'enterprise', live }));
    expect(r.onPage).toEqual([]);
    expect(r.rest.items.map(e => e.rid)).toEqual(['5000000000000000004']);
  });

  it('is empty with no match anywhere', () => {
    const r = buildResults(input({ query: 'zzq vendor', live: { ...emptyLive(), query: 'zzq vendor', status: 'ready' } }));
    expect(r.empty).toBe(true);
  });
});

describe('degraded states', () => {
  it('without a portal session, live search is off and touched objects stand in, with one line saying why', () => {
    const avail = availability('connected', 'Portal login required for workspace search.');
    expect(avail).toMatchObject({ tree: true, live: false });
    const cache = [obj('5000000000000000005', { name: 'Input source' })];
    const r = buildResults(input({ query: 'input', cache, avail }));
    expect(r.rest.label).toBe('Touched objects');
    expect(r.rest.items.map(e => e.rid)).toEqual(['5000000000000000005']);
    expect(r.rest.loading).toBe(false);
    expect(r.note).toBe('Not signed in to the portal. Showing objects you touched.');
    expect(r.onPage.length).toBeGreaterThan(0);
  });

  it('not connected: no tree, no live search, a reason', () => {
    expect(availability('not-configured')).toMatchObject({ tree: false, live: false, reason: 'No server is connected.' });
    expect(availability('needs-login')).toMatchObject({ tree: false, live: false, reason: 'Not signed in to the portal.' });
    expect(availability('unreachable').reason).toBe('The server cannot be reached.');
  });

  it('a transient check keeps everything available', () => {
    expect(availability('checking')).toEqual({ tree: true, live: true });
    expect(availability('reconnecting')).toEqual({ tree: true, live: true });
  });
});

describe('tree', () => {
  it('marks the current position only when the tree holds it', () => {
    expect(currentRow(TREE, DATE)).toBe(DATE);
    expect(currentRow(TREE, '9000000000000000000')).toBeNull();
    expect(currentRow(null, DATE)).toBeNull();
  });

  it('hides the rows under a collapsed node', () => {
    expect(visibleTree(TREE, new Set([SET])).map(n => n.rid)).toEqual([PAGE, VIEW, SET]);
    expect(visibleTree(TREE, new Set([VIEW])).map(n => n.rid)).toEqual([PAGE, VIEW]);
  });

  it('folds a long tree below its second level but keeps the path to the current position open', () => {
    const long: BrowseNode[] = [node(PAGE, null, 0, 'P', 'p', 'Scorecard', 2)];
    long.push(node('100000000000000001', PAGE, 1, 'A', 'a', 'InputView', 1));
    long.push(node('100000000000000002', '100000000000000001', 2, 'S', 's', 'InputSet', LONG_TREE));
    for (let i = 0; i < LONG_TREE; i++) long.push(node(`2000000000000000${String(i).padStart(2, '0')}`, '100000000000000002', 3, `I${i}`, `i${i}`, 'TextInput'));
    expect(defaultCollapsed(long, null).has('100000000000000002')).toBe(true);
    expect(defaultCollapsed(long, '200000000000000005').has('100000000000000002')).toBe(false);
    expect(defaultCollapsed(TREE, null).size).toBe(0);
  });

  it('opens Pinned and Recent unless the tree above is long', () => {
    expect(listsOpenByDefault('here', '', 5)).toBe(true);
    expect(listsOpenByDefault('here', '', 30)).toBe(false);
    expect(listsOpenByDefault('workspace', '', 30)).toBe(true);
  });
});

describe('keyboard movement', () => {
  const keys = ['g:1', 'p:2', 'p:3', 'more', 'code'];
  it('moves and stops at the ends', () => {
    expect(moveSelection(keys, 'p:2', 1)).toBe('p:3');
    expect(moveSelection(keys, 'code', 1)).toBe('code');
    expect(moveSelection(keys, 'g:1', -1)).toBe('g:1');
  });
  it('starts at the current position, else the first or last row', () => {
    expect(moveSelection(keys, null, 1, 'p:3')).toBe('p:3');
    expect(moveSelection(keys, null, 1)).toBe('g:1');
    expect(moveSelection(keys, null, -1)).toBe('code');
    expect(moveSelection([], null, 1)).toBeNull();
  });
});
