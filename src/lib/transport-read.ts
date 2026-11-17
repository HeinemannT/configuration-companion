/**
 * Transport (beta), the reads: the changes scan of one root, the scan of
 * everything under one object, the bundle
 * material of up to TRANSPORT_READ_BATCH objects, and the entries of the
 * transport log (transport-patch.ts writes them). Every script here is run
 * as a preview (non-transactional): `generate` and `genedit` are refused in
 * a committed run ("Not allowed to run genedit in a transaction mode",
 * measured on BMP 5.6.17), and the feature never writes.
 *
 * Free text travels in length-framed rows (ec-parser.ts), so no stored or
 * generated text can add or shift a row.
 */

import { appendRowEc, CONTEXT_OBJECT, contextObjectEc, countedFlushEc, EC_CHUNK, EC_DONE_LITERAL, EC_FRAME, flushChunkEc, framedFieldText, parseFramedLog } from './ec-parser';
import { ecString, formatEcLiteral, validateRid } from './ec-guards';
import { BmpRequestError, ecResultError } from './error-kind';
import { constantScript, SCRIPT_LIMITS, varyingScript } from './script-kinds';
import {
  CONDITION_RULE, FLOW_PROJECT, instancesEc, isNeverListed, isScanDay, isStartSpace, isTransportRoot, parseScanStart, plainAddress, serverStampIso, START_ID, TRANSPORT_READ_BATCH, TRANSPORT_SCAN_CAP,
  type TransportRoot,
} from './transport-bundle';
import { parseSourceListing, sourceListingText, TRANSPORT_LOG_ID } from './transport-patch';
import type { BmpClient, EcResult } from './bmp-client';

/** A scan of a large root walks every object once (4,310 objects took about
 *  200 ms on the dev workspace); the bound is for a slow server. */
export const TRANSPORT_SCAN_TIMEOUT_MS = 60_000;
/** One bundle read: 25 objects, two or three scripts each, `generate(true)` of an
 *  object with many children included. */
export const TRANSPORT_READ_TIMEOUT_MS = 90_000;
/** One probe or patch part of at most 20,000 characters run on a target (a
 *  preview part ran in about 70 ms); the bound is for a slow server. */
export const TRANSPORT_PART_TIMEOUT_MS = 120_000;

/** A connected workspace a patch can be applied to (TRANSPORT_TARGETS). */
export interface TransportTarget {
  /** Its environment token (`<profile>@<server>`). */
  environment: string;
  /** The server profile's name. */
  label: string;
  /** The host of its server's URL. */
  host: string;
}

// ── the changes scan ────────────────────────────────────────────────

/** One changed object of a scan. Dates as the server printed them, plus
 *  their ISO form when it could be read (serverStampIso). */
export interface TransportScanRow {
  /** The internal number (a 64-bit integer, as text). */
  rid: string;
  id: string;
  name: string;
  className: string;
  /** `lastModifiedDate` as printed (`Nov 1, 2026 10:00:00`). */
  modified: string;
  modifiedIso?: string;
  /** `lastModifiedBy.name` ('' when unknown). */
  modifiedBy: string;
  /** `lastModifiedBy.id` ('' when unknown). */
  modifiedById: string;
  /** `createdTime` as printed. */
  created: string;
  createdIso?: string;
  /** The parent's internal number ('' when unknown). */
  parentRid: string;
  /** The parent's ID (a root's is its upper-case name: `PORTAL`). */
  parentId: string;
  parentName: string;
  /** Its place among its siblings (`sortIndex`; 0 when unknown). */
  sortIndex: number;
  /** A linked copy: the ID of the template it is linked to (measured:
   *  `str(x.linkedTo.id.whenMissing(""))`, '' for a normal object). Absent
   *  for a normal object. */
  linkedTo?: string;
}

export interface TransportScan {
  root: TransportRoot;
  /** The day objects changed after (YYYY-MM-DD). */
  since: string;
  /** At most TRANSPORT_SCAN_CAP rows. */
  rows: TransportScanRow[];
  /** The root has more changed objects than the cap: ask for a later day. */
  more: boolean;
  /** The workspace has no such root: nothing was read. */
  missingRoot: boolean;
}

/**
 * The objects under `root.<root>` changed after `since`, one framed row
 * each (scanRowEc). At most TRANSPORT_SCAN_CAP + 1 rows (`first(…)`), so one
 * more row says "more". A root that does not resolve writes one `M` row
 * (measured: `root.<name>` of a missing root prints `Missing value for
 * .<name>` and yields nothing; `x = MISSING` is true then).
 *
 * The day is a literal in the text, the measured form
 * (`filter(lastModifiedDate > date("2026-11-15"))`), so the script is
 * varying: one text per root and day, under 1,200 characters. Both are
 * validated (an allow-listed root, a real calendar day).
 */
export function buildTransportScanEc(root: string, since: string): string {
  if (!isTransportRoot(root)) throw new Error(`Not a root the changes scan reads: ${root}`);
  if (!isScanDay(since)) throw new Error(`Not a day (YYYY-MM-DD): ${since}`);
  return varyingScript('transportScan', scanLines(`root.${root}`, since, TRANSPORT_SCAN_CAP + 1, `${rootFilter(root)}${dayFilter(since)}`));
}

/** The variables of a scan row's fields: short, so that a dated scan stays
 *  a varying script (none of the scan's other variables). */
const ROW_VARS = ['_a', '_b', '_c', '_e', '_h', '_m', '_n'];

/**
 * The framed `O` row of the object in `v`, the form of appendRowEc (every
 * field evaluated once into a variable, its length and text from the same
 * value). The first field holds, separated by one space, what has no space
 * in it: the RID, the parent's RID, the sort index and the class (one field
 * for all of them keeps the dated scan under the varying limit). Then ID, name, one field of last modified, created and the ID of the
 * template a linked copy is linked to (`|` between them: a printed date has
 * none, and the template's ID comes last, so it may hold anything), one of
 * its user's ID and name (`|` after the ID), the parent's ID and name.
 * `slim` (a search): no dates and no user, so the text stays small.
 */
function scanRowEc(v: string, slim = false): string[] {
  const linked = `str(${v}.linkedTo.id.whenMissing(""))`;
  const fields: Array<string | null> = [
    `str(${v}.rid) + " " + str(${v}.parent.rid) + " " + str(${v}.sortIndex) + " " + str(${v}.className)`,
    `str(${v}.id.whenMissing(""))`, `str(${v}.name.whenMissing(""))`,
    slim ? `"||" + ${linked}` : `str(${v}.lastModifiedDate.whenMissing("")) + "|" + str(${v}.createdTime.whenMissing("")) + "|" + ${linked}`,
    slim ? null : `str(${v}.lastModifiedBy.id.whenMissing("")) + "|" + str(${v}.lastModifiedBy.name.whenMissing(""))`,
    `str(${v}.parent.id)`, `str(${v}.parent.name.whenMissing(""))`,
  ];
  const empty = `"${formatEcLiteral(framedFieldText(''))}"`;
  const parts = fields.map((f, i) => (f == null ? empty : `str(${ROW_VARS[i]}.size()) + ":" + ${ROW_VARS[i]}`));
  return [
    ...fields.flatMap((f, i) => (f == null ? [] : [`${ROW_VARS[i]} := ${f}`])),
    `${EC_CHUNK} := ${EC_CHUNK} + ("${formatEcLiteral(EC_FRAME.row + framedFieldText('O'))}" + ${parts.join(' + ')})`,
  ];
}

/** The `M` row: the object asked about does not resolve. */
const MISSING_ROW = `"${formatEcLiteral(EC_FRAME.row + framedFieldText('M'))}"`;

/** The day's filter of a scan. */
const dayFilter = (since: string) => (since ? `.filter(lastModifiedDate > date("${since}"))` : '');

/** The filter of a root whose scan lists one class only: under
 *  `root.classConfig` the visibility rules (measured:
 *  `children.filter(className = "ConditionRule")`); the ClassConfigs, the
 *  system properties and the instances of linked properties there are
 *  never listed. */
const rootFilter = (root: string) => (root === 'classConfig' ? `.filter(className = "${CONDITION_RULE}")` : '');

/** Lines without indentation (every character counts in a varying script). */
const flat = (lines: readonly string[]): string => lines.map(l => l.trimStart()).join('\n');

