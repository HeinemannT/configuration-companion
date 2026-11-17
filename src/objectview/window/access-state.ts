/**
 * Access mode state for the object window — no DOM, no chrome.*.
 *
 * Holds the chosen subject (kept across node selection, in-window
 * navigation and, through `AccessSource.savePrefs`, a reopened window), the
 * subject list, the verdicts of the visible nodes, and the trace of the
 * selected node and action.
 *
 * Every request carries an id and the context it was sent for (environment,
 * subject, node-set generation). An answer is applied only when that
 * context is still the current one and the node is still visible, so a slow
 * answer for an earlier subject, object or connection never overwrites a
 * newer one. A node without a decision is "could not evaluate" with the
 * reason, never blank.
 */

import type { AccessSubject, AccessTraceNode } from '../../lib/types';
import {
  ACCESS_ACTIONS, DECISION_CHUNK, UNAVAILABLE_REASON, verdictFromTrace, type AccessAction, type ActionVerdicts, type Verdict,
} from '../../lib/access-mode';

export interface DecideAnswer {
  requestId: string;
  environment: string;
  subjectRid: string;
  ok: boolean;
  verdicts?: Record<string, ActionVerdicts>;
  unavailable?: boolean;
  error?: string;
}

export interface TraceAnswer {
  requestId: string;
  environment: string;
  subjectRid: string;
  rid: string;
  action: AccessAction;
  ok: boolean;
  trace?: AccessTraceNode;
  unavailable?: boolean;
  error?: string;
}

export interface PrepareAnswer {
  subjects: AccessSubject[];
  available: boolean;
  reason?: string;
  environmentName?: string;
}

export interface AccessPrefs {
  subject?: AccessSubject | null;
  recents: string[];
}

/** How the state reaches the service worker. Promises reject on timeout or
 *  a lost response; the state turns that into "could not evaluate". */
export interface AccessSource {
  status(environment: string): Promise<{ available?: boolean; reason?: string }>;
  prepare(environment: string): Promise<PrepareAnswer>;
  decide(req: { requestId: string; environment: string; subjectRid: string; rids: string[] }): Promise<DecideAnswer>;
  trace(req: { requestId: string; environment: string; subjectRid: string; rid: string; action: AccessAction }): Promise<TraceAnswer>;
  loadPrefs(environment: string): Promise<AccessPrefs>;
  savePrefs(environment: string, prefs: AccessPrefs): void;
}

export type Availability = 'unknown' | 'checking' | 'available' | 'unavailable';
export type CellState = Verdict | { state: 'loading' } | { state: 'idle' };
export type TraceState = { loading: true; id: string } | { trace: AccessTraceNode } | { error: string };

interface Pending { rids: string[]; environment: string; subjectRid: string; gen: number }

const RECENT_MAX = 6;
/** Decision requests in flight at once (the rest queue, top of the tree first). */
const CONCURRENCY = 2;

