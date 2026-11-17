/**
 * Service-worker side of the object window's access mode: the subject list
 * (once per environment and session), the availability check, and batched
 * decisions. No chrome.*: the handler (handlers/access.ts) supplies the
 * client and the environment check, so this is unit-testable.
 */

import type { AccessSubject, AccessTraceNode, AccessTraceAction } from './types';
import type { AccessTraceUpdates } from './bmp-types';
import { readIsolating, isObjectLevelError } from './batch-isolate';
import {
  ACCESS_ACTIONS, DECISION_DEPTH, TRACE_DEPTH, UNAVAILABLE_REASON, addChildUpdates, isTraceUnavailable,
  matchDecisionTraces, planDecisionCommands, type ActionVerdicts,
} from './access-mode';

export interface AccessModeClient {
  listAccessSubjects(): Promise<AccessSubject[]>;
  fetchAccessTraces(
    subjectRid: string,
    commands: ReadonlyArray<{ action: AccessTraceAction; rids: readonly string[]; updates?: AccessTraceUpdates }>,
    depth: number,
    signal?: AbortSignal,
  ): Promise<AccessTraceNode[][]>;
}

export interface Availability { available: boolean; reason?: string }

/** Most nodes one decision request may name (the window sends chunks of
 *  DECISION_CHUNK). */
export const MAX_DECISION_RIDS = 50;

const RID = /^\d+$/;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AccessModeService {
  private subjects = new Map<string, AccessSubject[]>();
  private loading = new Map<string, Promise<AccessSubject[]>>();
  private availability = new Map<string, Availability>();

  /** Cached availability for an environment, without a BMP request. */
  status(environment: string): Availability | undefined {
    return this.availability.get(environment);
  }

  /** Seed the list from session storage after a worker restart. */
  seedSubjects(environment: string, subjects: AccessSubject[]): void {
    if (!this.subjects.has(environment)) this.subjects.set(environment, subjects);
  }

  cachedSubjects(environment: string): AccessSubject[] | undefined {
    return this.subjects.get(environment);
  }

  /** Subjects (loaded once per environment) and whether the server knows
   *  the access-trace command. The first call probes with one READ trace. */
  async prepare(client: AccessModeClient, environment: string, assertEnvironment: () => void): Promise<{ subjects: AccessSubject[] } & Availability> {
    const subjects = await this.loadSubjects(client, environment, assertEnvironment);
    let avail = this.availability.get(environment);
    if (!avail) {
      if (!subjects.length) {
        // Not cached: a later attempt may read them.
        return { subjects, available: false, reason: 'No users or roles can be read on this connection. Access tests need Configuration Studio access.' };
      }
      try {
        const probe = subjects[0].rid;
        await client.fetchAccessTraces(probe, [{ action: 'READ', rids: [probe] }], DECISION_DEPTH);
        avail = { available: true };
      } catch (e) {
        if (!isTraceUnavailable(e)) return { subjects, available: true };
        avail = { available: false, reason: UNAVAILABLE_REASON };
      }
      assertEnvironment();
      this.availability.set(environment, avail);
    }
    return { subjects, ...avail };
  }

  private loadSubjects(client: AccessModeClient, environment: string, assertEnvironment: () => void): Promise<AccessSubject[]> {
    const have = this.subjects.get(environment);
    if (have) return Promise.resolve(have);
    let p = this.loading.get(environment);
    if (!p) {
      p = client.listAccessSubjects().then(list => {
        assertEnvironment();
        this.subjects.set(environment, list);
        return list;
      }).finally(() => this.loading.delete(environment));
      this.loading.set(environment, p);
    }
    return p;
  }

  /** Mark the command unavailable after a decision request proved it. */
  markUnavailable(environment: string): void {
    this.availability.set(environment, { available: false, reason: UNAVAILABLE_REASON });
  }

  /** Verdicts for `rids` × the four actions, in as few requests as
   *  possible. One bad node is isolated by halving (batch-isolate); its
   *  actions come back as "could not evaluate" with BMP's message. */
  async decide(client: AccessModeClient, environment: string, subjectRid: string, rids: readonly string[], assertEnvironment: () => void): Promise<{ verdicts: Record<string, ActionVerdicts>; unavailable?: boolean }> {
    if (!RID.test(subjectRid)) throw new Error('Not a subject RID.');
    const list = [...new Set(rids)];
    if (!list.length || list.length > MAX_DECISION_RIDS || list.some(r => !RID.test(r))) throw new Error(`Send 1 to ${MAX_DECISION_RIDS} object RIDs.`);
    // A switched connection fails the whole request; it is never split
    // and reported per node.
    let changed: unknown;
    const check = () => { try { assertEnvironment(); } catch (e) { changed = e; throw e; } };
    check();
    let res;
    try {
      res = await readIsolating(list, async batch => {
        const commands = planDecisionCommands(batch);
        const traces = await client.fetchAccessTraces(subjectRid, commands, DECISION_DEPTH);
        check();
        return matchDecisionTraces(commands, traces);
      }, { splittable: e => e !== changed && isObjectLevelError(e) && !isTraceUnavailable(e) });
    } catch (e) {
      if (isTraceUnavailable(e)) {
        this.markUnavailable(environment);
        return { verdicts: {}, unavailable: true };
      }
      throw e;
    }
    const verdicts: Record<string, ActionVerdicts> = {};
    for (const part of res.results) Object.assign(verdicts, part);
    const fail = (rid: string, reason: string) => {
      verdicts[rid] = Object.fromEntries(ACCESS_ACTIONS.map(a => [a.key, { state: 'unknown', reason }]));
    };
    for (const [rid, msg] of Object.entries(res.failed)) fail(rid, `BMP rejected the check for this node: ${msg}`);
    for (const rid of res.unresolved) fail(rid, res.error ?? 'BMP did not answer for this node.');
    return { verdicts };
  }

  /** The full trace the user reads for one node and action. */
  async trace(client: AccessModeClient, environment: string, subjectRid: string, rid: string, action: AccessTraceAction, assertEnvironment: () => void): Promise<{ trace?: AccessTraceNode; unavailable?: boolean }> {
    if (!RID.test(subjectRid) || !RID.test(rid)) throw new Error('Not an object RID.');
    if (!ACCESS_ACTIONS.some(a => a.key === action)) throw new Error('Unknown access action.');
    assertEnvironment();
    try {
      const lists = await client.fetchAccessTraces(subjectRid, [{ action, rids: [rid], ...(action === 'CREATE' ? { updates: addChildUpdates(rid) } : {}) }], TRACE_DEPTH);
      assertEnvironment();
      const trace = lists[0]?.[0];
      if (!trace) throw new Error('BMP returned no access decision.');
      return { trace };
    } catch (e) {
      if (isTraceUnavailable(e)) {
        this.markUnavailable(environment);
        return { unavailable: true };
      }
      throw new Error(message(e));
    }
  }
}
