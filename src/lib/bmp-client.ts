/**
 * BMP client facade — composes BmpAuth + BmpTransport.
 * Public API unchanged for all consumers.
 */

import { readRowFacts as readRowFactsFor, type RowFactsRead } from './object-row-facts';
import { appendRowEc, CONTEXT_OBJECT, contextObjectEc, countedFlushEc, createEcFrame, EC_CHUNK, EC_FRAME, parseFramedLog } from './ec-parser';
import {
  registerBmpTypes,
  makeGetObjectCommand,
  makeUpdateCommand,
  makeExtendedExecuteCommand,
  makeTreeItemCommand,
  makeGetServerSettingsCommand,
  makeAccessTraceCommand,
  makeGetTypeFieldsCommand,
  makeLoadTypeConfigCommand,
  makeReferenceIdentityCommand,
  type AccessTraceUpdates,
  parseEcResults,
  parseCommandResponse,
  parseTreeNodeInfo,
  type EcOutputEntry,
} from './bmp-types';
import { colorLinkBid } from './color-util';
import { fileLinkRhs, isFileLinkProp, OBJECT_FILE_PROPS } from './file-link-props';
import { styleAssignRhs, INVALID_COLOR_BID } from './style-ec';
import type {
  ColorSetData, AccessTraceAction, AccessTraceNode, AccessSubject, BmpObject,
  LayoutNode, ObjectPanePayload,
} from './types';
import { log } from './logger';
import { assertHostAccess, HostAccessError } from './site-access';
import { HEALTH_TIMEOUT, AUTH_TIMEOUT, CONTEXT_PER_POST, EC_TIMEOUT, OBJECT_RELATION_EC_TIMEOUT } from './constants';
import { fullObjectFromPane, OBJECT_NO_DATA, parseFullObject, type FullObject } from './object-read';
import type { FullObjectsRead } from './object-window';
import { buildStructureEc, parseStructureRows, type StructureRows, type StructureRule } from './object-structure';

/** Object reads sharing one sendCommands post (object window batch). */
const FULL_READ_BATCH = 100;
/** BMP's own answer when its heap is exhausted. */
const SERVER_OOM = /OutOfMemoryError|Java heap space|GC overhead limit/;
/** Identity lookups (TreeItemCommand) sharing one post on pre-5.6.3 BMP. */
const TREE_ITEM_BATCH = 25;
const RID_SHAPE = /^-?\d+$/;
import { BmpAuth, AuthError } from './bmp-auth';
import type { CommandAuthMode, AuthErrorCode } from './bmp-auth';
import { BmpTransport, type BmpTransportOutcome } from './bmp-transport';
import { backgroundSignal, inheritClass } from './request-class';
import { readIsolating } from './batch-isolate';
import { compareVersions } from './util';
import { BmpRequestError, ecResultError, errorKindOf, isConnectionKind, type BmpErrorKind } from './error-kind';
import { OBJECT_TEXT_PROPS } from './pane-schema';
import { validateBusinessId, validateRid, validateEcIdentifier, formatEcLiteral, ecScalarLiteral } from './ec-guards';
import { resolveNamespace } from './namespace';
import { ecResolveTemplate } from './template-link';
import { EcQueryService } from './ec-query-service';
import { commandResults, javaMapEntries, parseTypeCatalogue, parseReferenceIdentity, type BmpReferenceFact } from './bmp-type-catalogue';
import type { IdentityChangeSet } from './object-identity';
import { decodeSearchStreams, makeSearchCommand, registerSearchCommand, type SearchAnswer, type SearchCommandOptions } from './search-command';
import { decodeTreeEvents, laterPackId, makeTreeEventCommand, registerTreeEventCommand, type TreeEventAnswer } from './tree-events';
import { constantScript, SCRIPT_LIMITS, userScript, varyingScript } from './script-kinds';
import { LIST_ITEMS_MAX, parseFieldDescription, VALID_TYPE_NAME, type AllowedObjects, type AllowedSource, type FieldDescription, type ListItem } from './property-schema';

/** The children of the context object (a list set), one length-framed row
 *  per item (ec-parser.ts): RID, ID and name. A name is never searched for a
 *  marker, so no stored text can add or shift a row. */
const LIST_ITEMS_EC = constantScript('listItems', contextObjectEc('_s', [
  '_k := 0',
  '_s.children().forEach(_i:',
  ...appendRowEc(EC_CHUNK, ['_i.rid', '_i.id.whenMissing("")', '_i.name.whenMissing("")'], '     '),
  ...countedFlushEc('_k', 20),
  ')',
]).join('\n'));

/** The name of an allowed object: a user's full name (its `name` is the
 *  first name only), else the object's name. Measured: `fullName` is missing
 *  on other objects and `whenMissing` then yields the fallback. */
const ALLOWED_NAME_EC = '_i.fullName.whenMissing(_i.name.whenMissing(""))';

/** Parse LIST_ITEMS_EC: three-field rows, digits-only RIDs. A damaged or
 *  cut-off answer throws (the row stays read-only). */
export function parseListItems(log: string): ListItem[] {
  const out: ListItem[] = [];
  for (const [rid, id, name] of parseFramedLog(log, EC_FRAME, 3)) {
    if (!/^\d{1,20}$/.test(rid)) throw new Error('BMP returned a list item without a RID');
    out.push({ rid, id, name });
  }
  return out;
}

/**
 * The objects a reference property allows for the context object: the
 * definition's own expression, calculated on the object, without sending
 * the expression text (`<definition>.expression`). Measured on BMP 5.6.17:
 * `_o.calculate(lookup(<definition>).expression).first()` yields the
 * allowed objects, and `this.object` inside the definition's expression is
 * then `_o`. One length-framed row per object (RID, ID, name, as
 * LIST_ITEMS_EC, parsed by parseListItems); at most LIST_ITEMS_MAX + 1 rows
 * are written, so one more than the cap says "too many". Run
 * non-transactionally (executeEcScriptsOn).
 *
 * `definitionRef` is the definition's reference form from resolveRefs
 * (`lookup(<rid>)`, or the pre-lookup form of an older server): the text
 * varies only with the definition, a small fixed set per server, so it is
 * a constant builder.
 */
export function buildAllowedObjectsEc(definitionRef: string): string {
  return constantScript('allowedObjects', contextObjectEc('_o', [
    `_c := _o.calculate(${definitionRef}.expression).first()`,
    'IF _c != MISSING THEN',
    '     _k := 0',
    '     _n := 0',
    '     _c.forEach(_i:',
    '          _n := _n + 1',
    `          IF _n <= ${LIST_ITEMS_MAX + 1} THEN`,
    ...appendRowEc(EC_CHUNK, ['_i.rid', '_i.id.whenMissing("")', ALLOWED_NAME_EC], '               '),
    ...countedFlushEc('_k', 20, '               '),
    '          ENDIF',
    '     )',
    'ENDIF',
  ]).join('\n'));
}

/**
 * The objects a reference property "by type" allows (a definition without
 * an expression): every object whose class is one of `types`, exactly that
 * class when `exactClass` (`className`, measured to be the simple class
 * name), else with subclasses (plain `SELECT`). Measured on BMP 5.6.17:
 * `SELECT <type>` yields every object of the type, and the type must be a
 * literal in the script (`SELECT _var` does not work). One `SELECT` per
 * type, each cut to LIST_ITEMS_MAX + 1 objects, joined without duplicates
 * (`merge`); then the rows and the cap of buildAllowedObjectsEc, parsed by
 * parseAllowedObjects. The objects do not depend on the context object;
 * the script runs in the same post as the others, on the same context.
 *
 * Not applied: the definition's tree filter. Its `filter` cannot be read
 * (opaque, `""` in the read also when set), so when a tree filter is
 * configured this list may be wider than BMP's own picker shows.
 * Definitions with selection roots or `filtered` true are not editable and
 * never reach this builder (property-schema.ts byTypeBlock).
 *
 * `types` are validated type names (VALID_TYPE_NAME), a small fixed set per
 * server, so it is a constant builder.
 */
export function buildAllowedByTypeEc(types: readonly string[], exactClass: boolean): string {
  const names = [...new Set(types)];
  if (!names.length) throw new Error('No allowed types');
  for (const t of names) if (!VALID_TYPE_NAME.test(t)) throw new Error(`Invalid type: ${t}`);
  const cap = LIST_ITEMS_MAX + 1;
  return constantScript('allowedByType', contextObjectEc('_o', [
    '_c := LIST()',
    ...names.flatMap(t => [
      `_t := SELECT ${t}`,
      `_c := _c.merge(_t${exactClass ? `.filter(className = "${t}")` : ''}.first(${cap}))`,
    ]),
    '_k := 0',
    '_n := 0',
    '_c.forEach(_i:',
    '     _n := _n + 1',
    `     IF _n <= ${cap} THEN`,
    ...appendRowEc(EC_CHUNK, ['_i.rid', '_i.id.whenMissing("")', ALLOWED_NAME_EC], '          '),
    ...countedFlushEc('_k', 20, '          '),
    '     ENDIF',
    ')',
  ]).join('\n'));
}

/** Parse buildAllowedObjectsEc or buildAllowedByTypeEc: the rows as list
 *  items, cut to LIST_ITEMS_MAX; `tooMany` when there were more. A damaged
 *  or cut-off answer throws. */
export function parseAllowedObjects(log: string): AllowedObjects {
  const rows = parseListItems(log);
  return rows.length > LIST_ITEMS_MAX ? { items: rows.slice(0, LIST_ITEMS_MAX), tooMany: true } : { items: rows };
}

export { buildAccessSubjectsEc, parseAccessSubjectsLog, parseResolveTemplateLog, buildLayoutTreeEc, parseAwtColor } from './ec-query-service';

/** The subset of BMP's GraphQL quickSearch response we read (external, evolving
 *  schema — fields are optional and loosely typed on purpose). */
interface QuickSearchHit {
  epmObject?: {
    rid?: string | number; name?: string; type?: string;
    webParentRid?: string | number; webParentName?: string;
    hasChildren?: boolean; tabRid?: string | number;
  };
  pageLocationInfo?: { rid?: string | number; name?: string };
}
interface QuickSearchData { totalHits?: number; hits?: QuickSearchHit[]; }

/** The quick-search payload's RID keys (QuickSearchHit: epmObject.rid,
 *  webParentRid, tabRid; pageLocationInfo.rid), by their exact names. */
const QUICK_SEARCH_RID_KEYS = ['rid', 'webParentRid', 'tabRid'] as const;

/** JSON whose RID values stay exact: an integer value (or an array of
 *  integers) of one of `keys` is read as its decimal text, never as a JS
 *  number (BMP RIDs are 64-bit). Every other number is unchanged; a key is
 *  matched by its whole name, so `grid` stays a number. */
export function parseJsonKeepingRids(text: string, keys: readonly string[] = QUICK_SEARCH_RID_KEYS): any {
  const names = keys.map(k => k.replace(/[^A-Za-z0-9_]/g, '')).filter(Boolean).join('|');
  if (!names) return JSON.parse(text);
  const key = String.raw`("(?:${names})"\s*:\s*)`;
  const quoted = text
    // "rid": 123  (outside strings: a quoted key, a colon, a bare integer)
    .replace(new RegExp(String.raw`${key}(-?\d+)(?=\s*[,}\]])`, 'g'), '$1"$2"')
    // "rid": [123, 456]
    .replace(new RegExp(String.raw`${key}\[([-\d,\s]*)\]`, 'g'), (_m, k: string, list: string) => `${k}[${list.split(',').map(x => x.trim()).filter(Boolean).map(x => `"${x}"`).join(',')}]`);
  return JSON.parse(quoted);
}

// Ensure BMP types are registered once
registerBmpTypes();

/** Validate that a RID is a numeric string (positive or negative). Prevents EC injection. */
// Identifier / RID guards live in ec-guards.ts so ec-codegen can apply
// them at every interpolation slot too (defence-in-depth for the walker
// EC, not just the save paths).

export interface ConnectionResult {
  ok: boolean;
  message: string;
  authenticated: boolean;
  /** Machine-readable cause on failure — drives the connection UI state.
   *  `transport`: sign-in never got an answer (network error or timeout). */
  code?: AuthErrorCode | 'transport';
}

export interface HealthCheckResult {
  /** The workspace answers and reports itself running. */
  up: boolean;
  /** Something answered at the address (false: network failure or timeout). */
  reachable: boolean;
  /** The address answers but is not a BMP workspace (wrong path or host). */
  notWorkspace?: boolean;
  responseMs: number;
  /** Underlying reason when not up. */
  detail?: string;
}

export type BuildNumberProbeResult =
  | { status: 'known'; version: string }
  | { status: 'auth-required' }
  | { status: 'unavailable' }
  | { status: 'transient' };

export interface EcResult {
  ok: boolean;
  log?: string;
  outputEntries?: EcOutputEntry[];
  hasError?: boolean;
  hasWarning?: boolean;
  error?: string;
  /** Why the run failed when a transport failure caused it. Unset for an
   *  EC/server error (`ok: false` with BMP's own error text). */
  errorKind?: BmpErrorKind;
  /** A transactional run whose answer did not arrive (time-out, or the
   *  connection failed after the request left): BMP may have applied it. */
  outcomeUnknown?: boolean;
}

