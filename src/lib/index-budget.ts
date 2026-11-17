/**
 * The code index is gentle with the server by design. Every request the
 * index (and the server-scan fallback, and the object search) sends goes
 * through these rules:
 *
 *  1. Budget per request. One script per post. A code read holds at most
 *     `readObjects` objects (a type's first read 10, then between 1 and 100) and aims at a
 *     response of `targetBytes`, sized from the bytes per object of the
 *     previous answer; a response over `maxBytes` or slower than `slowMs`
 *     halves the next one. A list holds at most `listRows` objects (RID, stamp and
 *     organisation; with the per-request frame markers about 260 bytes a
 *     row as measured: 1,000 rows ≈ 260 KB, no code). A
 *     full object read (discovery samples) holds `sampleObjects` objects: one
 *     batch of 9 such reads once answered 4.3 MB, so two stay near 1 MB.
 *  2. Pacing. Before each background post the pacer waits as long as the
 *     previous post took (at least `minPauseMs`, at most `maxPauseMs`): the
 *     server works at most half the time for the index. One index job per
 *     server, and only the user starts one.
 *  3. Overload stops the job. An answer that reads like an overloaded
 *     server (out of memory, HTTP 5xx, a time-out) ends the job at once
 *     with a clear status, without retrying the heavy step; automatic work
 *     waits `cooldownMs`.
 *
 * The numbers: a read of 40 objects of the test server's average code
 * (840 characters) answers about 35 KB; 100 objects about 85 KB; the
 * largest single code body seen there was under 60 KB. 600 KB keeps a
 * response well under 1 MB even with non-ASCII text.
 */

import type { EcResult } from './bmp-client';

export const BUDGET = {
  readObjects: 40,
  /** The first read of a type: its code size is not known yet. */
  firstReadObjects: 10,
  minReadObjects: 1,
  maxReadObjects: 100,
  targetBytes: 300_000,
  maxBytes: 600_000,
  slowMs: 8_000,
  listRows: 1_000,
  /** Types per discovery script (each type: one select per source). */
  typesPerScript: 16,
  /** (list, type) pairs per counting script: one select each, released
   *  after its size is read; no code, about 60 bytes a row. */
  countsPerScript: 64,
  sampleObjects: 2,
  minPauseMs: 500,
  maxPauseMs: 30_000,
  cooldownMs: 30 * 60_000,
} as const;

/** The server answered like an overloaded one: the job stops. */
export class ServerOverloadError extends Error {
  constructor(message: string) { super(message); this.name = 'ServerOverloadError'; }
}

const OVERLOAD = /OutOfMemory|heap space|GC overhead|HTTP 5\d\d|\b50[234]\b|timed out|time-?out|Too many requests|HTTP 429|Service Unavailable|Bad Gateway|overloaded/i;

/** Does this answer read like an overloaded server? */
export function isOverload(r: Pick<EcResult, 'ok' | 'error' | 'log' | 'errorKind'>): boolean {
  if (r.errorKind === 'timeout') return true;
  if (r.ok && !r.error) return false;
  return OVERLOAD.test(`${r.error ?? ''}\n${r.ok ? '' : r.log ?? ''}`);
}

/** One request of an index job, for the status and the live check. */
export interface RequestRecord { op: string; objects: number; bytes: number; ms: number; pauseMs: number; ok: boolean }

export interface PacerOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minPauseMs?: number;
  maxPauseMs?: number;
  /** Objects in a type's first read (BUDGET.firstReadObjects). */
  firstReadObjects?: number;
}

/**
 * Paces the posts of one job and adapts the read size. `post` waits the
 * pause the previous post earned, runs one request, records it, and throws
 * `ServerOverloadError` when the answer reads like an overloaded server.
 */
export class Pacer {
  readonly log: RequestRecord[] = [];
  /** Objects per code read script now (the last type read). */
  readSize: number = BUDGET.readObjects;
  /** Objects per read script per type: a type starts at
   *  `firstReadObjects` and is sized from its own answers. */
  private readonly sizes = new Map<string, number>();
  private pause = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minPause: number;
  private readonly firstRead: number;
  private readonly maxPause: number;

