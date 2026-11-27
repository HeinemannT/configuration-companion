/**
 * Atlas (atlas/atlas.html): the types of one server, their references and
 * the ways between them, on a page of its own in a browser tab. Like Colors
 * and images it names its server in its URL and every request it sends goes
 * to that server; one tab is kept per server (handlers/atlas.ts).
 *
 * Everything is read-only. The types are a dated copy per server, read on the
 * first open and on Refresh. Where a property is used comes from the local
 * code copy, when there is one; the objects along a way are read when the way
 * is picked.
 */
import { sendFireForget, sendRequestBounded, setRouteHint } from '../lib/messaging';
import { createCopyProgress } from '../lib/copy-progress';
import { copyWithFeedback } from '../lib/copy-feedback';
import { ICON_SPRITE } from '../lib/icon-sprite';
import { markSvg, setMarkMood } from '../lib/companion-mark';
import { codeIndexStore } from '../lib/code-index-store';
import type { CodeIndexStatus, InspectorMessage } from '../lib/types';
import { findRoutes, findTypes, routeKey, typeName } from '../lib/atlas/model';
import { noUsage, readUsage, usageCounts } from '../lib/atlas/usage';
import type { AtlasReadProgress } from '../lib/atlas/progress';
import { mountAtlasView, pickedRoute, type AtlasMatch, type AtlasState } from './atlas-view';
import { latestRun } from './latest-run';

const MODEL_TIMEOUT_MS = 180_000;
const READ_TIMEOUT_MS = 45_000;
const COPY_POLL_MS = 2_000;

const url = new URL(location.href);
const environment = url.searchParams.get('environment') ?? '';
// Every request of this page goes to the server it was opened for.
if (environment.includes('@')) setRouteHint({ profileId: environment.slice(0, environment.indexOf('@')) });
const serverUrl = environment.slice(environment.indexOf('@') + 1);
/** The BMP tab Atlas was opened from: where objects and code are opened. */
let openerTab: number | undefined;

const state: AtlasState = {
  view: 'all', server: serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''), model: null, fetchedAt: null, readMs: null, reading: false, readSince: null, progress: null, error: null, notice: null,
  cell: null, focus: null, prop: null,
  route: { from: null, to: null, routes: [], key: null, scope: 'all', tab: 'rows', rows: null, rowsFor: null, total: 0, loading: false, since: null, error: null, start: 'this.object' },
  home: null, usage: null, query: '', matches: [],
};
let waiting = 0;
let rowsRequest = 0;
let copyTimer: ReturnType<typeof setTimeout> | null = null;

const host = document.getElementById('atlas-root')!;
const sprite = document.createElement('div');
sprite.innerHTML = ICON_SPRITE;
document.body.prepend(sprite.firstElementChild!);

async function work<T>(task: Promise<T>): Promise<T> {
  waiting += 1;
  setMarkMood(view.mark, true);
  try { return await task; } finally {
    waiting -= 1;
    if (waiting === 0) setMarkMood(view.mark, false);
  }
}

/** The progress of a code copy made from here (shared with the code search window). */
const copyProgress = createCopyProgress({ onStop: () => sendFireForget({ type: 'CODE_INDEX_CANCEL', environment }) });