/** Whether a failed write may still have been applied (save-check.ts): a
 *  time-out or a network failure once the request was sent. A transport
 *  error with zero attempts never left the extension. */
function writeOutcomeUnknown(e: unknown, kind: BmpErrorKind | undefined): boolean {
  if (kind !== 'timeout' && kind !== 'network') return false;
  const attempts = (e as { attempts?: unknown } | null)?.attempts;
  return !(e instanceof Error && e.name === 'BmpTransportError' && attempts === 0);
}

export interface TemplateResolution {
  templateRid: string | null;
  templateName?: string;
  templateType?: string;
  templateBusinessId?: string;
}

/** Structured editor context returned by fetchEditorContext() — single EC call. */
export interface EditorContextData {
  instance: { rid: string; businessId: string; type: string; name: string };
  template: { rid: string; businessId: string; type: string; name: string } | null;
  instanceCode: Record<string, string>;
  templateCode: Record<string, string>;
  locationRid?: string;
}

/** Object pane data: identity + parent + template + style props + siblings
 *  (fetchObjectPane; the AI property inspection reads it). */
export type ObjectPaneData = ObjectPanePayload;


/** Properties surfaced by the object pane. Allowlisted to prevent EC injection
 *  via attacker-controlled keys and to gate UI editors per property type. */
export const PANE_PROPS = [
  // Property-definition metadata. Missing safely on non-property objects.
  'description', 'category',
  'width', 'height',
  // Responsive width — verified live via bmp_type_fields on Scorecard subtypes;
  // ResponsiveWidth mixin attaches these to layout-bearing widgets. 0-6 each,
  // 0 == 6 (full width).
  'columnsLargeScreen', 'columnsMediumScreen', 'columnsSmallScreen',
  // Display-level toggles attached by HasToolsMenu / HasDisableSearch mixins.
  'showToolMenu', 'disableSearch',
  // HasWidgetColors declares only headerColor + fontColor (no bgColor —
  // verified against the live type schema).
  'headerColor', 'fontColor',
  'shadow', 'transparency',
  'headerStyle', 'borderStyle',
  // Visibility — Visibillity mixin (`visible`) + ScreenSizeVisibility mixin
  // (per-breakpoint booleans). The legacy `hidden` field doesn't exist on
  // current BMP types; we read/write `visible` instead.
  'visible',
  'shownOnLargeDisplay', 'shownOnMediumDisplay', 'shownOnSmallDisplay',
  // HasColumnWidths mixin — list-bearing widgets (ExtendedTable,
  // IndicatorList, IssueList, RiskList, TaskList, …). Read-only in
  // the pane; the value is a `ColumnWidths` object that EC stringifies
  // to a readable summary. Editing is deferred — the constructor takes
  // a structured per-column map that we don't yet have a UI for.
  'columnWidths',
  // EditField → property accessor on the business object created/edited by
  // the owning CreateObjectView. Full Object View renders a live class-schema
  // picker for this rather than a free-text box.
  'propertyMapping',
  // Essential EditField behaviour. Keep these in the same focused Field
  // section as propertyMapping; Blueprint owns structure, Object View owns
  // deliberate field configuration.
  'required', 'placeholder', 'propertyHint',
  // Label default mode. Both have concrete setters on Label and are edited
  // together through the pane's confirmed, atomic change() path.
  'textInputType', 'advancedDefault',
] as const;
export type PaneProp = typeof PANE_PROPS[number];
export const PANE_PROPS_SET: ReadonlySet<string> = new Set(PANE_PROPS);

/** Identity fields edited from Full Object View. Keep these separate from
 * PANE_PROPS: they are already returned as ObjectPaneIdentity, so adding them
 * to the pane-property query would fetch the same values a second time. */
export const OBJECT_IDENTITY_PROPS = ['name', 'id'] as const;
/** Expression gates the object window edits next to their expression
 * (`useShowExpression` …). Written only through APPLY_OBJECT_CHANGES, never
 * fetched by the pane query, so they stay out of PANE_PROPS. */
export const OBJECT_GATE_PROPS = ['useShowExpression', 'useEnableExpression'] as const;
export const OBJECT_CHANGE_PROPS_SET: ReadonlySet<string> = new Set([
  ...PANE_PROPS,
  ...OBJECT_FILE_PROPS,
  ...OBJECT_TEXT_PROPS,
  ...OBJECT_IDENTITY_PROPS,
  ...OBJECT_GATE_PROPS,
]);

// ── Access-trace parsing ──────────────────────────────────────────
// The deserialized tree uses boxed java.lang.Boolean ({value}), HashMaps
// ({$map} / {$entries}), ArrayLists ({$elements}) and java.time.Duration.
// These coercers normalise that into
// a clean AccessTraceNode the UI can render directly.

function atCoerceBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'boolean') {
    return (v as { value: boolean }).value;
  }
  return null;
}

function atStringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as { value?: unknown; identifier?: unknown };
    if (o.value != null) return String(o.value);
    if (o.identifier != null) return String(o.identifier);
    return '';
  }
  return String(v);
}

function atCoerceStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object') return out;
  const o = v as { $map?: Record<string, unknown>; $entries?: [unknown, unknown][] };
  if (o.$map && typeof o.$map === 'object') {
    for (const [k, val] of Object.entries(o.$map)) out[String(k)] = atStringify(val);
  } else if (Array.isArray(o.$entries)) {
    for (const [k, val] of o.$entries) out[atStringify(k)] = atStringify(val);
  }
  return out;
}

export function parseAccessTraceNode(dto: any): AccessTraceNode {
  const kids = dto?.childrenDTOs?.$elements ?? dto?.childrenDTOs ?? [];
  const durationMs = dto?.duration?.durationMs;
  return {
    element: String(dto?.element ?? ''),
    result: atCoerceBool(dto?.result),
    timedOut: dto?.timedOut === true,
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    details: atCoerceStringMap(dto?.details),
    children: Array.isArray(kids) ? kids.map(parseAccessTraceNode) : [],
  };
}

/** Pull the first trace tree out of a deserialized AccessTraceCommand response
 *  (`ArrayList<IntegrationObjectResponse>` → `.response.traces`). Throws on a
 *  server exception. Factored out so the unwrap is unit-testable without BMP. */
export function extractAccessTrace(objects: any[]): AccessTraceNode | null {
  for (const obj of objects) {
    if (obj?.$class?.includes('ServerExceptionResponse')) {
      throw new Error(obj.message ?? 'Access trace was rejected by BMP');
    }
    if (obj?.$class === 'java.util.ArrayList') {
      const resp = obj.$elements?.[0]?.response;
      const tracesRaw = resp?.traces;
      const traces = tracesRaw?.$elements ?? tracesRaw;
      if (Array.isArray(traces) && traces.length > 0) return parseAccessTraceNode(traces[0]);
    }
  }
  return null;
}

/** Every command's trace list from one multi-command AccessTraceCommand
 *  request, in command order. Throws on a server exception or when BMP
 *  answered fewer commands than were sent. */
export function extractAccessTraceLists(objects: any[], count: number): AccessTraceNode[][] {
  const lists: AccessTraceNode[][] = [];
  for (const obj of objects) {
    if (obj?.$class?.includes('ExceptionResponse')) throw new Error(obj.message ?? 'Access trace was rejected by BMP');
    if (obj?.$class !== 'java.util.ArrayList') continue;
    for (const item of obj.$elements ?? []) {
      if (item?.$class?.includes('ExceptionResponse')) throw new Error(item.message ?? 'Access trace was rejected by BMP');
      const raw = item?.response?.traces;
      const traces = raw?.$elements ?? raw;
      lists.push(Array.isArray(traces) ? traces.map(parseAccessTraceNode) : []);
    }
  }
  if (lists.length !== count) throw new Error(`BMP answered ${lists.length} of ${count} access checks.`);
  return lists;
}

/** Split the stream of a multi-command EC post into one result per command.
 *  Each command's answer ends with its ExtendedExecuteResult (or a server
 *  exception in its place). A stream with a different number of answers is
 *  not trusted for any command. */
export function splitEcResults(objects: any[], count: number): EcResult[] {
  const groups: any[][] = [];
  let current: any[] = [];
  for (const obj of objects) {
    current.push(obj);
    const cls = String(obj?.$class ?? '');
    if (cls.endsWith('ExtendedExecuteResult') || cls.includes('ExceptionResponse')) {
      groups.push(current);
      current = [];
    }
  }
  if (groups.length !== count) {
    const exception = objects.find(obj => String(obj?.$class ?? '').includes('ExceptionResponse'));
    const error = exception?.message ?? `BMP answered ${groups.length} of ${count} scripts.`;
    return Array.from({ length: count }, () => ({ ok: false, error: String(error), errorKind: exception ? 'server' as const : 'protocol' as const }));
  }
  return groups.map(group => parseEcResults(group));
}

/** Lightweight cache interface — avoids coupling to ObjectCache. */
export interface IdentityCache {
  get(rid: string): { businessId?: string; type?: string } | undefined;
  invalidate?(rid: string): void;
}

/** A string field by name somewhere in a decoded response (depth-bounded). */
function findStringField(value: unknown, name: string, depth: number): string | null {
  if (!value || typeof value !== 'object' || depth < 0) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec[name] === 'string') return rec[name] as string;
  for (const v of Object.values(rec)) {
    const found = Array.isArray(v) ? v.map(x => findStringField(x, name, depth - 1)).find(x => x != null) ?? null : findStringField(v, name, depth - 1);
    if (found != null) return found;
  }
  return null;
}

const retiredListeners = new Set<(client: BmpClient) => void>();
/** Called when a client is retired (bmp-client retire): caches keyed by the
 *  client instance drop what it read. */
export function onClientRetired(fn: (client: BmpClient) => void): () => void {
  retiredListeners.add(fn);
  return () => retiredListeners.delete(fn);
}

/** A restart check is one small read (BmpClient.checkServerRestart). */
const RESTART_CHECK_TIMEOUT_MS = 10_000;

export class BmpClient {
  readonly auth: BmpAuth;
  private transport: BmpTransport;
  private _cache: IdentityCache | null = null;
  /** The EC-query family (build EC → executeEc → parse) — plan 021. New EC
   *  queries go here; new binary commands stay on BmpClient. */
  private ecQuery: EcQueryService;

  /** Whether server supports EC lookup(). null = unknown. Resolved from a
   * recognized version or one read-only capability probe. */
  supportsLookup: boolean | null = null;
  private lookupProbe: Promise<boolean> | null = null;
  private lookupProbeFailure: { error: Error; retryAt: number } | null = null;
  private capabilityRevision = 0;

  /** Whether the server runs a script on the command's context object
   *  (`this.object`): the readers send constant scripts that reach their
   *  object only that way. null = not checked yet (ensureContextSupport). */
  contextSupport: boolean | null = null;
  /** What the check found: `supported`, `ignored` (the server answered and
   *  did not use the context: an old server) or `unchecked` (every anchor
   *  failed: reads go by context, results say the check was not possible). */
  contextCheck: 'supported' | 'ignored' | 'unchecked' | null = null;
  private contextProbe: Promise<boolean> | null = null;

  /** Invalidate in-flight capability work as well as its cached result. */
  resetCapabilities(): void {
    this.capabilityRevision++;
    this.supportsLookup = null;
    this.lookupProbe = null;
    this.lookupProbeFailure = null;
    this.contextSupport = null;
    this.contextCheck = null;
    this.contextProbe = null;
    this.orgRidCache.clear();
  }