export class AccessMode {
  private _on = false;
  private _env: string | undefined;
  private _envName = '';
  private _availability: Availability = 'unknown';
  private _reason: string | undefined;
  private _subjects: AccessSubject[] | null = null;
  private _subjectsLoading = false;
  private _subjectsError: string | undefined;
  private _subject: AccessSubject | null = null;
  private _recents: string[] = [];
  private _action: AccessAction = 'READ';
  private _selected: string | undefined;
  private nodes: string[] = [];
  private nodeSet = new Set<string>();
  private gen = 0;
  private verdicts = new Map<string, ActionVerdicts>();
  private asked = new Set<string>();
  private pending = new Map<string, Pending>();
  private traces = new Map<string, TraceState>();
  private _evaluatedAt: number | undefined;
  private seq = 0;
  private scheduled = false;
  private prefsFor: string | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly source: AccessSource, private readonly opts: { now?: () => number; defer?: (fn: () => void) => void } = {}) {}

  // ── reading ────────────────────────────────────────────────────

  get on(): boolean { return this._on; }
  get environment(): string | undefined { return this._env; }
  get environmentName(): string { return this._envName; }
  get availability(): Availability { return this._availability; }
  get unavailableReason(): string | undefined { return this._availability === 'unavailable' ? this._reason : undefined; }
  get subjects(): readonly AccessSubject[] | null { return this._subjects; }
  get subjectsLoading(): boolean { return this._subjectsLoading; }
  get subjectsError(): string | undefined { return this._subjectsError; }
  get subject(): AccessSubject | null { return this._subject; }
  get recents(): readonly string[] { return this._recents; }
  get action(): AccessAction { return this._action; }
  get selected(): string | undefined { return this._selected; }
  get evaluatedAt(): number | undefined { return this._evaluatedAt; }

  /** The cell for one node and action as the tree and the strip show it. */
  cell(rid: string, action: AccessAction): CellState {
    if (!this._subject) return { state: 'idle' };
    const v = this.verdicts.get(rid)?.[action];
    if (v) return v;
    return this.nodeSet.has(rid) ? { state: 'loading' } : { state: 'idle' };
  }

  trace(rid: string, action: AccessAction): TraceState | undefined {
    return this.traces.get(`${rid}|${action}`);
  }

  /** Progress of the visible node set (for "Asking … for N nodes"). */
  progress(): { total: number; done: number; requests: number } {
    let done = 0;
    for (const r of this.nodes) if (this.verdicts.has(r)) done++;
    let requests = 0;
    for (const p of this.pending.values()) if (this.current(p)) requests++;
    return { total: this.nodes.length, done, requests };
  }

  /** Visible nodes, other than `except`, with at least one decision. */
  decidedCount(except?: string): number {
    let n = 0;
    for (const r of this.nodes) {
      if (r === except) continue;
      const row = this.verdicts.get(r);
      if (row && Object.values(row).some(v => v && v.state !== 'unknown')) n++;
    }
    return n;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ── context ────────────────────────────────────────────────────

  /** The window's connection. A change drops every result. */
  setEnvironment(environment: string | undefined): void {
    if (environment === this._env) return;
    this._env = environment;
    this._envName = '';
    this._availability = 'unknown';
    this._reason = undefined;
    this._subjects = null;
    this._subjectsError = undefined;
    this._subject = null;
    this._recents = [];
    this.resetResults();
    if (!environment) { this._on = false; this.emit(); return; }
    this.prefsFor = environment;
    void this.source.loadPrefs(environment).then(p => {
      if (this._env !== environment || this.prefsFor !== environment) return;
      this._recents = p.recents.slice(0, RECENT_MAX);
      if (!this._subject && p.subject) this._subject = p.subject;
      this.emit();
      this.schedule();
    }, () => { /* no stored prefs */ });
    void this.source.status(environment).then(s => {
      if (this._env !== environment || s.available !== false) return;
      this.markUnavailable(s.reason);
    }, () => { /* unknown until prepared */ });
    this.emit();
  }

  /** The visible nodes in tree order. `gen` changes when the window's data
   *  changed (another root, a save): results for an older generation are
   *  dropped. */
  setNodes(rids: readonly string[], gen: number): void {
    const fresh = gen !== this.gen;
    if (fresh) {
      this.gen = gen;
      this.resetResults();
    }
    const same = rids.length === this.nodes.length && rids.every((r, i) => r === this.nodes[i]);
    if (same && !fresh) return;
    this.nodes = [...rids];
    this.nodeSet = new Set(rids);
    this.schedule();
  }

  select(rid: string | undefined): void {
    if (rid === this._selected) return;
    this._selected = rid;
    this.ensureTrace();
  }

  // ── user actions ───────────────────────────────────────────────

  toggle(force?: boolean): void {
    const next = force ?? !this._on;
    if (next && (this._availability === 'unavailable' || !this._env)) return;
    if (next === this._on) return;
    this._on = next;
    if (next) {
      this.prepare();
      this.schedule();
      this.ensureTrace();
    }
    this.emit();
  }

  /** Load subjects and check availability (once per environment). */
  prepare(): void {
    const env = this._env;
    if (!env || this._subjects || this._subjectsLoading) return;
    this._subjectsLoading = true;
    this._subjectsError = undefined;
    if (this._availability === 'unknown') this._availability = 'checking';
    this.source.prepare(env).then(res => {
      if (this._env !== env) return;
      this._subjects = res.subjects;
      this._envName = res.environmentName ?? '';
      if (!res.available) this.markUnavailable(res.reason);
      else if (this._availability !== 'unavailable') this._availability = 'available';
    }, (e: unknown) => {
      if (this._env !== env) return;
      this._subjectsError = e instanceof Error ? e.message : String(e);
      if (this._availability === 'checking') this._availability = 'unknown';
    }).finally(() => {
      if (this._env !== env) return;
      this._subjectsLoading = false;
      this.emit();
      this.schedule();
    });
  }

  pick(subject: AccessSubject): void {
    this._recents = [subject.rid, ...this._recents.filter(r => r !== subject.rid)].slice(0, RECENT_MAX);
    if (this._subject?.rid !== subject.rid) {
      this._subject = subject;
      this.resetResults();
      this.schedule();
    }
    this.savePrefs();
    this.ensureTrace();
    this.emit();
  }

  clearSubject(): void {
    if (!this._subject) return;
    this._subject = null;
    this.resetResults();
    this.savePrefs();
    this.emit();
  }

  setAction(action: AccessAction): void {
    if (action === this._action) return;
    this._action = action;
    this.ensureTrace();
    this.emit();
  }

  /** Ask again for one node (after "could not evaluate"). */
  retry(rid: string): void {
    this.verdicts.delete(rid);
    this.asked.delete(rid);
    for (const a of ACCESS_ACTIONS) this.traces.delete(`${rid}|${a.key}`);
    this.schedule();
    this.emit();
  }

  /** Evaluate every visible node again. */
  rerun(): void {
    this.resetResults();
    this.schedule();
    this.emit();
  }

  // ── internals ──────────────────────────────────────────────────

  private markUnavailable(reason?: string): void {
    this._availability = 'unavailable';
    this._reason = reason ?? 'Access tests are not available on this connection.';
    this._on = false;
    this.resetResults();
    this.emit();
  }

  private savePrefs(): void {
    if (this._env) this.source.savePrefs(this._env, { subject: this._subject, recents: this._recents });
  }

  private resetResults(): void {
    this.verdicts = new Map();
    this.asked = new Set();
    this.traces = new Map();
    this._evaluatedAt = undefined;
    // In-flight requests stay in `pending` but no longer match: their
    // answers are dropped when they arrive.
  }

  private current(p: Pending): boolean {
    return p.environment === this._env && p.subjectRid === this._subject?.rid && p.gen === this.gen;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => { this.scheduled = false; this.pump(); };
    if (this.opts.defer) this.opts.defer(run); else queueMicrotask(run);
  }

  private pump(): void {
    const env = this._env, subject = this._subject;
    if (!this._on || !env || !subject || this._availability === 'unavailable') return;
    let active = 0;
    for (const p of this.pending.values()) if (this.current(p)) active++;
    const missing = this.nodes.filter(r => !this.verdicts.has(r) && !this.asked.has(r));
    while (active < CONCURRENCY && missing.length) {
      const chunk = missing.splice(0, DECISION_CHUNK);
      this.send(chunk, env, subject.rid);
      active++;
    }
  }

  private send(rids: string[], environment: string, subjectRid: string): void {
    const requestId = `d${++this.seq}`;
    const req: Pending = { rids, environment, subjectRid, gen: this.gen };
    this.pending.set(requestId, req);
    for (const r of rids) this.asked.add(r);
    this.source.decide({ requestId, environment, subjectRid, rids }).then(
      res => this.applyDecisions(requestId, res),
      (e: unknown) => this.failDecisions(requestId, e instanceof Error ? e.message : String(e)),
    );
  }

  /** Apply one decision answer if it still belongs to the current context. */
  applyDecisions(requestId: string, res: DecideAnswer): void {
    const req = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (!req || res.requestId !== requestId || res.environment !== req.environment || res.subjectRid !== req.subjectRid) return;
    if (!this.current(req)) { this.schedule(); return; }
    if (res.unavailable) { this.markUnavailable(UNAVAILABLE_REASON); return; }
    for (const rid of req.rids) {
      this.asked.delete(rid);
      if (!this.nodeSet.has(rid)) continue;
      const got = res.ok ? res.verdicts?.[rid] : undefined;
      const reason = res.ok ? 'BMP returned no decision for this node.' : (res.error || 'The access check failed.');
      const row: ActionVerdicts = {};
      for (const a of ACCESS_ACTIONS) row[a.key] = got?.[a.key] ?? { state: 'unknown', reason };
      this.verdicts.set(rid, row);
    }
    this._evaluatedAt = (this.opts.now ?? Date.now)();
    this.emit();
    this.ensureTrace();
    this.schedule();
  }

  private failDecisions(requestId: string, error: string): void {
    const req = this.pending.get(requestId);
    if (!req) return;
    this.applyDecisions(requestId, {
      requestId, environment: req.environment, subjectRid: req.subjectRid, ok: false,
      error: /timed out/i.test(error) ? 'No answer within 30 s.' : error,
    });
  }

  /** Fetch the full trace of the selected node and action once its verdict
   *  is known (an "unknown" verdict has no trace to show). */
  private ensureTrace(): void {
    const env = this._env, subject = this._subject, rid = this._selected, action = this._action;
    if (!this._on || !env || !subject || !rid || this._availability === 'unavailable') return;
    const v = this.verdicts.get(rid)?.[action];
    if (!v || v.state === 'unknown') return;
    const key = `${rid}|${action}`;
    if (this.traces.has(key)) return;
    const requestId = `t${++this.seq}`;
    const gen = this.gen;
    this.traces.set(key, { loading: true, id: requestId });
    this.source.trace({ requestId, environment: env, subjectRid: subject.rid, rid, action }).then(res => {
      const cur = this.traces.get(key);
      const live = cur && 'loading' in cur && cur.id === requestId && this._env === env && this._subject?.rid === subject.rid && this.gen === gen
        && res.requestId === requestId && res.environment === env && res.subjectRid === subject.rid && res.rid === rid && res.action === action;
      if (!live) return;
      if (res.unavailable) { this.markUnavailable(UNAVAILABLE_REASON); return; }
      if (res.ok && res.trace) {
        this.traces.set(key, { trace: res.trace });
        // The trace is the newer answer: the cell follows it.
        const row = this.verdicts.get(rid);
        if (row) row[action] = verdictFromTrace(res.trace);
      } else {
        this.traces.set(key, { error: res.error || 'BMP returned no trace.' });
      }
      this.emit();
    }, (e: unknown) => {
      const cur = this.traces.get(key);
      if (!cur || !('loading' in cur) || cur.id !== requestId) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.traces.set(key, { error: /timed out/i.test(msg) ? 'No answer within 30 s.' : msg });
      this.emit();
    });
  }
}
