/**
 * Code search: the window launcher, the code index (status, sync, cancel),
 * scope and target resolution, and the server-scan fallback. Read-only.
 */

import { register } from '../handler-registry';
import { boundContexts, ctxOf, type SwContext } from '../sw-context';
import { errorMessage } from '../logger';
import { errorKindOf } from '../error-kind';
import { ENVIRONMENT_CHANGED_ERROR, environmentToken } from '../environment';
import { buildRowEc, identityRow, parseDelimitedRow } from '../ec-row-codec';
import { openCodeSearchWindow } from '../codesearch-launcher';
import { resolveFrameTargetTabId } from '../frame-launcher';
import { reportFrameOpenFailure } from '../frame-open-failure';
import { cancelIndexSync, clearCodeIndex, currentEnvironment, estimateServerCopy, indexStatus, removeCodeCopy, searchEnvironment, serverRoots, serverScanSource, startIndexSync } from '../code-index-service';
import { KNOWN_CODE_PROPS } from '../code-index-sync';
import { buildCodeScopeEcs, parseCodeScopeLog, type CodeScope } from '../code-search-scope';
import { CONTEXT_OBJECT, createEcFrame, mergeFramedLogs } from '../ec-parser';
import { codeIndexStore } from '../code-index-store';
import { runCodeSearch, type CodeSearchRequest } from '../code-search';
import type { CodeSearchObject } from '../messages';
import type { BmpClient } from '../bmp-client';
import { scriptSentence } from '../load-governor';
import { scopeFor } from '../profile-scope';
import { scriptOn } from '../script-kinds';
import { LISTING_REUSE_MS } from '../code-scope-read';

const str = (v: unknown, max = 400) => (typeof v === 'string' && v.length <= max ? v : undefined);
const RID = /^-?\d{1,20}$/;

function object(v: unknown): CodeSearchObject | undefined {
  const o = v as Partial<CodeSearchObject> | undefined;
  if (!o || typeof o.rid !== 'string' || !RID.test(o.rid)) return undefined;
  return { rid: o.rid, ...(str(o.name) ? { name: o.name } : {}), ...(str(o.type) ? { type: o.type } : {}), ...(str(o.businessId) ? { businessId: o.businessId } : {}) };
}

register('OPEN_CODE_SEARCH', async (msg, _respond, meta) => {
  const query = typeof msg.query === 'string' ? msg.query.trim().slice(0, 400) : '';
  const target = { tabId: meta.senderTabId, windowId: meta.panelWindowId };
  const disposition = await openCodeSearchWindow(target, {
    type: 'codesearch',
    ...(query ? { query } : {}),
    ...(typeof msg.replace === 'string' && msg.mode === 'replace' ? { replace: msg.replace.slice(0, 400) } : {}),
    ...(msg.mode === 'refs' || msg.mode === 'text' || msg.mode === 'replace' ? { mode: msg.mode } : {}),
    ...(object(msg.scope) ? { scope: object(msg.scope) } : {}),
    ...(object(msg.target) ? { target: object(msg.target) } : {}),
    ...(object(msg.context) ? { context: object(msg.context) } : {}),
    ...(msg.restore === true ? { restore: true } : {}),
  });
  // Nothing opened (no BMP page in the panel's window): the panel says why.
  if (disposition === 'failed') await reportFrameOpenFailure(ctxOf(meta), meta.panelWindowId, await resolveFrameTargetTabId(target));
});

// ── index ─────────────────────────────────────────────────────────

register('CODE_INDEX_GET_STATUS', async (_msg, respond, meta) => {
  const env = currentEnvironment(ctxOf(meta));
  if (!env) { respond({ type: 'CODE_INDEX_STATUS', status: { environment: '', state: 'none', syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 0, version: 0, error: 'Not connected' } }); return; }
  respond({ type: 'CODE_INDEX_STATUS', status: await indexStatus(env, ctxOf(meta)) });
});

