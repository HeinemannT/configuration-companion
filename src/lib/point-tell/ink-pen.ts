/**
 * Point and tell: the brush pen. Pure math, no DOM: raw pointer samples in, a stabilised centre line
 * with a width at every point out.
 *
 * What makes it feel like a pen:
 *   - a one-euro filter plus a short pulled string: slow hand tremor is removed, a fast stroke keeps up;
 *   - width from speed (slow is fat, fast is thin) or, with a real stylus, from pressure;
 *   - a landing dot (the width opens over the first millimetres) and a lift-off taper: a flick runs out
 *     into a hairline that carries on a little;
 *   - the tip is always at the real pointer position (`tipView`), the stabilised line trails behind it.
 *
 * A stroke is a list of control points (`Cp`). `dense` turns control points into evenly spaced samples
 * (a quadratic through the midpoints, so the line has no corners) that the canvas fills as a tube of
 * variable width. Ported from the ink lab's Brush pen; the other inks and the pools are not carried over.
 */

export interface Cp { x: number; y: number; t: number; /** distance along the stroke */ s: number; /** width before the landing ramp */ b: number; /** radius */ r: number }

export interface Dense { x: number[]; y: number[]; r: number[]; n: number }

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const sat = (v: number): number => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

/** One-euro filter: the cutoff rises with speed, so tremor goes and fast strokes keep up. */
export class Euro {
  private x: number | null = null;
  private dx = 0;
  constructor(private readonly mc: number, private readonly beta: number) {}
  private a(c: number, dt: number): number { return 1 / (1 + 1 / (TAU * c) / dt); }
  f(v: number, dt: number): number {
    if (this.x === null) { this.x = v; return v; }
    this.dx += ((v - this.x) / dt - this.dx) * this.a(1, dt);
    this.x += (v - this.x) * this.a(this.mc + this.beta * Math.abs(this.dx), dt);
    return this.x;
  }
}

/** The brush pen at its middle size. Radius in CSS px; speeds in px per ms. */
export const BRUSH = {
  R: 3.0,
  lam: 17,
  step: 1.5,
  stab: { mc: 1.3, beta: 0.11, L: 1.3 },
  /** Radius factor from speed. */
  g: (v: number): number => lerp(1.5, 0.2, Math.pow(sat((v - 0.05) / 2.8), 0.6)),
  /** Radius factor from pressure (and a little from speed). */
  pg: (p: number, v: number): number => (0.14 + 1.9 * Math.pow(p, 0.9)) * (1.05 - 0.25 * sat(v / 3)),
  start: { len: 18, min: 0.16 },
  end: (vl: number): { len: number; min: number; ext: number } => ({
    len: lerp(12, 110, sat(vl / 2.2)),
    min: lerp(0.7, 0.05, sat(vl / 0.9)),
    ext: vl > 0.9 ? lerp(4, 40, sat((vl - 0.9) / 2.2)) : 0,
  }),
} as const;

interface Sample { x: number; y: number; t: number }

export class Pen {
  readonly cps: Cp[] = [];
  /** Index of the first control point not yet baked (see `bakedChunk`). */
  private baked = 0;
  private pred: Array<{ x: number; y: number }> = [];
  private vS = 0;
  private pS = 0.5;
  private real = false;
  private rs = 0;
  private t0 = 0;
  private eu: [Euro, Euro] = [new Euro(BRUSH.stab.mc, BRUSH.stab.beta), new Euro(BRUSH.stab.mc, BRUSH.stab.beta)];
  private brush: { x: number; y: number } = { x: 0, y: 0 };
  private prev: Sample = { x: 0, y: 0, t: 0 };
  /** The real pointer position now. */
  tip: { x: number; y: number } = { x: 0, y: 0 };
  private recent: Sample[] = [];
  /** Radius at lift-off speed, kept for tests and for the taper. */
  vLift = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  private lan(dt: number): number { return 0.38 + 0.62 * easeOut(sat(dt / 60)); }
  private ts(s: number): number { return lerp(BRUSH.start.min, 1, easeOut(sat(s / BRUSH.start.len))); }
  private target(): number { return BRUSH.R * (this.real ? BRUSH.pg(this.pS, this.vS) : BRUSH.g(this.vS)); }
  private strL(): number { return BRUSH.stab.L * lerp(1, 0.15, sat(this.vS / 1.3)); }

  /** `pressure` > 0 with a stylus switches the width to pressure. */
  down(x: number, y: number, t: number, pressure: number, pointerType: string): void {
    this.t0 = t;
    this.real = pointerType === 'pen' && pressure > 0;
    this.pS = pressure > 0 ? pressure : 0.5;
    this.brush = { x, y };
    this.prev = { x, y, t };
    this.tip = { x, y };
    this.recent = [{ x, y, t }];
    this.rs = this.target();
    this.addCp(x, y, t);
  }

