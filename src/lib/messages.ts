// Message union — extracted from types.ts (Plan 012). Groups every InspectorMessage
// sub-type by domain; each group is a standalone type for narrowing in handlers.
// Re-exported from './types' for back-compat. Imports domain interfaces from './types'
// (type-only) — messages depend on types, never the reverse.
import type { AccessRequest } from './access-workspace/model';
import type { AccessDestination } from './access-workspace/entry';
import type { ActionVerdicts } from './access-mode';
import type { CustomChange, ListItem, TypePropertySchema } from './property-schema';
import type { ChangeInput, ChangeRecord } from './change-record';
import type {
  AccessSubject,
  AccessTraceAction,
  AccessTraceNode,
  ActivityEntry,
  BmpObject,
  ColorSetData,
  ConnGroup,
  ConnTarget,
  ConnectionState,
  DetectionPhase,
  EnrichMode,
  FavoriteEntry,
  FrameActivation,
  FrameKind,
  HistoryEntry,
  InspectorSettings,
  LayoutNode,
  ObjectWindowFocus,
  ObjectWindowOrigin,
  PropertyApplication,
  PageContextSource,
  ScriptHistoryEntry,
  ServerProfile,
  StudioChild,
  StudioChildType,
  StudioChildField,
  TypeOptionSet,
  TypeSchemaProp,
  EditPageContext,
  WidgetInfo,
} from './types';
import type { IdentityPatch, IdentitySaveResult } from './object-identity';
import type { ValueChange } from './save-check';

/** How a sending window names an object, for the Log sentence only. */
export interface ObjectLabel { name?: string; businessId?: string; type?: string }
import type { EcOutputEntry } from './bmp-types';
import type { FullObject, ObjectSummary, ValueKind } from './object-read';
import type { ObjectRootPayload } from './object-window';
import type { RefResolution } from './code-ref-resolve';
import type { StructureRow } from './object-structure';
import type { CompareRead, SuggestRow } from './compare-read';
import type { FoundObject } from './object-search';
import type { BrowseTree, ObjectHit } from './browse-tree';

/** What set a tab's current position (lib/current-position.ts). */
export type PositionSource = 'badge' | 'contextmenu' | 'window' | 'picker';
import type { JsonShape } from './json-shape';
import type { AiCustomProvider, AiProviderId, AiRequestPayload, AiChatTurn, AiChatEvent, AiChatQuote, AiContextEnvelope, AiContextSource } from './ai/types';
import type { AiChangeProposal } from './ai/change-ticket';
import type { LModel, PlanNote, NodeStyle, FlowNode } from './layout/types';
import type { StylePreset } from './style-presets';
import type { BlueprintCtx, FlowRefListItem } from './layout/sync';
import type { PortableIdConfig, PortableIdPlan, PortableIdRequest } from './layout/portable-ids';
import type { InstanceFanout, ContainerBlast, FlowContainerBlast } from './layout/blast-radius';

// ── Page & Object Discovery ──────────────────────────────────────
export type PageMessage =
  | { type: 'OBJECTS_DISCOVERED'; objects: BmpObject[] }
  | { type: 'GET_PAGE_INFO' }
  // Worker → content script: the bound object only (no widget scan, no object walk).
  | { type: 'GET_PAGE_CONTEXT' }
  | { type: 'PAGE_INFO'; url: string; rid?: string; tabRid?: string; tabName?: string; contextSource?: PageContextSource; editContext?: EditPageContext; widgets: WidgetInfo[]; detection?: { confidence: number; signals: string[]; isBmp: boolean } }
  // Page context from the MAIN-world interceptor (React fiber). On BMP's
  // custom-routed pages the bound object lives only in the fiber
  // (`webParentRid` / `selectedTabRid`), never in the URL/DOM. The interceptor
  // posts this to the content script, which both resolves it locally (Page
  // tab) and forwards it to the SW (footer + editor EC `this`).
  | { type: 'PAGE_CONTEXT'; rid?: string; tabRid?: string }
  | { type: 'EDIT_PAGE_CONTEXT'; context?: EditPageContext }
  // Content-script signal: BMP did an SPA route change (URL param flipped).
  // SW forwards by re-running sendPageInfoToPanel so the Page tab's widget
  // list refreshes — without this, post-route widgets show grey "?" until
  // the user clicks Refresh or switches panel tabs.
  | { type: 'BMP_URL_CHANGED' }
  // The rendered page changed without changing its owner/route (React mounted,
  // widgets were replaced, or an in-page tab switched). Refresh visible page
  // information, but preserve the user's explicit object selection.
  | { type: 'BMP_PAGE_RENDER_CHANGED' }
  | { type: 'GET_CONTEXT_RID' }
  // The tab's current position: the object the user last pointed at (badge
  // click, right-click, object window), else the page's bound object.
  // `source` is absent for the page fallback (see lib/current-position.ts).
  | { type: 'CONTEXT_RID_DATA'; rid?: string; name?: string; objectType?: string; businessId?: string; source?: PositionSource }
  | { type: 'COPY_TO_CLIPBOARD'; text: string };

// ── Inspect Toggle ───────────────────────────────────────────────
export type InspectMessage =
  | { type: 'TOGGLE_INSPECT' }
  | { type: 'SET_INSPECT_STATE'; active: boolean }
  | { type: 'INSPECT_STATE'; active: boolean }
  // Standalone create/edit routes render native property editors without
  // data-rid attributes. Resolve the owning EditPage's ordered EditFields so
  // the content script can badge those controls like normal page widgets.
  | { type: 'INSPECT_EDIT_PAGE_FIELDS'; editPageRid: string }
  | {
      type: 'INSPECT_EDIT_PAGE_FIELDS_RESULT';
      ok: boolean;
      fields?: Array<{
        rid: string;
        businessId: string;
        name: string;
        className: 'EditField' | 'EditPageInfo';
        /** Index in the complete EditPage child stream, including break/info rows. */
        streamIndex: number;
        property?: string;
        propertyObject?: {
          rid: string;
          businessId?: string;
          name?: string;
          type?: string;
        };
      }>;
      error?: string;
    };

// ── Cache ────────────────────────────────────────────────────────
export type CacheMessage =
  | { type: 'GET_CACHE'; filter?: string }
  // `filter` echoes the GET_CACHE filter so a consumer can drop a late/reordered
  // response that no longer matches the current query.
  | { type: 'CACHE_DATA'; objects: BmpObject[]; filter?: string }
  // Live workspace search via BMP's GraphQL quickSearch (the engine the web
  // portal's search box uses). gen guards against out-of-order responses.
  | { type: 'BROWSE_SEARCH'; query: string; page?: number; pageSize?: number; gen: number }
  // `page` echoes the request's page (1 when absent): a page answers twice
  // (fast hits, then the identity pass), so the panel must know which page.
  | { type: 'BROWSE_SEARCH_RESULT'; query: string; gen: number; page?: number; ok: boolean; objects?: BmpObject[]; totalHits?: number; error?: string }
  // Browse tab (handlers/browse.ts). The page's structure for the Here tree.
  // Answers in up to three steps on the panel port: the crumbs alone (no
  // tree), the page's own rows (tree.presented 'loading' while a data
  // object's presenting template is read), then the whole tree.
  | { type: 'BROWSE_TREE'; rid: string; typeHint?: string }
  | { type: 'BROWSE_TREE_DATA'; rid: string; environment: string; ok: boolean; tree?: BrowseTree; crumbs?: import('./browse-tree').BrowseCrumb[]; error?: string; errorKind?: import('./error-kind').BmpErrorKind }
  // Exact RID or business ID typed into the search: one read or one EC lookup.
  | { type: 'BROWSE_RESOLVE'; query: string; gen: number }
  | { type: 'BROWSE_RESOLVE_RESULT'; query: string; gen: number; ok: boolean; object?: ObjectHit; error?: string }
  // Scroll the first of `rids` found on the page into view and ring it. The
  // content script answers with the rid it found (an ancestor when the object
  // itself has no element), or null.
  | { type: 'LOCATE_ON_PAGE'; rids: string[] }
  | { type: 'LOCATE_RESULT'; rid: string; found: string | null }
  | { type: 'CLEAR_CACHE' }
  // Reset everything except user-facing preferences (favorites, settings).
  // Use this when the extension is in a bad state and you want a clean slate
  // without re-configuring servers. Clears: object cache, enrichment state,
  // activity log, compare pivot, context rid per tab, in-flight fetches.
  | { type: 'RESET_ALL' }
  | { type: 'CACHE_STATS'; count: number }
  // Storage quota warning — SW failed to persist the object cache because
  // chrome.storage.local hit the 10 MB ceiling. Panel surfaces a small
  // banner so the user can hit Reset / Clear instead of staring at silent
  // stale data.
  | { type: 'CACHE_QUOTA_WARNING'; size: number }
  // Approximate byte size of the persisted cache — requested on demand by
  // the Connect tab so it can show "N cached · ~X MB".
  | { type: 'GET_CACHE_BYTES' }
  | { type: 'CACHE_BYTES'; bytes: number }
  // In-place BMP navigation: the content script clicks the matching tab
  // button (no reload) and scroll-and-highlights the target widget. Sent by
  // the Extended Code editor's "go to this object" action.
  | { type: 'BMP_GOTO'; bmpTabId?: number; rid?: string; tabRid?: string; tabName?: string }
  // Open a top-level object (a card / page / scorecard) in the BMP portal by
  // navigating the tab to ?rid=<rid>. Unlike BMP_GOTO (which highlights a widget
  // on the CURRENT page), this loads the object's own page.
  // Hard-reload the BMP tab. Out-of-band EC writes (property/colour/style
  // edits from the object window) do NOT re-render BMP's React DOM — verified
  // live: the committed change is invisible until a full page reload. So
  // after a successful save we offer a one-click reload; the SW reloads the
  // active BMP tab (mirrors BMP_GOTO's tab resolution).
  | { type: 'RELOAD_BMP_TAB'; bmpTabId?: number };

