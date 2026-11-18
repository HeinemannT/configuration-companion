/**
 * Object lookup, cache, and linked object handlers.
 */

import { clearCodeIndex, noteSavedObject } from '../code-index-service';
import { register, type HandlerMeta } from '../handler-registry';
import { boundContexts, ctxOf, getCtx, type SwContext } from '../sw-context';
import { activityObject, activityObjectLabel } from '../activity-format';
import { incrementGeneration, invalidateRid } from '../enrichment';
import { clearActivityLog } from '../activity';
import { clearAllContextRids } from '../context-rid';
import { errorMessage, log } from '../logger';
import { CODE_BEARING_TYPES } from '../namespace';
import { loadColorSets } from '../color-set-cache';
import type { BmpObject } from '../types';
import { refFieldsFromSchema, buildConnectionsEc, parseConnections, buildContextJunctionEc, parseJunctions, pickFarSide, buildInboundEc, parseInbound, buildInstancesEc, parseInstances } from '../connections';
import type { ConnGroup } from '../types';
import { appendRowEc, CONTEXT_OBJECT, createEcFrame, EC_DONE_LITERAL, parseFramedLog, STATIC_EC_FRAME, type EcFrame } from '../ec-parser';
import { pathTouchesCode } from '../ec-code-safety';
import { PAGE_OBJECTS_MAX, sanitizePageObject } from '../validate-inbound';
import { BATCH_CHUNK_SIZE } from '../constants';
import { ENVIRONMENT_CHANGED_ERROR, environmentMatches, environmentMismatchError, environmentToken } from '../environment';
import { markHostAccessRequired } from '../connection';
import { HostAccessError } from '../site-access';
import { bmpTypeKnowledge, typeKnowledgeFor } from '../bmp-type-knowledge';
import { sendPageInfoToPanel } from '../content-script-injection';
import { clearAllLocalData } from '../local-data';
import { errorKindOf } from '../error-kind';
import { isOutcomeUnknown, MAY_HAVE_SAVED } from '../save-check';
import { scriptOn } from '../script-kinds';
import { resolveRefRids } from '../ref-rid';
import { cachedTypeCatalogue, lookupRefsByCommand } from '../id-lookup';

const browseSearchControllers = new Map<string, AbortController>();

function browseSearchKey(meta: HandlerMeta): string {
  if (meta.panelWindowId != null) return `panel:${meta.panelWindowId}`;
  if (meta.senderTabId != null) return `tab:${meta.senderTabId}`;
  return meta.isOneShot ? 'oneshot' : 'panel:unknown';
}

function hydrateBrowseObject(cacheObject: BmpObject | undefined, hit: BmpObject): BmpObject {
  if (!cacheObject) return hit;
  return {
    ...hit,
    businessId: cacheObject.businessId ?? hit.businessId,
    templateBusinessId: cacheObject.templateBusinessId ?? hit.templateBusinessId,
    identityEnriched: cacheObject.identityEnriched ?? hit.identityEnriched,
    cascade: cacheObject.cascade ?? hit.cascade,
  };
}

// ── EC builders (exported for tests) ─────────────────────────────

/** Build the EC that resolves a `namespace.bid` ref to identity + code preview.
 *
 *  CRITICAL: the inline IF after `:=` MUST be parenthesised — bare
 *  `_x := IF ... ENDIF` is a parse error in EC and silently breaks the
 *  whole hover. See `ec-codegen.test.ts` for the validator that codifies
 *  this rule; this builder is exported so a regression test can re-assert
 *  it for the hover path. */
export function buildHoverResolveEc(ref: string, frame: EcFrame = STATIC_EC_FRAME): string {
  const codeBearingCheck = [...CODE_BEARING_TYPES].map(t => `_cls = "${t}"`).join(' OR ');
  // Framed row (ec-parser): the name and multi-line code come back unchanged.
  return scriptOn('buildHoverResolveEc', ref, [
    `_o := ${ref}`,
    '_cls := _o.className.whenMissing("")',
    `_code := (IF ${codeBearingCheck} THEN output(_o.expression.whenMissing("")) ELSE "" ENDIF)`,
    '_r := ""',
    ...appendRowEc('_r', ['_o.name.whenMissing("")', '_cls', '_o.rid.whenMissing("")', '_o.id.whenMissing("")', '_code']),
    `_r + ${EC_DONE_LITERAL}`,
  ].join('\n'));
}