register('CODE_INDEX_SYNC', async (msg, respond, meta) => {
  // `user`: the user pressed Make copy, Refresh or Resume. Without it
  // nothing is started; the answer is the status.
  const roots = Array.isArray(msg.roots) ? msg.roots.filter((r): r is string => typeof r === 'string' && /^[a-z][A-Za-z0-9]{0,40}$/.test(r)) : undefined;
  // The index of the window's own server (the page it is mounted in).
  const env = await startIndexSync(msg.force === true, msg.force === true || msg.user === true, roots, ctxOf(meta));
  if (!env) { respond({ type: 'CODE_INDEX_STATUS', status: { environment: '', state: 'none', syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 0, version: 0, error: 'Not connected' } }); return; }
  respond({ type: 'CODE_INDEX_STATUS', status: await indexStatus(env, ctxOf(meta)) });
});

/** "Server was restarted" (a Log entry of the script pause, extension
 *  pages only): the script count of that profile's server only starts
 *  again. Sends nothing. The answer is the status of that server's copy,
 *  without the note now; open code search windows get it too
 *  (code-index-service rememberGovernor). */
register('RESET_SCRIPT_COUNT', async (msg, respond) => {
  const ctx = typeof msg.profileId === 'string' ? scopeFor(msg.profileId)?.ctx ?? null : null;
  await ctx?.client?.governor.resetScriptCount();
  const env = ctx ? currentEnvironment(ctx) : null;
  if (env) respond({ type: 'CODE_INDEX_STATUS', status: await indexStatus(env, ctx!) });
});

/** Stop copying. With `environment` (Atlas), the copy of that server only:
 *  the context whose server it is now; none, nothing stops. Without it, the
 *  copy of the window's own server. */
register('CODE_INDEX_CANCEL', (msg, _respond, meta) => {
  const own = ctxOf(meta);
  if (typeof msg.environment !== 'string') { cancelIndexSync(own); return; }
  const ctx = [own, ...boundContexts()].find(c => currentEnvironment(c) === msg.environment);
  if (ctx) cancelIndexSync(ctx);
});

/** Diagnostics hook: the load governor of the current server (state,
 *  counters, the last posts). No extension page sends it; the live test rig
 *  reads the governor's counters through it. Sends nothing to the server. */
register('GET_SERVER_LOAD', (_msg, respond, meta) => {
  const g = ctxOf(meta).client?.governor;
  const load = g?.scriptLoad();
  // New texts per kind (script-kinds.ts): constant ones are few and kept;
  // varying ones carry a question and stay small.
  const kinds = load ? (['constant', 'varying', 'user'] as const).map(k => `${k} ${load.byKind[k].distinct} (${load.byKind[k].distinctChars} characters)`).join(', ') : '';
  respond(g && load
    ? { type: 'SERVER_LOAD_DATA', ok: true, state: g.state(), counters: { ...g.counters }, fullReadsPerPost: g.fullReadsPerPost, recent: g.recentPosts.slice(-200), scripts: load, scriptSentence: `${scriptSentence(load)} Since ${new Date(load.since).toISOString()}: ${load.distinct} new scripts (${load.distinctChars} characters): ${kinds}; about ${load.bytesPerChar} bytes of server memory per character.` }
    : { type: 'SERVER_LOAD_DATA', ok: false, counters: null, recent: [] });
});

/** "Remove index": the local copy of this profile's server is deleted and
 *  nothing is built again until the user asks. */
register('CODE_INDEX_REMOVE', async (msg, respond, meta) => {
  const env = currentEnvironment(ctxOf(meta));
  // A named copy (the window lists the copies of its server for other
  // profiles): only that one goes, and only when it is of the window's own
  // server; otherwise nothing is removed. Without a name the window's own
  // copy goes. Without a server of its own the window removes nothing.
  if (typeof msg.environment === 'string') {
    const named = msg.environment;
    if (!env || named.slice(named.indexOf('@') + 1) !== env.slice(env.indexOf('@') + 1)) throw new Error('That copy is not of this server. Nothing was removed.');
    if (named === env) await clearCodeIndex(env.slice(0, env.indexOf('@')));
    else await removeCodeCopy(named);
  } else if (env) await clearCodeIndex(env.slice(0, env.indexOf('@')));
  respond(env ? { type: 'CODE_INDEX_STATUS', status: await indexStatus(env, ctxOf(meta)) } : { type: 'CODE_INDEX_STATUS', status: { environment: '', state: 'none', syncedAt: null, builtAt: null, objects: 0, bytes: 0, pending: 0, version: 0 } });
});