// ── Object lookup (hover cards, type knowledge) ──────────────────
export type ServerLookupMessage =
  | { type: 'HOVER_LOOKUP'; rid: string; environment?: string }
  | { type: 'HOVER_LOOKUP_RESULT'; rid: string; name?: string; objectType?: string; businessId?: string; templateBusinessId?: string; codePreview?: string }
  | { type: 'HOVER_RESOLVE'; ref: string }
  | { type: 'HOVER_RESOLVE_RESULT'; ref: string; name?: string; objectType?: string; rid?: string; businessId?: string; codePreview?: string; /** The server has no such object: the sentence to show ("No object t.x on this server."). */ missing?: string }
  // Type-schema lookup powering the Vars + Properties panel in the
  // extended-code editor. One round trip per class returns every
  // property (system + custom) with its EC accessor, display label,
  // and config-class. Cached in the SW; refresh=true bypasses the
  // cache and re-fetches. See type-schema-cache.ts.
  | { type: 'FETCH_TYPE_SCHEMA'; className: string; refresh?: boolean; exampleRef?: string }
  | { type: 'FETCH_TYPE_SCHEMA_RESULT'; className: string; ok: boolean; props?: TypeSchemaProp[]; canonicalClassName?: string; error?: string; environment?: string }
  | { type: 'FETCH_TYPE_SCHEMAS'; classNames: string[] }
  | { type: 'FETCH_TYPE_SCHEMAS_RESULT'; results: Array<{ className: string; ok: boolean; props?: TypeSchemaProp[]; canonicalClassName?: string; error?: string }>; environment: string }
  // Allowed values for a class's list/tag properties — drives value
  // autocomplete (WHERE/filter `<listprop> = t.<id>`) and the Vars panel's
  // option dropdowns. Separate from FETCH_TYPE_SCHEMA so a failure here can't
  // regress property-name completion. One EC round trip per class, cached in
  // the SW. See bmp-type-knowledge.ts.
  | { type: 'FETCH_TYPE_OPTIONS'; className: string; refresh?: boolean }
  | { type: 'FETCH_TYPE_OPTIONS_RESULT'; className: string; ok: boolean; options?: TypeOptionSet[]; error?: string }
  // Resolve a `root.<lcCategory>.children()` style reference to the
  // class of objects it returns — one EC call per category root,
  // cached forever per server.
  | { type: 'RESOLVE_ROOT_CATEGORY'; category: string }
  | { type: 'RESOLVE_ROOT_CATEGORY_RESULT'; category: string; ok: boolean; className?: string };

// ── Connection & Settings ────────────────────────────────────────
export type ConnectionMessage =
  | { type: 'GET_SETTINGS' }
  /** Settings as a page may see them: passwords and the AI key redacted
   *  (redactSettings), activeProfileId = the profile the receiving window
   *  shows. */
  | { type: 'SETTINGS_DATA'; settings: InspectorSettings }
  | { type: 'SAVE_SETTINGS'; settings: Partial<InspectorSettings> }
  /** Answer to SAVE_SETTINGS when the change could not be stored. */
  | { type: 'SETTINGS_SAVE_FAILED'; error: string }
  /** Whether stored settings could be read in this worker life. 'failed':
   *  nothing is written until a Retry reads them. */
  | { type: 'SETTINGS_STATUS'; status: 'loading' | 'loaded' | 'failed'; error?: string; backupAvailable?: boolean }
  | { type: 'RETRY_SETTINGS_LOAD' }
  | { type: 'CONNECTION_TEST' }
  | { type: 'CONNECTION_STATE'; state: ConnectionState }
  | { type: 'GET_CONNECTION_STATE' };

// ── Profiles ─────────────────────────────────────────────────────
export type ProfileMessage =
  | { type: 'SAVE_PROFILE'; profile: ServerProfile }
  | { type: 'DELETE_PROFILE'; profileId: string }
  | { type: 'SET_ACTIVE_PROFILE'; profileId: string }
  /** The profile a window shows changed. `manual`: the user picked it in
   *  Connect (only then is "Switched to …" said). */
  | { type: 'PROFILE_SWITCHED'; profileId: string; label: string; manual?: boolean }
  /** Answer to SAVE_PROFILE: whether the saved server works, in one sentence. */
  | { type: 'PROFILE_VERDICT'; profileId: string; ok: boolean; text: string; detail: string | null };

// ── EC Execution ─────────────────────────────────────────────────
export type EcMessage =
  | { type: 'EC_EXECUTE'; code: string; objectRid?: string; property?: string; transactional?: boolean; environment?: string }
  // `durationMs` is the SW-measured EC round-trip. The panel surfaces it in
  // the status bar latency chip — it's the user-perceived signal of how
  // responsive BMP is to actual work (vs health-check pings).
  | { type: 'EC_RESULT'; ok: boolean; log?: string; outputEntries?: EcOutputEntry[]; hasError?: boolean; hasWarning?: boolean; error?: string; durationMs?: number; errorKind?: import('./error-kind').BmpErrorKind; outcomeUnknown?: boolean }
  | {
      type: 'SAVE_PROPERTY'; rid: string; objectType: string; property: string; value: string; environment?: string;
      /** How the sending window names the object (Log sentence only). */
      objectLabel?: ObjectLabel;
      /** Value kind from the object read (`parseFullObject`). Picks the save route when given. */
      valueKind?: ValueKind;
    }
  // notSent: the save was refused before any write was sent.
  // outcomeUnknown: the write's answer did not arrive; BMP may have applied it.
  | { type: 'SAVE_RESULT'; ok: boolean; error?: string; notSent?: boolean; outcomeUnknown?: boolean }
  // Only the edited fields are sent; `expect` holds the values the user opened
  // for them (refused with `conflict` when BMP holds something else).
  | ({ type: 'SAVE_IDENTITY'; rid: string; environment?: string; expect?: IdentityPatch; objectLabel?: ObjectLabel } & IdentityPatch)
  | ({ type: 'SAVE_IDENTITY_RESULT' } & IdentitySaveResult)
  | { type: 'OPEN_EDITOR'; rid: string; property?: string; scrollToLine?: number; scrollToText?: string }
  | { type: 'FETCH_EDITOR_CONTEXT'; rid: string; property?: string }
  | { type: 'EDITOR_CONTEXT_DATA'; rid: string; context: import('./editor-types').EditorContext }
  | {
      type: 'EDITOR_LAUNCH_READY';
      phases: {
        totalMs: number;
        settingsMs: number;
        targetMs: number;
        placeholderMs: number;
        frameMountMs: number;
        contextMs: number;
        publishToAdoptMs: number;
        editorBootMs: number;
      };
    }
  | { type: 'JSON_SHAPE_READ'; source: string; objectRid?: string }
  | { type: 'JSON_SHAPE_RESULT'; ok: boolean; shape?: JsonShape; error?: string }
  | { type: 'OPEN_EXTENDED' };

