/**
 * Point and tell: what one stroke is shaped like (closed, arrow-like, flat, scribbled, wavy ...). Pure
 * geometry over points in page coordinates; ink-read and gestures decide what a shape means.
 */
import { clamp, dist, dp, rectOf } from './ink-geom';
import type { Rect } from './hit';
import type { PtPoint } from './types';

export const TAU = Math.PI * 2;

// ── Geometry of one stroke ──────────────────────────────────────────────────────────────────────

export function pathLen(p: PtPoint[]): number { let l = 0; for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]); return l; }

export function resample(P: PtPoint[], step: number): PtPoint[] {
  if (!P.length) return [];
  const out: PtPoint[] = [[P[0][0], P[0][1]]];
  let acc = 0, prev = P[0];
  for (let i = 1; i < P.length; i++) {
    const cur = P[i];
    let d = dist(prev, cur);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      prev = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      out.push(prev);
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d; prev = cur;
  }
  const last = P[P.length - 1];
  if (dist(out[out.length - 1], last) > 0.5) out.push([last[0], last[1]]);
  return out;
}

export function polyArea(P: PtPoint[]): number {
  let s = 0;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

export function pip(p: PtPoint, poly: PtPoint[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

export interface Features {
  S: PtPoint[];
  L: number;
  bbox: Rect;
  diag: number;
  start: PtPoint;
  end: PtPoint;
  tap: boolean;
  turn: number;
  sharp: number;
  corners: number;
  closure: number;
  rectness: number;
  closed: boolean;
  tip: PtPoint;
  hasHead: boolean;
  arrowish: boolean;
  scribble: boolean;
  flat: boolean;
  chord: number;
  /** A squiggle: the line swings to both sides of its chord several times. */
  wavy: boolean;
}

/** What a stroke is shaped like. Ported from the sketch board's recognizer. */
export function analyze(points: PtPoint[]): Features {
  const S = resample(points, 3);
  const L = pathLen(S);
  const bbox = rectOf(S.length ? S : [[0, 0]]);
  const diag = Math.hypot(bbox.width, bbox.height);
  const start = S[0] ?? [0, 0], end = S[S.length - 1] ?? [0, 0];
  const chord = dist(start, end);
  const F: Features = {
    S, L, bbox, diag, start, end, chord, tap: L < 14 || diag < 10, turn: 0, sharp: 0, corners: 0, closure: 1, rectness: 0, closed: false,
    tip: end, hasHead: false, arrowish: false, scribble: false, flat: false, wavy: false,
  };
  if (F.tap) return F;
  const R = resample(points, 9);
  let turn = 0;
  for (let i = 2; i < R.length; i++) {
    let d = Math.atan2(R[i][1] - R[i - 1][1], R[i][0] - R[i - 1][0]) - Math.atan2(R[i - 1][1] - R[i - 2][1], R[i - 1][0] - R[i - 2][0]);
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    turn += d;
  }
  F.turn = turn;
  const V = dp(S, clamp(0.04 * diag, 5, 16));
  let sharp = 0, corners = 0;
  for (let k = 1; k < V.length - 1; k++) {
    const a = V[k - 1], b = V[k], c = V[k + 1], l1 = dist(a, b), l2 = dist(b, c);
    if (l1 < 10 || l2 < 10) continue;
    const cos = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (l1 * l2);
    const ang = Math.acos(clamp(cos, -1, 1));
    if (ang >= 2.0) sharp++;
    if (ang >= 1.1) corners++;
  }
  F.sharp = sharp; F.corners = corners;
  F.closure = chord / L;
  F.rectness = Math.abs(polyArea(S)) / Math.max(1, bbox.width * bbox.height);
  F.closed = sharp <= 2 && ((F.closure < 0.3 && Math.abs(turn) >= 4.4) || (F.closure < 0.12 && Math.abs(turn) > 3.6));
  // The point farthest from the start is the tip of an arrow; what follows it is the head.
  let ti = 0, td = 0;
  S.forEach((p, i) => { const d = dist(p, start); if (d > td) { td = d; ti = i; } });
  const tail = pathLen(S.slice(ti)), shaft = S.slice(0, ti + 1), tip = S[ti], sc = dist(start, tip), sl = pathLen(shaft) || 1;
  let devS = 0;
  const dx = tip[0] - start[0], dy = tip[1] - start[1];
  for (const p of shaft) { const c = ((p[0] - start[0]) * dy - (p[1] - start[1]) * dx) / (sc || 1); if (Math.abs(c) > Math.abs(devS)) devS = c; }
  F.tip = tip;
  F.hasHead = tail > 8 && tail <= Math.min(0.34 * L, 90);
  // Swings to both sides of the chord (more than 2 px, four times or more) make a squiggle, never an arrow.
  {
    const cx = end[0] - start[0], cy = end[1] - start[1], cl = Math.hypot(cx, cy) || 1;
    let side = 0, swings = 0;
    for (const p of S) {
      const d = ((p[0] - start[0]) * cy - (p[1] - start[1]) * cx) / cl;
      const sg = d > 1.6 ? 1 : d < -1.6 ? -1 : 0;
      if (sg && sg !== side) { if (side) swings++; side = sg; }
    }
    F.wavy = swings >= 3;
  }
  const bow = Math.abs(devS) / (sc || 1);
  F.arrowish = sc >= 50 && sc / sl >= 0.72 && bow <= 0.32 && (F.hasHead || tail <= 8 + 0.04 * L) && !F.closed && !F.wavy;
  F.flat = bbox.width >= 28 && (bbox.height <= 0.3 * bbox.width || bbox.height <= 12) && !F.closed;
  F.scribble = sharp >= 3 && L / diag >= 1.5 && !F.closed;
  return F;
}

