/**
 * Browse tab handlers (side panel) — all read-only.
 *
 *  - BROWSE_TREE: the structure of the page the user is on. Reuses the object
 *    window's structure machinery (openObjectRoot: one EC listing plus one
 *    batched read), adds the presenting template of a data object and the
 *    page's ancestors for the location crumb. Types without a structure rule
 *    fall back to the object and its direct children.
 *  - BROWSE_RESOLVE: an exact RID or business ID typed into the search.
 *  - LOCATE_ON_PAGE: ring an object's element on the page of the panel's
 *    window (the content script answers with the rid it found, after
 *    switching to the object's page tab when needed; lib/locate-plan.ts).
 */

import { readSummaries } from '../object-summaries';
import { register } from '../handler-registry';
import { ctxOf, getCtx } from '../sw-context';
import type { HandlerMeta } from '../handler-registry';
import type { InspectorMessage } from '../types';
import { errorMessage } from '../logger';
import { environmentMatches, environmentToken, ENVIRONMENT_CHANGED_ERROR } from '../environment';
import { isRidShaped } from '../validate-inbound';
import { cleanLocateAnswer, cleanLocateTabs, layoutTabs, type LocateTab } from '../locate-plan';
import { readObjectRoot } from './object-window';
import { typeInfo } from '../object-window-table';
import type { ObjectRootPayload } from '../object-window';
import {
  browsePlan, withTemplate, buildAncestorsEc, flattenTree, idLookupPlan, isLookupableId, parseAncestors,
  type BrowseCrumb, type BrowseTree,
} from '../browse-tree';
import { OBJECT_RELATION_EC_TIMEOUT } from '../constants';
import { CONTEXT_OBJECT, createEcFrame } from '../ec-parser';
import { listStructures, parseStructureRows, STRUCTURE_MAX_NODES } from '../object-structure';
import { resolveRefRids } from '../ref-rid';
import { cachedTypeCatalogue, lookupIdByCommand } from '../id-lookup';

const TEMPLATE_HINT = 'EnterpriseTemplate';
/** Nodes followed through a reference (InputView → its input set). */
const MAX_REFERENCED = 24;

type Client = NonNullable<ReturnType<typeof getCtx>['client']>;

/** A page lists its widgets, but an InputView's inputs hang off its
 *  `inputSet` reference, not its children. List every such node's structure
 *  (its type's `via` rule) in ONE EC call and read the new nodes in ONE
 *  batched read, so the page tree reaches the inputs a badge can point at.
 *  Failures leave the tree as it was. */
async function expandReferenced(client: Client, payload: ObjectRootPayload, signal?: AbortSignal): Promise<{ payload: ObjectRootPayload; posts: number }> {
  const rows = payload.rows ?? [];
  const targets = rows
    .map(r => payload.nodes[r.rid])
    .filter(o => !!o && o.rid !== payload.rid && !!typeInfo(o.type).structure?.via)
    .slice(0, MAX_REFERENCED);
  if (!targets.length) return { payload, posts: 0 };
  let posts = 0;
  try {
    const listed = await listStructures(client, targets.map(o => ({ rid: o.rid, rule: typeInfo(o.type).structure! })), signal, OBJECT_RELATION_EC_TIMEOUT);
    posts++;
    if (!listed.ok || listed.hasWarning) return { payload, posts };
    const known = new Set([payload.rid, ...rows.map(r => r.rid)]);
    const extra = parseStructureRows(listed.log ?? '').filter(r => !known.has(r.rid));
    if (!extra.length || signal?.aborted) return { payload, posts };
    // Row facts only (object-row-facts.ts): a node is read in full when opened.
    const { objects, posts: n, error } = await client.readRowFacts(extra.map(r => r.rid), signal);
    posts += n;
    const rowFactsError = payload.rowFactsError ?? error;
    return { payload: { ...payload, rows: [...rows, ...extra], nodes: { ...payload.nodes, ...objects }, ...(rowFactsError ? { rowFactsError } : {}) }, posts };
  } catch {
    return { payload, posts };
  }
}

/** The page trees being read, per panel window. The panel asks for the page
 *  the user is on; someone moving through pages leaves a read for each page
 *  behind, and the page they stop on would wait behind them all. A read for
 *  another page from the same window ends the older ones. */
const treeReads = new Map<number, Array<{ rid: string; controller: AbortController }>>();

/** Start a tree read for `rid` in `windowId`: every running read of that
 *  window for another rid is aborted. `done` forgets this read. */
