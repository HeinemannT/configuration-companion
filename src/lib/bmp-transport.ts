/**
 * BMP binary transport — one LoginTicket command path with bounded,
 * operation-aware recovery.
 */

import { serializeCommands, deserializeResponse, deserializeStream, deserializeStreamResult } from './java-serial';
import { BmpAuth } from './bmp-auth';
import { classifyScript, scriptLimitProblem } from './script-kinds';
import { log } from './logger';
import { AUTH_TIMEOUT, EC_TIMEOUT } from './constants';
import { BACKGROUND_TIMEOUT, isLowPriority, noteQueueWait, requestClassOf, type RequestClass } from './request-class';
import { governorFor, OVERLOAD_TEXT, scriptBudgetSentence, type LoadGovernor, type LoadState, type PostCost, type ScriptKey } from './load-governor';

export type CommandIntent = 'read' | 'write';
export type BmpTransportErrorKind =
  | 'auth'
  | 'permission'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'http'
  | 'protocol';

export class BmpTransportError extends Error {
  constructor(
    message: string,
    readonly kind: BmpTransportErrorKind,
    readonly attempts: number,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BmpTransportError';
  }
}

export interface BmpTransportMetrics {
  /** Java command class (or compact batch summary), never EC source text. */
  operation: string;
  /** Low-cardinality product feature, never EC source or object identity. */
  feature?: 'editor-context' | 'color-sets';
  commandCount: number;
  /** Requests already active/queued when this request entered the transport. */
  queueDepth: number;
  queueWaitMs: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  attempts: number;
}

export type BmpTransportOutcome =
  | ({ ok: true; intent: CommandIntent } & BmpTransportMetrics)
  | ({ ok: false; intent: CommandIntent; error: BmpTransportError } & BmpTransportMetrics);

interface RequestResult {
  buffer: ArrayBuffer;
  attempts: number;
}

interface QueuedRequest {
  /** Read when the queue picks the next post, so a promoted background
   *  post (request-class.ts promoteToUser) is sent as a user post. */
  requestClass(): RequestClass;
  /** Low-priority user work (request-class lowPrioritySignal). */
  low: boolean;
  start(waitedMs: number): void;
  /** Refused by the load governor (background work stopped). */
  refuse(error: Error): void;
  cost: PostCost;
  /** When the governor first held this post back. */
  heldSince?: number;
}

interface RequestMeta {
  operation?: string;
  commandCount?: number;
  /** Full object reads (IntegrationGetObjectCommand) in the post. */
  fullReads?: number;
  feature?: BmpTransportMetrics['feature'];
  /** Extended Code scripts in the post, for the script gauge (load-governor). */
  scripts?: ReadonlyArray<ScriptKey>;
  /** Built-in index reads in the post (load-governor PostCost.index). */
  index?: number;
  /** Read-only constant scripts in the post (load-governor PostCost.measured). */
  measured?: number;
}

const EXTENDED_EXECUTE = 'com.corporater.bmp.dto.command.extended.ExtendedExecuteCommand';

/** The script texts of the Extended Code commands of a post, as ledger keys
 *  with their kind (script-kinds.ts). A script over its kind's limit is
 *  refused here, before anything is sent: a constant script over 25,000
 *  characters, a varying one over 1,200 (the server keeps a parse tree per
 *  distinct text, 2,000 of them, counted by entry). */
function scriptsOf(commands: readonly any[]): ScriptKey[] {
  const out: ScriptKey[] = [];
  for (const c of commands) {
    if (c?.$type !== EXTENDED_EXECUTE || typeof c.function !== 'string') continue;
    const k = classifyScript(c.function as string, c.transactional === true);
    const problem = scriptLimitProblem(k);
    if (problem) {
      log.warn('transport:script-size', `${problem} ${(c.function as string).slice(0, 120)}`);
      throw new BmpTransportError(problem, 'protocol', 0);
    }
    out.push({ key: k.key, chars: k.chars, kind: k.kind });
  }
  return out;
}

