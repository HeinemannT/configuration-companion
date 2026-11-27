/**
 * Atlas: a page in its own tab (atlas/atlas.html), opened from the side panel
 * or from an object; its own requests are answered here. Every one is a read
 * (preview runs).
 *
 *  - OPEN_ATLAS: open the page for the sender's server, or bring forward the
 *    tab that is already open for it (as Colors and images does);
 *  - ATLAS_MODEL: which types point at which, with how many objects fill each
 *    reference: a dated copy per server read on the first open and when asked
 *    again (lib/atlas/atlas-cache.ts);
 *  - ATLAS_OBJECT: one object's own name and class;
 *  - ATLAS_ROUTE: the objects along a route between two types;
 *  - ATLAS_OPEN: an object, or the Extended Code window with the code of a
 *    route, on a BMP page of the server.
 */
import { register, type HandlerMeta } from '../handler-registry';
import { closePanelInWindow } from '../companion-tabs';
import { ctxOf, getCtx, type SwContext } from '../sw-context';
import { environmentMatches, environmentMismatchError, environmentToken } from '../environment';
import { openObjectViewWindow } from '../objectview-launcher';
import { openExtendedWindow } from '../editor';
import { errorMessage } from '../logger';
import { sendFireForget } from '../messaging';
import { getContextRid } from '../context-rid';
import { loadAtlasModel } from '../atlas/atlas-cache';
import {
  assembleAtlasModel, buildAtlasCountEc, buildAtlasHeldEc, buildAtlasObjectEc, buildAtlasPropertiesEc, heldRequests,
  ATLAS_ROUTE_ROWS, buildAtlasRouteRowsEc, parseAtlasHeld, parseAtlasHeldCounts, parseAtlasObject, parseAtlasProperties, parseAtlasRouteRows,
  type AtlasHeldCounts,
} from '../atlas/atlas-ec';
import type { AtlasModel, AtlasObjectRef, AtlasStep } from '../atlas/model';
import { progressReporter, type AtlasReadProgress } from '../atlas/progress';

const RID = /^-?\d{1,20}$/;
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** Classes whose objects are read at the same time. */
const HELD_PARALLEL = 3;

type Client = NonNullable<SwContext['client']>;

export interface AtlasTarget { rid?: string; name?: string; objectType?: string }

let launching: Promise<void> | undefined;

/** Open the page for the server of `requester`, or bring its open tab forward and send it to `where`. */
export async function openAtlasPage(where: AtlasTarget, source: Pick<HandlerMeta, 'senderTabId' | 'panelWindowId'> = {}, requester: SwContext = getCtx()): Promise<void> {
  const ctx = requester, environment = environmentToken(ctx);
  if (!ctx.client || !ctx.settings.activeProfileId) throw new Error('Choose a BMP connection in Companion first.');
  // The initiating tab, before a queued launch changes the active one.
  const opener = source.senderTabId != null ? await chrome.tabs.get(source.senderTabId).catch(() => undefined)
    : (await chrome.tabs.query({ active: true, ...(source.panelWindowId != null ? { windowId: source.panelWindowId } : { lastFocusedWindow: true }) }))[0];
  const task = (launching ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (environmentToken(ctx) !== environment) throw new Error('The connection changed. Open Atlas again.');
    const base = chrome.runtime.getURL('atlas/atlas.html') + '?environment=' + encodeURIComponent(environment);
    const hash = new URLSearchParams({ ...(where.rid ? { rid: where.rid } : {}), ...(where.name ? { name: where.name } : {}), ...(where.objectType ? { type: where.objectType } : {}), ...(opener?.id != null ? { tab: String(opener.id) } : {}) }).toString();
    const url = hash ? `${base}#${hash}` : base;
    const existing = (await chrome.tabs.query({})).find(t => (t.url ?? t.pendingUrl)?.split('#')[0] === base);
    const origin = opener?.id != null ? await chrome.tabs.get(opener.id).catch(() => undefined) : undefined;
    if (existing?.id != null) {
      if (where.rid || where.objectType) {
        // A message reaches the open page without reloading it.
        const reply = await chrome.runtime.sendMessage({ type: 'ATLAS_NAVIGATE', tabId: existing.id, environment, ...where }).catch(() => undefined) as { ok?: boolean } | undefined;
        if (!reply?.ok) await chrome.tabs.update(existing.id, { url });
      }
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
      await closePanelInWindow(existing.windowId);
    } else {
      await chrome.tabs.create({ url, ...(origin?.id != null ? { windowId: origin.windowId, index: origin.index + 1, openerTabId: origin.id } : {}) });
    }
  });
  launching = task;
  try { await task; } finally { if (launching === task) launching = undefined; }
}

