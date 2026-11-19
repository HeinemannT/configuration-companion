import type { CommandAuthMode, IdentityMap } from './identity-map';
export type { CommandAuthMode, CommandAuthSource, EffectiveActor, IdentityMap } from './identity-map';
import type { AiSettings } from './ai/types';
export type { AiSettings };
// Style-prop catalog is single-sourced in style-props.ts and re-exported for
// back-compat with the many `from './types'` import sites.
import { PAINT_STYLE_PROPS, COLOR_LINK_PROPS, PAINT_PROP_RESET, STYLE_PROPS, styleResetLiteral } from './style-props';
export { PAINT_STYLE_PROPS, COLOR_LINK_PROPS, PAINT_PROP_RESET, STYLE_PROPS, styleResetLiteral };
// The message union and the type-color/abbreviation registry are single-sourced in
// messages.ts / type-registry.ts respectively; re-exported below for back-compat with
// the many `from './types'` import sites.
import { CHART_TYPES } from './type-registry';
export * from './messages';
export * from './type-registry';

/** Unified connection state — single source of truth for health + auth */
export interface ConnectionState {
  display: 'not-configured' | 'checking' | 'reconnecting' | 'connected' | 'online' | 'identity-mismatch' | 'command-failed' | 'auth-failed' | 'server-down' | 'unreachable' | 'needs-login' | 'no-config-access' | 'needs-access' | 'not-workspace' | 'needs-password';
  /** Verified portal and Configuration Studio actors. */
  identities: IdentityMap;
  version: string | null;
  /** Blueprint requires EC lookup(). Missing means capability is not yet known. */
  blueprintSupported?: boolean;
  responseMs: number | null;
  profileLabel: string | null;
  workspace: string | null;
  authError: string | null;
  /** Underlying error text for the current non-working state (health or
   * authentication), shown on request beside the plain-language sentence. */
  detail?: string | null;
  networkOffline: boolean;
  lastUpdate: number;
  /** Validation is quiet metadata. A matching confirmed display remains in
   * place while stale evidence is checked. */
  validation?: 'idle' | 'validating';
  /** Time of the latest confirmed command/reachability evidence. */
  verifiedAt?: number | null;
  /** Changes only when the semantic projection changes; timestamps alone do
   * not churn panel/content/storage publications. */
  semanticRevision?: number;
  /** Epoch of the currently active confirmed incident, or 0 when healthy. */
  incidentEpoch?: number;
  /** Latest incident epoch that subsequently recovered, or 0. */
  recoveryEpoch?: number;
  /** The view's own profile + resolved server identity. Writable views retain
   * this token and the service worker rejects saves after an environment change. */
  environment?: string;
}

/** Metadata about a BMP object discovered via DOM, fiber, or server */
export interface BmpObject {
  rid: string;
  name?: string;
  type?: string;
  typename?: string;
  businessId?: string;
  templateBusinessId?: string;
  /** True once the server identity query has resolved both the concrete
   * instance and its optional template. Distinguishes "no template" from
   * "this quick-search/DOM record has not been enriched yet". */
  identityEnriched?: boolean;
  /** When the server identity was read (ms). The cache lifetime counts from
   *  here, so rediscovering the object on a page does not extend it. */
  enrichedAt?: number;
  /** Cascade target for flow-bearing widgets (InputView → inputSet,
   *  ActionButton → actionObject). Surfaced on the badge as a second pill so
   *  the chain shape is visible without opening the sidebar. */
  cascade?: { rid: string; businessId?: string; type?: string; name?: string };
  webParentRid?: string;
  /** Breadcrumb context from a live quickSearch hit: the object's web parent
   *  and the page it lives on. Lets Browse disambiguate same-named objects. */
  webParentName?: string;
  pageRid?: string;
  pageName?: string;
  tabRid?: string;
  hasChildren?: boolean;
  properties?: Record<string, unknown>;
  treePath?: string[];
  source: ObjectSource;
  discoveredAt: number;
  updatedAt: number;
}

type ObjectSource = 'dom' | 'fiber' | 'server';

/** Messages between content script, interceptor, and service worker.
 *  Grouped by domain — each group is a standalone type for narrowing in handlers.
 *  The message union itself lives in ./messages (re-exported below for back-compat). */

