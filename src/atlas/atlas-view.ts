/**
 * Atlas's view. Three views of the same model:
 *
 *  - All types: a grid, a row references a column, the number is how many
 *    references. It needs no layout, so it cannot tangle.
 *  - One type: the type in the middle, who references it on the left, what
 *    it references on the right. Lines only run to the middle.
 *  - Route: the ways from one type to another, only the types between them
 *    drawn, the chosen way lit, its objects below.
 *
 * The right side shows what is picked. What Atlas knows beyond that (class
 * names, labels, how a target is known, counts per step) sits in a card that
 * opens when the pointer rests on a thing. A long list shows its first part
 * and "Show all"; it stays open while the view shows the same thing. The view
 * only draws `AtlasState` and reports what the user did; atlas.ts holds the
 * state and talks to the service worker. `live` redraws only what a running
 * read changes (its step, its count, its time), so a read never replaces what
 * the user is working with.
 */
import { btn, el, icon } from '../lib/dom';
import { typeGlyphSvg } from '../lib/object-glyphs';
import { typeLabel } from '../lib/object-window-table';
import { readDate } from '../lib/read-date';
import {
  edgesBetween, fillText, fullTypeName, gridOrder, routeEc, routeKey, stepLabel, typeName,
  type AtlasEdge, type AtlasModel, type AtlasObjectRef, type AtlasRoute, type AtlasStart,
} from '../lib/atlas/model';
import { groupHits, type AtlasUsage, type UsageHit } from '../lib/atlas/usage';
import { asOf, elapsedText, progressLine, progressShare, readSummary, type AtlasReadProgress } from '../lib/atlas/progress';
import { ListMemory, listPart, nameList, placeCard } from './atlas-layout';
import { ATLAS_ROUTE_START } from '../lib/atlas/atlas-ec';

export type AtlasViewName = 'all' | 'type' | 'route';

export type AtlasMatch =
  | { kind: 'type'; cls: string; name: string }
  | { kind: 'prop'; cls: string; prop: string; name: string };

export interface AtlasRouteState {
  from: string | null;
  to: string | null;
  /** The ways between the two, ranked (model.rankRoutes). */
  routes: AtlasRoute[];
  /** The chosen way (`routeKey`); null: the first. */
  key: string | null;
  /** Objects of every object of the start type, or of the object Atlas was opened on. */
  scope: 'all' | 'one';
  tab: 'rows' | 'code';
  rows: AtlasObjectRef[][] | null;
  /** What `rows` were read for (scope and route). */
  rowsFor: string | null;
  /** Rows read on the server; `rows` holds the first of them. */
  total: number;
  loading: boolean;
  /** When the rows being read were asked for. */
  since: number | null;
  error: string | null;
  /** What the code starts from. */
  start: AtlasStart;
}

export interface AtlasState {
  view: AtlasViewName;
  /** The server the page was opened for, as its address. */
  server: string;
  model: AtlasModel | null;
  fetchedAt: number | null;
  /** How long the read of `model` took. */
  readMs: number | null;
  /** The model is being read. */
  reading: boolean;
  /** When the page asked for the read that runs. */
  readSince: number | null;
  /** How far the running read is, as the service worker reports it. */
  progress: AtlasReadProgress | null;
  error: string | null;
  /** Something could not be opened on a BMP page. */
  notice: string | null;
  /** All types: the picked pair. */
  cell: { from: string; to: string } | null;
  /** One type: the type in the middle and its picked reference. */
  focus: string | null;
  prop: string | null;
  route: AtlasRouteState;
  /** The object Atlas was opened on. */
  home: AtlasObjectRef | null;
  usage: AtlasUsage | null;
  query: string;
  matches: AtlasMatch[];
}

export interface AtlasActions {
  setView(view: AtlasViewName): void;
  search(text: string): void;
  pickType(cls: string): void;
  pickProp(cls: string, prop: string | null): void;
  pickCell(from: string, to: string): void;
  routeBetween(from: string | null, to: string | null): void;
  swapRoute(): void;
  pickRoute(key: string): void;
  setScope(scope: 'all' | 'one'): void;
  setTab(tab: 'rows' | 'code'): void;
  setStart(start: AtlasStart): void;
  refresh(): void;
  makeCopy(): void;
  dismissNotice(): void;
  copy(code: string, target: HTMLElement): void;
  openCode(code: string, rid?: string): void;
  openObject(object: AtlasObjectRef): void;
}

