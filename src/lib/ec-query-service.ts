/**
 * EC-query service — the "build EC string → run it → parse rows" family,
 * extracted from bmp-client.ts (plan 021). BmpClient owns transport / auth /
 * identity cache / binary commands / health probing and forwards to this
 * service for everything that's a pure EC round trip.
 *
 * Constructor deps are two BmpClient methods (bound dynamically, so tests
 * that monkey-patch `client.executeEc` / `client.resolveRef` after
 * construction still keep working) plus the PANE_PROPS allowlist. No
 * back-reference to BmpClient itself — see plan 021 for the coupling analysis.
 *
 * New EC queries go here; new binary commands stay in bmp-client.ts.
 */

import type {
  EcResult, TemplateResolution, EditorContextData,
} from './bmp-client';
import { log } from './logger';
import {
  BATCH_CHUNK_SIZE,
  COLOR_SETS_EC_TIMEOUT,
  LAYOUT_TREE_EC_TIMEOUT,
  OBJECT_RELATION_EC_TIMEOUT,
} from './constants';
import { appendBlockEc, appendRowEc, CONTEXT_OBJECT, contextObjectEc, createEcFrame, EC_CHUNK, EC_DONE_LITERAL, isCompleteFramedLog, objectLoopEc, parseFramedLog, parseSepBlocks, parseSepMultiObject, splitFramedRows, stableRidOrder, STATIC_EC_FRAME, type EcFrame } from './ec-parser';
import { BmpRequestError, ecResultError, type BmpErrorKind } from './error-kind';
import { buildRowEc } from './ec-row-codec';
import { validateEcIdentifier, validateRid } from './ec-guards';
import { constantScript, scriptOn, varyingScript } from './script-kinds';
import { isCodeProperty } from './ec-code-safety';
import { ecResolveTemplate } from './template-link';
import { LAYOUT_SEP, parseLayoutNodes, safeWireTextEc } from './layout-wire';
import type {
  ColorSetData, ObjectPaneCard, ObjectPaneIdentity, AccessSubject, LayoutNode,
  EditFieldPropertyResolution, PropertyApplication, ObjectPanePayload, ObjectPaneSiblingMsg,
} from './types';
import {
  buildObjectPaneEc, buildPropertyApplicationsEc,
  buildEditFieldPropertyEc, buildEditFieldTypesEc,
  PROPERTY_APPLICATION_MARK,
  PROPERTY_APPLICATION_FIELD, PROPERTY_APPLICATION_END, PROPERTY_APPLICATION_ERROR,
  PROPERTY_APPLICATION_TOTAL,
} from './ec-codegen';
import {
  ALL_CODE_FIELDS, ALL_REFERENCE_FIELDS,
  ALL_INDIRECT_FIELDS, ALL_CONTEXT_FIELDS, ALL_ENABLED_BY_PROPS,
} from './widget-metadata';
import { isMasterPropertyDefinition } from './property-config';

/** One exact property requested by a bounded caller. Reference properties get
 * identity metadata in the same EC round trip instead of being stringified. */
export interface SelectedPropertyRequest {
  accessor: string;
  reference: boolean;
}

export interface SelectedPropertyValue {
  accessor: string;
  state: 'value' | 'missing';
  value: string;
  reference?: ObjectPaneIdentity;
}

/** Parse a `<prefix>Rid/Id/Name/Type` identity block out of a parseSepBlocks
 *  map. Returns null when the rid is absent/`MISSING`. Shared by
 *  fetchEditorContext (inst/tmpl) and fetchObjectPane (inst/par/tmpl/card) so
 *  the blocks can't drift apart. */
function parseIdentityBlock(data: Record<string, string | undefined>, prefix: string): ObjectPaneIdentity | null {
  const rid = data[`${prefix}Rid`];
  if (!rid || rid === 'MISSING') return null;
  return {
    rid,
    businessId: data[`${prefix}Id`] ?? '',
    type: data[`${prefix}Type`] ?? '',
    name: data[`${prefix}Name`] ?? '',
  };
}

export function parseEditFieldPropertyLog(log: string): EditFieldPropertyResolution | null {
  let data: Record<string, string>;
  try { data = parseSepBlocks(log); } catch { return null; }
  const accessor = data.accessor?.trim();
  const property = parseIdentityBlock(data, 'property');
  if (!accessor || !property) return null;
  return { accessor, property };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Parse one application.genedit() delta. The EC can contain nested lists,
 * calls, and commas inside quoted strings, so assignments split only at
 * top-level commas. */
function parseGeneditDelta(genedit: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const body of extractCallBodies(genedit, '.change(')) {
    for (const assignment of splitTopLevelAssignments(body)) {
      const at = assignment.indexOf(':=');
      if (at < 0) continue;
      const field = assignment.slice(0, at).trim();
      if (!field || field === 'id' || field === '__links') continue;
      overrides[field] = assignment.slice(at + 2).trim();
    }
  }
  return overrides;
}

function extractCallBodies(text: string, marker: string): string[] {
  const bodies: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf(marker, pos);
    if (start < 0) break;
    const bodyStart = start + marker.length;
    let depth = 1;
    let inQuote = false;
    let quote = '';
    let i = bodyStart;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (inQuote) {
        if (ch === '\\' && i + 1 < text.length) i++;
        else if (ch === quote) inQuote = false;
      } else if (ch === "'" || ch === '"') {
        inQuote = true;
        quote = ch;
      } else if (ch === '(' || ch === '[') {
        depth++;
      } else if (ch === ')' || ch === ']') {
        depth--;
      }
      i++;
    }
    if (depth === 0) bodies.push(text.slice(bodyStart, i - 1));
    pos = i;
  }
  return bodies;
}

function splitTopLevelAssignments(body: string): string[] {
  const assignments: string[] = [];
  let current = '';
  let depth = 0;
  let inQuote = false;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuote) {
      current += ch;
      if (ch === '\\' && i + 1 < body.length) current += body[++i];
      else if (ch === quote) inQuote = false;
    } else if (ch === "'" || ch === '"') {
      inQuote = true;
      quote = ch;
      current += ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      if (depth > 0) depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      if (current.trim()) assignments.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) assignments.push(current.trim());
  return assignments;
}

