/**
 * Code search window (codesearch/codesearch.html): find text, or the
 * references to one object, in the Extended Code of the current server.
 *
 * The search itself is lib/code-search `runCodeSearch`. It runs here, in the
 * window's own page, over the local code index (IndexedDB, lib/code-index-
 * store), which the service worker builds and refreshes (CODE_INDEX_SYNC).
 * Every query is then local and complete. While the index is first being
 * built, the part already read is searched and the answer says so; a
 * server that cannot be indexed is searched by the worker's server scan
 * (CODE_SEARCH_START), through the same function.
 *
 * Read-only. A match opens the object window on that object, property and
 * line, with the search as the first step of its trail.
 */

import { shortcutDef, shortcutLabels, whichShortcut, withShortcut, type ShortcutId } from '../lib/shortcuts';
import { escapeLayers } from '../lib/escape-layers';
import { installCheatSheetKey } from '../lib/cheat-sheet';
import type { CodeCopyEstimate, CodeIndexStatus, CodeSearchObject, InspectorMessage } from '../lib/types';
import type { CodeSearchFrameActivation, ConnectionState } from '../lib/types';
import { installCloseHandshake } from '../lib/frame-close-handshake';
import { pickerSearch } from '../lib/object-search-sources';
import { createObjectPicker, type ObjectPicker, type ObjectPickerSource, type PickerObject } from '../lib/object-picker';
import { sendFireForget, sendRequestBounded } from '../lib/messaging';
import { openObject } from '../lib/open-object';
import { renderCodeLine } from '../editor-core/code-view';
import { describeConnection } from '../lib/connection-copy';
import { propHelp, typeInfo } from '../lib/object-window-table';
import { ICON_SPRITE } from '../lib/icon-sprite';
import { codeIndexStore, type IndexedObject } from '../lib/code-index-store';
import { CONTEXT_LINES, NEEDS_INDEX_TEXT, effectiveObject, isWholeLine, indexSource, type CodeSearchHit, type CodeSearchOutcome, type CodeSearchProgress, type CodeSearchRequest, type CodeSearchSort, type CoverageMeta, type FoldedInstance, type SearchableObject } from '../lib/code-search';
import { ALL_ROWS, PAGE_ROWS, ResultList, runAll } from './search-results';
import { reconcileChildren } from './keyed-dom';
import type { RefResolution } from '../lib/code-ref-resolve';
import {
  addRecent, charsText, chosenLabels, coverageText, durationText, familyTree, fmt, indexFacets, indexText, kindTree, LINES_SHOWN, navRows, optionsText,
  parseRecents, plural, progressText, propLabel, removeRecent, rowKey, scopeText, step, summaryText, toggleEntry, topKinds, typeLabel, visibleLines, whereTree,
  type FeedNow, type Filters, type IndexFacets, type RecentSearch, type TreeEntry, type WhereRoot,
} from './search-model';
import { kindOfProp } from '../lib/object-window-table';
import { patternProblem } from '../lib/code-search-match';
import { emptyState } from '../lib/empty-state';
import { watchWindowEnvironment } from '../lib/window-environment';
import { fromParent, postToParent } from '../lib/frame-parent';
import { copyWithFeedback } from '../lib/copy-feedback';
import { cancelledText, isQuietEnd, NO_ANSWER_TEXT, startWatchdog, STATUS_TIMEOUT_MS, STOPPED_TEXT, type Watchdog } from './search-lifecycle';
import { attrs, btn, el, icon, type Kid } from '../lib/dom';
import { startKeepAlive, type KeepAlive } from '../lib/keep-alive';
import { createReplaceTab } from './replace-tab';

installCloseHandshake();

type Msg<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

// ── tiny DOM helpers ──────────────────────────────────────────────

const kbd = (t: string) => el('kbd', '', t);
function tile(type: string): HTMLElement {
  const info = typeInfo(type);
  const t = attrs(el('span', 'cs-tile', icon(info.icon)), { title: typeLabel(type), 'aria-hidden': 'true' });
  t.style.background = `var(${info.fam})`;
  return t;
}
const objName = (o: { name?: string; businessId?: string; rid: string }) => o.name || o.businessId || o.rid;
/** Where a result lives: the root's name on the server, then the folders
 *  above it ("Template category · Central pages › Home"). */
function placeText(h: { root?: string; where: string }): string {
  const root = h.root ? whereLabel(`root:${h.root}`) : '';
  return [root, h.where].filter(Boolean).join(' · ');
}
/** Name of a Where key (a root or an organisation). */
function whereLabel(key: string): string {
  if (key.startsWith('root:')) return status?.roots?.find(r => r.key === key.slice(5))?.name ?? key.slice(5);
  if (key.startsWith('org:')) return status?.orgs?.[key.slice(4)]?.name ?? key.slice(4);
  return key;
}

// ── state ─────────────────────────────────────────────────────────

/** Recent searches are kept per server profile: their RIDs and places
 *  belong to one server (cloned servers share RIDs). The old shared list
 *  cannot be attributed to a server and is dropped. */
const RECENTS_PREFIX = 'crev-codesearch-recents';
let recentsProfile: string | null = null;
const recentsKey = (): string | null => recentsProfile ? `${RECENTS_PREFIX}:${recentsProfile}` : null;
const WIN_ID = Math.random().toString(36).slice(2);

let mode: 'text' | 'refs' | 'replace' = 'text';
let query = '';
const opts = { caseSensitive: true, wholeWord: false, regex: false };
/** Where, Kind of code (properties) and Object type (types); empty lists
 *  mean any. Where applies to "Used in code" too. */
const filters: Filters = { types: [], props: [], where: [] };
const FOLD_KEY = 'crev-codesearch-fold';
/** Fold instances into their template's row (on by default). */
let fold = loadFold();
/** Rows whose folded instances are listed. */
const openInstances = new Set<string>();

function loadFold(): boolean {
  try { return localStorage.getItem(FOLD_KEY) !== 'off'; } catch { return true; }
}
/** The object the window was opened from (scope and target offers). */
let context: CodeSearchObject | null = null;
let scope: { obj: CodeSearchObject; rids?: Set<string>; covered?: Msg<'CODE_SEARCH_SCOPE_RESULT'>['covered']; loading?: boolean; error?: string } | null = null;
let target: CodeSearchObject | null = null;
let picking: { kind: 'scope' | 'target'; text: string } | null = null;
/** The open filter menu, and the text of its filter field. */
let openMenu: MenuKind | null = null;
let menuFilter = '';
/** Focus the open menu after the next render (it was just opened). */
let focusMenu = false;
let status: CodeIndexStatus | null = null;
let snapshot: { key: string; objects: IndexedObject[] } | null = null;
let snapshotLoad: Promise<void> | null = null;
let connection: ReturnType<typeof describeConnection> | null = null;

interface Run {
  id: string;
  req: CodeSearchRequest;
  label: string;
  /** Every row of the answer, shown a page at a time (search-results). */
  list: ResultList;
  /** The rows shown. */
  readonly hits: CodeSearchHit[];
  outcome?: CodeSearchOutcome;
  error?: string;
  searching: boolean;
  started: number;
  source: 'index' | 'server';
  /** Index state when the search started (why the server was read). */
  indexState?: CodeIndexStatus['state'];
  controller?: AbortController;
  /** Server search only: asks the worker when the search goes quiet. */
  watchdog?: Watchdog;
  /** Run again on a changed index: keeps selection and scroll. */
  quiet?: boolean;
}
let run: Run | null = null;
/** The query was edited after the shown results: they are greyed out. */
let stale = false;
/** Regex mode: what is wrong with the pattern of the last search (nothing
 *  was searched; the results shown belong to the previous search). */
let patternError: string | null = null;
let selected: string | null = null;
const contextOpen = new Set<string>();
const contextMore = new Map<string, { above: number; below: number }>();
const collapsed = new Set<string>();
const allLines = new Set<string>();
let recents: RecentSearch[] = [];
/** The server of this window's page, learned from the worker's first answer
 *  for it; broadcasts about other servers' indexes are ignored. */
let ownEnvironment: string | null = null;
/** The change feed of this window's server as the worker last told it. */
let feedNow: FeedNow | null = null;
const environmentWatch = watchWindowEnvironment(() => ownEnvironment ?? undefined);

function adoptEnvironment(env: string): void {
  if (!env || ownEnvironment) return;
  ownEnvironment = env;
  void environmentWatch.check();
  const profile = env.slice(0, env.indexOf('@'));
  if (!profile || profile === recentsProfile) return;
  recentsProfile = profile;
  recents = loadRecents();
  try { localStorage.removeItem(RECENTS_PREFIX); } catch { /* storage blocked */ }
}
/** Order of the objects (null: the mode's default). */
let sortBy: CodeSearchSort | null = null;
const currentSort = (): CodeSearchSort => sortBy ?? (mode === 'refs' ? 'location' : 'matches');
/** The Replace tab changes with the query, the options, the filters and the copy. */
/** The mode of the results shown (the Replace tab has none). */
const searchMode = (): 'text' | 'refs' => (mode === 'refs' ? 'refs' : 'text');
const refreshReplace = (): void => { if (mode === 'replace') rep.invalidate(); };

function loadRecents(): RecentSearch[] {
  const key = recentsKey();
  if (!key) return [];
  try { return parseRecents(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return []; }
}
function saveRecents(): void {
  const key = recentsKey();
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(recents)); } catch { /* storage blocked */ }
}

// ── persistent controls ───────────────────────────────────────────

const root = document.getElementById('search-root')!;
const sprite = document.createElement('div');
sprite.innerHTML = ICON_SPRITE;
root.append(sprite.firstElementChild!);

const input = attrs(el('input', 'cs-q') as HTMLInputElement, {
  type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search Extended Code',
  'aria-controls': 'cs-results', placeholder: 'Search Extended Code',
});
const live = attrs(el('div', 'sr-only'), { 'aria-live': 'polite', role: 'status' });
/** The whole-word mark: "ab" over a bracket that marks the word's edges (the
 *  form code editors use). Text and stroke follow currentColor; the letters
 *  take the toggle's own font, so the weight matches "Aa" and ".*". */
