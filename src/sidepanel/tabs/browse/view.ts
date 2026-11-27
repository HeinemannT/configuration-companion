/**
 * Browse tab — view. Builds the persistent search bar once and redraws the
 * scrolling body from a plain model. Rows follow the object window's tree:
 * inset bands with rounded hover, no per-row rules, a 16 px muted type icon,
 * name first and the ID after it in mono, one line per row (two for search
 * results: name, then where it is).
 *
 * Every interactive element carries `data-act` (and `data-key` for rows that
 * take the keyboard selection); the tab wires one delegated listener.
 */

import { shortcutDef, shortcutLabel, shortcutLabels, withShortcut, type ShortcutId } from '../../../lib/shortcuts';
import type { BrowseCrumb, BrowseNode } from '../../../lib/browse-tree';
import { typeInfo, typeLabel } from '../../../lib/object-window-table';
import { ICON_SPRITE } from '../../../lib/icon-sprite';
import { emptyState } from '../../../lib/empty-state';
import { TYPE_FILTERS, type Entry, type Results, type Scope, type TypeFilter } from './state';
import { attrs, el, icon } from '../../../lib/dom';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Symbols Browse needs beyond the object window's sprite. */
const BROWSE_SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="b-locate" viewBox="0 0 16 16"><path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2"/><circle cx="8" cy="8" r="1.5"/></symbol>
<symbol id="b-cur" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/></symbol>
<symbol id="b-ret" viewBox="0 0 16 16"><path d="M13 4v4.5a1 1 0 0 1-1 1H4M6.5 7 4 9.5 6.5 12"/></symbol>
<symbol id="b-pick" viewBox="0 0 16 16"><path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3"/><path d="m8 8 6 2.2-2.6 1.2-1.2 2.6z"/></symbol>
<symbol id="b-reveal" viewBox="0 0 16 16"><path d="M3 3.5h4M5 3.5v9M5 8h3M5 12.5h3M10 8h3M10 12.5h3"/></symbol>
</defs></svg>`;

let spriteMounted = false;
export function mountSprites(doc: Document = document): void {
  if (spriteMounted || doc.getElementById('bw-sprites')) return;
  const host = doc.createElement('div');
  host.id = 'bw-sprites';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  host.innerHTML = ICON_SPRITE + BROWSE_SPRITE;
  doc.body.appendChild(host);
  spriteMounted = true;
}


/** Text with every query token underlined. */
export function marked(text: string, toks: readonly string[]): Node[] {
  if (!toks.length || !text) return [document.createTextNode(text)];
  const re = new RegExp(`(${toks.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
  // split() with one capture group: odd pieces are the matches.
  const out: Node[] = [];
  text.split(re).forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 0) { out.push(document.createTextNode(part)); return; }
    const m = document.createElement('mark');
    m.textContent = part;
    out.push(m);
  });
  return out;
}

/** The type icon; its tooltip names the type. */
function kindIcon(type: string): SVGSVGElement {
  const s = icon(typeInfo(type).icon, 'kind');
  const label = typeText(type);
  if (label) {
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = label;
    s.prepend(t);
  }
  return s;
}

/** Type for people (the shared label); nothing for an unknown type. */
const typeText = (type: string): string => (type ? typeLabel(type) : '');

/** Second line of a result: where the object is. A row of this page shows
 *  its path inside the page (nothing for a row right under the page); a
 *  workspace hit its location, else its type. Null: a one-line row. */
export function whereLine(e: Entry): string | null {
  if (e.path.length) return e.path.join(' › ');
  return e.onPage ? null : typeText(e.type) || null;
}

// ── shell (built once) ────────────────────────────────────────────

export interface Shell {
  root: HTMLElement;
  input: HTMLInputElement;
  field: HTMLElement;
  clear: HTMLButtonElement;
  seg: HTMLElement;
  typeBtn: HTMLButtonElement;
  typeLbl: HTMLElement;
  pickHint: HTMLElement;
  pick: HTMLButtonElement;
  scroll: HTMLElement;
  foot: HTMLElement;
}