register('OPEN_ATLAS', async (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  const rid = typeof msg.rid === 'string' && RID.test(msg.rid) ? msg.rid : undefined;
  const objectType = typeof msg.objectType === 'string' && CLASS_NAME.test(msg.objectType) ? msg.objectType : undefined;
  const name = typeof msg.name === 'string' && msg.name.length <= 400 ? msg.name : undefined;
  try {
    // Opened without an object (the side panel): the object selected on the page, when there is one.
    const tabId = rid || objectType ? undefined : meta.senderTabId ?? (await chrome.tabs.query({ active: true, ...(meta.panelWindowId != null ? { windowId: meta.panelWindowId } : { lastFocusedWindow: true }) }))[0]?.id;
    const selected = tabId != null ? getContextRid(tabId) : undefined;
    const where: AtlasTarget = selected && RID.test(selected.rid)
      ? { rid: selected.rid, ...(selected.name ? { name: selected.name } : {}), ...(selected.type && CLASS_NAME.test(selected.type) ? { objectType: selected.type } : {}) }
      : { ...(rid ? { rid } : {}), ...(name ? { name } : {}), ...(objectType ? { objectType } : {}) };
    await openAtlasPage(where, meta, ctx);
  } catch (e) { ctx.toast(errorMessage(e), 'error'); }
});

/**
 * Read the model: the reference properties, then per class what they hold,
 * then the objects of the classes that are only referenced. `onProgress`
 * hears each step, and how many of the step's classes are done.
 */
export async function readAtlasModel(client: Pick<Client, 'executeEc'>, onProgress?: (p: AtlasReadProgress) => void): Promise<AtlasModel> {
  const startedAt = Date.now();
  onProgress?.({ step: 'properties', done: 0, total: 0, startedAt });
  const first = await client.executeEc(buildAtlasPropertiesEc());
  if (!first.ok) throw new Error(first.error || first.log || 'The reference properties could not be read');
  const properties = parseAtlasProperties(first.log ?? '');
  const requests = heldRequests(properties);
  let heldDone = 0;
  onProgress?.({ step: 'held', done: 0, total: requests.length, startedAt });
  const held: Record<string, Record<string, string[]>> = {};
  const unread: string[] = [];
  const counts: Record<string, AtlasHeldCounts> = {};
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < requests.length; i = next++) {
      const { cls, props } = requests[i];
      const seen: Record<string, string[]> = {};
      const count: AtlasHeldCounts = { filled: {} };
      let failed = false;
      for (const script of buildAtlasHeldEc(cls, props)) {
        const r = await client.executeEc(script);
        // A class this server cannot select, or one the user cannot read: its references keep the targets they name.
        if (!r.ok) { failed = true; break; }
        Object.assign(seen, parseAtlasHeld(r.log ?? ''));
        const c = parseAtlasHeldCounts(r.log ?? '');
        count.count = c.count ?? count.count;
        count.seen = c.seen ?? count.seen;
        Object.assign(count.filled, c.filled);
      }
      held[cls] = seen;
      // What was counted before a script of the class failed still stands.
      if (count.count != null) counts[cls] = count;
      if (failed) unread.push(cls);
      onProgress?.({ step: 'held', done: ++heldDone, total: requests.length, startedAt });
    }
  };
  await Promise.all(Array.from({ length: Math.min(HELD_PARALLEL, requests.length) }, worker));
  // The classes that are only referenced have no read of their own: count them, a few at a time.
  const asked = new Set(requests.map(r => r.cls));
  const targets = [...new Set([...properties.flatMap(p => p.types), ...Object.values(held).flatMap(h => Object.values(h).flat())])].filter(c => CLASS_NAME.test(c) && !asked.has(c)).sort();
  let at = 0, counted = 0;
  if (targets.length) onProgress?.({ step: 'counts', done: 0, total: targets.length, startedAt });
  const counter = async () => {
    for (let i = at++; i < targets.length; i = at++) {
      const r = await client.executeEc(buildAtlasCountEc(targets[i]));
      const c = r.ok ? parseAtlasHeldCounts(r.log ?? '') : null;
      if (c?.count != null) counts[targets[i]] = c;
      onProgress?.({ step: 'counts', done: ++counted, total: targets.length, startedAt });
    }
  };
  await Promise.all(Array.from({ length: Math.min(HELD_PARALLEL, targets.length) }, counter));
  return assembleAtlasModel(properties, held, unread, counts);
}