  constructor(opts: PacerOptions = {}) {
    // Unit tests pin a sleep that does not wait (src/test-setup.ts).
    const pinned = (globalThis as { __crevTestPacerSleep?: (ms: number) => Promise<void> }).__crevTestPacerSleep;
    this.sleep = opts.sleep ?? pinned ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.minPause = opts.minPauseMs ?? BUDGET.minPauseMs;
    this.firstRead = opts.firstReadObjects ?? BUDGET.firstReadObjects;
    this.maxPause = opts.maxPauseMs ?? BUDGET.maxPauseMs;
  }

  async post(op: string, objects: number, run: () => Promise<EcResult[]>, signal?: AbortSignal): Promise<EcResult[]> {
    const pauseMs = this.pause;
    if (pauseMs) await this.sleep(pauseMs);
    signal?.throwIfAborted();
    const t0 = this.now();
    let res: EcResult[];
    try {
      res = await run();
    } catch (e) {
      const ms = this.now() - t0;
      this.log.push({ op, objects, bytes: 0, ms, pauseMs, ok: false });
      const message = e instanceof Error ? e.message : String(e);
      if (isOverload({ ok: false, error: message, errorKind: (e as { kind?: EcResult['errorKind'] }).kind })) throw new ServerOverloadError(message);
      throw e;
    }
    const ms = this.now() - t0;
    const bytes = res.reduce((n, r) => n + (r.log?.length ?? 0) + (r.error?.length ?? 0), 0);
    const ok = res.every(r => r.ok);
    this.log.push({ op, objects, bytes, ms, pauseMs, ok });
    this.pause = Math.min(this.maxPause, Math.max(this.minPause, ms));
    const bad = res.find(isOverload);
    if (bad) throw new ServerOverloadError(bad.error || bad.log || 'The server is overloaded');
    return res;
  }

  /** Adapt the read size to the answer of a read of `objects` objects:
   *  the next read aims at `targetBytes` from this answer's bytes per
   *  object (at most one and a half times this size); an answer over
   *  `maxBytes` or slower than `slowMs` halves it. Measured live: growing
   *  by half on small answers alone let one read reach 1.9 MB. */
  /** Objects for the next read of `type`. */
  readSizeFor(type: string): number {
    return this.sizes.get(type) ?? this.firstRead;
  }

  adapt(bytes: number, ms: number, objects = this.readSize, type?: string): void {
    if (type) this.readSize = this.readSizeFor(type);
    const perObject = Math.max(1, bytes / Math.max(1, objects));
    const fit = Math.floor(BUDGET.targetBytes / perObject);
    if (bytes > BUDGET.maxBytes || ms > BUDGET.slowMs) {
      this.readSize = Math.max(BUDGET.minReadObjects, Math.min(fit, Math.floor(Math.min(this.readSize, objects) / 2)));
      if (type) this.sizes.set(type, this.readSize);
      return;
    }
    const next = Math.min(fit, Math.ceil(Math.max(this.readSize, objects) * 1.5));
    this.readSize = Math.max(BUDGET.minReadObjects, Math.min(BUDGET.maxReadObjects, ms < BUDGET.slowMs / 4 ? next : Math.min(next, this.readSize)));
    if (type) this.sizes.set(type, this.readSize);
  }
}

/** Split `items` into groups of at most `rows` by their weight (expected
 *  rows); an item heavier than `rows` goes alone. */
export function packByRows<T>(items: readonly T[], weight: (t: T) => number, rows: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let n = 0;
  for (const it of items) {
    const w = Math.max(0, weight(it));
    if (cur.length && n + w > rows) { out.push(cur); cur = []; n = 0; }
    cur.push(it);
    n += w;
  }
  if (cur.length) out.push(cur);
  return out;
}
