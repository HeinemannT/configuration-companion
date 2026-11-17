/**
 * Transport window, the collection: the objects that go, as an ordered set by
 * RID that survives every search, its draft (one per workspace, a dated
 * snapshot in `chrome.storage.local`), the list grouped by place, the state
 * of each object after a comparison, what the objects use, and the model of
 * the map. Pure and deterministic: no DOM, no chrome.*.
 */

import { addressKey, argumentReferences, classNameOf, CONDITION_RULE, fileLimitKb, isTransportRoot, parseObjectText, TRANSPORT_ROOTS, type LeftOutObject, type TransportRoot } from '../lib/transport-bundle';
import type { PatchCounts, PatchReviewObject } from '../lib/transport-patch';
import type { TransportScanRow } from '../lib/transport-read';
import { AREA_LABELS, AREA_ORDER, plural } from './transport-model';

// ── the collection ──────────────────────────────────────────────────

/** One object above another: its ID and name. */
export interface PlaceStep { id: string; name: string }

/** A folder taken whole: the object and everything under it, as one line of
 *  the transport. What is known of what is under it when it was last read
 *  (at every comparison it is read again, so objects added since come along);
 *  with all of it in the transport, a comparison lists what the target has
 *  under it. */
export interface WholeFolder {
  /** The object's address (`t.<ID>`). */
  address: string;
  /** The IDs and RIDs of every object under it, its own included. */
  ids: string[];
  rids: string[];
  /** RIDs under it that were left out (unticked, or an ID BMP assigned). They
   *  stay left out when the folder is read again. */
  leftOut?: string[];
}

export interface CollectionItem {
  rid: string;
  /** The facts of its row as last read. */
  row: TransportScanRow;
  /** The area it was found in, when known. */
  area?: TransportRoot;
  /** The objects above it as far as they are known, top first, its parent
   *  last; a root is not a step. Empty when its parent is a root. */
  trail: PlaceStep[];
  /** When its row was read (ISO, the window's clock). */
  readAt: string;
  /** Refresh did not find it on the workspace. */
  gone?: boolean;
  whole?: WholeFolder;
}

/** The area of a root's ID (`PORTAL` → `portal`), any case. */
export function rootOfId(id: string): TransportRoot | undefined {
  const k = id.trim().toLowerCase();
  return k ? TRANSPORT_ROOTS.find(r => r.toLowerCase() === k) : undefined;
}

/** An ordered set of objects by RID; the order is the order of adding. */
export class TransportCollection {
  private readonly items = new Map<string, CollectionItem>();
  /** Counts every change: a memo keyed on it is current. */
  version = 0;

  get size(): number { return this.items.size; }
  has(rid: string): boolean { return this.items.has(rid); }
  get(rid: string): CollectionItem | undefined { return this.items.get(rid); }
  list(): CollectionItem[] { return [...this.items.values()]; }
  rids(): string[] { return [...this.items.keys()]; }

  /** Add an object; one already there stays as it is (false). */
  add(item: CollectionItem): boolean {
    if (this.items.has(item.rid)) return false;
    this.items.set(item.rid, item);
    this.version++;
    return true;
  }

  remove(rid: string): boolean {
    const had = this.items.delete(rid);
    if (had) this.version++;
    return had;
  }

  /** Change one object in place (its position stays). */
  update(rid: string, change: Partial<CollectionItem>): void {
    const old = this.items.get(rid);
    if (old) { this.items.set(rid, { ...old, ...change, rid }); this.version++; }
  }

  /** Empty it, or fill it with `items` (in that order, each RID once). */
  replace(items: readonly CollectionItem[] = []): void {
    this.items.clear();
    for (const i of items) if (!this.items.has(i.rid)) this.items.set(i.rid, i);
    this.version++;
  }
}

/** The lines of the transport: objects alone, and folders taken whole (an
 *  object under a folder is part of its line). */
