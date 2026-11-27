/**
 * Code search window, pure parts: the three two-level filters (Where, Kind
 * of code, Object type: a coarse first level, the real roots,
 * organisations, properties and types inside), keyboard navigation over
 * the grouped results, recent searches and the sentences that say what was
 * searched. No DOM, no chrome.*.
 */

import { CHART_TYPES } from '../lib/types';
import { CODE_KINDS, familyLabel, familyOfType, kindLabel, kindOfProp, OTHER_FAMILY, OTHER_KIND, propLabel, TYPE_FAMILIES, typeLabel } from '../lib/object-window-table';
import type { CodeSearchCoverage, CodeSearchHit, CodeSearchOutcome, CodeSearchProgress } from '../lib/code-search';
import { dateTimeText, timeOfDay } from '../lib/coverage-line';

export { propLabel, typeLabel };

// ── filters ───────────────────────────────────────────────────────

/** The filters: real types, real properties and Where keys (`root:<accessor>`,
 *  `org:<RID>`); empty lists mean "any" / everywhere. The groups of the
 *  menus are views over these lists, so saved searches keep working. */
export interface Filters { types: string[]; props: string[]; where: string[] }

// ── two-level menus ───────────────────────────────────────────────

/** One row of a two-level menu. A group's `on` is 'some' when only part of
 *  it is chosen; `keys` are the filter values it stands for. */
export interface TreeEntry {
  key: string;
  label: string;
  n?: number;
  on: boolean | 'some';
  keys: string[];
  children?: TreeEntry[];
}

const sortEntries = (a: TreeEntry, b: TreeEntry) => (b.n ?? 0) - (a.n ?? 0) || a.label.localeCompare(b.label);

function groupState(children: readonly TreeEntry[]): boolean | 'some' {
  const on = children.filter(c => c.on === true).length;
  return on === 0 ? (children.some(c => c.on === 'some') ? 'some' : false) : on === children.length ? true : 'some';
}

/** "Kind of code": the CODE_KINDS groups with the properties inside. `n`
 *  of a group: objects (kindCounts), of a property: objects (propCounts). */
export function kindTree(propKeys: Iterable<string>, propCounts: Readonly<Record<string, number>> | undefined, kindCounts: Readonly<Record<string, number>> | undefined, chosen: readonly string[], filter = ''): TreeEntry[] {
  const all = new Set<string>([...propKeys, ...Object.keys(propCounts ?? {}), ...chosen]);
  const groups = new Map<string, TreeEntry[]>();
  const needle = filter.trim().toLowerCase();
  for (const p of all) {
    if (!p) continue;
    const label = propLabel(p);
    const g = kindOfProp(p);
    if (needle && !label.toLowerCase().includes(needle) && !p.toLowerCase().includes(needle) && !kindLabel(g).toLowerCase().includes(needle)) continue;
    const list = groups.get(g) ?? [];
    list.push({ key: p, label, ...(propCounts ? { n: propCounts[p] ?? 0 } : {}), on: chosen.includes(p), keys: [p] });
    groups.set(g, list);
  }
  const out: TreeEntry[] = [];
  for (const k of [...CODE_KINDS.map(x => x.key), OTHER_KIND.key]) {
    const children = groups.get(k);
    if (!children?.length) continue;
    children.sort(sortEntries);
    out.push({ key: `kind:${k}`, label: kindLabel(k), ...(kindCounts ? { n: kindCounts[k] ?? 0 } : {}), on: groupState(children), keys: children.map(c => c.key), children });
  }
  return out;
}

/** "Object type": the TYPE_FAMILIES with the real types inside. A type is
 *  in one family, so a family's count is the sum of its types. */
