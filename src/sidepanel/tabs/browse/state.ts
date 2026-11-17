/**
 * Browse tab — state rules (pure: no DOM, no messaging).
 *
 * What a query means (exact RID or business ID, words), how results are
 * grouped and ranked, which tree row is the current position, which rows are
 * visible, how the keyboard moves, and what still works when the connection
 * or the portal sign-in is missing. The view (view.ts) draws what these
 * functions return; the data source (source.ts) feeds them.
 */

import type { BmpObject, ConnectionState } from '../../../lib/types';
import type { BrowseNode, ObjectHit } from '../../../lib/browse-tree';
import { blendResults } from '../../../lib/browse-blend';
import { resolveDisplayIdentity } from '../../../lib/object-identity';
import { coverageText } from '../../../lib/coverage-line';

export type Scope = 'here' | 'workspace';
export type TypeFilter = 'all' | 'enterprise' | 'web';

export const TYPE_FILTERS: ReadonlyArray<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All types' },
  { value: 'enterprise', label: 'Enterprise objects' },
  { value: 'web', label: 'Other objects' },
];

/** One object as a result or list row. `id` is the ID the row shows and
 *  Copy ID copies (template ID first for a template-linked instance). */
export interface Entry {
  rid: string;
  name: string;
  type: string;
  id: string;
  /** Where the object is, outermost first: for a row of this page its
   *  ancestors inside the page (the page itself left out); for a workspace
   *  hit its page and web parent. Empty when there is nothing to say. */
  path: string[];
  onPage: boolean;
}

// ── Query ─────────────────────────────────────────────────────────

/** A pasted RID: 15 to 20 digits. BMP rids are Java longs and stay strings.
 *  Shorter numbers are business IDs (enterprise objects use "113"). */
export function isRidQuery(q: string): boolean {
  return /^-?\d{15,20}$/.test(q.trim());
}

/** One token that can be a business ID or a RID: worth an exact lookup. */
export function isIdLike(q: string): boolean {
  const t = q.trim();
  return t.length >= 2 && /^[A-Za-z0-9_.:-]+$/.test(t);
}