/** The roots of the server with their names and the organisations: one
 *  small request per environment (the Where menu without an index). */
register('CODE_SEARCH_ROOTS', async (_msg, respond, meta) => {
  try {
    const r = await serverRoots(ctxOf(meta));
    respond(r ? { type: 'CODE_SEARCH_ROOTS_RESULT', ok: true, ...r } : { type: 'CODE_SEARCH_ROOTS_RESULT', ok: false, roots: [], orgs: {}, error: 'Not connected' });
  } catch (e) {
    respond({ type: 'CODE_SEARCH_ROOTS_RESULT', ok: false, roots: [], orgs: {}, error: errorMessage(e) });
  }
});

/** What a local copy would cost this server, sent only when the user opens
 *  "Keep a copy on this computer": the code search's listing (kept for the
 *  build, which then does not list again while it is current) and its read
 *  plan (code-copy estimateCopy). */
register('CODE_INDEX_ESTIMATE', async (_msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'CODE_INDEX_ESTIMATE_RESULT', ok: false, error: 'Not connected' }); return; }
  try {
    const e = await estimateServerCopy(ctx);
    if (!e) { respond({ type: 'CODE_INDEX_ESTIMATE_RESULT', ok: false, error: 'Not connected' }); return; }
    respond({
      type: 'CODE_INDEX_ESTIMATE_RESULT', ok: true,
      estimate: { objects: e.objects, chars: e.chars, posts: e.posts, commands: e.commands, seconds: e.seconds, ...(e.perSource ? { perSource: true } : {}), ...(e.failedSources.length ? { failedSources: e.failedSources } : {}) },
    });
  } catch (e) {
    respond({ type: 'CODE_INDEX_ESTIMATE_RESULT', ok: false, error: errorMessage(e) });
  }
});

// ── scope and target ──────────────────────────────────────────────

const PIPE3 = '|||';
const IDENTITY_FIELDS = ['rid', 'id', 'name', 'className'];

/** EC that resolves `ref` to an identity row. */
export function buildIdentityEc(ref: string): string {
  return scriptOn('buildIdentityEc', ref, [`_o := ${ref}`, buildRowEc(identityRow('_o', { ridDefault: '"MISSING"' }), PIPE3)].join('\n'));
}

export function parseIdentityLog(log: string): CodeSearchObject | null {
  const line = log.split('\n').map(l => l.trim()).find(l => l.includes(PIPE3));
  if (!line) return null;
  const row = parseDelimitedRow(line, IDENTITY_FIELDS, PIPE3);
  if (!row || !row.rid || !RID.test(row.rid)) return null;
  return { rid: row.rid, businessId: row.id || '', name: row.name || '', type: row.className || '' };
}

/** A typed RID or `ns.id` to an EC reference; null for anything else (the
 *  shape is checked before it reaches EC). */
async function refOf(_client: BmpClient, text: string): Promise<{ rid: string } | string | null> {
  const t = text.trim();
  // A RID travels as the command's context: one constant script.
  if (RID.test(t)) return { rid: t };
  if (/^[a-z]+\.[A-Za-z0-9_-]+$/.test(t)) return t;
  return null;
}

async function identity(client: BmpClient, ref: { rid: string } | string): Promise<CodeSearchObject | null> {
  const r = typeof ref === 'string' ? await client.executeEc(buildIdentityEc(ref)) : await client.executeEcOn(buildIdentityEc(CONTEXT_OBJECT), ref.rid);
  if (!r.ok) throw new Error(r.error || r.log || 'The object could not be read');
  return parseIdentityLog(r.log ?? '');
}

