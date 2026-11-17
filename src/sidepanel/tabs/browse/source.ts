/**
 * Browse tab — data source. Owns the requests to the service worker and the
 * answers it keeps: the Here tree per page (cached, refreshed on page change
 * and after a save), the touched-object cache matches, the live workspace
 * search with its pages, the exact RID / ID lookup, and Recent. No DOM.
 *
 * Every answer is matched to the request it belongs to (page rid, query,
 * generation), so a late answer never paints over a newer one.
 */

import type { BmpObject, HistoryEntry, InspectorMessage } from '../../../lib/types';
import type { BrowseCrumb, BrowseTree, ObjectHit } from '../../../lib/browse-tree';
import type { SendFn } from '../tab-types';
import { emptyLive, isIdLike, isRidQuery, type LiveState } from './state';

/** Live search page size. quickSearch drops sub-objects without a page of
 *  their own, so a page usually holds a few less. */
export const LIVE_PAGE_SIZE = 25;

export interface TreeEntry {
  status: 'loading' | 'ready' | 'error';
  tree: BrowseTree | null;
  error?: string;
  /** A refresh is under way while an older tree is shown. */
  refreshing: boolean;
  /** The page's ancestors, known before the tree (first answer); null
   *  until then. */
  crumbs: BrowseCrumb[] | null;
}

/** Live hits of every loaded page, de-duplicated by rid, in page order. */
function flatten(pages: readonly BmpObject[][]): BmpObject[] {
  const seen = new Set<string>();
  const out: BmpObject[] = [];
  for (const page of pages) for (const o of page) if (!seen.has(o.rid)) { seen.add(o.rid); out.push(o); }
  return out;
}

export class BrowseSource {
  /** Page rid → its tree. */
  readonly trees = new Map<string, TreeEntry>();
  cache: BmpObject[] = [];
  cacheQuery = '';
  live: LiveState = emptyLive();
  resolved: ObjectHit | null = null;
  resolvedQuery = '';
  /** Configuration objects found on the server by name and ID
   *  (OBJECT_SEARCH): the portal quick search does not list them. */
  config: BmpObject[] = [];
  configQuery = '';
  /** The configuration search's line for its results (a cut). */
  configNotice: string | null = null;
  history: HistoryEntry[] = [];

  private gen = 0;
  /** Query of the last GET_CACHE; other answers are dropped. */
  private wantCache = '';
  private resolveGen = 0;
  /** Called with (requested rid, found rid or null) when a locate answers. */
  onLocated: ((rid: string, found: string | null) => void) | null = null;

  constructor(private readonly send: SendFn) {}

  // ── Here tree ──────────────────────────────────────────────────

  /** Ask for a page's tree. A cached tree stays on screen while it refreshes. */
  loadTree(rid: string, typeHint?: string): void {
    const cur = this.trees.get(rid);
    if (cur?.status === 'loading' || cur?.refreshing) return;
    if (cur?.tree) cur.refreshing = true;
    else this.trees.set(rid, { status: 'loading', tree: null, refreshing: false, crumbs: cur?.crumbs ?? null });
    this.send({ type: 'BROWSE_TREE', rid, ...(typeHint ? { typeHint } : {}) });
  }

  /** After a save: drop every cached tree except `keep`, which refreshes in
   *  place (so the panel does not flash empty). */
  invalidateTrees(keep: string | null): void {
    for (const rid of [...this.trees.keys()]) if (rid !== keep) this.trees.delete(rid);
    if (keep) {
      const cur = this.trees.get(keep);
      if (cur && cur.status !== 'loading') {
        cur.refreshing = false;
        this.loadTree(keep);
      }
    }
  }

  // ── Search ─────────────────────────────────────────────────────

  /** Run a new query: touched objects, live search page 1, exact lookup. */
  search(query: string, liveAvailable: boolean): void {
    const q = query.trim();
    this.gen++;
    this.wantCache = q;
    if (q) this.send({ type: 'GET_CACHE', filter: q });
    else this.cache = [];
    if (!q) {
      this.live = emptyLive();
      this.resolved = null;
      this.resolvedQuery = '';
      this.config = [];
      this.configQuery = '';
      this.configNotice = null;
      this.send({ type: 'OBJECT_SEARCH_CANCEL', channel: 'browse' });
      // Also cancels the identity pass of the previous query.
      this.send({ type: 'BROWSE_SEARCH', query: '', gen: this.gen });
      return;
    }
    if (liveAvailable && !isRidQuery(q)) {
      this.live = { ...emptyLive(), query: q, status: 'loading' };
      this.send({ type: 'BROWSE_SEARCH', query: q, gen: this.gen, page: 1, pageSize: LIVE_PAGE_SIZE });
      this.config = [];
      this.configQuery = q;
      this.configNotice = null;
      if (q.length >= 2) this.send({ type: 'OBJECT_SEARCH', query: q, channel: 'browse' });
    } else {
      this.live = { ...emptyLive(), query: q, status: 'ready' };
    }
    if (isIdLike(q) && this.resolvedQuery !== q) {
      this.resolved = null;
      this.resolvedQuery = '';
      this.send({ type: 'BROWSE_RESOLVE', query: q, gen: ++this.resolveGen });
    }
  }