export function buildShell(): Shell {
  const input = attrs(el('input', 'bw-q ui-input') as HTMLInputElement, {
    id: 'browse-q', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'browse-list',
    'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Search name, ID or RID', 'aria-label': 'Search objects',
  });
  const clear = attrs(el('button', 'ui-ibtn bw-clr', icon('i-x', 'ic-sm')) as HTMLButtonElement, {
    type: 'button', 'data-act': 'clear', title: withShortcut('Clear', 'browse.back'), 'aria-label': 'Clear search',
  });
  const field = el('div', 'bw-field', icon('i-search', 'bw-field-ic'), input,
    attrs(el('kbd', 'bw-kbd', shortcutLabel('browse.search')), { title: `Press ${shortcutLabel('browse.search')} to search` }), clear);
  const seg = attrs(el('div', 'bw-seg',
    attrs(el('button', '', 'Here'), { type: 'button', 'data-act': 'scope', 'data-scope': 'here', title: 'The structure of this page; a search finds its objects first, then the workspace' }),
    attrs(el('button', '', 'Workspace'), { type: 'button', 'data-act': 'scope', 'data-scope': 'workspace', title: 'Search the whole workspace' }),
  ), { role: 'group', 'aria-label': 'Search scope' });
  const typeLbl = el('span', '', 'All types');
  const typeBtn = attrs(el('button', 'ui-tbtn', typeLbl, icon('i-chev', 'ic-sm')) as HTMLButtonElement, {
    type: 'button', 'data-act': 'type-menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Filter results by type',
  });
  // While picking, this line takes the type filter's place in the toolbar,
  // so nothing below moves.
  const pickHint = attrs(el('span', 'bw-pickhint', 'Click an object'), { role: 'status', hidden: '', title: 'Click an object on the BMP page. Esc cancels.' });
  const pick = attrs(el('button', 'ui-ibtn', icon('b-pick')) as HTMLButtonElement, {
    type: 'button', 'data-act': 'pick', 'aria-pressed': 'false',
    title: 'Pick an element on the page', 'aria-label': 'Pick an element on the page',
  });
  const tools = el('div', 'bw-tools', seg, typeBtn, pickHint, el('span', 'bw-sp'), pick);
  const scroll = attrs(el('div', 'bw-scroll'), { id: 'browse-list', tabindex: '-1' });
  const foot = attrs(el('div', 'bw-foot'), { hidden: '' });
  const root = el('div', 'bw ui', el('div', 'bw-bar', field, tools), scroll, foot);
  return { root, input, field, clear, seg, typeBtn, typeLbl, pickHint, pick, scroll, foot };
}

export function syncShell(s: Shell, m: { query: string; scope: Scope; type: TypeFilter; picking: boolean }): void {
  s.field.classList.toggle('has', m.query.length > 0);
  for (const b of s.seg.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.scope === m.scope));
  s.typeLbl.textContent = TYPE_FILTERS.find(t => t.value === m.type)?.label ?? 'All types';
  s.typeBtn.classList.toggle('on', m.type !== 'all');
  // The type filter only filters results: no query, no filter.
  s.typeBtn.hidden = m.picking || !m.query.trim();
  s.pickHint.hidden = !m.picking;
  s.pick.setAttribute('aria-pressed', String(m.picking));
  s.pick.title = m.picking ? 'Picking: click an object on the page (Esc cancels)' : 'Pick an element on the page';
}

export function typeMenu(current: TypeFilter): HTMLElement {
  return attrs(el('div', 'bw-menu ui-menu', ...TYPE_FILTERS.map(t =>
    attrs(el('button', '', icon('i-check', 'ic-sm bw-ck'), t.label), {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(t.value === current), 'data-act': 'type', 'data-type': t.value,
    }))), { role: 'menu', 'aria-label': 'Type filter' });
}

// ── rows ──────────────────────────────────────────────────────────

/** Hover / keyboard actions. At most three; `reveal` replaces `locate` on a
 *  result that is on this page. */
function actions(e: { rid: string; id: string }, third: 'locate' | 'reveal' | null): HTMLElement {
  const btn = (act: string, ic: string, title: string) =>
    attrs(el('button', 'ui-ibtn', icon(ic)), { type: 'button', tabindex: '-1', 'data-act': act, 'data-rid': e.rid, title, 'aria-label': title });
  return el('span', 'bw-acts',
    btn('open', 'i-popout', 'Open in object window'),
    btn('copy', 'i-copy', e.id ? 'Copy ID. Shift-click copies the RID' : 'Copy RID'),
    third === 'locate' ? btn('locate', 'b-locate', 'Locate on page') : null,
    third === 'reveal' ? btn('reveal', 'b-reveal', 'Reveal in tree (→)') : null,
  );
}