function claimTreeRead(windowId: number | undefined, rid: string): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  if (windowId == null) return { signal: controller.signal, done: () => { /* not tracked */ } };
  const keep: Array<{ rid: string; controller: AbortController }> = [];
  for (const read of treeReads.get(windowId) ?? []) {
    if (read.rid === rid) keep.push(read);
    else read.controller.abort();
  }
  const own = { rid, controller };
  keep.push(own);
  treeReads.set(windowId, keep);
  return {
    signal: controller.signal,
    done: () => {
      const rest = (treeReads.get(windowId) ?? []).filter(r => r !== own);
      if (rest.length) treeReads.set(windowId, rest); else treeReads.delete(windowId);
    },
  };
}

register('BROWSE_TREE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const { signal, done } = claimTreeRead(meta.panelWindowId, msg.rid);
  // Superseded by a read for another page: the panel hears at once that this
  // rid was dropped (it asks again when the page is shown) and nothing more
  // is sent for it. Waiting posts leave the transport queue with the signal.
  signal.addEventListener('abort', () => {
    done();
    respond({ type: 'BROWSE_TREE_DATA', rid: msg.rid, environment, ok: false, superseded: true });
  }, { once: true });
  try {
    await browseTree(msg, m => { if (!signal.aborted) respond(m); }, meta, environment, signal);
  } finally {
    done();
  }
});

async function browseTree(
  msg: { rid: string; typeHint?: string },
  respond: (m: InspectorMessage) => void,
  meta: HandlerMeta,
  environment: string,
  signal: AbortSignal,
): Promise<void> {
  const ctx = ctxOf(meta);
  const client = ctx.client;
  const fail = (error: string) => respond({ type: 'BROWSE_TREE_DATA', rid: msg.rid, environment, ok: false, error });
  if (!client) { fail('Not connected to BMP'); return; }
  if (!isRidShaped(msg.rid)) { fail(`Not an object RID: ${msg.rid}`); return; }
  const started = Date.now();
  let posts = 0;
  // On the panel port the answer comes in steps (crumbs, own rows, whole
  // tree), so the panel can draw what is known; a one-shot caller gets the
  // whole tree once.
  const progressive = !meta.isOneShot;

  // The crumb is independent of the structure: start it now (the transport
  // serialises posts, so this costs one short EC call either way). It lands
  // first, so the panel knows at once whether a location line is coming.
  const crumbs: Promise<BrowseCrumb[]> = (async () => {
    let out: BrowseCrumb[] = [];
    try {
      const frame = createEcFrame();
      // One constant script: the object is the command's context.
      const r = await client.executeEcOn(buildAncestorsEc(CONTEXT_OBJECT, frame), msg.rid, signal, OBJECT_RELATION_EC_TIMEOUT);
      posts++;
      out = r.ok ? parseAncestors(r.log ?? '', frame) : [];
    } catch { out = []; }
    if (progressive && environmentMatches(ctxOf(meta), environment)) {
      respond({ type: 'BROWSE_TREE_DATA', rid: msg.rid, environment, ok: true, crumbs: out });
    }
    return out;
  })();

  let root: ObjectRootPayload;
  try {
    // The shared root read carries no abort (an object window may have
    // joined it): a superseded browse only stops waiting for it.
    const request = readObjectRoot(msg.rid, msg.typeHint, ctx);
    if (!request) { fail('Not connected to BMP'); return; }
    root = await request;
  } catch (e) {
    fail(errorMessage(e));
    return;
  }
  if (signal.aborted) return;
  posts += root.posts;

  let presented: ObjectRootPayload | null = null;
  let fallback = false;
  let plan = browsePlan(root);
  if (plan.selected) {
    // The object picks its template by expression: the `template` reference
    // is not the one BMP presents it with. One small read says which it is;
    // when that read fails the reference stays as the best guess.
    try {
      const resolved = await client.resolveTemplate(msg.rid);
      posts++;
      if (signal.aborted) return;
      plan = withTemplate(root, plan, resolved.templateRid && isRidShaped(resolved.templateRid) ? resolved.templateRid : null);
    } catch { /* keep the reference */ }
  }
  let presentedState: BrowseTree['presented'] = plan.presented;
  const templateRid = plan.templateRid;
  if (plan.children) {
    // No structure rule for this type and no template to show: the object
    // and its direct children.
    fallback = true;
    try {
      const rows = await client.fetchStructureRows(msg.rid, { depth: 1 }, signal);
      posts++;
      if (signal.aborted) return;
      const { objects, posts: n, error } = rows.length ? await client.readRowFacts(rows.map(r => r.rid), signal) : { objects: {}, posts: 0, error: undefined };
      posts += n;
      root = { ...root, rows, nodes: objects, ...(rows.truncated ? { structureTruncatedAt: STRUCTURE_MAX_NODES } : {}), ...(error ? { rowFactsError: error } : {}) };
    } catch (e) {
      root = { ...root, structureError: errorMessage(e) };
    }
  }
  if (signal.aborted) return;

  {
    const own = await expandReferenced(client, root, signal);
    root = own.payload;
    posts += own.posts;
  }
  if (signal.aborted) return;
  const crumbList = await crumbs;
  if (signal.aborted) return;
  const build = (): BrowseTree => ({
    rootRid: msg.rid,
    nodes: flattenTree(root, presented),
    crumbs: crumbList,
    presented: presentedState,
    fallback,
    ...(root.structureError ? { structureError: root.structureError } : {}),
    ...(root.structureTruncatedAt ? { structureTruncatedAt: root.structureTruncatedAt } : {}),
    ...(root.rootFallback ? { rootFallback: root.rootFallback } : {}),
    ...(root.rowFactsError ? { rowFactsError: root.rowFactsError } : {}),
    posts,
    ms: Date.now() - started,
  });

  if (templateRid) {
    // The presenting template can be large (a whole page design); the
    // object's own rows go out first and the template follows.
    if (progressive) {
      if (!environmentMatches(ctxOf(meta), environment)) { fail(ENVIRONMENT_CHANGED_ERROR); return; }
      respond({ type: 'BROWSE_TREE_DATA', rid: msg.rid, environment, ok: true, tree: { ...build(), presented: 'loading' } });
    }
    try {
      const request = readObjectRoot(templateRid, TEMPLATE_HINT, ctx);
      presented = request ? await request : null;
      if (signal.aborted) return;
      presentedState = presented ? 'loaded' : 'error';
      if (presented) {
        posts += presented.posts;
        const tpl = await expandReferenced(client, presented, signal);
        presented = tpl.payload;
        posts += tpl.posts;
      }
    } catch {
      presentedState = 'error';
    }
  }

  if (signal.aborted) return;
  if (!environmentMatches(ctxOf(meta), environment)) { fail(ENVIRONMENT_CHANGED_ERROR); return; }
  respond({ type: 'BROWSE_TREE_DATA', rid: msg.rid, environment, ok: true, tree: build() });
}

