/**
 * Object window view — structure tree on the left, one generic detail pane
 * for the selected node on the right, the save bar at the bottom.
 *
 * Renders from plain data (`WindowModel`) and reports intent through
 * `ViewHandlers`. No chrome.* calls in here, so the view can be unit-tested
 * and driven from fixtures.
 *
 * Editing:
 *  - every pending edit lives in the window draft (controller); the view
 *    marks it on the control, on the object's tree row and in the save bar,
 *    with a diamond and the word "Unsaved" so colour is never the only cue;
 *  - name and ID open an input only from their pencil buttons;
 *    clicking or selecting the text never starts an edit;
 *  - expressions are edited in place with CodeMirror (loaded on first edit);
 *  - Escape inside an edit cancels that edit and never closes the window.
 */

import { unknownOutcomeLine } from '../../lib/save-check';
import { escapeLayers } from '../../lib/escape-layers';
import { ariaKeyShortcuts, eventTarget, shortcutLabels, whichShortcut, withShortcut } from '../../lib/shortcuts';
import { copyWithFeedback } from '../../lib/copy-feedback';
import type { FullObject, ObjectSummary, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { rowFactsNote } from '../../lib/row-facts-status';
import { assembleStructure, attachRows, attachTree, type AttachedRow, type StructureNode, type StructureTree } from '../../lib/object-structure';
import {
  EXPRESSIONS, HIDDEN_ROLES, ROLE_ORDER, blocksFor, codePropsFor, curatedProps, dividerLeads, followRule, isCustomKey, isDataObject, isEmptyValue, roleLabel,
  propHelp, propLabelIn, splitWords, typeInfo, typeLabel, type FieldDef, type GroupDef, type TypeInfo,
} from '../../lib/object-window-table';
import type { ObjectWindowFocus, ObjectWindowOrigin, PropertyApplication, TypeSchemaProp } from '../../lib/types';
import type { TypePropertySchema } from '../../lib/property-schema';
import { refName, type AllowedObjectsState, type RefName } from './reference-edit';
import type { ReferenceRowState } from './controller';
import { decodeEcLiteral, isPropertyConfigClass } from '../../lib/property-config';
import {
  buildSections, customValueText, NOT_SET, RELATIONS_NOTE, sectionOpen, sectionRowHay, type PropSection, type SectionRow,
} from './prop-sections';
import {
  ABSENT, isEditKind, isReferenceKind, parseNumberInput, REASON_TEXT, referenceRids, type ListItem, type PropertyKind,
} from '../../lib/property-schema';

const isTextKind = (k: PropertyKind) => k === 'text' || k === 'multiline';
import { identityBusinessIdError } from '../../lib/object-identity';
import { colorLinkBid } from '../../lib/color-util';
import { fileLinkText, isFileLinkProp } from '../../lib/file-link-props';
import {
  colorLinkEditor, enumEditor, numberEditor, propertyAccessorEditor, sliderEditor, stringEditor, textAreaEditor,
  displayValue as draftDisplay, type EnumOption, type PropEditorContext,
} from '../../lib/property-editors';
import type { PropDef } from '../../lib/pane-schema';
import { CODE_CAP_LINES, formatCount, keysReadBy, renderCode } from '../../editor-core/code-view';
import type { CodeEditorFactory, CodeEditorHandle } from './code-edit';
import { baseText, canReset, editability, readOnlyReason, templateRidOf, type DraftEntry, type DraftView } from './draft';
import { compareFailed, overrides, overrideState, type OverrideState } from './override-diff';
import { ICON_SPRITE } from '../../lib/icon-sprite';
import type { AccessMode } from './access-state';
import { AccessPane, accessCells, accessRowLabel, type AccessPaneHandlers } from './access-view';
import { ACCESS_ACTIONS } from '../../lib/access-mode';
import type { CodeRefCache } from '../../lib/code-ref-client';
import type { RefTarget } from '../../lib/code-ref-resolve';
import { RefUi, type RefCtx, type RefUiState } from '../../editor-core/code-links';
import { coverageText, SEARCH_NOW_LABEL, type Coverage } from '../../lib/coverage-line';
import { useSummary } from '../../lib/use-summary';
import { failedNote, failureBlock, unreadValue } from '../../lib/failure-form';
import { describeFailure } from '../../lib/connection-copy';
import { attrs, btn as button, el, icon, type Kid } from '../../lib/dom';

/** How long after a landing each new render scrolls to the landing line again. */
const LANDING_REVEAL_MS = 3000;

type Kids = Kid[];

export interface WindowHint {
  name?: string;
  type?: string;
  businessId?: string;
}

export type EditTarget = 'instance' | 'template';

export interface TemplateState {
  obj?: FullObject;
  loading?: boolean;
  error?: string;
}

export interface FieldListState {
  list?: TypeSchemaProp[];
  loading?: boolean;
  error?: string;
}

/** The property schema of a type (custom sections, kinds, editors). */
export interface PropertySchemaState {
  schema?: TypePropertySchema;
  loading?: boolean;
  error?: string;
}

export interface PresentedState {
  payload?: ObjectRootPayload;
  loading?: boolean;
  error?: string;
  /** The object has no template reference. */
  none?: boolean;
}

/** One object that refers to the scanned object ("Used by"). `field` is the
 *  declared reverse reference it came through, when there is one. */
export interface InboundTarget extends ObjectSummary {
  field?: string;
}

/** One object whose code calls the shown object ("Used by" › "In code"). */
export interface InCodeTarget { rid: string; name: string; type: string; businessId: string; places: number }

/** "In code": filled from the local code index (the search window's "Used
 *  in code"); `unavailable` while the index is not ready. */
export interface InCodeState {
  phase: 'loading' | 'done' | 'unavailable' | 'error';
  targets: InCodeTarget[];
  error?: string;
  /** What the answer covers (index size and age), or why nothing was searched. */
  coverage?: Coverage;
}

export interface InboundState {
  phase: 'scanning' | 'done' | 'error';
  /** Start of the scan (ms, controller clock): the progress shows the elapsed time. */
  startedAt: number;
  ms?: number;
  targets: InboundTarget[];
  /** Referrers counted by the scan, also past the cap. */
  total?: number;
  capped?: boolean;
  /** Objects linked to it as their template: the count and the first few. */
  instances?: { total: number; targets: InboundTarget[] };
  error?: string;
}

export interface ApplicationsState {
  phase: 'loading' | 'done' | 'error';
  list: PropertyApplication[];
  total?: number;
  truncated?: boolean;
  error?: string;
}

/** Options for the EditField property-mapping picker. */
export interface PropertyChoices {
  options?: EnumOption[];
  loading?: boolean;
  source?: string;
  error?: string;
}

/** One step of the trail: an object, and the call that reached it when it
 *  was reached by reference. */
export interface TrailStep {
  rid: string;
  from?: { rid: string; line: number; prop?: string };
}

export interface WindowModel {
  /** Code references: identities and target code (window lifetime). */
  refs?: CodeRefCache;
  /** Bumps with every change of `refs`. */
  refsVersion?: number;
  /** Rows hung into the current root's tree by reference. */
  extra?: { rows: readonly AttachedRow[]; nodes: Readonly<Record<string, FullObject>> };
  /** A selection to apply once (history step, followed reference). */
  nav?: { seq: number; sel?: string; trail?: TrailStep[] };
  phase: 'loading' | 'ready' | 'fatal';
  rid: string;
  hint?: WindowHint;
  error?: string;
  payload?: ObjectRootPayload;
  /** Names/types of objects outside the tree: relation targets, property
   *  definitions (custom keys, EditField mappings). */
  summaries: Readonly<Record<string, ObjectSummary>>;
  /** Rids the summary read answered without an object. */
  missing?: Readonly<Record<string, true>>;
  /** Rids whose own read failed (isolated from a failed batch) → error. */
  unreadable?: Readonly<Record<string, string>>;
  /** Set when relation names could not be loaded. */
  summariesError?: string;
  /** Rids whose summary read is under way: their names show a placeholder. */
  pendingNames?: ReadonlySet<string>;
  /** Property labels per type from a loaded field list: property name or
   *  property rid → label. Empty until a field list was fetched. */
  labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Full field list per type ("All fields"). */
  fields?: Readonly<Record<string, FieldListState>>;
  /** Property schema per type (data objects; loaded after first paint). */
  schemas?: Readonly<Record<string, PropertySchemaState>>;
  /** Allowed objects of reference rows, keyed by `allowedKey(rid,
   *  definition)` (reference-edit.ts); loaded on demand
   *  (controller.loadAllowed). */
  allowed?: Readonly<Record<string, AllowedObjectsState>>;
  /** Data-object root: its presenting template (loaded after first paint). */
  presented?: PresentedState;
  canBack: boolean;
  canForward: boolean;
  /** The window draft (all pending edits). */
  draft: DraftView;
  saving: boolean;
  /** Short result of the last save, shown in the save bar. */
  saveNote?: string;
  /** Template | Instance for the current root. */
  target: EditTarget;
  /** Template reads keyed by template rid. */
  templates: Readonly<Record<string, TemplateState>>;
  /** propertyMapping choices keyed by EditField rid. */
  choices: Readonly<Record<string, PropertyChoices>>;
  /** "Used by" scans keyed by the scanned rid. */
  inbound?: Readonly<Record<string, InboundState>>;
  inCode?: Readonly<Record<string, InCodeState>>;
  /** Property applications keyed by property definition rid. */
  applications?: Readonly<Record<string, ApplicationsState>>;
  /** The root is pinned (Browse's Pinned list). */
  pinned?: boolean;
  /** The header offers the pin toggle. */
  canPin?: boolean;
  /** The search that opened this step: the first step of the trail. */
  origin?: ObjectWindowOrigin;
  /** Property and line to land on (marked and scrolled into view). */
  focus?: ObjectWindowFocus & { rid: string; seq: number };
}

export interface ViewHandlers {
  /** Open another object as the window root (in-frame history). `trail`:
   *  the path that led to it ("Open as root" keeps it). */
  navigate(rid: string, trail?: TrailStep[]): void;
  back(): void;
  forward(): void;
  retry(): void;
  /** Read these names again (a reference chip's Retry). */
  retryNames?(rids: string[]): void;
  /** Resolves false when the clipboard write failed. */
  copy(text: string): Promise<boolean> | void;
  openInEditor(rid: string, property: string, type: string): void;
  openBlueprint(rid: string): void;
  /** The selected node changed (lazy work such as EditField choices). */
  selected?(obj: FullObject | null): void;
  /** The user switched a property list to "All fields". */
  requestFields?(obj: FullObject): void;
  /** Read the template `rid` once, to compare an object's values with it. */
  needTemplate?(rid: string): void;
  /** Stage `value` for `prop` (removes the entry when it equals `base`). */
  edit(rid: string, prop: string, value: string, base: string): void;
  /** Stage a custom property value (the controller checks it against the
   *  schema; equal to the stored value removes the entry). Returns why the
   *  value is not staged; the row keeps the edit open and says so. */
  editCustom?(rid: string, prop: string, value: string): string | undefined | void;
  /** Read the objects a reference row allows (controller.loadAllowed). */
  loadAllowed?(rid: string, prop: string, opts?: { refresh?: boolean }): void;
  /** A reference row as its editor needs it (controller.referenceRow). */
  referenceRow?(rid: string, prop: string): ReferenceRowState | null;
  /** Stage the objects of a reference row (none: "Not set"); returns the
   *  refusal in words (controller.editReferences). */
  editReferences?(rid: string, prop: string, rids: readonly string[]): string | undefined;
  revert(rid: string, prop: string): void;
  /** Stage or cancel "reset override to the template value". */
  toggleReset(rid: string, prop: string, base: string): void;
  discard(): void;
  save(): void;
  setTarget(target: EditTarget): void;
  /** Compare: with the template (side B), or with an object picked in the
   *  Compare window. The object is side A. */
  compare(kind: 'pick' | 'template', obj: FullObject): void;
  /** Atlas on this object: what it holds and what points at it. */
  atlas?(obj: { rid: string; name?: string; type?: string }): void;
  access(obj: FullObject): void;
  /** Open the colour-link picker; `apply` stages the picked bid. */
  pickColor?(anchor: HTMLElement, currentBid: string | null, apply: (bid: string) => void): void;
  /** The image picker of a button's image file (lib/image-picker.ts). A pick
   *  goes to `onChange` as the RID of the file, '' for None; the window stages it. */
  imageEditor?(spec: ImageEditorSpec): HTMLElement;
  /** Start the "Used by" scan of an object. */
  scanInbound?(obj: FullObject): void;
  /** Read "In code" of an object from the local code index. */
  usedInCode?(obj: FullObject): void;
  cancelInbound?(rid: string): void;
  /** Load where a property definition is applied. */
  loadApplications?(rid: string): void;
  togglePin?(): void;
  /** Reload the BMP page (it does not show out-of-band saves by itself). */
  reloadPage?(): void;
  /** Tree rows with a follow rule became visible: list their references. */
  followRefs?(items: Array<{ rid: string; via: string; depth: number }>): void;
  /** Go to a referenced object inside the window (attach it when needed). */
  /** `hops`: steps this adds to the trail; each is one history step. */
  reveal?(target: string, trail: TrailStep[], attach: Array<{ under: string; obj: FullObject }>, hops?: number): void;
  /** The user selected a node; the window records a history step. */
  selectionChanged?(sel: string, trail: TrailStep[], via: 'key' | 'click'): void;
  /** Node Back (-1) or Forward (1) would select, for its tooltip. */
  neighbour?(dir: -1 | 1): string | undefined;
  /** The trail's search step: back to the code search window. */
  toOrigin?(origin: ObjectWindowOrigin): void;
  /** Code search for an object: its references, or text under it. */
  /** `from`: the object the user is looking at (the search window marks
   *  the target "current object" only when it is that object). */
  findReferences?(obj: { rid: string; name?: string; type?: string; businessId?: string }, from?: { rid: string; name?: string; type?: string; businessId?: string }): void;
  searchCode?(obj: { rid: string; name?: string; type?: string; businessId?: string } | null, under: boolean): void;
}

export interface ViewOptions {
  /** CodeMirror factory; loaded on first edit when omitted. */
  codeEditor?: CodeEditorFactory;
  /** Access mode (the header's Access toggle). Without it the Access
   *  button only calls `handlers.access`. */
  access?: { mode: AccessMode; handlers: AccessPaneHandlers };
}

interface RootUiState extends RefUiState {
  /** Path that led to the selection (tree path, extended by references). */
  trail: TrailStep[];
  /** The folded middle of a long trail is shown. */
  trailOpen: boolean;
  selected: string;
  filter: string;
  collapsed: Set<string>;
  expanded: Set<string>;
  propFilter: string;
  hideEmpty: boolean;
  /** Data-object property list: values only, or every field of the type. */
  fieldMode: 'value' | 'all';
  /** The user's own fold choice per property section (section key → open). */
  folds: Map<string, boolean>;
}

/** An open in-row editor of a custom property. `text` follows the typing so
 *  a re-render (names arriving) keeps it; `start` is the value it opened on. */
interface PropEdit {
  rid: string;
  prop: string;
  text: string;
  start: string;
  error?: string;
  /** Reference editor: the highlighted option and the list's scroll. */
  active?: number;
  scroll?: number;
}

interface CodeEdit {
  rid: string;
  prop: string;
  /** Text when the edit began (Escape restores it). */
  start: string;
  base: string;
  handle: CodeEditorHandle | null;
  timer?: number;
}

const NARROW_PX = 720;
const TREE_MIN_PX = 180;
const DETAIL_MIN_PX = 320;
const TREE_WIDTH_KEY = 'crev-ow-tree-w';

/** Remembered tree width (a per-viewer convenience; storage may be blocked). */
function readTreeWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(TREE_WIDTH_KEY));
    return Number.isFinite(n) && n >= TREE_MIN_PX ? n : null;
  } catch {
    return null;
  }
}

function writeTreeWidth(w: number): void {
  try { localStorage.setItem(TREE_WIDTH_KEY, String(w)); } catch { /* storage blocked */ }
}
const ROLE_ACCESS = new Set(['Role', 'AccessPolicy']);


function dot(fam: string): HTMLElement {
  const d = el('i', 'ow-dot');
  d.style.background = `var(${fam})`;
  return d;
}

/** Unsaved marker: a diamond plus text, never colour alone. */
function dia(text = 'Unsaved changes'): HTMLElement {
  return el('span', 'ow-dia-wrap', attrs(el('i', 'ow-dia'), { 'aria-hidden': 'true' }), el('span', 'ow-sr', text));
}

function readOnlySwitch(on: boolean, label: string): HTMLElement {
  return attrs(el('span', 'ui-sw'), { role: 'switch', 'aria-checked': String(on), 'aria-readonly': 'true', 'aria-label': label, title: `${label}: ${on ? 'on' : 'off'}` });
}

function enumText(v: PropValue): string {
  const tail = v.text.split('.').pop() ?? v.text;
  return tail ? splitWords(tail) : '';
}

/** Display string for a value in the curated grid and the property list. */
/** What the image editor of a property row needs from the window. */
export interface ImageEditorSpec {
  /** The RID of the linked file ('' for none) and its name and ID when known. */
  rid: string;
  name: string;
  id: string;
  /** The object's background color: a button's buttonBackgroundColor (else headerColor), as the color object's RID and, when the window has it, its ID. */
  colorRid: string;
  colorBid: string;
  dirty: boolean;
  onChange: (rid: string) => void;
}

export function displayValue(v: PropValue): string {
  switch (v.kind) {
    case 'enum': return v.text;
    case 'list': return v.items?.length ? v.items.join(', ') : '';
    default: return v.text;
  }
}

const KIND_LABEL: Record<PropValue['kind'], string> = {
  text: 'Text', html: 'HTML', number: 'Number', boolean: 'Boolean', enum: 'Enum',
  code: 'Expression', time: 'Time', list: 'List', unknown: 'Other',
};

/** Label for a property of an object: the table's curated label, then the
 *  type's field-list label when already loaded, then a property definition
 *  name (custom keys), then a readable form of the accessor. */
export function propLabel(
  obj: { type: string },
  prop: string,
  labels?: Readonly<Record<string, Readonly<Record<string, string>>>>,
  summaries?: Readonly<Record<string, ObjectSummary>>,
): string {
  // The one property label (lib/object-window-table.ts), with this type's loaded captions.
  return propLabelIn(prop, labels?.[obj.type], summaries);
}

// ── the view ─────────────────────────────────────────────────────

/** The small glyph in front of a property's name and its word (the
 *  glyph's title): what kind of value the property holds. */
const KIND_GLYPH: Readonly<Record<PropertyKind, readonly [string, string]>> = {
  text: ['k-text', 'Text'], multiline: ['i-list', 'Long text'], rich: ['i-list', 'Rich text'],
  number: ['k-num', 'Number'], boolean: ['k-bool', 'Yes or no'], choice: ['k-choice', 'Choice'], listItem: ['k-choice', 'List item'],
  reference: ['i-link', 'Reference'], referenceList: ['k-refs', 'List of references'], principal: ['i-user', 'User or group'],
  date: ['k-date', 'Date'], code: ['k-code', 'Code'], file: ['k-file', 'File'], other: ['k-other', 'Other'],
};
/** Characters of a read-only text the row holds at most. */
const LONG_TEXT_MAX = 2000;

export class ObjectWindowView {
  private model: WindowModel | null = null;
  private tree: StructureTree | null = null;
  private treeFor: ObjectRootPayload | null = null;
  private treeForPresented: ObjectRootPayload | null = null;
  /** Divider row labels ("Page 2", "Column 2", section names) by rid. */
  private leads: Record<string, string> = {};
  private ui = new Map<string, RootUiState>();
  private readonly shell: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly fwd: HTMLButtonElement;
  private readonly crumbs: HTMLElement;
  private readonly compareWrap: HTMLElement;
  private readonly searchWrap: HTMLElement;
  /** Landing already scrolled into view (its seq). */
  private focusShown = -1;
  /** Until when a render after the landing scrolls to the line again. */
  private focusRevealUntil = 0;
  private readonly accessBtn: HTMLButtonElement;
  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private readonly struct: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly treeEl: HTMLElement;
  private readonly treeNote: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly fatal: HTMLElement;
  private readonly bar: HTMLElement;
  private renderedDetailFor = '';
  /** Identity field being edited from its pencil. */
  private idEdit: { rid: string; prop: 'name' | 'id'; value: string; error?: string } | null = null;
  private propEdit: PropEdit | null = null;
  private codeEdit: CodeEdit | null = null;
  /** The draft generation last seen (DraftView.generation; -1: none yet). */
  private draftGeneration = -1;
  private codeFactory: CodeEditorFactory | null;
  private readonly accessMode: AccessMode | null;
  private readonly accessPane: AccessPane | null;
  /** Bumps when the window's data changes (another root, a save): access
   *  results for older data are dropped. */
  private dataGen = 0;
  private accessWasOn = false;
  private accessRenderedFor = '';
  /** The tree has a width the user dragged to (access mode keeps it). */
  private userTreeWidth = false;
  /** Ticks the elapsed time of running scans (`.ow-scan-t[data-since]`). */
  private scanTimer = 0;
  /** Code reference links, peeks, card and Calls. */
  private readonly refUi: RefUi;
  /** The trail bar at the top of the detail pane. */
  private readonly trailEl: HTMLElement;
  private navSeq = -1;
  private extraRows = -1;
  private extraNodes: unknown = null;
  /** Names seen in this window (trail steps of earlier roots, history). */
  private readonly names = new Map<string, string>();