function wholeWordMark(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  attrs(s, { class: 'cs-tg-ww', viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' });
  const t = document.createElementNS(NS, 'text');
  attrs(t, { x: '8', y: '9', 'text-anchor': 'middle', fill: 'currentColor' });
  t.textContent = 'ab';
  const p = document.createElementNS(NS, 'path');
  attrs(p, { d: 'M2.5 11v2.5h11V11', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  s.append(t, p);
  return s;
}

const toggles = {
  caseSensitive: btn('cs-tg', undefined, () => setOpt('caseSensitive'), 'Aa'),
  wholeWord: btn('cs-tg', undefined, () => setOpt('wholeWord'), wholeWordMark()),
  regex: btn('cs-tg', undefined, () => setOpt('regex'), '.*'),
};
toggles.caseSensitive.title = 'Match case';
toggles.wholeWord.title = 'Whole word: “task” does not match “tasks”';
toggles.regex.title = 'Pattern (regular expression)';
for (const b of Object.values(toggles)) b.setAttribute('aria-label', b.title);
toggles.wholeWord.setAttribute('aria-label', 'Match whole word');
const clearBtn = btn('ui-ibtn', withShortcut('Clear', 'codesearch.back'), () => { clearQuery(); input.focus(); }, icon('i-x'));
const goBtn = btn('ui-btn primary cs-go', undefined, () => { if (run?.searching) stop(); else void search(); }, 'Search');
const fieldEl = el('div', 'cs-fld ui-search', icon('i-search'), input, clearBtn, el('span', 'cs-tgsep'), toggles.caseSensitive, toggles.wholeWord, toggles.regex, goBtn);
const modesSlot = el('div');
const fieldSlot = el('div');
const progSlot = el('div');
const scopeSlot = el('div');
const pickSlot = el('div');
const repSlot = el('div');
/** What is wrong with the pattern, at the field (regex mode). */
const fieldMsg = attrs(el('div', 'cs-field-err'), { id: 'cs-field-err', role: 'alert' });
fieldMsg.hidden = true;
const qaEl = el('div', 'cs-qa', modesSlot, fieldSlot, fieldMsg, repSlot, progSlot, scopeSlot, pickSlot);
const sumEl = el('div', 'cs-sum');
const resEl = attrs(el('div', 'cs-res'), { id: 'cs-results', role: 'tree', 'aria-label': 'Results', tabindex: '-1' });
const statusEl = el('footer', 'cs-status');
const shell = attrs(el('section', 'cs ui', qaEl, sumEl, resEl, statusEl, live), { 'aria-label': 'Search code' });
root.append(shell);

let typeTimer = 0;
input.addEventListener('input', () => {
  query = input.value;
  if (mode === 'replace') { rep.leaveResult(); renderQa(); rep.invalidate(); return; }
  if (run) stale = true;
  patternError = null;
  renderQa();
  renderResults();
  window.clearTimeout(typeTimer);
  // Local search answers in milliseconds: search as you type.
  if (indexUsable() && query.trim()) typeTimer = window.setTimeout(() => void search(), 80);
  else if (!query.trim()) { run = null; stale = false; renderAll(); }
});
input.addEventListener('keydown', e => onKey(e));
resEl.addEventListener('keydown', e => onKey(e));

for (const [k, b] of Object.entries(toggles)) attrs(b, { 'aria-pressed': String(opts[k as keyof typeof opts]) });

function setOpt(k: keyof typeof opts): void {
  opts[k] = !opts[k];
  if (mode === 'replace') { rep.leaveResult(); renderQa(); rep.invalidate(); return; }
  if (query.trim() || mode === 'refs') void search(); else renderQa();
}

function clearQuery(): void {
  query = '';
  input.value = '';
  if (mode === 'replace') { rep.leaveResult(); rep.invalidate(); renderAll(); return; }
  run?.controller?.abort();
  run?.watchdog?.stop();
  if (run?.source === 'server') sendFireForget({ type: 'CODE_SEARCH_STOP', id: run.id, windowId: WIN_ID });
  run = null;
  stale = false;
  selected = null;
  renderAll();
}

// ── index ─────────────────────────────────────────────────────────

function indexUsable(): boolean {
  // A complete index answers, and one built root by root once everything
  // but the organisation root is read (the answer says what it covers);
  // before that the server scan does.
  if (status?.state === 'ready' || status?.state === 'refreshing') return true;
  return (status?.state === 'building' || status?.state === 'paused') && status.stage === 'organisation';
}

/** A copy places organisation objects by their top-level organisation (the
 *  search reads per top-level organisation): a deeper organisation in Where
 *  is searched on the server. */
function indexServes(req: CodeSearchRequest): boolean {
  if (!indexUsable()) return false;
  if (!status?.copy || !req.where?.length) return true;
  return req.where.every(k => !k.startsWith('org:') || !status!.orgs?.[k.slice(4)]?.parent);
}

/** The coverage the index source states, from the status. */
function coverageMeta(st: CodeIndexStatus): CoverageMeta {
  return {
    syncedAt: st.syncedAt, builtAt: st.builtAt, objects: st.objects, pending: st.state === 'refreshing' ? 0 : st.pending,
    ...(st.roots ? { roots: Object.fromEntries(st.roots.map(r => [r.key, r])), rootOrder: st.roots.map(r => r.key) } : {}),
    ...(st.orgs ? { orgs: st.orgs } : {}), ...(st.stage ? { stage: st.stage } : {}),
  };
}

/** The window's copy of the index is reloaded when the stored index
 *  changed: revision, sync time and object count all live in the stored
 *  meta, so a worker restart cannot make an old copy look current. */
const snapshotKey = (st: CodeIndexStatus) => `${st.environment}|${st.version}|${st.syncedAt ?? ''}|${st.objects}|${st.pending}`;

async function ensureSnapshot(): Promise<void> {
  if (!status) return;
  const st = status;
  const key = snapshotKey(st);
  if (snapshot && snapshot.key === key) return;
  if (snapshotLoad) { await snapshotLoad; if (snapshot?.key === key) return; }
  snapshotLoad = (async () => {
    const objects: IndexedObject[] = [];
    await codeIndexStore().scan(st.environment, batch => { objects.push(...batch); }, 1000);
    snapshot = { key, objects };
  })();
  try { await snapshotLoad; } finally { snapshotLoad = null; }
}

let rebuildTimer = 0;
function onStatus(s: CodeIndexStatus): void {
  adoptEnvironment(s.environment);
  const prev = status;
  status = s;
  if (prev && prev.environment !== s.environment) snapshot = null;
  const nowUsable = indexUsable();
  const changed = !!prev && snapshotKey(prev) !== snapshotKey(s);
  rep.environmentKnown();
  if (mode === 'replace' && (changed || !prev || prev.state !== s.state)) rep.invalidate();
  // The index became ready while server results are shown, or the index
  // changed under index results: the same query runs again (selection and
  // scroll position are kept).
  if (run && !run.searching && !stale && nowUsable && ((run.source === 'server') || (run.source === 'index' && changed))) {
    window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(() => { if (run && !stale && !run.searching) void search(true); }, 50);
  }
  if (!s.roots?.length) loadServerRoots();
  holdWorker();
  applyDefaultWhere();
  renderStatus();
  renderQa();
}

/** The keep-alive port (keep-alive.ts) keeps the worker running, with the
 *  code read for live searches and the change feed of this server. A
 *  complete local index answers searches here: no port then, so nothing is
 *  polled for this window. A build or refresh under way holds it. */
let keepAlive: KeepAlive | null = null;
function holdWorker(): void {
  const local = status?.state === 'ready';
  if (local && keepAlive) { keepAlive.stop(); keepAlive = null; }
  else if (!local && !keepAlive) keepAlive = startKeepAlive();
}

// ── search ────────────────────────────────────────────────────────

function request(): CodeSearchRequest | null {
  // The Replace tab plans from the copy by itself (replace-tab.ts).
  if (mode === 'replace') return null;
  const base = {
    caseSensitive: opts.caseSensitive, wholeWord: opts.wholeWord, regex: opts.regex, sort: currentSort(), fold,
    ...(filters.where.length && !scope ? { where: [...filters.where] } : {}),
  };
  if (mode === 'refs') {
    if (!target) return null;
    return { mode: 'refs', target: { rid: target.rid, businessId: target.businessId ?? '', ...(target.type ? { type: target.type } : {}) }, ...base, caseSensitive: true, wholeWord: false, regex: false };
  }
  if (!query.trim()) return null;
  // Kind and Type apply to text: a "Used in code" list is every place.
  return {
    mode: 'text', text: query, ...base,
    ...(filters.types.length ? { types: [...filters.types] } : {}),
    ...(filters.props.length ? { props: [...filters.props] } : {}),
  };
}

function labelOf(): string {
  return mode === 'refs' ? `Used in code: ${target ? objName(target) : ''}` : `Search: ${query}`;
}

/** Run the query. One scan gives every row; "Show more" pages through them
 *  here (showMore). A changed query, scope or option searches again and
 *  drops the old rows. `quiet`: the same query again (a changed index, a
 *  new order): the shown results, selection, scroll and page count stay
 *  until the answer replaces them. `fresh`: "Search again": the server
 *  lists the place again even when a listing a few seconds old is kept. */
async function search(quiet = false, fresh = false): Promise<void> {
  const req = request();
  if (!req) { renderAll(); return; }
  // An invalid pattern: say what is wrong at the field, keep the previous
  // results (marked as the previous search's) and send nothing.
  patternError = req.mode === 'text' && req.regex ? patternProblem(req.text ?? '') : null;
  if (patternError) {
    if (run) stale = true;
    renderAll();
    return;
  }
  if (scope?.loading || scope?.error) { renderAll(); return; }
  if (scope?.rids) req.scopeRids = scope.rids;
  run?.controller?.abort();
  run?.watchdog?.stop();
  // The worker replaces this window's running search by itself; no stop is sent.
  const id = `${WIN_ID}:${Date.now()}`;
  const list = new ResultList(quiet && run ? run.list.shown : PAGE_ROWS);
  // Full texts read for the old rows may be out of date: read again on demand.
  fullCode.clear();
  const cur: Run = { id, req, label: labelOf(), list, get hits() { return list.hits; }, searching: true, started: performance.now(), source: indexServes(req) ? 'index' : 'server', ...(status ? { indexState: status.state } : {}) };
  run = cur;
  stale = false;
  cur.quiet = quiet;
  // A quiet run (the same query again on a changed index) keeps the shown
  // results, selection and scroll until its answer replaces them.
  if (!quiet) { selected = null; contextOpen.clear(); collapsed.clear(); allLines.clear(); renderAll(); }
  if (cur.source === 'server') {
    // Every row in one answer: the window pages through them itself.
    const wire = { ...req, scopeRids: undefined, offset: 0, limit: ALL_ROWS };
    sendFireForget({ type: 'CODE_SEARCH_START', id, windowId: WIN_ID, search: wire, ...(scope ? { scopeRid: scope.obj.rid } : {}), ...(fresh ? { fresh: true } : {}) });
    cur.watchdog = startWatchdog({
      ask: async () => {
        const r = await sendRequestBounded<Msg<'CODE_SEARCH_STATUS_RESULT'>>({ type: 'CODE_SEARCH_STATUS', id, windowId: WIN_ID }, { timeoutMs: STATUS_TIMEOUT_MS });
        return r?.type === 'CODE_SEARCH_STATUS_RESULT' && r.id === id ? r.running : undefined;
      },
      onDead: () => {
        if (run !== cur || !cur.searching) return;
        cur.searching = false;
        cur.error = NO_ANSWER_TEXT;
        renderAll();
      },
    });
    return;
  }
  const controller = new AbortController();
  cur.controller = controller;
  try {
    await ensureSnapshot();
    if (run !== cur) return;
    const snap = snapshot;
    const meta = status ? coverageMeta(status) : null;
    const outcome = await runAll(req, indexSource(meta, each => { each(snap?.objects ?? []); return Promise.resolve(); }), list, { signal: controller.signal, resolveKeys, namesFromCopy: true });
    if (run !== cur) return;
    finish(cur, outcome);
  } catch (e) {
    if (run !== cur || controller.signal.aborted) return;
    cur.searching = false;
    cur.error = e instanceof Error ? e.message : String(e);
    renderAll();
  }
}

/** Names resolved for this window's server, kept while the window is open
 *  ("Used in code" again sends nothing for names already resolved). */
const resolved = new Map<string, RefResolution>();
async function resolveKeys(keys: string[]): Promise<Record<string, RefResolution>> {
  const out: Record<string, RefResolution> = {};
  const env = status?.environment ?? '';
  for (const k of keys) { const r = resolved.get(`${env}|${k}`); if (r) out[k] = r; }
  const ask = keys.filter(k => !out[k]);
  for (let i = 0; i < ask.length; i += 80) {
    const res = await sendRequestBounded<Msg<'CODE_REFS_RESULT'>>({ type: 'RESOLVE_CODE_REFS', keys: ask.slice(i, i + 80), ...(status?.environment ? { environment: status.environment } : {}) }, { timeoutMs: 20_000 });
    if (res?.type !== 'CODE_REFS_RESULT' || !res.ok) throw new Error(res?.type === 'CODE_REFS_RESULT' && res.error ? res.error : 'References could not be resolved');
    Object.assign(out, res.results);
    for (const [k, r] of Object.entries(res.results)) resolved.set(`${env}|${k}`, r);
  }
  return out;
}

function finish(cur: Run, outcome: CodeSearchOutcome): void {
  cur.watchdog?.stop();
  cur.outcome = cur.list.outcome === outcome ? outcome : cur.list.finish(outcome);
  cur.searching = false;
  const top = resEl.scrollTop;
  if (selected && !navRows(cur.hits, collapsed, allLines).some(r => r.key === selected)) selected = null;
  if (cur.quiet) {
    renderAll();
    resEl.scrollTop = top;
    return;
  }
  if (!selected && cur.hits.length) {
    const rows = navRows(cur.hits, collapsed, allLines);
    selected = rows[0]?.key ?? null;
  }
  const rec: RecentSearch = {
    mode: searchMode(), query: mode === 'refs' ? (target?.businessId || target?.rid || '') : query, ...(mode === 'refs' && target ? { target } : {}),
    ...opts, types: mode === 'text' ? [...filters.types] : [], props: mode === 'text' ? [...filters.props] : [],
    ...(filters.where.length && !scope ? { where: filters.where.map(k => ({ key: k, label: whereLabel(k) })) } : {}),
    ...(scope ? { scope: scope.obj } : {}), matches: outcome.matches, objects: outcome.matchedObjects,
  };
  recents = addRecent(recents, rec);
  saveRecents();
  live.textContent = outcome.matchedObjects ? `${summaryText(outcome, searchMode())}.` : 'No matches.';
  renderAll();
}

function stop(): void {
  if (!run?.searching) return;
  run.controller?.abort();
  run.watchdog?.stop();
  if (run.source === 'server') sendFireForget({ type: 'CODE_SEARCH_STOP', id: run.id, windowId: WIN_ID });
  run.searching = false;
  run.error = STOPPED_TEXT;
  renderAll();
}

// ── opening a match ───────────────────────────────────────────────

function hitOf(rid: string): CodeSearchHit | undefined {
  return run?.hits.find(h => h.rid === rid);
}

function open(key: string, inEditor = false): void {
  const [rid, prop, lineStr] = key.split(':');
  const hit = hitOf(rid);
  const line = Number(lineStr);
  if (!hit) return;
  if (inEditor) {
    const text = hit.props.find(p => p.prop === prop)?.lines.find(l => l.line === line)?.text;
    sendFireForget({ type: 'OPEN_EDITOR', rid, property: prop, scrollToLine: line, ...(text ? { scrollToText: text } : {}) });
    return;
  }
  openObject(rid, hit, {
    focus: { prop, line },
    origin: { kind: 'search', label: run?.label ?? labelOf(), mode: searchMode(), ...(mode === 'text' ? { query } : {}) },
  });
}

// ── keyboard ──────────────────────────────────────────────────────

function onKey(e: KeyboardEvent): void {
  const rows = run ? navRows(run.hits, collapsed, allLines) : [];
  const id = whichShortcut(e, ['codesearch.move', 'codesearch.context', 'codesearch.uncontext', 'codesearch.openEditor', 'codesearch.open']);
  if (id === 'codesearch.move') {
    if (!rows.length || (picking && e.target !== resEl)) return;
    e.preventDefault();
    selected = step(rows, selected, e.key === 'ArrowDown' ? 1 : -1);
    updateSelection();
    return;
  }
  const atEnd = e.target === resEl || input.selectionStart === input.value.length;
  if (id === 'codesearch.context' && selected && atEnd) {
    if (!contextOpen.has(selected)) { e.preventDefault(); contextOpen.add(selected); renderResults(); }
    return;
  }
  if (id === 'codesearch.uncontext' && selected && contextOpen.has(selected) && atEnd) {
    e.preventDefault(); contextOpen.delete(selected); renderResults(); return;
  }
  if (id === 'codesearch.open' || id === 'codesearch.openEditor') {
    e.preventDefault();
    if (e.target === input && (stale || !run)) { window.clearTimeout(typeTimer); void search(); return; }
    if (selected) open(selected, id === 'codesearch.openEditor');
    else void search();
  }
}

/** Window keys: `/` focuses the field, F8 / Shift+F8 step through the hits. */
function onWindowKey(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const id = whichShortcut(e, ['codesearch.again', 'codesearch.search', 'codesearch.next', 'codesearch.prev']);
  if (id === 'codesearch.again') {
    // The same query again (Enter opens the selected hit instead).
    if (picking) return;
    e.preventDefault();
    if (request() && !run?.searching) void search(false, true);
    return;
  }
  if (id === 'codesearch.search') {
    e.preventDefault();
    input.focus();
    input.select();
  } else if (id) {
    const rows = run ? navRows(run.hits, collapsed, allLines) : [];
    if (!rows.length) return;
    e.preventDefault();
    selected = step(rows, selected, id === 'codesearch.next' ? 1 : -1);
    updateSelection();
  }
}

// Escape, innermost first: a menu or picker, a running search, the query,
// then the window (lib/escape-layers.ts).
const escLayers = escapeLayers();
escLayers.register({ kind: 'window', name: 'codesearch', isOpen: () => true, close: () => { postToParent({ type: 'CREV_OVERLAY_CLOSE_PLEASE' }); } });
escLayers.register({ kind: 'input', name: 'query', isOpen: () => !!query, close: () => { clearQuery(); } });
escLayers.register({ kind: 'input', name: 'running-search', isOpen: () => !!run?.searching, close: () => { stop(); } });
escLayers.register({ kind: 'menu', name: 'menus', isOpen: () => !!openMenu || !!picking, close: () => { closeMenu(); closePick(); renderQa(); } });
escLayers.listen(document);
document.addEventListener('keydown', onWindowKey);

// The Replace tab (replace-tab.ts) works on the window's copy of the code.
const rep = createReplaceTab({
  objects: () => snapshot?.objects ?? null,
  load: () => ensureSnapshot(),
  copyReady: () => status?.state === 'ready' || status?.state === 'refreshing',
  environment: () => ownEnvironment ?? status?.environment,
  blocked: () => environmentWatch.blocked(),
  query: () => query,
  options: () => opts,
  filters: () => filters,
  scopeRids: () => scope?.rids,
  tile,
  typeLabel,
  render: renderAll,
  openEditor: (rid, prop, line) => sendFireForget({ type: 'OPEN_EDITOR', rid, property: prop, ...(line ? { scrollToLine: line } : {}) }),
  keepCopy: () => { setMode('text'); instantOpen = true; void loadEstimate(); renderAll(); },
  announce: text => { live.textContent = text; },
  escape: layer => { escLayers.register(layer); },
});
installCheatSheetKey(() => ({ window: 'codesearch', title: 'Code search: keyboard shortcuts' }));

function updateSelection(): void {
  for (const r of resEl.querySelectorAll('.cs-ml.sel')) { r.classList.remove('sel'); r.setAttribute('aria-selected', 'false'); }
  const row = selected ? resEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(selected)}"]`) : null;
  if (row) {
    row.classList.add('sel');
    row.setAttribute('aria-selected', 'true');
    row.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', row.id);
    resEl.setAttribute('aria-activedescendant', row.id);
  }
  renderStatus();
}

// ── rendering: query area ─────────────────────────────────────────

function chip(label: Kid | Kid[], on: boolean, onClick: () => void, title?: string): HTMLButtonElement {
  const b = btn(`cs-chip${on ? ' on' : ''}`, undefined, onClick, ...(Array.isArray(label) ? label : [label]));
  b.setAttribute('aria-pressed', String(on));
  if (title) b.title = title;
  return b;
}

function renderQa(): void {
  // Only when it differs: setting the value moves the caret.
  if (input.value !== query) input.value = query;
  input.placeholder = mode === 'refs' ? '' : mode === 'replace' ? 'Find' : 'Search Extended Code';
  shell.dataset.mode = mode;
  for (const [k, b] of Object.entries(toggles)) {
    const on = opts[k as keyof typeof opts];
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  clearBtn.hidden = !query || mode === 'replace';
  goBtn.hidden = mode === 'replace';
  // The pattern problem shows only while the pattern is still the one searched.
  if (mode === 'replace') patternError = opts.regex && query.trim() ? patternProblem(query) : null;
  else if (patternError && !(mode === 'text' && opts.regex)) patternError = null;
  fieldMsg.hidden = !patternError;
  fieldMsg.replaceChildren(...(patternError ? [icon('i-warn', 'ic-sm'), el('span', '', el('b', '', 'Not a valid pattern. '), patternError)] : []));
  if (patternError) attrs(input, { 'aria-invalid': 'true', 'aria-describedby': 'cs-field-err' });
  else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
  fieldEl.classList.toggle('invalid', !!patternError);
  const searching = !!run?.searching;
  goBtn.textContent = searching ? 'Stop' : 'Search';
  goBtn.className = searching ? 'ui-btn cs-go' : 'ui-btn primary cs-go';
  const modes = el('div', 'cs-modes');
  attrs(modes, { role: 'tablist', 'aria-label': 'Search mode' });
  for (const [m, label] of [['text', 'Find text'], ['refs', 'Used in code'], ['replace', 'Replace']] as const) {
    const b = btn(m === mode ? 'on' : '', undefined, () => setMode(m), label);
    attrs(b, { role: 'tab', 'aria-selected': String(m === mode) });
    modes.append(b);
  }
  // The query field is never moved in the DOM (moving it drops focus and
  // caret): each part has its own slot, and only changed slots are replaced.
  modesSlot.replaceChildren(modes);
  if (mode !== 'refs') { if (fieldSlot.firstChild !== fieldEl) fieldSlot.replaceChildren(fieldEl); }
  else fieldSlot.replaceChildren(targetRow());
  if (mode === 'replace') { if (repSlot.firstChild !== rep.field) repSlot.replaceChildren(rep.field); }
  else repSlot.replaceChildren();
  if (searching || status?.state === 'building' || status?.state === 'refreshing') {
    const p = progressFraction();
    progSlot.replaceChildren(attrs(el('div', 'cs-prog', Object.assign(el('i'), { style: `width:${Math.round(p * 100)}%` }) as HTMLElement), { role: 'progressbar', 'aria-label': 'Search progress', 'aria-valuenow': String(Math.round(p * 100)) }));
  } else progSlot.replaceChildren();
  // The row is rebuilt: focus (an open menu's item or filter field) stays
  // on the same control.
  const had = document.activeElement instanceof HTMLElement && scopeSlot.contains(document.activeElement) ? document.activeElement : null;
  const fk = had?.dataset.fk;
  const caret = had instanceof HTMLInputElement ? had.selectionStart : null;
  scopeSlot.replaceChildren(scopeRow());
  const again = fk ? scopeSlot.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]`) : null;
  if (again) {
    again.focus();
    if (again instanceof HTMLInputElement && caret != null) again.setSelectionRange(caret, caret);
  } else if (had && openMenu) {
    scopeSlot.querySelector<HTMLElement>('.cs-mf, [role="menuitemcheckbox"]')?.focus();
  }
  if (focusMenu && openMenu) {
    focusMenu = false;
    scopeSlot.querySelector<HTMLElement>('.cs-mf, [role="menuitemcheckbox"]')?.focus();
  }
  if (pickerBox) { if (pickSlot.firstChild !== pickerBox) pickSlot.replaceChildren(pickerBox); } else pickSlot.replaceChildren();
}

function progressFraction(): number {
  const sp = run?.searching ? run.list.progress : undefined;
  if (sp) return searchFraction(sp);
  const p = status?.progress;
  if ((status?.state === 'building' || status?.state === 'refreshing') && p?.toRead) return p.read / p.toRead;
  return 0.3;
}

/** Each mode keeps its last results: switching to "Used in code" to pick
 *  an object, and back, does not lose the text search's results (nor does a
 *  failed picker query). */
const runsByMode: Record<'text' | 'refs', Run | null> = { text: null, refs: null };

function setMode(m: 'text' | 'refs' | 'replace'): void {
  if (mode === m) return;
  // A search under way belongs to the mode it was started in.
  if (run?.searching) stop();
  if (mode !== 'replace') runsByMode[mode] = run;
  mode = m;
  run = m === 'replace' ? null : runsByMode[m];
  stale = false;
  selected = null;
  if (m === 'refs' && !target && context) target = context;
  renderAll();
  if (m === 'replace') { rep.invalidate(); input.focus(); }
  else if (m === 'refs' && target && !run) void search();
  else if (m === 'text') input.focus();
}

function targetRow(): HTMLElement {
  if (!target) {
    return el('div', 'cs-tgt empty', el('span', 'cs-muted', 'Choose the object to look up.'), el('span', 'grow'),
      btn('ui-tbtn', undefined, () => startPick('target'), 'Choose…'));
  }
  const fromContext = context?.rid === target.rid;
  return el('div', 'cs-tgt', tile(target.type ?? ''), el('span', 'nm', objName(target)),
    target.businessId ? el('span', 'ui-id', `ID ${target.businessId}`) : '', el('span', 'ui-id', `RID ${target.rid}`), el('span', 'grow'),
    fromContext ? el('span', 'src', 'current object') : '',
    btn('ui-tbtn', 'Choose another object', () => startPick('target'), 'Change…'));
}

function scopeRow(): HTMLElement {
  // Three filters in one row, each a menu; the granular level is one click
  // deeper (a group's chevron).
  const row = el('div', 'cs-scope');
  row.append(filterMenu('where'));
  if (mode !== 'refs') row.append(filterMenu('kind'), filterMenu('type'));
  if (scope?.error) row.append(el('span', 'cs-scope-err', icon('i-warn', 'ic-sm'), scope.error));
  return row;
}

// ── Where, Kind of code and Object type menus ─────────────────────

type MenuKind = 'where' | 'kind' | 'type';

const MENUS: Record<MenuKind, { any: string; name: string; plural: string; tip: string }> = {
  where: { any: 'Everywhere', name: 'Where', plural: 'places', tip: 'Search only some roots or organisations' },
  kind: { any: 'Any kind of code', name: 'Kind', plural: 'properties', tip: 'Search only some kinds of code' },
  type: { any: 'Any type', name: 'Type', plural: 'types', tip: 'Search only some object types' },
};

/** Lists longer than this get a filter field. */
const MENU_FILTER_FROM = 10;
/** Groups opened in the menus (their real entries shown). */
const openGroups = new Set<string>();

let facetsOf: { key: string; facets: IndexFacets } | null = null;

/** Types, properties and places of the loaded index (the menus before a query). */
function idleFacets(): IndexFacets | null {
  if (!snapshot) return null;
  if (facetsOf?.key !== snapshot.key) facetsOf = { key: snapshot.key, facets: indexFacets(snapshot.objects) };
  return facetsOf.facets;
}

/** The outcome of the current query, when its results are shown. */
function shownOutcome(): CodeSearchOutcome | undefined {
  return mode === 'text' && run && !run.searching && !run.error ? run.outcome : undefined;
}

/** The server's roots and organisations without an index (one small
 *  request, CODE_SEARCH_ROOTS). */
let serverRootList: { roots: Array<{ key: string; name: string }>; orgs: Record<string, { name: string; parent: string }> } | null = null;
let serverRootsLoad: Promise<void> | null = null;
/** The Where choice was made by the user (else the default applies). */
let whereTouched = false;
const ORG = 'organisation';

function loadServerRoots(): void {
  if (serverRootList || serverRootsLoad) return;
  serverRootsLoad = (async () => {
    try {
      const r = await sendRequestBounded<Msg<'CODE_SEARCH_ROOTS_RESULT'>>({ type: 'CODE_SEARCH_ROOTS' }, { timeoutMs: 60_000 });
      if (r?.type === 'CODE_SEARCH_ROOTS_RESULT' && r.ok) { serverRootList = { roots: r.roots, orgs: r.orgs }; applyDefaultWhere(); renderQa(); }
    } catch { /* the menu lists the index's roots, or none */ } finally { serverRootsLoad = null; }
  })();
}

/** The configuration roots: every root but the organisation root. */
function configRootKeys(): string[] {
  const keys = status?.roots?.length ? status.roots.map(r => r.key) : (serverRootList?.roots ?? []).map(r => r.key);
  return keys.filter(k => k !== ORG).map(k => `root:${k}`);
}

/** The default scope is the configuration roots, until the user chooses. */
function applyDefaultWhere(): void {
  if (whereTouched || scope) return;
  const keys = configRootKeys();
  if (keys.length) filters.where = keys;
}

const isDefaultWhere = () => { const d = configRootKeys(); return !!d.length && d.length === filters.where.length && d.every(k => filters.where.includes(k)); };
const includesOrg = () => !filters.where.length || filters.where.some(k => k === `root:${ORG}` || k.startsWith('org:'));

function rootsOf(): WhereRoot[] {
  const idle = idleFacets();
  if (status?.roots?.length) return status.roots.map(r => ({ key: r.key, name: r.name, objects: idle ? idle.where[`root:${r.key}`] ?? 0 : r.objects, done: r.done }));
  // No index: every root of the server is listed, without a number (counts
  // come with results).
  return (serverRootList?.roots ?? []).map(r => ({ key: r.key, name: r.name }));
}

function menuTree(kind: MenuKind, filter = ''): TreeEntry[] {
  const idle = idleFacets();
  const o = shownOutcome();
  if (kind === 'kind') return kindTree(Object.keys(idle?.props ?? {}), o?.propCounts ?? idle?.props, o?.kindCounts ?? idle?.kinds, filters.props, filter);
  if (kind === 'type') return familyTree(Object.keys(idle?.types ?? {}), o?.typeCounts ?? idle?.types, filters.types, filter);
  return whereTree(rootsOf(), status?.orgs ?? serverRootList?.orgs ?? {}, o?.whereCounts ?? idle?.where, filters.where, filter);
}

function chosenOf(kind: MenuKind): string[] {
  return kind === 'kind' ? filters.props : kind === 'type' ? filters.types : filters.where;
}

function setChosen(kind: MenuKind, value: string[]): void {
  if (kind === 'kind') filters.props = value;
  else if (kind === 'type') filters.types = value;
  else { filters.where = value; whereTouched = true; if (value.length && scope) scope = null; }
  refreshReplace();
  if (request()) void search(); else renderAll();
}

function buttonText(kind: MenuKind): { text: string; on: boolean; words: string } {
  const m = MENUS[kind];
  if (kind === 'where' && scope) {
    const name = objName(scope.obj);
    return { text: `Under ${name}${scope.loading ? ' · listing…' : ''}`, on: true, words: `under ${name}` };
  }
  const chosen = chosenOf(kind);
  if (kind === 'where' && isDefaultWhere()) return { text: 'Configuration roots', on: false, words: 'the configuration roots (organisation instances not included)' };
  if (!chosen.length) return { text: m.any, on: false, words: m.any };
  const labels = chosenLabels(menuTree(kind), chosen);
  const list = labels.length ? labels : chosen;
  return { text: `${m.name}: ${list.length === 1 ? list[0] : `${list[0]} +${list.length - 1}`}`, on: true, words: list.join(', ') };
}

const objectsText = (n: number) => `${fmt(n)} ${n === 1 ? 'object' : 'objects'}`;

/** A menu button with a two-level, multi-select menu: groups with their
 *  counts (a group is chosen as a whole), the real entries one click deeper. */
function filterMenu(kind: MenuKind): HTMLElement {
  const m = MENUS[kind];
  const isOpen = openMenu === kind;
  const wrap = el('span', 'cs-menu-wrap');
  const bt = buttonText(kind);
  const b = chip([bt.text, icon('i-chev', 'ic-sm')], bt.on, () => {
    if (isOpen) closeMenu(); else { openMenu = kind; menuFilter = ''; focusMenu = true; if (!snapshot && indexUsable()) void ensureSnapshot().then(renderQa); }
    renderQa();
  });
  const menuId = `cs-menu-${kind}`;
  attrs(b, { 'aria-haspopup': 'menu', 'aria-expanded': String(isOpen), 'aria-controls': isOpen ? menuId : undefined, 'aria-label': `${m.name} filter: ${bt.words}`, 'data-fk': `trig-${kind}` });
  b.title = bt.on ? bt.words : m.tip;
  const clearable = isClearable(kind);
  // Backspace or Delete on the chip clears the filter, like its ×.
  b.addEventListener('keydown', e => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && clearable) { e.preventDefault(); clearFilter(kind, `trig-${kind}`); }
  });
  wrap.append(b);
  if (clearable) {
    wrap.classList.add('clearable');
    const x = btn('cs-chip-x', `Clear the ${m.name} filter`, () => clearFilter(kind, `trig-${kind}`), icon('i-x', 'ic-sm'));
    attrs(x, { 'data-fk': `clear-chip-${kind}` });
    if (bt.on) x.classList.add('on');
    wrap.append(x);
  }
  if (!isOpen) return wrap;
  const all = menuTree(kind);
  const tree = menuFilter ? menuTree(kind, menuFilter) : all;
  const counted = !!shownOutcome();
  const pop = el('div', 'ui-menu cs-menu');
  const size = all.reduce((n, e) => n + 1 + (e.children?.length ?? 0), 0);
  if (size > MENU_FILTER_FROM) {
    const f = attrs(el('input', 'cs-mf') as HTMLInputElement, {
      type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: `Filter ${m.plural}`,
      'aria-label': `Filter ${m.plural}`, 'aria-controls': menuId, 'data-fk': `filter-${kind}`,
    });
    f.value = menuFilter;
    f.addEventListener('input', () => { menuFilter = f.value; renderQa(); });
    pop.append(f);
  }
  const head = el('div', 'cs-mh cs-mh-row', el('span', 'grow', counted ? 'Objects with matches' : 'Objects with code'));
  // A plain "Clear" while something is ticked: the menu and its filter text stay.
  if (clearable) head.append(attrs(btn('cs-mclear', undefined, () => clearFilter(kind, `filter-${kind}`), 'Clear'), { 'data-fk': `clear-${kind}`, 'aria-label': `Clear the ${m.name} filter` }));
  pop.append(head);
  const list = attrs(el('div', 'cs-ml-list'), { role: 'menu', id: menuId, 'aria-label': m.name });
  const anyOn = !clearable;
  // The "any" row is clear-all: it unticks every entry (and an Under-object scope).
  if (!menuFilter) list.append(menuItem(kind, '', m.any, anyOn, undefined, 0, () => clearFilter(kind)));
  const rows = (entries: readonly TreeEntry[], depth: number) => {
    for (const e of entries) {
      const open = !!menuFilter || openGroups.has(`${kind}|${e.key}`);
      const it = menuItem(kind, e.key, e.label, e.on, e.n, depth, () => setChosen(kind, toggleEntry(chosenOf(kind), e)));
      const line = el('div', 'cs-mrow');
      line.dataset.depth = String(depth);
      if (e.children?.length) {
        const x = btn('cs-mx', open ? `Hide the entries of ${e.label}` : `Show the entries of ${e.label}`, ev => {
          ev.stopPropagation();
          const k = `${kind}|${e.key}`;
          if (openGroups.has(k)) openGroups.delete(k); else openGroups.add(k);
          renderQa();
          scopeSlot.querySelector<HTMLElement>(`[data-fk="x:${kind}:${CSS.escape(e.key)}"]`)?.focus();
        }, icon('i-chev', `ic-sm chev${open ? '' : ' closed'}`));
        attrs(x, { 'aria-expanded': String(open), 'data-fk': `x:${kind}:${e.key}`, tabindex: '-1' });
        line.append(x);
      } else line.append(el('span', 'cs-mx-sp'));
      line.append(it);
      list.append(line);
      if (e.children?.length && open) rows(e.children, depth + 1);
    }
  };
  rows(tree, 0);
  if (!tree.length) list.append(el('div', 'cs-mh', menuFilter ? `No ${m.plural} match “${menuFilter}”` : `No ${m.plural} yet`));
  if (kind === 'where' && !menuFilter) {
    const under = scope?.obj ?? context;
    if (under) list.append(menuItem(kind, 'scope:context', `Under ${objName(under)}`, !!scope, undefined, 0, () => { closeMenu(); filters.where = []; setScope(scope ? null : under); }));
    list.append(menuItem(kind, 'scope:pick', 'Under another object…', false, undefined, 0, () => { closeMenu(); startPick('scope'); }, false));
  }
  pop.append(list);
  pop.addEventListener('keydown', e => menuKey(e, pop, kind));
  wrap.append(pop);
  return wrap;
}

function menuItem(kind: MenuKind, key: string, label: string, on: boolean | 'some', n: number | undefined, depth: number, onClick: () => void, check = true): HTMLButtonElement {
  const it = btn(`cs-mi${on === true ? ' on' : ''}${n === 0 && !on ? ' none' : ''}`, undefined, onClick,
    attrs(el('span', 'ck', check && on ? icon(on === 'some' ? 'i-dash' : 'i-check', 'ic-sm') : ''), { 'aria-hidden': 'true' }), el('span', 'grow', label), n != null ? el('span', 'ui-id', fmt(n)) : '');
  attrs(it, {
    role: 'menuitemcheckbox', 'aria-checked': on === 'some' ? 'mixed' : String(!!on), 'aria-level': String(depth + 1),
    'aria-label': n != null ? `${label}, ${objectsText(n)}` : label, 'data-fk': `${kind}:${key}`, tabindex: '-1',
  });
  return it;
}

/** Arrow keys move through the menu (and up into its filter field), Right
 *  and Left open and close a group, Home and End jump, Escape closes the
 *  menu and returns to its button, Tab leaves. */
function menuKey(e: KeyboardEvent, pop: HTMLElement, kind: MenuKind): void {
  const items = [...pop.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
  const field = pop.querySelector<HTMLInputElement>('.cs-mf');
  const stops: HTMLElement[] = [...(field ? [field] : []), ...items];
  const i = stops.indexOf(document.activeElement as HTMLElement);
  const go = (n: number) => { e.preventDefault(); stops[Math.max(0, Math.min(stops.length - 1, n))]?.focus(); };
  const exp = (document.activeElement as HTMLElement | null)?.parentElement?.querySelector<HTMLElement>('.cs-mx');
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && exp && e.target !== field) {
    const open = exp.getAttribute('aria-expanded') === 'true';
    if ((e.key === 'ArrowRight') !== open) {
      e.preventDefault();
      const fk = (document.activeElement as HTMLElement).dataset.fk;
      exp.click();
      if (fk) scopeSlot.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]`)?.focus();
    }
  }
  else if (e.key === 'Home' && e.target !== field) go(field ? 1 : 0);
  else if (e.key === 'End' && e.target !== field) go(stops.length - 1);
  else if (e.key === 'Enter' && e.target === field) { e.preventDefault(); items.find(it => !it.dataset.fk?.endsWith(':'))?.click(); }
  else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    closeMenu(); renderQa();
    scopeSlot.querySelector<HTMLElement>(`[data-fk="trig-${kind}"]`)?.focus();
  } else if (e.key === 'Tab') { closeMenu(); queueMicrotask(renderQa); }
  else if (field && e.target !== field && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') field.focus();
}