  move(x: number, y: number, t: number, pressure: number): void {
    const dt = Math.max(1, t - this.prev.t);
    const inst = Math.hypot(x - this.prev.x, y - this.prev.y) / dt;
    this.vS += (inst - this.vS) * (1 - Math.exp(-dt / 34));
    if (this.real) this.pS += (pressure - this.pS) * (1 - Math.exp(-dt / 28));
    this.recent.push({ x, y, t });
    while (this.recent.length > 2 && t - this.recent[0].t > 70) this.recent.shift();
    this.tip = { x, y };
    this.prev = { x, y, t };
    const fx = this.eu[0].f(x, dt / 1000), fy = this.eu[1].f(y, dt / 1000), L = this.strL();
    const d = Math.hypot(fx - this.brush.x, fy - this.brush.y);
    if (d > L) { const k = (d - L) / d; this.brush.x += (fx - this.brush.x) * k; this.brush.y += (fy - this.brush.y) * k; }
    const last = this.cps[this.cps.length - 1];
    if (Math.hypot(this.brush.x - last.x, this.brush.y - last.y) >= 0.8) this.addCp(this.brush.x, this.brush.y, t);
  }

  private addCp(x: number, y: number, t: number): void {
    const prev = this.cps[this.cps.length - 1];
    const ds = prev ? Math.hypot(prev.x - x, prev.y - y) : 0;
    const s = (prev ? prev.s : 0) + ds;
    this.rs += (this.target() - this.rs) * (prev ? 1 - Math.exp(-ds / BRUSH.lam) : 1);
    const b = this.rs * this.ts(s);
    const cp: Cp = { x, y, t, s, b, r: Math.min(b * this.lan(t - this.t0), BRUSH.R * 2.3) };
    if (this.cps.length === 1) this.cps[0].r = Math.min(this.cps[0].b * this.lan(t - this.t0), BRUSH.R * 2.3);
    this.cps.push(cp);
  }

  private provCp(x: number, y: number): Cp {
    const last = this.cps[this.cps.length - 1];
    const s = last.s + Math.hypot(x - last.x, y - last.y);
    const b = this.rs * this.ts(s);
    return { x, y, s, b, t: 0, r: Math.min(b * this.lan(this.clock() - this.t0), BRUSH.R * 2.3) };
  }

  /** Predicted points that really lead the tip (the browser's `getPredictedEvents`). */
  setPred(list: Array<{ x: number; y: number }>): void {
    const b = this.tip;
    const before = this.recent.length > 1 ? this.recent[this.recent.length - 2] : b;
    const dx = b.x - before.x, dy = b.y - before.y;
    this.pred = list.filter(p => (p.x - b.x) * dx + (p.y - b.y) * dy > 0).slice(0, 3);
  }

  /** The control points that are settled since the last call, as dense samples to paint for good; null when there is none. */
  bakedChunk(): Dense | null {
    const m = this.cps.length;
    if (m < 2 || this.baked > m - 2) return null;
    const d = dense(this.cps, this.baked, m - 2, BRUSH.step);
    this.baked = m - 1;
    return d;
  }

  /** The part still moving: control points from the last baked one, the real tip, and the prediction. */
  tailView(): { v: Cp[]; i0: number } {
    const v = this.cps.concat([this.provCp(this.tip.x, this.tip.y)], this.pred.map(p => this.provCp(p.x, p.y)));
    return { v, i0: this.baked };
  }

  /** The line as drawn, to the real tip: what a reader of the shape should see (before the lift-off hairline is added). */
  path(): Array<[number, number]> {
    const p: Array<[number, number]> = this.cps.map(c => [c.x, c.y]);
    const last = p[p.length - 1];
    if (!last || Math.hypot(this.tip.x - last[0], this.tip.y - last[1]) > 0.35) p.push([this.tip.x, this.tip.y]);
    return p;
  }

  /** Lift: the tip is added, the end tapers, a flick carries on as a hairline. Returns the finished control points. */
  up(t: number): Cp[] {
    let vl = 0;
    if (this.recent.length > 1) {
      const a = this.recent[0], b = this.recent[this.recent.length - 1];
      vl = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(b.t - a.t, 8);
      vl *= Math.exp(-Math.max(0, t - b.t - 25) / 45);
    }
    const last = this.cps[this.cps.length - 1];
    if (Math.hypot(this.tip.x - last.x, this.tip.y - last.y) > 0.35) this.addCp(this.tip.x, this.tip.y, Math.max(t, last.t + 1));
    const cps = this.cps;
    if (cps.length === 1) { // a tap: the landing dot
      cps[0].r = Math.min(cps[0].b * this.lan(t - this.t0), BRUSH.R * 2.3);
      this.vLift = 0;
      return cps;
    }
    const end = cps[cps.length - 1];
    const e = BRUSH.end(vl);
    this.vLift = vl;
    if (e.ext > 1.5 && cps.length > 3) {
      const a = cps[Math.max(0, cps.length - 4)], b = end;
      const h0 = Math.atan2(b.y - a.y, b.x - a.x);
      const c = cps[Math.max(0, cps.length - 8)];
      const h1 = Math.atan2(a.y - c.y, a.x - c.x);
      let dh = h0 - h1;
      while (dh > Math.PI) dh -= TAU;
      while (dh < -Math.PI) dh += TAU;
      const span = Math.max(4, Math.hypot(a.x - c.x, a.y - c.y));
      let kap = clamp(dh / span, -0.05, 0.05), hd = h0, px = b.x, py = b.y, s = b.s, tt = b.t;
      for (let d = 3; d <= e.ext; d += 3) {
        hd += kap * 3; kap *= 0.93;
        px += Math.cos(hd) * 3; py += Math.sin(hd) * 3; s += 3; tt += 3 / Math.max(vl, 0.3);
        cps.push({ x: px, y: py, s, t: tt, b: end.b, r: end.r });
      }
    }
    const tot = cps[cps.length - 1].s;
    for (const cp of cps) {
      const u = (tot - cp.s) / e.len;
      if (u < 1) cp.r *= e.min + (1 - e.min) * Math.pow(Math.sin(u * Math.PI / 2), 1.15);
      cp.r = Math.max(cp.r, 0.12);
    }
    return cps;
  }
}