/** Parse buildHoverResolveEc output. Null when the answer is incomplete. */
export function parseHoverResolveLog(log: string, frame: EcFrame = STATIC_EC_FRAME): { name?: string; objectType?: string; rid?: string; businessId?: string; codePreview?: string } | null {
  let rows: string[][];
  try { rows = parseFramedLog(log, frame, 5); } catch { return null; }
  const row = rows[0];
  if (!row) return null;
  const [name, type, rid, businessId, code] = row;
  return {
    name: name || undefined,
    objectType: type.trim() || undefined,
    rid: rid.trim() || undefined,
    businessId: businessId.trim() || undefined,
    codePreview: code ? (code.length > 500 ? code.slice(0, 500) : code) : undefined,
  };
}

// ── Handlers ─────────────────────────────────────────────────────

register('GET_CACHE', (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const objects = msg.filter ? ctx.cache.search(msg.filter) : ctx.cache.getAll();
  respond({ type: 'CACHE_DATA', objects, filter: msg.filter ?? '' });
});

// Live workspace search via BMP's GraphQL quickSearch. The fast GraphQL result
// paints first; a cancellable identity pass then hydrates template + instance
// ids and updates the same generation. Superseded searches abort their work so
// typing cannot fill BMP's serialized command queue with stale enrichments.
register('BROWSE_SEARCH', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const { query, gen } = msg;
  const page = msg.page ?? 1;
  // A next page ("Show more") runs beside its query's first page, so the
  // first page's identity pass is not cut short. A new query stops both.
  const base = browseSearchKey(meta);
  const nextPage = page > 1;
  const key = nextPage ? `${base}#more` : base;
  browseSearchControllers.get(key)?.abort();
  if (!nextPage) browseSearchControllers.get(`${base}#more`)?.abort();
  if (!query.trim()) {
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, page, ok: true, objects: [], totalHits: 0 });
    return;
  }
  if (!ctx.client) {
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, page, ok: false, error: 'Not connected to BMP' });
    return;
  }
  const controller = new AbortController();
  browseSearchControllers.set(key, controller);
  const client = ctx.client;
  const environment = environmentToken(ctx);
  try {
    const { totalHits, objects } = await client.quickSearch(query, {
      page: msg.page,
      pageSize: msg.pageSize,
      signal: controller.signal,
    });
    if (controller.signal.aborted || !environmentMatches(ctxOf(meta), environment)) return;

    ctx.cache.putAll(objects);
    const immediate = objects.map(hit => hydrateBrowseObject(ctx.cache.get(hit.rid), hit));
    if (!meta.isOneShot) {
      respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, page, ok: true, objects: immediate, totalHits });
    }

    const missing = immediate.filter(object => !object.identityEnriched);
    const identities: Record<string, {
      businessId?: string;
      type?: string;
      name?: string;
      templateBusinessId?: string;
      cascade?: { rid: string; businessId?: string; type?: string; name?: string };
    }> = {};
    try {
      for (let i = 0; i < missing.length; i += BATCH_CHUNK_SIZE) {
        const chunk = missing.slice(i, i + BATCH_CHUNK_SIZE).map(object => object.rid);
        const result = await client.batchEnrich(chunk, controller.signal);
        if (controller.signal.aborted || !environmentMatches(ctxOf(meta), environment)) return;
        Object.assign(identities, result.results);
        if (result.error) break;
      }
    } catch (e) {
      if (controller.signal.aborted || !environmentMatches(ctxOf(meta), environment)) return;
      // Identity is progressive decoration. A failed EC pass must not erase
      // quickSearch results that were already valid and visible.
      log.swallow('handler:browseSearch:enrich', e);
      if (meta.isOneShot) {
        respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, page, ok: true, objects: immediate, totalHits });
      }
      return;
    }

    const now = Date.now();
    const hydrated = immediate.map((hit): BmpObject => {
      const identity = identities[hit.rid];
      if (!identity) return hit;
      return {
        ...hit,
        businessId: identity.businessId,
        type: identity.type ?? hit.type,
        name: identity.name ?? hit.name,
        templateBusinessId: identity.templateBusinessId,
        identityEnriched: true,
        enrichedAt: now,
        cascade: identity.cascade,
        source: 'server',
        discoveredAt: hit.discoveredAt,
        updatedAt: now,
      };
    });
    ctx.cache.putAll(hydrated.filter(object => object.identityEnriched));
    if (meta.isOneShot || Object.keys(identities).length > 0) {
      respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, page, ok: true, objects: hydrated, totalHits });
    }
  } catch (e) {
    if (controller.signal.aborted) return;
    if (e instanceof HostAccessError) {
      markHostAccessRequired(ctx);
      respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, page, ok: false, error: 'Grant site access to search this BMP workspace' });
      return;
    }
    respond({ type: 'BROWSE_SEARCH_RESULT', query, gen, page, ok: false, error: e instanceof Error ? e.message : 'Search failed' });
  } finally {
    if (browseSearchControllers.get(key) === controller) browseSearchControllers.delete(key);
  }
});

