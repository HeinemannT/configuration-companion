/**
 * Object window controller — in-frame navigation (back/forward), a small
 * short-lived cache keyed by rid, the optional enrichments (relation names,
 * custom-property and mapped-property names, the type field list, EditField
 * property choices), the root's template read, a data object's presenting
 * template, and the window draft with its save.
 *
 * Nothing optional runs before the first paint. After a root lands:
 *  - ONE batched summary read names relation targets, custom property keys
 *    (numeric definition rids) and EditField mappings;
 *  - a data object's template structure is opened (listing + one batch).
 * The type field list is fetched only when the user asks for "All fields".
 *
 * Talks to BMP only through `ObjectWindowSource`, so tests and the dev
 * harness can feed it fixtures. Writes go through `source.run`, one call per
 * existing write route (see save-plan.ts).
 */

import type { Coverage } from '../../lib/coverage-line';
import type { FullObject, ObjectSummary } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import type { ObjectLabel } from '../../lib/messages';
import type { ObjectWindowFocus, ObjectWindowOrigin, PropertyApplication, TypeSchemaProp } from '../../lib/types';
import { EXPRESSIONS, HIDDEN_ROLES, isCustomKey, isDataObject, typeInfo } from '../../lib/object-window-table';
import { readIsolating } from '../../lib/batch-isolate';
import { CodeRefCache } from '../../lib/code-ref-client';
import type { RefResolution } from '../../lib/code-ref-resolve';
import type { AttachedRow } from '../../lib/object-structure';
import { editability, templateRidOf, WindowDraft, type CustomEntry } from './draft';
import {
  customModels, encodeCustomValue, isEditKind, isReferenceKind, ownValue, REASON_TEXT, referenceRids, referenceValue, storedValue,
  type AllowedObjects, type Editability, type ListItem, type PropertyModel, type ReferenceKind, type TypePropertySchema,
} from '../../lib/property-schema';
import { customValueText } from './prop-sections';
import { buildConflict, buildReview, type ConflictChoice, type ConflictContent, type ReviewContent, type ReviewDetail } from './review';
import { allowedKey, outsideAllowed, referenceDiff, referenceText, refName, type AllowedObjectsState, type RefName } from './reference-edit';
import {
  checkAgainstRead, customStored, planSave, readBackEquals, runSave,
  type ObjectCheck, type ObjectResult, type SaveOutcome, type SavePort, type SaveStep,
} from './save-plan';
import { CHANGED_IN_BMP, storedDiffersLine, unknownOutcomeLine, type UnknownOutcome } from '../../lib/save-check';
import {
  propLabel, type ApplicationsState, type EditTarget, type FieldListState, type InboundState, type InboundTarget, type InCodeState, type InCodeTarget, type ObjectWindowView,
  type PresentedState, type PropertyChoices, type PropertySchemaState, type TemplateState, type TrailStep, type WindowHint, type WindowModel,
} from './view';

/** Property labels from a field list: accessor and property rid → label. */
export function labelsFromFields(props: readonly TypeSchemaProp[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of props) {
    const label = p.label?.trim();
    if (!label || label.startsWith('#L#') || label === p.accessor) continue;
    if (p.accessor) out[p.accessor] = label;
    if (p.propertyRid) out[p.propertyRid] = label;
  }
  return out;
}

/** A custom write was sent but no read-back could check it. */
export const UNCHECKED_LINE = 'Sent, but could not be checked. Reload to see the stored value.';

/** READ_OBJECT_SUMMARIES accepts at most this many rids per call. */
const SUMMARY_CHUNK = 200;
export interface SummaryAnswer {
  summaries: ObjectSummary[];
  missing?: readonly string[];
  failed?: Readonly<Record<string, string>>;
}

/** Type hint for a presenting template: its structure rule lists widgets
 *  and Container → ActionButton in the same call as the batch read. */
const TEMPLATE_HINT = 'EnterpriseTemplate';
import { changeInputs } from './changes';
import type { ChangeInput } from '../../lib/change-record';

export interface ObjectWindowSource {
  /** Open a root. Rejects only when the root itself cannot be read. */
  openRoot(rid: string, typeHint?: string): Promise<ObjectRootPayload>;
  /** Names/types for rids outside the tree. Rejects when the read as a
   *  whole failed. `missing`: the server says these are not there; `failed`:
   *  these reads failed or were dropped. A bare list says neither: a rid
   *  absent from it counts as failed. */
  readSummaries(rids: string[]): Promise<ObjectSummary[] | SummaryAnswer>;
  /** The type's full field list (accessor, label, description) through
   *  `help(lookup(rid))`, with `rid` as the example object. Asked for only
   *  when the user switches a property list to "All fields". Rejects on failure. */
  fieldList(type: string, rid: string): Promise<TypeSchemaProp[]>;
  /** The type's property schema (field description, definition classes,
   *  list items) for the custom sections and editors. Rejects on failure. */
  propertySchema?(type: string): Promise<TypePropertySchema>;
  /** The objects reference property `definition` of type `type` allows for
   *  object `rid` (FETCH_ALLOWED_OBJECTS). Rejects on failure. */
  allowedObjects?(rid: string, definition: string, type: string): Promise<AllowedObjects>;
  /** Full reads through the object window read path (template, re-read after save). */
  readObjects(rids: string[]): Promise<{ objects: Record<string, FullObject>; errors: Record<string, string> }>;
  /** Run one write on its existing route. `label` names the object for the
   *  Log (display only). */
  run(step: SaveStep, label?: ObjectLabel): Promise<SaveOutcome>;
  /** Report written properties to the change record (no answer). */
  recordChanges?(changes: ChangeInput[]): void;
  /** EditField propertyMapping choices. */
  propertyChoices?(rid: string): Promise<PropertyChoices>;
  /** "Used by": every object that refers to `rid` (declared reverse
   *  references first, then the rref() scan). Slow on much-used objects;
   *  started only by the user. Rejects on failure. */
  inbound?(rid: string, type: string): Promise<{ targets: InboundTarget[]; total?: number; capped?: boolean; instances?: { total: number; targets: InboundTarget[] } }>;
  /** Stop waiting for the scan of `rid` (BMP may still finish it). */
  cancelInbound?(rid: string): void;
  /** Objects whose code calls `obj`, from the local code index; null while
   *  the index is not ready. */
  usedInCode?(obj: { rid: string; businessId: string; name: string; type: string }): Promise<{ targets: InCodeTarget[] | null; coverage: Coverage }>;
  /** Where a property definition is applied (ClassConfig applications). */
  applications?(rid: string): Promise<{ applications: PropertyApplication[]; total: number; truncated: boolean }>;
  /** Code references → identity and code property (one batched post). */
  resolveRefs?(keys: string[]): Promise<Record<string, RefResolution>>;
  /** Follow single references of tree nodes (a button's action object). */
  listReferenced?(items: Array<{ rid: string; via: string; depth: number }>): Promise<{ rows: Array<{ rid: string; parent: string }>; nodes: Record<string, FullObject> }>;
  /** Pinned rids (Browse's Pinned list). */
  pins?(): Promise<string[]>;
  /** Pin or unpin; resolves to the pinned rids after the change. */
  togglePin?(obj: { rid: string; name: string; type: string; businessId: string; templateBusinessId?: string }): Promise<string[]>;
}

export interface ControllerOptions {
  /** Cache lifetime for opened roots (ms). */
  cacheMs?: number;
  now?: () => number;
  /** Called after each root lands (title updates). */
  onRoot?(root: FullObject): void;
  /** Show the review; resolve true to save. Default: save without asking. */
  confirmSave?(review: ReviewContent): Promise<boolean>;
  /** Objects were held back (changed in BMP since opened, or the check could
   *  not read): Review, Overwrite (Save anyway) or Cancel. Default: Cancel. */
  resolveConflict?(conflict: ConflictContent): Promise<ConflictChoice>;
  /** Pause before re-reading after a write whose answer was lost (ms,
   *  default 2000): seen live, a commit can still be running on the server
   *  when the answer breaks off, and an immediate re-read then shows the old
   *  value ("not saved") although the value lands a moment later. */
  unknownRereadDelayMs?: number;
  /** Ask before pending edits are dropped (navigation, Discard). */
  confirmDiscard?(count: number, reason: 'navigate' | 'discard'): Promise<boolean>;
  /** Back from the first step of a window opened by a search: return to it. */
  onOrigin?(origin: ObjectWindowOrigin): void;
}

