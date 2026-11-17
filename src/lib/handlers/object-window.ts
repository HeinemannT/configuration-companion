/**
 * Object window handlers — OPEN_OBJECT_ROOT, READ_OBJECT_SUMMARIES and
 * READ_FULL_OBJECTS. All are read-only; none writes to BMP. The window saves
 * through the existing write routes (APPLY_OBJECT_CHANGES, SAVE_IDENTITY,
 * SAVE_PROPERTY).
 */

import { register } from '../handler-registry';
import { ctxOf, getCtx, type SwContext } from '../sw-context';
import { errorMessage } from '../logger';
import { errorKindOf } from '../error-kind';
import { ENVIRONMENT_CHANGED_ERROR, environmentMatches, environmentMismatchError, environmentToken } from '../environment';
import { openObjectRoot, type ObjectRootPayload } from '../object-window';
import { listStructures, parseStructureRows } from '../object-structure';
import { OBJECT_RELATION_EC_TIMEOUT } from '../constants';
import { isDataObject } from '../object-window-table';
import { isRidShaped } from '../validate-inbound';
import { readSummaries } from '../object-summaries';
import { createEcFrame } from '../ec-parser';
import { rowFactsNote } from '../row-facts-status';
import { backgroundSignal, promoteToUser } from '../request-class';
import { noteFrameServed, type FrameSender } from '../sender-trust';
import type { HandlerMeta } from '../handler-registry';

/** The sender of a frame message as sender-trust.ts records it. */
function frameSender(meta: HandlerMeta): FrameSender {
  return { tabId: meta.senderTabId, frameId: meta.senderFrameId, documentId: meta.senderDocumentId, url: meta.senderUrl };
}

/** Coalesce duplicate opens of the same root (double-click, back+forward),
 *  and keep a prefetched result for a short time so the window's own request
 *  (sent once its frame has loaded) is answered from it. */
interface RootEntry {
  request: Promise<ObjectRootPayload>;
  at: number;
  settled: boolean;
  /** Set while the read is a hover prefetch: background posts that the next
   *  hover supersedes. Cleared when a user open joins it. */
  hover?: { signal: AbortSignal; controller: AbortController };
}
const inFlight = new Map<string, RootEntry>();
/** How long a finished prefetch stays available to the window's request. */
const PREFETCH_KEEP_MS = 8_000;
/** Type hint for a data object's presenting template (see controller.ts). */
const TEMPLATE_HINT = 'EnterpriseTemplate';

/** Who asks for a root:
 *  - `open`: a user open (OPEN_OBJECT_VIEW) or another surface's read;
 *  - `window`: the object window's own OPEN_OBJECT_ROOT, which consumes a
 *    finished prefetch;
 *  - `hover`: the pointer rests on a badge. Background class; at most one
 *    hover read at a time, superseded by the next hover. */
type RootMode = 'open' | 'window' | 'hover';

/** The current hover prefetch per profile, if any (map key). */
const hoverKeys = new Map<string, string>();

const fresh = (entry: RootEntry) => Date.now() - entry.at < PREFETCH_KEEP_MS;

/** A user open joins a hover read: from now on its posts are user posts and
 *  a later hover no longer cancels it. */
function promote(key: string, entry: RootEntry): void {
  if (!entry.hover) return;
  promoteToUser(entry.hover.signal);
  entry.hover = undefined;
  for (const [profile, k] of hoverKeys) if (k === key) hoverKeys.delete(profile);
}

/** One open of `rid`. A request still under way is always joined. A finished
 *  prefetch is handed once to the window's own request and then dropped. A
 *  new user open never reuses a finished user prefetch, so reopening an
 *  object after a save reads it again; it does reuse a finished hover read
 *  from the last few seconds, which is what makes the open instant. */
function rootRequest(ctx: SwContext, rid: string, typeHint: string | undefined, mode: RootMode, signal?: AbortSignal): Promise<ObjectRootPayload> | null {
  const client = ctx.client;
  if (!client || !isRidShaped(rid)) return null;
  const key = `${environmentToken(ctx)}::${rid}`;
  const cur = inFlight.get(key);
  if (cur) {
    const fromHover = !!cur.hover;
    const reuse = !cur.settled
      || (mode === 'window' && fresh(cur))
      || (mode === 'hover' && fresh(cur))
      || (mode === 'open' && fromHover && fresh(cur));
    if (reuse) {
      if (mode !== 'hover') promote(key, cur);
      if (mode === 'window') {
        const consume = () => { if (inFlight.get(key) === cur) inFlight.delete(key); };
        cur.request.then(consume, consume);
      }
      return cur.request;
    }
  }
  let hover: RootEntry['hover'];
  if (mode === 'hover' && !signal) {
    const controller = new AbortController();
    hover = { controller, signal: backgroundSignal({ signal: controller.signal }) };
  }
  const readSignal = hover?.signal ?? signal;
  const request = openObjectRoot(client, rid, typeHint, readSignal);
  const entry: RootEntry = { request, at: Date.now(), settled: false, ...(hover ? { hover } : {}) };
  inFlight.set(key, entry);
  if (hover) hoverKeys.set(ctx.profileId ?? '', key);
  const drop = () => { if (inFlight.get(key) === entry) inFlight.delete(key); };
  request.then(payload => {
    entry.settled = true;
    entry.at = Date.now();
    if (mode === 'window') { drop(); return; }
    setTimeout(drop, PREFETCH_KEEP_MS);
    // A data object is shown with its presenting template: start that open
    // now, so it is under way before the window asks for it. A hover read
    // keeps its class and its cancellation for this second read.
    const tpl = isDataObject(payload.root) ? payload.root.references.template?.[0] : undefined;
    if (tpl) rootRequest(ctx, tpl, TEMPLATE_HINT, 'open', entry.hover?.signal)?.catch(() => { /* the window asks again */ });
  }, drop);
  return request;
}