/** A long ID is cut in the middle when the column is narrow, so both its
 *  start and its end show (IDs of one family differ at the end). With
 *  query marks the ID stays whole and is cut at its end. */
const ID_TAIL = 5;
const cuts = (id: string, toks: readonly string[]): boolean => !toks.length && id.length > ID_TAIL + 5;
function idNodes(id: string, toks: readonly string[]): Node[] {
  if (!cuts(id, toks)) return marked(id, toks);
  return [el('span', 'h', id.slice(0, -ID_TAIL)), el('span', 't', id.slice(-ID_TAIL))];
}

/** Name, then the ID in mono. A click on the ID copies it (Shift: the RID)
 *  instead of opening the row. */
function label(rid: string, name: string, id: string, toks: readonly string[]): HTMLElement {
  return el('span', 'bw-lbl',
    el('span', `bw-nm${name ? '' : ' unnamed'}`, ...marked(name || '(unnamed)', toks)),
    id ? attrs(el('span', `bw-id ui-id${cuts(id, toks) ? ' mid' : ''}`, ...idNodes(id, toks)), { 'data-act': 'copyid', 'data-rid': rid, title: `Copy ${id}. Shift-click copies the RID` }) : null);
}

export interface TreeRowState {
  expanded: boolean;
  current: boolean;
  selected: boolean;
}

export function treeRow(n: BrowseNode, st: TreeRowState): HTMLElement {
  const chev = el('span', `bw-chev${n.kids && !st.expanded ? ' closed' : ''}`);
  if (n.kids) {
    chev.append(icon('i-chev', 'ic-sm'));
    attrs(chev, { 'data-act': 'toggle', 'data-rid': n.rid, title: st.expanded ? 'Collapse' : 'Expand' });
  }
  const name = n.name || n.businessId;
  // The marker sits inside the label, before the ID, so the ID keeps its
  // column at the row's end on the current row too.
  const lbl = label(n.rid, n.name, n.businessId, []);
  if (st.current) lbl.insertBefore(attrs(el('span', 'bw-mark', icon('b-cur', 'ic-sm')), { title: 'Current position' }), lbl.querySelector('.bw-id'));
  const row = attrs(el('div', `bw-row${st.current ? ' cur' : ''}${st.selected ? ' kb' : ''}`,
    chev, kindIcon(n.type), lbl,
    actions({ rid: n.rid, id: n.businessId }, 'locate'),
  ), {
    id: `bw-t-${n.rid}`, role: 'treeitem', 'data-key': `t:${n.rid}`, 'data-rid': n.rid, 'data-act': 'row',
    'aria-level': String(n.depth + 1), 'aria-selected': String(st.selected),
    'aria-expanded': n.kids ? String(st.expanded) : undefined,
    'aria-current': st.current ? 'location' : undefined,
    title: [name || '(unnamed)', n.businessId !== name ? n.businessId : '', typeText(n.type), st.current ? 'Current position' : ''].filter(Boolean).join(' · '),
  });
  row.style.setProperty('--d', String(n.depth));
  return row;
}

/** A Pinned or Recent row: one line, no indent. */
export function listRow(e: Entry, key: string, selected: boolean): HTMLElement {
  return attrs(el('div', `bw-row${selected ? ' kb' : ''}`,
    kindIcon(e.type), label(e.rid, e.name, e.id, []), actions(e, e.onPage ? 'locate' : null),
  ), {
    id: `bw-${key.replace(':', '-')}`, role: 'option', 'data-key': key, 'data-rid': e.rid, 'data-act': 'row',
    'aria-selected': String(selected),
    title: [e.name || '(unnamed)', e.id, typeText(e.type)].filter(Boolean).join(' · '),
  });
}

/** A search result: name and ID, then where it is. The path is shortened
 *  from its start, so the immediate parent always shows. */