/** Exact lookups answered lately, per server profile (environment token)
 *  and query: the picker asks one for every pause in typing, and a query
 *  typed again (Backspace, a second picker) is answered here. Short-lived
 *  and dropped on any write of the connection, so a renamed or new object
 *  is found by the next lookup. */
const resolveAnswers = new Map<string, { at: number; result: { ok: true; object?: { rid: string; type: string; name: string; businessId: string } } }>();
export const RESOLVE_ANSWER_TTL_MS = 60_000;
const RESOLVE_ANSWER_MAX = 200;
const resolveWatched = new WeakSet<object>();

register('BROWSE_RESOLVE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const client = ctx.client;
  const query = typeof msg.query === 'string' ? msg.query.trim() : '';
  const reply = (result: { ok: boolean; object?: { rid: string; type: string; name: string; businessId: string }; error?: string }) =>
    respond({ type: 'BROWSE_RESOLVE_RESULT', query: msg.query, gen: msg.gen, ...result });
  if (!client) { reply({ ok: false, error: 'Not connected to BMP' }); return; }
  const environment = environmentToken(ctx);
  const key = `${environment}|${query}`;
  const known = resolveAnswers.get(key);
  if (known && Date.now() - known.at < RESOLVE_ANSWER_TTL_MS) { reply(known.result); return; }
  if (!resolveWatched.has(client) && typeof client.onWrite === 'function') {
    resolveWatched.add(client);
    client.onWrite(() => { for (const k of [...resolveAnswers.keys()]) if (k.startsWith(`${environment}|`)) resolveAnswers.delete(k); });
  }
  const done = (result: { ok: boolean; object?: { rid: string; type: string; name: string; businessId: string }; error?: string }) => {
    if (result.ok && !result.error) {
      resolveAnswers.delete(key);
      resolveAnswers.set(key, { at: Date.now(), result: { ok: true, ...(result.object ? { object: result.object } : {}) } });
      while (resolveAnswers.size > RESOLVE_ANSWER_MAX) resolveAnswers.delete(resolveAnswers.keys().next().value!);
    }
    reply(result);
  };
  try {
    if (/^-?\d{15,20}$/.test(query)) {
      // A RID: one small identity script (object-summaries.ts), not a full
      // object read.
      const { summaries } = await readSummaries(client, [query], createEcFrame);
      const o = summaries[0];
      if (!environmentMatches(ctxOf(meta), environment)) return;
      done(o ? { ok: true, object: { rid: o.rid, type: o.type, name: o.name, businessId: o.businessId } } : { ok: true });
      return;
    }
    if (!isLookupableId(query)) { done({ ok: true }); return; }
    // The built-in by-ID lookup first: no script text (id-lookup.ts).
    const byCommand = await lookupIdByCommand(client, query, () => cachedTypeCatalogue(client)).catch(() => undefined);
    if (!environmentMatches(ctxOf(meta), environment)) return;
    if (byCommand !== undefined) {
      if (byCommand === null) { done({ ok: true }); return; }
      const { summaries } = await readSummaries(client, [byCommand], createEcFrame);
      if (!environmentMatches(ctxOf(meta), environment)) return;
      const o = summaries[0];
      done(o ? { ok: true, object: { rid: o.rid, type: o.type, name: o.name, businessId: o.businessId } } : { ok: true });
      return;
    }
    // The catalogue or the lookup posts failed: the script lookup.
    // The ID is text, so the lookup varies: small scripts that only find
    // the RID in each ID space (ref-rid); the first space that knows it
    // wins. Its identity is read by the constant summary script.
    const plan = idLookupPlan(query);
    const found = await resolveRefRids(plan.exprs, code => client.executeEc(code, undefined, false, undefined, OBJECT_RELATION_EC_TIMEOUT), plan.prelude);
    if (!environmentMatches(ctxOf(meta), environment)) return;
    const answers = plan.exprs.map(e => found.get(e));
    const rid = answers.find((v): v is string => typeof v === 'string');
    if (!rid) {
      const failed = answers.find((v): v is Error => v instanceof Error);
      // Every space refused: the lookup failed; otherwise the ID is unknown.
      done(failed && answers.every(v => v instanceof Error) ? { ok: false, error: failed.message || 'Lookup failed' } : { ok: true });
      return;
    }
    const { summaries } = await readSummaries(client, [rid], createEcFrame);
    if (!environmentMatches(ctxOf(meta), environment)) return;
    const o = summaries[0];
    done(o ? { ok: true, object: { rid: o.rid, type: o.type, name: o.name, businessId: o.businessId } } : { ok: true });
  } catch (e) {
    done({ ok: false, error: errorMessage(e) });
  }
});