/** Start reading a root before its window asks (OPEN_OBJECT_VIEW). The
 *  window's OPEN_OBJECT_ROOT for the same rid joins this request. */
export function prefetchObjectRoot(rid: string, typeHint?: string, ctx: SwContext = getCtx()): void {
  rootRequest(ctx, rid, typeHint, 'open')?.catch(() => { /* reported to the window's own request */ });
}

/** The pointer rests on a badge: read its root as background work, so a
 *  double-click that follows opens at once. One hover read at a time: a read
 *  for another object cancels the previous one (its waiting posts leave the
 *  queue; a post in flight finishes and its answer is dropped). */
export function hoverPrefetchObjectRoot(rid: string, typeHint?: string, ctx: SwContext = getCtx()): void {
  if (!ctx.client || !isRidShaped(rid)) return;
  const key = `${environmentToken(ctx)}::${rid}`;
  // One hover read per server profile: a hover on another server's page
  // does not cancel this one.
  const profile = ctx.profileId ?? '';
  const hoverKey = hoverKeys.get(profile);
  if (hoverKey && hoverKey !== key) {
    const prev = inFlight.get(hoverKey);
    // Also stops the template read a finished hover read started; the
    // finished root itself stays available for a few seconds.
    prev?.hover?.controller.abort();
    hoverKeys.delete(profile);
  }
  rootRequest(ctx, rid, typeHint, 'hover')?.catch(() => { /* superseded, or the window asks again */ });
}

/** Read a root for another surface (the side panel's Browse tree). Joins a
 *  read already under way and, like a prefetch, leaves the result briefly
 *  for an object window that opens the same root. Null when not connected. */
export function readObjectRoot(rid: string, typeHint?: string, ctx: SwContext = getCtx()): Promise<ObjectRootPayload> | null {
  return rootRequest(ctx, rid, typeHint, 'open');
}

register('PREFETCH_OBJECT_VIEW', (msg, _respond, meta) => {
  const hint = typeof msg.objectType === 'string' && msg.objectType.length <= 200 ? msg.objectType : undefined;
  if (typeof msg.rid === 'string') hoverPrefetchObjectRoot(msg.rid, hint, ctxOf(meta));
});

const MAX_SUMMARY_RIDS = 200;

register('OPEN_OBJECT_ROOT', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  if (!ctx.client) {
    respond({ type: 'OBJECT_ROOT_DATA', rid: msg.rid, environment, ok: false, error: 'Not connected to BMP' });
    return;
  }
  if (!isRidShaped(msg.rid)) {
    respond({ type: 'OBJECT_ROOT_DATA', rid: msg.rid, environment, ok: false, error: `Not an object RID: ${msg.rid}` });
    return;
  }
  // A window that already shows data from one server never reads another
  // server's object into its draft.
  if (msg.environment && msg.environment !== environment) {
    respond({ type: 'OBJECT_ROOT_DATA', rid: msg.rid, environment, ok: false, error: environmentMismatchError(ctx, msg.environment), environmentChanged: true });
    return;
  }
  const request = rootRequest(ctx, msg.rid, msg.typeHint, 'window');
  if (!request) {
    respond({ type: 'OBJECT_ROOT_DATA', rid: msg.rid, environment, ok: false, error: 'Not connected to BMP' });
    return;
  }
  try {
    const payload = await request;
    if (!environmentMatches(ctxOf(meta), environment)) {
      respond({ type: 'OBJECT_ROOT_DATA', rid: msg.rid, environment, ok: false, error: ENVIRONMENT_CHANGED_ERROR });
      return;
    }
    // What this window was served (root, tree nodes, template): the objects
    // it may write custom values of (sender-trust.ts). The root is pinned: a
    // tree of more than FRAME_SERVED_PER_KEY nodes never pushes it out.
    if (meta.senderKind === 'frame') {
      await noteFrameServed(frameSender(meta), environment,
        [...Object.keys(payload.nodes ?? {}), payload.root.references.linkedTo?.[0], payload.root.references.template?.[0]],
        { root: payload.root.rid });
    }
    respond({ type: 'OBJECT_ROOT_DATA', rid: msg.rid, environment, ok: true, payload });
  } catch (e) {
    const errorKind = errorKindOf(e);
    respond({ type: 'OBJECT_ROOT_DATA', rid: msg.rid, environment, ok: false, error: errorMessage(e), ...(errorKind ? { errorKind } : {}) });
  }
});

