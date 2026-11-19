/** Small geometry for reading strokes: shared by the stroke reader and the widget reader. */
import type { Rect } from './hit';
import type { PtPoint } from './types';

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const dist = (a: PtPoint, b: PtPoint): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Douglas-Peucker: the corners of a line. */
export function dp(P: PtPoint[], eps: number): PtPoint[] {
  if (P.length < 3) return P.slice();
  const keep = new Uint8Array(P.length);
  keep[0] = keep[P.length - 1] = 1;
  const st: Array<[number, number]> = [[0, P.length - 1]];
  while (st.length) {
    const [a, b] = st.pop()!;
    let md = 0, mi = -1;
    const A = P[a], B = P[b], dx = B[0] - A[0], dy = B[1] - A[1], l = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((P[i][0] - A[0]) * dy - (P[i][1] - A[1]) * dx) / l; if (d > md) { md = d; mi = i; } }
    if (md > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return P.filter((_, i) => keep[i] === 1);
}

export const rectOf = (pts: PtPoint[]): Rect => {
  let x = 1e9, y = 1e9, x2 = -1e9, y2 = -1e9;
  for (const p of pts) { x = Math.min(x, p[0]); y = Math.min(y, p[1]); x2 = Math.max(x2, p[0]); y2 = Math.max(y2, p[1]); }
  return { left: x, top: y, width: x2 - x, height: y2 - y };
};