/** A scan of the descendants of `source` (changed after `since` when one is
 *  given), at most `first` rows; one `M` row when `source` is missing.
 *  `filter` replaces the day's filter; `head` goes first. */
function scanLines(source: string, since: string, first: number, filter = since ? `.filter(lastModifiedDate > date("${since}"))` : '', head: readonly string[] = [], slim = false): string {
  return flat([
    ...head,
    '_r := ""',
    `${EC_CHUNK} := ""`,
    `_g := ${source}`,
    'IF _g = MISSING THEN',
    `_r := ${MISSING_ROW}`,
    'ELSE',
    '_k := 0',
    `_g.descendants()${filter}.first(${first}).forEach(_i:`,
    ...scanRowEc('_i', slim),
    ...countedFlushEc('_k', 20, ''),
    ')',
    'ENDIF',
    ...flushChunkEc(),
    `_r + ${EC_DONE_LITERAL}`,
  ]);
}

/** One object's own row: `_g` found by `find`, or an `M` row. */
function ownRowLines(find: string): string {
  return flat([
    '_r := ""',
    `${EC_CHUNK} := ""`,
    `_g := ${find}`,
    'IF _g = MISSING THEN',
    `_r := ${MISSING_ROW}`,
    'ELSE',
    ...scanRowEc('_g'),
    'ENDIF',
    ...flushChunkEc(),
    `_r + ${EC_DONE_LITERAL}`,
  ]);
}

// ── the scan under one object ───────────────────────────────────────

/**
 * The object with ID `id` in the ID space `space` (START_SPACES; `t` when
 * none is given), as one framed `O` row of the scan's shape, or one `M` row
 * when there is none. Measured: `<space>.get("<ID>")` returns the object
 * with that ID in that space, and `= MISSING` is true when there is none
 * (`t`, `k`, `r`, `d` among others). The space is allow-listed, the ID is
 * checked (START_ID) and written as a double-quoted literal: one small
 * varying text per object.
 */
export function buildTransportStartEc(id: string, space: string = 't'): string {
  if (!isStartSpace(space)) throw new Error(`Not an ID space a start may be in: ${space}`);
  if (!START_ID.test(id)) throw new Error(`Not an ID: ${id}`);
  return varyingScript('transportStart', ownRowLines(`${space}.get(${ecString(id)})`));
}

/** The context object's own row, in the scan's shape (an `M` row when it
 *  does not resolve). Constant: the object travels as the command's
 *  context. */
export function buildTransportRowEc(): string {
  return constantScript('transportRow', ownRowLines(CONTEXT_OBJECT));
}

/**
 * Everything under the context object (`this.object`), one framed `O` row
 * each, at most TRANSPORT_SCAN_CAP rows (one more than the starting object's
 * own row leaves room for). Measured: `this.object.descendants()` works in a
 * script run with the object as its context, without the object itself.
 * Constant: the object travels as the command's context.
 */
export function buildTransportUnderEc(): string {
  return constantScript('transportUnder', scanLines(CONTEXT_OBJECT, '', TRANSPORT_SCAN_CAP));
}

/** As buildTransportUnderEc, only the objects changed after `since`
 *  (YYYY-MM-DD), the measured filter of the changes scan. The day is in the
 *  text: varying, one text per day. */
export function buildTransportUnderSinceEc(since: string): string {
  if (!isScanDay(since)) throw new Error(`Not a day (YYYY-MM-DD): ${since}`);
  return varyingScript('transportUnderSince', scanLines(CONTEXT_OBJECT, since, TRANSPORT_SCAN_CAP));
}

/** The children of `_g` (or another collection of it, `of`): one framed `C`
 *  row with the RID each, or an `M` row when `_g` does not resolve. */
function childrenLines(source: string, of = 'children'): string {
  return flat([
    '_r := ""',
    `${EC_CHUNK} := ""`,
    `_g := ${source}`,
    'IF _g = MISSING THEN',
    `_r := ${MISSING_ROW}`,
    'ELSE',
    '_k := 0',
    `_g.${of}.forEach(_i:`,
    ...appendRowEc(EC_CHUNK, ['"C"', '_i.rid']),
    ...countedFlushEc('_k', 50, ''),
    ')',
    'ENDIF',
    ...flushChunkEc(),
    `_r + ${EC_DONE_LITERAL}`,
  ]);
}

/** The RIDs of the children of the context object (measured:
 *  `this.object.children.forEach(…)`). Constant. */
export function buildTransportChildrenEc(): string {
  return constantScript('transportChildren', childrenLines(CONTEXT_OBJECT));
}

/** The RIDs of the children of `root.<root>` (an allow-listed root): one
 *  small varying text per root. */
export function buildTransportRootChildrenEc(root: string): string {
  if (!isTransportRoot(root)) throw new Error(`Not a root the changes scan reads: ${root}`);
  return varyingScript('transportRootChildren', childrenLines(`root.${root}`));
}

const RID = /^-?\d{1,20}$/;
const DAMAGED = 'BMP returned a damaged row';

/** A damaged answer, with the `protocol` kind. */
const damaged = () => new BmpRequestError(DAMAGED, 'protocol');

/** The rows of a framed answer; a damaged or cut-off one throws with the
 *  `protocol` kind. */
function protocolRows(log: string): string[][] {
  try { return parseFramedLog(log, EC_FRAME); }
  catch (e) { throw new BmpRequestError(e instanceof Error ? e.message : String(e), 'protocol'); }
}

/** Parse buildTransportScanEc. Throws on a damaged or cut-off answer (kind
 *  `protocol`). */
export function parseTransportScanLog(log: string, root: TransportRoot, since: string): TransportScan {
  const { rows, missing, read } = scanRows(log);
  const more = read > TRANSPORT_SCAN_CAP;
  return { root, since, rows: more ? rows.slice(0, TRANSPORT_SCAN_CAP) : rows, more, missingRoot: missing };
}

/** The first field of a row: RID, parent RID, sort index, class, one space
 *  between them. A parent RID or sort index that is not a number (nothing
 *  printed) reads as '' and 0. */
const HEAD_FIELD = /^(-?\d{1,20}) (\S*) (\S*) (\S+)$/;

/** The `O` rows of a scan-shaped answer, whether it had an `M` row, and
 *  how many `O` rows it had. Objects never listed (isNeverListed: logs,
 *  system properties, ClassConfigs, the instances of linked properties) are
 *  dropped on arrival. Throws on a damaged or cut-off answer (kind
 *  `protocol`). */
function scanRows(log: string): { rows: TransportScanRow[]; missing: boolean; read: number } {
  const rows: TransportScanRow[] = [];
  let missing = false;
  let read = 0;
  for (const row of protocolRows(log)) {
    if (row[0] === 'M' && row.length === 1) { missing = true; continue; }
    if (row[0] !== 'O' || row.length !== 8) throw damaged();
    const [, head, id, name, dates, user, parentId, parentName] = row;
    const bar0 = user.indexOf('|');
    const modifiedById = bar0 < 0 ? '' : user.slice(0, bar0), modifiedBy = bar0 < 0 ? '' : user.slice(bar0 + 1);
    const n = HEAD_FIELD.exec(head);
    const bar = dates.indexOf('|');
    if (!n || !RID.test(n[1]) || bar < 0) throw damaged();
    const bar2 = dates.indexOf('|', bar + 1);
    const modified = dates.slice(0, bar), created = bar2 < 0 ? dates.slice(bar + 1) : dates.slice(bar + 1, bar2);
    const linkedTo = bar2 < 0 ? '' : dates.slice(bar2 + 1);
    const parentRid = /^\d{1,20}$/.test(n[2]) ? n[2] : '';
    const mIso = serverStampIso(modified), cIso = serverStampIso(created);
    read++;
    if (isNeverListed(n[4], linkedTo)) continue;
    rows.push({
      rid: n[1], id, name, className: n[4], modified, ...(mIso ? { modifiedIso: mIso } : {}),
      modifiedBy, modifiedById, created, ...(cIso ? { createdIso: cIso } : {}),
      parentRid, parentId, parentName, sortIndex: /^-?\d{1,10}$/.test(n[3]) ? Number(n[3]) : 0,
      ...(linkedTo ? { linkedTo } : {}),
    });
  }
  return { rows, missing, read };
}

/** `Missing value for .<root>` in a log (the server's own words for a root
 *  that does not resolve). */
