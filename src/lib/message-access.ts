/**
 * Who may send which message: an allow-list per sender kind.
 *
 * - `content`: a content script inside a BMP page. It runs next to page code
 *   that Companion does not control, so it may send only what the content
 *   script and Blueprint actually send (derived from src/content*.ts and
 *   src/content-blueprint/).
 * - `frame`: one of Companion's own pages embedded in a BMP page (object
 *   window, editor, Studio, code search, Compare). Extension origin, but the
 *   page around it is not trusted, so it gets the set those windows send.
 * - `extension`: Companion's own top-level pages (side panel, Access
 *   workspace). They may send every registered type.
 *
 * Every registered request type has an entry; `message-access.test.ts` fails
 * when a new type is registered without one. An empty list means "extension
 * pages only". Anything not listed for a sender kind is refused and logged
 * once as a diagnostic.
 */

export type SenderKind = 'content' | 'frame' | 'extension';

const C = 'content' as const;
const F = 'frame' as const;
type Allowed = ReadonlyArray<typeof C | typeof F>;

/** Non-extension senders allowed per message type. */
export const MESSAGE_ACCESS: Readonly<Record<string, Allowed>> = {
  // Page facts and Blueprint (content script)
  DETECTION_RESULT: [C],
  PAGE_CONTEXT: [C],
  BMP_URL_CHANGED: [C],
  BMP_PAGE_RENDER_CHANGED: [C],
  OBJECTS_DISCOVERED: [C],
  ENRICH_BADGES: [C],
  SET_CONTEXT_RID: [C, F],
  PREFETCH_OBJECT_VIEW: [C],
  INSPECT_EDIT_PAGE_FIELDS: [C],
  INJECT_BLUEPRINT: [C],
  BLUEPRINT_RESUME: [C],
  BLUEPRINT_CLOSE: [C],
  BLUEPRINT_TOGGLE: [C],
  LAYOUT_LOAD: [C],
  LAYOUT_LINKS: [C],
  LAYOUT_APPLY: [C],
  LAYOUT_BLAST: [C],
  LAYOUT_FLOW_REFS: [C],
  LAYOUT_FLOW_REF_CHILDREN: [C],
  LAYOUT_FLOW_SETTINGS: [C],
  LAYOUT_PORTABLE_ID_PREFLIGHT: [C],
  LIST_STYLE_PRESETS: [C],
  SAVE_STYLE_PRESET: [C],
  DELETE_STYLE_PRESET: [C],
  // One fixed preference key each, validated (handlers/page-prefs.ts):
  // content scripts cannot read extension storage themselves.
  FRAME_BOUNDS_GET: [C],
  FRAME_BOUNDS_SAVE: [C],
  PORTABLE_IDS_GET: [C],
  PORTABLE_IDS_SAVE: [C],
  FETCH_COLOR_SETS: [C, F],
  FETCH_TYPE_SCHEMAS: [C, F],
  // Shared reads and launches
  GET_CONNECTION_STATE: [C, F],
  HOVER_LOOKUP: [C, F],
  OPEN_OBJECT_VIEW: [C, F],
  OPEN_EDITOR: [C, F],
  OPEN_STUDIO: [C, F],
  OPEN_ACCESS_WORKSPACE: [C, F],
  // Colors and images page; the object window's image picker reads the same lists.
  OPEN_COLORS_IMAGES: [F],
  IMAGE_INDEX: [F],
  IMAGE_BYTES: [F],
  COLORS_IMAGES_WRITE: [],
  SAVE_IDENTITY: [C, F],
  // Windows (frames)
  OPEN_OBJECT_ROOT: [F],
  READ_OBJECT_SUMMARIES: [F],
  READ_FULL_OBJECTS: [F],
  APPLY_OBJECT_CHANGES: [F],
  // Frames only for the object and environment they read (sender-trust.ts
  // frameMayWrite, checked by the handler); never from a page.
  APPLY_CUSTOM_CHANGES: [F],
  FETCH_PROPERTY_SCHEMA: [F],
  FETCH_ALLOWED_OBJECTS: [F],
  SAVE_PROPERTY: [F],
  FETCH_TYPE_SCHEMA: [F],
  FETCH_TYPE_OPTIONS: [F],
  FETCH_EDIT_FIELD_TYPES: [F],
  FETCH_PROPERTY_APPLICATIONS: [F],
  FETCH_INBOUND: [F],
  FETCH_INBOUND_CANCEL: [F],
  FETCH_EDITOR_CONTEXT: [F],
  LIST_REFERENCED: [F],
  RESOLVE_CODE_REFS: [F],
  RESOLVE_ROOT_CATEGORY: [F],
  RECORD_RECENT: [F],
  RECORD_CHANGES: [F],
  TOGGLE_FAVORITE: [F],
  GET_FAVORITES: [F],
  GET_HISTORY: [F],
  GET_SCRIPT_HISTORY: [F],
  RELOAD_BMP_TAB: [F],
  OPEN_BLUEPRINT_FOR: [F],
  OPEN_CODE_SEARCH: [F],
  OPEN_COMPARE: [F],
  ACCESS_MODE_DECIDE: [F],
  ACCESS_MODE_PREPARE: [F],
  ACCESS_MODE_STATUS: [F],
  ACCESS_MODE_TRACE: [F],
  CODE_INDEX_GET_STATUS: [F],
  CODE_INDEX_SYNC: [F],
  CODE_INDEX_ESTIMATE: [F],
  CODE_INDEX_CANCEL: [F],
  CODE_INDEX_REMOVE: [F],
  CODE_SEARCH_START: [F],
  CODE_SEARCH_STOP: [F],
  CODE_SEARCH_STATUS: [F],
  CODE_SEARCH_CODE: [F],
  CODE_SEARCH_SCOPE: [F],
  CODE_SEARCH_ROOTS: [F],
  CODE_SEARCH_RESOLVE: [F],
  // Transport (beta): environment-bound (handlers/transport.ts).
  TRANSPORT_SCAN: [F],
  TRANSPORT_SCAN_UNDER: [F],
  TRANSPORT_CHILDREN: [F],
  TRANSPORT_COUNTS: [F],
  TRANSPORT_SCAN_BELOW: [F],
  TRANSPORT_FIND: [F],
  TRANSPORT_SOURCE_LISTING: [F],
  TRANSPORT_READ_OBJECTS: [F],
  TRANSPORT_READ_CREATION: [F],
  TRANSPORT_LOG: [F],
  TRANSPORT_SEARCH: [F],
  TRANSPORT_ROWS: [F],
  TRANSPORT_USED_BY: [F],
  TRANSPORT_FACTS: [F],
  // The objects of the page the window sits on (the sender's own tab).
  TRANSPORT_PAGE_OBJECTS: [F],
  // The other connected workspaces, and one part run on one of them (a
  // committed run only with the apply flow's explicit confirmation).
  TRANSPORT_TARGETS: [F],
  TRANSPORT_RUN_PART: [F],
  TRANSPORT_CANCEL: [F],
  // Numeric IDs: reads, and the change itself (committed only after the confirmation).
  NUMERIC_IDS_SCAN: [F],
  NUMERIC_IDS_ORIGINS: [F],
  NUMERIC_IDS_RUN: [F],
  // Opened from the side panel only.
  OPEN_TRANSPORT: [],
  BROWSE_SEARCH: [F],
  BROWSE_RESOLVE: [F],
  OBJECT_SEARCH: [F],
  OBJECT_SEARCH_CANCEL: [F],
  COMPARE_SUGGEST: [F],
  READ_COMPARE: [F],
  EC_EXECUTE: [F],
  EC_SYNTAX_CHECK: [F],
  EDITOR_LAUNCH_READY: [F],
  HOVER_RESOLVE: [F],
  JSON_SHAPE_READ: [F],
  BMP_GOTO: [F],
  CONNECTION_TEST: [F],
  AI_GET_CONFIG: [F],
  AI_REQUEST: [F],
  AI_CANCEL: [F],
  AI_CHAT_HANDOFF: [F],
  SHOW_IN_LOG: [C, F],
  AI_EDITOR_CONTEXT_UPDATE: [F],
  STUDIO_FETCH_CODE: [F],
  STUDIO_FETCH_CHILDREN: [F],
  STUDIO_FETCH_DATA: [F],
  STUDIO_FETCH_RESOURCE: [F],
  STUDIO_RESOLVE_REF: [F],
  STUDIO_RESOLVE_RIDS: [F],
  STUDIO_ADD_CHILD: [F],
  STUDIO_SAVE_CHILD: [F],
  STUDIO_DELETE_CHILD: [F],
  STUDIO_WRITE_RESOURCE: [F],
  // Extension pages only (side panel, Access workspace)
  GET_SETTINGS: [],
  SAVE_SETTINGS: [],
  RETRY_SETTINGS_LOAD: [],
  SAVE_PROFILE: [],
  DELETE_PROFILE: [],
  SET_ACTIVE_PROFILE: [],
  SITE_ACCESS_CHANGED: [],
  CLEAR_CACHE: [],
  RESET_ALL: [],
  GET_ACTIVITY: [],
  GET_CHANGES: [],
  CLEAR_CHANGES: [],
  GET_CACHE: [],
  GET_CACHE_BYTES: [],
  GET_CONTEXT_RID: [],
  GET_DETECTION: [],
  GET_PAGE_INFO: [],
  GET_SERVER_LOAD: [], // diagnostics hook: the test rig reads the load governor through it
  RESET_SCRIPT_COUNT: [],
  LOCATE_ON_PAGE: [],
  SET_INSPECT_STATE: [],
  TOGGLE_INSPECT: [],
  TOGGLE_POINT_TELL: [],
  POINT_TELL_STATE: [C],
  POINT_TELL_SERVER: [C],
  POINT_TELL_CAPTURE: [C],
  POINT_TELL_SEND: [C],
  POINT_TELL_REQUEUE: [C],
  POINT_TELL_STATUS: [C],
  POINT_TELL_VOICE: [C],
  OPEN_CLAUDE_SETUP: [C],
  OPEN_EXTENDED: [],
  BROWSE_TREE: [],
  ACCESS_WORKSPACE_REQUEST: [],
  AI_SAVE_CONFIG: [],
  AI_SAVE_CUSTOM_PROVIDER: [],
  AI_REMOVE_CONFIG: [],
  AI_TEST: [],
  AI_LIST_MODELS: [],
  AI_CHAT_SEND: [],
  AI_CHAT_CANCEL: [],
  AI_GET_EDITOR_CONTEXT: [],
  AI_PREVIEW_CODE: [],
  AI_PREVIEW_CHANGE: [],
  AI_RUN_CHANGE: [],
  AI_APPLY_PROPOSAL: [],
  AI_INSERT_AT_CURSOR: [],
  AI_OPEN_IN_EDITOR: [],
};

/** Whether a sender of `kind` may send `type`. Unknown types are refused for
 *  content scripts and frames. */
export function senderKindMay(kind: SenderKind, type: string): boolean {
  if (kind === 'extension') return true;
  const allowed = MESSAGE_ACCESS[type];
  return !!allowed && (allowed as readonly string[]).includes(kind);
}