register('CODE_SEARCH_RESOLVE', async (msg, respond, meta) => {
  const client = ctxOf(meta).client;
  if (!client) { respond({ type: 'CODE_SEARCH_RESOLVE_RESULT', ok: false, error: 'Not connected' }); return; }
  try {
    const ref = await refOf(client, String(msg.text ?? ''));
    if (!ref) { respond({ type: 'CODE_SEARCH_RESOLVE_RESULT', ok: false, error: 'Type a RID or an ID with its ID space, for example t.assessment_basis_values.' }); return; }
    const o = await identity(client, ref);
    respond(o ? { type: 'CODE_SEARCH_RESOLVE_RESULT', ok: true, object: o } : { type: 'CODE_SEARCH_RESOLVE_RESULT', ok: false, error: `No object ${String(msg.text).trim()} on this server.` });
  } catch (e) {
    respond({ type: 'CODE_SEARCH_RESOLVE_RESULT', ok: false, error: errorMessage(e) });
  }
});

/** Scopes listed lately, by environment and RID: the live scan that follows
 *  CODE_SEARCH_SCOPE uses the same list instead of listing again. */
const scopeCache = new Map<string, { at: number; object: CodeSearchObject; scope: CodeScope }>();
const SCOPE_CACHE_MS = 5 * 60_000;

/** "Under an object": the object, its tree and the references its type
 *  follows in the object window (code-search-scope), objects with code only.
 *  One identity post and one listing post; no full object reads. A listing
 *  younger than `maxAgeMs` is used again (0: list now); `reused` says so. */
async function listScope(client: BmpClient, rid: string, maxAgeMs: number, ctx: SwContext): Promise<{ at: number; object: CodeSearchObject; scope: CodeScope; reused?: boolean } | null> {
  const env = currentEnvironment(ctx) ?? '';
  // Per client instance: another user's scope is not used again.
  const key = `${searchEnvironment(ctx) ?? env}|${rid}`;
  const hit = scopeCache.get(key);
  if (hit && Date.now() - hit.at < Math.min(maxAgeMs, SCOPE_CACHE_MS)) return { ...hit, reused: true };
  const object = await identity(client, { rid });
  if (!object) return null;
  const meta = env ? await codeIndexStore().getMeta(env).catch(() => null) : null;
  const map = meta?.codeProps ?? KNOWN_CODE_PROPS;
  const frame = createEcFrame();
  // One constant script per root type and code map: the root is the context.
  // Small constant scripts (one per group of code types), the root as the
  // context of each, in one post.
  const parts = await client.executeEcScriptsOn(buildCodeScopeEcs(CONTEXT_OBJECT, object.type ?? '', frame, map), rid, AbortSignal.timeout(60_000), 60_000);
  const bad = parts.find(r => !r.ok || r.log == null);
  if (bad) throw new Error(bad.error || bad.log || 'The scope could not be listed');
  const scope = parseCodeScopeLog(mergeFramedLogs(parts.map(r => r.log!), frame), frame, object.type ?? '');
  // The scope object first, as one script listed it.
  const self = scope.items.findIndex(it => it.rid === rid);
  if (self > 0) scope.items.unshift(...scope.items.splice(self, 1));
  for (const [k, v] of scopeCache) if (Date.now() - v.at >= SCOPE_CACHE_MS) scopeCache.delete(k);
  const entry = { at: Date.now(), object, scope };
  scopeCache.set(key, entry);
  return entry;
}