/** One history step: a root and, within it, the selected node and the
 *  trail that led there. Back/Forward walk selections, not only roots. */
interface Entry {
  rid: string;
  hint?: WindowHint;
  sel?: string;
  trail?: TrailStep[];
  /** Arrow-key selections in a row share one entry. */
  via?: 'key' | 'click' | 'ref';
  at?: number;
  /** The search that opened this step (first trail step). */
  origin?: ObjectWindowOrigin;
  /** Property and line to land on. */
  focus?: ObjectWindowFocus & { rid: string; seq: number };
}

/** Rows hung into the current root's tree by reference, with their reads. */
interface Extra {
  root: string;
  rows: AttachedRow[];
  nodes: Record<string, FullObject>;
}

interface BaseModel {
  phase: WindowModel['phase'];
  rid: string;
  hint?: WindowHint;
  error?: string;
  payload?: ObjectRootPayload;
}

const CACHE_MAX = 24;
function toAnswer(res: ObjectSummary[] | SummaryAnswer): SummaryAnswer {
  return Array.isArray(res) ? { summaries: res } : res;
}

/** A reference row (reference, user/group, list of references) as the
 *  editor needs it (controller.referenceRow). */
export interface ReferenceRowState {
  kind: ReferenceKind;
  model: PropertyModel;
  /** The model's editability, narrowed by the allowed objects: read-only
   *  while they are not loaded (`reason: 'unread-definition'` with the
   *  read's error, or ALLOWED_NOT_LOADED while loading or not asked), and
   *  "The list is too long to choose from here" when there are too many. */
  editability: Editability;
  /** The allowed objects (undefined: not asked yet; loadAllowed). */
  allowed?: AllowedObjectsState;
  /** The value shown: the staged one, else the stored one (canonical). */
  value: string;
  /** The stored value (canonical; what the draft started from). */
  stored: string;
  /** The objects of `value`, named, in its order. */
  selected: RefName[];
  /** RIDs of `value` the allowed objects do not hold: a save that keeps
   *  them is refused ("Not one of the objects this property allows"). */
  outside: string[];
  /** "Not set" (an empty list) may be chosen (the model's `allowBlank`). */
  mayBeEmpty: boolean;
  /** A saved change takes effect from today (DATED_NOTE). */
  dated: boolean;
}

/** Why a reference value cannot be staged before its allowed objects are read. */
export const ALLOWED_NOT_LOADED = 'The objects this property allows are not loaded yet.';

/** Roles whose targets the pane names (relations + audit rows). */
const NAMED_AUDIT_ROLES = new Set(['createdBy', 'lastModifiedBy']);

export class ObjectWindowController {
  private history: Entry[] = [];
  private index = -1;
  private cache = new Map<string, { payload: ObjectRootPayload; at: number }>();
  private summaries: Record<string, ObjectSummary> = {};
  /** Rids the server says are not there (deleted definition …): never asked
   *  for again in this window, until the user retries. */
  private missing: Record<string, true> = {};
  /** Rids whose own read fails on the server (isolated from a failed
   *  batch): rid → error. Also in `missing`, so they are not asked for again
   *  until the user retries. A read that failed as a whole marks nothing:
   *  its names show `summariesError` with Retry and the next load asks again. */
  private unreadable: Record<string, string> = {};
  private summariesError: string | undefined;
  /** Rids whose summary read is under way (names show a placeholder). */
  private readonly pendingNames = new Set<string>();
  /** The read each pending rid waits for: a load that wants a rid another
   *  read is fetching waits for it, then asks itself if it is still unknown. */
  private readonly namesInFlight = new Map<string, Promise<void>>();
  private labels: Record<string, Record<string, string>> = {};
  private fields: Record<string, FieldListState> = {};
  /** Property schema per type (data objects), for the window's life. */
  private schemas: Record<string, PropertySchemaState> = {};
  /** Allowed objects of reference rows (allowedKey → state): display only,
   *  until a save of the object or a refresh. The write gate reads its own. */
  private allowed: Record<string, AllowedObjectsState> = {};
  /** Presenting template per data-object root rid. */
  private presented: Record<string, PresentedState> = {};
  private templates: Record<string, TemplateState> = {};
  private choices: Record<string, PropertyChoices> = {};
  /** "Used by" scans keyed by rid (kept across in-frame navigation). */
  private inbound: Record<string, InboundState> = {};
  /** "In code" lists keyed by rid. */
  private inCode: Record<string, InCodeState> = {};
  /** Property applications keyed by property definition rid. */
  private applications: Record<string, ApplicationsState> = {};
  private pins = new Set<string>();
  private targets = new Map<string, EditTarget>();
  private readonly draft = new WindowDraft();
  private saving = false;
  private saveNote: string | undefined;
  private base: BaseModel | null = null;
  private token = 0;
  /** Code references: identities and target code, for the window's life. */
  readonly refs: CodeRefCache;
  /** Rows hung in by reference, per root: going Back to a root shows its
   *  tree as it was. Bounded like the root cache. */
  private extras = new Map<string, Extra>();
  /** Rids whose follow rule was already listed (current root). */
  private followed = new Set<string>();
  /** Selection the view applies once (history steps, followed references). */
  private nav: { seq: number; sel?: string; trail?: TrailStep[] } = { seq: 0 };
  private readonly cacheMs: number;
  private readonly now: () => number;

  constructor(
    private readonly view: Pick<ObjectWindowView, 'update'>,
    private readonly source: ObjectWindowSource,
    private readonly options: ControllerOptions = {},
  ) {
    this.cacheMs = options.cacheMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.refs = new CodeRefCache({
      resolve: keys => this.source.resolveRefs ? this.source.resolveRefs(keys) : Promise.reject(new Error('References cannot be resolved here')),
      read: rids => this.source.readObjects(rids),
    }, () => this.refresh());
  }

  // ── references ─────────────────────────────────────────────────

  /** Resolve the references of code that became visible (one batch). */
  resolveRefs(keys: readonly string[]): void {
    void this.refs.request(keys);
  }

  /** Follow the reference rule of tree rows that became visible: ONE
   *  listing for all of them, never part of the open itself. */
  followReferences(items: ReadonlyArray<{ rid: string; via: string; depth: number }>): void {
    const list = this.source.listReferenced;
    const root = this.base?.payload?.root.rid;
    const fresh = items.filter(it => !this.followed.has(`${root}:${it.rid}`));
    if (!list || !root || !fresh.length) return;
    for (const it of fresh) this.followed.add(`${root}:${it.rid}`);
    list([...fresh]).then(res => {
      if (this.base?.payload?.root.rid !== root) return;
      const asked = new Set(fresh.map(it => it.rid));
      const extra = this.extraFor(root);
      for (const r of res.rows) extra.rows.push({ rid: r.rid, parent: r.parent, ...(asked.has(r.parent) ? { referenced: true } : {}) });
      Object.assign(extra.nodes, res.nodes);
      this.extras.set(root, { ...extra, rows: [...extra.rows] });
      this.refresh();
    }, () => { /* the tree stays as it is */ });
  }

  /** Go to a referenced object inside the window: hang it under `attach.under`
   *  when the tree does not hold it yet, select it, extend the trail. */
  reveal(target: string, trail: TrailStep[], attach: ReadonlyArray<{ under: string; obj: FullObject }> = [], hops = 1): void {
    const root = this.base?.payload?.root.rid;
    if (!root) return;
    if (attach.length) {
      const extra = this.extraFor(root);
      for (const a of attach) {
        if (extra.nodes[a.obj.rid]) continue;
        extra.rows.push({ rid: a.obj.rid, parent: a.under, referenced: true });
        extra.nodes[a.obj.rid] = a.obj;
      }
      this.extras.set(root, { ...extra, rows: [...extra.rows] });
    }
    // One history step per hop: Back goes back exactly one reference.
    for (let k = Math.max(1, trail.length - Math.max(1, hops)); k < trail.length; k++) this.pushSelection(trail[k].rid, trail.slice(0, k + 1), 'ref');
    this.pushSelection(target, trail, 'ref');
    this.nav = { seq: this.nav.seq + 1, sel: target, trail };
    this.refresh();
  }