// ── CVO Studio ───────────────────────────────────────────────────
// The CVO studio is the editor's CustomVisualization sibling: it opens a CVO's
// html + javascript as files with a live sandbox preview. Saving reuses
// SAVE_PROPERTY (html/javascript route through saveCodeViaEc), so this family
// only carries the open gesture for now.
export type StudioMessage =
  | { type: 'OPEN_STUDIO'; rid: string; property?: string }
  // Re-fetch a CVO's code after a save, to confirm what actually landed (the
  // save->reload pattern: catches a silent in-script rollback) and re-seed.
  | { type: 'STUDIO_FETCH_CODE'; rid: string; props?: string[]; environment?: string }
  | { type: 'STUDIO_CODE_DATA'; ok: boolean; code?: Record<string, string>; error?: string; errorKind?: import('./error-kind').BmpErrorKind }
  // Fetch live `_data` from the CVO data servlet for the chosen render context.
  | { type: 'STUDIO_FETCH_DATA'; cvoRid: string; businessObjectRid: string; periodMillis?: number }
  | { type: 'STUDIO_DATA'; ok: boolean; data?: unknown; error?: string; status?: number }
  // CVO data-input children (CustomVisualizationExpression) — referenced by
  // businessId (rids exceed JS safe-int). Edits go through SAVE_PROPERTY; only
  // add (id+key) and delete (childId) need generated EC, on simple identifiers.
  | { type: 'STUDIO_FETCH_CHILDREN'; cvoBid: string }
  | { type: 'STUDIO_CHILDREN'; ok: boolean; children?: StudioChild[]; error?: string }
  | { type: 'STUDIO_ADD_CHILD'; cvoBid: string; childId: string; key: string; childType: StudioChildType; environment?: string }
  | { type: 'STUDIO_CHILD_ADDED'; ok: boolean; rid?: string; error?: string; outcomeUnknown?: boolean }
  // Save a child's key + its type-specific fields in one EC (handles the table
  // reference + the int timeout that a plain SAVE_PROPERTY can't).
  // `expect` (with `cvoBid`) holds the values the user opened; the save is
  // refused with `conflict` when BMP holds something else. `field` names a
  // field the handler rejected (nothing was written).
  | { type: 'STUDIO_SAVE_CHILD'; childId: string; childType: StudioChildType; key: string; fields: Partial<Record<StudioChildField, string>>; environment?: string; cvoBid?: string; expect?: Partial<Record<'key' | StudioChildField, string>> }
  | { type: 'STUDIO_CHILD_SAVED'; ok: boolean; error?: string; field?: string; notSent?: boolean; conflict?: ValueChange[]; checkFailed?: boolean; outcomeUnknown?: boolean }
  | { type: 'STUDIO_DELETE_CHILD'; childId: string; environment?: string }
  | { type: 'STUDIO_CHILD_DELETED'; ok: boolean; error?: string; outcomeUnknown?: boolean }
  // Download a FileResource's decoded content (a hosted JS library) to inject
  // into the sandbox preview.
  | { type: 'STUDIO_FETCH_RESOURCE'; rid: string }
  | { type: 'STUDIO_RESOURCE'; ok: boolean; rid: string; text?: string; error?: string }
  // Host a file as a FileResource: write content via EC .change(content :=
  // "name;mime;base64") — the GraphQL path silently writes empty (footgun).
  | { type: 'STUDIO_WRITE_RESOURCE'; resId: string; name: string; mime: string; base64: string; environment?: string }
  | { type: 'STUDIO_RESOURCE_WRITTEN'; ok: boolean; rid?: string; id?: string; error?: string; outcomeUnknown?: boolean }
  // Resolve a configurator-friendly business id (or a rid) to {rid, id, name}.
  | { type: 'STUDIO_RESOLVE_REF'; ref: string }
  | { type: 'STUDIO_REF_RESOLVED'; ok: boolean; rid?: string; id?: string; name?: string; error?: string }
  // Batch rid -> {id, name} for the dependency list (lookup(rid).id).
  | { type: 'STUDIO_RESOLVE_RIDS'; rids: string[] }
  | { type: 'STUDIO_RIDS_RESOLVED'; ok: boolean; refs?: Array<{ rid: string; id: string; name: string }>; error?: string };

// ── Frame Overlay (in-page floating iframes for editor/diff/objectview/codesearch/transport/cvo-studio) ─
export type FrameOverlayMessage =
  | {
      type: 'MOUNT_FRAME';
      kind: FrameKind;
      url: string;
      label: string;
      defaultWidth: number;
      defaultHeight: number;
      resourceKey?: string;
      replaceExisting?: boolean;
      activation?: FrameActivation;
    }
  | { type: 'FRAME_MOUNT_RESULT'; disposition: import('./types').FrameMountDisposition };

// ── Enrichment ───────────────────────────────────────────────────
export type EnrichMessage =
  | { type: 'ENRICH_BADGES'; rids: string[] }
  | { type: 'BADGE_ENRICHMENT'; enrichments: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } }> }
  | { type: 'ENRICH_MODE'; mode: EnrichMode }
  | { type: 'RE_ENRICH' }
  | { type: 'RESET_OVERLAY_CACHES' }; // SW → content on a manual Reset: drop the blueprint overlay's per-workspace caches

// ── Detection ────────────────────────────────────────────────────
export type DetectionMessage =
  | { type: 'DETECTION_RESULT'; confidence: number; signals: string[]; isBmp: boolean }
  | { type: 'GET_DETECTION' }
  | { type: 'DETECTION_STATE'; phase: DetectionPhase; confidence: number; signals: string[] }
  | { type: 'BMP_SIGNALS_RESULT'; signals: string[] };

// ── Activity ─────────────────────────────────────────────────────
export type ActivityMessage =
  | { type: 'GET_ACTIVITY' }
  | { type: 'ACTIVITY_LOG'; entries: ActivityEntry[] }
  | { type: 'ACTIVITY_ENTRY'; entry: ActivityEntry }
  // Change record (lib/change-record.ts): the object window reports what it wrote.
  | { type: 'RECORD_CHANGES'; changes: ChangeInput[]; environment?: string }
  | { type: 'GET_CHANGES' }
  | { type: 'CLEAR_CHANGES' }
  | { type: 'CHANGES_DATA'; profileId: string; entries: ChangeRecord[] }
  /** A page or window asks the worker to open the side panel's Log at an error. `logId` names the
   *  entry when the toast already has one; otherwise the worker logs `text`. */
  | { type: 'SHOW_IN_LOG'; text: string; detail?: string; logId?: number }
  | { type: 'SHOW_IN_LOG_RESULT'; opened: boolean; logId: number }
  /** Worker to panel: switch to the Log tab and highlight this entry. */
  | { type: 'SHOW_LOG_ENTRY'; id: number };

// ── History ──────────────────────────────────────────────────────
export type HistoryMessage =
  | { type: 'GET_HISTORY' }
  | { type: 'HISTORY_DATA'; entries: HistoryEntry[] }
  // The object window opened `rid` as its root: record it as recent.
  | { type: 'RECORD_RECENT'; rid: string; name?: string; objectType?: string; businessId?: string; templateBusinessId?: string };

// ── Favorites ────────────────────────────────────────────────────
export type FavoritesMessage =
  | {
      type: 'TOGGLE_FAVORITE';
      rid: string;
      name?: string;
      objectType?: string;
      businessId?: string;
      templateBusinessId?: string;
    }
  | { type: 'GET_FAVORITES' }
  | { type: 'FAVORITES_DATA'; entries: FavoriteEntry[] };

// ── Context Menu ─────────────────────────────────────────────────
export type ContextMenuMessage =
  // Set the sender tab's current position (lib/current-position.ts).
  | { type: 'SET_CONTEXT_RID'; rid: string; name?: string; objectType?: string; businessId?: string; source?: PositionSource };

