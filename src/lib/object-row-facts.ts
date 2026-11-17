/**
 * What a tree row needs, without a full object read. Opening the object
 * window used to read every listed node in full (up to 400 full object
 * reads) only to draw the rows: name, type, ID, the key, and the markers
 * (show / enable / after / required expression set, gate switches on, the
 * node has code, page visibility, the button type that decides a follow
 * rule). This script returns exactly those facts per node, 50 nodes a
 * script; code properties are read only as the length of their text inside
 * `output(…)` (ec-code-safety), every other fact as text.
 *
 * The result is a "light" FullObject (`lite: true`): enough for the row and
 * its markers, never shown in the detail pane. The window reads a node in
 * full when it is selected (controller `nodeSelected`).
 */

import { appendRowEc, contextObjectEc, EC_CHUNK, EC_FRAME, objectLoopEc, parseFramedLog, stableRidOrder, type EcFrame } from './ec-parser';
import { CONTEXT_PER_POST } from './constants';
import { constantScript, varyingScript } from './script-kinds';
import type { ContextEach } from './object-summaries';
import { KNOWN_CODE_PROPS } from './code-index-sync';
import { TYPES } from './object-window-table';
import type { FullObject, PropValue } from './object-read';
import { ecResultError, type BmpErrorKind } from './error-kind';
import { isObjectLevelError } from './batch-isolate';
import { rowFactsFailure, type RowFactsFailure } from './row-facts-status';

/** Nodes per script: about 50 × 35 short reads; the answer holds only the
 *  facts that are set (a few KB). */
export const ROW_FACTS_PER_SCRIPT = 50;

/** Code properties a row marker or the "has code" marker can look at. */
export const ROW_CODE_PROPS: readonly string[] = [...new Set([
  'showExpression', 'enableExpression', 'afterExpression', 'requiredExpression',
  ...Object.values(TYPES).flatMap(t => t.blocks),
  ...Object.values(KNOWN_CODE_PROPS).flat(),
])].filter(p => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p)).sort();

/** Other properties a row looks at: the key, the expression gates, the
 *  required flag, page visibility, the button type (follow rule). */
export const ROW_VALUE_PROPS: readonly string[] = ['key', 'useShowExpression', 'useEnableExpression', 'useRequiredExpression', 'required', 'visibility', 'visible', 'buttonType'];

const RID = /^-?\d{1,20}$/;

/** The text of any property value, for `size()`: code only inside
 *  `output(…)` (ec-code-safety), the result always through `str(…)`.
 *  `"" + value` is not text for every kind: the children of a scorecard
 *  failed live with "Method size can only be on a list, text or map" on
 *  `_s.size()` of `"" + output(_o.text…)` (a widget's text). `str(…)` turns
 *  every kind (text, boolean, enum, number, date, object, list, rich text)
 *  into text. */
export function textOfEc(prop: string): string {
  return `str(output(_o.${prop}.whenMissing("")))`;
}

/** `items`: each node's RID and its EC reference (`lookup(…)`).
 *  `facts: false` writes only the identity row (name, type, ID, template
 *  link): the fallback for objects whose facts fail on the server. */
export function buildRowFactsEc(items: ReadonlyArray<{ rid: string; ref: string }>, _frame: EcFrame = EC_FRAME, opts: { facts?: boolean } = {}): string {
  for (const { rid } of items) if (!RID.test(rid)) throw new Error(`Invalid RID ${rid}`);
  // One loop over the list (ec-parser objectLoopEc): the ~35 fact blocks are
  // written once, not once per node; only the list line changes per call.
  return varyingScript('buildRowFactsEc', objectLoopEc(items.map(it => it.ref), '_o', rowFactsBody(opts.facts !== false), 10).join('\n'));
}

/** The row facts of the context object: ONE constant script for every node
 *  (two with the identity-only fallback; BmpClient.executeEcEach). */
export function buildContextRowFactsEc(opts: { facts?: boolean } = {}): string {
  return constantScript('buildContextRowFactsEc', contextObjectEc('_o', rowFactsBody(opts.facts !== false)).join('\n'));
}