  /** Next live page for the current query. */
  more(): void {
    const l = this.live;
    if (!l.query || !l.more || l.moreLoading || l.status !== 'ready') return;
    this.live = { ...l, moreLoading: true };
    this.send({ type: 'BROWSE_SEARCH', query: l.query, gen: this.gen, page: l.page + 1, pageSize: LIVE_PAGE_SIZE });
  }

  locate(rids: string[]): void {
    if (rids.length) this.send({ type: 'LOCATE_ON_PAGE', rids });
  }

  reset(): void {
    this.gen++;
    this.resolveGen++;
    this.trees.clear();
    this.cache = [];
    this.cacheQuery = '';
    this.wantCache = '';
    this.live = emptyLive();
    this.resolved = null;
    this.resolvedQuery = '';
    this.config = [];
    this.configQuery = '';
    this.configNotice = null;
    this.history = [];
  }

  /** Apply an answer. True when something shown may have changed. */
  handle(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'BROWSE_TREE_DATA': {
        const cur = this.trees.get(msg.rid);
        if (!cur) return false;
        if (msg.ok && !msg.tree) {
          // The crumbs, ahead of the tree.
          if (!msg.crumbs) return false;
          cur.crumbs = msg.crumbs;
          return true;
        }
        if (msg.ok && msg.tree) {
          let tree = msg.tree;
          const partial = tree.presented === 'loading';
          // A refresh's first answer keeps the template rows already shown
          // until the new ones arrive.
          if (partial && cur.tree?.presented === 'loaded') {
            tree = { ...tree, presented: 'loaded', nodes: [...tree.nodes, ...cur.tree.nodes.filter(n => n.group === 1)] };
          }
          this.trees.set(msg.rid, { status: 'ready', tree, refreshing: partial, crumbs: tree.crumbs });
        } else if (cur.tree) {
          // Keep the older tree; a template still loading will not come.
          cur.refreshing = false;
          if (cur.tree.presented === 'loading') cur.tree = { ...cur.tree, presented: 'error' };
        } else {
          this.trees.set(msg.rid, { status: 'error', tree: null, error: msg.error ?? 'Not read', refreshing: false, crumbs: cur.crumbs });
        }
        return true;
      }
      case 'CACHE_DATA':
        if (!this.wantCache || (msg.filter ?? '') !== this.wantCache) return false;
        this.cache = msg.objects;
        this.cacheQuery = msg.filter ?? '';
        return true;
      case 'BROWSE_SEARCH_RESULT': {
        if (msg.gen !== this.gen || msg.query.trim() !== this.live.query) return false;
        const l = this.live;
        if (!msg.ok) {
          // A failed next page keeps what is shown.
          this.live = (msg.page ?? 1) > 1 || l.moreLoading
            ? { ...l, moreLoading: false, more: false }
            : { ...l, status: 'error', error: msg.error ?? 'Search failed', items: [], pages: [] };
          return true;
        }
        const objects = msg.objects ?? [];
        const total = msg.totalHits ?? objects.length;
        // Every page answers twice (fast hits, then the identity pass with
        // IDs filled in), and page 1's second answer can arrive after Show
        // more asked for page 2. The echoed page number says which page an
        // answer belongs to: it replaces that page's hits.
        const n = msg.page ?? 1;
        if (n > Math.max(1, l.page) + 1) return false;
        const advancing = n > l.page;
        if (n > 1 && advancing && !l.moreLoading) return false;
        const pages = l.pages.slice();
        pages[n - 1] = objects;
        const page = Math.max(l.page, n);
        const lastFilled = (pages[page - 1]?.length ?? 0) > 0;
        this.live = {
          ...l,
          status: 'ready', error: undefined,
          pages, items: flatten(pages), page, totalHits: total,
          moreLoading: n > 1 && advancing ? false : l.moreLoading,
          more: lastFilled && page * LIVE_PAGE_SIZE < total,
        };
        return true;
      }
      case 'OBJECT_SEARCH_RESULT': {
        if (!msg.ok || msg.query.trim() !== this.configQuery) return false;
        const now = Date.now();
        this.config = msg.objects.map(o => ({ rid: o.rid, name: o.name, type: o.type, businessId: o.businessId, source: 'server' as const, discoveredAt: now, updatedAt: now }));
        this.configNotice = msg.notice ?? null;
        return this.config.length > 0 || !!this.configNotice;
      }
      case 'BROWSE_RESOLVE_RESULT':
        if (msg.gen !== this.resolveGen) return false;
        this.resolvedQuery = msg.query.trim();
        this.resolved = msg.ok ? msg.object ?? null : null;
        return true;
      case 'HISTORY_DATA':
        this.history = msg.entries;
        return true;
      case 'LOCATE_RESULT':
        this.onLocated?.(msg.rid, msg.found);
        return false;
      default:
        return false;
    }
  }
}
