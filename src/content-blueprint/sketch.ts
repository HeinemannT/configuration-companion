/**
 * The hand-drawn line language of the Blueprint canvas.
 *
 * Every box gets ONE SVG path: four strokes that overshoot the corners and bow very slightly. The
 * wobble is seeded by the object id, so a box draws the same on every render (it never jitters) and two
 * boxes never look stamped. There are no filters, no blur and no animation at rest; the only motion is a
 * short draw-in when Blueprint opens or when a staged box first appears (off under reduced motion).
 *
 * The pass runs AFTER the canvas grid is laid out: one read phase (every cell's offset size), then one
 * write phase (one absolutely positioned <svg> per cell plus its hover readout), so it costs one layout
 * and no layout thrash. Position and z-index of the injected SVG are set inline (css-integrity rule).
 */
import type { LNode } from '../lib/layout/types';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Deterministic PRNG seeded by a string (FNV-ish hash → LCG). Stable across renders and sessions. */
export function seeded(seed: string): () => number {
  let s = 7;
  for (let i = 0; i < seed.length; i++) s = (Math.imul(s, 31) + seed.charCodeAt(i)) >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export interface SketchOpts {
  /** endpoint jitter in px (the "hand"). */
  j?: number;
  /** corner overshoot in px. */
  ov?: number;
}

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/** One path for a w×h box at (x,y): four quadratic strokes that overshoot the corners by `ov` px and
 *  bow under ~1 px. Same seed → same path. */
export function sketchRectPath(x: number, y: number, w: number, h: number, seed: string, o: SketchOpts = {}): string {
  const rnd = seeded(seed);
  const j = o.j ?? 0.7, ov = o.ov ?? 3;
  const p = (v: number): string => r1(v + (rnd() - 0.5) * 2 * j);
  const side = (x1: number, y1: number, x2: number, y2: number, dx: number, dy: number): string => {
    const ax = x1 - dx * ov, ay = y1 - dy * ov, bx = x2 + dx * ov, by = y2 + dy * ov;
    const mx = (ax + bx) / 2 + (rnd() - 0.5) * j * 2.2, my = (ay + by) / 2 + (rnd() - 0.5) * j * 2.2;
    return `M${p(ax)} ${p(ay)}Q${r1(mx)} ${r1(my)} ${p(bx)} ${p(by)}`;
  };
  return side(x, y, x + w, y, 1, 0) + side(x + w, y, x + w, y + h, 0, 1)
    + side(x + w, y + h, x, y + h, -1, 0) + side(x, y + h, x, y, 0, -1);
}

/** Crop marks just outside a container's four corners — the container's signature. */
export function cropMarksPath(x: number, y: number, w: number, h: number, gap = 4, len = 8): string {
  const m = (cx: number, cy: number, sx: number, sy: number): string => `M${cx} ${cy + sy * len}V${cy}H${cx + sx * len}`;
  return m(x - gap, y - gap, 1, 1) + m(x + w + gap, y - gap, -1, 1)
    + m(x - gap, y + h + gap, 1, -1) + m(x + w + gap, y + h + gap, -1, -1);
}

/** The nesting level a cell draws at. */
export type SketchLevel = 'container' | 'widget' | 'inner';

export function sketchLevel(node: Pick<LNode, 'kind'>, inner: boolean): SketchLevel {
  if (node.kind === 'container') return 'container';
  return inner ? 'inner' : 'widget';
}

/** Ids already drawn once this session — a box draws in the first time it appears, never again. */
const drawn = new Set<string>();
let firstPaint = true;
/** Reset the draw-in memory (Blueprint turned off). The next open draws in again. */
export function resetSketchMemory(): void { drawn.clear(); firstPaint = true; }

function reducedMotion(): boolean {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
}

/** Width of one grid column (L units, 6 per row) for the readout, from the canvas root width. */
function colLabel(cell: HTMLElement): string {
  const span = Number(cell.dataset.bpspan || 0);
  if (!span) return '';
  return span >= 6 ? '6 COL' : `${span} COL`;
}

/**
 * Draw the sketch strokes for every result cell inside `root`. Cells must carry `data-bplevel`
 * (container | widget | inner) and `data-bpid`. Safe to call on a detached tree (no-op sizes).
 */
export function sketchCanvas(root: HTMLElement): void {
  const cells = Array.from(root.querySelectorAll<HTMLElement>('.bp-rcell[data-bplevel]'));
  // READ phase: every size first, so the writes below never force a re-layout per cell.
  const sizes = cells.map(c => ({ w: c.offsetWidth, h: c.offsetHeight }));
  const animate = !reducedMotion();
  const drawAll = firstPaint && animate;
  firstPaint = false;
  // WRITE phase.
  cells.forEach((cell, i) => {
    const { w, h } = sizes[i];
    if (w < 4 || h < 4) return;
    const id = cell.dataset.bpid ?? String(i);
    const level = cell.dataset.bplevel as SketchLevel;
    const pad = 6; // room for overshoot + crop marks outside the box
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `bp-sk bp-sk-${level}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', String(w + pad * 2));
    svg.setAttribute('height', String(h + pad * 2));
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`);
    // critical placement inline (css-integrity rule): the stroke layer never joins the cell's flow
    svg.style.cssText = `position:absolute;left:${-pad - 1}px;top:${-pad - 1}px;z-index:0;overflow:visible;pointer-events:none`;
    const o: SketchOpts = level === 'container' ? { j: 0.5, ov: 0 } : level === 'inner' ? { j: 0.35, ov: 0 } : {};
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'bp-sk-line');
    path.setAttribute('d', sketchRectPath(0.5, 0.5, w - 1, h - 1, id, o));
    const fresh = !drawn.has(id);
    drawn.add(id);
    if (animate && (drawAll || (fresh && cell.classList.contains('st-new')))) {
      path.setAttribute('pathLength', '1');
      path.classList.add('bp-sk-draw');
      if (level === 'widget') path.style.animationDelay = '40ms';
      if (level === 'inner') path.style.animationDelay = '80ms';
    }
    svg.appendChild(path);
    if (level === 'container') {
      const crop = document.createElementNS(SVG_NS, 'path');
      crop.setAttribute('class', 'bp-sk-crop');
      crop.setAttribute('d', cropMarksPath(0, 0, w, h));
      svg.appendChild(crop);
    }
    cell.insertBefore(svg, cell.firstChild);
    // hover/selection readout (CSS shows it only on hover or selection)
    const cols = colLabel(cell);
    cell.dataset.bpdim = `${cols ? cols + '  ' : ''}${Math.round(w)} × ${Math.round(h)}`;
  });
}

