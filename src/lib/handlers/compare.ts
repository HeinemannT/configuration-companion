/**
 * Compare: the window launcher, the read of one or two sides and the picker
 * suggestions. Read-only; nothing here writes to BMP.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { errorMessage } from '../logger';
import { errorKindOf } from '../error-kind';
import { ENVIRONMENT_CHANGED_ERROR, environmentMatches, environmentToken } from '../environment';
import { OBJECT_RELATION_EC_TIMEOUT } from '../constants';
import { openCompareWindow } from '../diff-launcher';
import { buildSuggestPartEc, filterSuggestRows, parseSuggestLog, readCompare, suggestClassOf } from '../compare-read';
import { isRidShaped } from '../validate-inbound';
import type { CodeSearchObject } from '../messages';

const str = (v: unknown, max = 400) => (typeof v === 'string' && v.length <= max ? v : undefined);

function object(v: unknown): CodeSearchObject | undefined {
  const o = v as Partial<CodeSearchObject> | undefined;
  if (!o || typeof o.rid !== 'string' || !isRidShaped(o.rid)) return undefined;
  return { rid: o.rid, ...(str(o.name) ? { name: o.name } : {}), ...(str(o.type) ? { type: o.type } : {}), ...(str(o.businessId) ? { businessId: o.businessId } : {}) };
}

register('OPEN_COMPARE', async (msg, _respond, meta) => {
  const left = object(msg.left);
  if (!left) return;
  const right = object(msg.right);
  await openCompareWindow({ type: 'diff', left, ...(right ? { right } : {}) }, { tabId: meta.senderTabId, windowId: meta.panelWindowId });
});

register('READ_COMPARE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const client = ctx.client;
  if (!client) { respond({ type: 'COMPARE_DATA', environment, ok: false, error: 'Not connected to BMP', errorKind: 'not-signed-in' }); return; }
  if (msg.environment && msg.environment !== environment) { respond({ type: 'COMPARE_DATA', environment, ok: false, error: ENVIRONMENT_CHANGED_ERROR }); return; }
  const rids = [...new Set((Array.isArray(msg.rids) ? msg.rids : []).filter(r => typeof r === 'string' && isRidShaped(r)))].slice(0, 2);
  if (!rids.length) { respond({ type: 'COMPARE_DATA', environment, ok: false, error: 'No object to compare' }); return; }
  try {
    const read = await readCompare(client, rids, OBJECT_RELATION_EC_TIMEOUT);
    if (!environmentMatches(ctxOf(meta), environment)) { respond({ type: 'COMPARE_DATA', environment, ok: false, error: ENVIRONMENT_CHANGED_ERROR }); return; }
    respond({ type: 'COMPARE_DATA', environment, ok: true, read });
  } catch (e) {
    const errorKind = errorKindOf(e);
    respond({ type: 'COMPARE_DATA', environment, ok: false, error: errorMessage(e), ...(errorKind ? { errorKind } : {}) });
  }
});

register('COMPARE_SUGGEST', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const client = ctx.client;
  if (!client) { respond({ type: 'COMPARE_SUGGEST_DATA', ok: false, rows: [], error: 'Not connected to BMP' }); return; }
  if (msg.environment && msg.environment !== environmentToken(ctx)) { respond({ type: 'COMPARE_SUGGEST_DATA', ok: false, rows: [], error: ENVIRONMENT_CHANGED_ERROR }); return; }
  if (!isRidShaped(msg.rid)) { respond({ type: 'COMPARE_SUGGEST_DATA', ok: false, rows: [], error: 'Not a RID' }); return; }
  try {
    // Constant scripts, one per object, each object the command's context
    // (one post): the template's instances, the object's own instances and
    // class, the parent's children. Nothing of the objects is in the text.
    const parts: Array<{ part: 'template' | 'object' | 'parent'; rid: string }> = [
      ...(msg.templateRid && isRidShaped(msg.templateRid) ? [{ part: 'template' as const, rid: msg.templateRid }] : []),
      { part: 'object', rid: msg.rid },
      ...(msg.parentRid && isRidShaped(msg.parentRid) ? [{ part: 'parent' as const, rid: msg.parentRid }] : []),
    ];
    const results = await client.executeEcPairs(parts.map(p => ({ code: buildSuggestPartEc(p.part), objectRid: p.rid })), undefined, OBJECT_RELATION_EC_TIMEOUT);
    const own = results[parts.findIndex(p => p.part === 'object')];
    if (!own?.ok) { respond({ type: 'COMPARE_SUGGEST_DATA', ok: false, rows: [], error: own?.error || 'The suggestions could not be read' }); return; }
    // A template or parent that cannot be read offers nothing, as before.
    const log = results.map(r => (r.ok ? r.log ?? '' : '')).join('\n');
    respond({ type: 'COMPARE_SUGGEST_DATA', ok: true, rows: filterSuggestRows(parseSuggestLog(log), msg.rid, suggestClassOf(own.log ?? '')) });
  } catch (e) {
    respond({ type: 'COMPARE_SUGGEST_DATA', ok: false, rows: [], error: errorMessage(e) });
  }
});