/** Something is ticked in the menu (for Where: a place or an Under-object scope). */
function isClearable(kind: MenuKind): boolean {
  return chosenOf(kind).length > 0 || (kind === 'where' && !!scope);
}

/** Untick everything in one menu. An open menu stays open with its filter
 *  text; focus goes to `focusKey` (else stays where the row rebuild puts it). */
function clearFilter(kind: MenuKind, focusKey?: string): void {
  if (kind === 'where') scope = null;
  setChosen(kind, []);
  const to = focusKey ? scopeSlot.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focusKey)}"]`) : null;
  (to ?? (openMenu === kind ? scopeSlot.querySelector<HTMLElement>('.cs-mf, [role="menuitemcheckbox"]') : null))?.focus();
}

function closeMenu(): void {
  openMenu = null;
  menuFilter = '';
}

/** A filter list set from a chip or a hint (types, props). */
function setFilter(list: 'types' | 'props' | 'where', value: string[]): void {
  setChosen(list === 'types' ? 'type' : list === 'props' ? 'kind' : 'where', value);
}

function setScope(obj: CodeSearchObject | null): void {
  // Under an object replaces the Where choice.
  if (obj) filters.where = [];
  if (!obj) { scope = null; refreshReplace(); if (request()) void search(); else renderAll(); return; }
  const s: NonNullable<typeof scope> = { obj, loading: true };
  scope = s;
  renderAll();
  void (async () => {
    try {
      const res = await sendRequestBounded<Msg<'CODE_SEARCH_SCOPE_RESULT'>>({ type: 'CODE_SEARCH_SCOPE', rid: obj.rid, ...(status?.environment ? { environment: status.environment } : {}) }, { timeoutMs: 90_000 });
      if (scope !== s) return;
      if (res?.type !== 'CODE_SEARCH_SCOPE_RESULT' || !res.ok) { s.loading = false; s.error = res?.type === 'CODE_SEARCH_SCOPE_RESULT' && res.error ? res.error : 'The scope could not be listed.'; renderAll(); return; }
      s.obj = { ...obj, ...res.object };
      s.rids = new Set(res.rids ?? []);
      s.covered = res.covered;
      s.loading = false;
    } catch (e) {
      if (scope !== s) return;
      s.loading = false;
      s.error = e instanceof Error ? e.message : String(e);
    }
    refreshReplace();
    if (request()) void search(); else renderAll();
  })();
}

