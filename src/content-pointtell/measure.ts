/**
 * Point and tell: measuring the page. Walks the layout model and asks the DOM where each object is,
 * in document coordinates (the layer scrolls with the page, so nothing is re-measured on scroll).
 * Containers have no element of their own: their place is the union of what they hold, as in Blueprint.
 */
import { ridElementMap } from '../content-blueprint/geometry';
import { findAllTabAnchors } from '../lib/dom-scanner';
import { walk } from '../lib/layout/model';
import type { LModel, LNode } from '../lib/layout/types';
import type { PtTarget, Rect } from '../lib/point-tell/hit';
import { unionOf } from '../lib/point-tell/hit';
import type { PtScene } from '../lib/point-tell/resolve';

const MIN = 8;
/** BMP's tab pills: older builds mark them .corpo-tabSet__tab, newer ones role=tab (the page scanner knows both). */
export const TAB_PILL = '.corpo-tabSet__tab, [role="tab"]';
const SELECTED_PILL = '.corpo-tabSet__tab--selected, [role="tab"][aria-selected="true"]';

const docRect = (el: Element): Rect | null => {
  const r = el.getBoundingClientRect();
  return r.width >= MIN && r.height >= MIN ? { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height } : null;
};

const norm = (s: string): string => s.replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The model tab BMP shows, by the selected pill's name; the first tab with something on screen otherwise. */
export function liveTabId(model: LModel, scene?: { targets: PtTarget[] }): string | null {
  const sel = document.querySelector(SELECTED_PILL);
  const name = sel?.textContent ? norm(sel.textContent) : '';
  if (name) { const t = model.tabs.find(x => norm(x.name) === name); if (t) return t.id; }
  if (scene) {
    const shown = new Set(scene.targets.map(t => t.id));
    const hasShown = (n: LNode): boolean => shown.has(n.id) || n.children.some(hasShown);
    return model.tabs.find(hasShown)?.id ?? null;
  }
  return null;
}

export interface Measured { scene: PtScene; foreign: PtTarget[] }

/** The page right now. `links` joins the rid the page shows to the model's widget (templated pages). */
export function measureScene(model: LModel, links: Record<string, string>, draftPills: PtTarget[] = []): Measured {
  const byRid = ridElementMap();
  const reverse = new Map(Object.entries(links).map(([rid, id]) => [id, rid]));
  const ridOf = (n: LNode): string | undefined => reverse.get(n.id) ?? n.rid;
  const found: Array<{ t: PtTarget; depth: number }> = [];
  const known = new Set<string>();

  // One walk: a widget's place is its element, a container's the union of what it holds. A member of a
  // group (a button in a button group) is its own object too.
  const measure = (n: LNode, depth: number): Rect | null => {
    if (n.kind === 'tab') { n.children.forEach(c => measure(c, depth)); return null; }
    let rect: Rect | null;
    if (n.kind === 'widget') {
      const rid = ridOf(n);
      if (rid) known.add(rid);
      const el = rid ? byRid.get(rid) : undefined;
      rect = el ? docRect(el) : null;
      n.children.forEach(c => measure(c, depth + 1));
    } else {
      rect = unionOf(n.children.flatMap(c => measure(c, depth + 1) ?? []));
    }
    if (rect) found.push({ t: { id: n.id, kind: n.kind, rect }, depth });
    return rect;
  };
  model.tabs.forEach(t => measure(t, 0));
  // Larger first, and a parent before what it holds when the two are the same size: hitTest takes the last match.
  const targets = found.sort((x, y) => (y.t.rect.width * y.t.rect.height) - (x.t.rect.width * x.t.rect.height) || x.depth - y.depth).map(f => f.t);

  // The tab pills.
  const pills: PtTarget[] = [];
  const seen = new Set<string>();
  for (const a of findAllTabAnchors()) {
    const pill = a.element.closest(TAB_PILL) ?? a.element;
    const rect = docRect(pill);
    if (!rect) continue;
    const tab = model.tabs.find(t => (t.rid && t.rid === a.rid)) ?? model.tabs.find(t => norm(t.name) === norm(a.name ?? pill.textContent ?? ''));
    if (tab && !seen.has(tab.id)) { seen.add(tab.id); pills.push({ id: tab.id, kind: 'tab', rect }); }
  }

  // Objects on screen that the model does not hold: only meaningful when widgets are matched through links.
  const foreign: PtTarget[] = [];
  if (Object.keys(links).length) {
    walk(model, n => { const r = ridOf(n); if (r) known.add(r); });
    for (const [rid, el] of byRid) {
      if (known.has(rid) || el.parentElement?.closest('[data-rid]')) continue;
      const rect = docRect(el);
      if (rect) foreign.push({ id: `foreign:${rid}`, kind: 'widget', rect });
    }
  }

  const tabRow = measureTabRow(pills);
  const crumbRow = measureCrumbRow(model);
  pills.push(...draftPills);
  const scene: PtScene = { model, liveTabId: null, targets, pills, ...(tabRow ? { tabRow } : {}), ...(crumbRow ? { crumbRow } : {}) };
  scene.liveTabId = liveTabId(model, scene);
  return { scene, foreign };
}

/** The row BMP's tab strip fills: the strip's own box when it is about one pill tall, else the pills and the page's width. Null without tabs. */
function measureTabRow(pills: PtTarget[]): { rect: Rect } | undefined {
  if (!pills.length) return undefined;
  const first = document.querySelector(TAB_PILL);
  const strip = first?.closest('[role="tablist"], .corpo-tabSet');
  const sr = strip ? docRect(strip) : null;
  const u = unionOf(pills.map(p => p.rect))!;
  if (sr && sr.height <= u.height * 2.2 && sr.width >= u.width) return { rect: { left: sr.left, top: Math.min(sr.top, u.top), width: sr.width, height: Math.max(sr.height, u.height) } };
  return { rect: { left: u.left, top: u.top, width: Math.max(u.width, document.documentElement.clientWidth - u.left - 24), height: u.height } };
}

/** The breadcrumb row: the area past the last crumb, where a new page may be drawn. */
export function measureCrumbRow(model: LModel): { rect: Rect; lastId: string } | undefined {
  const items = [...document.querySelectorAll('.corpo-breadcrumbs__item')];
  const last = items[items.length - 1];
  const lr = last ? docRect(last) : null;
  if (!lr) return undefined;
  const left = lr.left + lr.width;
  const label = (el: Element | undefined): string | undefined => el?.querySelector('.nav-bar-item-label')?.textContent?.trim() || undefined;
  const parent = label(items.length > 1 ? items[items.length - 2] : last);
  return { rect: { left, top: lr.top, width: Math.max(160, Math.min(520, document.documentElement.clientWidth - left - 24)), height: lr.height }, lastId: model.pageId, ...(parent ? { parent } : {}) };
}

/** Sorted list of the rids on screen: changes exactly when BMP swaps tabs or redraws its widgets. */
export function ridSignature(): string {
  return [...document.querySelectorAll('[data-rid]')].map(el => (el as HTMLElement).dataset.rid).sort().join(',');
}