function namesMissingRoot(text: string | undefined, root: string): boolean {
  return !!text && new RegExp(`Missing value for \\.${root}\\b`, 'i').test(text);
}

/** Scan one root for objects changed after `since`: one preview run. A
 *  root the workspace does not have is `missingRoot` (no rows), not an
 *  error. Throws when the run fails or the answer is damaged. */
export async function readTransportScan(client: Pick<BmpClient, 'executeEc'>, root: string, since: string, signal?: AbortSignal): Promise<TransportScan> {
  const code = buildTransportScanEc(root, since);
  const r = await client.executeEc(code, undefined, false, signal, TRANSPORT_SCAN_TIMEOUT_MS);
  const known = root as TransportRoot;
  if (!r.ok) {
    if (namesMissingRoot(`${r.error ?? ''}\n${r.log ?? ''}`, root) && !r.log?.includes(EC_FRAME.row)) return { root: known, since, rows: [], more: false, missingRoot: true };
    throw ecResultError(r, `Reading ${root} failed`);
  }
  const scan = parseTransportScanLog(r.log ?? '', known, since);
  if (!scan.rows.length && !scan.missingRoot && namesMissingRoot(r.log, root)) return { ...scan, missingRoot: true };
  return scan;
}

/** A scan under one object. */
export interface TransportUnderScan {
  /** The starting object's ID (without its space). */
  start: string;
  /** The day objects changed after (YYYY-MM-DD), or '' for all of them. */
  since: string;
  /** The starting object's own row (absent when it does not exist). */
  origin?: TransportScanRow;
  /** The starting object first (with a day: only when it changed after it),
   *  then what is under it; at most TRANSPORT_SCAN_CAP rows. */
  rows: TransportScanRow[];
  /** More objects under it than the cap: the rows are cut. */
  more: boolean;
  /** No object has that ID: nothing was read under it. */
  missingStart: boolean;
}

/** Parse buildTransportStartEc: the object's row, or null when there is
 *  none. Throws on a damaged or cut-off answer (kind `protocol`). */
export function parseTransportStartLog(log: string): TransportScanRow | null {
  const { rows, missing, read } = scanRows(log);
  if (missing && !read) return null;
  if (missing || read !== 1) throw damaged();
  // An object never listed (a log, say) is not found.
  if (!rows.length) return null;
  return rows[0];
}

/** Changed after the start of `day` by its printed time; true when the time
 *  could not be read (the server's filter decides for the others). */
const changedAfter = (row: TransportScanRow, day: string) => !row.modifiedIso || row.modifiedIso > `${day}T00:00:00`;

/** The starting object's row (when it is listed) and the rows under it, cut
 *  at TRANSPORT_SCAN_CAP in all. */
function underRows(origin: TransportScanRow, read: TransportScanRow[], since: string): { rows: TransportScanRow[]; more: boolean } {
  const below = read.filter(r => r.rid !== origin.rid);
  const more = below.length > TRANSPORT_SCAN_CAP - 1;
  const own = !since || changedAfter(origin, since) ? [origin] : [];
  return { rows: [...own, ...(more ? below.slice(0, TRANSPORT_SCAN_CAP - 1) : below)], more };
}

/**
 * The object `start` (an ID or `<space>.<ID>`, parseScanStart) and
 * everything under it, changed after `since` when one is given (YYYY-MM-DD;
 * '' for all): one preview run that finds the object by its ID, then one
 * with the object as the command's context that lists its descendants. An
 * ID that names no object is `missingStart` (no rows), not an error. Throws
 * for a start or day that is not one (before any run), when a run fails, or
 * on a damaged answer.
 */
export async function readTransportUnder(client: Pick<BmpClient, 'executeEc' | 'executeEcOn'>, start: string, since: string, signal?: AbortSignal): Promise<TransportUnderScan> {
  const s = parseScanStart(start);
  if (!s.ok) throw new Error(s.error);
  if (since && !isScanDay(since)) throw new Error(`Not a day (YYYY-MM-DD): ${since}`);
  const none: TransportUnderScan = { start: s.id, since, rows: [], more: false, missingStart: true };
  const found = await client.executeEc(buildTransportStartEc(s.id, s.space), undefined, false, signal, TRANSPORT_SCAN_TIMEOUT_MS);
  if (!found.ok) throw ecResultError(found, `${s.address} could not be read`);
  const origin = parseTransportStartLog(found.log ?? '');
  if (!origin) return none;
  const code = since ? buildTransportUnderSinceEc(since) : buildTransportUnderEc();
  const under = await client.executeEcOn(code, origin.rid, signal, TRANSPORT_SCAN_TIMEOUT_MS);
  if (!under.ok) throw ecResultError(under, `The objects under ${s.address} could not be read`);
  const read = scanRows(under.log ?? '');
  // Deleted between the two runs.
  if (read.missing) return none;
  return { start: s.id, since, origin, ...underRows(origin, read.rows, since), missingStart: false };
}

/** One object found by its address. */
export interface TransportFound {
  /** The object's row; absent when no object has that address. */
  row?: TransportScanRow;
}

/** Find the object `<space>.<ID>` (START_SPACES) on the workspace: one small
 *  preview run (buildTransportStartEc). Throws for an address of another
 *  form or space (before any run), when the run fails, or on a damaged
 *  answer. */
export async function readTransportFind(client: Pick<BmpClient, 'executeEc'>, address: string, signal?: AbortSignal): Promise<TransportFound> {
  const s = parseScanStart(address);
  if (!s.ok || !address.includes('.')) throw new Error(s.ok ? `Not an address: ${address}` : s.error);
  const r = await client.executeEc(buildTransportStartEc(s.id, s.space), undefined, false, signal, TRANSPORT_SCAN_TIMEOUT_MS);
  if (!r.ok) throw ecResultError(r, `${s.address} could not be read`);
  const row = parseTransportStartLog(r.log ?? '');
  return row ? { row } : {};
}

// ── search, rows by RID ─────────────────────────────────────────────

/** Matches one area's search returns at most; one more says "more". */
export const TRANSPORT_SEARCH_CAP = 500;
/** Characters a search text has at least and at most. */
export const TRANSPORT_SEARCH_MIN = 2;
export const TRANSPORT_SEARCH_MAX = 80;

/** A search text as it is searched for: trimmed; null when it is shorter
 *  than TRANSPORT_SEARCH_MIN or longer than TRANSPORT_SEARCH_MAX. */
export function searchText(text: unknown): string | null {
  const t = typeof text === 'string' ? text.trim() : '';
  return t.length >= TRANSPORT_SEARCH_MIN && t.length <= TRANSPORT_SEARCH_MAX ? t : null;
}

/**
 * The objects under `root.<root>` whose ID or name holds `text`, one framed
 * row each (scanRowEc), at most TRANSPORT_SEARCH_CAP + 1. Measured on BMP
 * 5.6.17: with `_q := "*text*"`, `descendants().filter(id = _q OR name =
 * _q)` is a wildcard match without regard to case (4,300 objects in about
 * 0.1 s). The text is a literal (ecString); a `*` or `?` in it is a wildcard
 * too. Varying: one text per root and search.
 */
export function buildTransportSearchEc(root: string, text: string): string {
  if (!isTransportRoot(root)) throw new Error(`Not a root the search reads: ${root}`);
  const q = searchText(text);
  if (q == null) throw new Error(`Search for ${TRANSPORT_SEARCH_MIN} to ${TRANSPORT_SEARCH_MAX} characters.`);
  return varyingScript('transportSearch', scanLines(`root.${root}`, '', TRANSPORT_SEARCH_CAP + 1, `${rootFilter(root)}.filter(id = _q OR name = _q)`, [`_q := ${ecString(`*${q}*`)}`], true));
}

/** One area searched. */
export interface TransportSearch {
  root: TransportRoot;
  rows: TransportScanRow[];
  /** More matches than TRANSPORT_SEARCH_CAP: `rows` is cut. */
  more: boolean;
  missingRoot: boolean;
}

/** Search one area: one preview run. A root the workspace does not have is
 *  `missingRoot`. Throws for a root or text that is not one (before any
 *  run), when the run fails, or on a damaged answer. */
