/**
 * Access mode of the object window: the shared, DOM-free part used by both
 * the service worker (batched decisions) and the window (state and view).
 *
 * BMP makes every access decision. This module only reads what a trace
 * says: the top-level result is the verdict, a Statement whose result is
 * true is a statement that granted access. It does not rank statements and
 * does not apply deny-overrides; a deny statement that matched is reported
 * as a fact next to the server's verdict, never as the reason for it.
 *
 * Request shape (observed on BMP 5.6.17):
 *  - READ, UPDATE and DELETE accept several resources in one
 *    AccessTraceCommand and answer one trace per resource;
 *  - CREATE ignores the resource and evaluates the `new.*` values in the
 *    updates (the trace reports an empty resource). "Add child" for an
 *    existing node therefore names that node as `new.parent` and sends no
 *    type and no other values: one command per node.
 * Several commands go in one request; BMP answers them in order.
 */

import type { AccessTraceNode } from './types';
import type { AccessTraceUpdates } from './bmp-types';

export type AccessAction = 'READ' | 'UPDATE' | 'CREATE' | 'DELETE';

export interface AccessActionInfo {
  key: AccessAction;
  /** Column letter in the structure tree. */
  letter: 'R' | 'W' | 'A' | 'D';
  label: string;
  /** "<subject> can <verb> <node>". */
  verb: string;
}

export const ACCESS_ACTIONS: readonly AccessActionInfo[] = [
  { key: 'READ', letter: 'R', label: 'Read', verb: 'read' },
  { key: 'UPDATE', letter: 'W', label: 'Write', verb: 'write to' },
  { key: 'CREATE', letter: 'A', label: 'Add child', verb: 'add a child under' },
  { key: 'DELETE', letter: 'D', label: 'Delete', verb: 'delete' },
];

export function actionInfo(key: AccessAction): AccessActionInfo {
  return ACCESS_ACTIONS.find(a => a.key === key) ?? ACCESS_ACTIONS[0];
}

/** One statement of a policy, as the trace names it. */
export interface StatementRef {
  policyRid: string;
  policyName: string;
  /** 0-based, as BMP reports it. Shown 1-based. */
  index: number;
  effect: string;
  /** Subject token that matched, e.g. `role:roleBasic` or `user:maya_chen`. */
  via?: string;
}

/** The server's answer for one node and action, reduced for the tree. */
export type Verdict =
  | { state: 'allowed'; by: StatementRef[]; evaluated: number }
  | { state: 'denied'; evaluated: number; denyMatched: StatementRef[] }
  | { state: 'unknown'; reason: string };

export type ActionVerdicts = Partial<Record<AccessAction, Verdict>>;

// ── reading a trace ────────────────────────────────────────────────

const REQUEST_NODES = new Set(['TraceRequest', 'Access request']);

/** Top-level statements of a trace (not the ones inside a nested
 *  HasAccessTo request: those belong to a different decision). */
export function topStatements(trace: AccessTraceNode): AccessTraceNode[] {
  const out: AccessTraceNode[] = [];
  const walk = (n: AccessTraceNode) => {
    for (const c of n.children) {
      if (c.element === 'Statement') out.push(c);
      else if (!REQUEST_NODES.has(c.element)) walk(c);
    }
  };
  walk(trace);
  return out;
}

export function statementRef(node: AccessTraceNode): StatementRef {
  const d = node.details;
  const subject = node.children.find(c => c.element === 'Subject');
  const via = subject?.details.globalMatchEntity || subject?.details.localMatchEntity || undefined;
  const index = /^\d+$/.test(d.statementIndex ?? '') ? Number(d.statementIndex) : -1;
  return {
    policyRid: d.policyRid ?? '',
    policyName: d.policyRid_name || d.policyRid || 'Policy',
    index,
    effect: (d.effect ?? '').toUpperCase(),
    ...(via ? { via } : {}),
  };
}

