/**
 * Point and tell: a sketch of a widget. A group of strokes drawn on empty grid is read for what a person
 * means by it, the way they would sketch it on paper:
 *
 *   a box with lines across            table (the lines run edge to edge; a vertical divider may cross them)
 *   a box with bars of varying height  chart (bars)
 *   a box with a rising, zigzag line   chart (line)
 *   a small wide rounded box           button (also a small box with one short scribble inside)
 *   two or more wavy or short lines    text (inside a box with nothing else in it, or without a box)
 *   a box with anything else           no kind: "add here", as an empty box is
 *
 * Pure functions over the features of the strokes (see `analyze` in ink-read). The ink is never changed;
 * this only says what it looks like. When the evidence is thin the answer is the weaker one: no kind.
 */
import type { Features } from './ink-features';
import { clamp, dp } from './ink-geom';
import type { Rect } from './hit';
import type { PtPoint, PtWidgetKind } from './types';

/** The widget types of the add list (see layout/palette) that each sketch stands for. */
export const WIDGET_TYPES = {
  table: ['ExtendedTable'],
  chartBars: ['BarChart', 'BarLineChart'],
  chartLine: ['LineChart', 'AreaChart'],
  chartBoth: ['BarLineChart', 'BarChart', 'LineChart'],
  button: ['ActionButton'],
  text: ['TextElement'],
} as const;

export interface SketchRead {
  /** The outer box of the sketch (page coordinates): where the new widget goes and how wide it is. */
  box: Rect;
  /** Absent: a box with nothing the reader is sure of; it stays an "add here". */
  widget?: { kind: PtWidgetKind; types: string[] };
}

type PartKind = 'H' | 'V' | 'loop' | 'free';
interface Part { kind: PartKind; box: Rect; wavy: boolean; f: Features; rounded: boolean }

const right = (r: Rect): number => r.left + r.width;
const bottom = (r: Rect): number => r.top + r.height;
const unionOf = (rs: Rect[]): Rect => {
  const l = Math.min(...rs.map(r => r.left)), t = Math.min(...rs.map(r => r.top));
  return { left: l, top: t, width: Math.max(...rs.map(right)) - l, height: Math.max(...rs.map(bottom)) - t };
};

/** A line that swings to both sides of its chord three times or more, by more than a hand's tremor. */
function waviness(S: PtPoint[]): boolean {
  if (S.length < 8) return false;
  const a = S[0], b = S[S.length - 1];
  const cx = b[0] - a[0], cy = b[1] - a[1], cl = Math.hypot(cx, cy) || 1;
  let side = 0, swings = 0;
  for (const p of S) {
    const d = ((p[0] - a[0]) * cy - (p[1] - a[1]) * cx) / cl;
    const sg = d > 2.5 ? 1 : d < -2.5 ? -1 : 0;
    if (sg && sg !== side) { if (side) swings++; side = sg; }
  }
  return swings >= 3;
}

/** How much the corners of a closed box are cut: under 0.1 for a sharp box, 0.12 to 0.25 for a rounded one, over 0.3 for an oval. */
function cornerCut(S: PtPoint[], box: Rect): number {
  const m = Math.min(box.width, box.height) || 1;
  const corners: PtPoint[] = [[box.left, box.top], [right(box), box.top], [right(box), bottom(box)], [box.left, bottom(box)]];
  let sum = 0;
  for (const c of corners) { let best = 1e9; for (const p of S) best = Math.min(best, Math.hypot(p[0] - c[0], p[1] - c[1])); sum += best / m; }
  return sum / 4;
}

const flatBox = (r: Rect): boolean => r.width >= 24 && (r.height <= Math.max(0.22 * r.width, 12));
const tallBox = (r: Rect): boolean => r.height >= 20 && (r.width <= 0.2 * r.height || r.width <= 10);

/** The pieces a stroke is made of: a line, a loop, or something free-form. A stroke with corners (an L, a U) is cut into its straight pieces. */
function partsOf(fs: Features[]): Part[] {
  const out: Part[] = [];
  for (const f of fs) {
    if (f.tap || f.L < 14) continue;
    const bb = f.bbox;
    const base = { f, wavy: false, rounded: false };
    if (f.closed || (f.closure < 0.35 && f.corners >= 3 && f.rectness >= 0.6 && bb.width >= 14 && bb.height >= 14)) {
      const cut = cornerCut(f.S, bb);
      out.push({ ...base, kind: 'loop', box: bb, rounded: f.rectness >= 0.8 && cut >= 0.11 && cut <= 0.29 });
      continue;
    }
    if (flatBox(bb)) { out.push({ ...base, kind: 'H', box: bb, wavy: waviness(f.S) }); continue; }
    if (tallBox(bb)) { out.push({ ...base, kind: 'V', box: bb }); continue; }
    if (f.corners >= 1 && f.corners <= 3 && f.L / Math.max(1, f.diag) <= 1.6 && !f.scribble) {
      const V = dp(f.S, clamp(0.05 * f.diag, 4, 12));
      let any = false;
      for (let i = 1; i < V.length; i++) {
        const a = V[i - 1], b = V[i], dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
        if (Math.hypot(dx, dy) < 14) continue;
        const box: Rect = { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: dx, height: dy };
        if (dy <= 0.36 * dx) { out.push({ ...base, kind: 'H', box }); any = true; }
        else if (dx <= 0.36 * dy) { out.push({ ...base, kind: 'V', box }); any = true; }
        else out.push({ ...base, kind: 'free', box });
      }
      if (any) continue;
      if (V.length > 1) continue;
    }
    out.push({ ...base, kind: 'free', box: bb });
  }
  return out;
}