export function resultRow(e: Entry, key: string, toks: readonly string[], selected: boolean): HTMLElement {
  const where = whereLine(e);
  return attrs(el('div', `bw-row res${where ? '' : ' one'}${selected ? ' sel' : ''}`,
    kindIcon(e.type),
    el('span', 'bw-body', label(e.rid, e.name, e.id, toks),
      where ? attrs(el('span', 'bw-path', el('bdi', '', where)), { dir: 'rtl' }) : null),
    el('span', 'bw-ret', icon('b-ret', 'ic-sm')),
    actions(e, e.onPage ? 'reveal' : null),
  ), {
    id: `bw-${key.replace(':', '-')}`, role: 'option', 'data-key': key, 'data-rid': e.rid, 'data-act': 'row',
    'data-onpage': e.onPage ? '1' : undefined, 'aria-selected': String(selected),
    title: [e.name || '(unnamed)', e.id, typeText(e.type), e.path.join(' › ')].filter(Boolean).join(' · '),
  });
}

// ── blocks ────────────────────────────────────────────────────────

/** The location line. `loading`: a quiet spinner at its end while the
 *  page's structure is read (the line does not change height). */
export function crumbs(items: readonly BrowseCrumb[], page: { rid: string; name: string } | null, loading = false): HTMLElement {
  const all = [...items, ...(page ? [{ rid: page.rid, type: '', name: page.name }] : [])];
  const nav = attrs(el('nav', 'bw-crumbs'), { 'aria-label': 'Location' });
  all.forEach((c, i) => {
    if (i) nav.append(icon('i-fwd', 'ic-sm bw-sep'));
    nav.append(attrs(el('button', `bw-crumb${i === all.length - 1 ? ' last' : ''}`, c.name || '…'), {
      type: 'button', 'data-act': 'crumb', 'data-rid': c.rid, title: `Open ${c.name || 'this object'} in the object window`,
    }));
  });
  if (loading) nav.append(el('span', 'bw-sp'), loadingMark('Reading page structure'));
  return nav;
}

/** A spinner that names what it waits for to assistive tech and on hover. */
function loadingMark(text: string): HTMLElement {
  return attrs(el('span', 'bw-spin'), { role: 'status', 'aria-label': text, title: text });
}

export function group(text: string, count?: number | null, extra?: Node | null): HTMLElement {
  return el('div', 'bw-grp', el('span', '', text),
    count != null || extra ? el('span', 'bw-gc', extra ?? null, count != null ? String(count) : null) : null);
}

/** A header that folds its rows: chevron first, as in the tree. `count`
 *  null with `loading` shows a spinner in its place. */
export function toggleGroup(key: string, text: string, count: number | null, open: boolean, loading = false): HTMLElement {
  return attrs(el('button', 'bw-grp tog', icon('i-chev', 'ic-sm bw-gchev'), el('span', 'bw-gt', text),
    el('span', 'bw-gc', loading ? loadingMark(`Reading ${text}`) : null, count != null ? String(count) : null)), {
    type: 'button', 'data-act': 'section', 'data-sec': key, 'aria-expanded': String(open),
  });
}

export function note(text: string, opts: { link?: { act: string; text: string } } = {}): HTMLElement {
  return el('div', 'bw-note',
    icon('i-info'),
    el('span', '', text, opts.link ? ' ' : null,
      opts.link ? attrs(el('button', 'bw-lnk', opts.link.text), { type: 'button', 'data-act': opts.link.act }) : null),
  );
}

/** What a locate that changed nothing on the page says, under its row
 *  (indented like the row; the tab sets `--d`). Spoken through the live region. */
export function locateNote(text: string): HTMLElement {
  return attrs(el('div', 'bw-locnote', icon('i-info', 'ic-sm'), el('span', '', text)), { 'aria-hidden': 'true' });
}

export function status(text: string): HTMLElement {
  return attrs(el('div', 'bw-status', el('span', 'bw-spin'), text), { role: 'status' });
}

export function skeletonTree(): HTMLElement[] {
  const rows: Array<[number, number]> = [[0, 55], [1, 38], [1, 62], [2, 48], [3, 58], [3, 52], [3, 44], [4, 50], [4, 46]];
  return rows.map(([d, w], i) => {
    const r = el('div', 'bw-sk', el('i', 'c'), el('i', 'i'), attrs(el('i', ''), { style: `width:${w}%` }));
    r.style.setProperty('--d', String(d));
    if (!i) attrs(r, { role: 'status', 'aria-label': 'Reading page structure' });
    return r;
  });
}

/** The location line's placeholder, same height as the line. */
export function skeletonCrumb(): HTMLElement {
  return el('div', 'bw-sk crumb', attrs(el('i', ''), { style: 'width:45%' }), el('span', 'bw-sp'), loadingMark('Reading page structure'));
}