export type StatementStage = 'matched' | 'failed' | 'skipped' | 'unknown';
const stage = (n?: AccessTraceNode): StatementStage =>
  !n ? 'skipped' : n.timedOut || n.result == null ? 'unknown' : n.result ? 'matched' : 'failed';

/** Why a statement did not grant, in the words of its first failed part. */
export function statementOutcome(node: AccessTraceNode): { grants: boolean; denyMatched: boolean; why: string } {
  if (node.timedOut) return { grants: false, denyMatched: false, why: 'Timed out' };
  if (node.result === true) return { grants: true, denyMatched: false, why: 'Granted' };
  const subject = stage(node.children.find(c => c.element === 'Subject'));
  const action = stage(node.children.find(c => c.element === 'Action'));
  const rest = node.children.filter(c => c.element !== 'Subject' && c.element !== 'Action');
  const restOk = rest.every(c => c.result === true && !c.timedOut);
  const deny = (node.details.effect ?? '').toUpperCase() === 'DENY';
  if (deny && subject === 'matched' && action === 'matched' && restOk) return { grants: false, denyMatched: true, why: 'Deny statement matched' };
  if (subject === 'failed') return { grants: false, denyMatched: false, why: 'Subject does not match' };
  if (action === 'failed') return { grants: false, denyMatched: false, why: 'Action does not match' };
  if (subject === 'unknown' || action === 'unknown' || rest.some(c => c.timedOut || c.result == null)) return { grants: false, denyMatched: false, why: 'Not fully evaluated' };
  if (!restOk) return { grants: false, denyMatched: false, why: 'Condition false' };
  return { grants: false, denyMatched: false, why: 'Does not grant' };
}

/** BMP action names in the window's words: `CREATE` → "Add child".
 *  Unknown names stay as BMP wrote them. */
export function actionWords(raw: string): string {
  return raw.split(',').map(s => s.trim()).filter(Boolean)
    .map(s => ACCESS_ACTIONS.find(a => a.key === s.toUpperCase())?.label ?? s).join(', ');
}

const MISS_WORDS: Record<string, [string, string]> = {
  'Subject does not match': ['for another subject', 'for other subjects'],
  'Action does not match': ['for another action', 'for other actions'],
  'Condition false': ['failed a condition', 'failed a condition'],
  'Deny statement matched': ['matched Deny (grants nothing)', 'matched Deny (grant nothing)'],
  'Not fully evaluated': ['not fully evaluated', 'not fully evaluated'],
  'Timed out': ['timed out', 'timed out'],
  'Does not grant': ['does not grant', 'do not grant'],
};

/** One muted line on why statements did not grant, most common reason
 *  first: "41 for other subjects · 10 for other actions · 2 failed a condition". */
