/**
 * Point and tell: the ink canvas. One canvas the size of the window, above the page and click-through,
 * on which the strokes are painted in the brand purple, with no edge or shadow under them.
 *
 * Finished strokes live in an offscreen canvas that is redrawn from the stored strokes (cached paths) on
 * scroll, resize and edit. A stroke being drawn is painted in two parts: the settled part is baked once
 * into a live layer, and only the tail that is still moving is redrawn each frame, from
 * the real pen tip, into a small scratch canvas. The visible canvas then shows, in the dirty box only:
 * finished strokes and the live layer. That keeps a frame well under a millisecond.
 *
 * Strokes are in page coordinates; the canvas is in window coordinates, so a stroke is painted at its
 * page position minus the scroll offset (frozen while a stroke is being drawn).
 */
import { BRUSH, Pen, dense, denseBox, unpackStroke, type Dense } from '../lib/point-tell/ink-pen';
import { Z, placed } from './view';

/** The brand purple: the one ink. */
export const INK_COLOR = '#8a3ffc';

/** A finished stroke in page coordinates, ready to paint. */
export interface InkStrokeIn { key: string; points: ReadonlyArray<[number, number]>; r?: readonly number[] }

interface Item {
  key: string;
  /** Page-coordinate bounds, grown by the pen's widest point. */
  x0: number; y0: number; x1: number; y1: number;
  core: Path2D;
  /** Sub-sampled centre line for the eraser. */
  poly: Array<{ x: number; y: number; r: number }>;
}

interface Box { x: number; y: number; w: number; h: number }

const union = (a: Box | null, b: Box | null): Box | null => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

function hull(p: Path2D, ax: number, ay: number, ar: number, bx: number, by: number, br: number): void {
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
  if (d < 1e-3 || d <= Math.abs(ar - br)) return;
  const th = Math.atan2(dy, dx), al = Math.acos((ar - br) / d), a1 = th + al, a2 = th - al;
  p.moveTo(ax + ar * Math.cos(a2), ay + ar * Math.sin(a2));
  p.lineTo(bx + br * Math.cos(a2), by + br * Math.sin(a2));
  p.lineTo(bx + br * Math.cos(a1), by + br * Math.sin(a1));
  p.lineTo(ax + ar * Math.cos(a1), ay + ar * Math.sin(a1));
  p.closePath();
}

/** The union of discs and the hulls between them: a tube of varying width with no joints. */
function tube(d: Dense, grow: number): Path2D {
  const p = new Path2D();
  let px = 0, py = 0, pr = 0;
  for (let i = 0; i < d.n; i++) {
    const rr = Math.max(0.06, d.r[i] + grow);
    p.moveTo(d.x[i] + rr, d.y[i]);
    p.arc(d.x[i], d.y[i], rr, 0, Math.PI * 2);
    if (i) hull(p, px, py, pr, d.x[i], d.y[i], rr);
    px = d.x[i]; py = d.y[i]; pr = rr;
  }
  return p;
}

const mk = (w: number, h: number): HTMLCanvasElement => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };

export interface InkStats { frames: number; meanMs: number; p95Ms: number; maxMs: number }

export class InkCanvas {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** No 2d canvas here (a test environment): every call does nothing. */
  private readonly dead: boolean;
  private dpr = 1;
  private w = 0; private h = 0;
  private base: HTMLCanvasElement;
  private baseCtx: CanvasRenderingContext2D;
  private items: Item[] = [];
  private cache = new Map<string, { sig: string; item: Item }>();
  private baseDirty = true;
  private raf = 0;

  // The stroke being drawn.
  private pen: Pen | null = null;
  private sx = 0; private sy = 0;
  private liveCore: HTMLCanvasElement | null = null;
  private liveCoreCtx: CanvasRenderingContext2D | null = null;
  private tailCore: HTMLCanvasElement;
  private liveBox: Box | null = null;
  private tailBox: Box | null = null;
  private dirty: Box | null = null;
  private costs: number[] = [];

