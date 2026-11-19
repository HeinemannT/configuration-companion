/**
 * Transport window, the pure part: area labels and order, dates, row
 * grouping and filtering, the text of counts and the download name. No DOM,
 * no chrome.*.
 */

import { createdOnOrAfter, TRANSPORT_DEFAULT_ROOTS, type TransportRoot } from '../lib/transport-bundle';
import type { PatchCounts } from '../lib/transport-patch';
import type { TransportScanRow } from '../lib/transport-read';

/** The areas in the order the window lists and scans them: the default
 *  ones first, then the opt-in ones. */
export const AREA_ORDER: readonly TransportRoot[] = [
  'portal', 'templateCategory', 'property', 'expression', 'externalResource', 'transformer', 'defaults', 'page', 'nodeType', 'classConfig',
  'notification', 'role', 'accessProfile', 'accessPolicy',
];

export const AREA_LABELS: Readonly<Record<TransportRoot, string>> = {
  portal: 'Shared web',
  templateCategory: 'Templates',
  property: 'Properties',
  expression: 'Expressions',
  externalResource: 'External resources',
  transformer: 'Transformers',
  defaults: 'Defaults',
  page: 'Pages',
  nodeType: 'Node types',
  classConfig: 'Visibility rules',
  notification: 'Notifications',
  role: 'Roles',
  accessProfile: 'Access profiles',
  accessPolicy: 'Access policies',
};

/** Whether an area is ticked by default (the others are opt-in). */
export const isDefaultArea = (root: TransportRoot): boolean => TRANSPORT_DEFAULT_ROOTS.includes(root);