register('ATLAS_MODEL', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const client = ctx.client;
  if (!client) { respond({ type: 'ATLAS_MODEL_DATA', ok: false, environment, error: 'Not connected' }); return; }
  if (msg.environment != null && !environmentMatches(ctx, msg.environment)) { respond({ type: 'ATLAS_MODEL_DATA', ok: false, environment, error: environmentMismatchError(ctx, msg.environment) }); return; }
  try {
    // The open Atlas page of this server hears how far the read is (ATLAS_PROGRESS).
    const report = progressReporter(progress => { sendFireForget({ type: 'ATLAS_PROGRESS', environment, progress }); });
    const loaded = await loadAtlasModel(environment, () => readAtlasModel(client, report), msg.force === true);
    if (environmentToken(ctx) !== environment) { respond({ type: 'ATLAS_MODEL_DATA', ok: false, environment, error: 'The connection changed' }); return; }
    respond({ type: 'ATLAS_MODEL_DATA', ok: true, environment, model: loaded.model, fetchedAt: loaded.fetchedAt, ...(loaded.readMs != null ? { readMs: loaded.readMs } : {}), ...(loaded.error ? { error: loaded.error } : {}) });
  } catch (e) {
    respond({ type: 'ATLAS_MODEL_DATA', ok: false, environment, error: errorMessage(e) });
  }
});

/** One object's own RID, ID, name and class. */
export async function readAtlasObject(client: Pick<Client, 'executeEcOn'>, rid: string): Promise<AtlasObjectRef> {
  const r = await client.executeEcOn(buildAtlasObjectEc(), rid);
  const object = r.ok ? parseAtlasObject(r.log ?? '') : null;
  if (!object) throw new Error(r.error || (r.ok ? '' : r.log) || 'The object could not be read');
  return object;
}

register('ATLAS_OBJECT', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const rid = typeof msg.rid === 'string' && RID.test(msg.rid) ? msg.rid : '';
  const client = ctx.client;
  if (!client || !rid) { respond({ type: 'ATLAS_OBJECT_DATA', ok: false, rid, error: client ? 'Not an object' : 'Not connected' }); return; }
  if (!environmentMatches(ctx, msg.environment)) { respond({ type: 'ATLAS_OBJECT_DATA', ok: false, rid, error: environmentMismatchError(ctx, msg.environment) }); return; }
  try {
    respond({ type: 'ATLAS_OBJECT_DATA', ok: true, rid, object: await readAtlasObject(client, rid) });
  } catch (e) {
    respond({ type: 'ATLAS_OBJECT_DATA', ok: false, rid, error: errorMessage(e) });
  }
});

const PROP_ID = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;

function routeSteps(raw: unknown): AtlasStep[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return null;
  const steps: AtlasStep[] = [];
  for (const s of raw as Array<Partial<AtlasStep>>) {
    if ((s?.dir !== 'out' && s?.dir !== 'in') || typeof s.prop !== 'string' || !PROP_ID.test(s.prop)) return null;
    if (s.alias != null && (typeof s.alias !== 'string' || !PROP_ID.test(s.alias))) return null;
    steps.push({ dir: s.dir, prop: s.prop, ...(s.alias ? { alias: s.alias } : {}) });
  }
  return steps;
}