export function notGrantingSummary(statements: readonly AccessTraceNode[], max = 3): string {
  const counts = new Map<string, number>();
  for (const s of statements) {
    const why = statementOutcome(s).why;
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const words = ([why, n]: [string, number]) => {
    const w = MISS_WORDS[why] ?? [why.toLowerCase(), why.toLowerCase()];
    return `${n} ${n === 1 ? w[0] : w[1]}`;
  };
  if (sorted.length <= max) return sorted.map(words).join(' · ');
  const head = sorted.slice(0, max - 1);
  const rest = statements.length - head.reduce((x, [, n]) => x + n, 0);
  return [...head.map(words), `${rest} other`].join(' · ');
}

/** The verdict as BMP returned it. A missing trace or a trace without a
 *  boolean result is "could not evaluate", never denied. */
export function verdictFromTrace(trace: AccessTraceNode | null | undefined): Verdict {
  if (!trace) return { state: 'unknown', reason: 'BMP returned no decision.' };
  if (trace.timedOut) return { state: 'unknown', reason: 'BMP stopped the evaluation (timed out).' };
  if (trace.result == null) return { state: 'unknown', reason: 'BMP returned no decision.' };
  const statements = topStatements(trace);
  if (trace.result) {
    return { state: 'allowed', by: statements.filter(s => s.result === true && !s.timedOut).map(statementRef), evaluated: statements.length };
  }
  return { state: 'denied', evaluated: statements.length, denyMatched: statements.filter(s => statementOutcome(s).denyMatched).map(statementRef) };
}

// ── batched requests ───────────────────────────────────────────────

export interface TraceCommand {
  action: AccessAction;
  rids: string[];
  /** CREATE only: the node named as `new.parent`. */
  updates?: AccessTraceUpdates;
}

/** Trace depth for verdict batches. BMP still evaluates nested HasAccessTo
 *  checks fully; the depth only trims their trace. Measured on 35 subjects ×
 *  10 nodes × 4 actions: identical verdicts at depth 1 and 10. */
export const DECISION_DEPTH = 1;
/** Trace depth for the trace the user reads. */
export const TRACE_DEPTH = 10;
/** Nodes per decision request (≈ 0.35 s and 1.6 MB of trace on BMP 5.6). */
export const DECISION_CHUNK = 10;

/** The updates that make CREATE mean "add a child under `rid`". */
export function addChildUpdates(rid: string): AccessTraceUpdates {
  return { type: '', parent_rid: rid };
}

/** Commands for `rids`: READ, UPDATE and DELETE each for all rids, then one
 *  CREATE per rid. */
export function planDecisionCommands(rids: readonly string[]): TraceCommand[] {
  const list = [...rids];
  return [
    { action: 'READ', rids: list },
    { action: 'UPDATE', rids: list },
    { action: 'DELETE', rids: list },
    ...list.map(rid => ({ action: 'CREATE' as const, rids: [rid], updates: addChildUpdates(rid) })),
  ];
}

/** Pair each command's traces with the nodes it asked for. Traces of a
 *  multi-resource command are matched by their reported resource rid, never
 *  by position alone; a node without a trace gets "could not evaluate". */
export function matchDecisionTraces(commands: readonly TraceCommand[], traces: ReadonlyArray<readonly AccessTraceNode[]>): Record<string, ActionVerdicts> {
  if (traces.length !== commands.length) throw new Error(`BMP answered ${traces.length} of ${commands.length} access checks.`);
  const out: Record<string, ActionVerdicts> = {};
  commands.forEach((cmd, i) => {
    const list = traces[i];
    for (const rid of cmd.rids) {
      let t: AccessTraceNode | undefined;
      if (cmd.action === 'CREATE') t = list[0];
      else t = list.find(x => x.details.resource === rid) ?? (cmd.rids.length === 1 && list.length === 1 && !list[0].details.resource ? list[0] : undefined);
      (out[rid] ??= {})[cmd.action] = verdictFromTrace(t);
    }
  });
  return out;
}

/** An answer that means the server does not know the access-trace command
 *  (older BMP), as opposed to a failed decision. */
export function isTraceUnavailable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /ClassNotFound|NoClassDefFound|InvalidClassException|serialVersionUID|unknown command|command not supported|no such command/i.test(msg);
}

export const UNAVAILABLE_REASON = 'This BMP version has no access test command.';

// ── text ───────────────────────────────────────────────────────────

/** `role:roleBasic` → `role roleBasic` with the subject name when known. */
export function viaLabel(via: string | undefined, nameOf: (kind: 'user' | 'role', id: string) => string | undefined): string | undefined {
  if (!via) return undefined;
  const m = /^(role|user|group):(.+)$/.exec(via.trim());
  if (!m) return via;
  const kind = m[1] as 'user' | 'role' | 'group';
  const name = kind === 'group' ? undefined : nameOf(kind, m[2]);
  return name && name !== m[2] ? `${kind} ${name} (${m[2]})` : `${kind} ${m[2]}`;
}