register('HOVER_LOOKUP', async (msg, respond, meta) => {
  const ctx = ctxOf(meta), client = ctx.client, environment = environmentToken(ctx);
  const empty = () => respond({ type: 'HOVER_LOOKUP_RESULT', rid: msg.rid });
  // Legacy previews can follow the current profile. Bound previews must not
  // resolve an old RID from the new profile's cache or client.
  if (msg.environment && msg.environment !== environment) { empty(); return; }
  // Fast path: check cache (includes code preview if properties were fetched)
  const cached = ctx.cache.get(msg.rid);
  if (cached?.identityEnriched && (cached.name || cached.type)) {
    const codePreview = extractCachedCode(cached);
    respond({
      type: 'HOVER_LOOKUP_RESULT',
      rid: msg.rid,
      name: cached.name,
      objectType: cached.type,
      businessId: cached.businessId,
      templateBusinessId: cached.templateBusinessId,
      codePreview,
    });
    return;
  }
  // Slow path: EC lookup (identity only — no code fetch for RID lookups)
  if (!client) { empty(); return; }
  try {
    const identity = await client.lookupIdentity(msg.rid);
    if (environmentToken(ctxOf(meta)) !== environment || ctxOf(meta).client !== client) { empty(); return; }
    respond({
      type: 'HOVER_LOOKUP_RESULT', rid: msg.rid,
      name: identity?.name, objectType: identity?.type, businessId: identity?.businessId,
      templateBusinessId: identity?.templateBusinessId,
    });
  } catch {
    empty();
  }
});

/** Extract code preview from a cached object's properties (if code-bearing type). */
function extractCachedCode(obj: BmpObject): string | undefined {
  if (!obj.type || !obj.properties || !CODE_BEARING_TYPES.has(obj.type)) return undefined;
  const props = obj.properties as Record<string, unknown>;
  const code = (props.expression ?? props.html ?? props.javascript) as string | undefined;
  if (!code || typeof code !== 'string') return undefined;
  return code.length > 500 ? code.slice(0, 500) : code;
}

/** A `namespace.businessId` reference, optionally followed by accessor hops
 *  (`ceras.foo.parent.owning_org`). This is interpolated raw into `_o := <ref>`,
 *  so it is an EC-injection surface: lock it to a lowercase-prefixed dotted
 *  navigation path — no spaces, parens, operators, quotes, or statement
 *  separators can pass. The client validates first; this is the server backstop.
 *  Hop count is generous (the client enforces the real policy cap). */
const HOVER_REF_RE = /^[a-z]{1,6}\.[A-Za-z0-9_]+(?:\.[A-Za-z_]\w*){0,6}$/;

/** A hover path may not pass through a code property: `_o := t.x.expression`
 *  would run that code (ec-code-safety). The first two segments are the ID
 *  space and the business ID. */
export function hoverRefAllowed(ref: string): boolean {
  return HOVER_REF_RE.test(ref) && !pathTouchesCode(ref.split('.').slice(2).join('.'));
}

/** The RID a hover reference names: null when the server says there is no
 *  such object, an Error (or undefined) when it could not be looked up.
 *  The ID space and business ID (`ns.id`) go to the built-in by-ID lookup
 *  (id-lookup): no script text. Hops after them (`.parent.owner`) are
 *  followed by a small script on that object as the command's context, so
 *  its text holds the hops only, never the ID. Without the by-ID answer the
 *  whole reference falls back to the script lookup (ref-rid). */