export async function readTransportSearch(client: Pick<BmpClient, 'executeEc'>, root: string, text: string, signal?: AbortSignal): Promise<TransportSearch> {
  const code = buildTransportSearchEc(root, text);
  const known = root as TransportRoot;
  const r = await client.executeEc(code, undefined, false, signal, TRANSPORT_SCAN_TIMEOUT_MS);
  if (!r.ok) {
    if (namesMissingRoot(`${r.error ?? ''}\n${r.log ?? ''}`, root) && !r.log?.includes(EC_FRAME.row)) return { root: known, rows: [], more: false, missingRoot: true };
    throw ecResultError(r, `The search of ${root} failed`);
  }
  const { rows, missing, read } = scanRows(r.log ?? '');
  const more = read > TRANSPORT_SEARCH_CAP;
  return { root: known, rows: more ? rows.slice(0, TRANSPORT_SEARCH_CAP) : rows, more, missingRoot: missing || (!rows.length && namesMissingRoot(r.log, root)) };
}

/** One object read again by its RID. */
export type TransportRowRead =
  | { rid: string; row: TransportScanRow }
  /** The object does not exist (any more). */
  | { rid: string; missing: true }
  | { rid: string; error: string };

/**
 * The scan rows of up to TRANSPORT_READ_BATCH objects by RID, in one preview
 * post: buildTransportRowEc with each object as the command's context,
 * answered on its own. In the order asked, without repeats. Throws for more
 * than a batch or a RID that is not one (before any post).
 */
export async function readTransportRows(client: Pick<BmpClient, 'executeEcPairs'>, rids: readonly string[], signal?: AbortSignal): Promise<TransportRowRead[]> {
  const list = batchOf(rids);
  if (!list.length) return [];
  const code = buildTransportRowEc();
  const answers = await client.executeEcPairs(list.map(objectRid => ({ code, objectRid })), signal, TRANSPORT_SCAN_TIMEOUT_MS);
  return list.map((rid, i): TransportRowRead => {
    const a = answers[i];
    if (!a?.ok) return { rid, error: a?.error || a?.log || 'The object could not be read.' };
    try {
      const row = parseTransportStartLog(a.log ?? '');
      if (!row) return { rid, missing: true };
      return row.rid === rid ? { rid, row } : { rid, error: DAMAGED };
    } catch (e) {
      return { rid, error: errorOf(e) };
    }
  });
}

// ── used by, linked copies ──────────────────────────────────────────

/** Objects "Used by" lists at most; one more says "more". */
export const TRANSPORT_USED_BY_CAP = 200;

/**
 * The objects that use the context object, at most TRANSPORT_USED_BY_CAP +
 * 1: one framed `U` row each with RID, ID, class and name. Measured:
 * `x.rref()` returns the objects that use x (an index lookup whose cost
 * grows with the number of matches), and `x.rref().first(n).forEach(_i: …)`
 * with `_i.rid`, `_i.id`, `_i.className`, `_i.name`. Read for one object on
 * request only, never in a loop. Constant: the object travels as the
 * command's context.
 */
export function buildTransportUsedByEc(): string {
  return constantScript('transportUsedBy', contextObjectEc('_o', [
    '_k := 0',
    `_o.rref().first(${TRANSPORT_USED_BY_CAP + 1}).forEach(_i:`,
    ...appendRowEc(EC_CHUNK, ['"U"', '_i.rid', '_i.id.whenMissing("")', '_i.className', '_i.name.whenMissing("")']),
    ...countedFlushEc('_k', 20, ''),
    ')',
  ]).join('\n'));
}

/** An object that uses another. */
export interface TransportUser { rid: string; id: string; className: string; name: string }

export interface TransportUsedBy {
  /** At most TRANSPORT_USED_BY_CAP, in the server's order. */
  users: TransportUser[];
  /** TRANSPORT_USED_BY_CAP or more: `users` is cut. */
  more: boolean;
}

/** Parse buildTransportUsedByEc. Throws on a damaged or cut-off answer
 *  (kind `protocol`). */
export function parseTransportUsedByLog(log: string): TransportUsedBy {
  const users: TransportUser[] = [];
  for (const row of protocolRows(log)) {
    if (row[0] !== 'U' || row.length !== 5 || !RID.test(row[1].trim())) throw damaged();
    users.push({ rid: row[1].trim(), id: row[2], className: row[3], name: row[4] });
  }
  const more = users.length > TRANSPORT_USED_BY_CAP;
  return { users: more ? users.slice(0, TRANSPORT_USED_BY_CAP) : users, more };
}

/** What uses the object `rid`: one preview run with the object as the
 *  command's context. Throws for a RID that is not one (before any run),
 *  when the run fails, or on a damaged answer. */
export async function readTransportUsedBy(client: Pick<BmpClient, 'executeEcOn'>, rid: string, signal?: AbortSignal): Promise<TransportUsedBy> {
  validateRid(rid);
  const r = await client.executeEcOn(buildTransportUsedByEc(), rid, signal, TRANSPORT_SCAN_TIMEOUT_MS);
  if (!r.ok) throw ecResultError(r, 'What uses the object could not be read');
  return parseTransportUsedByLog(r.log ?? '');
}

/** Used objects one facts read asks about at most (TRANSPORT_FACTS). */
export const TRANSPORT_FACTS_BATCH = 25;
/** Used objects the window looks up at most after a build. */
export const TRANSPORT_FACTS_CAP = 200;

/** An address the facts read may name: one of the ID spaces a value names
 *  (argumentReferences) and an ID of letters, digits and underscore. */