  constructor(private readonly root: HTMLElement, private readonly handlers: ViewHandlers, options: ViewOptions = {}) {
    this.codeFactory = options.codeEditor ?? null;
    this.accessMode = options.access?.mode ?? null;
    this.accessPane = options.access ? new AccessPane(options.access.mode, options.access.handlers) : null;
    const sprite = document.createElement('div');
    sprite.innerHTML = ICON_SPRITE;
    root.textContent = '';
    root.append(sprite.firstElementChild!);

    this.back = button('ui-ibtn', 'Back', () => this.handlers.back(), icon('i-back'));
    this.fwd = button('ui-ibtn', 'Forward', () => this.handlers.forward(), icon('i-fwd'));
    this.crumbs = attrs(el('nav', 'ow-crumbs'), { 'aria-label': 'Location' });
    this.compareWrap = el('span', 'ow-menu-wrap ow-menu-end');
    this.searchWrap = el('span', 'ow-menu-wrap ow-menu-end');
    this.accessBtn = button('ui-tbtn ow-acc-btn', undefined, () => this.onAccessButton(),
      icon('i-shield'), el('span', 'ow-acc-lbl', 'Access'), el('span', 'ow-acc-state', ''));
    const titlebar = el('header', 'ow-titlebar', this.back, this.fwd, this.crumbs, el('span', 'ow-grow'),
      this.searchWrap, this.compareWrap, this.accessBtn);

    this.head = el('div', 'ow-head');
    this.filter = attrs(el('input', 'ui-input') as HTMLInputElement, {
      type: 'text', placeholder: 'Filter structure', 'aria-label': 'Filter structure', autocomplete: 'off', spellcheck: 'false',
    });
    this.filter.addEventListener('input', () => {
      const st = this.state();
      if (!st) return;
      st.filter = this.filter.value;
      this.renderTree();
    });
    this.treeEl = attrs(el('div', 'ow-tree'), { role: 'tree', tabindex: '0', 'aria-label': 'Object structure' });
    this.treeEl.addEventListener('keydown', e => this.onTreeKey(e));
    this.treeNote = el('div', 'ow-quiet ow-tree-note');
    this.struct = attrs(el('aside', 'ow-struct', el('div', 'ow-filter', icon('i-search'), this.filter), this.treeEl, this.treeNote), { 'aria-label': 'Structure', id: 'ow-struct' });
    const scrim = el('div', 'ow-scrim');
    scrim.addEventListener('click', () => this.setTreeOpen(false));
    this.detail = el('main', 'ow-detail');
    // The access pane's sticky bar gets an edge once content slides under it.
    this.detail.addEventListener('scroll', () => this.detail.classList.toggle('ow-scrolled', this.detail.scrollTop > 0), { passive: true });
    this.body = el('div', 'ow-body', this.struct, this.splitter(), scrim, this.detail);
    this.fatal = el('div', 'ow-fatal');
    this.bar = attrs(el('footer', 'ow-bar'), { 'aria-label': 'Unsaved changes', 'aria-live': 'polite' });
    this.shell = attrs(el('section', 'ow ui', titlebar, this.head, this.body, this.fatal, this.bar), { 'data-tree': 'closed', 'aria-label': 'Object window' });
    // Text typed in a field counts only when the field is left (the editors commit on change). So
    // that one click on Save is enough while the cursor is still in the field: typing makes the
    // buttons usable, pressing Save does not take the focus away (the bar would be redrawn between
    // press and release and the click lost), and requestSave takes the typed text first.
    this.shell.addEventListener('input', e => {
      if (!this.typedEditor(e.target) || this.model?.saving) return;
      for (const b of this.bar.querySelectorAll<HTMLButtonElement>('button.ui-btn')) b.disabled = false;
    });
    this.bar.addEventListener('mousedown', e => {
      if ((e.target as Element | null)?.closest?.('button.ui-btn.primary') && this.typedEditor(document.activeElement)) e.preventDefault();
    });
    if (this.userTreeWidth) this.shell.dataset.treeW = 'user';
    root.append(this.shell);
    this.trailEl = attrs(el('nav', 'ow-trail'), { 'aria-label': 'Trail' });
    this.refUi = new RefUi({
      cache: () => this.model?.refs ?? null,
      state: () => this.state() ?? null,
      rerender: () => this.renderDetail(),
      open: (target, ref, ctx) => this.openRef(target, ref.line, ctx),
      ...(this.handlers.findReferences ? { findRefs: (t: RefTarget) => {
        const cur = this.selectedObj();
        this.handlers.findReferences?.({ rid: t.rid, name: t.name, type: t.type, businessId: t.businessId },
          cur ? { rid: cur.rid, name: cur.name, type: cur.type, businessId: cur.businessId } : undefined);
      } } : {}),
    }, this.shell);
    this.accessMode?.subscribe(() => this.onAccessChange());

    root.ownerDocument.addEventListener('click', e => {
      const t = e.target as Element | null;
      if (!t?.closest?.('.ow-menu-wrap')) this.closeMenus();
    });
    // Escape, innermost first (lib/escape-layers.ts): menus and the tree
    // drawer, then the card, then a peek; the window layer (main.ts) is
    // asked last. Both run before the focused element's own handlers. Inside
    // an in-place code editor its own Escape handling runs instead.
    const layers = escapeLayers(root.ownerDocument);
    layers.register({
      kind: 'menu', name: 'menus-and-tree', phase: 'capture',
      isOpen: () => this.shell.isConnected && (!!this.root.querySelector('.ow-menu[data-open="true"]') || this.shell.dataset.tree === 'open'),
      close: () => { this.closeMenus(); this.setTreeOpen(false); },
    });
    layers.register({
      kind: 'peek', name: 'card-and-peeks', phase: 'capture',
      isOpen: () => this.shell.isConnected && this.refUi.busy,
      close: e => !(e && eventTarget(e)?.closest('.cm-editor')) && this.refUi.escape(),
    });
    layers.listen(root.ownerDocument);
  }

