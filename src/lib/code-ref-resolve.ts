/**
 * Batched resolve of code references (service-worker side, pure parts).
 *
 * Many references → ONE read-only Extended Code post that answers, for each
 * reference: RID (string), class, name, business ID and the property that
 * holds its code, or nothing (not found). The code itself is not sent: it is
 * read on the first peek through the object read (READ_FULL_OBJECTS).
 *
 * Safety and cost:
 *  - every key is re-validated (`parseRefKey`); a dot-form ID is written as
 *    `t.some_id` (works on every server), an ID with `-` or `.` as a quoted
 *    `t.get("…")` literal, a RID as `lookup(<digits>)`;
 *  - free text travels in the length-framed rows of ec-parser (constant
 *    markers); keys are sorted, so the same code view asks the same script;
 *  - rows go into a short chunk that is added to the result every few
 *    objects (`appendEc` / `flushChunkEc`), never one growing string;
 *  - code is checked with `output(…)`, which reads the text without running
 *    it, and only on classes that keep code in `expression`.
 *
 * A failed post (an older server without `get`, one object BMP cannot read)
 * is halved until the failing keys are isolated (`readIsolating`), exactly
 * like the batched object reads.
 */

import { appendRowEc, contextObjectEc, EC_CHUNK, EC_FRAME, objectLoopEc, parseFramedLog, type EcFrame } from './ec-parser';
import { CONTEXT_PER_POST } from './constants';
import { parseRefKey } from './code-refs';
import { ecString } from './ec-guards';
import { constantScript, varyingScript } from './script-kinds';
import { resolveRefRids } from './ref-rid';
import { isObjectLevelError, readIsolating } from './batch-isolate';
import { ecResultError, type BmpErrorKind } from './error-kind';

export interface RefTarget {
  /** 64-bit RID, always a string. */
  rid: string;
  type: string;
  name: string;
  businessId: string;
  /** Property that holds the target's code, when it has code. */
  codeProp?: string;
  /** The object's model key (for example DEFAULTS), when the built-in by-ID
   *  lookup answered the reference: it comes in that answer at no extra
   *  cost. RID keys and script lookups leave it out. */
  model?: string;
}

export type RefResolution = { found: true; target: RefTarget } | { found: false; error?: string };

/** Keys per resolve request. The window asks for one code view at a time. */
export const REF_BATCH_MAX = 80;
/** Rows collected in the chunk before it is added to the result. */
const CHUNK_EVERY = 8;

/** Classes whose code is their `expression` (checked for emptiness). */
export const EXPRESSION_CODE_CLASSES: readonly string[] = [
  'ExtendedExpression', 'ExtendedMethodConfig', 'ExtendedTransport', 'ExtendedTable', 'ButtonInput', 'ActionButton',
  'CustomVisualizationExpression', 'EditPageInfo', 'Label', 'ReferenceMethodConfig', 'HistoricalReferenceMethodConfig',
];

/** EC expression that evaluates to the referenced object, or null for a key
 *  that is not a reference. */
export function refExpression(key: string): string | null {
  const p = parseRefKey(key);
  if (!p) return null;
  if (!p.ns) return `lookup(${p.id})`;
  if (/^[A-Za-z0-9_]+$/.test(p.id)) return `${p.ns}.${p.id}`;
  return `${p.ns}.get(${ecString(p.id)})`;
}

/** One loop over `[index, object]` pairs (ec-parser objectLoopEc): the
 *  class test and the code check are written once, and the script changes
 *  only in its list line. A key whose object does not exist writes no row:
 *  its pair holds MISSING or only the index (`_p.size()` is then 1). */
export function buildRefResolveEc(keys: readonly string[], _frame: EcFrame = EC_FRAME): string {
  const pairs: string[] = [];
  keys.forEach((key, i) => {
    const expr = refExpression(key);
    if (expr) pairs.push(`LIST("${i}", ${expr})`);
  });
  const body = [
    '_pn := _p.size()',
    'IF _pn = 2 THEN',
    '     _o := _p.last()',
    '     IF _o != MISSING THEN',
    ...refRowLines('_p.first()').map(l => `          ${l}`),
    '     ENDIF',
    'ENDIF',
  ];
  return varyingScript('buildRefResolveEc', objectLoopEc(pairs, '_p', body, CHUNK_EVERY).join('\n'));
}

/** The row of `_o`: index, RID, class, name, ID, code property. */
function refRowLines(index: string): string[] {
  const isExpr = EXPRESSION_CODE_CLASSES.map(c => `_cls = "${c}"`).join(' OR ');
  return [
    '_cls := _o.className.whenMissing("")',
    `_cp := (IF ${isExpr} THEN (IF str(output(_o.expression.whenMissing(""))) = "" THEN "" ELSE "expression" ENDIF) ELSE (IF _cls = "CustomVisualization" THEN "javascript" ELSE "" ENDIF) ENDIF)`,
    ...appendRowEc(EC_CHUNK, [index, '_o.rid.whenMissing("")', '_cls', '_o.name.whenMissing("")', '_o.id.whenMissing("")', '_cp']),
  ];
}

/** A RID key's object as the command's context: ONE constant script for
 *  every RID key (BmpClient.executeEcEach). Its index field is 0. */
export function buildContextRefResolveEc(): string {
  return constantScript('buildContextRefResolveEc', contextObjectEc('_o', refRowLines('"0"')).join('\n'));
}