/** Read-only Extended Code commands whose script is constant (script-kinds.ts)
 *  in a post sent as a read (`intent` after commandReplayIntent, so every
 *  script in it is non-transactional). `scripts` is scriptsOf(commands): one
 *  key per Extended Code command, in order. The governor debits a post made
 *  only of them by measured time (load-governor PostCost.measured). */
function measuredCount(commands: readonly any[], scripts: readonly ScriptKey[], intent: CommandIntent): number {
  if (intent !== 'read') return 0;
  let n = 0;
  let s = 0;
  for (const c of commands) {
    if (c?.$type !== EXTENDED_EXECUTE || typeof c.function !== 'string') continue;
    if (c.transactional === false && scripts[s]?.kind === 'constant') n++;
    s++;
  }
  return n;
}

/** The scripts of a post and, of its commands, the read-only constant ones. */
function scriptMeta(commands: readonly any[], intent: CommandIntent): { scripts: ScriptKey[]; measured?: number } {
  const scripts = scriptsOf(commands);
  const measured = measuredCount(commands, scripts, intent);
  return measured ? { scripts, measured } : { scripts };
}

const GET_OBJECT = 'com.corporater.bmp.dto.command.repository.IntegrationGetObjectCommand';

/** Built-in index reads: no script and no object read on the server (the
 *  name and ID index, a by-ID lookup, a tree item). The governor debits
 *  them by measured time (load-governor PostCost.index). */
const INDEX_COMMANDS = new Set([
  'com.corporater.bmp.dto.command.SearchCommand',
  'com.corporater.bmp.dto.command.repository.GetPropertiesByIdCommand',
  'com.corporater.bmp.dto.command.tree.TreeItemCommand',
  // The change feed (tree-events.ts): an empty poll takes about 30 ms.
  'com.corporater.bmp.dto.command.tree.TreeEventCommand',
]);
const indexCount = (commands: readonly any[]) => commands.filter(c => INDEX_COMMANDS.has(c?.$type)).length;

const TRANSIENT_HTTP = new Set([502, 503, 504]);
const REPLAYABLE_COMMANDS = new Set([
  'com.corporater.bmp.dto.command.repository.IntegrationGetObjectCommand',
  'com.corporater.bmp.dto.command.repository.GetPropertiesByIdCommand',
  'com.corporater.bmp.dto.command.tree.TreeItemCommand',
  'com.corporater.bmp.dto.command.type.GetTypeFieldsCommand',
  'com.corporater.bmp.dto.command.type.LoadTypeConfigCommand',
  'com.corporater.bmp.dto.command.access.AccessTraceCommand',
  // Name and ID search on the server's index (search-command.ts): a read.
  'com.corporater.bmp.dto.command.SearchCommand',
  // The change feed (tree-events.ts): stateless; a repeat only takes an id.
  'com.corporater.bmp.dto.command.tree.TreeEventCommand',
]);

/** Caller intent can prohibit replay, but cannot make a mutation replayable.
 * Unknown commands fail closed until their read semantics are established. */
export function commandReplayIntent(commands: readonly unknown[], intent: CommandIntent): CommandIntent {
  if (intent === 'write' || commands.length === 0) return 'write';
  return commands.every(command => {
    if (!command || typeof command !== 'object') return false;
    const value = command as { $type?: string; transactional?: unknown };
    return value.$type === 'com.corporater.bmp.dto.command.extended.ExtendedExecuteCommand'
      ? value.transactional === false
      : typeof value.$type === 'string' && REPLAYABLE_COMMANDS.has(value.$type);
  }) ? 'read' : 'write';
}
const isHtml = (response: Response): boolean => /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i
  .test(response.headers.get('Content-Type') ?? '');

