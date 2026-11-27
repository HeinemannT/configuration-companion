/**
 * Pure layout rules of the Atlas page: how much of a long list is shown, how
 * a list of names is cut, and where the card that opens on a resting pointer
 * is placed. No DOM here, so all of it is tested on its own.
 */

const num = (n: number) => n.toLocaleString('en-US');

export interface ListPart<T> {
  shown: T[];
  /** Items not shown. */
  hidden: number;
  /** The expander's text, null when the list needs none. */
  toggle: string | null;
}

/**
 * The part of `items` a list shows: the first `limit`, then "Show all 42";
 * opened, all of them and "Show fewer". A list at most `slack` longer than
 * `limit` is shown whole: an expander for one or two items helps nobody.
 * Items `keep` says are always shown (the picked one), in their place.
 */
export function listPart<T>(items: readonly T[], limit: number, open: boolean, keep?: (item: T) => boolean, slack = 2): ListPart<T> {
  if (items.length <= limit + slack) return { shown: [...items], hidden: 0, toggle: null };
  if (open) return { shown: [...items], hidden: 0, toggle: 'Show fewer' };
  const shown = items.filter((item, i) => i < limit || (keep?.(item) ?? false));
  return { shown, hidden: items.length - shown.length, toggle: `Show all ${num(items.length)}` };
}

/** "A, B, C and 9 more": at most `max` names. */
export function nameList(names: readonly string[], max = 4): string {
  if (names.length === 0) return '';
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${num(names.length - max)} more`;
}

/**
 * Which lists the user opened, per view. A list stays open while the view
 * shows the same thing (the same type, the same pair, the same two ends);
 * when that changes, every list of the view closes again.
 */
export class ListMemory {
  private readonly byView = new Map<string, { context: string; open: Set<string> }>();

  private entry(view: string, context: string): Set<string> {
    let e = this.byView.get(view);
    if (!e || e.context !== context) { e = { context, open: new Set() }; this.byView.set(view, e); }
    return e.open;
  }

  isOpen(view: string, context: string, list: string): boolean { return this.entry(view, context).has(list); }

  toggle(view: string, context: string, list: string): void {
    const open = this.entry(view, context);
    if (open.has(list)) open.delete(list); else open.add(list);
  }
}

export interface Box { left: number; top: number; right: number; bottom: number }
export interface Size { width: number; height: number }

export interface CardPlace {
  left: number;
  top: number;
  side: 'below' | 'above';
  /** Set when the card is higher than the room on its side: it is cut to this. */
  maxHeight: number | null;
}

/**
 * Where the card for `anchor` goes, from the card's measured size and the
 * viewport. Below the anchor when it fits, else above when that fits, else on
 * the side with more room and cut to it. It never covers the anchor, so the
 * pointer resting on the anchor never rests on the card. Horizontally centred
 * on the anchor and kept `margin` inside the viewport.
 */
export function placeCard(anchor: Box, card: Size, viewport: Size, gap = 8, margin = 8): CardPlace {
  const below = viewport.height - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - margin;
  const centre = (anchor.left + anchor.right) / 2;
  const left = Math.round(Math.max(margin, Math.min(viewport.width - margin - card.width, centre - card.width / 2)));
  if (card.height <= below) return { left, top: Math.round(anchor.bottom + gap), side: 'below', maxHeight: null };
  if (card.height <= above) return { left, top: Math.round(anchor.top - gap - card.height), side: 'above', maxHeight: null };
  if (below >= above) return { left, top: Math.round(anchor.bottom + gap), side: 'below', maxHeight: Math.max(0, Math.floor(below)) };
  const room = Math.max(0, Math.floor(above));
  return { left, top: Math.round(anchor.top - gap - room), side: 'above', maxHeight: room };
}
