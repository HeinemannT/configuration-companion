/**
 * Transport (beta) handlers. Every read is a preview run (transport-read.ts).
 * The one write is TRANSPORT_RUN_PART with `transactional` and `confirmed`,
 * sent only by the window's apply flow after the person confirmed.
 *
 *  - TRANSPORT_SCAN: the objects under one root changed after a day, one
 *    preview run (at most TRANSPORT_SCAN_CAP rows, `more` when there were
 *    more; `missingRoot` when the workspace has no such root).
 *  - TRANSPORT_SCAN_UNDER: one object, found by its ID, and everything under
 *    it (changed after a day, or all), two preview runs; same cap and
 *    `more`; `missingStart` when no object has that ID.
 *  - TRANSPORT_CHILDREN: the RIDs of the children of `root.<root>` or of
 *    one object, one preview run (a cut scan is read on child by child).
 *  - TRANSPORT_COUNTS: how many objects are under each of up to
 *    TRANSPORT_READ_BATCH roots or objects (`descendants().size()`), by root
 *    name or RID; one that is missing is left out.
 *  - TRANSPORT_SCAN_BELOW: one object, by its RID, and everything under it
 *    (changed after a day, or all), one preview post; same cap and `more`;
 *    `missing` when the object is gone.
 *  - TRANSPORT_FIND: one object by its address `<space>.<ID>` (spaces t, k,
 *    r, d), its scan row, one preview run; `missing` when there is none.
 *  - TRANSPORT_READ_OBJECTS: `genedit()`, class, the parent's and siblings'
 *    addresses, the parent's ID and the system flag of up to
 *    TRANSPORT_READ_BATCH objects, and `generate(true)` of the property
 *    definitions in `creation` (their links), one preview post; each
 *    object answers on its own.
 *  - TRANSPORT_READ_CREATION: `generate(true)` of up to
 *    TRANSPORT_READ_BATCH property definitions, one preview post; any other
 *    object gives no text.
 *  - TRANSPORT_SOURCE_LISTING: the IDs this workspace has under a listing
 *    start of the comparison, one preview run.
 *  - TRANSPORT_SEARCH: the objects under one root whose ID or name holds a
 *    text (a wildcard match), one preview run, at most TRANSPORT_SEARCH_CAP.
 *  - TRANSPORT_ROWS: the scan rows of up to TRANSPORT_READ_BATCH objects by
 *    RID (a draft read again, the objects of a page), one preview post.
 *  - TRANSPORT_PAGE_OBJECTS: the RIDs of the objects on the BMP page the
 *    window sits on, from that tab's widget scan (GET_PAGE_INFO). Sends
 *    nothing to a server.
 *  - TRANSPORT_USED_BY: what uses one object (`rref()`), one preview run,
 *    on request only, at most TRANSPORT_USED_BY_CAP.
 *  - TRANSPORT_FACTS: what this workspace has at up to TRANSPORT_FACTS_BATCH
 *    used addresses (RID, class, parent ID, name, or missing), a few
 *    addresses per preview run.
 *  - TRANSPORT_LOG: the entries of the workspace's transport log (the
 *    Record part of a patch adds them), newest first, one preview run;
 *    `missingLog` when the workspace has none.
 *  - TRANSPORT_TARGETS: the other workspaces Companion is connected to now:
 *    stored server profiles other than the window's own whose connection is
 *    confirmed. Sends nothing to a server.
 *  - TRANSPORT_RUN_PART: one probe or patch part (the person's transport,
 *    script kind `user`, at most its limit) on one of those workspaces, in
 *    that workspace's queue: a preview, or a committed run (`transactional`)
 *    only with `confirmed: true`. A committed run is never aborted once it
 *    started; a cancel only keeps a queued one from starting.
 *  - TRANSPORT_CANCEL: stops a running or queued request by its ID.
 *
 * An answer that refuses before anything is read (a page sender, no
 * connection, another environment, a bad root, start, day or RID) carries
 * `refused: true`.
 *
 * Bound to the sender's server profile (`environment`, checked before and
 * after the read) and refused from content scripts; extension pages and
 * Companion's embedded windows may send them. The requests of one profile
 * run one at a time, in the order they came: the window asks for root after
 * root and batch after batch, and the load governor paces each post.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { errorMessage } from '../logger';
import { errorKindOf } from '../error-kind';
import { ENVIRONMENT_CHANGED_ERROR, environmentMatches, environmentMismatchError, environmentToken } from '../environment';
import { isScanDay, isTransportRoot, parseScanStart, TRANSPORT_READ_BATCH } from '../transport-bundle';
import {
  readTransportBelow, readTransportChildren, readTransportSourceListing, buildTransportSourceListingEc, readTransportCreation, readTransportFacts, isFactAddress, TRANSPORT_FACTS_BATCH, readTransportFind, readTransportLog, readTransportObjects,
  readTransportCounts, readTransportRows, readTransportScan, readTransportSearch, readTransportUnder, readTransportUsedBy, searchText, TRANSPORT_SEARCH_MAX,
  TRANSPORT_SEARCH_MIN, readNumericScan, readTransportOrigins,
} from '../transport-read';
import { validateRid } from '../ec-guards';
import { buildIdChangeEc } from '../numeric-id-write';
import { SCRIPT_LIMITS, userScript } from '../script-kinds';
import { computeConnectionState } from '../connection';
import { scopeFor } from '../profile-scope';
import { getCtx, type SwContext } from '../sw-context';
import { TRANSPORT_PART_TIMEOUT_MS, type TransportTarget } from '../transport-read';
import type { BmpClient } from '../bmp-client';
import type { InspectorMessage } from '../types';

const NOT_FROM_PAGE = 'This request is not accepted from a page.';

/** Running and queued requests by ID. */
const controllers = new Map<string, AbortController>();
/** The tail of each profile's queue. */
const queues = new Map<string, Promise<unknown>>();