// ── Object View ──────────────────────────────────────────────────
export type ObjectViewMessage =
  // name/objectType/businessId: what the sender already knows (the badge's
  // enrichment). The type lets the service worker take the two-post open.
  // `reveal`: an open object window selects `rid` in its tree when it holds
  // it (else adds it as a referenced row) instead of opening it as root.
  // `from` names the calling object and line ("Reached from …, line N").
  // `focus`: land on this property and line (marked, scrolled into view).
  // `origin`: the search that led here, the first step of the trail.
  | { type: 'OPEN_OBJECT_VIEW'; rid: string; name?: string; objectType?: string; businessId?: string; reveal?: boolean; from?: { rid: string; name?: string; line?: number }; focus?: ObjectWindowFocus; origin?: ObjectWindowOrigin }
  // The pointer rests on a badge: start the root read as background work so
  // a double-click that follows opens at once. Read-only.
  | { type: 'PREFETCH_OBJECT_VIEW'; rid: string; objectType?: string }
  // Object window (structure tree + detail pane). One request opens a root:
  // root read, structure listing and one batched read of the listed nodes.
  /** `environment`: the window's pinned environment once it shows data;
   *  a read for another server is refused (environmentChanged). */
  | { type: 'OPEN_OBJECT_ROOT'; rid: string; typeHint?: string; environment?: string }
  | { type: 'OBJECT_ROOT_DATA'; rid: string; environment: string; ok: boolean; payload?: ObjectRootPayload; error?: string; errorKind?: import('./error-kind').BmpErrorKind; environmentChanged?: boolean }
  // Names/types for relation targets — one batched object read.
  | { type: 'READ_OBJECT_SUMMARIES'; rids: string[] }
  /** `missing`: the server says these are not there; `failed`: their reads
   *  failed or were dropped (ask again). */
  | { type: 'OBJECT_SUMMARIES_DATA'; environment: string; ok: boolean; summaries: ObjectSummary[]; missing?: string[]; failed?: Record<string, string>; error?: string }
  // Full reads of a few objects through the same read path (root's template,
  // re-read after a save). Read-only.
  | { type: 'READ_FULL_OBJECTS'; rids: string[]; environment?: string }
  | { type: 'FULL_OBJECTS_DATA'; environment: string; ok: boolean; objects: Record<string, FullObject>; errors: Record<string, string>; error?: string }
  // Code references (lib/code-refs.ts keys) → identity and code property,
  // one batched read-only post (lib/code-ref-resolve.ts).
  | { type: 'RESOLVE_CODE_REFS'; keys: string[]; environment?: string }
  | { type: 'CODE_REFS_RESULT'; environment: string; ok: boolean; results: Record<string, RefResolution>; error?: string }
  // Follow single references of tree nodes (a button's action object): one
  // structure listing for all items plus one batched read of the new nodes.
  | { type: 'LIST_REFERENCED'; items: Array<{ rid: string; via: string; depth: number }> }
  | { type: 'REFERENCED_DATA'; environment: string; ok: boolean; rows: StructureRow[]; nodes: Record<string, FullObject>; error?: string };

export type ObjectPaneMessage =
  /** The classes an EditField's property mapping targets (object window picker). */
  | { type: 'FETCH_EDIT_FIELD_TYPES'; rid: string }
  | { type: 'EDIT_FIELD_TYPES_RESULT'; rid: string; ok: boolean; classNames: string[]; error?: string }
  | { type: 'APPLY_OBJECT_CHANGES'; rid: string; target: 'instance' | 'template'; changes: Record<string, string | number | boolean>; resetProps?: string[]; environment?: string; objectLabel?: ObjectLabel }
  | { type: 'FETCH_PROPERTY_APPLICATIONS'; rid: string; environment?: string }
  | { type: 'PROPERTY_APPLICATIONS_RESULT'; rid: string; ok: boolean; applications?: PropertyApplication[]; total?: number; truncated?: boolean; error?: string; environment: string }
  | { type: 'APPLY_CHANGES_RESULT'; rid: string; ok: boolean; error?: string; outcomeUnknown?: boolean }
  /** The object window's custom property schema of a type (property-schema.ts). */
  | { type: 'FETCH_PROPERTY_SCHEMA'; className: string; environment: string }
  | { type: 'PROPERTY_SCHEMA_RESULT'; className: string; ok: boolean; schema?: TypePropertySchema; error?: string; environment: string }
  /** The objects reference property `definition` (a custom reference,
   *  user/group or list-of-references property of `className` whose
   *  definition has an expression) allows for object `rid`: the definition's
   *  expression calculated on that object, read now (no worker cache).
   *  `items` (RID, ID, name) holds at most LIST_ITEMS_MAX; `tooMany`: the
   *  expression yields more, the row is read-only. For display; the write
   *  gate reads the set again itself. */
  | { type: 'FETCH_ALLOWED_OBJECTS'; rid: string; definition: string; className: string; environment: string }
  | { type: 'ALLOWED_OBJECTS_RESULT'; rid: string; definition: string; ok: boolean; items?: ListItem[]; tooMany?: boolean; error?: string; environment: string }
  /** Custom property values of one object; the service worker gates every
   *  change against the object's own type (custom-property-gate.ts). */
  /** `expect`: definition → the value the window opened (property-schema's
   *  canonical form). The worker compares it with the object it reads for
   *  the gate and writes nothing when one differs (`conflict`, with that read
   *  as `object`). Without it no changed-since-opened check is made here. */
  | { type: 'APPLY_CUSTOM_CHANGES'; rid: string; changes: CustomChange[]; environment: string; objectLabel?: ObjectLabel; expect?: Record<string, string> }
  | { type: 'APPLY_CUSTOM_CHANGES_RESULT'; rid: string; ok: boolean; error?: string; notSent?: boolean; outcomeUnknown?: boolean; warning?: string; refused?: Array<{ definition: string; reason: string }>; conflict?: ValueChange[]; object?: FullObject }
  // Inbound scan — "who references me" via rref(), incl. undeclared edges.
  | { type: 'FETCH_INBOUND'; rid: string; className: string }
  // total: every rref() referrer, also past the cap.
  | { type: 'INBOUND_RESULT'; rid: string; ok: boolean; groups?: ConnGroup[]; targets?: ConnTarget[]; capped?: boolean; total?: number; instances?: { total: number; targets: ConnTarget[] }; error?: string }
  // Stop waiting for a FETCH_INBOUND of `rid` (BMP may still finish the command).
  | { type: 'FETCH_INBOUND_CANCEL'; rid: string }
  // Access mode of the object window (lib/access-mode.ts). Every request
  // names the environment it belongs to; the worker refuses a mismatch.
  // STATUS answers from the worker's cache only (no BMP request).
  | { type: 'ACCESS_MODE_STATUS'; environment: string }
  | { type: 'ACCESS_MODE_PREPARE'; environment: string }
  | { type: 'ACCESS_MODE_READY'; environment: string; ok: boolean; available?: boolean; reason?: string; subjects?: AccessSubject[]; environmentName?: string; error?: string }
  | { type: 'ACCESS_MODE_DECIDE'; requestId: string; environment: string; subjectRid: string; rids: string[] }
  | { type: 'ACCESS_MODE_DECISIONS'; requestId: string; environment: string; subjectRid: string; ok: boolean; verdicts?: Record<string, ActionVerdicts>; unavailable?: boolean; error?: string }
  | { type: 'ACCESS_MODE_TRACE'; requestId: string; environment: string; subjectRid: string; rid: string; action: AccessTraceAction }
  | { type: 'ACCESS_MODE_TRACE_DATA'; requestId: string; environment: string; subjectRid: string; rid: string; action: AccessTraceAction; ok: boolean; trace?: AccessTraceNode; unavailable?: boolean; error?: string };

// ── Compare ──────────────────────────────────────────────────────
export type CompareMessage =
  // Open (or bring forward) the Compare window. `left` is side A; without
  // `right` the picker for side B opens with its suggestions.
  | { type: 'OPEN_COMPARE'; left: CodeSearchObject; right?: CodeSearchObject }
  // Full reads of one or two objects, their structure and the names they
  // refer to (lib/compare-read.ts). Read-only, two or three posts.
  | { type: 'READ_COMPARE'; rids: string[]; environment?: string }
  | { type: 'COMPARE_DATA'; environment: string; ok: boolean; read?: CompareRead; error?: string; errorKind?: import('./error-kind').BmpErrorKind }
  // Picker offers for side B (one read-only post): other instances of the
  // template, instances of the object, siblings of the same class.
  | { type: 'COMPARE_SUGGEST'; rid: string; templateRid?: string; parentRid?: string; environment?: string }
  | { type: 'COMPARE_SUGGEST_DATA'; ok: boolean; rows: SuggestRow[]; error?: string }
  // Server object search by name and ID (lib/object-search.ts), read-only.
  // `channel`: the asking surface; its next search cancels this one.
  | { type: 'OBJECT_SEARCH'; query: string; channel: string; skipIndexed?: boolean }
  | { type: 'OBJECT_SEARCH_RESULT'; query: string; ok: boolean; objects: FoundObject[]; types?: number; notSearched?: string[]; error?: string; /** How the server was searched: its search command, or the name catalogs. */ via?: 'command' | 'catalog'; /** A cut, or IDs that could not be read: one short line for the user. */ notice?: string }
  | { type: 'OBJECT_SEARCH_CANCEL'; channel: string };