export function parsePropertyApplicationsLog(log: string): PropertyApplication[] | null {
  if (log.includes(PROPERTY_APPLICATION_ERROR)) return null;
  const end = log.indexOf(PROPERTY_APPLICATION_END);
  if (end < 0) return null;
  const applications: PropertyApplication[] = [];
  for (const record of log.slice(0, end).split(PROPERTY_APPLICATION_MARK).slice(1)) {
    const fields = record.split(PROPERTY_APPLICATION_FIELD);
    if (fields.length < 5) return null;
    const [classFqn, rid, businessId, type, ...geneditParts] = fields;
    if (!classFqn || !rid || rid === 'MISSING' || !businessId) return null;
    const classId = classFqn.trim().slice(classFqn.trim().lastIndexOf('.') + 1);
    if (!classId) return null;
    applications.push({
      classId,
      application: {
        rid: rid.trim(),
        businessId: businessId.trim(),
        name: '',
        type: type.trim(),
      },
      overrides: parseGeneditDelta(geneditParts.join(PROPERTY_APPLICATION_FIELD)),
    });
  }
  return applications;
}

export function parsePropertyApplicationsResult(log: string): {
  applications: PropertyApplication[];
  total: number;
  truncated: boolean;
} | null {
  const applications = parsePropertyApplicationsLog(log);
  if (!applications) return null;
  const totalMatch = log.match(new RegExp(`${PROPERTY_APPLICATION_TOTAL}(\\d+)`));
  const parsedTotal = totalMatch ? Number(totalMatch[1]) : applications.length;
  const total = Number.isFinite(parsedTotal) && parsedTotal >= applications.length
    ? parsedTotal
    : applications.length;
  return { applications, total, truncated: total > applications.length };
}

/** Build the EC for `listAccessSubjects`: every user then every role, each as
 *  a `kind|||rid|||id|||name` row. Exported so a golden test can lock the
 *  exact EC string in. */
export function buildAccessSubjectsEc(_frame: EcFrame = STATIC_EC_FRAME): string {
  return constantScript('buildAccessSubjectsEc', [
    // One row per object, joined once: a server can hold many thousands of users, and appending
    // every row to one growing text copies that text per row (see ec-parser.ts).
    '_us := root.user.descendants.filter(className = "User").calculate(',
    '     _u := self',
    '     _row := ""',
    ...appendRowEc('_row', ['"user"', '_u.rid', '_u.id.whenMissing("")', '_u.name.whenMissing("")'], '     '),
    '     _row',
    ')',
    '_rs := root.role.descendants.filter(className = "Role").calculate(',
    '     _r := self',
    '     _row := ""',
    ...appendRowEc('_row', ['"role"', '_r.rid', '_r.id.whenMissing("")', '_r.name.whenMissing("")'], '     '),
    '     _row',
    ')',
    `_us.join("") + _rs.join("") + ${EC_DONE_LITERAL}`,
  ].join('\n'));
}

/** Parse the `buildAccessSubjectsEc` output into sorted access subjects.
 *  Throws when the completion marker is missing (cut-off answer). */
