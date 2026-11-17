/**
 * Compare read path (service-worker side): everything the Compare window
 * draws for one or two objects, in as few posts as the transport allows.
 *
 *  1. ONE batched full read of the roots (both sides when both are known);
 *  2. ONE read-only Extended Code listing of the structure of every root
 *     whose type has a structure rule (lib/object-window-table);
 *  3. ONE batched read of the listed children plus the objects the roots
 *     refer to (reference targets, custom property definitions, template,
 *     parent), which names them.
 *
 * A batch BMP rejects because of one object is halved until that object is
 * isolated (readObjectsIsolating). Only a connection failure throws; a root
 * that cannot be read is reported per side. Read-only: no command here
 * writes. Suggestions for the picker are a separate, single post
 * (`buildSuggestEc`).
 */

import type { FullObject, ObjectSummary } from './object-read';
import { OBJECT_NO_DATA, summarize } from './object-read';
import { readObjectsIsolating, type ObjectReader } from './object-window';
import { readSummaries } from './object-summaries';
import { createEcFrame } from './ec-parser';
import { listStructures, parseStructureRows, STRUCTURE_MAX_NODES, type StructureRow, type StructureRule } from './object-structure';
import { typeInfo } from './object-window-table';
import { ridsToName } from './compare-model';
import { buildRowEc, field, parseDelimitedRow } from './ec-row-codec';
import { safeWireTextEc } from './layout-wire';
import { errorMessage } from './logger';
import { constantScript, varyingScript } from './script-kinds';
import { rowFactsFailure, type RowFactsFailure } from './row-facts-status';

export interface CompareSideRead {
  rid: string;
  /** null when the root could not be read; see `error` / `notFound`. */
  root: FullObject | null;
  error?: string;
  notFound?: boolean;
  /** The text cannot be a RID (set by the window, never read). */
  invalid?: boolean;
  /** Structure rows under this root; null when its type has no structure
   *  or the listing failed. */
  rows: StructureRow[] | null;
  structureError?: string;
  structureTruncatedAt?: number;
  /** The children are listed, but their row facts (names, types, markers)
   *  could not be read for some of them: why (row-facts-status.ts). */
  rowFactsError?: RowFactsFailure;
  /** Full reads of the listed children. */
  nodes: Record<string, FullObject>;
}

export interface CompareRead {
  sides: Record<string, CompareSideRead>;
  /** Names of referenced objects and custom property definitions. */
  summaries: Record<string, ObjectSummary>;
  posts: number;
  ms: number;
}

export interface CompareReader extends ObjectReader {
  resolveRef(rid: string, signal?: AbortSignal): Promise<string>;
  /** Names, types and IDs without full reads (object-summaries.ts). */
  resolveRefs?(rids: readonly string[], signal?: AbortSignal): Promise<Map<string, string | Error>>;
  /** Constant scripts with the object as the command context (BmpClient). */
  executeEcEach?: import('./object-summaries').ContextEach;
  executeEc(code: string, objectRid?: string, transactional?: boolean, signal?: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; log?: string; error?: string; hasWarning?: boolean }>;
}

/** Objects named per side at most (reference targets and definitions). */
const MAX_NAMED = 200;

/** Rows of `rows` below `root`, in listing order. */
export function rowsUnder(rows: readonly StructureRow[], root: string): StructureRow[] {
  const inTree = new Set([root]);
  const out: StructureRow[] = [];
  // Rows come parent first (the listing walks down), so one pass suffices;
  // a second pass catches rows listed before their parent.
  for (let pass = 0; pass < 2; pass++) {
    for (const r of rows) {
      if (inTree.has(r.rid) || !inTree.has(r.parent)) continue;
      inTree.add(r.rid);
      out.push(r);
    }
  }
  return out;
}