register('CODE_SEARCH_SCOPE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const client = ctx.client;
  if (!client) { respond({ type: 'CODE_SEARCH_SCOPE_RESULT', ok: false, error: 'Not connected', errorKind: 'not-signed-in' }); return; }
  if (msg.environment && msg.environment !== environmentToken(ctx)) { respond({ type: 'CODE_SEARCH_SCOPE_RESULT', ok: false, error: ENVIRONMENT_CHANGED_ERROR }); return; }
  try {
    if (!RID.test(msg.rid)) throw new Error('Not a RID');
    // Choosing the scope lists it again; the scan that follows reuses it.
    const listed = await listScope(client, msg.rid, 0, ctx);
    if (!listed) { respond({ type: 'CODE_SEARCH_SCOPE_RESULT', ok: false, error: 'The object of this scope no longer exists.' }); return; }
    respond({ type: 'CODE_SEARCH_SCOPE_RESULT', ok: true, object: listed.object, rids: listed.scope.items.map(i => i.rid), covered: listed.scope.covered });
  } catch (e) {
    const errorKind = errorKindOf(e);
    respond({ type: 'CODE_SEARCH_SCOPE_RESULT', ok: false, error: errorMessage(e), ...(errorKind ? { errorKind } : {}) });
  }
});

// ── server scan (fallback) ────────────────────────────────────────

/** The running live scan per code search window (server profile, tab and the
 *  window's own id): a search started in one window never stops another
 *  window's, and a second search in the same window replaces the first. Every
 *  search ends with a CODE_SEARCH_DONE, a stopped or replaced one with
 *  `cancelled`. */
interface ActiveSearch { id: string; windowId: string; controller: AbortController }
const activeByWindow = new Map<string, ActiveSearch>();

const windowKeyOf = (ctx: SwContext, tabId: number | undefined, windowId: unknown): string =>
  `${ctx.profileId ?? ''}|${tabId ?? ''}|${typeof windowId === 'string' ? windowId.slice(0, 80) : ''}`;

type DoneBody = { outcome?: import('../code-search').CodeSearchOutcome; error?: string; errorKind?: import('../error-kind').BmpErrorKind; cancelled?: 'superseded' | 'stopped' };
const sendDone = (id: string, m: DoneBody): void => {
  chrome.runtime.sendMessage({ type: 'CODE_SEARCH_DONE', id, ...m }).catch(() => { /* window closed */ });
};