/** Run `job` after every earlier request of `environment`; a request
 *  cancelled while it waits does not run. */
function enqueue<T>(environment: string, requestId: string, job: (signal: AbortSignal) => Promise<T>): { result: Promise<T>; controller: AbortController } {
  const controller = new AbortController();
  controllers.get(requestId)?.abort();
  controllers.set(requestId, controller);
  const prev = queues.get(environment) ?? Promise.resolve();
  const result = prev.catch(() => undefined).then(() => {
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    return job(controller.signal);
  });
  const tail = result.catch(() => undefined).finally(() => {
    if (controllers.get(requestId) === controller) controllers.delete(requestId);
    if (queues.get(environment) === tail) queues.delete(environment);
  });
  queues.set(environment, tail);
  return { result, controller };
}

const requestIdOf = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : '');

register('TRANSPORT_CANCEL', (msg) => {
  const id = requestIdOf(msg.requestId);
  controllers.get(id)?.abort();
  controllers.delete(id);
});

register('TRANSPORT_SCAN', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const requestId = requestIdOf(msg.requestId);
  const root = typeof msg.root === 'string' ? msg.root : '';
  const since = typeof msg.since === 'string' ? msg.since : '';
  const reply = (r: Record<string, unknown>) => respond({ type: 'TRANSPORT_SCAN_RESULT', requestId, environment, root, since, ok: false, ...r } as never);
  if (meta.senderKind === 'content') { reply({ error: NOT_FROM_PAGE, refused: true }); return; }
  if (!ctx.client) { reply({ error: 'Not connected to BMP', refused: true }); return; }
  if (!environmentMatches(ctx, msg.environment)) { reply({ error: environmentMismatchError(ctx, msg.environment), refused: true }); return; }
  if (!isTransportRoot(root)) { reply({ error: `Not a root the changes scan reads: ${root}`, refused: true }); return; }
  if (!isScanDay(since)) { reply({ error: 'The day must be a date (YYYY-MM-DD).', refused: true }); return; }
  const client = ctx.client;
  const { result, controller } = enqueue(environment, requestId, signal => readTransportScan(client, root, since, signal));
  try {
    const scan = await result;
    if (controller.signal.aborted) { reply({ cancelled: true }); return; }
    if (!environmentMatches(ctxOf(meta), environment)) { reply({ error: ENVIRONMENT_CHANGED_ERROR }); return; }
    reply({ ok: true, rows: scan.rows, ...(scan.more ? { more: true } : {}), ...(scan.missingRoot ? { missingRoot: true } : {}) });
  } catch (e) {
    if (controller.signal.aborted) { reply({ cancelled: true }); return; }
    const errorKind = errorKindOf(e);
    reply({ error: errorMessage(e), ...(errorKind ? { errorKind } : {}) });
  }
});