export function tokens(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

// ── Ranking ───────────────────────────────────────────────────────

/** Lower is better; -1 when a token is in neither the name nor the ID.
 *  A token at the start of the name ranks first, at a word start next, inside
 *  a word after that, and in the ID only last. Shorter names break ties. */
export function score(name: string, id: string, toks: readonly string[]): number {
  const n = name.toLowerCase();
  const i = id.toLowerCase();
  let s = 0;
  for (const t of toks) {
    const a = n.indexOf(t);
    const b = i.indexOf(t);
    if (a < 0 && b < 0) return -1;
    s += a === 0 ? 0 : a > 0 ? (/[\s\-_–—·(]/.test(n[a - 1]) ? 1 : 3) : 5;
  }
  return s + n.length / 1000;
}

export function rank<T extends { name: string; id: string }>(list: readonly T[], toks: readonly string[]): T[] {
  return list
    .map((o, i) => ({ o, i, s: score(o.name, o.id, toks) }))
    .filter(x => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map(x => x.o);
}

export function isEnterpriseType(type: string): boolean {
  return /^Ce[A-Z]/.test(type);
}

export function typeMatches(type: string, filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (!type) return false;
  return filter === 'enterprise' ? isEnterpriseType(type) : !isEnterpriseType(type);
}

// ── Entries ───────────────────────────────────────────────────────

/** Ancestor names of every tree node (within its own group). */
export function treePaths(nodes: readonly BrowseNode[]): Map<string, string[]> {
  const byRid = new Map(nodes.map(n => [n.rid, n]));
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    const p = n.parent ? byRid.get(n.parent) : undefined;
    out.set(n.rid, p ? [...(out.get(p.rid) ?? []), p.name || p.businessId || '(unnamed)'] : []);
  }
  return out;
}

/** A tree row as a result. `ancestors` are its ancestors in the tree
 *  (treePaths). The page's own name is left out: the "On this page" group
 *  already says it. A presenting template's rows keep the template's name. */
export function nodeEntry(n: BrowseNode, ancestors: readonly string[]): Entry {
  return { rid: n.rid, name: n.name, type: n.type, id: n.businessId, path: n.group === 0 ? ancestors.slice(1) : [...ancestors], onPage: true };
}

/** Location of a workspace hit: its page, then its web parent, without
 *  repeats and without the object itself. */
export function locationPath(o: Pick<BmpObject, 'rid' | 'name' | 'pageRid' | 'pageName' | 'webParentRid' | 'webParentName'>): string[] {
  const out: string[] = [];
  const add = (rid: string | undefined, name: string | undefined) => {
    const n = name?.trim();
    if (!n || rid === o.rid || n === o.name || out.includes(n)) return;
    out.push(n);
  };
  add(o.pageRid, o.pageName);
  add(o.webParentRid, o.webParentName);
  return out;
}

export function objectEntry(o: BmpObject, onPage = false): Entry {
  const id = resolveDisplayIdentity({ rid: o.rid, businessId: o.businessId, templateBusinessId: o.templateBusinessId });
  return {
    rid: o.rid,
    name: o.name ?? '',
    type: o.type ?? '',
    id: id.primaryKind === 'template' || id.primaryKind === 'instance' ? id.primary : '',
    path: locationPath(o),
    onPage,
  };
}

// ── Degraded states ───────────────────────────────────────────────

export interface Availability {
  /** The page structure can be read (binary command channel). */
  tree: boolean;
  /** Live workspace search can run (portal session). */
  live: boolean;
  /** One quiet line saying why something is unavailable. */
  reason?: string;
}

const PORTAL_LOGIN = /portal login required|portal sign-?in/i;

/** What works for this connection state. `liveError` is the last workspace
 *  search error: a missing portal session shows there first. */
export function availability(display: ConnectionState['display'], liveError?: string | null): Availability {
  const live = liveError && PORTAL_LOGIN.test(liveError)
    ? { live: false, reason: 'Not signed in to the portal.' }
    : { live: true };
  switch (display) {
    case 'connected':
    case 'checking':
    case 'reconnecting':
      return { tree: true, ...live };
    case 'online':
      return { tree: false, live: live.live, reason: live.reason ?? 'Signed in to the portal only; page structure needs the command connection.' };
    case 'needs-login':
      return { tree: false, live: false, reason: 'Not signed in to the portal.' };
    case 'not-configured':
      return { tree: false, live: false, reason: 'No server is connected.' };
    case 'needs-access':
      return { tree: false, live: false, reason: 'Site access to this server is not granted.' };
    case 'unreachable':
    case 'server-down':
      return { tree: false, live: false, reason: 'The server cannot be reached.' };
    case 'not-workspace':
      return { tree: false, live: false, reason: 'The server address is not a BMP workspace. See Connect.' };
    case 'needs-password':
      return { tree: false, live: false, reason: 'The stored password must be entered again. See Connect.' };
    case 'auth-failed':
    case 'no-config-access':
    case 'identity-mismatch':
    case 'command-failed':
      return { tree: false, live: false, reason: 'The connection is not working. See Connect.' };
    default:
      return { tree: true, live: true };
  }
}

// ── Results ───────────────────────────────────────────────────────

export type LiveStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface LiveState {
  query: string;
  status: LiveStatus;
  /** Every loaded page's hits in page order, de-duplicated. */
  items: BmpObject[];
  /** Hits per page (index 0 = page 1), each the page's latest answer. */
  pages: BmpObject[][];
  /** Pages loaded so far (quickSearch pages are 1-based). */
  page: number;
  /** Another page can be asked for. */
  more: boolean;
  moreLoading: boolean;
  totalHits: number;
  error?: string;
}

export function emptyLive(): LiveState {
  return { query: '', status: 'idle', items: [], pages: [], page: 0, more: false, moreLoading: false, totalHits: 0 };
}

export interface ResultsInput {
  query: string;
  scope: Scope;
  type: TypeFilter;
  /** The Here tree; null while it is not loaded. */
  nodes: readonly BrowseNode[] | null;
  /** Touched objects matching the query (the service worker's cache). */
  cache: readonly BmpObject[];
  live: LiveState;
  /** The exact RID / ID lookup for this query, when it answered. */
  resolved: ObjectHit | null;
  avail: Availability;
}

export interface Results {
  isRid: boolean;
  goTo: Entry | null;
  onPage: Entry[];
  /** Live results (scope workspace / here), or the touched objects alone
   *  when live search is unavailable. */
  rest: {
    label: 'Workspace' | 'Touched objects';
    items: Entry[];
    loading: boolean;
    more: boolean;
    moreLoading: boolean;
  };
  /** Quiet line about a degraded state. */
  note: string | null;
  empty: boolean;
  /** How the answer was reached (what was searched); shown under an empty result. */
  coverage: string;
  /** The configuration search's line for its results (a cut). */
  searchNote?: string | null;
}

/** What an empty (or any) answer searched: the server live, or only what was touched. */
export function searchCoverage(inp: Pick<ResultsInput, 'scope' | 'nodes' | 'live' | 'avail'>, q: string): string {
  if (!inp.avail.live) {
    return coverageText({ kind: 'not-searched', reason: 'live search is unavailable, so only the objects you touched were checked' });
  }
  if (inp.live.query === q && inp.live.status === 'error') {
    return coverageText({ kind: 'not-searched', reason: `the server search failed${inp.live.error ? ` (${inp.live.error.replace(/\.$/, '')})` : ''}` });
  }
  const page = inp.scope === 'here' && inp.nodes?.length ? `the ${inp.nodes.length === 1 ? 'object' : `${inp.nodes.length} objects`} on this page and ` : '';
  return coverageText({ kind: 'live', objects: 0, what: 'the workspace', note: `Also checked ${page}the objects you touched` });
}

function sameId(a: string | undefined, q: string): boolean {
  return !!a && a.toLowerCase() === q.toLowerCase();
}

export function buildResults(inp: ResultsInput): Results {
  const q = inp.query.trim();
  const toks = tokens(q);
  const isRid = isRidQuery(q);
  const nodes = inp.nodes ?? [];
  const paths = treePaths(nodes);
  const treeRids = new Set(nodes.map(n => n.rid));

  // Exact match: the tree first (it can be revealed), then what we know.
  let goTo: Entry | null = null;
  const node = nodes.find(n => (isRid ? n.rid === q : sameId(n.businessId, q)));
  if (node) goTo = nodeEntry(node, paths.get(node.rid) ?? []);
  const asNode = (rid: string) => {
    const n = nodes.find(x => x.rid === rid);
    return n ? nodeEntry(n, paths.get(n.rid) ?? []) : null;
  };
  if (!goTo) {
    const known = [...inp.live.items, ...inp.cache].find(o =>
      isRid ? o.rid === q : sameId(o.businessId, q) || sameId(o.templateBusinessId, q));
    if (known) goTo = asNode(known.rid) ?? objectEntry(known);
  }
  if (!goTo && inp.resolved && (isRid ? inp.resolved.rid === q : sameId(inp.resolved.businessId, q))) {
    const r = inp.resolved;
    goTo = asNode(r.rid) ?? { rid: r.rid, name: r.name, type: r.type, id: r.businessId, path: [], onPage: false };
  }
  const skip = new Set(goTo ? [goTo.rid] : []);

  const note = q && !inp.avail.live && inp.avail.reason
    ? `${inp.avail.reason} Showing objects you touched.`
    : null;

  if (isRid) {
    return {
      isRid, goTo, onPage: [],
      rest: { label: 'Workspace', items: [], loading: false, more: false, moreLoading: false },
      note: null, empty: !goTo, coverage: searchCoverage(inp, q),
    };
  }

  const onPage = inp.scope === 'here'
    ? rank(nodes.filter(n => !skip.has(n.rid) && typeMatches(n.type, inp.type)).map(n => nodeEntry(n, paths.get(n.rid) ?? [])), toks)
    : [];
  const shownOnPage = new Set(inp.scope === 'here' ? treeRids : []);
  const keep = (o: BmpObject) => !skip.has(o.rid) && !shownOnPage.has(o.rid) && typeMatches(o.type ?? '', inp.type);

  let rest: Results['rest'];
  if (!inp.avail.live) {
    const local = rank(inp.cache.filter(keep).map(o => objectEntry(o)), toks);
    rest = { label: 'Touched objects', items: local, loading: false, more: false, moreLoading: false };
  } else {
    const liveFresh = inp.live.query === q;
    const liveItems = liveFresh && inp.live.status !== 'loading' ? inp.live.items : [];
    const blended = blendResults([], liveItems.filter(keep), { ceTypes: new Set(), webTypes: new Set(), source: 'all', sort: 'relevance' });
    const liveRids = new Set(blended.map(o => o.rid));
    const loading = !liveFresh || inp.live.status === 'loading';
    // Touched objects the live search did not return: ranked after it, once
    // the live search has no further page. Before that, a later page would
    // mostly bring hits already listed at the tail as touched objects, and
    // Show more would seem to add nothing.
    const liveHasMore = !loading && inp.live.status === 'ready' && inp.live.more;
    const touched = liveHasMore ? [] : rank(inp.cache.filter(o => keep(o) && !liveRids.has(o.rid)).map(o => objectEntry(o)), toks);
    rest = {
      label: 'Workspace',
      items: [...blended.map(o => objectEntry(o)), ...touched],
      loading,
      more: !loading && inp.live.more,
      moreLoading: !loading && inp.live.moreLoading,
    };
  }

  const empty = !goTo && onPage.length === 0 && rest.items.length === 0 && !rest.loading;
  return { isRid, goTo, onPage, rest, note, empty, coverage: searchCoverage(inp, q) };
}

// ── Tree ──────────────────────────────────────────────────────────

/** Rids of `rid`'s ancestors, nearest first. */
export function ancestorsOf(nodes: readonly BrowseNode[], rid: string): string[] {
  const byRid = new Map(nodes.map(n => [n.rid, n]));
  const out: string[] = [];
  let cur = byRid.get(rid);
  while (cur?.parent && out.length < 64) {
    out.push(cur.parent);
    cur = byRid.get(cur.parent);
  }
  return out;
}

/** The tree row marked as the current position: the position itself when the
 *  tree holds it, else none. */
export function currentRow(nodes: readonly BrowseNode[] | null, positionRid: string | null | undefined): string | null {
  if (!nodes || !positionRid) return null;
  return nodes.some(n => n.rid === positionRid) ? positionRid : null;
}

/** Rows hidden by collapsed ancestors are left out. */
export function visibleTree(nodes: readonly BrowseNode[], collapsed: ReadonlySet<string>): BrowseNode[] {
  const out: BrowseNode[] = [];
  let skipDepth: number | null = null;
  let skipGroup = -1;
  for (const n of nodes) {
    if (skipDepth !== null) {
      if (n.group === skipGroup && n.depth > skipDepth) continue;
      skipDepth = null;
    }
    out.push(n);
    if (n.kids > 0 && collapsed.has(n.rid)) { skipDepth = n.depth; skipGroup = n.group; }
  }
  return out;
}

/** A long tree opens folded below its second level (the template of a data
 *  object below its first), with the path to the current position open. */
export const LONG_TREE = 40;

export function defaultCollapsed(nodes: readonly BrowseNode[], current: string | null): Set<string> {
  const out = new Set<string>();
  if (nodes.length > LONG_TREE) {
    for (const n of nodes) if (n.kids > 0 && n.depth >= (n.group === 1 ? 1 : 2)) out.add(n.rid);
  }
  if (current) for (const a of ancestorsOf(nodes, current)) out.delete(a);
  return out;
}

/** Pinned and Recent start open unless the tree above them is long. */
export const LISTS_OPEN_MAX_ROWS = 10;

export function listsOpenByDefault(scope: Scope, query: string, treeRows: number): boolean {
  return scope === 'workspace' || treeRows <= LISTS_OPEN_MAX_ROWS;
}

// ── Keyboard ──────────────────────────────────────────────────────

/** Next selection among the rows that can take it, in display order. With
 *  nothing selected, Down starts at `from` (the current position) or the
 *  first row, Up at the last. Movement stops at the ends. */
export function moveSelection(keys: readonly string[], current: string | null, delta: number, from: string | null = null): string | null {
  if (!keys.length) return null;
  let i = current ? keys.indexOf(current) : -1;
  if (i < 0) {
    const f = from ? keys.indexOf(from) : -1;
    if (f >= 0) return keys[f];
    return delta > 0 ? keys[0] : keys[keys.length - 1];
  }
  i = Math.max(0, Math.min(keys.length - 1, i + delta));
  return keys[i];
}