export function familyTree(typeKeys: Iterable<string>, typeCounts: Readonly<Record<string, number>> | undefined, chosen: readonly string[], filter = ''): TreeEntry[] {
  const all = new Set<string>([...typeKeys, ...Object.keys(typeCounts ?? {}), ...chosen]);
  const groups = new Map<string, TreeEntry[]>();
  const needle = filter.trim().toLowerCase();
  for (const t of all) {
    if (!t) continue;
    const label = typeLabel(t);
    const f = familyOfType(t);
    if (needle && !label.toLowerCase().includes(needle) && !t.toLowerCase().includes(needle) && !familyLabel(f).toLowerCase().includes(needle)) continue;
    const list = groups.get(f) ?? [];
    list.push({ key: t, label, ...(typeCounts ? { n: typeCounts[t] ?? 0 } : {}), on: chosen.includes(t), keys: [t] });
    groups.set(f, list);
  }
  const out: TreeEntry[] = [];
  for (const k of [...TYPE_FAMILIES.map(x => x.key), OTHER_FAMILY.key]) {
    const children = groups.get(k);
    if (!children?.length) continue;
    children.sort(sortEntries);
    const n = typeCounts ? children.reduce((a, c) => a + (c.n ?? 0), 0) : undefined;
    out.push({ key: `family:${k}`, label: familyLabel(k), ...(n != null ? { n } : {}), on: groupState(children), keys: children.map(c => c.key), children });
  }
  return out;
}

/** `objects`: objects with code under the root, by the index; undefined
 *  when no index is loaded (the root is listed without a number). */
export interface WhereRoot { key: string; name: string; objects?: number; done?: boolean }

/** "Where": the roots that hold code (by the index), with the server's
 *  names; inside the organisation root the top-level organisations, then
 *  their sub-organisations. A chosen root or organisation covers what is
 *  below it. */
export function whereTree(
  roots: readonly WhereRoot[], orgs: Readonly<Record<string, { name: string; parent: string }>>,
  counts: Readonly<Record<string, number>> | undefined, chosen: readonly string[], filter = '',
): TreeEntry[] {
  const needle = filter.trim().toLowerCase();
  const kids = new Map<string, string[]>();
  for (const [rid, g] of Object.entries(orgs)) { const l = kids.get(g.parent) ?? []; l.push(rid); kids.set(g.parent, l); }
  const orgEntry = (rid: string, parentOn: boolean, depth: number): TreeEntry | null => {
    const key = `org:${rid}`;
    const self = chosen.includes(key);
    const children = depth < 6 ? (kids.get(rid) ?? []).map(k => orgEntry(k, parentOn || self, depth + 1)).filter((e): e is TreeEntry => !!e) : [];
    const n = counts?.[key] ?? 0;
    const name = orgs[rid]?.name || rid;
    const hit = !needle || name.toLowerCase().includes(needle) || children.length > 0;
    if ((counts && !n && !self) || !hit) return null;
    children.sort(sortEntries);
    const on: TreeEntry['on'] = parentOn || self ? true : children.some(c => c.on) ? 'some' : false;
    return { key, label: name, ...(counts ? { n } : {}), on, keys: [key], ...(children.length ? { children } : {}) };
  };
  const out: TreeEntry[] = [];
  for (const r of roots) {
    const key = `root:${r.key}`;
    const n = counts ? counts[key] ?? 0 : r.objects;
    const self = chosen.includes(key);
    if (r.objects === 0 && !self) continue; // a root without code is not listed
    const children = r.key === 'organisation'
      ? (kids.get('') ?? []).map(t => orgEntry(t, self, 0)).filter((e): e is TreeEntry => !!e).sort(sortEntries)
      : [];
    if (needle && !r.name.toLowerCase().includes(needle) && !children.length) continue;
    const on: TreeEntry['on'] = self ? true : children.some(c => c.on) ? 'some' : false;
    out.push({ key, label: r.name, ...(n != null ? { n } : {}), on, keys: [key], ...(children.length ? { children } : {}) });
  }
  return out;
}

/** Choose or clear a whole entry (a group, or one real entry). Choosing a
 *  group of real entries adds its children; choosing a Where node replaces
 *  what is chosen below it. */
export function toggleEntry(chosen: readonly string[], e: TreeEntry): string[] {
  if (e.on === true) {
    const drop = new Set(e.keys);
    for (const d of descendants(e)) drop.add(d);
    return chosen.filter(k => !drop.has(k));
  }
  const below = new Set(descendants(e));
  return [...chosen.filter(k => !below.has(k) && !e.keys.includes(k)), ...e.keys];
}

function descendants(e: TreeEntry): string[] {
  return (e.children ?? []).flatMap(c => [...c.keys, ...descendants(c)]);
}