/** The chosen areas in list order. */
export function orderedAreas(chosen: ReadonlySet<TransportRoot>): TransportRoot[] {
  return AREA_ORDER.filter(r => chosen.has(r));
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The Where button's summary: "7 areas", "Templates", "No areas". */
export function areasSummary(chosen: ReadonlySet<TransportRoot>): string {
  const list = orderedAreas(chosen);
  if (!list.length) return 'No areas';
  if (list.length === 1) return AREA_LABELS[list[0]];
  return plural(list.length, 'area');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A local calendar day as YYYY-MM-DD. */
export function dayOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The default "Changed since": seven days before `now`. */
export function defaultSince(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  return dayOf(d);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "8 Nov 2026" for YYYY-MM-DD; the text itself for anything else. */
export function dayText(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** A modified time in short form: "14 Nov 10:05" in the current year,
 *  "14 Nov 2025" in another; the server's text when it was not read. */
export function shortTime(iso: string | undefined, raw: string, now: Date): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso) : null;
  if (!m) return raw;
  const day = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
  return Number(m[1]) === now.getFullYear() ? `${day} ${m[4]}:${m[5]}` : `${day} ${m[1]}`;
}

/** Who changed a row: the key the "Changed by" filter compares. */
export const userKey = (row: TransportScanRow): string => row.modifiedById || row.modifiedBy;

export interface UserOption { key: string; label: string }

/** The users in the rows, by name, each once. A row without a user is left out. */
export function usersOf(rows: Iterable<TransportScanRow>): UserOption[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    const key = userKey(r);
    if (key && !seen.has(key)) seen.set(key, r.modifiedBy || r.modifiedById);
  }
  return [...seen].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

export interface Filters {
  /** Words (separated by spaces) that must all be in the ID or the name,
   *  without regard to case. */
  text: string;
  /** A userKey, or '' for anyone. */
  user: string;
  newOnly: boolean;
}

export const NO_FILTERS: Filters = Object.freeze({ text: '', user: '', newOnly: false });

export const filtersActive = (f: Filters): boolean => !!f.text.trim() || !!f.user || f.newOnly;

/** An ID of digits only: a number BMP assigned, which may name another
 *  object on the target. Ticking a group leaves such a row out. */
export const isNumericId = (row: Pick<TransportScanRow, 'id'>): boolean => /^\d+$/.test(row.id);

/** Created on or after the scan's day. */
export const isNewRow = (row: TransportScanRow, since: string): boolean => createdOnOrAfter(row.createdIso, since);

/** Does a row pass the filters? */
export function rowMatches(row: TransportScanRow, f: Filters, since: string): boolean {
  if (f.user && userKey(row) !== f.user) return false;
  if (f.newOnly && !isNewRow(row, since)) return false;
  return holdsWords(row, wordsOf(f.text));
}

// ── the one box: words, an ID list, an exact ID ─────────────────────

/** The ID spaces an address may start with (`t.x`, `k.x`). */
const SPACE_PREFIX = /^[tkrd]\./i;

/** The words of a text: lower case, split at spaces, an address's space
 *  (`t.`) taken off. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean).map(w => (SPACE_PREFIX.test(w) && w.length > 2 ? w.slice(2) : w));
}

/** Is every word in the row's ID or name? No words: every row. */
export function holdsWords(row: Pick<TransportScanRow, 'id' | 'name'>, words: readonly string[]): boolean {
  if (!words.length) return true;
  const hay = `${row.id}\u0000${row.name}`.toLowerCase();
  return words.every(w => hay.includes(w));
}

/** Where a row comes among the matches of an area: 0 its ID is the text, 1
 *  its ID starts with it, 2 the name holds every word, 3 the rest. */
export function rankOf(row: Pick<TransportScanRow, 'id' | 'name'>, words: readonly string[]): number {
  if (!words.length) return 3;
  const id = row.id.toLowerCase();
  if (words.length === 1 && id === words[0]) return 0;
  if (id.startsWith(words[0])) return 1;
  const name = row.name.toLowerCase();
  return words.every(w => name.includes(w)) ? 2 : 3;
}

/** Does a word look like an ID or an address: an address (`t.x`), or an
 *  underscore, a dot, a digit or a capital inside it (`swi_home`,
 *  `ceRiskAssessment`)? */
export function looksLikeId(word: string): boolean {
  return (SPACE_PREFIX.test(word) && word.length > 2) || /[_.\d]/.test(word) || /[a-z][A-Z]/.test(word);
}

/** Is the pasted text a list of IDs? Only when it holds a comma or a line
 *  break, or has several words that are all exact IDs or addresses. Any other
 *  text is a search where every word must match. */
export function isIdList(text: string): boolean {
  const t = text.trim();
  const tokens = t.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return false;
  if (/[,\r\n]/.test(t)) return true;
  return tokens.length >= 2 && tokens.every(looksLikeId);
}

/** What the box holds: nothing to search for, an ID list, or words (the
 *  longest is searched on the workspace, every one must match; a single
 *  word is also tried as an exact ID). */
export type BoxRead =
  | { kind: 'none' }
  | { kind: 'ids'; text: string }
  | { kind: 'words'; words: string[]; longest: string; single: string | null };

/** Characters the box needs before anything is searched. */
export const BOX_MIN = 2;
/** How long the box waits after a key before it searches. */
export const BOX_DEBOUNCE_MS = 300;

export function readBox(text: string): BoxRead {
  const t = text.trim();
  if (t.length < BOX_MIN) return { kind: 'none' };
  if (isIdList(t)) return { kind: 'ids', text: t };
  const words = wordsOf(t);
  if (!words.length) return { kind: 'none' };
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
  if (longest.length < BOX_MIN) return { kind: 'none' };
  return { kind: 'words', words, longest, single: t.split(/\s+/).length === 1 ? t : null };
}

// ── what a button says ──────────────────────────────────────────────

/** How "Changed" is set: any date, a preset, since the last transport, or a day. */
export type SinceKey = 'any' | 'today' | '7d' | '30d' | 'last' | 'custom';

/** The day (YYYY-MM-DD) a key stands for; '' for any date or a day not known. */
export function sinceDay(key: SinceKey, now: Date, last: string | null, custom: string): string {
  const day = (back: number) => dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
  switch (key) {
    case 'today': return day(0);
    case '7d': return day(7);
    case '30d': return day(30);
    case 'last': return last ?? '';
    case 'custom': return custom;
    default: return '';
  }
}

/** "12 Nov", with the year when it is not this one. */
export function shortDay(day: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const text = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
  return Number(m[1]) === now.getFullYear() ? text : `${text} ${m[1]}`;
}

/** The value on the Changed button: "any date", "7 days", "since 12 Nov",
 *  then ", tassilo" and ", new only". */
export function changedValue(key: SinceKey, day: string, user: string, newOnly: boolean, now: Date): string {
  let t = key === 'any' ? 'any date' : key === 'today' ? 'today' : key === '7d' ? '7 days' : key === '30d' ? '30 days' : day ? `since ${shortDay(day, now)}` : 'any date';
  if (user) t += `, ${user}`;
  if (newOnly) t += ', new only';
  return t;
}

/** The value on the Areas button: the count, or the name of the only area. */
export function areasValue(chosen: ReadonlySet<TransportRoot>): string {
  const list = orderedAreas(chosen);
  return list.length === 1 ? AREA_LABELS[list[0]] : String(list.length);
}

/** The end button of a row or area: what it takes and how it reads. */
export type SubSpec =
  /** A folder taken whole: `total` objects under it, `taken` of them in. */
  | { mode: 'whole'; total: number; taken: number }
  /** Everything under it, not yet taken; `count` is unknown until read. */
  | { mode: 'all'; count?: number }
  /** An area header in the tree: take everything in the area. */
  | { mode: 'area'; count?: number }
  /** The shown matches under it, all of them in the transport or not. */
  | { mode: 'hits'; count: number; done: boolean };

export function subLabel(s: SubSpec): string {
  switch (s.mode) {
    case 'whole': return s.taken < s.total ? `${s.taken.toLocaleString('en-US')} of ${s.total.toLocaleString('en-US')} under it` : `All ${s.total.toLocaleString('en-US')} under it`;
    case 'all': return s.count == null ? '+ under it' : `+ ${s.count.toLocaleString('en-US')} under it`;
    case 'area': return s.count == null ? 'All' : `All ${s.count.toLocaleString('en-US')}`;
    case 'hits': return `${s.done ? 'All' : '+'} ${plural(s.count, 'match', 'matches')}`;
  }
}

const cmp = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);

/** Rows sorted by class, then ID, then RID (as text). */
export function sortRows(rows: readonly TransportScanRow[]): TransportScanRow[] {
  return [...rows].sort((a, b) => cmp(a.className, b.className) || cmp(a.id, b.id) || (a.rid.length - b.rid.length) || cmp(a.rid, b.rid));
}

/** A label as part of a file name: letters, digits, dot, dash and
 *  underscore; other runs become one dash. */
export function fileSafe(label: string): string {
  const s = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60).replace(/[-.]+$/, '');
  return s || 'workspace';
}

