/**
 * Load governor: one per server connection (BmpTransport), in front of every
 * post the extension sends. It does not know how much a given server can
 * take, so it keeps the extension well inside what was measured:
 *
 *  - The outage on the test server (1.5 GB heap) came after about 1,600
 *    commands in one minute and about 2,400 more within three, nearly all
 *    full object reads (`IntegrationGetObjectCommand`, ~4,000 in five
 *    minutes); one batch of 9 such reads once answered 4.3 MB.
 *  - After the restart, the paced index build peaked at 273 commands a
 *    minute with no trouble.
 *
 * Rules:
 *  1. Rolling budgets per minute, as token buckets (a short burst, then a
 *     steady rate): commands, full object reads and response bytes. User
 *     posts draw from the shared budget; background posts draw from it and
 *     from a much smaller background budget.
 *       shared:      240 commands/min (burst 450), 200 full reads/min
 *                    (burst 400: one object window or Browse tree at its
 *                    400-node cap goes at once), 24 MB/min (burst 16 MB)
 *       background:  120 commands/min (burst 20), 30 full reads/min
 *                    (burst 10), 6 MB/min (burst 3 MB)
 *     A command counts one, except a built-in index read (the name and ID
 *     search, a by-ID lookup, a tree item: no script, no object read, about
 *     1-3 ms each on the test server): twenty of them count one, and after
 *     the answer an index-only post costs at least one command per 250 ms of
 *     measured time, so a slow index read is charged like the work it was.
 *     A user post of read-only constant scripts (the code search listing
 *     and reads) costs one command per 200 ms of measured time, at most one
 *     per command (measuredScriptDebit); while the governor is overloaded
 *     or slow, after a failure or 30 s without such a post, one per command.
 *     240 commands a minute stays below the 273 that the paced build ran
 *     without trouble; 200 full reads a minute is a quarter of the rate
 *     that preceded the outage (about 800 a minute), and only one
 *     maximal object window fits in a minute's burst.
 *  2. A post that would exceed a budget waits in the queue, in order, never
 *     dropped; while it waits the state says "waiting for the server".
 *  3. Full object reads per post start at 25 and adapt: an answer over 2 MB
 *     or slower than 5 s halves the next post (down to 5), a small and fast
 *     one lets it grow back to 25.
 *  4. Early warning: the duration of light posts (one command, a small
 *     answer) is tracked against the session's baseline. When the recent
 *     median is four times the baseline (and over 1.5 s), background work
 *     pauses for two minutes.
 *  5. An overload signal (out of memory, HTTP 5xx, a time-out) stops
 *     background work for 30 minutes; user posts still go, one at a time.
 *  6. Script gauge (script-ledger.ts): BMP parses every script through one
 *     cache of 2,000 texts (keyed by the text only, about 40 bytes of heap
 *     per character, cleared only by a restart). The governor keeps
 *     Companion's window of that cache per server, across worker restarts.
 *     Background posts that carry a NEW text are refused while Companion
 *     holds SCRIPT_COST.backgroundEntries entries or backgroundBytes of
 *     estimated memory (repeats still go); user posts are never held back;
 *     past noticeEntries / noticeBytes the side panel says so. With the
 *     server option `noCache` on, nothing is kept and no budget applies.
 *     GET_SERVER_LOAD reports it; the Log states the background limit once
 *     per server when it starts and when it ends (kept across worker
 *     restarts). A change-feed pack id going back (a server restart) empties
 *     the window, so the count is an estimate since the last restart seen.
 *
 * Pure logic with an injectable clock; the transport calls `admit`,
 * `charge` and `observe`.
 */

import { mbPhrase, chromeLedgerStorage, SCRIPT_COST, ScriptLedger, type LedgerStorage, type LedgerTotals } from './script-ledger';

export type LoadClass = 'user' | 'background';

export interface Bucket { capacity: number; perMinute: number }

