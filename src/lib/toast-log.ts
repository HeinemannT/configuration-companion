/**
 * Worker side of "Show in Log": an error toast needs a Log record to point at.
 *
 * Handlers that fail usually log the failure and then toast it; others only
 * toast. `logIdForError` reuses a recent error entry that already says the
 * same thing and records one otherwise, so the toast's link always lands on
 * an entry without logging the same failure twice.
 */

import { getActivityLog, logActivity } from './activity';

/** How far back an existing error entry still counts as this toast's record. */
const RECENT_MS = 10_000;

export function logIdForError(text: string, profileId?: string, detail?: string): number {
  const now = Date.now();
  const log = getActivityLog();
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (now - entry.time > RECENT_MS) break;
    if (entry.level !== 'error') continue;
    if (profileId && entry.profileId && entry.profileId !== profileId) continue;
    if (entry.message === text || entry.message.includes(text) || text.includes(entry.message)) return entry.id;
    // A handler logs "Save failed on X" with the server's reason as detail, then toasts "Save failed: <reason>".
    if (entry.detail && entry.detail.length >= 8 && text.includes(entry.detail)) return entry.id;
  }
  return logActivity('error', text, detail, { category: 'system', action: 'error-toast' }, profileId).id;
}

/** A panel that is still opening cannot be told yet: its Log entry waits here
 *  until the panel says hello, and is dropped if that takes too long. */
const HOLD_MS = 10_000;
const held = new Map<number, { id: number; at: number }>();

export function holdLogEntryForPanel(windowId: number, id: number): void {
  held.set(windowId, { id, at: Date.now() });
}

export function takeHeldLogEntry(windowId: number): number | undefined {
  const entry = held.get(windowId);
  held.delete(windowId);
  return entry && Date.now() - entry.at <= HOLD_MS ? entry.id : undefined;
}