/** The download's file name; `tag` says what was scanned (the day, or the
 *  starting object's ID and the day); `kind` names a probe or patch file. */
export function downloadName(workspaceLabel: string, tag: string, kind?: 'probe' | 'patch'): string {
  return `transport-${kind ? `${kind}-` : ''}${fileSafe(workspaceLabel)}-${tag}.txt`;
}

/** "12 objects, 5 new, in 6 parts"; "12 objects in 6 parts" when nothing
 *  is counted as new (a scan without a day). */
export function bundleSummary(objects: number, fresh: number | null, parts: number): string {
  if (fresh == null) return `${plural(objects, 'object')} in ${plural(parts, 'part')}`;
  return `${plural(objects, 'object')}, ${fresh.toLocaleString('en-US')} new, in ${plural(parts, 'part')}`;
}

/** "2 to add · 3 to change · 1 to move · 2 to delete · 1 ID to
 *  change · 5 the same · 1 left out"; counts of zero are left out. */
export function patchSummary(c: PatchCounts): string {
  const bits: string[] = [];
  const add = (n: number | undefined, words: string) => { if (n) bits.push(`${n.toLocaleString('en-US')} ${words}`); };
  add(c.create, 'to add');
  add(c.change, 'to change');
  add(c.move, 'to move');
  add(c.delete, 'to delete');
  add(c.rename, c.rename === 1 ? 'ID to change' : 'IDs to change');
  add(c.same, 'the same');
  add(c.leftOut, 'left out');
  return bits.join(' · ') || 'No objects';
}

// ── the list as a tree ──────────────────────────────────────────────

/** A line of a group's tree: an object of the scan, or a context line for a
 *  parent that is not among the rows (its ID and name, nothing to tick). */