export function skeletonRows(n: number): HTMLElement[] {
  return Array.from({ length: n }, (_, i) => el('div', 'bw-sk res', el('i', 'i'), attrs(el('i', ''), { style: `width:${i % 2 ? 34 : 46}%` })));
}

/** Nothing to list: the shared empty state (mascot, sentence, hint). */
export function empty(title: string, body = ''): HTMLElement {
  return emptyState({ title, text: body, art: 'sm', className: 'bw-empty' });
}

/** Show more, or the same control busy while the next page loads (same
 *  place, same height, keeps the keyboard selection). */
export function moreButton(loading: boolean, selected: boolean): HTMLElement {
  return attrs(el('button', `bw-more${selected ? ' kb' : ''}${loading ? ' busy' : ''}`,
    loading ? el('span', 'bw-spin') : null, loading ? 'Loading more' : 'Show more'), {
    type: 'button', id: 'bw-more', 'data-act': 'more', 'data-key': 'more',
    'aria-busy': loading ? 'true' : undefined, 'aria-disabled': loading ? 'true' : undefined,
    title: loading ? undefined : 'Load more results',
  });
}

export function codeRow(query: string, selected: boolean): HTMLElement {
  return attrs(el('div', `bw-row code${selected ? ' sel' : ''}`,
    icon('k-code', 'kind'),
    el('span', 'bw-lbl', el('span', 'bw-nm', 'Search inside code for ', el('q', '', query))),
  ), { id: 'bw-code', role: 'option', 'data-act': 'code', 'data-key': 'code', 'aria-selected': String(selected), title: `Open code search for “${query}”` });
}

/** Keyboard hints while typing; only the ones that apply now. */
export function footer(canReveal: boolean): Node[] {
  // From the registry (lib/shortcuts.ts), so the hints match the handlers.
  const hint = (id: ShortcutId) => el('span', '', ...shortcutLabels(id).map(t => el('kbd', '', t)), shortcutDef(id).hint ?? '');
  return [
    hint('browse.move'),
    hint('browse.open'),
    canReveal ? hint('browse.reveal') : null,
    hint('browse.copyId'),
    hint('browse.locate'),
  ].filter((n): n is HTMLElement => n !== null);
}

// ── results body ──────────────────────────────────────────────────

export interface ResultsView {
  results: Results;
  query: string;
  toks: readonly string[];
  selected: string | null;
}

/** Search results: Go to, On this page, Workspace (or Touched objects), the
 *  quiet degraded line, and the hand-off to code search last. */
export function resultsBody(v: ResultsView): HTMLElement[] {
  const r = v.results;
  const out: HTMLElement[] = [];
  const sel = (key: string) => v.selected === key;
  if (r.goTo) {
    out.push(group('Go to'));
    out.push(resultRow(r.goTo, `g:${r.goTo.rid}`, r.isRid ? [] : v.toks, sel(`g:${r.goTo.rid}`)));
  }
  if (r.note) out.push(note(r.note, { link: { act: 'connect', text: 'Connect' } }));
  if (r.searchNote) out.push(note(r.searchNote));
  if (r.onPage.length) {
    out.push(group('On this page', r.onPage.length));
    for (const e of r.onPage) out.push(resultRow(e, `p:${e.rid}`, v.toks, sel(`p:${e.rid}`)));
  }
  const rest = r.rest;
  if (!r.isRid && (rest.items.length || rest.loading)) {
    out.push(group(rest.label, rest.loading ? null : rest.items.length,
      rest.loading ? el('span', 'bw-gl', el('span', 'bw-spin'), 'Searching') : null));
    for (const e of rest.items) out.push(resultRow(e, `w:${e.rid}`, v.toks, sel(`w:${e.rid}`)));
    if (rest.loading) out.push(...skeletonRows(2));
    else if (rest.more || rest.moreLoading) out.push(moreButton(rest.moreLoading, sel('more')));
  }
  if (r.empty) {
    out.push(r.isRid
      ? empty(`No object has RID ${v.query}`, `${r.coverage} Check the number, or search by name or ID.`)
      : empty(`No objects match “${v.query}”`, `${r.coverage} ${r.note ? 'Connect to search the whole workspace.' : 'Check the spelling, or search by ID or RID.'}`));
  }
  out.push(codeRow(v.query, sel('code')));
  return out;
}
