/**
 * RESOLVE_CODE_REFS — the batched, read-only resolve of code references for
 * the object window and the Extended Code window (see code-ref-resolve.ts).
 * One user-class post per batch; the windows cache the answers for their
 * own lifetime.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { errorMessage } from '../logger';
import { ENVIRONMENT_CHANGED_ERROR, environmentMatches, environmentToken } from '../environment';
import { createEcFrame } from '../ec-parser';
import { OBJECT_RELATION_EC_TIMEOUT } from '../constants';
import { REF_BATCH_MAX, resolveRefsIsolating } from '../code-ref-resolve';
import { cachedTypeCatalogue, lookupRefsByCommand } from '../id-lookup';

register('RESOLVE_CODE_REFS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const client = ctx.client;
  const keys = [...new Set((Array.isArray(msg.keys) ? msg.keys : []).filter((k): k is string => typeof k === 'string' && k.length <= 260))]
    .slice(0, REF_BATCH_MAX);
  const fail = (error: string) => respond({ type: 'CODE_REFS_RESULT', environment, ok: false, results: {}, error });
  if (!client) { fail('Not connected to BMP'); return; }
  if (msg.environment && msg.environment !== environment) { fail(ENVIRONMENT_CHANGED_ERROR); return; }
  try {
    // The by-ID answer also names each object's model: kept for the card.
    const models = new Map<string, string>();
    const { results } = await resolveRefsIsolating(keys,
      code => client.executeEc(code, undefined, false, undefined, OBJECT_RELATION_EC_TIMEOUT),
      createEcFrame,
      (code, rids) => client.executeEcEach(code, rids, undefined, OBJECT_RELATION_EC_TIMEOUT),
      // ID keys by the built-in by-ID lookup: no script text (id-lookup).
      refs => lookupRefsByCommand(client, refs, () => cachedTypeCatalogue(client), undefined, models));
    for (const [k, model] of models) {
      const r = results[k];
      if (r?.found) r.target.model = model;
    }
    if (!environmentMatches(ctxOf(meta), environment)) { fail(ENVIRONMENT_CHANGED_ERROR); return; }
    respond({ type: 'CODE_REFS_RESULT', environment, ok: true, results });
  } catch (e) {
    fail(errorMessage(e));
  }
});