register('TRANSPORT_SCAN_UNDER', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const requestId = requestIdOf(msg.requestId);
  const start = typeof msg.start === 'string' ? msg.start.slice(0, 200) : '';
  const since = typeof msg.since === 'string' ? msg.since : '';
  const reply = (r: Record<string, unknown>) => respond({ type: 'TRANSPORT_SCAN_UNDER_RESULT', requestId, environment, start, since, ok: false, ...r } as never);
  if (meta.senderKind === 'content') { reply({ error: NOT_FROM_PAGE, refused: true }); return; }
  if (!ctx.client) { reply({ error: 'Not connected to BMP', refused: true }); return; }
  if (!environmentMatches(ctx, msg.environment)) { reply({ error: environmentMismatchError(ctx, msg.environment), refused: true }); return; }
  const parsed = parseScanStart(start);
  if (!parsed.ok) { reply({ error: parsed.error, refused: true }); return; }
  if (since && !isScanDay(since)) { reply({ error: 'The day must be a date (YYYY-MM-DD).', refused: true }); return; }
  const client = ctx.client;
  const { result, controller } = enqueue(environment, requestId, signal => readTransportUnder(client, start, since, signal));
  try {
    const scan = await result;
    if (controller.signal.aborted) { reply({ cancelled: true }); return; }
    if (!environmentMatches(ctxOf(meta), environment)) { reply({ error: ENVIRONMENT_CHANGED_ERROR }); return; }
    reply({ ok: true, rows: scan.rows, ...(scan.origin ? { origin: scan.origin } : {}), ...(scan.more ? { more: true } : {}), ...(scan.missingStart ? { missingStart: true } : {}) });
  } catch (e) {
    if (controller.signal.aborted) { reply({ cancelled: true }); return; }
    const errorKind = errorKindOf(e);
    reply({ error: errorMessage(e), ...(errorKind ? { errorKind } : {}) });
  }
});

/**
 * A read of one question: refused before anything is read (`error` says
 * why), or run in the profile's queue and answered with what `answer` makes
 * of its result. `echo` goes into every answer.
 */
function registerRead<T>(type: 'NUMERIC_IDS_SCAN' | 'TRANSPORT_CHILDREN' | 'TRANSPORT_COUNTS' | 'TRANSPORT_SCAN_BELOW' | 'TRANSPORT_FIND' | 'TRANSPORT_SEARCH' | 'TRANSPORT_USED_BY' | 'TRANSPORT_FACTS' | 'TRANSPORT_SOURCE_LISTING', answer: string, prepare: (msg: Record<string, unknown>) => {
  echo: Record<string, unknown>;
  error?: string;
  read?: (client: BmpClient, signal: AbortSignal) => Promise<T>;
  answer?: (value: T) => Record<string, unknown>;
}): void {
  register(type, async (msg, respond, meta) => {
    const ctx = ctxOf(meta);
    const environment = environmentToken(ctx);
    const requestId = requestIdOf(msg.requestId);
    const p = prepare(msg as Record<string, unknown>);
    const reply = (r: Record<string, unknown>) => respond({ type: answer, requestId, environment, ...p.echo, ok: false, ...r } as never);
    if (meta.senderKind === 'content') { reply({ error: NOT_FROM_PAGE, refused: true }); return; }
    if (!ctx.client) { reply({ error: 'Not connected to BMP', refused: true }); return; }
    if (!environmentMatches(ctx, msg.environment)) { reply({ error: environmentMismatchError(ctx, msg.environment), refused: true }); return; }
    const { read, answer: make } = p;
    if (p.error || !read || !make) { reply({ error: p.error ?? 'Refused.', refused: true }); return; }
    const client = ctx.client;
    const { result, controller } = enqueue(environment, requestId, signal => read(client, signal));
    try {
      const value = await result;
      if (controller.signal.aborted) { reply({ cancelled: true }); return; }
      if (!environmentMatches(ctxOf(meta), environment)) { reply({ error: ENVIRONMENT_CHANGED_ERROR }); return; }
      reply({ ok: true, ...make(value) });
    } catch (e) {
      if (controller.signal.aborted) { reply({ cancelled: true }); return; }
      const errorKind = errorKindOf(e);
      reply({ error: errorMessage(e), ...(errorKind ? { errorKind } : {}) });
    }
  });
}

const RID_SHAPE = /^\d{1,20}$/;