/** Control points `i0..i1` to evenly spaced samples: a quadratic through the midpoints of neighbours. */
export function dense(v: ReadonlyArray<Pick<Cp, 'x' | 'y' | 'r'>>, i0: number, i1: number, step: number): Dense {
  const X: number[] = [], Y: number[] = [], R: number[] = [], n = v.length;
  for (let i = i0; i <= i1; i++) {
    const c = v[i], pv = i > 0 ? v[i - 1] : c, nx = i < n - 1 ? v[i + 1] : c;
    const ax = (pv.x + c.x) / 2, ay = (pv.y + c.y) / 2, bx = (c.x + nx.x) / 2, by = (c.y + nx.y) / 2;
    const ar = (pv.r + c.r) / 2, br = (c.r + nx.r) / 2;
    const len = Math.hypot(c.x - ax, c.y - ay) + Math.hypot(bx - c.x, by - c.y);
    const k = Math.max(1, Math.ceil(len / step));
    const j1 = i === i1 ? k : k - 1;
    for (let j = 0; j <= j1; j++) {
      const t = j / k, u = 1 - t;
      X.push(u * u * ax + 2 * u * t * c.x + t * t * bx);
      Y.push(u * u * ay + 2 * u * t * c.y + t * t * by);
      R.push(lerp(ar, br, t));
    }
  }
  return { x: X, y: Y, r: R, n: X.length };
}

/** Box of dense samples, grown by each radius and `pad`. */
export function denseBox(d: Dense, pad: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < d.n; i++) {
    const r = d.r[i] + pad;
    if (d.x[i] - r < x0) x0 = d.x[i] - r;
    if (d.y[i] - r < y0) y0 = d.y[i] - r;
    if (d.x[i] + r > x1) x1 = d.x[i] + r;
    if (d.y[i] + r > y1) y1 = d.y[i] + r;
  }
  return { x0, y0, x1, y1 };
}

// ── Storing a stroke ────────────────────────────────────────────────────────────────────────────

/** A finished stroke as kept: points and the radius at each. */
export interface PackedStroke { points: Array<[number, number]>; r: number[] }

/** Douglas-Peucker on the centre line; the radius of a dropped point is read along the line. */
export function packStroke(cps: ReadonlyArray<Pick<Cp, 'x' | 'y' | 'r' | 's'>>, tolerance = 0.45): PackedStroke {
  const n = cps.length;
  if (n <= 2) return { points: cps.map(c => [round1(c.x), round1(c.y)]), r: cps.map(c => round2(c.r)) };
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = keep[n - 1] = true;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = cps[a], B = cps[b];
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((cps[i].x - A.x) * dy - (cps[i].y - A.y) * dx) / len;
      // A change of radius counts as much as a change of place: a taper must keep its shape.
      const dr = Math.abs(cps[i].r - lerp(A.r, B.r, (cps[i].s - A.s) / ((B.s - A.s) || 1))) * 1.6;
      const e = Math.max(d, dr);
      if (e > worst) { worst = e; at = i; }
    }
    if (worst > tolerance && at > 0) { keep[at] = true; stack.push([a, at], [at, b]); }
  }
  const points: Array<[number, number]> = [], r: number[] = [];
  cps.forEach((c, i) => { if (keep[i]) { points.push([round1(c.x), round1(c.y)]); r.push(round2(c.r)); } });
  return { points, r };
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** A stored stroke as control points `dense` can draw; a missing radius list gives the pen's middle width. */
export function unpackStroke(points: ReadonlyArray<[number, number]>, r?: readonly number[]): Array<Pick<Cp, 'x' | 'y' | 'r'>> {
  return points.map((p, i) => ({ x: p[0], y: p[1], r: r && Number.isFinite(r[i]) ? r[i] : BRUSH.R * 0.7 }));
}