export class BmpTransport {
  private outcomeObserver: ((outcome: BmpTransportOutcome) => void) | null = null;
  /**
   * BMP command responses are session-sensitive. Concurrent /cs/command posts
   * sharing one client/session can cause one caller to receive an incomplete
   * response intended for another command. Keep HTTP exchanges ordered per
   * transport instance; callers may still batch commands in one request.
   * The waiting queue has two classes (request-class.ts): a waiting user
   * request is sent before waiting background work, but never in parallel
   * with, or by interrupting, the post in flight.
   */
  private queue: QueuedRequest[] = [];
  private inFlight = false;
  private pendingRequests = 0;
  /** Every post passes the load governor of its server (load-governor.ts). */
  readonly governor: LoadGovernor;
  private loadObserver: ((state: LoadState) => void) | null = null;
  private lastLoad = 'ok';
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** When `wakeTimer` fires (Date.now() time). */
  private wakeAt = 0;

  setLoadObserver(observer: ((state: LoadState) => void) | null): void { this.loadObserver = observer; }

  private publishLoad(): void {
    const st = this.governor.state();
    const key = st.state === 'waiting' ? `waiting:${Math.ceil(st.waitMs / 1000)}` : st.state;
    if (key === this.lastLoad) return;
    this.lastLoad = key;
    try { this.loadObserver?.(st); } catch { /* status must not break commands */ }
  }

  constructor(
    private bmpUrl: string,
    private auth: BmpAuth,
  ) {
    this.governor = governorFor(bmpUrl);
    // An overload signal refuses waiting background posts at once.
    this.governor.subscribe(() => {
      if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
      this.pump();
    });
  }

  /** The workspace base URL (trailing slash), e.g. `https://host/Workspace/`.
   *  Used to build non-command servlet URLs like the CVO data servlet. */
  get baseUrl(): string { return this.bmpUrl }

  setOutcomeObserver(observer: ((outcome: BmpTransportOutcome) => void) | null): void {
    this.outcomeObserver = observer;
  }