registerRead('TRANSPORT_CHILDREN', 'TRANSPORT_CHILDREN_RESULT', msg => {
  const root = typeof msg.root === 'string' ? msg.root : '';
  const rid = typeof msg.rid === 'string' ? msg.rid : '';
  const echo = root ? { root } : { rid };
  if (root ? !isTransportRoot(root) : !RID_SHAPE.test(rid)) return { echo, error: root ? `Not a root the changes scan reads: ${root}` : 'Not an object RID.' };
  return {
    echo,
    read: (client, signal) => readTransportChildren(client, root ? { root } : { rid }, signal),
    answer: c => ({ rids: c.rids, ...(c.missing ? { missing: true } : {}) }),
  };
});

registerRead('TRANSPORT_COUNTS', 'TRANSPORT_COUNTS_RESULT', msg => {
  const cap = TRANSPORT_READ_BATCH;
  const roots: unknown[] = Array.isArray(msg.roots) ? msg.roots.slice(0, cap + 1) : [];
  const rids: unknown[] = Array.isArray(msg.rids) ? msg.rids.slice(0, cap + 1) : [];
  if ((roots.length ? 1 : 0) + (rids.length ? 1 : 0) !== 1) return { echo: {}, error: 'Ask for roots or objects.' };
  if (roots.length > cap || rids.length > cap) return { echo: {}, error: `At most ${cap} per read.` };
  if (!roots.every(isTransportRoot)) return { echo: {}, error: 'Not a root the changes scan reads.' };
  if (!rids.every((r): r is string => typeof r === 'string' && RID_SHAPE.test(r))) return { echo: {}, error: 'Not an object RID.' };
  return {
    echo: {},
    read: (client, signal) => readTransportCounts(client, roots.length ? { roots: roots as string[] } : { rids: rids as string[] }, signal),
    answer: counts => ({ counts }),
  };
});

registerRead('TRANSPORT_SCAN_BELOW', 'TRANSPORT_SCAN_BELOW_RESULT', msg => {
  const rid = typeof msg.rid === 'string' ? msg.rid : '';
  const since = typeof msg.since === 'string' ? msg.since : '';
  const echo = { rid, since };
  if (!RID_SHAPE.test(rid)) return { echo, error: 'Not an object RID.' };
  if (since && !isScanDay(since)) return { echo, error: 'The day must be a date (YYYY-MM-DD).' };
  return {
    echo,
    read: (client, signal) => readTransportBelow(client, rid, since, signal),
    answer: b => ({ rows: b.rows, ...(b.origin ? { origin: b.origin } : {}), ...(b.more ? { more: true } : {}), ...(b.missing ? { missing: true } : {}) }),
  };
});

registerRead('TRANSPORT_FIND', 'TRANSPORT_FIND_RESULT', msg => {
  const address = typeof msg.address === 'string' ? msg.address.slice(0, 200) : '';
  const parsed = parseScanStart(address);
  if (!parsed.ok || !address.includes('.')) return { echo: { address }, error: parsed.ok ? 'Not an address.' : parsed.error };
  return {
    echo: { address },
    read: (client, signal) => readTransportFind(client, address, signal),
    answer: f => (f.row ? { row: f.row } : { missing: true }),
  };
});

registerRead('TRANSPORT_SOURCE_LISTING', 'TRANSPORT_SOURCE_LISTING_RESULT', msg => {
  const start = typeof msg.start === 'string' ? msg.start.slice(0, 200) : '';
  try { buildTransportSourceListingEc(start); } catch (e) { return { echo: { start }, error: errorMessage(e) }; }
  return {
    echo: { start },
    read: (client, signal) => readTransportSourceListing(client, start, signal),
    answer: ids => ({ ids }),
  };
});

registerRead('TRANSPORT_SEARCH', 'TRANSPORT_SEARCH_RESULT', msg => {
  const root = typeof msg.root === 'string' ? msg.root : '';
  const raw = typeof msg.text === 'string' ? msg.text.slice(0, TRANSPORT_SEARCH_MAX + 1) : '';
  const text = searchText(raw);
  const echo = { root, text: raw };
  if (!isTransportRoot(root)) return { echo, error: `Not a root the search reads: ${root}` };
  if (text == null) return { echo, error: `Search for ${TRANSPORT_SEARCH_MIN} to ${TRANSPORT_SEARCH_MAX} characters.` };
  return {
    echo,
    read: (client, signal) => readTransportSearch(client, root, text, signal),
    answer: r => ({ rows: r.rows, ...(r.more ? { more: true } : {}), ...(r.missingRoot ? { missingRoot: true } : {}) }),
  };
});