  /** The user selected a node (tree click, arrow key, relation row). */
  selectionChanged(sel: string, trail: TrailStep[], via: 'key' | 'click' = 'click'): void {
    if (this.pushSelection(sel, trail, via)) this.refresh();
  }

  /** The history step Back or Forward would go to. */
  neighbour(dir: -1 | 1): string | undefined {
    const e = this.history[this.index + dir];
    return e ? e.sel ?? e.rid : undefined;
  }

  private pushSelection(sel: string, trail: TrailStep[], via: 'key' | 'click' | 'ref'): boolean {
    const cur = this.history[this.index];
    if (!cur) return false;
    const now = this.now();
    if ((cur.sel ?? cur.rid) === sel) { cur.trail = trail; return false; }
    // The search that opened this root stays the first step of its trail.
    const entry: Entry = { rid: cur.rid, ...(cur.hint ? { hint: cur.hint } : {}), ...(cur.origin ? { origin: cur.origin } : {}), sel, trail, via, at: now };
    this.history = this.history.slice(0, this.index + 1);
    this.history.push(entry);
    this.index = this.history.length - 1;
    return true;
  }

  private extraFor(root: string): Extra {
    let extra = this.extras.get(root);
    if (!extra) {
      extra = { root, rows: [], nodes: {} };
      this.extras.set(root, extra);
      while (this.extras.size > CACHE_MAX) this.extras.delete(this.extras.keys().next().value!);
    }
    return extra;
  }

  /** Load the pinned rids once (the header's pin toggle). */
  loadPins(): void {
    this.source.pins?.().then(rids => { this.pins = new Set(rids); this.refresh(); }, () => { /* pins stay unknown */ });
  }

  togglePin(): void {
    const root = this.base?.payload?.root;
    const toggle = this.source.togglePin;
    if (!root || !toggle) return;
    const tpl = templateRidOf(root);
    const tplBid = tpl ? this.summaries[tpl]?.businessId : undefined;
    // Optimistic: the header answers at once, the service worker confirms.
    const next = new Set(this.pins);
    if (next.has(root.rid)) next.delete(root.rid); else next.add(root.rid);
    this.pins = next;
    this.refresh();
    toggle({ rid: root.rid, name: root.name, type: root.type, businessId: root.businessId, ...(tplBid ? { templateBusinessId: tplBid } : {}) })
      .then(rids => { this.pins = new Set(rids); }, () => { this.loadPins(); })
      .finally(() => this.refresh());
  }

  // ── Used by ────────────────────────────────────────────────────

  /** Start the "Used by" scan of `obj`. Never runs on its own. */
  scanInbound(obj: FullObject): void {
    const scan = this.source.inbound;
    const rid = obj.rid;
    if (!scan || this.inbound[rid]?.phase === 'scanning') return;
    const startedAt = this.now();
    const state: InboundState = { phase: 'scanning', startedAt, targets: [] };
    this.inbound = { ...this.inbound, [rid]: state };
    this.refresh();
    scan(rid, obj.type).then(res => {
      if (this.inbound[rid] !== state) return; // cancelled or restarted
      const known: Record<string, ObjectSummary> = {};
      for (const t of [...res.targets, ...(res.instances?.targets ?? [])]) if (!this.summaries[t.rid]) known[t.rid] = { rid: t.rid, name: t.name, type: t.type, businessId: t.businessId };
      this.summaries = { ...this.summaries, ...known };
      this.inbound = { ...this.inbound, [rid]: {
        phase: 'done', startedAt, ms: this.now() - startedAt, targets: res.targets,
        ...(res.total != null ? { total: res.total } : {}), ...(res.capped ? { capped: true } : {}),
        ...(res.instances ? { instances: res.instances } : {}),
      } };
    }, (e: unknown) => {
      if (this.inbound[rid] !== state) return;
      this.inbound = { ...this.inbound, [rid]: { phase: 'error', startedAt, targets: [], error: e instanceof Error ? e.message : String(e) } };
    }).finally(() => this.refresh());
  }

  /** Fill "In code" of `obj` from the local code index (once per object;
   *  again when the index was not ready). */
  loadInCode(obj: FullObject): void {
    const read = this.source.usedInCode;
    const rid = obj.rid;
    const cur = this.inCode[rid];
    if (!read || cur?.phase === 'loading' || cur?.phase === 'done') return;
    const state: InCodeState = { phase: 'loading', targets: [] };
    this.inCode = { ...this.inCode, [rid]: state };
    read({ rid, businessId: obj.businessId, name: obj.name, type: obj.type }).then(({ targets, coverage }) => {
      if (this.inCode[rid] !== state) return;
      if (!targets) { this.inCode = { ...this.inCode, [rid]: { phase: 'unavailable', targets: [], coverage } }; return; }
      const known: Record<string, ObjectSummary> = {};
      for (const t of targets) if (!this.summaries[t.rid]) known[t.rid] = { rid: t.rid, name: t.name, type: t.type, businessId: t.businessId };
      this.summaries = { ...this.summaries, ...known };
      this.inCode = { ...this.inCode, [rid]: { phase: 'done', targets, coverage } };
    }, (e: unknown) => {
      if (this.inCode[rid] !== state) return;
      this.inCode = { ...this.inCode, [rid]: { phase: 'error', targets: [], error: e instanceof Error ? e.message : String(e) } };
    }).finally(() => this.refresh());
  }

  /** Cancel a running scan: the control returns to its start state. */
  cancelInbound(rid: string): void {
    if (this.inbound[rid]?.phase !== 'scanning') return;
    const rest = { ...this.inbound };
    delete rest[rid];
    this.inbound = rest;
    this.source.cancelInbound?.(rid);
    this.refresh();
  }

  // ── property applications ─────────────────────────────────────

  loadApplications(rid: string): void {
    const load = this.source.applications;
    if (!load || this.applications[rid]?.phase === 'loading') return;
    this.applications = { ...this.applications, [rid]: { phase: 'loading', list: this.applications[rid]?.list ?? [] } };
    this.refresh();
    load(rid).then(res => {
      this.applications = { ...this.applications, [rid]: { phase: 'done', list: res.applications, total: res.total, truncated: res.truncated } };
    }, (e: unknown) => {
      this.applications = { ...this.applications, [rid]: { phase: 'error', list: [], error: e instanceof Error ? e.message : String(e) } };
    }).finally(() => this.refresh());
  }

  get current(): string | undefined {
    return this.history[this.index]?.rid;
  }

  /** Number of pending edits in the window. */
  get dirtyCount(): number {
    return this.draft.count();
  }

  /** Open `rid` as the root. `push` adds a history entry (default).
   *  `trail`: the path that led here (kept on the new root's trail). */
  open(rid: string, hint?: WindowHint, push = true, trail?: TrailStep[]): Promise<void> {
    if (push && this.current === rid && (this.history[this.index].sel ?? rid) === rid) return this.load(this.history[this.index]);
    return this.leaving(rid, () => {
      if (push) {
        this.history = this.history.slice(0, this.index + 1);
        this.history.push({ rid, ...(hint ? { hint } : {}), ...(trail?.length && trail[trail.length - 1].rid === rid ? { trail } : {}) });
        this.index = this.history.length - 1;
      }
      return this.load(this.history[this.index]);
    });
  }

  back(): Promise<void> {
    if (this.index <= 0) {
      const origin = this.history[this.index]?.origin;
      if (origin) this.options.onOrigin?.(origin);
      return Promise.resolve();
    }
    return this.step(this.index - 1);
  }

  /** Open `rid` from a search: on `focus` (property and line), with the
   *  search as the first trail step. The same root already shown keeps its
   *  history step and gets the landing. */
  land(rid: string, hint: WindowHint | undefined, landing: { focus?: ObjectWindowFocus; origin?: ObjectWindowOrigin }): Promise<void> {
    const focus = landing.focus ? { ...landing.focus, rid, seq: ++this.focusSeq } : undefined;
    const cur = this.history[this.index];
    if (cur && cur.rid === rid && (cur.sel ?? rid) === rid && this.index === this.history.length - 1) {
      if (landing.origin) cur.origin = landing.origin;
      if (focus) cur.focus = focus;
      this.nav = { seq: this.nav.seq + 1, sel: rid };
      this.refresh();
      return Promise.resolve();
    }
    return this.leaving(rid, () => {
      this.history = this.history.slice(0, this.index + 1);
      this.history.push({ rid, ...(hint ? { hint } : {}), ...(landing.origin ? { origin: landing.origin } : {}), ...(focus ? { focus } : {}) });
      this.index = this.history.length - 1;
      return this.load(this.history[this.index]);
    });
  }