// ── Page context ─────────────────────────────────────────────────

/** Which provider supplied the resolved page object. `none` = no provider
 *  had one (truly contextless page). Ordered by authority in resolution. */
export type PageContextSource = 'url' | 'fiber' | 'dom' | 'none';

/** The single answer to "what object is BMP rendering right now, in what tab".
 *  Resolved once (URL ⊕ fiber ⊕ DOM) and shared by every surface —
 *  footer/status chip, Browse's Here tree, and the editor's EC execution `this` — so they
 *  can't drift apart. `rid` granularity matches `?rid=`: a scorecard on a
 *  landing page, an enterprise object on a detail page. */
export interface PageContext {
  rid?: string;
  tabRid?: string;
  tabName?: string;
  source: PageContextSource;
}

/** Identity carried by BMP's create/edit React surface. This is deliberately
 * separate from PageContext: `editPageRid` identifies the form definition,
 * while PageContext continues to identify the bound business object used by
 * Blueprint and EC execution. */
export interface EditPageContext {
  editPageRid: string;
  initializerRid?: string;
  templateRid?: string;
  webParentRid?: string;
  parentRid?: string;
  objectRid?: string;
  objectName?: string;
  objectType?: string;
  /** Rendered property editors in DOM order. `key` is BMP's stable index in
   *  the EditPage field stream; Inspect uses it to join a native form control
   *  back to its EditField configuration without inventing DOM RIDs. */
  fields?: EditPageFieldContext[];
}

export interface EditPageFieldContext {
  kind?: 'field' | 'info';
  key?: number;
  propertyRef?: string;
  /** Configuration RID carried by an EditPageInfo React slot. */
  objectRef?: string;
  displayName?: string;
  pageIndex?: number;
  columnIndex?: number;
}

export interface EditFieldPropertyResolution {
  /** Exact accessor stored in EditField.propertyMapping. */
  accessor: string;
  /** Stable master property configuration under root.property. */
  property: ObjectPaneIdentity;
}

/** One ClassConfig application of a master property. The application is a
 * delta over the master: an empty `overrides` object means every field
 * inherits live from the property definition. */
export interface PropertyApplication {
  /** Short BMP object-type ID, e.g. `CeRiskAssessment`. */
  classId: string;
  /** Real ClassConfig child, retained as an addressable BMP object. */
  application: ObjectPaneIdentity;
  /** Explicit per-class delta as emitted by application.genedit(). Values are
   * EC literals so code/string/list fidelity is preserved across the wire. */
  overrides: Record<string, string>;
}

export interface TypeSchemaProp {
  /** EC accessor (e.g. `domain_tags`). The exact string a script writes
   *  after `_obj.` to read the property. Resolved via the two-step
   *  `.as(linkedTo).as(id)` chain — NOT `.as(linkedTo.id)` which is a
   *  similar-looking EC expression that returns DISPLAY names. */
  accessor: string;
  /** Display label shown in BMP's UI (e.g. "Domain Tags"). */
  label: string;
  /** The property-config class (e.g. `TagMethodConfig`,
   *  `ReferenceMethodConfig`). Drives the kind chip in the UI. */
  configClass: string;
  /** True for BMP built-in props (id, name, parent, …). The Vars panel
   *  filters these out by default; toggling the filter is instant
   *  because the data was already fetched. */
  systemobject: boolean;
  /** Optional help text supplied by BMP's concrete-object `help()` output. */
  description?: string;
  /** Stable master MethodConfig identity under `root.property`. Present on
   * the ClassConfig enumeration path; absent on the `help()` fallback. */
  propertyRid?: string;
  propertyId?: string;
  /** Concrete class of the linked master property (e.g.
   * `ReferenceMethodConfig`). This intentionally differs from `configClass`,
   * which describes the per-object-type ClassConfig application. */
  propertyConfigClass?: string;
}

/** One allowed value of a list/tag property — a ListPropertySetItem or Tag,
 *  addressable in EC as `t.<businessId>`. */
export interface TypeOptionItem {
  /** EC reference form, e.g. `t.master`. Emitted verbatim by value autocomplete
   *  (a literal string would match the display NAME, not the id — fragile). */
  ref: string;
  /** Display name shown as the completion detail (e.g. "Master"). */
  name: string;
}

