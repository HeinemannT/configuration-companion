/**
 * The current object and "Locate on page" in Inspect mode.
 *
 *  - Current object: the object last pointed at from its badge (click,
 *    keyboard copy, double-click, Alt+Enter, right-click) or located from
 *    Browse keeps a calm violet double ring on its outline and a violet mark
 *    in its badge until another object becomes current.
 *  - Locate: scrolls to the object, dims the rest of the page by about 14 %
 *    for 1.5 s around a cut-out and pulses a ring twice. While the target is
 *    off screen an edge flag names it and points to it (a click scrolls
 *    there). With reduced motion: no smooth scroll and no pulse; the ring
 *    and the dim still show.
 *
 * Cheap: positions are read once when the scroll has ended (`scrollend`, or
 * a short timeout), never per frame; a later scroll removes the spot.
 * Critical layout (position, z-index, pointer-events) is inline.
 */

import { locatePlan, spotBox, type LocatePlan, type Rect } from './lib/badge-look';
import { getTypeColor } from './lib/types';

/** Above the page and our badges, below the hover card (2147483644). */
export const LOCATE_Z_INDEX = '2147483640';
/** How long the dim and the ring stay. */
export const LOCATE_MS = 1500;
/** How long an edge flag waits for a click when the target stays off screen. */
export const FLAG_MS = 4000;
/** Fallback when the browser sends no scrollend. */
const SCROLL_SETTLE_MS = 700;

let currentRid: string | null = null;

const ridSelector = (rid: string) => `.crev-label[data-crev-label="${rid.replace(/[^0-9-]/g, '')}"]`;

function setMark(label: Element, on: boolean): void {
  label.classList.toggle('crev-label--current', on);
  const host = label.parentElement;
  if (host?.classList.contains('crev-outline')) host.classList.toggle('crev-current', on);
  const stub = label.querySelector<HTMLElement>('.crev-stub');
  if (!stub) return;
  let mark = stub.querySelector<HTMLElement>(':scope > .crev-curmark');
  if (on && !mark) {
    mark = document.createElement('span');
    mark.className = 'crev-curmark';
    mark.setAttribute('aria-hidden', 'true');
    stub.appendChild(mark);
  } else if (!on && mark) mark.remove();
  if (on) stub.setAttribute('aria-current', 'true');
  else stub.removeAttribute('aria-current');
}

/** Make `rid` the current object: its badges and outlines get the ring and
 *  the mark; the previous one loses them. */
export function markCurrent(rid: string | null): void {
  if (!rid || !/^-?\d+$/.test(rid)) rid = null;
  if (currentRid && currentRid !== rid) for (const l of document.querySelectorAll(ridSelector(currentRid))) setMark(l, false);
  currentRid = rid;
  applyCurrent();
}

/** Mark badges of the current object added since (after a sync). */
export function applyCurrent(): void {
  if (!currentRid) return;
  for (const l of document.querySelectorAll(ridSelector(currentRid))) if (!l.classList.contains('crev-label--current')) setMark(l, true);
}

export function clearCurrent(): void {
  for (const l of document.querySelectorAll('.crev-label--current')) setMark(l, false);
  currentRid = null;
}

export function currentObject(): string | null {
  return currentRid;
}

// ── locate ──────────────────────────────────────────────────────────

export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

const rectOf = (el: Element): Rect => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, bottom: r.bottom, right: r.right }; };

function fixedLayer(id: string): HTMLElement {
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.style.position = 'fixed';
  el.style.zIndex = LOCATE_Z_INDEX;
  // documentElement, not body: a transformed body wrapper would trap fixed.
  document.documentElement.appendChild(el);
  return el;
}

let timers: Array<ReturnType<typeof setTimeout>> = [];
let stopScrollWatch: (() => void) | null = null;

/** Remove the spot and the flag. */
export function endLocate(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
  stopScrollWatch?.();
  stopScrollWatch = null;
  document.getElementById('crev-locate-spot')?.remove();
  document.getElementById('crev-locate-flag')?.remove();
}

/** The dimmed page with a ringed cut-out round `el`; pulses twice unless
 *  motion is reduced. Gone after LOCATE_MS or at the next scroll. */