registerRead('TRANSPORT_USED_BY', 'TRANSPORT_USED_BY_RESULT', msg => {
  const rid = typeof msg.rid === 'string' ? msg.rid : '';
  if (!RID_SHAPE.test(rid)) return { echo: { rid }, error: 'Not an object RID.' };
  return {
    echo: { rid },
    read: (client, signal) => readTransportUsedBy(client, rid, signal),
    answer: u => ({ users: u.users, ...(u.more ? { more: true } : {}) }),
  };
});

registerRead('TRANSPORT_FACTS', 'TRANSPORT_FACTS_RESULT', msg => {
  const raw: unknown[] = Array.isArray(msg.addresses) ? msg.addresses.slice(0, TRANSPORT_FACTS_BATCH + 1) : [];
  if (!raw.length || raw.length > TRANSPORT_FACTS_BATCH) return { echo: {}, error: `Ask for 1 to ${TRANSPORT_FACTS_BATCH} addresses.` };
  if (!raw.every(isFactAddress)) return { echo: {}, error: 'Not an address of an object.' };
  const addresses = raw as string[];
  return {
    echo: {},
    read: (client, signal) => readTransportFacts(client, addresses, signal),
    answer: facts => ({ facts }),
  };
});

/** The RIDs of a batch request, or why it is refused. */
function batchRids(value: unknown, cap = TRANSPORT_READ_BATCH): { rids: string[] } | { error: string } {
  const raw: unknown[] = Array.isArray(value) ? value.slice(0, cap + 1) : [];
  if (raw.length > cap) return { error: `At most ${cap} objects per read.` };
  const rids: string[] = [];
  for (const r of raw) {
    try { rids.push(validateRid(typeof r === 'string' ? r : '')); }
    catch { return { error: `Not an object RID: ${String(r).slice(0, 40)}` }; }
  }
  return { rids };
}

/** A batch read: refused before anything is read, or run in the profile's
 *  queue and answered with its result in `field`. */