/** A list/tag property's option set, resolved from its ListPropertySet
 *  (list/historical-list) or TagList (tag). */
export interface TypeOptionSet {
  /** The property accessor the options belong to (e.g. `subtype`). */
  accessor: string;
  /** True for multi-value tag properties — they compare with CONTAINS / IN,
   *  not = / != (single-select lists). */
  multi: boolean;
  items: TypeOptionItem[];
}

/** The three CVO child kinds, by what they populate in `_data`. */
export type StudioChildType = 'expression' | 'table' | 'connection'

/** The type-specific fields of a CVO child that STUDIO_SAVE_CHILD writes. */
export type StudioChildField = 'expression' | 'table' | 'url' | 'urlParameters' | 'headers' | 'timeout'

export interface StudioChild {
  /** rid as a string (Java long — never a JS number). */
  rid: string
  /** businessId. */
  id: string
  /** Which `_data.*` map this populates. */
  type: StudioChildType
  /** JS-side key → `_data.<type-map>[key]`. */
  key: string
  /** expression: Reporter-token text → _data.expressions[key]. */
  expression?: string
  /** table: referenced table's business id → _data.tables[key]. */
  table?: string
  /** connection: upstream config → _data.serverConnections[key] (a proxy path). */
  url?: string
  urlParameters?: string
  headers?: string
  timeout?: string
}

// Frame kinds are the in-page iframe surfaces.
export type FrameKind = 'editor' | 'diff' | 'objectview' | 'codesearch' | 'transport' | 'cvo-studio';
/** Optional in-place intent for an already-open frame. Today the editor uses
 * this to switch code properties without reloading and losing slot drafts. */
export type FrameActivation = EditorFrameActivation | ObjectWindowFrameActivation | CodeSearchFrameActivation | CompareFrameActivation | TransportFrameActivation;

/** Transport window: the tab to show when it is opened or brought forward. */
export interface TransportFrameActivation {
  type: 'transport';
  tab: 'find' | 'transport' | 'numeric';
}

/** Object window: navigate the live frame to another root (in-frame history). */
export interface ObjectWindowFrameActivation {
  type: 'objectview';
  rid: string;
  /** Title hint from the enrichment cache; painted before the read lands. */
  name?: string;
  objectType?: string;
  businessId?: string;
  /** Select `rid` in the live tree (or hang it under `from`) instead of
   *  opening it as root. The Extended Code window's "Open". */
  reveal?: boolean;
  from?: { rid: string; line?: number };
  focus?: ObjectWindowFocus;
  origin?: ObjectWindowOrigin;
  /** A change to stage in the window's own draft, for the user to review and save there. */
  draft?: ObjectWindowDraft;
}

/** One property change opened in the object window as a draft (Point and tell). */
export interface ObjectWindowDraft { prop: string; value: string }

/** A property and line to land on in the object window. */
export interface ObjectWindowFocus { prop: string; line: number }

/** The search that opened the object window: the first trail step; Back
 *  from the first step returns to it. */
export interface ObjectWindowOrigin {
  kind: 'search';
  /** "Search: today", "References: Assessment basis values". */
  label: string;
  mode: 'text' | 'refs';
  query?: string;
}

/** Code search window: what to show when it is opened or brought forward. */
export interface CodeSearchFrameActivation {
  type: 'codesearch';
  query?: string;
  /** The replace tab: the text to put in place of `query`. */
  replace?: string;
  mode?: 'text' | 'refs' | 'replace';
  scope?: { rid: string; name?: string; type?: string; businessId?: string };
  target?: { rid: string; name?: string; type?: string; businessId?: string };
  context?: { rid: string; name?: string; type?: string; businessId?: string };
  restore?: boolean;
}

/** Compare window: side A, and side B or the picker for it. */
export interface CompareFrameActivation {
  type: 'diff';
  left: { rid: string; name?: string; type?: string; businessId?: string };
  right?: { rid: string; name?: string; type?: string; businessId?: string };
}

export interface EditorFrameActivation {
  type: 'editor';
  rid: string;
  property?: string;
  scrollToLine?: number;
  scrollToText?: string;
  /** The whole new text of `property`, to show as a diff (Point and tell). */
  proposal?: string;
}

/** Result of asking the content script to mount a frame. Callers that prepare
 * one-shot launch state use this to distinguish a cold mount from activating
 * an already-live, draft-preserving frame. */
