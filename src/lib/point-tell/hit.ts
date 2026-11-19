/**
 * Point and tell: what is under a point or inside a box. Pure geometry over rectangles in page
 * (document) coordinates; the page measures, this decides. The one place the click-to-note behaviour and
 * a future drawing layer ask "which object is this".
 */
import type { NodeKind } from '../layout/types';

export interface Rect { left: number; top: number; width: number; height: number }

/** An object that has a place on the page: its model id, kind and rectangle. */
export interface PtTarget { id: string; kind: NodeKind; rect: Rect }

export const area = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height);
export const right = (r: Rect): number => r.left + r.width;
export const bottom = (r: Rect): number => r.top + r.height;
export const centre = (r: Rect): [number, number] => [r.left + r.width / 2, r.top + r.height / 2];

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.left && x <= right(r) && y >= r.top && y <= bottom(r);
}

export function intersection(a: Rect, b: Rect): number {
  const w = Math.min(right(a), right(b)) - Math.max(a.left, b.left);
  const h = Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

export function unionOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const l = Math.min(...rects.map(r => r.left)), t = Math.min(...rects.map(r => r.top));
  const rr = Math.max(...rects.map(right)), bb = Math.max(...rects.map(bottom));
  return { left: l, top: t, width: rr - l, height: bb - t };
}

/** The deepest object under a point: the smallest rectangle that contains it; among equals, the later
 *  one (it is drawn on top). Tabs and other targets are all treated alike. */
export function hitTest(targets: readonly PtTarget[], x: number, y: number): PtTarget | null {
  let best: PtTarget | null = null;
  for (const t of targets) {
    if (!contains(t.rect, x, y)) continue;
    if (!best || area(t.rect) <= area(best.rect)) best = t;
  }
  return best;
}

/** Objects whose centre is inside the box. */
export function targetsInBox(targets: readonly PtTarget[], box: Rect): PtTarget[] {
  return targets.filter(t => { const [cx, cy] = centre(t.rect); return contains(box, cx, cy); });
}

/** The edge of `r` nearest to a point, and whether a drop there means "before" the object (left or top).
 *  The same convention as Blueprint's drop gestures. */
export function nearestEdge(r: Rect, x: number, y: number): { side: 'left' | 'right' | 'top' | 'bottom'; before: boolean } {
  const rx = r.width > 0 ? (x - r.left) / r.width : 0.5;
  const ry = r.height > 0 ? (y - r.top) / r.height : 0.5;
  const dl = rx, dr = 1 - rx, dt = ry, db = 1 - ry, min = Math.min(dl, dr, dt, db);
  const side = min === dl ? 'left' : min === dr ? 'right' : min === dt ? 'top' : 'bottom';
  return { side, before: side === 'left' || side === 'top' };
}
