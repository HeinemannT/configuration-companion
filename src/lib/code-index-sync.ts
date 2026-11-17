/**
 * Building and refreshing the code index (service worker). Read-only.
 *
 * Rule for every script here (ec-code-safety): code is read only inside
 * `output(…)`, which returns the stored text. A bare `_o.expression`, a
 * `WHERE`/`filter` on a code property, or a comparison on it runs the code.
 * Filters are on the stamp and the organisation reference only.
 *
 * Gentle by design (index-budget): one script per post, a budget per
 * request (objects and expected response size, halved when an answer is
 * large or slow), a pause after every post as long as the post took, one
 * job per server, and a stop at the first answer that reads like an
 * overloaded server. Lists are selected one at a time and released.
 *
 * A built index is checked with one small request (`buildSummaryEc`: per
 * source and type, count and newest changed stamp); only changed types
 * are listed then, only objects changed since the last list.
 *
 * A first build goes root by root (`CODE_ROOTS`), each root named in its
 * select: every root but the organisation root first (search is usable
 * from there on), then the organisation root top-level organisation by
 * organisation, a list over the row budget split into the organisation's
 * own objects and its sub-organisations. Lists carry RID, stamp and
 * organisation, never code; code is read in budgeted posts.
 *
 * Instances: an instance's code that equals its template's text is kept
 * once, on the template (compared here, not on the server); the instance
 * records `tmpl` and `inherits`. An instance is read again only when its
 * own stamp changes.
 *
 * Every post runs in the background request class. Free text travels in the
 * length-framed rows of ec-parser (constant markers, so a repeated question
 * is the same script); RIDs are strings throughout.
 */

import { appendRowEc, chunkByScriptSize, CONTEXT_OBJECT, contextObjectEc, countedFlushEc, createEcFrame, EC_CHUNK, EC_DONE_LITERAL, flushChunkEc, mergeFramedLogs, parseFramedLog, stableRidOrder, type EcFrame } from './ec-parser';
import { CONTEXT_PER_POST } from './constants';
import { constantScript, varyingScript } from './script-kinds';
import { BUDGET, packByRows, Pacer, ServerOverloadError, type RequestRecord } from './index-budget';
import { CODE_PROPS_FOR_TYPE } from './types';
import { findCodeRefs } from './code-refs';
import { backgroundSignal } from './request-class';
import type { CodeIndexMeta, CodeIndexStore, IndexedObject, IndexedRef, RootCoverage, StoredStamp } from './code-index-store';
import type { EcResult } from './bmp-client';
import type { BmpTypeCatalogue } from './bmp-type-catalogue';
import type { FullObject } from './object-read';

/** What the sync needs from the BMP client. */
export interface IndexClient {
  ensureLookupSupport(signal?: AbortSignal): Promise<boolean>;
  resolveRefs(rids: readonly string[], signal?: AbortSignal): Promise<Map<string, string | Error>>;
  executeEcBatch(codes: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<EcResult[]>;
  /** Scripts each with its own context object (or none) and context end
   *  date (`this.end`), in one post (BmpClient.executeEcPairs). */
  executeEcPairs?(pairs: ReadonlyArray<{ code: string; objectRid?: string; endMs?: number }>, signal?: AbortSignal, timeoutMs?: number): Promise<EcResult[]>;
  /** BmpClient.contextCheck: `unchecked` when the server's support for
   *  the context object could not be checked. */
  contextCheck?: 'supported' | 'ignored' | 'unchecked' | null;
  /** BmpClient.ensureContextSupport: false when the server ignores the
   *  command's context object. */
  ensureContextSupport?(signal?: AbortSignal): Promise<boolean>;
  /** Constant scripts with the object as the command context (BmpClient);
   *  without it the loop scripts are the fallback. */
  executeEcEach?(code: string, objectRids: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<Map<string, EcResult>>;
}

/** Rows collected before the chunk joins the inventory result. */
const INVENTORY_CHUNK = 40;
/** Properties whose text is not Extended Code: no references are read. */
const NOT_EC = new Set(['html', 'javascript', 'text', 'longText']);

/** The frame (ec-parser `createEcFrame`: the constant one). Kept as a name
 *  for this module's callers. */
export const plainFrame = createEcFrame;

/** Where a script runs: an object as the command's context and a date as
 *  its end (`this.end`), so neither is in the text. */
export interface Place { objectRid?: string; endMs?: number }

/** One question as several small scripts (ec-parser SCRIPT_TARGET_CHARS) in
 *  one post, their framed answers merged into one. A failed part fails the
 *  whole, as the one script did. With `place` and a client with the context
 *  path, `build` gets `onContext` and the scripts run there (constant);
 *  otherwise the object and the date are in the text. */
async function runSplit<T>(client: IndexClient, items: readonly T[], build: (group: readonly T[], onContext: boolean) => string, signal?: AbortSignal, timeoutMs?: number, place?: Place): Promise<EcResult[]> {
  const onContext = !!place && !!client.executeEcPairs;
  const codes = chunkByScriptSize(items, g => build(g, onContext)).map(g => build(g, onContext));
  if (!codes.length) codes.push(build([], onContext));
  const results = onContext
    ? await client.executeEcPairs!(codes.map(code => ({ code, ...place })), signal, timeoutMs)
    : await client.executeEcBatch(codes, signal, timeoutMs);
  const bad = results.find(r => !r.ok || r.log == null);
  if (bad) return [bad];
  try {
    return [{ ...results[0], ok: true, log: mergeFramedLogs(results.map(r => r.log!)), ...(results.some(r => r.hasWarning) ? { hasWarning: true } : {}) }];
  } catch (e) {
    return [{ ok: false, error: e instanceof Error ? e.message : String(e), errorKind: 'protocol' }];
  }
}

/** Code properties per type. */
export type CodePropMap = Readonly<Record<string, readonly string[]>>;

/** The properties the extension knows without asking the server: the
 *  floor of every discovered map (script and HTML bodies are plain strings
 *  on the server, so they are not found as expressions). */
export const STATIC_CODE_PROPS: CodePropMap = CODE_PROPS_FOR_TYPE;

export function codeTypes(map: CodePropMap = STATIC_CODE_PROPS): string[] {
  return Object.keys(map);
}

export function propsOf(type: string, map: CodePropMap = STATIC_CODE_PROPS): readonly string[] {
  return map[type] ?? [];
}

// ── which properties hold code (asked from the server) ────────────

/** What discovery needs besides the EC routes: the native type list and
 *  the full object read (the same read the object window uses). */
export interface DiscoveryClient {
  fetchTypeCatalogue(signal?: AbortSignal): Promise<BmpTypeCatalogue>;
  readFullObjects(rids: readonly string[], signal?: AbortSignal): Promise<{ objects: Record<string, FullObject>; errors: Record<string, string> }>;
}


const TYPE_NAME = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const PROP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;

/** Code properties of the standard BMP configuration types, as read from
 *  the full object read of real objects (BMP 5.6.17). Discovery starts from
 *  here, so it samples only types this table does not name. */
export const KNOWN_CODE_PROPS: CodePropMap = {
  ...CODE_PROPS_FOR_TYPE,
  PieChart: ['expression', 'variablesExpression'],
  RiskChart: ['expression', 'markerBorderColorExpression'],
  ActionButton: ['expression', 'initExpression', 'afterExpression', 'editExpression', 'refreshExpression'],
  ButtonInput: ['expression', 'initExpression', 'afterExpression', 'defaultExpression', 'enableExpression', 'refreshExpression', 'showExpression', 'destinationExpression'],
  BooleanInput: ['enableExpression', 'refreshExpression', 'showExpression', 'defaultExpression'],
  DateInput: ['enableExpression', 'refreshExpression', 'showExpression', 'defaultExpression'],
  ListInput: ['enableExpression', 'refreshExpression', 'showExpression', 'defaultExpression'],
  NumberInput: ['enableExpression', 'refreshExpression', 'showExpression', 'defaultExpression'],
  TextInput: ['enableExpression', 'refreshExpression', 'showExpression', 'defaultExpression'],
  ReferenceInput: ['enableExpression', 'showExpression', 'defaultExpression', 'refreshExpression', 'expression', 'filterExpression'],
  Card: ['colorExpression', 'linkExpression', 'backgroundColorExpression'],
  CardPart: ['secondExpression', 'firstColorExpression', 'firstExpression', 'firstLinkExpression', 'secondLinkExpression', 'secondColorExpression'],
  RelationshipCard: ['backgroundColorExpression', 'expression', 'colorExpression'],
  CategoryAxisPlotline: ['markerPlacementExpression'],
  NumberAxisPlotline: ['markerPlacementExpression'],
  CreateObjectView: ['initExpression', 'afterExpression', 'parentDestinationExpression', 'editExpression'],
  CustomVisualizationExpression: ['expression'],
  EditField: ['enableExpression', 'showExpression', 'defaultExpression', 'requiredExpression'],
  EditPage: ['useExpression', 'afterExpression'],
  EditPageInfo: ['showExpression', 'expression'],
  EditPageValidation: ['expression'],
  ExtendedTargetConfig: ['expression'],
  FilteredComments: ['afterExpression', 'initExpression', 'destinationExpression', 'expression'],
  HistoricalReferenceMethodConfig: ['afterExpression', 'destinationExpression', 'expression', 'filterExpression'],
  ReferenceMethodConfig: ['afterExpression', 'destinationExpression', 'expression', 'filterExpression'],
  ImageView: ['expression'],
  LockPolicy: ['expression'],
  UserTaskPage: ['customNavigationTargetExpressionOnComplete'],
  Validation: ['refreshExpression', 'expression'],
};

/** Class names that can be configuration objects with code. A concrete
 *  type the table does not know is sampled only when its name fits. */
export const CODE_TYPE_HINT = /(Input|Button|Chart|Card|CardPart|Page|View|MethodConfig|Expression|Transport|Visualization|Table|Field|Plotline|Validation|Label|Comments|Policy|TargetConfig|Element|Info)$/;

/** The types discovery asks about: concrete, not in the table, and named
 *  like a configuration type that can hold code. */
export function discoveryCandidates(catalogue: BmpTypeCatalogue, known: CodePropMap): string[] {
  return Object.entries(catalogue.types)
    .filter(([id, f]) => f.concrete && TYPE_NAME.test(id) && !known[id] && CODE_TYPE_HINT.test(id))
    .map(([id]) => id).sort();
}

/** For each type, whether it has objects in one of `sources`, and the RID of
 *  one. One list variable is reused, so the script never holds more than
 *  one type's list. */
export function buildExistsEc(types: readonly string[], sources: readonly string[]): string {
  const lines = ['_r := ""'];
  for (const t of types) {
    if (!TYPE_NAME.test(t)) throw new Error(`Invalid type ${t}`);
    lines.push('_f := ""');
    for (const src of sources) {
      if (src !== 'root' && !/^root\.[a-z][A-Za-z0-9]{0,40}$/.test(src)) throw new Error(`Invalid source ${src}`);
      lines.push(`_l := SELECT ${t} FROM ${src}`, 'IF _f = "" AND _l.size() > 0 THEN', '     _f := str(_l.first().rid)', 'ENDIF', '_l := ""');
    }
    lines.push(`_r := _r + "${t}|" + _f + "\\n"`);
  }
  lines.push('_r + "#DONE"');
  // Constant: one text per group of the server's own types.
  return constantScript('buildExistsEc', lines.join('\n'));
}

export function parseExistsLog(log: string): Map<string, string> {
  if (!log.includes('#DONE')) throw new Error('The type list came back incomplete');
  const out = new Map<string, string>();
  for (const line of log.split('\n')) {
    const [t, rid] = line.trim().replace(/^Result\s*:\s*/i, '').split('|');
    if (t && TYPE_NAME.test(t) && rid && RID.test(rid.trim())) out.set(t, rid.trim());
  }
  return out;
}

export interface Discovery {
  map: Record<string, string[]>;
  /** Concrete types on the server, types asked about, types with objects
   *  among those, objects read as samples. */
  types: number;
  withObjects: number;
  sampled: number;
  /** Types that could not be read (named in the status). */
  unreadable: string[];
  posts: number;
}

/**
 * Which properties hold code, with little work for the server: the known
 * table, plus the concrete types the table does not know whose name fits
 * (`discoveryCandidates`). Those are checked for objects (one list kept at
 * a time, `typesPerScript` types a post) and one object of each is read in
 * full, `sampleObjects` objects a post. Kept with the index per server and
 * extension version; asked again only when the user forces it.
 */
export async function discoverCodeProps(client: IndexClient & DiscoveryClient, signal: AbortSignal, pacer = new Pacer(), sources: readonly string[] = ['root']): Promise<Discovery> {
  const map: Record<string, string[]> = Object.fromEntries(Object.entries(KNOWN_CODE_PROPS).map(([t, p]) => [t, [...p]]));
  let catalogue: BmpTypeCatalogue | null = null;
  await pacer.post('type list', 0, async () => { catalogue = await client.fetchTypeCatalogue(signal); return [{ ok: true, log: '' }]; }, signal);
  const all = Object.values(catalogue!.types).filter(f => f.concrete).length;
  const candidates = discoveryCandidates(catalogue!, map);
  const found = new Map<string, string>();
  const unreadable: string[] = [];
  for (let i = 0; i < candidates.length; i += BUDGET.typesPerScript) {
    const group = candidates.slice(i, i + BUDGET.typesPerScript);
    const [r] = await pacer.post('types with objects', 0, () => client.executeEcBatch([buildExistsEc(group, sources)], signal, 60_000), signal);
    if (r?.ok && r.log != null) { try { for (const [t, rid] of parseExistsLog(r.log)) found.set(t, rid); continue; } catch { /* named below */ } }
    unreadable.push(...group);
  }
  const rids = [...found.values()];
  const typeOf = new Map([...found].map(([t, rid]) => [rid, t]));
  let sampled = 0;
  for (let i = 0; i < rids.length; i += BUDGET.sampleObjects) {
    const chunk = rids.slice(i, i + BUDGET.sampleObjects);
    let read: { objects: Record<string, FullObject> } = { objects: {} };
    await pacer.post('sample objects', chunk.length, async () => { read = await client.readFullObjects(chunk, signal); return [{ ok: true, log: '' }]; }, signal);
    for (const rid of chunk) {
      const obj = read.objects[rid];
      const t = typeOf.get(rid)!;
      if (!obj) { unreadable.push(t); continue; }
      sampled++;
      for (const [prop, v] of Object.entries(obj.props)) {
        // Extended Code only: time expressions are classified as code by the
        // read too, but they are not code.
        if (v.kind !== 'code' || !PROP_NAME.test(prop)) continue;
        if (v.cls ? !/Extended/.test(v.cls) : !/(^e|E)xpression$/.test(prop)) continue;
        const list = map[t] ?? (map[t] = []);
        if (!list.includes(prop)) list.push(prop);
      }
    }
  }
  return { map, types: all, withObjects: found.size, sampled, unreadable: [...new Set(unreadable)].sort(), posts: pacer.log.length };
}

/** Old name of the sample script, kept for the integration test: one type
 *  at a time, the list released after use. */
export function buildSampleEc(types: readonly string[]): string {
  return buildExistsEc(types, ['root']);
}

// ── roots ─────────────────────────────────────────────────────────

/** The roots that can hold code, in build order, with the label used when
 *  the server gives no name. Every root is named in its select: a plain
 *  `SELECT … FROM root` does not reach every root on every server. The
 *  organisation root is last and read top-level organisation by
 *  organisation (the largest share of code on a large server). */
export const CODE_ROOTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'templateCategory', label: 'Templates' },
  { key: 'portal', label: 'Portal' },
  { key: 'page', label: 'Pages' },
  { key: 'expression', label: 'Expressions' },
  { key: 'classConfig', label: 'Class configuration' },
  { key: 'property', label: 'Properties' },
  { key: 'notification', label: 'Notifications' },
  { key: 'transformer', label: 'Transformers' },
  { key: 'actionPlan', label: 'Action plans' },
  { key: 'defaults', label: 'Defaults' },
  { key: 'risk', label: 'Risks' },
  { key: 'processManagement', label: 'Process management' },
  { key: 'organisation', label: 'Organisation' },
];
export const ORG_ROOT = 'organisation';
const ROOT_KEY = /^[a-z][A-Za-z0-9]{0,40}$/;
const RID = /^-?\d{1,20}$/;