export type FrameMountDisposition =
  | 'mounted'
  | 'activated'
  | 'replacement-pending'
  | 'superseded'
  | 'dropped'
  | 'failed';

// ── History ──────────────────────────────────────────────────────
export interface HistoryEntry {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  templateBusinessId?: string;
  action: 'viewed' | 'edited' | 'ec-executed';
  timestamp: number;
}

// ── Favorites ────────────────────────────────────────────────────
export interface FavoriteEntry {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  templateBusinessId?: string;
  addedAt: number;
}

/** A flat node in a layout projection. Parent linkage is via `parentRid`;
 *  consumers fold these into a tree client-side. The portal-tree fetch
 *  returns only TabSet/Tab/Container; Blueprint's dual-model fetch can
 *  additionally carry page-owned widget nodes via `containerRid`. */
export interface LayoutNode {
  rid: string;
  parentRid?: string;
  /** Layout owner that hosts this node — for widgets, the cell they
   *  bind to via `container :=`. Null for the root + top-level nodes. */
  containerRid?: string;
  businessId?: string;
  name?: string;
  type: string;
  /** Responsive column sizing (1..6). Set for Tab + Container + any
   *  widget that carries it. Undefined for TabSet (no grid of its own). */
  columnsLargeScreen?: number;
  columnsMediumScreen?: number;
  columnsSmallScreen?: number;
  /** Authored chart/URLView height in px — needed so the blueprint edits from the real value
   *  rather than a default (otherwise a height edit overwrites the live height). */
  chartHeight?: number;
  /** Enterprise object classes whose properties a DescriptionView renders (`viewTypes`).
   *  Blueprint fetches this on a dedicated marker; absent on every other widget type. */
  viewTypes?: string[];
  /** Ordered DescriptionView property accessors (`sortVisibility`). */
  sortVisibility?: string[];
}

// ── BMP object identity ─────────────────────────────────────────
/** Canonical resolved identity shared by every extension surface.
 *  RIDs remain strings because BMP uses 64-bit Java longs. */
export interface ObjectIdentity {
  rid: string;
  businessId: string;
  type: string;
  name: string;
  /** Reusable definition identity, when the concrete object is template-backed. */
  templateBusinessId?: string;
}

/** Sparse identity accepted at UI boundaries while enrichment is pending. */
export type ObjectReference = Pick<ObjectIdentity, 'rid'> &
  Partial<Omit<ObjectIdentity, 'rid'>> & {
    templateBusinessId?: string;
  };

/** Compatibility name for pane-specific payloads. New shared UI should use
 *  ObjectIdentity / ObjectReference rather than inventing another shape. */
export type ObjectPaneIdentity = ObjectIdentity;

/** An object's effective detail card, plus whether it was inherited from the
 *  object's template (enterprise objects carry the card on their template,
 *  not the instance). Part of ObjectPaneData. */
export type ObjectPaneCard = ObjectPaneIdentity & { viaTemplate: boolean };

// ── Access Trace (admin permission test) ─────────────────────────

export type AccessTraceAction = 'READ' | 'UPDATE' | 'DELETE' | 'CREATE';

/** One node of the PBAC decision tree returned by AccessTraceCommand.
 *  `element` is the node kind (TraceRequest / Statement / Subject / Action /
 *  HasAccessTo / All / Any / Equal / Contains…), `result` is whether access is
 *  granted at this node (null when not a boolean leaf), `details` is the
 *  type-specific "why" (e.g. Statement → policyRid / statementIndex). */
export interface AccessTraceNode {
  element: string;
  result: boolean | null;
  timedOut: boolean;
  /** BMP's elapsed time for this node, including nested evaluations. */
  durationMs?: number;
  details: Record<string, string>;
  children: AccessTraceNode[];
}

/** A user or role that can be tested as the trace subject. */
export interface AccessSubject {
  rid: string;
  name: string;
  kind: 'user' | 'role';
  businessId?: string;
}
export interface ObjectPaneSiblingMsg {
  rid: string;
  businessId: string;
  name: string;
  type: string;
  isCurrent: boolean;
}

/** Canonical serializable object-pane payload shared by the query service,
 * runtime message, handler, and inspector views. */