function registerBatch(type: 'TRANSPORT_READ_OBJECTS' | 'TRANSPORT_READ_CREATION' | 'TRANSPORT_ROWS' | 'NUMERIC_IDS_ORIGINS',
  answer: 'TRANSPORT_OBJECTS_RESULT' | 'TRANSPORT_CREATION_RESULT' | 'TRANSPORT_ROWS_RESULT' | 'NUMERIC_IDS_ORIGINS_RESULT', field: 'objects' | 'texts' | 'rows' | 'origins',
  read: (client: BmpClient, rids: string[], msg: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>, cap = TRANSPORT_READ_BATCH): void {
  register(type, async (msg, respond, meta) => {
    const ctx = ctxOf(meta);
    const environment = environmentToken(ctx);
    const requestId = requestIdOf(msg.requestId);
    const reply = (r: Record<string, unknown>) => respond({ type: answer, requestId, environment, ok: false, ...r } as never);
    if (meta.senderKind === 'content') { reply({ error: NOT_FROM_PAGE, refused: true }); return; }
    if (!ctx.client) { reply({ error: 'Not connected to BMP', refused: true }); return; }
    if (!environmentMatches(ctx, msg.environment)) { reply({ error: environmentMismatchError(ctx, msg.environment), refused: true }); return; }
    const batch = batchRids(msg.rids, cap);
    if ('error' in batch) { reply({ error: batch.error, refused: true }); return; }
    const client = ctx.client;
    const { result, controller } = enqueue(environment, requestId, signal => read(client, batch.rids, msg as Record<string, unknown>, signal));
    try {
      const value = await result;
      if (controller.signal.aborted) { reply({ cancelled: true }); return; }
      if (!environmentMatches(ctxOf(meta), environment)) { reply({ error: ENVIRONMENT_CHANGED_ERROR }); return; }
      reply({ ok: true, [field]: value });
    } catch (e) {
      if (controller.signal.aborted) { reply({ cancelled: true }); return; }
      const errorKind = errorKindOf(e);
      reply({ error: errorMessage(e), ...(errorKind ? { errorKind } : {}) });
    }
  });
}

registerBatch('TRANSPORT_READ_OBJECTS', 'TRANSPORT_OBJECTS_RESULT', 'objects', (client, rids, msg, signal) => {
  // The creation text only for objects of this read.
  const creation = Array.isArray(msg.creation) ? msg.creation.filter((r): r is string => typeof r === 'string' && rids.includes(r)) : [];
  // A file's content only up to this many characters of its text.
  const limit = typeof msg.fileLimit === 'number' && Number.isFinite(msg.fileLimit) && msg.fileLimit >= 0 ? Math.floor(msg.fileLimit) : undefined;
  return readTransportObjects(client, rids, signal, creation, limit);
});

registerBatch('TRANSPORT_READ_CREATION', 'TRANSPORT_CREATION_RESULT', 'texts', (client, rids, _msg, signal) => readTransportCreation(client, rids, signal));

registerBatch('TRANSPORT_ROWS', 'TRANSPORT_ROWS_RESULT', 'rows', (client, rids, _msg, signal) => readTransportRows(client, rids, signal));

// Numeric IDs: the scan of one root, who created the objects, and the change itself.
registerRead('NUMERIC_IDS_SCAN', 'NUMERIC_IDS_SCAN_RESULT', msg => {
  const root = typeof msg.root === 'string' ? msg.root : '';
  if (!isTransportRoot(root)) return { echo: {}, error: `Not a root the numeric ID scan reads: ${root}` };
  return {
    echo: {},
    read: (client, signal) => readNumericScan(client, root, signal),
    answer: s => ({ rows: s.rows, context: s.context, ...(s.more ? { more: true } : {}), ...(s.missingRoot ? { missingRoot: true } : {}) }),
  };
});

registerBatch('NUMERIC_IDS_ORIGINS', 'NUMERIC_IDS_ORIGINS_RESULT', 'origins', (client, rids, _msg, signal) => readTransportOrigins(client, rids, signal));

register('NUMERIC_IDS_RUN', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const requestId = requestIdOf(msg.requestId);
  const transactional = msg.transactional === true;
  const reply = (r: Record<string, unknown>) => respond({ type: 'NUMERIC_IDS_RUN_RESULT', requestId, environment, ok: false, ...r } as never);
  if (meta.senderKind === 'content') { reply({ error: NOT_FROM_PAGE, refused: true }); return; }
  if (!ctx.client) { reply({ error: 'Not connected to BMP', refused: true }); return; }
  if (!environmentMatches(ctx, msg.environment)) { reply({ error: environmentMismatchError(ctx, msg.environment), refused: true }); return; }
  if (typeof msg.transactional !== 'boolean') { reply({ error: 'Say whether the change is committed or a preview.', refused: true }); return; }
  if (transactional && msg.confirmed !== true) { reply({ error: 'IDs change only after the change was confirmed.', refused: true }); return; }
  if (transactional && computeConnectionState(ctx).display !== 'connected') { reply({ error: 'The connection to the server is not confirmed now. Nothing was sent.', refused: true }); return; }
  let code: string;
  try {
    const items = Array.isArray(msg.items) ? msg.items : [];
    code = buildIdChangeEc(items.map(i => ({
      rid: String(i?.rid), space: String(i?.space), className: String(i?.className ?? ''), name: String(i?.name ?? ''), from: String(i?.from), to: String(i?.to),
    })));
  } catch (e) { reply({ error: errorMessage(e), refused: true }); return; }
  const client = ctx.client;
  let started = false;
  const begun = Date.now();
  const { result, controller } = enqueue(environment, requestId, signal => {
    started = true;
    // A committed run is never aborted once it started.
    return client.executeEc(userScript(code), undefined, transactional, transactional ? undefined : signal, TRANSPORT_PART_TIMEOUT_MS);
  });
  try {
    const r = await result;
    if (!transactional && controller.signal.aborted) { reply({ cancelled: true }); return; }
    if (!transactional && !environmentMatches(ctxOf(meta), environment)) { reply({ error: ENVIRONMENT_CHANGED_ERROR }); return; }
    if (transactional) {
      ctx.logActivity(r.ok && !r.hasWarning ? 'success' : 'error', `Numeric IDs: ${r.ok ? 'changed' : 'failed to change'} ${msg.items.length} IDs (${Date.now() - begun}ms)`, r.ok ? undefined : r.error, { category: 'change', action: 'save-property', durationMs: Date.now() - begun });
    }
    if (r.ok && r.hasWarning) { reply({ error: `BMP reported a warning${r.log ? `: ${r.log.slice(0, 300)}` : '.'}`, log: r.log ?? '', ...(transactional ? { outcomeUnknown: true } : {}) }); return; }
    reply({
      ok: r.ok, log: r.log ?? '', ...(r.error ? { error: r.error } : {}), ...(r.errorKind ? { errorKind: r.errorKind } : {}),
      ...(r.outcomeUnknown ? { outcomeUnknown: true } : {}),
    });
  } catch (e) {
    if (!started && controller.signal.aborted) { reply({ cancelled: true }); return; }
    const errorKind = errorKindOf(e);
    reply({ error: errorMessage(e), ...(errorKind ? { errorKind } : {}), ...(transactional && started ? { outcomeUnknown: true } : {}) });
  }
});


