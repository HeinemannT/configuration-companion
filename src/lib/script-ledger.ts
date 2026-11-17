/**
 * The script ledger: which distinct Extended Code texts Companion has sent to
 * one server lately, kept across worker restarts.
 *
 * What the server does (measured on a BMP server): every script
 * is parsed through one static cache keyed by the exact text only (not the
 * context object, the user, or preview against execute), at most 2,000
 * entries, counted by entry and not by size, evicted about least recently
 * used, never expired; only a server restart clears it, or the server start
 * option `noCache` turns it off. A cached tree costs about 40 bytes of heap
 * per character of its text (measured on a restarted server). The
 * configuration's own expressions, the portal's tables and buttons and other
 * clients share that cache, so every new text of ours can also push out one
 * of theirs.
 *
 * So the ledger models Companion's share of that cache: a window of the last
 * SCRIPT_COST.cacheEntries distinct texts Companion sent (a 64-bit hash and
 * the length each, most recently used last). Its size is an upper bound of
 * what the server still holds for us: the server's own traffic may have
 * evicted some. An entry not sent for SCRIPT_COST.staleMs leaves the window
 * (a week of other traffic has very likely evicted it). Kept in
 * chrome.storage.local (about 60 KB per server).
 *
 * A restart: no server start time is reported anywhere Companion reads. The
 * one free signal is the change feed's pack counter (tree-events.ts), which
 * every TreeEventCommand answer carries and which starts again when the
 * server restarts: an id below the largest one seen (`mark`) means the
 * server restarted, and the window is emptied (`noteServerCounter`). It is
 * seen only while the code search's feed runs; a restart the counter has
 * already passed again by then goes unseen. So the totals are an estimate
 * since the server was last seen restarting (or since the ledger started).
 */

import type { ScriptKey } from './load-governor';
import type { ScriptKind } from './script-kinds';

const KINDS: readonly ScriptKind[] = ['constant', 'varying', 'user'];
const KIND_CODE: Record<ScriptKind, number> = { constant: 0, varying: 1, user: 2 };
/** A text sent before kinds were recorded counts as varying. */
const kindOf = (code: unknown): ScriptKind => KINDS[Number(code)] ?? 'varying';
/** A Java long as text (pack ids): compared as BigInt, never a JS number. */
const LONG = /^-?\d{1,20}$/;

export const SCRIPT_COST = {
  /** The server's parse cache holds this many texts (ExtCache maximumSize). */
  cacheEntries: 2_000,
  /** Server heap per character of a cached text (measured, rounded). */
  bytesPerChar: 40,
  /** Background work adds no NEW text once Companion holds this many entries
   *  or this much estimated memory in the server's cache. PLACEHOLDERS. */
  backgroundEntries: 200,
  backgroundBytes: 40_000_000,
  /** The side panel shows a quiet notice past these. PLACEHOLDERS. */
  noticeEntries: 500,
  noticeBytes: 100_000_000,
  staleMs: 7 * 86_400_000,
  persistDelayMs: 2_000,
} as const;

export interface LedgerStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

interface Persisted {
  v: 2 | 3;
  /** The largest change-feed pack id seen (a Java long, as text). */
  mark?: string;
  /** When a restart was last seen (a pack id below `mark`), or set by the user. */
  restartAt?: number;
  /** 1: `restartAt` was set by the user ("Server was restarted"). */
  restartBy?: 1;
  /** The background limit's state last written to the Log (1: paused). */
  paused?: 0 | 1;
  since: number;
  sent: number;
  sentChars: number;
  /** v3: new texts and their characters per kind since `since`. */
  byKind?: Partial<Record<ScriptKind, [number, number]>>;
  /** [key, chars, last sent, kind (v3)] in order of use, oldest first. */
  window: Array<[string, number, number, number?]>;
}

/** Per kind: texts in the window and their characters, and new texts sent
 *  since the ledger's start with their characters. */
export interface KindTotals { entries: number; chars: number; distinct: number; distinctChars: number }

export interface LedgerTotals {
  /** Distinct texts in Companion's window of the server's cache, their
   *  characters and the largest. */
  entries: number;
  chars: number;
  largest: number;
  /** Share of the server's 2,000 entries, and the estimated memory. */
  share: number;
  estimatedServerBytes: number;
  /** New distinct texts sent since `since` (the ledger's start). */
  distinct: number;
  distinctChars: number;
  /** Start of the count: when the server was last seen restarting, else
   *  when the ledger started. */
  since: number;
  /** `since` is a restart Companion saw (or the user reported). */
  restartSeen: boolean;
  /** The user reported that restart ("Server was restarted"). */
  restartSetByUser: boolean;
  /** The same, per kind (script-kinds.ts). */
  byKind: Record<ScriptKind, KindTotals>;
}