export interface ObjectPanePayload {
  instance: ObjectPaneIdentity;
  parent: ObjectPaneIdentity | null;
  template: ObjectPaneIdentity | null;
  card: ObjectPaneCard | null;
  instanceProps: Record<string, string>;
  templateProps: Record<string, string>;
  instanceOverrideProps: string[];
  siblings: ObjectPaneSiblingMsg[];
  siblingTotal: number;
  codeFields: Record<string, string>;
  isPropertyDefinition: boolean;
  references: Record<string, ObjectPaneIdentity | null>;
  indirectCode: Record<string, string>;
  indirectCodeRids: Record<string, string>;
  contextValues: Record<string, string>;
  gateValues: Record<string, string>;
  lists: Record<string, ObjectPaneIdentity[]>;
  editFieldClassNames?: string[];
  editFieldProperty?: EditFieldPropertyResolution;
  editFieldPropertyError?: string;
  propertyApplications?: PropertyApplication[];
  propertyApplicationsError?: string;
  propertyApplicationsTotal?: number;
  propertyApplicationsTruncated?: boolean;
}
// ── Connections (generic reference relationships) ───────────────────

/** A resolved endpoint of a relationship edge. */
export interface ConnTarget {
  rid: string;
  name: string;
  type: string;
  businessId: string;
  /** The rid resolved to nothing (dangling/deleted reference). */
  broken?: boolean;
  /** Junction far-side (C2): the object on the other side of a thin junction. */
  via?: ConnTarget;
}

/** One relationship field and its current endpoints. */
export interface ConnGroup {
  field: string;
  label: string;
  /** out = forward ref (this → target); in = reverse ref (target → this). */
  direction: 'out' | 'in';
  targets: ConnTarget[];
  /** More reverse-reference targets exist than were safe to return. */
  capped?: boolean;
}

// ── Code Search ──────────────────────────────────────────────────
export interface CodeSearchResult {
  rid: string; name?: string; type?: string; businessId?: string;
  property: string;
  matchingLines: Array<{ lineNum: number; text: string }>;
}

// ── Script History ───────────────────────────────────────────────
export interface ScriptHistoryEntry {
  code: string; timestamp: number; ok: boolean; mode: 'preview' | 'execute'; durationMs?: number;
}

// ── Colors (linked CorpoColor picker) ────────────────────────────
// BMP widget colors (headerColor / fontColor / bgColor) are LINKS to
// CorpoColor objects in CorpoColorSets, not hex strings — so they're picked
// from a list, not typed. The picker fetches the workspace's colorsets once.
export interface ColorOption { bid: string; name: string; rgb: string }
/** `folder` = businessId of the Category the set lives in ('ColorRoot' for the system sets) —
 *  used to order workspace-custom sets ahead of the stock palette in the pickers. */
export interface ColorSetData { id: string; name: string; colors: ColorOption[]; folder?: string }

export interface WidgetInfo {
  rid: string;
  name?: string;
  type?: string;
  element?: string;
  rect?: { top: number; left: number; width: number; height: number };
}

export type SaveTarget = 'template' | 'instance';
export type EnrichMode = 'widgets' | 'all';

export interface ServerProfile {
  id: string;
  label: string;
  bmpUrl: string;
  /** Stored command credentials. Empty when commands use the portal login. */
  bmpUser: string;
  bmpPass: string;
  /** Explicit identity used for Configuration Studio commands. */
  commandAuthMode: CommandAuthMode;
  /** Rotated whenever command auth material changes. */
  commandAuthRevision?: string;
  /** Set when the stored password could not be decrypted in this browser
   *  (for example, an unpacked build loaded from another folder has a new
   *  extension ID and therefore a new key). The unreadable value is dropped,
   *  never sent or saved again; the user must enter the password again. */
  passwordUnreadable?: boolean;
  /** Settings sent to any page never carry the stored password: `bmpPass` is
   *  empty there and this flag says whether one is stored (redactSettings). */
  hasStoredPassword?: boolean;
  /** SAVE_PROFILE only: remove the stored password. An empty `bmpPass` on
   *  an existing profile otherwise means "keep the stored one". */
  clearPassword?: boolean;
}

