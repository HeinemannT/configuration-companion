/**
 * Compare window (diff/diff.html): two objects side by side.
 *
 * Side A is the object Compare was opened from; side B is picked with the
 * shared object picker (lib/object-picker), which offers the template and
 * its instances, siblings of the same type and recently opened objects
 * before any typing. Both sides can be changed and swapped at any time.
 *
 * The comparison is lib/compare-model.ts on the full object reads
 * (READ_COMPARE, lib/compare-read.ts): properties in the object window's
 * groups and labels, code as a word-marked line diff, children matched by
 * ID and by name and type. A matched pair of children opens as its own
 * comparison in this window (Back returns).
 *
 * Read-only: nothing here writes to BMP.
 */

import { shortcutLabel, whichShortcut, withShortcut } from '../lib/shortcuts';
import { escapeLayers } from '../lib/escape-layers';
import { installCheatSheetKey } from '../lib/cheat-sheet';
import type { CompareFrameActivation, ConnectionState, InspectorMessage } from '../lib/types';
import type { CompareRead, CompareSideRead, SuggestRow } from '../lib/compare-read';
import type { FullObject, ObjectSummary } from '../lib/object-read';
import { installCloseHandshake } from '../lib/frame-close-handshake';
import { sendRequestBounded } from '../lib/messaging';
import { openObject } from '../lib/open-object';
import { describeConnection } from '../lib/connection-copy';
import { copyWithFeedback } from '../lib/copy-feedback';
import { pickerSearch } from '../lib/object-search-sources';
import { createObjectPicker, type ObjectPicker, type ObjectPickerSource, type PickerObject } from '../lib/object-picker';
import { assembleStructure, type StructureTree } from '../lib/object-structure';
import { isDataObject, typeInfo, typeLabel } from '../lib/object-window-table';
import { renderCodeLine } from '../editor-core/code-view';
import { findCodeRefs, type CodeRef } from '../lib/code-refs';
import type { BmpErrorKind } from '../lib/error-kind';
import { rowFactsNote } from '../lib/row-facts-status';
import {
  compareCoverage, compareProperties, compareStructure, foldCode, groupCount, structView, whereOf, wordDiff,
  type CmpRow, type CmpSection, type CodeDiff, type CodeRow, type PropertyCompare, type Range,
  type SideKey, type StructRow, type StructureCompare,
} from '../lib/compare-model';
import { ICON_SPRITE } from '../lib/icon-sprite';
import { emptyState } from '../lib/empty-state';
import { watchWindowEnvironment } from '../lib/window-environment';
import { fromParent, postTitleToParent, postToParent } from '../lib/frame-parent';
import { attrs, btn, el, icon, type Kid } from '../lib/dom';

installCloseHandshake();

type Msg<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

const READ_TIMEOUT_MS = 30_000;
const SUGGEST_TIMEOUT_MS = 20_000;
/** Below this width a code diff is unified. */
const NARROW_PX = 720;

// ── tiny DOM helpers ──────────────────────────────────────────────

function tile(type: string, large = false): HTMLElement {
  const info = typeInfo(type);
  const t = attrs(el('span', `cmp-tile${large ? ' lg' : ''}`, icon(info.icon)), { title: info.label || type, 'aria-hidden': 'true' });
  t.style.background = `var(${info.fam})`;
  return t;
}
function sw(on: boolean, label: string, onChange: () => void): HTMLElement {
  const b = attrs(btn('ui-sw', undefined, onChange), { role: 'switch', 'aria-checked': String(on), 'aria-label': label });
  return el('label', 'cmp-sw', b, el('span', '', label));
}
const kbd = (t: string) => el('kbd', '', t);
const AB: Record<SideKey, string> = { a: 'A', b: 'B' };
const objName = (o: { name?: string; businessId?: string; rid: string }) => o.name || o.businessId || '(unnamed)';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── state ─────────────────────────────────────────────────────────

interface SideState {
  /** What we know before the read lands (name, type from the opener). */
  hint: PickerObject | null;
  read: CompareSideRead | null;
  loading: boolean;
}

/** A pair left for another one: Back returns to its tab, scroll position
 *  and opened groups. */
interface Pair { a: PickerObject; b: PickerObject; tab: 'props' | 'struct'; scroll: number; open: string[] }

const state = {
  a: { hint: null, read: null, loading: false } as SideState,
  b: { hint: null, read: null, loading: false } as SideState,
  picking: null as SideKey | null,
  tab: 'props' as 'props' | 'struct',
  diffOnly: true,
  ignoreWs: false,
  layout: 'auto' as 'auto' | 'split' | 'unified',
  /** Expanded equal groups, opened folds, hidden code diffs. */
  open: new Set<string>(),
  history: [] as Pair[],
  summaries: {} as Record<string, ObjectSummary>,
  environment: '',
  /** Whole-read failure (not a side). */
  error: null as { text: string; kind?: BmpErrorKind } | null,
  connection: null as ReturnType<typeof describeConnection> | null,
  current: -1,
  started: 0,
  /** Scroll position to restore once the pair is drawn (Back). */
  restoreScroll: null as number | null,
};
/** A page now on another server than the compared data is said in a banner. */
const environmentWatch = watchWindowEnvironment(() => state.environment || undefined);
/** A RID is a 64-bit number: 15 to 20 digits in practice. */
const RID_SHAPE = /^-?\d{15,20}$/;
/** Reads done in this window, by rid (history navigation reuses them). */
const reads = new Map<string, CompareSideRead>();
let readSeq = 0;

// ── persistent elements ───────────────────────────────────────────

const root = document.getElementById('diff-root')!;
root.className = 'cmp ui';
const sprite = document.createElement('div');
sprite.hidden = true;
sprite.innerHTML = ICON_SPRITE;
document.body.prepend(sprite);
const headEl = attrs(el('header', 'cmp-head'), { 'aria-label': 'Sides' });
const toolEl = attrs(el('div', 'cmp-tb'), { role: 'toolbar', 'aria-label': 'Compare' });
const bodyEl = attrs(el('main', 'cmp-body'), { tabindex: '-1' });
const statusEl = el('footer', 'cmp-status');
const liveEl = attrs(el('div', 'sr-only'), { role: 'status', 'aria-live': 'polite' });
root.replaceChildren(headEl, toolEl, bodyEl, statusEl, liveEl);

let picker: ObjectPicker | null = null;
let pickerBox: HTMLElement | null = null;
/** The picker's field: drawn in the header slot of the side being chosen,
 *  the one place to search (its list stays in the body). */
let pickerInput: HTMLInputElement | null = null;

// ── derived ───────────────────────────────────────────────────────

const objOf = (k: SideKey): FullObject | null => state[k].read?.root ?? null;
const ready = () => !!objOf('a') && !!objOf('b') && !state.a.loading && !state.b.loading;

let cache: { key: string; props: PropertyCompare; struct: StructureCompare | null; trees: [StructureTree, StructureTree] | null } | null = null;
function compared() {
  const a = state.a.read!, b = state.b.read!;
  const key = `${a.rid}|${b.rid}|${state.ignoreWs}|${Object.keys(state.summaries).length}|${readSeq}`;
  if (cache?.key === key) return cache;
  const opts = { summaries: state.summaries, ignoreWhitespace: state.ignoreWs };
  const props = compareProperties(a.root!, b.root!, opts);
  let struct: StructureCompare | null = null;
  let trees: [StructureTree, StructureTree] | null = null;
  if (a.rows || b.rows) {
    trees = [assembleStructure(a.root!, a.rows, a.nodes), assembleStructure(b.root!, b.rows, b.nodes)];
    struct = compareStructure(trees[0], trees[1], opts);
  }
  cache = { key, props, struct, trees };
  return cache;
}

// ── reading ───────────────────────────────────────────────────────