export const GOVERNOR = {
  fullReadsPerPost: 25,
  minFullReadsPerPost: 5,
  largeBytes: 2_000_000,
  slowMs: 5_000,
  shared: {
    commands: { capacity: 450, perMinute: 240 },
    fullReads: { capacity: 400, perMinute: 200 },
    bytes: { capacity: 16_000_000, perMinute: 24_000_000 },
  },
  background: {
    commands: { capacity: 20, perMinute: 120 },
    fullReads: { capacity: 10, perMinute: 30 },
    bytes: { capacity: 3_000_000, perMinute: 6_000_000 },
  },
  light: { maxBytes: 20_000, baselineSamples: 10, recentSamples: 5, factor: 4, minMs: 1_500, pauseMs: 2 * 60_000 },
  /** Built-in index reads (PostCost.index): `perUnit` of them are debited
   *  as one command when the post starts; after the answer the post costs
   *  at least one command per `msPerUnit` of measured time, so an index read
   *  that keeps the server busy is charged for it. */
  index: { perUnit: 20, msPerUnit: 250 },
  /** Read-only constant scripts sent as user work (PostCost.measured): a
   *  post costs one command per `slowMsPerCommand` of measured time (at
   *  least one, at most one per command). The divisor equals the threshold:
   *  the cost is continuous there (a post at 200 ms per command costs one per
   *  command, the old cost), and the server time admitted per second never
   *  exceeds what the old rule admits at 200 ms per command (4 commands a
   *  second x 200 ms = 0.8 s of server time per second). The last post's
   *  time per command sets the next start debit for `historyMs`; after that,
   *  a failure, or while the governor is overloaded or slow, every such post
   *  costs one per command, as before. */
  measured: { slowMsPerCommand: 200, historyMs: 30_000 },
  cooldownMs: 30 * 60_000,
} as const;

/** Commands a post debits when it starts: every command counts one, except
 *  built-in index reads (`index`), which count one per GOVERNOR.index.perUnit
 *  (at least one per post). */
export function commandDebit(cost: Pick<PostCost, 'commands' | 'index'>): number {
  const index = Math.max(0, Math.min(cost.commands, cost.index ?? 0));
  const other = cost.commands - index;
  const units = index ? Math.ceil(index / GOVERNOR.index.perUnit) : 0;
  return Math.max(cost.commands > 0 ? 1 : 0, other + units);
}

/** What an index-only post costs after its answer: its start debit, or one
 *  command per GOVERNOR.index.msPerUnit of measured time when that is more. */
export function measuredIndexDebit(cost: Pick<PostCost, 'commands' | 'index'>, durationMs: number): number {
  return Math.max(commandDebit(cost), Math.ceil(Math.max(0, durationMs) / GOVERNOR.index.msPerUnit));
}

/** What a post of `commands` read-only constant scripts (PostCost.measured)
 *  costs after an answer in `durationMs`: one per
 *  GOVERNOR.measured.slowMsPerCommand of measured time, at least one and at
 *  most `commands` (the old cost, reached at 200 ms per command). */
export function measuredScriptDebit(commands: number, durationMs: number): number {
  const ms = Math.max(0, durationMs);
  return Math.max(1, Math.min(commands, Math.ceil(ms / GOVERNOR.measured.slowMsPerCommand)));
}

class TokenBucket {
  private level: number;
  private at: number;
  constructor(private readonly spec: Bucket, now: number) { this.level = spec.capacity; this.at = now; }
  private refill(now: number): void {
    // Wall-clock time: a clock set back must not drain the bucket.
    this.level = Math.min(this.spec.capacity, this.level + (Math.max(0, now - this.at) / 60_000) * this.spec.perMinute);
    this.at = now;
  }
  /** Give back `n` (a measured debit below the start debit), never above
   *  the burst. */
  give(n: number, now: number): void { this.refill(now); this.level = Math.min(this.spec.capacity, this.level + n); }
  /** Milliseconds until `n` can be taken (0: now). A request larger than
   *  the burst waits for a full bucket and then goes (never starves). */
  waitFor(n: number, now: number): number {
    this.refill(now);
    const need = Math.min(n, this.spec.capacity);
    if (this.level >= need) return 0;
    return Math.ceil(((need - this.level) / this.spec.perMinute) * 60_000);
  }
  take(n: number, now: number): void { this.refill(now); this.level -= n; }
}