  /**
   * Once per connection: does this server run a script on the command's
   * context object? One tiny constant script gives the RIDs of two model
   * roots (the portal and the expression root: objects the readers
   * themselves use as context; the customer root cannot be one, BMP refuses
   * it). Then, root by root, `this.object`'s RID with that root as the
   * context:
   *  - the answer is that RID: supported;
   *  - an answer without it (empty, another RID): the server ignores the
   *    context (an old server): not supported;
   *  - a server error or an unreadable answer: undecided, the next root is
   *    tried; when every root is undecided the check is `unchecked`: reads go
   *    by context (most likely right) and a search that finds nothing says
   *    the check was not possible.
   * A connection failure decides nothing (the next read asks again). A client
   * whose executeEc is replaced (unit tests) is taken as supporting it.
   */
  async ensureContextSupport(signal?: AbortSignal): Promise<boolean> {
    if (this.contextSupport != null) return this.contextSupport;
    if (Object.prototype.hasOwnProperty.call(this, 'executeEc')) return true;
    const revision = this.capabilityRevision;
    const task = this.contextProbe ??= (async () => {
      const unknown = (r: EcResult) => r.errorKind != null && r.errorKind !== 'server';
      const anchor = await this.executeEc(constantScript('contextProbeAnchor', '"CTXA=" + str(root.portal.rid.whenMissing("")) + "|" + str(root.expression.rid.whenMissing("")) + "|"'), undefined, false, inheritClass(signal), AUTH_TIMEOUT);
      if (unknown(anchor)) throw ecResultError(anchor, 'The context check did not answer');
      const m = /CTXA=(-?\d{0,20})\|(-?\d{0,20})\|/.exec(anchor.log ?? '');
      const anchors = [...new Set((m ? [m[1], m[2]] : []).filter(rid => /^-?\d{1,20}$/.test(rid)))];
      let outcome: 'supported' | 'ignored' | 'unchecked' = 'unchecked';
      for (const rid of anchors) {
        const r = await this.executeEc(constantScript('contextProbe', '"CTX=" + str(this.object.rid.whenMissing("")) + "|"'), rid, false, inheritClass(signal), AUTH_TIMEOUT, undefined, { context: true, probe: true });
        if (unknown(r)) throw ecResultError(r, 'The context check did not answer');
        const answer = r.ok && !r.hasError ? /CTX=(-?\d{0,20})\|/.exec(r.log ?? '')?.[1] : undefined;
        if (answer == null) continue; // error or unreadable: undecided, next root
        outcome = answer === rid ? 'supported' : 'ignored';
        break;
      }
      if (revision !== this.capabilityRevision) throw new Error('BMP capability detection was reset; retry the operation');
      this.contextCheck = outcome;
      this.contextSupport = outcome !== 'ignored';
      if (outcome === 'ignored') log.warn('bmpClient:capabilities', 'This server ignores the command\'s context object: readers fall back to small scripts or report the read as not supported');
      if (outcome === 'unchecked') log.warn('bmpClient:capabilities', 'Could not check whether this server runs scripts on the command\'s context object: reads go by context; a search that finds nothing says so');
      return this.contextSupport;
    })();
    try { return await task; } finally { if (this.contextProbe === task) this.contextProbe = null; }
  }

  /** A context script in its text form for a server that ignores the
   *  context: the object (and item) by `lookup(<RID>)`, sent only when it
   *  stays a small varying script; otherwise a clear "not supported". */
  private contextTextForm(code: string, objectRid: string, itemRid: string | undefined, endMs: number | undefined, feature: string | undefined): string | EcResult {
    const unsupported: EcResult = {
      ok: false, errorKind: 'server',
      error: `This server version is not supported for ${feature ? `the ${feature} read` : 'this read'}: it does not run a script on the object it is about (the command's context).`,
    };
    if (this.supportsLookup === false || endMs != null || /\bthis\.end\b/.test(code)) return unsupported;
    const text = code.split('this.object').join(`lookup(${objectRid})`).split('this.item').join(`lookup(${itemRid ?? objectRid})`);
    return text.length <= SCRIPT_LIMITS.varying ? varyingScript('contextTextForm', text) : unsupported;
  }

  /** Hidden/missing build metadata is not evidence of a modern EC engine.
   * Probe once per client, sharing the result across concurrent badge batches.
   * Only a parser rejection of this fixed expression selects the legacy path;
   * authentication, transport, and unreadable responses remain failures. */
  async ensureLookupSupport(signal?: AbortSignal): Promise<boolean> {
    if (this.supportsLookup !== null) return this.supportsLookup;
    if (this.lookupProbe) return this.lookupProbe;
    if (this.lookupProbeFailure && Date.now() < this.lookupProbeFailure.retryAt) {
      throw this.lookupProbeFailure.error;
    }
    const revision = this.capabilityRevision;
    const task = (async () => {
      const marker = 'CREV_LOOKUP_SUPPORTED';
      // One probe serves every caller waiting on it. It inherits the class
      // of the caller that started it (a user action stays a user post).
      const result = await this.executeEc(constantScript('lookupProbe', `lookup(0).whenMissing("${marker}")`), undefined, false, inheritClass(signal), AUTH_TIMEOUT);
      if (this.capabilityRevision !== revision) throw new Error('BMP capability detection was reset; retry the operation');
      const supported = result.ok && !result.hasWarning
        && result.log?.split(/\r?\n/).some(line => line.trim() === marker);
      const rejectedSyntax = result.outputEntries?.some(entry => entry.logType === 'ERROR'
        && /Encountered[\s\S]+Was expecting|(?:unknown|undefined|unrecognized|unsupported)\s+(?:function|method)[\s\S]*lookup/i.test(entry.message));
      if (!supported && !rejectedSyntax) {
        throw new Error(result.error || result.log || 'BMP lookup capability probe returned no recognizable result');
      }
      // Version discovery may have completed during this command. It can
      // refine compatibility, but must never hide a transport/auth failure.
      if (this.supportsLookup !== null) return this.supportsLookup;
      this.supportsLookup = Boolean(supported);
      this.lookupProbeFailure = null;
      log.info('bmpClient:capabilities', supported ? 'EC lookup() verified' : 'Legacy EC engine — using native object identity resolution');
      return this.supportsLookup;
    })();
    this.lookupProbe = task;
    try {
      return await task;
    } catch (error) {
      // A page can enqueue hundreds of RIDs. Do not repeat a failed probe for
      // every batch; reconnect/reset clears this short retry window at once.
      if (this.lookupProbe === task) {
        this.lookupProbeFailure = {
          error: error instanceof Error ? error : new Error(String(error)),
          retryAt: Date.now() + 30_000,
        };
      }
      throw error;
    } finally {
      if (this.lookupProbe === task) this.lookupProbe = null;
    }
  }

  constructor(
    private bmpUrl: string,
    bmpUser: string,
    bmpPass: string,
    profileId?: string,
    authMode: CommandAuthMode = 'portal',
    credentialRevision = '',
  ) {
    this.auth = new BmpAuth(bmpUrl, bmpUser, bmpPass, profileId, authMode, credentialRevision);
    this.transport = new BmpTransport(bmpUrl, this.auth);
    this.transport.setRestartCheck(why => this.checkServerRestart(why));
    // Dynamic-dispatch wrappers (not `.bind()`) so tests that monkey-patch
    // `client.executeEc` / `client.resolveRef` on the instance after
    // construction still intercept calls made through the service.
    this.ecQuery = new EcQueryService(
      (code, objectRid, transactional, signal, timeoutMs, feature) =>
        this.executeEc(code, objectRid, transactional, signal, timeoutMs, feature),
      (rid, signal) => this.resolveRef(rid, signal),
      PANE_PROPS,
      (rids, signal) => this.resolveRefs(rids, signal),
      {
        on: (code, rid, signal, timeoutMs, feature) => this.executeEcOn(code, rid, signal, timeoutMs, feature),
        each: (code, rids, signal, timeoutMs, feature) => this.executeEcEach(code, rids, signal, timeoutMs, feature),
      },
    );
  }

  get jwt(): string | null { return this.auth.jwt; }
  get serverUrl(): string { return this.bmpUrl; }
  get username(): string { return this.auth.username; }
  get authMode(): CommandAuthMode { return this.auth.authMode; }
  get authRevision(): string { return this.auth.revision; }
  get commandUser(): string | null { return this.auth.commandUser; }
  get portalActor(): string | null { return this.auth.portalActor; }
  bindPortalActor(actor: string): void { this.auth.bindPortalActor(actor); }
  passwordMatches(pass: string): boolean { return this.auth.passwordMatches(pass); }
  setTransportOutcomeObserver(observer: ((outcome: BmpTransportOutcome) => void) | null): void {
    this.transport.setOutcomeObserver(observer);
  }
  /** Called after every write this connection sent (creates, renames,
   *  moves, deletes, saves): for caches of server state. */
  onWrite(fn: () => void): () => void { return this.transport.onWrite(fn); }
  /** The load governor of this connection (load-governor.ts). */
  get governor(): import('./load-governor').LoadGovernor { return this.transport.governor; }
  /** Changes when the command session is replaced (sign-in again,
   *  reconnect): what was learnt about the server is learnt again. */
  get sessionEpoch(): number { return this.auth.sessionEpoch; }

  /** Several of BMP's own SearchCommands (search-command.ts) in one
   *  read-only post, no Extended Code: one answer each, in order. A
   *  transport failure (HTTP error, time-out, damaged answer) throws. */
  async runSearchCommands(commands: readonly SearchCommandOptions[], signal?: AbortSignal, timeoutMs = 30_000): Promise<SearchAnswer[]> {
    registerSearchCommand();
    const objects = await this.transport.sendStreamingCommands(commands.map(makeSearchCommand), 'read', signal, timeoutMs);
    return decodeSearchStreams(objects, commands.length);
  }

  /** The change feed (tree-events.ts): every pack after `lastPackId`
   *  ('-1': one empty pack with a fresh watermark). One small read-only
   *  post, no Extended Code. A transport failure throws. */
  async readTreeEvents(lastPackId: string, signal?: AbortSignal, timeoutMs = 15_000, feature?: 'restart-check'): Promise<TreeEventAnswer> {
    registerTreeEventCommand();
    // Every feed read is a restart check (checkServerRestart).
    this.counterReadEpoch = this.auth.sessionEpoch;
    this.transport.governor.claimRestartCheck(true);
    const objects = await this.transport.sendStreamingCommands([makeTreeEventCommand(lastPackId)], 'read', signal, timeoutMs, feature);
    const answer = decodeTreeEvents(objects);
    // The pack counter starts again when the server restarts: the script
    // gauge learns of a restart from it, at no extra post.
    if (answer.ok && answer.packs.length) void this.transport.governor.noteServerCounter(answer.packs.reduce((w, p) => laterPackId(w, p.packId), answer.packs[0].packId));
    return answer;
  }

  /** The command session in which the change feed was last read. */
  private counterReadEpoch: number | null = null;
  /** A check failed on this connection (a server without the change feed, or
   *  one that did not answer): it is not asked again until the next connect. */
  private restartCheckFailed = false;

  /** Did the server restart? (script-ledger.ts) One change-feed read from
   *  '-1': one small read-only post, no Extended Code, answered with one
   *  empty pack whose id the governor compares with the stored mark; a
   *  restart empties the script count. Fire-and-forget: it never blocks the
   *  caller and a failure changes nothing. It goes as background work (the
   *  overload cool-down refuses it; it carries no script, so the script
   *  count never does). `session`: the first answer of a command session
   *  (connect, reconnect, a new worker), unless the feed was read in it
   *  already. `refused` / `limit`: the count holds background work back or
   *  a status reports it; at most one per GOVERNOR.restartCheckMs per
   *  server. */
  checkServerRestart(why: 'session' | 'refused' | 'limit'): void {
    if ((globalThis as { __crevTestNoRestartCheck?: boolean }).__crevTestNoRestartCheck) return;
    if (why === 'session' && this.counterReadEpoch === this.auth.sessionEpoch) return;
    if (this.restartCheckFailed) return;
    if (!this.transport.governor.claimRestartCheck(why === 'session')) return;
    this.readTreeEvents('-1', backgroundSignal(), RESTART_CHECK_TIMEOUT_MS, 'restart-check')
      .then(a => { if (!a.ok) this.restartCheckFailed = true; }, (e: unknown) => {
        // Only a check that was sent and failed counts; one held back (an overload cool-down) is asked again later.
        const sent = e instanceof Error && e.name === 'BmpTransportError' && (e as { attempts?: number }).attempts !== 0 && (e as { kind?: string }).kind !== 'cancelled';
        if (sent) this.restartCheckFailed = true;
      });
  }

  /** ID, type and tree text of objects by RID: TreeItemCommands, up to
   *  `perPost` in one post (a built-in read, no Extended Code). An object
   *  the server did not describe maps to null. */
  async readTreeIdentities(rids: readonly string[], signal?: AbortSignal, perPost = 200): Promise<Map<string, { businessId?: string; type?: string; name?: string } | null>> {
    const out = new Map<string, { businessId?: string; type?: string; name?: string } | null>();
    const valid = [...new Set(rids)].filter(r => RID_SHAPE.test(r));
    for (let i = 0; i < valid.length; i += perPost) {
      signal?.throwIfAborted();
      for (const [rid, n] of await this.fetchTreeItems(valid.slice(i, i + perPost), signal)) {
        out.set(rid, n ? { ...(n.businessId != null && n.businessId !== '-1' ? { businessId: n.businessId } : {}), ...(n.type ? { type: n.type } : {}), ...(n.name != null ? { name: n.name } : {}) } : null);
      }
    }
    return out;
  }

  /** The model roots by their keys (GetPropertiesByIdCommand with the
   *  ROOT id space, one post): key → RID and model; a root this server does
   *  not have is left out. `complete`: every key was answered (none was
   *  lost to a failed post). No Extended Code. */
  async rootRidsById(keys: readonly string[], signal?: AbortSignal): Promise<{ roots: Map<string, { rid: string; model: string }>; complete: boolean }> {
    const res = await this.resolvePolicyReferences(keys.map(k => ({ token: k, space: 'ROOT', id: k })), signal);
    if (res.unavailable.length === keys.length && res.problems.length) throw new Error(res.problems[0]);
    const roots = new Map<string, { rid: string; model: string }>();
    for (const k of keys) { const f = res.references[k]; if (f?.rid) roots.set(k, { rid: f.rid, model: f.model }); }
    return { roots, complete: res.unavailable.length === 0 };
  }
  setLoadObserver(observer: ((state: import('./load-governor').LoadState) => void) | null): void {
    this.transport.setLoadObserver(observer);
  }
  /** Inject enrichment cache for resolveRef lookups. */
  set cache(c: IdentityCache | null) { this._cache = c; }

