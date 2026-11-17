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
  const x = Math.round(doc.documentElement.clientWidth / 2);
  for (const e of doc.elementsFromPoint(x, 2)) {
    if (e.closest('#crev-blueprint-layer, .crev-eo-host, #crev-tooltip, #crev-toast-container')) continue;
    for (let a: Element | null = e, depth = 0; a && a !== doc.body && depth < 12; a = a.parentElement, depth++) {
      const pos = getComputedStyle(a).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = a.getBoundingClientRect();
      return r.top <= 1 && r.height <= MAX_BAND ? r.bottom : 0;
    }
    return 0;
  }
  return 0;
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