export interface RootList {
  /** accessor → name on the server ('' when the root has no name). Roots
   *  the server does not have are left out. */
  roots: Map<string, string>;
  /** accessor → the root's RID (the context object of a scan script). */
  rootRids?: Map<string, string>;
  /** Organisations: RID → name and parent organisation RID ('' on top). */
  orgs: Map<string, { name: string; parent: string }>;
}

/** One post: every root's name, and every organisation with its parent.
 *  Names and parents only; no code is touched. */
export function buildRootListEc(roots: readonly string[], frame: EcFrame): string {
  const lines = ['_r := ""', `${EC_CHUNK} := ""`];
  for (const key of roots) {
    if (!ROOT_KEY.test(key)) throw new Error(`Invalid root ${key}`);
    lines.push(`_x := root.${key}`, ...appendRowEc(EC_CHUNK, ['"R"', `"${key}"`, '_x.rid.whenMissing("")', '_x.name.whenMissing("")', '""']));
  }
  if (roots.includes(ORG_ROOT)) {
    lines.push(
      '_k := 0',
      `_gs := SELECT Organisation FROM root.${ORG_ROOT}`,
      '_gs.forEach(_g:',
      ...appendRowEc(EC_CHUNK, ['"G"', '_g.rid', '_g.name.whenMissing("")', '_g.parent.rid.whenMissing("")', '_g.parent.className.whenMissing("")'], '     '),
      '     _k := _k + 1',
      '     IF _k >= 40 THEN',
      ...flushChunkEc().map(l => `          ${l}`),
      '          _k := 0',
      '     ENDIF',
      ')',
    );
  }
  lines.push(...flushChunkEc(), `_r + ${EC_DONE_LITERAL}`);
  return constantScript('buildRootListEc', lines.join('\n'));
}

export function parseRootListLog(log: string, frame: EcFrame): RootList {
  const roots = new Map<string, string>();
  const rootRids = new Map<string, string>();
  const raw: Array<[string, string, string, string]> = [];
  for (const [kind, a, b, c, d] of parseFramedLog(log, frame, 5)) {
    if (kind === 'R' && ROOT_KEY.test(a) && RID.test(b.trim())) { roots.set(a, c); rootRids.set(a, b.trim()); }
    else if (kind === 'G' && RID.test(a.trim())) raw.push([a.trim(), b, c.trim(), d.trim()]);
  }
  const orgs = new Map<string, { name: string; parent: string }>();
  for (const [rid, name, parent, cls] of raw) orgs.set(rid, { name, parent: cls === 'Organisation' && RID.test(parent) ? parent : '' });
  return { roots, rootRids, orgs };
}

/** RIDs from the top-level organisation down to `org` (a broken or cyclic
 *  chain stops). */
export function orgPath(org: string, orgs: ReadonlyMap<string, { parent: string }> | Readonly<Record<string, { parent: string }>>): string[] {
  const get = (r: string) => (orgs instanceof Map ? orgs.get(r) : (orgs as Record<string, { parent: string }>)[r]);
  const out: string[] = [];
  let cur = org;
  while (cur && get(cur) && !out.includes(cur) && out.length < 32) { out.unshift(cur); cur = get(cur)!.parent; }
  return out;
}

// ── inventory ─────────────────────────────────────────────────────

/** List the objects of one type: RID, stamp and code length (`stamps`), or
 *  only RIDs. `from` scopes the select to a subtree (an EC reference that
 *  the caller built from a validated RID). Only the unit and integration
 *  tests use it now; a search scope is listed by code-search-scope. */
export function buildInventoryEc(type: string, frame: EcFrame, opts: { from?: string; stamps?: boolean; map?: CodePropMap } = {}): string {
  const map = opts.map ?? STATIC_CODE_PROPS;
  if (!map[type] || !TYPE_NAME.test(type)) throw new Error(`Not a code type: ${type}`);
  const stamps = opts.stamps !== false;
  const lines = ['_r := ""', `${EC_CHUNK} := ""`, `_list := SELECT ${type} FROM ${opts.from ?? 'root'}`, '_k := 0', '_list.forEach(_o:'];
  if (stamps) lines.push(...lengthEc(type, map));
  const fields = stamps
    ? ['_o.rid', '_o.lastModifiedDate.whenMissing("")', '_len']
    : ['_o.rid'];
  lines.push(
    ...appendRowEc(EC_CHUNK, fields, '     '),
    '     _k := _k + 1',
    `     IF _k >= ${INVENTORY_CHUNK} THEN`,
    ...flushChunkEc().map(l => `          ${l}`),
    '          _k := 0',
    '     ENDIF',
    ')',
    ...flushChunkEc(),
    `_r + ${EC_DONE_LITERAL}`,
  );
  return lines.join('\n');
}

/** `_len` := the code length of `_o`, counted on the server from the text
 *  (`output(…)`: the code is never run, ec-code-safety). */
function lengthEc(type: string, map: CodePropMap): string[] {
  const lines = ['     _len := 0'];
  for (const p of propsOf(type, map)) {
    if (!PROP_NAME.test(p)) throw new Error(`Invalid property ${p}`);
    lines.push(
      `     _v_${p} := output(_o.${p})`,
      `     _w_${p} := _v_${p}.whenMissing("")`,
      `     _s_${p} := _w_${p}.size()`,
      `     _len := _len + _s_${p}`,
    );
  }
  return lines;
}