/** The shared object picker (lib/object-picker), built once per pick so
 *  its field keeps focus and text across renders. */
let pickerBox: HTMLElement | null = null;
let picker: ObjectPicker | null = null;

const pickerSource: ObjectPickerSource = {
  // The shared object search: exact RID or ID, the local code index, the
  // server by name and ID, the portal search (lib/object-search.ts).
  search: pickerSearch(`codesearch:${WIN_ID}`),
  async resolve(text) {
    const res = await sendRequestBounded<Msg<'CODE_SEARCH_RESOLVE_RESULT'>>({ type: 'CODE_SEARCH_RESOLVE', text }, { timeoutMs: 20_000 });
    if (res?.type !== 'CODE_SEARCH_RESOLVE_RESULT' || !res.ok || !res.object) return { error: res?.type === 'CODE_SEARCH_RESOLVE_RESULT' && res.error ? res.error : 'No answer' };
    return res.object;
  },
  async suggestions() {
    let recent: PickerObject[] = [];
    try {
      const res = await sendRequestBounded<Msg<'HISTORY_DATA'>>({ type: 'GET_HISTORY' }, { timeoutMs: 5_000 });
      if (res?.type === 'HISTORY_DATA') {
        const seen = new Set<string>();
        for (const e of res.entries) {
          if (seen.has(e.rid) || !/^-?\d{1,20}$/.test(e.rid)) continue;
          seen.add(e.rid);
          recent.push({ rid: e.rid, name: e.name, type: e.type, businessId: e.businessId });
          if (recent.length >= 8) break;
        }
      }
    } catch { recent = []; }
    return { current: context, recent };
  },
};