/** Read the sides that are not read yet: one READ_COMPARE for both. */
async function load(): Promise<void> {
  const want = (['a', 'b'] as const).filter(k => state[k].hint && !state[k].read);
  for (const k of want) {
    const hit = reads.get(state[k].hint!.rid);
    if (hit) state[k].read = hit;
  }
  // Text that cannot be a RID is answered at once, without a read.
  for (const k of ['a', 'b'] as const) {
    const h = state[k].hint;
    if (h && !state[k].read && !RID_SHAPE.test(h.rid)) state[k].read = { rid: h.rid, root: null, notFound: true, invalid: true, rows: null, nodes: {} };
  }
  const rids = [...new Set((['a', 'b'] as const).filter(k => state[k].hint && !state[k].read).map(k => state[k].hint!.rid))];
  if (!rids.length) { renderAll(); return; }
  const seq = ++readSeq;
  for (const k of ['a', 'b'] as const) if (state[k].hint && rids.includes(state[k].hint!.rid)) state[k].loading = true;
  state.error = null;
  state.started = performance.now();
  renderAll();
  let res: Msg<'COMPARE_DATA'> | null = null;
  try {
    res = await sendRequestBounded<Msg<'COMPARE_DATA'>>({ type: 'READ_COMPARE', rids }, { timeoutMs: READ_TIMEOUT_MS });
  } catch (e) {
    const timedOut = e instanceof Error && /timed out/i.test(e.message);
    res = { type: 'COMPARE_DATA', environment: '', ok: false, error: timedOut ? `The server did not answer within ${READ_TIMEOUT_MS / 1000} s.` : e instanceof Error ? e.message : String(e) };
  }
  if (seq !== readSeq) return;
  for (const k of ['a', 'b'] as const) state[k].loading = false;
  if (res?.type !== 'COMPARE_DATA' || !res.ok || !res.read) {
    const kind = res?.type === 'COMPARE_DATA' ? res.errorKind : undefined;
    state.error = { text: res?.type === 'COMPARE_DATA' && res.error ? res.error : 'No response from the extension service worker.', ...(kind ? { kind } : {}) };
    void refreshConnection();
    renderAll();
    return;
  }
  // The first read pins the server this window compares on.
  if (!state.environment) state.environment = res.environment;
  void environmentWatch.check();
  apply(res.read);
  root.dataset.ms = String(Math.round(performance.now() - state.started));
  renderAll();
  announce();
  if (state.picking) startSuggestions();
}

function apply(read: CompareRead): void {
  Object.assign(state.summaries, read.summaries);
  for (const s of Object.values(read.sides)) reads.set(s.rid, s);
  for (const k of ['a', 'b'] as const) {
    const h = state[k].hint;
    if (!h) continue;
    if (state[k].read) continue;
    // A side the read did not answer for counts as not found.
    const r = read.sides[h.rid] ?? { rid: h.rid, root: null, notFound: true, rows: null, nodes: {} };
    state[k].read = r;
    if (r.root) state[k].hint = { rid: r.root.rid, name: r.root.name, type: r.root.type, businessId: r.root.businessId };
  }
  readSeq++;
  cache = null;
}

function remember(): void {
  if (state.a.hint && state.b.hint) state.history.push({ a: state.a.hint, b: state.b.hint, tab: state.tab, scroll: bodyEl.scrollTop, open: [...state.open] });
}

/** Show a pair (or side A with the picker for B). */
function show(a: PickerObject | null, b: PickerObject | null, opts: { push?: boolean; fresh?: boolean } = {}): void {
  if (opts.push) remember();
  if (opts.fresh) reads.clear();
  closePicker();
  state.a = { hint: a, read: null, loading: false };
  state.b = { hint: b, read: null, loading: false };
  state.open.clear();
  state.current = -1;
  cache = null;
  if (a && !b) openPicker('b');
  else if (!a && b) openPicker('a');
  void load();
}

function setSide(k: SideKey, obj: PickerObject): void {
  remember();
  state[k] = { hint: obj, read: null, loading: false };
  state.open.clear();
  state.current = -1;
  cache = null;
  closePicker();
  void load();
}

function swap(): void {
  const picking = state.picking;
  [state.a, state.b] = [state.b, state.a];
  state.open.clear();
  state.current = -1;
  cache = null;
  if (picking) openPicker(picking === 'a' ? 'b' : 'a');
  else renderAll();
}

function back(): void {
  const prev = state.history.pop();
  if (!prev) return;
  closePicker();
  state.a = { hint: prev.a, read: null, loading: false };
  state.b = { hint: prev.b, read: null, loading: false };
  state.open = new Set(prev.open);
  state.tab = prev.tab;
  state.restoreScroll = prev.scroll;
  state.current = -1;
  cache = null;
  void load();
}

/** Read both sides again (Retry after their children's facts failed). */
function reread(): void {
  for (const k of ['a', 'b'] as const) {
    const r = state[k].read;
    if (r) reads.delete(r.rid);
    state[k] = { hint: state[k].hint, read: null, loading: false };
  }
  cache = null;
  void load();
}

function openInWindow(obj: PickerObject): void {
  openObject(obj.rid, obj);
}

// ── picker ────────────────────────────────────────────────────────

let suggest: { for: string; rows: SuggestRow[] | null } | null = null;
let recents: PickerObject[] | null = null;

function startSuggestions(): void {
  const other = state.picking ? objOf(state.picking === 'a' ? 'b' : 'a') : null;
  if (!other || suggest?.for === other.rid) return;
  suggest = { for: other.rid, rows: null };
  const mine = suggest;
  const template = isDataObject(other) ? undefined : other.references.linkedTo?.[0];
  void sendRequestBounded<Msg<'COMPARE_SUGGEST_DATA'>>({
    type: 'COMPARE_SUGGEST', rid: other.rid,
    ...(template ? { templateRid: template } : {}),
    ...(other.references.parent?.[0] ? { parentRid: other.references.parent[0] } : {}),
    ...(state.environment ? { environment: state.environment } : {}),
  }, { timeoutMs: SUGGEST_TIMEOUT_MS }).then(res => {
    mine.rows = res?.type === 'COMPARE_SUGGEST_DATA' && res.ok ? res.rows : [];
  }, () => { mine.rows = []; }).finally(() => picker?.refresh());
}