export interface InventoryRow { rid: string; stamp: string; len: number; type?: string; org?: string }

export function parseInventoryLog(log: string, frame: EcFrame, stamps = true): InventoryRow[] {
  let rows: string[][];
  try { rows = parseFramedLog(log, frame); } catch { throw new Error('The object list came back incomplete (the answer was cut off)'); }
  const out: InventoryRow[] = [];
  for (const f of rows) {
    const rid = f[0].trim();
    if (!RID.test(rid)) throw new Error('The object list holds a damaged row');
    if (!stamps) { out.push({ rid, stamp: '', len: 0 }); continue; }
    if (f.length !== 3) throw new Error('The object list holds a damaged row');
    const len = Number(f[2].trim());
    out.push({ rid, stamp: f[1].trim(), len: Number.isFinite(len) ? len : -1 });
  }
  return out;
}


/** One list of the staged build: a root, one top-level organisation of the
 *  organisation root (with its sub-organisations), or one organisation's
 *  own objects when its list is larger than the budget. */
export interface Bucket {
  /** `r:<root>`, `o:<organisation RID>` or `own:<organisation RID>`. */
  key: string;
  root: string;
  /** Organisation RID of an organisation bucket. */
  org?: string;
  /** Only the objects whose own organisation is `org`. */
  own?: boolean;
}

export const rootBucket = (root: string): Bucket => ({ key: `r:${root}`, root });
export const orgBucket = (org: string, own = false): Bucket => ({ key: `${own ? 'own' : 'o'}:${org}`, root: ORG_ROOT, org, ...(own ? { own: true } : {}) });

/** yyyy-mm-dd, two days before `ms`: a refresh lists the objects changed
 *  since then (the server and this browser may be in other time zones). */
export function sinceDay(ms: number): string {
  return new Date(ms - 2 * 86_400_000).toISOString().slice(0, 10);
}

function fromOf(bucket: Bucket, onContext = false): string {
  if (!ROOT_KEY.test(bucket.root)) throw new Error(`Invalid root ${bucket.root}`);
  if (bucket.org != null && !RID.test(bucket.org)) throw new Error(`Invalid RID ${bucket.org}`);
  return bucket.org != null ? (onContext ? 'this.object' : `lookup(${bucket.org})`) : `root.${bucket.root}`;
}

/** Where a bucket's scripts run on the context path: an organisation as
 *  the context, the day as the context's end. */
export function placeOf(bucket: Bucket, since?: string): Place | undefined {
  const endMs = since ? Date.parse(`${since}T00:00:00Z`) : undefined;
  if (bucket.org == null && endMs == null) return undefined;
  return { ...(bucket.org != null ? { objectRid: bucket.org } : {}), ...(endMs != null ? { endMs } : {}) };
}

/** The bucket key in a count row: the place is not in the text, so every
 *  row carries `*` (countTargets puts the bucket's key back). */
const CONTEXT_KEY = '*';

const COUNT_FROM = /^(?:this\.object|root\.[a-z][A-Za-z0-9]{0,40}|lookup\(-?\d{1,20}\))$/;

function countText(from: string, types: readonly string[], own: boolean): string {
  if (!COUNT_FROM.test(from)) throw new Error(`Invalid count source ${from}`);
  const lines = ['_r := ""', `_g := ${from}`];
  for (const type of types) {
    if (!TYPE_NAME.test(type)) throw new Error(`Not a type: ${type}`);
    lines.push(`_l := SELECT ${type} FROM _g${own ? ' WHERE organisation = _g' : ''}`,
      '_n := _l.size()', ...appendRowEc('_r', ['"N"', `"${CONTEXT_KEY}"`, `"${type}"`, '_n']), '_l := ""');
  }
  lines.push(`_r + ${EC_DONE_LITERAL}`);
  return lines.join('\n');
}

/**
 * How many objects each of `types` has under `from`: one select at a time,
 * released after its size is read. No code is touched.
 *
 * `from` is the command's context (`this.object`, the default: a root or an
 * organisation travels as the context, so the text depends on the type
 * group only), a root by its accessor (`root.<key>`: the fallback for a
 * server that ignores the context; one text per root and type group) or an
 * organisation by `lookup(<RID>)` (a client without the context path;
 * varying). `own` counts only the objects whose organisation is the place.
 */
export function buildCountEc(types: readonly string[], from: string = CONTEXT_OBJECT, own = false): string {
  const text = countText(from, types, own);
  return from.startsWith('lookup(') ? varyingScript('buildCountEc', text) : constantScript('buildCountEc', text);
}

/** The type groups of a count: the type list sorted and cut into scripts
 *  of about SCRIPT_TARGET_CHARS characters and at most
 *  BUDGET.countsPerScript selects. The same list gives the same groups
 *  whatever is counted and wherever: a count sends only the groups that
 *  hold a type it wants, so its texts never depend on the root, the
 *  organisation or the subset of types asked. */
export function countGroups(types: readonly string[]): string[][] {
  const sorted = [...new Set(types)].sort();
  const out: string[][] = [];
  // Measured with the longest form (an organisation's own objects), so
  // every form of a group stays near the target.
  for (const g of chunkByScriptSize(sorted, x => countText(CONTEXT_OBJECT, x, true))) {
    for (let i = 0; i < g.length; i += BUDGET.countsPerScript) out.push(g.slice(i, i + BUDGET.countsPerScript));
  }
  return out;
}

export function parseCountLog(log: string, frame: EcFrame): Map<string, number> {
  const out = new Map<string, number>();
  for (const [kind, key, type, n] of parseFramedLog(log, frame, 4)) {
    const v = Number(n.trim());
    if (kind === 'N' && TYPE_NAME.test(type) && Number.isSafeInteger(v)) out.set(`${key}|${type}`, v);
  }
  return out;
}

/** A place to count in: a bucket and, for a root, the root's RID (its
 *  context object; without it the root is named in the text). */
export interface CountTarget { bucket: Bucket; rid?: string }

export interface CountResult {
  /** `<bucket key>|<type>` → objects. */
  counts: Map<string, number>;
  /** bucket key → why it could not be counted. */
  failed: Map<string, string>;
}

interface CountCommand { key: string; code: string; objectRid?: string; selects: number; part: readonly string[]; retry?: string }

/**
 * Count `types` in every target. A root or an organisation is the command's
 * context, so a text depends only on its types: a type group of `all` (the
 * caller's full type list, countGroups) when the count wants at least half
 * of the group, otherwise one text per wanted type. The texts never depend
 * on the place, and their number is bounded by the type list, not by the
 * number of roots or organisations.
 *
 * Commands are packed into posts of at most `BUDGET.countsPerScript`
 * selects (several places in one post). A server that ignores the context,
 * a root without a known RID, or a root the server refuses as a context is
 * counted with the root named in the text (`root.<key>`): then one text per
 * root and type group. A place that cannot be counted is in `failed` with
 * the reason; nothing is left out silently.
 */