async function hoverRid(client: NonNullable<SwContext['client']>, ref: string): Promise<string | null | Error | undefined> {
  const [ns, id, ...hops] = ref.split('.');
  const key = `${ns}.${id}`;
  const found = await lookupRefsByCommand(client, [{ key, ns, id }], () => cachedTypeCatalogue(client)).catch(() => undefined);
  const base = found?.get(key);
  if (base === undefined) return (await resolveRefRids([ref], code => client.executeEc(code, undefined, false))).get(ref);
  if (base === null || !hops.length) return base;
  const path = `this.object.${hops.join('.')}`;
  return (await resolveRefRids([path], code => client.executeEcOn(code, base))).get(path);
}

/** Recent hover answers per profile and reference (bounded, short-lived). */
const hoverAnswers = new Map<string, { parsed: NonNullable<ReturnType<typeof parseHoverResolveLog>>; at: number }>();
const HOVER_TTL_MS = 60_000;
const HOVER_MAX = 200;

register('HOVER_RESOLVE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client || typeof msg.ref !== 'string' || !hoverRefAllowed(msg.ref)) {
    respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref });
    return;
  }
  try {
    // EC: resolve namespace.bid reference to identity + code preview in one call.
    // output() returns raw text without evaluating the expression.
    // Code is only fetched for known code-bearing types (IF/ELSE guards).
    // A hover over the same reference again within a minute is answered
    // here: no new script on every hover.
    const key = `${ctx.profileId ?? ''}|${msg.ref}`;
    const known = hoverAnswers.get(key);
    if (known && Date.now() - known.at < HOVER_TTL_MS) {
      respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref, ...known.parsed });
      return;
    }
    const frame = createEcFrame();
    const client = ctx.client;
    const rid = await hoverRid(client, msg.ref);
    if (rid === null) {
      // The server answered: there is no such object.
      respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref, missing: `No object ${msg.ref} on this server.` });
      return;
    }
    if (typeof rid !== 'string') {
      // The server refused the reference, or the lookup failed.
      respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref });
      return;
    }
    const result = await client.executeEcOn(buildHoverResolveEc(CONTEXT_OBJECT, frame), rid);
    const parsed = result.ok ? parseHoverResolveLog(result.log ?? '', frame) : null;
    if (!parsed) {
      respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref });
      return;
    }
    hoverAnswers.delete(key);
    hoverAnswers.set(key, { parsed, at: Date.now() });
    while (hoverAnswers.size > HOVER_MAX) hoverAnswers.delete(hoverAnswers.keys().next().value!);
    respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref, ...parsed });
  } catch {
    respond({ type: 'HOVER_RESOLVE_RESULT', ref: msg.ref });
  }
});

// ── Type-schema fetch ───────────────────────────────────────────
//
// Powers the editor's Vars + Properties panel. One EC round-trip per
// className enumerates all properties (system + custom) with their EC
// accessor (via the two-step `.as(linkedTo).as(id)` trick — NOT the
// one-step `.as(linkedTo.id)` which returns display names).
//
// Cache lives in type-schema-cache.ts. We re-export the active
// environment token so neither distinct profiles nor a reconfigured profile
// can share schema state.

register('FETCH_COLOR_SETS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const serverId = environmentToken(ctx);
  // Serve from the persistent cache unless a manual refresh forced a reload.
  // This is the speed win: a panel reopen or SW idle-reset no longer re-runs
  // the BMP round-trip — the colours come straight from versioned storage.local.
  let sets: import('../types').ColorSetData[] = [];
  let fetchedAt: number | undefined;
  let stale = false;
  let fetchError: string | undefined;
  if (ctx.client) {
    try {
      const loaded = await loadColorSets(serverId, () => ctx.client!.fetchColorSets(), msg.force);
      sets = loaded.sets;
      fetchedAt = loaded.fetchedAt;
      stale = loaded.stale;
      fetchError = loaded.error;
    } catch (e) {
      log.swallow('handler:fetchColorSets', e);
      fetchError = errorMessage(e);
    }
  } else {
    fetchError = 'Not connected';
  }
  // Broadcast to the panel (its colour picker listens for the broadcast) AND respond to the sender, so
  // the blueprint overlay can `sendRequest` the same data over the one-shot channel (style-mode tinting).
  const result = {
    type: 'COLOR_SETS_DATA' as const,
    environment: serverId,
    sets,
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(stale ? { stale: true } : {}),
    ...(fetchError ? { error: fetchError } : {}),
  };
  // A profile switch can complete while the serialized BMP request is in
  // flight. Never broadcast old-environment colors into the new panel.
  if (environmentToken(ctx) !== serverId) {
    respond({ type: 'COLOR_SETS_DATA', environment: serverId, sets: [], error: 'Color request superseded by environment change' });
    return;
  }
  ctx.sendToPanel(result);
  respond(result);
});