export function transportLines(items: readonly CollectionItem[]): { objects: number; folders: number; covered: ReadonlySet<string> } {
  const covered = new Set<string>();
  let folders = 0;
  for (const i of items) {
    if (!i.whole) continue;
    folders++;
    const left = new Set(i.whole.leftOut ?? []);
    for (const r of i.whole.rids) if (r !== i.rid && !left.has(r)) covered.add(r);
  }
  return { objects: items.filter(i => !i.whole && !covered.has(i.rid)).length, folders, covered };
}

/** "12 objects and 2 folders in the transport"; "Nothing in the transport". */
export function linesText(l: { objects: number; folders: number }): string {
  const parts = [l.objects ? plural(l.objects, 'object') : '', l.folders ? plural(l.folders, 'folder') : ''].filter(Boolean);
  return parts.length ? `${parts.join(' and ')} in the transport` : 'Nothing in the transport';
}

// ── the draft ───────────────────────────────────────────────────────

/** The storage key of a workspace's draft. */
export const DRAFT_KEY_PREFIX = 'crev_transport_draft:';
export const draftKey = (environment: string): string => `${DRAFT_KEY_PREFIX}${environment}`;

export interface TransportDraft {
  v: 1;
  environment: string;
  /** When it was saved (ISO). */
  savedAt: string;
  items: CollectionItem[];
  /** "Carry the content of files up to n KB" of this workspace. */
  fileLimitKb?: number;
  /** "Carry the content of files" (off unless the person turned it on). */
  fileContent?: boolean;
}

export function toDraft(environment: string, items: readonly CollectionItem[], savedAt: string, fileLimitKb?: number, fileContent?: boolean): TransportDraft {
  return { v: 1, environment, savedAt, items: items.map(i => ({ ...i })), ...(fileLimitKb != null ? { fileLimitKb } : {}), ...(fileContent != null ? { fileContent } : {}) };
}

/** "Carry the content of files" kept with a draft of `environment`. */
export function draftFileContent(value: unknown, environment: string): boolean | undefined {
  const d = value as Partial<TransportDraft> | null;
  return d && typeof d === 'object' && d.environment === environment && typeof d.fileContent === 'boolean' ? d.fileContent : undefined;
}

/** The file limit kept with a draft of `environment`, when there is one. */
export function draftFileLimit(value: unknown, environment: string): number | undefined {
  const d = value as Partial<TransportDraft> | null;
  return d && typeof d === 'object' && d.environment === environment && typeof d.fileLimitKb === 'number' ? fileLimitKb(d.fileLimitKb) : undefined;
}

const isText = (v: unknown): v is string => typeof v === 'string';
const RID = /^\d{1,20}$/;

/** A stored row, checked field by field; null when it is not one. */
function storedRow(v: unknown): TransportScanRow | null {
  const r = v as Partial<TransportScanRow> | null;
  if (!r || typeof r !== 'object' || !isText(r.rid) || !RID.test(r.rid)) return null;
  const texts = ['id', 'name', 'className', 'modified', 'modifiedBy', 'modifiedById', 'created', 'parentRid', 'parentId', 'parentName'] as const;
  if (texts.some(k => !isText(r[k]))) return null;
  return {
    rid: r.rid, id: r.id!, name: r.name!, className: r.className!, modified: r.modified!, modifiedBy: r.modifiedBy!, modifiedById: r.modifiedById!, created: r.created!,
    ...(isText(r.modifiedIso) ? { modifiedIso: r.modifiedIso } : {}), ...(isText(r.createdIso) ? { createdIso: r.createdIso } : {}),
    // Fields a draft from before may still hold (description markers) are not read.
    parentRid: r.parentRid!, parentId: r.parentId!, parentName: r.parentName!, sortIndex: typeof r.sortIndex === 'number' && Number.isFinite(r.sortIndex) ? r.sortIndex : 0,
    ...(isText(r.linkedTo) && r.linkedTo ? { linkedTo: r.linkedTo } : {}),
  };
}

/** The objects of a stored draft for `environment`, checked; null when the
 *  value is no draft of that workspace. Objects that do not read are left out. */