const view = mountAtlasView(host, {
  setView(v) { state.view = v; closeFind(); if (v === 'route') void readRows(); render(); },
  search(text) {
    state.query = text;
    state.matches = state.model && text.trim() ? matchesOf(text) : [];
    render();
  },
  pickType(cls) { showType(cls, null); },
  pickProp(cls, prop) { showType(cls, prop); },
  pickCell(from, to) { state.cell = state.cell?.from === from && state.cell.to === to ? null : { from, to }; render(); },
  routeBetween(from, to) { state.view = 'route'; closeFind(); setRoute(from, to); render(); },
  swapRoute() { setRoute(state.route.to, state.route.from); render(); },
  pickRoute(key) { state.route.key = key; state.route.rows = null; render(); void readRows(); },
  setScope(scope) { state.route.scope = scope; state.route.rows = null; render(); void readRows(); },
  setTab(tab) { state.route.tab = tab; render(); },
  setStart(start) { state.route.start = start; render(); },
  refresh() { void readModel(true); },
  makeCopy() { void makeCopy(); },
  dismissNotice() { state.notice = null; render(); },
  copy(code, target) { void copyWithFeedback(code, target, { textTarget: target.querySelector<HTMLElement>('.at-copy-t') ?? undefined }); },
  openCode(code, rid) { void open({ code, ...(rid ? { rid } : {}) }); },
  openObject(o) { void open({ rid: o.rid, ...(o.name ? { name: o.name } : {}), ...(o.cls ? { objectType: o.cls } : {}), ...(o.id ? { businessId: o.id } : {}) }); },
}, copyProgress.el);
view.mark.innerHTML = markSvg();

function render(): void { view.render(state); }
function closeFind(): void { state.query = ''; state.matches = []; }

function matchesOf(text: string): AtlasMatch[] {
  const model = state.model!;
  const types: AtlasMatch[] = findTypes(model, text, 8).map(t => ({ kind: 'type', cls: t.cls, name: t.name }));
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const props: AtlasMatch[] = model.edges
    .filter(e => { const hay = `${e.prop} ${e.label}`.toLowerCase(); return words.every(w => hay.includes(w)); })
    .slice(0, 8).map(e => ({ kind: 'prop', cls: e.from, prop: e.prop, name: typeName(model, e.from) }));
  return [...types, ...props];
}

function showType(cls: string, prop: string | null): void {
  state.view = 'type';
  state.focus = cls;
  state.prop = prop;
  closeFind();
  render();
}

/** The two ends of the route changed: its ways are found and ranked again. */
function setRoute(from: string | null, to: string | null): void {
  const r = state.route;
  r.from = from;
  r.to = to;
  r.key = null;
  r.rows = null;
  r.error = null;
  if (r.scope === 'one' && state.home?.cls !== from) r.scope = 'all';
  rank();
  void readRows();
}

function rank(): void {
  const r = state.route;
  r.routes = state.model && r.from && r.to ? findRoutes(state.model, r.from, r.to, usageCounts(state.usage)) : [];
  if (r.key && !r.routes.some(x => routeKey(x) === r.key)) r.key = null;
  // Rows read for another route (the order changed with a new read) are not this route's.
  if (r.rows && r.rowsFor !== rowsKey()) r.rows = null;
}

/** What the rows on screen were read for: the scope and the picked route. */
function rowsKey(): string | null {
  const chosen = pickedRoute(state.route);
  return chosen ? `${state.route.scope}|${routeKey(chosen)}` : null;
}

async function request<R extends InspectorMessage>(msg: InspectorMessage, timeoutMs: number): Promise<R> {
  return work(sendRequestBounded<R>(msg, { timeoutMs }));
}