register('FETCH_TYPE_SCHEMA', async (msg, respond, meta) => {
  const environment = environmentToken(ctxOf(meta));
  const result = await typeKnowledgeFor(ctxOf(meta)).properties({
    className: msg.className,
    refresh: msg.refresh,
    exampleRef: msg.exampleRef,
  });
  respond(result.ok
    ? {
        type: 'FETCH_TYPE_SCHEMA_RESULT',
        className: msg.className,
        ok: true,
        props: result.props,
        canonicalClassName: result.canonical,
        environment,
      }
    : {
        type: 'FETCH_TYPE_SCHEMA_RESULT',
        className: msg.className,
        ok: false,
        error: result.error,
        environment,
      });
});

register('FETCH_TYPE_SCHEMAS', async (msg, respond, meta) => {
  const batch = await typeKnowledgeFor(ctxOf(meta)).propertiesFor(msg.classNames);
  respond({
    type: 'FETCH_TYPE_SCHEMAS_RESULT',
    environment: batch.environment,
    results: batch.results.map(result => result.ok
      ? {
          className: result.className,
          ok: true as const,
          props: result.props,
          canonicalClassName: result.canonical,
        }
      : {
          className: result.className,
          ok: false as const,
          error: result.error,
        }),
  });
});

register('FETCH_TYPE_OPTIONS', async (msg, respond, meta) => {
  const result = await typeKnowledgeFor(ctxOf(meta)).options(msg.className, msg.refresh);
  respond(result.ok
    ? {
        type: 'FETCH_TYPE_OPTIONS_RESULT',
        className: msg.className,
        ok: true,
        options: result.options,
      }
    : {
        type: 'FETCH_TYPE_OPTIONS_RESULT',
        className: msg.className,
        ok: false,
        error: result.error,
      });
});

/** Inbound scans under way, by rid. A cancel (or a new scan of the same rid)
 *  aborts the waiting request; BMP may still finish the command. */
const inFlightInbound = new Map<string, AbortController>();

register('FETCH_INBOUND', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'INBOUND_RESULT', rid: msg.rid, ok: false, error: 'Not connected' }); return; }
  inFlightInbound.get(`${ctxOf(meta).profileId ?? ''}|${msg.rid}`)?.abort();
  const controller = new AbortController();
  inFlightInbound.set(`${ctxOf(meta).profileId ?? ''}|${msg.rid}`, controller);
  const { signal } = controller;
  try {
    // Constant scripts: the object is the command's context (this.object).
    const ref = CONTEXT_OBJECT;
    // Declared reverse references name their field. Page elements (InputSet,
    // widgets) have no class schema: the rref() scan alone answers for them.
    const schema = await typeKnowledgeFor(ctxOf(meta)).properties({ className: msg.className });
    const reverseFields = schema.ok
      ? refFieldsFromSchema(schema.props).filter(field => field.direction === 'in')
      : [];
    let groups: ConnGroup[] = [];
    const frame = createEcFrame();
    if (reverseFields.length > 0) {
      const declared = await ctx.client.executeEcOn(buildConnectionsEc(ref, reverseFields, frame), msg.rid, signal);
      if (!declared.ok) {
        respond({
          type: 'INBOUND_RESULT',
          rid: msg.rid,
          ok: false,
          error: declared.error || declared.log || 'Declared reverse-reference fetch failed',
        });
        return;
      }
      groups = parseConnections(declared.log ?? '', reverseFields, frame);
      await inlineJunctions(msg.rid, groups, ctxOf(meta));
    }
    signal.throwIfAborted();
    const result = await ctx.client.executeEcOn(buildInboundEc(ref, frame), msg.rid, signal);
    if (!result.ok) { respond({ type: 'INBOUND_RESULT', rid: msg.rid, ok: false, error: result.error || result.log || 'EC execution failed' }); return; }
    const inbound = parseInbound(result.log ?? '', undefined, frame);
    // Objects linked to this one as their template: rref() does not return
    // them, so they are always read. A failed read leaves the count out.
    let instances: ReturnType<typeof parseInstances> | undefined;
    {
      signal.throwIfAborted();
      try {
        const linked = await ctx.client.executeEcOn(buildInstancesEc(ref, frame), msg.rid, signal);
        if (linked.ok) instances = parseInstances(linked.log ?? '', frame);
      } catch (e) { if (signal.aborted) throw e; }
    }
    respond({
      type: 'INBOUND_RESULT',
      rid: msg.rid,
      ok: true,
      groups,
      targets: inbound.targets,
      capped: inbound.capped || groups.some(group => group.capped),
      ...(inbound.total != null ? { total: inbound.total } : {}),
      ...(instances ? { instances } : {}),
    });
  } catch (e) {
    respond({ type: 'INBOUND_RESULT', rid: msg.rid, ok: false, error: signal.aborted ? 'Cancelled' : errorMessage(e) });
  } finally {
    const inboundKey = `${ctxOf(meta).profileId ?? ''}|${msg.rid}`;
    if (inFlightInbound.get(inboundKey) === controller) inFlightInbound.delete(inboundKey);
  }
});

