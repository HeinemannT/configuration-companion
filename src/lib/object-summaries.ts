/**
 * Names, types and business IDs of many objects with one small script,
 * instead of full object reads. A full object read
 * (`IntegrationGetObjectCommand`) serialises every property of the object;
 * one batch of 9 once answered 4.3 MB. This read answers about 100 bytes
 * an object and touches no code (ec-code-safety).
 */

import { appendRowEc, contextObjectEc, EC_CHUNK, EC_FRAME, objectLoopEc, parseFramedLog, stableRidOrder, type EcFrame } from './ec-parser';
import { CONTEXT_PER_POST } from './constants';
import { constantScript, varyingScript } from './script-kinds';
import { isConnectionKind, type BmpErrorKind } from './error-kind';
import type { ObjectSummary } from './object-read';

/** Objects per script: about 25 KB an answer. */
export const SUMMARIES_PER_SCRIPT = 100;
const RID = /^-?\d{1,20}$/;

/** `refs`: the EC reference of each RID (`lookup(…)`, from resolveRefs).
 *  One loop over the list (ec-parser objectLoopEc): the script text changes
 *  only in its list line. */
export function buildSummariesEc(items: ReadonlyArray<{ rid: string; ref: string }>, _frame: EcFrame = EC_FRAME): string {
  for (const { rid } of items) if (!RID.test(rid)) throw new Error(`Invalid RID ${rid}`);
  return varyingScript('buildSummariesEc', objectLoopEc(items.map(it => it.ref), '_o',
    appendRowEc(EC_CHUNK, ['str(_o.rid)', '_o.className.whenMissing("")', '_o.name.whenMissing("")', '_o.id.whenMissing("")']), 20).join('\n'));
}

export function parseSummariesLog(log: string, frame: EcFrame = EC_FRAME): ObjectSummary[] {
  return parseFramedLog(log, frame, 4)
    .filter(([rid]) => RID.test(rid.trim()))
    .map(([rid, type, name, businessId]) => ({ rid: rid.trim(), type: type.trim(), name, businessId: businessId.trim() }));
}

/** The summary of the context object: ONE constant script for every object
 *  (BmpClient.executeEcEach). */
export function buildContextSummaryEc(): string {
  return constantScript('buildContextSummaryEc', contextObjectEc('_o', appendRowEc(EC_CHUNK, ['str(_o.rid)', '_o.className.whenMissing("")', '_o.name.whenMissing("")', '_o.id.whenMissing("")'])).join('\n'));
}

export interface SummaryReader {
  resolveRefs(rids: readonly string[], signal?: AbortSignal): Promise<Map<string, string | Error>>;
  executeEc(code: string, objectRid?: string, transactional?: boolean, signal?: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; log?: string; error?: string }>;
  /** One constant script per object, the object as the command's context.
   *  Without it the loop script (buildSummariesEc) is the fallback. */
  executeEcEach?: ContextEach;
}

/** BmpClient.executeEcEach, structurally. */
export type ContextEach = (code: string, objectRids: readonly string[], signal?: AbortSignal, timeoutMs?: number) => Promise<Map<string, { ok: boolean; log?: string; error?: string; errorKind?: BmpErrorKind }>>;

/** A per-object error that says the object is not there (deleted, or a RID
 *  of another server), as opposed to a read that failed. */
const NOT_THERE = /no data|not found|no such object|does not exist|unknown object|could not find|object is null|null object/i;

export function isNotThereError(error: string | undefined): boolean {
  return !!error && NOT_THERE.test(error);
}

export interface SummariesRead {
  summaries: ObjectSummary[];
  posts: number;
  /** The server says these objects are not there: remembering this is safe. */
  missing: string[];
  /** These objects' reads failed or came back without an answer: ask again. */
  failed: Record<string, string>;
}

/** Summaries of `rids`. With context commands: one constant script, one
 *  command per object (CONTEXT_PER_POST a post). Otherwise one loop script
 *  per SUMMARIES_PER_SCRIPT objects. A context command that runs and writes
 *  no row means the object is not there. Every asked RID ends up in exactly one
 *  of `summaries`, `missing` (not there) or `failed` (ask again); a lost
 *  connection or session fails the whole read. */
export async function readSummaries(client: SummaryReader, rids: readonly string[], newFrame: () => EcFrame, signal?: AbortSignal): Promise<SummariesRead> {
  const out: ObjectSummary[] = [];
  const missing: string[] = [];
  const failed: Record<string, string> = {};
  let posts = 0;
  const at = new Map(rids.map((rid, i) => [rid, i] as const));
  const settle = () => {
    out.sort((a, b) => (at.get(a.rid) ?? 0) - (at.get(b.rid) ?? 0));
    const got = new Set(out.map(o => o.rid));
    for (const rid of rids) {
      if (got.has(rid) || failed[rid] || missing.includes(rid)) continue;
      if (!RID.test(rid)) missing.push(rid);
      else failed[rid] = 'The read answered without this object';
    }
    for (const rid of got) delete failed[rid];
    return { summaries: out, posts, missing: missing.filter(r => !got.has(r)), failed };
  };
  if (client.executeEcEach) {
    const valid = stableRidOrder(rids).filter(rid => RID.test(rid));
    const answers = await client.executeEcEach(buildContextSummaryEc(), valid, signal);
    posts = Math.ceil(valid.length / CONTEXT_PER_POST);
    const frame = newFrame();
    for (const [rid, r] of answers) {
      // An object that is not there fails alone and is reported as missing;
      // a lost connection or session fails the read; any other failure is
      // reported so the caller can ask again.
      if (!r.ok || r.log == null) {
        if (r.errorKind && isConnectionKind(r.errorKind)) throw new Error(r.error || 'The object summaries could not be read');
        if (isNotThereError(`${r.error ?? ''} ${r.log ?? ''}`)) missing.push(rid);
        else failed[rid] = r.error || r.log || 'The object summary could not be read';
        continue;
      }
      const rows = parseSummariesLog(r.log, frame);
      // The command ran on the object and wrote no row: there is no such
      // object (BMP runs the script with an empty context).
      if (!rows.some(row => row.rid === rid)) missing.push(rid);
      out.push(...rows);
    }
    return settle();
  }
  const refs = await client.resolveRefs(rids, signal);
  // One order for one set of objects: the same question is the same script.
  const items = stableRidOrder(rids).flatMap(rid => {
    const ref = refs.get(rid);
    if (typeof ref === 'string') return [{ rid, ref }];
    // A RID that does not resolve is not there; a lookup that failed is not known.
    if (ref instanceof Error && !isNotThereError(ref.message)) failed[rid] = ref.message;
    else missing.push(rid);
    return [];
  });
  for (let i = 0; i < items.length; i += SUMMARIES_PER_SCRIPT) {
    const frame = newFrame();
    const r = await client.executeEc(buildSummariesEc(items.slice(i, i + SUMMARIES_PER_SCRIPT), frame), undefined, false, signal);
    posts++;
    if (!r.ok || r.log == null) throw new Error(r.error || r.log || 'The object summaries could not be read');
    out.push(...parseSummariesLog(r.log, frame));
  }
  return settle();
}
