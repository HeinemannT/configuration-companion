/**
 * Point and tell: where the small listener may sit while the microphone is held. It rises from behind an edge of the
 * comment field, so it needs a free box on that side: not over any ink, not over a number badge, inside the window.
 * Above the field first, then below it; at the right end of the edge first (the ripples leave toward the right), then
 * the left end, then the middle. When no box is free there is no listener: covering the user's ink is worse.
 */

export interface SpotRect { left: number; top: number; width: number; height: number }
export interface SpotInput {
  /** The comment field, in page coordinates. */
  card: SpotRect;
  /** The listener's width and height. */
  size: number;
  /** How far the ripples reach beyond the listener, toward the right. */
  reach: number;
  /** The part of the page the listener may use (page coordinates). */
  view: { left: number; top: number; right: number; bottom: number };
  /** Sample points of every mark's ink. */
  ink: ReadonlyArray<readonly [number, number]>;
  /** Boxes to keep clear (the number badges). */
  avoid: readonly SpotRect[];
}
/** `left`: the left of the listener, page coordinates. */
export interface Spot { side: 'top' | 'bottom'; left: number }

/** How far the listener tucks behind the field's edge. */
export const TUCK = 4;
const PAD = 7;

interface Zone { left: number; top: number; right: number; bottom: number }

const hitsInk = (z: Zone, ink: SpotInput['ink']): boolean =>
  ink.some(p => p[0] >= z.left - PAD && p[0] <= z.right + PAD && p[1] >= z.top - PAD && p[1] <= z.bottom + PAD);
const hitsBox = (z: Zone, boxes: readonly SpotRect[]): boolean =>
  boxes.some(b => b.left - PAD < z.right && b.left + b.width + PAD > z.left && b.top - PAD < z.bottom && b.top + b.height + PAD > z.top);

export function listenerSpot(i: SpotInput): Spot | null {
  const { card, size, reach, view } = i;
  const xs = [card.left + card.width - size - 18, card.left + 14, card.left + (card.width - size) / 2];
  for (const side of ['top', 'bottom'] as const) {
    // The part that shows: above the top edge (less the tuck), or below the bottom edge.
    const top = side === 'top' ? card.top - size + TUCK : card.top + card.height;
    for (const left of xs) {
      const z: Zone = { left: left - 3, right: left + size + reach, top, bottom: top + size - TUCK };
      if (z.top < view.top || z.bottom > view.bottom || z.left < view.left || z.right > view.right) continue;
      if (hitsInk(z, i.ink) || hitsBox(z, i.avoid)) continue;
      return { side, left };
    }
  }
  return null;
}