async function loadRecents(): Promise<PickerObject[]> {
  if (recents) return recents;
  const out: PickerObject[] = [];
  try {
    const res = await sendRequestBounded<Msg<'HISTORY_DATA'>>({ type: 'GET_HISTORY' }, { timeoutMs: 5_000 });
    if (res?.type === 'HISTORY_DATA') {
      const seen = new Set<string>();
      for (const e of res.entries) {
        if (seen.has(e.rid) || !/^-?\d{1,20}$/.test(e.rid)) continue;
        seen.add(e.rid);
        out.push({ rid: e.rid, name: e.name, type: e.type, businessId: e.businessId, note: ago(e.timestamp) });
        if (out.length >= 8) break;
      }
    }
  } catch { /* no recents */ }
  recents = out;
  return out;
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const pickerSource: ObjectPickerSource = {
  search: pickerSearch(`compare:${Math.random().toString(36).slice(2)}`),
  async resolve(text) {
    const res = await sendRequestBounded<Msg<'CODE_SEARCH_RESOLVE_RESULT'>>({ type: 'CODE_SEARCH_RESOLVE', text }, { timeoutMs: 20_000 });
    if (res?.type !== 'CODE_SEARCH_RESOLVE_RESULT' || !res.ok || !res.object) return { error: res?.type === 'CODE_SEARCH_RESOLVE_RESULT' && res.error ? res.error : 'No answer' };
    return res.object;
  },
  async suggestions() {
    const otherKey: SideKey = state.picking === 'a' ? 'b' : 'a';
    const other = objOf(otherKey);
    const groups: Array<{ title: string; items: PickerObject[] }> = [];
    if (other) {
      const tpl = isDataObject(other) ? undefined : other.references.linkedTo?.[0];
      const items: PickerObject[] = [];
      if (tpl) {
        const s = state.summaries[tpl];
        items.push({ rid: tpl, name: s?.name, type: s?.type, businessId: s?.businessId, note: 'Template of this object', tag: 'template' });
      }
      const rows = suggest?.for === other.rid ? suggest.rows ?? [] : [];
      for (const r of rows.filter(x => x.kind === 'instance').slice(0, 10)) {
        items.push({ rid: r.rid, name: r.name, type: r.type, businessId: r.businessId, note: tpl ? 'Same template' : 'Instance of this object', tag: 'instance' });
      }
      if (items.length) groups.push({ title: 'Template and instances', items });
      const where = whereOf(other, state.summaries);
      const sib = rows.filter(x => x.kind === 'sibling').slice(0, 12)
        .map(r => ({ rid: r.rid, name: r.name, type: r.type, businessId: r.businessId, note: where }));
      if (sib.length) groups.push({ title: 'Same type next to this object', items: sib });
    }
    const recent = (await loadRecents()).filter(r => r.rid !== other?.rid);
    return { groups, recent, recentTitle: 'Recently opened' };
  },
};

function openPicker(k: SideKey): void {
  closePicker();
  state.picking = k;
  const other = objOf(k === 'a' ? 'b' : 'a');
  picker = createObjectPicker({
    source: pickerSource,
    label: `Object for side ${AB[k]}`,
    placeholder: `Side ${AB[k]}: search by name, ID or RID`,
    typeLabel,
    rankHit: o => (other && o.type === other.type ? 0 : 1),
    onPick: obj => setSide(k, obj),
    onCancel: () => { closePicker(); renderAll(); },
  });
  pickerBox = picker.el;
  pickerInput = picker.el.querySelector<HTMLInputElement>('.ui-picker-q');
  focusPicker = true;
  startSuggestions();
  renderAll();
}

function closePicker(): void {
  picker?.destroy();
  picker = null;
  pickerBox = null;
  pickerInput = null;
  state.picking = null;
}

// ── rendering: header ─────────────────────────────────────────────

function renderHead(): void {
  const side = (k: SideKey): HTMLElement => {
    const s = state[k];
    const obj = s.read?.root;
    const badge = el('span', 'cmp-ab', AB[k]);
    if (state.picking === k && pickerInput) {
      return attrs(el('div', 'cmp-side empty picking', attrs(badge, { 'data-pick': '1' }), pickerInput), { role: 'group', 'aria-label': `Side ${AB[k]}` });
    }
    if (!s.hint) {
      return el('div', 'cmp-side empty', btn('cmp-side-main', `Choose the object for side ${AB[k]}`, () => openPicker(k),
        attrs(badge, { 'data-pick': '1' }), el('span', '', 'Choose the object to compare with')));
    }
    if (s.read && !obj) {
      return el('div', 'cmp-side bad', btn('cmp-side-main', `Side ${AB[k]} could not be read. Choose another object`, () => openPicker(k),
        badge, el('span', 'cmp-side-t', el('span', 'nm', s.read.notFound ? 'Not found' : 'Could not be read'), el('span', 'sb', el('span', 'ui-id', s.hint.businessId || s.hint.rid)))));
    }
    const name = obj?.name || s.hint.name || s.hint.businessId || (s.loading ? 'Reading…' : `RID ${s.hint.rid}`);
    const type = obj?.type || s.hint.type || '';
    const sub = s.loading ? 'Reading…' : obj ? [whereOf(obj, state.summaries), typeLabel(obj.type)].filter(Boolean).join(' · ') : '';
    const main = btn('cmp-side-main', undefined, () => openPicker(k), badge, type ? tile(type, true) : null,
      el('span', 'cmp-side-t', el('span', 'nm', name), el('span', 'sb', (obj?.businessId || s.hint.businessId) ? el('span', 'ui-id', obj?.businessId || s.hint.businessId!) : null, el('span', '', sub))));
    attrs(main, { 'aria-label': `Side ${AB[k]}: ${name}${type ? `, ${typeLabel(type)}` : ''}. Choose another object`, title: 'Choose another object' });
    const open = obj ? btn('ui-ibtn', `Open ${name} in the object window`, () => openInWindow({ rid: obj.rid, name: obj.name, type: obj.type, businessId: obj.businessId }), icon('i-popout')) : null;
    return attrs(el('div', `cmp-side${s.loading ? ' loading' : ''}`, main, open), { role: 'group', 'aria-label': `Side ${AB[k]}` });
  };
  const sw = btn('ui-ibtn cmp-swap', 'Swap sides', () => swap(), icon('i-compare'));
  sw.disabled = !state.a.hint || !state.b.hint;
  headEl.replaceChildren(side('a'), sw, side('b'));
}

// ── rendering: toolbar ────────────────────────────────────────────

function renderTools(): void {
  const kids: Kid[] = [];
  if (state.history.length) kids.push(btn('ui-tbtn', withShortcut('Back to the previous pair', 'compare.back'), () => back(), icon('i-back', 'ic-sm'), 'Back'));
  if (!ready() || state.picking) {
    toolEl.replaceChildren(...kids.filter((k): k is Node => !!k));
    toolEl.hidden = !kids.length;
    return;
  }
  toolEl.hidden = false;
  const { props, struct } = compared();
  const tabs = attrs(el('div', 'cmp-modes'), { role: 'tablist', 'aria-label': 'What to compare' });
  const tab = (id: 'props' | 'struct', label: string, n: number | null) => {
    const b = btn(state.tab === id ? 'on' : '', undefined, () => { state.tab = id; state.current = -1; renderAll(); announce(); }, label, n != null ? el('span', 'cnt', String(n)) : null);
    attrs(b, { role: 'tab', 'aria-selected': String(state.tab === id), id: `tab-${id}`, 'aria-controls': 'cmp-panel' });
    tabs.append(b);
  };
  tab('props', 'Properties', props.differ);
  tab('struct', 'Structure', struct ? struct.differ : null);
  kids.push(tabs, el('span', 'grow'));
  const count = state.tab === 'props'
    ? props.sameType ? `${props.differ} of ${plural(props.total, 'property', 'properties')} differ` : `${props.differ} of ${plural(props.total, 'shared property', 'shared properties')} differ`
    : struct ? `${struct.differ} of ${plural(struct.total, 'child', 'children')} differ${struct.pending ? ` (${struct.pending} being compared)` : ''}` : 'No structure';
  kids.push(
    btn('ui-ibtn', withShortcut('Previous difference', 'compare.prev'), () => step(-1), icon('i-chev', 'cmp-up')),
    btn('ui-ibtn', withShortcut('Next difference', 'compare.next'), () => step(1), icon('i-chev')),
  );
  kids.push(sw(state.ignoreWs, 'Ignore whitespace', () => { state.ignoreWs = !state.ignoreWs; cache = null; renderAll(); announce(); }));
  kids.push(sw(state.diffOnly, 'Differences only', () => { state.diffOnly = !state.diffOnly; renderAll(); }), el('span', 'cmp-muted', count));
  toolEl.replaceChildren(...kids.filter((k): k is Node => !!k));
}

// ── rendering: body ───────────────────────────────────────────────

function center(iconId: string, title: string, text: string, ...actions: Kid[]): HTMLElement {
  return el('div', 'cmp-center', icon(iconId, 'ic-big'), el('h3', '', title), el('span', '', text), actions.length ? el('div', 'cmp-actions', ...actions) : null);
}

/** Nothing to compare yet, or nothing differs: the shared empty state
 *  (mascot, sentence, action). Errors and the connection keep center(). */
function blank(title: string, text: string, actions: Kid[] = [], role?: 'status'): HTMLElement {
  return emptyState({ title, titleTag: 'h3', text, actions: actions.length ? actions : null, className: 'cmp-blank', role });
}

function renderBody(): void {
  bodyEl.removeAttribute('aria-labelledby');
  bodyEl.removeAttribute('role');
  bodyEl.setAttribute('aria-busy', String(state.a.loading || state.b.loading));
  if (state.connection && (!ready() || state.error)) {
    const c = state.connection;
    bodyEl.replaceChildren(center('i-plug', c.label === 'No server' ? 'Not connected to a server' : c.label, `${c.sentence} Compare reads from the server you are connected to.`,
      btn('ui-btn primary', undefined, () => { void refreshConnection(true); }, 'Retry')));
    return;
  }
  if (state.error) {
    bodyEl.replaceChildren(attrs(center('i-warn', 'The objects could not be read', state.error.text,
      btn('ui-btn primary', undefined, () => { void load(); }, 'Retry'),
      btn('ui-btn', undefined, (e) => void copyWithFeedback(state.error?.text ?? '', e.currentTarget as HTMLElement, { textTarget: e.currentTarget as HTMLElement }), 'Copy details')), { role: 'alert' }));
    return;
  }
  if (state.picking) { bodyEl.replaceChildren(pickLayout(state.picking)); return; }
  for (const k of ['a', 'b'] as const) {
    const s = state[k];
    if (s.read && !s.read.root) {
      const text = s.read.invalid
        ? `“${s.read.rid}” cannot be a RID: a RID has 15 to 20 digits.`
        : s.read.notFound
        ? `No object with RID ${s.read.rid} on this server. It may have been deleted, or the RID belongs to another server.`
        : `The server could not read this object: ${s.read.error ?? 'unknown error'}.`;
      bodyEl.replaceChildren(center('i-info', `${AB[k]} could not be read`, text, btn('ui-btn primary', undefined, () => openPicker(k), 'Choose another object')));
      return;
    }
  }
  if (!state.a.hint || !state.b.hint) {
    const k: SideKey = state.a.hint ? 'b' : 'a';
    bodyEl.replaceChildren(blank('Choose two objects', 'Pick the object to compare with.', [btn('ui-btn primary', undefined, () => openPicker(k), 'Choose an object')]));
    return;
  }
  if (!ready()) { bodyEl.replaceChildren(skeleton()); return; }
  attrs(bodyEl, { role: 'tabpanel', 'aria-labelledby': `tab-${state.tab}` });
  bodyEl.id = 'cmp-panel';
  const top = state.restoreScroll ?? bodyEl.scrollTop;
  state.restoreScroll = null;
  bodyEl.replaceChildren(...(state.tab === 'props' ? propsView() : structureView()));
  bodyEl.scrollTop = top;
  markCurrent(false);
}

function skeleton(): HTMLElement {
  const loadingKey: SideKey = state.a.loading && !state.a.read ? 'a' : 'b';
  const done = state[loadingKey === 'a' ? 'b' : 'a'].read?.root;
  const grid = el('div', 'cmp-skel');
  for (let i = 0; i < 6; i++) grid.append(el('span', 'skel'), el('span', 'skel'), el('span', 'skel'));
  const both = state.a.loading && state.b.loading;
  return el('div', 'cmp-loading', grid, el('div', 'cmp-muted', both ? 'Reading both objects…' : `Reading ${AB[loadingKey]}${done ? `; ${AB[loadingKey === 'a' ? 'b' : 'a']} is read` : ''}…`));
}

function pickLayout(k: SideKey): HTMLElement {
  const otherKey: SideKey = k === 'a' ? 'b' : 'a';
  const other = state[otherKey];
  const o = other.read?.root;
  const card = el('div', 'cmp-acard');
  if (o) {
    const dl = el('dl', '');
    const fact = (t: string, d: Node | string | null) => { if (d) dl.append(el('dt', '', t), el('dd', '', d)); };
    fact('Type', typeLabel(o.type));
    fact('ID', o.businessId ? el('span', 'ui-id', o.businessId) : null);
    const tpl = o.references.linkedTo?.[0] ?? o.references.template?.[0];
    if (tpl) { const s = state.summaries[tpl]; fact('Template', s ? el('span', '', s.name || s.businessId, ' ', el('span', 'ui-id', s.businessId)) : null); }
    fact('Under', whereOf(o, state.summaries) || null);
    fact('RID', el('span', 'ui-id', o.rid));
    card.append(el('div', 'cmp-acard-h', el('span', 'cmp-ab', AB[otherKey]), tile(o.type, true), el('span', 'nm', objName(o))), dl);
  } else if (other.hint) {
    card.append(el('div', 'cmp-acard-h', el('span', 'cmp-ab', AB[otherKey]), el('span', 'nm', objName(other.hint))), el('div', 'cmp-muted', other.loading ? 'Reading…' : ''));
  } else card.append(el('div', 'cmp-muted', `Side ${AB[otherKey]} is empty.`));
  const foot = el('div', 'cmp-pfoot', el('span', '', kbd('↑'), ' ', kbd('↓'), ' choose'), el('span', '', kbd('Enter'), ' compare'), el('span', '', kbd(shortcutLabel('compare.close')), ' cancel'));
  return el('div', 'cmp-pick', card, el('div', 'cmp-pl', pickerBox, foot));
}

// ── properties ────────────────────────────────────────────────────

function colsHead(): HTMLElement {
  const n = (k: SideKey) => { const o = objOf(k)!; return el('span', '', el('span', 'cmp-ab sm', AB[k]), objName(o)); };
  return attrs(el('div', 'cmp-cols cmp-cols-h', el('span', ''), n('a'), n('b')), { 'aria-hidden': 'true' });
}

function factsBlock(p: PropertyCompare): HTMLElement {
  const grid = el('div', 'cmp-facts');
  const user = (rid?: string) => (rid ? state.summaries[rid]?.name || '' : '');
  // ID, type and location are in the side headers.
  const rows: Array<[string, (k: SideKey) => Kid]> = [
    ['RID', k => el('span', 'ui-id', p.identity[k].rid)],
    ['Created', k => [p.identity[k].created, user(p.identity[k].createdBy)].filter(Boolean).join(' · ') || el('span', 'none', '—')],
    ['Modified', k => [p.identity[k].modified, user(p.identity[k].modifiedBy)].filter(Boolean).join(' · ') || el('span', 'none', '—')],
  ];
  for (const [label, f] of rows) grid.append(el('span', 'fl', label), el('span', 'fv', f('a')), el('span', 'fv', f('b')));
  return attrs(el('section', 'cmp-facts-wrap', el('div', 'cmp-sub-h', 'Identity', el('span', 'cmp-muted', 'facts about each side, not compared')), grid), { 'aria-label': 'Identity of each side' });
}

/** What the comparison covered (lib/compare-model compareCoverage), with what each side's read left out. */
function coverageOf(props: Pick<PropertyCompare, 'total' | 'notComparable'>, struct: StructureCompare | null): ReturnType<typeof compareCoverage> {
  const side = (k: SideKey) => state[k].read ?? undefined;
  return compareCoverage(props, struct, { a: side('a'), b: side('b') });
}

function propsView(): Node[] {
  const { props, struct } = compared();
  const out: Node[] = [];
  const same = objOf('a')!.rid === objOf('b')!.rid;
  if (state.diffOnly && props.differ === 0 && (!struct || struct.differ === 0)) {
    const cov = coverageOf(props, struct);
    out.push(blank(cov.complete ? 'Identical' : 'No differences found', `${cov.compared}${cov.left ? ` ${cov.left}` : ''}${same ? ' Both sides are the same object.' : ''}`,
      [btn('ui-tbtn', undefined, () => { state.diffOnly = false; renderAll(); }, 'Show all properties')], 'status'));
    return out;
  }
  if (!props.sameType) {
    const a = objOf('a')!, b = objOf('b')!;
    const list = (xs: string[]) => (xs.length > 8 ? `${xs.slice(0, 8).join(', ')} and ${xs.length - 8} more` : xs.join(', '));
    out.push(el('div', 'cmp-note', icon('i-info'), el('span', '', el('b', '', `${typeLabel(a.type)} and ${typeLabel(b.type)}.`),
      ` ${plural(props.total, 'property exists', 'properties exist')} on both and ${props.total === 1 ? 'is' : 'are'} compared below.`,
      props.notComparable.a.length || props.notComparable.b.length ? ' Not comparable: ' : '',
      props.notComparable.a.length ? el('span', '', el('b', '', list(props.notComparable.a)), ` exist only on ${typeLabel(a.type)}`) : '',
      props.notComparable.a.length && props.notComparable.b.length ? '; ' : '',
      props.notComparable.b.length ? el('span', '', el('b', '', list(props.notComparable.b)), ` only on ${typeLabel(b.type)}`) : '',
      props.notComparable.a.length || props.notComparable.b.length ? '.' : '')));
  }
  if (props.templatePair) {
    const n = props.sections.reduce((c, sec) => c + sec.groups.reduce((d, g) => d + g.rows.filter(r => r.template).length, 0), 0);
    if (n) out.push(el('div', 'cmp-note', icon('i-info'), el('span', '', `One side is the template of the other: ${plural(n, 'template link differs', 'template links differ')} (link, model, linked to), as expected, and ${n === 1 ? 'is' : 'are'} not counted.`)));
  }
  out.push(factsBlock(props));
  out.push(colsHead());
  for (const sec of props.sections) out.push(...sectionView(sec));
  return out;
}

function sectionView(sec: CmpSection): Node[] {
  const rows = sec.groups.flatMap(g => g.rows);
  const c = groupCount(rows);
  const key = `s:${sec.title}`;
  const allEqual = c.differ === 0;
  const closed = allEqual && state.diffOnly && !state.open.has(key);
  const band = btn('ui-band ui-disc cmp-band', undefined, () => { toggle(key); }, icon('i-chev', `ui-disc-chev${closed ? ' closed' : ''}`), el('span', 't', sec.title),
    el('span', 'n', allEqual ? `${c.total} equal` : `${c.differ} of ${c.total} differ`));
  attrs(band, { 'aria-expanded': String(!closed) });
  const out: Node[] = [band];
  if (closed) return out;
  for (const g of sec.groups) {
    const gc = groupCount(g.rows);
    const gkey = `g:${sec.title}/${g.title}`;
    if (g.title) {
      if (gc.differ === 0 && state.diffOnly && !state.open.has(gkey)) {
        out.push(eqRow(`${g.title} · ${gc.total} equal`, gkey));
        continue;
      }
      out.push(el('div', 'cmp-gh', g.title, el('span', 'n', gc.differ ? `${gc.differ} of ${gc.total} differ` : `${gc.total} equal`)));
    }
    const showAll = !state.diffOnly || state.open.has(gkey) || (allEqual && state.open.has(key));
    const eq = g.rows.filter(r => r.equal);
    for (const r of g.rows) if (!r.equal || showAll) out.push(...rowView(r));
    if (!showAll && eq.length) out.push(eqRow(gc.differ ? `${plural(eq.length, 'more property', 'more properties')}` : `${plural(eq.length, 'property', 'properties')}`, gkey, eq.length <= 3 ? eq.map(r => r.label).join(', ') : ''));
  }
  return out;
}

function eqRow(text: string, key: string, names = ''): HTMLElement {
  return attrs(btn('cmp-eqrow', undefined, () => toggle(key), icon('i-chev', 'closed'), el('span', '', text), names ? el('span', 'cmp-muted', names) : null,
    el('span', 'tick', icon('i-check', 'ic-sm')), el('span', 'cmp-muted', 'equal')), { 'aria-expanded': 'false' });
}

function toggle(key: string): void {
  if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
  renderAll();
}

function valueView(row: CmpRow, k: SideKey, ranges: Range[] | null): HTMLElement {
  const v = row[k];
  const cell = el('span', 'cmp-dv');
  const other = row[k === 'a' ? 'b' : 'a'];
  if (!v) { cell.classList.add('none'); cell.textContent = row.only ? `not on ${AB[k]}` : '—'; return cell; }
  if (row.kind === 'ref') {
    if (!v.rids?.length) { cell.classList.add('none'); cell.textContent = 'not set'; return cell; }
    const otherSet = new Set(other?.rids ?? []);
    for (const rid of v.rids) {
      const s = state.summaries[rid];
      const changed = !row.equal && !otherSet.has(rid);
      const ref = el('span', `cmp-ref${changed ? (k === 'a' ? ' del' : ' ins') : ''}`, s ? (s.name || '(unnamed)') : 'Name not read', s?.businessId ? el('span', 'ui-id', s.businessId) : null);
      if (!s) ref.title = `RID ${rid}`;
      if (s) {
        const open = btn('cmp-ref-open', `Open ${s.name || s.businessId} in the object window`, () => openInWindow(s), ref);
        cell.append(open);
      } else cell.append(ref);
    }
    return cell;
  }
  if (v.empty && !v.cls) { cell.classList.add('none'); cell.textContent = 'not set'; return cell; }
  if (v.cls && !v.text) { cell.classList.add('none'); cell.textContent = v.cls; return cell; }
  if (row.kind === 'mono') cell.classList.add('mono');
  if (row.kind === 'bool' || row.kind === 'enum') {
    cell.append(row.equal ? v.text : el('span', k === 'a' ? 'del' : 'ins', v.text));
    if (row.kind === 'enum') cell.title = v.raw;
    return cell;
  }
  cell.append(...marked(v.text, ranges ?? [], k === 'a' ? 'del' : 'ins'));
  return cell;
}

function marked(text: string, ranges: readonly Range[], cls: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push(document.createTextNode(text.slice(at, s)));
    out.push(el('span', cls, text.slice(s, e)));
    at = e;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

/** A side's value for the live region ("Show expression: not set, TRUE"). */
function spoken(row: CmpRow, k: SideKey): string {
  const v = row[k];
  if (!v) return `not on ${AB[k]}`;
  if (v.empty) return 'not set';
  if (row.kind === 'ref') return (v.rids ?? []).map(r => state.summaries[r]?.name || 'unnamed object').join(', ');
  if (row.kind === 'code') { const n = v.raw.split('\n').length; return n > 1 ? `${n} lines` : v.raw.slice(0, 60); }
  const t = v.text || v.cls || '';
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

function rowView(row: CmpRow): Node[] {
  const name = el('span', 'cmp-pn', el('span', 'lbl', row.label), row.only ? el('span', 'cmp-only', `only in ${AB[row.only]}`) : null,
    row.template ? attrs(el('span', 'cmp-only tpl', 'template link'), { title: 'Differs because one side is the template of the other; not counted' }) : null);
  name.title = row.label;
  const r = attrs(el('div', `cmp-dr${row.equal ? ' eq' : ' diff'}`), { 'data-key': row.key, tabindex: row.equal ? undefined : '-1', 'aria-label': row.equal ? undefined : `${row.label}: ${spoken(row, 'a')}, ${spoken(row, 'b')}` });
  if (row.kind === 'code' && row.a && row.b && !row.equal && row.code) {
    const d = row.code;
    const ckey = `c:${row.key}`;
    const hidden = state.open.has(ckey);
    const size = (k: SideKey, n: number) => (row[k]!.empty ? el('span', 'cmp-none', 'not set') : el('span', 'cmp-muted', plural(n, 'line')));
    r.append(name, el('span', 'cmp-dv', size('a', d.linesA)),
      el('span', 'cmp-dv', size('b', d.linesB), el('span', 'cmp-muted', '·'),
        el('span', 'mono', el('span', 'plus', `+${d.added}`), ' ', el('span', 'minus', `−${d.removed}`)),
        btn('ui-tbtn', undefined, () => toggle(ckey), hidden ? 'Show diff' : 'Hide diff')));
    return hidden ? [r] : [r, codeView(row, d)];
  }
  const w = (row.kind === 'text' || row.kind === 'mono' || row.kind === 'code') && row.a && row.b && !row.equal && !row.a.empty && !row.b.empty
    ? wordDiff(row.a.text, row.b.text, { ignoreWhitespace: state.ignoreWs && row.kind === 'code' }) : null;
  const ra = w ? w.a : row.a && !row.equal && !row.a.empty ? [[0, row.a.text.length] as const] : [];
  const rb = w ? w.b : row.b && !row.equal && !row.b.empty ? [[0, row.b.text.length] as const] : [];
  if (row.kind === 'code') {
    // Equal or one-sided code: its size and first line.
    const brief = (k: SideKey) => {
      const v = row[k];
      if (!v || v.empty) return valueView(row, k, null);
      const lines = v.raw.split('\n');
      return el('span', 'cmp-dv', el('span', 'cmp-muted', plural(lines.length, 'line')), el('span', 'mono cmp-first', lines[0]));
    };
    r.append(name, brief('a'), brief('b'));
    return [r];
  }
  r.append(name, valueView(row, 'a', ra), valueView(row, 'b', rb));
  return [r];
}

// ── code diff ─────────────────────────────────────────────────────

function wideLayout(): boolean {
  if (state.layout === 'split') return true;
  if (state.layout === 'unified') return false;
  return window.innerWidth >= NARROW_PX;
}

/** References per line of `code` (1-based line → refs with line offsets). */
function refsByLine(code: string): Map<number, Array<{ s: number; e: number; ref: CodeRef }>> {
  const out = new Map<number, Array<{ s: number; e: number; ref: CodeRef }>>();
  const starts: number[] = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  for (const ref of findCodeRefs(code)) {
    const ls = starts[ref.line - 1];
    if (ls == null) continue;
    const list = out.get(ref.line) ?? [];
    list.push({ s: ref.start - ls, e: ref.end - ls, ref });
    out.set(ref.line, list);
  }
  return out;
}

/** One code line: syntax colours, changed words, reference links. */
function codeLine(text: string, ranges: readonly Range[], refs: ReadonlyArray<{ s: number; e: number; ref: CodeRef }>, cls: string, plain: boolean): HTMLElement {
  const out = el('span', 'c');
  if (!text) { out.textContent = ' '; return out; }
  const link = (i: number) => {
    const r = refs[i];
    return btn('xref', `Open ${r.ref.ns ? `${r.ref.ns}.` : ''}${r.ref.id} in the object window`, () => { void openRef(r.ref); });
  };
  out.append(...renderCodeLine(text, {
    plain,
    layers: [
      { ranges: refs.map(r => [r.s, r.e] as const), wrap: link },
      { ranges, wrap: () => el('span', cls), key: () => true },
    ],
  }));
  return out;
}

async function openRef(ref: CodeRef): Promise<void> {
  const res = await sendRequestBounded<Msg<'CODE_REFS_RESULT'>>({ type: 'RESOLVE_CODE_REFS', keys: [ref.key], ...(state.environment ? { environment: state.environment } : {}) }, { timeoutMs: 20_000 }).catch(() => null);
  const hit = res?.type === 'CODE_REFS_RESULT' && res.ok ? res.results[ref.key] : undefined;
  if (hit?.found) openInWindow(hit.target);
  else announce(`${ref.ns ? `${ref.ns}.` : ''}${ref.id} could not be found on this server.`);
}

function codeView(row: CmpRow, d: CodeDiff): HTMLElement {
  const wide = wideLayout();
  const refsA = refsByLine(row.a!.raw), refsB = refsByLine(row.b!.raw);
  const plain = !!row.plain;
  const foldKey = (i: number) => `f:${row.key}:${i}`;
  const opened = new Set<number>();
  for (const k of state.open) if (k.startsWith(`f:${row.key}:`)) opened.add(Number(k.slice(`f:${row.key}:`.length)));
  const box = el('div', `cmp-code ${wide ? 'split' : 'unified'}`);
  const seg = attrs(el('span', 'cmp-seg'), { role: 'group', 'aria-label': 'Diff layout' });
  for (const [id, label] of [['split', 'Side by side'], ['unified', 'Unified']] as const) {
    const on = wide === (id === 'split');
    seg.append(attrs(btn(on ? 'on' : '', undefined, () => { state.layout = id; renderAll(); }, label), { 'aria-pressed': String(on) }));
  }
  const wsOnly = d.rows.filter(r => r.ws).length;
  const note = d.disjoint ? 'No lines in common: both texts are shown as they are.'
    : [d.changed ? `${plural(d.changed, 'changed line')}, changed words marked` : '', wsOnly ? `${plural(wsOnly, 'line differs', 'lines differ')} only in whitespace (ignored)` : ''].filter(Boolean).join(' · ');
  const head = el('div', 'cmp-cdh', el('span', 'cmp-muted', note), el('span', 'grow'), seg);
  const n = (x?: number) => el('span', 'n', x ? String(x) : '');
  const line = (r: CodeRow, side: SideKey) => {
    const text = side === 'a' ? r.a : r.b;
    if (text == null) return el('span', 'c gap', ' ');
    const ranges = r.op === 'ch' && !d.disjoint ? (side === 'a' ? r.ra : r.rb) ?? [] : [];
    const refs = (side === 'a' ? refsA.get(r.na ?? 0) : refsB.get(r.nb ?? 0)) ?? [];
    return codeLine(text, ranges, refs, side === 'a' ? 'del' : 'ins', plain);
  };
  const tone = (r: CodeRow, side: SideKey) => {
    if (d.disjoint || r.ws) return '';
    if (side === 'a') return r.op === 'ch' || r.op === 'del' ? 'rm' : '';
    return r.op === 'ch' || r.op === 'add' ? 'ad' : '';
  };

  if (d.disjoint) {
    // Two unrelated texts: plain A and B, no red and green on every line.
    const col = (k: SideKey) => {
      const text = row[k]!.raw;
      const refs = k === 'a' ? refsA : refsB;
      const c = el('div', 'cmp-col');
      text.split('\n').forEach((t, i) => c.append(el('div', 'cl', n(i + 1), codeLine(t, [], refs.get(i + 1) ?? [], '', plain))));
      return c;
    };
    const grid = attrs(el('div', `cmp-sbs plain${wide ? ' two' : ''}`), { role: 'group', 'aria-label': `${row.label}: A and B` });
    grid.append(el('div', 'cmp-colh', el('span', 'cmp-ab sm', 'A')), ...(wide ? [el('div', 'cmp-colh', el('span', 'cmp-ab sm', 'B'))] : []), col('a'));
    if (!wide) grid.append(el('div', 'cmp-colh', el('span', 'cmp-ab sm', 'B')));
    grid.append(col('b'));
    box.append(head, grid);
    return box;
  }

  const view = foldCode(d.rows, 3, opened);
  const foldRow = (item: { fold: number; count: number }, withText: boolean) => el('div', 'cmp-fold',
    withText ? `${plural(item.count, 'unchanged line')}` : ' ',
    withText ? btn('', `Show ${plural(item.count, 'unchanged line')}`, () => { state.open.add(foldKey(item.fold)); renderAll(); }, 'Show') : null);

  if (wide) {
    // Four columns: numbers A, code A, numbers B, code B. Lines do not wrap;
    // the two code columns scroll sideways in step.
    const na = el('div', 'cmp-nums'), ca = el('div', 'cmp-lines'), nb = el('div', 'cmp-nums'), cb = el('div', 'cmp-lines');
    const ia = el('div', 'cmp-inner'), ib = el('div', 'cmp-inner');
    ca.append(ia); cb.append(ib);
    for (const item of view) {
      if ('fold' in item) {
        na.append(el('div', 'cmp-fold', ' ')); ia.append(foldRow(item, true));
        nb.append(el('div', 'cmp-fold', ' ')); ib.append(foldRow(item, false));
        continue;
      }
      const r = item.row;
      const sideCell = (k: SideKey) => { const c = line(r, k); const t = tone(r, k); if (t) c.classList.add(t); return c; };
      na.append(el('div', `nr ${tone(r, 'a')}`, String(r.na ?? '')));
      ia.append(sideCell('a'));
      nb.append(el('div', `nr ${tone(r, 'b')}`, String(r.nb ?? '')));
      ib.append(sideCell('b'));
    }
    let syncing = false;
    const sync = (from: HTMLElement, to: HTMLElement) => from.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      to.scrollLeft = from.scrollLeft;
      requestAnimationFrame(() => { syncing = false; });
    });
    sync(ca, cb); sync(cb, ca);
    // Both sides get the width of the longer one, so they scroll the same way.
    requestAnimationFrame(() => {
      const w = Math.max(ia.scrollWidth, ib.scrollWidth);
      ia.style.minWidth = ib.style.minWidth = `${w}px`;
    });
    const grid = attrs(el('div', 'cmp-sbs split', na, ca, nb, cb), { role: 'group', 'aria-label': `${row.label}: code diff, side by side` });
    box.append(head, grid);
    return box;
  }

  const lines = attrs(el('div', 'cmp-sbs'), { role: 'group', 'aria-label': `${row.label}: code diff, unified` });
  const ur = (o: number | undefined, nn: number | undefined, sign: string, c: HTMLElement, cls: string) =>
    el('div', `ur ${cls}`, n(o), n(nn), el('span', 'g', sign), c);
  for (const item of view) {
    if ('fold' in item) { lines.append(foldRow(item, true)); continue; }
    const r = item.row;
    if (r.op === 'eq') lines.append(ur(r.na, r.nb, '', line(r, 'a'), r.ws ? 'ws' : ''));
    else {
      if (r.a != null) lines.append(ur(r.na, undefined, r.ws ? '' : '−', line(r, 'a'), r.ws ? 'ws' : 'rm'));
      if (r.b != null) lines.append(ur(undefined, r.nb, r.ws ? '' : '+', line(r, 'b'), r.ws ? 'ws' : 'ad'));
    }
  }
  box.append(head, lines);
  return box;
}

// ── structure ─────────────────────────────────────────────────────

function structureView(): Node[] {
  const { struct, trees } = compared();
  const a = objOf('a')!, b = objOf('b')!;
  const out: Node[] = [];
  if (!struct || !trees) {
    out.push(blank('No structure to compare', `${typeLabel(a.type)}${a.type === b.type ? '' : ` and ${typeLabel(b.type)}`} ${a.type === b.type ? 'has' : 'have'} no child tree in the object window.`));
    return out;
  }
  for (const k of ['a', 'b'] as const) {
    const s = state[k].read!;
    if (s.structureError) out.push(attrs(el('div', 'cmp-note err', icon('i-warn'), el('span', '', `The children of ${AB[k]} could not be listed: ${s.structureError}`)), { role: 'alert' }));
    if (s.structureTruncatedAt) out.push(el('div', 'cmp-note', icon('i-info'), el('span', '', `Only the first ${s.structureTruncatedAt} children of ${AB[k]} are compared.`)));
  }
  // Listed, but names and markers missing: say why once, with Retry.
  const unread = (['a', 'b'] as const).filter(k => state[k].read?.rowFactsError);
  if (unread.length) {
    const f = state[unread[0]].read!.rowFactsError!;
    out.push(attrs(el('div', 'cmp-note err', icon('i-warn'),
      el('span', '', `Children of ${unread.map(k => AB[k]).join(' and ')}: ${rowFactsNote(f)}`),
      btn('ui-tbtn', 'Read both sides again', () => reread(), 'Retry')), { role: 'alert', title: f.message }));
  }
  if (struct.anchor) {
    const inner: SideKey = struct.anchor.side;
    const outer: SideKey = inner === 'a' ? 'b' : 'a';
    out.push(el('div', 'cmp-note', icon('i-info'), el('span', '', `${AB[outer]} is part of ${AB[inner]}'s tree, so the children are compared from there: the same objects are matched, not shown as removed and added.`)));
  }
  if (state.diffOnly && struct.differ === 0) {
    const cov = coverageOf({ total: 0, notComparable: { a: [], b: [] } }, struct);
    out.push(blank(cov.left ? 'No differences found' : 'Same structure', `All ${plural(struct.total - struct.pending, 'child', 'children')} compared match and are equal.${cov.left ? ` ${cov.left}` : ''}`,
      [btn('ui-tbtn', undefined, () => { state.diffOnly = false; renderAll(); }, 'Show all children')], 'status'));
    return out;
  }
  out.push(attrs(el('div', 'cmp-tcols-h', el('span', '', el('span', 'cmp-ab sm', 'A'), objName(a)), el('span', '', el('span', 'cmp-ab sm', 'B'), objName(b))), { 'aria-hidden': 'true' }));
  const list = attrs(el('div', 'cmp-tree'), { role: 'list', 'aria-label': 'Children of both sides' });
  for (const item of structView(struct.rows, state.diffOnly, state.open)) {
    if ('equal' in item) {
      const names = item.equal.map(i => objName(struct.rows[i].a?.obj ?? { rid: '' })).slice(0, 4).join(', ');
      list.append(attrs(btn('cmp-eqt', undefined, () => toggle(item.key), icon('i-chev', 'ic-sm closed'),
        `${plural(item.equal.length, 'equal child', 'equal children')} (${names}${item.equal.length > 4 ? ', …' : ''})`), { style: `--d:${item.depth}`, role: 'listitem' }));
      continue;
    }
    list.append(structRow(item.row, item.index));
  }
  out.push(list);
  return out;
}

const MARK: Record<StructRow['status'], string> = { same: '', changed: '~', onlyA: '−', onlyB: '+' };

function structRow(r: StructRow, index: number): HTMLElement {
  const cell = (k: SideKey) => {
    const node = r[k];
    const cls = r.status === 'onlyA' ? (k === 'a' ? 'rm' : 'ghost') : r.status === 'onlyB' ? (k === 'b' ? 'add' : 'ghost') : r.status === 'changed' ? 'chg' : '';
    const c = attrs(el('div', `tc ${cls}`), { style: `--d:${r.depth}` });
    if (!node) return c;
    const o = node.obj;
    c.append(el('span', 'mk', MARK[r.status]), el('span', 'nm', o ? objName(o) : 'Not read'));
    if (o) c.insertBefore(tile(o.type), c.lastChild);
    if (o?.businessId) c.append(el('span', 'ui-id', o.businessId));
    if (k === 'b' && r.by && r.by !== 'id') c.append(el('span', 'by', r.by === 'name' ? 'by name' : r.by === 'link' ? 'by template' : 'same object'));
    if (r.status === 'changed') c.append(el('span', 'why', el('b', '', String(r.diffs)), ' differ'));
    // Known by its row facts only: the count follows (read lazily).
    if (k === 'b' && r.pending) c.append(attrs(el('span', 'why pend', '…'), { title: 'Comparing the properties…' }));
    return c;
  };
  const pair = !!r.a?.obj && !!r.b?.obj;
  const label = `${objName(r.a?.obj ?? r.b?.obj ?? { rid: '' })}: ${r.status === 'same' ? 'equal' : r.status === 'changed' ? `${r.diffs} differing properties` : r.status === 'onlyA' ? 'only in A' : 'only in B'}`;
  const row = attrs(el('div', `tr${r.status === 'same' ? ' eq' : ' diff'}${pair && index > 0 ? ' pair' : ''}`, cell('a'), cell('b')), {
    role: 'listitem', tabindex: r.status === 'same' && !(pair && index > 0) ? undefined : '-1', 'aria-label': label, 'data-index': String(index),
    title: pair && index > 0 ? 'Compare this pair (Enter)' : undefined,
  });
  if (r.pending) row.dataset.pending = String(index);
  if (pair && index > 0) {
    const go = () => {
      const x = r.a!.obj!, y = r.b!.obj!;
      // The pair opens on its properties.
      remember();
      state.tab = 'props';
      show({ rid: x.rid, name: x.name, type: x.type, businessId: x.businessId }, { rid: y.rid, name: y.name, type: y.type, businessId: y.businessId });
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }
  return row;
}

// ── status bar, live region ───────────────────────────────────────

function renderStatus(): void {
  const keys = el('span', 'keys', el('span', '', kbd(shortcutLabel('compare.next')), ' ', kbd(shortcutLabel('compare.prev')), ' next / previous difference'));
  if (state.history.length) keys.append(el('span', '', kbd(shortcutLabel('compare.back')), ' back'));
  let left = '';
  if (ready() && !state.picking) {
    const { struct } = compared();
    if (state.tab === 'struct' && struct) {
      const by = [struct.bySame ? `${struct.bySame} as the same object` : '', struct.byLink ? `${struct.byLink} by template` : '', `${struct.byId} by ID`, `${struct.byName} by name and type`].filter(Boolean).join(', ');
      left = `Matched ${by} · ${struct.onlyA} only in A · ${struct.onlyB} only in B`;
      keys.append(el('span', '', kbd('Enter'), ' compare the selected pair'));
    } else left = 'Read-only. Values come from the server you are connected to.';
  }
  statusEl.replaceChildren(el('span', 'grow', left), keys);
}

function announce(text?: string): void {
  if (text) { liveEl.textContent = text; return; }
  if (!ready()) return;
  const { props, struct } = compared();
  liveEl.textContent = state.tab === 'props'
    ? (props.differ ? `${plural(props.differ, 'difference')} in ${plural(props.total, 'property', 'properties')}` : `No differences in ${plural(props.total, 'property', 'properties')}`)
    : struct ? `${struct.differ} of ${plural(struct.total, 'child', 'children')} differ` : 'No structure to compare';
}

// ── next / previous difference ────────────────────────────────────

function targets(): HTMLElement[] {
  return [...bodyEl.querySelectorAll<HTMLElement>(state.tab === 'props' ? '.cmp-dr.diff' : '.tr.diff')];
}

function markCurrent(scroll: boolean): void {
  const list = targets();
  list.forEach((t, i) => t.classList.toggle('cur', i === state.current));
  const cur = list[state.current];
  if (cur && scroll) {
    cur.scrollIntoView({ block: 'nearest' });
    cur.focus({ preventScroll: true });
  }
}

function step(dir: 1 | -1): void {
  const list = targets();
  if (!list.length) { announce('No differences to move to.'); return; }
  state.current = state.current < 0 ? (dir > 0 ? 0 : list.length - 1) : (state.current + dir + list.length) % list.length;
  markCurrent(true);
  const t = list[state.current];
  announce(`Difference ${state.current + 1} of ${list.length}: ${t.getAttribute('aria-label') ?? ''}`);
}

// ── render all ────────────────────────────────────────────────────

/** The picker's field takes focus once it opens; a re-render that moves
 *  it keeps the focus it had. */
let focusPicker = false;

function renderAll(): void {
  const hadPicker = !!pickerInput && document.activeElement === pickerInput;
  renderHead();
  renderTools();
  renderBody();
  if (picker && (focusPicker || hadPicker)) { picker.focus(); focusPicker = false; }
  renderStatus();
  const a = state.a.read?.root ?? state.a.hint, b = state.b.read?.root ?? state.b.hint;
  const title = a && b ? `${objName(a)} ↔ ${objName(b)}` : a ? objName(a) : '';
  document.title = title ? `Compare: ${title} - Companion` : 'Compare - Companion';
  postTitleToParent(title ? `Compare · ${title}` : 'Compare');
  // Rig and tests: the shown state.
  const failed = (['a', 'b'] as const).some(k => state[k].read && !state[k].read!.root);
  root.dataset.state = state.picking ? 'picking' : state.error || failed ? 'error' : !ready() ? 'loading' : 'ready';
  if (state.tab === 'struct') queueMicrotask(() => { void fillPending(); });
}

/** Pairs shown in the structure list whose sides are known by their row
 *  facts only: read in full a few at a time (PAIRS_PER_READ pairs, one
 *  request), so each "…" becomes its count. Never more than one request in
 *  flight; a pair opened is read at once by its own Compare. */
const PAIRS_PER_READ = 3;
let filling = false;
/** Objects asked once already (a failed read is not asked again). */
const triedFull = new Set<string>();
async function fillPending(): Promise<void> {
  if (filling) return;
  const { struct } = compared();
  if (!struct?.pending) return;
  const shown = [...bodyEl.querySelectorAll<HTMLElement>('[data-pending]')].map(e => Number(e.dataset.pending)).slice(0, PAIRS_PER_READ);
  const rids = [...new Set(shown.flatMap(i => [struct.rows[i]?.a?.obj, struct.rows[i]?.b?.obj]).filter((o): o is FullObject => !!o?.lite && !triedFull.has(o.rid)).map(o => o.rid))];
  if (!rids.length) return;
  for (const r of rids) triedFull.add(r);
  filling = true;
  try {
    const res = await sendRequestBounded<Msg<'FULL_OBJECTS_DATA'>>({ type: 'READ_FULL_OBJECTS', rids }, { timeoutMs: READ_TIMEOUT_MS });
    if (res?.type !== 'FULL_OBJECTS_DATA' || !res.ok) return;
    for (const k of ['a', 'b'] as const) {
      const rd = state[k].read;
      if (!rd) continue;
      for (const [rid, o] of Object.entries(res.objects)) if (rd.nodes[rid]) rd.nodes[rid] = o;
    }
    cache = null;
  } catch { return; } finally { filling = false; }
  renderAll();
}

// ── connection ────────────────────────────────────────────────────

function onConnection(s: ConnectionState): void {
  const was = state.connection;
  state.connection = s.display === 'connected' ? null : describeConnection(s);
  if (was && !state.connection && (state.error || (!ready() && (state.a.hint || state.b.hint)))) { void load(); return; }
  if (was?.sentence !== state.connection?.sentence) renderAll();
}

async function refreshConnection(retry = false): Promise<void> {
  try {
    const res = await sendRequestBounded<Msg<'CONNECTION_STATE'>>({ type: 'GET_CONNECTION_STATE' }, { timeoutMs: 5_000 });
    if (res?.type === 'CONNECTION_STATE') onConnection(res.state);
    if (retry && !state.connection) void load();
  } catch { /* worker asleep: the next message tells */ }
}

chrome.runtime.onMessage.addListener((msg: InspectorMessage) => {
  if (msg.type === 'CONNECTION_STATE') onConnection(msg.state);
});

// ── keyboard ──────────────────────────────────────────────────────

// Keys from lib/shortcuts.ts. Next / previous and back never fire while
// typing (the picker field keeps its caret keys).
window.addEventListener('keydown', e => {
  if (e.defaultPrevented) return;
  const id = whichShortcut(e, ['compare.next', 'compare.prev', 'compare.back', 'compare.search']);
  if (id === 'compare.next' || id === 'compare.prev') {
    if (!ready() || state.picking) return;
    e.preventDefault();
    step(id === 'compare.prev' ? -1 : 1);
  } else if (id === 'compare.back' && state.history.length) {
    e.preventDefault();
    back();
  } else if (id === 'compare.search' && pickerInput) {
    e.preventDefault();
    pickerInput.focus();
  }
});

// Escape: the picker cancels itself (object-picker.ts); otherwise choosing a
// side is cancelled, then the window closes, as the frame's "Close (Esc)"
// says. The frame's own key listener cannot see keys inside this frame.
const escLayers = escapeLayers();
escLayers.register({ kind: 'window', name: 'compare', isOpen: () => true, close: () => { postToParent({ type: 'CREV_OVERLAY_CLOSE_PLEASE' }); } });
escLayers.register({
  kind: 'input', name: 'picking', isOpen: () => !!state.picking && ready(),
  close: () => { closePicker(); renderAll(); },
});
escLayers.listen(document);
installCheatSheetKey(() => ({ window: 'compare', title: 'Compare: keyboard shortcuts' }));

let wasWide = wideLayout();
window.addEventListener('resize', () => {
  const now = wideLayout();
  if (now !== wasWide) { wasWide = now; if (ready()) renderAll(); }
});

// ── activation ────────────────────────────────────────────────────

function activate(a: CompareFrameActivation): void {
  state.history = [];
  show(a.left, a.right ?? null, { fresh: true });
}

window.addEventListener('message', (e: MessageEvent) => {
  if (!fromParent(e)) return;
  const m = e.data as { type?: string; activation?: CompareFrameActivation } | undefined;
  if (m?.type === 'CREV_FRAME_ACTIVATE' && m.activation?.type === 'diff' && m.activation.left?.rid) activate(m.activation);
});

// A page opened directly (diff.html#leftRid,rightRid) compares those two.
const RID = /^-?\d{1,20}$/;
function fromHash(): void {
  const [hl, hr] = decodeURIComponent(location.hash.slice(1)).split(',');
  if (hl && RID.test(hl)) show({ rid: hl }, hr && RID.test(hr) ? { rid: hr } : null, { fresh: true });
}
window.addEventListener('hashchange', fromHash);
renderAll();
void refreshConnection();
fromHash();
postToParent({ type: 'CREV_FRAME_READY' });