  private focusSeq = 0;

  forward(): Promise<void> {
    return this.index < this.history.length - 1 ? this.step(this.index + 1) : Promise.resolve();
  }

  /** Go to history entry `i`: within the same root only the selection
   *  changes (no read); another root loads first. */
  private step(i: number): Promise<void> {
    const next = this.history[i];
    const cur = this.history[this.index];
    if (cur && next.rid === cur.rid && this.base?.phase === 'ready') {
      this.index = i;
      this.nav = { seq: this.nav.seq + 1, ...(next.sel ? { sel: next.sel } : {}), ...(next.trail ? { trail: next.trail } : {}) };
      this.refresh();
      return Promise.resolve();
    }
    return this.leaving(next.rid, () => {
      this.index = i;
      return this.load(this.history[this.index]);
    });
  }

  retry(): Promise<void> {
    const entry = this.history[this.index];
    if (!entry) return Promise.resolve();
    this.cache.delete(entry.rid);
    // Retry asks again for every name: failed ones and ones said to be missing.
    this.missing = {};
    this.unreadable = {};
    this.summariesError = undefined;
    const rest = { ...this.presented };
    delete rest[entry.rid];
    this.presented = rest;
    return this.load(entry);
  }

  /** Read these names again (a reference chip's Retry), whatever an earlier
   *  read said about them. */
  retryNames(rids: readonly string[]): Promise<void> {
    const ask = rids.filter(r => !this.summaries[r] && !this.namesInFlight.has(r));
    if (!ask.length) return Promise.resolve();
    const missing = { ...this.missing };
    for (const r of ask) delete missing[r];
    this.missing = missing;
    return this.readNames(ask);
  }

  /** Dirty guard for in-frame navigation: pending edits belong to the
   *  current root, so leaving it asks first and then drops them. Without
   *  pending edits `go` runs at once (the header paints synchronously). */
  private leaving(next: string, go: () => Promise<void>): Promise<void> {
    if (this.saving) return Promise.resolve();
    const n = this.draft.count();
    if (!n || next === this.current) return go();
    const ask = this.options.confirmDiscard ? this.options.confirmDiscard(n, 'navigate') : Promise.resolve(true);
    return ask.then(ok => {
      if (!ok) return;
      this.draft.clear();
      return go();
    });
  }

  /** The selected node changed: EditField property choices load lazily.
   *  Labels are never fetched here (see `requestFields`). */
  nodeSelected(obj: FullObject | null): void {
    if (obj?.lite) { this.loadFull(obj.rid); return; }
    if (obj) this.loadChoices(obj);
    if (obj && isDataObject(obj)) this.ensureSchema(obj.type);
  }

  /** Load the property schema of `type` once (data objects). */
  ensureSchema(type: string): void {
    const load = this.source.propertySchema;
    if (!load || !type || this.schemas[type]) return;
    this.schemas = { ...this.schemas, [type]: { loading: true } };
    load(type).then(schema => {
      this.schemas = { ...this.schemas, [type]: { schema } };
    }, (e: unknown) => {
      this.schemas = { ...this.schemas, [type]: { error: e instanceof Error ? e.message : String(e) } };
    }).finally(() => this.refresh());
  }

  /** The schema model of custom property `prop` of `obj`, if loaded. */
  private customModel(obj: FullObject, prop: string): { model: PropertyModel; schema: TypePropertySchema } | null {
    const schema = ownValue(this.schemas, obj.type)?.schema;
    const model = schema ? customModels(schema).find(m => m.key === prop) : undefined;
    return schema && model ? { model, schema } : null;
  }

  /** Tree rows carry only their facts (object-row-facts.ts): a node is read
   *  in full when it is selected, once. */
  private readonly fullLoading = new Set<string>();
  private loadFull(rid: string): void {
    if (this.fullLoading.has(rid)) return;
    this.fullLoading.add(rid);
    this.source.readObjects([rid]).then(({ objects }) => {
      if (objects[rid]) {
        this.applyFresh(objects);
        this.loadChoices(objects[rid]);
      }
    }, () => { /* the row stays; the pane says it could not be read */ }).finally(() => {
      this.fullLoading.delete(rid);
      this.refresh();
    });
  }

  /** "All fields": load the type's full field list once per type (cached
   *  for the window's life). Its labels then serve every object of the type. */
  requestFields(obj: FullObject): void {
    const type = obj.type;
    const cur = this.fields[type];
    if (!type || cur?.list || cur?.loading) return;
    this.fields = { ...this.fields, [type]: { loading: true } };
    this.refresh();
    this.source.fieldList(type, obj.rid).then(list => {
      if (!list.length) throw new Error('No fields returned');
      this.fields = { ...this.fields, [type]: { list } };
      this.labels = { ...this.labels, [type]: labelsFromFields(list) };
    }).catch((e: unknown) => {
      this.fields = { ...this.fields, [type]: { error: e instanceof Error ? e.message : String(e) } };
    }).finally(() => this.refresh());
  }

  private loadChoices(obj: FullObject): void {
    const load = this.source.propertyChoices;
    if (!load || obj.type !== 'EditField' || !('propertyMapping' in obj.props) || this.choices[obj.rid]) return;
    const rid = obj.rid;
    this.choices = { ...this.choices, [rid]: { loading: true } };
    load(rid).then(c => {
      this.choices = { ...this.choices, [rid]: c };
    }, (e: unknown) => {
      this.choices = { ...this.choices, [rid]: { error: e instanceof Error ? e.message : String(e) } };
    }).finally(() => this.refresh());
  }

  // ── Template | Instance ────────────────────────────────────────

  setTarget(target: EditTarget): void {
    const rid = this.current;
    const root = this.base?.payload?.root;
    if (!rid || !root) return;
    const tpl = templateRidOf(root);
    if (target === 'template' && !tpl) return;
    this.targets.set(rid, target);
    if (target === 'template' && tpl && !this.templates[tpl]?.obj && !this.templates[tpl]?.loading) void this.loadTemplate(tpl);
    this.refresh();
  }

  /** Read the template `rid` once (the "overrides template" comparison). */
  ensureTemplate(rid: string): void {
    if (this.templates[rid]) return;
    void this.loadTemplate(rid);
  }

  private async loadTemplate(rid: string): Promise<void> {
    this.templates = { ...this.templates, [rid]: { loading: true } };
    this.refresh();
    try {
      const { objects, errors } = await this.source.readObjects([rid]);
      const obj = objects[rid];
      this.templates = { ...this.templates, [rid]: obj ? { obj } : { error: errors[rid] ?? 'Template not found' } };
      if (obj) this.nodeSelected(obj);
    } catch (e) {
      this.templates = { ...this.templates, [rid]: { error: e instanceof Error ? e.message : String(e) } };
    }
    this.refresh();
  }

  // ── draft ──────────────────────────────────────────────────────

  /** Every object the draft can refer to: root, nodes and loaded templates. */
  private objects(): Record<string, FullObject> {
    const p = this.base?.payload;
    const out: Record<string, FullObject> = {};
    if (p) {
      const shown = this.presented[p.root.rid]?.payload;
      if (shown) {
        Object.assign(out, shown.nodes);
        out[shown.root.rid] = shown.root;
      }
      // Objects hung in by reference are edited like any other node.
      const extra = this.extras.get(p.root.rid);
      if (extra) Object.assign(out, extra.nodes);
      Object.assign(out, p.nodes);
      out[p.root.rid] = p.root;
    }
    for (const [rid, t] of Object.entries(this.templates)) if (t.obj) out[rid] = t.obj;
    return out;
  }