register('LOCATE_ON_PAGE', async (msg, respond, meta) => {
  const rids = (Array.isArray(msg.rids) ? msg.rids : []).filter(r => typeof r === 'string' && isRidShaped(r)).slice(0, 12);
  const first = rids[0] ?? '';
  const tabId = meta.senderTabId ?? (meta.panelWindowId != null
    ? (await chrome.tabs.query({ active: true, windowId: meta.panelWindowId }))[0]?.id
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  if (!rids.length) { respond({ type: 'LOCATE_RESULT', rid: first, found: null, why: 'not-shown' }); return; }
  if (tabId == null) { respond({ type: 'LOCATE_RESULT', rid: first, found: null, why: 'no-page' }); return; }
  const tabs = cleanLocateTabs(msg.tabs, isRidShaped);
  try {
    // The page may switch its tab and wait for the object (about 3 s at most).
    let answer = cleanLocateAnswer(await chrome.tabs.sendMessage(tabId, { type: 'LOCATE_ON_PAGE', rids, ...(tabs.length ? { tabs } : {}) }));
    // Not shown and no tab known from the tree: an enterprise template's
    // widget sits on a tab of the page's layout. Ask the server where, then
    // let the page open that tab.
    const client = ctxOf(meta).client;
    if (!answer.found && !tabs.length && !answer.tab && answer.why === 'not-shown' && client) {
      const read = async (list: string[]) => (await client.readFullObjects(list.filter(isRidShaped).slice(0, 24))).objects;
      const fromLayout = await layoutTabs(read, rids).catch(() => [] as LocateTab[]);
      if (fromLayout.length) answer = cleanLocateAnswer(await chrome.tabs.sendMessage(tabId, { type: 'LOCATE_ON_PAGE', rids, tabs: fromLayout }));
    }
    respond({ type: 'LOCATE_RESULT', rid: first, ...answer });
  } catch {
    // No content script answers: the tab in front is not a BMP page with Companion on it.
    respond({ type: 'LOCATE_RESULT', rid: first, found: null, why: 'no-page' });
  }
});
