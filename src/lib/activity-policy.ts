/**
 * What the activity log keeps when it is full, and how it folds repeats.
 * Shared by the worker (activity.ts) and the panel's copy (log tab), so both
 * trim the same way. Stored format and key are unchanged; `count` is an
 * optional field on merged diagnostic entries.
 *
 *  - User work (saves, runs, Blueprint, Studio, connection events, any error)
 *    is kept; when the log exceeds ACTIVITY_MAX the oldest diagnostic entry
 *    (detection, page connection, background reads, enrichment) goes first.
 *  - A diagnostic that repeats the same sentence within MERGE_WINDOW_MS of an
 *    earlier one is folded into it: its time moves forward and `count` grows.
 */
import type { ActivityEntry, ActivityMeta } from './types';

export const MERGE_WINDOW_MS = 60_000;
/** How far back a repeat is looked for (entries, newest first). */
const MERGE_LOOKBACK = 40;

export function isUserWork(entry: Pick<ActivityEntry, 'level' | 'category'>): boolean {
  return entry.level === 'error' || (entry.category != null && entry.category !== 'system');
}

/**
 * Drop entries until `max` remain: oldest diagnostic first, then oldest
 * overall. The newest diagnostics (a tenth of `max`) are kept even in a log
 * full of user work, so a new page-connection line is not dropped the moment
 * it is written; past that floor, the oldest user work makes room.
 */
export function trimActivity(entries: ActivityEntry[], max: number): void {
  const floor = Math.floor(max / 10);
  while (entries.length > max) {
    const diagnostics = entries.reduce((n, e) => n + (isUserWork(e) ? 0 : 1), 0);
    const i = diagnostics > floor ? entries.findIndex(e => !isUserWork(e)) : entries.findIndex(isUserWork);
    entries.splice(i >= 0 ? i : 0, 1);
  }
}

/** Index of an earlier diagnostic the new one repeats, or -1. */
export function findRepeat(entries: readonly ActivityEntry[], next: ActivityEntry): number {
  if (isUserWork(next)) return -1;
  const stop = Math.max(0, entries.length - MERGE_LOOKBACK);
  for (let i = entries.length - 1; i >= stop; i--) {
    const e = entries[i];
    if (next.time - e.time > MERGE_WINDOW_MS) break;
    if (!isUserWork(e) && e.message === next.message && e.level === next.level && e.profileId === next.profileId) return i;
  }
  return -1;
}

/** Fold `next` into the repeat at `index`; the merged entry moves to the end. */
export function mergeRepeat(entries: ActivityEntry[], index: number, next: ActivityEntry): ActivityEntry {
  const [prev] = entries.splice(index, 1);
  const merged: ActivityEntry = {
    ...prev,
    time: next.time,
    count: (prev.count ?? 1) + 1,
    ...(next.detail !== undefined ? { detail: next.detail } : {}),
    ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
  };
  entries.push(merged);
  return merged;
}

/** A trailing "(123ms)" in a sentence belongs in the duration column. */
export function tidyMessage(message: string, meta?: Pick<ActivityMeta, 'durationMs'>): { message: string; durationMs?: number } {
  const m = /\s*\((\d+)\s?ms\)$/.exec(message);
  if (!m) return { message, ...(meta?.durationMs !== undefined ? { durationMs: meta.durationMs } : {}) };
  return { message: message.slice(0, m.index), durationMs: meta?.durationMs ?? Number(m[1]) };
}