// ── Code Search ──────────────────────────────────────────────────
export type CodeSearchMessage =
  // Open (or bring forward) the code search window. `query`: run it (Browse
  // hands its query over). `scope`: search under this object. `target`:
  // the object "Used in code" looks for. `context`: the object the window was opened
  // from (offered as scope and target). `restore`: only bring it forward.
  | { type: 'OPEN_CODE_SEARCH'; query?: string; mode?: 'text' | 'refs'; scope?: CodeSearchObject; target?: CodeSearchObject; context?: CodeSearchObject; restore?: boolean }
  // The local code index of the current server (lib/code-index-*).
  // SYNC starts (or joins) a refresh; STATUS answers at once and is also
  // broadcast while the index changes.
  | { type: 'CODE_INDEX_SYNC'; force?: boolean; user?: boolean; roots?: string[] }
  | { type: 'CODE_INDEX_REMOVE' }
  | { type: 'GET_SERVER_LOAD' }
  // "Server was restarted" in the Log: that one server's script count starts again.
  | { type: 'RESET_SCRIPT_COUNT'; profileId: string }
  | { type: 'SERVER_LOAD_DATA'; ok: boolean; state?: import('./load-governor').LoadState; counters: Record<string, number> | null; fullReadsPerPost?: number; scripts?: import('./load-governor').ScriptLoad; scriptSentence?: string; recent: Array<{ op: string; cls: string; commands: number; fullReads: number; bytes: number; ms: number; heldMs: number; ok: boolean; at: number }> }
  | { type: 'CODE_SEARCH_ROOTS' }
  | { type: 'CODE_SEARCH_ROOTS_RESULT'; ok: boolean; roots: Array<{ key: string; name: string }>; orgs: Record<string, { name: string; parent: string }>; error?: string }
  | { type: 'CODE_INDEX_ESTIMATE' }
  | { type: 'CODE_INDEX_ESTIMATE_RESULT'; ok: boolean; estimate?: CodeCopyEstimate; error?: string }
  /** The load governor's state changed (load-governor.ts): waiting, slow, overloaded or ok. */
  | { type: 'SERVER_LOAD'; state: import('./load-governor').LoadState; sentence: string | null; notice?: string; profileId?: string }
  | { type: 'CODE_INDEX_GET_STATUS' }
  | { type: 'CODE_INDEX_CANCEL' }
  | { type: 'CODE_INDEX_STATUS'; status: CodeIndexStatus }
  // Objects with code under `rid` (one read-only post), for the scope chip.
  | { type: 'CODE_SEARCH_SCOPE'; rid: string; environment?: string }
  | { type: 'CODE_SEARCH_SCOPE_RESULT'; ok: boolean; object?: CodeSearchObject; rids?: string[]; covered?: import('./code-search-scope').CodeScope['covered']; error?: string; errorKind?: import('./error-kind').BmpErrorKind }
  // Resolve typed text (RID or ns.id) to one object (scope or target).
  | { type: 'CODE_SEARCH_RESOLVE'; text: string }
  | { type: 'CODE_SEARCH_RESOLVE_RESULT'; ok: boolean; object?: CodeSearchObject; error?: string }
  // The server scan (fallback when the index cannot be used). Hits stream
  // as CODE_SEARCH_HITS; DONE carries the totals and coverage.
  // `windowId` names the sending code search window: one window's search never
  // stops another window's. DONE always ends a search; `cancelled` says why it
  // has no outcome (a new search in the same window, or a stop).
  | { type: 'CODE_SEARCH_START'; id: string; windowId?: string; search: CodeSearchWireRequest; scopeRid?: string; /** "Search again": list the place again even when a listing a few seconds old is kept (code-scope-read LISTING_REUSE_MS). */ fresh?: boolean }
  | { type: 'CODE_SEARCH_HITS'; id: string; hits: CodeSearchHit[] }
  // First results of a running live scan (unsorted, before folding) and how
  // far it is; the complete answer follows as CODE_SEARCH_HITS.
  | { type: 'CODE_SEARCH_PROGRESS'; id: string; hits: CodeSearchHit[]; progress: import('./code-search').CodeSearchProgress }
  // The full text of one property of a result, when its context is widened
  // beyond the lines the hit carries. Read-only.
  | { type: 'CODE_SEARCH_CODE'; rid: string; prop: string; environment?: string }
  | { type: 'CODE_SEARCH_CODE_RESULT'; ok: boolean; code?: string; error?: string }
  | { type: 'CODE_SEARCH_DONE'; id: string; outcome?: CodeSearchOutcome; error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: 'superseded' | 'stopped' }
  | { type: 'CODE_SEARCH_STOP'; id?: string; windowId?: string }
  // The window's watchdog asks whether the worker still runs a search.
  // Worker → code search windows: how fresh the change feed of a server is
  // (code-feed.ts), after each poll; `at` is its last successful check.
  | { type: 'CODE_SEARCH_FEED'; environment: string; health: 'fresh' | 'stale' | 'off'; at: number | null }
  | { type: 'CODE_SEARCH_STATUS'; id: string; windowId?: string }
  | { type: 'CODE_SEARCH_STATUS_RESULT'; id: string; running: boolean };

