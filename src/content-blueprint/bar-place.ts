/**
 * Where the floating Blueprint bar sits. It is centred between 8px insets (never pushed off the left
 * edge) and placed just under the portal's own top header band, so it does not cover the header's
 * menu, search and period controls. Position, insets and z-index are set inline (css-integrity rule:
 * the stylesheet is cosmetic only).
 */

/** Gap between the portal's header and the bar, and the bar's insets from the viewport edges. */
export const BAR_GAP = 8;
/** Top when there is no portal header band to clear. */
export const BAR_TOP = 10;
/** A fixed/sticky band taller than this is not a header (a drawer, a full-page layer). */
const MAX_BAND = 120;

/** The bar's top for a portal header band ending at `bandBottom` (0: none). */
export function barTop(bandBottom: number): number {
  return bandBottom > 0 && bandBottom <= MAX_BAND ? Math.round(bandBottom) + BAR_GAP : BAR_TOP;
}

/** The bottom of the portal's fixed or sticky top band at the top centre of the viewport, ignoring
 *  Companion's own elements; 0 when there is none. */
export function portalBandBottom(doc: Document = document): number {
  return portalBand(doc)?.getBoundingClientRect().bottom ?? 0;
}

/** Put the bar in place: inline position, insets and stacking. */
export function placeBar(bar: HTMLElement, bandBottom = portalBandBottom()): void {
  Object.assign(bar.style, {
    position: 'fixed',
    zIndex: '50',
    top: `${barTop(bandBottom)}px`,
    left: `${BAR_GAP}px`,
    right: `${BAR_GAP}px`,
  });
}

// ── Docked bar ──────────────────────────────────────────────────────────────────────────────────
// Where the portal has a top band with page content in flow below it, the bar is a full-width strip
// at the very top of the window, over the band: while Blueprint is on it is the page's top bar, as in
// any editor. The Blueprint canvas scrolls over the portal's band anyway, so a bar under the band
// left a strip of moving page above it. The page gets as much room as the bar is taller than the
// band, so nothing of the page is covered. Without such a band the bar floats.

/** The portal's fixed or sticky top band at the top centre of the viewport, ignoring Companion's
 *  own elements; null when there is none. */
export function portalBand(doc: Document = document): HTMLElement | null {
  const x = Math.round(doc.documentElement.clientWidth / 2);
  for (const e of doc.elementsFromPoint?.(x, 2) ?? []) {
    if (e.closest('#crev-blueprint-layer, .crev-eo-host, #crev-tooltip, #crev-toast-container')) continue;
    for (let a: Element | null = e, depth = 0; a && a !== doc.body && depth < 12; a = a.parentElement, depth++) {
      const pos = getComputedStyle(a).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = a.getBoundingClientRect();
      return r.top <= 1 && r.height <= MAX_BAND ? a as HTMLElement : null;
    }
    return null;
  }
  return null;
}

/** The first element in the page flow after the band: the one that takes the room. */
export function roomTarget(band: HTMLElement): HTMLElement | null {
  for (let a: Element | null = band, depth = 0; a && a !== a.ownerDocument.body && depth < 4; a = a.parentElement, depth++) {
    const next = a.nextElementSibling;
    if (!(next instanceof HTMLElement)) continue;
    const pos = getComputedStyle(next).position;
    if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') return next;
  }
  return null;
}

let room: { el: HTMLElement; was: string; px: number; base: number; top: string } | null = null;
/** On the element that takes the room: its own inline margin and its margin in px before docking.
 *  Kept on the element, so a content script that replaces this one (the extension reloaded) starts
 *  from the page's real margin, not from the room already added. */
const ROOM_ATTR = 'data-crev-dock-room';

/** Dock `bar` (already in the document) under the portal band and give the page room for it.
 *  Returns true when the page moved (the caller anchors its canvas again). False and floating
 *  when the portal has no band to dock under. Pass the band when it is already known. */
export function dockBar(bar: HTMLElement, band: HTMLElement | null = portalBand(bar.ownerDocument)): boolean {
  const target = band && roomTarget(band);
  if (!band || !target) {
    // The band is out of sight for a moment (the portal opened a menu or a dialog over it): stay
    // docked where the bar was, so the bar and the page do not jump while it is open.
    if (room?.el.isConnected) {
      bar.classList.add('bp-docked');
      Object.assign(bar.style, { top: room.top, left: '0', right: '0' });
      return false;
    }
    bar.classList.remove('bp-docked');
    return clearDockRoom();
  }
  bar.classList.add('bp-docked');
  const top = '0px';
  Object.assign(bar.style, { top, left: '0', right: '0' });
  const px = Math.max(0, Math.ceil(bar.getBoundingClientRect().height - band.getBoundingClientRect().bottom));
  if (room && room.el === target && room.px === px && target.style.marginTop === `${room.base + px}px`) { room.top = top; return false; }
  if (room && room.el !== target) clearDockRoom();
  if (!room) {
    const kept = /^(\d+(?:\.\d+)?)\|(.*)$/.exec(target.getAttribute(ROOM_ATTR) ?? '');
    room = kept ? { el: target, was: kept[2], px: 0, base: Number(kept[1]), top }
      : { el: target, was: target.style.marginTop, px: 0, base: parseFloat(getComputedStyle(target).marginTop) || 0, top };
    target.setAttribute(ROOM_ATTR, `${room.base}|${room.was}`);
  }
  room.px = px; room.top = top;
  target.style.marginTop = `${room.base + px}px`;
  return true;
}

/** Give the room back. Returns true when the page moved. */
export function clearDockRoom(): boolean {
  if (!room) return false;
  room.el.style.marginTop = room.was;
  room.el.removeAttribute(ROOM_ATTR);
  room = null;
  return true;
}