export async function countTargets(
  client: IndexClient, targets: readonly CountTarget[], types: readonly string[],
  opts: { all?: readonly string[]; signal?: AbortSignal; post?: (send: () => Promise<EcResult[]>) => Promise<EcResult[]> } = {},
): Promise<CountResult> {
  const counts = new Map<string, number>();
  const failed = new Map<string, string>();
  const wanted = new Set(types);
  const groups = countGroups(opts.all ?? types).filter(g => g.some(t => wanted.has(t)));
  const extra = [...wanted].filter(t => !groups.some(g => g.includes(t)));
  if (extra.length) groups.push(...countGroups(extra));
  if (!groups.length || !targets.length) return { counts, failed };
  const parts = groups.flatMap(g => {
    const hit = g.filter(t => wanted.has(t));
    return hit.length * 2 >= g.length ? [g] : hit.map(t => [t]);
  });
  const post = opts.post ?? (send => send());
  let context = !!client.executeEcPairs;
  if (context && client.ensureContextSupport) {
    try { context = await client.ensureContextSupport(opts.signal); } catch { /* the post says what fails */ }
  }
  const onContext: CountCommand[] = [];
  const byText: CountCommand[] = [];
  for (const { bucket, rid } of targets) {
    const own = !!bucket.own;
    for (const part of parts) {
      const selects = part.length;
      if (bucket.org != null) {
        if (!RID.test(bucket.org)) throw new Error(`Invalid RID ${bucket.org}`);
        // The client applies the text form itself where the server ignores
        // the context (BmpClient.executeEcPairs).
        if (client.executeEcPairs) onContext.push({ key: bucket.key, code: buildCountEc(part, CONTEXT_OBJECT, own), objectRid: bucket.org, selects, part });
        else byText.push({ key: bucket.key, code: buildCountEc(part, `lookup(${bucket.org})`, own), selects, part });
      } else {
        if (!ROOT_KEY.test(bucket.root)) throw new Error(`Invalid root ${bucket.root}`);
        const named = `root.${bucket.root}`;
        if (context && rid && RID.test(rid)) onContext.push({ key: bucket.key, code: buildCountEc(part, CONTEXT_OBJECT), objectRid: rid, selects, part, retry: named });
        else byText.push({ key: bucket.key, code: buildCountEc(part, named), selects, part });
      }
    }
  }
  const take = (cmd: CountCommand, r: EcResult | undefined) => {
    if (failed.has(cmd.key)) return;
    if (!r?.ok || r.log == null) { failed.set(cmd.key, r?.error || r?.log || 'no answer'); return; }
    try {
      for (const [k, v] of parseCountLog(r.log, plainFrame())) {
        const type = k.slice(k.indexOf('|') + 1);
        if (wanted.has(type)) counts.set(`${cmd.key}|${type}`, v);
      }
    } catch (e) {
      failed.set(cmd.key, e instanceof Error ? e.message : String(e));
    }
  };
  const packs = (cmds: readonly CountCommand[]): CountCommand[][] => {
    const out: CountCommand[][] = [];
    let cur: CountCommand[] = [];
    let n = 0;
    for (const c of cmds) {
      if (cur.length && n + c.selects > BUDGET.countsPerScript) { out.push(cur); cur = []; n = 0; }
      cur.push(c);
      n += c.selects;
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const retry: CountCommand[] = [];
  for (const pack of packs(onContext)) {
    const results = await post(() => client.executeEcPairs!(pack.map(c => ({ code: c.code, objectRid: c.objectRid })), opts.signal, 60_000));
    pack.forEach((c, i) => {
      const r = results[i];
      // A root the server does not take as a context: named in the text.
      if (c.retry && r && !r.ok && (r.errorKind == null || r.errorKind === 'server')) {
        retry.push({ key: c.key, part: c.part, selects: c.selects, code: buildCountEc(c.part, c.retry) });
      } else take(c, r);
    });
  }
  for (const pack of packs([...byText, ...retry])) {
    const results = await post(() => client.executeEcBatch(pack.map(c => c.code), opts.signal, 60_000));
    pack.forEach((c, i) => take(c, results[i]));
  }
  for (const key of failed.keys()) for (const k of [...counts.keys()]) if (k.startsWith(`${key}|`)) counts.delete(k);
  return { counts, failed };
}

/**
 * List the objects of `types` in one bucket: RID, stamp and, in the
 * organisation root, the object's own organisation. No code is read: a
 * change is seen in the stamp. `since` (yyyy-mm-dd) lists only objects
 * changed since that day; `ridsOnly` lists RIDs (removal check). One list
 * variable is reused. The caller keeps the expected rows within
 * `BUDGET.listRows`.
 *
 * The filters are on the stamp and on the organisation reference, never on
 * code (ec-code-safety). The day is a literal in the WHERE clause, the form
 * proven on BMP 5.6.17 (`WHERE lastModifiedDate >= date("2026-11-06")`).
 */
export function buildBucketInventoryEc(bucket: Bucket, types: readonly string[], frame: EcFrame, opts: { since?: string; ridsOnly?: boolean; orglessOnly?: boolean } = {}, onContext = false): string {
  if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) throw new Error(`Invalid day ${opts.since}`);
  const org = bucket.root === ORG_ROOT;
  const since = opts.since && !opts.ridsOnly;
  // On the context path the day is the context's end (`this.end`, the
  // same comparison, verified on BMP 5.6.17) and the organisation the
  // context: the script is constant.
  const conds = [...(bucket.own ? ['organisation = _g'] : []), ...(since ? [onContext ? 'lastModifiedDate >= _since' : `lastModifiedDate >= date("${opts.since}")`] : [])];
  const lines = ['_r := ""', `${EC_CHUNK} := ""`, `_g := ${fromOf(bucket, onContext)}`, '_k := 0', ...(since && onContext ? ['_since := this.end'] : [])];
  for (const type of types) {
    if (!TYPE_NAME.test(type)) throw new Error(`Not a type: ${type}`);
    const fields = opts.ridsOnly
      ? ['"O"', `"${type}"`, 'str(_o.rid)', '""', '""']
      : ['"O"', `"${type}"`, 'str(_o.rid)', 'str(_o.lastModifiedDate.whenMissing(""))', org ? 'str(_o.organisation.rid.whenMissing(""))' : '""'];
    // Objects without an organisation of their own (a visualization's data
    // input): kept when an organisation's list is split by organisation.
    const keep = opts.orglessOnly ? ['     IF str(_o.organisation.rid.whenMissing("")) = "" THEN', ...appendRowEc(EC_CHUNK, fields, '          '), '     ENDIF'] : appendRowEc(EC_CHUNK, fields, '     ');
    lines.push(
      `_l := SELECT ${type} FROM _g${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}`,
      '_l.forEach(_o:',
      ...keep,
      '     _k := _k + 1',
      `     IF _k >= ${INVENTORY_CHUNK} THEN`,
      ...flushChunkEc().map(l => `          ${l}`),
      '          _k := 0',
      '     ENDIF',
      ')',
      '_l := ""',
    );
  }
  lines.push(...flushChunkEc(), `_r + ${EC_DONE_LITERAL}`);
  const constant = (bucket.org == null || onContext) && (!since || onContext);
  return constant ? constantScript('buildBucketInventoryEc', lines.join('\n')) : varyingScript('buildBucketInventoryEc', lines.join('\n'));
}

export function parseBucketInventoryLog(log: string, frame: EcFrame): InventoryRow[] {
  const rows: InventoryRow[] = [];
  for (const [kind, type, rid, stamp, org] of parseFramedLog(log, frame, 5)) {
    if (kind !== 'O') continue;
    if (!RID.test(rid.trim()) || !TYPE_NAME.test(type)) throw new Error('The object list holds a damaged row');
    rows.push({ rid: rid.trim(), type, stamp: stamp.trim(), len: 0, ...(RID.test(org.trim()) ? { org: org.trim() } : {}) });
  }
  return rows;
}

// ── the change summary ────────────────────────────────────────────

/** Roots a plain `SELECT … FROM root` may not reach: each is asked too. */
export const SUMMARY_ROOTS = ['templateCategory', 'portal', 'actionPlan', 'risk', 'defaults'] as const;

/**
 * The refresh's one small request: per source (`root` and the roots it may
 * not reach) and type, how many objects there are, how many changed since
 * `since`, and the newest stamp among those. Nothing else is read when the
 * answer equals the stored one. Lists are released after use; only the
 * changed objects are walked.
 */
export function buildSummaryEc(types: readonly string[], sources: readonly string[], since: string, frame: EcFrame, onContext = false): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`Invalid day ${since}`);
  // On the context path the day is the context's end (`this.end`).
  const lines = ['_r := ""', ...(onContext ? ['_since := this.end'] : [])];
  for (const src of sources) {
    if (src !== 'root' && !/^root\.[a-z][A-Za-z0-9]{0,40}$/.test(src)) throw new Error(`Invalid source ${src}`);
    for (const t of types) {
      if (!TYPE_NAME.test(t)) throw new Error(`Not a type: ${t}`);
      lines.push(
        `_l := SELECT ${t} FROM ${src}`, '_n := _l.size()', '_l := ""',
        `_c := SELECT ${t} FROM ${src} WHERE lastModifiedDate >= ${onContext ? '_since' : `date("${since}")`}`,
        '_m := ""', '_md := date("1970-01-01")',
        '_c.forEach(_o:',
        '     IF _o.lastModifiedDate > _md THEN',
        '          _md := _o.lastModifiedDate',
        '          _m := str(_o.lastModifiedDate)',
        '     ENDIF',
        ')',
        '_cn := _c.size()',
        ...appendRowEc('_r', ['"S"', `"${src}"`, `"${t}"`, '_n', '_cn', '_m']),
        '_c := ""',
      );
    }
  }
  lines.push(`_r + ${EC_DONE_LITERAL}`);
  return onContext ? constantScript('buildSummaryEc', lines.join('\n')) : varyingScript('buildSummaryEc', lines.join('\n'));
}

/** `<source>|<type>` → count, changed since the day, newest changed stamp. */
export type Summary = Record<string, { n: number; c: number; m: string }>;

export function parseSummaryLog(log: string, frame: EcFrame): Summary {
  const out: Summary = {};
  for (const [kind, src, t, n, c, m] of parseFramedLog(log, frame, 6)) {
    const nn = Number(n.trim()), cc = Number(c.trim());
    if (kind === 'S' && TYPE_NAME.test(t) && Number.isSafeInteger(nn) && Number.isSafeInteger(cc)) out[`${src}|${t}`] = { n: nn, c: cc, m: m.trim() };
  }
  return out;
}

/** The summary's sources for the roots a server has: `root` and the roots
 *  a plain select from it may not reach. */
export function summarySources(present: readonly string[]): string[] {
  return ['root', ...SUMMARY_ROOTS.filter(r => present.includes(r)).map(r => `root.${r}`)];
}

/** The change summary (buildSummaryEc) of `map`'s types in `present` roots,
 *  for the day window `day`: one post, paced. Throws when it fails. */
export async function readChangeSummary(client: IndexClient, map: CodePropMap, present: readonly string[], day: string, signal: AbortSignal, pacer: Pacer): Promise<Summary> {
  const types = codeTypes(map);
  const sources = summarySources(present);
  const since = sinceDay(Date.parse(`${day}T00:00:00Z`));
  const frame = plainFrame();
  const [r] = await pacer.post('summary', 0, () => runSplit(client, types, (t, c) => buildSummaryEc(t, sources, since, frame, c), signal, 60_000, { endMs: Date.parse(`${since}T00:00:00Z`) }), signal);
  if (!r?.ok || r.log == null) throw new Error(r?.error || r?.log || 'The change summary failed');
  return parseSummaryLog(r.log, frame);
}

/** Types whose summary differs from the stored one (count or newest
 *  stamp), and whether a count moved (objects may have been removed). */
export function summaryChanges(prev: Summary | undefined, next: Summary): { types: Set<string>; counted: Set<string> } {
  const types = new Set<string>();
  const counted = new Set<string>();
  for (const [k, v] of Object.entries(next)) {
    const t = k.slice(k.indexOf('|') + 1);
    const p = prev?.[k];
    if (!p || p.n !== v.n) { types.add(t); counted.add(t); } else if (p.m !== v.m) types.add(t);
  }
  return { types, counted };
}

// ── reading code ──────────────────────────────────────────────────

export interface ReadItem { rid: string; ref: string; type: string; props: readonly string[] }

/** One LIST of framed rows: an identity row per object (with the template
 *  it is an instance of), a code row per property, read with `output(…)`:
 *  the stored text, never run (ec-code-safety). No comparison on the
 *  server: an instance's text is compared with its template's here. */
export function buildReadEc(items: readonly ReadItem[], _frame: EcFrame = createEcFrame()): string {
  // Objects with the same code properties (one type a script, readObjects)
  // share one loop over their list: the reads are written once per group,
  // not once per object. Code bodies are long, so the chunk joins the result
  // every few objects.
  const groups = new Map<string, { props: string[]; byRid: Map<string, string> }>();
  for (const it of items) {
    if (!RID.test(it.rid)) throw new Error(`Invalid RID ${it.rid}`);
    for (const p of it.props) if (!PROP_NAME.test(p)) throw new Error(`Invalid property ${p}`);
    const props = [...new Set(it.props)].sort();
    const key = props.join(',');
    const g = groups.get(key) ?? { props, byRid: new Map<string, string>() };
    g.byRid.set(it.rid, it.ref);
    groups.set(key, g);
  }
  const lines = ['_r := ""', `${EC_CHUNK} := ""`, '_k := 0'];
  for (const { props, byRid } of [...groups.values()].sort((a, b) => (a.props.join(',') < b.props.join(',') ? -1 : 1))) {
    lines.push(
      `LIST(${stableRidOrder(byRid.keys()).map(rid => byRid.get(rid)!).join(', ')}).forEach(_o:`,
      '     IF _o != MISSING THEN',
      '          _oid := str(_o.rid)',
      ...appendRowEc(EC_CHUNK, ['"I"', '_oid', '_o.id.whenMissing("")', '_o.name.whenMissing("")', '_o.parent.name.whenMissing("")',
        '_o.parent.parent.name.whenMissing("")', '_o.lastModifiedDate.whenMissing("")', '_o.linkedTo.rid.whenMissing("")'], '          '),
      ...props.flatMap(p => appendRowEc(EC_CHUNK, ['"C"', '_oid', `"${p}"`, `output(_o.${p}.whenMissing(""))`], '          ')),
      '     ENDIF',
      ...countedFlushEc('_k', 4),
      ')',
    );
  }
  lines.push(...flushChunkEc(), `_r + ${EC_DONE_LITERAL}`);
  return varyingScript('buildReadEc', lines.join('\n'));
}

/** The code read of the context object: ONE constant script per property
 *  set (BmpClient.executeEcEach). Rows as buildReadEc. */