/** The chosen entries in words: a whole group by its name, else the
 *  entries chosen inside. */
export function chosenLabels(tree: readonly TreeEntry[], chosen: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly TreeEntry[]) => {
    for (const e of list) {
      if (e.on === true && (e.children?.length || chosen.includes(e.key) || e.keys.every(k => chosen.includes(k)))) { out.push(e.label); continue; }
      if (e.children) walk(e.children);
    }
  };
  walk(tree);
  return out;
}

/** The result-bar chips: the most frequent kinds of code of the results
 *  (not one already chosen alone). */
export function topKinds(kindCounts: Readonly<Record<string, number>>, chosenProps: readonly string[], max = 3): Array<{ kind: string; label: string; n: number }> {
  const chosenKinds = new Set(chosenProps.map(kindOfProp));
  if (chosenKinds.size === 1 && chosenProps.length) return [];
  return Object.entries(kindCounts).filter(([, n]) => n > 0)
    .map(([kind, n]) => ({ kind, label: kindLabel(kind), n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, max);
}

/** One entry of a filter menu. `n`: objects the filter gives for the
 *  current query (undefined: no query yet). */
export interface FacetEntry { key: string; label: string; n?: number; on: boolean }

/**
 * Entries of a filter menu: every key the index holds or the search counted,
 * plus the chosen ones; most objects first, then by label. `filter` narrows
 * by label or internal name (the menu's filter field).
 */
export function facetEntries(
  keys: Iterable<string>,
  counts: Readonly<Record<string, number>> | undefined,
  chosen: readonly string[],
  labelOf: (key: string) => string,
  filter = '',
): FacetEntry[] {
  const all = new Set<string>([...keys, ...Object.keys(counts ?? {}), ...chosen]);
  const needle = filter.trim().toLowerCase();
  const out: FacetEntry[] = [];
  for (const key of all) {
    if (!key) continue;
    const label = labelOf(key);
    if (needle && !label.toLowerCase().includes(needle) && !key.toLowerCase().includes(needle)) continue;
    out.push({ key, label, ...(counts ? { n: counts[key] ?? 0 } : {}), on: chosen.includes(key) });
  }
  return out.sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

export interface IndexFacets {
  types: Record<string, number>;
  props: Record<string, number>;
  kinds: Record<string, number>;
  where: Record<string, number>;
}

/** Types, properties, kinds of code and places of the index (menus before
 *  the first query), with the objects that hold code there. An instance
 *  counts the properties it inherits. */
export function indexFacets(objects: Iterable<{ type: string; code: Record<string, string>; inherits?: string[]; root?: string; path?: string[] }>): IndexFacets {
  const types: Record<string, number> = {};
  const props: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const where: Record<string, number> = {};
  for (const o of objects) {
    types[o.type] = (types[o.type] ?? 0) + 1;
    const ks = new Set<string>();
    for (const p of new Set([...Object.keys(o.code).filter(p => o.code[p]), ...(o.inherits ?? [])])) { props[p] = (props[p] ?? 0) + 1; ks.add(kindOfProp(p)); }
    for (const k of ks) kinds[k] = (kinds[k] ?? 0) + 1;
    if (o.root) where[`root:${o.root}`] = (where[`root:${o.root}`] ?? 0) + 1;
    for (const g of o.path ?? []) where[`org:${g}`] = (where[`org:${g}`] ?? 0) + 1;
  }
  return { types, props, kinds, where };
}

/** Add or remove `key` from a chosen list. */
export function toggle(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter(k => k !== key) : [...list, key];
}

/** Menu button text: "Any type", "Extended table", "Extended table +2". */
export function filterButtonText(chosen: readonly string[], labelOf: (key: string) => string, any: string): string {
  if (!chosen.length) return any;
  const first = labelOf(chosen[0]);
  return chosen.length === 1 ? first : `${first} +${chosen.length - 1}`;
}

/** "any type", "Extended table", "Extended table or Button" (sentences). */
export function filterWords(chosen: readonly string[], labelOf: (key: string) => string, any: string): string {
  if (!chosen.length) return any;
  const labels = chosen.map(labelOf);
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/** The narrowing chips of the result bar: the most frequent types of the
 *  results (not the one already chosen alone). */
export function topTypes(byType: Readonly<Record<string, number>>, chosen: readonly string[], max = 3): Array<{ type: string; label: string; n: number }> {
  if (chosen.length === 1) return [];
  return Object.entries(byType).filter(([, n]) => n > 0)
    .map(([type, n]) => ({ type, label: typeLabel(type), n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, max);
}

/** Type filters of the earlier "Code of" groups, so saved searches keep
 *  their meaning. */
const LEGACY_CODE_OF: Readonly<Record<string, readonly string[]>> = {
  all: [],
  expr: ['ExtendedExpression'],
  gates: ['ExtendedExpression'],
  tables: ['ExtendedTable'],
  calc: ['ExtendedMethodConfig'],
  charts: CHART_TYPES,
  viz: ['CustomVisualization'],
  actions: ['ActionButton', 'ButtonInput', 'Label'],
  transports: ['ExtendedTransport'],
  text: ['TextElement'],
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const names = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && NAME.test(x)))].slice(0, 60) : []);

export function fmt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** "40 s", "3 min", "1 h 10 min". */
export function durationText(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

// ── navigation ────────────────────────────────────────────────────

/** One selectable row: a match line (`prop`, `line`) of an object. */
export interface NavRow { rid: string; prop: string; line: number; key: string }

export const rowKey = (rid: string, prop: string, line: number) => `${rid}:${prop}:${line}`;

/** Lines shown per object before "n more matches". */
export const LINES_SHOWN = 3;

/** Visible lines of a hit: the first few, or all when the object is opened up. */
export function visibleLines(hit: CodeSearchHit, all: boolean): Array<{ prop: string; line: CodeSearchHit['props'][number]['lines'][number] }> {
  const out: Array<{ prop: string; line: CodeSearchHit['props'][number]['lines'][number] }> = [];
  for (const p of hit.props) for (const l of p.lines) out.push({ prop: p.prop, line: l });
  return all ? out : out.slice(0, LINES_SHOWN);
}

export function navRows(hits: readonly CodeSearchHit[], collapsed: ReadonlySet<string>, allLines: ReadonlySet<string>): NavRow[] {
  const out: NavRow[] = [];
  for (const h of hits) {
    if (collapsed.has(h.rid)) continue;
    for (const v of visibleLines(h, allLines.has(h.rid))) out.push({ rid: h.rid, prop: v.prop, line: v.line.line, key: rowKey(h.rid, v.prop, v.line.line) });
  }
  return out;
}

/** The row `dir` steps from `current` (clamped at the ends). */
export function step(rows: readonly NavRow[], current: string | null, dir: 1 | -1): string | null {
  if (!rows.length) return null;
  const i = current ? rows.findIndex(r => r.key === current) : -1;
  if (i < 0) return (dir === 1 ? rows[0] : rows[rows.length - 1]).key;
  return rows[Math.min(rows.length - 1, Math.max(0, i + dir))].key;
}

// ── recent searches ───────────────────────────────────────────────

export interface RecentSearch {
  mode: 'text' | 'refs';
  query: string;
  /** Refs mode: the target. */
  target?: { rid: string; name?: string; type?: string; businessId?: string };
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Type and Property filters (empty: any). */
  types: string[];
  props: string[];
  /** Where keys with the names shown when saved (absent: everywhere). */
  where?: Array<{ key: string; label: string }>;
  scope?: { rid: string; name?: string; type?: string; businessId?: string };
  matches?: number;
  objects?: number;
}

export const RECENTS_MAX = 8;

export function recentKey(r: RecentSearch): string {
  return [r.mode, r.mode === 'refs' ? r.target?.rid : r.query, r.caseSensitive, r.wholeWord, r.regex,
    [...r.types].sort().join(','), [...r.props].sort().join(','), r.scope?.rid ?? '', (r.where ?? []).map(w => w.key).sort().join(',')].join('\u0001');
}

export function addRecent(list: readonly RecentSearch[], r: RecentSearch): RecentSearch[] {
  const k = recentKey(r);
  return [r, ...list.filter(x => recentKey(x) !== k)].slice(0, RECENTS_MAX);
}

export function removeRecent(list: readonly RecentSearch[], r: RecentSearch): RecentSearch[] {
  const k = recentKey(r);
  return list.filter(x => recentKey(x) !== k);
}

/** Saved recent searches. Entries of earlier versions are converted: their
 *  "Code of" group becomes the group's types; an unknown one means any. */
export function parseRecents(raw: unknown): RecentSearch[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentSearch[] = [];
  for (const r of raw as unknown[]) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown> & { target?: { rid?: unknown } };
    if ((o.mode !== 'text' && o.mode !== 'refs') || typeof o.query !== 'string') continue;
    if (o.mode === 'refs' && !(o.target && typeof o.target.rid === 'string' && /^-?\d{1,20}$/.test(o.target.rid))) continue;
    const legacy = typeof o.codeOf === 'string' && Object.hasOwn(LEGACY_CODE_OF, o.codeOf) ? [...LEGACY_CODE_OF[o.codeOf]] : [];
    const rest: Record<string, unknown> = { ...o };
    delete rest.codeOf;
    out.push({
      ...(rest as unknown as RecentSearch),
      caseSensitive: o.caseSensitive !== false, wholeWord: o.wholeWord === true, regex: o.regex === true,
      types: Array.isArray(o.types) ? names(o.types) : legacy,
      props: names(o.props),
      ...(whereOf(o.where).length ? { where: whereOf(o.where) } : {}),
    });
    if (out.length >= RECENTS_MAX) break;
  }
  return out;
}

const WHERE_KEY = /^(root:[a-z][A-Za-z0-9]{0,40}|org:-?\d{1,20})$/;
function whereOf(v: unknown): Array<{ key: string; label: string }> {
  if (!Array.isArray(v)) return [];
  return v.filter((w): w is { key: string; label: string } => !!w && typeof w === 'object' && typeof (w as { key?: unknown }).key === 'string' && WHERE_KEY.test((w as { key: string }).key))
    .map(w => ({ key: w.key, label: typeof w.label === 'string' ? w.label.slice(0, 120) : w.key })).slice(0, 40);
}

export function optionsText(r: Pick<RecentSearch, 'caseSensitive' | 'wholeWord' | 'regex' | 'types' | 'props' | 'scope' | 'where'>): string {
  const where = r.scope ? `Under ${r.scope.name || r.scope.businessId || r.scope.rid}` : r.where?.length ? filterButtonText(r.where.map(w => w.label), x => x, 'Everywhere') : 'Everywhere';
  const opts = [r.regex ? 'pattern' : '', r.caseSensitive ? 'match case' : '', r.wholeWord ? 'whole word' : ''].filter(Boolean);
  return [where, filterButtonText(r.types, typeLabel, 'Any type'), ...(r.props.length ? [filterButtonText(r.props, propLabel, 'Any property')] : []), ...opts].join(' · ');
}

// ── sentences ─────────────────────────────────────────────────────

export { dateTimeText, timeOfDay };

/** "234 objects · 311 matches" (refs: "6 places in 4 objects"). */
export function summaryText(o: CodeSearchOutcome, mode: 'text' | 'refs'): string {
  if (mode === 'refs') {
    const lines = o.lines < o.matches ? ` on ${plural(o.lines, 'line')}` : '';
    return `${plural(o.matches, 'place')}${lines} in ${plural(o.matchedObjects, 'object')}`;
  }
  return `${plural(o.matchedObjects, 'object')} · ${plural(o.matches, 'match', 'matches')}`;
}

/** Why the code was read from the server although a copy exists. */
const SERVER_REASON: Record<string, string> = {
  unavailable: 'A copy cannot be made of this server.',
  building: 'The copy is still being made.',
  paused: 'Copying stopped.',
  failed: 'The copy could not be made.',
};

/** The change feed of the window's server as the worker last told it
 *  (CODE_SEARCH_FEED): newer than the coverage of the last search. */
export interface FeedNow { health: 'fresh' | 'stale' | 'off'; at: number | null }

/** What was searched. Copy: "Searched 3,573 objects with code (copy from
 *  13 Nov, 14:02) in 0.1 s.", after a refresh "(copy checked 13 Nov,
 *  16:30)". Without a copy the code is read from the server once,
 *  kept while the window is open and matched here: "Read 3,025 objects from
 *  the server in 1.9 s. Kept while this window is open.", then "Searched
 *  3,025 objects in 0.3 s. No code changed since the last search." While the
 *  change feed keeps the code current: "Searched 12,456 objects in 0.4 s.
 *  Up to date as of 8 s ago." (the age of its last check, `feed` when the
 *  worker told a newer one); once it stopped: "The next search checks the
 *  server for changes again." */
export function coverageText(c: CodeSearchCoverage, now = Date.now(), indexState?: string, ms?: number, feed?: FeedNow | null): string {
  const of = c.searched < c.total ? `${fmt(c.searched)} of ${fmt(c.total)} objects with code` : `${plural(c.searched, 'object')} with code`;
  const took = ms != null ? ` in ${(ms / 1000).toFixed(1)} s` : '';
  if (c.source === 'server') {
    const failed = c.failedTypes?.length ? ` Not searched: ${c.failedTypes.map(t => (/^[A-Z]/.test(t) ? typeLabel(t) : t)).join(', ')}.` : '';
    const why = SERVER_REASON[indexState ?? ''] ? `${SERVER_REASON[indexState!]} ` : '';
    const objects = c.searched < c.total ? `${fmt(c.searched)} of ${fmt(c.total)} objects` : plural(c.searched, 'object');
    const read = c.read ?? 0;
    let what: string;
    const changed = Math.min(read, c.readChanged ?? 0);
    const added = read - changed;
    // "4 changed objects read again", "2,323 more objects read", or both.
    const readParts = [
      ...(changed ? [`${plural(changed, 'changed object')} read again`] : []),
      ...(added ? [changed ? `${fmt(added)} more read` : `${plural(added, 'more object')} read`] : []),
    ].join(' and ');
    if (c.narrowed) {
      // Too much code to read it all: the server picked the candidates.
      const got = read ? `${plural(read, 'object')} read from the server and matched here` : 'all of them were kept from the last search and matched here';
      what = `Searched ${objects}${took}. There is too much code to read it all, so the server first picked the objects that may match; ${got}.`;
    } else if (read && read >= c.searched) {
      what = `Read ${objects} from the server${took}. Kept while this window is open.`;
    } else if (read) {
      what = `Searched ${objects}${took}. ${readParts.charAt(0).toUpperCase()}${readParts.slice(1)} from the server; the rest was kept from the last search.`;
    } else if (c.listingReused) {
      // The server was not asked for changes this time (a listing a few
      // seconds old was used): say when it was.
      what = `Searched ${objects}${took}.`;
    } else {
      what = `Searched ${objects}${took}. No code changed on the server since the last search.`;
    }
    let checked = c.listingReused && c.checkedAt != null ? ` ${checkedText(c.checkedAt, now)}` : '';
    if (c.feedAt != null) {
      const at = feed?.health === 'fresh' && feed.at != null ? Math.max(feed.at, c.feedAt) : c.feedAt;
      if (feed && feed.health !== 'fresh') checked = ' The next search checks the server for changes again.';
      else checked = c.listingReused ? ` ${upToDateText(at, now)}` : '';
    }
    return `${why}${what}${checked}${failed}`;
  }
  if (c.scopedComplete) return `Searched ${plural(c.searched, 'object')} with code${took}: the chosen part is read completely.`;
  if (c.roots && !c.complete) {
    const org = c.roots.tops ? `; organisation: ${fmt(c.roots.tops.done)} of ${plural(c.roots.tops.total, 'top-level organisation')} read so far` : '';
    return `Searched ${plural(c.searched, 'object')} with code in the parts read so far${took}${org}.`;
  }
  if (c.pending && !c.complete) return `Searched ${of}${took}: the copy is still being made.`;
  const when = c.indexedAt ? ` (copy ${c.checked ? 'checked' : 'from'} ${dateTimeText(c.indexedAt, now)})` : '';
  return `Searched ${of}${when}${took}.`;
}

/** The change feed's last check: "Up to date as of 8 s ago." (a minute
 *  or more: the time of day). */
export function upToDateText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `Up to date as of ${s < 1 ? 'just now' : `${s} s ago`}.` : `Up to date as of ${timeOfDay(at, now)}.`;
}

/** "4.3 M" characters, "850 K", "120". */
export function charsText(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)} K`;
  return fmt(n);
}

/** How far a search without a copy is, in words: the listing ("Listing
 *  code on the server: 8,400 objects so far, source 7 of 12…"), then the
 *  read with what is searched so far and the size ("Reading code: 3,100 of
 *  12,456 objects (4.3 M characters)…"). */
export function progressText(p: CodeSearchProgress): string {
  if (p.phase === 'scan') {
    if (p.listed != null && p.sources) return `Listing code on the server: ${plural(p.listed, 'object')} so far, source ${fmt(Math.min(p.sources, Math.max(1, p.source ?? 1)))} of ${fmt(p.sources)}…`;
    return `Asking the server which objects may match: ${fmt(p.postsDone)} of ${fmt(p.posts)} ${p.posts === 1 ? 'request' : 'requests'}…`;
  }
  // The first search (or the first after the worker restarted) reads the
  // place's code once; later searches read only what changed.
  if (p.reading === 'all') {
    // The objects searched so far: kept ones first, then as they are read.
    const size = p.chars != null ? ` (${charsText(p.chars)} characters)` : '';
    if (p.total && p.searched != null) return `Reading code: ${fmt(Math.min(p.searched, p.total))} of ${fmt(p.total)} objects${size}…`;
    return `Reading code: ${fmt(p.read)} of ${fmt(p.candidates)} ${p.candidates === 1 ? 'object' : 'objects'}${size}…`;
  }
  return `Reading the objects the server picked: ${fmt(p.read)} of ${fmt(p.candidates)}…`;
}

/** When the server was last asked which code changed: "Checked for
 *  changes 12 s ago." (a minute or more: the time of day). */
export function checkedText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `Checked for changes ${s < 1 ? 'just now' : `${s} s ago`}.` : `Checked for changes at ${timeOfDay(at, now)}.`;
}

/** What a search "under an object" covered (code-search-scope): "Under
 *  Sandbox: the object and what is under it, its input set with what is
 *  under it, and what 2 buttons act on." */
export function scopeText(name: string, covered: { via?: { prop: string; found: boolean }; followed: number } | undefined): string {
  if (!covered) return `Under ${name}.`;
  const parts = ['the object and what is under it'];
  if (covered.via?.found) parts.push(`its ${propLabel(covered.via.prop).toLowerCase()} with what is under it`);
  if (covered.followed) parts.push(`what ${plural(covered.followed, 'button')} ${covered.followed === 1 ? 'acts' : 'act'} on`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  const missing = covered.via && !covered.via.found ? ` It has no ${propLabel(covered.via.prop).toLowerCase()}.` : '';
  return `Under ${name}: ${list}.${missing}`;
}

export interface IndexTextInput {
  state: string; syncedAt: number | null; objects: number; pending: number;
  progress?: { phase?: string; read: number; toRead: number }; last?: { changed: number; removed: number; first?: boolean };
  error?: string; codeTypes?: number; notCovered?: string[];
  roots?: Array<{ key: string; name: string; done: boolean; tops?: number; topsDone?: number }>;
  stage?: string;
  /** When the copy was made: a later `syncedAt` is a refresh's. */
  builtAt?: number | null;
  /** A copy made from the search's read (it changes only on Refresh), and
   *  whether the user stopped its last refresh. */
  copy?: boolean;
  stopped?: boolean;
}

/** Whether the copy's time is a refresh's: a refresh confirms the copy as
 *  of its own time (`syncedAt`), a build sets both times at once. */
const refreshed = (s: Pick<IndexTextInput, 'syncedAt' | 'builtAt'>) => s.syncedAt != null && s.builtAt != null && s.syncedAt !== s.builtAt;

/** "the copy from 13 Nov, 14:02" after a build, "the copy, checked 13 Nov,
 *  16:30" after a refresh. */
function theCopy(s: IndexTextInput, now: number): string {
  const at = dateTimeText(s.syncedAt ?? now, now);
  return refreshed(s) ? `the copy, checked ${at}` : `the copy from ${at}`;
}

/** The footer of a copy: when it was made or last refreshed, and what a
 *  refresh under way is doing. */
function copyText(s: IndexTextInput, now: number): string {
  const from = theCopy(s, now);
  const nc = s.notCovered?.length ? ` Not searched: ${s.notCovered.join('; ')}.` : '';
  if (s.state === 'refreshing') {
    const p = s.progress;
    const step = !p ? 'asking the server what changed'
      : p.phase === 'reading' && p.toRead ? `${fmt(Math.min(p.read, p.toRead))} of ${plural(p.toRead, 'object')} done`
      : 'listing the code on the server';
    return `Refreshing ${from}: ${step}… Searches use the copy until the refresh is done.`;
  }
  const after = s.stopped ? ' The refresh was stopped; the copy is unchanged.'
    : s.error ? ` The refresh failed: ${s.error.replace(/\.?\s*$/, '.')} The copy is unchanged.` : '';
  return `Searching ${from}.${nc}${after}`;
}

/** What a root-by-root build covers: "Template category, Portal,
 *  Expression … ready; Organization: 4 of 19". Null when every root is read. */
export function coverageLine(roots: IndexTextInput['roots']): string | null {
  if (!roots?.length || roots.every(r => r.done)) return null;
  const done = roots.filter(r => r.done).map(r => r.name);
  const ready = done.length ? `${done.slice(0, 3).join(', ')}${done.length > 3 ? ` and ${done.length - 3} more` : ''} ready` : '';
  const waiting = roots.filter(r => !r.done && r.tops == null).map(r => r.name);
  const org = roots.filter(r => !r.done && r.tops != null).map(r => `${r.name}: ${fmt(r.topsDone ?? 0)} of ${fmt(r.tops!)}`);
  const rest = waiting.length > 1 ? `${waiting.length} more roots to read` : waiting.length ? `${waiting[0]}: reading` : '';
  return [ready, [rest, ...org].filter(Boolean).join(', ')].filter(Boolean).join('; ');
}

/** One sentence for the state of the copy. */
export function indexText(s: IndexTextInput, now = Date.now()): string {
  const p = s.progress;
  const nc = s.notCovered?.length ? ` Not searched: ${s.notCovered.join('; ')}.` : '';
  switch (s.state) {
    case 'building': {
      // Root by root only once the organisation stage runs; a read of the
      // whole server counts objects (the roots are all done only at its end).
      const cov = coverageLine(s.roots);
      if (cov && (s.stage === 'organisation' || !p?.toRead)) return `Making the copy: ${cov}.${s.stage === 'organisation' ? ' Search covers what is ready.' : ''}`;
      return p?.toRead ? `Making the copy: ${fmt(p.read)} of ${plural(p.toRead, 'object')} read.` : 'Making the copy: listing objects.';
    }
    case 'paused': {
      const cov = coverageLine(s.roots);
      if (cov && s.stage === 'organisation') return `Copying stopped: ${cov}. Resume continues it; search covers what is ready.`;
      const toRead = p?.toRead ?? s.objects;
      // Stopped while the objects were still being listed: nothing to count.
      if (!toRead) return 'Copying stopped before anything was read. Searches read the server meanwhile.';
      return `Copying stopped: ${fmt(p?.read ?? 0)} of ${plural(toRead, 'object')} read. Resume continues it; searches read the server meanwhile.`;
    }
    case 'failed':
      return `The copy could not be made: ${s.error ?? 'unknown reason'}. Searches read the server.`;
    case 'unavailable':
      return 'A copy cannot be made of this server (it has no bulk read). Searches read the code from the server.';
    case 'refreshing':
      if (s.copy) return copyText(s, now);
      return p?.toRead
        ? `Refreshing ${theCopy(s, now)}: ${fmt(p.read)} of ${plural(p.toRead, 'changed object')} read.`
        : `Refreshing ${theCopy(s, now)}: checking for changes.`;
    case 'ready': {
      const changed = s.last && !s.last.first ? s.last.changed + s.last.removed : 0;
      const since = changed ? `, ${plural(changed, 'object')} changed since the previous refresh` : '';
      const types = s.codeTypes ? ` in ${plural(s.codeTypes, 'object type')}` : '';
      if (s.copy) return copyText(s, now);
      return `Searching ${theCopy(s, now)}: ${plural(s.objects, 'object')} with code${types}${since}.${nc}`;
    }
    default:
      return 'No copy on this computer. When you search, the code is read from the server once and kept while this window is open.';
  }
}