// ── Transport (beta) ─────────────────────────────────────────────
// Reads are preview runs (handlers/transport.ts); the only write is a
// confirmed TRANSPORT_RUN_PART on a connected target. Requests of one
// server profile run one at a time, in order; TRANSPORT_CANCEL stops a
// running or queued one (its result then says `cancelled`). A result that
// refused before anything was read (page sender, not connected, another
// environment, a bad root, start, day or RID) says `refused`.
export type TransportMessage =
  // Open the Transport window on the active tab of the panel's window.
  | { type: 'OPEN_TRANSPORT' }
  // Objects under one root changed after `since` (YYYY-MM-DD).
  | { type: 'TRANSPORT_SCAN'; requestId: string; environment: string; root: string; since: string }
  | {
    type: 'TRANSPORT_SCAN_RESULT'; requestId: string; environment: string; root: string; since: string; ok: boolean;
    rows?: import('./transport-read').TransportScanRow[];
    /** More changed objects than TRANSPORT_SCAN_CAP: `rows` is cut. */
    more?: boolean;
    /** The workspace has no such root. */
    missingRoot?: boolean;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The object `start` (an ID or `<space>.<ID>`) and everything under it, changed
  // after `since` (YYYY-MM-DD) or, with '', all of it.
  | { type: 'TRANSPORT_SCAN_UNDER'; requestId: string; environment: string; start: string; since: string }
  | {
    type: 'TRANSPORT_SCAN_UNDER_RESULT'; requestId: string; environment: string; start: string; since: string; ok: boolean;
    /** The starting object's own row. */
    origin?: import('./transport-read').TransportScanRow;
    /** The starting object first (when it is listed), then what is under it. */
    rows?: import('./transport-read').TransportScanRow[];
    /** More objects than TRANSPORT_SCAN_CAP: `rows` is cut. */
    more?: boolean;
    /** No object has that ID. */
    missingStart?: boolean;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The children of `root.<root>` or of the object `rid` (one of the two),
  // in the server's order.
  | { type: 'TRANSPORT_CHILDREN'; requestId: string; environment: string; root?: string; rid?: string }
  | {
    type: 'TRANSPORT_CHILDREN_RESULT'; requestId: string; environment: string; root?: string; rid?: string; ok: boolean;
    rids?: string[];
    /** The root or object does not resolve. */
    missing?: boolean;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // How many objects are under each of up to 25 roots or objects, by root
  // name or RID (`descendants().size()`).
  | { type: 'TRANSPORT_COUNTS'; requestId: string; environment: string; roots?: string[]; rids?: string[] }
  | {
    type: 'TRANSPORT_COUNTS_RESULT'; requestId: string; environment: string; ok: boolean;
    counts?: Record<string, number>;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The object `rid` and everything under it, changed after `since`
  // (YYYY-MM-DD) or, with '', all of it.
  | { type: 'TRANSPORT_SCAN_BELOW'; requestId: string; environment: string; rid: string; since: string }
  | {
    type: 'TRANSPORT_SCAN_BELOW_RESULT'; requestId: string; environment: string; rid: string; since: string; ok: boolean;
    /** The object's own row. */
    origin?: import('./transport-read').TransportScanRow;
    /** The object first (when it is listed), then what is under it. */
    rows?: import('./transport-read').TransportScanRow[];
    /** More objects than TRANSPORT_SCAN_CAP: `rows` is cut. */
    more?: boolean;
    /** The object does not exist (any more). */
    missing?: boolean;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // One object by its address `<space>.<ID>` (spaces t, k, r, d).
  // The IDs this workspace has under a listing start, at every comparison.
  | { type: 'TRANSPORT_SOURCE_LISTING'; requestId: string; environment: string; start: string }
  | {
    type: 'TRANSPORT_SOURCE_LISTING_RESULT'; requestId: string; environment: string; start: string; ok: boolean;
    ids?: string[];
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  | { type: 'TRANSPORT_FIND'; requestId: string; environment: string; address: string }
  | {
    type: 'TRANSPORT_FIND_RESULT'; requestId: string; environment: string; address: string; ok: boolean;
    row?: import('./transport-read').TransportScanRow;
    /** No object has that address. */
    missing?: boolean;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The objects under `root.<root>` whose ID or name holds `text` (2 to 100
  // characters; `*` and `?` are wildcards), at most TRANSPORT_SEARCH_CAP.
  | { type: 'TRANSPORT_SEARCH'; requestId: string; environment: string; root: string; text: string }
  | {
    type: 'TRANSPORT_SEARCH_RESULT'; requestId: string; environment: string; root: string; text: string; ok: boolean;
    rows?: import('./transport-read').TransportScanRow[];
    /** More matches than TRANSPORT_SEARCH_CAP: `rows` is cut. */
    more?: boolean;
    /** The workspace has no such root. */
    missingRoot?: boolean;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The scan rows of up to TRANSPORT_READ_BATCH objects by RID.
  | { type: 'TRANSPORT_ROWS'; requestId: string; environment: string; rids: string[] }
  | {
    type: 'TRANSPORT_ROWS_RESULT'; requestId: string; environment: string; ok: boolean;
    /** One entry per asked RID, in order. */
    rows?: import('./transport-read').TransportRowRead[];
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The RIDs of the objects on the BMP page the window sits on (the page's
  // widget scan, PAGE_INFO). Sends nothing to a server.
  | { type: 'TRANSPORT_PAGE_OBJECTS'; requestId: string; environment: string }
  | {
    type: 'TRANSPORT_PAGE_OBJECTS_RESULT'; requestId: string; environment: string; ok: boolean;
    rids?: string[];
    error?: string; refused?: boolean;
  }
  // The objects that use the object `rid` (`rref()`), at most TRANSPORT_USED_BY_CAP.
  | { type: 'TRANSPORT_USED_BY'; requestId: string; environment: string; rid: string }
  | {
    type: 'TRANSPORT_USED_BY_RESULT'; requestId: string; environment: string; rid: string; ok: boolean;
    users?: import('./transport-read').TransportUser[];
    /** TRANSPORT_USED_BY_CAP or more: `users` is cut. */
    more?: boolean;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // What this workspace has at up to TRANSPORT_FACTS_BATCH used addresses
  // (`<space>.<ID>`): RID, class, parent ID, name, or missing.
  | { type: 'TRANSPORT_FACTS'; requestId: string; environment: string; addresses: string[] }
  | {
    type: 'TRANSPORT_FACTS_RESULT'; requestId: string; environment: string; ok: boolean;
    facts?: import('./transport-read').TransportFact[];
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The bundle material of up to TRANSPORT_READ_BATCH objects; `creation`:
  // the property definitions among them whose generate(true) text (their
  // links) is read too.
  // `fileLimit`: a file's content is read only when its whole text has at
  // most this many characters (default: every file's).
  | { type: 'TRANSPORT_READ_OBJECTS'; requestId: string; environment: string; rids: string[]; creation?: string[]; fileLimit?: number }
  | {
    type: 'TRANSPORT_OBJECTS_RESULT'; requestId: string; environment: string; ok: boolean;
    /** One entry per asked RID, in order; a failed object has ok false. */
    objects?: import('./transport-read').TransportObjectRead[];
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The generate(true) text of up to TRANSPORT_READ_BATCH property definitions.
  | { type: 'TRANSPORT_READ_CREATION'; requestId: string; environment: string; rids: string[] }
  | {
    type: 'TRANSPORT_CREATION_RESULT'; requestId: string; environment: string; ok: boolean;
    /** One entry per asked RID, in order; a failed object has ok false. */
    texts?: import('./transport-read').TransportCreationRead[];
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The entries of the workspace's transport log, newest first.
  | { type: 'TRANSPORT_LOG'; requestId: string; environment: string }
  | {
    type: 'TRANSPORT_LOG_RESULT'; requestId: string; environment: string; ok: boolean;
    entries?: import('./transport-read').TransportLogEntry[];
    /** The log has more entries than TRANSPORT_LOG_CAP: `entries` is cut. */
    more?: boolean;
    /** The workspace has no transport log. */
    missingLog?: boolean;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  // The other workspaces Companion is connected to now (stored server
  // profiles other than the window's own whose connection is confirmed).
  | { type: 'TRANSPORT_TARGETS'; requestId: string; environment: string }
  | {
    type: 'TRANSPORT_TARGETS_RESULT'; requestId: string; environment: string; ok: boolean;
    targets?: import('./transport-read').TransportTarget[];
    error?: string; refused?: boolean;
  }
  // One part of a probe or patch, run on the connected workspace `target`
  // (its environment token) as a preview, or committed (`transactional`)
  // only with `confirmed: true`, which only the apply flow sets after the
  // person confirmed. `environment` is the window's own. A committed run is
  // never stopped once it started; TRANSPORT_CANCEL only keeps a queued one
  // from starting.
  | { type: 'TRANSPORT_RUN_PART'; requestId: string; environment: string; target: string; code: string; transactional: boolean; confirmed?: boolean }
  | {
    type: 'TRANSPORT_PART_RESULT'; requestId: string; environment: string; target: string; ok: boolean;
    log?: string;
    /** A committed run whose answer did not arrive: it may have been applied. */
    outcomeUnknown?: boolean;
    error?: string; errorKind?: import('./error-kind').BmpErrorKind; cancelled?: boolean; refused?: boolean;
  }
  | { type: 'TRANSPORT_CANCEL'; requestId: string };

/** An object named by the code search window (scope, target, context). */
export interface CodeSearchObject { rid: string; name?: string; type?: string; businessId?: string }

/** A request over messages: the subtree as a list. */
export type CodeSearchWireRequest = Omit<import('./code-search').CodeSearchRequest, 'scopeRids'> & { scopeRids?: string[] };
type CodeSearchHit = import('./code-search').CodeSearchHit;
type CodeSearchOutcome = import('./code-search').CodeSearchOutcome;

export interface CodeIndexStatus {
  environment: string;
  /** none: never built · building (first build) · paused: a first build
   *  stopped at progress.read of progress.toRead · ready · refreshing ·
   *  failed: the first build failed (error) · unavailable: this server
   *  cannot be indexed (the server scan is used). */
  state: 'none' | 'building' | 'paused' | 'ready' | 'refreshing' | 'failed' | 'unavailable';
  syncedAt: number | null;
  builtAt: number | null;
  objects: number;
  bytes: number;
  pending: number;
  /** Bumps whenever stored objects changed (persisted with the index). */
  version: number;
  /** Code types and code properties the index covers (discovered). */
  codeTypes?: number;
  codeProps?: number;
  /** What the index does not cover, in words. */
  notCovered?: string[];
  progress?: { phase: 'listing' | 'reading' | 'done'; read: number; toRead: number };
  /** Last sync: objects read (new or changed) and removed. */
  last?: {
    changed: number; removed: number; ms: number; posts: number; at: number; first?: boolean; unchanged?: boolean;
    stages?: Array<{ stage: string; posts: number; ms: number; read: number }>;
    /** Every request of the sync: operation, objects, response size, time, pause before it. */
    requests?: Array<{ op: string; objects: number; bytes: number; ms: number; pauseMs: number; ok: boolean }>;
  };
  /** The server answered like an overloaded one recently: automatic index work waits. */
  overload?: boolean;
  error?: string;
  /** Roots, in build order: name, objects with code, read completely. */
  roots?: Array<{ key: string; name: string; objects: number; done: boolean; tops?: number; topsDone?: number; topsRead?: string[] }>;
  /** Organisations: RID → name and parent ('' on top). */
  orgs?: Record<string, { name: string; parent: string }>;
  /** Build stage: search is usable from 'organisation' on. */
  stage?: 'roots' | 'organisation' | 'done';
  /** A copy made from the code search's read (code-copy.ts); absent for an
   *  index of the older builder. It changes only on the user's Refresh. */
  copy?: boolean;
  /** The user stopped the last refresh of a complete copy: it is unchanged. */
  stopped?: boolean;
}

/** What a local copy would cost (code-copy CopyEstimate): from the listing
 *  the build then uses. */
export interface CodeCopyEstimate {
  /** Objects with code and their characters. */
  objects: number;
  chars: number;
  /** Requests and commands of the build, and its expected time (s). */
  posts: number;
  commands: number;
  seconds: number;
  /** Too much code to read in one go: read source by source. */
  perSource?: boolean;
  /** Sources the listing could not list (not in the estimate). */
  failedSources?: string[];
}

// ── Script History ───────────────────────────────────────────────
export type ScriptHistoryMessage =
  | { type: 'GET_SCRIPT_HISTORY' }
  | { type: 'SCRIPT_HISTORY_DATA'; entries: ScriptHistoryEntry[] };

// ── Colors (linked CorpoColor picker) ────────────────────────────
export type ColorMessage =
  // `force` bypasses the persistent colour cache (manual refresh in the picker).
  | { type: 'FETCH_COLOR_SETS'; force?: boolean }
  | {
      type: 'COLOR_SETS_DATA';
      environment: string;
      sets: ColorSetData[];
      fetchedAt?: number;
      stale?: boolean;
      error?: string;
    };

// ── Notifications (ephemeral panel toasts) ───────────────────────
// SW fires `TOAST` to surface user-action failures that are otherwise
// buried in the Log tab. The panel renders a top-right notification
// that auto-dismisses. Kept separate from `ActivityEntry` so the log
// can stay quiet while the user still sees what failed.
export type NotificationMessage =
  | { type: 'TOAST'; text: string; kind: 'success' | 'error' | 'info'; logId?: number }
  /** A handler failed before it answered `requestType`. */
  | { type: 'REQUEST_FAILED'; requestType: string; error: string; errorKind?: import('./error-kind').BmpErrorKind }
  /** A header button's window or page mode could not open on the active tab
   *  (frame-open-failure): one line for the panel's notice area. */
  | { type: 'PANEL_NOTICE'; failure: 'no-page' | 'site-not-granted'; text: string }
  /** A newer panel document claimed this browser window. The superseded
   *  document must retire its reconnecting port instead of reconnecting and
   *  stealing ownership back in a tight loop. */
  | { type: 'PANEL_SUPERSEDED' }
  /** First message sent by every side-panel instance on connect — tells
   *  the SW which window the panel is attached to. Without this the SW
   *  has to guess via lastFocusedWindow, which breaks when the user has
   *  the panel open in two windows simultaneously (the most-recently-
   *  touched window wins, the other panel goes deaf). */
  | { type: 'PANEL_HELLO'; windowId: number; panelIncarnation: string; panelCreatedAt: number };

// ── Full union (backward-compatible) ─────────────────────────────
/** Blueprint layout-builder messages (sidepanel/content ↔ SW). The SW owns BmpClient and runs
 *  the layout-service; the panel holds the editable model + history and sends high-level
 *  load/apply. Models are plain JSON (LModel) so they cross the port unchanged. */
export type LayoutMessage =
  // Blueprint overlay toggle: panel → SW (BLUEPRINT_TOGGLE) flips per-window state; SW → content/panel
  // (BLUEPRINT_STATE) drives the overlay on/off. Mirrors the inspect/paint toggle convention.
  | { type: 'BLUEPRINT_TOGGLE' }
  // Overlay X → SW: an explicit, idempotent close for the sender tab. This is deliberately not a
  // toggle: a stale/restoring MV3 worker must never interpret "close" as "turn Blueprint back on".
  | { type: 'BLUEPRINT_CLOSE' }
  | { type: 'BLUEPRINT_STATE'; active: boolean }
  // SW → content, before the worker turns Blueprint off: the tab answers `{ ok }` from its one exit
  // check (asks the user when changes are unsaved). Not a handler: content scripts never send it.
  | { type: 'BLUEPRINT_REQUEST_EXIT' }
  // Object window "Edit in Blueprint": turn Blueprint on for the sender tab and select `rid` in it.
  | { type: 'OPEN_BLUEPRINT_FOR'; rid: string }
  // SW → content: select `rid` in Blueprint once its page model is loaded.
  | { type: 'BLUEPRINT_SELECT'; rid: string }
  // Content → SW after the post-apply reload: turn blueprint back ON for the sender tab's window so
  // the editing session survives the refresh (apply toggles it off before reloading — see applyPage).
  | { type: 'BLUEPRINT_RESUME' }
  // Content → SW on first blueprint activation in a tab: the Blueprint editor (~150 KB, lib/layout/*
  // + content-blueprint/*) is NOT part of the always-on content bundle — it lives in a separate
  // content-blueprint.js, injected on demand into the sender tab. Fire-and-forget; content.ts follows
  // up with the enable command (`window.__crevBpCmd`, or the pending-command queue if the injected
  // script has not started yet) to actually turn the overlay on.
  | { type: 'INJECT_BLUEPRINT' }
  // Panel → SW after a successful chrome.permissions.request (the standard per-site prompt): re-sync
  // the dynamic content-script registrations and, when a tab is named, inject into it right away
  // (registered scripts only cover future loads) + refresh its detection/page info.
  | { type: 'SITE_ACCESS_CHANGED'; tabId?: number }
  | { type: 'LAYOUT_LOAD'; rid: string; prefer?: 'template' | 'instance' }
  // `env` = the page's environment token at load time; Blueprint echoes it back on apply so the SW
  // can reject a commit aimed at a different environment (the profile was pointed elsewhere mid-edit).
  | { type: 'LAYOUT_LOAD_RESULT'; ok: boolean; env?: string; ctx?: BlueprintCtx; model?: LModel; baseline?: LModel; orphans?: LayoutNode[]; error?: string }
  | { type: 'LAYOUT_APPLY'; env: string; ctx: BlueprintCtx; baseline: LModel; desired: LModel; portableIds?: PortableIdPlan }
  | { type: 'LAYOUT_APPLY_RESULT'; ok: boolean; noop: boolean; stale?: boolean; partial?: boolean; unverified?: boolean; script?: string; executionLog?: string; notes?: PlanNote[]; model?: LModel; baseline?: LModel; error?: string }
  | { type: 'LAYOUT_PORTABLE_ID_PREFLIGHT'; requests: PortableIdRequest[] }
  | { type: 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT'; ok: boolean; portableIds?: PortableIdPlan; error?: string }
  // Apply-preview blast radius: is the page a template master (fan-out), and do any touched shared
  // containers reach pages outside the page's own template-family. Best-effort — both may be null.
  | {
      type: 'LAYOUT_BLAST';
      pageId: string;
      containers: { id: string; rid?: string }[];
      flowContainers: {
        id: string;
        rid?: string;
        className: 'InputSet' | 'EditPage';
      }[];
    }
  | {
      type: 'LAYOUT_BLAST_RESULT';
      fanout: InstanceFanout | null;
      blast: ContainerBlast | null;
      flowBlast: FlowContainerBlast | null;
    }
  // Flow "wire to existing" picker: the workspace's InputSets/EditPages (lean list — bid/rid/class/
  // category/name only), fetched at picker-open, never in the main layout fetch.
  | { type: 'LAYOUT_FLOW_REFS'; refClass: 'InputSet' | 'EditPage' | 'ObjectType' }
  | { type: 'LAYOUT_FLOW_REFS_RESULT'; ok: boolean; refs?: FlowRefListItem[]; error?: string }
  // Wire-to-existing follow-up: the on-demand children of ONE existing off-page InputSet/EditPage the
  // user just wired to (the main fetch never projected it). Same shape as the main flow projection's
  // child rows; rendered as the reference's real current contents (staged adds/reorders layer on top).
  | { type: 'LAYOUT_FLOW_SETTINGS'; rid: string; className: string }
  | { type: 'LAYOUT_FLOW_SETTINGS_RESULT'; ok: boolean; values?: Record<string, string | boolean>; error?: string }
  | { type: 'LAYOUT_FLOW_REF_CHILDREN'; refId: string }
  | { type: 'LAYOUT_FLOW_REF_CHILDREN_RESULT'; ok: boolean; children?: FlowNode[]; error?: string };

// ── Saved style presets (blueprint paintbrush library) ───────────
// Per-profile named widget appearance presets. The blueprint requests these one-shot (sendRequest);
// SAVE/DELETE mutate then echo the fresh list back as STYLE_PRESETS_DATA.
export type StylePresetMessage =
  | { type: 'LIST_STYLE_PRESETS' }
  | { type: 'SAVE_STYLE_PRESET'; name: string; style: NodeStyle }
  | { type: 'DELETE_STYLE_PRESET'; id: string }
  | { type: 'STYLE_PRESETS_DATA'; presets: StylePreset[] };

// ── Page-script preferences ──────────────────────────────────────
// Extension storage is closed to content scripts (storage-access.ts). The few
// preferences the page layer keeps go through the worker, one validated value
// per request: where an in-page window was last placed, and the Blueprint
// portable-ID recipe.
export type PagePrefsMessage =
  | { type: 'FRAME_BOUNDS_GET'; kind: FrameKind }
  | { type: 'FRAME_BOUNDS_SAVE'; kind: FrameKind; bounds: { left: number; top: number; width: number; height: number } }
  | { type: 'FRAME_BOUNDS_DATA'; bounds: { left: number; top: number; width: number; height: number } | null }
  | { type: 'PORTABLE_IDS_GET' }
  | { type: 'PORTABLE_IDS_SAVE'; config: PortableIdConfig }
  | { type: 'PORTABLE_IDS_DATA'; config: PortableIdConfig };

// ── AI coding assistant ──────────────────────────────────────────
// Config CRUD + test/list are one-shot request/response (panel ↔ SW). A
// completion is fire-and-forget (AI_REQUEST) with streaming replies broadcast
// by the SW as AI_CHUNK / AI_DONE / AI_ERROR keyed by requestId; AI_CANCEL
// aborts the in-flight request. The API key never leaves the SW — it is stored
// encrypted and decrypted only on the way to a provider.
export type AiMessage =
  | { type: 'AI_GET_CONFIG' }
  | { type: 'AI_CONFIG_DATA'; configured: boolean; provider?: AiProviderId; model?: string; customProvider?: AiCustomProvider }
  | { type: 'AI_SAVE_CONFIG'; provider: AiProviderId; model: string; apiKey?: string }
  | { type: 'AI_SAVE_CUSTOM_PROVIDER'; json: string }
  | { type: 'AI_REMOVE_CONFIG' }
  | { type: 'AI_CONFIG_SAVED'; ok: boolean; configured: boolean; provider?: AiProviderId; model?: string; customProvider?: AiCustomProvider; error?: string }
  // Broadcast (SW → all pages) whenever the stored AI config changes, so
  // already-open editor / studio surfaces can show or hide the assistant live
  // (zero-footprint: removing the key must disable it without a reload).
  | { type: 'AI_CONFIG_CHANGED'; configured: boolean; provider?: AiProviderId; model?: string; customProvider?: AiCustomProvider }
  | { type: 'AI_TEST' }
  | { type: 'AI_TEST_RESULT'; ok: boolean; model?: string; ms?: number; error?: string }
  | { type: 'AI_LIST_MODELS'; provider: AiProviderId }
  | { type: 'AI_MODELS_RESULT'; ok: boolean; models?: string[]; error?: string }
  | { type: 'AI_REQUEST'; payload: AiRequestPayload }
  | { type: 'AI_CHUNK'; requestId: string; delta: string }
  | { type: 'AI_DONE'; requestId: string }
  | { type: 'AI_ERROR'; requestId: string; message: string }
  | { type: 'AI_CANCEL'; requestId: string }
  // ── Chat (tool-using conversation) ──────────────────────────────
  // AI_CHAT_SEND runs one user turn; the SW streams AI_CHAT_EVENT broadcasts
  // keyed by requestId (the exact primitive AI_CHUNK uses). The panel owns the
  // transcript and sends `history` whole each turn; `text` is the new turn.
  | { type: 'AI_CHAT_SEND'; requestId: string; text: string; history: AiChatTurn[]; envelope: AiContextEnvelope }
  | { type: 'AI_CHAT_EVENT'; requestId: string; event: AiChatEvent }
  | { type: 'AI_CHAT_CANCEL'; requestId: string }
  // Chat code-block Preview + "Fix it": dry-run EC, return the result text.
  | { type: 'AI_PREVIEW_CODE'; requestId: string; code: string }
  | { type: 'AI_PREVIEW_RESULT'; requestId: string; purpose: 'verification'; ok: boolean; resultText: string }
  // Structured Change Ticket lifecycle. Preview returns a short-lived id
  // bound in the SW to exact code + active BMP server + actor. Run accepts
  // only that id, so UI/source edits cannot bypass Preview. Verification
  // previews use AI_PREVIEW_CODE and can never produce a runnable id.
  | {
      type: 'AI_PREVIEW_CHANGE';
      requestId: string;
      proposal: AiChangeProposal;
      /** Verified card target, when its object token resolved in the tool ledger. */
      expectedTarget?: { rid: string; businessId?: string };
    }
  | { type: 'AI_PREVIEW_CHANGE_RESULT'; requestId: string; purpose: 'change'; ok: boolean; resultText: string; previewId?: string; runnable: boolean }
  | { type: 'AI_RUN_CHANGE'; requestId: string; previewId: string }
  | { type: 'AI_RUN_CHANGE_RESULT'; requestId: string; ok: boolean; resultText: string; partial?: boolean }
  // Apply a proposed code block to the open editor/studio via the standard
  // merge-diff proposal. Routed to the surface holding the target object.
  | { type: 'AI_APPLY_PROPOSAL'; code: string; target: { rid: string; slot: string } }
  // Insert a proposed code block at the open editor/studio's CURSOR (additive,
  // not a slot replace) via the same merge-diff proposal. Routed to the surface
  // holding the target object, exactly like AI_APPLY_PROPOSAL.
  | { type: 'AI_INSERT_AT_CURSOR'; code: string; target: { rid: string; slot: string } }
  // Chat "Open in editor" (no editor context chip attached): launch the
  // Extended Code editor in free-script mode preloaded with the block's code.
  | { type: 'AI_OPEN_IN_EDITOR'; code: string }
  // Command strip's Ask hands off to the chat tab: the SW opens the sidepanel
  // and forwards this so the panel switches to the AI tab and submits it.
  | { type: 'AI_CHAT_HANDOFF'; text: string; quote?: AiChatQuote; envelope: AiContextEnvelope }
  // Editor/studio → SW update. This request is deliberately distinct from the
  // scoped AI_EDITOR_CONTEXT response so the raw runtime message is never
  // consumed directly by every side panel in every Chrome window.
  | { type: 'AI_EDITOR_CONTEXT_UPDATE'; source: AiContextSource | null }
  // SW → one window's panel: context for that window's active BMP tab.
  | { type: 'AI_EDITOR_CONTEXT'; source: AiContextSource | null }
  | { type: 'AI_GET_EDITOR_CONTEXT' };

export type InspectorMessage =
  | { type: 'OPEN_ACCESS_WORKSPACE'; environment?: string; destination?: AccessDestination }
  | { type: 'ACCESS_WORKSPACE_NAVIGATE'; tabId: number; environment: string; destination: AccessDestination }
  | { type: 'ACCESS_WORKSPACE_REQUEST'; environment: string; request: AccessRequest }
  | { type: 'ACCESS_WORKSPACE_RESULT'; ok: boolean; data?: unknown; error?: string }
  | PageMessage | InspectMessage | CacheMessage | ServerLookupMessage
  | ConnectionMessage | ProfileMessage | EcMessage | StudioMessage | FrameOverlayMessage | EnrichMessage
  | DetectionMessage | ActivityMessage
  | HistoryMessage | FavoritesMessage | ContextMenuMessage
  | ObjectViewMessage | ObjectPaneMessage
  | CompareMessage | CodeSearchMessage | TransportMessage | ScriptHistoryMessage
  | ColorMessage | NotificationMessage | LayoutMessage | StylePresetMessage | PagePrefsMessage
  | AiMessage;