export class ScriptLedger {
  private readonly now: () => number;
  /** key → [chars, last sent, kind]; Map order is use order (oldest first). */
  private window = new Map<string, [number, number, ScriptKind]>();
  private since: number;
  private sent = 0;
  private sentChars = 0;
  private sentByKind: Record<ScriptKind, [number, number]> = { constant: [0, 0], varying: [0, 0], user: [0, 0] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly key: string | null;
  private readonly storage: LedgerStorage | null;
  private mark: string | null = null;
  private restartAt: number | null = null;
  private restartByUser = false;
  private paused: boolean | null = null;
  /** The stored ledger was read (or there is no store). */
  loaded: boolean;
  /** Resolves when the stored ledger was read (or there was none). */
  readonly ready: Promise<void>;

  constructor(opts: { now?: () => number; key?: string; storage?: LedgerStorage | null } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.since = this.now();
    this.key = opts.key ?? null;
    this.storage = opts.storage ?? null;
    this.loaded = !this.key || !this.storage;
    this.ready = this.load().finally(() => { this.loaded = true; });
  }

  private async load(): Promise<void> {
    if (!this.key || !this.storage) return;
    try {
      const raw = await this.storage.get(this.key) as Partial<Persisted> | undefined;
      if (!raw || (raw.v !== 2 && raw.v !== 3) || !Array.isArray(raw.window)) return;
      const merged = new Map<string, [number, number, ScriptKind]>();
      for (const e of raw.window) if (Array.isArray(e) && typeof e[0] === 'string') merged.set(e[0], [Number(e[1]) || 0, Number(e[2]) || 0, kindOf(e[3])]);
      // Texts sent in this worker before the load are the most recent.
      for (const [k, v] of this.window) { merged.delete(k); merged.set(k, v); }
      this.window = merged;
      this.since = Math.min(this.since, Number(raw.since) || this.since);
      this.sent += Number(raw.sent) || 0;
      this.sentChars += Number(raw.sentChars) || 0;
      for (const k of KINDS) {
        const v = raw.byKind?.[k];
        if (Array.isArray(v)) { this.sentByKind[k][0] += Number(v[0]) || 0; this.sentByKind[k][1] += Number(v[1]) || 0; }
      }
      if (typeof raw.mark === 'string' && LONG.test(raw.mark)) this.mark = this.mark && BigInt(this.mark) > BigInt(raw.mark) ? this.mark : raw.mark;
      if (typeof raw.restartAt === 'number') { this.restartAt = raw.restartAt; this.restartByUser = raw.restartBy === 1; }
      if (raw.paused === 0 || raw.paused === 1) this.paused = raw.paused === 1;
      this.trim();
    } catch { /* an unreadable ledger starts again */ }
  }

  private trim(): void {
    const old = this.now() - SCRIPT_COST.staleMs;
    for (const [k, [, at]] of this.window) {
      if (at >= old && this.window.size <= SCRIPT_COST.cacheEntries) break;
      this.window.delete(k);
    }
  }

  /** A change-feed pack id the server answered (tree-events.ts). One below
   *  the largest seen means the server restarted and dropped its parsed
   *  scripts: the window and the counts start again. True: a restart. */
  async noteServerCounter(packId: string): Promise<boolean> {
    if (!LONG.test(packId)) return false;
    await this.ready;
    const id = BigInt(packId);
    if (this.mark != null && id < BigInt(this.mark)) {
      this.restarted(packId, false);
      return true;
    }
    // No mark yet (a ledger from an earlier build, or a reset without a
    // known pack id): the first id is the baseline, not a restart.
    if (this.mark == null || id > BigInt(this.mark)) { this.mark = packId; this.schedulePersist(); }
    return false;
  }

  /** The user says the server was restarted: the count starts again now.
   *  `packId`: the feed's current pack id as the new baseline, when known;
   *  else the next answer sets it. */
  async resetByUser(packId: string | null): Promise<void> {
    await this.ready;
    this.restarted(packId != null && LONG.test(packId) ? packId : null, true);
  }

  private restarted(mark: string | null, byUser: boolean): void {
    this.window.clear();
    this.since = this.restartAt = this.now();
    this.restartByUser = byUser;
    this.sent = this.sentChars = 0;
    for (const k of KINDS) this.sentByKind[k] = [0, 0];
    this.mark = mark;
    this.schedulePersist();
  }

  /** The background limit's state last written to the Log (null: none yet). */
  get pausedLogged(): boolean | null { return this.paused; }
  set pausedLogged(on: boolean | null) {
    if (this.paused === on) return;
    this.paused = on;
    this.schedulePersist();
  }

  /** The text is in Companion's window (the server very likely has it). */
  has(key: string): boolean {
    const e = this.window.get(key);
    return !!e && e[1] >= this.now() - SCRIPT_COST.staleMs;
  }

  /** Characters of `scripts` not in the window (each distinct text once). */
  newChars(scripts: ReadonlyArray<ScriptKey> | undefined): number {
    let n = 0;
    const counted = new Set<string>();
    for (const s of scripts ?? []) {
      if (counted.has(s.key) || this.has(s.key)) continue;
      counted.add(s.key);
      n += s.chars;
    }
    return n;
  }

  /** The scripts of a post that starts: each moves to the newest end of the
   *  window (as the server's LRU does); new ones are counted. */
  record(scripts: ReadonlyArray<ScriptKey> | undefined): { newChars: number; newCount: number; repeats: number } {
    const t = this.now();
    let newChars = 0, newCount = 0, repeats = 0;
    for (const s of scripts ?? []) {
      const kind = s.kind ?? 'varying';
      if (this.has(s.key)) repeats++;
      else {
        newChars += s.chars; newCount++;
        this.sentByKind[kind][0]++;
        this.sentByKind[kind][1] += s.chars;
      }
      this.window.delete(s.key);
      this.window.set(s.key, [s.chars, t, kind]);
    }
    if (newCount) { this.sent += newCount; this.sentChars += newChars; }
    this.trim();
    if (scripts?.length) this.schedulePersist();
    return { newChars, newCount, repeats };
  }

  totals(): LedgerTotals {
    this.trim();
    let chars = 0, largest = 0;
    const byKind = Object.fromEntries(KINDS.map(k => [k, { entries: 0, chars: 0, distinct: this.sentByKind[k][0], distinctChars: this.sentByKind[k][1] }])) as Record<ScriptKind, KindTotals>;
    for (const [c, , kind] of this.window.values()) {
      chars += c; largest = Math.max(largest, c);
      byKind[kind].entries++;
      byKind[kind].chars += c;
    }
    return {
      entries: this.window.size,
      chars,
      largest,
      share: this.window.size / SCRIPT_COST.cacheEntries,
      estimatedServerBytes: chars * SCRIPT_COST.bytesPerChar,
      distinct: this.sent,
      distinctChars: this.sentChars,
      since: this.since,
      restartSeen: this.restartAt != null && this.restartAt >= this.since,
      restartSetByUser: this.restartAt != null && this.restartAt >= this.since && this.restartByUser,
      byKind,
    };
  }

  private schedulePersist(): void {
    if (!this.key || !this.storage || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.persist(); }, SCRIPT_COST.persistDelayMs);
  }

