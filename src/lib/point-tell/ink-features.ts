/**
 * Point and tell: what one stroke is shaped like (closed, arrow-like, flat, scribbled, wavy ...). Pure
 * geometry over points in page coordinates; ink-read and gestures decide what a shape means.
 */
import { clamp, dist, dp, rectOf, selfMeeting } from './ink-geom';
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
  // Nonzero winding, not even-odd: a loop that overshoots its start winds twice over the overlap, and that is still inside.
  let w = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if (a[1] <= p[1]) { if (b[1] > p[1] && (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]) > 0) w++; }
    else if (b[1] <= p[1] && (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]) < 0) w--;
  }
  return w !== 0;
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
  /** How far the line goes round its own middle, in radians (signed). */
  sweep: number;
  rectness: number;
  closed: boolean;
  /** One stroke drawn as an X, and where its two legs cross. */
  xmark: boolean;
  cross?: PtPoint;
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
    S, L, bbox, diag, start, end, chord, tap: L < 14 || diag < 10, turn: 0, sharp: 0, corners: 0, closure: 1, sweep: 0, rectness: 0, closed: false, xmark: false,
    tip: end, hasHead: false, arrowish: false, scribble: false, flat: false, wavy: false,
  };
  if (F.tap) return F;
  const R = resample(points, 9);
  let turn = 0, core = 0;
  // The turning of the body of the line, without a hook at either end (about 12% of it, at most 18 px, each side).
  const trim = Math.max(1, Math.round(Math.min(18, 0.12 * L) / 9));
  for (let i = 2; i < R.length; i++) {
    let d = Math.atan2(R[i][1] - R[i - 1][1], R[i][0] - R[i - 1][0]) - Math.atan2(R[i - 1][1] - R[i - 2][1], R[i - 1][0] - R[i - 2][0]);
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    turn += d;
    if (i >= 2 + trim && i < R.length - trim) core += d;
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
  // How far the line goes round its own middle: a hook at either end hardly changes it, where it cancels the turning.
  {
    const mx = S.reduce((a, p) => a + p[0], 0) / S.length, my = S.reduce((a, p) => a + p[1], 0) / S.length;
    let sw = 0, prev = Math.atan2(S[0][1] - my, S[0][0] - mx);
    for (let i = 1; i < S.length; i++) {
      const a = Math.atan2(S[i][1] - my, S[i][0] - mx);
      let d = a - prev;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      sw += d; prev = a;
    }
    F.sweep = sw;
  }
  // One stroke that is an X: two long straight legs that cross, joined by a short side (a ribbon, an alpha).
  {
    const X = dp(S, clamp(0.07 * diag, 5, 24));
    // (The short side may bend a little, so it can be two pieces.)
    if ((X.length === 4 || X.length === 5) && L >= 50) {
      const m = selfMeeting(S, 0.15 * L);
      const first = dist(X[0], X[1]), last = dist(X[X.length - 2], X[X.length - 1]);
      if (m && m.t1 >= 0.12 && m.t1 <= 0.5 && m.t2 >= 0.5 && m.t2 <= 0.88 && first >= 0.25 * L && last >= 0.25 * L && first + last >= 0.6 * L) { F.cross = m.at; F.xmark = true; }
    }
  }
  const loopTurn = Math.abs(turn);
  F.closed = !F.xmark && sharp <= 3
    && ((sharp <= 2 && ((F.closure < 0.3 && loopTurn >= 4.4) || (F.closure < 0.12 && loopTurn > 3.6)))
      || (F.closure < (Math.abs(F.sweep) >= 6 ? 0.4 : 0.3) && Math.abs(F.sweep) >= 5.3 && Math.abs(core) >= 3));
  // The point farthest from the start is the tip of an arrow; what follows it is the head: a short stretch (one
  // barb, two, a triangle) that stays close to the tip, on the shaft's side of it.
  // Sharp turns of the pen (a reversal of about 75 degrees or more over 12 px each side), at most one per 12 px.
  const K = 4, cusps: number[] = [];
  for (let i = K, last = -9; i < S.length - K; i++) {
    const v1x = S[i][0] - S[i - K][0], v1y = S[i][1] - S[i - K][1], v2x = S[i + K][0] - S[i][0], v2y = S[i + K][1] - S[i][1];
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 6 || l2 < 6 || Math.acos(clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)) < 1.3) continue;
    if (i - last > K) cusps.push(i);
    last = i;
  }
  const split = (ti: number) => {
    const rest = S.slice(ti), tail = pathLen(rest), shaft = S.slice(0, ti + 1), tip = S[ti], sc = dist(start, tip), sl = pathLen(shaft) || 1;
    let devS = 0;
    const dx = tip[0] - start[0], dy = tip[1] - start[1];
    for (const p of shaft) { const c = ((p[0] - start[0]) * dy - (p[1] - start[1]) * dx) / (sc || 1); if (Math.abs(c) > Math.abs(devS)) devS = c; }
    const ux = (start[0] - tip[0]) / (sc || 1), uy = (start[1] - tip[1]) / (sc || 1);
    let reach = 0, back = 0;
    for (const p of rest) { reach = Math.max(reach, dist(p, tip)); back += (p[0] - tip[0]) * ux + (p[1] - tip[1]) * uy; }
    // One barb is a straight stretch; a W or a triangle turns twice more inside the head.
    const turns = cusps.filter(c => c > ti + K).length;
    const hasHead = tail > 8 && reach <= Math.min(0.45 * sl, 60) && back / Math.max(1, rest.length) > 0.15 * reach
      && (turns === 0 ? tail <= Math.min(0.5 * sl, 90) : turns >= 2 && tail <= Math.min(0.8 * sl, 170));
    const bow = Math.abs(devS) / (sc || 1);
    return { shaft, tip, sc, sl, tail, hasHead, bow, fits: sc >= 50 && sc / sl >= 0.72 && bow <= 0.32 && (hasHead || tail <= 8 + 0.04 * L) };
  };
  let ti = 0, td = 0;
  S.forEach((p, i) => { const d = dist(p, start); if (d > td) { td = d; ti = i; } });
  let sp = split(ti);
  // A head turns the pen right round at the tip, and a barb can be longer than the lift of the shaft's curve: when
  // the farthest point is not the tip, the tip is the first sharp turn that leaves only a head's worth of line.
  if (!sp.fits) {
    for (const c of cusps) { const t = split(c); if (t.hasHead && t.fits) { sp = t; break; } }
  }
  const { shaft, tip, sc, sl, tail, bow } = sp;
  F.tip = tip;
  F.hasHead = sp.hasHead;
  // Swings to both sides of the shaft's line (more than 2 px, four times or more) make a squiggle, never an arrow.
  {
    const cx = tip[0] - start[0], cy = tip[1] - start[1], cl = Math.hypot(cx, cy) || 1;
    let side = 0, swings = 0;
    for (const p of shaft) {
      const d = ((p[0] - start[0]) * cy - (p[1] - start[1]) * cx) / cl;
      const sg = d > 1.6 ? 1 : d < -1.6 ? -1 : 0;
      if (sg && sg !== side) { if (side) swings++; side = sg; }
    }
    F.wavy = swings >= 3;
  }
  F.arrowish = sc >= 50 && sc / sl >= 0.72 && bow <= 0.32 && (F.hasHead || tail <= 8 + 0.04 * L) && !F.closed && !F.wavy && !F.xmark;
  F.flat = bbox.width >= 28 && (bbox.height <= 0.3 * bbox.width || bbox.height <= 12) && !F.closed;
  F.scribble = sharp >= 3 && L / diag >= 1.5 && !F.closed && !F.arrowish && !F.xmark;
  return F;
}

/**
 * Two strokes that together are one loop (two arcs, left and right): the loop as one stroke, or null when
 * they do not close it. Each end must meet an end of the other within a third of the loop's size.
 */
export function joinedLoop(a: Features, b: Features): Features | null {
  if (a.tap || b.tap || a.L < 24 || b.L < 24 || a.closed || b.closed || a.chord / a.L > 0.9 || b.chord / b.L > 0.9) return null;
  const box = rectOf([...a.S, ...b.S]), size = Math.hypot(box.width, box.height);
  const gap = (rev: boolean): number => (rev ? dist(a.end, b.end) + dist(b.start, a.start) : dist(a.end, b.start) + dist(b.end, a.start));
  const rev = gap(true) < gap(false);
  const e1 = rev ? dist(a.end, b.end) : dist(a.end, b.start), e2 = rev ? dist(b.start, a.start) : dist(b.end, a.start);
  if (Math.max(e1, e2) > 0.3 * size) return null;
  const F = analyze([...a.S, ...(rev ? [...b.S].reverse() : b.S)]);
  return F.closed ? F : null;
}