  /** Apply version flags — called once when BMP version is detected. */
  applyVersionFlags(version: string) {
    const v = version.replace(/^v\.?/i, '');
    const isOld = compareVersions(v, '5.6.3.0') < 0;
    // LoginTicket authentication is the transport's single cross-version
    // command path. Version only determines whether EC lookup() is available.
    this.supportsLookup = !isOld;
  }

  /** Safe fallback when version detection fails — assume old BMP.
   *  Binary mode with ticket auth works on all BMP versions. */
  assumeOldBmp() {
    this.supportsLookup = false;
  }

  // ── Auth delegation ──────────────────────────────────────────

  /** `background`: a monitoring or recovery check the user did not ask for.
   *  Its posts then wait behind any waiting user post. */
  async testConnection(options: { background?: boolean } = {}): Promise<ConnectionResult> {
    let authenticated = false;
    const signal = options.background ? backgroundSignal() : undefined;
    try {
      await this.auth.getLoginTicket();
      authenticated = true;
      // A connection probe is deliberately cheaper and more tightly bounded
      // than a user EC run. On cold start it owns the serialized command lane;
      // letting the trivial `1` probe consume the general 30-second EC window
      // makes the Extended Code surface appear frozen behind it.
      const probe = await this.executeEc(constantScript('connectionProbe', '1'), undefined, false, signal, AUTH_TIMEOUT);
      if (!probe.ok) {
        return { ok: false, message: probe.error ?? probe.log ?? 'BMP command probe failed', authenticated: true };
      }
      if (probe.hasWarning || !probe.log?.split(/\r?\n/).some(line => line.trim() === '1')) {
        return { ok: false, message: 'BMP command probe returned no recognizable result', authenticated: true };
      }
      await this.ensureLookupSupport(signal);
      // Once per connection, best effort: does this server keep parsed
      // scripts at all (feature toggle noCache)? The script gauge says so.
      void this.readServerCacheOff().catch(() => {});
      return { ok: true, message: 'Authenticated and command channel ready', authenticated: true };
    } catch (e) {
      // AuthError carries a precise cause; everything else (network throw,
      // serializer error) is reported via the transport's generic formatter.
      if (e instanceof AuthError) {
        return { ok: false, message: e.message, authenticated: false, code: e.code };
      }
      const noAnswer = e instanceof TypeError
        || (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError'));
      return {
        ok: false,
        message: this.transport.formatError(e),
        authenticated,
        ...(noAnswer && !authenticated ? { code: 'transport' as const } : {}),
      };
    }
  }

  absorbAuth(other: BmpClient) { this.auth.absorbAuth(other.auth); }
  logout() { this.resetCapabilities(); this.auth.logout(); }
  /** Retired for good (credentials changed, profile deleted): what other
   *  modules kept for this client goes too (onClientRetired). */
  retire() {
    this.resetCapabilities();
    this.auth.retire();
    for (const fn of retiredListeners) { try { fn(this); } catch { /* a listener must not stop the others */ } }
  }
  retryAuthentication() {
    this.lookupProbeFailure = null;
    return this.auth.retryAuthentication();
  }

  // ── Object resolution ────────────────────────────────────────

  /** Resolve a RID to an EC object reference expression.
   *  On 5.6.3+ (lookup available): returns "lookup(rid)".
   *  On pre-5.6.3: resolves business ID via cache or native TreeItemCommand. */
  async resolveRef(rid: string, signal?: AbortSignal): Promise<string> {
    const epoch = this.auth.sessionEpoch;
    validateRid(rid);
    signal?.throwIfAborted();
    const supportsLookup = await this.ensureLookupSupport(signal);
    this.auth.assertAuthEpoch(epoch);
    signal?.throwIfAborted();
    if (supportsLookup) return `lookup(${rid})`;

    const [ref] = (await this.resolveRefs([rid], signal)).values();
    if (ref instanceof Error) throw ref;
    return ref;
  }

  /** resolveRef for several rids with as few posts as possible: on pre-5.6.3
   *  every uncached rid becomes one TreeItemCommand and up to
   *  TREE_ITEM_BATCH of them share one post. A post BMP rejects as a whole
   *  is halved until the failing rids are isolated (batch-isolate.ts), so
   *  each rid gets the same answer it would get from a post of its own.
   *  Returns rid → reference or the Error resolveRef would throw. A
   *  connection failure is reported for every rid that was not answered. */
  async resolveRefs(rids: readonly string[], signal?: AbortSignal): Promise<Map<string, string | Error>> {
    const epoch = this.auth.sessionEpoch;
    const out = new Map<string, string | Error>();
    const toResolve: string[] = [];
    for (const rid of new Set(rids)) {
      try { validateRid(rid); toResolve.push(rid); }
      catch (e) { out.set(rid, e instanceof Error ? e : new Error(String(e))); }
    }
    if (toResolve.length === 0) return out;
    signal?.throwIfAborted();
    const supportsLookup = await this.ensureLookupSupport(signal);
    this.auth.assertAuthEpoch(epoch);
    signal?.throwIfAborted();
    if (supportsLookup) {
      // No post: lookup(rid). Through resolveRef, so a caller (or test) that
      // replaces resolveRef on the instance is still honoured.
      for (const rid of toResolve) {
        try { out.set(rid, await this.resolveRef(rid, signal)); }
        catch (e) { signal?.throwIfAborted(); out.set(rid, e instanceof Error ? e : new Error(String(e))); }
      }
      return out;
    }

    const identities = new Map<string, { businessId?: string; type?: string } | null>();
    const uncached: string[] = [];
    for (const rid of toResolve) {
      // Try enrichment cache first
      const cached = this._cache?.get(rid);
      if (cached?.businessId) identities.set(rid, cached);
      else uncached.push(rid);
    }
    for (let i = 0; i < uncached.length; i += TREE_ITEM_BATCH) {
      const batch = uncached.slice(i, i + TREE_ITEM_BATCH);
      try {
        const read = await readIsolating(batch, ids => this.fetchTreeItems(ids, signal), {
          signal,
          // Never more posts than one per rid would have cost, plus the first.
          maxRequests: batch.length * 2,
        });
        for (const found of read.results) for (const [rid, identity] of found) identities.set(rid, identity);
        for (const [rid, message] of Object.entries(read.failed)) out.set(rid, new Error(message));
        for (const rid of read.unresolved) out.set(rid, new Error(read.error ?? `Cannot resolve object ${rid}`));
      } catch (e) {
        signal?.throwIfAborted();
        const error = e instanceof Error ? e : new Error(String(e));
        for (const rid of batch) out.set(rid, error);
      }
    }
    signal?.throwIfAborted();
    for (const rid of toResolve) {
      if (out.has(rid)) continue;
      const identity = identities.get(rid);
      if (!identity?.businessId) { out.set(rid, new Error(`Cannot resolve object ${rid}: not found on server`)); continue; }
      // Business IDs are unique only within their native IdSpace. Validate in
      // the consuming EC request (including writes), not in a separate check
      // that costs another round trip and can race a rename. get() quotes the
      // ID as data, including IDs that are not legal bare EC identifiers.
      const ref = `${resolveNamespace(identity.type ?? '')}.get("${formatEcLiteral(identity.businessId)}")`;
      // EC numeric literals round large RIDs. Compare exact decimal text.
      out.set(rid, `LIST(${ref}).filter(str(rid) = "${rid}").first().whenMissing(error("BMP object identity no longer matches RID ${rid}; refresh the object"))`);
    }
    return out;
  }

  /** One post of TreeItemCommands. Response: ArrayList<IntegrationObjectResponse>
   *  in command order, each `.response` a TreeNodeInformationDto. A server
   *  exception for the whole post throws; one rid without a DTO maps to null. */
  private async fetchTreeItems(rids: readonly string[], signal?: AbortSignal): Promise<Map<string, ReturnType<typeof parseTreeNodeInfo>>> {
    const buffer = await this.transport.sendCommands(rids.map(rid => makeTreeItemCommand(rid)), 'read', signal);
    const objects = this.transport.deserializeStream(buffer, 'read', true);
    const out = new Map<string, ReturnType<typeof parseTreeNodeInfo>>();
    const elements: unknown[] = [];
    for (const obj of objects) {
      const cls = obj?.$class ?? '';
      if (cls.includes('ServerExceptionResponse')) throw new Error(obj.message ?? 'BMP object identity request failed');
      if (cls === 'java.util.ArrayList') elements.push(...(obj.$elements ?? []));
    }
    rids.forEach((rid, index) => {
      const item = elements[index] as { $class?: string; message?: string; response?: { $class?: string } } | undefined;
      if (rids.length > 1 && item?.$class?.includes('ExceptionResponse')) {
        // One object failed inside an otherwise answered post: let
        // readIsolating ask for it alone, as resolveRef always did.
        throw new Error(item.message ?? 'BMP object identity request failed');
      }
      const dto = item?.response;
      out.set(rid, dto?.$class?.includes('TreeNodeInformationDto') ? parseTreeNodeInfo(dto) : null);
    });
    return out;
  }

  // ── Object operations ────────────────────────────────────────

  /** Save a single property back to BMP (binary serializer) */
  async saveProperty(rid: string, objectType: string, property: string, value: string): Promise<{ ok: boolean; error?: string; outcomeUnknown?: boolean }> {
    return this.saveProperties(rid, objectType, { [property]: value });
  }

  /** Save a related property set in one BMP update command. */
  async saveProperties(rid: string, objectType: string, properties: Record<string, string>): Promise<{ ok: boolean; error?: string; outcomeUnknown?: boolean }> {
    try {
      const cmd = makeUpdateCommand(rid, objectType, properties);
      const buffer = await this.transport.sendCommands([cmd], 'write');
      const raw = this.transport.deserializeResponse(buffer, 'write');

      if (raw?.$class?.includes('ServerExceptionResponse')) {
        return { ok: false, error: raw.message ?? 'Server error' };
      }
      return { ok: true };
    } catch (e) {
      return {
        ok: false, error: this.transport.formatError(e),
        ...(writeOutcomeUnknown(e, errorKindOf(e)) ? { outcomeUnknown: true } : {}),
      };
    }
  }

  /** Fetch a CustomVisualization's live `_data` from the data servlet. Unlike
   *  the binary command channel (JWT/ticket), this servlet auths by the BMP
   *  SESSION COOKIE — so it's a plain credentials:'include' GET that rides the
   *  browser's BMP session (the SW has host + cookies permissions). Returns the
   *  servlet JSON (expressions/tables/serverConnections/context). A 400 means
   *  the render context isn't org-rooted (the CVO must resolve under an
   *  Organisation) — surfaced as a clear message for the studio's live toggle. */
  async cvoData(
    cvoRid: string,
    businessObjectRid: string,
    periodType = 'M',
    periodMillis?: number,
  ): Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }> {
    const u = new URL(`${this.transport.baseUrl}web/customvisualizationdata`);
    u.searchParams.set('customvizrid', cvoRid);
    u.searchParams.set('businessobjectrid', businessObjectRid);
    u.searchParams.set('selectedPeriodType', periodType);
    u.searchParams.set('selectedPeriod', String(periodMillis ?? Date.now()));
    u.searchParams.set('ytd', 'false');
    u.searchParams.set('_t', String(Date.now())); // cache-buster
    try {
      await assertHostAccess(u.toString());
      const res = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: res.status === 401 || res.status === 403
            ? 'Portal login required for live CVO data. The stored command identity does not authenticate portal data.'
            : res.status === 400
            ? 'Data servlet returned 400: the render context is not org-rooted. The CVO must resolve under an Organisation; pick an org-rooted scorecard or page rid as the render context.'
            : `Data servlet HTTP ${res.status}`,
        };
      }
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, error: this.transport.formatError(e) };
    }
  }

  /** Download a FileResource's decoded `content` bytes as text — the
   *  /web/download servlet decodes the stored `name;mime;base64` triplet and
   *  serves the real bytes (no nosniff), so a hosted JS library comes back as
   *  runnable source. Session-cookie auth (same as cvoData), so it's a plain
   *  credentials:'include' GET. Used by the studio to inject a CVO's hosted
   *  libraries into the sandbox preview. rid stays a string (Java long). */
  async downloadResource(rid: string): Promise<{ ok: boolean; text?: string; error?: string; status?: number }> {
    const u = new URL(`${this.transport.baseUrl}web/download`);
    u.searchParams.set('propName', 'content');
    u.searchParams.set('rid', rid);
    try {
      await assertHostAccess(u.toString());
      const res = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: res.status === 401 || res.status === 403
            ? 'Portal login required for resource downloads. The stored command identity does not authenticate portal files.'
            : `Download HTTP ${res.status}`,
        };
      }
      return { ok: true, text: await res.text() };
    } catch (e) {
      return { ok: false, error: this.transport.formatError(e) };
    }
  }

  /** The bytes of a FileResource (the same download as downloadResource, not
   *  read as text), for an image thumbnail. At most `maxBytes`: a larger
   *  file is not read. rid stays a string (Java long). */
  async downloadResourceBytes(rid: string, maxBytes = 2_000_000): Promise<{ ok: boolean; bytes?: Uint8Array; contentType?: string; error?: string }> {
    if (!RID_SHAPE.test(rid)) return { ok: false, error: `Invalid RID: ${rid}` };
    const u = new URL(`${this.transport.baseUrl}web/download`);
    u.searchParams.set('propName', 'content');
    u.searchParams.set('rid', rid);
    try {
      await assertHostAccess(u.toString());
      const res = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        return { ok: false, error: res.status === 401 || res.status === 403 ? 'Portal login required to show the image.' : `Download HTTP ${res.status}` };
      }
      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, error: 'The file is too large to show.' };
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) return { ok: false, error: 'The file is too large to show.' };
      return { ok: true, bytes, contentType: res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() };
    } catch (e) {
      return { ok: false, error: this.transport.formatError(e) };
    }
  }

  // ── Access trace (admin permission test) ──────────────────────

  /** Run AccessTraceCommand: trace whether `subjectRid` (a user OR role) has
   *  `action` access to `rid`. Returns the PBAC decision tree, or throws on a
   *  server-side rejection (e.g. insufficient privilege). */
  async fetchAccessTrace(
    rid: string,
    subjectRid: string,
    action: AccessTraceAction = 'READ',
    signal?: AbortSignal,
    updates?: AccessTraceUpdates,
    indexed = false,
  ): Promise<AccessTraceNode | null> {
    const buffer = await this.transport.sendCommands([makeAccessTraceCommand(rid, subjectRid, action, 10, updates, indexed)], 'read', signal);
    return extractAccessTrace(this.transport.deserializeStream(buffer, 'read', true));
  }

  /** Several AccessTraceCommands in ONE request (see lib/access-mode.ts for
   *  the shapes BMP accepts). Returns each command's traces in order. */
  async fetchAccessTraces(
    subjectRid: string,
    commands: ReadonlyArray<{ action: AccessTraceAction; rids: readonly string[]; updates?: AccessTraceUpdates }>,
    depth: number,
    signal?: AbortSignal,
  ): Promise<AccessTraceNode[][]> {
    const buffer = await this.transport.sendCommands(commands.map(c => makeAccessTraceCommand(c.rids, subjectRid, c.action, depth, c.updates)), 'read', signal);
    return extractAccessTraceLists(this.transport.deserializeStream(buffer, 'read', true), commands.length);
  }

  async fetchTypeFields(type: string, signal?: AbortSignal): Promise<Array<{ id: string; businessId: string; reference: boolean; multiselect: boolean; targets: string[] }>> {
    return (await this.fetchTypeFieldDescriptions(type, signal)).map(f => {
      const allowed = f.referenceConstraints?.allowedTypes ?? [];
      const targets = allowed.length ? allowed : [f.multiselect ? f.collectionType ?? '' : f.type];
      return { id: f.id, businessId: f.businessId, reference: f.reference === true, multiselect: f.multiselect === true, targets: targets.filter(Boolean) };
    });
  }

  /** The type's whole field description (GetTypeFieldsCommand): one entry
   *  per field with every attribute the server sends (property-schema.ts). */
  async fetchTypeFieldDescriptions(type: string, signal?: AbortSignal): Promise<FieldDescription[]> {
    validateEcIdentifier(type);
    const buffer = await this.transport.sendCommands([makeGetTypeFieldsCommand(type)], 'read', signal);
    const objects = this.transport.deserializeStream(buffer, 'read', true);
    for (const obj of objects) {
      if (obj?.$class?.includes('ServerExceptionResponse')) throw new Error(obj.message ?? 'Cannot read type fields');
      const response = obj?.$elements?.[0]?.response;
      if (!response) continue;
      const entries = javaMapEntries(response);
      if (entries.length !== 1 || String((entries[0][0] as { typeId?: string })?.typeId ?? entries[0][0]) !== type) throw new Error(`BMP returned fields for a different type than ${type}.`);
      const values = entries.flatMap(([, v]: [unknown, any]) => v?.$elements ?? []);
      const fields = values.map(parseFieldDescription).filter((f: FieldDescription | null): f is FieldDescription => !!f);
      if (fields.length) return fields;
    }
    throw new Error(`BMP returned no fields for ${type}.`);
  }

  /** The items of a list set (its children): RID, ID and name. One
   *  constant script with the set as the command's context. */
  async readListItems(setRid: string, signal?: AbortSignal): Promise<ListItem[]> {
    validateRid(setRid);
    const r = await this.executeEcOn(LIST_ITEMS_EC, setRid, signal);
    if (!r.ok) throw new Error(r.error || r.log || 'Could not read the list items');
    return parseListItems(r.log ?? '');
  }

  /** The items of several list sets in ONE post (executeEcPairs: the same
   *  constant script once per set, each set as its command's context, each
   *  answered on its own). Set RID → items, or the Error of that set. */
  async readListItemSets(setRids: readonly string[], signal?: AbortSignal): Promise<Map<string, ListItem[] | Error>> {
    const sets = [...new Set(setRids)];
    for (const s of sets) validateRid(s);
    const results = await this.executeEcPairs(sets.map(objectRid => ({ code: LIST_ITEMS_EC, objectRid })), signal);
    const out = new Map<string, ListItem[] | Error>();
    sets.forEach((s, i) => {
      const r = results[i];
      if (!r?.ok) { out.set(s, new Error(r?.error || r?.log || 'Could not read the list items')); return; }
      try { out.set(s, parseListItems(r.log ?? '')); }
      catch (e) { out.set(s, e instanceof Error ? e : new Error(String(e))); }
    });
    return out;
  }

  /** The objects reference property `definitionRid` allows for object
   *  `objectRid` (`source`: its expression, the default, or its types; see
   *  readAllowedObjectSets). One post on a server with `lookup()`; an older
   *  server first resolves an advanced definition (resolveRefs). Throws
   *  when the read fails. */
  async readAllowedObjects(objectRid: string, definitionRid: string, signal?: AbortSignal, source?: AllowedSource): Promise<AllowedObjects> {
    const sources = source ? new Map([[definitionRid, source]]) : undefined;
    const read = (await this.readAllowedObjectSets(objectRid, [definitionRid], signal, sources)).get(definitionRid);
    if (!read) throw new Error('Could not read the allowed objects');
    if (read instanceof Error) throw read;
    return read;
  }

  /** The allowed objects of several reference properties of ONE object in
   *  ONE post (executeEcScriptsOn: one script per definition, the object as
   *  each command's context, each answered on its own), plus the reference
   *  resolution of the advanced definitions (no post with `lookup()`).
   *  `sources`: definition → AllowedSource; a definition without an entry
   *  is advanced (buildAllowedObjectsEc), a by-type one is read by its type
   *  names (buildAllowedByTypeEc) and needs no resolution. Definition RID →
   *  allowed objects, or the Error of that definition. */
  async readAllowedObjectSets(
    objectRid: string, definitionRids: readonly string[], signal?: AbortSignal, sources?: ReadonlyMap<string, AllowedSource>,
  ): Promise<Map<string, AllowedObjects | Error>> {
    validateRid(objectRid);
    const defs = [...new Set(definitionRids)];
    const out = new Map<string, AllowedObjects | Error>();
    if (!defs.length) return out;
    const byType = new Map<string, Extract<AllowedSource, { mode: 'by-type' }>>();
    for (const def of defs) {
      const s = sources?.get(def);
      if (s?.mode === 'by-type') byType.set(def, s);
    }
    const advanced = defs.filter(d => !byType.has(d));
    const refs = advanced.length ? await this.resolveRefs(advanced, signal) : new Map<string, string | Error>();
    const asked: Array<{ def: string; code: string }> = [];
    for (const def of defs) {
      const typed = byType.get(def);
      if (typed) {
        try { asked.push({ def, code: buildAllowedByTypeEc(typed.types, typed.exactClass) }); }
        catch (e) { out.set(def, e instanceof Error ? e : new Error(String(e))); }
        continue;
      }
      const ref = refs.get(def);
      if (typeof ref === 'string') asked.push({ def, code: buildAllowedObjectsEc(ref) });
      else out.set(def, ref ?? new Error(`Cannot resolve object ${def}`));
    }
    if (!asked.length) return out;
    const results = await this.executeEcScriptsOn(asked.map(a => a.code), objectRid, signal);
    asked.forEach(({ def }, i) => {
      const r = results[i];
      if (!r?.ok) { out.set(def, new Error(r?.error || r?.log || 'Could not read the allowed objects')); return; }
      try { out.set(def, parseAllowedObjects(r.log ?? '')); }
      catch (e) { out.set(def, e instanceof Error ? e : new Error(String(e))); }
    });
    return out;
  }

  /** Write custom property values of one object in ONE transactional run:
   *  `_o := <ref>` then the given change lines (built and checked by the
   *  service worker's gate, custom-property-gate.ts). */
  async applyCustomChanges(rid: string, lines: readonly string[]): Promise<{ ok: boolean; error?: string; notSent?: boolean; outcomeUnknown?: boolean; warning?: string }> {
    if (!lines.length) return { ok: true };
    const epoch = this.auth.sessionEpoch;
    const ref = await this.resolveRef(rid);
    this.auth.assertAuthEpoch(epoch);
    const script = userScript([`_o := ${ref}`, ...lines].join('\n'));
    if (script.length > SCRIPT_LIMITS.user) return { ok: false, notSent: true, error: `The change is too large to send (${script.length} characters).` };
    const result = await this.executeEc(script, undefined, true);
    if (!result.ok) {
      return { ok: false, error: result.error ?? result.log ?? 'Change failed', ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}) };
    }
    // A warning after a committed run is not a failed save: the window
    // re-reads the object and decides from the stored value.
    return result.hasWarning ? { ok: true, warning: result.log || 'BMP reported a warning' } : { ok: true };
  }

  async fetchTypeCatalogue(signal?: AbortSignal) {
    const buffer = await this.transport.sendCommands([makeLoadTypeConfigCommand()], 'read', signal);
    return parseTypeCatalogue(commandResults(this.transport.deserializeStream(buffer, 'read', true), 1)[0]);
  }

  /** Bounded native ID lookups, using BMP's own IdSpace mapping, not UI roots. */
  async resolvePolicyReferences(refs: Array<{ token: string; space: string; id: string }>, signal?: AbortSignal): Promise<import('./bmp-type-catalogue').BmpReferenceResolution> {
    const facts: Record<string, BmpReferenceFact | null> = Object.create(null);
    const unavailable: string[] = [], problems: string[] = [];
    for (let start = 0; start < refs.length; start += 32) {
      signal?.throwIfAborted();
      const batch = refs.slice(start, start + 32);
      let results: unknown[];
      try {
        const buffer = await this.transport.sendCommands(batch.map(r => makeReferenceIdentityCommand(r.space, r.id)), 'read', signal);
        results = commandResults(this.transport.deserializeStream(buffer, 'read', true), batch.length);
      } catch (error) {
        signal?.throwIfAborted();
        // Keep prior batches. Stop dispatching after a transport/batch failure;
        // an explicit retry can resume only the unavailable identities.
        unavailable.push(...refs.slice(start).map(r => r.token));
        problems.push(error instanceof Error ? error.message : String(error));
        break;
      }
      results.forEach((value, i) => {
        try { facts[batch[i].token] = parseReferenceIdentity(value); }
        catch (error) {
          unavailable.push(batch[i].token);
          problems.push(error instanceof Error ? error.message : String(error));
        }
      });
    }
    signal?.throwIfAborted();
    return { references:facts, unavailable, problems:[...new Set(problems)] };
  }

  /** List users + roles (the possible trace subjects) via EC, sorted by name. */
  async listAccessSubjects(): Promise<AccessSubject[]> {
    return this.ecQuery.listAccessSubjects();
  }

  // ── EC operations ────────────────────────────────────────────

  /** Execute Extended Code. `timeoutMs` widens the network window for known-long runs
   *  (blueprint layout fetch/apply on heavy pages) — defaults to EC_TIMEOUT in the transport. */
  /** objectRid → organisation rid, resolved once per session. `this.org` in EC
   *  reads the calculation context's orgRid. BMP's web context binds that to the
   *  object's owning organisation for a standard page; we sent 0, so `this.org`
   *  resolved to nothing (`this.object.organisation` still worked because it
   *  walks the object's own tree, not the context — see extended-code
   *  reference, "this.org vs this.object.organisation"). We bind the same
   *  owning org. Cache: the org binding of an object never changes mid-session. */
  private orgRidCache = new Map<string, bigint | undefined>();
  /** Bound on orgRidCache: one entry per object an EC run used as context. */
  static readonly ORG_RID_CACHE_LIMIT = 500;

  private async resolveOrgRid(objectRid: string, signal?: AbortSignal): Promise<bigint | undefined> {
    signal?.throwIfAborted();
    if (this.orgRidCache.has(objectRid)) {
      // Map order is insertion order: re-insert so the oldest unused entry goes first.
      const org = this.orgRidCache.get(objectRid);
      this.orgRidCache.delete(objectRid);
      this.orgRidCache.set(objectRid, org);
      return org;
    }
    // Tag the value with a marker: parseEcResults strips BMP's "Result : "
    // prefix, so a bare number would be indistinguishable from the status/
    // duration log lines. `whenMissing(0)` yields "ORG=0" for no owning org.
    const revision = this.capabilityRevision;
    // One constant script: the object is the command's context, so this
    // text is parsed once per server life, not once per object.
    validateRid(objectRid);
    const cmd = makeExtendedExecuteCommand(constantScript('orgRid', '"ORG=" + str(this.object.organisation.rid.whenMissing(0))'), { objectRid: BigInt(objectRid) });
    const r = parseEcResults(await this.transport.sendStreamingCommand(cmd, 'read', signal));
    signal?.throwIfAborted();
    if (revision !== this.capabilityRevision) throw new Error('BMP context resolution was reset; retry the operation');
    if (!r.ok) throw new Error(r.error || r.log || 'Could not resolve the BMP organisation context');
    const m = r.log?.match(/ORG=(-?\d+)/);
    if (!m) throw new Error('BMP returned no organisation context');
    const org = m[1] !== '0' ? BigInt(m[1]) : undefined;
    this.orgRidCache.set(objectRid, org); // cache only a definitive answer
    while (this.orgRidCache.size > BmpClient.ORG_RID_CACHE_LIMIT) {
      this.orgRidCache.delete(this.orgRidCache.keys().next().value!);
    }
    return org;
  }

  async executeEc(
    code: string,
    objectRid?: string,
    transactional = false,
    signal?: AbortSignal,
    timeoutMs?: number,
    feature?: import('./bmp-transport').BmpTransportMetrics['feature'],
    /** `context`: the object is only the command's context (`this.object`);
     *  its organisation is not resolved (executeEcOn). */
    opts: { context?: boolean; itemRid?: string; endMs?: number; probe?: boolean } = {},
  ): Promise<EcResult> {
    const epoch = this.auth.sessionEpoch;
    try {
      if (objectRid && !RID_SHAPE.test(objectRid)) throw new BmpRequestError(`Invalid RID: ${objectRid}`, 'server');
      if (opts.context && objectRid && !opts.probe && !(await this.ensureContextSupport(signal))) {
        // The server ignores the context: the small text form, or "not supported".
        const text = this.contextTextForm(code, objectRid, opts.itemRid, opts.endMs, feature);
        if (typeof text !== 'string') return text;
        return await this.executeEc(text, undefined, false, signal, timeoutMs, feature);
      }
      if (opts.itemRid && !RID_SHAPE.test(opts.itemRid)) throw new BmpRequestError(`Invalid RID: ${opts.itemRid}`, 'server');
      const cmd = makeExtendedExecuteCommand(code, {
        objectRid: objectRid ? BigInt(objectRid) : undefined,
        orgRid: objectRid && !opts.context ? await this.resolveOrgRid(objectRid, signal) : undefined,
        // The command's item (`this.item`); the object when not given.
        itemRid: objectRid && opts.itemRid ? BigInt(opts.itemRid) : undefined,
        // The context's end (`this.end`): a date for a constant script.
        ...(opts.endMs != null ? { endMs: opts.endMs } : {}),
        transactional,
      });
      this.auth.assertAuthEpoch(epoch);
      const objects = await this.transport.sendStreamingCommand(
        cmd,
        transactional ? 'write' : 'read',
        signal,
        timeoutMs,
        feature,
      );
      const result = parseEcResults(objects);
      // BMP's own out-of-memory answer is an overload signal for every
      // feature (load-governor.ts).
      if (!result.ok && SERVER_OOM.test(`${result.error ?? ''}
${result.log ?? ''}`)) this.transport.governor.noteOverload(result.error ?? 'Out of memory');
      return result;
    } catch (e) {
      // AbortSignal.timeout → TimeoutError; a caller-passed abort → AbortError.
      if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        return {
          ok: false, error: `EC execution timed out (${Math.round((timeoutMs ?? EC_TIMEOUT) / 1000)}s)`, errorKind: 'timeout',
          ...(transactional ? { outcomeUnknown: true } : {}),
        };
      }
      const errorKind = errorKindOf(e) ?? (e instanceof AuthError ? 'not-signed-in' : undefined);
      return {
        ok: false, error: this.transport.formatError(e), ...(errorKind ? { errorKind } : {}),
        ...(transactional && writeOutcomeUnknown(e, errorKind) ? { outcomeUnknown: true } : {}),
      };
    }
  }

  /**
   * Several read-only EC scripts in one post (measured on BMP 5.6.17: the
   * commands run one after another and each is answered on its own, so one
   * failing script does not fail the others). Results come back in order.
   * Use it only for scripts that always go together; a transport failure
   * fails all of them, as it would fail each of separate posts.
   */
  async executeEcBatch(codes: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<EcResult[]> {
    if (codes.length === 0) return [];
    if (codes.length === 1) return [await this.executeEc(codes[0], undefined, false, signal, timeoutMs)];
    const epoch = this.auth.sessionEpoch;
    try {
      const commands = codes.map(code => makeExtendedExecuteCommand(code, { transactional: false }));
      this.auth.assertAuthEpoch(epoch);
      const objects = await this.transport.sendStreamingCommands(commands, 'read', signal, timeoutMs);
      const results = splitEcResults(objects, codes.length);
      const oom = results.find(r => !r.ok && SERVER_OOM.test(`${r.error ?? ''}
${r.log ?? ''}`));
      if (oom) this.transport.governor.noteOverload(oom.error ?? 'Out of memory');
      return results;
    } catch (e) {
      const errorKind = errorKindOf(e) ?? (e instanceof AuthError ? 'not-signed-in' : undefined);
      const failed: EcResult = { ok: false, error: this.transport.formatError(e), ...(errorKind ? { errorKind } : {}) };
      return codes.map(() => failed);
    }
  }

  /**
   * One constant script about one object: the object travels as the
   * command's context (`this.object` in the script), not in the script text,
   * so BMP parses the script once per server life (it keeps a parse tree per
   * distinct text; measured on BMP 5.6.17, about 40 bytes of heap per
   * character, never released). No organisation context is resolved: the
   * readers do not use it, and resolving it would cost a post per object.
   */
  async executeEcOn(
    code: string,
    objectRid: string,
    signal?: AbortSignal,
    timeoutMs?: number,
    feature?: import('./bmp-transport').BmpTransportMetrics['feature'],
    /** A second object for the script (`this.item`). */
    itemRid?: string,
  ): Promise<EcResult> {
    return this.executeEc(code, objectRid, false, signal, timeoutMs, feature, { context: true, ...(itemRid ? { itemRid } : {}) });
  }

  /**
   * One constant script for each of several objects: one command per object
   * (the object as the command's context), up to CONTEXT_PER_POST commands
   * in one post. Each command is answered on its own, so an object the
   * server cannot read fails only its own answer. Every command counts as
   * one against the load governor. A RID that is not a decimal RID gets a
   * failed answer without a post.
   */
  private serverCacheProbe: Promise<boolean | null> | null = null;

  /** The server's `noCache` feature toggle (GetServerSettingsCommand's
   *  `enabledFeatures`), read once per client; null when unknown. Tells the
   *  load governor's script gauge whether the server keeps parsed scripts. */
  readServerCacheOff(): Promise<boolean | null> {
    this.serverCacheProbe ??= (async () => {
      const buffer = await this.transport.sendCommands([makeGetServerSettingsCommand()], 'read', backgroundSignal());
      const features = findStringField(this.transport.deserializeResponse(buffer), 'enabledFeatures', 4);
      const off = features == null ? null : /(^|[,\s])noCache([,\s]|$)/.test(features);
      this.transport.governor.setServerCacheOff(off);
      return off;
    })().catch(() => null);
    return this.serverCacheProbe;
  }

  /** Whether the batched context path may be used; false sends each item
   *  through executeEc, which applies the text form or "not supported". A
   *  connection failure of the check counts as supported here: the post
   *  that follows fails the same way and says so. */
  private async contextOrFallback(signal?: AbortSignal): Promise<boolean> {
    try { return await this.ensureContextSupport(signal); } catch { return true; }
  }

  /** Scripts each with its own context object (or none), one post; each
   *  answers on its own, in order. */
  async executeEcPairs(pairs: ReadonlyArray<{ code: string; objectRid?: string; endMs?: number }>, signal?: AbortSignal, timeoutMs?: number): Promise<EcResult[]> {
    if (!pairs.length) return [];
    if (Object.prototype.hasOwnProperty.call(this, 'executeEc') || (pairs.some(p => p.objectRid) && !(await this.contextOrFallback(signal)))) {
      const out: EcResult[] = [];
      for (const p of pairs) out.push(await this.executeEc(p.code, p.objectRid, false, signal, timeoutMs, undefined, { context: true, ...(p.endMs != null ? { endMs: p.endMs } : {}) }));
      return out;
    }
    const epoch = this.auth.sessionEpoch;
    try {
      for (const p of pairs) if (p.objectRid) validateRid(p.objectRid);
      const commands = pairs.map(p => makeExtendedExecuteCommand(p.code, { ...(p.objectRid ? { objectRid: BigInt(p.objectRid) } : {}), ...(p.endMs != null ? { endMs: p.endMs } : {}), transactional: false }));
      this.auth.assertAuthEpoch(epoch);
      return splitEcResults(await this.transport.sendStreamingCommands(commands, 'read', signal, timeoutMs), pairs.length);
    } catch (e) {
      const errorKind = errorKindOf(e) ?? (e instanceof AuthError ? 'not-signed-in' : undefined);
      const failed: EcResult = { ok: false, error: this.transport.formatError(e), ...(errorKind ? { errorKind } : {}) };
      return pairs.map(() => failed);
    }
  }

  /** Several constant scripts on one object (the command context), one
   *  post: each answers on its own, in order (split scripts). */
  async executeEcScriptsOn(codes: readonly string[], objectRid: string, signal?: AbortSignal, timeoutMs?: number): Promise<EcResult[]> {
    if (codes.length <= 1 || Object.prototype.hasOwnProperty.call(this, 'executeEc') || !(await this.contextOrFallback(signal))) {
      const out: EcResult[] = [];
      for (const code of codes) out.push(await this.executeEc(code, objectRid, false, signal, timeoutMs, undefined, { context: true }));
      return out;
    }
    validateRid(objectRid);
    const epoch = this.auth.sessionEpoch;
    try {
      const commands = codes.map(code => makeExtendedExecuteCommand(code, { objectRid: BigInt(objectRid), transactional: false }));
      this.auth.assertAuthEpoch(epoch);
      return splitEcResults(await this.transport.sendStreamingCommands(commands, 'read', signal, timeoutMs), codes.length);
    } catch (e) {
      const errorKind = errorKindOf(e) ?? (e instanceof AuthError ? 'not-signed-in' : undefined);
      const failed: EcResult = { ok: false, error: this.transport.formatError(e), ...(errorKind ? { errorKind } : {}) };
      return codes.map(() => failed);
    }
  }

  async executeEcEach(
    code: string,
    objectRids: readonly string[],
    signal?: AbortSignal,
    timeoutMs?: number,
    feature?: import('./bmp-transport').BmpTransportMetrics['feature'],
  ): Promise<Map<string, EcResult>> {
    const out = new Map<string, EcResult>();
    const rids: string[] = [];
    for (const rid of new Set(objectRids)) {
      if (RID_SHAPE.test(rid)) rids.push(rid);
      else out.set(rid, { ok: false, error: `Invalid RID: ${rid}`, errorKind: 'server' });
    }
    // One object, or an executeEc replaced on this instance (unit tests): one
    // executeEc per object, so the replacement sees every command.
    if (rids.length === 1 || Object.prototype.hasOwnProperty.call(this, 'executeEc') || !(await this.contextOrFallback(signal))) {
      for (const rid of rids) out.set(rid, await this.executeEc(code, rid, false, signal, timeoutMs, feature, { context: true }));
      return out;
    }
    for (let i = 0; i < rids.length; i += CONTEXT_PER_POST) {
      const chunk = rids.slice(i, i + CONTEXT_PER_POST);
      const epoch = this.auth.sessionEpoch;
      let results: EcResult[];
      try {
        signal?.throwIfAborted();
        const commands = chunk.map(rid => makeExtendedExecuteCommand(code, { objectRid: BigInt(rid), transactional: false }));
        this.auth.assertAuthEpoch(epoch);
        const objects = await this.transport.sendStreamingCommands(commands, 'read', signal, timeoutMs, feature);
        results = splitEcResults(objects, chunk.length);
      } catch (e) {
        if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError') && signal?.aborted) throw e;
        const errorKind = errorKindOf(e) ?? (e instanceof AuthError ? 'not-signed-in' : undefined);
        const failed: EcResult = e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')
          ? { ok: false, error: `EC execution timed out (${Math.round((timeoutMs ?? EC_TIMEOUT) / 1000)}s)`, errorKind: 'timeout' }
          : { ok: false, error: this.transport.formatError(e), ...(errorKind ? { errorKind } : {}) };
        results = chunk.map(() => failed);
      }
      const oom = results.find(r => !r.ok && SERVER_OOM.test(`${r.error ?? ''}
${r.log ?? ''}`));
      if (oom) this.transport.governor.noteOverload(oom.error ?? 'Out of memory');
      chunk.forEach((rid, k) => out.set(rid, results[k]));
    }
    return out;
  }

  /** Resolve template for a linked instance (pure EC) */
  async resolveTemplate(rid: string): Promise<TemplateResolution> {
    return this.ecQuery.resolveTemplate(rid);
  }

  /** Batch enrich: get businessId, type, name, templateBusinessId for multiple RIDs.
   *  Version-aware: uses resolveRef() which returns lookup(rid) on 5.6.3+ or
   *  namespace refs (t.{bid}) on pre-5.6.3. Works on all BMP versions. */
  async batchEnrich(rids: string[], signal?: AbortSignal): Promise<{ results: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } }>; error?: string; errorKind?: BmpErrorKind }> {
    return this.ecQuery.batchEnrich(rids, signal);
  }

  /** Lightweight identity fetch for a single RID (version-aware). `fresh` evicts a cached legacy
   *  business-ID reference first, which is required when verifying an ID-changing write. */
  async lookupIdentity(
    rid: string,
    options?: { fresh?: boolean },
  ): Promise<{ name?: string; type?: string; businessId?: string; templateBusinessId?: string } | null> {
    if (options?.fresh) this._cache?.invalidate?.(rid);
    const { results } = await this.batchEnrich([rid]);
    return results[rid] ?? null;
  }

  /** Fetch code properties via EC */
  async fetchCodeViaEc(rid: string, properties: string[]): Promise<Record<string, string>> {
    return this.ecQuery.fetchCodeViaEc(rid, properties);
  }

  /** Read a bounded exact property selection with explicit missing state and
   * structured reference identities where requested. */
  async fetchSelectedProperties(
    rid: string,
    properties: readonly import('./ec-query-service').SelectedPropertyRequest[],
    signal?: AbortSignal,
  ): Promise<import('./ec-query-service').SelectedPropertyValue[]> {
    return this.ecQuery.fetchSelectedProperties(rid, properties, signal);
  }

  /** Batch fetch code properties for multiple objects in a single EC call */
  async batchFetchCode(
    rids: string[],
    properties: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, Record<string, string>>> {
    return this.ecQuery.batchFetchCode(rids, properties, signal);
  }

  /** Walk the layout subtree of a Scorecard / TabSet / Tab / Container.
   *  Returns flat nodes with parent linkage + responsive sizing — the
   *  panel folds these into a tree client-side. Single round trip via
   *  EC `.descendants()` so even deep nests cost one server call.
   *
   *  Returned types: Tab, TabSet, Container, plus widget objects bound to
   *  any container in the subtree (rendered as leaves with their cell
   *  reference). */
  async fetchLayoutTree(rid: string): Promise<{ nodes: LayoutNode[]; truncated: boolean }> {
    return this.ecQuery.fetchLayoutTree(rid);
  }

  /** Read several objects in as few HTTP posts as possible: every rid becomes
   *  one IntegrationGetObjectCommand, and up to FULL_READ_BATCH commands share
   *  one sendCommands call. The transport serialises posts, so Promise.all
   *  over single reads would run them one after another.
   *  Per-object failures are reported in `errors`. A chunk that BMP rejects
   *  as a whole (one server exception for the post, or an undecodable
   *  answer) is reported in `failedChunks` and its rids in `errors`; the
   *  other chunks are kept, so a caller can retry only the failed chunk.
   *  A connection failure (the post itself failed) throws. */
  async readFullObjects(rids: readonly string[], signal?: AbortSignal): Promise<FullObjectsRead> {
    const objects: Record<string, FullObject> = {};
    const errors: Record<string, string> = {};
    const failedChunks: Array<{ rids: string[]; error: string }> = [];
    const unique = [...new Set(rids)].filter(r => RID_SHAPE.test(r));
    // The load governor sets how many full reads share a post (25, adapted
    // to the answers; load-governor.ts). FULL_READ_BATCH is the ceiling.
    for (let i = 0; i < unique.length;) {
      const size = Math.max(1, Math.min(FULL_READ_BATCH, this.transport.governor.fullReadsPerPost));
      const chunk = unique.slice(i, i + size);
      i += chunk.length;
      signal?.throwIfAborted();
      const buffer = await this.transport.sendCommands(chunk.map(r => makeGetObjectCommand(r)), 'read', signal);
      let raw;
      try {
        raw = this.transport.deserializeResponse(buffer);
      } catch (e) {
        const kind = errorKindOf(e);
        if (isConnectionKind(kind)) throw e;
        const error = this.transport.formatError(e);
        failedChunks.push({ rids: chunk, error });
        for (const rid of chunk) errors[rid] = error;
        continue;
      }
      if (typeof raw?.$class === 'string' && raw.$class.includes('ExceptionResponse')) {
        const error = String(raw.message ?? 'BMP object read failed');
        failedChunks.push({ rids: chunk, error });
        for (const rid of chunk) errors[rid] = error;
        continue;
      }
      const responses = parseCommandResponse(raw);
      chunk.forEach((rid, index) => {
        const entry = responses[index];
        if (entry && typeof entry.$class === 'string' && entry.$class.includes('ExceptionResponse')) {
          errors[rid] = String(entry.message ?? 'Object read failed');
          return;
        }
        const obj = parseFullObject(entry);
        if (!obj) { errors[rid] = OBJECT_NO_DATA; return; }
        if (!obj.rid) obj.rid = rid;
        objects[obj.rid === rid ? rid : obj.rid] = obj;
      });
    }
    return failedChunks.length ? { objects, errors, failedChunks } : { objects, errors };
  }

  /** List an object window's structure (rid|||parent rows) in one read-only EC call. */
  async fetchStructureRows(rid: string, rule: StructureRule, signal?: AbortSignal): Promise<StructureRows> {
    validateRid(rid);
    // One constant script per rule: the root is the command's context.
    const result = await this.executeEcOn(buildStructureEc(CONTEXT_OBJECT, rule), rid, signal, OBJECT_RELATION_EC_TIMEOUT);
    if (!result.ok) throw ecResultError(result, 'Structure listing failed');
    if (result.hasWarning) throw new BmpRequestError(result.error || 'Structure listing returned warnings', 'server');
    return parseStructureRows(result.log ?? '');
  }

  /** Fetch full editor context in a single EC call: identity, template, code props for both.
   *  Replaces separate lookupIdentity + resolveTemplate + 2× fetchCodeViaEc round-trips. */
  async fetchEditorContext(rid: string, extraProps: string[] = []): Promise<EditorContextData | null> {
    return this.ecQuery.fetchEditorContext(rid, extraProps);
  }

  /** Save a code property via EC */
  async saveCodeViaEc(rid: string, property: string, code: string): Promise<{ ok: boolean; error?: string; outcomeUnknown?: boolean }> {
    const epoch = this.auth.sessionEpoch;
    validateEcIdentifier(property);
    const escaped = formatEcLiteral(code);
    const ref = await this.resolveRef(rid);
    this.auth.assertAuthEpoch(epoch);
    const ec = `_o := ${ref}\n_o.change(${property} := "${escaped}")`;
    const result = await this.executeEc(ec, undefined, true);
    if (!result.ok) {
      return { ok: false, error: result.error ?? result.log ?? 'EC save failed', ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}) };
    }
    return { ok: true };
  }

  /** Single EC round trip that reads an object's pane data.
   *  Returns identity + parent + template + allowlisted style props + siblings.
   *  Handles both model (.linkedTo) and enterprise (.template) objects. */
  async fetchObjectPane(
    rid: string,
    signal?: AbortSignal,
    options: { overrides?: boolean } = {},
  ): Promise<ObjectPaneData | null> {
    const data = await this.ecQuery.fetchObjectPane(rid, signal);
    if (!data) return null;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Master properties use a compact, read-only pane and have no instance
    // override delta. Avoid the otherwise redundant binary GetObject command.
    if (data.isPropertyDefinition) return data;
    // Overrides exist only on an object linked to a template, and only a
    // caller that asks for them (the AI property inspection) pays the second
    // post. Without a template the comparison below yields [] as well.
    if (options.overrides === false || data.template == null) {
      data.instanceOverrideProps = [];
      return data;
    }

    const overrideProps = await this.fetchOverriddenProps(rid, signal);
    if (overrideProps) {
      data.instanceOverrideProps = overrideProps;
    } else {
      // Some older BMP objects throw inside IntegrationGetObjectCommand. Keep
      // the pane usable with value comparison. This cannot reveal an explicit
      // same-value override, so authoritative metadata always wins when parsed.
      data.instanceOverrideProps = PANE_PROPS.filter(prop =>
        data.template != null
        && data.instanceProps[prop] !== data.templateProps[prop],
      );
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return data;
  }

  /** Object-window fallback when the binary read of `rid` fails on the
   *  server: identity and known properties from the guarded Extended Code
   *  pane read. Null when the object does not exist. */
  /** Tree row facts of many nodes (object-row-facts.ts): one small script
   *  per 50 nodes instead of a full read of each. */
  async readRowFacts(rids: readonly string[], signal?: AbortSignal): Promise<RowFactsRead> {
    return readRowFactsFor(this, rids, createEcFrame, signal);
  }

  async readRootFallback(rid: string, signal?: AbortSignal): Promise<FullObject | null> {
    const pane = await this.ecQuery.fetchObjectPane(rid, signal);
    return pane ? fullObjectFromPane(pane) : null;
  }

  async fetchPropertyApplications(rid: string, signal?: AbortSignal) {
    return this.ecQuery.fetchPropertyApplications(rid, signal);
  }

  /** The explicit overrides of a template-linked object, from the same
   *  binary read the object window uses. Null when the read fails (some
   *  older BMP objects throw inside IntegrationGetObjectCommand). */
  private async fetchOverriddenProps(rid: string, signal?: AbortSignal): Promise<string[] | null> {
    try {
      const { objects } = await this.readFullObjects([rid], signal);
      return objects[rid]?.overridden ?? null;
    } catch (e) {
      log.swallow('bmpClient:fetchObjectPane:overrides', e);
      return null;
    }
  }

  /** The classes an EditField's property mapping targets (object window). */
  async fetchEditFieldClassNames(rid: string, signal?: AbortSignal): Promise<string[]> {
    return this.ecQuery.fetchEditFieldClassNames(rid, signal);
  }

  /** Apply a batched pane/identity change to a single object via _o.change(...).
   *  Property names MUST be in OBJECT_CHANGE_PROPS_SET; values are escaped client-side.
   *  Callers must still read back persisted state: BMP execute mode commits writes,
   *  but does not provide rollback-on-error semantics. */
  async applyObjectChanges(
    rid: string,
    target: 'instance' | 'template',
    changes: Record<string, string | number | boolean>,
    resetProps: string[] = [],
  ): Promise<{ ok: boolean; error?: string; outcomeUnknown?: boolean }> {
    const epoch = this.auth.sessionEpoch;
    const props = Object.keys(changes);
    if (props.length === 0 && resetProps.length === 0) return { ok: true };
    if (target === 'template' && resetProps.length > 0) {
      return { ok: false, error: 'Template properties cannot be reset to an instance source' };
    }
    const duplicate = resetProps.find(prop => props.includes(prop));
    if (duplicate) return { ok: false, error: `Property cannot be changed and reset together: ${duplicate}` };
    for (const p of [...props, ...resetProps]) {
      if (!OBJECT_CHANGE_PROPS_SET.has(p)) {
        // Print enough context to diagnose the cause. We had a report
        // ("Property not allowed: disableSearch") for a prop that's
        // explicitly in PANE_PROPS — the most likely cause is a stale
        // bundled SW or a hidden-character name mismatch. Code-point
        // dump catches the latter; the set size tells us if the SW's
        // PANE_PROPS_SET is somehow empty.
        const codepoints = [...p].map(c => c.codePointAt(0)?.toString(16)).join(',');
        return {
          ok: false,
          error: `Property not allowed: "${p}" (codepoints ${codepoints}; ${OBJECT_CHANGE_PROPS_SET.size} props in allowlist). If this prop normally works, try Disable + Re-enable the extension to refresh the service worker.`,
        };
      }
      // Defense-in-depth: OBJECT_CHANGE_PROPS_SET is already an allowlist, but valid-
      // ating the identifier shape ensures even a corrupted allowlist can't
      // become an injection vector.
      validateEcIdentifier(p);
    }
    const ref = await this.resolveRef(rid);
    const assignments: string[] = [];
    for (const p of props) {
      // Shared rule (style-ec): colour links → `prop := t.<bid>` (a reference, never a quoted string,
      // which errors on a CorpoColor prop) or `:= ""` to CLEAR when empty; scalars → an EC literal.
      // Property editors store draft values as strings. `required` is outside
      // the style catalogue, so normalize it explicitly to an EC boolean
      // instead of persisting the string "true"/"false".
      const value = p === 'required'
        ? String(changes[p]).toLowerCase() === 'true'
        : changes[p];
      if (isFileLinkProp(p)) {
        // A link to a file: `lookup(<rid>)`, or `""` to clear it.
        const link = fileLinkRhs(changes[p]);
        if (link === null) return { ok: false, error: `Invalid file RID "${String(changes[p])}"` };
        assignments.push(`${p} := ${link}`);
        continue;
      }
      const rhs = styleAssignRhs(p, value, ecScalarLiteral);
      if (rhs === INVALID_COLOR_BID) return { ok: false, error: `Invalid colour id "${colorLinkBid(changes[p])}"` };
      assignments.push(`${p} := ${rhs}`);
    }
    const lines: string[] = [
      `_o := ${ref}`,
    ];
    if (target === 'template') {
      lines.push(...ecResolveTemplate('_o', '_t'));
      lines.push('IF _t = MISSING THEN');
      lines.push('  "no template"');
      lines.push('ELSE');
      lines.push(`  _t.change(${assignments.join(', ')})`);
      lines.push('ENDIF');
    } else {
      if (assignments.length > 0) lines.push(`_o.change(${assignments.join(', ')})`);
      for (const prop of resetProps) lines.push(`_o.reset(${prop})`);
    }
    this.auth.assertAuthEpoch(epoch);
    const result = await this.executeEc(lines.join('\n'), undefined, true);
    if (!result.ok) return { ok: false, error: result.error ?? result.log ?? 'Change failed', ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}) };
    if (result.log?.includes('no template')) return { ok: false, error: 'Object has no template' };
    return { ok: true };
  }

  /**
   * Preview, then apply the requested identity fields in one EC write.
   *
   * BMP's `transactional` flag means commit-vs-preview, not rollback on error.
   * The exact script is therefore previewed first, template resolution happens
   * before either write, and the lower-blast-radius instance change runs before
   * the linked-template ID change. The handler must always read back after a
   * write attempt and treat that persisted state as authoritative.
   */
  async applyIdentityChanges(
    rid: string,
    changes: IdentityChangeSet,
  ): Promise<{ ok: boolean; writeAttempted: boolean; error?: string }> {
    const epoch = this.auth.sessionEpoch;
    const changesTemplate = Object.hasOwn(changes, 'templateBusinessId');
    const instanceAssignments: string[] = [];

    if (changes.businessId !== undefined) {
      validateBusinessId(changes.businessId);
      instanceAssignments.push(`id := ${ecScalarLiteral(changes.businessId)}`);
    }
    if (changes.name !== undefined) {
      if (!changes.name.trim()) {
        return { ok: false, writeAttempted: false, error: 'Name is required.' };
      }
      instanceAssignments.push(`name := ${ecScalarLiteral(changes.name)}`);
    }
    if (changesTemplate) validateBusinessId(changes.templateBusinessId ?? '');
    if (instanceAssignments.length === 0 && !changesTemplate) {
      return { ok: true, writeAttempted: false };
    }

    const ref = await this.resolveRef(rid);
    this.auth.assertAuthEpoch(epoch);
    const lines = [`_o := ${ref}`];
    const instanceChange = instanceAssignments.length > 0
      ? `_o.change(${instanceAssignments.join(', ')})`
      : null;

    if (changesTemplate) {
      lines.push(...ecResolveTemplate('_o', '_t'));
      lines.push('IF _t = MISSING THEN');
      lines.push('  "no template"');
      lines.push('ELSE');
      if (instanceChange) lines.push(`  ${instanceChange}`);
      lines.push(`  _t.change(id := ${ecScalarLiteral(changes.templateBusinessId ?? '')})`);
      lines.push('ENDIF');
    } else if (instanceChange) {
      lines.push(instanceChange);
    }

    const script = lines.join('\n');
    // The preview of the user's write (script-kinds.ts: the user's kind).
    const preview = await this.executeEc(userScript(script), undefined, false);
    if (!preview.ok || preview.hasWarning) {
      return {
        ok: false,
        writeAttempted: false,
        error: preview.error
          ?? (preview.hasWarning
            ? `BMP reported a warning during identity validation${preview.log ? `: ${preview.log}` : '.'}`
            : preview.log)
          ?? 'Identity validation failed',
      };
    }
    if (preview.log?.includes('no template')) {
      return { ok: false, writeAttempted: false, error: 'Could not resolve the linked template.' };
    }

    this.auth.assertAuthEpoch(epoch);
    const result = await this.executeEc(script, undefined, true);
    if (!result.ok || result.hasWarning) {
      return {
        ok: false,
        writeAttempted: true,
        error: result.error
          ?? (result.hasWarning
            ? `BMP reported a warning while saving identity values${result.log ? `: ${result.log}` : '.'}`
            : result.log)
          ?? 'Identity change failed',
      };
    }
    if (result.log?.includes('no template')) {
      return { ok: false, writeAttempted: true, error: 'Could not resolve the linked template.' };
    }
    return { ok: true, writeAttempted: true };
  }

  /** Enumerate the workspace's colour sets + colours (for the link picker).
   *  Walks t.ColorRoot → CorpoColorSet → CorpoColor; each colour carries its
   *  bid (for linking via `t.<bid>`), name, and rgb (parsed from java.awt.Color). */
  async fetchColorSets(): Promise<ColorSetData[]> {
    return this.ecQuery.fetchColorSets();
  }

  /**
   * Live workspace search via BMP's GraphQL `quickSearch` — the exact engine
   * the web portal's search box uses. Returns NAVIGABLE objects (pages,
   * scorecards, tasks, enterprise objects) ranked by relevance, with their web
   * parent + page-location breadcrumb. `totalHits` counts all index matches,
   * including non-navigable sub-objects that quickSearch does not materialise,
   * so it can exceed the returned object count.
   *
   * Auth rides the user's BMP web session (JSESSIONID cookie via
   * `credentials: 'include'`), NOT the binary protocol's JWT — same as the
   * portal. The SW has host permission for the BMP origin, so the cookie is
   * attached automatically.
   */
  async quickSearch(
    text: string,
    opts: { page?: number; pageSize?: number; signal?: AbortSignal } = {},
  ): Promise<{ totalHits: number; objects: BmpObject[] }> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 40;
    const query =
      'query quickSearch($text: String, $pageSize: Int, $pageNumber: Int, $searchSlotConfigurationRid: String) {' +
      ' quickSearch(text: $text, pageSize: $pageSize, pageNumber: $pageNumber, searchSlotConfigurationRid: $searchSlotConfigurationRid) {' +
      ' totalHits hits { epmObject { rid name type webParentRid webParentName hasChildren tabRid } pageLocationInfo { rid name } } } }';
    await assertHostAccess(this.bmpUrl);
    // Not a command post, but it reads up to a page of objects: it takes its
    // turn in the transport lane and counts against the load governor.
    const res = await this.transport.sendGoverned('QuickSearch', opts.signal, () => fetch(`${this.bmpUrl}graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        operationName: 'quickSearch',
        variables: { text, pageNumber: page, pageSize, searchSlotConfigurationRid: '' },
        query,
      }),
      signal: opts.signal,
    }));
    if (res.status === 401 || res.status === 403 || res.redirected
      || (res.url && new URL(res.url).origin !== new URL(this.bmpUrl).origin)) {
      throw new Error('Portal login required for workspace search. Stored command access does not broaden portal search.');
    }
    if (!res.ok) throw new Error(`quickSearch HTTP ${res.status}`);
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (contentType && !contentType.includes('json')) {
      throw new Error('Portal login required for workspace search.');
    }
    // Not res.json(): a RID the server writes as a bare JSON number would go
    // through a JS number and lose its last digits above 2^53.
    const json = parseJsonKeepingRids(await res.text());
    if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'GraphQL error');
    const q: QuickSearchData = json?.data?.quickSearch ?? { totalHits: 0, hits: [] };
    const now = Date.now();
    const objects: BmpObject[] = (q.hits ?? [])
      .map((hit): BmpObject | null => {
        const e = hit.epmObject;
        if (e?.rid == null) return null;
        return {
          rid: String(e.rid),
          name: e.name ?? undefined,
          type: e.type ?? undefined,
          webParentRid: e.webParentRid != null ? String(e.webParentRid) : undefined,
          webParentName: e.webParentName ?? undefined,
          hasChildren: !!e.hasChildren,
          tabRid: e.tabRid != null ? String(e.tabRid) : undefined,
          pageRid: hit.pageLocationInfo?.rid != null ? String(hit.pageLocationInfo.rid) : undefined,
          pageName: hit.pageLocationInfo?.name ?? undefined,
          source: 'server',
          discoveredAt: now,
          updatedAt: now,
        };
      })
      .filter((o): o is BmpObject => o !== null);
    return { totalHits: q.totalHits ?? objects.length, objects };
  }

  // ── Static health checks ─────────────────────────────────────

  /**
   * Reachability and workspace check.
   *
   * `/health` is not a reliable workspace signal on its own: BMP 5.6 answers
   * it with an empty 404, while a wrong path on the same host also answers 404
   * and a catch-all web server answers 200 with HTML. When `/health` gives no
   * JSON status, the anonymous `cs/authentication` endpoint decides: a BMP
   * workspace answers it with a JSON object; anything else is not a workspace.
   */
  static async checkHealth(bmpUrl: string): Promise<HealthCheckResult> {
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    let res: Response;
    try {
      await assertHostAccess(bmpUrl);
      res = await fetch(`${bmpUrl}health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT), credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      if (e instanceof HostAccessError) throw e;
      log.swallow('bmpClient:checkHealth', e);
      const timedOut = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return {
        up: false, reachable: false, responseMs: elapsed(),
        detail: timedOut
          ? `No answer from ${bmpUrl} within ${HEALTH_TIMEOUT / 1000} seconds.`
          : `The request to ${bmpUrl} failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const ms = elapsed();
    if (res.status >= 500) {
      return { up: false, reachable: true, responseMs: ms, detail: `GET ${bmpUrl}health answered HTTP ${res.status}.` };
    }
    if (res.ok) {
      const data = await res.json().catch(() => null) as { status?: unknown } | null;
      if (data && typeof data.status === 'string') {
        return data.status === 'up'
          ? { up: true, reachable: true, responseMs: ms }
          : { up: false, reachable: true, responseMs: ms, detail: `BMP reported health status "${data.status}".` };
      }
    }
    const workspace = await BmpClient.probeWorkspace(bmpUrl);
    if (workspace.kind === 'workspace') return { up: true, reachable: true, responseMs: ms };
    if (workspace.kind === 'not-workspace') {
      return { up: false, reachable: true, notWorkspace: true, responseMs: ms, detail: workspace.detail };
    }
    // The health request was answered; an inconclusive workspace probe is
    // left to the sign-in check rather than reported as an outage.
    return { up: true, reachable: true, responseMs: ms };
  }

  /** Workspaces already confirmed in this worker lifetime (per base URL). */
  private static confirmedWorkspaces = new Set<string>();

  /** Ask the anonymous authentication-metadata endpoint whether `bmpUrl` is a
   *  BMP workspace. Read-only; sends no cookies or credentials. */
  static async probeWorkspace(bmpUrl: string): Promise<{ kind: 'workspace' | 'not-workspace' | 'unknown'; detail?: string }> {
    if (BmpClient.confirmedWorkspaces.has(bmpUrl)) return { kind: 'workspace' };
    let res: Response;
    try {
      res = await fetch(`${bmpUrl}cs/authentication`, {
        method: 'GET', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      });
    } catch (e) {
      log.swallow('bmpClient:probeWorkspace', e);
      return { kind: 'unknown' };
    }
    if (res.status === 401 || res.status === 403 || res.status >= 500) return { kind: 'unknown' };
    const notWorkspace = (why: string) => ({
      kind: 'not-workspace' as const,
      detail: `${bmpUrl} is not a BMP workspace: ${why}`,
    });
    if (!res.ok) return notWorkspace(`GET cs/authentication answered HTTP ${res.status}.`);
    const contentType = res.headers?.get?.('content-type') ?? '';
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return notWorkspace(`GET cs/authentication did not answer with BMP data${contentType ? ` (${contentType.split(';')[0]})` : ''}.`);
    }
    if (!('userName' in body) && !('defaultLocale' in body)) {
      return notWorkspace('GET cs/authentication answered JSON that BMP does not send.');
    }
    BmpClient.confirmedWorkspaces.add(bmpUrl);
    return { kind: 'workspace' };
  }

  static async getBuildNumber(bmpUrl: string, jwt?: string): Promise<BuildNumberProbeResult> {
    try {
      await assertHostAccess(bmpUrl);
      const headers: Record<string, string> = {};
      if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
      const res = await fetch(`${bmpUrl}buildNum`, { headers, signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
      if (res.status === 401 || res.status === 403) return { status: 'auth-required' };
      if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) {
        return { status: 'transient' };
      }
      if (!res.ok) return { status: 'unavailable' };
      const data = await res.json().catch(() => null);
      const version = typeof data?.version === 'string' ? data.version.trim() : '';
      return /^(?:v\.?)?\d+\.\d+\.\d+(?:\.\d+)?(?:\b|$)/i.test(version)
        ? { status: 'known', version } : { status: 'unavailable' };
    } catch (e) {
      log.swallow('bmpClient:getBuildNumber', e);
      return { status: 'transient' };
    }
  }

}
