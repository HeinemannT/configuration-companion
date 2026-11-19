/**
 * Numeric IDs tab, the pure part: which objects are listed, which are BMP's
 * own, the tree the list is drawn from (the Find tree: areas, folders, a
 * context line for a folder that has no number itself), the filters, the
 * proposed and typed IDs with their problems, and the words of counts. No
 * DOM, no chrome.*.
 */

import { isPropertyDefinition, TRANSPORT_DEFAULT_ROOTS, type TransportRoot } from '../lib/transport-bundle';
import { resolveNamespace } from '../lib/namespace';
import { idProblem, isNumericOnly, proposeIds, usedKey, type IdObject, type Proposal } from '../lib/numeric-id-propose';
import type { NumericContextRow, TransportOrigin, TransportScanRow } from '../lib/transport-read';
import {
  AREA_LABELS, AREA_ORDER, buildGroupTree, CONTEXT, HIDDEN, holdsWords, MATCH, plural, showTree, wordsOf,
  type GroupTree, type TreeNode, type TreeShow,
} from './transport-model';

/** The areas the tab offers: those of Find but Properties (their IDs are left out for now). */
export const NUMERIC_AREAS: readonly TransportRoot[] = AREA_ORDER.filter(r => r !== 'property');

/** Ticked when the tab first opens. */
export const NUMERIC_DEFAULT_AREAS: readonly TransportRoot[] = TRANSPORT_DEFAULT_ROOTS.filter(r => r !== 'property');

/** Does the ID live in the properties' ID space (`k.`)? Those are left out. */
export const isPropertySpace = (className: string): boolean => resolveNamespace(className) === 'k' || isPropertyDefinition(className);

/** Is the object one the tab lists: a number as ID, in a space other than
 *  properties, not a linked copy (a copy follows its template). */
export function isCandidate(row: TransportScanRow): boolean {
  return isNumericOnly(row.id) && !row.linkedTo && !isPropertySpace(row.className);
}

/** The ID of the account BMP's own objects were created by (name System). */
export const BUILT_IN_USER = 'admin';

/** Does the creator say anything about an object? Not when the signed-in
 *  user is that same built-in account: everything they make has the same
 *  creator as BMP's own objects. An unknown user counts as another one. */
export function creatorCounts(signedIn: string | null | undefined): boolean {
  return (signedIn ?? '').trim().toLowerCase() !== BUILT_IN_USER;
}

/** Why an object counts as BMP's own, or null. */
export function bmpReason(origin: TransportOrigin | undefined, byCreator = true): string | null {
  if (!origin) return null;
  if (origin.systemObject) return 'BMP marks it as a system object';
  if (byCreator && origin.createdBy.trim().toLowerCase() === 'system') return 'Created by System, not by a person';
  return null;
}

export interface NumericEntry {
  row: TransportScanRow;
  area: TransportRoot;
  space: string;
  /** Probably BMP's own, and why. */
  bmp: boolean;
  why?: string;
}

/** What one area's scan holds, and when it was read. */
export interface AreaScan {
  root: TransportRoot;
  /** Every object whose ID starts with a digit. */
  rows: TransportScanRow[];
  /** Every other object. */
  context: NumericContextRow[];
  more: boolean;
  /** Epoch ms of the read. */
  at: number;
}

export function entriesOf(scan: AreaScan, origins: ReadonlyMap<string, TransportOrigin>, byCreator = true): NumericEntry[] {
  const out: NumericEntry[] = [];
  for (const row of scan.rows) {
    if (!isCandidate(row)) continue;
    const why = bmpReason(origins.get(row.rid), byCreator);
    out.push({ row, area: scan.root, space: resolveNamespace(row.className), bmp: !!why, ...(why ? { why } : {}) });
  }
  return out;
}