export function buildContextReadEc(props: readonly string[]): string {
  const sorted = [...new Set(props)].sort();
  for (const p of sorted) if (!PROP_NAME.test(p)) throw new Error(`Invalid property ${p}`);
  return constantScript('buildContextReadEc', contextObjectEc('_o', [
    '_oid := str(_o.rid)',
    ...appendRowEc(EC_CHUNK, ['"I"', '_oid', '_o.id.whenMissing("")', '_o.name.whenMissing("")', '_o.parent.name.whenMissing("")',
      '_o.parent.parent.name.whenMissing("")', '_o.lastModifiedDate.whenMissing("")', '_o.linkedTo.rid.whenMissing("")']),
    ...sorted.flatMap(p => appendRowEc(EC_CHUNK, ['"C"', '_oid', `"${p}"`, `output(_o.${p}.whenMissing(""))`])),
  ]).join('\n'));
}

export interface ReadObject {
  rid: string;
  businessId: string;
  name: string;
  parent: string;
  grandparent: string;
  stamp: string;
  code: Record<string, string>;
  /** Template RID (`linkedTo`), when the object is an instance. */
  tmpl?: string;
  /** Properties whose text is the template's. */
  inherits?: string[];
}

/** Rows of `buildReadEc`. Throws on a cut-off answer. `rids`: the objects
 *  asked for; one that wrote no row no longer exists and gets an empty
 *  identity, as when every object had its own block. */
export function parseReadLog(log: string, frame: EcFrame, rids: readonly string[] = []): Map<string, ReadObject> {
  let rows: string[][];
  try { rows = parseFramedLog(log, frame); } catch (e) {
    if (e instanceof Error && /damaged/.test(e.message)) throw new Error('The code read holds a damaged row');
    throw new Error('The code read came back incomplete (the answer was cut off)');
  }
  const out = new Map<string, ReadObject>();
  for (const f of rows) {
    if (f[0] === 'I' && (f.length === 7 || f.length === 8)) {
      const rid = f[1];
      const cur = out.get(rid);
      const tmpl = (f[7] ?? '').trim();
      out.set(rid, { rid, businessId: f[2], name: f[3], parent: f[4], grandparent: f[5], stamp: f[6].trim(), code: cur?.code ?? {}, ...(RID.test(tmpl) && tmpl !== rid ? { tmpl } : {}) });
    } else if (f[0] === 'C' && f.length === 4) {
      const cur = out.get(f[1]);
      if (!cur) throw new Error('The code read holds a row without its object');
      if (f[3]) cur.code[f[2]] = f[3];
    } else {
      throw new Error('The code read holds a damaged row');
    }
  }
  for (const rid of rids) {
    if (!out.has(rid)) out.set(rid, { rid, businessId: '', name: '', parent: '', grandparent: '', stamp: '', code: {} });
  }
  return out;
}

/** An instance's properties whose text is its template's are kept once, on
 *  the template: they move from `code` to `inherits`. */
export function foldIntoTemplate(o: ReadObject, template: Pick<IndexedObject, 'code'> | null | undefined): ReadObject {
  if (!o.tmpl || !template) return o;
  const code: Record<string, string> = {};
  const inherits: string[] = [];
  for (const [p, t] of Object.entries(o.code)) {
    if (template.code[p] === t) inherits.push(p); else code[p] = t;
  }
  return inherits.length ? { ...o, code, inherits } : o;
}

export function refsOf(code: Record<string, string>): IndexedRef[] {
  const out: IndexedRef[] = [];
  for (const [p, text] of Object.entries(code)) {
    if (NOT_EC.has(p)) continue;
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    for (const r of findCodeRefs(text)) {
      const ls = starts[r.line - 1] ?? 0;
      out.push({ k: r.key, p, l: r.line, s: r.start - ls, e: r.end - ls, f: r.form });
    }
  }
  return out;
}

/** Where an object lives: its root and, in the organisation root, the
 *  organisations above it. */
export interface Placement { root?: string; path?: string[] }

export function toIndexed(env: string, type: string, o: ReadObject, inv?: InventoryRow, place: Placement = {}): IndexedObject {
  const len = Object.values(o.code).reduce((n, t) => n + t.length, 0);
  return {
    env, rid: o.rid, type, name: o.name, businessId: o.businessId,
    where: [o.grandparent, o.parent].filter(Boolean).join(' › '),
    stamp: inv?.stamp || o.stamp, len,
    code: o.code, refs: refsOf(o.code),
    ...(place.root ? { root: place.root } : {}),
    ...(place.path?.length ? { path: place.path } : {}),
    ...(o.tmpl ? { tmpl: o.tmpl } : {}),
    ...(o.inherits?.length ? { inherits: [...o.inherits] } : {}),
  };
}

/**
 * Read `items` one script per post, `pacer.readSize` objects a script
 * (adapted to the size and time of each answer), paced. An object BMP
 * cannot read is isolated by halving its script, never by retrying a whole
 * post; an answer that reads like an overloaded server stops the read
 * (`ServerOverloadError`).
 */
export async function readObjects(
  client: IndexClient, items: readonly Omit<ReadItem, 'ref'>[], signal: AbortSignal,
  onPost?: (read: Map<string, ReadObject>, failed: Map<string, string>) => Promise<void>,
  pacer: Pacer = new Pacer(),
): Promise<{ posts: number; bytes: number; failed: Map<string, string> }> {
  const failedAll = new Map<string, string>();
  let posts = 0;
  let bytes = 0;
  // One type a script: a type's first read is small, later ones are sized
  // from that type's answers (Pacer.readSizeFor).
  const sorted = [...items].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const pending: Array<Array<Omit<ReadItem, 'ref'>>> = [];
  let next = 0;
  while (pending.length || next < sorted.length) {
    signal.throwIfAborted();
    let group = pending.shift();
    if (!group) {
      const type = sorted[next].type;
      const size = Math.max(1, pacer.readSizeFor(type));
      group = [];
      while (next < sorted.length && sorted[next].type === type && group.length < size) group.push(sorted[next++]);
    }
    if (!group.length) continue;
    if (client.executeEcEach) {
      // One constant script per property set, each object as its command's
      // context: an object the server cannot read fails alone (no halving).
      const each = client.executeEcEach.bind(client);
      const frame = plainFrame();
      const rids = group.map(i => i.rid);
      const t0 = Date.now();
      let answers = new Map<string, EcResult>();
      await pacer.post('read code', group.length, async () => { answers = await each(buildContextReadEc(group[0].props), rids, signal); return [...answers.values()]; }, signal);
      posts += Math.ceil(rids.length / CONTEXT_PER_POST);
      const size = [...answers.values()].reduce((n, r) => n + (r.log?.length ?? 0), 0);
      bytes += size;
      pacer.adapt(size, Date.now() - t0, group.length, group[0].type);
      const read = new Map<string, ReadObject>();
      const failed = new Map<string, string>();
      for (const rid of rids) {
        const r = answers.get(rid);
        if (r?.ok && r.log != null) {
          try { for (const [k, o] of parseReadLog(r.log, frame, [rid])) read.set(k, o); continue; } catch { /* as failed */ }
        }
        if (r?.errorKind && r.errorKind !== 'server') throw new Error(r.error || 'The code read failed');
        failed.set(rid, r?.error || r?.log || 'The object could not be read');
      }
      for (const [rid, e] of failed) failedAll.set(rid, e);
      await onPost?.(read, failed);
      continue;
    }
    const refs = await client.resolveRefs(group.map(i => i.rid), signal);
    const script: ReadItem[] = [];
    const failed = new Map<string, string>();
    for (const it of group) {
      const ref = refs.get(it.rid);
      if (typeof ref === 'string') script.push({ ...it, ref }); else failed.set(it.rid, ref?.message ?? 'The object could not be resolved');
    }
    const read = new Map<string, ReadObject>();
    if (script.length) {
      const frame = plainFrame();
      const t0 = Date.now();
      const [r] = await pacer.post('read code', script.length, () => client.executeEcBatch([buildReadEc(script, frame)], signal), signal);
      posts++;
      const size = (r?.log?.length ?? 0);
      bytes += size;
      pacer.adapt(size, Date.now() - t0, script.length, script[0].type);
      let ok = false;
      if (r?.ok && r.log != null) {
        try { for (const [rid, o] of parseReadLog(r.log, frame, script.map(it => it.rid))) read.set(rid, o); ok = true; } catch { /* halved below */ }
      }
      if (!ok) {
        if (r?.errorKind && r.errorKind !== 'server') throw new Error(r.error || 'The code read failed');
        if (script.length === 1) failed.set(script[0].rid, r?.error || r?.log || 'The object could not be read');
        else {
          // Halve to isolate the object BMP cannot read; the halves are read
          // next, paced like every post.
          const half = Math.ceil(group.length / 2);
          pending.unshift(group.slice(0, half), group.slice(half));
          continue;
        }
      }
    }
    for (const [rid, e] of failed) failedAll.set(rid, e);
    await onPost?.(read, failed);
  }
  return { posts, bytes, failed: failedAll };
}

// ── sync ──────────────────────────────────────────────────────────

export interface SyncProgress {
  phase: 'listing' | 'reading' | 'done';
  /** Objects read so far in this sync, of `toRead`. */
  read: number;
  toRead: number;
  /** Objects with code in the index. */
  objects: number;
  /** The stage being built. */
  stage?: 'roots' | 'organisation' | 'check';
}

/** Posts and time of one stage (measurement, status). */
export interface StageCost { stage: string; posts: number; ms: number; read: number }

export interface SyncResult {
  meta: CodeIndexMeta;
  /** Objects new or changed since the previous sync (read this time). */
  changed: number;
  /** This sync was the first complete build. */
  first: boolean;
  removed: number;
  failed: number;
  posts: number;
  bytes: number;
  ms: number;
  stages: StageCost[];
  /** Every request: operation, objects, response size, time, pause. */
  requests: RequestRecord[];
  /** A check found nothing changed (one request). */
  unchanged?: boolean;
}

export class IndexUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'IndexUnavailableError'; }
}

/** Label of a root: the server's name of the root object, else ours. */
export function rootLabel(key: string, serverName?: string): string {
  return serverName?.trim() || CODE_ROOTS.find(r => r.key === key)?.label || key;
}

export interface SyncOptions {
  signal: AbortSignal;
  onProgress?: (p: SyncProgress) => void;
  now?: () => number;
  /** Ask again which properties hold code (the user's Refresh). */
  rediscover?: boolean;
  /** List every object again (the user's Refresh). */
  full?: boolean;
  roots?: readonly string[];
  /** Extension version: discovery is kept per server and version. */
  version?: string;
  pacer?: Pacer;
  /** Rows per list script (BUDGET.listRows; lower in tests). */
  listRows?: number;
}