export function readDraft(value: unknown, environment: string): CollectionItem[] | null {
  const d = value as Partial<TransportDraft> | null;
  if (!d || typeof d !== 'object' || d.v !== 1 || d.environment !== environment || !Array.isArray(d.items)) return null;
  const out: CollectionItem[] = [];
  const seen = new Set<string>();
  for (const raw of d.items as unknown[]) {
    const i = raw as Partial<CollectionItem> | null;
    const row = storedRow(i?.row);
    if (!i || !row || i.rid !== row.rid || seen.has(row.rid)) continue;
    seen.add(row.rid);
    const trail = Array.isArray(i.trail) ? i.trail.filter((s): s is PlaceStep => !!s && isText(s.id) && isText(s.name)).map(s => ({ id: s.id, name: s.name })) : [];
    const w = i.whole;
    // A draft from before has no left-out list: nothing was left out.
    const whole = w && isText(w.address) && Array.isArray(w.ids) && Array.isArray(w.rids) && w.ids.every(isText) && w.rids.every(isText)
      ? { address: w.address, ids: [...w.ids], rids: [...w.rids], ...(Array.isArray(w.leftOut) && w.leftOut.length ? { leftOut: w.leftOut.filter(isText) } : {}) }
      : undefined;
    out.push({
      rid: row.rid, row, ...(isTransportRoot(i.area) ? { area: i.area } : {}), trail, readAt: isText(i.readAt) ? i.readAt : d.savedAt ?? '',
      ...(i.gone === true ? { gone: true } : {}), ...(whole ? { whole } : {}),
    });
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The oldest read time of the objects (ISO), or null. */
export function draftDate(items: readonly CollectionItem[]): string | null {
  let min: string | null = null;
  for (const i of items) if (i.readAt && (min == null || i.readAt < min)) min = i.readAt;
  return min;
}

/** "Draft from 14 Nov, 37 objects" (the year when it is not this one). */
/** "This transport is a draft from 14 Nov with 37 objects." (the Apply confirmation). */
export function draftAgeLine(items: readonly CollectionItem[]): string {
  const at = draftDate(items);
  const m = at ? /^(\d{4})-(\d{2})-(\d{2})/.exec(at) : null;
  const day = m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}` : '';
  return `This transport is a draft${day ? ` from ${day}` : ''} with ${plural(items.length, 'object')}.`;
}

export function draftLine(items: readonly CollectionItem[], now: Date): string {
  const at = draftDate(items);
  const m = at ? /^(\d{4})-(\d{2})-(\d{2})/.exec(at) : null;
  const day = m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}${Number(m[1]) !== now.getFullYear() ? ` ${m[1]}` : ''}` : '';
  return `${day ? `Draft from ${day}` : 'Draft'}, ${plural(items.length, 'object')}`;
}

// ── places ──────────────────────────────────────────────────────────

/** The objects under one parent. */
export interface PlaceGroup {
  /** The parent's RID, or `id:<parent ID>` when it is not known. */
  key: string;
  area?: TransportRoot;
  /** Area label and the names above, top first: "Shared web", "Administration", "Cards". */
  path: string[];
  /** The top-level place: the area and the first folder. */
  topKey: string;
  topPath: string[];
  /** By sibling order, then ID. */
  items: CollectionItem[];
}

/** The path separator in a place's title. */
export const PATH_SEP = ' › ';

/** A step's label: its name, else its ID. */
const stepLabel = (s: PlaceStep) => s.name || s.id;

/** The area of an object: where it was found, else its parent when that is a root. */
export const areaOf = (i: CollectionItem): TransportRoot | undefined => i.area ?? (i.trail.length ? undefined : rootOfId(i.row.parentId));

const cmp = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);

/**
 * The objects grouped by their parent, each group with the path of the
 * parent: the area's label and the names above (an object of the transport
 * that is the parent gives its own path and name); when nothing above the
 * parent is known, the parent's ID and name. Groups in area order (unknown
 * last), then by path; objects by sibling order, then ID. Deterministic.
 */