export interface TreeNode {
  /** The row's RID; `p:<RID>` for a context line. */
  key: string;
  /** Absent for a context line. */
  row?: TransportScanRow;
  /** The row's RID, or the RID of the parent a context line stands for. */
  rid: string;
  id: string;
  name: string;
  depth: number;
  /** Siblings in `sortIndex` order (rows), context lines after them. */
  children: TreeNode[];
  /** Position in GroupTree.order (pre-order); the node and its subtree are
   *  order[index] to order[end - 1]. */
  index: number;
  end: number;
}

export interface GroupTree {
  /** The first level. */
  tops: TreeNode[];
  /** Every node, parents before their children. */
  order: TreeNode[];
  byKey: Map<string, TreeNode>;
}

/** The object at the top of a group under an object. */
export interface TreeTop { rid: string; id: string; name: string }

const contextKey = (rid: string) => `p:${rid}`;

function siblingOrder(a: TreeNode, b: TreeNode): number {
  if (!a.row !== !b.row) return a.row ? -1 : 1;
  if (a.row && b.row) return (a.row.sortIndex - b.row.sortIndex) || cmp(a.row.className, b.row.className) || cmp(a.id, b.id) || (a.rid.length - b.rid.length) || cmp(a.rid, b.rid);
  return cmp(a.id, b.id) || cmp(a.rid, b.rid);
}

/**
 * The rows of a group as a tree. A row whose parent is a row of the group
 * nests under it. In an area (`rootIds`: the IDs of the roots, `PORTAL`;
 * any case), a row directly under a root, or with no known parent, is on the
 * first level;
 * one whose parent is not among the rows hangs under a context line for that
 * parent. Under an object (`top`), the starting object is the one node of
 * the first level (a context line when it is not among the rows), and every
 * other row is under it. A cycle (which BMP cannot have) is cut. Pure: the
 * same rows give the same tree, whatever order they come in. With `rank`
 * (lower first), siblings come in the order of the best rank in their
 * subtree, then in the usual order.
 */
export function buildGroupTree(rows: readonly TransportScanRow[], opts: { rootIds?: readonly string[]; top?: TreeTop; rank?: (row: TransportScanRow) => number } = {}): GroupTree {
  const byKey = new Map<string, TreeNode>();
  const node = (key: string, rid: string, id: string, name: string, row?: TransportScanRow): TreeNode => {
    const n: TreeNode = { key, rid, id, name, depth: 0, children: [], index: 0, end: 0, ...(row ? { row } : {}) };
    byKey.set(key, n);
    return n;
  };
  for (const r of rows) if (!byKey.has(r.rid)) node(r.rid, r.rid, r.id, r.name, r);
  const parentOf = new Map<TreeNode, TreeNode | null>();
  const tops: TreeNode[] = [];
  const { top } = opts;
  const rootIds = new Set((opts.rootIds ?? []).map(r => r.toLowerCase()));
  const topNode = top ? byKey.get(top.rid) ?? node(contextKey(top.rid), top.rid, top.id, top.name) : null;
  if (topNode) tops.push(topNode);
  const contextFor = (r: TransportScanRow): TreeNode => {
    const k = contextKey(r.parentRid);
    const existing = byKey.get(k);
    if (existing) return existing;
    const c = node(k, r.parentRid, r.parentId, r.parentName);
    if (topNode) { topNode.children.push(c); parentOf.set(c, topNode); } else { tops.push(c); parentOf.set(c, null); }
    return c;
  };
  const attach = (n: TreeNode, p: TreeNode | null) => {
    parentOf.set(n, p);
    if (p) p.children.push(n); else tops.push(n);
  };
  const atRoot = (r: TransportScanRow) => !r.parentRid || rootIds.has(r.parentId.toLowerCase());
  for (const n of [...byKey.values()]) {
    const r = n.row;
    if (!r || n === topNode) continue;
    const p = r.parentRid && r.parentRid !== r.rid ? byKey.get(r.parentRid) : undefined;
    if (p?.row) attach(n, p);
    else if (topNode) attach(n, r.parentRid && r.parentRid !== topNode.rid ? contextFor(r) : topNode);
    else attach(n, atRoot(r) ? null : contextFor(r));
  }
  // Cut a cycle: a node no top reaches goes to the first level (under the
  // starting object when there is one).
  const reached = new Set<TreeNode>();
  const mark = (from: TreeNode) => {
    const stack = [from];
    while (stack.length) {
      const n = stack.pop()!;
      if (reached.has(n)) continue;
      reached.add(n);
      stack.push(...n.children);
    }
  };
  for (const t of tops) mark(t);
  for (const n of byKey.values()) {
    if (reached.has(n)) continue;
    const p = parentOf.get(n);
    if (p) p.children.splice(p.children.indexOf(n), 1);
    attach(n, topNode);
    mark(n);
  }
  const best = new Map<TreeNode, number>();
  const bestOf = (n: TreeNode): number => {
    let b = best.get(n);
    if (b != null) return b;
    b = n.row && opts.rank ? opts.rank(n.row) : 99;
    best.set(n, b);
    for (const c of n.children) b = Math.min(b, bestOf(c));
    best.set(n, b);
    return b;
  };
  const siblings = opts.rank
    ? (a: TreeNode, b: TreeNode) => (bestOf(a) - bestOf(b)) || siblingOrder(a, b)
    : siblingOrder;
  tops.sort(siblings);
  const order: TreeNode[] = [];
  const stack: Array<{ n: TreeNode; depth: number; open: boolean }> = [...tops].reverse().map(n => ({ n, depth: 0, open: true }));
  while (stack.length) {
    const s = stack.pop()!;
    if (!s.open) { s.n.end = order.length; continue; }
    s.n.depth = s.depth;
    s.n.index = order.length;
    order.push(s.n);
    s.n.children.sort(siblings);
    stack.push({ n: s.n, depth: s.depth, open: false });
    for (let i = s.n.children.length - 1; i >= 0; i--) stack.push({ n: s.n.children[i], depth: s.depth + 1, open: true });
  }
  return { tops, order, byKey };
}