/** RIDs the objects of a page return at most. */
const PAGE_OBJECTS_CAP = 2_000;

register('TRANSPORT_PAGE_OBJECTS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const requestId = requestIdOf(msg.requestId);
  const reply = (r: Record<string, unknown>) => respond({ type: 'TRANSPORT_PAGE_OBJECTS_RESULT', requestId, environment, ok: false, ...r } as never);
  if (meta.senderKind === 'content') { reply({ error: NOT_FROM_PAGE, refused: true }); return; }
  if (!environmentMatches(ctx, msg.environment)) { reply({ error: environmentMismatchError(ctx, msg.environment), refused: true }); return; }
  // The window is a frame of the BMP tab: that tab's own page.
  const tabId = meta.senderTabId;
  if (tabId == null) { reply({ error: 'This window is not on a BMP page.', refused: true }); return; }
  let info: { type?: string; widgets?: Array<{ rid?: unknown }> } | undefined;
  try {
    info = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' } satisfies InspectorMessage) as typeof info;
  } catch {
    info = undefined;
  }
  if (info?.type !== 'PAGE_INFO') { reply({ error: 'The page did not answer. Reload it and try again.' }); return; }
  const rids = [...new Set((info.widgets ?? []).map(w => (typeof w.rid === 'string' ? w.rid : '')).filter(r => RID_SHAPE.test(r)))].slice(0, PAGE_OBJECTS_CAP);
  reply({ ok: true, rids });
});

register('TRANSPORT_LOG', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const requestId = requestIdOf(msg.requestId);
  const reply = (r: Record<string, unknown>) => respond({ type: 'TRANSPORT_LOG_RESULT', requestId, environment, ok: false, ...r } as never);
  if (meta.senderKind === 'content') { reply({ error: NOT_FROM_PAGE, refused: true }); return; }
  if (!ctx.client) { reply({ error: 'Not connected to BMP', refused: true }); return; }
  if (!environmentMatches(ctx, msg.environment)) { reply({ error: environmentMismatchError(ctx, msg.environment), refused: true }); return; }
  const client = ctx.client;
  const { result, controller } = enqueue(environment, requestId, signal => readTransportLog(client, signal));
  try {
    const log = await result;
    if (controller.signal.aborted) { reply({ cancelled: true }); return; }
    if (!environmentMatches(ctxOf(meta), environment)) { reply({ error: ENVIRONMENT_CHANGED_ERROR }); return; }
    reply({ ok: true, entries: log.entries, ...(log.more ? { more: true } : {}), ...(log.missingLog ? { missingLog: true } : {}) });
  } catch (e) {
    if (controller.signal.aborted) { reply({ cancelled: true }); return; }
    const errorKind = errorKindOf(e);
    reply({ error: errorMessage(e), ...(errorKind ? { errorKind } : {}) });
  }
});

// ── other workspaces: the targets of a direct apply ───────────────

/** The bound context of a stored profile, its stores loaded; null when there
 *  is no such profile (or no scopes: a unit-test harness). */
async function profileContext(profileId: string): Promise<SwContext | null> {
  if (!getCtx().scopeFor) return null;
  const scope = scopeFor(profileId);
  if (!scope) return null;
  await scope.ready;
  return scope.ctx;
}