  /** Write the ledger now (also used by tests). */
  async persist(): Promise<void> {
    if (!this.key || !this.storage) return;
    await this.ready;
    const value: Persisted = {
      v: 3, since: this.since, sent: this.sent, sentChars: this.sentChars, byKind: { ...this.sentByKind },
      ...(this.mark != null ? { mark: this.mark } : {}),
      ...(this.restartAt != null ? { restartAt: this.restartAt } : {}),
      ...(this.restartByUser ? { restartBy: 1 as const } : {}),
      ...(this.paused != null ? { paused: this.paused ? 1 as const : 0 as const } : {}),
      window: [...this.window].map(([k, [c, at, kind]]) => [k, c, at, KIND_CODE[kind]]),
    };
    try { await this.storage.set(this.key, value); } catch { /* the window stays in memory */ }
  }
}

/** chrome.storage.local as a ledger store, when the extension has it. */
export function chromeLedgerStorage(): LedgerStorage | null {
  const local = (globalThis as { chrome?: { storage?: { local?: { get?: unknown; set?: unknown } } } }).chrome?.storage?.local;
  if (!local || typeof local.get !== 'function' || typeof local.set !== 'function') return null;
  const area = local as unknown as { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void> };
  return {
    get: async key => (await area.get(key))?.[key],
    set: async (key, value) => { await area.set({ [key]: value }); },
  };
}

/** Megabytes, rounded for a sentence: "about 40 MB", "about 4.9 MB", "under 1 MB". */
export function mbPhrase(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 10 ? `about ${Math.round(mb)} MB` : mb >= 1 ? `about ${mb.toFixed(1)} MB` : 'under 1 MB';
}