export interface AtlasView {
  render(state: AtlasState): void;
  /** Redraw only what a running read changes: its step, counts and time. */
  live(state: AtlasState): void;
  focusSearch(): void;
  /** The mark in the header, whose eyes read while the page waits. */
  mark: HTMLElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The first part of a long list. */
export const ROUTES_SHOWN = 12;
export const SIDE_SHOWN = 10;
export const ROWS_SHOWN = 14;
export const MIDS_SHOWN = 8;
const PAIR_SHOWN = 10;
const HITS_SHOWN = 6;
const TIP_DELAY_MS = 280;
const TICK_MS = 200;

const glyph = (cls: string, size = 16): HTMLElement => {
  const g = el('span', 'at-g');
  g.innerHTML = typeGlyphSvg(cls, size);
  return g;
};

const num = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** The picked way of a route state. */
export function pickedRoute(route: AtlasRouteState): AtlasRoute | null {
  return route.routes.find(r => routeKey(r) === route.key) ?? route.routes[0] ?? null;
}

function bar(share: number | null, cls = ''): HTMLElement {
  const fill = el('i');
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, share ?? 0)) * 100)}%`;
  return el('span', `at-bar${cls ? ` ${cls}` : ''}${share == null ? ' unknown' : ''}`, fill);
}

const shareOf = (model: AtlasModel, e: AtlasEdge): number | null => {
  const seen = model.types[e.from]?.seen;
  return e.filled != null && seen ? e.filled / seen : e.filled != null ? 0 : null;
};

function path(svg: SVGSVGElement, d: string, cls: string, width?: number): void {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('class', cls);
  if (width != null) p.setAttribute('stroke-width', String(width));
  svg.append(p);
}

/** A line from the right edge of `a` to the left edge of `b`, in the coordinates of `box`. */
function link(svg: SVGSVGElement, box: DOMRect, a: DOMRect, b: DOMRect, cls: string, width?: number, ay?: number): void {
  const x1 = a.right - box.left, y1 = (ay ?? a.top + a.height / 2) - box.top;
  const x2 = b.left - box.left, y2 = b.top + b.height / 2 - box.top;
  const mid = (x1 + x2) / 2;
  path(svg, `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`, cls, width);
}

/** The arrow of a reference, drawn: it points from the type that has the reference to the type it holds. */
const arrowIcon = (cls = '') => icon('i-arrow', `at-arrow${cls ? ` ${cls}` : ''}`);
const srText = (text: string) => el('span', 'sr-only', text);

/** "A [arrow] B", read aloud as "A references B". */
function refLine(a: string, b: string): HTMLElement {
  return el('span', 'at-ref', el('span', 'at-ref-n', a), arrowIcon(), srText(' references '), el('span', 'at-ref-n', b));
}

/** The types a route passes: "A [arrow] B [arrow] C", read aloud with "then". */
function typeTrail(names: readonly string[]): HTMLElement {
  const out = el('span', 'at-ref');
  names.forEach((n, i) => {
    if (i > 0) out.append(arrowIcon(), srText(' then '));
    out.append(el('span', 'at-ref-n', n));
  });
  return out;
}

/** The steps of a route: "controls [arrow] execution_performer". */
function stepTrail(route: Pick<AtlasRoute, 'steps'>, cls = 'at-rt-l'): HTMLElement {
  const out = el('span', cls);
  route.steps.forEach((s, i) => {
    if (i > 0) out.append(arrowIcon('sm'), srText(' then '));
    // A step never breaks inside its name: a long one ends in an ellipsis (the card on hover has it whole).
    out.append(el('span', 'at-st', stepLabel(s).replace(/^\./, '')));
  });
  return out;
}

/** One line of text that ends in an ellipsis; the full text on hover. */
function line(cls: string, text: string): HTMLElement {
  const s = el('span', cls, text);
  s.title = text;
  return s;
}

export function mountAtlasView(host: HTMLElement, actions: AtlasActions, copyProgress?: HTMLElement): AtlasView {
  const root = el('div', 'at');
  const mark = el('span', 'at-mark crev-mark');
  mark.setAttribute('aria-hidden', 'true');
  const server = el('span', 'at-server ui-id');
  const input = el('input', 'at-q') as HTMLInputElement;
  input.type = 'search';
  input.placeholder = 'Find a type or property';
  input.setAttribute('aria-label', 'Find a type or property');
  input.addEventListener('input', () => actions.search(input.value));
  const menu = el('div', 'at-menu ui-menu');
  const find = el('div', 'at-find', el('span', 'at-qf ui-search', icon('i-search'), input), menu);
  const views: Array<[AtlasViewName, string]> = [['all', 'All types'], ['type', 'One type'], ['route', 'Route']];
  const seg = el('div', 'at-seg');
  const read = el('span', 'at-read');
  read.setAttribute('aria-live', 'polite');
  const refresh = btn('ui-tbtn', undefined, () => actions.refresh(), 'Refresh');
  const head = el('div', 'at-head', mark, el('span', 'at-title', 'Atlas'), server, el('span', 'at-grow'), read, refresh);
  const top = el('div', 'at-top', find, seg);
  // While the types are read again: what runs, and that the copy on screen stays in use.
  const strip = el('div', 'at-progress');
  strip.setAttribute('role', 'status');
  const notice = el('div', 'at-notice');
  const main = el('div', 'at-main');
  const insp = el('div', 'at-insp');
  const tipEl = el('div', 'at-tip');
  tipEl.hidden = true;
  root.append(head, top, strip, notice, el('div', 'at-body', main, insp), tipEl);
  host.replaceChildren(root);

  const lists = new ListMemory();
  let redraw: (() => void) | null = null;
  let lastState: AtlasState | null = null;
  new ResizeObserver(() => redraw?.()).observe(main);
  const again = () => { if (lastState) render(lastState); };

  /** The first part of `items` and, when the list is long, its expander. */
  function part<T>(items: readonly T[], limit: number, where: [view: string, context: string, list: string], keep?: (item: T) => boolean) {
    const p = listPart(items, limit, lists.isOpen(...where), keep);
    const toggle = p.toggle ? btn('at-more', undefined, () => { lists.toggle(...where); again(); }, p.toggle) : null;
    return { shown: p.shown, toggle };
  }

  // ── Time that runs: elapsed text of every running read ──────────

  let ticker: ReturnType<typeof setInterval> | null = null;
  function tick(): void {
    const now = Date.now();
    const running = root.querySelectorAll<HTMLElement>('[data-since]');
    for (const e of running) e.textContent = elapsedText(now - Number(e.dataset.since));
    if (running.length === 0 && ticker) { clearInterval(ticker); ticker = null; }
    else if (running.length && !ticker) ticker = setInterval(tick, TICK_MS);
  }
  const since = (at: number | null) => {
    const s = el('span', 'at-el');
    if (at != null) { s.dataset.since = String(at); s.textContent = elapsedText(Date.now() - at); }
    return s;
  };
  const spinner = () => { const s = el('span', 'at-spin'); s.setAttribute('aria-hidden', 'true'); return s; };
  /** A quiet note that something is read: what, a count when one is known, and the time it runs. */
  const loadingNote = (cls: string, what: string, detail: HTMLElement | string | null, at: number | null) =>
    el('div', `at-loading ${cls}`, spinner(), el('span', 'at-loading-t', what), detail ? el('span', 'at-loading-d', detail) : null, since(at));

  // ── The card that opens when the pointer rests on a thing ───────

  let tipTimer: ReturnType<typeof setTimeout> | null = null;
  let tipFor: HTMLElement | null = null;
  const hideTip = () => { if (tipTimer) clearTimeout(tipTimer); tipTimer = null; tipFor = null; tipEl.hidden = true; };
  /** Fill the card, measure it where it cannot be seen, then place it once and show it. */
  function showTip(target: HTMLElement, kids: HTMLElement[]): void {
    tipEl.replaceChildren(...kids);
    tipEl.style.visibility = 'hidden';
    tipEl.style.maxHeight = '';
    // Measured at the top left corner, so the room left of a previous place does not narrow it.
    tipEl.style.left = '0px';
    tipEl.style.top = '0px';
    tipEl.hidden = false;
    const size = { width: tipEl.offsetWidth, height: tipEl.offsetHeight };
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const p = placeCard(target.getBoundingClientRect(), size, viewport);
    tipEl.style.left = `${p.left}px`;
    tipEl.style.top = `${p.top}px`;
    if (p.maxHeight != null) tipEl.style.maxHeight = `${p.maxHeight}px`;
    tipEl.dataset.side = p.side;
    tipEl.style.visibility = '';
    tipFor = target;
  }
  /** `build` is called when the card opens: nothing is built for things nobody rests on. */
  function tip<T extends HTMLElement>(target: T, build: () => Array<HTMLElement | null>): T {
    target.addEventListener('mouseenter', () => {
      // Already open for this thing: it stays where it is.
      if (tipFor === target && !tipEl.hidden) return;
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        tipTimer = null;
        const kids = build().filter((k): k is HTMLElement => k != null);
        if (kids.length === 0 || !target.isConnected) return;
        showTip(target, kids);
      }, TIP_DELAY_MS);
    });
    target.addEventListener('mouseleave', hideTip);
    target.addEventListener('mousedown', hideTip);
    return target;
  }
  const tipTitle = (text: string | HTMLElement, sub = '') => el('div', 'at-tip-h', el('b', '', text), sub ? el('span', 'at-mono', sub) : null);
  const tipLine = (label: string, value: string) => (value ? el('div', 'at-tip-l', el('span', '', label), el('span', '', value)) : null);
  const more = (n: number) => (n > 0 ? el('p', 'at-tip-n', `${num(n)} more`) : null);
  const yes = (v: boolean | undefined) => (v ? 'Yes' : 'No');

  function typeTip(model: AtlasModel, cls: string): Array<HTMLElement | null> {
    const t = model.types[cls];
    const own = model.edges.filter(e => e.from === cls);
    const inn = model.edges.filter(e => e.to.includes(cls));
    return [tipTitle(fullTypeName(model, cls), cls),
      tipLine('Objects', t?.count != null ? num(t.count) : model.unread.includes(cls) ? 'not read' : ''),
      tipLine('References', num(own.length)),
      tipLine('Referenced by', num(inn.length))];
  }

  /** A reference in the words of its property: name, ID, and its settings. */
  function edgeTip(state: AtlasState, model: AtlasModel, e: AtlasEdge): Array<HTMLElement | null> {
    const used = state.usage?.state === 'ready' ? state.usage.byProp[e.prop]?.length ?? 0 : null;
    return [tipTitle(e.label || e.prop, e.prop),
      tipLine('Property', e.historical ? 'Historical reference' : 'Reference'),
      tipLine('Linked to', typeName(model, e.from)),
      tipLine('Multiselect', yes(e.multi)),
      tipLine('Advanced', yes(e.advanced)),
      tipLine(e.declared ? 'Types' : 'Objects', e.to.length ? nameList(e.to.map(c => typeName(model, c)), 6) : 'none'),
      tipLine('Filled', fillText(model, e)),
      tipLine('Used in code', used != null ? num(used) : '')];
  }

  function edgeList(model: AtlasModel, title: string | HTMLElement, edges: AtlasEdge[]): Array<HTMLElement | null> {
    if (edges.length === 0) return [];
    return [el('div', 'at-tip-c', title), ...edges.slice(0, 8).map(e => el('div', 'at-tip-l', el('span', 'at-mono', e.prop), el('span', '', fillText(model, e)))),
      more(edges.length - 8)];
  }

  const segment = <T extends string>(cls: string, items: Array<[T, string]>, on: T, pick: (v: T) => void, disabled: T[] = []): HTMLElement =>
    el('div', `at-seg ${cls}`, ...items.map(([v, label]) => {
      const b = btn(`at-seg-b${v === on ? ' on' : ''}`, undefined, () => pick(v), label);
      b.disabled = disabled.includes(v);
      return b;
    }));

  const empty = (title: string, text = '', ...extra: HTMLElement[]) =>
    el('div', 'ui-empty', el('p', 'ui-empty-title', title), text ? el('p', 'ui-empty-text', text) : null, ...extra);

  /** A heading of the right side: at most two lines, the whole text on hover. */
  const heading = (content: string | HTMLElement, full: string, cls = '') => {
    const h = el('h2', `at-h${cls ? ` ${cls}` : ''}`, content);
    h.title = full;
    return h;
  };

  // ── All types ───────────────────────────────────────────────────

  function renderAll(state: AtlasState, model: AtlasModel): void {
    redraw = null;
    const order = gridOrder(model);
    if (order.length === 0) { main.replaceChildren(empty('No reference properties')); return; }
    const count = new Map<string, number>();
    for (const e of model.edges) for (const t of e.to) count.set(`${e.from}>${t}`, (count.get(`${e.from}>${t}`) ?? 0) + 1);
    const grid = el('div', 'at-grid');
    grid.style.gridTemplateColumns = `minmax(200px, 260px) repeat(${order.length}, 30px)`;
    grid.append(el('div', 'at-grid-corner',
      el('span', '', 'Referenced by', arrowIcon('down')),
      el('span', '', 'References', arrowIcon())));
    for (const c of order) {
      grid.append(tip(btn(`at-col-h${state.cell?.to === c ? ' on' : ''}`, undefined, () => actions.pickType(c), el('span', '', typeName(model, c))), () => typeTip(model, c)));
    }
    for (const r of order) {
      const t = model.types[r];
      grid.append(tip(btn(`at-row-h${state.cell?.from === r ? ' on' : ''}`, undefined, () => actions.pickType(r),
        glyph(r, 14), el('span', 'at-row-hn', typeName(model, r)), t?.count != null ? el('span', 'at-ct', num(t.count)) : null), () => typeTip(model, r)));
      for (const c of order) {
        const n = count.get(`${r}>${c}`) ?? 0;
        const band = state.cell && (state.cell.from === r || state.cell.to === c) ? ' band' : '';
        if (!n) { grid.append(el('span', `at-cell none${band}`)); continue; }
        const on = state.cell?.from === r && state.cell.to === c;
        const b = tip(btn(`at-cell${on ? ' on' : ''}${n >= 4 ? ' dark' : ''}`, undefined, () => actions.pickCell(r, c), String(n)), () => [
          tipTitle(refLine(typeName(model, r), typeName(model, c))),
          ...edgeList(model, plural(n, 'reference'), edgesBetween(model, r, c)),
          ...(r === c ? [] : edgeList(model, refLine(typeName(model, c), typeName(model, r)), edgesBetween(model, c, r))),
        ]);
        b.setAttribute('aria-label', `${typeName(model, r)} references ${typeName(model, c)}: ${plural(n, 'reference')}`);
        b.style.setProperty('--a', String(Math.min(1, 0.12 + 0.2 * Math.log2(n + 1))));
        grid.append(b);
      }
    }
    main.replaceChildren(el('div', 'at-grid-wrap', grid));
  }

  function refRows(state: AtlasState, model: AtlasModel, edges: AtlasEdge[], pick: (e: AtlasEdge) => void): HTMLElement[] {
    return edges.map(e => tip(btn('at-pr', undefined, () => pick(e), el('span', 'at-pr-p', e.prop), bar(shareOf(model, e)), el('span', 'at-pr-n', e.filled != null ? String(e.filled) : '')), () => edgeTip(state, model, e)));
  }

  function inspCell(state: AtlasState, model: AtlasModel): void {
    if (!state.cell) {
      insp.replaceChildren(el('div', 'at-k', plural(gridOrder(model).length, 'type')), el('h2', 'at-h', plural(model.edges.length, 'reference')));
      return;
    }
    const { from, to } = state.cell;
    const fromName = typeName(model, from), toName = typeName(model, to);
    const context = `${from}>${to}`;
    const there = edgesBetween(model, from, to), back = from === to ? [] : edgesBetween(model, to, from);
    const seen = model.types[from]?.seen;
    const a = part(there, PAIR_SHOWN, ['all', context, 'there']);
    const b = part(back, PAIR_SHOWN, ['all', context, 'back']);
    insp.replaceChildren(
      el('div', 'at-k', plural(there.length, 'reference')), heading(refLine(fromName, toName), `${fromName} references ${toName}`),
      el('div', 'at-cap', el('span', '', 'Filled'), el('span', '', seen != null ? `of ${num(seen)}` : '')),
      ...refRows(state, model, a.shown, e => actions.pickProp(from, e.prop)), ...(a.toggle ? [a.toggle] : []),
      ...(back.length ? [el('div', 'at-cap', el('span', 'at-cap-n', refLine(toName, fromName)), el('span', '', String(back.length))),
        ...refRows(state, model, b.shown, e => actions.pickProp(to, e.prop)), ...(b.toggle ? [b.toggle] : [])] : []),
      el('div', 'at-acts', btn('ui-btn primary at-btn-n', fromName, () => actions.pickType(from), fromName), btn('ui-btn', undefined, () => actions.routeBetween(from, to), 'Route')),
    );
  }

  // ── One type ────────────────────────────────────────────────────

  function sideCard(model: AtlasModel, cls: string, edges: AtlasEdge[], on: boolean, title: string): HTMLButtonElement {
    const t = model.types[cls];
    return tip(btn(`at-card${on ? ' on' : ''}`, undefined, () => actions.pickType(cls), glyph(cls),
      el('span', 'at-card-n', typeName(model, cls)), el('span', 'at-card-v', plural(edges.length, 'ref')), t?.count != null ? el('span', 'at-ct', num(t.count)) : null),
    () => [tipTitle(fullTypeName(model, cls), cls), tipLine('Objects', t?.count != null ? num(t.count) : ''), ...edgeList(model, title, edges)]);
  }

  const colCap = (text: string, n: number) => el('div', 'at-colcap', el('span', '', text), el('span', 'at-colcap-n', num(n)));

  function renderType(state: AtlasState, model: AtlasModel): void {
    const cls = state.focus;
    if (!cls) { redraw = null; main.replaceChildren(empty('Pick a type')); return; }
    const byFill = (a: AtlasEdge, b: AtlasEdge) => (b.filled ?? -1) - (a.filled ?? -1) || a.prop.localeCompare(b.prop);
    const own = model.edges.filter(e => e.from === cls).sort(byFill);
    const inBy = new Map<string, AtlasEdge[]>(), outBy = new Map<string, AtlasEdge[]>();
    for (const e of model.edges) if (e.to.includes(cls) && e.from !== cls) inBy.set(e.from, [...(inBy.get(e.from) ?? []), e]);
    for (const e of own) for (const t of e.to) if (t !== cls) outBy.set(t, [...(outBy.get(t) ?? []), e]);
    const picked = own.find(e => e.prop === state.prop) ?? null;
    const byRefs = (m: Map<string, AtlasEdge[]>) => [...m].sort((a, b) => b[1].length - a[1].length || typeName(model, a[0]).localeCompare(typeName(model, b[0])));

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'at-lines');
    const leftCards = new Map<string, HTMLElement>(), rightCards = new Map<string, HTMLElement>(), rowEls = new Map<string, HTMLElement>();
    const ins = part(byRefs(inBy), SIDE_SHOWN, ['type', cls, 'in']);
    const outs = part(byRefs(outBy), SIDE_SHOWN, ['type', cls, 'out'], ([c]) => picked?.to.includes(c) ?? false);
    const left = el('div', 'at-col', inBy.size ? colCap('Referenced by', inBy.size) : null);
    for (const [c, edges] of ins.shown) { const card = sideCard(model, c, edges.sort(byFill), false, 'References'); leftCards.set(c, card); left.append(card); }
    if (ins.toggle) left.append(ins.toggle);
    const right = el('div', 'at-col', outBy.size ? colCap('References', outBy.size) : null);
    for (const [c, edges] of outs.shown) { const card = sideCard(model, c, edges, picked?.to.includes(c) ?? false, 'References'); rightCards.set(c, card); right.append(card); }
    if (outs.toggle) right.append(outs.toggle);

    const t = model.types[cls];
    const headRow = tip(btn(`at-focus-h${picked ? '' : ' on'}`, undefined, () => actions.pickProp(cls, null), glyph(cls, 18),
      el('span', 'at-focus-n', typeName(model, cls)), t?.count != null ? el('span', 'at-ct', num(t.count)) : null), () => typeTip(model, cls));
    const focus = el('div', 'at-focus', headRow);
    const rows = part(own, ROWS_SHOWN, ['type', cls, 'rows'], e => e.prop === state.prop);
    for (const e of rows.shown) {
      const row = tip(btn(`at-row${e.prop === state.prop ? ' on' : ''}${e.filled === 0 ? ' zero' : ''}`, undefined, () => actions.pickProp(cls, e.prop === state.prop ? null : e.prop),
        el('span', 'at-row-p', e.prop), e.to.includes(cls) ? el('span', 'at-tag', 'itself') : null, bar(shareOf(model, e)), el('span', 'at-row-n', e.filled != null ? String(e.filled) : '')),
      () => edgeTip(state, model, e));
      rowEls.set(e.prop, row);
      focus.append(row);
    }
    if (rows.toggle) { rows.toggle.classList.add('at-row-more'); focus.append(rows.toggle); }
    if (own.length === 0) focus.append(el('div', 'at-row-none', 'No references'));
    const star = el('div', 'at-star', svg, left, el('div', 'at-mid', focus), right);
    main.replaceChildren(star);

    redraw = () => {
      const box = star.getBoundingClientRect();
      svg.replaceChildren();
      svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      const f = focus.getBoundingClientRect();
      for (const card of leftCards.values()) link(svg, box, card.getBoundingClientRect(), f, 'at-e');
      for (const [c, card] of rightCards) if (!picked?.to.includes(c)) link(svg, box, f, card.getBoundingClientRect(), 'at-e');
      const r = picked ? rowEls.get(picked.prop)?.getBoundingClientRect() : undefined;
      if (picked && r) for (const c of picked.to) { const card = rightCards.get(c); if (card) link(svg, box, f, card.getBoundingClientRect(), 'at-e hot', undefined, r.top + r.height / 2); }
    };
    redraw();
  }

  function hitRow(h: UsageHit): HTMLElement {
    const where = h.where.split('›').pop()?.trim() ?? '';
    return tip(btn('at-use', undefined, () => actions.openObject({ rid: h.rid, id: h.businessId, name: h.name, cls: h.type }),
      el('span', 'at-use-n', h.name || h.businessId || where || h.type), el('span', 'at-use-w', h.name ? where : h.codeProp)),
    () => [tipTitle(h.name || h.businessId || h.type, h.type), tipLine('ID', h.businessId), tipLine('Parent', h.where), tipLine('Property', h.codeProp)]);
  }

  /** "1,200 of 8,400 objects" while the code copy is read; "" before the first batch. */
  const usageRead = (u: AtlasUsage | null): string => {
    if (u?.state !== 'loading' || !u.read) return '';
    return u.toRead ? `${num(u.read)} of ${plural(u.toRead, 'object')}` : plural(u.read, 'object');
  };

  function usedIn(state: AtlasState, prop: string): HTMLElement[] {
    const u = state.usage;
    const cap = (n: string) => el('div', 'at-cap', el('span', '', 'Used in'), el('span', '', n));
    if (!u || u.state === 'loading') return [cap(''), loadingNote('at-usage', 'Reading the code copy', el('span', 'at-uread', usageRead(u)), u?.since ?? null)];
    if (u.state === 'none') {
      // While a copy is made, the shared progress (lib/copy-progress) says everything.
      if (u.making && copyProgress) return [cap(''), el('div', 'at-hint at-copying', copyProgress)];
      const making = u.making ? el('p', 'at-note', u.making.toRead ? `${num(u.making.read)} of ${num(u.making.toRead)}` : '') : null;
      return [cap(''), el('div', 'at-hint', el('p', '', u.reason), making, u.canMake ? btn('ui-btn primary', undefined, () => actions.makeCopy(), u.resume ? 'Resume' : 'Make a copy') : null)];
    }
    const hits = u.byProp[prop] ?? [];
    const out: HTMLElement[] = [cap(String(hits.length))];
    for (const g of groupHits(hits)) {
      const p = part(g.hits, HITS_SHOWN, ['use', `${state.focus}|${prop}`, g.type]);
      out.push(el('div', 'at-grp', line('at-grp-n', typeLabel(g.type)), el('span', '', String(g.hits.length))));
      for (const h of p.shown) out.push(hitRow(h));
      if (p.toggle) out.push(p.toggle);
    }
    out.push(tip(el('p', 'at-note at-cover', `Code copy${u.at ? ` ${readDate(u.at)}` : ''}`), () => [tipLine('Objects with code', num(u.objects))]));
    return out;
  }

  function inspType(state: AtlasState, model: AtlasModel): void {
    const cls = state.focus;
    if (!cls) { insp.replaceChildren(); return; }
    const edge = model.edges.find(e => e.from === cls && e.prop === state.prop);
    const t = model.types[cls];
    if (!edge) {
      const own = model.edges.filter(e => e.from === cls).length;
      const inn = model.edges.filter(e => e.to.includes(cls)).length;
      const fact = (label: string, value: string) => el('div', 'at-pr at-kv', el('span', 'at-pr-p', label), el('span', '', value));
      const full = fullTypeName(model, cls);
      insp.replaceChildren(el('div', 'at-k', 'Type'), heading(full, full), line('at-sub at-mono at-line', cls),
        el('div', 'at-cap'),
        fact('Objects', t?.count != null ? num(t.count) : model.unread.includes(cls) ? 'not read' : ''), fact('References', num(own)), fact('Referenced by', num(inn)),
        el('div', 'at-acts', btn('ui-btn', undefined, () => actions.routeBetween(cls, null), 'Route')));
      return;
    }
    const seen = t?.seen ?? 0, filled = edge.filled;
    const toNames = edge.to.map(c => typeName(model, c));
    const to = toNames.length ? nameList(toNames) : 'none';
    const sub = el('p', 'at-sub at-sub-ref', refLine(typeName(model, cls), to));
    sub.title = `${typeName(model, cls)} references ${toNames.length ? toNames.join(', ') : 'none'}`;
    insp.replaceChildren(
      el('div', 'at-k', `${edge.historical ? 'Historical reference' : 'Reference'}${edge.multi ? ' · Multiselect' : ''}${edge.advanced ? ' · Advanced' : ''}`),
      tip(heading(edge.prop, edge.prop, 'at-mono'), () => edgeTip(state, model, edge)),
      ...(edge.label ? [line('at-sub at-line', edge.label)] : []),
      sub,
      filled != null
        ? el('div', 'at-fact', el('b', '', String(filled)), el('span', '', ` ${fillText(model, edge).replace(/^\d+ /, '')} filled`), seen - filled > 0 ? el('small', '', `${num(seen - filled)} empty`) : null)
        : el('p', 'at-note', 'Not read'),
      ...(edge.to.length === 1 ? [el('div', 'at-acts', btn('ui-btn', undefined, () => actions.routeBetween(cls, edge.to[0]), 'Route'))] : []),
      ...usedIn(state, edge.prop),
    );
  }

  // ── Route ───────────────────────────────────────────────────────

  function typeSelect(model: AtlasModel, value: string | null, label: string, pick: (cls: string | null) => void): HTMLElement {
    const s = el('select', 'at-sel') as HTMLSelectElement;
    s.setAttribute('aria-label', label);
    s.append(new Option('Pick a type', ''));
    for (const cls of gridOrder(model).sort((a, b) => typeName(model, a).localeCompare(typeName(model, b)))) s.append(new Option(typeName(model, cls), cls));
    s.value = value ?? '';
    s.title = value ? typeName(model, value) : '';
    s.addEventListener('change', () => pick(s.value || null));
    return s;
  }

  function routeTip(state: AtlasState, model: AtlasModel, x: AtlasRoute): Array<HTMLElement | null> {
    const steps = x.steps.map((s, i) => {
      const owner = s.dir === 'out' ? x.classes[i] : x.classes[i + 1];
      const e = model.edges.find(d => d.from === owner && d.prop === s.prop);
      return el('div', 'at-tip-l', el('span', 'at-mono', stepLabel(s)), el('span', '', e ? fillText(model, e) : ''));
    });
    return [tipTitle(typeTrail(x.classes.map(c => typeName(model, c)))), el('div', 'at-tip-c', 'Filled'), ...steps,
      tipLine('Route', x.fill != null ? `${Math.round(x.fill * 100)} %` : ''),
      tipLine('Used in code', state.usage?.state === 'ready' ? num(x.used) : '')];
  }

  function renderRoute(state: AtlasState, model: AtlasModel): void {
    const r = state.route;
    const pickers = el('div', 'at-ends', el('span', '', 'From'), typeSelect(model, r.from, 'From', c => actions.routeBetween(c, r.to)),
      btn('ui-ibtn', 'Other direction', () => actions.swapRoute(), icon('i-swap')),
      el('span', '', 'to'), typeSelect(model, r.to, 'To', c => actions.routeBetween(r.from, c)));
    if (!r.from || !r.to) { redraw = null; main.replaceChildren(el('div', 'at-route', pickers, empty('Pick two types'))); return; }
    const from = r.from, to = r.to;
    const chosen = pickedRoute(r);
    if (!chosen) { redraw = null; main.replaceChildren(el('div', 'at-route', pickers, empty('No route'))); return; }
    const direct = r.routes.filter(x => x.steps.length === 1);
    const via = new Map<string, AtlasRoute[]>();
    for (const x of r.routes) if (x.steps.length === 2) via.set(x.classes[1], [...(via.get(x.classes[1]) ?? []), x]);
    const rows = r.rows;
    const passed = (i: number, cls: string): string => {
      if (!rows || r.loading) return '';
      const n = new Set(rows.map(row => row[i]?.rid)).size;
      const total = model.types[cls]?.count;
      return r.scope === 'all' && total != null ? `${num(n)} of ${num(total)}` : num(n);
    };
    const pill = (cls: string, on: boolean, step: number | null, note: string, pick: (() => void) | null, more: () => Array<HTMLElement | null>): HTMLElement => {
      const kids = [step != null ? el('i', '', String(step)) : glyph(cls, 14), el('span', 'at-pill-n', typeName(model, cls)), note ? el('small', '', note) : null];
      return tip(pick ? btn(`at-pill${on ? ' on' : ''}`, undefined, pick, ...kids) : el('div', `at-pill${on ? ' on' : ''}`, ...kids), more);
    };
    const two = chosen.steps.length === 2;
    const endTip = (i: number, cls: string) => () => [...typeTip(model, cls), tipLine('On this route', passed(i, cls))];
    const fromPill = pill(from, true, 1, passed(0, from), null, endTip(0, from));
    const toPill = pill(to, true, two ? 3 : 2, passed(chosen.steps.length, to), null, endTip(chosen.steps.length, to));
    const mids = new Map<string, HTMLElement>();
    const midCol = el('div', 'at-gcol');
    const ordered = [...via].sort((a, b) => r.routes.indexOf(a[1][0]) - r.routes.indexOf(b[1][0]));
    // The chosen type sits in the middle of the column, so its line runs straight.
    const chosenMid = two ? chosen.classes[1] : null;
    const midPart = part(ordered, MIDS_SHOWN, ['route', `${from}>${to}`, 'via'], ([c]) => c === chosenMid);
    const rest = midPart.shown.filter(([c]) => c !== chosenMid);
    const half = Math.ceil(rest.length / 2);
    const mine = midPart.shown.find(([c]) => c === chosenMid);
    const column = mine ? [...rest.slice(0, half), mine, ...rest.slice(half)] : midPart.shown;
    for (const [c, list] of column) {
      const on = c === chosenMid;
      const p = pill(c, on, on ? 2 : null, on ? passed(1, c) : plural(list.length, 'route'), () => actions.pickRoute(routeKey(list[0])), () => [
        tipTitle(fullTypeName(model, c), c), el('div', 'at-tip-c', plural(list.length, 'route')),
        ...list.slice(0, 6).map(x => el('div', 'at-tip-l', stepTrail(x, 'at-mono'), el('span', '', x.empty ? 'empty' : x.fill != null ? `${Math.round(x.fill * 100)} %` : ''))),
        more(list.length - 6)]);
      mids.set(c, p);
      midCol.append(p);
    }
    if (midPart.toggle) { midPart.toggle.classList.add('at-gmore'); midCol.append(midPart.toggle); }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'at-lines');
    const labels = el('div', 'at-glabels');
    const graph = el('div', `at-graph${direct.length ? ' has-direct' : ''}`, svg, labels, el('div', 'at-gcol at-gend', fromPill), midCol, el('div', 'at-gcol at-gend', toPill));

    const canOne = state.home != null && state.home.cls === from;
    const code = routeEc(chosen.steps, r.start);
    const copy = btn('ui-btn', undefined, () => actions.copy(code, copy), icon('i-copy'), el('span', 'at-copy-t', 'Copy'));
    const rowsTab = r.loading ? el('span', 'at-tab-l', spinner(), 'Objects') : rows ? plural(Math.max(r.total, rows.length), 'row') : 'Objects';
    const tabs = el('div', 'at-tabs',
      btn(`at-tab${r.tab === 'rows' ? ' on' : ''}`, undefined, () => actions.setTab('rows'), rowsTab),
      btn(`at-tab${r.tab === 'code' ? ' on' : ''}`, undefined, () => actions.setTab('code'), 'Extended Code'),
      el('span', 'at-grow'),
      r.tab === 'code'
        ? segment('at-start', [['this.object', 'this.object'], ['this', 'this']], r.start, v => actions.setStart(v))
        : segment('', [['all', `All ${model.types[from]?.count != null ? num(model.types[from].count) : ''}`.trim()], ['one', 'This one']], r.scope, v => actions.setScope(v), canOne ? [] : ['one']),
      copy,
      btn('ui-btn primary', undefined, () => actions.openCode(routeEc(chosen.steps, 'this.object'), canOne ? state.home?.rid : undefined), 'Open in Extended Code'));
    let body: HTMLElement;
    if (r.tab === 'code') body = el('pre', 'at-code', code);
    else if (r.loading) {
      const count = model.types[from]?.count;
      const start = r.scope === 'one' && canOne ? 'From one object'
        : count != null ? count > ATLAS_ROUTE_START ? `From the first ${num(ATLAS_ROUTE_START)} of ${plural(count, 'object')}` : `From ${plural(count, 'object')}` : null;
      body = loadingNote('at-pad', 'Reading the objects of this route', start, r.since);
    } else if (r.error) body = el('p', 'at-note at-pad', r.error);
    else if (!rows || rows.length === 0) body = el('p', 'at-note at-pad', 'No rows');
    else {
      const table = el('table', 'at-table');
      table.append(el('tr', '', ...chosen.classes.map(c => { const th = el('th', '', typeName(model, c)); th.title = fullTypeName(model, c); return th; })));
      let prev: AtlasObjectRef[] | null = null;
      for (const row of rows.slice(0, 200)) {
        const before = prev;
        table.append(el('tr', '', ...row.map((o, i) => el('td', '', tip(btn(`at-obj${before && before[i]?.rid === o.rid && i < row.length - 1 ? ' same' : ''}`, undefined, () => actions.openObject(o), o.name || o.id || o.rid),
          () => [tipTitle(o.name || o.id || o.rid, o.cls), tipLine('ID', o.id)])))));
        prev = row;
      }
      const big = r.scope === 'all' && (model.types[from]?.count ?? 0) > ATLAS_ROUTE_START;
      const note = `${big ? `First ${ATLAS_ROUTE_START} objects, 10 per step. ` : ''}${r.total > 200 ? `200 of ${num(r.total)} rows.` : ''}`.trim();
      body = el('div', 'at-rows', table, note ? el('p', 'at-note at-pad', note) : null);
    }
    main.replaceChildren(el('div', 'at-route', pickers, graph, el('div', 'at-sheet', tabs, body)));

    redraw = () => {
      const box = graph.getBoundingClientRect();
      svg.replaceChildren();
      labels.replaceChildren();
      svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      const a = fromPill.getBoundingClientRect(), b = toPill.getBoundingClientRect();
      const width = (n: number) => 1.2 + 1.2 * Math.log2(n + 1);
      const label = (text: string, x: number, y: number, quiet = false) => { const l = el('span', `at-glabel${quiet ? ' quiet' : ''}`, text); l.title = text; l.style.left = `${x}px`; l.style.top = `${y}px`; labels.append(l); };
      if (direct.length) {
        const x1 = a.left + a.width / 2 - box.left, x2 = b.left + b.width / 2 - box.left;
        path(svg, `M${x1} ${a.top - box.top} C${x1} 4 ${x2} 4 ${x2} ${b.top - box.top}`, two ? 'at-e dash' : 'at-e hot', two ? width(direct.length) : undefined);
        label(two ? `${num(direct.length)} direct` : stepLabel(chosen.steps[0]), (x1 + x2) / 2, 14, two);
      }
      for (const [c, list] of via) {
        const pillEl = mids.get(c);
        if (c === chosenMid || !pillEl) continue;
        const m = pillEl.getBoundingClientRect();
        link(svg, box, a, m, 'at-e', width(new Set(list.map(x => x.steps[0].prop)).size));
        link(svg, box, m, b, 'at-e', width(new Set(list.map(x => x.steps[1].prop)).size));
      }
      const chosenEl = chosenMid ? mids.get(chosenMid) : undefined;
      if (chosenEl) {
        const m = chosenEl.getBoundingClientRect();
        link(svg, box, a, m, 'at-e hot');
        link(svg, box, m, b, 'at-e hot');
        const cy = (p: DOMRect, q: DOMRect) => (p.top + p.height / 2 + q.top + q.height / 2) / 2 - box.top - 20;
        label(stepLabel(chosen.steps[0]), (a.right + m.left) / 2 - box.left, cy(a, m));
        label(stepLabel(chosen.steps[1]), (m.right + b.left) / 2 - box.left, cy(m, b));
      }
    };
    redraw();
  }

  function inspRoute(state: AtlasState, model: AtlasModel): void {
    const r = state.route;
    if (!r.from || !r.to) { insp.replaceChildren(el('div', 'at-k', 'Routes')); return; }
    const chosen = pickedRoute(r);
    const chosenKey = chosen ? routeKey(chosen) : null;
    const list = part(r.routes, ROUTES_SHOWN, ['route', `${r.from}>${r.to}`, 'routes'], x => routeKey(x) === chosenKey);
    const fromName = typeName(model, r.from), toName = typeName(model, r.to);
    const out: HTMLElement[] = [el('div', 'at-k', plural(r.routes.length, 'route')), heading(typeTrail([fromName, toName]), `From ${fromName} to ${toName}`)];
    let group = '';
    for (const x of list.shown) {
      const g = x.steps.length === 1 ? 'Direct' : typeName(model, x.classes[1]);
      if (g !== group) { out.push(el('div', 'at-cap', line('at-cap-n', g))); group = g; }
      const note = x.empty ? 'empty' : x.fill != null ? `${Math.round(x.fill * 100)} %` : '';
      out.push(tip(btn(`at-rt${routeKey(x) === chosenKey ? ' on' : ''}${x.empty ? ' zero' : ''}`, undefined, () => actions.pickRoute(routeKey(x)),
        stepTrail(x), bar(x.fill, 'sm'), el('span', 'at-rt-n', note)), () => routeTip(state, model, x)));
    }
    if (list.toggle) out.push(list.toggle);
    insp.replaceChildren(...out);
  }

  // ── Frame ───────────────────────────────────────────────────────

  /** The head and the strip of a running read; the reading view of a first open. */
  function live(state: AtlasState): void {
    const model = state.model;
    const types = model ? gridOrder(model).length : 0;
    root.classList.toggle('busy', state.reading);
    refresh.disabled = state.reading;
    // While a read runs, the strip below says what runs and which copy is in use.
    if (state.reading) { read.textContent = ''; read.title = ''; }
    else if (model && state.fetchedAt) {
      const failed = state.error ? 'Read failed. ' : '';
      read.textContent = `${failed}${readSummary(types, model.edges.length, state.readMs)} · ${asOf(state.fetchedAt)}`;
      read.title = state.error ?? `Read ${readDate(state.fetchedAt)}`;
    } else { read.textContent = ''; read.title = ''; }

    const p = state.progress;
    const at = p?.startedAt ?? state.readSince;
    const stepText = p ? progressLine(p) : 'Starting';
    const share = p ? progressShare(p) : 0;
    strip.hidden = !(state.reading && model);
    if (state.reading && model) {
      let t = strip.querySelector<HTMLElement>('.at-ptext');
      if (!t) {
        t = el('span', 'at-ptext');
        strip.replaceChildren(spinner(), t, el('span', 'at-pstep'), since(at), el('span', 'at-pbar', el('i')));
      }
      t.textContent = `Reading the types again. The copy ${asOf(state.fetchedAt ?? Date.now())} stays in use until the read ends.`;
    } else strip.replaceChildren();
    for (const s of root.querySelectorAll<HTMLElement>('.at-pstep')) s.textContent = stepText;
    for (const b of root.querySelectorAll<HTMLElement>('.at-pbar > i')) b.style.width = `${Math.round(share * 100)}%`;
    for (const e of root.querySelectorAll<HTMLElement>('.at-el')) if (at != null && e.closest('.at-progress, .at-first')) e.dataset.since = String(at);
    for (const u of root.querySelectorAll<HTMLElement>('.at-uread')) u.textContent = usageRead(state.usage);
    tick();
  }

  function render(state: AtlasState): void {
    lastState = state;
    hideTip();
    server.textContent = state.server;
    server.title = state.server;
    seg.replaceChildren(...views.map(([v, label]) => btn(`at-seg-b${state.view === v ? ' on' : ''}`, undefined, () => actions.setView(v), label)));
    notice.hidden = !state.notice;
    notice.replaceChildren(el('span', '', state.notice ?? ''), btn('ui-ibtn ui-ibtn-sm', 'Close', () => actions.dismissNotice(), icon('i-x')));
    if (input.value !== state.query) input.value = state.query;
    menu.hidden = state.matches.length === 0;
    menu.replaceChildren(...state.matches.map(m => m.kind === 'type'
      ? btn('at-menu-b', undefined, () => actions.pickType(m.cls), glyph(m.cls, 14), el('span', 'at-menu-n', m.name), el('span', 'ui-id', m.cls))
      : btn('at-menu-b', undefined, () => actions.pickProp(m.cls, m.prop), el('span', 'at-menu-n at-mono', m.prop), el('span', 'ui-id', m.name))));

    const model = state.model;
    if (!model) {
      redraw = null;
      insp.replaceChildren();
      main.replaceChildren(state.reading
        ? el('div', 'ui-empty at-first', el('p', 'ui-empty-title', 'Reading the types of this server'),
          el('p', 'ui-empty-text at-pstep'), el('span', 'at-pbar wide', el('i')),
          el('p', 'ui-empty-text', 'Atlas opens when the read ends. ', since(state.readSince)))
        : empty('Not read', state.error ?? '', el('div', 'ui-empty-actions', btn('ui-btn', undefined, () => actions.refresh(), 'Try again'))));
    } else if (state.view === 'all') { renderAll(state, model); inspCell(state, model); }
    else if (state.view === 'type') { renderType(state, model); inspType(state, model); }
    else { renderRoute(state, model); inspRoute(state, model); }
    live(state);
  }

  return { render, live, focusSearch: () => input.focus(), mark };
}