  edit(rid: string, prop: string, value: string, base: string): void {
    if (this.saving) return;
    const obj = this.objects()[rid];
    // Guard: only properties the read returned and the policy allows.
    if (!obj || !editability(obj, prop)) return;
    this.draft.set(rid, prop, value, base);
    this.saveNote = undefined;
    this.refresh();
  }

  /** Stage a custom property value. Only an editable custom property of the
   *  object's type schema, and only a value that fits its kind (the service
   *  worker checks both again before it writes). Returns why a value is not
   *  staged (the gate's own words), so the row can keep the edit and say so;
   *  undefined when it is staged. */
  editCustom(rid: string, prop: string, value: string): string | undefined {
    if (this.saving) return 'A save is under way.';
    const obj = this.objects()[rid];
    const found = obj ? this.customModel(obj, prop) : null;
    if (!obj || !found) return 'The property schema is not loaded.';
    const { model, schema } = found;
    if (!model.editability.ok) return model.editability.text;
    if (!isEditKind(model.kind)) return 'This property is not editable in the object window.';
    const kind = model.kind;
    let items: Set<string> | undefined;
    if (kind === 'listItem') items = new Set((ownValue(schema.listItems, prop) ?? []).map(i => i.rid));
    else if (isReferenceKind(kind)) {
      // Checked against the allowed objects this window read; the gate
      // reads them again before it writes.
      const allowed = ownValue(this.allowed, allowedKey(rid, prop));
      if (allowed?.phase === 'done' && allowed.tooMany) return REASON_TEXT['list-too-long'];
      if (allowed?.phase !== 'done') return ALLOWED_NOT_LOADED;
      items = new Set(allowed.items.map(i => i.rid));
      // A list keeps what it holds: only added objects must be allowed.
      if (kind === 'referenceList') for (const r of referenceRids(storedValue(obj, prop, kind))) items.add(r);
    }
    const enc = encodeCustomValue(kind, value, { integer: model.integer, items, options: model.options, allowBlank: model.allowBlank, historical: model.historical });
    if ('error' in enc) return enc.error;
    this.draft.setCustom(rid, prop, { value, base: storedValue(obj, prop, kind), definition: prop, accessor: model.accessor, valueKind: kind });
    this.saveNote = undefined;
    this.refresh();
    return undefined;
  }

  /** Stage the objects of a reference row (`rids` in the order the user
   *  built; one for a single reference, none for "Not set"). The value is
   *  property-schema's canonical form; the rest is editCustom. Returns the
   *  refusal in words, undefined when staged (or when it equals the stored
   *  value as a set: the entry is then dropped). */
  editReferences(rid: string, prop: string, rids: readonly string[]): string | undefined {
    return this.editCustom(rid, prop, referenceValue(rids));
  }

  /** Read the allowed objects of reference row `prop` of object `rid` (once
   *  per window until a save of the object; `refresh` reads again). Loading
   *  and error states land in `WindowModel.allowed`. */
  loadAllowed(rid: string, prop: string, opts: { refresh?: boolean } = {}): void {
    const load = this.source.allowedObjects;
    const obj = this.objects()[rid];
    const found = obj ? this.customModel(obj, prop) : null;
    if (!load || !obj || !found || !isReferenceKind(found.model.kind)) return;
    const key = allowedKey(rid, prop);
    const cur = ownValue(this.allowed, key);
    if (cur?.phase === 'loading' || (cur?.phase === 'done' && !cur.stale && !opts.refresh)) return;
    const state: AllowedObjectsState = { phase: 'loading', ...(cur?.phase === 'done' ? { items: cur.items } : {}) };
    this.allowed = { ...this.allowed, [key]: state };
    this.refresh();
    load(rid, prop, obj.type).then(read => {
      if (this.allowed[key] !== state) return;
      this.allowed = { ...this.allowed, [key]: { phase: 'done', items: read.items, ...(read.tooMany ? { tooMany: true } : {}) } };
    }, (e: unknown) => {
      if (this.allowed[key] !== state) return;
      this.allowed = { ...this.allowed, [key]: { phase: 'error', error: e instanceof Error ? e.message : String(e) } };
    }).finally(() => this.refresh());
  }

  /** Mark the allowed objects of these objects' rows stale: their names
   *  still serve the words, the next loadAllowed reads them again. */
  private forgetAllowed(rids: readonly string[]): void {
    if (!rids.length) return;
    const drop = new Set(rids);
    const next: Record<string, AllowedObjectsState> = {};
    for (const [key, state] of Object.entries(this.allowed)) {
      const owner = key.slice(0, key.indexOf(':'));
      if (!drop.has(owner)) next[key] = state;
      else if (state.phase === 'done') next[key] = { ...state, stale: true };
    }
    this.allowed = next;
  }

  /** The allowed objects of a reference row, as loaded (undefined: not asked). */
  allowedFor(rid: string, prop: string): AllowedObjectsState | undefined {
    return ownValue(this.allowed, allowedKey(rid, prop));
  }

  /** Everything a reference row's editor needs, or null when `prop` is not a
   *  reference row of a loaded schema. */
  referenceRow(rid: string, prop: string): ReferenceRowState | null {
    const obj = this.objects()[rid];
    const found = obj ? this.customModel(obj, prop) : null;
    if (!obj || !found || !isReferenceKind(found.model.kind)) return null;
    const { model } = found;
    const kind = found.model.kind;
    const allowed = this.allowedFor(rid, prop);
    const stored = storedValue(obj, prop, kind);
    const e = this.draft.get(rid, prop);
    const value = e?.kind === 'custom' ? e.value : stored;
    const items = allowed?.phase === 'done' || allowed?.phase === 'loading' ? allowed.items : undefined;
    let editability: Editability = model.editability;
    if (editability.ok) {
      if (allowed?.phase === 'done' && allowed.tooMany) editability = { ok: false, reason: 'list-too-long', text: REASON_TEXT['list-too-long'] };
      else if (allowed?.phase === 'error') editability = { ok: false, reason: 'unread-definition', text: allowed.error };
      else if (allowed?.phase !== 'done') editability = { ok: false, reason: 'unread-definition', text: ALLOWED_NOT_LOADED };
    }
    return {
      kind, model, editability, ...(allowed ? { allowed } : {}), value, stored,
      selected: referenceRids(value).map(r => refName(r, items, this.summaries)),
      outside: outsideAllowed(value, allowed),
      mayBeEmpty: model.allowBlank === true,
      dated: model.dated === true,
    };
  }

  /** The named objects a reference row's allowed objects and the object
   *  summaries know (for words). */
  private refItems(rid: string, prop: string): ListItem[] | undefined {
    const a = this.allowedFor(rid, prop);
    return a?.phase === 'done' || a?.phase === 'loading' ? a.items : undefined;
  }

  /** A custom value in words (review, conflict, "stored value differs").
   *  A text that begins or ends with white space is quoted, so the
   *  difference to the same text without it shows. A reference value names
   *  its objects as "Name (ID)". */
  private customText(rid: string, prop: string, value: string, objects: Record<string, FullObject>): string {
    const obj = objects[rid];
    const found = obj ? this.customModel(obj, prop) : null;
    const kind = found?.model.kind ?? 'text';
    if (isReferenceKind(kind)) return referenceText(value, this.refItems(rid, prop), this.summaries);
    return customValueText(value, kind, { items: ownValue(found?.schema.listItems, prop), summaries: this.summaries, quoteEdges: true });
  }

  /** The review facts of a custom row: the added and removed objects of a
   *  list of references, the dated note of a Historical reference. */
  private reviewDetail(rid: string, prop: string, objects: Record<string, FullObject>): ReviewDetail | undefined {
    const e = this.draft.get(rid, prop);
    const obj = objects[rid];
    const model = e?.kind === 'custom' && obj ? this.customModel(obj, prop)?.model : undefined;
    if (!e || e.kind !== 'custom' || !model || !isReferenceKind(model.kind)) return undefined;
    return {
      ...(model.kind === 'referenceList' ? { refs: referenceDiff(e.base, e.value, this.refItems(rid, prop), this.summaries) } : {}),
      ...(model.dated ? { dated: true } : {}),
    };
  }

  revert(rid: string, prop: string): void {
    if (this.saving) return;
    this.draft.revert(rid, prop);
    this.refresh();
  }