function startPick(kind: 'scope' | 'target'): void {
  closePick();
  picking = { kind, text: '' };
  picker = createObjectPicker({
    source: pickerSource,
    label: kind === 'scope' ? 'Object to search under' : 'Object to look up in code',
    placeholder: 'Name, ID or RID',
    typeLabel,
    onPick: obj => {
      closePick();
      if (kind === 'scope') setScope(obj);
      else { target = obj; void search(); }
      renderQa();
    },
    onCancel: () => { closePick(); renderQa(); input.focus(); },
  });
  pickerBox = el('div', 'cs-pick', el('div', 'cs-pick-h', el('span', '', kind === 'scope' ? 'Search under' : 'Used in code for'), el('span', 'grow'),
    btn('ui-tbtn', undefined, () => { closePick(); renderQa(); }, 'Cancel')), picker.el);
  renderQa();
  picker.focus();
}

function closePick(): void {
  picker?.destroy();
  picker = null;
  pickerBox = null;
  picking = null;
}

// ── rendering: results ────────────────────────────────────────────

function renderLine(text: string, ranges: ReadonlyArray<readonly [number, number]>, hot = true): HTMLElement {
  const out = el('span', 'cc');
  const marks = hot ? [...ranges].sort((a, b) => a[0] - b[0]) : [];
  const mark = (i: number) => { const mk = el('mark', ''); mk.dataset.m = String(i); return mk; };
  out.append(...renderCodeLine(text, { layers: [{ ranges: marks, wrap: mark }] }));
  return out;
}

/** A match line without its indentation (the ranges move with it). */
function trimmedLine(text: string, ranges: ReadonlyArray<readonly [number, number]>): HTMLElement {
  const lead = text.length - text.trimStart().length;
  const cut = Math.min(lead, ...ranges.map(r => r[0]));
  return renderLine(text.slice(cut).replace(/\s+$/, ''), ranges.map(([a, b]) => [a - cut, b - cut] as const));
}

function renderSummary(): void {
  const o = run?.outcome;
  if (!run || (!o && !run.hits.length)) { sumEl.replaceChildren(); sumEl.hidden = true; return; }
  sumEl.hidden = false;
  const kids: Kid[] = [];
  if (o) {
    kids.push(el('span', '', el('b', '', summaryText(o, searchMode()))));
    if (fold && o.rows < o.matchedObjects) kids.push(el('span', 'cs-muted', `in ${fmt(o.rows)} ${o.rows === 1 ? 'row' : 'rows'}`));
    if (o.more || (o.coverage.searched < o.coverage.total)) kids.push(el('span', 'cs-muted', o.more ? `showing ${fmt(Math.min(run.hits.length, o.matchedObjects))}` : `in ${fmt(o.coverage.searched)} of ${fmt(o.coverage.total)} objects`));
    if (mode === 'refs') kids.push(el('span', 'grow'), el('span', 'cs-muted', 'Comments and strings do not count'));
  } else {
    kids.push(el('span', '', `${fmt(run.hits.length)} ${run.hits.length === 1 ? 'object' : 'objects'} so far`));
  }
  if (o && o.matchedObjects > 1) {
    const seg = attrs(el('span', 'cs-seg'), { role: 'group', 'aria-label': 'Sort objects by' });
    for (const [k, label, tip] of [['matches', 'Most matches', 'Most matches first'], ['name', 'Name', 'Sorted by name'], ['location', 'Folder', 'Folder: sorted by the two folders above the object']] as const) {
      const on = currentSort() === k;
      const b = btn(on ? 'on' : '', tip, () => { sortBy = k; void search(true); }, label);
      b.setAttribute('aria-pressed', String(on));
      seg.append(b);
    }
    if (mode === 'refs') kids.push(el('span', 'cs-muted', 'Sort by'), seg); else kids.push(el('span', 'grow'), el('span', 'cs-muted', 'Sort by'), seg);
  }
  if (o) {
    const f = chip('Fold instances', fold, () => {
      fold = !fold;
      try { localStorage.setItem(FOLD_KEY, fold ? 'on' : 'off'); } catch { /* storage blocked */ }
      void search(true);
    }, 'Show instances whose code is their template\'s in the template\'s row');
    f.classList.add('cs-fold');
    kids.push(f);
  }
  if (mode === 'text') {
    if (!(o && o.matchedObjects > 1)) kids.push(el('span', 'grow'));
    kids.push(
      btn('ui-ibtn', 'Collapse all objects', () => { for (const h of run?.hits ?? []) collapsed.add(h.rid); renderResults(); }, icon('i-colall')),
      btn('ui-ibtn', 'Expand all objects', () => { collapsed.clear(); renderResults(); }, icon('i-expall')),
      btn('ui-ibtn', 'Copy the objects as a table', ev => copyTable(ev.currentTarget as HTMLElement), icon('i-copy')));
  }
  sumEl.replaceChildren(...kids.filter((k): k is Node | string => !!k));
}

function copyTable(b: HTMLElement): void {
  const rows = [['Type', 'ID', 'Name', 'RID', 'Matches'], ...(run?.hits ?? []).map(h => [h.type, h.businessId, h.name, h.rid, String(h.matches)])];
  void copyWithFeedback(rows.map(r => r.join('\t')).join('\n'), b, { failClass: 'copy-failed' });
}