  /** Send a serialized command body through the cross-version LoginTicket path.
   *  Reads may be replayed once after an expired ticket or transient network/
   *  gateway failure. Writes always make exactly one command POST. */
  async sendRequest(
    body: Uint8Array,
    timeout: number,
    intent: CommandIntent,
    signal?: AbortSignal,
    meta: RequestMeta = {},
  ): Promise<ArrayBuffer> {
    const queuedAt = Date.now();
    const sessionEpoch = this.auth.sessionEpoch;
    const queueDepth = this.pendingRequests;
    const { requestClass, supersede } = requestClassOf(signal);
    if (requestClass === 'background') timeout = Math.min(timeout, BACKGROUND_TIMEOUT);
    const metrics = (startedAt: number) => ({
      operation: meta.operation ?? 'SerializedCommand',
      ...(meta.feature ? { feature: meta.feature } : {}),
      commandCount: meta.commandCount ?? 1,
      queueDepth,
      queueWaitMs: Math.max(0, startedAt - queuedAt),
      requestBytes: body.byteLength,
    });
    this.pendingRequests++;
    const cost: PostCost = { commands: meta.commandCount ?? 1, fullReads: meta.fullReads ?? 0, ...(meta.index ? { index: meta.index } : {}), ...(meta.measured ? { measured: meta.measured } : {}), ...(meta.scripts?.length ? { scripts: meta.scripts } : {}) };
    let heldMs = () => 0;
    return this.enqueueRequest(() => requestClassOf(signal).requestClass, cost, h => { heldMs = h; }, [signal, supersede], () => {
      // Left the queue without a post: cancelled or superseded while waiting.
      this.pendingRequests = Math.max(0, this.pendingRequests - 1);
      const error = new BmpTransportError('BMP request cancelled', 'cancelled', 0);
      this.emitOutcome({ ok: false, intent, error, ...metrics(Date.now()), durationMs: 0, responseBytes: 0, attempts: 0 });
      return error;
    }, async () => {
      const startedAt = Date.now();
      const common = metrics(startedAt);
      noteQueueWait(signal, common.queueWaitMs);
      try {
        const { buffer, attempts } = await this.sendRequestInternal(body, timeout, intent, sessionEpoch, signal);
        const debit = this.governor.observe(requestClassOf(signal).requestClass, cost, { ok: true, durationMs: Math.max(0, Date.now() - startedAt), responseBytes: buffer.byteLength });
        this.governor.record({ op: meta.operation ?? 'SerializedCommand', cls: requestClassOf(signal).requestClass, commands: cost.commands, fullReads: cost.fullReads, bytes: buffer.byteLength, ms: Math.max(0, Date.now() - startedAt), heldMs: heldMs(), ok: true, debit });
        this.publishLoad();
        this.emitOutcome({
          ok: true,
          intent,
          ...common,
          durationMs: Math.max(0, Date.now() - startedAt),
          responseBytes: buffer.byteLength,
          attempts,
        });
        return buffer;
      } catch (cause) {
        const error = cause instanceof BmpTransportError
          ? cause
          : this.classifyError(cause, 0, signal);
        // A time-out or a 5xx answer is an overload signal for every feature.
        // A failed ticket request carries its HTTP status only in the text.
        const overload = error.kind === 'timeout' || (error.status != null && error.status >= 500) || OVERLOAD_TEXT.test(error.message);
        const debit = this.governor.observe(requestClassOf(signal).requestClass, cost, { ok: false, durationMs: Math.max(0, Date.now() - startedAt), responseBytes: 0, overload, detail: error.message });
        this.governor.record({ op: meta.operation ?? 'SerializedCommand', cls: requestClassOf(signal).requestClass, commands: cost.commands, fullReads: cost.fullReads, bytes: 0, ms: Math.max(0, Date.now() - startedAt), heldMs: heldMs(), ok: false, debit });
        this.publishLoad();
        this.emitOutcome({
          ok: false,
          intent,
          error,
          ...common,
          durationMs: Math.max(0, Date.now() - startedAt),
          responseBytes: 0,
          attempts: error.attempts,
        });
        throw error;
      } finally {
        this.pendingRequests = Math.max(0, this.pendingRequests - 1);
      }
    });
  }