  toggleReset(rid: string, prop: string, base: string): void {
    if (this.saving) return;
    if (this.draft.get(rid, prop)?.kind === 'reset') this.draft.revert(rid, prop);
    else this.draft.stageReset(rid, prop, base);
    this.refresh();
  }

  async discard(): Promise<void> {
    const n = this.draft.count();
    if (this.saving || !n) return;
    if (this.options.confirmDiscard && !(await this.options.confirmDiscard(n, 'discard'))) return;
    this.draft.clear();
    this.saveNote = undefined;
    this.refresh();
  }

  /** Review, then save through the existing routes; re-read what was written.
   *
   *  Each object is compared with what BMP holds now before it is written
   *  (save-plan.ts). Held objects go to the conflict dialog; the others save.
   *  After the writes, one re-read shows what BMP stores: "Saved" only when
   *  it matches what was sent, and a write whose answer was lost is resolved
   *  to "saved after all", "not saved" or "could not check". */
  async save(): Promise<void> {
    if (this.saving || !this.draft.count()) return;
    const objects = this.objects();
    const items = this.draft.items();
    const root = this.base?.payload?.root;
    const tpl = templateRidOf(root);
    const describe = (rid: string) => {
      const o = objects[rid];
      const kind = o ? (typeInfo(o.type).label || o.type) : '';
      // Where the change is written: the template, or this instance of it.
      const where = rid === tpl ? ' · template' : tpl && rid === root?.rid ? ' · this instance' : '';
      return { rid, name: o?.name || o?.businessId || '', kind: `${kind}${where}` };
    };
    const label = (rid: string, prop: string) => {
      const custom = isCustomKey(prop) && objects[rid] ? this.customModel(objects[rid], prop)?.model : undefined;
      if (custom) return `${custom.label} (${custom.accessor})`;
      return EXPRESSIONS[prop]?.label ?? propLabel(objects[rid] ?? { type: '' }, prop, this.labels);
    };
    const isCode = (rid: string, prop: string) => objects[rid]?.props[prop]?.kind === 'code';
    const display = (rid: string, prop: string, value: string) => (isCustomKey(prop) && this.draft.get(rid, prop)?.kind === 'custom' ? this.customText(rid, prop, value, objects) : undefined);
    const review = buildReview(items, describe, label, isCode, display, (rid, prop) => this.draft.propErrorFor(rid, prop),
      (rid, prop) => (isCustomKey(prop) ? this.reviewDetail(rid, prop, objects) : undefined));
    if (this.options.confirmSave && !(await this.options.confirmSave(review))) return;

    // A list item or a referenced object is sized with its business ID (its
    // pre-lookup reference): list items from the schema, objects from the
    // allowed objects this window read.
    const itemId = (rid: string, definition: string, item: string) => {
      const o = objects[rid];
      const list = o ? ownValue(ownValue(this.schemas, o.type)?.schema?.listItems, definition) : undefined;
      return (list ?? this.refItems(rid, definition))?.find(i => i.rid === item)?.id;
    };
    const plans = planSave(items, objects, { itemId });
    this.saving = true;
    this.refresh();
    const port: SavePort = {
      run: step => {
        const o = objects[step.rid];
        return this.source.run(step, o ? { name: o.name, businessId: o.businessId, type: o.type } : undefined);
      },
      check: (rid, opened, kinds) => this.checkOpened(rid, opened, kinds),
    };
    let results = await runSave(plans, port);

    // Held objects: the user decides. The other objects are already saved.
    const held = results.filter(r => r.held);
    const heldNotes = new Map<string, string>();
    let reviewAgain = false;
    if (held.length) {
      const savedObjects = results.filter(r => r.saved.length).length;
      const content = buildConflict(
        held.map(r => ({
          object: describe(r.rid),
          ...(r.held!.state === 'changed' ? { changes: r.held!.changes } : {}),
          ...(r.held!.state === 'unreadable' ? { checkError: r.held!.error } : {}),
        })),
        savedObjects, label, isCode,
        (rid, prop) => { const e = this.draft.get(rid, prop); return e?.kind === 'value' || e?.kind === 'custom' ? e.value : undefined; },
        display,
      );
      const choice = this.options.resolveConflict ? await this.options.resolveConflict(content) : 'cancel';
      if (choice === 'overwrite') {
        const heldRids = new Set(held.map(r => r.rid));
        const again = await runSave(plans.filter(p => heldRids.has(p.rid)), port, { force: true });
        results = results.map(r => again.find(a => a.rid === r.rid) ?? r);
      } else {
        for (const r of held) {
          if (choice === 'review' && r.held!.state === 'changed') {
            this.reviewChanged(r.rid, r.held!);
            reviewAgain = true;
            heldNotes.set(r.rid, `Changed in BMP since you opened it. Your edit is kept and now compares with the current BMP value; save again to write it.`);
          } else {
            const h = r.held!;
            heldNotes.set(r.rid, h.state === 'unreadable'
              ? `Not saved: could not check whether it ${CHANGED_IN_BMP} (${h.error}).`
              : `Not saved: ${CHANGED_IN_BMP}.`);
          }
        }
      }
    }

    for (const r of results) {
      // A custom entry leaves the draft only after its own read-back matched
      // (settle); the other routes keep their behaviour.
      this.draft.commit(r.rid, r.saved.filter(s => s.entry.kind !== 'custom'));
      this.draft.setError(r.rid, heldNotes.get(r.rid) ?? r.error);
      for (const [prop, why] of Object.entries(r.propErrors ?? {})) this.draft.setPropError(r.rid, prop, why);
    }
    const reread = results.filter(r => r.attempted).map(r => r.rid);
    if (results.some(r => r.unknown?.length)) {
      const ms = this.options.unknownRereadDelayMs ?? 2000;
      if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
    }
    let rereadError: string | undefined;
    let fresh: Record<string, FullObject> = {};
    if (reread.length) {
      try {
        const read = await this.source.readObjects(reread);
        fresh = read.objects;
        this.applyFresh(fresh);
        const missing = reread.filter(r => !fresh[r]);
        if (missing.length) rereadError = read.errors[missing[0]] ?? 'Object not found';
      } catch (e) {
        rereadError = e instanceof Error ? e.message : String(e);
      }
    }
    // The change record: what was sent, with the opened value.
    const sent = changeInputs(results, fresh, objects, label,
      (rid, prop, entry, value) => (entry.kind === 'custom' ? this.customText(rid, prop, value, objects) : value));
    if (sent.length) this.source.recordChanges?.(sent);
    this.saveNote = this.settle(results, fresh, heldNotes, label, rereadError);
    // The allowed objects depend on the object's data: a written object's
    // sets are read again when its rows ask (after settle named the values).
    this.forgetAllowed(reread);
    this.saving = false;
    this.refresh();
    // Review: open the review again, now against the current BMP values.
    if (reviewAgain) await this.save();
  }

  /** One read of `rid`, compared with the opened values. */
  private async checkOpened(rid: string, opened: Readonly<Record<string, string>>, kinds?: Readonly<Record<string, CustomEntry['valueKind']>>): Promise<ObjectCheck> {
    const { objects, errors } = await this.source.readObjects([rid]);
    return checkAgainstRead(opened, objects[rid], errors[rid], kinds);
  }

  /** Review: show the current BMP values and compare the draft with them. */
  private reviewChanged(rid: string, check: Extract<ObjectCheck, { state: 'changed' }>): void {
    if (check.object) this.applyFresh({ [rid]: check.object });
    for (const c of check.changes) {
      const entry = this.draft.get(rid, c.prop);
      if (entry?.kind === 'value') this.draft.set(rid, c.prop, entry.value, c.current);
      else if (entry?.kind === 'custom') this.draft.setCustom(rid, c.prop, { ...entry, base: c.current });
      else if (entry?.kind === 'reset') this.draft.stageReset(rid, c.prop, c.current);
    }
  }