register('FETCH_INBOUND_CANCEL', (msg, _respond, meta) => {
  inFlightInbound.get(`${ctxOf(meta).profileId ?? ''}|${msg.rid}`)?.abort();
});

/**
 * For reverse-ref targets that are join objects (CeWorkflow mitigations, etc.),
 * read each one's far side and attach it inline so risk → control reads in one
 * hop. Generic: groups junction targets by type, reads that type's forward
 * refs, and picks the endpoint that isn't the back-edge. Best-effort + capped;
 * a failure here never fails the whole Connections fetch.
 */
async function inlineJunctions(sourceRid: string, groups: ConnGroup[], ctx: SwContext): Promise<void> {
  if (!ctx.client) return;
  const JUNCTION_CAP = 24;
  const byType = new Map<string, { rid: string; target: import('../types').ConnTarget }[]>();
  let count = 0;
  for (const g of groups) {
    if (g.direction !== 'in') continue; // junctions arrive as reverse-ref targets
    for (const t of g.targets) {
      if (t.broken || !t.type || !t.rid || count >= JUNCTION_CAP) continue;
      const arr = byType.get(t.type) ?? [];
      arr.push({ rid: t.rid, target: t });
      byType.set(t.type, arr);
      count++;
    }
  }
  for (const [type, entries] of byType) {
    try {
      const schema = await typeKnowledgeFor(ctx).properties({ className: type });
      if (!schema.ok) continue;
      const fwd = refFieldsFromSchema(schema.props).filter(f => f.direction === 'out');
      if (fwd.length === 0) continue;
      const frame = createEcFrame();
      // One constant script per field list, one command per junction.
      const answers = await ctx.client.executeEcEach(buildContextJunctionEc(fwd), entries.map(e => e.rid));
      const farByRid = new Map<string, import('../types').ConnTarget[]>();
      for (const r of answers.values()) {
        if (!r.ok || r.log == null) continue;
        try { for (const [k, v] of parseJunctions(r.log, frame)) farByRid.set(k, v); } catch { /* that junction stays without a via */ }
      }
      for (const e of entries) {
        const far = pickFarSide(sourceRid, e.rid, farByRid.get(e.rid) ?? []);
        if (far) e.target.via = far;
      }
    } catch { /* best-effort — leave these targets without a via */ }
  }
}

register('RESOLVE_ROOT_CATEGORY', async (msg, respond, meta) => {
  const result = await typeKnowledgeFor(ctxOf(meta)).rootCategory(msg.category);
  respond(result.ok
    ? {
        type: 'RESOLVE_ROOT_CATEGORY_RESULT',
        category: msg.category,
        ok: true,
        ...(result.className ? { className: result.className } : {}),
      }
    : { type: 'RESOLVE_ROOT_CATEGORY_RESULT', category: msg.category, ok: false });
});

register('GET_CACHE_BYTES', (msg, respond, meta) => {
  // Approximate size in bytes of the persisted cache (lean form). Used by
  // the Connect tab to surface "X MB used". Cheap to compute (one JSON
  // stringify per cached object) but not free — only fired on tab activate.
  respond({ type: 'CACHE_BYTES', bytes: ctxOf(meta).cache.getApproxBytes() });
});

register('CLEAR_CACHE', (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  ctx.cache.clear();
  // The code index is a cached copy of the server's code too.
  void clearCodeIndex();
  incrementGeneration(ctx); // this profile: resets enrichedRids + permanentlyFailed + aborts in-flight
  respond({ type: 'CACHE_STATS', count: 0 });
  ctx.broadcastToContent({ type: 'RE_ENRICH' });
});