  /** A request that is not a command post but reads several objects (the
   *  portal's GraphQL search): it waits its turn in the same lane and counts
   *  against the same budgets as one light command (load-governor). */
  async sendGoverned<T>(operation: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const { supersede } = requestClassOf(signal);
    const cost: PostCost = { commands: 1, fullReads: 0 };
    const queuedAt = Date.now();
    this.pendingRequests++;
    let heldMs = () => 0;
    return this.enqueueRequest(() => requestClassOf(signal).requestClass, cost, h => { heldMs = h; }, [signal, supersede], () => {
      this.pendingRequests = Math.max(0, this.pendingRequests - 1);
      return new BmpTransportError('BMP request cancelled', 'cancelled', 0);
    }, async () => {
      const startedAt = Date.now();
      noteQueueWait(signal, startedAt - queuedAt);
      const done = (ok: boolean, detail?: string) => {
        const cls = requestClassOf(signal).requestClass;
        const ms = Math.max(0, Date.now() - startedAt);
        this.governor.observe(cls, cost, { ok, durationMs: ms, responseBytes: 0, ...(detail ? { detail } : {}) });
        this.governor.record({ op: operation, cls, commands: cost.commands, fullReads: 0, bytes: 0, ms, heldMs: heldMs(), ok });
        this.publishLoad();
      };
      try {
        const out = await run();
        done(true);
        return out;
      } catch (e) {
        done(false, e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        this.pendingRequests = Math.max(0, this.pendingRequests - 1);
      }
    });
  }

  /** One lane, two classes: the next post is the oldest waiting user post
   *  (one not marked low first, then a low one), else the oldest waiting
   *  background post. A post in flight always runs to
   *  its end. A waiting post whose signal (or supersede signal) aborts leaves
   *  the queue at once and is rejected with `dropped()`. */
  private enqueueRequest<T>(
    requestClass: () => RequestClass,
    cost: PostCost,
    exposeHeld: (held: () => number) => void,
    signals: ReadonlyArray<AbortSignal | undefined>,
    dropped: () => Error,
    request: () => Promise<T>,
  ): Promise<T> {
    let held = 0;
    exposeHeld(() => held);
    return new Promise<T>((resolve, reject) => {
      const watched = signals.filter((s): s is AbortSignal => s != null);
      const job: QueuedRequest = {
        requestClass,
        low: isLowPriority(signals[0]),
        cost,
        refuse: (error: Error) => { detach(); this.pendingRequests = Math.max(0, this.pendingRequests - 1); reject(error); },
        start: (waitedMs: number) => {
          detach();
          held = waitedMs;
          this.governor.start(requestClass(), cost, waitedMs);
          request().then(resolve, reject).finally(() => {
            this.inFlight = false;
            this.pump();
          });
        },
      };
      const onAbort = () => {
        // A promoted post belongs to a user action now: a supersede of the
        // background work it started as must not drop it.
        if (requestClass() === 'user' && !signals[0]?.aborted) return;
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1);
        detach();
        reject(dropped());
      };
      const detach = () => { for (const s of watched) s.removeEventListener('abort', onAbort); };
      if (watched.some(s => s.aborted)) { reject(dropped()); return; }
      for (const s of watched) s.addEventListener('abort', onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0) return;
    let index = this.queue.findIndex(job => job.requestClass() === 'user' && !job.low);
    if (index < 0) index = this.queue.findIndex(job => job.requestClass() === 'user');
    if (index < 0) index = 0;
    const job = this.queue[index];
    const cls = job.requestClass();
    const wait = this.governor.admit(cls, job.cost);
    if (wait < 0) {
      // Background work is stopped after an overload signal: refused, the
      // caller sees why; user posts go on.
      this.queue.splice(index, 1);
      const b = this.governor.backgroundBlocked();
      job.refuse(new BmpTransportError(wait === -2
        ? scriptBudgetSentence(this.governor.ledger.totals())
        : `Background work stopped: the server answered like an overloaded one${b?.detail ? ` (${b.detail})` : ''}.`, 'cancelled', 0));
      this.publishLoad();
      this.pump();
      return;
    }
    if (wait > 0) {
      // Over the budget: the post waits in order (never dropped) and the
      // status says so.
      job.heldSince ??= Date.now();
      this.publishLoad();
      // One timer, due at the earliest wait: a post that may go sooner
      // (a user post behind a long background wait) is not held to a timer
      // set for a later one.
      const delay = Math.min(wait, 60_000);
      const due = Date.now() + delay;
      if (this.wakeTimer && due < this.wakeAt) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
      if (!this.wakeTimer) {
        this.wakeAt = due;
        this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.pump(); }, delay);
      }
      return;
    }
    this.queue.splice(index, 1);
    this.inFlight = true;
    job.start(job.heldSince ? Date.now() - job.heldSince : 0);
    this.publishLoad();
  }