  /** After the re-read: check what BMP stores against what was sent, resolve
   *  lost answers, and return the one-line note. */
  private settle(
    results: readonly ObjectResult[],
    fresh: Readonly<Record<string, FullObject>>,
    heldNotes: ReadonlyMap<string, string>,
    label: (rid: string, prop: string) => string,
    rereadError: string | undefined,
  ): string {
    const differs: string[] = [];
    const customDiffers: string[] = [];
    let unchecked = 0;
    let verified = 0;
    let unknown: UnknownOutcome | undefined;
    for (const r of results) {
      const obj = fresh[r.rid];
      for (const { prop, entry } of r.saved) {
        if (entry.kind === 'custom') {
          if (!obj) {
            // Sent, but nothing tells whether it is stored: the row stays marked.
            unchecked++;
            this.draft.setPropError(r.rid, prop, UNCHECKED_LINE);
            continue;
          }
          if (customStored(entry, prop, obj)) {
            // Compared by kind; "not set" or another item never counts as saved.
            verified++;
            this.draft.commit(r.rid, [{ prop, entry }]);
            continue;
          }
          // Stored differs: the edit stays, now against what BMP holds, so the
          // next save does not report a change made by this save.
          const stored = storedValue(obj, prop, entry.valueKind);
          const text = this.customText(r.rid, prop, stored, { ...fresh });
          this.draft.setCustom(r.rid, prop, { value: entry.value, base: stored, definition: entry.definition, accessor: entry.accessor, valueKind: entry.valueKind });
          this.draft.setPropError(r.rid, prop, `Stored value differs: ${text}`);
          customDiffers.push(`${label(r.rid, prop)}: "${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`);
          continue;
        }
        verified++;
        if (!obj || entry.kind !== 'value' || readBackEquals(prop, entry.value, obj.props[prop])) continue;
        differs.push(storedDiffersLine(label(r.rid, prop), obj.props[prop]?.text ?? ''));
      }
      if (!r.unknown?.length) continue;
      let outcome: UnknownOutcome;
      if (!obj) outcome = 'unverified';
      else if (r.unknown.every(({ prop, entry }) => (entry.kind === 'custom' ? customStored(entry, prop, obj)
        : entry.kind === 'value' && readBackEquals(prop, entry.value, obj.props[prop])))) {
        outcome = 'saved';
        this.draft.commit(r.rid, r.unknown);
        this.draft.setError(r.rid, undefined);
      } else outcome = 'not-saved';
      if (outcome !== 'saved') this.draft.setError(r.rid, unknownOutcomeLine(outcome));
      // The least certain outcome speaks for the note.
      if (unknown === undefined || outcome === 'unverified' || (outcome === 'not-saved' && unknown === 'saved')) unknown = outcome;
    }
    const saved = verified;
    const failed = results.filter(r => this.draft.errorFor(r.rid) && !heldNotes.has(r.rid)).length;
    if (unknown) return unknownOutcomeLine(unknown);
    // Every entry that is not stored as sent is named (and marked on its
    // row), also next to another object's failure, hold or unchecked write.
    const notStored = customDiffers.length ? `Not stored as sent: ${customDiffers.join('; ')}${differs.length ? ` (+${differs.length} more)` : ''}` : '';
    const andNotStored = notStored ? `; ${notStored}` : '';
    if (heldNotes.size) {
      const held = results.filter(r => heldNotes.has(r.rid));
      const unread = held.filter(r => r.held?.state === 'unreadable').length;
      const reason = !unread ? CHANGED_IN_BMP : unread === held.length ? 'could not check for changes in BMP' : `${CHANGED_IN_BMP}, or could not check`;
      const k = held.length;
      return `${saved ? `Saved ${saved}; ` : ''}${k} object${k === 1 ? '' : 's'} held back: ${reason}${andNotStored}`;
    }
    if (failed) return `Saved ${saved}, ${failed} object${failed === 1 ? '' : 's'} not saved${andNotStored}`;
    if (unchecked) return `${saved ? `Saved ${saved}; ` : ''}${UNCHECKED_LINE}${rereadError ? ` (${rereadError})` : ''}${andNotStored}`;
    if (notStored) return notStored;
    if (differs.length) return `${differs[0]}${differs.length > 1 ? ` (+${differs.length - 1} more)` : ''}`;
    return `Saved ${saved} change${saved === 1 ? '' : 's'}${rereadError ? '. Reload to see the stored values.' : ''}`;
  }

  /** Put re-read objects into the current payload, the cache and templates. */
  private applyFresh(fresh: Record<string, FullObject>): void {
    for (const [rid, obj] of Object.entries(fresh)) {
      if (this.templates[rid]) this.templates = { ...this.templates, [rid]: { obj } };
      // A saved target shows its new code in peeks and cards.
      if (this.refs.code(rid)?.obj) this.refs.putObject(obj);
    }
    for (const [root, extra] of this.extras) {
      if (!Object.keys(fresh).some(r => extra.nodes[r])) continue;
      this.extras.set(root, { ...extra, nodes: Object.fromEntries(Object.entries(extra.nodes).map(([r, o]) => [r, fresh[r] ?? o])) });
    }
    const touches = (p: ObjectRootPayload) => !!fresh[p.root.rid] || Object.keys(p.nodes).some(r => fresh[r]);
    const merge = (p: ObjectRootPayload): ObjectRootPayload => ({
      ...p,
      root: fresh[p.root.rid] ?? p.root,
      nodes: Object.fromEntries(Object.entries(p.nodes).map(([r, o]) => [r, fresh[r] ?? o])),
    });
    for (const [key, entry] of this.cache) {
      const p = entry.payload;
      if (!touches(p)) continue;
      const next = merge(p);
      this.cache.set(key, { payload: next, at: entry.at });
      if (this.base?.payload === p) this.base = { ...this.base, payload: next };
    }
    for (const [key, st] of Object.entries(this.presented)) {
      if (st.payload && touches(st.payload)) this.presented = { ...this.presented, [key]: { payload: merge(st.payload) } };
    }
    const root = this.base?.payload?.root;
    if (root && fresh[root.rid]) this.options.onRoot?.(root);
  }

  // ── model ──────────────────────────────────────────────────────

  private publish(base: BaseModel): void {
    this.base = base;
    const extra = base.payload ? this.extras.get(base.payload.root.rid) ?? null : null;
    const model: WindowModel = {
      ...base,
      canBack: this.index > 0 || !!this.history[this.index]?.origin,
      ...(this.history[this.index]?.origin ? { origin: this.history[this.index].origin } : {}),
      ...(this.history[this.index]?.focus ? { focus: this.history[this.index].focus } : {}),
      canForward: this.index < this.history.length - 1,
      refs: this.refs,
      refsVersion: this.refs.version,
      ...(extra ? { extra: { rows: extra.rows, nodes: extra.nodes } } : {}),
      nav: this.nav,
      summaries: this.summaries,
      ...(this.summariesError ? { summariesError: this.summariesError } : {}),
      missing: this.missing,
      unreadable: this.unreadable,
      pendingNames: this.pendingNames,
      labels: this.labels,
      fields: this.fields,
      schemas: this.schemas,
      allowed: this.allowed,
      ...(this.presented[base.rid] ? { presented: this.presented[base.rid] } : {}),
      draft: this.draft,
      saving: this.saving,
      ...(this.saveNote ? { saveNote: this.saveNote } : {}),
      target: this.targets.get(base.rid) ?? 'instance',
      templates: this.templates,
      choices: this.choices,
      inbound: this.inbound,
      inCode: this.inCode,
      applications: this.applications,
      pinned: this.pins.has(base.rid),
      canPin: !!this.source.togglePin,
    };
    this.view.update(model);
  }

  private refresh(): void {
    if (this.base) this.publish(this.base);
  }

  private async load(entry: Entry): Promise<void> {
    const token = ++this.token;
    this.saveNote = undefined;
    const cached = this.cache.get(entry.rid);
    if (cached && this.now() - cached.at < this.cacheMs) {
      this.landed(entry, cached.payload);
      return;
    }
    // Paint the header from the hint at once; the read follows.
    const hint = entry.hint ?? this.hintFromKnown(entry.rid);
    this.publish({ phase: 'loading', rid: entry.rid, ...(hint ? { hint } : {}) });
    try {
      const payload = await this.source.openRoot(entry.rid, hint?.type);
      if (token !== this.token) return;
      this.cache.set(entry.rid, { payload, at: this.now() });
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.landed(entry, payload);
    } catch (e) {
      if (token !== this.token) return;
      this.publish({ phase: 'fatal', rid: entry.rid, ...(hint ? { hint } : {}), error: e instanceof Error ? e.message : String(e) });
    }
  }

