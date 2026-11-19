/**
 * Hand-like paths for the ink tests: a little wobble, a bow, a hooked end. Seeded, so a test is the same
 * every time. Points are [x, y] in page coordinates.
 */
import type { PtPoint } from '../types';

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

export interface GenOpts { wob?: number; seed?: number }

export function line(a: PtPoint, b: PtPoint, o: GenOpts & { bow?: number; n?: number; hook?: boolean; head?: boolean } = {}): PtPoint[] {
  const r = rng(o.seed ?? 1), wob = o.wob ?? 1.6, bow = o.bow ?? 0.06, n = o.n ?? 50;
  const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy), nx = -dy / d, ny = dx / d;
  const pts: PtPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, c = Math.sin(Math.PI * t) * bow * d;
    pts.push([a[0] + dx * t + nx * c + (r() - 0.5) * wob, a[1] + dy * t + ny * c + (r() - 0.5) * wob]);
  }
  if (o.hook || o.head) {
    const ang = Math.atan2(dy, dx), L = 16, tip = pts[pts.length - 1];
    for (let i = 1; i <= 6; i++) pts.push([tip[0] - ((L * i) / 6) * Math.cos(ang - 0.5), tip[1] - ((L * i) / 6) * Math.sin(ang - 0.5)]);
  }
  return pts;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, o: GenOpts & { turns?: number; a0?: number; dir?: number } = {}): PtPoint[] {
  const r = rng(o.seed ?? 2), wob = o.wob ?? 2.5, turns = o.turns ?? 1.08, a0 = o.a0 ?? -2.2, dir = o.dir ?? 1, n = 90;
  const ph = r() * 6, ph2 = r() * 6, pts: PtPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = a0 + dir * t * turns * Math.PI * 2, grow = 1 + 0.07 * t;
    const k = 1 + 0.05 * Math.sin(a * 2 + ph) + 0.03 * Math.sin(a * 3 + ph2);
    pts.push([cx + rx * grow * k * Math.cos(a) + (r() - 0.5) * wob, cy + ry * grow * k * Math.sin(a) + (r() - 0.5) * wob]);
  }
  return pts;
}

export function box(x: number, y: number, w: number, h: number, o: GenOpts = {}): PtPoint[] {
  const r = rng(o.seed ?? 3), wob = o.wob ?? 2.5, n = 24;
  const c: PtPoint[] = [[x, y], [x + w, y + (r() - 0.5) * 8], [x + w + (r() - 0.5) * 8, y + h], [x + (r() - 0.5) * 8, y + h], [x + 3, y + 10]];
  const pts: PtPoint[] = [];
  for (let s = 0; s < 4; s++) for (let i = 0; i < n; i++) { const t = i / n; pts.push([c[s][0] + (c[s + 1][0] - c[s][0]) * t + (r() - 0.5) * wob, c[s][1] + (c[s + 1][1] - c[s][1]) * t + (r() - 0.5) * wob]); }
  pts.push(c[4]);
  return pts;
}

export function zigzag(x: number, y: number, w: number, h: number, legs = 5, o: GenOpts = {}): PtPoint[] {
  const r = rng(o.seed ?? 4), wob = o.wob ?? 2, pts: PtPoint[] = [];
  for (let l = 0; l < legs; l++) {
    const a: PtPoint = [x + (l % 2 ? w : 0), y + (h * l) / legs], b: PtPoint = [x + (l % 2 ? 0 : w), y + (h * (l + 1)) / legs];
    for (let i = 0; i < 14; i++) { const t = i / 14; pts.push([a[0] + (b[0] - a[0]) * t + (r() - 0.5) * wob, a[1] + (b[1] - a[1]) * t + (r() - 0.5) * wob]); }
  }
  return pts;
}

export function wave(x: number, y: number, w: number, amp = 3.5, per = 14, o: GenOpts = {}): PtPoint[] {
  const r = rng(o.seed ?? 5), pts: PtPoint[] = [];
  for (let i = 0; i <= w; i += 2) pts.push([x + i, y + amp * Math.sin((i / per) * Math.PI) + (r() - 0.5)]);
  return pts;
}

/** Two diagonals, drawn one after the other: an X. */
export function cross(x: number, y: number, w: number, h: number, o: GenOpts = {}): PtPoint[][] {
  return [line([x, y], [x + w, y + h], { bow: 0.02, seed: o.seed ?? 6 }), line([x + w, y], [x, y + h], { bow: 0.02, seed: (o.seed ?? 6) + 1 })];
}

/** A tick. */
export function tick(x: number, y: number, o: GenOpts = {}): PtPoint[] {
  return [...line([x, y + 14], [x + 12, y + 30], { bow: 0, n: 8, seed: o.seed ?? 7 }), ...line([x + 12, y + 30], [x + 42, y - 6], { bow: 0, n: 14, seed: (o.seed ?? 7) + 1 })];
}

/** A word of handwriting as `k` small strokes side by side. */
export function letters(x: number, y: number, k = 5, o: GenOpts = {}): PtPoint[][] {
  const r = rng(o.seed ?? 8), out: PtPoint[][] = [];
  for (let i = 0; i < k; i++) {
    const s: PtPoint[] = [];
    for (let j = 0; j <= 14; j++) { const t = (j / 14) * Math.PI * 2; s.push([x + i * 16 + 8 * (j / 14) + 6 * Math.sin(t), y - 9 * Math.cos(t) * (i % 2 ? 0.7 : 1) + (r() - 0.5)]); }
    out.push(s);
  }
  return out;
}