export function placeGroups(items: readonly CollectionItem[]): PlaceGroup[] {
  const byRid = new Map(items.map(i => [i.rid, i]));
  const keyOf = (i: CollectionItem) => (i.row.parentRid ? i.row.parentRid : `id:${i.row.parentId.toLowerCase()}`);
  /** The steps above `i` and its area, through parents in the transport. */
  const memo = new Map<string, { area?: TransportRoot; steps: PlaceStep[] }>();
  const above = (i: CollectionItem, seen: Set<string>): { area?: TransportRoot; steps: PlaceStep[] } => {
    const known = memo.get(i.rid);
    if (known) return known;
    seen.add(i.rid);
    const parent = i.row.parentRid ? byRid.get(i.row.parentRid) : undefined;
    let v: { area?: TransportRoot; steps: PlaceStep[] };
    if (parent && !seen.has(parent.rid)) {
      const p = above(parent, seen);
      v = { area: p.area ?? areaOf(i), steps: [...p.steps, { id: parent.row.id, name: parent.row.name }] };
    } else {
      // A visibility rule: under its class (its parent's ID is the full class name).
      const steps = i.row.className === CONDITION_RULE && i.row.parentId.includes('.') ? [{ id: i.row.parentId, name: `Class ${classNameOf(i.row.parentId)}` }]
        : i.trail.length || rootOfId(i.row.parentId) || !i.row.parentId ? i.trail : [{ id: i.row.parentId, name: i.row.parentName }];
      v = { area: areaOf(i), steps };
    }
    memo.set(i.rid, v);
    return v;
  };
  const groups = new Map<string, PlaceGroup>();
  for (const i of items) {
    const k = keyOf(i);
    let g = groups.get(k);
    if (!g) {
      const a = above(i, new Set());
      const label = a.area ? [AREA_LABELS[a.area]] : [];
      const steps = a.steps.map(stepLabel);
      // Nothing above the parent known: its ID and name.
      const last = a.steps[a.steps.length - 1];
      const lone = !a.area && a.steps.length === 1 && last ? [last.name && last.id ? `${last.id} · ${last.name}` : last.id || last.name] : steps;
      const path = [...label, ...lone];
      const top = [...label, ...lone.slice(0, 1)];
      g = { key: k, ...(a.area ? { area: a.area } : {}), path: path.length ? path : ['Unknown place'], topKey: `${a.area ?? ''}/${(a.steps[0]?.id ?? '').toLowerCase()}`, topPath: top.length ? top : ['Unknown place'], items: [] };
      groups.set(k, g);
    }
    g.items.push(i);
  }
  const areaRank = (a?: TransportRoot) => (a ? AREA_ORDER.indexOf(a) : AREA_ORDER.length);
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => (a.row.sortIndex - b.row.sortIndex) || cmp(a.row.id, b.row.id) || cmp(a.rid, b.rid));
  return out.sort((a, b) => (areaRank(a.area) - areaRank(b.area)) || cmp(a.path.join('\u0000'), b.path.join('\u0000')) || cmp(a.key, b.key));
}

// ── state after a comparison ────────────────────────────────────────

export type ItemState = 'add' | 'change' | 'move' | 'same' | 'rename' | 'left';

export const STATE_LABELS: Readonly<Record<ItemState, string>> = {
  add: 'to add', change: 'to change', move: 'to move', same: 'the same', rename: 'ID changes', left: 'left out',
};

export interface ItemStateInfo { state: ItemState; title?: string }

/** The state of each object by RID: its outcome in the comparison, or left
 *  out with the reason. */
export function itemStates(review: readonly PatchReviewObject[], leftOut: readonly LeftOutObject[]): Map<string, ItemStateInfo> {
  const out = new Map<string, ItemStateInfo>();
  for (const o of leftOut) out.set(o.rid, { state: 'left', title: o.detail });
  for (const r of review) {
    if (r.renamedFrom) { out.set(r.rid, { state: 'rename', title: `From ${r.renamedFrom}` }); continue; }
    const state: ItemState = r.outcome === 'create' ? 'add' : r.outcome;
    const title = r.place?.labels.length ? r.place.labels.join(' · ') : undefined;
    out.set(r.rid, { state, ...(title ? { title } : {}) });
  }
  return out;
}