/** A line across a box that goes up (or down) to the right in several legs: a line chart, not a scribble. */
function isChartLine(p: Part, inner: Rect): boolean {
  const f = p.f;
  if (p.kind !== 'free' || f.closed || f.tap) return false;
  if (f.bbox.width < 0.5 * inner.width || f.bbox.height < 0.2 * inner.height) return false;
  if (f.L / Math.max(1, f.diag) > 2.2) return false;
  const V = dp(f.S, clamp(0.06 * f.diag, 5, 14));
  if (V.length < 4) return false;
  let fwd = 0, back = 0;
  for (let i = 1; i < f.S.length; i++) { const dx = f.S[i][0] - f.S[i - 1][0]; if (dx >= -2) fwd++; if (dx <= 2) back++; }
  return Math.max(fwd, back) >= 0.9 * (f.S.length - 1);
}

interface Frame { inner: Rect; used: Part[]; rounded: boolean }

/** The outline of the sketch: one loop that is the whole sketch, or four sides drawn as lines. */
function frameOf(parts: Part[], B: Rect): Frame | null {
  const loops = parts.filter(p => p.kind === 'loop' && p.box.width >= 0.8 * B.width && p.box.height >= 0.8 * B.height)
    .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
  if (loops.length) {
    const l = loops[0];
    return { inner: l.box, used: [l], rounded: l.rounded };
  }
  const tol = clamp(0.14 * Math.min(B.width, B.height), 7, 20);
  const cover = (ps: Part[], lo: number, hi: number): number => {
    const iv = ps.map(p => [Math.max(lo, p.kind === 'H' ? p.box.left : p.box.top), Math.min(hi, p.kind === 'H' ? right(p.box) : bottom(p.box))]).filter(i => i[1] > i[0]).sort((a, b) => a[0] - b[0]);
    let len = 0, at = lo;
    for (const [a, b] of iv) { if (b > at) { len += b - Math.max(a, at); at = b; } }
    return len / Math.max(1, hi - lo);
  };
  const sideH = (y: number): Part[] => parts.filter(p => p.kind === 'H' && Math.abs(p.box.top + p.box.height / 2 - y) <= tol);
  const sideV = (x: number): Part[] => parts.filter(p => p.kind === 'V' && Math.abs(p.box.left + p.box.width / 2 - x) <= tol);
  const top = sideH(B.top), bot = sideH(bottom(B)), lef = sideV(B.left), rig = sideV(right(B));
  const ok = cover(top, B.left, right(B)) >= 0.55 && cover(bot, B.left, right(B)) >= 0.55 && cover(lef, B.top, bottom(B)) >= 0.55 && cover(rig, B.top, bottom(B)) >= 0.55;
  if (!ok) return null;
  return { inner: B, used: [...top, ...bot, ...lef, ...rig], rounded: false };
}

const isTextLine = (p: Part, iw: number): boolean => p.kind === 'H' && (p.wavy || p.box.width < 0.75 * iw) && p.box.width >= 24;

/** Lines of text without a box: two or more lines under each other, wavy or short, left edges roughly together. */
function textLines(parts: Part[], contentWidth: number): Rect | null {
  if (parts.length < 2 || !parts.every(p => p.kind === 'H' && p.box.width >= 40)) return null;
  const rows = parts.slice().sort((a, b) => a.box.top - b.box.top);
  const B = unionOf(rows.map(p => p.box));
  if (contentWidth > 0 && B.width > 0.8 * contentWidth) return null;
  const maxW = Math.max(...rows.map(p => p.box.width));
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].box, b = rows[i].box;
    const gap = b.top - a.top;
    const xov = Math.min(right(a), right(b)) - Math.max(a.left, b.left);
    if (gap < 8 || gap > 90 || xov < 0.5 * Math.min(a.width, b.width)) return null;
    if (Math.abs(a.left - b.left) > 0.35 * maxW + 20) return null;
  }
  return B;
}