/**
 * Bring the index of `env` up to date with the server, gently
 * (index-budget): one script per post, paced, a budget per request, and a
 * stop at the first sign of an overloaded server.
 *
 * A built index is first checked with one small request (the summary: per
 * source and type, count and newest changed stamp). When it equals the
 * stored one, nothing else is sent. Otherwise only the changed types are
 * listed (objects changed since the last list), and a type whose count
 * moved is counted per list and listed again as RIDs where its count
 * differs, which finds removed objects.
 *
 * A first build (or `full`) goes root by root: every root but the
 * organisation root (search is usable from there on), then the
 * organisation root, top-level organisation by organisation, with a list
 * larger than the budget split into the organisation's own objects and its
 * sub-organisations. Every post is committed before the next one, so a
 * stopped build resumes where it stopped.
 */
export async function syncCodeIndex(
  client: IndexClient & Partial<DiscoveryClient>, store: CodeIndexStore, env: string, opts: SyncOptions,
): Promise<SyncResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const signal = backgroundSignal({ signal: opts.signal });
  const alive = () => { signal.throwIfAborted(); };
  const pacer = opts.pacer ?? new Pacer();
  if (!(await client.ensureLookupSupport(signal))) {
    throw new IndexUnavailableError('This server has no lookup() (BMP before 5.6.3), so its code cannot be read in bulk.');
  }
  const prev = await store.getMeta(env);
  const today = new Date(now()).toISOString().slice(0, 10);
  const stages: StageCost[] = [];
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const p = pacer.log.length, t = now(), r = readSoFar;
    const out = await fn();
    stages.push({ stage: name, posts: pacer.log.length - p, ms: now() - t, read: readSoFar - r });
    return out;
  };
  const readSoFar = 0;
  const result = (meta: CodeIndexMeta, extra: Partial<SyncResult>): SyncResult => ({
    meta, first: false, changed: 0, removed: 0, failed: 0, bytes: 0, ...extra,
    posts: pacer.log.length, ms: now() - t0, stages, requests: pacer.log,
  });

  // ── a built index: the one small request first ──
  const summaryTypes = (map: CodePropMap, present: readonly string[]) => ({
    types: codeTypes(map),
    sources: ['root', ...SUMMARY_ROOTS.filter(r => present.includes(r)).map(r => `root.${r}`)],
  });
  if (prev?.builtAt && !opts.full && prev.codeProps && prev.rootOrder && prev.summary) {
    const { types, sources } = summaryTypes(prev.codeProps, prev.rootOrder);
    // The summary's day window is kept for a week (answers stay comparable),
    // then moved to today: that one check lists the changed objects again.
    const day = prev.summaryDay && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${prev.summaryDay}T00:00:00Z`) <= 7 * 86_400_000 ? prev.summaryDay : today;
    const since = sinceDay(Date.parse(`${day}T00:00:00Z`));
    const frame = plainFrame();
    const summary = await stage('check', async () => {
      const [r] = await pacer.post('summary', 0, () => runSplit(client, types, (t, c) => buildSummaryEc(t, sources, since, frame, c), signal, 60_000, { endMs: Date.parse(`${since}T00:00:00Z`) }), signal);
      if (!r?.ok || r.log == null) throw new Error(r?.error || r?.log || 'The change summary failed');
      return parseSummaryLog(r.log, frame);
    });
    // The same day window as the stored summary: comparable.
    const comparable = day === prev.summaryDay;
    const changes = summaryChanges(comparable ? prev.summary : undefined, summary);
    if (!changes.types.size) {
      const meta: CodeIndexMeta = { ...prev, syncedAt: now() };
      alive();
      await store.putMeta(meta);
      opts.onProgress?.({ phase: 'done', read: 0, toRead: 0, objects: meta.objects });
      return result(meta, { unchanged: true });
    }
    return refreshChanged(client, store, env, { ...prev, summaryDay: day }, summary, changes, { ...opts, now, pacer, signal, today, stages, t0 });
  }

  // ── a first build, or every object listed again ──
  opts.onProgress?.({ phase: 'listing', read: 0, toRead: 0, objects: prev?.objects ?? 0, stage: 'roots' });
  const discoveryKey = `v${opts.version ?? '0'}`;
  let map: Record<string, string[]> = prev?.codeProps ? { ...prev.codeProps } : Object.fromEntries(Object.entries(KNOWN_CODE_PROPS).map(([t, p]) => [t, [...p]]));
  let discovery = prev?.discovery;
  let discoveredAt = prev?.codePropsAt ?? null;
  if (client.fetchTypeCatalogue && client.readFullObjects && (opts.rediscover || !prev?.codeProps || prev.discoveryKey !== discoveryKey)) {
    try {
      const d = await stage('discovery', () => discoverCodeProps(client as IndexClient & DiscoveryClient, signal, pacer, ['root', ...SUMMARY_ROOTS.map(r => `root.${r}`)]));
      map = d.map;
      discoveredAt = now();
      discovery = { types: d.types, withObjects: d.withObjects, sampled: d.sampled, unreadable: d.unreadable };
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof ServerOverloadError) throw e;
      // Keep the previous (or known) list; the status names the failure.
      discovery = { ...(discovery ?? { types: 0, withObjects: 0, sampled: 0, unreadable: [] }), error: e instanceof Error ? e.message : String(e) };
    }
  }
  const types = codeTypes(map);

  const wanted = (opts.roots ?? CODE_ROOTS.map(r => r.key)).filter(k => ROOT_KEY.test(k));
  const rootList = await stage('roots list', () => readRootList(client, wanted, signal, pacer));
  const present = wanted.filter(k => rootList.roots.has(k));
  if (!present.length) throw new Error('The server answered with none of the roots that hold code');
  const orgs = rootList.orgs;
  const tops = [...orgs].filter(([, g]) => !g.parent).map(([rid]) => rid);
  alive();

  const stored = await store.stamps(env);
  const roots: Record<string, RootCoverage> = {};
  for (const key of present) {
    // A resumed build keeps what it finished.
    const was = prev?.roots?.[key];
    roots[key] = {
      name: rootLabel(key, rootList.roots.get(key)), objects: was?.objects ?? 0, done: !opts.full && !!was?.done,
      ...(key === ORG_ROOT ? { tops: tops.length, topsRead: !opts.full ? (was?.topsRead ?? []).filter(t => tops.includes(t)) : [] } : {}),
    };
    if (key === ORG_ROOT) roots[key].topsDone = roots[key].topsRead!.length;
  }
  const empty: Record<string, string> = opts.full ? {} : { ...(prev?.empty ?? {}) };
  const meta: CodeIndexMeta = {
    env, syncedAt: prev?.syncedAt ?? null, builtAt: opts.full ? prev?.builtAt ?? null : prev?.builtAt ?? null,
    objects: prev?.objects ?? 0, bytes: prev?.bytes ?? 0, types, pending: 0, revision: prev?.revision ?? 0,
    codeProps: map, codePropsAt: discoveredAt, discoveryKey, ...(discovery ? { discovery } : {}),
    roots, rootOrder: present, orgs: Object.fromEntries(orgs),
    ...(rootList.rootRids?.size ? { rootRids: Object.fromEntries([...rootList.rootRids].filter(([k]) => present.includes(k))) } : prev?.rootRids ? { rootRids: prev.rootRids } : {}),
    stage: prev?.builtAt && !opts.full ? 'done' : 'roots',
    buckets: opts.full ? {} : { ...(prev?.buckets ?? {}) }, empty,
  };
  alive();
  await store.putMeta(meta);

  const ctx: BuildCtx = { client, store, env, signal, pacer, map, orgs, stored, meta, empty, today, onProgress: opts.onProgress, listRows: opts.listRows ?? BUDGET.listRows, counters: { read: 0, changed: 0, removed: 0, failed: 0, bytes: 0, failedRids: new Set() } };
  const counters = ctx.counters;
  const sync = (b: Bucket, s: SyncProgress['stage'], ts: readonly string[] = types) => syncBucket(ctx, b, ts, s);

  await stage('roots', async () => {
    for (const key of present.filter(k => k !== ORG_ROOT)) {
      if (roots[key].done) continue;
      await sync(rootBucket(key), 'roots');
      roots[key].done = true;
      countObjects(stored, meta);
      alive();
      await store.putMeta(meta);
    }
  });
  if (meta.stage === 'roots') meta.stage = 'organisation';
  alive();
  await store.putMeta(meta);

  if (roots[ORG_ROOT]) {
    await stage('organisation', async () => {
      const org = roots[ORG_ROOT];
      for (const top of tops) {
        if (org.topsRead?.includes(top)) continue;
        await sync(orgBucket(top), 'organisation');
        org.topsRead = [...(org.topsRead ?? []), top];
        org.topsDone = org.topsRead.length;
        countObjects(stored, meta);
        alive();
        await store.putMeta(meta);
      }
      org.done = true;
      // Objects under an organisation that is no longer a top-level one.
      const topSet = new Set(tops);
      const stray = [...stored].filter(([, s]) => s.root === ORG_ROOT && (!s.top || !topSet.has(s.top))).map(([rid]) => rid);
      if (stray.length) { alive(); await store.remove(env, stray); for (const r of stray) stored.delete(r); counters.removed += stray.length; }
    });
  }
  const gone = [...stored].filter(([, s]) => s.root && !roots[s.root]).map(([rid]) => rid);
  if (gone.length) { alive(); await store.remove(env, gone); for (const r of gone) stored.delete(r); counters.removed += gone.length; }

  // Instances read before their template: folded here, without the server.
  await stage('fold', () => foldStored(store, env, stored, signal));
  // One count request per root: what the index misses is named.
  const { missing: incomplete, uncounted } = await stage('completeness', () => checkCompleteness({ ...ctx, rootRids: meta.rootRids }, present, types));
  if (Object.keys(incomplete).length) meta.incomplete = incomplete; else delete meta.incomplete;
  if (Object.keys(uncounted).length) meta.uncounted = uncounted; else delete meta.uncounted;

  // The base of the next check: one summary, as the refresh will ask it.
  const { types: sTypes, sources } = summaryTypes(map, present);
  const frame = plainFrame();
  const sumSince = sinceDay(Date.parse(`${today}T00:00:00Z`));
  const [sr] = await pacer.post('summary', 0, () => runSplit(client, sTypes, (t, c) => buildSummaryEc(t, sources, sumSince, frame, c), signal, 60_000, { endMs: Date.parse(`${sumSince}T00:00:00Z`) }), signal);
  if (sr?.ok && sr.log != null) { try { meta.summary = parseSummaryLog(sr.log, frame); meta.summaryDay = today; } catch { delete meta.summary; } }

  countObjects(stored, meta);
  const at = now();
  meta.stage = 'done';
  meta.pending = counters.failedRids.size;
  meta.failed = counters.failedRids.size;
  meta.syncedAt = at;
  meta.builtAt = meta.builtAt ?? at;
  meta.lastFullAt = at;
  meta.revision = (meta.revision ?? 0) + 1;
  alive();
  await store.putMeta(meta);
  opts.onProgress?.({ phase: 'done', read: counters.read, toRead: counters.read, objects: meta.objects });
  return result(meta, { first: !prev?.builtAt, changed: counters.changed, removed: counters.removed, failed: counters.failed, bytes: counters.bytes });
}

interface BuildCtx {
  client: IndexClient; store: CodeIndexStore; env: string; signal: AbortSignal; pacer: Pacer;
  map: CodePropMap; orgs: ReadonlyMap<string, { name: string; parent: string }>;
  stored: Map<string, StoredStamp>; meta: CodeIndexMeta; empty: Record<string, string>; today: string;
  onProgress?: (p: SyncProgress) => void;
  listRows: number;
  counters: { read: number; changed: number; removed: number; failed: number; bytes: number; failedRids: Set<string> };
}

function countObjects(stored: ReadonlyMap<string, StoredStamp>, meta: CodeIndexMeta): void {
  let n = 0;
  let b = 0;
  const per: Record<string, number> = {};
  for (const s of stored.values()) { n++; b += s.len; if (s.root) per[s.root] = (per[s.root] ?? 0) + 1; }
  meta.objects = n;
  meta.bytes = b;
  for (const [k, r] of Object.entries(meta.roots ?? {})) r.objects = per[k] ?? 0;
}

const inBucket = (b: Bucket, s: StoredStamp) => (b.org ? s.root === ORG_ROOT && !!s.path?.includes(b.org) && (!b.own || s.path?.at(-1) === b.org) : s.root === b.root);

/** Words for a bucket in a message. */
function bucketLabel(ctx: Pick<BuildCtx, 'orgs' | 'meta'>, b: Bucket): string {
  if (b.org != null) return `organisation ${ctx.orgs.get(b.org)?.name || b.org}${b.own ? ' (its own objects)' : ''}`;
  return `root ${ctx.meta.roots?.[b.root]?.name ?? rootLabel(b.root)}`;
}

/** Count `types` in buckets (countTargets: one constant text per type
 *  group of the index's type list). A bucket that cannot be counted stops
 *  the list that needs the count, naming the bucket and the reason. */
async function countBuckets(ctx: BuildCtx, buckets: readonly Bucket[], types: readonly string[]): Promise<Map<string, number>> {
  const targets = buckets.map(bucket => ({ bucket, ...(bucket.org == null && ctx.meta.rootRids?.[bucket.root] ? { rid: ctx.meta.rootRids[bucket.root] } : {}) }));
  const { counts, failed } = await countTargets(ctx.client, targets, types, {
    all: codeTypes(ctx.map), signal: ctx.signal, post: send => ctx.pacer.post('count', 0, send, ctx.signal),
  });
  if (failed.size) {
    const [key, why] = [...failed][0];
    const b = buckets.find(x => x.key === key)!;
    throw new Error(`The object count failed in ${bucketLabel(ctx, b)}: ${why}`);
  }
  return counts;
}

/** List `types` of a bucket within the row budget: types packed into
 *  scripts by their counts; a type larger than the budget in an
 *  organisation is listed per own objects and sub-organisation. */
async function listWithinBudget(ctx: BuildCtx, bucket: Bucket, types: readonly string[], counts: ReadonlyMap<string, number>, opts: { since?: string; ridsOnly?: boolean; orglessOnly?: boolean } = {}, depth = 0): Promise<{ rows: InventoryRow[]; listed: Set<string> }> {
  const rows: InventoryRow[] = [];
  const listed = new Set<string>();
  const n = (t: string) => counts.get(`${bucket.key}|${t}`) ?? 0;
  const big = types.filter(t => n(t) > ctx.listRows && bucket.org && !bucket.own && depth < 6);
  const small = types.filter(t => !big.includes(t) && n(t) > 0);
  for (const group of packByRows(small, n, ctx.listRows)) {
    const frame = plainFrame();
    const [r] = await ctx.pacer.post(opts.ridsOnly ? 'list RIDs' : 'list', group.reduce((a, t) => a + n(t), 0), () => runSplit(ctx.client, group, (t, c) => buildBucketInventoryEc(bucket, t, frame, opts, c), ctx.signal, 60_000, placeOf(bucket, opts.ridsOnly ? undefined : opts.since)), ctx.signal);
    if (!r?.ok || r.log == null) throw new Error(r?.error || r?.log || 'The object list failed');
    rows.push(...parseBucketInventoryLog(r.log, frame));
    for (const t of group) listed.add(t);
  }
  for (const t of types) if (n(t) === 0 && !big.includes(t)) listed.add(t);
  if (big.length) {
    const kids = [...ctx.orgs].filter(([, g]) => g.parent === bucket.org).map(([rid]) => orgBucket(rid));
    const parts = [orgBucket(bucket.org!, true), ...kids];
    const sub = await countBuckets(ctx, parts, big);
    const covered = new Map<string, number>();
    for (const part of parts) {
      const got = await listWithinBudget(ctx, part, big, sub, opts, depth + 1);
      rows.push(...got.rows);
      for (const t of got.listed) covered.set(t, (covered.get(t) ?? 0) + 1);
    }
    // What the parts do not hold has no organisation of its own: listed
    // from the whole organisation, only those rows sent.
    const orgless = big.filter(t => n(t) > parts.reduce((a, p) => a + (sub.get(`${p.key}|${t}`) ?? 0), 0));
    if (orgless.length) {
      const frame = plainFrame();
      const [r] = await ctx.pacer.post('list without organisation', 0, () => runSplit(ctx.client, orgless, (t, c) => buildBucketInventoryEc(bucket, t, frame, { ...opts, orglessOnly: true }, c), ctx.signal, 60_000, placeOf(bucket, opts.ridsOnly ? undefined : opts.since)), ctx.signal);
      if (!r?.ok || r.log == null) throw new Error(r?.error || r?.log || 'The object list failed');
      rows.push(...parseBucketInventoryLog(r.log, frame));
    }
    for (const t of big) if (covered.get(t) === parts.length) listed.add(t);
  }
  return { rows, listed };
}

/** List, diff, read and commit one bucket (first build or full list). */
async function syncBucket(ctx: BuildCtx, bucket: Bucket, types: readonly string[], stage: SyncProgress['stage']): Promise<void> {
  const { stored, store, env, meta, signal } = ctx;
  const alive = () => { signal.throwIfAborted(); };
  const counts = await countBuckets(ctx, [bucket], types);
  const { rows, listed } = await listWithinBudget(ctx, bucket, types, counts);
  alive();
  const names = new Set(rows.map(r => r.rid));
  const removed = [...stored].filter(([rid, s]) => inBucket(bucket, s) && listed.has(s.type) && !names.has(rid)).map(([rid]) => rid);
  const toRead = rows.filter(r => {
    const s = stored.get(r.rid);
    if (s) return s.stamp !== r.stamp || s.type !== r.type || !inBucket(bucket, s);
    return emptyStamp(ctx.empty[r.rid]) !== r.stamp;
  });
  if (removed.length) {
    await store.remove(env, removed);
    for (const rid of removed) stored.delete(rid);
    ctx.counters.removed += removed.length;
    meta.revision = (meta.revision ?? 0) + 1;
  }
  for (const t of types) if (listed.has(t)) (meta.buckets ??= {})[`${bucket.key}|${t}`] = { count: counts.get(`${bucket.key}|${t}`) ?? 0, day: ctx.today };
  await readAndStore(ctx, bucket.root, toRead, stage, bucket.org);
}

/** Read `rows`, fold instances into their stored template, store. */
async function readAndStore(ctx: BuildCtx, root: string, rows: readonly InventoryRow[], stage: SyncProgress['stage'], listedUnder?: string): Promise<void> {
  const { stored, store, env, meta, signal, map, orgs } = ctx;
  const byRid = new Map(rows.map(r => [r.rid, r]));
  meta.pending = rows.length;
  signal.throwIfAborted();
  await store.putMeta(meta);
  ctx.onProgress?.({ phase: 'reading', read: ctx.counters.read, toRead: ctx.counters.read + rows.length, objects: meta.objects, stage });
  const res = await readObjects(ctx.client, rows.map(r => ({ rid: r.rid, type: r.type!, props: map[r.type!] ?? [] })), signal, async (got, failedHere) => {
    const list: IndexedObject[] = [];
    const none: string[] = [];
    for (const [rid, o0] of got) {
      const row = byRid.get(rid);
      if (!row) continue;
      // An object without an organisation of its own (a visualization's
      // data input) is placed under the organisation it was listed in.
      const own = row.org ?? stored.get(rid)?.path?.at(-1) ?? listedUnder;
      const path = root === ORG_ROOT && own ? orgPath(own, orgs) : undefined;
      const tmpl = o0.tmpl ? (await store.get(env, o0.tmpl)) : null;
      const o = foldIntoTemplate(o0, tmpl);
      if (!Object.keys(o.code).length && !o.inherits?.length) { none.push(rid); ctx.empty[rid] = emptyEntry(row.stamp, row.type!, root); continue; }
      delete ctx.empty[rid];
      list.push(toIndexed(env, row.type!, o, row, { root, ...(path?.length ? { path } : {}) }));
    }
    signal.throwIfAborted();
    await store.put(list);
    if (none.some(r => stored.has(r))) await store.remove(env, none.filter(r => stored.has(r)));
    for (const r of none) stored.delete(r);
    for (const o of list) stored.set(o.rid, { type: o.type, stamp: o.stamp, len: o.len, root: o.root, ...(o.path?.length ? { top: o.path[0], path: o.path } : {}), ...(o.tmpl ? { tmpl: o.tmpl } : {}), ...(o.inherits?.length ? { inherits: o.inherits.length } : {}) });
    for (const rid of failedHere.keys()) ctx.counters.failedRids.add(rid);
    ctx.counters.read += got.size;
    meta.pending = Math.max(0, meta.pending - got.size);
    meta.revision = (meta.revision ?? 0) + 1;
    countObjects(stored, meta);
    signal.throwIfAborted();
    await store.putMeta(meta);
    ctx.onProgress?.({ phase: 'reading', read: ctx.counters.read, toRead: ctx.counters.read + meta.pending, objects: meta.objects, stage });
  }, ctx.pacer);
  ctx.counters.bytes += res.bytes;
  ctx.counters.changed += rows.length - res.failed.size;
  ctx.counters.failed += res.failed.size;
}

/** An object listed without code: its stamp, type and root (so the
 *  completeness check can count it). */
const emptyEntry = (stamp: string, type: string, root: string) => `${stamp}\u0001${type}\u0001${root}`;
const emptyStamp = (v: string | undefined) => v?.split('\u0001')[0];

/**
 * Completeness: one count request per root (every code type, one select at
 * a time). The server's count of a type in a root must equal the objects
 * the index holds there, with code or listed without; the difference per
 * type is kept in `meta.incomplete` and named in the status line.
 */
export async function checkCompleteness(
  ctx: Pick<BuildCtx, 'client' | 'pacer' | 'signal' | 'stored' | 'empty' | 'counters'> & { rootRids?: Readonly<Record<string, string>> },
  roots: readonly string[], types: readonly string[],
): Promise<{ missing: Record<string, number>; uncounted: Record<string, string> }> {
  const known = new Map<string, number>();
  for (const s of ctx.stored.values()) if (s.root) known.set(`${s.root}|${s.type}`, (known.get(`${s.root}|${s.type}`) ?? 0) + 1);
  for (const v of Object.values(ctx.empty)) { const [, t, r] = v.split('\u0001'); if (t && r) known.set(`${r}|${t}`, (known.get(`${r}|${t}`) ?? 0) + 1); }
  const missing: Record<string, number> = {};
  const targets = roots.map(root => ({ bucket: rootBucket(root), ...(ctx.rootRids?.[root] ? { rid: ctx.rootRids[root] } : {}) }));
  const { counts, failed } = await countTargets(ctx.client, targets, types, { signal: ctx.signal, post: send => ctx.pacer.post('completeness', 0, send, ctx.signal) });
  for (const [k, n] of counts) {
    const root = k.slice(2, k.indexOf('|'));
    const type = k.slice(k.indexOf('|') + 1);
    const gap = n - (known.get(`${root}|${type}`) ?? 0);
    if (gap > 0) missing[type] = (missing[type] ?? 0) + gap;
  }
  // A root that could not be counted is named, not skipped.
  const uncounted: Record<string, string> = {};
  for (const [key, why] of failed) uncounted[key.slice(2)] = why;
  return { missing, uncounted };
}

/** Instances stored with their own code because their template was read
 *  later: folded now, locally. */
async function foldStored(store: CodeIndexStore, env: string, stored: Map<string, StoredStamp>, signal: AbortSignal): Promise<void> {
  const todo = [...stored].filter(([, s]) => s.tmpl && !s.inherits && stored.has(s.tmpl)).map(([rid]) => rid);
  const out: IndexedObject[] = [];
  for (const rid of todo) {
    const o = await store.get(env, rid);
    const t = o?.tmpl ? await store.get(env, o.tmpl) : null;
    if (!o || !t) continue;
    const f = foldIntoTemplate({ rid, businessId: o.businessId, name: o.name, parent: '', grandparent: '', stamp: o.stamp, code: o.code, tmpl: o.tmpl }, t);
    if (!f.inherits?.length) continue;
    out.push({ ...o, code: f.code, refs: refsOf(f.code), inherits: f.inherits, len: Object.values(f.code).reduce((n, x) => n + x.length, 0) });
    stored.set(rid, { ...stored.get(rid)!, inherits: f.inherits.length });
  }
  signal.throwIfAborted();
  await store.put(out);
}

/**
 * A refresh after the summary found changes: only the changed types are
 * listed, only objects changed since the last list (one list per bucket,
 * paced). A type whose count moved is counted per bucket; buckets whose
 * count differs from the stored one are listed as RIDs to find removals.
 * An instance whose stamp did not change is not read again, even when its
 * template changed: it is treated as inheriting (see foldIntoTemplate).
 */
async function refreshChanged(
  client: IndexClient, store: CodeIndexStore, env: string, prev: CodeIndexMeta, summary: Summary,
  changes: { types: Set<string>; counted: Set<string> },
  o: SyncOptions & { now: () => number; pacer: Pacer; signal: AbortSignal; today: string; stages: StageCost[]; t0: number },
): Promise<SyncResult> {
  const { pacer, signal, now } = o;
  const stored = await store.stamps(env);
  const orgs = new Map(Object.entries(prev.orgs ?? {}));
  const tops = [...orgs].filter(([, g]) => !g.parent).map(([rid]) => rid);
  const buckets: Bucket[] = [...(prev.rootOrder ?? []).filter(k => k !== ORG_ROOT).map(rootBucket), ...(prev.rootOrder?.includes(ORG_ROOT) ? tops.map(t => orgBucket(t)) : [])];
  const meta: CodeIndexMeta = { ...prev, buckets: { ...(prev.buckets ?? {}) }, empty: { ...(prev.empty ?? {}) }, roots: JSON.parse(JSON.stringify(prev.roots ?? {})) as Record<string, RootCoverage> };
  const ctx: BuildCtx = { client, store, env, signal, pacer, map: prev.codeProps ?? KNOWN_CODE_PROPS, orgs, stored, meta, empty: meta.empty!, today: o.today, onProgress: o.onProgress, listRows: o.listRows ?? BUDGET.listRows, counters: { read: 0, changed: 0, removed: 0, failed: 0, bytes: 0, failedRids: new Set() } };
  const t1 = now();
  const p1 = pacer.log.length;
  const types = [...changes.types].filter(t => ctx.map[t]);
  // The day of the oldest list of these types: objects changed since then.
  const days = buckets.flatMap(b => types.map(t => meta.buckets?.[`${b.key}|${t}`]?.day ?? prev.summaryDay ?? o.today));
  const since = sinceDay(Date.parse(`${[...days].sort()[0] ?? o.today}T00:00:00Z`));
  for (const b of buckets) {
    // Changed objects only: few rows; the count budget does not apply.
    const frame = plainFrame();
    const [r] = await pacer.post('list changed', 0, () => runSplit(client, types, (t, c) => buildBucketInventoryEc(b, t, frame, { since }, c), signal, 60_000, placeOf(b, since)), signal);
    if (!r?.ok || r.log == null) throw new Error(r?.error || r?.log || 'The list of changed objects failed');
    const rows = parseBucketInventoryLog(r.log, frame).filter(row => {
      const s = stored.get(row.rid);
      return s ? s.stamp !== row.stamp : emptyStamp(meta.empty?.[row.rid]) !== row.stamp;
    });
    if (rows.length) await readAndStore(ctx, b.root, rows, b.org ? 'organisation' : 'roots', b.org);
    // These types are listed up to today in this bucket.
    for (const t of types) { const k = `${b.key}|${t}`; if (meta.buckets![k]) meta.buckets![k] = { ...meta.buckets![k], day: o.today }; }
  }
  // Removal: a moved count is counted per bucket; differing buckets are
  // listed as RIDs.
  const counted = [...changes.counted].filter(t => ctx.map[t]);
  if (counted.length) {
    const counts = await countBuckets(ctx, buckets, counted);
    for (const b of buckets) {
      const differ = counted.filter(t => counts.get(`${b.key}|${t}`) !== meta.buckets?.[`${b.key}|${t}`]?.count);
      if (!differ.length) continue;
      const { rows, listed } = await listWithinBudget(ctx, b, differ, counts, { ridsOnly: true });
      const names = new Set(rows.map(r => r.rid));
      const removed = [...stored].filter(([rid, s]) => inBucket(b, s) && listed.has(s.type) && !names.has(rid)).map(([rid]) => rid);
      if (removed.length) {
        signal.throwIfAborted();
        await store.remove(env, removed);
        for (const r of removed) stored.delete(r);
        ctx.counters.removed += removed.length;
      }
      for (const t of differ) if (listed.has(t)) meta.buckets![`${b.key}|${t}`] = { count: counts.get(`${b.key}|${t}`) ?? 0, day: o.today };
    }
  }
  countObjects(stored, meta);
  o.stages.push({ stage: 'changes', posts: pacer.log.length - p1, ms: now() - t1, read: ctx.counters.read });
  const at = now();
  meta.summary = summary;
  meta.summaryDay = prev.summaryDay ?? o.today;
  meta.pending = ctx.counters.failedRids.size;
  meta.failed = ctx.counters.failedRids.size;
  meta.syncedAt = at;
  meta.revision = (meta.revision ?? 0) + 1;
  signal.throwIfAborted();
  await store.putMeta(meta);
  o.onProgress?.({ phase: 'done', read: ctx.counters.read, toRead: ctx.counters.read, objects: meta.objects });
  return {
    meta, first: false, changed: ctx.counters.changed, removed: ctx.counters.removed, failed: ctx.counters.failed, bytes: ctx.counters.bytes,
    posts: pacer.log.length, ms: at - o.t0, stages: o.stages, requests: pacer.log,
  };
}

export async function readRootList(client: IndexClient, roots: readonly string[], signal: AbortSignal, pacer: Pacer): Promise<RootList> {
  const frame = plainFrame();
  const [r] = await pacer.post('roots', 0, () => client.executeEcBatch([buildRootListEc(roots, frame)], signal, 60_000), signal);
  if (r?.ok && r.log != null) {
    try { return parseRootListLog(r.log, frame); } catch { /* asked one by one below */ }
  }
  if (r?.errorKind && r.errorKind !== 'server') throw new Error(r.error || 'The roots could not be listed');
  // A root this server does not have fails the script: one root a post.
  const out: RootList = { roots: new Map(), rootRids: new Map(), orgs: new Map() };
  for (const k of roots) {
    const f = plainFrame();
    const [x] = await pacer.post('roots', 0, () => client.executeEcBatch([buildRootListEc([k], f)], signal, 60_000), signal);
    if (!x?.ok || x.log == null) continue;
    try {
      const p = parseRootListLog(x.log, f);
      for (const [a, v] of p.roots) out.roots.set(a, v);
      for (const [a, v] of p.rootRids ?? []) out.rootRids!.set(a, v);
      for (const [a, v] of p.orgs) out.orgs.set(a, v);
    } catch { /* that root is left out */ }
  }
  return out;
}

/** Re-read objects the extension just saved (no list). Objects that are
 *  not in the index and have no known type are left to the next sync. */
export async function refreshIndexedObjects(
  client: IndexClient, store: CodeIndexStore, env: string, rids: readonly string[], signal: AbortSignal,
  types: Readonly<Record<string, string>> = {},
): Promise<number> {
  const meta = await store.getMeta(env);
  const map: CodePropMap = meta?.codeProps ?? STATIC_CODE_PROPS;
  const items: Array<{ rid: string; type: string; props: readonly string[]; cur: IndexedObject | null }> = [];
  for (const rid of rids) {
    const cur = await store.get(env, rid);
    const type = cur?.type ?? types[rid];
    if (type && map[type]) items.push({ rid, type, props: map[type], cur });
  }
  if (!items.length) return 0;
  let n = 0;
  await readObjects(client, items, backgroundSignal({ signal }), async got => {
    const list: IndexedObject[] = [];
    for (const it of items) {
      const o0 = got.get(it.rid);
      if (!o0) continue;
      const o = foldIntoTemplate(o0, o0.tmpl ? await store.get(env, o0.tmpl) : null);
      const obj = toIndexed(env, it.type, o, undefined, { root: it.cur?.root, path: it.cur?.path });
      if (Object.keys(obj.code).length || obj.inherits?.length) list.push(obj); else await store.remove(env, [it.rid]);
    }
    signal.throwIfAborted();
    await store.put(list);
    n += list.length;
  });
  if (n && meta) await store.putMeta({ ...meta, revision: (meta.revision ?? 0) + 1 });
  return n;
}