async function readModel(force: boolean): Promise<void> {
  if (state.reading) return;
  state.reading = true;
  state.readSince = Date.now();
  state.progress = null;
  render();
  try {
    const r = await request({ type: 'ATLAS_MODEL', environment, ...(force ? { force: true } : {}) }, MODEL_TIMEOUT_MS);
    if (r.type !== 'ATLAS_MODEL_DATA') throw new Error(r.type === 'REQUEST_FAILED' ? r.error : 'Unexpected answer from the extension.');
    if (r.environment !== environment) throw new Error('Another connection is active. Open Atlas again.');
    if (r.ok && r.model) {
      state.model = r.model;
      state.fetchedAt = r.fetchedAt ?? null;
      state.readMs = r.readMs ?? null;
      state.error = r.error ?? null;
    } else state.error = r.error ?? 'The types could not be read';
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
  state.reading = false;
  state.progress = null;
  state.readSince = null;
  rank();
  render();
  if (state.model && (!state.usage || force)) void loadUsage();
  if (state.view === 'route') void readRows();
}

/** The objects along the picked way. */
async function readRows(): Promise<void> {
  const r = state.route;
  const chosen = pickedRoute(r);
  const key = rowsKey();
  if (!chosen || !key || !r.from || state.view !== 'route') return;
  if (r.rows && r.rowsFor === key) return;
  const mine = ++rowsRequest;
  r.rows = null;
  r.loading = true;
  r.since = Date.now();
  r.error = null;
  render();
  try {
    const one = r.scope === 'one' && state.home?.cls === r.from ? state.home.rid : undefined;
    const res = await request({ type: 'ATLAS_ROUTE', key, environment, classes: chosen.classes, steps: chosen.steps, ...(one ? { rid: one } : {}) }, READ_TIMEOUT_MS);
    if (mine !== rowsRequest) return;
    if (res.type === 'ATLAS_ROUTE_DATA' && res.ok) { r.rows = res.rows ?? []; r.rowsFor = key; r.total = res.total ?? r.rows.length; }
    else r.error = res.type === 'ATLAS_ROUTE_DATA' ? (res.error ?? 'The objects could not be read') : res.type === 'REQUEST_FAILED' ? res.error : 'Unexpected answer from the extension.';
  } catch (e) {
    if (mine !== rowsRequest) return;
    r.error = e instanceof Error ? e.message : String(e);
  }
  r.loading = false;
  render();
}

async function copyStatus(): Promise<CodeIndexStatus | null> {
  try {
    const r = await sendRequestBounded({ type: 'CODE_INDEX_GET_STATUS' }, { timeoutMs: 5_000 });
    return r.type === 'CODE_INDEX_STATUS' && r.status.environment === environment ? r.status : null;
  } catch { return null; }
}

/** Where the references are used, from the local code copy; while one is
 *  being made, look again. One scan at a time; a scan asked for meanwhile
 *  runs after it, and the older one's result is dropped. */
const usageRun = latestRun(scanUsage);
function loadUsage(): Promise<void> { return usageRun.request(); }

async function scanUsage(stale: () => boolean): Promise<void> {
  if (!state.model) return;
  if (copyTimer) { clearTimeout(copyTimer); copyTimer = null; }
  const st = await copyStatus();
  if (stale() || !state.model) return;
  copyProgress.update(st);
  if (st && (st.state === 'ready' || st.state === 'refreshing')) {
    // A copy read before stays on screen while it is read again.
    if (state.usage?.state !== 'ready') { state.usage = { state: 'loading', read: 0, toRead: st.objects, since: Date.now() }; render(); }
    const onBatch = (read: number) => { if (!stale() && state.usage?.state === 'loading') { state.usage.read = read; view.live(state); } };
    let next: NonNullable<AtlasState['usage']>;
    try { next = await work(readUsage(codeIndexStore(), st, state.model.edges.map(e => e.prop), onBatch)); }
    catch (e) { next = { state: 'none', reason: e instanceof Error ? e.message : String(e), canMake: false }; }
    if (stale()) return;
    state.usage = next;
  } else {
    state.usage = noUsage(st);
    if (st?.state === 'building') copyTimer = setTimeout(() => { void loadUsage(); }, COPY_POLL_MS);
  }
  // The ranking takes the usage into account.
  const before = pickedRoute(state.route);
  rank();
  if (before && !state.route.key) state.route.key = routeKey(before);
  render();
}

async function makeCopy(): Promise<void> {
  // A scan under way would put its older answer over this one.
  usageRun.drop();
  state.usage = { state: 'none', reason: 'Making the code copy', canMake: false, making: { read: 0, toRead: 0 } };
  render();
  try {
    const r = await sendRequestBounded({ type: 'CODE_INDEX_SYNC', user: true }, { timeoutMs: 10_000 });
    if (r.type === 'CODE_INDEX_STATUS') copyProgress.update(r.status);
    if (r.type === 'CODE_INDEX_STATUS' && r.status.state !== 'building' && r.status.state !== 'refreshing') {
      state.usage = noUsage(r.status);
      render();
      return;
    }
  } catch (e) {
    state.usage = { state: 'none', reason: e instanceof Error ? e.message : String(e), canMake: true };
    render();
    return;
  }
  copyTimer = setTimeout(() => { void loadUsage(); }, COPY_POLL_MS);
}

/** Open an object, or the Extended Code window, on a BMP page of this server. */
async function open(what: { rid?: string; name?: string; objectType?: string; businessId?: string; code?: string }): Promise<void> {
  let error: string | null = null;
  try {
    const r = await request({ type: 'ATLAS_OPEN', environment, ...(openerTab != null ? { tab: openerTab } : {}), ...what }, 20_000);
    if (r.type !== 'ATLAS_OPEN_RESULT') error = r.type === 'REQUEST_FAILED' ? r.error : 'Unexpected answer from the extension.';
    else if (!r.ok) error = r.error ?? 'It could not be opened';
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  if (error !== state.notice) { state.notice = error; render(); }
}

/** The object's own name and class, where the opener only knew its RID. */
async function readHome(rid: string): Promise<void> {
  try {
    const r = await request({ type: 'ATLAS_OBJECT', rid, environment }, READ_TIMEOUT_MS);
    if (r.type !== 'ATLAS_OBJECT_DATA' || !r.ok || !r.object || state.home?.rid !== rid) return;
    const first = !state.home.cls;
    state.home = r.object;
    if (first) showType(r.object.cls, null);
    else render();
  } catch { /* the page works without the object's name */ }
}

/** Opened, or sent somewhere, on an object or a type. */
function go(where: { rid?: string | null; name?: string | null; objectType?: string | null; tab?: number }): void {
  if (where.tab != null) openerTab = where.tab;
  if (where.rid) {
    state.home = { rid: where.rid, id: '', name: where.name ?? '', cls: where.objectType ?? '' };
    if (where.objectType) showType(where.objectType, null);
    void readHome(where.rid);
  } else if (where.objectType) showType(where.objectType, null);
  else render();
}

function fromHash(): void {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const tab = Number(p.get('tab'));
  go({ rid: /^-?\d{1,20}$/.test(p.get('rid') ?? '') ? p.get('rid') : null, name: p.get('name'), objectType: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(p.get('type') ?? '') ? p.get('type') : null, ...(Number.isInteger(tab) && tab > 0 ? { tab } : {}) });
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, respond) => {
  const m = raw as { type?: string; environment?: string; rid?: string; name?: string; objectType?: string; progress?: AtlasReadProgress } | undefined;
  // How far the read of the types is: only the parts that show it are drawn again.
  if (m?.type === 'ATLAS_PROGRESS' && m.environment === environment && m.progress) {
    if (state.reading) { state.progress = m.progress; view.live(state); }
    return undefined;
  }
  // The code copy's state, as the worker tells every page: the progress takes each one;
  // the page is drawn again only when the copy starts or ends.
  if (m?.type === 'CODE_INDEX_STATUS') {
    const st = (raw as { status?: CodeIndexStatus }).status;
    if (!st || st.environment !== environment) return undefined;
    copyProgress.update(st);
    const making = state.usage?.state === 'none' && !!state.usage.making;
    // A list read from a copy that was removed (or is being made again) goes with it.
    const shown = state.usage?.state === 'ready' && st.state !== 'refreshing';
    if (st.state === 'building' ? !making : making || shown || st.state === 'ready') void loadUsage();
    return undefined;
  }
  if (m?.type !== 'ATLAS_NAVIGATE' || m.environment !== environment) return undefined;
  go({ rid: m.rid, name: m.name, objectType: m.objectType });
  respond({ ok: true });
  return undefined;
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.matches.length) { closeFind(); render(); }
});
document.addEventListener('mousedown', e => {
  if (state.matches.length && !(e.target as HTMLElement).closest('.at-find')) { state.matches = []; render(); }
});
window.addEventListener('hashchange', fromHash);

fromHash();
void readModel(false);