  constructor(parent: HTMLElement) {
    this.el = placed(document.createElement('canvas'), 'fixed', Z.ink);
    this.el.className = 'pt-ink';
    this.el.style.left = '0'; this.el.style.top = '0';
    this.el.style.pointerEvents = 'none';
    this.el.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.el);
    this.ctx = this.el.getContext('2d', { alpha: true, desynchronized: true })!;
    this.base = mk(1, 1);
    this.baseCtx = this.base.getContext('2d')!;
    this.dead = !this.ctx || !this.baseCtx || typeof Path2D === 'undefined';
    this.tailCore = mk(1, 1);
    this.resize();
  }

  /** Size to the window (and its pixel density). Everything is repainted. */
  resize(): void {
    const w = document.documentElement.clientWidth || window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (w === this.w && h === this.h && dpr === this.dpr && this.el.width) return;
    this.w = w; this.h = h; this.dpr = dpr;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    for (const c of [this.el, this.base]) { c.width = bw; c.height = bh; }
    this.el.style.width = `${w}px`; this.el.style.height = `${h}px`;
    this.liveCore = null; this.liveCoreCtx = null;
    this.baseDirty = true;
    this.cache.clear();
    this.schedule();
  }

  // ── Finished strokes ──────────────────────────────────────────────────────────────────────────

  /** The strokes to show, in order. Paths are cached per stroke key and position. */
  setStrokes(strokes: ReadonlyArray<InkStrokeIn>): void {
    if (this.dead) return;
    const next = new Map<string, { sig: string; item: Item }>();
    this.items = strokes.map(s => {
      const sig = `${s.points.length}:${s.points[0]?.[0]}:${s.points[0]?.[1]}:${s.points[s.points.length - 1]?.[0]}:${s.points[s.points.length - 1]?.[1]}`;
      const hit = this.cache.get(s.key);
      const item = hit && hit.sig === sig ? hit.item : this.build(s);
      next.set(s.key, { sig, item });
      return item;
    });
    this.cache = next;
    this.baseDirty = true;
    this.schedule();
  }

  private build(s: InkStrokeIn): Item {
    const cps = unpackStroke(s.points as Array<[number, number]>, s.r);
    const d = dense(cps, 0, cps.length - 1, BRUSH.step);
    const b = denseBox(d, 1);
    const poly: Item['poly'] = [];
    let ax = 1e9, ay = 1e9;
    for (let i = 0; i < d.n; i++) if (i === 0 || i === d.n - 1 || Math.hypot(d.x[i] - ax, d.y[i] - ay) >= 5) { poly.push({ x: d.x[i], y: d.y[i], r: d.r[i] }); ax = d.x[i]; ay = d.y[i]; }
    return { key: s.key, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, core: tube(d, 0), poly };
  }

  private paintItem(g: CanvasRenderingContext2D, it: Item): void {
    g.fillStyle = INK_COLOR;
    g.fill(it.core);
  }

  private redrawBase(): void {
    const g = this.baseCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.base.width, this.base.height);
    const sx = window.scrollX, sy = window.scrollY;
    g.setTransform(this.dpr, 0, 0, this.dpr, -sx * this.dpr, -sy * this.dpr);
    for (const it of this.items) {
      if (it.x1 < sx || it.x0 > sx + this.w || it.y1 < sy || it.y0 > sy + this.h) continue;
      this.paintItem(g, it);
    }
    this.baseDirty = false;
  }

  /** The window scrolled: finished strokes are painted at their new place. */
  scrolled(): void { this.baseDirty = true; this.schedule(); }

  /** A stroke whose centre line passes within `slop` px of the segment a-b (page coordinates), as the eraser asks. */
  hits(ax: number, ay: number, bx: number, by: number, slop: number): string[] {
    const out: string[] = [];
    if (this.dead) return out;
    const segDist = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
      const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0;
      return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
    };
    for (const it of this.items) {
      if (Math.max(ax, bx) < it.x0 - slop || Math.min(ax, bx) > it.x1 + slop || Math.max(ay, by) < it.y0 - slop || Math.min(ay, by) > it.y1 + slop) continue;
      let hit = false;
      for (let i = 0; i < it.poly.length && !hit; i++) {
        const q = it.poly[i], n = it.poly[i + 1];
        if (segDist(q.x, q.y, ax, ay, bx, by) <= q.r + slop) hit = true;
        else if (n && segDist(ax, ay, q.x, q.y, n.x, n.y) <= Math.max(q.r, n.r) + slop) hit = true;
      }
      if (hit && !out.includes(it.key)) out.push(it.key);
    }
    return out;
  }

  // ── The stroke being drawn ────────────────────────────────────────────────────────────────────

  /** Start painting `pen`'s stroke; the scroll offset is frozen for its length. */
  begin(pen: Pen): void {
    if (this.dead) return;
    this.pen = pen;
    this.sx = window.scrollX; this.sy = window.scrollY;
    if (!this.liveCore) {
      this.liveCore = mk(this.el.width, this.el.height);
      this.liveCoreCtx = this.liveCore.getContext('2d');
    }
    const lg = this.liveCoreCtx!;
    lg.setTransform(1, 0, 0, 1, 0, 0); lg.clearRect(0, 0, this.el.width, this.el.height); lg.setTransform(this.dpr, 0, 0, this.dpr, -this.sx * this.dpr, -this.sy * this.dpr);
    this.liveBox = null; this.tailBox = null; this.costs = [];
    this.schedule();
  }

  /** Whether a stroke is being drawn. */
  get drawing(): boolean { return this.pen !== null; }

  /** The stroke ended (or was cancelled): the live layers are cleared; the caller then sets the strokes. */
  end(): void {
    if (!this.pen || this.dead) return;
    this.pen = null;
    const box = union(this.liveBox, this.tailBox);
    this.liveBox = this.tailBox = null;
    if (this.liveCoreCtx) { const g = this.liveCoreCtx; g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.el.width, this.el.height); g.restore(); }
    this.dirty = union(this.dirty, box);
    this.baseDirty = true; // the finished stroke arrives with setStrokes; until then show the others
    this.publishStats();
    this.schedule();
  }

  /** A frame is wanted (new samples arrived). */
  invalidate(): void { this.schedule(); }

  private schedule(): void {
    if (this.raf || this.dead) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.frame(); });
  }

  private devBox(x0: number, y0: number, x1: number, y1: number): Box {
    // Window coordinates (page minus the frozen scroll while drawing) to device pixels.
    const d = this.dpr;
    const x = Math.max(0, Math.floor((x0 - this.sx) * d)), y = Math.max(0, Math.floor((y0 - this.sy) * d));
    const X = Math.min(this.el.width, Math.ceil((x1 - this.sx) * d)), Y = Math.min(this.el.height, Math.ceil((y1 - this.sy) * d));
    return { x, y, w: Math.max(0, X - x), h: Math.max(0, Y - y) };
  }

  private frame(): void {
    const t0 = performance.now();
    const pen = this.pen;
    if (pen) this.liveFrame(pen);
    if (this.baseDirty) { this.redrawBase(); this.dirty = { x: 0, y: 0, w: this.el.width, h: this.el.height }; }
    this.present();
    if (pen) { this.costs.push(performance.now() - t0); if (this.pen) this.schedule(); }
  }

  private liveFrame(pen: Pen): void {
    const maxR = BRUSH.R * 2.6 + 5;
    const chunk = pen.bakedChunk();
    if (chunk && this.liveCoreCtx) {
      this.liveCoreCtx.fillStyle = INK_COLOR; this.liveCoreCtx.fill(tube(chunk, 0));
      const b = denseBox(chunk, maxR);
      const box = this.devBox(b.x0, b.y0, b.x1, b.y1);
      this.liveBox = union(this.liveBox, box); this.dirty = union(this.dirty, box);
    }
    const { v, i0 } = pen.tailView();
    const d = dense(v, i0, v.length - 1, BRUSH.step);
    const tb = denseBox(d, maxR);
    const box = this.devBox(tb.x0, tb.y0, tb.x1, tb.y1);
    if (this.tailCore.width < box.w || this.tailCore.height < box.h) {
      this.tailCore.width = Math.max(this.tailCore.width, Math.ceil(box.w * 1.4));
      this.tailCore.height = Math.max(this.tailCore.height, Math.ceil(box.h * 1.4));
    }
    const c = this.tailCore.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, c.canvas.width, c.canvas.height); c.setTransform(this.dpr, 0, 0, this.dpr, -(box.x + this.sx * this.dpr), -(box.y + this.sy * this.dpr));
    c.fillStyle = INK_COLOR; c.fill(tube(d, 0));
    this.dirty = union(union(this.dirty, box), this.tailBox);
    this.tailBox = box;
  }

  private present(): void {
    const r = this.dirty;
    this.dirty = null;
    if (!r || r.w <= 0 || r.h <= 0) return;
    const g = this.ctx;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(r.x, r.y, r.w, r.h);
    g.drawImage(this.base, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    const pen = this.pen;
    if (pen && this.liveCore) {
      const t = this.tailBox;
      g.drawImage(this.liveCore, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      if (t) this.drawTail(g, this.tailCore, t, r);
    }
    g.restore();
  }

  /** The part of the tail scratch canvas that falls inside the dirty box. */
  private drawTail(g: CanvasRenderingContext2D, src: HTMLCanvasElement, t: Box, r: Box): void {
    const x = Math.max(t.x, r.x), y = Math.max(t.y, r.y), X = Math.min(t.x + t.w, r.x + r.w), Y = Math.min(t.y + t.h, r.y + r.h);
    if (X <= x || Y <= y) return;
    g.drawImage(src, x - t.x, y - t.y, X - x, Y - y, x, y, X - x, Y - y);
  }

  private publishStats(): void {
    const c = this.costs.slice().sort((a, b) => a - b);
    if (!c.length) return;
    const mean = c.reduce((a, b) => a + b, 0) / c.length;
    // Read from the page by the test rig (the content script's own world is not reachable from it).
    this.el.dataset.frames = String(c.length);
    this.el.dataset.meanMs = mean.toFixed(3);
    this.el.dataset.p95Ms = c[Math.min(c.length - 1, Math.floor(c.length * 0.95))].toFixed(3);
    this.el.dataset.maxMs = c[c.length - 1].toFixed(3);
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.el.remove();
  }
}
