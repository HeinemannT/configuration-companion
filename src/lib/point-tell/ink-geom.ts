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

export interface Meeting {
  /** Where along each polyline (0 at its start, 1 at its end, by length) they meet. */
  ta: number;
  tb: number;
  at: PtPoint;
  /** True when the lines really cross; false when they only come within the allowed distance. */
  crossing: boolean;
}

const arcs = (P: PtPoint[]): number[] => { const a = [0]; for (let i = 1; i < P.length; i++) a.push(a[i - 1] + dist(P[i - 1], P[i])); return a; };

/** The point where segment a-b meets segment c-d, as the fractions along each; null when they do not touch. */
function segMeet(a: PtPoint, b: PtPoint, c: PtPoint, d: PtPoint): { u: number; v: number } | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const u = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, v = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
}

/**
 * Where two strokes meet: the first place their lines cross; failing that, the closest they come when that
 * is within `tol`. Null when they stay apart.
 */
export function meeting(A: PtPoint[], B: PtPoint[], tol: number): Meeting | null {
  if (A.length < 2 || B.length < 2) return null;
  const ca = arcs(A), cb = arcs(B), la = ca[ca.length - 1] || 1, lb = cb[cb.length - 1] || 1;
  for (let i = 1; i < A.length; i++) {
    for (let j = 1; j < B.length; j++) {
      const m = segMeet(A[i - 1], A[i], B[j - 1], B[j]);
      if (m) return { ta: (ca[i - 1] + m.u * (ca[i] - ca[i - 1])) / la, tb: (cb[j - 1] + m.v * (cb[j] - cb[j - 1])) / lb, at: [A[i - 1][0] + m.u * (A[i][0] - A[i - 1][0]), A[i - 1][1] + m.u * (A[i][1] - A[i - 1][1])], crossing: true };
    }
  }
  let best = tol + 1, bi = 0, bj = 0;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) { const d = dist(A[i], B[j]); if (d < best) { best = d; bi = i; bj = j; } }
  if (best > tol) return null;
  return { ta: ca[bi] / la, tb: cb[bj] / lb, at: [(A[bi][0] + B[bj][0]) / 2, (A[bi][1] + B[bj][1]) / 2], crossing: false };
}

/** Where one stroke crosses itself, ignoring the stretch just around each point (`skip` px along the line). */
export function selfMeeting(P: PtPoint[], skip: number): { t1: number; t2: number; at: PtPoint } | null {
  const c = arcs(P), l = c[c.length - 1] || 1;
  for (let i = 1; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) {
      if (c[j - 1] - c[i] < skip) continue;
      const m = segMeet(P[i - 1], P[i], P[j - 1], P[j]);
      if (m) return { t1: (c[i - 1] + m.u * (c[i] - c[i - 1])) / l, t2: (c[j - 1] + m.v * (c[j] - c[j - 1])) / l, at: [P[i - 1][0] + m.u * (P[i][0] - P[i - 1][0]), P[i - 1][1] + m.u * (P[i][1] - P[i - 1][1])] };
    }
  }
  return null;
}
