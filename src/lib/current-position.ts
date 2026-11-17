/**
 * Current position: per tab, the object the user last pointed at.
 *
 * Set by a badge click, a right-click, the object window (its root and its
 * selected node) and the side panel's page picker (Browse). Stored in the
 * context-rid map (context-rid.ts) and published to the side panel of the
 * tab's window as CONTEXT_RID_DATA with `source`. When nothing was pointed at,
 * the page's bound object stands in (GET_CONTEXT_RID, PAGE_CONTEXT) and
 * `source` is absent. A page change clears the pointer (detection handler,
 * tab listeners), so the position follows the new page again.
 *
 * Reads: `getContextRid(tabId)` for the pointer alone, or
 * `resolvePanelContextForTab(tabId)` (panel-context-sync.ts) for the pointer
 * with the page fallback.
 */

import { setContextRid, type ContextRidEntry } from './context-rid';
import { getCtx } from './sw-context';
import type { PositionSource } from './types';

/** Sources the Log tab records. Badge clicks and window navigation are too
 *  frequent to log one by one. */
const LOGGED: ReadonlySet<PositionSource> = new Set(['contextmenu', 'picker']);

/** Set and publish the current position of `tabId`. Without a tab (a sender
 *  outside any tab) the position is only published to every panel. */
export function setCurrentPosition(tabId: number | undefined, entry: ContextRidEntry, source?: PositionSource): void {
  const ctx = getCtx();
  if (tabId != null) setContextRid(tabId, entry);
  if (!source || LOGGED.has(source)) ctx.logActivity('info', `Current object: ${entry.name || entry.businessId || entry.rid}`, undefined, { category: 'system', action: 'context' });
  const msg = {
    type: 'CONTEXT_RID_DATA' as const,
    rid: entry.rid,
    name: entry.name,
    objectType: entry.type,
    businessId: entry.businessId,
    ...(source ? { source } : {}),
  };
  if (tabId != null) ctx.sendToPanelByTab(tabId, msg);
  else ctx.sendToPanel(msg);
}