export type LoadState =
  | { state: 'ok' }
  | { state: 'waiting'; waitMs: number; reason: 'budget' }
  | { state: 'slow'; until: number }
  | { state: 'overloaded'; until: number; detail: string };

export interface PostCost {
  commands: number;
  fullReads: number;
  /** Of `commands`, built-in index reads: the server's name and ID index
   *  (SearchCommand), by-ID lookups (GetPropertiesByIdCommand) and tree
   *  items (TreeItemCommand). No script, no object read: they are debited
   *  by measured time, not one each (commandDebit, measuredIndexDebit). */
  index?: number;
  /** Of `commands`, read-only (non-transactional) Extended Code commands
   *  whose script is `constant` (script-kinds.ts), in a read post. A user
   *  post made only of them is debited by measured time while the server is
   *  fast (measuredScriptDebit); otherwise each counts one. */
  measured?: number;
  /** Extended Code scripts in the post (their text's key and length). */
  scripts?: ReadonlyArray<ScriptKey>;
}

/** A script text as the ledger knows it: a 64-bit hash, the length and,
 *  once the transport classified it, its kind (script-kinds.ts). */
export interface ScriptKey { key: string; chars: number; kind?: import('./script-kinds').ScriptKind }

/** FNV-1a over the UTF-16 code units, twice with different seeds: a 64-bit
 *  key. Collisions only make a new script count as known. */
export function scriptKey(text: string): ScriptKey {
  let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return { key: (a >>> 0).toString(36) + '.' + (b >>> 0).toString(36), chars: text.length };
}

/** The script gauge (GET_SERVER_LOAD): Companion's share of the server's
 *  script cache (script-ledger.ts) and the budgets. */
export interface ScriptLoad extends LedgerTotals {
  /** Scripts sent again in this worker life (same text): no new parse. */
  repeats: number;
  /** New script characters in the last hour (this worker life). */
  hourChars: number;
  cacheEntries: number;
  bytesPerChar: number;
  backgroundEntries: number;
  backgroundBytes: number;
  noticeEntries: number;
  noticeBytes: number;
  /** The server runs without a parse cache (feature `noCache`): nothing
   *  is kept, no budget applies. null: not known. */
  serverCacheOff: boolean | null;
  /** Background work that needs a new script text is refused now. */
  backgroundStopped: boolean;
}

/** What a notice listener is told: the background limit started or ended
 *  (the Log), or the memory notice (the side panel). */
export type NoticeKind = 'background' | 'background-end' | 'memory';

/** What the count is: an estimate since the server was last seen
 *  restarting, or since Companion started counting (script-ledger.ts). */