  private async sendRequestInternal(
    body: Uint8Array,
    timeout: number,
    intent: CommandIntent,
    sessionEpoch: number,
    signal?: AbortSignal,
  ): Promise<RequestResult> {
    const assertCurrent = (attempts: number) => {
      if (signal?.aborted) throw new BmpTransportError('BMP request cancelled', 'cancelled', attempts);
      if (sessionEpoch !== this.auth.sessionEpoch) {
        throw new BmpTransportError('BMP connection changed. The previous request was cancelled.', 'cancelled', attempts);
      }
    };
    assertCurrent(0);

    const deadline = Date.now() + timeout;
    const maxAttempts = intent === 'read' ? 2 : 1;
    let renewedTicket = false;
    let ticket: string;
    try {
      ticket = await this.auth.getLoginTicket(sessionEpoch);
    } catch (cause) {
      assertCurrent(0);
      throw this.classifyError(cause, 0, signal, 'Could not obtain a BMP login ticket');
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      assertCurrent(attempt - 1);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new BmpTransportError(`BMP at ${this.bmpUrl} timed out`, 'timeout', attempt - 1);
      }

      try {
        const { response: res, buffer } = await this.postCommand(body, ticket, remaining, signal);
        assertCurrent(attempt);

        if (res.type === 'opaqueredirect' || res.redirected || (res.status >= 300 && res.status < 400)) {
          const message = 'BMP redirected /cs/command instead of accepting command authentication. Check the sign-in gateway, then reconnect.';
          this.auth.rejectCommandAuthentication(message);
          throw new BmpTransportError(message, 'auth', attempt, res.status || undefined);
        }

        if (res.status === 401) {
          if (intent === 'write' || attempt === maxAttempts) {
            const source = this.auth.authMode === 'stored' ? 'stored-login' : 'portal-session';
            const detail = renewedTicket
              ? this.auth.authMode === 'stored'
                ? ' A new stored Studio session was also rejected. Automatic login retries are paused; check the gateway and account, then reconnect.'
                : ' A renewed portal-session ticket was also rejected.'
              : ' The command was not retried. Reconnect before trying again.';
            const message = `BMP rejected ${source} authentication at /cs/command (HTTP 401).${detail}`;
            this.auth.rejectCommandAuthentication(message);
            throw new BmpTransportError(message, 'auth', attempt, 401);
          }
          ticket = await this.auth.refreshLoginTicket(sessionEpoch);
          renewedTicket = true;
          continue;
        }

        // A 403 is an authorization decision, not evidence that a ticket
        // expired. Re-authenticating/replaying can duplicate work and cannot
        // grant a permission the user does not have.
        if (res.status === 403) {
          throw new BmpTransportError('Permission denied (403)', 'permission', attempt, 403);
        }

        if (!res.ok) {
          if (intent === 'read' && attempt < maxAttempts && TRANSIENT_HTTP.has(res.status)) {
            continue;
          }
          throw new BmpTransportError(`Command failed: HTTP ${res.status}`, 'http', attempt, res.status);
        }

        if (isHtml(res)) {
          const message = 'BMP returned an HTML sign-in page from /cs/command instead of a command response. Check the sign-in gateway, then reconnect.';
          this.auth.rejectCommandAuthentication(message);
          throw new BmpTransportError(message, 'auth', attempt, res.status);
        }

        return { buffer: buffer!, attempts: attempt };
      } catch (cause) {
        assertCurrent(attempt);
        const error = cause instanceof BmpTransportError
          ? cause
          : this.classifyError(cause, attempt, signal);
        if (intent === 'read' && attempt < maxAttempts && error.kind === 'network') {
          continue;
        }
        throw error;
      }
    }