// Full reset — clears state CLEAR_CACHE leaves behind. Use when the extension
// gets into a bad state and the user wants a clean slate without losing their
// server profiles. We deliberately leave favorites, style presets and settings
// untouched so the reset doesn't punish the user for using it. Every other
// local copy goes, for every profile (local-data.ts).
register('RESET_ALL', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const base = getCtx();
  // Object caches, badge naming, history and script history of every profile.
  for (const bound of new Set([...boundContexts(), ctx])) {
    bound.cache.clear();
    bound.history.clear();
    bound.scriptHistory.clear();
    incrementGeneration(bound);
  }
  await clearCodeIndex();
  await bmpTypeKnowledge.clear();
  // Launch contexts, Access drafts and journals, Compare pivots, page
  // diagnostics, and the stored caches of profiles not loaded right now.
  await clearAllLocalData((base.settings.profiles ?? []).map(p => p.id)).catch(e => log.swallow('handler:resetLocalData', e));
  // Activity log
  clearActivityLog();
  // Compare pivot (lives in chrome.storage.session, scoped per-profile —
  // wipe all of them so RESET_ALL doesn't leave per-env pivots behind).
  chrome.storage.session.get(null).then((all) => {
    const keys = Object.keys(all).filter(k => k.startsWith('crev_compare_pivot'));
    if (keys.length) chrome.storage.session.remove(keys).catch(() => {});
  }).catch(() => {});
  // Per-tab context rids
  clearAllContextRids();
  // Reset completion is transient by design: recording it in the activity
  // log immediately recreated the persisted state the user just cleared.
  ctx.toast('Extension state reset', 'success');
  respond({ type: 'CACHE_STATS', count: 0 });
  base.broadcastToContent({ type: 'RE_ENRICH' });
  base.broadcastToContent({ type: 'RESET_OVERLAY_CACHES' }); // also drop the blueprint overlay's colour + InputSet caches

  // Snap the panel to a clean slate. Without these, the user clicks Reset
  // and the status-bar chips + Page tab + Log tab still show stale state
  // until they navigate. Each broadcast hits the corresponding handler in
  // the panel orchestrator and clears its piece of in-memory state.
  ctx.sendToPanel({ type: 'CONTEXT_RID_DATA' });                           // clears context chip
  ctx.sendToPanel({ type: 'ACTIVITY_LOG', entries: [] });                  // empties Log tab
  ctx.sendToPanel({ type: 'HISTORY_DATA', entries: [] });                  // empties Recent list
  ctx.sendToPanel({ type: 'DETECTION_STATE', phase: 'checking', confidence: 0, signals: [] });
  // Refresh the panel's page info against the active BMP tab — async
  // and best-effort; chrome.tabs.sendMessage is gated on injection so we
  // don't block the reset on it.
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId != null) {
      sendPageInfoToPanel(tabId);
    }
  });
});

register('OBJECTS_DISCOVERED', (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  // Defence in depth: content.ts's crev-interceptor listener already shape-
  // validates (lib/validate-inbound.ts), but this handler is also reachable
  // from other message paths — never trust rid shape verbatim at the cache
  // write site.
  // A content script reports what the page shows: only the page hints
  // survive (validate-inbound.ts sanitizePageObject), never a server-read
  // identity, and merge.ts keeps any identity the server already gave.
  const sent: unknown[] = Array.isArray(msg.objects) ? msg.objects.slice(0, PAGE_OBJECTS_MAX) : [];
  const objects = sent
    .map(o => sanitizePageObject(o, (o as { source?: unknown } | null)?.source === 'fiber' ? 'fiber' : 'dom'))
    .filter((o): o is BmpObject => o !== null);
  ctx.cache.putAll(objects);
  ctx.logActivity('success', `Found ${objects.length} object${objects.length !== 1 ? 's' : ''}`);
  ctx.sendToPanel({ type: 'CACHE_STATS', count: ctx.cache.size });
});