const FACT_ADDRESS = /^[tkoug]\.[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const isFactAddress = (a: unknown): a is string => typeof a === 'string' && FACT_ADDRESS.test(a);

/** The lines of one address: assigned, tested for MISSING, then read into
 *  one framed `F` row (the address as given, RID and class, the parent's
 *  ID, the name); nothing when there is no object. */
function factLines(address: string): string[] {
  return [
    `_o := ${address}`,
    'IF _o != MISSING THEN',
    '_a := str(_o.rid) + " " + str(_o.className)',
    '_b := str(_o.parent.id)',
    '_c := str(_o.name.whenMissing(""))',
    `_r := _r + ("${formatEcLiteral(EC_FRAME.row + framedFieldText('F') + framedFieldText(address))}" + str(_a.size()) + ":" + _a + str(_b.size()) + ":" + _b + str(_c.size()) + ":" + _c)`,
    'ELSE ""',
    'ENDIF',
  ];
}

/**
 * The facts of used objects on this workspace, several addresses per
 * script: per address, `_o := <address>`, `IF _o != MISSING THEN` one row
 * of RID, class, parent ID and name `ELSE "" ENDIF` (the measured form). As
 * many scripts as keep each one within the varying limit, in order. Throws
 * for an address of another form. Varying: the addresses are in the text.
 */
export function buildTransportFactsEcs(addresses: readonly string[]): string[] {
  const list = [...new Set(addresses)];
  for (const a of list) if (!isFactAddress(a)) throw new Error(`Not an address the facts read names: ${String(a).slice(0, 60)}`);
  const head = ['_r := ""'], tail = [`_r + ${EC_DONE_LITERAL}`];
  const out: string[] = [];
  let cur: string[] = [];
  const text = (lines: string[]) => [...head, ...lines, ...tail].join('\n');
  for (const a of list) {
    const next = [...cur, ...factLines(a)];
    if (cur.length && text(next).length > SCRIPT_LIMITS.varying) { out.push(varyingScript('transportFacts', text(cur))); cur = factLines(a); } else cur = next;
  }
  if (cur.length) out.push(varyingScript('transportFacts', text(cur)));
  return out;
}

/** What this workspace has at a used address. */
export type TransportFact =
  | { address: string; rid: string; className: string; parentId: string; name: string }
  | { address: string; missing: true };

/** Parse one buildTransportFactsEcs answer for its `asked` addresses: a
 *  fact per address asked, `missing` for those without a row. Throws on a
 *  damaged answer (kind `protocol`). */
export function parseTransportFactsLog(log: string, asked: readonly string[]): TransportFact[] {
  const found = new Map<string, TransportFact>();
  for (const row of protocolRows(log)) {
    if (row[0] !== 'F' || row.length !== 5) throw damaged();
    const [, address, head, parentId, name] = row;
    const m = /^(-?\d{1,20}) (\S+)$/.exec(head);
    if (!m || !asked.includes(address)) throw damaged();
    found.set(address, { address, rid: m[1], className: m[2], parentId, name });
  }
  return asked.map(a => found.get(a) ?? { address: a, missing: true });
}

/** The facts of up to TRANSPORT_FACTS_BATCH used addresses: the scripts of
 *  buildTransportFactsEcs, one preview run each, in order. Throws for more
 *  than a batch or an address of another form (before any run), when a run
 *  fails, or on a damaged answer. */
export async function readTransportFacts(client: Pick<BmpClient, 'executeEc'>, addresses: readonly string[], signal?: AbortSignal): Promise<TransportFact[]> {
  const list = [...new Set(addresses)];
  if (list.length > TRANSPORT_FACTS_BATCH) throw new Error(`At most ${TRANSPORT_FACTS_BATCH} addresses per read.`);
  const scripts = buildTransportFactsEcs(list);
  const out: TransportFact[] = [];
  let at = 0;
  for (const code of scripts) {
    const asked = list.slice(at).filter(a => code.includes(`_o := ${a}\n`));
    at += asked.length;
    const r = await client.executeEc(code, undefined, false, signal, TRANSPORT_SCAN_TIMEOUT_MS);
    if (!r.ok) throw ecResultError(r, 'The used objects could not be read');
    out.push(...parseTransportFactsLog(r.log ?? '', asked));
  }
  return out;
}

/** The children of one object or root. */
export interface TransportChildren {
  /** In the server's order (`children` come in `sortIndex` order). */
  rids: string[];
  /** The object or root does not resolve. */
  missing: boolean;
}

/** Parse buildTransportChildrenEc / buildTransportRootChildrenEc. Throws on a
 *  damaged or cut-off answer (kind `protocol`). */
export function parseTransportChildrenLog(log: string): TransportChildren {
  const rids: string[] = [];
  let missing = false;
  for (const row of protocolRows(log)) {
    if (row[0] === 'M' && row.length === 1) { missing = true; continue; }
    if (row[0] !== 'C' || row.length !== 2 || !RID.test(row[1].trim())) throw damaged();
    rids.push(row[1].trim());
  }
  if (missing && rids.length) throw damaged();
  return { rids, missing };
}

/** The children of `root.<root>` or of the object `rid`: one preview run.
 *  Throws for a root or RID that is not one (before any run), when the run
 *  fails, or on a damaged answer. */
export async function readTransportChildren(client: Pick<BmpClient, 'executeEc' | 'executeEcOn'>, of: { root: string } | { rid: string }, signal?: AbortSignal): Promise<TransportChildren> {
  let r: EcResult;
  if ('root' in of) {
    const code = buildTransportRootChildrenEc(of.root);
    r = await client.executeEc(code, undefined, false, signal, TRANSPORT_SCAN_TIMEOUT_MS);
    if (!r.ok && namesMissingRoot(`${r.error ?? ''}\n${r.log ?? ''}`, of.root) && !r.log?.includes(EC_FRAME.row)) return { rids: [], missing: true };
  } else {
    validateRid(of.rid);
    r = await client.executeEcOn(buildTransportChildrenEc(), of.rid, signal, TRANSPORT_SCAN_TIMEOUT_MS);
  }
  if (!r.ok) throw ecResultError(r, 'The children could not be read');
  return parseTransportChildrenLog(r.log ?? '');
}

// ── how many objects are under an object ────────────────────────────

/** Objects one counts read asks about at most (TRANSPORT_COUNTS). */
export const TRANSPORT_COUNTS_BATCH = TRANSPORT_READ_BATCH;

/**
 * The number of objects under the context object: one framed `N` row
 * (`<object>.descendants().size()`, measured on BMP 5.6.10 and 5.6.17; the
 * number includes objects Transport never lists). Constant: the object
 * travels as the command's context.
 */
export function buildTransportCountEc(): string {
  return constantScript('transportCount', contextObjectEc('_o', appendRowEc(EC_CHUNK, ['"N"', '_o.descendants().size()'])).join('\n'));
}

/** The same for `root.<root>` (an allow-listed root): one `N` row, or an `M`
 *  row when the root does not resolve. Under `root.classConfig` only the
 *  visibility rules count, as in every scan. */
export function buildTransportRootCountEc(root: string): string {
  if (!isTransportRoot(root)) throw new Error(`Not a root the changes scan reads: ${root}`);
  return varyingScript('transportRootCount', flat([
    '_r := ""',
    `${EC_CHUNK} := ""`,
    `_g := root.${root}`,
    'IF _g = MISSING THEN',
    `_r := ${MISSING_ROW}`,
    'ELSE',
    ...appendRowEc(EC_CHUNK, ['"N"', `_g.descendants()${rootFilter(root)}.size()`]),
    'ENDIF',
    ...flushChunkEc(),
    `_r + ${EC_DONE_LITERAL}`,
  ]));
}

/** Parse buildTransportCountEc / buildTransportRootCountEc: the count, or
 *  null when the object or root does not resolve. Throws on a damaged or
 *  cut-off answer (kind `protocol`). */
export function parseTransportCountLog(log: string): number | null {
  const rows = protocolRows(log);
  if (rows.length === 1 && rows[0][0] === 'M' && rows[0].length === 1) return null;
  if (rows.length !== 1 || rows[0][0] !== 'N' || rows[0].length !== 2 || !/^\d{1,9}$/.test(rows[0][1].trim())) throw damaged();
  return Number(rows[0][1].trim());
}

/**
 * How many objects are under each of up to TRANSPORT_COUNTS_BATCH roots
 * (`roots`, one preview run each) or objects (`rids`, one preview post), by
 * root name or RID. One that is missing, or whose count fails, is left out
 * (the window shows its button without a number). Throws for a root or RID
 * that is not one (before any run), or when the read is aborted.
 */
export async function readTransportCounts(client: Pick<BmpClient, 'executeEc' | 'executeEcPairs'>, of: { roots: readonly string[] } | { rids: readonly string[] }, signal?: AbortSignal): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if ('roots' in of) {
    const roots = of.roots.slice(0, TRANSPORT_COUNTS_BATCH);
    const codes = roots.map(r => buildTransportRootCountEc(r));
    for (let i = 0; i < roots.length; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      try {
        const r = await client.executeEc(codes[i], undefined, false, signal, TRANSPORT_SCAN_TIMEOUT_MS);
        if (r.ok) { const n = parseTransportCountLog(r.log ?? ''); if (n != null) out[roots[i]] = n; }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
    }
    return out;
  }
  const rids = batchOf(of.rids);
  if (!rids.length) return out;
  const code = buildTransportCountEc();
  const answers = await client.executeEcPairs(rids.map(objectRid => ({ code, objectRid })), signal, TRANSPORT_SCAN_TIMEOUT_MS);
  rids.forEach((rid, i) => {
    const a = answers[i];
    if (!a?.ok) return;
    try { const n = parseTransportCountLog(a.log ?? ''); if (n != null) out[rid] = n; } catch { /* left out */ }
  });
  return out;
}

/** What is under one object, read by its RID. */
export interface TransportBelow {
  /** The object's own row (absent when it does not exist any more). */
  origin?: TransportScanRow;
  /** Its own row (with a day: only when it changed after it), then what is
   *  under it; at most TRANSPORT_SCAN_CAP rows. */
  rows: TransportScanRow[];
  /** More objects under it than the cap: the rows are cut. */
  more: boolean;
  /** The object does not exist (any more). */
  missing: boolean;
}

/**
 * The object `rid` and everything under it, changed after `since` when one
 * is given (YYYY-MM-DD; '' for all): one preview post of two scripts, both
 * with the object as the command's context, its own row
 * (buildTransportRowEc) and what is under it (buildTransportUnderEc or
 * buildTransportUnderSinceEc). Throws for a RID or day that is not one
 * (before any post), when a run fails, or on a damaged answer.
 */
export async function readTransportBelow(client: Pick<BmpClient, 'executeEcPairs'>, rid: string, since: string, signal?: AbortSignal): Promise<TransportBelow> {
  validateRid(rid);
  if (since && !isScanDay(since)) throw new Error(`Not a day (YYYY-MM-DD): ${since}`);
  const code = since ? buildTransportUnderSinceEc(since) : buildTransportUnderEc();
  const [own, under] = await client.executeEcPairs([{ code: buildTransportRowEc(), objectRid: rid }, { code, objectRid: rid }], signal, TRANSPORT_SCAN_TIMEOUT_MS);
  if (!own?.ok) throw ecResultError(own ?? { ok: false }, 'The object could not be read');
  const origin = parseTransportStartLog(own.log ?? '');
  if (!origin) return { rows: [], more: false, missing: true };
  if (!under?.ok) throw ecResultError(under ?? { ok: false }, 'The objects under it could not be read');
  const read = scanRows(under.log ?? '');
  if (read.missing) return { rows: [], more: false, missing: true };
  return { origin, ...underRows(origin, read.rows, since), missing: false };
}

// ── the bundle material ─────────────────────────────────────────────

/** The class whose generated text carries a file's content (measured on
 *  5.6.17: `genedit()` and `generate(true)` hold it as
 *  `name;mime;gzip-base64` in the `content` value; `genedit(id, name)`
 *  prints the values without it). */
export const FILE_CLASS = 'FileResource';

/**
 * The object's own text: RID, class, its text, and for a file the size of
 * its whole text. For a file (FILE_CLASS) the whole `genedit()` is only
 * measured on the server (assigned, then `.size()`) and its values are
 * printed without the content (`genedit(id, name)`): the content is read
 * on its own (buildTransportFileTextEc), only for a file within the limit.
 * Any other object: `genedit()` and an empty size. The object is the
 * command's context: one constant text.
 */
export function buildTransportObjectEc(): string {
  return constantScript('transportObject', contextObjectEc('_o', [
    '_s := ""',
    '_t := ""',
    `IF _o.className = '${FILE_CLASS}' THEN`,
    '     _t := str(_o.genedit())',
    '     _s := str(_t.size())',
    '     _t := str(_o.genedit(id, name))',
    'ELSE',
    '     _t := str(_o.genedit())',
    'ENDIF',
    ...appendRowEc(EC_CHUNK, ['_o.rid', '_o.className', '_t', '_s']),
  ]).join('\n'));
}

/**
 * As buildTransportObjectEc, with file content off: a file (FILE_CLASS) is
 * read with `genedit(id, name)` only, never measured; its size field is
 * `?`. No `genedit()` or `generate(true)` without value names runs on a
 * file. Constant.
 */
export function buildTransportObjectNoContentEc(): string {
  return constantScript('transportObjectNoContent', contextObjectEc('_o', [
    '_s := ""',
    '_t := ""',
    `IF _o.className = '${FILE_CLASS}' THEN`,
    '     _s := "?"',
    '     _t := str(_o.genedit(id, name))',
    'ELSE',
    '     _t := str(_o.genedit())',
    'ENDIF',
    ...appendRowEc(EC_CHUNK, ['_o.rid', '_o.className', '_t', '_s']),
  ]).join('\n'));
}

/** A file's whole text (`genedit()`, its content included): RID, text.
 *  Read only for a file within the limit. Constant. */
export function buildTransportFileTextEc(): string {
  return constantScript('transportFileText', contextObjectEc('_o', [
    ...appendRowEc(EC_CHUNK, ['_o.rid', '_o.genedit()']),
  ]).join('\n'));
}

/**
 * The `generate(true)` text of a property definition (its links to classes
 * are only there) and the `genedit()` texts of its instances (its own
 * values per class; measured: `k.get("x").rref(linkedTo)` lists them):
 * RID, a flag, the text, the instances (`<size>:<text>` each). Every other Add is made from the
 * object's values (transport-bundle.ts), so only a class whose name holds
 * `MethodConfig` is asked; any other object gives the flag `N` and no text,
 * so no recursive `generate` runs on a folder and no file's content is
 * read here. A property definition is a leaf. Constant: the object is the
 * command's context.
 */
export function buildTransportCreationEc(): string {
  return constantScript('transportCreation', contextObjectEc('_o', [
    '_f := ""',
    '_t := ""',
    '_c := str(_o.className)',
    '_x := _c.indexOf("MethodConfig").whenMissing(-1)',
    'IF _x > 0 THEN',
    '     _t := str(_o.generate(true))',
    ...instancesEc('_o', '     '),
    'ELSE',
    '     _v := ""',
    '     _f := "N"',
    'ENDIF',
    ...appendRowEc(EC_CHUNK, ['_o.rid', '_f', '_t', '_v']),
  ]).join('\n'));
}

/**
 * The object's place: the RIDs of its parent and of its previous and next
 * sibling ('' when there is none), the parent's ID and class, and whether
 * it is a system object. Siblings are the last of the parent's children
 * below its `sortIndex` and the first above it (`sortIndex` can have gaps;
 * `children` come in `sortIndex` order). No generated text is asked for
 * here. Measured: `genedit()` / `generate()` of an object adds a temporary
 * sibling for the rest of the run, so the siblings are found first. The
 * addresses of the parent and the siblings come from their `genedit(id)`
 * (one value, no content; measured on 5.6.10 for an ordinary object, a
 * file, a property definition, a step and a rule), in the same run: no post
 * per neighbour. Under a FlowProject: whether the object is
 * one of the project's steps (measured:
 * `t.p.configObjects.filter(id = "x").size()` is 1 for a step, 0 for a
 * child such as the schedule or the log folder). The neighbours' addresses are read on their
 * own (buildTransportAddressEc). Constant: the object is the command's
 * context.
 */
export function buildTransportNeighboursEc(): string {
  return constantScript('transportNeighbours', contextObjectEc('_o', [
    '_pa := ""',
    '_pv := ""',
    '_nx := ""',
    '_pi := ""',
    '_pc := ""',
    '_so := str(_o.systemObject.whenMissing(false))',
    '_st := ""',
    '_ga := ""',
    '_gv := ""',
    '_gx := ""',
    '_p := _o.parent',
    'IF _p != MISSING THEN',
    '     _pa := str(_p.rid)',
    '     _pi := str(_p.id)',
    '     _pc := str(_p.className)',
    `     IF _pc = '${FLOW_PROJECT}' THEN`,
    '          _q := str(_o.id)',
    '          _st := str(_p.configObjects.filter(id = _q).size())',
    '     ELSE ""',
    '     ENDIF',
    '     _i := _o.sortIndex',
    '     _c := _p.children.filter(sortIndex < _i)',
    '     _n := _p.children.filter(sortIndex > _i)',
    // The addresses last, after both siblings are found: genedit() of an
    // object adds a temporary sibling for the rest of the run.
    '     _ga := str(_p.genedit(id))',
    '     IF _c.size() > 0 THEN',
    '          _cv := _c.last()',
    '          _pv := str(_cv.rid)',
    '          _gv := str(_cv.genedit(id))',
    '     ELSE ""',
    '     ENDIF',
    '     IF _n.size() > 0 THEN',
    '          _cn := _n.first()',
    '          _nx := str(_cn.rid)',
    '          _gx := str(_cn.genedit(id))',
    '     ELSE ""',
    '     ENDIF',
    'ELSE ""',
    'ENDIF',
    ...appendRowEc(EC_CHUNK, ['_pa', '_pv', '_nx', '_pi', '_pc', '_so', '_st', '_ga', '_gv', '_gx']),
  ]).join('\n'));
}

/** What one object of a bundle read returned. */
export type TransportObjectRead =
  | {
    rid: string; ok: true; className: string;
    /** A property definition's `generate(true)`, as BMP returned it;
     *  absent when it was not asked for or could not be read. */
    generate?: string;
    /** Why `generate` was asked for and could not be read. */
    creationError?: string;
    /** A property definition: the `genedit()` texts of its instances,
     *  read with `generate`. */
    instances?: string;
    /** A step of the FlowProject it is under. */
    flowStep?: true;
    /** `genedit()`, as BMP returned it; for a file whose content was not
     *  read, `genedit(id, name)` (its values without the content). */
    genedit: string;
    /** A file (FILE_CLASS): the characters of its whole `genedit()` text
     *  (the content as gzip-base64 text, not its size on disk); absent when
     *  it was not measured (file content off, `isFile`). */
    fileSize?: number;
    /** A file (FILE_CLASS), measured or not. */
    isFile?: true;
    /** A file: its content was read (within the limit). */
    contentCarried?: boolean;
    /** '' when unknown; see neighboursError. */
    parentAddress: string;
    previousAddress: string;
    nextAddress: string;
    /** The parent's ID ('' when unknown; a root's is its upper-case name). */
    parentId: string;
    /** The parent is a root: its class ends with `Root`, or it has no address. */
    parentIsRoot: boolean;
    systemObject: boolean;
    /** The neighbours could not be read (the object's own text could). */
    neighboursError?: string;
  }
  /** `missing`: the object does not exist on this workspace (any more). */
  | { rid: string; ok: false; error: string; missing?: true };

/** What a creation read returned for one object. */
export type TransportCreationRead =
  | { rid: string; ok: true; generate: string; instances?: string }
  | { rid: string; ok: false; error: string };

/** Parse buildTransportObjectEc for `rid`: class, text and, for a file,
 *  the size of its whole text. Throws on a damaged answer or one about
 *  another object; null when the object does not exist. */
export function parseTransportObjectLog(log: string, rid: string): { className: string; genedit: string; fileSize?: number; isFile?: true } | null {
  const rows = parseFramedLog(log, EC_FRAME, 4);
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0][0].trim() !== rid) throw new Error(DAMAGED);
  const [, className, genedit, raw] = rows[0];
  const size = raw.trim();
  if (size && size !== '?' && !/^\d{1,10}$/.test(size)) throw new Error(DAMAGED);
  return { className, genedit, ...(size ? { isFile: true as const } : {}), ...(size && size !== '?' ? { fileSize: Number(size) } : {}) };
}