export interface InspectorSettings {
  schemaVersion: number;
  profiles: ServerProfile[];
  activeProfileId: string;
  /** One-time notices for legacy auto profiles migrated to stored commands. */
  commandAuthMigrationNotices?: Array<{ profileId: string; user: string }>;
  autoDetect: boolean;
  saveTarget: SaveTarget;
  enrichMode: EnrichMode;
  /** AI coding-assistant config. Absent until the user configures a provider
   *  + key in the Connect tab. The API key inside is stored AES-GCM encrypted;
   *  it is stripped from the session snapshot (see snapshotSettings). */
  ai?: AiSettings;
}

export const DEFAULT_SETTINGS: InspectorSettings = {
  schemaVersion: 4,
  profiles: [],
  activeProfileId: '',
  autoDetect: true,
  saveTarget: 'template',
  enrichMode: 'widgets',
};

/** Activity feed entry */
/** `action` of the Log entry that says background work paused for the
 *  script count: it offers "Server was restarted". */
export const SCRIPT_PAUSE_ACTION = 'script-pause';
/** `action` of the Log entry that says that pause ended (the count fell, the
 *  server restarted, or the user reset the count). */
export const SCRIPT_RESUME_ACTION = 'script-resume';
export type ActivityCategory = 'execution' | 'change' | 'blueprint' | 'studio' | 'connection' | 'system';

export interface ActivityMeta {
  /** Explicit origin for work that may finish after a profile switch. */
  profileId?: string;
  category: ActivityCategory;
  action?: string;
  object?: ObjectReference;
  durationMs?: number;
  /** Verified command actor at the time of the operation. */
  commandActor?: string;
  commandAuthSource?: import('./identity-map').CommandAuthSource;
}

export interface ActivityEntry {
  id: number;
  time: number;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  detail?: string;
  /** Structured metadata keeps filtering cheap and avoids parsing display copy. */
  category?: ActivityCategory;
  action?: string;
  object?: ObjectReference;
  durationMs?: number;
  commandActor?: string;
  commandAuthSource?: import('./identity-map').CommandAuthSource;
  /** Profile the action ran against. Used to filter the Log tab when
   *  the user has multiple environments configured. Missing on legacy
   *  entries — UI treats them as belonging to the active profile. */
  profileId?: string;
  /** How many times a repeated diagnostic happened (merged entries only). */
  count?: number;
  /** Side panel only, never stored: when the condition this warning reported
   *  ended (a script pause followed by its resume, log-model.ts). */
  endedAt?: number;
}

/** Detection state machine phases */
export type DetectionPhase = 'unknown' | 'checking' | 'detected' | 'not-detected';

/** Property names that contain code/scripts (ordered: primary first) */
export const SCRIPT_PROPS = [
  'expression', 'html', 'javascript',
] as const;

/** Map from BMP type → code property names to fetch/save.
 *  All HasExtendedExpression types use 'expression' (CorpoExtendedExpression).
 *  CustomVisualization uses plain String properties 'html' and 'javascript'.
 *
 *  For ActionButton / ButtonInput / Label we list only the DIRECT string
 *  props (`expression`, `initExpression`, `afterExpression`, `defaultExpression`).
 *  Their `showExpression` / `enableExpression` / `validateExpression` are
 *  References to an ExtendedExpression whose `.expression` carries the EC
 *  text — that surface is covered by adding ExtendedExpression itself,
 *  which catches every indirect gate-EC at the source. */
export const CODE_PROPS_FOR_TYPE: Record<string, readonly string[]> = {
  ExtendedTable: ['expression'],
  ExtendedMethodConfig: ['expression'],
  ...Object.fromEntries(CHART_TYPES.map(t => [t, ['expression'] as readonly string[]])),
  CustomVisualization: ['html', 'javascript'],
  ActionButton: ['expression', 'initExpression', 'afterExpression'],
  ButtonInput: ['expression', 'initExpression', 'afterExpression', 'defaultExpression'],
  Label: ['defaultExpression', 'expression'],
  ExtendedTransport: ['expression'],
  ExtendedExpression: ['expression'],
  // The two sanitized HTML bodies (no EC slots on this type) — also makes
  // Code Search cover TextElement content.
  TextElement: ['text', 'longText'],
};

/** Types that have viewable/editable code properties */
export const TYPES_WITH_CODE = new Set(Object.keys(CODE_PROPS_FOR_TYPE));