/** "5 to add · 20 to change · 2 to move · 10 the same"; counts of zero are left out. */
export function summaryLine(c: PatchCounts): string {
  const bits: string[] = [];
  const add = (n: number, words: string) => { if (n) bits.push(`${n.toLocaleString('en-US')} ${words}`); };
  add(c.create, 'to add');
  add(c.change, 'to change');
  add(c.move, 'to move');
  add(c.delete, 'to delete');
  add(c.rename, c.rename === 1 ? 'ID changes' : 'IDs change');
  add(c.same, 'the same');
  add(c.leftOut, 'left out');
  return bits.join(' · ') || 'Nothing to compare';
}

/** The compact count line of a set of objects: "3 to add · 12 to change";
 *  "the same" when nothing differs; '' without states. */
export function stateCounts(rids: readonly string[], states: ReadonlyMap<string, ItemStateInfo>): string {
  const n: Partial<Record<ItemState, number>> = {};
  let any = false;
  for (const rid of rids) {
    const s = states.get(rid)?.state;
    if (!s) continue;
    any = true;
    n[s] = (n[s] ?? 0) + 1;
  }
  if (!any) return '';
  const order: ItemState[] = ['add', 'change', 'move', 'rename', 'left'];
  const bits = order.filter(s => n[s]).map(s => `${n[s]!.toLocaleString('en-US')} ${STATE_LABELS[s]}`);
  return bits.join(' · ') || 'the same';
}

// ── what the objects use ────────────────────────────────────────────

/** The addresses an object's generated text uses, without its own (by lower
 *  case, the first spelling kept, sorted). */
export function usesOfText(genedit: string): { address: string; uses: string[] } | null {
  const line = parseObjectText(genedit);
  return line ? { address: line.address, uses: argumentReferences(line.args, line.address) } : null;
}

export type UseState = 'transport' | 'target' | 'missing' | 'not-found' | 'unknown';

export const USE_STATE_TITLES: Readonly<Record<UseState, string>> = {
  transport: 'In this transport', target: 'On the target', missing: 'Missing on the target', 'not-found': 'Not found here', unknown: '',
};

export type UseKind = 'lists' | 'expressions' | 'properties' | 'files' | 'organisations' | 'templates' | 'other';

export const USE_KINDS: readonly UseKind[] = ['lists', 'expressions', 'properties', 'files', 'organisations', 'templates', 'other'];

export const USE_KIND_LABELS: Readonly<Record<UseKind, string>> = {
  lists: 'Lists', expressions: 'Expressions', properties: 'Properties', files: 'Files', organisations: 'Organisations', templates: 'Templates', other: 'Other objects',
};

const FILE_CLASSES = /^(FileResource|TranslationFile|APIResource|RemoteResource|SqlResource|PowerBiResource)$/;

/** The kind of a used object: by its class when it is known (and its area),
 *  else by its address space (`k` properties, `o` organisations, `r` files). */
export function useKind(address: string, className?: string, area?: TransportRoot): UseKind {
  if (area === 'templateCategory') return 'templates';
  const c = className ?? '';
  if (/^ListPropertySet(Item)?$/.test(c)) return 'lists';
  if (c === 'ExtendedExpression' || area === 'expression') return 'expressions';
  if (/MethodConfig$/.test(c) || area === 'property') return 'properties';
  if (FILE_CLASSES.test(c) || area === 'externalResource') return 'files';
  if (c === 'Organisation') return 'organisations';
  if (c) return 'other';
  const space = address.slice(0, address.indexOf('.')).toLowerCase();
  return space === 'k' ? 'properties' : space === 'o' ? 'organisations' : space === 'r' ? 'files' : 'other';
}

/** One object used by the transport that is not in it. */
export interface UsedObject {
  address: string;
  /** Lower case. */
  key: string;
  name: string;
  kind: UseKind;
  /** Its class, when it is known. */
  className?: string;
  state: UseState;
  /** The comparison says the target lacks it (also when it is not found here). */
  missing: boolean;
  /** The RIDs of the objects of the transport that use it. */
  by: string[];
}