/** Parse buildTransportFileTextEc for `rid`: the whole text, or null when
 *  the object does not exist. Throws on a damaged answer. */
export function parseTransportFileTextLog(log: string, rid: string): string | null {
  const rows = parseFramedLog(log, EC_FRAME, 2);
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0][0].trim() !== rid) throw new Error(DAMAGED);
  return rows[0][1];
}

/** Parse buildTransportCreationEc for `rid`: the text, `{ other: true }`
 *  for an object that is not a property definition, or null when the
 *  object does not exist. Throws on a damaged answer or one about another
 *  object. */
export function parseTransportCreationLog(log: string, rid: string): { text: string; instances: string } | { other: true } | null {
  const rows = parseFramedLog(log, EC_FRAME, 4);
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0][0].trim() !== rid) throw new Error(DAMAGED);
  return rows[0][1] === 'N' ? { other: true } : { text: rows[0][2], instances: rows[0][3] };
}

/** What buildTransportNeighboursEc gives. */
export interface TransportNeighbours {
  parentRid: string;
  previousRid: string;
  nextRid: string;
  parentId: string;
  parentClass: string;
  systemObject: boolean;
  /** A step of the FlowProject it is under. */
  step: boolean;
  /** The addresses of the parent and of the previous and next sibling ('' when
   *  there is none or it is not a plain address, e.g. a root's). */
  parentAddress: string;
  previousAddress: string;
  nextAddress: string;
}