register('READ_OBJECT_SUMMARIES', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  if (!ctx.client) {
    respond({ type: 'OBJECT_SUMMARIES_DATA', environment, ok: false, summaries: [], error: 'Not connected to BMP' });
    return;
  }
  const rids = [...new Set((Array.isArray(msg.rids) ? msg.rids : []).filter(r => typeof r === 'string' && isRidShaped(r)))]
    .slice(0, MAX_SUMMARY_RIDS);
  try {
    // Name, type and ID only: one small script per 100 objects instead of
    // full object reads (object-summaries.ts; lighter on the server).
    const { summaries, missing, failed } = await readSummaries(ctx.client, rids, createEcFrame);
    respond({ type: 'OBJECT_SUMMARIES_DATA', environment, ok: true, summaries, missing, failed });
  } catch (e) {
    respond({ type: 'OBJECT_SUMMARIES_DATA', environment, ok: false, summaries: [], error: errorMessage(e) });
  }
});

/** Template reads and re-reads after a save: a few objects, one batched post. */
const MAX_FULL_RIDS = 100;

register('READ_FULL_OBJECTS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  if (!ctx.client) {
    respond({ type: 'FULL_OBJECTS_DATA', environment, ok: false, objects: {}, errors: {}, error: 'Not connected to BMP' });
    return;
  }
  if (msg.environment && msg.environment !== environment) {
    respond({ type: 'FULL_OBJECTS_DATA', environment, ok: false, objects: {}, errors: {}, error: environmentMismatchError(ctx, msg.environment) });
    return;
  }
  const rids = [...new Set((Array.isArray(msg.rids) ? msg.rids : []).filter(r => typeof r === 'string' && isRidShaped(r)))]
    .slice(0, MAX_FULL_RIDS);
  try {
    const { objects, errors } = await ctx.client.readFullObjects(rids);
    if (!environmentMatches(ctxOf(meta), environment)) {
      respond({ type: 'FULL_OBJECTS_DATA', environment, ok: false, objects: {}, errors: {}, error: ENVIRONMENT_CHANGED_ERROR });
      return;
    }
    if (meta.senderKind === 'frame') await noteFrameServed(frameSender(meta), environment, rids.filter(r => Object.hasOwn(objects, r) && !!objects[r]));
    respond({ type: 'FULL_OBJECTS_DATA', environment, ok: true, objects, errors });
  } catch (e) {
    respond({ type: 'FULL_OBJECTS_DATA', environment, ok: false, objects: {}, errors: {}, error: errorMessage(e) });
  }
});

/** Nodes followed per LIST_REFERENCED (a button row that became visible). */
const MAX_FOLLOW = 24;

/** Follow single references of tree nodes (a ButtonInput's action object):
 *  ONE structure listing for every item and ONE batched read of the listed
 *  nodes. Read-only. Rows carry the node they hang under (`parent`). */
register('LIST_REFERENCED', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const client = ctx.client;
  const fail = (error: string) => respond({ type: 'REFERENCED_DATA', environment, ok: false, rows: [], nodes: {}, error });
  if (!client) { fail('Not connected to BMP'); return; }
  const items = (Array.isArray(msg.items) ? msg.items : [])
    .filter(it => !!it && typeof it.rid === 'string' && isRidShaped(it.rid) && typeof it.via === 'string' && /^[A-Za-z_]\w{0,63}$/.test(it.via))
    .slice(0, MAX_FOLLOW);
  if (!items.length) { respond({ type: 'REFERENCED_DATA', environment, ok: true, rows: [], nodes: {} }); return; }
  try {
    const listed = await listStructures(client, items.map(it => ({
      rid: it.rid,
      rule: { via: it.via, depth: Math.max(0, Math.min(2, Math.floor(Number(it.depth) || 0))) },
    })), undefined, OBJECT_RELATION_EC_TIMEOUT);
    if (!listed.ok) { fail(listed.error || 'Listing failed'); return; }
    const rows = parseStructureRows(listed.log ?? '');
    // Row facts only (object-row-facts.ts): a node is read in full when selected.
    const read = rows.length ? await client.readRowFacts(rows.map(r => r.rid)) : { objects: {}, error: undefined };
    if (!environmentMatches(ctxOf(meta), environment)) { fail(ENVIRONMENT_CHANGED_ERROR); return; }
    // Nothing named: say why rather than add rows that read "(not read)".
    if (read.error && rows.length && !Object.keys(read.objects).length) { fail(rowFactsNote(read.error)); return; }
    respond({ type: 'REFERENCED_DATA', environment, ok: true, rows: [...rows], nodes: read.objects });
  } catch (e) {
    fail(errorMessage(e));
  }
});