export function countedSince(s: Partial<Pick<LedgerTotals, 'since' | 'restartSeen' | 'restartSetByUser'>>): string {
  if (s.since == null) return '';
  const day = new Date(s.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return s.restartSeen
    ? `An estimate since the server was last seen restarting (${day}${s.restartSetByUser ? ', set by you' : ''}).`
    : `An estimate since ${day}; Companion has not seen the server restart since then.`;
}

/** The gauge in one sentence (Log, diagnostics). */
export function scriptSentence(s: Pick<ScriptLoad, 'entries' | 'chars' | 'largest' | 'estimatedServerBytes'> & Partial<Pick<LedgerTotals, 'since' | 'restartSeen' | 'restartSetByUser'>> & { serverCacheOff?: boolean | null; byKind?: LedgerTotals['byKind'] }): string {
  if (s.serverCacheOff) return 'This server keeps no parsed scripts (its noCache option is on): Companion adds nothing to its memory.';
  const k = s.byKind;
  const kinds = k ? ` Constant: ${k.constant.entries} (${Math.round(k.constant.chars / 1024)} KB); varying: ${k.varying.entries} (${Math.round(k.varying.chars / 1024)} KB); your own code and writes: ${k.user.entries} (${Math.round(k.user.chars / 1024)} KB).` : '';
  const since = countedSince(s);
  return `Companion holds about ${s.entries} of the 2,000 parsed scripts this server keeps (${Math.round(s.chars / 1024)} KB of text, the largest ${Math.round(s.largest / 1024)} KB, ${mbPhrase(s.estimatedServerBytes)} of server memory).${since ? ' ' + since : ''}${kinds}`;
}

/** The side panel's quiet notice when Companion's share is large (null
 *  below it). */
export function scriptMemoryNotice(s: Pick<LedgerTotals, 'entries' | 'estimatedServerBytes'> & Partial<Pick<LedgerTotals, 'since' | 'restartSeen' | 'restartSetByUser'>>): string | null {
  if (s.entries <= SCRIPT_COST.noticeEntries && s.estimatedServerBytes <= SCRIPT_COST.noticeBytes) return null;
  const since = countedSince(s);
  return `Companion has added about ${s.entries} parsed scripts (${mbPhrase(s.estimatedServerBytes)}) to this server's memory. The server keeps them until it restarts.${since ? ' ' + since : ''}`;
}

/** The Log line when background work may add new scripts again. */
export function scriptBudgetEndSentence(s: Pick<LedgerTotals, 'entries' | 'estimatedServerBytes'> & { restarted?: boolean; byUser?: boolean }): string {
  return `Background work resumed: ${s.byUser ? 'you reset the count after a server restart; Companion' : s.restarted ? 'the server restarted; Companion' : 'Companion'} now holds about ${s.entries} parsed scripts (${mbPhrase(s.estimatedServerBytes)}) in this server's memory.`;
}

/** Why a background post with a new script text was refused. */
export function scriptBudgetSentence(s: Pick<LedgerTotals, 'entries' | 'estimatedServerBytes'>): string {
  return `Background work paused: Companion already holds about ${s.entries} parsed scripts (${mbPhrase(s.estimatedServerBytes)}) in this server's memory. Work that needs a new script waits; your own actions are not affected.`;
}

export class LoadGovernor {
  private readonly now: () => number;
  private readonly shared: Record<'commands' | 'fullReads' | 'bytes', TokenBucket>;
  private readonly background: Record<'commands' | 'fullReads' | 'bytes', TokenBucket>;
  /** Full object reads per post now (adaptive). */
  fullReadsPerPost: number = GOVERNOR.fullReadsPerPost;
  private baseline: number[] = [];
  private recent: number[] = [];
  private slowUntil = 0;
  private overloadUntil = 0;
  private overloadDetail = '';
  private waiting: { waitMs: number } | null = null;
  private readonly listeners = new Set<() => void>();
  /** Called when waiting posts must be looked at again (an overload). */
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** The last posts (operation, size, time, how long the governor held
   *  each back), for the live check and diagnostics. */
  readonly recentPosts: Array<{ op: string; cls: LoadClass; commands: number; fullReads: number; bytes: number; ms: number; heldMs: number; ok: boolean; at: number; debit?: number }> = [];
  record(entry: Omit<LoadGovernor['recentPosts'][number], 'at'>): void {
    this.recentPosts.push({ ...entry, at: this.now() });
    if (this.recentPosts.length > 300) this.recentPosts.shift();
  }
  /** Counters for the status and the live check. */
  readonly counters = { posts: 0, commands: 0, fullReads: 0, bytes: 0, queued: 0, queuedMs: 0, rejected: 0, debited: 0 };

  // ── the script gauge ──────────────────────────────────────────────
  /** Companion's window of the server's script cache, kept across worker
   *  restarts (script-ledger.ts). */
  readonly ledger: ScriptLedger;
  /** The server's `noCache` option, once read (GetServerSettings). */
  private serverCacheOff: boolean | null = null;
  setServerCacheOff(off: boolean | null): void { this.serverCacheOff = off; }
  /** New script text per post, oldest first (the last hour, this worker). */
  private newScriptLog: Array<{ at: number; chars: number }> = [];
  private repeats = 0;
  private memoryNoticeGiven = false;
  private readonly noticeListeners = new Map<string, (text: string, kind: NoticeKind) => void>();
  /** One listener per owner (a profile): the memory notice goes to each
   *  profile's side panel, once while it lasts; the background limit to one
   *  Log (the first listener), once per server when it starts and once when
   *  it ends. The state written last is kept with the ledger, so a worker
   *  restart does not write it again. */
  setNoticeListener(owner: string, fn: ((text: string, kind: NoticeKind) => void) | null): void {
    if (fn) this.noticeListeners.set(owner, fn); else this.noticeListeners.delete(owner);
  }
  private emit(kind: NoticeKind, text: string, all: boolean): void {
    for (const fn of this.noticeListeners.values()) {
      try { fn(text, kind); } catch { /* the Log must not stop posts */ }
      if (!all) return;
    }
  }
  /** The background limit and the memory notice, against the ledger now. */
  private notices(restarted = false): void {
    // Before the stored ledger is read its window looks empty: no verdict.
    if (!this.ledger.loaded) return;
    const totals = this.ledger.totals();
    const paused = this.scriptBudgetUsed();
    const logged = this.ledger.pausedLogged;
    if (paused !== (logged ?? false)) {
      this.ledger.pausedLogged = paused;
      if (paused) this.emit('background', `${scriptSentence(totals)} ${scriptBudgetSentence(totals)}`, false);
      else this.emit('background-end', scriptBudgetEndSentence({ ...totals, restarted, byUser: restarted && totals.restartSetByUser }), false);
    }
    const memory = this.memoryNotice();
    if (!memory) this.memoryNoticeGiven = false;
    else if (!this.memoryNoticeGiven) { this.memoryNoticeGiven = true; this.emit('memory', memory, true); }
  }

  /** A change-feed pack id the server answered (tree-events.ts): one going
   *  back means the server restarted and holds none of Companion's parsed
   *  scripts any more (script-ledger.ts). No request of its own. */
  async noteServerCounter(packId: string): Promise<void> {
    this.lastPackId = packId;
    if (await this.ledger.noteServerCounter(packId)) this.notices(true);
  }
  /** The last change-feed pack id this worker saw for the server. */
  private lastPackId: string | null = null;

  /** "Server was restarted" (the Log): this server's count starts again,
   *  dated as set by the user; the pause ends through the usual path (one
   *  Log line). The feed's last pack id, when known, is the new baseline. */
  async resetScriptCount(): Promise<void> {
    await this.ledger.resetByUser(this.lastPackId);
    this.notices(true);
  }

  private hourScriptChars(t: number): number {
    while (this.newScriptLog.length && this.newScriptLog[0].at <= t - 3_600_000) this.newScriptLog.shift();
    let n = 0;
    for (const e of this.newScriptLog) n += e.chars;
    return n;
  }

  /** Characters of `scripts` the server very likely does not hold. */
  newScriptChars(scripts: ReadonlyArray<ScriptKey> | undefined): number {
    return this.ledger.newChars(scripts);
  }

  /** Background work that needs a new script text is refused now. */
  scriptBudgetUsed(): boolean {
    if (this.serverCacheOff) return false;
    const t = this.ledger.totals();
    return t.entries >= SCRIPT_COST.backgroundEntries || t.estimatedServerBytes >= SCRIPT_COST.backgroundBytes;
  }

  /** The script gauge (GET_SERVER_LOAD). */
  scriptLoad(): ScriptLoad {
    return {
      ...this.ledger.totals(),
      repeats: this.repeats,
      hourChars: this.hourScriptChars(this.now()),
      cacheEntries: SCRIPT_COST.cacheEntries,
      bytesPerChar: SCRIPT_COST.bytesPerChar,
      backgroundEntries: SCRIPT_COST.backgroundEntries,
      backgroundBytes: SCRIPT_COST.backgroundBytes,
      noticeEntries: SCRIPT_COST.noticeEntries,
      noticeBytes: SCRIPT_COST.noticeBytes,
      serverCacheOff: this.serverCacheOff,
      backgroundStopped: this.scriptBudgetUsed(),
    };
  }

  /** The side panel's notice now (null below the notice level). */
  memoryNotice(): string | null {
    return this.serverCacheOff ? null : scriptMemoryNotice(this.ledger.totals());
  }

  /** A post with these scripts starts: they are known from now on. */
  private recordScripts(scripts: ReadonlyArray<ScriptKey> | undefined, t: number): void {
    if (!scripts?.length) return;
    const { newChars, repeats } = this.ledger.record(scripts);
    this.repeats += repeats;
    if (newChars) this.newScriptLog.push({ at: t, chars: newChars });
    this.notices();
  }

  constructor(opts: { now?: () => number; ledgerKey?: string; ledgerStorage?: LedgerStorage | null } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ledger = new ScriptLedger({ now: this.now, key: opts.ledgerKey, storage: opts.ledgerStorage ?? null });
    const t = this.now();
    const make = (s: Record<'commands' | 'fullReads' | 'bytes', Bucket>) => ({ commands: new TokenBucket(s.commands, t), fullReads: new TokenBucket(s.fullReads, t), bytes: new TokenBucket(s.bytes, t) });
    this.shared = make(GOVERNOR.shared);
    this.background = make(GOVERNOR.background);
  }

  /** Time per command of the last post of read-only constant scripts and
   *  when it ended (null: none, it failed, or the governor saw an overload
   *  or a slow server since): the next such post starts with the debit that
   *  time stands for, for GOVERNOR.measured.historyMs. Without it a post
   *  starts at the old cost, one per command. */
  private measuredHistory: { msPerCommand: number; at: number } | null = null;

  /** The governor's own overload or slow state: no measured discount. */
  private stressed(t: number): boolean { return t < this.overloadUntil || t < this.slowUntil; }
  /** Start debits of measured posts in flight, settled by `observe`. */
  private readonly measuredStarts = new WeakMap<PostCost, number>();

  /** Commands a post debits when it starts. A user post of read-only
   *  constant scripts starts at what the last such post's time per command
   *  stands for (the old cost when there is none, or it was slow). */
  private startDebit(cls: LoadClass, cost: PostCost): number {
    if (!measuredOnly(cls, cost)) return commandDebit(cost);
    const t = this.now();
    const h = this.measuredHistory;
    if (!h || this.stressed(t) || t - h.at > GOVERNOR.measured.historyMs || t < h.at) return cost.commands;
    return measuredScriptDebit(cost.commands, h.msPerCommand * cost.commands);
  }

  /** Background work is stopped (overload) or paused (slow server). */
  backgroundBlocked(): { until: number; why: 'overloaded' | 'slow'; detail?: string } | null {
    const t = this.now();
    if (t < this.overloadUntil) return { until: this.overloadUntil, why: 'overloaded', detail: this.overloadDetail };
    if (t < this.slowUntil) return { until: this.slowUntil, why: 'slow' };
    return null;
  }

  /** How long a post of `cost` must wait before it may start (0: now). A
   *  background post during an overload cool-down is refused (-1); one that
   *  carries new script text once today's script budget is used, too (-2). */
  admit(cls: LoadClass, cost: PostCost): number {
    const t = this.now();
    if (cls === 'background' && t < this.overloadUntil) return -1;
    if (cls === 'background' && this.scriptBudgetUsed() && this.newScriptChars(cost.scripts) > 0) return -2;
    // Bytes are charged after the answer: a budget in debt delays the next post.
    const debit = this.startDebit(cls, cost);
    const parts = [this.shared.commands.waitFor(debit, t), this.shared.fullReads.waitFor(cost.fullReads, t), this.shared.bytes.waitFor(1, t)];
    if (cls === 'background') {
      parts.push(this.background.commands.waitFor(debit, t), this.background.fullReads.waitFor(cost.fullReads, t), this.background.bytes.waitFor(1, t));
      if (t < this.slowUntil) parts.push(this.slowUntil - t);
    }
    const wait = Math.max(0, ...parts);
    this.waiting = wait ? { waitMs: wait } : null;
    return wait;
  }

  /** A post starts: take its commands (commandDebit) and full reads. */
  start(cls: LoadClass, cost: PostCost, waitedMs: number): void {
    const t = this.now();
    const debit = this.startDebit(cls, cost);
    if (measuredOnly(cls, cost)) this.measuredStarts.set(cost, debit);
    this.shared.commands.take(debit, t);
    this.shared.fullReads.take(cost.fullReads, t);
    this.counters.debited += debit;
    if (cls === 'background') { this.background.commands.take(debit, t); this.background.fullReads.take(cost.fullReads, t); }
    this.recordScripts(cost.scripts, t);
    this.counters.posts++;
    this.counters.commands += cost.commands;
    this.counters.fullReads += cost.fullReads;
    if (waitedMs > 0) { this.counters.queued++; this.counters.queuedMs += waitedMs; }
    this.waiting = null;
  }

  /** The answer of a post: charge its bytes and, for a post of index reads
   *  only, the commands its measured time stands for beyond its start debit;
   *  learn from its time. Returns the commands the post was debited in all. */
  observe(cls: LoadClass, cost: PostCost, outcome: { ok: boolean; durationMs: number; responseBytes: number; overload?: boolean; detail?: string }): number {
    const t = this.now();
    this.shared.bytes.take(outcome.responseBytes, t);
    if (cls === 'background') this.background.bytes.take(outcome.responseBytes, t);
    this.counters.bytes += outcome.responseBytes;
    let debit = commandDebit(cost);
    const started = this.measuredStarts.get(cost);
    if (started != null) {
      // Read-only constant scripts: settle the start debit to the measured
      // cost. A failed or overloaded post costs one per command (the old
      // cost) and makes the next such post start at the old cost too.
      this.measuredStarts.delete(cost);
      const fine = outcome.ok && !outcome.overload && !this.stressed(t);
      const final = fine ? measuredScriptDebit(cost.commands, outcome.durationMs) : cost.commands;
      this.measuredHistory = fine ? { msPerCommand: Math.max(0, outcome.durationMs) / cost.commands, at: t } : null;
      const extra = final - started;
      if (extra > 0) this.shared.commands.take(extra, t);
      else if (extra < 0) this.shared.commands.give(-extra, t);
      this.counters.debited += extra;
      debit = final;
    } else if (cost.commands > 0 && (cost.index ?? 0) >= cost.commands) {
      const extra = measuredIndexDebit(cost, outcome.durationMs) - debit;
      if (extra > 0) {
        this.shared.commands.take(extra, t);
        if (cls === 'background') this.background.commands.take(extra, t);
        this.counters.debited += extra;
        debit += extra;
      }
    }
    if (outcome.overload) { this.noteOverload(outcome.detail ?? 'The server answered like an overloaded one'); return debit; }
    if (cost.fullReads > 0 && outcome.ok) {
      if (outcome.responseBytes > GOVERNOR.largeBytes || outcome.durationMs > GOVERNOR.slowMs) {
        this.fullReadsPerPost = Math.max(GOVERNOR.minFullReadsPerPost, Math.floor(this.fullReadsPerPost / 2));
      } else if (outcome.responseBytes < GOVERNOR.largeBytes / 4 && outcome.durationMs < GOVERNOR.slowMs / 4) {
        this.fullReadsPerPost = Math.min(GOVERNOR.fullReadsPerPost, Math.ceil(this.fullReadsPerPost * 1.5));
      }
    }
    if (outcome.ok && cost.commands === 1 && outcome.responseBytes <= GOVERNOR.light.maxBytes) this.noteLight(outcome.durationMs);
    return debit;
  }

  private noteLight(ms: number): void {
    const L = GOVERNOR.light;
    if (this.baseline.length < L.baselineSamples) { this.baseline.push(ms); return; }
    this.recent.push(ms);
    if (this.recent.length > L.recentSamples) this.recent.shift();
    if (this.recent.length < L.recentSamples) return;
    const base = median(this.baseline);
    const now = median(this.recent);
    if (now > Math.max(L.minMs, base * L.factor)) {
      this.slowUntil = this.now() + L.pauseMs;
      this.recent = [];
      this.measuredHistory = null;
    }
  }

  /** An overload signal anywhere: background work stops for the cool-down. */
  noteOverload(detail: string): void {
    this.overloadUntil = this.now() + GOVERNOR.cooldownMs;
    this.measuredHistory = null;
    this.overloadDetail = detail.split('\n')[0].slice(0, 160);
    this.fullReadsPerPost = GOVERNOR.minFullReadsPerPost;
    for (const fn of this.listeners) { try { fn(); } catch { /* a listener must not stop the others */ } }
  }

  state(): LoadState {
    const t = this.now();
    if (t < this.overloadUntil) return { state: 'overloaded', until: this.overloadUntil, detail: this.overloadDetail };
    if (this.waiting) return { state: 'waiting', waitMs: this.waiting.waitMs, reason: 'budget' };
    if (t < this.slowUntil) return { state: 'slow', until: this.slowUntil };
    return { state: 'ok' };
  }
}

/** A user post made only of read-only constant scripts (PostCost.measured).
 *  Background work keeps one per command: its budgets do not change. */
function measuredOnly(cls: LoadClass, cost: PostCost): boolean {
  return cls === 'user' && cost.commands > 0 && cost.fullReads === 0 && (cost.measured ?? 0) >= cost.commands;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Does an error text read like an overloaded server? */
export const OVERLOAD_TEXT = /OutOfMemory|heap space|GC overhead|HTTP 5\d\d|\b50[234]\b|timed out|time-?out|Too many requests|HTTP 429|Service Unavailable|Bad Gateway|overload/i;

/** One sentence for the status bar (null: nothing to say). */
export function loadSentence(s: LoadState, now = Date.now()): string | null {
  const mins = (until: number) => Math.max(1, Math.ceil((until - now) / 60_000));
  switch (s.state) {
    case 'waiting': return `Waiting for the server: the extension keeps its load low (${Math.ceil(s.waitMs / 1000)} s).`;
    case 'slow': return `The server answers slowly: background work paused for ${mins(s.until)} min.`;
    case 'overloaded': return `The server answered like an overloaded one: background work stopped for ${mins(s.until)} min.`;
    default: return null;
  }
}

/** One governor per server (base URL): every profile and client of that
 *  server shares its budgets, and its script ledger (kept in
 *  chrome.storage.local under the server's URL). */
const governors = new Map<string, LoadGovernor>();
export function governorFor(serverUrl: string): LoadGovernor {
  let g = governors.get(serverUrl);
  if (!g) { g = new LoadGovernor({ ledgerKey: `crev_script_ledger:${serverUrl}`, ledgerStorage: chromeLedgerStorage() }); governors.set(serverUrl, g); }
  return g;
}

/** Unit tests start every test with fresh budgets (src/test-setup.ts). */
export function resetLoadGovernors(): void { governors.clear(); }