/** Drafting dimension lines for the selected cell: a width line above it and a height line on its
 *  right, each with 45° ticks and a tabular-mono label that interrupts the line. Built from the size
 *  the sketch pass already measured (no extra layout read). Placement is inline. */
export function dimensionLines(cell: HTMLElement): void {
  const svg = cell.querySelector('.bp-sk');
  const w = Number(svg?.getAttribute('width') ?? 0) - 12, h = Number(svg?.getAttribute('height') ?? 0) - 12;
  if (w < 24 || h < 16) return;
  const span = Number(cell.dataset.bpspan || 0);
  const mk = (cls: string, label: string, css: string): void => {
    const d = document.createElement('div');
    d.className = `bp-dim ${cls}`;
    d.setAttribute('aria-hidden', 'true');
    d.style.cssText = `position:absolute;z-index:3;pointer-events:none;${css}`;
    const t = document.createElement('span'); t.className = 'bp-dim-t'; t.textContent = label;
    d.appendChild(t);
    cell.appendChild(d);
  };
  mk('bp-dim-h', `${span ? `${span} COL  ` : ''}${Math.round(w)} PX`, `left:-1px;top:-15px;width:${w}px;height:9px`);
  mk('bp-dim-v', `${Math.round(h)} PX`, `right:-34px;top:-1px;width:12px;height:${h}px`);
}