function renderResults(): void {
  sumEl.classList.toggle('rp-sum', mode === 'replace');
  resEl.setAttribute('role', mode === 'replace' ? 'group' : 'tree');
  if (mode === 'replace') {
    rep.renderSummary(sumEl);
    rep.renderResults(resEl);
    return;
  }
  renderSummary();
  resEl.classList.toggle('stale', stale);
  resEl.setAttribute('aria-busy', String(!!run?.searching));
  const kids: Node[] = [];
  if (connection && !run?.hits.length) {
    groupNodes = new WeakMap();
    kids.push(el('div', 'cs-center', icon('i-plug', 'ic-big'), el('h3', '', connection.label === 'No server' ? 'Not connected to a server' : connection.label),
      el('span', '', connection.sentence, ' The search reads the server you are connected to.'),
      btn('ui-btn primary', undefined, () => { void refreshConnection(true); }, 'Retry')));
    resEl.replaceChildren(...kids);
    return;
  }
  if (!run) { resEl.replaceChildren(...startScreen()); return; }
  if (groupsOf !== run) { groupsOf = run; groupNodes = new WeakMap(); }
  if (instantOpen) kids.push(instantPanel());
  // The pattern could not be searched: what is shown is the previous search.
  if (patternError) kids.push(attrs(el('div', 'cs-note cs-prev', icon('i-info'), el('span', '', 'These results are from the previous search: ', el('b', '', run.label.replace(/^Search: /, '')), '.')), { role: 'status' }));
  if (run.error) {
    const stopped = isQuietEnd(run.error);
    const query = /^(Not a valid regular expression|Enter something|Choose the object)/.test(run.error);
    // A stop is not an error: the plain note, and a way to run it again.
    kids.push(stopped
      ? attrs(el('div', 'cs-note', icon('i-info'), el('span', '', el('b', '', run.error))), { role: 'status' })
      : attrs(el('div', 'cs-note err', icon('i-warn'), el('span', '', el('b', '', query ? 'Check the query. ' : 'The search stopped. '), run.error)), { role: 'alert' }));
    const detailsBtn = btn('ui-btn', undefined, ev => { const t = ev.currentTarget as HTMLElement; void copyWithFeedback(`${run?.label}\n${run?.error}`, t, { textTarget: t, failClass: 'copy-failed' }); }, 'Copy details');
    // Too much code on this server to search this way: the local copy is the way.
    const needsCopy = run.error === NEEDS_INDEX_TEXT;
    kids.push(el('div', 'cs-actions', needsCopy
      ? btn('ui-btn primary', undefined, () => { instantOpen = true; void loadEstimate(); renderResults(); }, 'Keep a copy on this computer')
      : btn('ui-btn primary', undefined, () => { void refreshConnection().then(() => { if (!connection) void search(false, true); }); }, stopped ? 'Search again' : 'Retry'),
      ...(stopped || needsCopy ? [] : [detailsBtn])));
    if (run.hits.length) kids.push(el('div', 'cs-sub-h', stopped ? 'Found so far' : 'Found before it stopped'));
  }
  const o = run.outcome;
  if (o && (o.more || !o.coverage.complete) && run.hits.length) kids.push(capNote(o));
  if (o && !scope && !includesOrg()) {
    kids.push(el('div', 'cs-quiet cs-orgnote', 'Organisation instances not searched · ',
      btn('cs-link', 'Search the organisation root too', () => setChosen('where', [...filters.where, `root:${ORG}`]), 'Include')));
  }
  for (const h of run.hits) kids.push(...group(h));
  if (o?.more) {
    kids.push(el('div', 'cs-loadmore', btn('ui-btn', undefined, () => showMore(), `Show ${fmt(Math.min(PAGE_ROWS, o.rows - run.hits.length))} more ${fold ? 'rows' : 'objects'}`),
      el('span', 'cs-muted', `${fmt(run.hits.length)} of ${fmt(o.rows)} shown`)));
  }
  if (o && !o.matchedObjects && !run.error) kids.push(noResults(o));
  if (!o && !run.hits.length && run.searching) kids.push(el('div', 'cs-quiet', 'Searching…'));
  // Groups already drawn stay in place (their nodes are kept per hit):
  // only new and changed ones are built and inserted.
  reconcileChildren(resEl, kids);
  updateSelection();
}

/** The next page of rows, from the rows already here: no search. */
function showMore(): void {
  if (!run?.outcome) return;
  run.list.showMore();
  run.outcome = run.list.outcome;
  renderAll();
}

function capNote(o: CodeSearchOutcome): HTMLElement {
  const shown = run!.hits.length;
  const head = o.more
    ? `First ${fmt(shown)} of ${fmt(o.rows)} ${fold && o.rows < o.matchedObjects ? 'rows' : 'objects'}.`
    : `Searched ${fmt(o.coverage.searched)} of ${fmt(o.coverage.total)} objects.`;
  const tail = o.more ? ' Show more below, or narrow the search.' : o.coverage.pending ? ' The copy is still being made; the results grow as it fills.' : ' Some objects could not be read.';
  const chips = o.more && mode === 'text' ? kindChips(o) : [];
  for (const c of chips) c.setAttribute('aria-label', c.title);
  if (o.more && mode === 'text' && !opts.wholeWord) chips.push(chip('Whole words only', false, () => setOpt('wholeWord')));
  return el('div', 'cs-note cap', icon('i-warn'), el('span', '', el('b', '', head), tail), el('span', 'grow'), ...chips);
}

/** Chips of the most frequent kinds of code of the results: one click
 *  narrows to that kind's properties. */
function kindChips(o: CodeSearchOutcome): HTMLButtonElement[] {
  return topKinds(o.kindCounts, filters.props).map(k => {
    const props = Object.keys(o.propCounts).filter(p => kindOfProp(p) === k.kind);
    return chip([k.label, el('span', 'n', fmt(k.n))], false, () => setFilter('props', props), `Only ${k.label}: ${fmt(k.n)} ${k.n === 1 ? 'object' : 'objects'}`);
  });
}

function noResults(o: CodeSearchOutcome): HTMLElement {
  const where = scope ? ` in ${objName(scope.obj)}` : '';
  const what: Array<string | HTMLElement> = mode === 'refs'
    ? [`No code calls ${target ? objName(target) : 'this object'}. ${coverageText(o.coverage, Date.now(), run?.indexState, undefined, feedNow)} Comments and strings do not count; relations that are not code are under “Used by › By reference” in the object window.`]
    : ['Looked for ', el('code', 'cs-qcode', query), ` (${[opts.caseSensitive ? 'match case' : 'ignore case', opts.wholeWord ? 'whole word' : '', opts.regex ? 'pattern' : ''].filter(Boolean).join(', ')}) in ${['where', 'kind', 'type'].map(k => buttonText(k as MenuKind)).filter(b => b.on).map(b => b.words).join(', ') || 'all code'}${where}. ${coverageText(o.coverage, Date.now(), run?.indexState, o.ms, feedNow)}`];
  const hints: HTMLElement[] = [];
  if (scope) hints.push(chip('Search everywhere', false, () => setScope(null)));
  if (mode === 'text' && opts.caseSensitive) hints.push(chip('Ignore case', false, () => setOpt('caseSensitive')));
  if (mode === 'text' && opts.wholeWord) hints.push(chip('Not only whole words', false, () => setOpt('wholeWord')));
  if (filters.where.length) hints.push(chip('Everywhere', false, () => setFilter('where', [])));
  if (mode === 'text' && filters.props.length) hints.push(chip('Any kind of code', false, () => setFilter('props', [])));
  if (mode === 'text' && filters.types.length) hints.push(chip('Any type', false, () => setFilter('types', [])));
  return emptyState({ title: `No matches${where}`, titleTag: 'h3', className: 'cs-empty', text: what, actions: hints.length ? hints : null });
}

/** The nodes of each drawn group, with the state they were drawn in. */
let groupNodes = new WeakMap<CodeSearchHit, { sig: string; nodes: Node[] }>();
let groupsOf: Run | null = null;

/** What a group's drawing depends on (selection is set on the rows after). */
function groupSig(h: CodeSearchHit): string {
  // Place names come from the roots and organisations known so far.
  const names = `${status?.roots?.length ?? 0}/${Object.keys(status?.orgs ?? {}).length}`;
  const parts = [names, collapsed.has(h.rid) ? 'c' : '', openInstances.has(h.rid) ? 'i' : '', allLines.has(h.rid) ? 'a' : ''];
  if (!collapsed.has(h.rid)) {
    for (const { prop, line } of visibleLines(h, allLines.has(h.rid))) {
      const key = rowKey(h.rid, prop, line.line);
      if (!contextOpen.has(key)) continue;
      const more = contextMore.get(key);
      parts.push(`${key}/${more?.above ?? ''}/${more?.below ?? ''}/${fullCode.has(codeKey(h.rid, prop)) ? 'f' : ''}`);
    }
  }
  return parts.join('|');
}

function group(h: CodeSearchHit): Node[] {
  const sig = groupSig(h);
  const kept = groupNodes.get(h);
  if (kept && kept.sig === sig) return kept.nodes;
  const nodes = buildGroup(h);
  groupNodes.set(h, { sig, nodes });
  return nodes;
}

function buildGroup(h: CodeSearchHit): Node[] {
  const isCollapsed = collapsed.has(h.rid);
  const gid = `g-${h.rid}`;
  const inst = h.instances?.length ?? 0;
  const instOpen = openInstances.has(h.rid);
  const instBtn = inst ? btn('cs-inst', instOpen ? 'Hide the instances' : 'List the instances with this code', e => {
    e.stopPropagation();
    if (openInstances.has(h.rid)) openInstances.delete(h.rid); else openInstances.add(h.rid);
    renderResults();
  }, `+ ${fmt(inst)} ${inst === 1 ? 'instance' : 'instances'}`) : null;
  if (instBtn) instBtn.setAttribute('aria-expanded', String(instOpen));
  const head = attrs(el('div', 'cs-gh', icon('i-chev', `chev${isCollapsed ? ' closed' : ''}`), tile(h.type),
    el('span', 'gn', el('span', 'nm', h.name || h.businessId || '(unnamed)'), h.businessId ? el('span', 'ui-id', h.businessId) : '', el('span', 'ty', typeLabel(h.type)),
      h.overridden ? attrs(el('span', 'cs-ovr', 'overridden'), { title: 'An instance of a template with code of its own' }) : '', instBtn),
    el('span', 'wh', placeText(h)), el('span', 'ct', fmt(h.matches))), {
    id: gid, role: 'treeitem', 'aria-level': '1', 'aria-expanded': String(!isCollapsed),
    'aria-label': `${h.name || h.businessId}, ${typeLabel(h.type)}, ${h.where}, ${h.matches} ${h.matches === 1 ? 'match' : 'matches'}`,
  });
  head.title = `${typeLabel(h.type)} · ${h.name}${h.where ? ` · ${h.where}` : ''}`;
  head.addEventListener('click', () => { if (collapsed.has(h.rid)) collapsed.delete(h.rid); else collapsed.add(h.rid); renderResults(); });
  const out: Node[] = [head];
  if (inst && instOpen) out.push(instanceList(h.instances!));
  if (isCollapsed) return out;
  const showAll = allLines.has(h.rid);
  const lines = visibleLines(h, showAll);
  for (const { prop, line } of lines) {
    const key = rowKey(h.rid, prop, line.line);
    const sel = key === selected;
    const row = attrs(el('div', `cs-ml${sel ? ' sel' : ''}`, el('span', 'ln', String(line.line)), attrs(el('span', 'pp', propLabel(prop)), { title: propHelp(prop) }),
      trimmedLine(line.text, line.ranges),
      el('span', 'go', line.form ? el('span', 'form', line.form) : '', el('span', 'open', 'Open'), kbd('Enter'))), {
      id: `r-${CSS.escape(key).replace(/[^A-Za-z0-9_-]/g, '_')}`, role: 'treeitem', 'aria-level': '2', 'aria-selected': String(sel),
      'aria-label': `Line ${line.line}, ${propLabel(prop)}: ${line.text.trim().slice(0, 120)}`,
    });
    row.dataset.key = key;
    row.addEventListener('click', e => {
      if (selected === key && !e.detail) return;
      selected = key;
      // "Open" on the selected row opens with one click, like Enter.
      if (e.detail >= 2 || (e.target as Element | null)?.closest?.('.open')) { open(key, e.altKey); return; }
      updateSelection();
    });
    out.push(row);
    if (contextOpen.has(key)) out.push(contextBlock(h, prop, line.line, line.ranges, key));
  }
  const total = h.props.reduce((n, p) => n + p.lines.length, 0);
  if (!showAll && total > LINES_SHOWN) {
    out.push(el('div', 'cs-more', btn('', undefined, () => { allLines.add(h.rid); renderResults(); }, `${fmt(total - LINES_SHOWN)} more ${total - LINES_SHOWN === 1 ? 'line' : 'lines'}`)));
  } else if (showAll && total >= 200) {
    out.push(el('div', 'cs-more', el('span', '', 'The first 200 lines are listed; open the object to see the rest')));
  }
  return out;
}

