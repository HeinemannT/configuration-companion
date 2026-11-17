/**
 * How many badge identities a page may ask for.
 *
 * A page chooses the rids it shows, and a script on the page can add badges
 * of its own, so every ENRICH_BADGES message is capped: at most
 * ENRICH_RIDS_PER_MESSAGE rids per message and ENRICH_RIDS_PER_MINUTE rids
 * per tab in any 60 seconds. A real page shows a few hundred badges at most;
 * a reconnect can merge several scans into one message, which the per-message
 * cap leaves room for. Rids beyond the budget are answered empty (the badge
 * stops loading; the card's Retry asks again later).
 */
import { isRidShaped } from './rid-shape';

export const ENRICH_RIDS_PER_MESSAGE = 1_000;
export const ENRICH_RIDS_PER_MINUTE = 3_000;
const WINDOW_MS = 60_000;

/** Per tab: when each admitted batch was asked for, and how many rids. */
const spent = new Map<number, Array<{ at: number; n: number }>>();

export interface EnrichAdmission { admitted: string[]; refused: string[] }

/** Split one message's rids into those this tab may still ask for and the
 *  rest. Duplicates and rids that are not rid-shaped are dropped. */
export function admitEnrichRids(tabId: number | undefined, rids: unknown, now = Date.now()): EnrichAdmission {
  const unique = Array.isArray(rids)
    ? [...new Set(rids.filter((r): r is string => typeof r === 'string').map(r => r.trim()))].filter(r => isRidShaped(r))
    : [];
  const perMessage = unique.slice(0, ENRICH_RIDS_PER_MESSAGE);
  const overMessage = unique.slice(ENRICH_RIDS_PER_MESSAGE);
  if (tabId == null) return { admitted: perMessage, refused: overMessage };
  const recent = (spent.get(tabId) ?? []).filter(e => now - e.at < WINDOW_MS);
  const used = recent.reduce((sum, e) => sum + e.n, 0);
  const room = Math.max(0, ENRICH_RIDS_PER_MINUTE - used);
  const admitted = perMessage.slice(0, room);
  if (admitted.length) recent.push({ at: now, n: admitted.length });
  if (recent.length) spent.set(tabId, recent); else spent.delete(tabId);
  return { admitted, refused: [...perMessage.slice(room), ...overMessage] };
}

/** The tab closed or left its page. */
export function forgetEnrichBudget(tabId: number): void { spent.delete(tabId); }

/** Unit tests start from an empty budget. */
export function resetEnrichBudgets(): void { spent.clear(); }