function rowFactsBody(facts: boolean): string[] {
  const body = [
    '_oid := str(_o.rid)',
    ...appendRowEc(EC_CHUNK, ['"O"', '_oid', '_o.className.whenMissing("")', '_o.name.whenMissing("")', '_o.id.whenMissing("")', '_o.linkedTo.rid.whenMissing("")']),
  ];
  for (const p of facts ? ROW_CODE_PROPS : []) {
    body.push(`_s := ${textOfEc(p)}`, 'IF _s.size() > 0 THEN',
      ...appendRowEc(EC_CHUNK, ['"C"', '_oid', `"${p}"`, '_s.size()', '""', '""'], '     '), 'ENDIF');
  }
  for (const p of facts ? ROW_VALUE_PROPS : []) {
    body.push(`_s := ${textOfEc(p)}`, 'IF _s.size() > 0 THEN',
      ...appendRowEc(EC_CHUNK, ['"V"', '_oid', `"${p}"`, '_s', '""', '""'], '     '), 'ENDIF');
  }
  return body;
}

/** Light objects from the answer. A code property the type is known to
 *  have is present (empty) when it holds no code, so a marker reads "empty"
 *  rather than "not applicable". */
export function parseRowFactsLog(log: string, frame: EcFrame): Record<string, FullObject> {
  const out: Record<string, FullObject> = {};
  const rows = parseFramedLog(log, frame);
  for (const f of rows) {
    if (f[0] !== 'O' || f.length !== 6 || !RID.test(f[1].trim())) continue;
    const rid = f[1].trim();
    const type = f[2].trim();
    const props: Record<string, PropValue> = {};
    for (const p of KNOWN_CODE_PROPS[type] ?? []) props[p] = { kind: 'code', text: '' };
    const linked = f[5].trim();
    // The template link (a reference, not code) pairs instances in Compare.
    out[rid] = { rid, type, name: f[3], businessId: f[4].trim(), props, references: RID.test(linked) ? { linkedTo: [linked] } : {}, overridden: [], lite: true };
  }
  for (const f of rows) {
    if ((f[0] !== 'C' && f[0] !== 'V') || f.length !== 6) continue;
    const o = out[f[1].trim()];
    if (!o) continue;
    if (f[0] === 'C') o.props[f[2]] = { kind: 'code', text: '…', cls: 'CorpoExtendedExpression' };
    else {
      const text = f[3];
      o.props[f[2]] = text === 'true' || text === 'false' ? { kind: 'boolean', text, bool: text === 'true' } : { kind: 'text', text };
    }
  }
  return out;
}

export interface RowFactsReader {
  resolveRefs(rids: readonly string[], signal?: AbortSignal): Promise<Map<string, string | Error>>;
  executeEc(code: string, objectRid?: string, transactional?: boolean, signal?: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; log?: string; error?: string; errorKind?: BmpErrorKind }>;
  /** One constant script per node, the node as the command's context
   *  (BmpClient). Without it the loop script is the fallback. */
  executeEcEach?: ContextEach;
}

/** Row facts through context commands: the facts script for every node,
 *  then the identity-only script for the nodes whose facts the server
 *  rejected (each command fails alone, so no halving is needed). A lost
 *  connection or session stops at once with what was read. */
async function readRowFactsInContext(each: ContextEach, rids: readonly string[], newFrame: () => EcFrame, signal?: AbortSignal): Promise<RowFactsRead> {
  const objects: Record<string, FullObject> = {};
  let posts = 0;
  const valid = stableRidOrder(rids).filter(rid => RID.test(rid));
  const frame = newFrame();
  const run = async (list: readonly string[], facts: boolean): Promise<{ failed: string[]; stop?: RowFactsFailure }> => {
    if (!list.length) return { failed: [] };
    posts += Math.ceil(list.length / CONTEXT_PER_POST);
    const answers = await each(buildContextRowFactsEc({ facts }), list, signal, 60_000);
    signal?.throwIfAborted();
    const failed: string[] = [];
    for (const rid of list) {
      const r = answers.get(rid);
      if (r?.ok && r.log != null) {
        try { Object.assign(objects, parseRowFactsLog(r.log, frame)); continue; } catch { /* a damaged answer: as a failed object */ }
      }
      const error = ecResultError(r ?? { ok: false, error: 'No answer' }, 'The tree rows could not be read');
      if (!isObjectLevelError(error)) return { failed, stop: rowFactsFailure(error, list.filter(x => !objects[x]).length) };
      failed.push(rid);
    }
    return { failed };
  };
  const first = await run(valid, true);
  if (first.stop) return { objects, posts, error: first.stop };
  const second = await run(first.failed, false);
  for (const rid of first.failed) if (objects[rid]) objects[rid] = { ...objects[rid], factsUnknown: true };
  if (second.stop) return { objects, posts, error: second.stop };
  if (second.failed.length) return { objects, posts, error: rowFactsFailure(new Error('The server could not read these objects'), second.failed.length) };
  return { objects, posts };
}