/** The instances folded into a row: name, place; a click opens one. */
function instanceList(list: readonly FoldedInstance[]): HTMLElement {
  const box = attrs(el('div', 'cs-insts'), { role: 'group', 'aria-label': 'Instances with this code' });
  for (const i of list) {
    const place = i.path?.length ? i.path.map(r => status?.orgs?.[r]?.name ?? r).join(' › ') : i.where;
    const row = btn('cs-irow', `Open ${i.name || i.businessId}`, () => openObject(i.rid, i, {
      origin: { kind: 'search', label: run?.label ?? labelOf(), mode: searchMode(), ...(mode === 'text' ? { query } : {}) },
    }), el('span', 'nm', i.name || i.businessId || i.rid), i.businessId ? el('span', 'ui-id', i.businessId) : '', el('span', 'wh', place));
    box.append(row);
  }
  return box;
}

/** Full property text read for a wider context: rid|prop → its lines. */
const fullCode = new Map<string, string[]>();
const fullLoading = new Set<string>();
const codeKey = (rid: string, prop: string) => `${rid}|${prop}`;

/** The lines a hit carries for one property: the matched lines kept whole
 *  and the lines around them. */
function carriedLines(h: CodeSearchHit, prop: string): Map<number, string> {
  const p = h.props.find(x => x.prop === prop);
  const out = new Map<number, string>(p?.around ?? []);
  for (const l of p?.lines ?? []) if (!out.has(l.line) && isWholeLine(l)) out.set(l.line, l.text);
  return out;
}

/** Read the full text of a property (the index copy, or one small request to
 *  the server), then draw the group again. */
function loadFullCode(h: CodeSearchHit, prop: string): void {
  const k = codeKey(h.rid, prop);
  if (fullCode.has(k) || fullLoading.has(k)) return;
  if (run?.source === 'index' && snapshot) {
    const byRid = snapshotIndex();
    const o = byRid.get(h.rid);
    if (o) { fullCode.set(k, (effectiveObject(o, byRid).code[prop] ?? '').split(/\r?\n/)); return; }
  }
  fullLoading.add(k);
  void (async () => {
    try {
      const r = await sendRequestBounded<Msg<'CODE_SEARCH_CODE_RESULT'>>({ type: 'CODE_SEARCH_CODE', rid: h.rid, prop, ...(ownEnvironment ? { environment: ownEnvironment } : {}) }, { timeoutMs: 30_000 });
      if (r?.type === 'CODE_SEARCH_CODE_RESULT' && r.ok && typeof r.code === 'string') fullCode.set(k, r.code.split(/\r?\n/));
    } catch { /* the block keeps the carried lines */ } finally { fullLoading.delete(k); scheduleRender(); }
  })();
}

let snapshotByRid: { key: string; byRid: Map<string, SearchableObject> } | null = null;
function snapshotIndex(): Map<string, SearchableObject> {
  if (!snapshot) return new Map();
  if (snapshotByRid?.key !== snapshot.key) snapshotByRid = { key: snapshot.key, byRid: new Map(snapshot.objects.map(o => [o.rid, o])) };
  return snapshotByRid.byRid;
}

function contextBlock(h: CodeSearchHit, prop: string, line: number, ranges: ReadonlyArray<readonly [number, number]>, key: string): HTMLElement {
  // The index copy is here: its text is read at once (hits of a local
  // search carry no context of their own).
  if (run?.source === 'index') loadFullCode(h, prop);
  const lineCount = h.props.find(p => p.prop === prop)?.lineCount ?? line;
  const full = fullCode.get(codeKey(h.rid, prop));
  const more = contextMore.get(key) ?? { above: CONTEXT_LINES, below: CONTEXT_LINES };
  const from = Math.max(1, line - more.above);
  const to = Math.min(full?.length ?? lineCount, line + more.below);
  const carried = full ? null : carriedLines(h, prop);
  // Lines beyond what the hit carries: the full text is read once.
  if (carried) {
    for (let n = from; n <= to; n++) if (!carried.has(n)) { loadFullCode(h, prop); break; }
  }
  const block = el('div', 'cs-code');
  for (let n = from; n <= to; n++) {
    const text = full ? full[n - 1] ?? '' : carried!.get(n);
    if (text == null) { block.append(el('div', 'cl', el('span', 'n', String(n)), el('span', 'cc cs-muted', 'Reading the code…'))); continue; }
    const hot = n === line;
    // The match line shows its marks (computed on the full line).
    const lineRanges = hot && !h.props.find(p => p.prop === prop)?.lines.find(l => l.line === line)?.cut ? ranges : [];
    block.append(el('div', `cl${hot ? ' hot' : ''}`, el('span', 'n', String(n)), renderLine(text, lineRanges)));
  }
  const widen = (d: 'above' | 'below') => { contextMore.set(key, { ...more, [d]: more[d] + 12 }); renderResults(); };
  return el('div', 'cs-cx', block, el('div', 'cf',
    from > 1 ? btn('', undefined, () => widen('above'), 'Show more above') : '',
    to < (full?.length ?? lineCount) ? btn('', undefined, () => widen('below'), 'Show more below') : '',
    el('span', 'grow'),
    btn('', `Open ${prop} in the floating editor (Alt+Enter)`, () => open(key, true), 'Floating editor'),
    el('span', '', `Open at line ${line}`), kbd('Enter')));
}

// ── start screen ──────────────────────────────────────────────────

/** "Keep a copy on this computer": the index panel, opened by the user. */
let instantOpen = false;
let estimate: { value?: CodeCopyEstimate; error?: string } | null = null;

async function loadEstimate(): Promise<void> {
  if (estimate && !estimate.error) return;
  estimate = null;
  renderResults();
  try {
    const r = await sendRequestBounded<Msg<'CODE_INDEX_ESTIMATE_RESULT'>>({ type: 'CODE_INDEX_ESTIMATE' }, { timeoutMs: 120_000 });
    estimate = r?.type === 'CODE_INDEX_ESTIMATE_RESULT' && r.ok && r.estimate ? { value: r.estimate } : { error: r?.type === 'CODE_INDEX_ESTIMATE_RESULT' ? r.error ?? 'No answer' : 'No answer' };
  } catch (e) { estimate = { error: e instanceof Error ? e.message : String(e) }; }
  renderResults();
}

function instantPanel(): HTMLElement {
  const box = el('div', 'cs-instant');
  box.append(el('h3', '', 'Keep a copy on this computer'),
    el('p', '', 'A copy saves this server\'s Extended Code on this computer. Searches then start at once, also after the browser restarts. Without it, the code is read from the server at the first search and kept only while this window is open; a server with very much code is narrowed on the server first.'),
    el('p', '', 'The copy is made with the same read as a search, paced so the server keeps working. It does not change by itself: Refresh in the footer asks the server what changed and reads only that.'));
  if (!estimate) { box.append(el('p', 'cs-muted', 'Listing the code on the server, as a search does…')); return box; }
  if (estimate.error) box.append(el('p', 'cs-muted', `The cost could not be estimated: ${estimate.error}`));
  const e = estimate.value;
  if (e) {
    const failed = e.failedSources?.length ? ` Not listed: ${e.failedSources.join(', ')}.` : '';
    const how = e.perSource ? ' Too much code to read in one go: it is read source by source.' : '';
    box.append(el('div', 'cs-instant-row', el('span', 'grow', `${plural(e.objects, 'object')} with code (${charsText(e.chars)} characters) · about ${plural(e.posts, 'request')}, ${durationText(e.seconds)}.${how}${failed}`),
      btn('ui-btn primary', 'Make a copy of this server\'s code on this computer', () => { instantOpen = false; void syncIndex(status?.state === 'ready', true); }, status?.state === 'ready' ? 'Make again' : 'Make copy')));
  }
  if (status && status.state !== 'none') {
    box.append(el('div', 'cs-instant-row', el('span', 'grow cs-muted', 'Remove the copy on this computer. Searches then read the code from the server again.'),
      btn('ui-btn', 'Delete the copy of this server\'s code on this computer', () => { instantOpen = false; void removeIndex(); }, 'Remove copy')));
  }
  return box;
}

async function removeIndex(): Promise<void> {
  try {
    const r = await sendRequestBounded<Msg<'CODE_INDEX_STATUS'>>({ type: 'CODE_INDEX_REMOVE' }, { timeoutMs: 20_000 });
    snapshot = null;
    if (r?.type === 'CODE_INDEX_STATUS') onStatus(r.status);
  } catch { /* the status broadcast follows */ }
  renderAll();
}

function startScreen(): Node[] {
  const out: Node[] = [];
  if (instantOpen) out.push(instantPanel());
  if (mode === 'refs' && !target) {
    out.push(emptyState({
      title: 'Used in code', titleTag: 'h3', className: 'cs-empty',
      text: 'Lists the places in Extended Code that call an object: t.id, t.get("id"), {id} and lookup(RID); comments and strings do not count. Choose the object above.',
      // the mascot only when nothing follows (recent searches, this object)
      art: recents.length || context || instantOpen ? false : 'md',
    }));
  }
  if (recents.length) {
    out.push(el('div', 'cs-sub-h', el('span', 'grow', 'Recent searches'), btn('cs-link', undefined, () => { recents = []; saveRecents(); renderResults(); }, 'Clear')));
    for (const r of recents) {
      const row = el('div', 'cs-rec', icon(r.mode === 'refs' ? 'i-refs' : 'i-clock'),
        el('span', 'q', el('span', 'qq', r.mode === 'refs' ? (r.target?.name || r.query) : r.query), el('span', 'op', r.mode === 'refs' ? 'Used in code' : optionsText(r))),
        el('span', 'rc', r.matches != null ? (r.mode === 'refs' ? `${fmt(r.matches)} places` : `${fmt(r.matches)} matches`) : ''),
        btn('ui-ibtn x', 'Remove from recent searches', e => { e.stopPropagation(); recents = removeRecent(recents, r); saveRecents(); renderResults(); }, icon('i-x')));
      attrs(row, { role: 'button', tabindex: '0', 'aria-label': r.mode === 'refs' ? `Again: used in code, ${r.target?.name || r.query}` : `Search again: ${r.query}, ${optionsText(r)}` });
      const go = () => applyRecent(r);
      row.addEventListener('click', go);
      row.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); } });
      out.push(row);
    }
  }
  if (context) {
    out.push(el('div', 'cs-sub-h', 'From this object'));
    const refRow = el('div', 'cs-rec', icon('i-refs'), el('span', 'q', 'Used in code: ', el('b', '', objName(context)), ' ', context.businessId ? el('span', 'ui-id', context.businessId) : ''), el('span', ''), el('span', ''));
    const underRow = el('div', 'cs-rec', icon('i-tree'), el('span', 'q', 'Search under ', el('b', '', objName(context)), ' ', context.businessId ? el('span', 'ui-id', context.businessId) : ''), el('span', ''), el('span', ''));
    for (const [row, go] of [[refRow, () => { target = context; setMode('refs'); if (mode === 'refs') void search(); }], [underRow, () => { setMode('text'); setScope(context); input.focus(); }]] as const) {
      attrs(row, { role: 'button', tabindex: '0' });
      row.addEventListener('click', go);
      row.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); } });
      out.push(row);
    }
  }
  if (!out.length) {
    const covered = status?.codeTypes ? ` It covers every property that holds Extended Code: ${fmt(status.codeProps ?? 0)} properties of ${fmt(status.codeTypes)} types on this server, plus visualization scripts and text element bodies.` : '';
    out.push(emptyState({ title: 'Search Extended Code', titleTag: 'h3', className: 'cs-empty', text: `Finds text in Extended Code on this server.${covered} Matches open in the object window on their line.` }));
  }
  return out;
}

