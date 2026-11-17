/**
 * Browse tab — find any object, with the structure of where you are.
 *
 * Empty query, scope Here: the location crumb, then the structure of the
 * page's object (the object window's structure machinery; a data object adds
 * its presenting template under "Presented by"), with the current position
 * marked; Pinned and Recent below. Typing replaces that with grouped,
 * ranked results: an exact RID / ID first ("Go to"), "On this page", then
 * "Workspace" (the blended cache + live quickSearch), and the hand-off to code
 * search last.
 *
 * The parts: state.ts (rules, no DOM), source.ts (requests and answers),
 * view.ts (drawing). This file wires them to the panel.
 */

import { matchesShortcut, whichShortcut } from '../../lib/shortcuts';
import type { BmpObject, InspectorMessage } from '../../lib/types';
import type { BrowseNode, BrowseTree } from '../../lib/browse-tree';
import { rowFactsNote } from '../../lib/row-facts-status';
import type { Tab, SendFn } from './tab-types';
import { S } from '../state';
import { el, statusFlash } from '../../lib/dom';
import { copyText, copyWithFeedback } from '../../lib/copy-feedback';
import { SEARCH_DEBOUNCE } from '../../lib/constants';
import { BrowseSource } from './browse/source';
import type { LiveState } from './browse/state';
import {
  availability, buildResults, currentRow, defaultCollapsed, ancestorsOf, isEnterpriseType, listsOpenByDefault, moveSelection,
  tokens, visibleTree, type Entry, type Results, type Scope, type TypeFilter,
} from './browse/state';
import * as V from './browse/view';

/** How long a page may report "no object" before its tree is cleared. */
const PAGE_LEAVE_GRACE = 600;
/** Saves in a burst (a Blueprint apply, several steps) re-read the shown tree once. */
export const TREE_REFRESH_DEBOUNCE = 500;

export class BrowseTab implements Tab {
  private readonly src: BrowseSource;
  private readonly shell: V.Shell;
  private mounted: HTMLElement | null = null;

