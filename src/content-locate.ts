/**
 * Browse's "Locate on page", the page side. Finds the first of `rids` that
 * is shown, and rings it (the caller's `ring`). When none is shown and the
 * object sits on a page tab that is not open, it opens that tab the way a
 * user would (a click on the tab), waits for the object to appear (at most
 * LOCATE_WAIT_MS, on DOM changes, with a slow poll as a backstop), and
 * rings it then. The tabs come from the panel's tree (lib/locate-plan.ts);
 * without them, a hidden element inside an ARIA tab panel names its tab.
 *
 * Never switches anything when the page is not visible: it answers
 * 'page-behind' and the panel says so.
 */
import { findAllTabAnchors, findTabButton, getAllRidElements, isTabActive } from './lib/dom-scanner';
import type { LocateAnswer, LocateTab } from './lib/locate-plan';

/** How long a tab switch may take to show the object. */
export const LOCATE_WAIT_MS = 3000;
const POLL_MS = 250;
/** The latest locateInPage call; an older one stops at its next step. */
let locateGen = 0;

/** Shown: laid out with a size (display:none and detached elements have no boxes). */
export function isShown(el: Element): boolean {
  const c = el as Element & { checkVisibility?: (o?: object) => boolean };
  if (typeof c.checkVisibility === 'function') {
    try { if (!c.checkVisibility({ visibilityProperty: true })) return false; } catch { /* older engine */ }
  }
  const rects = el.getClientRects();
  if (!rects.length) return false;
  for (const r of rects) if (r.width > 0 || r.height > 0) return true;
  return false;
}

/** Every element of `rid` on the page, the labelled one first. */
function elementsOf(rid: string): Element[] {
  const hits = getAllRidElements(true).filter(e => e.rid === rid).map(e => e.element);
  const labelled = document.querySelector(`.crev-label[data-crev-label="${rid}"]`)?.parentElement ?? null;
  if (labelled && !hits.includes(labelled)) hits.unshift(labelled);
  return hits;
}

/** The first of `rids` with a shown element. */
export function shownHit(rids: readonly string[], shown: (el: Element) => boolean = isShown): { rid: string; el: HTMLElement } | null {
  for (const rid of rids) {
    const el = elementsOf(rid).find(e => e instanceof HTMLElement && shown(e));
    if (el) return { rid, el: el as HTMLElement };
  }
  return null;
}

/** The tabs that hold a hidden element of `rids`, outermost first, from
 *  ARIA tab panels (`role=tabpanel` named by its tab). Empty when unknown. */
export function tabsFromDom(rids: readonly string[]): LocateTab[] {
  const anchors = findAllTabAnchors();
  for (const rid of rids) {
    for (const el of elementsOf(rid)) {
      const out: LocateTab[] = [];
      let panel = el.closest('[role="tabpanel"]');
      while (panel && out.length < 4) {
        const byControls = panel.id ? document.querySelector(`[role="tab"][aria-controls="${CSS.escape(panel.id)}"]`) : null;
        const labelledBy = panel.getAttribute('aria-labelledby');
        const tab = byControls ?? (labelledBy ? document.getElementById(labelledBy.split(/\s+/)[0]) : null);
        const a = tab ? anchors.find(x => x.element === tab || tab.contains(x.element) || x.element.contains(tab)) : undefined;
        if (a) out.unshift({ rid: a.rid, name: a.name ?? '' });
        panel = panel.parentElement?.closest('[role="tabpanel"]') ?? null;
      }
      if (out.length) return out;
    }
  }
  return [];
}

/** `probe()` once now and again on DOM changes (and a slow poll) until it
 *  answers or `ms` pass. */
export function waitFor<T>(probe: () => T | null, ms: number): Promise<T | null> {
  const first = probe();
  if (first !== null || ms <= 0) return Promise.resolve(first);
  return new Promise(resolve => {
    let done = false;
    let queued: ReturnType<typeof setTimeout> | null = null;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      obs.disconnect();
      clearTimeout(limit);
      clearInterval(poll);
      if (queued) clearTimeout(queued);
      resolve(v);
    };
    const check = () => { queued = null; const v = probe(); if (v !== null) finish(v); };
    const obs = new MutationObserver(() => { if (!queued) queued = setTimeout(check, 40); });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-selected'] });
    const poll = setInterval(check, POLL_MS);
    const limit = setTimeout(() => finish(probe()), ms);
  });
}