function applyRecent(r: RecentSearch): void {
  mode = r.mode;
  opts.caseSensitive = r.caseSensitive; opts.wholeWord = r.wholeWord; opts.regex = r.regex;
  filters.types = r.mode === 'text' ? [...r.types] : [];
  filters.props = r.mode === 'text' ? [...r.props] : [];
  filters.where = (r.where ?? []).map(w => w.key);
  whereTouched = true;
  if (r.mode === 'refs' && r.target) target = r.target;
  else { query = r.query; input.value = r.query; }
  if (r.scope && r.scope.rid !== scope?.obj.rid) { setScope(r.scope); return; }
  if (!r.scope) scope = null;
  void search();
}

// ── status bar ────────────────────────────────────────────────────

/** A search without an index: its listing posts first (a fifth of the bar), then the reads. */
function searchFraction(p: CodeSearchProgress): number {
  const scan = p.posts ? p.postsDone / p.posts : 0;
  const read = p.reading === 'all' && p.total && p.searched != null ? p.searched / p.total : p.candidates ? p.read / p.candidates : 0;
  return p.phase === 'scan' ? 0.2 * scan : 0.2 + 0.8 * read;
}

function renderStatus(): void {
  const facts: Kid[] = mode === 'replace' ? rep.facts() : [];
  if (run?.searching && run.list.progress) facts.push(el('span', 'cov', progressText(run.list.progress)));
  if (run?.outcome) facts.push(el('span', 'cov', coverageText(run.outcome.coverage, Date.now(), run.indexState, run.outcome.ms, feedNow)));
  // Enter opens the selected hit: this repeats an unchanged search.
  if (run && !run.searching && request()) facts.push(attrs(btn('cs-link cs-again', withShortcut('Check the server for changed code and search again', 'codesearch.again'), () => { void search(false, true); }, 'Search again'), { 'data-fk': 'again' }));
  // What the scope covered: the tree and the references the object window follows.
  if (run?.outcome && scope?.rids) facts.push(el('span', 'cov', scopeText(objName(scope.obj), scope.covered)));
  // Without an index, the sentence that explains it belongs to the empty
  // state; once a search ran, the link below carries it as its tooltip.
  // The Replace tab says only whose copy it works on; Refresh follows below.
  if (status && mode === 'replace' && (status.state === 'ready' || status.state === 'refreshing') && status.syncedAt) {
    facts.push(el('span', 'idx', `Copy of ${new Date(status.syncedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`));
  } else if (status && !(run && status.state === 'none')) facts.push(el('span', 'idx', indexText(status)));
  if (mode !== 'replace' && status && (status.state === 'none' || (status.state === 'ready' && !status.roots?.some(r => r.key === ORG))) && !connection) {
    const tip = status.state === 'none'
      ? `${indexText(status)} Keep a copy on this computer: what it gives and what it costs.`
      : 'Save a copy of this server\'s code on this computer: what it gives and what it costs';
    facts.push(btn('cs-link', tip, () => { instantOpen = !instantOpen; if (instantOpen) void loadEstimate(); renderResults(); }, status.state === 'none' ? 'Keep a copy on this computer' : 'Copy options'));
  }
  if (status && status.state !== 'unavailable' && status.state !== 'none' && !connection) {
    const st = status.state;
    facts.push(st === 'building' ? btn('cs-link', 'Stop copying (it can be resumed)', () => sendFireForget({ type: 'CODE_INDEX_CANCEL' }), 'Stop')
      : st === 'refreshing' ? btn('cs-link', status.copy ? 'Stop the refresh; the copy stays as it is' : 'Stop copying (it can be resumed)', () => sendFireForget({ type: 'CODE_INDEX_CANCEL' }), 'Stop')
      : st === 'paused' ? btn('cs-link', 'Continue making the copy', () => { void syncIndex(false, true); }, 'Resume')
      : btn('cs-link', status.copy ? 'Ask the server what changed since this copy and read only that' : 'List every object again and read what changed (paced; asks the server again which properties hold code)', () => { void syncIndex(true, true); }, 'Refresh'));
    // A copy can be removed from the footer: complete, stopped or failed.
    if (mode !== 'replace' && (st === 'paused' || st === 'failed' || (st === 'ready' && status.copy))) facts.push(btn('cs-link', 'Delete the copy of this server\'s code on this computer', () => { void removeIndex(); }, 'Remove copy'));
  }
  const line = el('div', 'facts', ...facts);
  line.title = facts.map(f => (f instanceof HTMLElement && !(f instanceof HTMLButtonElement) ? f.textContent : '')).filter(Boolean).join(' ');
  // Hint bar from the registry (lib/shortcuts.ts).
  const hint = (id: ShortcutId, word = shortcutDef(id).hint ?? '') => el('span', '', ...shortcutLabels(id).flatMap((k, i) => (i ? [' ', kbd(k)] : [kbd(k)])), ` ${word}`);
  const keys = mode === 'replace' ? [] : run?.hits.length
    ? [hint('codesearch.move'), hint('codesearch.context'), hint('codesearch.open'), hint('codesearch.openEditor'), hint('codesearch.again'), hint('codesearch.back')]
    : [hint('codesearch.open', 'search'), hint('codesearch.back', 'clear'), hint('sheet.open', 'all keys')];
  statusEl.replaceChildren(line, ...(keys.length ? [attrs(el('div', 'keys', ...keys), { 'aria-hidden': 'true' })] : []));
}

function renderAll(): void {
  // Plain state on the shell (tests and assistive styling read it).
  shell.dataset.state = !run ? 'idle' : run.searching ? 'searching' : run.error ? (isQuietEnd(run.error) ? 'stopped' : 'error') : 'done';
  if (run?.outcome) { shell.dataset.objects = String(run.outcome.matchedObjects); shell.dataset.ms = String(Math.round(performance.now() - run.started)); }
  renderQa();
  renderResults();
  renderStatus();
}

// ── worker messages ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: InspectorMessage) => {
  if (msg.type === 'CODE_INDEX_STATUS') {
    // A status broadcast is about one server's index: only this window's.
    if (!ownEnvironment || msg.status.environment !== ownEnvironment) return;
    onStatus(msg.status);
    return;
  }
  if (msg.type === 'CODE_SEARCH_HITS' && run?.id === msg.id) { run.watchdog?.touch(); run.list.addRows(msg.hits); scheduleRender(); return; }
  if (msg.type === 'CODE_SEARCH_PROGRESS' && run?.id === msg.id) {
    // First results while the scan still runs, and how far it is.
    run.watchdog?.touch();
    run.list.addPartial(msg.hits, msg.progress);
    scheduleRender();
    return;
  }
  if (msg.type === 'CODE_SEARCH_DONE' && run?.id === msg.id) {
    run.watchdog?.stop();
    if (msg.outcome) finish(run, msg.outcome);
    else if (msg.cancelled) {
      // Ended by a stop or a replacing search: partial results stay.
      run.searching = false;
      run.error = cancelledText(msg.cancelled);
      renderAll();
    } else {
      run.searching = false;
      run.error = msg.error ?? 'The search failed';
      // Any failure may be the connection: ask (the no-connection state wins).
      void refreshConnection();
      renderAll();
    }
    return;
  }
  if (msg.type === 'CODE_SEARCH_FEED') {
    // The change feed of this window's server after a poll: the footer's
    // "Up to date as of …" follows it.
    if (!ownEnvironment || msg.environment !== ownEnvironment) return;
    feedNow = { health: msg.health, at: msg.at };
    if (run?.outcome?.coverage.feedAt != null && !run.searching) renderStatus();
    return;
  }
  if (msg.type === 'CONNECTION_STATE') onConnection(msg.state);
});

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderResults(); if (run?.searching) { renderQa(); renderStatus(); } });
}

function onConnection(s: ConnectionState): void {
  const was = connection;
  connection = s.display === 'connected' ? null : describeConnection(s);
  if (was && !connection) void loadStatus();
  if (was?.sentence !== connection?.sentence) renderAll();
}

async function refreshConnection(retry = false): Promise<void> {
  try {
    const res = await sendRequestBounded<Msg<'CONNECTION_STATE'>>({ type: 'GET_CONNECTION_STATE' }, { timeoutMs: 5_000 });
    if (res?.type === 'CONNECTION_STATE') onConnection(res.state);
    if (retry && !connection) { await loadStatus(); if (request()) void search(); }
  } catch { /* worker asleep: the next message tells */ }
}

/** The user's Make copy, Refresh or Resume: the worker builds or
 *  refreshes the copy (nothing else starts one). */
async function syncIndex(force = false, user = force, roots?: string[]): Promise<void> {
  try {
    const res = await sendRequestBounded<Msg<'CODE_INDEX_STATUS'>>({ type: 'CODE_INDEX_SYNC', ...(force ? { force: true } : {}), ...(user ? { user: true } : {}), ...(roots?.length ? { roots } : {}) }, { timeoutMs: 10_000 });
    if (res?.type === 'CODE_INDEX_STATUS') onStatus(res.status);
  } catch { /* the status broadcast follows */ }
}

/** The index's state (opening, reconnecting): read locally by the worker,
 *  nothing is sent to the server. */
async function loadStatus(): Promise<void> {
  try {
    const res = await sendRequestBounded<Msg<'CODE_INDEX_STATUS'>>({ type: 'CODE_INDEX_GET_STATUS' }, { timeoutMs: 10_000 });
    if (res?.type === 'CODE_INDEX_STATUS') { onStatus(res.status); return; }
  } catch { /* the status broadcast follows */ }
  holdWorker();
}

// ── activation ────────────────────────────────────────────────────

function activate(a: CodeSearchFrameActivation): void {
  if (a.context) context = a.context;
  // The Replace tab, filled in by another window; nothing is searched or changed until the user acts.
  if (a.mode === 'replace') {
    if (a.query !== undefined) { query = a.query; input.value = a.query; }
    rep.set(a.replace);
    setMode('replace');
    rep.leaveResult();
    rep.invalidate();
    renderAll();
    input.focus();
    return;
  }
  // Back from the object window: the results (and selection) are still here.
  if (a.restore && run && (!a.query || (mode === 'text' && a.query === query))) { input.focus(); renderAll(); updateSelection(); return; }
  if (a.restore && !a.query && !a.target && !a.scope) { input.focus(); renderAll(); return; }
  if (a.scope) { mode = 'text'; setScope(a.scope); }
  if (a.target || a.mode === 'refs') {
    mode = 'refs';
    target = a.target ?? target ?? context;
    run = null;
    renderAll();
    if (target) void search();
    return;
  }
  if (a.query) {
    mode = 'text';
    query = a.query;
    input.value = a.query;
    void search();
  }
  renderAll();
  input.focus();
}

window.addEventListener('message', (e: MessageEvent) => {
  if (!fromParent(e)) return;
  const m = e.data as { type?: string; activation?: CodeSearchFrameActivation } | undefined;
  if (m?.type === 'CREV_FRAME_ACTIVATE' && m.activation?.type === 'codesearch') activate(m.activation);
});

document.addEventListener('click', e => {
  if (openMenu && !(e.target as Element | null)?.closest?.('.cs-menu-wrap')) { closeMenu(); renderQa(); }
});

renderAll();
input.focus();
void refreshConnection();
// Opening the window reads the index's state only: a copy is refreshed when
// the user asks, never by itself.
void loadStatus();
postToParent({ type: 'CREV_FRAME_READY' });