export function parseAccessSubjectsLog(ecLog: string, frame: EcFrame = STATIC_EC_FRAME): AccessSubject[] {
  const subjects: AccessSubject[] = [];
  for (const [kind, ridRaw, idRaw, name] of parseFramedLog(ecLog, frame, 4)) {
    const rid = ridRaw.trim();
    const id = idRaw.trim();
    if ((kind !== 'user' && kind !== 'role') || !rid || rid === 'MISSING') continue;
    subjects.push({
      rid,
      name: name.trim() || id || rid,
      kind,
      businessId: id || undefined,
    });
  }
  return subjects.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse `resolveTemplate`'s `rid|||name|||className|||id` output line
 *  (skipping BMP's "Result : 0" / "Duration" log noise) into a
 *  TemplateResolution. Exported so a golden test can lock the exact
 *  field order + MISSING-sentinel handling in. */
export function parseResolveTemplateLog(ecLog: string, frame: EcFrame = STATIC_EC_FRAME): TemplateResolution {
  const [row] = parseFramedLog(ecLog, frame, 4);
  const tRid = row?.[0]?.trim();
  if (!tRid || tRid === 'MISSING') return { templateRid: null };
  return {
    templateRid: tRid,
    templateName: row[1] || undefined,
    templateType: row[2].trim() || undefined,
    templateBusinessId: row[3].trim() || undefined,
  };
}

/** Build the EC for `fetchLayoutTree`. Emits the shared layout wire format
 *  (see layout-wire.ts): one node per LAYOUT_SEP marker, fields
 *  rid|bid|type|parentRid|containerRid|L|M|S|chartHeight|name. `name` is
 *  LAST (free-text, parsed as the rest) so a `|` in a name can't shift the
 *  structural fields. Exported so a golden test can lock the exact EC
 *  string in. */
export function buildLayoutTreeEc(ref: string): string {
  const nodeRow = buildRowEc([
    { name: 'rid', expr: '_n.rid' },
    { name: 'id', expr: '_n.id.whenMissing("")' },
    { name: 'className', expr: '_type' },
    { name: 'parentRid', expr: '_p.rid.whenMissing("")' },
    { name: 'containerRid', expr: '""' },
    { name: 'L', expr: '_n.columnsLargeScreen.whenMissing("")' },
    { name: 'M', expr: '_n.columnsMediumScreen.whenMissing("")' },
    { name: 'S', expr: '_n.columnsSmallScreen.whenMissing("")' },
    { name: 'chartHeight', expr: '""' },
    { name: 'name', expr: safeWireTextEc('_n.name.whenMissing("")') },
  ], '|');
  // Root row: same 10-field shape, but the root has no parent/container/
  // chartHeight of its own — those three columns are literal empties.
  const rootRow = buildRowEc([
    { name: 'rid', expr: '_root.rid' },
    { name: 'id', expr: '_root.id.whenMissing("")' },
    { name: 'className', expr: '_root.className.whenMissing("")' },
    { name: 'parentRid', expr: '""' },
    { name: 'containerRid', expr: '""' },
    { name: 'L', expr: '_root.columnsLargeScreen.whenMissing("")' },
    { name: 'M', expr: '_root.columnsMediumScreen.whenMissing("")' },
    { name: 'S', expr: '_root.columnsSmallScreen.whenMissing("")' },
    { name: 'chartHeight', expr: '""' },
    { name: 'name', expr: safeWireTextEc('_root.name.whenMissing("")') },
  ], '|');
  return scriptOn('buildLayoutTreeEc', ref, [
    `_root := ${ref}`,
    '_r := ""',
    '_chunk := ""',
    '_i := 0',
    '_emitted := 0',
    '_limitHit := "0"',
    '_root.descendants().forEach(_n:',
    '     _line := ""',
    '     _type := _n.className.whenMissing("")',
    '     _structural := "0"',
    '     IF _type = "TabSet" THEN _structural := "1" ELSE _structural := _structural ENDIF',
    '     IF _type = "Tab" THEN _structural := "1" ELSE _structural := _structural ENDIF',
    '     IF _type = "Container" THEN _structural := "1" ELSE _structural := _structural ENDIF',
    '     IF _structural = "1" THEN',
    '          IF _emitted < 600 THEN',
    '               _p := _n.parent',
    `               _line := "${LAYOUT_SEP}" + ${nodeRow} + "\\n"`,
    '               _emitted := _emitted + 1',
    '          ELSE',
    '               _limitHit := "1"',
    '          ENDIF',
    '     ELSE',
    '          _line := _line',
    '     ENDIF',
    '     _chunk := _chunk + _line',
    '     IF _line <> "" THEN _i := _i + 1 ELSE _i := _i ENDIF',
    '     IF _i > 31 THEN',
    '          _r := _r + _chunk',
    '          _chunk := ""',
    '          _i := 0',
    '     ELSE',
    '          _r := _r',
    '     ENDIF',
    ')',
    '_r := _r + _chunk',
    `_r := _r + "${LAYOUT_SEP}" + ${rootRow} + "\\n"`,
    'IF _limitHit = "1" THEN _r := _r + "<<<CREV_LAYOUT_TREE_LIMIT>>>600\\n" ELSE _r := _r ENDIF',
    '_r',
  ].join('\n'));
}

/** Parse `java.awt.Color[r=219,g=132,b=61]` → `rgb(219,132,61)`, else ''. */
export function parseAwtColor(s: string): string {
  const m = /r=(\d+),\s*g=(\d+),\s*b=(\d+)/.exec(s);
  return m ? `rgb(${m[1]},${m[2]},${m[3]})` : '';
}

// Compact control-character wire. PRO Demo has 633 colors: repeating the old
// 14-byte marker between every field made EC string accumulation cross the
// 10-second timeout. U+0001/U+0002 are already established in this repo as
// collision-free delimiters for arbitrary BMP text.
export const COLOR_FIELD = '\u0001';
export const COLOR_ROW = '\u0002';

/** Flat color projection. The parent carries the set and the grandparent its
 * category/folder. A final count marker makes a partial response distinct
 * from an authoritative empty workspace. */
export function buildColorSetsEc(): string {
  return constantScript('buildColorSetsEc', [
    '_colors := SELECT CorpoColor FROM root.portal',
    '_r := ""',
    '_count := 0',
    '_colors.forEach(_col:',
    '     _cv := _col.color',
    '     IF _cv != MISSING THEN',
    '          _set := _col.parent',
    '          _folder := _set.parent',
    // In parentheses: the result text is copied once per colour, not once per field.
    `          _r := _r + ("R${COLOR_FIELD}" + _set.id.whenMissing("") + "${COLOR_FIELD}" + _set.name.whenMissing("") + "${COLOR_FIELD}" + _folder.id.whenMissing("") + "${COLOR_FIELD}" + _col.id.whenMissing("") + "${COLOR_FIELD}" + _col.name.whenMissing("") + "${COLOR_FIELD}" + _cv + "${COLOR_ROW}")`,
    '          _count := _count + 1',
    '     ELSE',
    '          _r := _r',
    '     ENDIF',
    ')',
    `_r := _r + "D${COLOR_FIELD}" + _count + "${COLOR_ROW}"`,
    '_r',
  ].join('\n'));
}

/** Group the flat colour rows back into the picker shape, preserving server
 * order for both folders and swatches. Malformed/non-colour rows are ignored. */
export function parseColorSetsLog(log: string): ColorSetData[] {
  const sets: ColorSetData[] = [];
  const byId = new Map<string, ColorSetData>();
  let expectedCount: number | null = null;
  let parsedCount = 0;
  for (const wireRow of log.split(COLOR_ROW)) {
    const parts = wireRow.split(COLOR_FIELD);
    const marker = (parts[0] ?? '').trim();
    if (marker === 'D') {
      const count = Number((parts[1] ?? '').trim());
      if (Number.isInteger(count) && count >= 0) expectedCount = count;
      continue;
    }
    if (marker !== 'R') continue;
    const setId = (parts[1] ?? '').trim();
    const setName = (parts[2] ?? '').trim();
    const folder = (parts[3] ?? '').trim();
    const bid = (parts[4] ?? '').trim();
    const name = (parts[5] ?? '').trim();
    const rgb = parseAwtColor(parts[6] ?? '');
    if (!setId || !bid || !rgb) continue;
    parsedCount += 1;
    let set = byId.get(setId);
    if (!set) {
      set = { id: setId, name: setName, colors: [], ...(folder ? { folder } : {}) };
      byId.set(setId, set);
      sets.push(set);
    }
    set.colors.push({ bid, name, rgb });
  }
  if (expectedCount === null) throw new Error('Incomplete colour answer: the answer was cut off');
  if (parsedCount !== expectedCount) {
    throw new Error(`Incomplete color response: expected ${expectedCount} rows, parsed ${parsedCount}`);
  }
  const custom = (set: ColorSetData): number => (set.folder && set.folder !== 'ColorRoot' ? 0 : 1);
  return sets.sort((a, b) => custom(a) - custom(b));
}

/** Objects per chunk of a growing EC result (see ec-parser appendEc);
 *  measured on BMP 5.6.17. */
const BADGE_ROWS_PER_CHUNK = 8;
const CODE_ROWS_PER_CHUNK = 4;

/** Sorted, validated property names: one order for one question. `_o.<p>`
 *  is a bare identifier slot, so each must be a valid EC identifier. */
function sortedProps(properties: readonly string[]): string[] {
  const out = [...new Set(properties)].sort();
  out.forEach(validateEcIdentifier);
  return out;
}

/** Code properties of one object as `[property, text]` rows. Code is read
 *  only inside `output(…)` (ec-code-safety). */
export function buildCodeReadEc(ref: string, properties: readonly string[]): string {
  const lines = [`_o := ${ref}`, '_r := ""'];
  for (const prop of sortedProps(properties)) lines.push(...appendBlockEc('_r', prop, `output(_o.${prop}.whenMissing(""))`));
  lines.push(`_r + ${EC_DONE_LITERAL}`);
  return scriptOn('buildCodeReadEc', ref, lines.join('\n'));
}

/** Code properties of several objects: an `OBJ` row, then `[property,
 *  text]` rows per object, in one loop over the list (ec-parser
 *  objectLoopEc). Code bodies are long, so the chunk joins the result every
 *  few objects. */
export function buildBatchCodeReadEc(refs: readonly string[], properties: readonly string[]): string {
  const body = appendBlockEc(EC_CHUNK, 'OBJ', '_o.rid.whenMissing("SKIP")');
  for (const prop of sortedProps(properties)) body.push(...appendBlockEc(EC_CHUNK, prop, `output(_o.${prop}.whenMissing(""))`));
  return varyingScript('buildBatchCodeReadEc', objectLoopEc(refs, '_o', body, CODE_ROWS_PER_CHUNK).join('\n'));
}

/** Code properties of the context object as `[OBJ, rid]` then `[property,
 *  text]` rows: one constant script per property set (executeEcEach). */
export function buildContextCodeReadEc(properties: readonly string[]): string {
  const body = appendBlockEc(EC_CHUNK, 'OBJ', '_o.rid.whenMissing("SKIP")');
  for (const prop of sortedProps(properties)) body.push(...appendBlockEc(EC_CHUNK, prop, `output(_o.${prop}.whenMissing(""))`));
  return constantScript('buildContextCodeReadEc', contextObjectEc('_o', body).join('\n'));
}

/** The body of one badge row for `_o` (shared by the context script and
 *  the loop fallback). */
function enrichBody(): string[] {
  return [
    ...ecResolveTemplate('_o', '_t'),
    '_tid := (IF _t != MISSING THEN _t.id.whenMissing("") ELSE "" ENDIF)',
    // Cascade target — for flow-bearing widgets we surface the next link in
    // the chain so the badge can render a second pill. Non-flow types skip
    // the body via className guards (cheap when not matched).
    '_cls := _o.className',
    '_cRid := ""',
    '_cBid := ""',
    '_cType := ""',
    '_cName := ""',
    'IF _cls = "InputView" THEN',
    '  _cRid := output(_o.inputSet.rid.whenMissing(""))',
    '  _cBid := _o.inputSet.id.whenMissing("")',
    '  _cType := _o.inputSet.className.whenMissing("")',
    '  _cName := _o.inputSet.name.whenMissing("")',
    'ENDIF',
    // A create object view points at the edit page it opens.
    'IF _cls = "CreateObjectView" THEN',
    '  _cRid := output(_o.editPage.rid.whenMissing(""))',
    '  _cBid := _o.editPage.id.whenMissing("")',
    '  _cType := _o.editPage.className.whenMissing("")',
    '  _cName := _o.editPage.name.whenMissing("")',
    'ENDIF',
    'IF _cls = "ActionButton" THEN',
    '  _cRid := output(_o.actionObject.rid.whenMissing(""))',
    '  _cBid := _o.actionObject.id.whenMissing("")',
    '  _cType := _o.actionObject.className.whenMissing("")',
    '  _cName := _o.actionObject.name.whenMissing("")',
    'ENDIF',
    ...appendRowEc(EC_CHUNK, [
      '_o.rid', '_o.id.whenMissing("")', '_cls.whenMissing("")', '_o.name.whenMissing("")',
      '_tid', '_cRid', '_cBid', '_cType', '_cName',
    ]),
  ];
}

/** Badge identity of the context object: ONE constant script for every
 *  object (executeEcEach). Row fields as buildBatchEnrichEc. */
export function buildContextEnrichEc(): string {
  return constantScript('buildContextEnrichEc', contextObjectEc('_o', enrichBody()).join('\n'));
}

/** Badge identity of several objects: one loop over the list (ec-parser
 *  objectLoopEc), so the script changes only in its list line. Row fields:
 *  rid, id, type, name, template id, then the cascade target (rid, id,
 *  type, name) of a flow-bearing widget. */
export function buildBatchEnrichEc(refs: readonly string[]): string {
  return varyingScript('buildBatchEnrichEc', objectLoopEc(refs, '_o', enrichBody(), BADGE_ROWS_PER_CHUNK).join('\n'));
}

/** One constant script on the context object (`this.object`) of one
 *  command (BmpClient.executeEcOn). */
export type ExecuteEcOn = (code: string, objectRid: string, signal?: AbortSignal, timeoutMs?: number, feature?: import('./bmp-transport').BmpTransportMetrics['feature']) => Promise<EcResult>;
/** One constant script for each of several objects (BmpClient.executeEcEach). */
export type ExecuteEcEach = (code: string, objectRids: readonly string[], signal?: AbortSignal, timeoutMs?: number, feature?: import('./bmp-transport').BmpTransportMetrics['feature']) => Promise<Map<string, EcResult>>;

export class EcQueryService {
  constructor(
    /** BmpClient.executeEc, called dynamically (not `.bind()`-captured) so
     *  tests that monkey-patch `client.executeEc` after construction still
     *  intercept calls made through this service. */
    private readonly executeEc: (
      code: string,
      objectRid?: string,
      transactional?: boolean,
      signal?: AbortSignal,
      timeoutMs?: number,
      feature?: import('./bmp-transport').BmpTransportMetrics['feature'],
    ) => Promise<EcResult>,
    /** BmpClient.resolveRef, same dynamic-dispatch rationale. */
    _resolveRef: (rid: string, signal?: AbortSignal) => Promise<string>,
    /** BmpClient.PANE_PROPS — passed by value so this file doesn't need to
     *  import a runtime value back out of bmp-client.ts. */
    private readonly paneProps: readonly string[],
    /** BmpClient.resolveRefs. Unused since the readers take their object as
     *  the command's context; kept so callers need not change. */
    _resolveRefs?: (rids: readonly string[], signal?: AbortSignal) => Promise<Map<string, string | Error>>,
    /** BmpClient.executeEcOn / executeEcEach: constant scripts, the object as
     *  the command's context. Default: executeEc with the object RID (tests,
     *  services without a client), one call per object. */
    context?: { on: ExecuteEcOn; each: ExecuteEcEach },
  ) {
    this.on = context?.on ?? ((code, rid, signal, timeoutMs, feature) => this.executeEc(code, rid, false, signal, timeoutMs, feature));
    this.each = context?.each ?? (async (code, rids, signal, timeoutMs, feature) => {
      const out = new Map<string, EcResult>();
      for (const rid of new Set(rids)) out.set(rid, await this.on(code, rid, signal, timeoutMs, feature));
      return out;
    });
  }

  private readonly on: ExecuteEcOn;
  private readonly each: ExecuteEcEach;

  // ── Access-trace subject listing ─────────────────────────────

  /** List users + roles (the possible trace subjects) via EC, sorted by name. */
  async listAccessSubjects(): Promise<AccessSubject[]> {
    const frame = createEcFrame();
    const result = await this.executeEc(buildAccessSubjectsEc(frame));
    if (!result.ok || result.hasError || result.hasWarning) throw ecResultError(result, 'Cannot load users and roles for access testing.');
    return parseAccessSubjectsLog(result.log ?? '', frame);
  }

  // ── Template / enrichment ─────────────────────────────────────

  /** Resolve template for a linked instance (pure EC) */
  async resolveTemplate(rid: string): Promise<TemplateResolution> {
    validateRid(rid);
    const frame = createEcFrame();
    // Constant script: the object is the command's context.
    const code = [
      `_o := ${CONTEXT_OBJECT}`,
      ...ecResolveTemplate('_o', '_t'),
      '_r := ""',
      ...appendRowEc('_r', ['_t.rid.whenMissing("MISSING")', '_t.name.whenMissing("")', '_t.className.whenMissing("")', '_t.id.whenMissing("")']),
      `_r + ${EC_DONE_LITERAL}`,
    ].join('\n');
    const ecResult = await this.on(constantScript('EcQueryService.resolveTemplate', code), rid, undefined, OBJECT_RELATION_EC_TIMEOUT);
    if (!ecResult.ok) throw ecResultError(ecResult, 'Template resolution failed');
    if (ecResult.hasWarning) throw new BmpRequestError(ecResult.error || 'Template resolution returned warnings and may be incomplete', 'server');
    if (ecResult.log == null || ecResult.log.trim() === '') throw new BmpRequestError('Empty template-resolution response', 'protocol');
    return parseResolveTemplateLog(ecResult.log, frame);
  }

  /** Batch enrich: get businessId, type, name, templateBusinessId for multiple RIDs.
   *  Version-aware: uses resolveRef() which returns lookup(rid) on 5.6.3+ or
   *  namespace refs (t.{bid}) on pre-5.6.3. Works on all BMP versions. */
  async batchEnrich(rids: string[], signal?: AbortSignal): Promise<{ results: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } }>; error?: string; errorKind?: BmpErrorKind }> {
    let valid = rids.filter(Boolean).filter(rid => /^-?\d+$/.test(rid));
    if (valid.length === 0) return { results: {} };
    if (valid.length > BATCH_CHUNK_SIZE) valid = valid.slice(0, BATCH_CHUNK_SIZE);

    // One constant script for every object; each object is its command's
    // context, so the server parses the script once (executeEcEach). No
    // reference resolution is needed on any server version.
    const ordered = stableRidOrder(valid);
    const frame = createEcFrame();
    const answers = await this.each(buildContextEnrichEc(), ordered, signal);
    signal?.throwIfAborted();
    const rows: string[][] = [];
    const errors = new Set<string>();
    let errorKind: BmpErrorKind | undefined;
    for (const rid of ordered) {
      const result = answers.get(rid);
      if (!result?.ok || result.log == null) {
        errors.add(result?.error || result?.log || 'EC execution failed');
        errorKind ??= result?.errorKind ?? 'server';
        continue;
      }
      try {
        // Without the completion marker the log was cut off: an error the
        // enrichment retry acts on, never "no results".
        rows.push(...parseFramedLog(result.log, frame, 9));
      } catch (e) {
        errors.add(e instanceof Error ? e.message : String(e));
        errorKind ??= 'protocol';
      }
    }
    if (rows.length === 0 && errors.size > 0) {
      const error = [...errors].slice(0, 3).join('; ');
      log.debug('batchEnrich', `EC failed for ${ordered.length} RIDs:`, error);
      return { results: {}, error, errorKind: errorKind ?? 'server' };
    }

    const out: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } }> = {};
    for (const parts of rows) {
      // Fields: rid, bid, type, name, tbid, chainRid, chainBid, chainType, chainName.
      // Identifiers are trimmed; names are kept exactly as stored.
      const rid = parts[0].trim();
      if (!rid) continue;
      const bid = parts[1].trim() || undefined;
      const typ = parts[2].trim() || undefined;
      const name = parts[3] || undefined;
      const tbid = parts[4].trim() || undefined;
      const cRid = parts[5].trim();
      const cBid = parts[6].trim() || undefined;
      const cType = parts[7].trim() || undefined;
      const cName = parts[8] || undefined;
      const entry: { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } } = {
        businessId: bid, type: typ, name, templateBusinessId: tbid,
      };
      // Only attach cascade if we got a real rid back. For non-flow widgets
      // (Scorecard, KPI, etc.) the IF guards left these blank.
      if (cRid) entry.cascade = { rid: cRid, businessId: cBid, type: cType, name: cName };
      out[rid] = entry;
    }
    const missed = ordered.filter(rid => !(rid in out));
    if (missed.length > 0) log.debug('batchEnrich', `${missed.length}/${ordered.length} RIDs not resolved in EC:`, missed);
    return { results: out };
  }

  // ── Code / children / editor-context fetches ─────────────────

  /** Fetch code properties via EC. Throws when the read failed or was cut
   *  off: an empty map would read as "this object has no code", and a save
   *  made from that state would overwrite the real code with nothing. */
  async fetchCodeViaEc(rid: string, properties: string[]): Promise<Record<string, string>> {
    if (properties.length === 0) return {};
    validateRid(rid);
    const result = await this.on(buildCodeReadEc(CONTEXT_OBJECT, properties), rid);
    if (!result.ok) throw ecResultError(result, 'Code read failed');
    if (!isCompleteFramedLog(result.log)) {
      throw new BmpRequestError('Code read returned an incomplete result (the answer was cut off)', 'protocol');
    }
    return parseSepBlocks(result.log!);
  }

  /** Read a small exact property selection with explicit missing-state and,
   * for reference properties, stable identity. This is deliberately separate
   * from fetchCodeViaEc: code reads preserve raw source, while this method
   * produces bounded typed evidence for the AI/property inspector. */
  async fetchSelectedProperties(
    rid: string,
    properties: readonly SelectedPropertyRequest[],
    signal?: AbortSignal,
  ): Promise<SelectedPropertyValue[]> {
    if (!properties.length) return [];
    properties.forEach(property => validateEcIdentifier(property.accessor));

    validateRid(rid);
    const lines = [`_o := ${CONTEXT_OBJECT}`, '_r := ""'];
    const emit = (key: string, value: string): string[] => appendBlockEc('_r', key, value, '     ');

    // Properties in one order: the same question is the same script.
    for (const property of [...properties].sort((a, b) => (a.accessor < b.accessor ? -1 : a.accessor > b.accessor ? 1 : 0))) {
      const accessor = property.accessor;
      if (isCodeProperty(accessor)) {
        // Code is read as stored text: `_v := _o.expression` would run it
        // (ec-code-safety). Empty code reads as missing.
        lines.push(`_v := output(_o.${accessor}.whenMissing(""))`);
        lines.push('IF _v = "" THEN');
        lines.push(...emit(`state_${accessor}`, '"missing"'));
        lines.push('ELSE');
        lines.push(...emit(`state_${accessor}`, '"value"'));
        lines.push(...emit(`value_${accessor}`, '_v'));
        lines.push('ENDIF');
        continue;
      }
      lines.push(`_v := _o.${accessor}`);
      lines.push('IF _v.isMissing() THEN');
      lines.push(...emit(`state_${accessor}`, '"missing"'));
      lines.push('ELSE');
      lines.push(...emit(`state_${accessor}`, '"value"'));
      lines.push(...emit(`value_${accessor}`, 'output(_v)'));
      if (property.reference) {
        lines.push(...emit(`rid_${accessor}`, 'output(_v.rid.whenMissing(""))'));
        lines.push(...emit(`id_${accessor}`, 'output(_v.id.whenMissing(""))'));
        lines.push(...emit(`name_${accessor}`, 'output(_v.name.whenMissing(""))'));
        lines.push(...emit(`type_${accessor}`, 'output(_v.className.whenMissing(""))'));
      }
      lines.push('ENDIF');
    }
    lines.push(`_r + ${EC_DONE_LITERAL}`);

    const result = await this.on(constantScript('EcQueryService.readSelectedProperties', lines.join('\n')), rid, signal);
    if (!result.ok) throw new Error(result.error || result.log || 'Selected property read failed');
    if (result.hasWarning) throw new Error(result.error || 'Selected property read returned warnings and may be incomplete');
    if (!isCompleteFramedLog(result.log)) {
      throw new Error('Selected property read returned an incomplete result');
    }

    const data = parseSepBlocks(result.log!);
    return properties.map(property => {
      const accessor = property.accessor;
      const rawState = data[`state_${accessor}`];
      if (rawState !== 'value' && rawState !== 'missing') {
        throw new Error(`Selected property read returned an incomplete result for ${accessor}`);
      }
      const state = rawState;
      const referenceRid = data[`rid_${accessor}`]?.trim();
      const reference = property.reference && referenceRid && /^-?\d+$/.test(referenceRid)
        ? {
            rid: referenceRid,
            businessId: data[`id_${accessor}`] ?? '',
            name: data[`name_${accessor}`] ?? '',
            type: data[`type_${accessor}`] ?? '',
          }
        : undefined;
      return {
        accessor,
        state,
        value: data[`value_${accessor}`] ?? '',
        ...(reference ? { reference } : {}),
      };
    });
  }

  /** Batch fetch code properties for multiple objects in a single EC call.
   *  Identity is read separately (Code Search's identity post): measured on
   *  BMP 5.6.17, reading id and name in the same script as `output(expression)`
   *  made 25 objects take 6.3 s instead of 1.9 s + 0.1 s. */
  async batchFetchCode(
    rids: string[],
    properties: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, Record<string, string>>> {
    const result = new Map<string, Record<string, string>>();
    if (rids.length === 0 || properties.length === 0) return result;

    const valid = rids.filter(rid => /^-?\d+$/.test(rid));
    if (valid.length === 0) return result;

    // `_o.${prop}` below is a bare identifier slot — validate before building EC.
    properties.forEach(validateEcIdentifier);

    // One constant script per property set, one command per object (the
    // object as its context). An object the server cannot read fails alone
    // and is left out, as an unresolvable RID was.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const answers = await this.each(buildContextCodeReadEc(properties), stableRidOrder(valid), signal);
    for (const ecResult of answers.values()) {
      if (!ecResult.ok) {
        if (ecResult.errorKind && ecResult.errorKind !== 'server') throw ecResultError(ecResult, 'Code batch fetch failed');
        continue;
      }
      if (ecResult.hasWarning) throw new Error(ecResult.error || 'Code batch fetch returned warnings and may be incomplete');
      if (ecResult.log == null) throw new Error('Code batch fetch returned no result');
      if (!isCompleteFramedLog(ecResult.log)) {
        throw new Error('Code batch fetch returned an incomplete result (the answer was cut off)');
      }
      for (const [rid, props] of parseSepMultiObject(ecResult.log)) result.set(rid, props);
    }
    if (result.size === 0) {
      const failed = [...answers.values()].find(r => !r.ok);
      if (failed) throw ecResultError(failed, 'Code batch fetch failed');
    }
    return result;
  }

  /** Walk the portal layout subtree of a TabSet / Tab / Container.
   *  Returns flat nodes with parent linkage + responsive sizing — the
   *  panel folds these into a tree client-side. The collection walk is
   *  structurally safe (portal descendants are Tabs/Containers); output is
   *  chunked and source-capped so a large shared TabSet stays bounded.
   *
   *  Widgets are NOT descendants of a portal TabSet. They live under the
   *  page/org model and bind back through `.container`; Blueprint owns that
   *  dual-model view. */
  async fetchLayoutTree(rid: string): Promise<{ nodes: LayoutNode[]; truncated: boolean }> {
    validateRid(rid);
    const result = await this.on(buildLayoutTreeEc(CONTEXT_OBJECT), rid, undefined, LAYOUT_TREE_EC_TIMEOUT);
    if (!result.ok) throw new Error(result.error || result.log || 'Layout-tree fetch failed');
    if (result.hasWarning) throw new Error(result.error || 'Layout-tree fetch returned warnings and may be incomplete');
    if (!result.log) throw new Error('Empty layout-tree response');
    return {
      nodes: parseLayoutNodes(result.log),
      truncated: result.log.includes('<<<CREV_LAYOUT_TREE_LIMIT>>>'),
    };
  }

  /** Fetch full editor context in a single EC call: identity, template, code props for both.
   *  Replaces separate lookupIdentity + resolveTemplate + 2× fetchCodeViaEc round-trips. */
  async fetchEditorContext(rid: string, extraProps: string[] = []): Promise<EditorContextData | null> {
    validateRid(rid);
    // Standard code props + any caller-requested property (e.g. afterExpression,
    // showExpression, initExpression, defaultExpression). Without the extra, an
    // Edit on a non-standard field would fetch nothing for it and the editor
    // silently fell back to `expression`. Validated — names are interpolated
    // into EC below.
    const extras = extraProps.filter(p => {
      try { validateEcIdentifier(p); return true; } catch { return false; }
    });
    const codeProps = [...new Set(['expression', 'html', 'javascript', ...[...extras].sort()])];
    const block = (key: string, expr: string) => appendBlockEc('_r', key, expr);
    const lines = [
      `_inst := ${CONTEXT_OBJECT}`,
      '_r := ""',
      ...block('instRid', '_inst.rid.whenMissing("MISSING")'),
      ...block('instId', '_inst.id.whenMissing("")'),
      ...block('instName', '_inst.name.whenMissing("")'),
      ...block('instType', '_inst.className.whenMissing("")'),
      ...ecResolveTemplate('_inst', '_tmpl'),
      ...block('tmplRid', '_tmpl.rid.whenMissing("MISSING")'),
      ...block('tmplId', '_tmpl.id.whenMissing("")'),
      ...block('tmplName', '_tmpl.name.whenMissing("")'),
      ...block('tmplType', '_tmpl.className.whenMissing("")'),
      '_loc := _inst.location',
      ...block('locRid', '_loc.rid.whenMissing("MISSING")'),
    ];
    for (const prop of codeProps) {
      lines.push(...block(`inst_${prop}`, `output(_inst.${prop}.whenMissing(""))`));
      lines.push(...block(`tmpl_${prop}`, `output(_tmpl.${prop}.whenMissing(""))`));
    }
    lines.push(`_r + ${EC_DONE_LITERAL}`);

    const result = await this.on(constantScript('EcQueryService.editorContext', lines.join('\n')), rid, undefined, undefined, 'editor-context');
    // A failed or cut-off read is an error, never "no context": the editor
    // must not open a code slot as empty when the stored code was not read.
    if (!result.ok) throw ecResultError(result, 'Editor context read failed');
    if (!isCompleteFramedLog(result.log)) {
      throw new BmpRequestError('Editor context read returned an incomplete result (the answer was cut off)', 'protocol');
    }

    const data = parseSepBlocks(result.log!);
    const instance = parseIdentityBlock(data, 'inst');
    if (!instance) return null;
    const template = parseIdentityBlock(data, 'tmpl');

    // Extract code props. Caller-requested fields stay present even when empty
    // so an explicit Create/Edit action can open a new expression tab.
    const instanceCode: Record<string, string> = {};
    const templateCode: Record<string, string> = {};
    for (const prop of codeProps) {
      const instVal = data[`inst_${prop}`];
      const tmplVal = data[`tmpl_${prop}`];
      if (instVal || extras.includes(prop)) instanceCode[prop] = instVal ?? '';
      if (tmplVal || (template && extras.includes(prop))) templateCode[prop] = tmplVal ?? '';
    }

    const locationRid = data.locRid && data.locRid !== 'MISSING' ? data.locRid : undefined;
    return { instance, template, instanceCode, templateCode, locationRid };
  }

  /** Single EC round trip that powers the sidepanel object pane.
   *  Returns identity + parent + template + allowlisted style props + siblings.
   *  Handles both model (.linkedTo) and enterprise (.template) objects. */
  async fetchObjectPane(rid: string, signal?: AbortSignal): Promise<ObjectPanePayload | null> {
    validateRid(rid);
    const frame = createEcFrame();
    // Constant script (per pane property list): the object is the context.
    const result = await this.on(buildObjectPaneEc(CONTEXT_OBJECT, this.paneProps, frame), rid, signal);
    // Distinguish "EC failed" (throw — handler surfaces the message) from
    // "object truly not found" (return null — generic message is correct).
    if (!result.ok) throw ecResultError(result, 'EC fetch failed');
    if (!result.log) throw new BmpRequestError('Empty EC response', 'protocol');
    if (!isCompleteFramedLog(result.log, frame)) {
      throw new BmpRequestError('Object read returned an incomplete result (the answer was cut off)', 'protocol');
    }

    const data = parseSepBlocks(result.log, frame);
    const parsedInstance = parseIdentityBlock(data, 'inst');
    if (!parsedInstance) return null;
    const parent = parseIdentityBlock(data, 'par');
    const template = parseIdentityBlock(data, 'tmpl');
    const instance: ObjectPaneIdentity = template?.businessId
      ? { ...parsedInstance, templateBusinessId: template.businessId }
      : parsedInstance;
    const propertyDefinition = data.isPropertyDefinition === 'true'
      || isMasterPropertyDefinition(instance.type, template);

    const cardBase = parseIdentityBlock(data, 'card');
    const card: ObjectPaneCard | null = cardBase ? {
      ...cardBase,
      // Instance had no own card → the effective card came from the template.
      // `.trim()` guards the load-bearing emptiness check: parseSepBlocks
      // strips only a trailing newline, not stray whitespace.
      viaTemplate: !data.instCardRid?.trim(),
    } : null;

    const instanceProps: Record<string, string> = {};
    const templateProps: Record<string, string> = {};
    for (const prop of this.paneProps) {
      instanceProps[prop] = data[`inst_${prop}`] ?? '';
      templateProps[prop] = data[`tmpl_${prop}`] ?? '';
    }

    const codeFields: Record<string, string> = {};
    for (const cf of ALL_CODE_FIELDS) {
      const v = data[`code_${cf}`];
      if (v) codeFields[cf] = v;
    }

    const references: Record<string, ObjectPaneIdentity | null> = {};
    for (const rf of ALL_REFERENCE_FIELDS) {
      const tRid = data[`ref_${rf}_rid`];
      if (tRid) {
        references[rf] = {
          rid: tRid,
          businessId: data[`ref_${rf}_id`] ?? '',
          name: data[`ref_${rf}_name`] ?? '',
          type: data[`ref_${rf}_type`] ?? '',
        };
      }
    }

    const indirectCode: Record<string, string> = {};
    const indirectCodeRids: Record<string, string> = {};
    for (const ind of ALL_INDIRECT_FIELDS) {
      const key = `${ind.prop}_${ind.targetProp}`;
      const v = data[`ind_${key}`];
      if (v) indirectCode[key] = v;
      const targetRid = data[`ind_${key}_rid`];
      if (targetRid) indirectCodeRids[key] = targetRid;
    }

    const contextValues: Record<string, string> = {};
    for (const ctx of ALL_CONTEXT_FIELDS) {
      if (ctx.kind === 'list-ref') continue;
      const v = data[`ctx_${ctx.prop}`];
      if (v != null && v !== '') contextValues[ctx.prop] = v;
    }

    const gateValues: Record<string, string> = {};
    for (const eb of ALL_ENABLED_BY_PROPS) {
      const v = data[`gate_${eb}`];
      if (v != null && v !== '') gateValues[eb] = v;
    }

    const lists: Record<string, ObjectPaneIdentity[]> = {};
    for (const ctx of ALL_CONTEXT_FIELDS) {
      if (ctx.kind !== 'list-ref') continue;
      const block = data[`list_${ctx.prop}`] ?? '';
      const items: ObjectPaneIdentity[] = [];
      for (const [lRid, lId, lName, lType] of splitFramedRows(block, frame, 4)) {
        if (!lRid.trim()) continue;
        items.push({ rid: lRid.trim(), businessId: lId.trim(), name: lName, type: lType.trim() });
      }
      if (items.length > 0) lists[ctx.prop] = items;
    }

    const editFieldClassNames = [...new Set(
      (data.editFieldTypes ?? '').split(',').map(v => v.trim()).filter(Boolean),
    )];
    let editFieldProperty: EditFieldPropertyResolution | undefined;
    let editFieldPropertyError: string | undefined;
    const propertyAccessor = instance.type === 'EditField'
      ? (instanceProps.propertyMapping ?? '').trim()
      : '';
    if (propertyAccessor) {
      if (editFieldClassNames.length === 0) {
        editFieldPropertyError = `Cannot resolve "${propertyAccessor}" without an owning object type.`;
      } else {
        try {
          const resolution = await this.on(buildEditFieldPropertyEc(CONTEXT_OBJECT, editFieldClassNames), rid, signal);
          throwIfAborted(signal);
          if (!resolution.ok || resolution.hasWarning) {
            editFieldPropertyError = resolution.error
              ?? (resolution.hasWarning
                ? 'Property resolution returned warnings and may be incomplete.'
                : resolution.log ?? 'Property resolution failed');
          } else {
            editFieldProperty = parseEditFieldPropertyLog(resolution.log ?? '') ?? undefined;
            if (!editFieldProperty) {
              editFieldPropertyError = `No property configuration resolved for "${propertyAccessor}".`;
            }
          }
        } catch (error) {
          editFieldPropertyError = error instanceof Error ? error.message : 'Property resolution failed';
        }
      }
    }

    // Backward-compatible parser for captured/older pane responses. The
    // current builder no longer emits this block; live application loading is
    // handled lazily by fetchPropertyApplications below.
    let propertyApplications: PropertyApplication[] | undefined;
    let propertyApplicationsError: string | undefined;
    if (propertyDefinition && data.propertyApplications !== undefined) {
      if (result.hasWarning) {
        propertyApplicationsError = 'Property applications returned warnings and may be incomplete.';
      } else {
        const parsed = parsePropertyApplicationsLog(data.propertyApplications);
        if (parsed == null) propertyApplicationsError = 'Property applications response was incomplete.';
        else propertyApplications = parsed;
      }
    }

    const siblings: ObjectPaneSiblingMsg[] = [];
    const sibBlock = data.siblings ?? '';
    for (const [sRid, sId, sName, sType, sCur] of splitFramedRows(sibBlock, frame, 5)) {
      if (!sRid.trim()) continue;
      siblings.push({
        rid: sRid.trim(),
        businessId: sId.trim(),
        name: sName,
        type: sType.trim(),
        isCurrent: sCur.trim() === '1',
      });
    }

    // True child count from the EC (counts all children, not the capped slice).
    // Fall back to the emitted row count if the field is absent/garbled.
    const parsedTotal = Number((data.sibTotal ?? '').trim());
    const siblingTotal = Number.isFinite(parsedTotal) && parsedTotal >= siblings.length
      ? parsedTotal
      : siblings.length;

    throwIfAborted(signal);
    return {
      instance, parent, template, card,
      isPropertyDefinition: propertyDefinition,
      instanceProps, templateProps, instanceOverrideProps: [], siblings, siblingTotal,
      codeFields, references,
      indirectCode, indirectCodeRids, contextValues, gateValues, lists,
      ...(editFieldClassNames.length > 0 ? { editFieldClassNames } : {}),
      ...(editFieldProperty ? { editFieldProperty } : {}),
      ...(editFieldPropertyError ? { editFieldPropertyError } : {}),
      ...(propertyApplications ? { propertyApplications } : {}),
      ...(propertyApplicationsError ? { propertyApplicationsError } : {}),
    };
  }

  /** The classes an EditField's property mapping targets (the same rule the
   *  pane read applies), in one small EC call. Empty for any other object. */
  async fetchEditFieldClassNames(rid: string, signal?: AbortSignal): Promise<string[]> {
    validateRid(rid);
    const result = await this.on(buildEditFieldTypesEc(CONTEXT_OBJECT), rid, signal);
    if (!result.ok) throw ecResultError(result, 'Owning object type read failed');
    if (result.hasWarning) throw new BmpRequestError(result.error || 'Owning object type read returned warnings', 'server');
    if (!isCompleteFramedLog(result.log)) {
      throw new BmpRequestError('Owning object type read returned an incomplete result (the answer was cut off)', 'protocol');
    }
    return [...new Set((parseSepBlocks(result.log!).types ?? '').split(',').map(v => v.trim()).filter(Boolean))];
  }

  /** Lazy, bounded reverse-reference scan for master-property applications. */
  async fetchPropertyApplications(rid: string, signal?: AbortSignal): Promise<{
    applications: PropertyApplication[];
    total: number;
    truncated: boolean;
  }> {
    validateRid(rid);
    const result = await this.on(buildPropertyApplicationsEc(CONTEXT_OBJECT), rid, signal);
    if (!result.ok) throw new Error(result.error ?? result.log ?? 'Property application lookup failed');
    if (result.hasWarning) throw new Error('Property applications returned warnings and may be incomplete.');
    const parsed = parsePropertyApplicationsResult(result.log ?? '');
    if (!parsed) throw new Error('Property applications response was incomplete.');
    return parsed;
  }

  // ── Colour sets ────────────────────────────────────────────────

  /** Enumerate the workspace's colour sets + colours (for the link picker).
   *  Selects CorpoColor directly; each colour carries its set/folder, bid
   *  (for linking via `t.<bid>`), name, and rgb (parsed from java.awt.Color). */
  async fetchColorSets(): Promise<ColorSetData[]> {
    const result = await this.executeEc(
      buildColorSetsEc(),
      undefined,
      false,
      undefined,
      COLOR_SETS_EC_TIMEOUT,
      'color-sets',
    );
    if (!result.ok) {
      throw new Error(result.error || result.log || 'Colour query failed');
    }
    if (result.hasWarning) {
      throw new Error(result.error || 'Colour query returned warnings and may be incomplete');
    }
    return parseColorSetsLog(result.log ?? '');
  }
}