/** What the map and the needs line are made of. */
export interface UsesIndex {
  /** Per object of the transport (RID): the addresses it uses, in order. */
  perObject: Map<string, string[]>;
  /** The used objects that are not in the transport, by key, sorted by address. */
  outside: UsedObject[];
}

/**
 * The uses of the objects (`texts`: RID → genedit text): per object the
 * addresses it uses, and the used objects outside the transport (`inside`:
 * the lower-case addresses of the transport's objects) with their kind
 * (`facts`), state (`stateOf`) and whether the target lacks it
 * (`missingOf`, default: its state is `missing`). Deterministic.
 */
export function usesIndex(texts: ReadonlyArray<{ rid: string; genedit: string }>, inside: ReadonlySet<string>,
  facts: (key: string) => { name?: string; className?: string; area?: TransportRoot }, stateOf: (key: string) => UseState,
  missingOf?: (key: string) => boolean): UsesIndex {
  const perObject = new Map<string, string[]>();
  const outside = new Map<string, UsedObject>();
  for (const t of texts) {
    const u = usesOfText(t.genedit);
    if (!u) continue;
    perObject.set(t.rid, u.uses);
    for (const a of u.uses) {
      const k = addressKey(a);
      if (inside.has(k)) continue;
      let o = outside.get(k);
      if (!o) {
        const f = facts(k);
        const state = stateOf(k);
        o = { address: a, key: k, name: f.name ?? '', kind: useKind(a, f.className, f.area), ...(f.className ? { className: f.className } : {}), state, missing: missingOf ? missingOf(k) : state === 'missing', by: [] };
        outside.set(k, o);
      }
      if (!o.by.includes(t.rid)) o.by.push(t.rid);
    }
  }
  return { perObject, outside: [...outside.values()].sort((a, b) => cmp(a.key, b.key)) };
}

// ── the map ─────────────────────────────────────────────────────────

/** Left boxes shown at most; the rest are folded into one. */
export const MAP_LEFT_MAX = 12;
export const OTHER_PLACES = 'other-places';

export interface MapPlaceBox {
  key: string;
  label: string;
  /** The objects in it, in list order. */
  rids: string[];
  /** After a comparison: "3 to add · 12 to change". */
  counts: string;
  /** Files in it added without their content. */
  uploads: number;
}

/** A box of the map's right column: a kind, or `class:<Class>` for a class
 *  that fits none of the kinds. */
export type UseBoxKey = UseKind | `class:${string}`;

/** Classes that fit no kind shown in boxes of their own at most; the rest
 *  stay in "Other objects". */
export const MAP_CLASS_BOXES = 6;

export interface MapUseBox {
  kind: UseBoxKey;
  label: string;
  /** The used objects of this kind (keys). */
  keys: string[];
  missing: number;
  /** Files of it added without their content. */
  uploads: number;
}

export interface MapLink {
  left: string;
  right: UseBoxKey;
  /** Distinct used objects (keys). */
  keys: string[];
  missing: number;
}

export interface TransportMapModel {
  left: MapPlaceBox[];
  /** Empty before a comparison or build. */
  right: MapUseBox[];
  links: MapLink[];
}

/**
 * The map: one left box per top-level place (the most objects first; past
 * MAP_LEFT_MAX the rest in "Other places (n)"), one right box per kind of
 * used object outside the transport (ordered by the mean position of the
 * left boxes that use them, so connectors seldom cross), and one connector
 * per pair that has used objects, counted as distinct objects. Pure.
 */