export function showSpot(el: Element, reduced = prefersReducedMotion()): HTMLElement {
  document.getElementById('crev-locate-spot')?.remove();
  const box = spotBox(rectOf(el), window.innerWidth, window.innerHeight);
  const spot = fixedLayer('crev-locate-spot');
  spot.style.pointerEvents = 'none';
  spot.style.top = `${box.top}px`;
  spot.style.left = `${box.left}px`;
  spot.style.width = `${Math.max(0, box.right - box.left)}px`;
  spot.style.height = `${Math.max(0, box.bottom - box.top)}px`;
  spot.className = reduced ? 'crev-locate-spot' : 'crev-locate-spot crev-locate-spot--pulse';
  spot.setAttribute('aria-hidden', 'true');
  timers.push(setTimeout(() => spot.remove(), LOCATE_MS));
  // A later scroll would leave the cut-out behind: drop it then (one
  // passive listener, removed with the spot).
  const onScroll = () => { spot.remove(); stopScrollWatch?.(); stopScrollWatch = null; };
  timers.push(setTimeout(() => {
    document.addEventListener('scroll', onScroll, { capture: true, passive: true, once: true });
    stopScrollWatch = () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, 50));
  return spot;
}

/** The edge flag for a target off screen: names it and points to it. */
export function showFlag(plan: LocatePlan, name: string, type: string | undefined, onClick: () => void): HTMLElement | null {
  document.getElementById('crev-locate-flag')?.remove();
  if (!plan.edge) return null;
  const flag = fixedLayer('crev-locate-flag');
  flag.className = `crev-locate-flag crev-locate-flag--${plan.edge}`;
  flag.style.pointerEvents = 'auto';
  flag.setAttribute('role', 'button');
  flag.tabIndex = 0;
  flag.setAttribute('aria-label', `Scroll to ${name}`);
  const sq = document.createElement('i');
  sq.style.background = getTypeColor(type);
  const arrow = document.createElement('b');
  arrow.textContent = { top: '↑', bottom: '↓', left: '←', right: '→' }[plan.edge];
  const text = document.createElement('span');
  text.textContent = name;
  flag.append(sq, text, arrow);
  if (plan.edge === 'top' || plan.edge === 'bottom') {
    flag.style.left = `${plan.at}px`;
    flag.style[plan.edge] = '0px';
  } else {
    flag.style.top = `${plan.at}px`;
    flag.style[plan.edge] = '0px';
  }
  const go = (e: Event) => { e.preventDefault(); e.stopPropagation(); onClick(); };
  flag.addEventListener('click', go);
  flag.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') go(e); });
  timers.push(setTimeout(() => flag.remove(), FLAG_MS));
  return flag;
}

/** Wait for the end of a scroll (one event, or a short timeout). */
function afterScroll(run: () => void): void {
  let done = false;
  const finish = () => { if (done) return; done = true; document.removeEventListener('scrollend', finish, { capture: true }); run(); };
  document.addEventListener('scrollend', finish, { capture: true, once: true });
  timers.push(setTimeout(finish, SCROLL_SETTLE_MS));
}

export interface LocateTarget {
  rid: string;
  name: string;
  type?: string;
}

/**
 * Locate `el` on the page: it becomes the current object; off screen, an
 * edge flag points to it while the page scrolls there; in view, the page
 * dims around it and the ring pulses. A target that stays off screen (a
 * clipped panel) keeps its flag for FLAG_MS; a click on it tries again.
 */
export function locateElement(el: HTMLElement, target: LocateTarget, reduced = prefersReducedMotion()): void {
  endLocate();
  markCurrent(target.rid);
  const vw = window.innerWidth, vh = window.innerHeight;
  const first = locatePlan(rectOf(el), vw, vh);
  const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth';
  const land = () => {
    const plan = locatePlan(rectOf(el), window.innerWidth, window.innerHeight);
    if (plan.inView) {
      document.getElementById('crev-locate-flag')?.remove();
      showSpot(el, reduced);
    } else {
      showFlag(plan, target.name, target.type, () => { el.scrollIntoView({ behavior, block: 'center' }); afterScroll(land); });
    }
  };
  if (!first.inView) showFlag(first, target.name, target.type, () => { el.scrollIntoView({ behavior, block: 'center' }); afterScroll(land); });
  const r = el.getBoundingClientRect();
  const fully = r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw;
  if (fully) { land(); return; }
  el.scrollIntoView({ behavior, block: 'center' });
  if (behavior === 'auto') land();
  else afterScroll(land);
}