/** Parse buildTransportNeighboursEc: three RIDs, each '' unless it is a
 *  decimal RID, the parent's ID and class, the system flag. Throws on a
 *  damaged answer. */
export function parseTransportNeighboursLog(log: string): TransportNeighbours {
  const rows = parseFramedLog(log, EC_FRAME, 10);
  if (rows.length > 1) throw new Error(DAMAGED);
  const [pa, pv, nx, pi, pc, so, st, ga, gv, gx] = rows[0] ?? ['', '', '', '', '', '', '', '', '', ''];
  const rid = (v: string) => (/^\d{1,20}$/.test(v.trim()) ? v.trim() : '');
  const parentRid = rid(pa);
  return {
    parentRid, previousRid: rid(pv), nextRid: rid(nx),
    parentId: parentRid ? pi.trim() : '', parentClass: parentRid ? pc.trim() : '', systemObject: so.trim().toLowerCase() === 'true',
    step: !!parentRid && pc.trim() === FLOW_PROJECT && /^[1-9]\d*$/.test(st.trim()),
    parentAddress: parentRid ? addressOfText(ga) : '', previousAddress: rid(pv) ? addressOfText(gv) : '', nextAddress: rid(nx) ? addressOfText(gx) : '',
  };
}

/** The address in a `genedit(id)` text (measured: one value,
 *  `r.status_icon.change(id := 'status_icon') //FileResource`): the part before
 *  `.change(`, '' unless it is a plain dotted address (a root or a ClassConfig
 *  prints no text). */
export function addressOfText(text: string): string {
  const at = text.indexOf('.change(');
  return at > 0 ? plainAddress(text.slice(0, at)) : '';
}

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** RIDs to read, without repeats; throws for more than a batch or a RID
 *  that is not one. */
function batchOf(rids: readonly string[]): string[] {
  const list = [...new Set(rids)];
  if (list.length > TRANSPORT_READ_BATCH) throw new Error(`At most ${TRANSPORT_READ_BATCH} objects per read.`);
  for (const rid of list) validateRid(rid);
  return list;
}

/** The `generate(true)` text of `rid` from one answer. */
function creationOf(r: EcResult | undefined, rid: string): TransportCreationRead {
  if (!r?.ok) return { rid, ok: false, error: r?.error || r?.log || 'The text that adds it could not be read.' };
  try {
    const text = parseTransportCreationLog(r.log ?? '', rid);
    if (text == null) return { rid, ok: false, error: 'The object does not exist (any more).' };
    if ('text' in text) return { rid, ok: true, generate: text.text, ...(text.instances ? { instances: text.instances } : {}) };
    return { rid, ok: false, error: 'It is not a property definition.' };
  } catch (e) {
    return { rid, ok: false, error: errorOf(e) };
  }
}

/**
 * The bundle material of up to TRANSPORT_READ_BATCH objects in one preview
 * post (executeEcPairs): per object its own text and its neighbours (with
 * the addresses of its parent and siblings, no further post), and
 * for the property definitions in `creation` also their `generate(true)`
 * text (buildTransportCreationEc: no other object is asked), each script
 * with the object as the command's context and answered on its own, so an
 * object that fails does not fail the others, and failed neighbours or
 * creation text do not fail the object's own text. In the order asked, without repeats. Throws for
 * more than TRANSPORT_READ_BATCH objects or a RID that is not a decimal RID
 * (before any post).
 *
 * A file (FILE_CLASS) is measured first: its whole text is read, in one
 * more post, only when it has at most `fileLimit` characters
 * (`contentCarried`). A larger file keeps its values without the content:
 * its content never reaches the extension.
 */
export async function readTransportObjects(client: Pick<BmpClient, 'executeEcPairs'>, rids: readonly string[], signal?: AbortSignal, creation: readonly string[] = [],
  fileLimit = Number.POSITIVE_INFINITY): Promise<TransportObjectRead[]> {
  const list = batchOf(rids);
  if (!list.length) return [];
  // A limit of 0: file content off, a file is not even measured.
  const own = fileLimit > 0 ? buildTransportObjectEc() : buildTransportObjectNoContentEc();
  const near = buildTransportNeighboursEc();
  const make = buildTransportCreationEc();
  const withCreation = new Set(creation);
  const pairs: Array<{ code: string; objectRid: string }> = [];
  const at = list.map(objectRid => {
    const i = pairs.length;
    pairs.push({ code: own, objectRid }, { code: near, objectRid });
    if (withCreation.has(objectRid)) pairs.push({ code: make, objectRid });
    return i;
  });
  const results = await client.executeEcPairs(pairs, signal, TRANSPORT_READ_TIMEOUT_MS);
  type Own = {
    rid: string; text: NonNullable<ReturnType<typeof parseTransportObjectLog>>; near?: TransportNeighbours; nearError?: string;
    creation?: TransportCreationRead; carried?: boolean;
  };
  const out: Array<Own | { rid: string; error: string; missing?: true }> = list.map((rid, n) => {
    const i = at[n];
    const a = results[i], b = results[i + 1];
    if (!a?.ok) return { rid, error: a?.error || a?.log || 'The object could not be read.' };
    let text: ReturnType<typeof parseTransportObjectLog>;
    try { text = parseTransportObjectLog(a.log ?? '', rid); }
    catch (e) { return { rid, error: errorOf(e) }; }
    if (!text) return { rid, error: 'The object does not exist (any more).', missing: true as const };
    const c = withCreation.has(rid) ? { creation: creationOf(results[i + 2], rid) } : {};
    if (!b?.ok) return { rid, text, nearError: b?.error || b?.log || 'Its parent and siblings could not be read.', ...c };
    try { return { rid, text, near: parseTransportNeighboursLog(b.log ?? ''), ...c }; }
    catch (e) { return { rid, text, nearError: errorOf(e), ...c }; }
  });
  // Files within the limit: their whole text, in one more post.
  const files = out.filter((o): o is Own => 'text' in o && o.text.fileSize != null && o.text.fileSize <= fileLimit);
  if (files.length) {
    const fileText = buildTransportFileTextEc();
    const more = files.map(o => ({ code: fileText, objectRid: o.rid, o }));
    const answers = await client.executeEcPairs(more.map(({ code, objectRid }) => ({ code, objectRid })), signal, TRANSPORT_READ_TIMEOUT_MS);
    more.forEach((m, i) => {
      const r = answers[i];
      try {
        const whole = r?.ok ? parseTransportFileTextLog(r.log ?? '', m.o.rid) : null;
        if (whole != null) { m.o.text = { ...m.o.text, genedit: whole }; m.o.carried = true; }
      } catch { /* the values without the content stay */ }
    });
  }
  return out.map((o): TransportObjectRead => {
    if (!('text' in o)) return { rid: o.rid, ok: false, error: o.error, ...(o.missing ? { missing: true as const } : {}) };
    const c = o.creation;
    const made = !c ? {} : c.ok ? { generate: c.generate, ...(c.instances != null ? { instances: c.instances } : {}) } : { creationError: c.error };
    const file = o.text.isFile ? { contentCarried: !!o.carried } : {};
    if (!o.near) {
      return {
        rid: o.rid, ok: true, ...o.text, ...made, ...file, parentAddress: '', previousAddress: '', nextAddress: '', parentId: '', parentIsRoot: false, systemObject: false,
        neighboursError: o.nearError ?? 'Its parent and siblings could not be read.',
      };
    }
    const parentAddress = o.near.parentAddress;
    return {
      rid: o.rid, ok: true, ...o.text, ...made, ...file,
      parentAddress, previousAddress: o.near.previousAddress, nextAddress: o.near.nextAddress,
      parentId: o.near.parentId, parentIsRoot: !!o.near.parentRid && (/Root$/.test(o.near.parentClass) || !parentAddress), systemObject: o.near.systemObject,
      ...(o.near.step ? { flowStep: true as const } : {}),
    };
  });
}