register('CODE_SEARCH_START', async (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  const id = String(msg.id ?? '');
  const windowId = typeof msg.windowId === 'string' ? msg.windowId.slice(0, 80) : '';
  const key = windowKeyOf(ctx, meta.senderTabId, windowId);
  const previous = activeByWindow.get(key);
  if (previous) {
    previous.controller.abort();
    sendDone(previous.id, { cancelled: 'superseded' });
  }
  const controller = new AbortController();
  activeByWindow.set(key, { id, windowId, controller });
  const client = ctx.client;
  const done = (m: DoneBody) => {
    if (activeByWindow.get(key)?.id === id) activeByWindow.delete(key);
    sendDone(id, m);
  };
  if (!client) { done({ error: 'Not connected', errorKind: 'not-signed-in' }); return; }
  const w = msg.search;
  const types = Array.isArray(w?.types) ? w.types.filter((t): t is string => typeof t === 'string') : undefined;
  const props = Array.isArray(w?.props) ? w.props.filter((p): p is string => typeof p === 'string') : undefined;
  const target = w?.target && RID.test(w.target.rid) ? { rid: w.target.rid, businessId: str(w.target.businessId) ?? '' } : undefined;
  const req: CodeSearchRequest = {
    mode: w?.mode === 'refs' ? 'refs' : 'text',
    text: str(w?.text, 2000) ?? '',
    ...(target ? { target } : {}),
    caseSensitive: w?.caseSensitive !== false,
    wholeWord: w?.wholeWord === true,
    regex: w?.regex === true,
    ...(types ? { types } : {}),
    ...(props?.length ? { props } : {}),
    offset: Number.isSafeInteger(w?.offset) ? w.offset : 0,
    limit: Number.isSafeInteger(w?.limit) ? w.limit : undefined,
    ...(w?.sort === 'matches' || w?.sort === 'name' || w?.sort === 'location' || w?.sort === 'stored' ? { sort: w.sort } : {}),
    // Instances fold in the live scan too (seen live: the field was dropped).
    ...(w?.fold === true ? { fold: true } : {}),
  };
  try {
    // The listing carries each object's stamp, so code changed since the
    // last search is read again. A typed search uses a listing of the same
    // place made in the last LISTING_REUSE_MS; "Search again" (`fresh`)
    // always lists again.
    const fresh = msg.fresh === true;
    const scoped = msg.scopeRid && RID.test(msg.scopeRid) ? await listScope(client, msg.scopeRid, fresh ? 0 : LISTING_REUSE_MS, ctx) : undefined;
    if (scoped === null) throw new Error('The object of this scope no longer exists.');
    const where = Array.isArray(w?.where) ? w.where.filter((k): k is string => typeof k === 'string' && /^(root:[a-z][A-Za-z0-9]{0,40}|org:-?\d{1,20})$/.test(k)) : undefined;
    const source = await serverScanSource(scoped ? { items: scoped.scope.items, at: scoped.at, ...(scoped.reused ? { reused: true } : {}), ...(scoped.scope.now ? { now: scoped.scope.now } : {}) } : undefined, where, ctx, fresh);
    if (!source) throw new Error('Not connected');
    const outcome = await runCodeSearch(req, source, hits => {
      if (!controller.signal.aborted) chrome.runtime.sendMessage({ type: 'CODE_SEARCH_HITS', id, hits }).catch(() => { /* window closed */ });
    }, {
      signal: controller.signal,
      // The window has no copy of the code: hits carry the lines around each match.
      context: true,
      // First results per read and the progress, while the scan runs.
      onPartial: (hits, progress) => {
        if (!controller.signal.aborted) chrome.runtime.sendMessage({ type: 'CODE_SEARCH_PROGRESS', id, hits, progress }).catch(() => { /* window closed */ });
      },
    });
    if (!controller.signal.aborted) done({ outcome });
  } catch (e) {
    if (controller.signal.aborted) return;
    const errorKind = errorKindOf(e);
    done({ error: errorMessage(e), ...(errorKind ? { errorKind } : {}) });
  }
});

/** The full text of one property of a result, read when the user widens its
 *  context beyond the lines the hit carries. One small read; the code is read
 *  as stored text (output(), ec-code-safety), never run. */
register('CODE_SEARCH_CODE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const client = ctx.client;
  if (!client) { respond({ type: 'CODE_SEARCH_CODE_RESULT', ok: false, error: 'Not connected' }); return; }
  if (msg.environment && msg.environment !== environmentToken(ctx)) { respond({ type: 'CODE_SEARCH_CODE_RESULT', ok: false, error: ENVIRONMENT_CHANGED_ERROR }); return; }
  if (!RID.test(String(msg.rid)) || !/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(String(msg.prop))) { respond({ type: 'CODE_SEARCH_CODE_RESULT', ok: false, error: 'Not a property of an object' }); return; }
  try {
    const code = await client.fetchCodeViaEc(msg.rid, [msg.prop]);
    respond({ type: 'CODE_SEARCH_CODE_RESULT', ok: true, code: code[msg.prop] ?? '' });
  } catch (e) {
    respond({ type: 'CODE_SEARCH_CODE_RESULT', ok: false, error: errorMessage(e) });
  }
});

register('CODE_SEARCH_STOP', (msg, _respond, meta) => {
  const key = windowKeyOf(ctxOf(meta), meta.senderTabId, msg.windowId);
  const active = activeByWindow.get(key);
  if (!active || (msg.id && msg.id !== active.id)) return;
  active.controller.abort();
  activeByWindow.delete(key);
  sendDone(active.id, { cancelled: 'stopped' });
});

/** The window's watchdog: does the worker still know this search? */
register('CODE_SEARCH_STATUS', (msg, respond, meta) => {
  const active = activeByWindow.get(windowKeyOf(ctxOf(meta), meta.senderTabId, msg.windowId));
  respond({ type: 'CODE_SEARCH_STATUS_RESULT', id: msg.id, running: !!active && active.id === msg.id });
});
