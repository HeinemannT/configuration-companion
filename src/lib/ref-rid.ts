/**
 * An object named in text (a business ID with its ID space: `t.some_id`,
 * `ceras.get("x-1")`) to its RID, with the least script text.
 *
 * The name has to be in the script, so the script is VARYING: every new name
 * is a new entry in the server's parse cache (script-kinds.ts). It therefore
 * only looks the objects up and returns their RIDs; everything else about
 * them is read with a constant script that has the object as the command's
 * context (executeEcOn / executeEcEach). Names are grouped so that one
 * script stays within SCRIPT_LIMITS.varying.
 *
 * Wire: `|<rid>` per expression in order (empty when the object does not
 * exist), then `|#END`. RIDs are digits, so nothing needs framing.
 */

import { SCRIPT_LIMITS, varyingScript } from './script-kinds';
import { readIsolating } from './batch-isolate';
import { ecResultError } from './error-kind';

const RID = /^-?\d{1,20}$/;
const END = '#END';

/** One line per expression; `prelude` binds shared values (e.g. `_k := "…"`). */
export function buildRefRidsEc(exprs: readonly string[], prelude: readonly string[] = []): string {
  if (!exprs.length) throw new Error('Nothing to look up');
  const lines = [...prelude, '_r := ""'];
  for (const e of exprs) lines.push(`_r := _r + "|" + str(${e}.rid.whenMissing(""))`);
  lines.push(`_r + "|${END}"`);
  return varyingScript('buildRefRidsEc', lines.join('\n'));
}

/** Groups of expressions whose script fits SCRIPT_LIMITS.varying, in order.
 *  An expression too long for a script of its own is refused (null). */
export function groupRefExprs(exprs: readonly string[], prelude: readonly string[] = []): Array<string[] | null> {
  const out: Array<string[] | null> = [];
  let cur: string[] = [];
  const fits = (g: string[]) => buildRefRidsEc(g, prelude).length <= SCRIPT_LIMITS.varying;
  for (const e of exprs) {
    if (!fits([e])) { if (cur.length) out.push(cur); cur = []; out.push(null); continue; }
    if (cur.length && !fits([...cur, e])) { out.push(cur); cur = []; }
    cur.push(e);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** RIDs of buildRefRidsEc, one per expression ('' when not found). Throws on
 *  a cut-off or damaged answer. */
export function parseRefRidsLog(log: string, n: number): string[] {
  const line = log.split('\n').map(l => l.replace(/^Result : /, '').trim()).find(l => l.endsWith(`|${END}`));
  if (line == null) throw new Error('The lookup came back incomplete');
  const parts = line.slice(0, -(END.length + 1)).split('|').slice(1).map(s => s.trim());
  if (parts.length !== n || parts.some(p => p && !RID.test(p))) throw new Error('The lookup holds a damaged answer');
  return parts;
}

export interface RefRidRun { ok: boolean; log?: string; error?: string; errorKind?: import('./error-kind').BmpErrorKind }

/**
 * Look `exprs` up: expression → RID, null (no such object) or the Error of
 * an expression the server refused alone. A failed script is halved until
 * the failing expression is found (batch-isolate). `run` sends one script.
 */
export async function resolveRefRids(exprs: readonly string[], run: (code: string) => Promise<RefRidRun>, prelude: readonly string[] = []): Promise<Map<string, string | null | Error>> {
  const out = new Map<string, string | null | Error>();
  const unique = [...new Set(exprs)];
  const groups = groupRefExprs(unique, prelude);
  let k = 0;
  for (const g of groups) {
    if (!g) { out.set(unique[k], new Error('This reference is too long to look up')); k++; continue; }
    k += g.length;
    const read = await readIsolating(g, async batch => {
      const r = await run(buildRefRidsEc(batch, prelude));
      if (!r.ok || r.log == null) throw ecResultError(r, 'The lookup failed');
      const rids = parseRefRidsLog(r.log, batch.length);
      return new Map(batch.map((e, i) => [e, rids[i] || null] as const));
    }, { maxRequests: g.length * 2 });
    for (const found of read.results) for (const [e, rid] of found) out.set(e, rid);
    for (const [e, message] of Object.entries(read.failed)) out.set(e, new Error(message));
    for (const e of read.unresolved) out.set(e, new Error(read.error ?? 'The lookup failed'));
  }
  return out;
}