  private hintFromKnown(rid: string): WindowHint | undefined {
    const s = this.summaries[rid];
    if (s) return { name: s.name, type: s.type, businessId: s.businessId };
    for (const { payload } of this.cache.values()) {
      const o = payload.nodes[rid];
      if (o) return { name: o.name, type: o.type, businessId: o.businessId };
    }
    return undefined;
  }

  private landed(entry: Entry, payload: ObjectRootPayload): void {
    entry.hint = { name: payload.root.name, type: payload.root.type, businessId: payload.root.businessId };
    this.nav = { seq: this.nav.seq + 1, ...(entry.sel ? { sel: entry.sel } : {}), ...(entry.trail ? { trail: entry.trail } : {}) };
    // The summary read starts before the first paint only so its rids are
    // marked pending there (names show a placeholder, never a bare rid); it
    // runs after, and neither it nor the presenting template waits for the
    // other. The service worker usually has the template under way already.
    const names = this.loadSummaries(payload);
    this.publish({ phase: 'ready', rid: entry.rid, hint: entry.hint, payload });
    this.options.onRoot?.(payload.root);
    void this.loadPresented(payload);
    void names;
  }

  /** A data object's presenting template: its structure listing and one
   *  batched read, through the same open-root path. Soft on failure. */
  private async loadPresented(payload: ObjectRootPayload): Promise<void> {
    const root = payload.root;
    if (!isDataObject(root)) return;
    const tpl = root.references.template?.[0];
    const cur = this.presented[root.rid];
    if (cur?.payload || cur?.loading) return;
    if (!tpl) {
      this.presented = { ...this.presented, [root.rid]: { none: true } };
      this.refresh();
      return;
    }
    this.presented = { ...this.presented, [root.rid]: { loading: true } };
    this.refresh();
    try {
      const cached = this.cache.get(tpl);
      const p = cached && this.now() - cached.at < this.cacheMs ? cached.payload : await this.source.openRoot(tpl, TEMPLATE_HINT);
      if (!cached) this.cache.set(tpl, { payload: p, at: this.now() });
      this.presented = { ...this.presented, [root.rid]: { payload: p } };
      this.refresh();
      await this.loadSummaries(p);
    } catch (e) {
      this.presented = { ...this.presented, [root.rid]: { error: e instanceof Error ? e.message : String(e) } };
      this.refresh();
    }
  }

  /** ONE summary read (chunked only past 200 rids) for every name the pane
   *  wants: relation targets outside the tree, custom property keys and
   *  numeric reference roles (definition rids), and EditField mappings.
   *  Names another read is fetching are waited for, then asked again if
   *  that read did not answer them. */
  private async loadSummaries(payload: ObjectRootPayload): Promise<void> {
    const inTree = new Set([payload.root.rid, ...Object.keys(payload.nodes), ...(payload.rows ?? []).map(r => r.rid)]);
    const wanted = new Set<string>();
    const want = (r: string) => { if (!this.summaries[r] && !this.missing[r]) wanted.add(r); };
    for (const obj of [payload.root, ...Object.values(payload.nodes)]) {
      for (const [role, rids] of Object.entries(obj.references)) {
        if (HIDDEN_ROLES.test(role) && !NAMED_AUDIT_ROLES.has(role)) continue;
        if (isCustomKey(role)) want(role);
        for (const r of rids) if (!inTree.has(r)) want(r);
      }
      for (const k of Object.keys(obj.props)) if (isCustomKey(k)) want(k);
      const mapping = obj.type === 'EditField' ? obj.props.propertyMapping?.text.trim() : '';
      if (mapping && isCustomKey(mapping)) want(mapping);
    }
    if (!wanted.size) return;
    const elsewhere = [...wanted].filter(r => this.namesInFlight.has(r));
    const own = [...wanted].filter(r => !this.namesInFlight.has(r));
    const waits = [...new Set(elsewhere.map(r => this.namesInFlight.get(r)!))];
    await this.readNames(own);
    if (!waits.length) return;
    await Promise.all(waits);
    // The other read may have failed or dropped them: ask now.
    await this.readNames(elsewhere.filter(r => !this.summaries[r] && !this.missing[r] && !this.namesInFlight.has(r)));
  }

  /** Read the names of `rids`. What the server says about one object (it
   *  is not there, or it cannot be read) is remembered; a read that failed
   *  or dropped an answer is asked once more at once (not after a lost
   *  connection), and what fails again shows "could not be read" with Retry.
   *  Only this read's answers are merged, so reads in flight never
   *  overwrite each other's names. */
  private async readNames(rids: readonly string[]): Promise<void> {
    if (!rids.length) return;
    let done!: () => void;
    const flight = new Promise<void>(resolve => { done = resolve; });
    for (const r of rids) { this.pendingNames.add(r); this.namesInFlight.set(r, flight); }
    const next: Record<string, ObjectSummary> = {};
    const missing: Record<string, true> = {};
    const unreadable: Record<string, string> = {};
    let failed: Record<string, string> = {};
    let error: string | undefined;
    try {
      let ask = [...rids];
      for (let attempt = 0; attempt < 2 && ask.length; attempt++) {
        const round = await this.readNamesOnce(ask);
        Object.assign(next, round.found);
        Object.assign(missing, round.missing);
        Object.assign(unreadable, round.unreadable);
        failed = round.failed;
        error = round.error;
        if (round.connection) break;
        ask = Object.keys(failed);
      }
    } finally {
      for (const r of rids) {
        if (this.namesInFlight.get(r) !== flight) continue;
        this.namesInFlight.delete(r);
        this.pendingNames.delete(r);
      }
      this.summaries = { ...this.summaries, ...next };
      this.missing = { ...this.missing, ...missing };
      this.unreadable = { ...this.unreadable, ...unreadable };
      // A name still unknown after this read shows the reason and Retry.
      if (Object.keys(failed).length) this.summariesError = error ?? Object.values(failed)[0];
      this.refresh();
      done();
    }
  }

  /** One pass over `rids`. `missing`: the server says they are not there;
   *  `unreadable`: their own read fails on the server (isolated from a batch
   *  by halving, `readIsolating`), remembered too; `failed`: the read failed
   *  or left them out, worth asking again; `connection`: the read failed as
   *  a whole and splitting would not help. */
  private async readNamesOnce(rids: readonly string[]): Promise<{
    found: Record<string, ObjectSummary>; missing: Record<string, true>; unreadable: Record<string, string>;
    failed: Record<string, string>; error?: string; connection?: boolean;
  }> {
    const found: Record<string, ObjectSummary> = {};
    const missing: Record<string, true> = {};
    const unreadable: Record<string, string> = {};
    const failed: Record<string, string> = {};
    let error: string | undefined;
    let connection = false;
    for (let i = 0; i < rids.length; i += SUMMARY_CHUNK) {
      const chunk = rids.slice(i, i + SUMMARY_CHUNK);
      try {
        const res = await readIsolating(chunk, async ids => toAnswer(await this.source.readSummaries(ids)));
        const alone = Object.entries(res.failed);
        if (!res.results.length && (alone.length > 1 || res.unresolved.length)) {
          // No part of the batch could be read: not one bad rid, the read
          // itself failed. Nothing is remembered.
          error = res.error ?? alone[0]?.[1] ?? 'Summary read failed';
          for (const r of chunk) failed[r] = error;
          continue;
        }
        for (const answer of res.results) {
          for (const s of answer.summaries) found[s.rid] = s;
          for (const r of answer.missing ?? []) missing[r] = true;
          Object.assign(failed, answer.failed ?? {});
        }
        for (const [r, why] of alone) { unreadable[r] = why; missing[r] = true; }
        if (res.error) error = res.error;
        for (const r of res.unresolved) failed[r] = res.error ?? 'Summary read failed';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        connection = true;
        for (const r of chunk) failed[r] = error;
      }
      // Every asked rid ends somewhere; an answer that left one out dropped it.
      for (const r of chunk) {
        if (found[r] || missing[r]) { delete failed[r]; continue; }
        failed[r] ??= 'The read answered without this object';
      }
    }
    return { found, missing, unreadable, failed, ...(error ? { error } : {}), ...(connection ? { connection } : {}) };
  }
}