export interface RowFactsRead {
  objects: Record<string, FullObject>;
  posts: number;
  /** Set when some rows got no facts at all (connection or session lost,
   *  or even their identity failed on the server). The rows keep what the
   *  structure listing knows; the tree says why and offers Retry. */
  error?: RowFactsFailure;
}

/** Extra posts to isolate the objects of one failing chunk (enough for one
 *  bad object among 50: halving costs two posts a level). */
function isolateBudget(n: number): number {
  return 2 * Math.ceil(Math.log2(Math.max(2, n)));
}

/** Row facts of `rids`, one post per ROW_FACTS_PER_SCRIPT nodes.
 *
 * Never fails a whole tree because of one object: a chunk the server
 * rejects (an EC error, not a connection failure) is halved within a small
 * budget; the objects it cannot read with facts get their identity from one
 * more post and come back `factsUnknown` (markers unknown, name/type/ID
 * known). A session or connection failure stops at once and is returned in
 * `error` with whatever was read before it. Only an abort throws. */
export async function readRowFacts(client: RowFactsReader, rids: readonly string[], newFrame: () => EcFrame, signal?: AbortSignal): Promise<RowFactsRead> {
  if (client.executeEcEach) return readRowFactsInContext(client.executeEcEach.bind(client), rids, newFrame, signal);
  const objects: Record<string, FullObject> = {};
  let posts = 0;
  type Item = { rid: string; ref: string };
  const run = async (items: readonly Item[], facts: boolean): Promise<Record<string, FullObject>> => {
    const frame = newFrame();
    posts++;
    const r = await client.executeEc(buildRowFactsEc(items, frame, { facts }), undefined, false, signal, 60_000);
    if (!r.ok || r.log == null) throw ecResultError(r, 'The tree rows could not be read');
    return parseRowFactsLog(r.log, frame);
  };
  let items: Item[];
  try {
    const refs = await client.resolveRefs(rids, signal);
    // One order for one set of nodes: the same tree asks the same scripts.
    items = stableRidOrder(rids).flatMap(rid => { const ref = refs.get(rid); return typeof ref === 'string' ? [{ rid, ref }] : []; });
  } catch (e) {
    signal?.throwIfAborted();
    return { objects, posts, error: rowFactsFailure(e, rids.length) };
  }
  const missing = (list: readonly Item[]) => list.filter(it => !objects[it.rid]).length;
  for (let i = 0; i < items.length; i += ROW_FACTS_PER_SCRIPT) {
    const chunk = items.slice(i, i + ROW_FACTS_PER_SCRIPT);
    try {
      try {
        Object.assign(objects, await run(chunk, true));
        continue;
      } catch (e) {
        signal?.throwIfAborted();
        if (!isObjectLevelError(e)) throw e;
      }
      // Isolate the objects whose facts fail; the rest keep theirs.
      const unknown: Item[] = [];
      let budget = isolateBudget(chunk.length);
      const split = async (part: readonly Item[]): Promise<void> => {
        if (part.length === 1) { unknown.push(part[0]); return; }
        const mid = Math.ceil(part.length / 2);
        for (const half of [part.slice(0, mid), part.slice(mid)]) {
          if (budget <= 0) { unknown.push(...half); continue; }
          budget--;
          try {
            Object.assign(objects, await run(half, true));
          } catch (e) {
            signal?.throwIfAborted();
            if (!isObjectLevelError(e)) throw e;
            await split(half);
          }
        }
      };
      await split(chunk);
      if (!unknown.length) continue;
      // Their identity at least: one post for all of them.
      try {
        const ids = await run(unknown, false);
        for (const o of Object.values(ids)) objects[o.rid] = { ...o, factsUnknown: true };
      } catch (e) {
        signal?.throwIfAborted();
        if (!isObjectLevelError(e)) throw e;
        return { objects, posts, error: rowFactsFailure(e, missing(items)) };
      }
    } catch (e) {
      // Session or connection: stop; what was read so far stays.
      signal?.throwIfAborted();
      return { objects, posts, error: rowFactsFailure(e, missing(items)) };
    }
  }
  return { objects, posts };
}