/** At most this long for a freshly opened tab to stop moving the object. */
export const SETTLE_MS = 900;
const SETTLE_STEP_MS = 60;

/** Resolves once `el`'s box is the same in three checks in a row
 *  (SETTLE_STEP_MS apart), or after `ms`. An element taken off the page
 *  (a re-render) is never the same: it waits out `ms`. */
export function settled(el: Element, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  let off = 0;
  const key = () => {
    if ((el as { isConnected?: boolean }).isConnected === false) return `off${off++}`;
    const r = el.getBoundingClientRect();
    return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
  };
  return new Promise(resolve => {
    const end = Date.now() + ms;
    let last = key();
    let same = 0;
    const step = () => {
      const now = key();
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 2 || Date.now() >= end) resolve();
      else setTimeout(step, SETTLE_STEP_MS);
    };
    setTimeout(step, SETTLE_STEP_MS);
  });
}

/**
 * Locate the first shown of `rids`; open `tabs` (outermost first) when it is
 * not shown. `ring` marks the element (scroll, dim, pulse).
 */
export async function locateInPage(
  rids: readonly string[],
  tabs: readonly LocateTab[],
  ring: (el: HTMLElement, rid: string) => void,
  opts: { waitMs?: number; shown?: (el: Element) => boolean; settleMs?: number } = {},
): Promise<LocateAnswer> {
  const waitMs = opts.waitMs ?? LOCATE_WAIT_MS;
  const shown = opts.shown ?? isShown;
  // A newer locate takes over: this one clicks and rings nothing more.
  const mine = ++locateGen;
  const superseded = () => mine !== locateGen;
  const gone: LocateAnswer = { found: null, why: 'not-shown' };
  if (document.visibilityState === 'hidden') return { found: null, why: 'page-behind' };
  const now = shownHit(rids, shown);
  if (now) { ring(now.el, now.rid); return { found: now.rid }; }
  const path = tabs.length ? tabs : tabsFromDom(rids);
  const tab = path.length ? path[path.length - 1].name || undefined : undefined;
  if (!path.length) return { found: null, why: 'not-shown' };
  const until = Date.now() + waitMs;
  let switched = false;
  for (let i = 0; i < path.length; i++) {
    const t = path[i];
    // An inner tab strip appears once its outer tab is open. A tab with a
    // rid is that tab only; its name is used when there is no rid.
    const btn = await waitFor(() => (t.rid ? findTabButton(t.rid) : findTabButton(undefined, t.name || undefined)), i === 0 ? 0 : until - Date.now());
    if (superseded()) return gone;
    if (!btn) return { found: null, ...(tab ? { tab } : {}), ...(switched ? { switched } : {}), why: switched ? 'not-shown' : 'other-tab' };
    if (!isTabActive(btn)) { btn.click(); switched = true; }
  }
  if (!switched) return { found: null, ...(tab ? { tab } : {}), why: 'not-shown' };
  const probe = () => shownHit(rids, shown);
  const hit = await waitFor(probe, Math.max(0, until - Date.now()));
  if (superseded()) return gone;
  if (hit) {
    // A tab that just opened still lays out its widgets: ring where the
    // object comes to rest, not where it first appeared. A re-render may
    // have replaced the element meanwhile: ring the one shown now.
    await settled(hit.el, opts.settleMs ?? SETTLE_MS);
    if (superseded()) return gone;
    const last = probe() ?? await waitFor(probe, Math.max(0, until - Date.now()));
    if (superseded()) return gone;
    if (last) {
      ring(last.el, last.rid);
      return { found: last.rid, ...(tab ? { tab } : {}), switched: true };
    }
  }
  return { found: null, ...(tab ? { tab } : {}), switched: true, why: 'not-shown' };
}