    // The bounded loop always returns or throws. Keep an explicit guard so a
    // future attempt-policy edit cannot make this fall through silently.
    throw new BmpTransportError('BMP command retry exhausted', 'network', maxAttempts);
  }

  private emitOutcome(outcome: BmpTransportOutcome): void {
    try { this.outcomeObserver?.(outcome); } catch { /* telemetry must not break commands */ }
    // A write that was sent (answered or not: it may have written) tells
    // the caches that hold server state of this connection.
    if (outcome.intent === 'write' && outcome.attempts > 0) for (const fn of this.writeListeners) { try { fn(); } catch { /* a cache must not break commands */ } }
  }

  private readonly writeListeners = new Set<() => void>();
  /** Called after every write this connection sent; returns the unsubscribe. */
  onWrite(fn: () => void): () => void {
    this.writeListeners.add(fn);
    return () => this.writeListeners.delete(fn);
  }

  private postCommand(
    body: Uint8Array,
    ticket: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<{ response: Response; buffer: ArrayBuffer | null }> {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const effectiveSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    const exactBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return this.auth.fetchCommand(ticket, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-java-serialized-object' },
      body: exactBody,
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: effectiveSignal,
    }, async response => {
      // Consume the body inside the authentication scope. A late response from
      // a cleared identity must never be published as a successful command.
      if (response.ok && !isHtml(response)) return { response, buffer: await response.arrayBuffer() };
      await response.body?.cancel().catch(() => { /* the HTTP status remains authoritative */ });
      return { response, buffer: null };
    });
  }

  private classifyError(
    cause: unknown,
    attempts: number,
    callerSignal?: AbortSignal,
    fallback = 'BMP command failed',
  ): BmpTransportError {
    if (cause instanceof BmpTransportError) return cause;
    if (callerSignal?.aborted) {
      return new BmpTransportError('BMP request cancelled', 'cancelled', attempts, undefined, { cause });
    }
    if (cause instanceof DOMException && cause.name === 'TimeoutError') {
      return new BmpTransportError(`BMP at ${this.bmpUrl} timed out`, 'timeout', attempts, undefined, { cause });
    }
    // An AbortError not caused by the caller is the combined deadline signal.
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return new BmpTransportError(`BMP at ${this.bmpUrl} timed out`, 'timeout', attempts, undefined, { cause });
    }
    if (cause instanceof TypeError) {
      return new BmpTransportError(`Cannot reach BMP at ${this.bmpUrl}`, 'network', attempts, undefined, { cause });
    }
    const message = cause instanceof Error ? cause.message : fallback;
    return new BmpTransportError(message || fallback, 'auth', attempts, undefined, { cause });
  }

  /** Send one or more serialized commands. Intent is mandatory: it is the
   *  replay-safety boundary for this transport. */
  async sendCommands(
    commands: any[],
    intent: CommandIntent,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const body = serializeCommands(commands);
    const replay = commandReplayIntent(commands, intent);
    return this.sendRequest(
      body,
      AUTH_TIMEOUT,
      replay,
      signal,
      { operation: commandOperation(commands), commandCount: commands.length, fullReads: commands.filter(c => c?.$type === GET_OBJECT).length, index: indexCount(commands), ...scriptMeta(commands, replay) },
    );
  }

  /** Send a streaming command (e.g. ExtendedExecuteCommand). `timeoutMs`
   *  widens the deadline for known-long reads/writes such as Blueprint. */
  async sendStreamingCommand(
    command: any,
    intent: CommandIntent,
    signal?: AbortSignal,
    timeoutMs?: number,
    feature?: BmpTransportMetrics['feature'],
  ): Promise<any[]> {
    intent = commandReplayIntent([command], intent);
    const buffer = await this.sendRequest(
      serializeCommands([command]),
      timeoutMs ?? EC_TIMEOUT,
      intent,
      signal,
      { operation: commandOperation([command]), commandCount: 1, feature, ...scriptMeta([command], intent) },
    );
    let decoded: { objects: any[]; error?: Error };
    try {
      decoded = deserializeStreamResult(buffer);
    } catch (cause) {
      const error = new BmpTransportError('BMP protocol error while decoding command response', 'protocol', 1, undefined, { cause });
      this.emitDecodeFailure(intent, error, 'DeserializeStream');
      throw error;
    }
    // A stream that stops mid-object was cut off or damaged. Its first
    // objects can parse as a valid, empty EC result, so never return them as
    // a complete answer: callers and their retry paths see a typed error.
    if (decoded.error) {
      const error = new BmpTransportError(
        'BMP returned an incomplete response (the answer was cut off or damaged). Try again.',
        'protocol', 1, undefined, { cause: decoded.error },
      );
      this.emitDecodeFailure(intent, error, 'DeserializeStream');
      throw error;
    }
    return decoded.objects;
  }

  /** Several read-only streaming commands (e.g. ExtendedExecuteCommands) in
   *  one post. BMP runs them one after another and answers each in order,
   *  in the same stream; the caller splits the objects per command. */
  async sendStreamingCommands(
    commands: any[],
    intent: CommandIntent,
    signal?: AbortSignal,
    timeoutMs?: number,
    feature?: BmpTransportMetrics['feature'],
  ): Promise<any[]> {
    intent = commandReplayIntent(commands, intent);
    const buffer = await this.sendRequest(
      serializeCommands(commands),
      timeoutMs ?? EC_TIMEOUT,
      intent,
      signal,
      { operation: commandOperation(commands), commandCount: commands.length, feature, index: indexCount(commands), ...scriptMeta(commands, intent) },
    );
    let decoded: { objects: any[]; error?: Error };
    try {
      decoded = deserializeStreamResult(buffer);
    } catch (cause) {
      const error = new BmpTransportError('BMP protocol error while decoding command response', 'protocol', 1, undefined, { cause });
      this.emitDecodeFailure(intent, error, 'DeserializeStream');
      throw error;
    }
    if (decoded.error) {
      const error = new BmpTransportError(
        'BMP returned an incomplete response (the answer was cut off or damaged). Try again.',
        'protocol', 1, undefined, { cause: decoded.error },
      );
      this.emitDecodeFailure(intent, error, 'DeserializeStream');
      throw error;
    }
    return decoded.objects;
  }

  /** Deserialize a response buffer with the same typed protocol boundary. */
  deserializeResponse(buffer: ArrayBuffer, intent: CommandIntent = 'read'): any {
    try {
      return deserializeResponse(buffer);
    } catch (cause) {
      const error = new BmpTransportError('BMP protocol error while decoding command response', 'protocol', 1, undefined, { cause });
      this.emitDecodeFailure(intent, error, 'DeserializeResponse');
      throw error;
    }
  }

  /** Deserialize a streaming response outside sendStreamingCommand (used by
   *  binary read commands that share the stream envelope). */
  deserializeStream(buffer: ArrayBuffer, intent: CommandIntent = 'read', strict = false): any[] {
    try {
      return deserializeStream(buffer, strict);
    } catch (cause) {
      const error = new BmpTransportError('BMP protocol error while decoding command response', 'protocol', 1, undefined, { cause });
      this.emitDecodeFailure(intent, error, 'DeserializeStream');
      throw error;
    }
  }

  /** Translate typed failures into concise user-facing messages. */
  formatError(e: unknown): string {
    if (e instanceof BmpTransportError) return e.message;
    if (e instanceof TypeError && (e.message.includes('fetch') || e.message.includes('network'))) {
      return `Cannot reach BMP at ${this.bmpUrl}`;
    }
    if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      return `BMP at ${this.bmpUrl} timed out`;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Bad magic')) return 'Server response is not BMP binary: wrong URL or version mismatch';
    if (msg.includes('Unknown type code')) return 'BMP version mismatch: response contains unknown data types';
    if (msg.includes('Bad handle reference')) return 'BMP protocol error: possible version mismatch';
    return msg;
  }

  private emitDecodeFailure(
    intent: CommandIntent,
    error: BmpTransportError,
    operation: string,
  ): void {
    this.emitOutcome({
      ok: false,
      intent,
      error,
      operation,
      commandCount: 1,
      queueDepth: 0,
      queueWaitMs: 0,
      durationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
      attempts: error.attempts,
    });
  }
}

function commandOperation(commands: any[]): string {
  const names = commands.map(command => {
    const raw = typeof command?.$type === 'string' ? command.$type : 'SerializedCommand';
    return raw.split('.').pop() || 'SerializedCommand';
  });
  const unique = [...new Set(names)];
  if (unique.length === 1) return names.length > 1 ? `${names.length}×${unique[0]}` : unique[0];
  return unique.slice(0, 3).join('+') + (unique.length > 3 ? `+${unique.length - 3}` : '');
}
