/**
 * A synthetic hand for the ink tests: circles, arrows and crosses as a real person draws them, each drawn
 * from a seed. A shape is an ideal path, a pen turns it into samples (uneven spacing from slow to fast,
 * a little tremor, the corners rounded by the pen's smoothing). Seeded, so a rate is the same every run.
 * Points are [x, y] in page coordinates.
 */
import type { PtPoint } from '../types';

export type Rnd = () => number;
export const between = (r: Rnd, a: number, b: number): number => a + (b - a) * r();
export const pick = <T>(r: Rnd, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length];
const gauss = (r: Rnd): number => (r() + r() + r() + r() - 2) * 1.7;

export interface PenOpts {
  /** Tremor in px (sigma). */
  jit?: number;
  /** Typical spacing between samples in px: 3 is a slow careful stroke, 22 a fast flick. */
  step?: number;
}

/** A polyline through points, as dense points about 1 px apart. */
export function dense(vs: PtPoint[]): PtPoint[] {
  const out: PtPoint[] = [];
  for (let k = 1; k < vs.length; k++) {
    const a = vs[k - 1], b = vs[k], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let i = 0; i < n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  if (vs.length) out.push(vs[vs.length - 1]);
  return out;
}

/** A dense ideal path turned into pen samples. */
export function pen(path: PtPoint[], r: Rnd, o: PenOpts = {}): PtPoint[] {
  const jit = o.jit ?? 0.7, step = o.step ?? 8;
  const raw: PtPoint[] = [];
  let i = 0, nx = 0, ny = 0;
  const n = path.length;
  while (i < n - 1) {
    const t = i / Math.max(1, n - 1), ease = 0.35 + 0.65 * Math.sqrt(Math.sin(Math.PI * t) + 0.02);
    nx = nx * 0.8 + gauss(r) * jit * 0.6; ny = ny * 0.8 + gauss(r) * jit * 0.6;
    raw.push([path[Math.round(i)][0] + nx, path[Math.round(i)][1] + ny]);
    i += Math.max(1, step * ease * between(r, 0.6, 1.4));
  }
  raw.push([path[n - 1][0] + nx, path[n - 1][1] + ny]);
  // The pen's smoothing: each point is pulled toward its neighbours, which rounds corners.
  return raw.map((p, k) => {
    if (k === 0 || k === raw.length - 1) return p;
    const a = raw[k - 1], b = raw[k + 1];
    return [p[0] * 0.5 + (a[0] + b[0]) * 0.25, p[1] * 0.5 + (a[1] + b[1]) * 0.25] as PtPoint;
  });
}

const rot = (p: PtPoint, c: PtPoint, a: number): PtPoint => [c[0] + (p[0] - c[0]) * Math.cos(a) - (p[1] - c[1]) * Math.sin(a), c[1] + (p[0] - c[0]) * Math.sin(a) + (p[1] - c[1]) * Math.cos(a)];

// ── Circles ─────────────────────────────────────────────────────────────────────────────────────

export type CircleStyle = 'tidy' | 'overshoot' | 'gap' | 'hook' | 'kink' | 'double-hook' | 'fast' | 'spiral' | 'egg';
export const CIRCLE_STYLES: readonly CircleStyle[] = ['tidy', 'overshoot', 'gap', 'hook', 'kink', 'double-hook', 'fast', 'spiral', 'egg'];

/** One stroke around (cx, cy), as a hand draws a loop in the given style. */
export function circle(cx: number, cy: number, rx: number, ry: number, style: CircleStyle, r: Rnd): PtPoint[] {
  const dir = r() < 0.5 ? 1 : -1, a0 = between(r, -Math.PI, Math.PI), tilt = between(r, -1, 1) * (0.1 + 0.4 * Math.min(1, ry / rx, rx / ry));
  let turns = between(r, 0.98, 1.06), drift = between(r, -0.04, 0.06), sq = 2;
  if (style === 'overshoot') turns = between(r, 1.1, 1.35);
  if (style === 'gap') turns = between(r, 0.84, 0.95);
  if (style === 'spiral') { turns = between(r, 1.15, 1.5); drift = between(r, 0.12, 0.3) * (r() < 0.5 ? 1 : -1); }
  if (style === 'kink') sq = between(r, 2.8, 4);
  const vs: PtPoint[] = [];
  const m = 120;
  for (let k = 0; k <= m; k++) {
    const t = k / m, a = a0 + dir * t * turns * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    // A superellipse: sq = 2 is an ellipse, more is squarer. An egg is wider at one end.
    const egg = style === 'egg' ? 1 + 0.25 * Math.cos(a - 1) : 1;
    const f = (1 + drift * t) * egg;
    const x = rx * f * Math.sign(c) * Math.pow(Math.abs(c), 2 / sq), y = ry * f * Math.sign(s) * Math.pow(Math.abs(s), 2 / sq);
    vs.push(rot([cx + x, cy + y], [cx, cy], tilt));
  }
  const body = dense(vs);
  const size = Math.max(rx, ry);
  const hook = (at: PtPoint, away: PtPoint): PtPoint[] => {
    const l = Math.min(14, 0.3 * size) + 4, ang = Math.atan2(away[1] - at[1], away[0] - at[0]) + between(r, -1, 1);
    return dense([[at[0] + Math.cos(ang) * l, at[1] + Math.sin(ang) * l], at]);
  };
  let path = body;
  if (style === 'hook' || style === 'double-hook') path = [...hook(body[0], body[Math.min(body.length - 1, 12)]), ...path];
  if (style === 'double-hook') path = [...path, ...dense([body[body.length - 1], ...hook(body[body.length - 1], body[Math.max(0, body.length - 13)]).reverse().slice(0, -1)])];
  return pen(path, r, { step: style === 'fast' ? between(r, 16, 30) : between(r, 3, 12), jit: Math.min(1.2, 0.4 + size / 200) });
}

/** The same loop drawn as two strokes (left half, right half), each starting where the other ends, roughly. */
export function circleTwo(cx: number, cy: number, rx: number, ry: number, r: Rnd): PtPoint[][] {
  const dir = r() < 0.5 ? 1 : -1, a0 = between(r, -Math.PI, Math.PI), size = Math.max(rx, ry), slop = size * 0.08;
  const arc = (from: number, to: number): PtPoint[] => {
    const vs: PtPoint[] = [];
    for (let k = 0; k <= 60; k++) { const a = from + ((to - from) * k) / 60; vs.push([cx + rx * Math.cos(a) + between(r, -slop, slop) * 0.3, cy + ry * Math.sin(a)]); }
    return dense(vs);
  };
  const split = between(r, 0.45, 0.6) * Math.PI * 2 * dir;
  const A = arc(a0, a0 + split + dir * between(r, -0.15, 0.2));
  const B = arc(a0 + split + dir * between(r, -0.2, 0.1), a0 + dir * Math.PI * 2 + dir * between(r, -0.15, 0.2));
  return [pen(A, r, { step: between(r, 4, 12) }), pen(B, r, { step: between(r, 4, 12) })];
}

// ── Arrows ──────────────────────────────────────────────────────────────────────────────────────

export type HeadStyle = 'line' | 'hook' | 'w' | 'triangle' | 'v' | 'two' | 'first' | 'chevron';
export const HEAD_STYLES: readonly HeadStyle[] = ['line', 'hook', 'w', 'triangle', 'v', 'two', 'first', 'chevron'];
/** The head styles that are a real head. */
export const REAL_HEADS: readonly HeadStyle[] = ['hook', 'w', 'triangle', 'v', 'two', 'first', 'chevron'];

export interface ArrowOpts { bow?: number; head?: HeadStyle; step?: number }

/** An arrow from `tail` to `tip`; the strokes in the order they are drawn. */
export function arrow(tail: PtPoint, tip: PtPoint, r: Rnd, o: ArrowOpts = {}): PtPoint[][] {
  const head = o.head ?? 'hook', len = Math.hypot(tip[0] - tail[0], tip[1] - tail[1]);
  const bow = o.bow ?? between(r, -0.12, 0.12), nrm: PtPoint = [-(tip[1] - tail[1]) / len, (tip[0] - tail[0]) / len];
  const ctl: PtPoint = [(tail[0] + tip[0]) / 2 + nrm[0] * bow * len * 2, (tail[1] + tip[1]) / 2 + nrm[1] * bow * len * 2];
  const vs: PtPoint[] = [];
  for (let k = 0; k <= 40; k++) { const t = k / 40; vs.push([(1 - t) * (1 - t) * tail[0] + 2 * t * (1 - t) * ctl[0] + t * t * tip[0], (1 - t) * (1 - t) * tail[1] + 2 * t * (1 - t) * ctl[1] + t * t * tip[1]]); }
  // Which way the shaft arrives at the tip decides which way the head opens.
  const back = Math.atan2(vs[vs.length - 4][1] - tip[1], vs[vs.length - 4][0] - tip[0]);
  const hl = Math.min(36, Math.max(12, 0.2 * len)) * between(r, 0.8, 1.25), th = between(r, 0.4, 0.8);
  const b1: PtPoint = [tip[0] + Math.cos(back + th) * hl * between(r, 0.8, 1.2), tip[1] + Math.sin(back + th) * hl * between(r, 0.8, 1.2)];
  const b2: PtPoint = [tip[0] + Math.cos(back - th) * hl * between(r, 0.8, 1.2), tip[1] + Math.sin(back - th) * hl * between(r, 0.8, 1.2)];
  const step = o.step ?? between(r, 4, 14), P = (p: PtPoint[], st = step): PtPoint[] => pen(p, r, { step: st, jit: 0.6 });
  const shaft = dense(vs);
  switch (head) {
    case 'line': return [P(shaft)];
    case 'hook': return [P([...shaft, ...dense([tip, b1])])];
    case 'w': return [P([...shaft, ...dense([tip, b1, tip, b2])], Math.min(step, 7))];
    case 'triangle': return [P([...shaft, ...dense([tip, b1, b2, tip])], Math.min(step, 7))];
    case 'v': return [P(shaft), P(dense([b1, tip, b2]), Math.min(step, 6))];
    case 'two': return [P(shaft), P(dense([b1, tip]), 4), P(dense([b2, tip]), 4)];
    case 'chevron': return [P(shaft), P(dense([tip, b1]), 4), P(dense([tip, b2]), 4)];
    case 'first': return [P(dense([b1, tip, b2]), Math.min(step, 6)), P(shaft)];
  }
}

// ── Crosses ─────────────────────────────────────────────────────────────────────────────────────

export type CrossStyle = 'two' | 'curved' | 'lopsided' | 'one' | 'plus';
export const CROSS_STYLES: readonly CrossStyle[] = ['two', 'curved', 'lopsided', 'one', 'plus'];

/** A cross over a box (cx, cy, w, h), as one or two strokes. */
export function cross(cx: number, cy: number, w: number, h: number, style: CrossStyle, r: Rnd): PtPoint[][] {
  const ang = style === 'plus' ? 0 : between(r, -0.3, 0.3), c: PtPoint = [cx, cy];
  const jc = (p: PtPoint, s: number): PtPoint => [p[0] + between(r, -s, s), p[1] + between(r, -s, s)];
  const s = 0.05 * Math.min(w, h);
  const TL = rot(jc([cx - w / 2, cy - h / 2], s), c, ang), TR = rot(jc([cx + w / 2, cy - h / 2], s), c, ang);
  const BL = rot(jc([cx - w / 2, cy + h / 2], s), c, ang), BR = rot(jc([cx + w / 2, cy + h / 2], s), c, ang);
  const T = rot([cx, cy - h / 2], c, ang), B = rot([cx, cy + h / 2], c, ang), Lf = rot([cx - w / 2, cy], c, ang), Rt = rot([cx + w / 2, cy], c, ang);
  const bowed = (a: PtPoint, b: PtPoint, k: number): PtPoint[] => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, n: PtPoint = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    const vs: PtPoint[] = [];
    for (let i = 0; i <= 20; i++) { const t = i / 20, bw = Math.sin(Math.PI * t) * k * l; vs.push([a[0] + (b[0] - a[0]) * t + n[0] * bw, a[1] + (b[1] - a[1]) * t + n[1] * bw]); }
    return dense(vs);
  };
  const size = Math.hypot(w, h), P = (p: PtPoint[]): PtPoint[] => pen(p, r, { step: between(r, 4, 16), jit: Math.min(1, 0.4 + size / 300) });
  const flip = r() < 0.5;
  const mk = (a1: PtPoint, a2: PtPoint, b1: PtPoint, b2: PtPoint, k1: number, k2: number): PtPoint[][] => {
    const A = bowed(a1, a2, k1), B2 = bowed(b1, b2, k2);
    return flip ? [P(B2), P(A)] : [P(A), P(B2)];
  };
  switch (style) {
    case 'two': return mk(TL, BR, TR, BL, between(r, -0.04, 0.04), between(r, -0.04, 0.04));
    case 'curved': return mk(TL, BR, TR, BL, between(r, 0.1, 0.2), between(r, -0.2, -0.1));
    case 'plus': return mk(T, B, Lf, Rt, between(r, -0.03, 0.03), between(r, -0.03, 0.03));
    // The strokes cross well off the middle of each other.
    case 'lopsided': {
      const t = r() < 0.5 ? between(r, 0.28, 0.38) : between(r, 0.62, 0.72), len = Math.hypot(BL[0] - TR[0], BL[1] - TR[1]);
      const X: PtPoint = [TL[0] + (BR[0] - TL[0]) * t, TL[1] + (BR[1] - TL[1]) * t], d: PtPoint = [(BL[0] - TR[0]) / len, (BL[1] - TR[1]) / len];
      return mk(TL, BR, [X[0] - d[0] * len * 0.5, X[1] - d[1] * len * 0.5], [X[0] + d[0] * len * 0.5, X[1] + d[1] * len * 0.5], 0.02, 0.02);
    }
    // One stroke: down the first diagonal, along the side, down the other diagonal (a ribbon).
    case 'one': {
      const path = flip ? [TL, BR, BL, TR] : [TR, BL, BR, TL];
      return [pen(dense(path), r, { step: between(r, 5, 14), jit: 0.7 })];
    }
  }
}