/** The host of a server URL, '' when it cannot be read. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

register('TRANSPORT_TARGETS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const requestId = requestIdOf(msg.requestId);
  const reply = (r: Record<string, unknown>) => respond({ type: 'TRANSPORT_TARGETS_RESULT', requestId, environment, ok: false, ...r } as never);
  if (meta.senderKind === 'content') { reply({ error: NOT_FROM_PAGE, refused: true }); return; }
  if (!environmentMatches(ctx, msg.environment)) { reply({ error: environmentMismatchError(ctx, msg.environment), refused: true }); return; }
  const own = environment.split('@')[0];
  const targets: TransportTarget[] = [];
  for (const profile of getCtx().settings.profiles) {
    if (!profile.bmpUrl || profile.id === own) continue;
    const t = await profileContext(profile.id);
    if (!t?.client) continue;
    const token = environmentToken(t);
    if (token === environment || computeConnectionState(t).display !== 'connected') continue;
    const host = hostOf(t.client.serverUrl) || hostOf(profile.bmpUrl);
    targets.push({ environment: token, label: profile.label || host || profile.id, host });
  }
  reply({ ok: true, targets });
});

register('TRANSPORT_RUN_PART', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const requestId = requestIdOf(msg.requestId);
  const target = typeof msg.target === 'string' ? msg.target.slice(0, 1_000) : '';
  const code = typeof msg.code === 'string' ? msg.code : '';
  const transactional = msg.transactional === true;
  const reply = (r: Record<string, unknown>) => respond({ type: 'TRANSPORT_PART_RESULT', requestId, environment, target, ok: false, ...r } as never);
  if (meta.senderKind === 'content') { reply({ error: NOT_FROM_PAGE, refused: true }); return; }
  if (!ctx.client) { reply({ error: 'Not connected to BMP', refused: true }); return; }
  if (!environmentMatches(ctx, msg.environment)) { reply({ error: environmentMismatchError(ctx, msg.environment), refused: true }); return; }
  if (typeof msg.transactional !== 'boolean') { reply({ error: 'Say whether the part is run committed or as a preview.', refused: true }); return; }
  if (transactional && msg.confirmed !== true) { reply({ error: 'A committed part runs only after the apply was confirmed.', refused: true }); return; }
  if (!code.trim()) { reply({ error: 'The part is empty.', refused: true }); return; }
  if (code.length > SCRIPT_LIMITS.user) { reply({ error: `Script not sent: the part has ${code.length} characters, over Companion's limit of ${SCRIPT_LIMITS.user}.`, refused: true }); return; }
  const at = target.indexOf('@');
  if (at <= 0 || target === environment) { reply({ error: 'Not another workspace.', refused: true }); return; }
  const t = await profileContext(target.slice(0, at));
  if (!t?.client || environmentToken(t) !== target) { reply({ error: 'Companion is not connected to that workspace now. Compare again.', refused: true }); return; }
  if (transactional && computeConnectionState(t).display !== 'connected') { reply({ error: 'The connection to that workspace is not confirmed now. Nothing was sent.', refused: true }); return; }
  const client = t.client;
  let started = false;
  const begun = Date.now();
  const { result, controller } = enqueue(target, requestId, signal => {
    started = true;
    // A committed run is never aborted once it started.
    return client.executeEc(userScript(code), undefined, transactional, transactional ? undefined : signal, TRANSPORT_PART_TIMEOUT_MS);
  });
  try {
    const r = await result;
    if (!transactional && controller.signal.aborted) { reply({ cancelled: true }); return; }
    if (!transactional && environmentToken(t) !== target) { reply({ error: ENVIRONMENT_CHANGED_ERROR }); return; }
    if (transactional) {
      t.logActivity(r.ok ? 'success' : 'error', `Transport (beta): ${r.ok ? 'ran' : 'failed to run'} a committed part (${Date.now() - begun}ms)`, r.ok ? undefined : r.error, { category: 'execution', action: 'execute', durationMs: Date.now() - begun });
    }
    reply({
      ok: r.ok, log: r.log ?? '', ...(r.error ? { error: r.error } : {}), ...(r.errorKind ? { errorKind: r.errorKind } : {}),
      ...(r.outcomeUnknown ? { outcomeUnknown: true } : {}),
    });
  } catch (e) {
    if (!started && controller.signal.aborted) { reply({ cancelled: true }); return; }
    const errorKind = errorKindOf(e);
    reply({ error: errorMessage(e), ...(errorKind ? { errorKind } : {}), ...(transactional && started ? { outcomeUnknown: true } : {}) });
  }
});