/** The rows a context object stands for in the tree. */
export function contextRow(c: NumericContextRow): TransportScanRow {
  return {
    rid: c.rid, id: c.id, name: c.name, className: c.className, modified: '', modifiedBy: '', modifiedById: '', created: '',
    parentRid: c.parentRid, parentId: c.parentId, parentName: '', sortIndex: c.sortIndex,
  };
}

/** The objects of one area as the Find tree draws them: the numbers, the
 *  other objects as context (so folders nest as they do on the server). */
export function areaTree(scan: AreaScan): GroupTree {
  return buildGroupTree([...scan.context.map(contextRow), ...scan.rows], { rootIds: [scan.root] });
}

// ── what shows ────────────────────────────────────────────────────

export interface NumericFilters {
  /** Words that must all be in the old ID or the name. */
  text: string;
}

/** Which nodes of an area show, for its own objects (`bmp` false) or BMP's. */
export function showEntries(tree: GroupTree, entries: ReadonlyMap<string, NumericEntry>, bmp: boolean, filters: NumericFilters): TreeShow {
  const words = wordsOf(filters.text);
  return showTree(tree, row => {
    const e = entries.get(row.rid);
    return !!e && e.bmp === bmp && holdsWords(row, words);
  });
}

/** The entries shown under `node` (not the node itself). */
export function entriesUnder(tree: GroupTree, show: TreeShow, node: TreeNode, entries: ReadonlyMap<string, NumericEntry>): NumericEntry[] {
  const out: NumericEntry[] = [];
  for (let i = node.index + 1; i < node.end; i++) {
    if (show.state[i] !== MATCH) continue;
    const e = entries.get(tree.order[i].key);
    if (e) out.push(e);
  }
  return out;
}

/** Every entry shown in the area. */
export function shownEntries(tree: GroupTree, show: TreeShow, entries: ReadonlyMap<string, NumericEntry>): NumericEntry[] {
  const out: NumericEntry[] = [];
  for (let i = 0; i < tree.order.length; i++) {
    if (show.state[i] !== MATCH) continue;
    const e = entries.get(tree.order[i].key);
    if (e) out.push(e);
  }
  return out;
}

export { CONTEXT, HIDDEN, MATCH };

// ── the proposals, the edits and their problems ───────────────────

export const idObjectOf = (row: Pick<TransportScanRow, 'rid' | 'id' | 'name' | 'className' | 'parentRid'>): IdObject => ({
  rid: row.rid, id: row.id, name: row.name, className: row.className, parentRid: row.parentRid, space: resolveNamespace(row.className),
});

/** Proposals for every entry, given everything the scans hold (all areas read). */
export function proposalsFor(entries: readonly NumericEntry[], scans: readonly AreaScan[]): Map<string, Proposal> {
  const world: IdObject[] = [];
  const seen = new Set<string>();
  for (const s of scans) {
    for (const c of s.context) if (!seen.has(c.rid)) { seen.add(c.rid); world.push(idObjectOf(c)); }
    for (const r of s.rows) if (!seen.has(r.rid)) { seen.add(r.rid); world.push(idObjectOf(r)); }
  }
  return proposeIds(entries.map(e => idObjectOf(e.row)), world);
}

/** The IDs taken in each ID space (the key of usedKey), from everything read. */
export function takenIds(scans: readonly AreaScan[]): Set<string> {
  const out = new Set<string>();
  for (const s of scans) {
    for (const c of s.context) out.add(usedKey(resolveNamespace(c.className), c.id));
    for (const r of s.rows) out.add(usedKey(resolveNamespace(r.className), r.id));
  }
  return out;
}

export interface RowState {
  /** The new ID as shown: typed, else proposed. */
  value: string;
  /** Why it cannot be used, or null. */
  problem: string | null;
}

/**
 * The value and problem of each entry. An ID is a problem when it is not
 * valid, is used by an object read, or is also the value of another ticked
 * row (both are marked, so neither is changed by accident).
 */