/** Rows of `buildRefResolveEc`, keyed by the request's keys. A key without a
 *  row, or with an empty RID, is not found. Throws on a cut-off answer. */
export function parseRefResolveLog(log: string, frame: EcFrame, keys: readonly string[]): Record<string, RefResolution> {
  const out: Record<string, RefResolution> = {};
  for (const k of keys) out[k] = { found: false };
  for (const [idx, rid, type, name, businessId, codeProp] of parseFramedLog(log, frame, 6)) {
    const key = keys[Number(idx)];
    if (key == null || !/^-?\d{1,20}$/.test(rid.trim())) continue;
    out[key] = {
      found: true,
      target: { rid: rid.trim(), type: type.trim(), name, businessId: businessId.trim(), ...(codeProp.trim() ? { codeProp: codeProp.trim() } : {}) },
    };
  }
  return out;
}

export interface RefEcRun {
  ok: boolean;
  log?: string;
  error?: string;
  errorKind?: BmpErrorKind;
}

/** Resolve `keys` with as few posts as possible: one post for the whole
 *  batch; a failed post is halved until the failing keys are isolated. A
 *  key that fails alone is "not found" with the error. Connection failures
 *  throw. */
export async function resolveRefsIsolating(
  keys: readonly string[],
  run: (code: string, frame: EcFrame) => Promise<RefEcRun>,
  newFrame: () => EcFrame,
  /** Constant scripts with the object as the command context (BmpClient):
   *  RID keys go this way, one command each; ID keys keep the loop script. */
  each?: (code: string, objectRids: readonly string[]) => Promise<Map<string, RefEcRun>>,
  /** The built-in by-ID lookup (id-lookup lookupRefsByCommand): ID keys go
   *  this way first, with no script; a key it does not answer (undefined),
   *  or every key when it fails, falls back to the small varying script. */
  byId?: (refs: ReadonlyArray<{ key: string; ns: string; id: string }>) => Promise<Map<string, string | null | undefined> | undefined>,
): Promise<{ results: Record<string, RefResolution>; posts: number }> {
  const valid = [...new Set(keys)].filter(k => refExpression(k) != null).slice(0, REF_BATCH_MAX).sort();
  const results: Record<string, RefResolution> = {};
  for (const k of keys) if (!valid.includes(k)) results[k] = { found: false };
  if (!valid.length) return { results, posts: 0 };
  let posts = 0;
  const ridKeys = each ? valid.filter(k => !parseRefKey(k)?.ns) : [];
  // An ID key with the context path: the built-in by-ID lookup finds its RID
  // (`byId`; a small varying script, ref-rid, when it cannot), the constant
  // script reads the row on that object.
  const idKeys = each ? valid.filter(k => !!parseRefKey(k)?.ns) : [];
  const ridOfKey = new Map<string, string>(ridKeys.map(k => [k, parseRefKey(k)!.id]));
  // The by-ID lookup first: no script text reaches the server's parse cache.
  let byScript = idKeys;
  if (idKeys.length && byId) {
    const answered = await byId(idKeys.map(k => ({ key: k, ...parseRefKey(k)! }))).catch(() => undefined);
    if (answered) {
      posts++;
      byScript = [];
      for (const k of idKeys) {
        const v = answered.get(k);
        if (v === undefined) byScript.push(k);
        else if (v === null) results[k] = { found: false };
        else ridOfKey.set(k, v);
      }
    }
  }
  if (byScript.length) {
    const exprs = new Map(byScript.map(k => [k, refExpression(k)!] as const));
    let lookups = 0;
    const found = await resolveRefRids([...exprs.values()], async code => { lookups++; const frame = newFrame(); return run(code, frame); });
    posts += lookups;
    for (const k of byScript) {
      const v = found.get(exprs.get(k)!);
      if (v instanceof Error) results[k] = { found: false, error: v.message };
      else if (!v) results[k] = { found: false };
      else ridOfKey.set(k, v);
    }
  }
  const viaContext = [...ridOfKey.keys()];
  if (viaContext.length) {
    const rids = [...new Set(ridOfKey.values())];
    const answers = await each!(buildContextRefResolveEc(), rids);
    posts += Math.ceil(rids.length / CONTEXT_PER_POST);
    const frame = newFrame();
    for (const k of viaContext) {
      const r = answers.get(ridOfKey.get(k)!);
      if (!r?.ok) {
        const error = ecResultError(r ?? { ok: false, error: 'No answer' }, 'Reference lookup failed');
        if (!isObjectLevelError(error)) throw error;
        results[k] = { found: false, error: error.message };
        continue;
      }
      try { results[k] = parseRefResolveLog(r.log ?? '', frame, [k])[k]; } catch (e) { results[k] = { found: false, error: e instanceof Error ? e.message : String(e) }; }
    }
  }
  const rest = valid.filter(k => !ridKeys.includes(k) && !idKeys.includes(k));
  if (!rest.length) return { results, posts };
  const isolated = await readIsolating(rest, async batch => {
    const frame = newFrame();
    const r = await run(buildRefResolveEc(batch, frame), frame);
    if (!r.ok) throw ecResultError(r, 'Reference lookup failed');
    return parseRefResolveLog(r.log ?? '', frame, batch);
  });
  for (const part of isolated.results) Object.assign(results, part);
  for (const [k, error] of Object.entries(isolated.failed)) results[k] = { found: false, error };
  for (const k of isolated.unresolved) results[k] = { found: false, error: isolated.error ?? 'Reference lookup failed' };
  return { results, posts: posts + isolated.requests };
}