/**
 * The `generate(true)` text of up to TRANSPORT_READ_BATCH property
 * definitions (buildTransportCreationEc) in one preview post, one script per
 * object with the object as the command's context, each answered on its
 * own. In the order asked, without repeats. Throws for more than
 * TRANSPORT_READ_BATCH objects or a RID that is not a decimal RID (before
 * any post).
 */
export async function readTransportCreation(client: Pick<BmpClient, 'executeEcPairs'>, rids: readonly string[], signal?: AbortSignal): Promise<TransportCreationRead[]> {
  const list = batchOf(rids);
  if (!list.length) return [];
  const code = buildTransportCreationEc();
  const results = await client.executeEcPairs(list.map(objectRid => ({ code, objectRid })), signal, TRANSPORT_READ_TIMEOUT_MS);
  return list.map((rid, i) => creationOf(results[i], rid));
}

// ── what the source has under a listed object ───────────────────────

/** The listing of what this workspace has under `start` (a listing start
 *  of the comparison, `<space>.<ID>`), in the form the target part uses.
 *  Varying: the start is in the text. */
export function buildTransportSourceListingEc(start: string): string {
  return varyingScript('transportSourceListing', sourceListingText(start));
}

/** The IDs this workspace has under `start`, its own included: one
 *  preview run, at every comparison. Throws when the run fails, the answer
 *  is damaged, the object is missing or the listing is cut. */
export async function readTransportSourceListing(client: Pick<BmpClient, 'executeEc'>, start: string, signal?: AbortSignal): Promise<string[]> {
  const code = buildTransportSourceListingEc(start);
  const r = await client.executeEc(code, undefined, false, signal, TRANSPORT_SCAN_TIMEOUT_MS);
  if (!r.ok) throw ecResultError(r, `What this workspace has under ${start} could not be read`);
  const l = parseSourceListing(r.log ?? '', start);
  if (!l.ok) throw new Error(l.error);
  return l.ids;
}

// ── the transport log ───────────────────────────────────────────────

/** Entries the log read returns at most: the last ones added. */
export const TRANSPORT_LOG_CAP = 200;

/** One entry of the transport log (transport-patch.ts, the Record part). */
export interface TransportLogEntry {
  /** The internal number (a 64-bit integer, as text). */
  rid: string;
  id: string;
  /** The patch's title. */
  name: string;
  /** The patch's summary. */
  description: string;
  /** `createdTime` as printed, and its ISO form when it could be read. */
  created: string;
  createdIso?: string;
  /** `createdBy.name` ('' when unknown). */
  createdBy: string;
}

export interface TransportLog {
  /** Newest first, at most TRANSPORT_LOG_CAP. */
  entries: TransportLogEntry[];
  /** The log has more entries than were read. */
  more: boolean;
  /** The workspace has no transport log: nothing was read. */
  missingLog: boolean;
}

/**
 * The entries of the transport log folder `t.cc_transport_log`: one `T` row
 * with the number of its children, then one framed row per child among the
 * last TRANSPORT_LOG_CAP (entries are added at the end): `L`, RID, ID, name,
 * description, created, its user's name. A workspace without the folder
 * writes one `N` row. No generated text is asked for. Constant: the folder's
 * ID is fixed.
 */
export function buildTransportLogEc(): string {
  const i2 = '  ', i4 = '    ', i6 = '      ';
  const lines = [
    '_r := ""',
    `${EC_CHUNK} := ""`,
    `_g := t.${TRANSPORT_LOG_ID}`,
    'IF _g = MISSING THEN',
    `${i2}_r := "${formatEcLiteral(EC_FRAME.row + framedFieldText('N'))}"`,
    'ELSE',
    `${i2}_l := _g.children`,
    `${i2}_n := _l.size()`,
    ...appendRowEc('_r', ['"T"', '_n'], i2),
    `${i2}_j := 0`,
    `${i2}_k := 0`,
    `${i2}_l.forEach(_i:`,
    `${i4}_j := _j + 1`,
    `${i4}IF _j > _n - ${TRANSPORT_LOG_CAP} THEN`,
    ...appendRowEc(EC_CHUNK, [
      '"L"', '_i.rid', '_i.id.whenMissing("")', '_i.name.whenMissing("")', '_i.description.whenMissing("")',
      '_i.createdTime.whenMissing("")', '_i.createdBy.name.whenMissing("")',
    ], i6),
    ...countedFlushEc('_k', 20, i6),
    `${i4}ELSE ""`,
    `${i4}ENDIF`,
    `${i2})`,
    'ENDIF',
    ...flushChunkEc(),
    `_r + ${EC_DONE_LITERAL}`,
  ];
  return constantScript('transportLog', lines.join('\n'));
}

/** Parse buildTransportLogEc: newest first (by created time, then the
 *  reverse of the folder's order). Throws on a damaged or cut-off answer
 *  (kind `protocol`). */
export function parseTransportLogLog(log: string): TransportLog {
  const entries: TransportLogEntry[] = [];
  let missingLog = false;
  let count = 0;
  for (const row of protocolRows(log)) {
    if (row[0] === 'N' && row.length === 1) { missingLog = true; continue; }
    if (row[0] === 'T' && row.length === 2 && /^\d+$/.test(row[1].trim())) { count = Number(row[1].trim()); continue; }
    if (row[0] !== 'L' || row.length !== 7) throw damaged();
    const [, rid, id, name, description, created, createdBy] = row;
    if (!RID.test(rid.trim())) throw damaged();
    const iso = serverStampIso(created);
    entries.push({ rid: rid.trim(), id, name, description, created, ...(iso ? { createdIso: iso } : {}), createdBy });
  }
  entries.reverse();
  entries.sort((a, b) => {
    const x = a.createdIso ?? '', y = b.createdIso ?? '';
    return x === y ? 0 : !x ? 1 : !y ? -1 : x > y ? -1 : 1;
  });
  return { entries, more: count > entries.length, missingLog };
}

/** Read the transport log of the workspace: one preview run. Throws when
 *  the run fails or the answer is damaged. */
export async function readTransportLog(client: Pick<BmpClient, 'executeEc'>, signal?: AbortSignal): Promise<TransportLog> {
  const r = await client.executeEc(buildTransportLogEc(), undefined, false, signal, TRANSPORT_SCAN_TIMEOUT_MS);
  if (!r.ok) throw ecResultError(r, 'The transport log could not be read');
  return parseTransportLogLog(r.log ?? '');
}