/** Not shown, shown as context (an ancestor of a match, or a context
 *  line), shown as a match. */
export const HIDDEN = 0, CONTEXT = 1, MATCH = 2;

export interface TreeShow {
  /** Per position in GroupTree.order: HIDDEN, CONTEXT or MATCH. */
  state: Uint8Array;
  /** Rows the subtree control ticks (shown as a match, no
   *  numeric ID) before each position: the count of a subtree is
   *  `ticks[end] - ticks[index]`. */
  ticks: Int32Array;
}

/** Which nodes show: every row that matches, with its ancestors; a context
 *  line when something under it shows. */
export function showTree(tree: GroupTree, matches: (row: TransportScanRow) => boolean): TreeShow {
  const { order } = tree;
  const state = new Uint8Array(order.length);
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    if (n.row && matches(n.row)) state[i] = MATCH;
    else if (n.children.some(c => state[c.index] !== HIDDEN)) state[i] = CONTEXT;
  }
  const ticks = new Int32Array(order.length + 1);
  for (let i = 0; i < order.length; i++) {
    const r = order[i].row;
    ticks[i + 1] = ticks[i] + (r && state[i] === MATCH && !isNumericId(r) ? 1 : 0);
  }
  return { state, ticks };
}

/** Rows the subtree control of `n` ticks. */
export const subtreeCount = (n: TreeNode, show: TreeShow): number => show.ticks[n.end] - show.ticks[n.index];

/** The nodes to draw, in order: shown ones whose ancestors are open; with
 *  `from`, only those under it. */
export function visibleNodes(tree: GroupTree, show: TreeShow, closed: (n: TreeNode) => boolean, from?: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  const end = from ? from.end : tree.order.length;
  let i = from ? from.index + 1 : 0;
  while (i < end) {
    const n = tree.order[i];
    if (show.state[i] === HIDDEN) { i = n.end; continue; }
    out.push(n);
    i = closed(n) ? n.end : i + 1;
  }
  return out;
}

/** Does `n` have anything under it that shows? */
export const hasShownChildren = (n: TreeNode, show: TreeShow): boolean => n.children.some(c => show.state[c.index] !== HIDDEN);