register('FETCH_EDIT_FIELD_TYPES', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'EDIT_FIELD_TYPES_RESULT', rid: msg.rid, ok: false, classNames: [], error: 'Not connected' }); return; }
  const environment = environmentToken(ctx);
  try {
    const classNames = await ctx.client.fetchEditFieldClassNames(msg.rid);
    if (!environmentMatches(ctxOf(meta), environment)) {
      respond({ type: 'EDIT_FIELD_TYPES_RESULT', rid: msg.rid, ok: false, classNames: [], error: ENVIRONMENT_CHANGED_ERROR });
      return;
    }
    respond({ type: 'EDIT_FIELD_TYPES_RESULT', rid: msg.rid, ok: true, classNames });
  } catch (e) {
    respond({ type: 'EDIT_FIELD_TYPES_RESULT', rid: msg.rid, ok: false, classNames: [], error: errorMessage(e) });
  }
});

register('FETCH_PROPERTY_APPLICATIONS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  if (!ctx.client) {
    respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: false, error: 'Not connected', environment });
    return;
  }
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: false, error: ENVIRONMENT_CHANGED_ERROR, environment });
    return;
  }
  const client = ctx.client;
  try {
    const result = await client.fetchPropertyApplications(msg.rid);
    if (!environmentMatches(ctxOf(meta), environment)) {
      respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: false, error: ENVIRONMENT_CHANGED_ERROR, environment });
      return;
    }
    respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: true, ...result, environment });
  } catch (error) {
    respond({ type: 'PROPERTY_APPLICATIONS_RESULT', rid: msg.rid, ok: false, error: errorMessage(error), environment });
  }
});

/** The text values of saved changes (the local copy keeps those that are code). */
function savedTexts(changes: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(changes).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

register('APPLY_OBJECT_CHANGES', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) {
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: false, error: 'Not connected' });
    return;
  }
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: false, error: environmentMismatchError(ctx, msg.environment) });
    return;
  }
  const client = ctx.client;
  const startedAt = Date.now();
  const object = activityObject(msg.rid, ctx.cache.get(msg.rid), msg.objectLabel);
  const label = activityObjectLabel(object, msg.rid);
  try {
    const result = await client.applyObjectChanges(msg.rid, msg.target, msg.changes, msg.resetProps ?? []);
    const durationMs = Date.now() - startedAt;
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: result.ok, error: result.error, ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}) });
    // A local copy of the code takes the saved texts of this object (a save
    // to its template is read at the next Refresh).
    if (result.ok) noteSavedObject(msg.rid, msg.target === 'instance' ? savedTexts(msg.changes) : undefined, ctx);
    // Activity log: edits are the most-clicked surface; the Log tab was
    // otherwise blind to them. Surface prop-by-prop summary so the user
    // can audit what they actually changed.
    const propList = [
      ...Object.keys(msg.changes),
      ...(msg.resetProps ?? []).map(prop => `${prop}↩`),
    ];
    const propSummary = propList.length === 1
      ? propList[0]
      : `${propList.length} props (${propList.slice(0, 3).join(', ')}${propList.length > 3 ? '…' : ''})`;
    if (result.ok) {
      ctx.logActivity('success', `Edited ${msg.target} ${label}: ${propSummary} (${durationMs}ms)`, undefined, {
        category: 'change', action: 'edit-object', object, durationMs,
      });
      // Drop cached enrichment so badges + the object window refresh on the
      // next read. Fire-and-forget; the panel "saved" UI doesn't need
      // to wait for the re-fetch.
      invalidateRid(msg.rid, ctx).catch(e => log.swallow('handler:applyChanges:invalidate', e));
    } else {
      // Log AND toast: the user clicked Save and an inline error is easy
      // to miss if focus moved or the window closed.
      ctx.logActivity('error', `Edit failed on ${label}: ${propSummary} (${durationMs}ms)`, result.error, {
        category: 'change', action: 'edit-object', object, durationMs,
      });
      ctx.toast(result.outcomeUnknown ? MAY_HAVE_SAVED : `Save failed: ${result.error ?? 'unknown error'}`, 'error');
      if (result.outcomeUnknown) invalidateRid(msg.rid, ctx).catch(e => log.swallow('handler:applyChanges:invalidate', e));
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const unknown = isOutcomeUnknown(errorKindOf(e));
    respond({ type: 'APPLY_CHANGES_RESULT', rid: msg.rid, ok: false, error: errorMessage(e), ...(unknown ? { outcomeUnknown: true } : {}) });
    ctx.logActivity('error', `Edit request failed on ${label}`, errMsg, {
      category: 'change', action: 'edit-object', object,
    });
    ctx.toast(unknown ? `${MAY_HAVE_SAVED} ${errMsg}` : `Save threw: ${errMsg}`, 'error');
  }
});