  /** The draggable border between tree and detail pane (keyboard: arrows).
   *  The width is remembered per browser profile. */
  private splitter(): HTMLElement {
    const split = attrs(el('div', 'ow-split'), {
      role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize structure', 'aria-controls': 'ow-struct', tabindex: '0',
    });
    const stored = readTreeWidth();
    const apply = (w: number, persist: boolean) => {
      const max = Math.max(TREE_MIN_PX, (this.shell?.clientWidth || 900) - DETAIL_MIN_PX);
      const width = Math.round(Math.min(Math.max(w, TREE_MIN_PX), max));
      this.root.style.setProperty('--ow-tree-w', `${width}px`);
      split.setAttribute('aria-valuenow', String(width));
      // A width the user chose is kept as it is, also in access mode.
      this.userTreeWidth = true;
      if (this.shell) this.shell.dataset.treeW = 'user';
      if (persist) writeTreeWidth(width);
    };
    if (stored) {
      this.root.style.setProperty('--ow-tree-w', `${stored}px`);
      split.setAttribute('aria-valuenow', String(stored));
      this.userTreeWidth = true;
    }
    const current = () => this.struct.getBoundingClientRect().width;
    split.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, startW = current();
      split.setPointerCapture?.(e.pointerId);
      split.classList.add('drag');
      this.shell.dataset.split = 'drag';
      const move = (ev: PointerEvent) => apply(startW + ev.clientX - startX, false);
      const up = (ev: PointerEvent) => {
        split.removeEventListener('pointermove', move);
        split.removeEventListener('pointerup', up);
        split.removeEventListener('pointercancel', up);
        split.classList.remove('drag');
        delete this.shell.dataset.split;
        apply(startW + ev.clientX - startX, true);
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', up);
      split.addEventListener('pointercancel', up);
    });
    split.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      apply(current() + (e.key === 'ArrowLeft' ? -16 : 16), true);
    });
    return split;
  }

  /** Swap in a new model. Cheap when only summaries/labels changed. */
  update(model: WindowModel): void {
    const prev = this.model;
    this.model = model;
    this.back.disabled = !model.canBack;
    this.fwd.disabled = !model.canForward;
    this.historyTitles();
    const presented = model.presented?.payload ?? null;
    const extraRows = model.extra?.rows.length ?? 0;
    const extraNodes = model.extra?.nodes ?? null;
    if (model.payload !== this.treeFor || presented !== this.treeForPresented || extraRows !== this.extraRows || extraNodes !== this.extraNodes) {
      this.extraNodes = extraNodes;
      const fresh = model.payload !== this.treeFor;
      this.extraRows = extraRows;
      const arrived = !!presented && !this.treeForPresented;
      // A template arriving later adds nodes; it does not change data.
      if (fresh || (presented && this.treeForPresented && presented !== this.treeForPresented)) this.dataGen++;
      this.treeFor = model.payload ?? null;
      this.treeForPresented = presented;
      this.tree = model.payload ? this.buildTree(model.payload, presented) : null;
      if (model.payload && !this.ui.has(model.rid)) {
        this.ui.set(model.rid, {
          selected: model.rid, filter: '', collapsed: new Set(this.collapsedByDefault()), expanded: new Set(),
          propFilter: '', hideEmpty: true, fieldMode: 'value', folds: new Map(),
          trail: [{ rid: model.rid }], trailOpen: false, peeks: new Set(), full: new Set(), folded: new Set(), calls: new Set(),
        });
      } else if (arrived && presented) {
        // The presenting template arrived later: fold its containers.
        for (const r of this.collapsedByDefault(presented)) this.state()?.collapsed.add(r);
      }
      if (fresh) this.renderedDetailFor = '';
    }
    if (prev?.rid !== model.rid) {
      this.filter.value = this.state()?.filter ?? '';
      this.setTreeOpen(false);
      this.closeEdits(false);
    }
    // Every staged edit was dropped (Discard): an open inline editor holds
    // text that is no longer staged. Close it the way Escape does, so the
    // stored value shows again.
    if (model.draft.generation !== this.draftGeneration) {
      if (this.draftGeneration >= 0) this.closeEdits(false);
      this.draftGeneration = model.draft.generation;
    }
    this.applyNav(model);
    this.shell.dataset.phase = model.phase;
    this.accessWasOn = this.accessOn();
    this.shell.dataset.access = this.accessWasOn ? 'on' : 'off';
    // Interaction lock while a save runs: nothing editable takes input.
    for (const region of [this.head, this.body]) {
      region.inert = model.saving;
      region.toggleAttribute('inert', model.saving);
    }
    if (model.saving) this.shell.setAttribute('aria-busy', 'true'); else this.shell.removeAttribute('aria-busy');
    this.renderHead();
    this.renderCrumbs();
    this.renderTools();
    this.renderBar();
    if (model.phase === 'fatal') {
      this.renderFatal();
      return;
    }
    this.fatal.textContent = '';
    this.renderTree();
    this.renderDetail();
  }

  /** Select a tree node (no network: the batch already holds it). A user
   *  selection starts a new trail (the tree path) and records a history
   *  step; `trail` keeps a given trail instead (history, references). */
  select(rid: string, focusTree = false, opts: { via?: 'key' | 'click' | 'nav'; trail?: TrailStep[] } = {}): void {
    const st = this.state();
    if (!st || !this.tree?.nodes[rid]) return;
    if (st.selected !== rid) this.closeEdits(true);
    const changed = st.selected !== rid;
    st.selected = rid;
    st.trail = opts.trail ?? this.treePath(rid);
    st.trailOpen = false;
    let p = this.tree.nodes[rid].parent;
    while (p) { st.collapsed.delete(p); p = this.tree.nodes[p]?.parent ?? null; }
    this.renderTree();
    this.renderDetail();
    this.renderTools();
    this.treeEl.querySelector<HTMLElement>(`[data-rid="${rid}"]`)?.scrollIntoView({ block: 'nearest' });
    if (focusTree) this.treeEl.focus({ preventScroll: true });
    else if (this.isNarrow()) this.setTreeOpen(false);
    if (changed && opts.via !== 'nav') this.handlers.selectionChanged?.(rid, st.trail, opts.via === 'key' ? 'key' : 'click');
  }

  /** Another surface (the Extended Code window's "Open") asks to show
   *  `rid`. Selected when the tree holds it; hung under `from` when the tree
   *  holds the calling object. False: the caller opens it as root. */
  revealFromOutside(rid: string, from?: { rid: string; line?: number }): boolean {
    const tree = this.tree;
    const cache = this.model?.refs;
    if (!tree || !this.state() || this.model?.phase !== 'ready' || !this.handlers.reveal) return false;
    const caller = from && tree.nodes[from.rid] ? from : undefined;
    const step: TrailStep = caller ? { rid, from: { rid: caller.rid, line: caller.line ?? 0 } } : { rid };
    if (tree.nodes[rid]) {
      this.handlers.reveal(rid, caller ? [...this.treePath(caller.rid), step] : this.treePath(rid), []);
      return true;
    }
    if (!caller || !cache) return false;
    void cache.requestCode(rid).then(() => {
      const obj = cache.code(rid)?.obj;
      if (!obj || !this.tree?.nodes[caller.rid]) { this.handlers.navigate(rid); return; }
      this.handlers.reveal?.(rid, [...this.treePath(caller.rid), step], [{ under: caller.rid, obj }]);
    });
    return true;
  }

  /** Root-to-node path of a tree node. */
  private treePath(rid: string): TrailStep[] {
    const out: TrailStep[] = [];
    let cur: string | null = rid;
    while (cur && this.tree?.nodes[cur]) {
      out.unshift({ rid: cur });
      cur = this.tree.nodes[cur].parent;
    }
    return out;
  }

  /** Apply a selection the controller asks for once (history step,
   *  followed reference). A node no longer in the tree falls back to the
   *  last trail step that is, then the root. */
  private applyNav(model: WindowModel): void {
    const nav = model.nav;
    const st = this.state();
    if (!nav || nav.seq === this.navSeq || !this.tree || !st || model.phase !== 'ready') return;
    this.navSeq = nav.seq;
    const trail = nav.trail ?? [];
    let sel = nav.sel ?? this.tree.rootRid;
    if (!this.tree.nodes[sel]) sel = [...trail].reverse().find(s => this.tree!.nodes[s.rid])?.rid ?? this.tree.rootRid;
    if (st.selected !== sel) this.closeEdits(true);
    st.selected = sel;
    st.trail = trail.length && trail[trail.length - 1].rid === sel ? trail : this.treePath(sel);
    st.trailOpen = false;
    let p = this.tree.nodes[sel].parent;
    while (p) { st.collapsed.delete(p); p = this.tree.nodes[p]?.parent ?? null; }
    queueMicrotask(() => this.treeEl.querySelector<HTMLElement>(`[data-rid="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }

  get selectedRid(): string | undefined {
    return this.state()?.selected;
  }

  /** True while an inline edit (identity input or code editor) is open. */
  get editing(): boolean {
    return !!this.idEdit || !!this.codeEdit || !!this.propEdit;
  }

  // ── state ──────────────────────────────────────────────────────

  private state(): RootUiState | undefined {
    return this.model ? this.ui.get(this.model.rid) : undefined;
  }

  /** The root's own structure plus, for a data object, its presenting
   *  template as a second top-level tree. Also computes divider labels. */
  private buildTree(payload: ObjectRootPayload, presented: ObjectRootPayload | null): StructureTree {
    let tree = assembleStructure(payload.root, payload.rows, payload.nodes);
    if (presented) tree = attachTree(tree, assembleStructure(presented.root, presented.rows, presented.nodes));
    const extra = this.model?.extra;
    if (extra?.rows.length) tree = attachRows(tree, extra.rows, extra.nodes);
    const leads: Record<string, string> = {};
    for (const n of Object.values(tree.nodes)) {
      if (!n.children.length) continue;
      Object.assign(leads, dividerLeads(n.children.map(c => {
        const o = tree.nodes[c].obj;
        return { rid: c, type: o?.type ?? '', name: o?.name ?? '' };
      })));
    }
    this.leads = leads;
    return tree;
  }

  /** Containers in a presenting template start folded. */
  private collapsedByDefault(p: ObjectRootPayload | null = this.model?.presented?.payload ?? null): string[] {
    if (!p) return [];
    return Object.values(p.nodes).filter(o => o.type === 'Container').map(o => o.rid);
  }

  /** Root is a data object: grouped tree, property list, no Template | Instance. */
  private isDataRoot(): boolean {
    return isDataObject(this.model?.payload?.root);
  }

  private isNarrow(): boolean {
    return this.shell.clientWidth > 0 && this.shell.clientWidth < NARROW_PX;
  }

  private setTreeOpen(open: boolean): void {
    const was = this.shell.dataset.tree === 'open';
    this.shell.dataset.tree = open ? 'open' : 'closed';
    const btn = this.head.querySelector<HTMLElement>('.ow-tree-btn');
    btn?.setAttribute('aria-expanded', String(open));
    if (!this.isNarrow() || open === was) return;
    // The overlay takes focus while open and hands it back to the control
    // that opened it when it closes.
    if (open) this.treeEl.focus({ preventScroll: true });
    else {
      const a = this.root.ownerDocument.activeElement;
      if (!a || a === this.root.ownerDocument.body || this.struct.contains(a)) btn?.focus({ preventScroll: true });
    }
  }

  private closeMenus(): boolean {
    let closed = false;
    for (const m of this.root.querySelectorAll<HTMLElement>('.ow-menu[data-open="true"]')) {
      m.dataset.open = 'false';
      m.parentElement?.querySelector('.ow-menu-btn')?.setAttribute('aria-expanded', 'false');
      closed = true;
    }
    return closed;
  }

  private nodeObj(rid: string): FullObject | null {
    return this.tree?.nodes[rid]?.obj ?? null;
  }

  private templateRid(): string | undefined {
    return templateRidOf(this.model?.payload?.root);
  }

  /** Object shown in the detail pane for a node: the root's template in
   *  Template mode, else the node's own read. */
  private shownObj(node: StructureNode): FullObject | null {
    if (node.rid === this.tree?.rootRid && this.model?.target === 'template') {
      const t = this.templateRid();
      return t ? this.model.templates[t]?.obj ?? null : null;
    }
    return node.obj;
  }

  private selectedObj(): FullObject | null {
    const st = this.state();
    const node = st && this.tree?.nodes[st.selected];
    return node ? this.shownObj(node) : null;
  }

  /** Name/type for any rid: tree reads first, then summaries. */
  private resolve(rid: string): { name: string; type: string; businessId: string; inTree: boolean; known: boolean } {
    const obj = this.nodeObj(rid);
    if (obj) return { name: obj.name, type: obj.type, businessId: obj.businessId, inTree: true, known: true };
    const s = this.model?.summaries[rid];
    if (s) return { name: s.name, type: s.type, businessId: s.businessId, inTree: !!this.tree?.nodes[rid], known: true };
    return { name: '', type: '', businessId: '', inTree: !!this.tree?.nodes[rid], known: false };
  }

  /** Text for a place meant for a name. Never a bare rid: a quiet
   *  placeholder while the name is being read, a neutral fallback when it
   *  could not be read. The rid stays in the RID chip of the detail pane. */
  private nameFor(rid: string): { text: string; state: 'known' | 'pending' | 'unknown' } {
    const r = this.resolve(rid);
    if (r.known) return { text: r.name || r.businessId || '(unnamed)', state: 'known' };
    if (this.model?.phase === 'loading' || this.model?.pendingNames?.has(rid)) return { text: '…', state: 'pending' };
    return { text: 'Name could not be read', state: 'unknown' };
  }

  /** The quiet failed-read form for a name that could not be read: the
   *  reason and Retry (this name only, where the window can do that). */
  private unreadName(withRetry = true, rid?: string): HTMLElement {
    const reason = (rid && this.model?.unreadable?.[rid]) || this.model?.summariesError || 'The name of this object could not be read.';
    const again = rid && this.handlers.retryNames ? () => this.handlers.retryNames!([rid]) : () => this.handlers.retry();
    return unreadValue(reason, withRetry ? again : undefined);
  }

  private copy(text: string, feedback: HTMLElement): void {
    // "Copied" only after the clipboard write succeeded; a failure shows
    // "Copy failed" (window.css .copy-failed).
    void copyWithFeedback(text, feedback, {
      okClass: 'copied',
      failClass: 'copy-failed',
      write: async t => (await this.handlers.copy(t)) !== false,
    });
  }

  private entry(rid: string, prop: string): DraftEntry | undefined {
    return this.model?.draft.get(rid, prop);
  }

  /** Current value of a property including a staged edit. */
  private current(obj: FullObject, prop: string): string {
    const e = this.entry(obj.rid, prop);
    return e?.kind === 'value' ? e.value : baseText(obj.props[prop]);
  }

  // ── head + crumbs + tools ─────────────────────────────────────

  private renderHead(): void {
    const m = this.model!;
    const root = m.payload?.root;
    const type = root?.type ?? m.hint?.type ?? '';
    const info = typeInfo(type);
    const name = root ? root.name : m.hint?.name ?? '';
    const tile = el('span', 'ow-tile', icon(info.icon));
    tile.style.background = `var(${info.fam})`;
    const bid = root ? root.businessId : m.hint?.businessId ?? '';
    const pending = !name && !bid && m.phase === 'loading';
    const nameEl = el('span', `ow-head-name${name ? '' : pending ? ' ow-pending' : ' unnamed'}`,
      name || bid || (pending ? 'Loading…' : '(unnamed)'));
    nameEl.title = name;
    const treeBtn = button('ow-tree-btn', undefined, () => this.setTreeOpen(this.shell.dataset.tree !== 'open'),
      icon('i-tree'), el('span', 'ow-tree-lbl', 'Structure'), icon('i-chev', 'ic-sm'));
    attrs(treeBtn, { 'aria-label': 'Structure', 'aria-expanded': String(this.shell.dataset.tree === 'open'), 'aria-controls': 'ow-struct' });
    const pin = m.phase === 'ready' && m.canPin && this.handlers.togglePin
      ? attrs(button(`ui-ibtn ow-pin${m.pinned ? ' on' : ''}`, m.pinned ? 'Unpin: remove from Browse’s Pinned list' : 'Pin: keep in Browse’s Pinned list',
        () => this.handlers.togglePin?.(), icon('i-pin')), { 'aria-pressed': String(!!m.pinned) })
      : '';
    const kids: Kids = [tile, nameEl, type ? el('span', 'ow-head-kind', typeLabel(type)) : '', pin, el('span', 'ow-grow'),
      m.phase === 'ready' ? treeBtn : ''];
    // A data object's template presents it; it is not a model template, so
    // Template | Instance does not apply.
    if (m.phase === 'ready' && this.templateRid() && !this.isDataRoot()) {
      const seg = attrs(el('div', 'ow-seg'), { role: 'group', 'aria-label': 'Edit target' });
      for (const [t, label] of [['template', 'Template'], ['instance', 'Instance']] as const) {
        const b = button('', undefined, () => { this.closeEdits(true); this.handlers.setTarget(t); }, label);
        b.setAttribute('aria-pressed', String(m.target === t));
        seg.append(b);
      }
      kids.push(seg);
    }
    this.head.replaceChildren(...kids.filter((k): k is Node | string => !!k));
  }

  private renderCrumbs(): void {
    const m = this.model!;
    const root = m.payload?.root;
    const kids: Node[] = [];
    const parentRid = root?.references.parent?.[0];
    if (parentRid) {
      const p = this.resolve(parentRid);
      const n = this.nameFor(parentRid);
      const a = button(`ow-crumb${n.state === 'known' ? '' : ' ow-pending'}`, undefined, () => this.handlers.navigate(parentRid),
        n.state === 'unknown' ? 'Parent' : n.text);
      a.title = p.type ? `${p.type} · open as root` : 'Open the parent as root';
      kids.push(a, el('span', 'sep', '/'));
    }
    const curName = root ? (root.name || root.businessId || '(unnamed)') : (m.hint?.name || m.hint?.businessId || '');
    const cur = el('span', `cur${curName ? '' : ' ow-pending'}`, curName || '…');
    kids.push(cur);
    this.crumbs.replaceChildren(...kids);
  }

  /** Compare menu and Access button act on the selected object. */
  private renderTools(): void {
    const m = this.model!;
    const obj = m.phase === 'ready' ? this.selectedObj() : null;
    this.renderAccessButton(obj);
    const menu = attrs(el('div', 'ow-menu ui-menu ow-menu-cmp'), { role: 'menu', 'data-open': 'false' });
    const btn = button('ui-tbtn ow-menu-btn-t', 'Compare', () => {
      const open = menu.dataset.open !== 'true';
      this.closeMenus();
      menu.dataset.open = String(open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector<HTMLElement>('button')?.focus();
    }, icon('i-compare'), el('span', '', 'Compare'));
    btn.classList.add('ow-menu-btn');
    attrs(btn, { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    btn.disabled = !obj;
    if (obj) {
      const items: Array<[string, 'pick' | 'template']> = [['Compare with…', 'pick']];
      if (templateRidOf(obj) && !isDataObject(obj)) items.unshift(['Compare with template', 'template']);
      for (const [label, kind] of items) {
        const item = button('', undefined, () => { this.closeMenus(); this.handlers.compare(kind, obj); }, el('span', 'ow-menu-one', label));
        item.setAttribute('role', 'menuitem');
        menu.append(item);
      }
    }
    this.compareWrap.replaceChildren(btn, menu);
    this.renderSearchMenu(obj);
  }

  /** Search menu: code under the selected object, where it is used in code, all code. */
  private renderSearchMenu(obj: FullObject | null): void {
    if (!this.handlers.searchCode && !this.handlers.findReferences) { this.searchWrap.replaceChildren(); return; }
    const menu = attrs(el('div', 'ow-menu ui-menu ow-menu-cmp ow-menu-search'), { role: 'menu', 'data-open': 'false' });
    const btn = button('ui-tbtn ow-menu-btn-t', 'Search code', () => {
      const open = menu.dataset.open !== 'true';
      this.closeMenus();
      menu.dataset.open = String(open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector<HTMLElement>('button')?.focus();
    }, icon('i-search'), el('span', '', 'Search'), icon('i-chev', 'ic-sm'));
    btn.classList.add('ow-menu-btn');
    attrs(btn, { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    const who = obj ? { rid: obj.rid, name: obj.name, type: obj.type, businessId: obj.businessId } : null;
    const items: Array<[string, string, () => void]> = [];
    if (who) {
      items.push(['i-search', 'Search code under this object', () => this.handlers.searchCode?.(who, true)]);
      items.push(['i-refs', 'Used in code', () => this.handlers.findReferences?.(who, who)]);
      if (this.handlers.atlas) items.push(['i-share', 'Show in Atlas', () => this.handlers.atlas?.(who)]);
    }
    items.push(['i-search', 'Search code everywhere…', () => this.handlers.searchCode?.(who, false)]);
    for (const [ic, label, go] of items) {
      const item = button('', undefined, () => { this.closeMenus(); go(); }, icon(ic), el('span', 'ow-menu-one', label));
      item.setAttribute('role', 'menuitem');
      menu.append(item);
    }
    this.searchWrap.replaceChildren(btn, menu);
  }

  // ── access mode ────────────────────────────────────────────────

  private accessOn(): boolean {
    return !!this.accessMode?.on && this.model?.phase === 'ready';
  }

  /** Access is a toggle of the window; for a Role or AccessPolicy it opens
   *  the Access workspace instead (roles and policies are edited there). */
  private renderAccessButton(obj: FullObject | null): void {
    const mode = this.accessMode;
    const on = !!mode?.on;
    const workspace = !on && !!obj && ROLE_ACCESS.has(obj.type);
    const reason = mode?.unavailableReason;
    const lbl = this.accessBtn.querySelector('.ow-acc-lbl')!;
    const state = this.accessBtn.querySelector<HTMLElement>('.ow-acc-state')!;
    // Unavailable stays focusable and hoverable, so its reason can be read.
    this.accessBtn.disabled = !obj;
    if (!workspace && reason) this.accessBtn.setAttribute('aria-disabled', 'true'); else this.accessBtn.removeAttribute('aria-disabled');
    lbl.textContent = workspace ? 'Open in Access' : 'Access';
    if (mode && !workspace) {
      this.accessBtn.setAttribute('aria-pressed', String(on));
      state.textContent = reason ? 'Unavailable' : on ? 'On' : 'Off';
      state.hidden = false;
      this.accessBtn.title = reason ? `Access test unavailable: ${reason}` : on ? 'Leave access mode' : 'Test access: what a user or role can do on each node';
      this.accessBtn.setAttribute('aria-label', reason ? `Access test unavailable: ${reason}` : 'Access mode');
    } else {
      this.accessBtn.removeAttribute('aria-pressed');
      state.textContent = '';
      state.hidden = true;
      this.accessBtn.title = workspace ? 'Open in Access: roles and policies' : 'Test access to this object';
      this.accessBtn.setAttribute('aria-label', workspace ? 'Open in Access' : 'Access');
    }
  }

  private onAccessButton(): void {
    const obj = this.selectedObj();
    const mode = this.accessMode;
    if (!obj) return;
    if (!mode || (!mode.on && ROLE_ACCESS.has(obj.type))) { this.handlers.access(obj); return; }
    if (mode.unavailableReason && !mode.on) return;
    // Pending inline edits go into the draft before the pane is swapped.
    if (!mode.on) this.closeEdits(true);
    mode.toggle();
    if (mode.on && !mode.subject) this.accessPane?.focusInput();
  }

  private onAccessChange(): void {
    if (!this.model) return;
    const on = this.accessOn();
    const turned = on !== this.accessWasOn;
    this.accessWasOn = on;
    this.shell.dataset.access = on ? 'on' : 'off';
    this.renderTools();
    if (this.model.phase !== 'ready') return;
    this.renderTree();
    if (on || turned) {
      if (turned) this.renderedDetailFor = '';
      this.renderDetail();
    }
  }

  private renderAccessPane(node: StructureNode): void {
    const pane = this.accessPane!;
    if (this.detail.firstElementChild !== pane.el || this.detail.childElementCount !== 1) {
      this.detail.replaceChildren(pane.el);
      this.detail.scrollTop = 0;
    }
    // Another node starts at the top, as the normal pane does.
    if (this.accessRenderedFor !== node.rid) this.detail.scrollTop = 0;
    this.accessRenderedFor = node.rid;
    this.renderedDetailFor = '';
    const obj = node.obj;
    const info = typeInfo(obj?.type ?? '');
    const lead = info.divider ? this.leads[node.rid] : undefined;
    const name = this.rowName(node) || lead || '';
    pane.render({ rid: node.rid, name, businessId: obj?.businessId ?? '', type: obj?.type ?? '', typeLabel: info.label || obj?.type || 'Object', iconId: info.icon, isRoot: node.rid === this.tree?.rootRid });
    this.accessMode!.select(node.rid);
  }

  // ── save bar ───────────────────────────────────────────────────

  private renderBar(): void {
    const m = this.model!;
    if (m.phase !== 'ready') { this.bar.hidden = true; return; }
    this.bar.hidden = false;
    const n = m.draft.count();
    const failed = m.draft.items().map(i => i.rid).filter((r, i, a) => a.indexOf(r) === i && m.draft.errorFor(r));
    const long = m.saving ? `Saving ${n} change${n === 1 ? '' : 's'}…` : n ? `${n} unsaved change${n === 1 ? '' : 's'}` : (m.saveNote ?? 'No unsaved changes');
    // The narrowest frame shows the short form ("1 unsaved") instead of cutting the long one.
    const shortText = !m.saving && n ? `${n} unsaved` : long;
    const msg = el('span', `ow-bar-msg${n ? '' : ' clean'}`, attrs(el('i', 'ow-dia'), { 'aria-hidden': 'true' }),
      el('span', 'ow-bar-txt ow-bar-long', long), el('span', 'ow-bar-txt ow-bar-short', shortText));
    const kids: Kids = [msg];
    if (n && !m.saving && failed.length) {
      const names = failed.map(r => this.objName(r)).join(', ');
      kids.push(attrs(el('span', 'ow-bar-err', `Not saved: ${names}`), { title: failed.map(r => `${this.objName(r)}: ${m.draft.errorFor(r)}`).join('\n') }));
    } else if (n === 1 && !m.saving) {
      const it = m.draft.items()[0];
      kids.push(el('span', 'ow-bar-where', `${this.labelOf(it.rid, it.prop)} on ${this.objName(it.rid)}`));
    }
    // BMP does not re-render after an out-of-band save: offer the reload.
    if (!n && !m.saving && (m.saveNote?.startsWith('Saved') || m.saveNote === unknownOutcomeLine('saved')) && this.handlers.reloadPage) {
      kids.push(button('ow-link', 'Reload the BMP page to show the saved values', () => this.handlers.reloadPage?.(), icon('i-retry', 'ic-sm'), 'Reload page'));
    }
    const discard = button('ui-btn ghost', undefined, () => this.handlers.discard(), 'Discard');
    const save = button('ui-btn primary', undefined, () => this.requestSave(), m.saving ? 'Saving…' : 'Review and save');
    save.title = withShortcut('Review and save the unsaved changes', 'object.save');
    save.setAttribute('aria-keyshortcuts', ariaKeyShortcuts('object.save'));
    discard.disabled = !n || m.saving;
    save.disabled = !n || m.saving;
    kids.push(el('span', 'ow-grow'), discard, save);
    this.bar.replaceChildren(...kids.filter((k): k is Node | string => !!k));
  }

  private objName(rid: string): string {
    const t = this.templateRid();
    if (t === rid) {
      const o = this.model?.templates[rid]?.obj;
      return `${o?.name || 'Template'} (template)`;
    }
    const n = this.nameFor(rid);
    return n.state === 'pending' ? 'object' : n.text;
  }

  private labelOf(rid: string, prop: string): string {
    const obj = this.nodeObj(rid) ?? this.model?.templates[rid]?.obj;
    return EXPRESSIONS[prop]?.label ?? propLabel(obj ?? { type: '' }, prop, this.model?.labels, this.model?.summaries);
  }

  // ── fatal ──────────────────────────────────────────────────────

  private renderFatal(): void {
    const m = this.model!;
    this.treeEl.textContent = '';
    this.treeNote.textContent = '';
    this.detail.textContent = '';
    const ridLine = el('div', 'ow-fatal-rid', 'RID ', el('span', 'ow-sel', m.rid));
    // The shared failure words (connection-copy): one sentence, what to do, Retry, the raw detail
    // behind "Details". Never a raw transport error as the message.
    const copy = describeFailure({ error: m.error || 'The object read failed.' });
    this.fatal.replaceChildren(el('div', 'ow-fatal-box',
      el('h2', '', 'This object could not be opened'),
      failureBlock(copy, () => this.handlers.retry()),
      ridLine));
  }

  // ── tree ───────────────────────────────────────────────────────

  private visible(): Array<{ node: StructureNode; depth: number; top: number }> {
    const tree = this.tree, st = this.state();
    if (!tree || !st) return [];
    const q = st.filter.trim().toLowerCase();
    const matches = (n: StructureNode) => this.rowHay(n).includes(q);
    const memo = new Map<string, boolean>();
    const hasMatch = (n: StructureNode): boolean => {
      const c = memo.get(n.rid);
      if (c != null) return c;
      const r = matches(n) || n.children.some(k => hasMatch(tree.nodes[k]));
      memo.set(n.rid, r);
      return r;
    };
    const out: Array<{ node: StructureNode; depth: number; top: number }> = [];
    const walk = (rid: string, depth: number, top: number) => {
      const n = tree.nodes[rid];
      if (q && !hasMatch(n)) return;
      out.push({ node: n, depth, top });
      if (q || !st.collapsed.has(rid)) for (const k of n.children) walk(k, depth + 1, top);
    };
    tree.tops.forEach((rid, i) => walk(rid, 0, i));
    return out;
  }

  private rowName(n: StructureNode): string {
    return n.obj?.name ?? this.model?.summaries[n.rid]?.name ?? '';
  }

  private rowKey(n: StructureNode): string {
    const o = n.obj;
    if (!o) return '';
    return o.props.key?.text || o.businessId;
  }

  private rowHay(n: StructureNode): string {
    const type = n.obj?.type ?? '';
    return `${this.leads[n.rid] ?? ''} ${this.rowName(n)} ${this.rowKey(n)} ${typeInfo(type).label} ${type}`.toLowerCase();
  }

  /** Draft entries and save error of a tree row (the root row carries its
   *  template's edits too). */
  private rowDraft(rid: string): { count: number; error?: string } {
    const d = this.model!.draft;
    let count = d.countFor(rid);
    let error = d.errorFor(rid);
    const t = this.templateRid();
    if (rid === this.tree?.rootRid && t && !this.isDataRoot()) {
      count += d.countFor(t);
      error = error ?? d.errorFor(t);
    }
    return { count, error };
  }

  private renderTree(): void {
    const m = this.model, st = this.state();
    if (!m) return;
    if (m.phase === 'loading' || !this.tree || !st) {
      this.treeEl.replaceChildren(el('div', 'ow-quiet ow-pad', 'Loading structure…'));
      this.treeNote.textContent = '';
      return;
    }
    const rootInfo = typeInfo(this.tree.nodes[this.tree.rootRid].obj?.type ?? '');
    const slots = rootInfo.slots;
    const q = st.filter.trim().toLowerCase();
    const acc = this.accessOn();
    const headSlots = acc
      ? attrs(el('span', 'ow-slots', el('span', 'd'), ...ACCESS_ACTIONS.map(a => attrs(el('span', 'm', a.letter), { title: a.label }))),
        { title: ACCESS_ACTIONS.map(a => `${a.letter} = ${a.label}`).join(', ') })
      : attrs(el('span', 'ow-slots', el('span', 'd'), ...slots.map(s => attrs(el('span', 'm', s.letter), { title: s.name }))),
        { title: slots.map(s => `${s.letter} = ${s.name}`).join(', ') || undefined });
    const headRow = el('div', 'ow-tree-head', el('span', '', 'Structure'), headSlots);
    const list = this.visible();
    // Before the rows: newer data drops older results, so no stale cell is drawn.
    if (acc) this.accessMode!.setNodes(list.map(it => it.node.rid), this.dataGen);
    if (this.isDataRoot()) {
      // Two labelled groups: the object itself, then what presents it.
      const rows: Node[] = [headRow, el('div', 'ow-tree-grp', 'Object')];
      rows.push(...list.filter(it => it.top === 0).map(({ node, depth }) => this.treeRow(node, depth, q, slots)));
      rows.push(el('div', 'ow-tree-grp next', 'Presented by'));
      const shown = list.filter(it => it.top > 0);
      if (shown.length) rows.push(...shown.map(({ node, depth }) => this.treeRow(node, depth, q, slots)));
      else rows.push(this.presentedNote(q));
      this.treeEl.replaceChildren(...rows);
    } else if (!list.length) {
      this.treeEl.replaceChildren(headRow, el('div', 'ow-quiet ow-pad', `No structure matches “${st.filter}”.`));
    } else {
      this.treeEl.replaceChildren(headRow, ...list.map(({ node, depth }) => this.treeRow(node, depth, q, slots)));
    }
    if (list.some(it => it.node.rid === st.selected)) this.treeEl.setAttribute('aria-activedescendant', `ow-r-${st.selected}`);
    else this.treeEl.removeAttribute('aria-activedescendant');
    const p = m.payload;
    const note = p?.structureError ? 'Structure could not be listed.'
      : p?.structureTruncatedAt ? `Showing the first ${p.structureTruncatedAt} nodes of the structure.`
      : p?.rootFallback ?? '';
    const legend = Object.values(this.tree.nodes).some(n => n.referenced)
      ? el('div', 'ow-legend', icon('i-link'), el('span', '', 'Link icon: referenced, not a child.')) : '';
    // Rows without their facts say why, with Retry (never a silent "(not read)").
    const facts = p?.rowFactsError ?? m.presented?.payload?.rowFactsError;
    const factsLine = facts ? attrs(el('div', 'ow-tree-facts', el('span', '', rowFactsNote(facts)),
      button('ow-link', 'Read the structure again', () => this.handlers.retry(), icon('i-retry', 'ic-sm'), 'Retry')), { role: 'alert', title: facts.message }) : '';
    this.treeNote.replaceChildren(...[note ? el('div', '', note) : '', factsLine, legend].filter((k): k is HTMLElement => !!k));
    this.treeNote.title = p?.structureError ?? '';
    // A visible row whose type follows a reference (a button of type action)
    // lists its target now: after the paint, never as part of the open.
    if (this.handlers.followRefs && !q) {
      const items = list.flatMap(({ node }) => {
        const rule = followRule(node.obj);
        return rule && !node.children.length ? [{ rid: node.rid, via: rule.via, depth: rule.depth }] : [];
      });
      // After the paint and after the open's own reads are queued.
      if (items.length) window.setTimeout(() => this.handlers.followRefs?.(items), 0);
    }
  }

  /** One quiet line in the "Presented by" group when it holds no rows. */
  private presentedNote(q: string): HTMLElement {
    const p = this.model?.presented;
    let text = 'Loading template…';
    if (p?.none) text = 'No template presents this object.';
    else if (p?.error) text = 'The template could not be loaded.';
    else if (p?.payload && q) text = 'No match.';
    const note = el('div', 'ow-quiet ow-tree-msg', text);
    if (p?.error) note.title = p.error;
    return note;
  }

  private treeRow(n: StructureNode, depth: number, q: string, slots: TypeInfo['slots']): HTMLElement {
    const st = this.state()!;
    const obj = n.obj;
    const info = typeInfo(obj?.type ?? '');
    const selected = st.selected === n.rid;
    const name = this.rowName(n);
    const key = this.rowKey(n);
    const lead = info.divider ? this.leads[n.rid] : undefined;
    const chev = el('span', `chev${n.children.length && st.collapsed.has(n.rid) && !q ? ' closed' : ''}`);
    if (n.children.length) {
      chev.append(icon('i-chev'));
      chev.addEventListener('click', e => {
        e.stopPropagation();
        if (st.collapsed.has(n.rid)) st.collapsed.delete(n.rid); else st.collapsed.add(n.rid);
        this.renderTree();
      });
    }
    let lbl: HTMLElement;
    if (lead) {
      // Divider: what it starts ("Page 2"), then its own name, quietly.
      const rest = info.divider === 'heading' ? '' : name;
      lbl = el('span', 'ow-dv', el('span', 'ow-dv-lead', ...mark(lead, q)), rest ? el('span', 'ow-dv-name', ...mark(rest, q)) : '');
    } else {
      const nm = el('span', `nm${name ? '' : ' unnamed'}`, ...mark(name || (obj ? '(unnamed)' : '(not read)'), q));
      const use = obj?.type === 'InputSet' ? this.viewUse(n.rid) : '';
      // The use note goes before the key and never wraps away: the name shortens for it.
      lbl = el('span', use ? 'lbl has-use' : 'lbl', nm, use ? el('span', 'ow-use', use) : '', key ? el('span', 'ky ui-id', ...mark(key, q)) : '');
    }
    const acc = this.accessOn();
    const slotEls = acc ? accessCells(this.accessMode!, n.rid) : slots.map(s => {
      if (obj?.factsUnknown) return attrs(el('span', 'm unk', '?'), { title: `${s.name}: could not be read` });
      const on = obj ? s.test(obj) : null;
      const m = el('span', `m${on ? ' on' : ''}`, on === null ? '' : s.letter);
      if (on !== null) m.title = `${s.name}: ${on ? 'set' : 'empty'}`;
      return m;
    });
    const draft = this.rowDraft(n.rid);
    const d = el('span', 'd');
    if (draft.error) d.append(attrs(el('span', 'ow-err-mark', '!'), { title: `Not saved: ${draft.error}` }), el('span', 'ow-sr', 'Save failed'));
    else if (draft.count) d.append(dia(`${draft.count} unsaved change${draft.count === 1 ? '' : 's'}`));
    if (n.referenced) lbl.append(el('span', 'ow-sr', ', referenced, not a child'));
    const row = attrs(el('div', `ow-row${lead ? ' ow-div' : ''}${draft.count ? ' dirty' : ''}${n.referenced ? ' ref' : ''}`, el('span', 'bar'), chev,
      icon(n.referenced ? 'i-link' : info.icon, 'kind'), lbl, el('span', 'ow-slots', d, ...slotEls)), {
      role: 'treeitem', id: `ow-r-${n.rid}`, 'data-rid': n.rid, 'aria-level': String(depth + 1), 'aria-selected': String(selected),
      title: [lead && info.divider !== 'heading' ? lead : '', name, key, info.label || obj?.type, n.referenced ? 'referenced, not a child' : '', draft.count ? `${draft.count} unsaved` : ''].filter(Boolean).join(' · ') || '(not read)',
      ...(n.children.length ? { 'aria-expanded': String(!st.collapsed.has(n.rid) || !!q) } : {}),
    });
    if (acc) row.setAttribute('aria-label', accessRowLabel(this.accessMode!, n.rid, lead && !name ? lead : name || (obj ? '(unnamed)' : '(not read)')));
    row.style.setProperty('--d', String(depth));
    // Narrowness is checked at click time: the frame may have been resized
    // since this row was rendered.
    row.addEventListener('click', () => { this.select(n.rid, true); if (this.isNarrow()) this.setTreeOpen(false); });
    return row;
  }

  private onTreeKey(e: KeyboardEvent): void {
    const st = this.state();
    const list = this.visible();
    if (!st || !list.length || !this.tree) return;
    const idx = list.findIndex(it => it.node.rid === st.selected);
    const cur = this.tree.nodes[st.selected];
    const go = (i: number) => this.select(list[Math.max(0, Math.min(list.length - 1, i))].node.rid, true, { via: 'key' });
    switch (e.key) {
      case 'ArrowDown': go(idx + 1); break;
      case 'ArrowUp': go(idx - 1); break;
      case 'Home': go(0); break;
      case 'End': go(list.length - 1); break;
      case 'ArrowRight':
        if (cur?.children.length && st.collapsed.has(cur.rid)) { st.collapsed.delete(cur.rid); this.renderTree(); }
        else if (idx >= 0 && idx < list.length - 1 && list[idx + 1].depth > list[idx].depth) go(idx + 1);
        break;
      case 'ArrowLeft':
        if (cur?.children.length && !st.collapsed.has(cur.rid) && !st.filter) { st.collapsed.add(cur.rid); this.renderTree(); }
        else if (cur?.parent) this.select(cur.parent, true, { via: 'key' });
        break;
      case 'Enter':
        if (this.isNarrow()) this.setTreeOpen(false);
        this.detail.focus?.();
        break;
      default: return;
    }
    e.preventDefault();
  }

  // ── detail ─────────────────────────────────────────────────────

  private renderDetail(): void {
    const m = this.model!;
    const st = this.state();
    if (m.phase === 'loading' || !this.tree || !st) {
      this.detail.replaceChildren(el('div', 'ow-quiet ow-pad-y', 'Loading…'));
      this.renderedDetailFor = '';
      return;
    }
    const node = this.tree.nodes[st.selected] ?? this.tree.nodes[this.tree.rootRid];
    const obj = this.shownObj(node);
    if (this.accessOn()) {
      this.renderAccessPane(node);
      return;
    }
    const renderKey = `${node.rid}:${obj?.rid ?? ''}`;
    const keepScroll = this.renderedDetailFor === renderKey;
    const top = this.detail.scrollTop;
    // Restore focus to the same control after the re-render.
    const active = this.root.ownerDocument.activeElement as HTMLElement | null;
    const focusKey = active && this.detail.contains(active) ? active.closest<HTMLElement>('[data-fk]')?.dataset.fk : undefined;
    const editorFocused = !!this.codeEdit?.handle && !!active && this.codeEdit.handle.el.contains(active);

    this.renderTrail(st);
    const parts: Node[] = [this.trailEl, this.subHeader(node, obj)];
    const isTemplate = node.rid === this.tree.rootRid && m.target === 'template';
    if (obj?.lite) {
      // The row's facts only: the node is read in full now (once).
      parts.push(el('div', 'ow-quiet ow-pad-y', 'Loading…'));
      this.detail.replaceChildren(...parts);
      this.renderedDetailFor = '';
      this.handlers.selected?.(obj);
      return;
    }
    if (!obj) {
      const tpl = isTemplate ? m.templates[this.templateRid() ?? ''] : undefined;
      const text = isTemplate ? (tpl?.error ? 'The template could not be read.' : 'Loading template…') : 'This node could not be read.';
      parts.push(attrs(el('div', 'ow-quiet ow-pad-y', text), { title: isTemplate ? tpl?.error : m.payload?.nodeErrors?.[node.rid] }));
    } else {
      const info = typeInfo(obj.type);
      const data = isDataObject(obj);
      if (info.lead === 'mapping') {
        const mapped = this.mappedProperty(obj, node);
        if (mapped) parts.push(mapped);
      }
      const behaviour = this.behaviour(obj, info, node);
      const props = data ? null : this.curated(obj, info);
      const calls = this.callsSection(obj, info);
      for (const part of info.settingsFirst ? [props, behaviour, calls] : [behaviour, calls, props]) if (part) parts.push(part);
      const layout = this.layoutGroup(obj, info);
      if (layout) parts.push(layout);
      parts.push(data ? this.propList(obj, node) : this.allProperties(obj, info));
    }
    const apps = obj && !isTemplate ? this.applicationsSection(obj) : null;
    if (apps) parts.push(apps);
    // A data object's Relations are one of its property sections.
    const rel = isTemplate || (obj && isDataObject(obj)) ? null : this.relations(node);
    if (rel) parts.push(rel);
    this.detail.replaceChildren(...parts);
    this.detail.scrollTop = keepScroll ? top : 0;
    if (!keepScroll) this.handlers.selected?.(obj);
    this.renderedDetailFor = renderKey;
    if (editorFocused) this.codeEdit?.handle?.focus();
    else if (focusKey) {
      // A closed in-row editor (`<key>:ed`) hands focus back to its value box.
      const back = (k: string) => this.detail.querySelector<HTMLElement>(`[data-fk="${CSS.escape(k)}"]`);
      (back(focusKey) ?? (focusKey.endsWith(':ed') ? back(focusKey.slice(0, -3)) : null))?.focus({ preventScroll: true });
    }
    // Every reference drawn in this render is resolved in ONE request.
    this.refUi.flush();
    this.trailFit?.();
  }

  /** "Calls": the objects the selected object's code refers to. */
  private callsSection(obj: FullObject, info: TypeInfo): HTMLElement | null {
    const props = codePropsFor(info, obj).filter(p => obj.props[p]?.kind === 'code' && this.current(obj, p).trim());
    if (!props.length || !this.model?.refs) return null;
    return this.refUi.calls(obj, props, p => this.current(obj, p));
  }

  // ── trail ──────────────────────────────────────────────────────

  /** Name of a trail or history step; names seen once are remembered, so
   *  steps of an earlier root keep theirs. */
  private stepName(rid: string): string {
    const n = this.nameFor(rid);
    const code = this.model?.refs?.code(rid)?.obj;
    const name = n.state === 'known' ? n.text : code ? (code.name || code.businessId || '(unnamed)') : this.names.get(rid);
    if (name) { this.names.set(rid, name); return name; }
    return n.state === 'pending' ? '…' : 'previous object';
  }

  private stepIcon(rid: string): string {
    const type = this.resolve(rid).type || this.model?.refs?.code(rid)?.obj?.type || '';
    return typeInfo(type).icon;
  }

  /** The window's Back/Forward name the real target of the step. */
  private historyTitles(): void {
    for (const [b, dir] of [[this.back, -1], [this.fwd, 1]] as const) {
      const target = this.handlers.neighbour?.(dir);
      const keys = shortcutLabels(dir < 0 ? 'object.back' : 'object.forward').join(' or ');
      const origin = dir < 0 && !target ? this.model?.origin : undefined;
      const label = origin ? `Back to ${origin.label} (${keys})`
        : target && !b.disabled ? `${dir < 0 ? 'Back to' : 'Forward to'} ${this.stepName(target)} (${keys})` : `${dir < 0 ? 'Back' : 'Forward'} (${keys})`;
      b.title = label;
      b.setAttribute('aria-label', label);
    }
  }

  /** The path that led to the selection, one clickable step each. When
   *  space is short, middle steps fold into "…" (a menu listing them) before
   *  names are cut; the first and the current step keep their names. */
  private renderTrail(st: RootUiState): void {
    this.renderTrailSteps(st);
    const origin = this.model?.origin;
    const ol = this.trailEl.querySelector('ol');
    if (!origin || !ol) return;
    // The search that opened the window comes first; it returns there.
    const a = button('ow-trail-a first origin', undefined, () => this.handlers.toOrigin?.(origin), icon(origin.mode === 'refs' ? 'i-refs' : 'i-search', 'ic-sm'), el('span', '', origin.label));
    a.title = `${origin.label}: back to the results`;
    a.dataset.fk = 'trail:origin';
    ol.querySelector('.ow-trail-a.first')?.classList.remove('first');
    ol.prepend(el('li', '', a), attrs(el('li', 'sep', icon('i-right', 'ic-sm')), { 'aria-hidden': 'true' }));
  }

  private renderTrailSteps(st: RootUiState): void {
    const steps = st.trail.length ? st.trail : [{ rid: st.selected }];
    const go = (s: TrailStep, i: number) => {
      if (i === steps.length - 1 || !this.tree?.nodes[s.rid]) return;
      this.select(s.rid, false, { via: 'click', trail: steps.slice(0, i + 1) });
    };
    const title = (s: TrailStep) => s.from
      ? `${this.stepName(s.rid)} · reached from ${this.stepName(s.from.rid)}, ${this.fromWhere(s.from)}` : this.stepName(s.rid);
    const item = (s: TrailStep, i: number) => {
      const cur = i === steps.length - 1;
      const inTree = !!this.tree?.nodes[s.rid];
      const f = this.model?.focus;
      const at = cur && f && f.rid === s.rid ? ` · ${f.prop} · line ${f.line}` : '';
      const a = button(`ow-trail-a${cur ? ' cur' : ''}${i === 0 ? ' first' : ''}`, undefined, () => go(s, i),
        icon(this.stepIcon(s.rid), 'ic-sm'), el('span', '', `${this.stepName(s.rid)}${at}`));
      a.title = title(s);
      a.dataset.fk = `trail:${i}`;
      if (cur) a.setAttribute('aria-current', 'location');
      else if (!inTree) a.setAttribute('aria-disabled', 'true');
      return el('li', '', a);
    };
    const sep = () => attrs(el('li', 'sep', icon('i-right', 'ic-sm')), { 'aria-hidden': 'true' });
    const build = (fold: number) => {
      // `fold` middle steps (from the second one on) go into the "…" menu.
      const ol = el('ol', '');
      steps.forEach((s, i) => {
        if (fold && i >= 1 && i <= fold) {
          if (i !== 1) return;
          const hidden = steps.slice(1, fold + 1);
          const menu = attrs(el('div', 'ow-menu ui-menu ow-trail-menu'), { role: 'menu', 'data-open': 'false' });
          const more = button('ow-trail-a ow-menu-btn', `${hidden.length} more ${hidden.length === 1 ? 'step' : 'steps'}`, () => {
            const open = menu.dataset.open !== 'true';
            this.closeMenus();
            menu.dataset.open = String(open);
            more.setAttribute('aria-expanded', String(open));
            if (open) menu.querySelector<HTMLElement>('button')?.focus();
          }, icon('i-dots', 'ic-sm'));
          attrs(more, { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
          hidden.forEach((h, k) => {
            const mi = button('', undefined, () => { this.closeMenus(); go(h, k + 1); }, icon(this.stepIcon(h.rid), 'ic-sm'), el('span', '', this.stepName(h.rid)));
            mi.setAttribute('role', 'menuitem');
            mi.title = title(h);
            menu.append(mi);
          });
          ol.append(sep(), el('li', 'ow-menu-wrap', more, menu));
          return;
        }
        if (i > 0) ol.append(sep());
        ol.append(item(s, i));
      });
      return ol;
    };
    let fold = 0;
    let ol = build(0);
    this.trailEl.replaceChildren(ol);
    this.trailFit = () => {
      if (!ol.isConnected) return;
      // Measure with names at full width: fold before any name is cut.
      this.trailEl.classList.add('measure');
      while (ol.scrollWidth > ol.clientWidth + 1 && fold < steps.length - 2) {
        fold++;
        const next = build(fold);
        ol.replaceWith(next);
        ol = next;
      }
      this.trailEl.classList.remove('measure');
    };
  }

  /** Folds the trail once it is laid out (after the detail pane render). */
  private trailFit: (() => void) | null = null;

  /** "Expression line 4" of a reached-from step. */
  private fromWhere(from: NonNullable<TrailStep['from']>): string {
    const prop = from.prop ? (EXPRESSIONS[from.prop]?.label ?? splitWords(from.prop)).toLowerCase() : '';
    return `${prop ? `${prop} ` : ''}line ${from.line}`;
  }

  // ── following references ───────────────────────────────────────

  /** Ctrl/Cmd+Click or the open control on a reference: go to the target in
   *  this window. In the tree: select it. Not in the tree: hang it (and the
   *  peeked objects that led to it) under the calling node as referenced
   *  rows, then select it. The trail grows by those steps. */
  private openRef(target: RefTarget, line: number, ctx: RefCtx): void {
    const st = this.state();
    const cache = this.model?.refs;
    if (!st || !cache || !this.tree) return;
    const start = st.selected;
    const hops = [...ctx.chain.map(c => ({ rid: c.rid, line: c.line, prop: c.prop })), { rid: target.rid, line, prop: ctx.prop }];
    const go = () => {
      const tree = this.tree;
      if (!tree || this.state() !== st) return;
      const trail: TrailStep[] = [...st.trail];
      const attach: Array<{ under: string; obj: FullObject }> = [];
      let under = start;
      for (const h of hops) {
        trail.push({ rid: h.rid, from: { rid: under, line: h.line, prop: h.prop } });
        if (!tree.nodes[h.rid]) {
          const obj = cache.code(h.rid)?.obj;
          if (!obj) return;
          attach.push({ under, obj });
        }
        under = h.rid;
      }
      this.closeEdits(true);
      this.handlers.reveal?.(target.rid, trail, attach, hops.length);
    };
    const missing = hops.filter(h => !this.tree!.nodes[h.rid] && !cache.code(h.rid)?.obj);
    if (!missing.length) { go(); return; }
    void Promise.all(missing.map(h => cache.requestCode(h.rid, h.rid === target.rid ? target.codeProp : undefined))).then(go);
  }

  private subHeader(node: StructureNode, obj: FullObject | null): HTMLElement {
    const info = typeInfo(obj?.type ?? node.obj?.type ?? '');
    const q = (obj && info.qualifier ? info.qualifier(obj) : '')
      || (info.divider && info.divider !== 'heading' ? this.leads[node.rid] ?? '' : '');
    const isRoot = node.rid === this.tree?.rootRid;
    const isTemplate = isRoot && this.model?.target === 'template';
    const kind = el('div', 'ow-sub-kind', dot(info.fam), el('span', '', typeLabel(obj?.type ?? '')),
      q ? el('span', 'mid', '·') : '', q ? el('code', '', q) : '',
      isTemplate ? el('span', 'ow-tag', 'Template') : '', el('span', 'ow-grow'),
      isRoot ? '' : attrs(button('ow-link plain', undefined, () => this.handlers.navigate(node.rid, this.state()?.trail), icon('i-ownwin', 'ic-sm'), 'Open as root'),
        { title: 'Open this object as the window root. Back returns here.' }));
    const parts: Node[] = [kind, this.nameLine(node, obj)];
    const st = this.state();
    const last = st?.trail[st.trail.length - 1];
    if (st && last?.rid === node.rid && last.from) {
      const from = last.from;
      const i = st.trail.length - 2;
      const back = button('ow-link plain', undefined, () => {
        if (this.tree?.nodes[from.rid]) this.select(from.rid, false, { via: 'click', trail: st.trail.slice(0, Math.max(1, i + 1)) });
      }, this.stepName(from.rid));
      back.setAttribute('aria-label', `Reached from ${this.stepName(from.rid)}, ${this.fromWhere(from)}. Go there`);
      parts.push(el('div', 'ow-from', 'Reached from ', back, `, ${this.fromWhere(from)}`));
    }
    const ids = el('div', 'ow-sub-ids');
    if (obj) {
      // A linked instance whose ID differs from its template's: both IDs.
      const tplRid = isTemplate ? undefined : templateRidOf(obj);
      const tplBid = tplRid ? this.resolve(tplRid).businessId : '';
      const both = !!tplBid && tplBid !== this.current(obj, 'id');
      if (both) ids.append(this.chip('Template ID', tplBid, { businessId: tplBid, rid: tplRid }));
      const idChip = this.idChip(obj, both ? 'Instance ID' : 'ID');
      if (idChip) ids.append(idChip);
      ids.append(this.chip('RID', obj.rid, { rid: obj.rid }), this.copyMenu(obj.businessId, obj.rid));
    } else {
      ids.append(this.chip('RID', node.rid, { rid: node.rid }));
    }
    parts.push(ids);
    const err = obj ? this.model?.draft.errorFor(obj.rid) : undefined;
    if (err) parts.push(attrs(el('div', 'ow-save-err', attrs(el('span', 'ow-err-mark', '!'), { 'aria-hidden': 'true' }), el('span', '', `Not saved: ${err}`)), { role: 'alert' }));
    return el('div', 'ow-sub', ...parts);
  }

  private nameLine(node: StructureNode, obj: FullObject | null): HTMLElement {
    const line = el('div', 'ow-sub-name');
    if (!obj) {
      const name = this.rowName(node);
      line.append(el('h2', name ? 'ow-sel' : 'ow-sel unnamed', name || '(unnamed)'));
      return line;
    }
    const edit = this.idEdit?.rid === obj.rid && this.idEdit.prop === 'name' ? this.idEdit : null;
    if (edit) {
      line.append(this.identityInput(obj, 'name', edit.value, 'ow-name-input'));
      if (edit.error) line.append(el('span', 'ow-field-err', edit.error));
      return line;
    }
    const value = this.current(obj, 'name');
    line.append(el('h2', value ? 'ow-sel' : 'ow-sel unnamed', value || '(unnamed)'));
    if (this.editable(obj, 'name')) {
      line.append(button('ui-ibtn', 'Rename', () => this.startIdentity(obj, 'name'), icon('i-pencil')));
    }
    const e = this.entry(obj.rid, 'name');
    if (e) line.append(this.unsavedTag(obj.rid, 'name', `was ${e.base || '(unnamed)'}`));
    return line;
  }

  /** Business ID chip; its pencil is the only way to edit the ID. */
  private idChip(obj: FullObject, label = 'ID'): HTMLElement | null {
    const editable = !!this.editable(obj, 'id');
    const edit = this.idEdit?.rid === obj.rid && this.idEdit.prop === 'id' ? this.idEdit : null;
    if (edit) {
      const wrap = el('span', 'ow-id-edit', el('span', 'ow-chip-k', label), this.identityInput(obj, 'id', edit.value, 'ow-id-input'));
      return edit.error ? el('span', 'ow-id-edit-wrap', wrap, el('span', 'ow-field-err', edit.error)) : wrap;
    }
    const value = this.current(obj, 'id');
    if (!value && !editable) return null;
    const chip = this.chip(label, value, { businessId: value, rid: obj.rid });
    if (editable) {
      // The pencil shows only while the chip is hovered or holds focus.
      chip.querySelector('.ow-chip-acts')!.prepend(button('ow-chip-btn ow-chip-edit', 'Edit ID', () => this.startIdentity(obj, 'id'), icon('i-pencil')));
    }
    const e = this.entry(obj.rid, 'id');
    if (!e) return chip;
    chip.classList.add('dirty');
    return el('span', 'ow-chip-row', chip, this.unsavedTag(obj.rid, 'id', `was ${e.base || '(none)'}`));
  }

  private startIdentity(obj: FullObject, prop: 'name' | 'id'): void {
    this.closeEdits(true);
    this.idEdit = { rid: obj.rid, prop, value: this.current(obj, prop) };
    this.renderDetail();
    const input = this.detail.querySelector<HTMLInputElement>(prop === 'name' ? '.ow-name-input' : '.ow-id-input');
    input?.focus();
    input?.select();
  }

  private identityInput(obj: FullObject, prop: 'name' | 'id', value: string, cls: string): HTMLInputElement {
    const label = prop === 'name' ? 'Name' : 'ID';
    const input = attrs(el('input', `ow-input ${cls}`) as HTMLInputElement, { type: 'text', 'aria-label': label, autocomplete: 'off', spellcheck: 'false' });
    input.value = value;
    let done = false;
    const commit = () => {
      if (done || !this.idEdit) return;
      const next = input.value.trim();
      const error = prop === 'id' ? identityBusinessIdError(next) : next ? null : 'Name is required.';
      if (error) {
        this.idEdit = { ...this.idEdit, value: input.value, error };
        this.renderDetail();
        const again = this.detail.querySelector<HTMLInputElement>(`.${cls}`);
        again?.focus();
        return;
      }
      done = true;
      this.idEdit = null;
      this.handlers.edit(obj.rid, prop, next, baseText(obj.props[prop]));
      this.renderDetail();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') {
        // Cancel the edit; the window stays open.
        e.preventDefault();
        e.stopPropagation();
        done = true;
        this.idEdit = null;
        this.renderDetail();
      }
    });
    input.addEventListener('blur', () => { if (!done && input.isConnected) commit(); });
    return input;
  }

  /** "Unsaved" tag with its own revert. */
  private unsavedTag(rid: string, prop: string, was?: string): HTMLElement {
    const label = this.labelOf(rid, prop);
    return el('span', 'ow-tag-edit',
      attrs(el('i', 'ow-dia'), { 'aria-hidden': 'true' }), 'Unsaved',
      was ? attrs(el('span', 'ow-was', was), { title: was }) : '',
      button('ow-link', `Revert ${label}`, () => this.handlers.revert(rid, prop), icon('i-undo', 'ic-sm'), 'Revert'));
  }

  /** Identity chip: key, value, then its icons right after the value. */
  private chip(k: string, v: string, ids: { businessId?: string; rid?: string }): HTMLElement {
    return el('span', 'ow-chip', el('span', 'k', k), el('span', 'v ow-sel', v), el('span', 'ow-chip-acts', this.copyButton(ids, 'ow-chip-btn')));
  }

  /** The one copy control of a chip or row. Plain click copies the business
   *  ID (configurators' template ID), Shift-click the RID. A control with
   *  only one of the two copies that one. */
  private copyButton(ids: { businessId?: string; rid?: string }, cls: string): HTMLButtonElement {
    const { businessId, rid } = ids;
    const label = businessId && rid ? 'Copy ID \u00b7 Shift-click: RID' : businessId ? 'Copy ID' : 'Copy RID';
    const b = button(cls, label, e => {
      const text = e.shiftKey && rid ? rid : businessId || rid || '';
      if (text) this.copy(text, b);
    }, icon('i-copy', 'ic-copy'), icon('i-check', 'ic-ok'));
    return b;
  }

  private copyMenu(businessId: string, rid: string): HTMLElement {
    const items: Array<[string, string]> = [];
    if (businessId) items.push(['ID', businessId]);
    items.push(['RID', rid], ['EC reference', `lookup("${rid}")`]);
    const menu = attrs(el('div', 'ow-menu ui-menu'), { role: 'menu', 'data-open': 'false' });
    const btn = button('ow-menu-btn', undefined, () => {
      const open = menu.dataset.open !== 'true';
      this.closeMenus();
      menu.dataset.open = String(open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector<HTMLElement>('button')?.focus();
    }, icon('i-copy', 'ic-sm ic-copy'), icon('i-check', 'ic-sm ic-ok'), 'Copy', icon('i-chev', 'ic-sm'));
    attrs(btn, { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    for (const [label, value] of items) {
      const item = button('', undefined, () => { this.closeMenus(); this.copy(value, btn); btn.focus(); }, el('span', '', label), el('code', '', value));
      item.setAttribute('role', 'menuitem');
      menu.append(item);
    }
    menu.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = [...menu.querySelectorAll<HTMLElement>('button')];
      const i = list.indexOf(document.activeElement as HTMLElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
      e.preventDefault();
    });
    return el('span', 'ow-menu-wrap', btn, menu);
  }

  private section(title: string, ...kids: Kids): HTMLElement {
    return el('section', 'ow-sec', el('div', 'ow-sec-h ui-band', el('span', 't', title)), ...kids);
  }

  /** Section with a count in its header band. */
  private countedSection(title: string, count: number, ...kids: Kids): HTMLElement {
    return el('section', 'ow-sec', el('div', 'ow-sec-h ui-band', el('span', 't', title), el('span', 'n', String(count))), ...kids);
  }

  private siblingKeys(node: StructureNode): string[] {
    const tree = this.tree;
    if (!tree || !node.parent) return [];
    return tree.nodes[node.parent].children
      .filter(r => r !== node.rid)
      .map(r => tree.nodes[r].obj?.props.key?.text ?? '')
      .filter(Boolean);
  }

  private behaviour(obj: FullObject, info: TypeInfo, node: StructureNode): HTMLElement | null {
    const blocks = blocksFor(info, obj);
    if (!blocks.length) return null;
    const keys = this.siblingKeys(node);
    const parts = blocks.map(p => this.block(obj, p, keys, node));
    // One block has its own header; a "Behaviour" band above it says nothing.
    if (parts.length === 1) return el('section', 'ow-sec ow-sec-bare', ...parts);
    return this.section('Behaviour', ...parts);
  }

  /** Gate switch of an expression block: editable when the gate came back. */
  private gateControl(obj: FullObject, gateProp: string, label: string): HTMLElement {
    const on = this.current(obj, gateProp) === 'true';
    const e = this.entry(obj.rid, gateProp);
    if (!this.editable(obj, gateProp)) return readOnlySwitch(on, label);
    const sw = attrs(button('ui-sw', undefined, () => this.handlers.edit(obj.rid, gateProp, String(!on), baseText(obj.props[gateProp]))), {
      role: 'switch', 'aria-checked': String(on), 'aria-label': label, title: `${label}: ${on ? 'on' : 'off'}`, 'data-fk': `${obj.rid}:${gateProp}`,
    });
    if (!e) return sw;
    sw.classList.add('dirty');
    return el('span', 'ow-gate', sw, dia(`${label} unsaved`),
      button('ui-ibtn ui-ibtn-sm', `Revert ${label}`, () => this.handlers.revert(obj.rid, gateProp), icon('i-undo')));
  }

  private block(obj: FullObject, prop: string, siblingKeys: string[], node: StructureNode): HTMLElement {
    const def = EXPRESSIONS[prop] ?? { label: this.labelFor(obj, prop) ?? splitWords(prop) };
    const saved = obj.props[prop]?.text ?? '';
    const draft = this.entry(obj.rid, prop);
    const code = draft?.kind === 'value' ? draft.value : saved;
    const editable = this.editable(obj, prop)?.route === 'code';
    const gateProp = def.gate && def.gate in obj.props ? def.gate : undefined;
    const gateOn = gateProp ? this.current(obj, gateProp) === 'true' : null;
    const gate = gateProp ? this.gateControl(obj, gateProp, this.labelFor(obj, gateProp) ?? `Use ${def.label.toLowerCase()}`) : '';
    const editing = this.codeEdit?.rid === obj.rid && this.codeEdit.prop === prop;
    const tag = draft ? this.unsavedTag(obj.rid, prop) : '';
    if (!code.trim() && !editing) {
      return el('div', `ow-unset${draft ? ' edited' : ''}`, attrs(el('span', 'lbl', def.label), { title: propHelp(prop) }), gate, el('span', 'ow-grow'), tag, el('span', 'none', 'Not set'),
        editable ? button('ow-link', `Add ${def.label}`, () => this.startCode(obj, prop, ''), icon('i-plus', 'ic-sm'), 'Add') : '');
    }
    const st = this.state()!;
    const key = `${obj.rid}:${prop}`;
    const landing = this.model?.focus && this.model.focus.rid === obj.rid && this.model.focus.prop === prop ? this.model.focus : null;
    // Landing past the first lines: the block opens to show it.
    if (landing && landing.seq !== this.focusShown && landing.line > CODE_CAP_LINES) st.expanded.add(key);
    const open = st.expanded.has(key);
    const right = el('span', 'ow-blk-r', tag);
    let body: HTMLElement;
    let reads: string[] = [];
    if (editing) {
      body = el('div', 'ow-cm-host');
      if (this.codeEdit!.handle) body.append(this.codeEdit!.handle.el);
      else body.append(el('div', 'ow-quiet ow-pad-y', 'Loading editor…'));
      right.append(button('ow-link', 'Finish editing', () => this.finishCode(), icon('i-check', 'ic-sm'), 'Done'));
    } else {
      reads = def.plain ? [] : keysReadBy(code, siblingKeys);
      const opts = { plain: def.plain, keys: new Set(reads), label: def.label, ...(draft ? { orig: saved } : {}) };
      // References are links (read mode): hover or focus shows the card,
      // click peeks under the line, Ctrl/Cmd+Click opens the target here.
      const view = this.model?.refs && !def.plain
        ? this.refUi.code(code, { rid: obj.rid, prop, path: `${obj.rid}.${prop}`, chain: [], depth: 0 }, opts)
        : renderCode(code, opts);
      const capped = !view.truncated && view.lines > CODE_CAP_LINES;
      right.append(el('span', 'cnt', `${formatCount(view.lines)} ${view.lines === 1 ? 'line' : 'lines'}${view.truncated ? ` · ${formatCount(view.chars)} chars` : ''}`));
      if (capped) {
        right.append(button('ui-ibtn', open ? 'Collapse' : `Expand to all ${view.lines} lines`, () => {
          if (st.expanded.has(key)) st.expanded.delete(key); else st.expanded.add(key);
          this.renderDetail();
        }, icon(open ? 'i-collapse' : 'i-expand')));
      }
      if (!view.truncated) {
        const cb = button('ui-ibtn', 'Copy code', () => this.copy(code, cb), icon('i-copy', 'ic-copy'), icon('i-check', 'ic-ok'));
        right.append(cb);
        if (editable) right.append(button('ui-ibtn', `Edit ${def.label}`, () => this.startCode(obj, prop, code), icon('i-pencil')));
      }
      body = view.el;
      if (landing) this.markLanding(view.el, landing);
    }
    right.append(button('ui-ibtn', 'Open in editor', () => { this.closeEdits(true); this.handlers.openInEditor(obj.rid, prop, obj.type); }, icon('i-popout')));
    const blk = el('section', `ow-blk${gateOn === false ? ' off' : ''}${open || editing ? ' expanded' : ''}${draft ? ' edited' : ''}${editing ? ' editing' : ''}`,
      el('div', 'ow-blk-h', attrs(el('span', 'lbl', def.label), { title: propHelp(prop) }), gate, right), body);
    if (reads.length) {
      blk.append(el('div', 'ow-reads', 'reads', ...reads.map(k => button('ow-rd', `Select ${k}`, () => {
        const target = this.tree && node.parent ? this.tree.nodes[node.parent].children.find(r => this.tree!.nodes[r].obj?.props.key?.text === k) : undefined;
        if (target) this.select(target, false);
      }, k))));
    }
    return blk;
  }

  /** The landing line of a search: tinted, and scrolled into view. */
  private markLanding(code: HTMLElement, f: NonNullable<WindowModel['focus']>): void {
    const row = [...code.querySelectorAll<HTMLElement>(':scope > .ow-ln')].find(r => r.querySelector('.n')?.textContent === String(f.line));
    if (!row) return;
    row.classList.add('hot');
    row.setAttribute('aria-current', 'location');
    // The window renders again while the object loads (each time with a new row), so the line is
    // revealed on every render for a short while after the landing, not only on the first.
    if (this.focusShown !== f.seq) {
      this.focusShown = f.seq;
      this.focusRevealUntil = Date.now() + LANDING_REVEAL_MS;
    } else if (Date.now() > this.focusRevealUntil) return;
    requestAnimationFrame(() => {
      if (!row.isConnected) return;
      row.scrollIntoView({ block: 'center' });
      // The code box scrolls inside the pane too.
      const box = row.closest<HTMLElement>('.ow-code');
      if (box && box.scrollHeight > box.clientHeight) box.scrollTop = row.offsetTop - box.clientHeight / 2;
    });
  }

  /** Editability, except for objects hung in by reference (read only). */
  private editable(obj: FullObject, prop: string): ReturnType<typeof editability> {
    return editability(obj, prop);
  }

  private startCode(obj: FullObject, prop: string, code: string): void {
    this.closeEdits(true);
    const edit: CodeEdit = { rid: obj.rid, prop, start: code, base: obj.props[prop]?.text ?? '', handle: null };
    this.codeEdit = edit;
    this.renderDetail();
    const plain = EXPRESSIONS[prop]?.plain;
    const label = EXPRESSIONS[prop]?.label ?? prop;
    const create = (factory: CodeEditorFactory) => {
      if (this.codeEdit !== edit) return;
      edit.handle = factory({
        code, plain, label,
        onChange: text => {
          window.clearTimeout(edit.timer);
          edit.timer = window.setTimeout(() => this.flushCode(edit, text), 200);
        },
        onCancel: () => this.cancelCode(),
        onDone: () => this.finishCode(),
        ...(this.model?.refs ? { refs: {
          cache: this.model.refs,
          open: (target: RefTarget, line: number) => this.openRef(target, line, { rid: obj.rid, prop, path: `${obj.rid}.${prop}`, chain: [], depth: 0 }),
        } } : {}),
      });
      this.renderDetail();
      edit.handle.focus();
    };
    if (this.codeFactory) create(this.codeFactory);
    else {
      void import('./code-edit').then(mod => {
        this.codeFactory = mod.createCodeEditor;
        create(mod.createCodeEditor);
      });
    }
  }

  private flushCode(edit: CodeEdit, text: string): void {
    window.clearTimeout(edit.timer);
    edit.timer = undefined;
    this.handlers.edit(edit.rid, edit.prop, text, edit.base);
  }

  private finishCode(): void {
    const edit = this.codeEdit;
    if (!edit) return;
    this.codeEdit = null;
    if (edit.handle) this.flushCode(edit, edit.handle.getDoc());
    edit.handle?.destroy();
    this.renderDetail();
  }

  /** Escape: drop what was typed in this edit and close the editor. */
  private cancelCode(): void {
    const edit = this.codeEdit;
    if (!edit) return;
    this.codeEdit = null;
    window.clearTimeout(edit.timer);
    edit.handle?.destroy();
    this.handlers.edit(edit.rid, edit.prop, edit.start, edit.base);
    this.renderDetail();
  }

  /** Close open inline edits; `keep` keeps typed code in the draft. */
  /** Ctrl/Cmd+S: what the Save button does (finish open edits, then review
   *  and save). The controller ignores it when nothing is pending. */
  /** A text field of a property editor (the ones that commit on change). */
  private typedEditor(t: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
    const text = t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'number'));
    return text && t.closest('.ow-ed') ? t : null;
  }

  requestSave(): void {
    // Text still being typed in a field: take it as it is.
    this.typedEditor(document.activeElement)?.dispatchEvent(new Event('change', { bubbles: true }));
    this.closeEdits(true);
    this.handlers.save();
  }

  private closeEdits(keep: boolean): void {
    this.idEdit = null;
    this.propEdit = null;
    const edit = this.codeEdit;
    if (!edit) return;
    this.codeEdit = null;
    if (keep && edit.handle) this.flushCode(edit, edit.handle.getDoc());
    else window.clearTimeout(edit.timer);
    edit.handle?.destroy();
  }

  private labelFor(obj: FullObject, prop: string): string | undefined {
    return propLabel(obj, prop, this.model?.labels, this.model?.summaries);
  }

  private fieldRows(obj: FullObject, fields: FieldDef[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const f of fields) {
      let value: Node | null = null;
      if (f.ref) {
        if (!(f.ref in obj.references)) continue;
        const rids = obj.references[f.ref];
        value = rids.length ? el('span', 'ow-refs', ...rids.map(r => this.refButton(r))) : el('span', 'ow-none', 'Not set');
        // References follow the same rule as plain values.
        if (overrides(obj, f.ref, this.overrideOf(obj), true)) value = el('span', 'ow-cell', value, el('span', 'ow-tag', 'overrides template'));
      } else if (f.prop) {
        const v = obj.props[f.prop];
        if (!v) continue;
        value = this.fieldValue(obj, f, v);
      }
      if (!value) continue;
      const dirty = !!(f.prop && this.entry(obj.rid, f.prop));
      out.push(el('div', `gl${dirty ? ' edited' : ''}`, f.label), el('div', `gv${dirty ? ' edited' : ''}`, value));
    }
    return out;
  }

  /** Value cell: the typed editor when the property is editable, else text. */
  private fieldValue(obj: FullObject, f: FieldDef, v: PropValue): Node {
    const prop = f.prop!;
    const how = prop === 'name' ? null : this.editable(obj, prop);
    const e = this.entry(obj.rid, prop);
    const tail: Node[] = [];
    if (e?.kind === 'value') {
      tail.push(dia(`${f.label} unsaved`), attrs(el('span', 'ow-was', `was ${isFileLinkProp(prop) ? this.fileWords(e.base) : draftDisplay(e.base)}`), { title: e.base }),
        button('ui-ibtn ui-ibtn-sm', `Revert ${f.label}`, () => this.handlers.revert(obj.rid, prop), icon('i-undo')));
    }
    if (e?.kind === 'reset') {
      return el('span', 'ow-cell', el('span', 'ow-none', 'Template value'), dia(`${f.label} reset unsaved`), el('span', 'ow-tag', 'reset to template'),
        button('ow-link', `Keep the override of ${f.label}`, () => this.handlers.toggleReset(obj.rid, prop, baseText(v)), icon('i-undo', 'ic-sm'), 'Undo reset'));
    }
    if (overrides(obj, prop, this.overrideOf(obj))) {
      tail.push(el('span', 'ow-tag', 'overrides template'));
      if (canReset(obj, prop) && obj.rid !== this.templateRid()) {
        tail.push(button('ow-link', `Reset ${f.label} to the template value`, () => this.handlers.toggleReset(obj.rid, prop, baseText(v)), 'Reset'));
      }
    }
    const control = how?.route === 'props' ? this.editor(obj, prop, f, v, how.def, how.multiline) : this.readValue(obj, f, v);
    return el('span', 'ow-cell', control, ...tail);
  }

  /** A file link in words: the file's name and ID, "No image" for none. */
  private fileWords(rid: string): string {
    return fileLinkText(rid, r => { const k = this.resolve(r); return k.known ? (k.name && k.businessId && k.name !== k.businessId ? `${k.name} (${k.businessId})` : k.name || k.businessId) : undefined; });
  }

  private readValue(obj: FullObject, f: FieldDef, v: PropValue): Node {
    if (f.prop === 'name') {
      const cur = this.current(obj, 'name');
      return el('span', 'ow-val ow-sel', cur);
    }
    if (v.kind === 'boolean' || f.widget === 'bool') {
      const on = v.bool ?? v.text === 'true';
      return el('span', 'ow-bool', readOnlySwitch(on, f.label), el('span', 'ow-bool-t', on ? 'On' : 'Off'));
    }
    if (isEmptyValue(v)) return el('span', 'ow-none', 'Not set');
    if (v.kind === 'unknown' && !v.text && v.cls) return el('span', 'ow-none ow-mono', v.cls);
    if (v.kind === 'enum' || f.widget === 'enum') return attrs(el('span', 'ow-val', enumText(v)), { title: v.text });
    const mono = f.widget === 'mono' || f.widget === 'num' || v.kind === 'number' || v.kind === 'code';
    const why = f.prop ? readOnlyReason(obj, f.prop) : null;
    const text = el('span', `ow-val ow-sel${mono ? ' ow-mono' : ''}`, displayValue(v));
    return why ? attrs(text, { title: why }) : text;
  }

  /** Typed editor for a pane property (the side panel's property editors). */
  private editor(obj: FullObject, prop: string, f: FieldDef, v: PropValue, def: PropDef | undefined, multiline = false): Node {
    const base = baseText(v);
    const value = this.current(obj, prop);
    const dirty = !!this.entry(obj.rid, prop);
    const fk = `${obj.rid}:${prop}`;
    const ctx: PropEditorContext = { value, original: base, dirty, onChange: next => this.handlers.edit(obj.rid, prop, next, base) };
    const kind = def?.kind ?? (v.kind === 'boolean' ? 'boolean' : 'string');
    let node: HTMLElement;
    switch (kind) {
      case 'boolean': {
        const on = value === 'true' || value === 'TRUE';
        const sw = attrs(button(`ui-sw${dirty ? ' dirty' : ''}`, undefined, () => ctx.onChange(on ? 'false' : 'true')), {
          role: 'switch', 'aria-checked': String(on), 'aria-label': f.label,
        });
        node = el('span', 'ow-bool', sw, el('span', 'ow-bool-t', on ? 'On' : 'Off'));
        break;
      }
      case 'enum': node = enumEditor(ctx, def?.options ?? []); break;
      case 'number': node = numberEditor(ctx, { unit: def?.unit, ...(def?.range ?? {}) }); break;
      case 'slider': node = sliderEditor(ctx, def!.range!); break;
      case 'image': {
        const rid = value.trim();
        const known = rid ? this.resolve(rid) : null;
        node = this.handlers.imageEditor
          ? this.handlers.imageEditor({
            rid, name: known?.known ? known.name : '', id: known?.known ? known.businessId : '',
            colorRid: obj.references.buttonBackgroundColor?.[0] ?? obj.references.headerColor?.[0] ?? '',
            colorBid: colorLinkBid(this.current(obj, 'headerColor')) || (this.resolve(obj.references.buttonBackgroundColor?.[0] ?? '').businessId), dirty, onChange: ctx.onChange,
          })
          : el('span', 'ow-val', rid ? this.fileWords(rid) : 'No image');
        break;
      }
      case 'property': {
        const choices = this.model?.choices[obj.rid];
        node = propertyAccessorEditor(ctx, choices?.options, choices ?? { loading: true });
        break;
      }
      case 'color': {
        const bid = colorLinkBid(value);
        node = colorLinkEditor(ctx, {
          name: bid || value,
          rgb: null,
          onOpen: anchor => this.handlers.pickColor?.(anchor, bid || null, picked => ctx.onChange(picked)),
        });
        break;
      }
      default: node = multiline ? textAreaEditor(ctx) : stringEditor(ctx);
    }
    node.classList.add('ow-ed');
    const focusable = node.matches('button, input, select, textarea') ? node : node.querySelector<HTMLElement>('button, input, select, textarea');
    if (focusable) {
      focusable.dataset.fk = fk;
      focusable.setAttribute('aria-label', f.label);
    }
    return node;
  }

  private refButton(rid: string): HTMLElement {
    const r = this.resolve(rid);
    const info = typeInfo(r.type);
    const n = this.nameFor(rid);
    const shown = r.known ? (r.name || '(unnamed)') : n.text;
    if (n.state === 'unknown' && !r.inTree) {
      // Not a button: the chip holds its own Retry, and still opens the object.
      return el('span', 'ow-ref ow-ref-unread', dot('--text-placeholder'), this.unreadName(true, rid),
        button('ow-ref-open', 'Open this object as root', () => this.handlers.navigate(rid), icon('i-out')));
    }
    const label = n.state === 'unknown' ? this.unreadName(false) : el('span', n.state === 'known' ? '' : 'ow-pending', shown);
    if (r.inTree) {
      return button('ow-ref', `Select ${n.state === 'known' ? shown : 'object'}`, () => this.select(rid, false), dot(info.fam), label, r.businessId ? el('code', '', r.businessId) : '');
    }
    const b = button('ow-ref', `Open ${n.state === 'known' ? shown : 'this object'} as root`, () => this.handlers.navigate(rid),
      dot(r.known ? info.fam : '--text-placeholder'), label, r.known && r.businessId ? el('code', '', r.businessId) : '', icon('i-out'));
    return b;
  }

  private curated(obj: FullObject, info: TypeInfo): HTMLElement | null {
    const grid = this.grid(obj, info.groups);
    if (!grid) return null;
    const sec = this.section('Properties', grid);
    this.compareNote(sec, obj);
    return sec;
  }

  private grid(obj: FullObject, groups: GroupDef[], titled = true): HTMLElement | null {
    const rows: HTMLElement[] = [];
    for (const g of groups) {
      const fields = this.fieldRows(obj, g.fields);
      if (!fields.length) continue;
      if (titled) rows.push(el('div', 'gh', g.title));
      rows.push(...fields);
    }
    return rows.length ? el('div', 'ow-grid', ...rows) : null;
  }

  private layoutGroup(obj: FullObject, info: TypeInfo): HTMLElement | null {
    if (!info.layout) return null;
    const grid = this.grid(obj, [info.layout], false);
    if (!grid) return null;
    const link = button('ow-link plain', undefined, e => { e.preventDefault(); e.stopPropagation(); this.handlers.openBlueprint(obj.rid); },
      'Edit in Blueprint', icon('i-out', 'ic-sm'));
    const dirty = info.layout.fields.filter(f => f.prop && this.entry(obj.rid, f.prop)).length;
    // Collapsed: the main values the read returned, on one muted line.
    const brief = info.layout.fields.flatMap(f => {
      const v = f.prop ? obj.props[f.prop] : undefined;
      if (!f.prop || !v || isEmptyValue(v)) return [];
      const cur = this.current(obj, f.prop);
      const text = v.kind === 'boolean' || f.widget === 'bool'
        ? (cur === 'true' || cur === 'TRUE' ? 'on' : 'off')
        : v.kind === 'enum' || f.widget === 'enum' ? splitWords(cur.split('.').pop() ?? cur) : draftDisplay(cur);
      return text ? [`${f.label} ${text}`] : [];
    }).slice(0, 5).join(' \u00b7 ');
    const summary = el('summary', 'ow-grp-h ui-band ui-disc', el('span', 't', info.layout.title), dirty ? dia(`${dirty} unsaved in ${info.layout.title}`) : '',
      attrs(el('span', 'ow-grp-sum', brief), { title: brief || undefined }), link, icon('i-chev', 'ow-grp-chev ui-disc-chev'));
    const details = el('details', 'ow-grp', summary, el('div', 'inner', grid)) as HTMLDetailsElement;
    const st = this.state();
    const key = `${obj.rid}:layout`;
    details.open = !!st?.expanded.has(key);
    details.addEventListener('toggle', () => {
      if (!st) return;
      if (details.open) st.expanded.add(key); else st.expanded.delete(key);
    });
    return details;
  }

  private allProperties(obj: FullObject, info: TypeInfo): HTMLElement {
    const st = this.state()!;
    const shown = curatedProps(info, obj);
    const overState = this.overrideOf(obj);
    // Every property, also the ones the Properties block shows: the heading and its count say "all",
    // and the filter must find a property wherever else it appears. The override tag and Reset of
    // those stay in the Properties block only.
    const keys = Object.keys(obj.props);
    const rows = keys.map(k => {
      const v = obj.props[k];
      const label = propLabel(obj, k, this.model?.labels, this.model?.summaries);
      const empty = isEmptyValue(v);
      const text = v.kind === 'enum' ? v.text : displayValue(v);
      const over = !shown.has(k) && overrides(obj, k, overState);
      return { k, v, label, empty, text, over, hay: `${k} ${label} ${text || v.cls || ''}`.toLowerCase() };
    }).sort((a, b) => a.label.localeCompare(b.label));
    const total = Object.keys(obj.props).length;
    const emptyCount = Object.values(obj.props).filter(isEmptyValue).length;

    const list = el('div', 'ow-props');
    const nothing = el('div', 'ow-quiet ow-pad-y', 'No property matches.');
    const apply = () => {
      const q = st.propFilter.trim().toLowerCase();
      let any = 0;
      for (const row of list.children as HTMLCollectionOf<HTMLElement>) {
        // A typed filter also finds empty properties: "Hide empty" only trims the unfiltered list.
        const hide = q ? !(row.dataset.hay ?? '').includes(q) : st.hideEmpty && row.dataset.empty === 'true';
        row.hidden = hide;
        if (!hide) any++;
      }
      nothing.hidden = any > 0;
    };
    for (const r of rows) {
      const name = attrs(el('span', `pn${r.label === r.k ? ' ow-mono' : ''}`, r.label), { title: r.k });
      const value = r.empty
        ? el('span', 'pv none', 'empty')
        : r.v.kind === 'unknown' && !r.text && r.v.cls
          ? attrs(el('span', 'pv none', r.v.cls), { title: `${r.v.cls} value` })
          : r.v.kind === 'code'
            ? attrs(el('span', 'pv ow-sel', r.text.split('\n')[0] + (r.text.includes('\n') ? ' …' : '')), { title: r.text.length > 2000 ? `${r.text.slice(0, 2000)}…` : r.text })
            : attrs(el('span', 'pv ow-sel', r.text), { title: r.text });
      const reset = r.over && canReset(obj, r.k) && obj.rid !== this.templateRid()
        ? button('ow-link', `Reset ${r.label} to the template value`, () => this.handlers.toggleReset(obj.rid, r.k, baseText(r.v)), 'Reset') : '';
      const row = attrs(el('div', 'ow-pr ui-row', name, value, el('span', 'pt', KIND_LABEL[r.v.kind]),
        el('span', 'px', r.over ? el('span', 'ow-tag', 'overrides template') : '', reset)), {
        'data-empty': String(r.empty), 'data-hay': r.hay,
      });
      list.append(row);
    }

    const hideSw = attrs(el('button', 'ui-sw') as HTMLButtonElement, { type: 'button', role: 'switch', 'aria-checked': String(st.hideEmpty), 'aria-label': 'Hide empty' });
    hideSw.addEventListener('click', () => {
      st.hideEmpty = !st.hideEmpty;
      hideSw.setAttribute('aria-checked', String(st.hideEmpty));
      apply();
    });
    const filter = attrs(el('input', 'ui-input') as HTMLInputElement, {
      type: 'text', placeholder: 'Filter properties', 'aria-label': 'Filter properties', autocomplete: 'off', spellcheck: 'false',
    });
    filter.value = st.propFilter;
    filter.addEventListener('input', () => { st.propFilter = filter.value; apply(); });

    const head = el('div', 'ow-sec-h ui-band',
      el('span', 't', 'All properties'),
      el('span', 'n', `${total} · ${emptyCount} empty`),
      el('span', 'ow-grow'),
      el('label', 'ow-hide-empty', hideSw, 'Hide empty'),
      el('label', 'ow-pf', icon('i-search'), filter));
    const sec = el('section', 'ow-sec', head);
    this.compareNote(sec, obj);
    sec.append(list, nothing);
    apply();
    return sec;
  }

  /** The chip's comparison for `obj`: its linked template's values, read
   *  once (the window's existing full read) when first needed. */
  private overrideOf(obj: FullObject): OverrideState {
    const state = overrideState(obj, this.model?.templates ?? {});
    if (state.kind === 'loading' && !this.model?.templates[state.templateRid] && this.handlers.needTemplate) {
      const rid = state.templateRid;
      queueMicrotask(() => this.handlers.needTemplate?.(rid));
    }
    return state;
  }

  /** The template could not be read: one quiet line in the section header
   *  instead of chips. */
  private compareNote(sec: HTMLElement, obj: FullObject): void {
    const state = this.overrideOf(obj);
    if (!compareFailed(state) || !obj.overridden.length) return;
    const head = sec.querySelector('.ow-sec-h');
    const note = el('span', 'ow-cmp-note', 'Could not compare with the template');
    const grow = head?.querySelector('.ow-grow');
    if (grow) grow.before(note); else head?.append(note);
  }

  /** EditField: the property it is mapped to, named through the batched
   *  summary read of the property definitions (never one read per field). */
  private mappedProperty(obj: FullObject, node: StructureNode): HTMLElement | null {
    const v = obj.props.propertyMapping;
    if (!v) return null;
    const m = v.text.trim();
    const sec = this.section('Mapped property');
    if (!m) {
      sec.append(el('div', 'ow-quiet', 'Not mapped to a property.'));
      return sec;
    }
    const model = this.model!;
    const s = model.summaries[m];
    const page = node.parent ? this.tree?.nodes[node.parent]?.obj : null;
    const target = page?.props.types ? displayValue(page.props.types) : '';
    let name = s ? (s.name || s.businessId || m) : m;
    let quiet = false;
    let title: string | undefined;
    if (!s && isCustomKey(m)) {
      quiet = true;
      if (model.unreadable?.[m]) { name = 'Property could not be read'; title = model.unreadable[m]; }
      else if (model.missing?.[m]) name = 'Property not found';
      else if (model.summariesError) { name = 'Property name could not be loaded'; title = model.summariesError; }
      else name = 'Loading…';
    }
    const nameEl = el('span', `ow-mp-name${quiet ? ' quiet' : ''}`, name);
    if (title) nameEl.title = title;
    const ids = el('div', 'ow-mp-ids');
    if (s?.businessId) ids.append(this.chip('ID', s.businessId, { businessId: s.businessId, ...(isCustomKey(m) ? { rid: m } : {}) }));
    if (isCustomKey(m)) ids.append(this.chip('RID', m, { rid: m }));
    sec.append(el('div', 'ow-mapped',
      el('div', 'ow-mp-top', dot('--fam-structure'), nameEl, target ? el('span', 'ow-mp-meta', target) : ''),
      ids.childElementCount ? ids : ''));
    return sec;
  }

  /** Data objects: the property sections (prop-sections.ts) with the filter
   *  above them. Custom properties of the supported kinds edit in the row;
   *  everything else reads with a one-line reason. Relations sit between
   *  Advanced and Audit and fold like the others. */
  private propList(obj: FullObject, node: StructureNode): HTMLElement {
    const st = this.state()!;
    const m = this.model!;
    const ss = m.schemas?.[obj.type];
    const { before, after } = buildSections(obj, { summaries: m.summaries, labels: m.labels[obj.type], schema: ss?.schema, ...(ss?.error ? { schemaError: ss.error } : {}) });

    const input = attrs(el('input', 'ow-ps-q') as HTMLInputElement, {
      type: 'text', placeholder: 'Filter properties', 'aria-label': 'Filter properties', autocomplete: 'off', spellcheck: 'false',
    });
    input.value = st.propFilter;
    const clear = button('ui-ibtn ui-ibtn-sm ow-ps-clear', 'Clear filter', () => { input.value = ''; st.propFilter = ''; apply(); input.focus(); }, icon('i-x'));
    const count = el('span', 'ow-ps-cnt');
    const tools = el('div', 'ow-ps-tools', el('div', 'ui-search ow-ps-search', icon('i-search', 'ic-sm'), input, clear), count);

    const secs: HTMLElement[] = [];
    for (const sec of before) secs.push(this.propSection(obj, sec));
    const rel = this.relations(node, true);
    if (rel) secs.push(rel);
    for (const sec of after) secs.push(this.propSection(obj, sec));
    if (ss?.error) secs.unshift(attrs(el('div', 'ow-quiet ow-note', 'The property schema could not be read, so custom properties are read-only.'), { 'data-err': ss.error }));
    const nothing = el('div', 'ow-quiet ow-pad-y', 'No property matches.');

    const total = [...before, ...after].reduce((n, s) => n + s.rows.length, 0);
    const apply = () => {
      const q = st.propFilter.trim().toLowerCase();
      clear.hidden = !q;
      let rows = 0;
      let inSecs = 0;
      for (const sec of secs) {
        const list = [...sec.querySelectorAll<HTMLElement>('[data-hay]')];
        if (!list.length) continue;
        const body = sec.querySelector<HTMLElement>(':scope > .ow-ps-body');
        let n = 0;
        let shown = 0;
        for (const r of list) {
          const hit = !q || (r.dataset.hay ?? '').includes(q);
          // An unsaved row is never out of sight: it stays, marked as not matching.
          const unsaved = r.classList.contains('chg');
          r.hidden = !hit && !unsaved;
          r.classList.toggle('ow-nomatch', !!q && !hit && unsaved);
          if (hit) n++;
          if (hit || unsaved) shown++;
        }
        // A filter opens matching sections and hides the rest (never one with
        // unsaved rows); clearing it restores each section's own fold state.
        sec.hidden = !!q && shown === 0;
        if (body) body.hidden = q ? shown === 0 : sec.dataset.open !== 'true';
        sec.querySelector('.ow-ps-h')?.setAttribute('aria-expanded', String(q ? shown > 0 : sec.dataset.open === 'true'));
        rows += n;
        if (n) inSecs++;
      }
      count.textContent = q ? `${rows} ${rows === 1 ? 'property' : 'properties'} in ${inSecs} section${inSecs === 1 ? '' : 's'}` : `${total} properties`;
      nothing.hidden = !q || rows > 0;
    };
    input.addEventListener('input', () => { st.propFilter = input.value; apply(); });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !input.value) return;
      // Esc clears the filter; the window stays open.
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      st.propFilter = '';
      apply();
    });
    const wrap = el('div', 'ow-ps', tools, ...secs, nothing);
    apply();
    return wrap;
  }

  /** One foldable section of the data-object property list. */
  private propSection(obj: FullObject, sec: PropSection): HTMLElement {
    const st = this.state()!;
    const dirty = sec.rows.filter(r => this.entry(obj.rid, r.key)).length;
    const open = sectionOpen(sec, st.folds, dirty);
    const head = this.foldHead(sec.key, sec.title, sec.rows.length, open, dirty, sec.note, sec.category);
    const body = el('div', 'ow-ps-body', ...sec.rows.map(r => this.propRow(obj, r, !!sec.note)));
    body.hidden = !open;
    return attrs(el('section', 'ow-ps-sec', head, body), { 'data-sec': sec.key, 'data-open': String(open) });
  }

  /** Header band of a foldable section: chevron, title, count, unsaved
   *  count, and the one-line note of a section that is read-only as a whole.
   *  A section with an unsaved edit stays open. */
  private foldHead(key: string, title: string, n: number, open: boolean, dirty: number, note?: string, category?: boolean): HTMLElement {
    const st = this.state()!;
    const head = attrs(el('div', 'ow-sec-h ui-band ui-disc ow-ps-h',
      icon('i-chev', `ui-disc-chev${open ? '' : ' closed'}`),
      el('span', 't', title), el('span', 'n', String(n)),
      dirty ? el('span', 'ow-ps-dirty', attrs(el('i', 'ow-dia'), { 'aria-hidden': 'true' }), `${dirty} unsaved`) : '',
      el('span', 'ow-grow'),
      note ? el('span', 'ow-ps-note', icon('i-lock', 'ic-sm'), note) : ''), {
      role: 'button', tabindex: '0', 'aria-expanded': String(open), 'data-fk': `fold:${key}`,
    });
    const toggle = () => {
      if (dirty || st.propFilter.trim()) return;
      st.folds.set(key, !open);
      this.renderDetail();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle();
    });
    return head;
  }

  /** One property row: label and ID, the value (an editor for an editable
   *  custom property), the reason or the server's refusal under it, revert. */
  private propRow(obj: FullObject, r: SectionRow, sectionSays: boolean): HTMLElement {
    const e = this.entry(obj.rid, r.key);
    const cur = e?.kind === 'custom' ? e.value : r.stored;
    const items = this.listItems(obj, r);
    const text = customValueText(cur, r.kind, { items, summaries: this.model?.summaries });
    const editable = !!r.model?.editability.ok && !!this.handlers.editCustom && !this.model?.saving && isEditKind(r.kind);
    // A reference row has its own control (referenceEditor); without the
    // window's reference handlers it is drawn read-only.
    const refEditor = editable && isReferenceKind(r.kind) ? this.referenceEditor(obj, r, e) : null;
    const canEdit = refEditor ? refEditor.can : editable && !isReferenceKind(r.kind);
    const [glyph, kindWord] = KIND_GLYPH[r.kind];
    // One glyph slot: the kind, with a small clock on its corner when the
    // property is historical. The name and ID wrap beside it, never under it.
    const dated = !!r.model?.historical;
    const name = el('div', 'ow-pr-l',
      attrs(el('span', `ow-kind${dated ? ' hist' : ''}`, icon(glyph, 'ic-sm'), dated ? icon('i-clock', 'ow-kind-h') : ''),
        { title: dated ? `${kindWord}, historical: keeps dated values. A change takes effect from today.` : kindWord }),
      el('span', 'ow-pr-lt',
        attrs(el('span', 'nm', r.label), { title: r.label }), dated ? el('span', 'ow-sr', ', historical') : '',
        r.ident ? el('code', 'ky', r.ident) : '',
        e ? el('span', 'ow-pr-nomatch', 'Unsaved, does not match the filter') : ''));
    const value = el('div', 'ow-pr-v');
    value.append(refEditor?.node ?? (canEdit ? this.customEditor(obj, r, cur, text, items) : this.readOnlyValue(r, cur, text)));
    if (r.custom && obj.overridden.includes(r.key) && !e) value.append(el('span', 'ow-tag', 'overrides template'));
    // Why the row cannot be edited: a lock at the row's end, the reason on hover.
    if (r.reason && !sectionSays) value.append(attrs(el('div', 'ow-preason ow-lock', icon('i-lock', 'ic-sm'), el('span', 'ow-sr', r.reason)), { title: r.reason }));
    const refused = this.model?.draft.propErrorFor(obj.rid, r.key);
    if (refused) value.append(el('div', 'ow-perr', icon('i-warn', 'ic-sm'), el('span', '', `Not saved: ${refused}`)));
    const act = el('div', 'ow-pr-a', e ? button('ui-ibtn', `Revert ${r.label}`, () => this.handlers.revert(obj.rid, r.key), icon('i-undo')) : '');
    return attrs(el('div', `ow-pr2${e ? ' chg' : ''}${canEdit ? ' can' : ''}`, name, value, act), {
      'data-hay': sectionRowHay(r, text), 'data-key': r.key,
    });
  }

  private listItems(obj: FullObject, r: SectionRow): Array<{ rid: string; name: string }> | undefined {
    if (r.kind !== 'listItem') return undefined;
    return this.model?.schemas?.[obj.type]?.schema?.listItems[r.key];
  }

  // ── reference editor (in the row) ──────────────────────────────

  /**
   * The control of an editable reference, user/group or list-of-references
   * row (`r.model.editability.ok`), or null when the window has no
   * reference handlers (the row is then drawn read-only). `can`: the row
   * takes the edit affordance.
   *
   * Closed: the value's chips in a box that opens the editor; a staged list
   * marks added objects and shows removed ones struck through. Open: the
   * chips, each with a remove button, and a search field in the row; under
   * it the allowed objects (read on open) to pick from. Every pick is staged
   * at once; a refusal keeps the editor open and says why. Too many allowed
   * objects: the row is read-only with the reason.
   */
  private referenceEditor(obj: FullObject, r: SectionRow, e: DraftEntry | undefined): { node: HTMLElement; can: boolean } | null {
    const h = this.handlers;
    if (!h.referenceRow || !h.editReferences || !h.loadAllowed) return null;
    const row = h.referenceRow(obj.rid, r.key);
    if (!row) return null;
    const fk = `${obj.rid}:${r.key}`;
    const edit = this.propEdit?.rid === obj.rid && this.propEdit.prop === r.key ? this.propEdit : null;
    if (row.allowed?.phase === 'done' && row.allowed.tooMany) {
      if (edit) this.propEdit = null;
      const why = row.editability.ok ? REASON_TEXT['list-too-long'] : row.editability.text;
      return { node: el('div', 'ow-ref-ed', this.refValue(row, true), el('div', 'ow-preason', icon('i-lock', 'ic-sm'), el('span', '', why))), can: false };
    }
    return { node: edit ? this.refOpen(obj, r, row, edit, fk) : this.refClosed(obj, r, row, fk, !!e), can: true };
  }

  /** The named objects a reference row's allowed objects hold (loading
   *  keeps an earlier answer). */
  private refItems(row: ReferenceRowState): ListItem[] | undefined {
    const a = row.allowed;
    return a?.phase === 'done' || a?.phase === 'loading' ? a.items : undefined;
  }

  /** The value of a reference row as chips: the objects in their order (a
   *  list marks the ones added since stored), then the removed ones of a
   *  list. "Not set" when there is no object. `open`: chips carry the arrow
   *  that opens the object. */
  private refValue(row: ReferenceRowState, open: boolean): HTMLElement {
    const list = row.kind === 'referenceList';
    const had = new Set(referenceRids(row.stored));
    const has = new Set(row.selected.map(n => n.rid));
    const outside = new Set(row.outside);
    const chips = row.selected.map(n => this.refChip(n, { open, mark: outside.has(n.rid) ? 'out' : list && !had.has(n.rid) ? 'add' : undefined }));
    const removed = list ? [...had].filter(rid => !has.has(rid)) : [];
    const gone = removed.map(rid => this.refChip(refName(rid, this.refItems(row), this.model?.summaries), { open, mark: 'del' }));
    if (!chips.length && !gone.length) return el('span', 'ow-pr-none', NOT_SET);
    return el('span', 'ow-refs', ...chips, chips.length ? '' : el('span', 'ow-pr-none', NOT_SET), ...gone);
  }

  /** One object of a reference value: type dot, name, ID, and as asked the
   *  open arrow and a remove button. Marks: `add` (added to a list), `del`
   *  (removed from it), `out` (stored, no longer allowed). */
  private refChip(n: RefName, opts: { open?: boolean; mark?: 'add' | 'del' | 'out'; remove?: () => void }): HTMLElement {
    const rs = this.resolve(n.rid);
    const named = n.known ? { name: n.name, id: n.id } : rs.known ? { name: rs.name, id: rs.businessId } : null;
    const shown = named ? (named.name || named.id || '(unnamed)') : this.nameFor(n.rid).text;
    const id = named?.id && named.id !== shown ? named.id : '';
    const { mark } = opts;
    const sign = mark === 'add' ? '+' : mark === 'del' ? '−' : '';
    const chip = el('span', `ow-ref ow-ref-chip${mark ? ` ow-ref-${mark}` : ''}`,
      sign ? attrs(el('span', 'ow-ref-mk', sign), { 'aria-hidden': 'true' }) : '',
      mark === 'out' ? icon('i-warn', 'ow-ref-warn') : dot(rs.known ? typeInfo(rs.type).fam : '--text-placeholder'),
      el('span', named ? 'ow-ref-nm' : 'ow-ref-nm ow-pending', shown),
      id ? el('code', '', id) : '',
      mark === 'add' ? el('span', 'ow-sr', ', added') : mark === 'del' ? el('span', 'ow-sr', ', removed') : mark === 'out' ? el('span', 'ow-sr', ', no longer allowed') : '');
    attrs(chip, { 'data-rid': n.rid, ...(mark === 'out' ? { title: 'No longer one of the allowed objects' } : {}) });
    if (opts.open) {
      chip.append(button('ow-ref-open', rs.inTree ? `Select ${shown}` : `Open ${shown} as root`,
        () => (rs.inTree ? this.select(n.rid, false) : this.handlers.navigate(n.rid)), icon('i-out')));
    }
    if (opts.remove) {
      const x = button('ow-ref-x', `Remove ${shown}`, opts.remove, icon('i-x'));
      // The search field keeps the focus.
      x.addEventListener('mousedown', ev => ev.preventDefault());
      chip.append(x);
    }
    return chip;
  }

  /** The closed reference row: the chips in a box; a click on the box (not
   *  on a chip's open arrow) or its chevron opens the editor. A staged
   *  dated row says from when the change counts. */
  private refClosed(obj: FullObject, r: SectionRow, row: ReferenceRowState, fk: string, staged: boolean): HTMLElement {
    const open = () => this.startRefEdit(obj, r);
    const go = attrs(button('ui-ibtn ui-ibtn-sm ow-ref-go', `Edit ${r.label}`, open, icon('i-chev', 'ic-sm')), { 'data-fk': fk, 'aria-haspopup': 'listbox' });
    const box = el('div', 'ow-pbox ow-ref-box', this.refValue(row, true), go);
    box.addEventListener('click', ev => {
      if ((ev.target as Element | null)?.closest('.ow-ref-open, .ow-ref-go')) return;
      open();
    });
    return el('div', 'ow-ref-ed', box);
  }

  private startRefEdit(obj: FullObject, r: SectionRow): void {
    this.closeEdits(true);
    this.propEdit = { rid: obj.rid, prop: r.key, text: '', start: '' };
    this.handlers.loadAllowed?.(obj.rid, r.key);
    this.renderDetail();
    this.focusRefSearch(`${obj.rid}:${r.key}`);
    this.detail.querySelector('.ow-ref-pop')?.scrollIntoView?.({ block: 'nearest' });
  }

  private focusRefSearch(fk: string): void {
    this.detail.querySelector<HTMLInputElement>(`[data-ed="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
  }

  /** The open reference editor: chips with remove buttons and the search
   *  field in the row; under it the allowed objects filtered by name or ID
   *  (or the reading / failed state), the refusal and the dated note. One
   *  object: a pick stages it and closes. A list: a pick adds or removes
   *  the object and the editor stays open. Escape or leaving closes and
   *  keeps what was staged. */
  private refOpen(obj: FullObject, r: SectionRow, row: ReferenceRowState, edit: PropEdit, fk: string): HTMLElement {
    const a = row.allowed;
    const ready = a?.phase === 'done';
    const items = ready ? a.items : [];
    const list = row.kind === 'referenceList';
    const chosen = row.selected.map(n => n.rid);
    const had = new Set(referenceRids(row.stored));
    const outside = new Set(row.outside);
    const close = () => {
      if (this.propEdit !== edit) return;
      this.propEdit = null;
      this.renderDetail();
    };
    const stage = (rids: string[], closeAfter: boolean) => {
      const refused = this.handlers.editReferences?.(obj.rid, r.key, rids);
      if (refused) {
        edit.error = `Not saved: ${refused}`;
        this.renderDetail();
        this.focusRefSearch(fk);
        return;
      }
      edit.error = undefined;
      if (closeAfter) { close(); return; }
      this.renderDetail();
      this.focusRefSearch(fk);
    };
    const remove = (rid: string) => stage(chosen.filter(x => x !== rid), false);
    const pick = (rid: string) => {
      if (list) stage(chosen.includes(rid) ? chosen.filter(x => x !== rid) : [...chosen, rid], false);
      else if (chosen.length === 1 && chosen[0] === rid) close();
      else stage([rid], true);
    };
    const pickNone = () => (chosen.length ? stage([], true) : close());

    const listId = `refs-${fk.replace(/\W/g, '-')}`;
    const q = attrs(el('input', 'ow-menu-q ow-ref-q') as HTMLInputElement, {
      type: 'text', placeholder: 'Search name or ID', 'aria-label': `Search ${r.label}`, autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'data-ed': fk, 'data-fk': `${fk}:ed`,
    });
    q.value = edit.text;
    if (edit.error) q.setAttribute('aria-invalid', 'true');
    const chips = row.selected.map(n => this.refChip(n, {
      mark: outside.has(n.rid) ? 'out' : list && !had.has(n.rid) ? 'add' : undefined,
      // A single reference that may not be empty has nothing to remove.
      ...(ready && (list || row.mayBeEmpty) ? { remove: () => remove(n.rid) } : {}),
    }));
    const clear = list && row.mayBeEmpty && ready && chosen.length
      ? button('ui-ibtn ui-ibtn-sm ow-ref-clear', 'Clear all', () => stage([], false), icon('i-x'))
      : null;
    clear?.addEventListener('mousedown', ev => ev.preventDefault());
    const field = el('div', 'ui-search ow-ref-field', ...chips, q, clear ?? '');
    field.addEventListener('mousedown', ev => {
      if (ev.target !== field) return;
      ev.preventDefault();
      q.focus();
    });

    const body: Kid[] = [];
    const listEl = attrs(el('div', 'ow-menu-list'), { role: 'listbox', id: listId, 'aria-label': r.label, ...(list ? { 'aria-multiselectable': 'true' } : {}) });
    type Opt = { rid: string | null; name: string; id: string };
    const opts: Opt[] = [
      ...(!list && row.mayBeEmpty ? [{ rid: null, name: NOT_SET, id: '' }] : []),
      ...items.map(i => ({ rid: i.rid, name: i.name || i.id || i.rid, id: i.id }))
        .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base', numeric: true })),
    ];
    const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    let shown: Opt[] = [];
    const noMatch = el('div', 'ow-quiet ow-menu-empty', 'No object matches.');
    const optId = (i: number) => `${listId}-${i}`;
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      shown = t ? opts.filter(o => o.rid !== null && (o.name.toLowerCase().includes(t) || o.id.toLowerCase().includes(t))) : opts;
      const firstTicked = shown.findIndex(o => (o.rid === null ? !chosen.length : chosen.includes(o.rid)));
      const active = Math.min(edit.active ?? Math.max(0, firstTicked), Math.max(0, shown.length - 1));
      edit.active = active;
      listEl.replaceChildren(...shown.map((o, i) => {
        const ticked = o.rid === null ? !chosen.length : chosen.includes(o.rid);
        const opt = attrs(el('div', `ow-menu-opt ow-ref-opt${i === active ? ' on' : ''}${ticked ? ' cur' : ''}`,
          el('span', 'ow-ref-tick', ticked ? icon('i-check', 'ic-sm') : ''),
          el('span', 'nm', o.name), o.id && plain(o.id) !== plain(o.name) ? el('code', 'ow-ref-id', o.id) : ''), {
          role: 'option', 'aria-selected': String(ticked), id: optId(i), ...(o.rid ? { 'data-rid': o.rid } : { 'data-none': 'true' }),
        });
        opt.addEventListener('mousedown', ev => { ev.preventDefault(); if (o.rid === null) pickNone(); else pick(o.rid); });
        return opt;
      }));
      noMatch.hidden = !(t && items.length && !shown.length);
      if (shown[active]) q.setAttribute('aria-activedescendant', optId(active)); else q.removeAttribute('aria-activedescendant');
      if (listEl.isConnected) listEl.querySelector('.on')?.scrollIntoView?.({ block: 'nearest' });
    };
    if (!a || a.phase === 'loading') {
      body.push(el('div', 'ow-quiet ow-ref-line', 'Reading the allowed objects…'));
    } else if (a.phase === 'error') {
      const again = button('ow-link', undefined, () => this.handlers.loadAllowed?.(obj.rid, r.key, { refresh: true }), 'Try again');
      again.addEventListener('mousedown', ev => ev.preventDefault());
      body.push(el('div', 'ow-ref-line ow-ref-fail', icon('i-warn', 'ic-sm'), el('span', '', a.error), again));
    } else {
      draw();
      body.push(listEl, noMatch);
      if (!items.length) body.push(el('div', 'ow-quiet ow-ref-line', 'This property allows no objects for this object.'));
      listEl.addEventListener('scroll', () => { edit.scroll = listEl.scrollTop; });
      if (edit.scroll) queueMicrotask(() => { listEl.scrollTop = edit.scroll ?? 0; });
    }
    if (edit.error) body.push(el('div', 'ow-perr ow-ref-line', icon('i-warn', 'ic-sm'), el('span', '', edit.error)));

    q.addEventListener('input', () => { edit.text = q.value; edit.active = 0; draw(); });
    q.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); edit.active = Math.min(shown.length - 1, (edit.active ?? 0) + 1); draw(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); edit.active = Math.max(0, (edit.active ?? 0) - 1); draw(); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        const o = shown[edit.active ?? 0];
        if (o) { if (o.rid === null) pickNone(); else pick(o.rid); }
      } else if (ev.key === 'Backspace' && list && ready && !q.value && chosen.length) {
        ev.preventDefault();
        remove(chosen[chosen.length - 1]);
      }
    });

    const pop = attrs(el('div', 'ow-pop ow-menu-pop ow-ref-pop', ...body), { role: 'dialog', 'aria-label': `Choose ${r.label}` });
    // A click on the popover's own surface keeps the focus in the field.
    pop.addEventListener('mousedown', ev => { if (!(ev.target as Element | null)?.closest('input, button')) ev.preventDefault(); });
    const root = el('div', 'ow-ref-ed open', el('div', 'ow-pop-anchor ow-ref-anchor', field, pop));
    root.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    });
    root.addEventListener('focusout', ev => {
      const next = ev.relatedTarget as Node | null;
      if (!root.isConnected || (next && root.contains(next))) return;
      // Leaving the editor closes it; what was picked is already staged.
      queueMicrotask(() => { if (root.isConnected && !root.contains(document.activeElement)) close(); });
    });
    return root;
  }

  private readOnlyValue(r: SectionRow, cur: string, text: string): HTMLElement {
    if (cur === ABSENT || (cur === '' && isTextKind(r.kind))) return el('span', 'ow-pr-none', NOT_SET);
    if (r.kind === 'boolean') {
      const on = cur === 'true';
      return el('span', 'ow-bool', attrs(el('span', 'ui-sw'), { role: 'switch', 'aria-checked': String(on), 'aria-readonly': 'true', 'aria-label': r.label }), el('span', 'ow-bool-t', on ? 'On' : 'Off'));
    }
    if ((r.kind === 'reference' || r.kind === 'principal' || r.kind === 'referenceList') && r.rids?.length) {
      return el('span', 'ow-refs', ...r.rids.map(rid => this.refButton(rid)));
    }
    if (r.value?.kind === 'unknown' && !r.value.text && r.value.cls) return el('span', 'ow-pr-none ow-mono', r.value.cls);
    if (r.value?.kind === 'enum') return el('span', 'ow-pr-txt', enumText(r.value));
    // Stored HTML (a description) reads as its text.
    const plain = /^\s*<[a-z]/i.test(text) ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : text;
    // A long text wraps and is cut after three lines; a click shows all of it.
    const shown = plain.length > LONG_TEXT_MAX ? `${plain.slice(0, LONG_TEXT_MAX)}…` : plain;
    const txt = el('span', `ow-pr-txt ow-sel${r.kind === 'number' || r.kind === 'code' ? ' ow-mono' : ''}`, shown);
    if (plain.length > 120 || plain.includes('\n')) {
      txt.classList.add('ow-clamp');
      txt.title = 'Click to show all of it';
      txt.addEventListener('click', () => { if (!String(getSelection() ?? '')) txt.classList.toggle('open'); });
    }
    return txt;
  }

  // ── custom property editors (in the row) ───────────────────────

  /** The editor of an editable custom property. At rest the value reads as
   *  text in a box that outlines on hover and focus; Enter or a click opens
   *  the editor; Enter or leaving commits to the draft, Esc cancels. */
  private customEditor(obj: FullObject, r: SectionRow, cur: string, text: string, items?: Array<{ rid: string; name: string }>): HTMLElement {
    const fk = `${obj.rid}:${r.key}`;
    const editing = this.propEdit?.rid === obj.rid && this.propEdit.prop === r.key ? this.propEdit : null;
    /** Stage `value`; false when the controller refused it: the editor then
     *  stays open with the value and the reason (nothing is dropped). */
    const commit = (value: string): boolean => {
      const refused = this.handlers.editCustom?.(obj.rid, r.key, value);
      if (typeof refused === 'string' && refused) {
        this.propEdit = { rid: obj.rid, prop: r.key, text: value, start: editing?.start ?? cur, error: `Not saved: ${refused}` };
        this.renderDetail();
        return false;
      }
      this.propEdit = null;
      this.renderDetail();
      return true;
    };
    const cancel = () => { this.propEdit = null; this.renderDetail(); };
    switch (r.kind) {
      case 'boolean': {
        const on = cur === 'true';
        const sw = attrs(button(`ui-sw${this.entry(obj.rid, r.key) ? ' dirty' : ''}`, undefined, () => commit(on ? 'false' : 'true')), {
          role: 'switch', 'aria-checked': String(on), 'aria-label': r.label, 'data-fk': fk,
        });
        return el('span', 'ow-bool', sw, el('span', 'ow-bool-t', on ? 'On' : 'Off'));
      }
      case 'text':
      case 'number':
        if (editing) return this.lineEditor(r, editing, fk, commit, cancel);
        return this.valueBox(r, cur, text, fk, 'i-pencil', () => this.startPropEdit(obj, r, cur));
      case 'multiline':
        return el('div', 'ow-pop-anchor',
          this.valueBox(r, cur, text, fk, 'i-expand', () => this.startPropEdit(obj, r, cur)),
          editing ? this.textPopover(r, editing, fk, commit, cancel) : '');
      case 'choice':
      case 'listItem': {
        // "Not set" comes first where the field may be blank (allowBlank).
        const opts = r.kind === 'listItem'
          ? [...(r.model?.allowBlank ? [{ value: ABSENT, name: NOT_SET }] : []), ...(items ?? []).map(i => ({ value: i.rid, name: i.name || i.rid }))]
          : (r.model?.options ?? []).map(o => ({ value: o, name: o }));
        if (opts.length && opts.length <= 4 && editing) return this.segmented(r, opts, cur, editing, fk, commit, cancel);
        return el('div', 'ow-pop-anchor',
          this.valueBox(r, cur, text, fk, 'i-chev', () => this.startPropEdit(obj, r, cur)),
          editing && opts.length > 4 ? this.choiceMenu(r, opts, cur, fk, commit, cancel) : '');
      }
      default:
        return this.readOnlyValue(r, cur, text);
    }
  }

  private startPropEdit(obj: FullObject, r: SectionRow, cur: string): void {
    this.closeEdits(true);
    this.propEdit = { rid: obj.rid, prop: r.key, text: cur === ABSENT ? '' : cur, start: cur };
    this.renderDetail();
    const target = this.detail.querySelector<HTMLElement>(`[data-ed="${CSS.escape(`${obj.rid}:${r.key}`)}"]`);
    target?.focus();
    if (target instanceof HTMLInputElement) target.select();
  }

  /** The value at rest: text in a box with a trailing glyph saying what
   *  kind of editor opens. */
  private valueBox(r: SectionRow, cur: string, text: string, fk: string, glyph: string, open: () => void): HTMLElement {
    // An empty text reads as not set (the read cannot tell the two apart).
    const unset = cur === ABSENT || (cur === '' && isTextKind(r.kind));
    const shown = unset ? NOT_SET : text.split('\n')[0];
    const lines = r.kind === 'multiline' && !unset ? cur.split('\n').length - 1 : 0;
    const b = attrs(el('button', `ow-pbox${unset ? ' unset' : ''}${r.kind === 'number' ? ' num' : ''}`) as HTMLButtonElement, {
      type: 'button', 'data-fk': fk, 'aria-label': `${r.label}: ${unset ? 'not set' : shown}. Press Enter to edit`,
    });
    b.append(el('span', 'pt', shown || NOT_SET), lines > 0 ? el('span', 'hlp', `+${lines} line${lines === 1 ? '' : 's'}`) : '', attrs(icon(glyph, 'ic-sm tg'), { 'aria-hidden': 'true' }));
    b.addEventListener('click', open);
    return b;
  }

  /** Single-line text or number in the row. Numbers refuse what is not a
   *  number, in words under the field; nothing is staged then. */
  private lineEditor(r: SectionRow, edit: PropEdit, fk: string, commit: (v: string) => boolean, cancel: () => void): HTMLElement {
    const input = attrs(el('input', `ui-input ow-ped-in${r.kind === 'number' ? ' num' : ''}`) as HTMLInputElement, {
      type: 'text', 'aria-label': r.label, autocomplete: 'off', spellcheck: 'false', 'data-fk': fk, 'data-ed': fk,
      ...(r.kind === 'number' ? { inputmode: 'decimal' } : {}),
    });
    input.value = edit.text;
    const err = el('div', 'ow-perr', icon('i-warn', 'ic-sm'), el('span', '', edit.error ?? ''));
    err.hidden = !edit.error;
    if (edit.error) { input.setAttribute('aria-invalid', 'true'); err.id = `err-${fk.replace(/\W/g, '-')}`; input.setAttribute('aria-describedby', err.id); }
    let done = false;
    const value = (): { value: string } | { error: string } => {
      if (r.kind !== 'number') return { value: input.value };
      return parseNumberInput(input.value, !!r.model?.integer);
    };
    const tryCommit = (fromBlur: boolean) => {
      if (done) return;
      const v = value();
      if ('error' in v) {
        if (fromBlur) { done = true; cancel(); return; }
        edit.error = v.error;
        edit.text = input.value;
        this.renderDetail();
        this.detail.querySelector<HTMLInputElement>(`[data-ed="${CSS.escape(fk)}"]`)?.focus();
        return;
      }
      done = true;
      // Refused (a control character, a line break): the editor is drawn
      // again with the value and "Not saved: <reason>"; Enter keeps focus.
      if (!commit(v.value) && !fromBlur) this.detail.querySelector<HTMLInputElement>(`[data-ed="${CSS.escape(fk)}"]`)?.focus();
    };
    input.addEventListener('input', () => { edit.text = input.value; });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); tryCommit(false); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done = true; cancel(); }
    });
    input.addEventListener('blur', () => { if (input.isConnected) tryCommit(true); });
    return el('div', 'ow-ped', input, err, el('div', 'ow-phint', el('span', '', el('kbd', '', 'Enter'), ' apply'), el('span', '', el('kbd', '', 'Esc'), ' cancel')));
  }

  /** Plain multi-line text: a small editor anchored under the row. Ctrl+Enter
   *  or Apply commits, leaving the editor commits too, Esc cancels. */
  private textPopover(r: SectionRow, edit: PropEdit, fk: string, commit: (v: string) => boolean, cancel: () => void): HTMLElement {
    const ta = attrs(el('textarea', 'ui-input ow-pop-ta') as HTMLTextAreaElement, { 'aria-label': r.label, spellcheck: 'false', 'data-ed': fk, 'data-fk': `${fk}:ed` });
    ta.value = edit.text;
    const info = el('span', 'ow-pop-info');
    const count = () => { const t = ta.value; info.textContent = `${t.split('\n').length} line${t.split('\n').length === 1 ? '' : 's'}, ${t.length} characters`; };
    count();
    // A refused value comes back with its reason; the editor stays open.
    const err = el('div', 'ow-perr', icon('i-warn', 'ic-sm'), el('span', '', edit.error ?? ''));
    err.hidden = !edit.error;
    if (edit.error) { ta.setAttribute('aria-invalid', 'true'); err.id = `err-${fk.replace(/\W/g, '-')}`; ta.setAttribute('aria-describedby', err.id); }
    let done = false;
    const apply = () => { if (done) return; done = true; commit(ta.value); };
    const stop = () => { if (done) return; done = true; cancel(); };
    const pop = attrs(el('div', 'ow-pop', el('div', 'ow-pop-b', ta), err,
      el('div', 'ow-pop-f', info, el('span', 'ow-grow'),
        button('ui-btn ghost ow-pop-btn', undefined, stop, 'Cancel'),
        button('ui-btn primary ow-pop-btn', undefined, apply, 'Apply')),
      el('div', 'ow-phint', el('span', '', el('kbd', '', 'Ctrl'), el('kbd', '', 'Enter'), ' apply'), el('span', '', el('kbd', '', 'Esc'), ' cancel'))), {
      role: 'dialog', 'aria-label': `Edit ${r.label}`,
    });
    ta.addEventListener('input', () => { edit.text = ta.value; count(); });
    pop.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
      else if (whichShortcut(e, ['objectText.apply'])) { e.preventDefault(); apply(); }
    });
    pop.addEventListener('focusout', e => {
      const next = e.relatedTarget as Node | null;
      if (!pop.isConnected || (next && pop.contains(next))) return;
      // Leaving the editor commits what was typed.
      queueMicrotask(() => { if (pop.isConnected && !pop.contains(document.activeElement)) apply(); });
    });
    return pop;
  }

  /** Up to four options: a segmented control in the row. Arrow keys move, Enter or leaving closes it, Esc restores the value it had. */
  private segmented(r: SectionRow, opts: Array<{ value: string; name: string }>, cur: string, edit: PropEdit, fk: string, commit: (v: string) => void, cancel: () => void): HTMLElement {
    const group = attrs(el('div', 'ow-seg2'), { role: 'radiogroup', 'aria-label': r.label });
    let picked = cur;
    const btns = opts.map(o => {
      const b = attrs(button('', undefined, () => { picked = o.value; finish(); }, o.name), {
        role: 'radio', 'aria-checked': String(o.value === cur), tabindex: o.value === cur || (cur === ABSENT && o === opts[0]) ? '0' : '-1', 'data-v': o.value,
      });
      if (o.value === cur || (cur === ABSENT && o === opts[0])) attrs(b, { 'data-ed': fk, 'data-fk': fk });
      return b;
    });
    group.append(...btns);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // "Not set" (ABSENT) is an option only where the field may be blank.
      if (picked === edit.start) cancel(); else commit(picked);
    };
    const move = (d: number) => {
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const next = btns[(Math.max(0, i) + d + btns.length) % btns.length];
      picked = next.dataset.v ?? picked;
      for (const b of btns) { b.setAttribute('aria-checked', String(b === next)); b.tabIndex = b === next ? 0 : -1; }
      next.focus();
    };
    group.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done = true; cancel(); }
    });
    group.addEventListener('focusout', e => {
      const next = e.relatedTarget as Node | null;
      if (!group.isConnected || (next && group.contains(next))) return;
      queueMicrotask(() => { if (group.isConnected && !group.contains(document.activeElement)) finish(); });
    });
    return group;
  }

  /** More than four options: a small menu under the value with a search
   *  field, arrow keys, Enter to choose, Esc to close. */
  private choiceMenu(r: SectionRow, opts: Array<{ value: string; name: string }>, cur: string, fk: string, commit: (v: string) => void, cancel: () => void): HTMLElement {
    const q = attrs(el('input', 'ow-menu-q') as HTMLInputElement, { type: 'text', placeholder: `Search ${opts.length} options`, 'aria-label': `Search ${r.label}`, autocomplete: 'off', spellcheck: 'false', 'data-ed': fk, 'data-fk': `${fk}:ed` });
    const list = attrs(el('div', 'ow-menu-list'), { role: 'listbox', 'aria-label': r.label });
    const empty = el('div', 'ow-quiet ow-menu-empty', 'No option matches.');
    let active = Math.max(0, opts.findIndex(o => o.value === cur));
    let shown = opts;
    let done = false;
    const choose = (v: string) => { if (done) return; done = true; if (v === cur) cancel(); else commit(v); };
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      shown = t ? opts.filter(o => o.name.toLowerCase().includes(t)) : opts;
      active = Math.min(active, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((o, i) => {
        const opt = attrs(el('div', `ow-menu-opt${i === active ? ' on' : ''}${o.value === cur ? ' cur' : ''}`, el('span', 'nm', o.name), o.value === cur ? icon('i-check', 'ic-sm') : ''), {
          role: 'option', 'aria-selected': String(i === active), id: `opt-${fk.replace(/\W/g, '-')}-${i}`,
        });
        opt.addEventListener('mousedown', e => { e.preventDefault(); choose(o.value); });
        return opt;
      }));
      empty.hidden = shown.length > 0;
      if (shown[active]) q.setAttribute('aria-activedescendant', `opt-${fk.replace(/\W/g, '-')}-${active}`);
      list.querySelector('.on')?.scrollIntoView?.({ block: 'nearest' });
    };
    attrs(q, { role: 'combobox', 'aria-expanded': 'true' });
    q.addEventListener('input', () => { active = 0; draw(); });
    q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active].value); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done = true; cancel(); }
    });
    q.addEventListener('blur', () => { if (q.isConnected && !done) { done = true; cancel(); } });
    draw();
    return attrs(el('div', 'ow-pop ow-menu-pop', el('div', 'ow-pop-h', el('div', 'ui-search', icon('i-search', 'ic-sm'), q)), list, empty,
      el('div', 'ow-phint', el('span', '', el('kbd', '', '↑'), el('kbd', '', '↓'), ' move'), el('span', '', el('kbd', '', 'Enter'), ' choose'), el('span', '', el('kbd', '', 'Esc'), ' close'))), {
      role: 'dialog', 'aria-label': `Choose ${r.label}`,
    });
  }

  /** Relations. `fold`: the data-object property list's foldable section
   *  (collapsed by default, read-only note once in the header); custom
   *  reference properties are drawn in their category sections there. */
  private relations(node: StructureNode, fold = false): HTMLElement | null {
    const obj = node.obj;
    const groups: Array<[string, string[]]> = [];
    if (obj) {
      const roles = Object.keys(obj.references).filter(r => obj.references[r].length && !HIDDEN_ROLES.test(r) && !(fold && isCustomKey(r)));
      const rank = (r: string) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? ROLE_ORDER.length : i; };
      roles.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      const labels = this.model?.labels[obj.type];
      for (const role of roles) {
        const label = isCustomKey(role) ? propLabel(obj, role, this.model?.labels, this.model?.summaries) : roleLabel(role, labels);
        groups.push([label, obj.references[role]]);
      }
    }
    if (node.children.length) groups.push([`Contains ${node.children.length}`, node.children]);
    const usedBy = obj && this.handlers.scanInbound ? this.usedBy(obj) : [];
    if (!groups.length && !usedBy.length) return null;
    const count = groups.reduce((n, [, rids]) => n + rids.length, 0);
    if (fold) {
      const st = this.state()!;
      const key = 'relations';
      const open = sectionOpen({ key, collapsed: true }, st.folds, 0);
      const body = el('div', 'ow-ps-body ow-ps-rel');
      for (const [title, rids] of groups) {
        body.append(el('div', 'ow-rel-h', title));
        for (const rid of rids) {
          const row = this.relRow(rid);
          row.dataset.hay = `${title} ${this.nameFor(rid).text} ${this.resolve(rid).businessId}`.toLowerCase();
          body.append(row);
        }
      }
      if (this.model?.summariesError) body.append(failedNote('Names of related objects could not be read.', this.model.summariesError, () => this.handlers.retry()));
      body.append(...usedBy);
      body.hidden = !open;
      return attrs(el('section', 'ow-ps-sec', this.foldHead(key, 'Relations', count, open, 0, RELATIONS_NOTE), body), { 'data-sec': key, 'data-open': String(open) });
    }
    const sec = count ? this.countedSection('Relations', count) : this.section('Relations');
    for (const [title, rids] of groups) {
      sec.append(el('div', 'ow-rel-h', title));
      for (const rid of rids) sec.append(this.relRow(rid));
    }
    if (this.model?.summariesError) sec.append(failedNote('Names of related objects could not be read.', this.model.summariesError, () => this.handlers.retry()));
    sec.append(...usedBy);
    return sec;
  }

  /** "Used by": what refers to this object, in two groups. "In code" comes
   *  at once from the local code index (the search window's "Used in code");
   *  "By reference" is the slow scan of every other reference, which the
   *  user starts, can cancel and run again. */
  private usedBy(obj: FullObject): HTMLElement[] {
    const out: HTMLElement[] = [el('div', 'ow-use-h', el('span', 't', 'Used by'))];
    out.push(...this.inCodeGroup(obj));
    const st = this.model?.inbound?.[obj.rid];
    const head = el('div', 'ow-use-h sub', el('span', 't', 'By reference'));
    out.push(head);
    if (!st) {
      head.append(el('span', 'ow-grow'), button('ow-link', 'Find the objects that refer to this one in any other way (properties, relations). The scan can take a while.',
        () => this.handlers.scanInbound?.(obj), icon('i-search', 'ic-sm'), 'Scan for other references'));
      return out;
    }
    if (st.phase === 'scanning') {
      head.append(el('span', 'ow-grow'), button('ow-link plain', 'Stop waiting for the scan', () => this.handlers.cancelInbound?.(obj.rid), icon('i-x', 'ic-sm'), 'Cancel'));
      out.push(attrs(el('div', 'ow-scan', attrs(el('span', 'ow-scan-bar'), { 'aria-hidden': 'true' }),
        el('span', 'ow-scan-t', this.elapsed(st.startedAt))), { role: 'status', 'data-since': String(st.startedAt) }));
      this.tickScans();
      return out;
    }
    const again = button('ui-ibtn', 'Scan again', () => this.handlers.scanInbound?.(obj), icon('i-retry'));
    if (st.phase === 'error') {
      head.append(el('span', 'ow-grow'), again);
      out.push(failedNote('The scan failed.', st.error, () => this.handlers.scanInbound?.(obj)));
      return out;
    }
    const total = Math.max(st.total ?? 0, st.targets.length);
    head.append(el('span', 'n', String(total)), el('span', 'ow-grow'),
      st.ms != null ? attrs(el('span', 'ow-use-ms', formatMs(st.ms)), { title: 'Scan time' }) : '', again);
    const scanCoverage = el('div', 'ow-quiet ow-note ow-coverage', coverageText({ kind: 'live', objects: 0, what: 'every reference in the workspace', at: st.ms != null && st.startedAt > 1e12 ? st.startedAt + st.ms : null, note: 'References built from text at run time are not found' }));
    // The answer in one line, above the groups.
    const code = this.model?.inCode?.[obj.rid];
    const sum = useSummary({
      inCode: code?.phase === 'done' ? code.targets.map(t => t.rid) : null,
      listed: st.targets.map(t => t.rid), total, ...(st.instances ? { instances: st.instances.total, instanceRids: st.instances.targets.map(t => t.rid) } : {}),
    });
    out.splice(1, 0, attrs(el('div', 'ow-use-sum', el('div', 'h', sum.headline), ...sum.notes.map(n => el('div', 'ow-quiet', n))), { 'data-found': String(sum.found), role: 'status' }));
    const linked = st.instances;
    if (!st.targets.length && !linked?.total) {
      out.push(el('div', 'ow-quiet ow-note', 'Nothing refers to this object.'), scanCoverage);
      return out;
    }
    const instanceRids = new Set(linked?.targets.map(t => t.rid));
    if (linked?.total) {
      out.push(el('div', 'ow-rel-h', `Instances ${linked.total}`));
      for (const t of linked.targets) out.push(this.relRow(t.rid));
      if (linked.total > linked.targets.length) out.push(el('div', 'ow-quiet ow-note', `Showing the first ${linked.targets.length} of ${linked.total}.`));
    }
    // Said before the rows: a long list hides a line below it.
    if (st.capped || total > st.targets.length) out.push(el('div', 'ow-quiet ow-note', `Showing the first ${st.targets.length} of ${total}.`));
    // Declared reverse references keep their field name; the rest group by type.
    const groups = new Map<string, InboundTarget[]>();
    for (const t of st.targets) {
      if (instanceRids.has(t.rid)) continue;
      const key = t.field || typeInfo(t.type).label || t.type || 'Other';
      const list = groups.get(key) ?? [];
      list.push(t);
      groups.set(key, list);
    }
    for (const [title, list] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      out.push(el('div', 'ow-rel-h', `${title} ${list.length}`));
      for (const t of list) out.push(this.relRow(t.rid));
    }
    return out;
  }

  private inCodeGroup(obj: FullObject): HTMLElement[] {
    if (!this.handlers.usedInCode) return [];
    const st = this.model?.inCode?.[obj.rid];
    if (!st) queueMicrotask(() => this.handlers.usedInCode?.(obj));
    const head = el('div', 'ow-use-h sub', attrs(el('span', 't', 'In code'), { title: 'Extended Code that calls this object: t.id, t.get("id"), {id}, lookup(RID). Comments and strings do not count.' }));
    const out: HTMLElement[] = [head];
    if (!st || st.phase === 'loading') { out.push(el('div', 'ow-quiet ow-note', 'Reading the code copy…')); return out; }
    const searchNow = (): HTMLElement => button('ow-link plain', 'Find the places in code: reads the code from the server and matches it in Companion', () => this.handlers.findReferences?.({ rid: obj.rid, name: obj.name, type: obj.type, businessId: obj.businessId }), icon('i-search', 'ic-sm'), SEARCH_NOW_LABEL);
    if (st.phase === 'unavailable') {
      // Without an index nothing is read by itself: the user starts a live
      // search on the server.
      out.push(el('div', 'ow-quiet ow-note ow-coverage', coverageText(st.coverage ?? { kind: 'not-searched', reason: 'no code copy on this computer' }), ' ', searchNow()));
      return out;
    }
    if (st.phase === 'error') {
      out.push(failedNote('The code copy could not be read.', st.error, () => this.handlers.usedInCode?.(obj)), el('div', 'ow-quiet ow-note ow-coverage', coverageText({ kind: 'not-searched', reason: 'the code copy could not be read' }), ' ', searchNow()));
      return out;
    }
    const places = st.targets.reduce((n, t) => n + t.places, 0);
    head.append(el('span', 'n', String(st.targets.length)), el('span', 'ow-grow'),
      button('ow-link plain', 'Open the places in the code search window', () => this.handlers.findReferences?.({ rid: obj.rid, name: obj.name, type: obj.type, businessId: obj.businessId }), icon('i-search', 'ic-sm'), `${places} ${places === 1 ? 'place' : 'places'}`));
    const coverage = st.coverage ? el('div', 'ow-quiet ow-note ow-coverage', coverageText(st.coverage)) : null;
    if (!st.targets.length) {
      out.push(el('div', 'ow-quiet ow-note', 'No code in the copy calls this object.'));
      if (coverage) out.push(coverage);
      return out;
    }
    for (const t of st.targets) out.push(this.relRow(t.rid));
    if (coverage) out.push(coverage);
    return out;
  }

  /** Tree row note of an InputSet once its "Used by" scan ran. */
  private viewUse(rid: string): string {
    const st = this.model?.inbound?.[rid];
    if (st?.phase !== 'done') return '';
    const views = st.targets.filter(t => t.type === 'InputView').length;
    if (views > 1) return `shared · used by ${views} views`;
    return views === 1 ? 'used by 1 view' : 'used by no view';
  }

  private elapsed(since: number): string {
    return `Scanning references · ${Math.max(0, Math.floor((Date.now() - since) / 1000))} s`;
  }

  /** One interval for every running scan; it stops when none is shown. */
  private tickScans(): void {
    if (this.scanTimer) return;
    this.scanTimer = window.setInterval(() => {
      const rows = this.detail.querySelectorAll<HTMLElement>('.ow-scan[data-since]');
      if (!rows.length) { window.clearInterval(this.scanTimer); this.scanTimer = 0; return; }
      for (const r of rows) {
        const t = r.querySelector('.ow-scan-t');
        if (t) t.textContent = this.elapsed(Number(r.dataset.since));
      }
    }, 1000);
  }

  /** A master property definition (not a per-type application of one). */
  private isPropertyDefinition(obj: FullObject): boolean {
    return isPropertyConfigClass(obj.type) && !obj.references.linkedTo?.length;
  }

  /** Property definition: the object types it is applied to, loaded on
   *  request (one reverse-reference read). */
  private applicationsSection(obj: FullObject): HTMLElement | null {
    if (!this.handlers.loadApplications || !this.isPropertyDefinition(obj)) return null;
    const st = this.model?.applications?.[obj.rid];
    const head = el('div', 'ow-sec-h ui-band', el('span', 't', 'Applied to'));
    const sec = el('section', 'ow-sec', head);
    if (!st) {
      head.append(el('span', 'ow-grow'), button('ow-link', 'Find the object types this property is applied to',
        () => this.handlers.loadApplications?.(obj.rid), icon('i-search', 'ic-sm'), 'Find applications'));
      return sec;
    }
    if (st.phase === 'loading') {
      sec.append(attrs(el('div', 'ow-scan', attrs(el('span', 'ow-scan-bar'), { 'aria-hidden': 'true' }), el('span', 'ow-scan-t', 'Loading applications')), { role: 'status' }));
      return sec;
    }
    const again = button('ui-ibtn', 'Load again', () => this.handlers.loadApplications?.(obj.rid), icon('i-retry'));
    if (st.phase === 'error') {
      head.append(el('span', 'ow-grow'), again);
      sec.append(attrs(el('div', 'ow-quiet ow-note', 'Applications could not be loaded.'), { title: st.error }));
      return sec;
    }
    head.append(el('span', 'n', String(st.total ?? st.list.length)), el('span', 'ow-grow'), again);
    if (!st.list.length) {
      sec.append(el('div', 'ow-quiet ow-note', 'Not applied to any object type.'));
      return sec;
    }
    const list = [...st.list].sort((a, b) => a.classId.localeCompare(b.classId));
    for (const app of list) sec.append(this.applicationRow(app, obj));
    if (st.truncated) sec.append(el('div', 'ow-quiet ow-note', `Showing the first ${list.length} of ${st.total ?? list.length}.`));
    return sec;
  }

  /** One application: object type · overrides · its ID. Overrides fold out. */
  private applicationRow(app: PropertyApplication, def: FullObject): HTMLElement {
    const fields = Object.entries(app.overrides);
    const a = app.application;
    const open = button('', `Open the ${app.classId} application as root`, e => { e.preventDefault(); e.stopPropagation(); this.handlers.navigate(a.rid); },
      app.classId || a.name || '(unnamed)');
    const cb = this.copyButton({ ...(a.businessId ? { businessId: a.businessId } : {}), rid: a.rid }, 'ui-ibtn ow-ri-copy');
    const row = el('div', 'ow-rel ui-row',
      el('span', 'rn', fields.length ? icon('i-chev', 'ow-app-chev') : el('span', 'ow-app-sp'), open),
      el('span', 'rt', fields.length ? `${fields.length} override${fields.length === 1 ? '' : 's'}` : 'inherited'),
      el('span', 'ow-ri', attrs(el('span', 'ow-sel', a.businessId || a.rid), { title: a.businessId ? `RID ${a.rid}` : undefined }), cb));
    if (!fields.length) return row;
    const grid = el('div', 'ow-grid ow-app-grid');
    for (const [field, literal] of fields) {
      const value = decodeEcLiteral(literal);
      const before = field === 'name' ? def.name : field === 'id' ? def.businessId : def.props[field]?.text ?? '';
      grid.append(el('div', 'gl', propLabel(def, field, this.model?.labels, this.model?.summaries)),
        el('div', 'gv', attrs(el('span', 'ow-val ow-sel ow-mono', value.split('\n')[0] || '(empty)'),
          { title: before ? `${value}\n\nDefinition: ${before}` : value })));
    }
    return el('details', 'ow-app', el('summary', 'ow-app-sum', row), grid);
  }

  private relRow(rid: string): HTMLElement {
    const r = this.resolve(rid);
    const info = typeInfo(r.type);
    const n = this.nameFor(rid);
    const nameText = r.known ? (r.name || '(unnamed)') : n.text;
    const name = r.inTree
      ? button('', undefined, () => this.select(rid, false), nameText)
      : r.known ? button('', `Open ${nameText} as root`, () => this.handlers.navigate(rid), nameText)
      : n.state === 'unknown' ? this.unreadName() : el('span', 'ow-pending', nameText);
    const cb = this.copyButton({ ...(r.businessId ? { businessId: r.businessId } : {}), rid }, 'ui-ibtn ow-ri-copy');
    const ri = el('span', 'ow-ri', attrs(el('span', 'ow-sel', r.businessId || rid), { title: r.businessId ? `RID ${rid}` : undefined }), cb);
    return el('div', 'ow-rel ui-row',
      el('span', `rn${r.known ? '' : ' un'}`, dot(r.known ? info.fam : '--text-placeholder'), name),
      el('span', 'rt', r.known ? (info.label || r.type) : ''),
      ri);
  }
}

/** Scan time: "850 ms", "4.2 s", "1 min 5 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Split `text` around the first case-insensitive match of `q` for <mark>. */
function mark(text: string, q: string): Node[] {
  if (!q) return [document.createTextNode(text)];
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return [document.createTextNode(text)];
  const m = document.createElement('mark');
  m.textContent = text.slice(i, i + q.length);
  return [document.createTextNode(text.slice(0, i)), m, document.createTextNode(text.slice(i + q.length))];
}