/** The objects along a route: from the first objects of `cls`, or from one object. */
export async function readAtlasRoute(client: Pick<Client, 'executeEc' | 'executeEcOn'>, classes: readonly string[], steps: readonly AtlasStep[], rid?: string): Promise<AtlasObjectRef[][]> {
  const r = rid ? await client.executeEcOn(buildAtlasRouteRowsEc(null, steps), rid) : await client.executeEc(buildAtlasRouteRowsEc(classes[0], steps));
  if (!r.ok) throw new Error(r.error || r.log || 'The route could not be read');
  return parseAtlasRouteRows(r.log ?? '', steps.length + 1, classes);
}

register('ATLAS_ROUTE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const key = typeof msg.key === 'string' ? msg.key.slice(0, 400) : '';
  const steps = routeSteps(msg.steps);
  const classes = Array.isArray(msg.classes) && steps && msg.classes.length === steps.length + 1 && msg.classes.every(c => typeof c === 'string' && CLASS_NAME.test(c)) ? msg.classes : null;
  const rid = typeof msg.rid === 'string' && RID.test(msg.rid) ? msg.rid : undefined;
  const client = ctx.client;
  if (!client || !steps || !classes) { respond({ type: 'ATLAS_ROUTE_DATA', ok: false, key, error: client ? 'Not a route' : 'Not connected' }); return; }
  if (!environmentMatches(ctx, msg.environment)) { respond({ type: 'ATLAS_ROUTE_DATA', ok: false, key, error: environmentMismatchError(ctx, msg.environment) }); return; }
  try {
    const rows = await readAtlasRoute(client, classes, steps, rid);
    respond({ type: 'ATLAS_ROUTE_DATA', ok: true, key, rows: rows.slice(0, ATLAS_ROUTE_ROWS), total: rows.length });
  } catch (e) {
    respond({ type: 'ATLAS_ROUTE_DATA', ok: false, key, error: errorMessage(e) });
  }
});

/** A tab that shows a page of the server of `environment`: the one Atlas was opened from when it still does, else any. */
/** Is `url` a page of the server at `server`: the same origin, and its path at or under the server's. */
export function isPageOf(server: string, url: string | undefined): boolean {
  try {
    const s = new URL(server), u = new URL(url ?? '');
    if (!/^https?:$/.test(s.protocol) || u.origin !== s.origin) return false;
    const base = s.pathname.replace(/\/+$/, '');
    return u.pathname === base || u.pathname.startsWith(`${base}/`);
  } catch { return false; }
}

async function bmpTabOf(environment: string, preferred?: number): Promise<chrome.tabs.Tab | undefined> {
  const server = environment.slice(environment.indexOf('@') + 1);
  const on = (t: chrome.tabs.Tab | undefined) => isPageOf(server, t?.url);
  const first = preferred != null ? await chrome.tabs.get(preferred).catch(() => undefined) : undefined;
  if (on(first)) return first;
  return (await chrome.tabs.query({})).find(on);
}

register('ATLAS_OPEN', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const fail = (error: string) => { respond({ type: 'ATLAS_OPEN_RESULT', ok: false, error }); };
  if (!environmentMatches(ctx, msg.environment)) { fail(environmentMismatchError(ctx, msg.environment)); return; }
  const rid = typeof msg.rid === 'string' && RID.test(msg.rid) ? msg.rid : undefined;
  const code = typeof msg.code === 'string' && msg.code.length <= 8_000 ? msg.code : undefined;
  if (!rid && code == null) { fail('Nothing to open'); return; }
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 400 ? v : undefined);
  try {
    const tab = await bmpTabOf(environmentToken(ctx), typeof msg.tab === 'number' ? msg.tab : undefined);
    if (tab?.id == null) { fail('No page of this server is open in the browser. Open one, then try again.'); return; }
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    const disposition = code != null
      ? await openExtendedWindow(rid, { tabId: tab.id }, code, ctx)
      : await openObjectViewWindow(rid!, { tabId: tab.id }, { name: str(msg.name), type: str(msg.objectType), businessId: str(msg.businessId) }, ctx);
    if (disposition === 'failed') { fail('The window could not be opened on that page.'); return; }
    respond({ type: 'ATLAS_OPEN_RESULT', ok: true });
  } catch (e) { fail(errorMessage(e)); }
});