export function mapModel(groups: readonly PlaceGroup[], states: ReadonlyMap<string, ItemStateInfo>, uses: UsesIndex | null,
  uploads: ReadonlyArray<{ rid: string; address: string }> = []): TransportMapModel {
  const uploadRids = new Set(uploads.map(u => u.rid));
  const uploadKeys = new Set(uploads.map(u => addressKey(u.address)));
  const tops = new Map<string, { key: string; label: string; rids: string[] }>();
  for (const g of groups) {
    let t = tops.get(g.topKey);
    if (!t) { t = { key: g.topKey, label: g.topPath.join(PATH_SEP), rids: [] }; tops.set(g.topKey, t); }
    t.rids.push(...g.items.map(i => i.rid));
  }
  let left = [...tops.values()].sort((a, b) => (b.rids.length - a.rids.length) || cmp(a.label, b.label));
  if (left.length > MAP_LEFT_MAX) {
    const keep = left.slice(0, MAP_LEFT_MAX - 1);
    const rest = left.slice(MAP_LEFT_MAX - 1);
    left = [...keep, { key: OTHER_PLACES, label: `Other places (${rest.length.toLocaleString('en-US')})`, rids: rest.flatMap(r => r.rids) }];
  }
  const boxes: MapPlaceBox[] = left.map(l => ({ ...l, counts: stateCounts(l.rids, states), uploads: l.rids.filter(r => uploadRids.has(r)).length }));
  if (!uses) return { left: boxes, right: [], links: [] };
  const boxOf = new Map<string, string>();
  for (const b of boxes) for (const rid of b.rids) boxOf.set(rid, b.key);
  const linkMap = new Map<string, MapLink>();
  // A class that fits no kind gets a box of its own (the most objects first).
  const perClass = new Map<string, number>();
  for (const o of uses.outside) if (o.kind === 'other' && o.className) perClass.set(o.className, (perClass.get(o.className) ?? 0) + 1);
  const ownBox = new Set([...perClass].sort((a, b) => (b[1] - a[1]) || cmp(a[0], b[0])).slice(0, MAP_CLASS_BOXES).map(([c]) => c));
  const boxKey = (o: UsedObject): UseBoxKey => (o.kind === 'other' && o.className && ownBox.has(o.className) ? `class:${o.className}` : o.kind);
  const kinds = new Map<UseBoxKey, MapUseBox>();
  for (const u of uses.outside) {
    const o = { ...u, kind: boxKey(u) };
    let k = kinds.get(o.kind);
    if (!k) { k = { kind: o.kind, label: o.kind.startsWith('class:') ? o.kind.slice(6) : USE_KIND_LABELS[o.kind as UseKind], keys: [], missing: 0, uploads: 0 }; kinds.set(o.kind, k); }
    k.keys.push(o.key);
    if (uploadKeys.has(o.key)) k.uploads++;
    if (o.missing) k.missing++;
    for (const l of new Set(o.by.map(rid => boxOf.get(rid)).filter((x): x is string => !!x))) {
      const id = `${l}\u0000${o.kind}`;
      let link = linkMap.get(id);
      if (!link) { link = { left: l, right: o.kind, keys: [], missing: 0 }; linkMap.set(id, link); }
      link.keys.push(o.key);
      if (o.missing) link.missing++;
    }
  }
  const pos = new Map(boxes.map((b, i) => [b.key, i]));
  const links = [...linkMap.values()];
  const mean = (kind: UseBoxKey) => {
    const ls = links.filter(l => l.right === kind);
    const w = ls.reduce((n, l) => n + l.keys.length, 0);
    return w ? ls.reduce((n, l) => n + pos.get(l.left)! * l.keys.length, 0) / w : Number.MAX_SAFE_INTEGER;
  };
  const rank = (k: UseBoxKey) => (k.startsWith('class:') ? USE_KINDS.indexOf('other') - 0.5 : USE_KINDS.indexOf(k as UseKind));
  const right = [...kinds.values()].sort((a, b) => (mean(a.kind) - mean(b.kind)) || (rank(a.kind) - rank(b.kind)) || (b.keys.length - a.keys.length) || cmp(a.label, b.label));
  const rpos = new Map(right.map((r, i) => [r.kind, i]));
  links.sort((a, b) => (pos.get(a.left)! - pos.get(b.left)!) || (rpos.get(a.right)! - rpos.get(b.right)!));
  return { left: boxes, right, links };
}
