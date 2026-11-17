/**
 * Badge enrichment handlers.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { enrichBadges } from '../enrichment';
import { admitEnrichRids } from '../enrich-budget';
import { log } from '../logger';

register('ENRICH_BADGES', (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  // A page chooses these rids: at most so many per message and per minute
  // (enrich-budget.ts). The rest are answered empty so their badges stop loading.
  const { admitted, refused } = admitEnrichRids(meta.senderTabId, msg.rids);
  if (refused.length && meta.senderTabId != null) {
    log.warn('enrich:budget', `${refused.length} badge rids refused for tab ${meta.senderTabId}`);
    const enrichments: Record<string, Record<string, never>> = {};
    for (const rid of refused) enrichments[rid] = {};
    try { ctx.contentPorts.get(meta.senderTabId)?.postMessage({ type: 'BADGE_ENRICHMENT', enrichments }); } catch { /* port closed */ }
  }
  // Named by the page's own server and answered only to this tab.
  if (admitted.length) void enrichBadges(admitted, meta.senderTabId, ctx);
});