export function rowStates(
  entries: readonly NumericEntry[], proposals: ReadonlyMap<string, Proposal>, edits: ReadonlyMap<string, string>,
  ticked: ReadonlySet<string>, taken: ReadonlySet<string>, refused?: ReadonlyMap<string, string>,
): Map<string, RowState> {
  const out = new Map<string, RowState>();
  const sameValue = new Map<string, number>();
  const value = (e: NumericEntry) => edits.get(e.row.rid) ?? proposals.get(e.row.rid)?.id ?? '';
  for (const e of entries) {
    if (!ticked.has(e.row.rid)) continue;
    const k = usedKey(e.space, value(e));
    sameValue.set(k, (sameValue.get(k) ?? 0) + 1);
  }
  for (const e of entries) {
    const v = value(e);
    const k = usedKey(e.space, v);
    let problem = idProblem(v, id => (taken.has(usedKey(e.space, id)) ? 'Already used by another object' : null));
    if (!problem && ticked.has(e.row.rid) && (sameValue.get(k) ?? 0) > 1) problem = 'Also the new ID of another row';
    out.set(e.row.rid, { value: v, problem: refused?.get(e.row.rid) ?? problem });
  }
  return out;
}

// ── the words ─────────────────────────────────────────────────────

/** "24 of 38". */
export const footerCount = (ready: number, listed: number): string => `${ready.toLocaleString('en-US')} of ${listed.toLocaleString('en-US')}`;

export const changeButtonText = (n: number): string => `Change ${n.toLocaleString('en-US')} ${n === 1 ? 'ID' : 'IDs'}`;

export const confirmTitle = (n: number, workspace: string): string => `${changeButtonText(n)}${workspace ? ` in ${workspace}` : ''}`;

export function codeNote(objects: number): string {
  return objects === 1 ? 'Also changes code in 1 object.' : `Also changes code in ${objects.toLocaleString('en-US')} objects.`;
}

/** Said once, quietly, when the stored code copy cannot tell which code names an ID. */
export const notCheckedNote = (reason: string): string => `Code is not checked: ${reason}.`;

/** "19 Nov 10:05" (the year too when it is not this year), in local time. */
export function stampText(at: number, now: Date): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${day}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Read 19 Nov 10:05". */
export function readText(at: number | null, now: Date): string {
  return at == null ? '' : `Read ${stampText(at, now)}`;
}

/** The confirmation says when ticked rows were left out because their new ID is used. */
export const leftOutNote = (n: number): string => `${n === 1 ? '1 row' : `${n.toLocaleString('en-US')} rows`} left out: the new ID is already used.`;

export interface ResultCounts {
  changed: number;
  codeObjects: number;
  codeNotSaved: number;
  notChanged: number;
}

/** The line after a change. */
export function resultLine(r: ResultCounts): string {
  const parts = [`Changed ${plural(r.changed, 'ID')}${r.codeObjects ? ` and code in ${plural(r.codeObjects, 'object')}` : ''}.`];
  if (r.codeNotSaved) parts.push(`${plural(r.codeNotSaved, 'script')} still ${r.codeNotSaved === 1 ? 'names' : 'name'} an old ID.`);
  if (r.notChanged) parts.push(`${r.notChanged.toLocaleString('en-US')} not changed.`);
  return parts.join(' ');
}

export function backLine(r: { ids: number; code: number; heldBack: number; notBack: number }): string {
  const parts = [`Changed back ${plural(r.ids, 'ID')}${r.code ? ` and ${plural(r.code, 'script')}` : ''}.`];
  if (r.notBack) parts.push(`${r.notBack.toLocaleString('en-US')} ${r.notBack === 1 ? 'ID' : 'IDs'} could not go back.`);
  if (r.heldBack) parts.push(`${plural(r.heldBack, 'script')} left as ${r.heldBack === 1 ? 'it is' : 'they are'}.`);
  return parts.join(' ');
}

export { AREA_LABELS };