  private query = '';
  private scope: Scope = 'here';
  private type: TypeFilter = 'all';
  /** Rid of the page the Here tree shows (the page's own object). */
  private pageRid: string | null = null;
  /** Folded rows per page, and the rows already given their default. */
  private readonly collapsed = new Map<string, { set: Set<string>; seen: Set<string> }>();
  /** Pages whose "Presented by" group the user folded or opened (it starts open). */
  private readonly templateOpen = new Map<string, boolean>();
  /** The keyboard moved the selection (its ring and actions show); a
   *  pointer selection or the auto-selected first result shows neither. */
  private keyDriven = false;
  /** Rows visible in the results when Show more was clicked. */
  private moreFrom: number | null = null;
  private moreAuto = 0;
  /** Pinned / Recent open state the user chose (else the default). */
  private readonly sections: Record<string, boolean> = {};
  /** Key (`t:rid`, `p:rid`, `more`, …) of the keyboard selection. */
  private selected: string | null = null;
  /** The user moved the selection; until then a query keeps the first row selected. */
  private userMoved = false;
  private navKeys: string[] = [];
  /** Last marked current position; a change scrolls it into view. */
  private shownCurrent: string | null = null;
  private scrollToCurrent = false;
  private flashKey: string | null = null;
  private picking = false;
  private enabledInspectForPick = false;
  private menu: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private focusInput = false;
  /** A save changed the server while Browse was hidden: its trees are re-read
   *  when it is shown, not at once. */
  private treesStale = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly send: SendFn, private readonly onOpen: (rid: string) => void) {
    this.src = new BrowseSource(send);
    this.src.onLocated = (rid, found) => this.located(rid, found);
    this.shell = V.buildShell();
    this.wire();
  }

  // ── Tab interface ──────────────────────────────────────────────

  activate(): void {
    this.focusInput = true;
    if (this.treesStale) {
      this.treesStale = false;
      this.src.invalidateTrees(this.avail().tree ? this.pageRid : null);
    }
    this.send({ type: 'GET_PAGE_INFO' });
    this.send({ type: 'GET_HISTORY' });
    this.send({ type: 'GET_FAVORITES' });
    this.syncPage(S.page?.rid ?? null);
    // The position may have moved while the tab was hidden.
    this.followPosition();
    if (this.query.trim()) this.src.search(this.query, this.avail().live);
  }

  deactivate(): void {
    this.closeMenu();
    if (this.picking) this.disarm();
  }

  findObject(rid: string): BmpObject | null {
    const node = this.nodes()?.find(n => n.rid === rid);
    const now = Date.now();
    if (node) return { rid, name: node.name, type: node.type, businessId: node.businessId, source: 'server', discoveredAt: now, updatedAt: now };
    const hit = this.src.live.items.find(o => o.rid === rid) ?? this.src.cache.find(o => o.rid === rid);
    if (hit) return hit;
    if (this.src.resolved?.rid === rid) {
      const r = this.src.resolved;
      return { rid, name: r.name, type: r.type, businessId: r.businessId, source: 'server', discoveredAt: now, updatedAt: now };
    }
    const kept = S.favoriteEntries.find(f => f.rid === rid) ?? this.src.history.find(e => e.rid === rid);
    return kept ? { rid, name: kept.name, type: kept.type, businessId: kept.businessId, source: 'server', discoveredAt: now, updatedAt: now } : null;
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'PAGE_INFO':
        this.syncPage(msg.rid ?? null);
        return true;
      case 'CONTEXT_RID_DATA':
        // The orchestrator already stored the position in S.context.
        if (this.picking && msg.rid && (msg.source === 'badge' || msg.source === 'contextmenu')) this.disarm();
        this.followPosition();
        return true;
      case 'CONNECTION_STATE':
        if (this.pageRid && this.avail().tree && !this.src.trees.get(this.pageRid)?.tree) this.loadTree();
        return true;
      case 'ACTIVITY_ENTRY':
        // A save changes structure or names: the page's tree is re-read, once
        // per burst of saves while Browse is shown, else when it is shown next.
        if (msg.entry.category === 'change' && msg.entry.level === 'success') this.treesChanged();
        return false;
      case 'FAVORITES_DATA':
        return true;
      case 'INSPECT_STATE':
        return this.picking;
      case 'PROFILE_SWITCHED':
        this.src.reset();
        this.treesStale = false;
        if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
        if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
        this.collapsed.clear();
        this.pageRid = null;
        this.selected = null;
        return true;
      default: {
        const changed = this.src.handle(msg);
        if (changed && msg.type === 'BROWSE_SEARCH_RESULT') this.afterLivePage();
        return changed;
      }
    }
  }

  render(container: HTMLElement): void {
    if (this.shell.root.parentElement !== container) {
      container.replaceChildren(this.shell.root);
      V.mountSprites(container.ownerDocument);
    }
    this.mounted = container;
    this.draw();
    if (this.focusInput) {
      this.focusInput = false;
      try { this.shell.input.focus({ preventScroll: true }); } catch { /* fine */ }
    }
  }

  /** Context pill: show Browse's tree with the current position revealed. */
  revealCurrent(): void {
    this.setQuery('');
    this.scope = 'here';
    const cur = currentRow(this.nodes(), S.context?.rid);
    if (cur) {
      this.expandTo(cur);
      this.selected = `t:${cur}`;
      this.flashKey = `t:${cur}`;
    }
    this.scrollToCurrent = true;
  }

  /** Escape anywhere in the panel cancels a pick. */
  cancelPick(): boolean {
    if (!this.picking) return false;
    this.disarm();
    this.draw();
    return true;
  }

  // ── data plumbing ──────────────────────────────────────────────

  private treesChanged(): void {
    if (S.activeTab !== 'browse') {
      this.treesStale = true;
      return;
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (S.activeTab !== 'browse') { this.treesStale = true; return; }
      this.src.invalidateTrees(this.avail().tree ? this.pageRid : null);
      if (this.mounted) this.draw();
    }, TREE_REFRESH_DEBOUNCE);
  }

  private avail() {
    return availability(S.connState.display, this.src.live.status === 'error' ? this.src.live.error : null);
  }

  private nodes(): BrowseNode[] | null {
    return this.pageRid ? this.src.trees.get(this.pageRid)?.tree?.nodes ?? null : null;
  }

  private syncPage(rid: string | null): void {
    if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
    if (rid === this.pageRid) {
      if (rid && !this.src.trees.has(rid)) this.loadTree();
      return;
    }
    // A reloading BMP page first reports "no object" for a moment, then its
    // object again: blanking the tree for that moment is a flash. A page
    // that is really gone clears after a short wait.
    if (!rid && this.pageRid) {
      this.leaveTimer = setTimeout(() => {
        this.leaveTimer = null;
        if (S.page?.rid) return;
        this.setPage(null);
        if (this.mounted) this.draw();
      }, PAGE_LEAVE_GRACE);
      return;
    }
    this.setPage(rid);
  }

  private setPage(rid: string | null): void {
    this.pageRid = rid;
    if (this.selected?.startsWith('t:')) this.selected = null;
    this.shownCurrent = null;
    this.scrollToCurrent = true;
    if (rid) this.loadTree();
  }

  private loadTree(): void {
    if (!this.pageRid || !this.avail().tree) return;
    const hint = S.context?.rid === this.pageRid ? S.context.type : undefined;
    this.src.loadTree(this.pageRid, hint);
  }

  /** Folded rows of this page. Rows seen for the first time (the whole tree,
   *  or a presenting template that arrives after the page's own rows) get
   *  the default folding; the user's choices for known rows stay. */
  private collapsedFor(nodes: readonly BrowseNode[]): Set<string> {
    const key = this.pageRid ?? '';
    let entry = this.collapsed.get(key);
    if (!entry) {
      entry = { set: new Set(), seen: new Set() };
      this.collapsed.set(key, entry);
    }
    if (nodes.some(n => !entry.seen.has(n.rid))) {
      const defaults = defaultCollapsed(nodes, currentRow(nodes, S.context?.rid));
      for (const n of nodes) {
        if (entry.seen.has(n.rid)) continue;
        entry.seen.add(n.rid);
        if (defaults.has(n.rid)) entry.set.add(n.rid);
      }
    }
    return entry.set;
  }

  private expandTo(rid: string): void {
    const nodes = this.nodes();
    if (!nodes) return;
    const set = this.collapsedFor(nodes);
    for (const a of ancestorsOf(nodes, rid)) set.delete(a);
  }

  /** The current position moved: open its branch and bring it into view. */
  private followPosition(): void {
    const cur = currentRow(this.nodes(), S.context?.rid);
    if (cur && cur !== this.shownCurrent) {
      this.expandTo(cur);
      this.scrollToCurrent = true;
    }
  }

  private setQuery(q: string): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.query = q;
    if (this.shell.input.value !== q) this.shell.input.value = q;
    this.selected = null;
    this.userMoved = false;
    this.keyDriven = false;
    this.src.search(q, this.avail().live);
  }

  // ── drawing ────────────────────────────────────────────────────

  private draw(): void {
    if (!this.mounted) return;
    const s = this.shell;
    V.syncShell(s, { query: this.query, scope: this.scope, type: this.type, picking: this.picking });
    const keepTop = s.scroll.scrollTop;
    const q = this.query.trim();
    const body = q ? this.resultsBody(q) : this.homeBody();
    s.scroll.replaceChildren(...body);
    s.scroll.setAttribute('role', q ? 'listbox' : 'tree');
    s.scroll.setAttribute('aria-label', q ? 'Search results' : 'Page structure');
    this.navKeys = [...s.scroll.querySelectorAll<HTMLElement>('[data-key]')].map(e => e.dataset.key!);
    if (q && (!this.userMoved || !this.selected || !this.navKeys.includes(this.selected))) this.selected = this.navKeys[0] ?? null;
    if (!q && this.selected && !this.navKeys.includes(this.selected)) this.selected = null;
    this.markSelection();
    this.drawFoot(q);
    s.scroll.scrollTop = keepTop;
    this.afterDraw();
  }

  private afterDraw(): void {
    const s = this.shell;
    // A redraw under a resting pointer: the new row is hovered at once.
    let hovered: HTMLElement | null = null;
    try { hovered = s.scroll.querySelector<HTMLElement>('.bw-row:hover'); } catch { /* no :hover support */ }
    if (hovered) this.fitId(hovered);
    const cur = s.scroll.querySelector<HTMLElement>('.bw-row.cur');
    this.shownCurrent = cur?.dataset.rid ?? this.shownCurrent;
    if (this.scrollToCurrent && cur) {
      this.scrollToCurrent = false;
      const cr = cur.getBoundingClientRect();
      const sr = s.scroll.getBoundingClientRect();
      if (cr.top < sr.top + 8 || cr.bottom > sr.bottom - 8) s.scroll.scrollTop += cr.top - sr.top - (sr.height - cr.height) / 2;
    }
    if (this.flashKey) {
      const row = s.scroll.querySelector<HTMLElement>(`[data-key="${CSS.escape(this.flashKey)}"]`);
      this.flashKey = null;
      if (row) {
        row.scrollIntoView({ block: 'nearest' });
        row.classList.remove('flash');
        void row.offsetWidth;
        row.classList.add('flash');
      }
    }
  }

  private markSelection(): void {
    const s = this.shell;
    const q = !!this.query.trim();
    for (const r of s.scroll.querySelectorAll('.kb, .sel, .kf')) r.classList.remove('kb', 'sel', 'kf');
    const row = this.selected ? s.scroll.querySelector<HTMLElement>(`[data-key="${CSS.escape(this.selected)}"]`) : null;
    if (row) {
      // A result keeps its band whoever selected it; the ring and the row
      // actions show only for a keyboard selection.
      if (q && !row.classList.contains('bw-more')) row.classList.add('sel');
      if (this.keyDriven) {
        row.classList.add('kf');
        if (!q || row.classList.contains('bw-more')) row.classList.add('kb');
        this.fitId(row);
      }
      s.input.setAttribute('aria-activedescendant', row.id);
    } else {
      s.input.removeAttribute('aria-activedescendant');
    }
  }

  private drawFoot(q: string): void {
    const f = this.shell.foot;
    if (!q) { f.hidden = true; return; }
    f.hidden = false;
    const row = this.selected ? this.shell.scroll.querySelector<HTMLElement>(`[data-key="${CSS.escape(this.selected)}"]`) : null;
    f.replaceChildren(...V.footer(!!row?.dataset.onpage));
  }

  private homeBody(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const avail = this.avail();
    let treeRows = 0;
    let loading = false;
    if (this.scope === 'here') {
      if (!avail.tree) {
        out.push(V.note(`Page structure needs a connection. ${avail.reason ?? ''}`.trim(), { link: { act: 'connect', text: 'Connect' } }));
      } else if (!this.pageRid) {
        out.push(V.empty(S.bmpDetected === false ? 'This tab is not a BMP page.' : 'Open a BMP page to see its structure.'));
      } else {
        const entry = this.src.trees.get(this.pageRid);
        const tree = entry?.tree ?? null;
        const pageName = tree?.nodes[0]?.name || (S.context?.rid === this.pageRid ? S.context.name : '') || '';
        // The location line holds its place from the first frame: a
        // placeholder until the crumbs are known (they answer first), then
        // the crumbs, or nothing for a page without ancestors (it would
        // only repeat the tree's first row). The loading mark sits inside
        // it, so the rows below never move.
        // Until they are known, a placeholder line only when the page's type is
        // known and is not an enterprise object (those sit under a workspace
        // root: no crumbs). Unknown: no placeholder, so a wrong guess can at
        // most move the skeleton, never the real rows.
        const crumbs = tree?.crumbs ?? entry?.crumbs ?? null;
        const reading = !tree && entry?.status !== 'error';
        const pageType = S.context?.rid === this.pageRid ? S.context.type ?? '' : '';
        const page = pageName ? { rid: this.pageRid, name: pageName } : null;
        if (crumbs === null) {
          if (!reading) out.push(V.crumbs([], { rid: this.pageRid, name: pageName }));
          else if (pageType && !isEnterpriseType(pageType)) out.push(V.skeletonCrumb());
        } else if (crumbs.length) out.push(V.crumbs(crumbs, page, reading));
        if (!tree && entry?.status === 'error') {
          out.push(V.note('The page structure could not be read.', { link: { act: 'retry', text: 'Retry' } }));
        } else if (!tree) {
          out.push(...V.skeletonTree());
          loading = true;
        } else {
          const rows = this.treeRows(tree.nodes, tree.presented);
          treeRows = rows.length;
          out.push(...rows);
          if (tree.structureError) out.push(V.note('Only part of the structure could be listed.'));
          else if (tree.structureTruncatedAt) out.push(V.note(`Showing the first ${tree.structureTruncatedAt} nodes of the structure.`));
          // Rows without names say why, with Retry.
          if (tree.rowFactsError) out.push(V.note(rowFactsNote(tree.rowFactsError), { link: { act: 'retry', text: 'Retry' } }));
          if (tree.rootFallback) out.push(V.note(tree.rootFallback));
          else if (tree.fallback && tree.nodes.length > 1) out.push(V.note('Showing the object and its direct children.'));
        }
      }
    }
    // Pinned and Recent wait for the tree, so they do not jump when it lands.
    if (!loading) out.push(...this.lists(listsOpenByDefault(this.scope, this.query, treeRows)));
    return out;
  }

  /** "Presented by" starts open; the user's fold or unfold on a page is kept. */
  private templateIsOpen(): boolean {
    return this.templateOpen.get(this.pageRid ?? '') ?? true;
  }

  private treeRows(nodes: readonly BrowseNode[], presented: BrowseTree['presented']): HTMLElement[] {
    const collapsed = this.collapsedFor(nodes);
    const cur = currentRow(nodes, S.context?.rid);
    const out: HTMLElement[] = [];
    const ctx = S.context;
    const tplCount = nodes.filter(n => n.group === 1).length;
    const tplOpen = this.templateIsOpen();
    for (const raw of visibleTree(nodes, collapsed)) {
      if (raw.group === 1) break;
      out.push(this.treeRow(raw, collapsed, cur, ctx));
    }
    if (presented === 'loading' || (presented === 'loaded' && tplCount)) {
      out.push(V.toggleGroup('tpl', 'Presented by', presented === 'loading' ? null : tplCount, tplOpen, presented === 'loading'));
      if (tplOpen) {
        if (presented === 'loading') out.push(V.status('Reading the template'));
        else for (const raw of visibleTree(nodes, collapsed)) if (raw.group === 1) out.push(this.treeRow(raw, collapsed, cur, ctx));
      }
    } else if (presented && presented !== 'loaded') {
      out.push(V.group('Presented by'));
      out.push(el('div', 'bw-quiet', presented === 'none' ? 'No template presents this object.' : 'The template could not be read.'));
    }
    return out;
  }

  private treeRow(raw: BrowseNode, collapsed: ReadonlySet<string>, cur: string | null, ctx: typeof S.context): HTMLElement {
    // A data object's read can lack its ID; the position may know it.
    const n = !raw.businessId && ctx?.rid === raw.rid && ctx.businessId ? { ...raw, businessId: ctx.businessId } : raw;
    return V.treeRow(n, { expanded: !collapsed.has(n.rid), current: n.rid === cur, selected: this.selected === `t:${n.rid}` });
  }

  private lists(openByDefault: boolean): HTMLElement[] {
    const out: HTMLElement[] = [];
    const pinned: Entry[] = S.favoriteEntries.map(f => this.keptEntry(f.rid, f.name, f.type, f.businessId, f.templateBusinessId));
    const pins = new Set(pinned.map(p => p.rid));
    const recent: Entry[] = this.src.history.filter(e => !pins.has(e.rid)).slice(0, 8)
      .map(e => this.keptEntry(e.rid, e.name, e.type, e.businessId, e.templateBusinessId));
    const section = (key: string, label: string, items: Entry[]) => {
      if (!items.length) return;
      const open = this.sections[key] ?? openByDefault;
      out.push(V.toggleGroup(key, label, items.length, open));
      if (open) for (const e of items) out.push(V.listRow(e, `${key}:${e.rid}`, this.selected === `${key}:${e.rid}`));
    };
    section('pin', 'Pinned', pinned);
    section('rec', 'Recent', recent);
    return out;
  }

  private keptEntry(rid: string, name?: string, type?: string, businessId?: string, templateBusinessId?: string): Entry {
    const node = this.nodes()?.find(n => n.rid === rid);
    const id = templateBusinessId || businessId || '';
    return { rid, name: node?.name ?? name ?? '', type: node?.type ?? type ?? '', id: node?.businessId || id, path: [], onPage: !!node };
  }

  private results(q: string): Results {
    const r = buildResults({
      query: q, scope: this.scope, type: this.type, nodes: this.nodes(),
      cache: this.src.cache, live: withConfig(this.src.live, this.src.config, q), resolved: this.src.resolvedQuery === q ? this.src.resolved : null,
      avail: this.avail(),
    });
    // A cut of the configuration search ("Showing the first 200 …").
    return this.src.configQuery === q && this.src.configNotice ? { ...r, searchNote: this.src.configNotice } : r;
  }

  private resultsBody(q: string): HTMLElement[] {
    return V.resultsBody({ results: this.results(q), query: q, toks: tokens(q), selected: this.selected });
  }

  // ── actions ────────────────────────────────────────────────────

  private open(rid: string): void {
    this.onOpen(rid);
  }

  /** Copy the row's ID (Shift: the RID). `feedback` is the element that
   *  shows the result (the ID itself, or the Copy button); the status line
   *  says which value was copied once the write succeeded. */
  private copy(rid: string, rawRid: boolean, feedback?: HTMLElement): void {
    const id = this.findObject(rid);
    const entry = this.idFor(rid) || id?.businessId || '';
    const asRid = rawRid || !entry;
    const text = asRid ? rid : entry;
    const done = (ok: boolean) => { if (ok) statusFlash(`Copied ${asRid ? 'RID' : 'ID'} ${text}`); };
    if (feedback) {
      void copyWithFeedback(text, feedback, {
        okClass: 'copied', failClass: 'copy-failed',
        ...(feedback.classList.contains('bw-id') ? { textTarget: feedback, ms: 900 } : {}),
      }).then(done);
    } else {
      void copyText(text).then(done);
    }
  }

  /** Hide a row's ID while its actions show, but only when the two would
   *  actually touch at this width. */
  private fitId(row: HTMLElement): void {
    row.classList.remove('idc');
    const id = row.querySelector<HTMLElement>('.bw-id');
    const acts = row.querySelector<HTMLElement>('.bw-acts');
    const lbl = id?.parentElement;
    if (!id || !acts || !lbl) return;
    const box = id.getBoundingClientRect();
    if (!box.width || box.top >= lbl.getBoundingClientRect().bottom) return; // not shown anyway
    const buttons = acts.querySelectorAll('button').length;
    // Actions sit 4 px from the row's end, 24 px each, over an 8 px fade.
    const start = row.getBoundingClientRect().right - 4 - buttons * 24 - 8;
    if (box.right > start) row.classList.add('idc');
  }

  /** The ID a row shows (template ID first), as Copy ID copies it. */
  private idFor(rid: string): string {
    const row = this.shell.scroll.querySelector<HTMLElement>(`[data-rid="${CSS.escape(rid)}"] .bw-id`);
    return row?.textContent ?? '';
  }

  private locate(rid: string): void {
    const nodes = this.nodes();
    const chain = nodes?.some(n => n.rid === rid) ? [rid, ...ancestorsOf(nodes, rid)] : [rid];
    this.src.locate(chain);
  }

  private located(rid: string, found: string | null): void {
    if (!found) { statusFlash('Not visible on this page'); return; }
    if (found === rid) { statusFlash('Located on the page'); return; }
    const holder = this.nodes()?.find(n => n.rid === found);
    statusFlash(`Located its widget${holder?.name ? `, ${holder.name}` : ''}`);
  }

  private reveal(rid: string): void {
    this.setQuery('');
    this.scope = 'here';
    this.expandTo(rid);
    this.selected = `t:${rid}`;
    this.flashKey = `t:${rid}`;
    this.draw();
  }

  /** Show more. A page whose hits are all filtered out or already listed
   *  would add nothing, so up to three more pages follow on their own until
   *  a row is added. */
  private more(): void {
    if (this.src.live.moreLoading) return;
    this.moreFrom = this.results(this.query.trim()).rest.items.length;
    this.moreAuto = 0;
    this.src.more();
    this.draw();
  }

  private afterLivePage(): void {
    if (this.moreFrom === null || this.src.live.moreLoading) return;
    const shown = this.results(this.query.trim()).rest.items.length;
    if (shown <= this.moreFrom && this.src.live.more && this.moreAuto < 3) {
      this.moreAuto++;
      this.src.more();
      return;
    }
    this.moreFrom = null;
  }

  private handOff(): void {
    const q = this.query.trim();
    if (q) this.send({ type: 'OPEN_CODE_SEARCH', query: q });
  }

  private activateSelected(): void {
    const key = this.selected;
    if (!key) return;
    if (key === 'more') { this.more(); return; }
    if (key === 'code') { this.handOff(); return; }
    const rid = key.slice(key.indexOf(':') + 1);
    if (rid) this.open(rid);
  }

  private toggle(rid: string, open?: boolean): void {
    const nodes = this.nodes();
    if (!nodes) return;
    const set = this.collapsedFor(nodes);
    const isOpen = !set.has(rid);
    if (open === isOpen) return;
    if (isOpen) set.add(rid); else set.delete(rid);
    this.draw();
  }

  private arm(): void {
    this.picking = true;
    if (!S.inspectActive) {
      this.enabledInspectForPick = true;
      this.send({ type: 'SET_INSPECT_STATE', active: true });
    }
  }

  private disarm(): void {
    this.picking = false;
    if (this.enabledInspectForPick) {
      this.enabledInspectForPick = false;
      this.send({ type: 'SET_INSPECT_STATE', active: false });
    }
  }

  private openMenu(): void {
    if (this.menu) { this.closeMenu(); return; }
    const s = this.shell;
    const menu = V.typeMenu(this.type);
    menu.style.left = `${s.typeBtn.offsetLeft}px`;
    menu.style.top = `${s.typeBtn.offsetTop + s.typeBtn.offsetHeight + 4}px`;
    s.root.append(menu);
    s.typeBtn.setAttribute('aria-expanded', 'true');
    this.menu = menu;
    menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }

  private closeMenu(): void {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    this.shell.typeBtn.setAttribute('aria-expanded', 'false');
  }

  // ── events ─────────────────────────────────────────────────────

  private wire(): void {
    const s = this.shell;
    s.input.addEventListener('input', () => {
      this.query = s.input.value;
      this.selected = null;
      this.userMoved = false;
      this.keyDriven = false;
      s.field.classList.toggle('has', this.query.length > 0);
      if (this.timer) clearTimeout(this.timer);
      if (!this.query.trim()) { this.setQuery(''); this.draw(); return; }
      // Local matches (tree, touched) show at once; the requests wait for a pause.
      this.draw();
      this.timer = setTimeout(() => { this.timer = null; this.src.search(this.query, this.avail().live); this.draw(); }, SEARCH_DEBOUNCE);
    });
    s.input.addEventListener('keydown', e => this.onKey(e, true));
    s.scroll.addEventListener('keydown', e => this.onKey(e, false));
    // Row actions show on hover: hide the ID under them only where they meet.
    s.scroll.addEventListener('pointerover', e => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.bw-row');
      if (row && !row.contains(e.relatedTarget as Node | null)) this.fitId(row);
    });

    s.root.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const a = t.closest<HTMLElement>('[data-act]');
      if (this.menu && !t.closest('.bw-menu') && a?.dataset.act !== 'type-menu') this.closeMenu();
      if (!a || !s.root.contains(a)) return;
      const rid = a.dataset.rid ?? '';
      switch (a.dataset.act) {
        case 'clear': this.setQuery(''); this.draw(); s.input.focus(); return;
        case 'scope': this.scope = (a.dataset.scope as Scope) ?? 'here'; this.selected = null; if (this.scope === 'here') this.syncPage(S.page?.rid ?? this.pageRid); this.draw(); return;
        case 'type-menu': this.openMenu(); return;
        case 'type': this.type = (a.dataset.type as TypeFilter) ?? 'all'; this.closeMenu(); this.draw(); s.typeBtn.focus(); return;
        case 'pick': if (this.picking) this.disarm(); else this.arm(); this.draw(); return;
        case 'toggle': e.stopPropagation(); this.toggle(rid); return;
        case 'section': {
          const key = a.dataset.sec ?? '';
          const open = a.getAttribute('aria-expanded') !== 'true';
          if (key === 'tpl') this.templateOpen.set(this.pageRid ?? '', open);
          else this.sections[key] = open;
          this.draw();
          return;
        }
        case 'crumb': if (rid) this.open(rid); return;
        case 'retry': if (this.pageRid) { this.src.trees.delete(this.pageRid); this.loadTree(); this.draw(); } return;
        case 'connect': document.querySelector<HTMLElement>('.tab[data-tab="connect"]')?.click(); return;
        case 'more': this.selected = 'more'; this.userMoved = true; this.keyDriven = false; this.more(); return;
        case 'code': this.handOff(); return;
        case 'open': e.stopPropagation(); this.open(rid); return;
        case 'copy': e.stopPropagation(); this.copy(rid, (e as MouseEvent).shiftKey, a); return;
        case 'copyid': e.stopPropagation(); this.copy(rid, (e as MouseEvent).shiftKey, a); return;
        case 'locate': e.stopPropagation(); this.locate(rid); return;
        case 'reveal': e.stopPropagation(); this.reveal(rid); return;
        case 'row': {
          this.selected = a.dataset.key ?? null;
          this.userMoved = true;
          this.keyDriven = false;
          this.markSelection();
          this.drawFoot(this.query.trim());
          if (rid) this.open(rid);
          return;
        }
      }
    });

    s.root.addEventListener('keydown', e => {
      if (!this.menu || !this.menu.contains(e.target as Node)) return;
      const items = [...this.menu.querySelectorAll<HTMLElement>('button')];
      const i = items.indexOf(e.target as HTMLElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeMenu(); s.typeBtn.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    });

    document.addEventListener('mousedown', e => {
      if (this.menu && !(e.target as HTMLElement).closest('.bw-menu, .ui-tbtn')) this.closeMenu();
    });

    // "/" focuses the search from anywhere in the panel (not while typing).
    document.addEventListener('keydown', e => {
      if (!this.mounted || !this.mounted.classList.contains('active') || !matchesShortcut(e, 'browse.search')) return;
      e.preventDefault();
      s.input.focus();
      s.input.select();
    });
  }

  private onKey(e: KeyboardEvent, inInput: boolean): void {
    const q = this.query.trim();
    const s = this.shell;
    // Keys from lib/shortcuts.ts. The letter keys never fire in the field.
    const id = whichShortcut(e, ['browse.move', 'browse.open', 'browse.reveal', 'browse.collapse', 'browse.back', 'browse.copyRid', 'browse.copyId', 'browse.locate']);
    switch (id) {
      case 'browse.move': {
        e.preventDefault();
        const from = !q ? (currentRow(this.nodes(), S.context?.rid) ? `t:${currentRow(this.nodes(), S.context?.rid)}` : null) : null;
        this.selected = moveSelection(this.navKeys, this.selected, e.key === 'ArrowDown' ? 1 : -1, from);
        this.userMoved = true;
        this.keyDriven = true;
        this.markSelection();
        this.drawFoot(q);
        const row = this.selected ? s.scroll.querySelector<HTMLElement>(`[data-key="${CSS.escape(this.selected)}"]`) : null;
        row?.scrollIntoView({ block: 'nearest' });
        return;
      }
      case 'browse.open':
        if (this.selected) { e.preventDefault(); this.activateSelected(); }
        return;
      case 'browse.reveal': {
        const row = this.selected ? s.scroll.querySelector<HTMLElement>(`[data-key="${CSS.escape(this.selected)}"]`) : null;
        if (!row) return;
        if (q) {
          if (row.dataset.onpage && (!inInput || s.input.selectionStart === s.input.value.length)) { e.preventDefault(); this.keyDriven = true; this.reveal(row.dataset.rid!); }
        } else if (this.selected?.startsWith('t:') && (!inInput || !s.input.value)) {
          e.preventDefault();
          this.keyDriven = true;
          const rid = row.dataset.rid!;
          if (row.getAttribute('aria-expanded') === 'false') this.toggle(rid, true);
          else if (row.getAttribute('aria-expanded') === 'true') {
            this.selected = moveSelection(this.navKeys, this.selected, 1);
            this.markSelection();
          }
        }
        return;
      }
      case 'browse.collapse': {
        if (q || !this.selected?.startsWith('t:') || (inInput && s.input.value)) return;
        e.preventDefault();
        this.keyDriven = true;
        const rid = this.selected.slice(2);
        const node = this.nodes()?.find(n => n.rid === rid);
        if (node?.kids && !this.collapsedFor(this.nodes()!).has(rid)) this.toggle(rid, false);
        else if (node?.parent) { this.selected = `t:${node.parent}`; this.markSelection(); }
        return;
      }
      case 'browse.back':
        // One step per press: cancel the pick, clear the query, drop the
        // selection, then leave the field.
        if (this.picking) { e.preventDefault(); this.disarm(); this.draw(); }
        else if (this.query) { e.preventDefault(); this.setQuery(''); this.draw(); }
        else if (this.selected) { e.preventDefault(); this.selected = null; this.keyDriven = false; this.markSelection(); }
        else if (inInput) s.input.blur();
        return;
      case 'browse.copyId':
      case 'browse.copyRid':
      case 'browse.locate': {
        if (inInput || !this.selected) return;
        const rid = this.selected.slice(this.selected.indexOf(':') + 1);
        if (!/^-?\d+$/.test(rid)) return;
        e.preventDefault();
        if (id === 'browse.locate') this.locate(rid);
        else this.copy(rid, id === 'browse.copyRid');
        return;
      }
    }
  }
}

/** The portal search's hits plus the configuration objects the server
 *  search found by name and ID (the portal search does not list those). */
function withConfig(live: LiveState, config: readonly BmpObject[], q: string): LiveState {
  if (!config.length || live.query !== q.trim()) return live;
  const seen = new Set(live.items.map(o => o.rid));
  const extra = config.filter(o => !seen.has(o.rid));
  return extra.length ? { ...live, status: live.status === 'loading' ? 'ready' : live.status, items: [...live.items, ...extra], totalHits: live.totalHits + extra.length } : live;
}