/**
 * What a group of strokes sketches. Returns null when it is not a sketch on empty grid at all (the caller
 * reads it as plain ink): a stroke outside the box, a box with a diagonal through it, handwriting.
 * `contentWidth` is the width of the page's content, to tell a few short lines from a ruled page.
 */
export function readSketch(fs: Features[], contentWidth = 0): SketchRead | null {
  const parts = partsOf(fs);
  if (!parts.length) return null;
  const B = unionOf(parts.map(p => p.box));
  if (B.width < 40 || B.height < 20) return null;
  const frame = frameOf(parts, B);

  if (!frame) {
    const box = textLines(parts, contentWidth);
    return box ? { box, widget: { kind: 'text', types: [...WIDGET_TYPES.text] } } : null;
  }
  const inner = frame.inner;
  const iw = inner.width, ih = inner.height;
  const tol = clamp(0.14 * Math.min(iw, ih), 7, 20);
  const content = parts.filter(p => !frame.used.includes(p));
  // Everything must lie inside the box: a stroke sticking out of it is a drawing of something else.
  if (content.some(p => p.box.left < inner.left - tol || right(p.box) > right(inner) + tol || p.box.top < inner.top - tol || bottom(p.box) > bottom(inner) + tol)) return null;
  const add = (widget?: SketchRead['widget']): SketchRead => ({ box: inner, ...(widget ? { widget } : {}) });

  const hLong = content.filter(p => p.kind === 'H' && !p.wavy && p.box.width >= 0.75 * iw);
  // Upright strokes: dividers of a table when they run the whole height, bars of a chart when they stand on the bottom at different heights.
  const uprights = content.filter(p => (p.kind === 'V' && p.box.height >= 0.12 * ih)
    || (p.kind === 'loop' && p.box.height >= 1.2 * p.box.width && p.box.height >= 0.12 * ih && p.box.width <= 0.25 * iw));
  const standingUp = uprights.filter(p => Math.abs(bottom(p.box) - bottom(inner)) <= 0.3 * ih);
  const heights = uprights.map(p => p.box.height);
  const barsLike = uprights.length >= 3 && standingUp.length >= 0.7 * uprights.length && Math.max(...heights) / Math.max(1, Math.min(...heights)) >= 1.25;
  const bars = barsLike ? uprights : [];
  const vFull = barsLike ? [] : uprights.filter(p => p.kind === 'V' && p.box.height >= 0.75 * ih);
  const lines = content.filter(p => isTextLine(p, iw));
  const rising = content.filter(p => isChartLine(p, inner));
  const known = new Set<Part>([...hLong, ...vFull, ...bars, ...lines, ...rising]);
  const rest = content.filter(p => !known.has(p));

  if (bars.length && rest.length === 0 && hLong.length <= 1 && lines.length === 0) {
    return add({ kind: 'chart', types: [...(rising.length ? WIDGET_TYPES.chartBoth : WIDGET_TYPES.chartBars)] });
  }
  if (rising.length === 1 && bars.length === 0 && rest.length === 0 && lines.length === 0 && hLong.length <= 1) {
    return add({ kind: 'chart', types: [...WIDGET_TYPES.chartLine] });
  }
  // Axes of a chart (a line up the left and one along the bottom) are not the rules of a table.
  const axes = hLong.length === 1 && vFull.length === 1 && vFull[0].box.left <= inner.left + 0.15 * iw && bottom(hLong[0].box) >= bottom(inner) - 0.2 * ih;
  if (!axes && ih >= 56 && iw >= 100 && rest.length === 0 && bars.length === 0 && rising.length === 0 && (hLong.length >= 2 || (hLong.length === 1 && vFull.length >= 1))) {
    return add({ kind: 'table', types: [...WIDGET_TYPES.table] });
  }
  const quiet = hLong.length === 0 && vFull.length === 0 && bars.length === 0 && rising.length === 0 && rest.length === 0;
  if (quiet && lines.length >= 2 && ih >= 40) return add({ kind: 'text', types: [...WIDGET_TYPES.text] });
  // A small wide box: a button, when it is rounded or has a short scribble for its label.
  const small = ih >= 22 && ih <= 70 && iw >= 50 && iw <= 260 && iw >= 1.5 * ih && iw <= 8 * ih;
  if (small && hLong.length === 0 && vFull.length === 0 && bars.length === 0 && rising.length === 0) {
    const label = lines.length + rest.length;
    if (label === 1 && content.length === 1) return add({ kind: 'button', types: [...WIDGET_TYPES.button] });
    if (label === 0 && frame.rounded) return add({ kind: 'button', types: [...WIDGET_TYPES.button] });
  }
  return add();
}