export async function readCompare(reader: CompareReader, ids: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<CompareRead> {
  const started = Date.now();
  const rids = [...new Set(ids)];
  let posts = 0;
  const sides: Record<string, CompareSideRead> = {};

  // 1. roots
  const roots = await readObjectsIsolating(reader, rids, signal);
  posts += roots.requests;
  for (const rid of rids) {
    const root = roots.objects[rid] ?? null;
    const error = roots.errors[rid] ?? (roots.unresolved.includes(rid) ? roots.error ?? 'Object read failed' : undefined);
    const missing = !root && (!error || error === OBJECT_NO_DATA);
    sides[rid] = { rid, root, rows: null, nodes: {}, ...(missing ? { notFound: true } : error && !root ? { error } : {}) };
  }

  // 2. structure listing, one post for every root with a rule
  const listed: Array<{ rid: string; rule: StructureRule }> = [];
  for (const s of Object.values(sides)) {
    const rule = s.root ? typeInfo(s.root.type).structure : undefined;
    if (rule) listed.push({ rid: s.rid, rule });
  }
  if (listed.length) {
    posts++;
    try {
      const res = await listStructures(reader, listed.map(l => ({ rid: l.rid, rule: l.rule })), signal, timeoutMs);
      if (!res.ok) throw new Error(res.error || 'Structure listing failed');
      const all = parseStructureRows(res.log ?? '');
      for (const l of listed) {
        sides[l.rid].rows = rowsUnder(all, l.rid);
        if (all.truncated) sides[l.rid].structureTruncatedAt = STRUCTURE_MAX_NODES;
      }
    } catch (e) {
      signal?.throwIfAborted();
      for (const l of listed) sides[l.rid].structureError = errorMessage(e);
    }
  }

  // 3. children and named objects, one batched read
  const want = new Set<string>();
  const named = new Set<string>();
  for (const s of Object.values(sides)) {
    for (const r of s.rows ?? []) want.add(r.rid);
    if (s.root) for (const r of ridsToName(s.root).slice(0, MAX_NAMED)) named.add(r);
  }
  for (const r of named) want.add(r);
  const summaries: Record<string, ObjectSummary> = {};
  for (const s of Object.values(sides)) if (s.root) summaries[s.rid] = summarize(s.root);
  // Children: the row facts only (object-row-facts.ts), matched without
  // full reads; a pair's property count is read lazily by the window.
  // Named objects: names, types and IDs (object-summaries.ts).
  const kids = [...new Set(Object.values(sides).flatMap(sd => (sd.rows ?? []).map(r => r.rid)))].filter(r => !roots.objects[r]);
  const names = [...named].filter(r => !roots.objects[r] && !kids.includes(r));
  let reads: Record<string, FullObject> = {};
  const light = !!reader.readRowFacts && !!reader.resolveRefs;
  let factsError: RowFactsFailure | undefined;
  try {
    if (light) {
      if (kids.length) {
        try {
          const got = await reader.readRowFacts!(kids, signal);
          posts += got.posts;
          reads = got.objects;
          factsError = got.error;
        } catch (e) {
          signal?.throwIfAborted();
          factsError = rowFactsFailure(e, kids.length);
        }
      }
      if (names.length) {
        const got = await readSummaries({ resolveRefs: reader.resolveRefs!.bind(reader), executeEc: reader.executeEc.bind(reader), ...(reader.executeEcEach ? { executeEcEach: reader.executeEcEach.bind(reader) } : {}) }, names, createEcFrame, signal);
        posts += got.posts;
        for (const sm of got.summaries) summaries[sm.rid] = sm;
      }
    } else {
      const extra = [...want].filter(r => !roots.objects[r]);
      if (extra.length) {
        const got = await readObjectsIsolating(reader, extra, signal);
        posts += got.requests;
        reads = got.objects;
      }
    }
  } catch (e) {
    // Children and names are optional; a connection failure still throws.
    signal?.throwIfAborted();
    const msg = errorMessage(e);
    for (const sd of Object.values(sides)) if (sd.rows) sd.structureError ??= msg;
  }
  const objectOf = (r: string) => reads[r] ?? roots.objects[r];
  for (const r of want) {
    const o = objectOf(r);
    if (o) summaries[r] = summarize(o);
  }
  for (const sd of Object.values(sides)) {
    for (const r of sd.rows ?? []) {
      const o = objectOf(r.rid);
      if (o) sd.nodes[r.rid] = o;
    }
    // The children are listed: a failed facts read is not a failed listing.
    const unread = (sd.rows ?? []).filter(r => !sd.nodes[r.rid]).length;
    if (factsError && unread) sd.rowFactsError = { ...factsError, rows: unread };
  }
  return { sides, summaries, posts, ms: Date.now() - started };
}

// ── picker suggestions ────────────────────────────────────────────

export interface SuggestRow {
  kind: 'instance' | 'sibling';
  rid: string;
  businessId: string;
  type: string;
  name: string;
}

const SEP = '|||';
const ROW_FIELDS = ['kind', 'rid', 'id', 'className', 'name'];

function rowEc(kind: string, v: string): string {
  return `"${kind}${SEP}" + ${buildRowEc([
    field('rid', `${v}.rid.whenMissing("")`),
    field('id', `${v}.id.whenMissing("")`),
    field('className', `${v}.className.whenMissing("")`),
    field('name', safeWireTextEc(`${v}.name.whenMissing("")`)),
  ], SEP)} + "\\n"`;
}

/** Lines that add one value per element of `list` to `_r`: calculated per element and joined once,
 *  so a template with thousands of instances does not copy the result once per row. */
function joinedEc(list: string, v: string, value: string, indent = ''): string[] {
  return [`${indent}_x := ${list}.calculate(`, `${indent}  ${v} := self`, `${indent}  ${value}`, `${indent})`, `${indent}_r := _r + _x.join("").whenMissing("")`];
}

/**
 * One read-only EC call for the picker's offers: the other instances of
 * the object's template, the instances of the object itself (when it is a
 * template), and the siblings of the same class under the same parent.
 * `ref`, `templateRef` and `parentRef` are EC references (lookup(rid) or
 * an ID-space reference from BmpClient.resolveRef).
 */
export function buildSuggestEc(ref: string, opts: { templateRef?: string; parentRef?: string }): string {
  // The instances of the template and of the object are one list with one row expression: the
  // script is a varying one and must stay within its size limit (script-kinds.ts).
  const lines = [`_o := ${ref}`, '_r := ""', '_cls := _o.className', '_ins := _o.rref(linkedTo)'];
  if (opts.templateRef) lines.push(`_t := ${opts.templateRef}`, 'IF _t != MISSING THEN', '  _ins := _t.rref(linkedTo).union(_ins)', 'ENDIF');
  lines.push(...joinedEc('_ins', '_i', `(IF _i.rid != _o.rid THEN ${rowEc('instance', '_i')} ELSE "" ENDIF)`));
  if (opts.parentRef) {
    lines.push(`_p := ${opts.parentRef}`, 'IF _p != MISSING THEN',
      ...joinedEc('_p.children()', '_s', `(IF _s.className = _cls AND _s.rid != _o.rid THEN ${rowEc('sibling', '_s')} ELSE "" ENDIF)`, '  '), 'ENDIF');
  }
  lines.push('_r');
  // The fallback for a client without the context path (buildSuggestPartEc).
  return varyingScript('buildSuggestEc', lines.join('\n'));
}

/**
 * The same offers as buildSuggestEc, as three CONSTANT scripts, each run
 * with its object as the command's context (one post): `template` on the
 * template (its instances), `object` on the object (its own instances, and
 * a `cls` row with its class), `parent` on the parent (its children). The
 * object itself and siblings of another class are left out here
 * (filterSuggestRows), as the one script did on the server.
 */
export function buildSuggestPartEc(part: 'template' | 'object' | 'parent'): string {
  const lines = ['_o := this.object', '_r := ""'];
  if (part === 'template') lines.push(...joinedEc('_o.rref(linkedTo)', '_i', `(${rowEc('instance', '_i')})`));
  if (part === 'object') lines.push(`_r := _r + "cls${SEP}" + _o.className.whenMissing("") + "\\n"`, ...joinedEc('_o.rref(linkedTo)', '_j', `(${rowEc('instance', '_j')})`));
  if (part === 'parent') lines.push(...joinedEc('_o.children()', '_s', `(${rowEc('sibling', '_s')})`));
  lines.push('_r');
  return constantScript('buildSuggestPartEc', lines.join('\n'));
}

/** The object's class from the `object` part's `cls` row ('' when absent). */
export function suggestClassOf(log: string): string {
  for (const line of log.split('\n')) {
    const t = line.trim();
    if (t.startsWith(`cls${SEP}`)) return t.slice(3 + SEP.length).trim();
  }
  return '';
}

/** The offers of the three parts, in their order, as buildSuggestEc gives
 *  them: never the object itself, siblings of its class only. */
export function filterSuggestRows(rows: readonly SuggestRow[], rid: string, cls: string): SuggestRow[] {
  return rows.filter(r => r.rid !== rid && (r.kind !== 'sibling' || r.type === cls));
}

export function parseSuggestLog(log: string): SuggestRow[] {
  const out: SuggestRow[] = [];
  const seen = new Set<string>();
  for (const line of log.split('\n')) {
    const row = parseDelimitedRow(line.trim(), ROW_FIELDS, SEP, { trailingFreeText: true });
    if (!row || (row.kind !== 'instance' && row.kind !== 'sibling') || !/^-?\d{1,20}$/.test(row.rid)) continue;
    const key = `${row.kind}:${row.rid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: row.kind, rid: row.rid, businessId: row.id, type: row.className, name: row.name });
  }
  return out;
}
