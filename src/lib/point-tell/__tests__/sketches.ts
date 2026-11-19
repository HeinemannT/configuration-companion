/**
 * Hand-like sketches of widgets for the reader's tests: a table, bars, a rising line, a rounded button, lines
 * of text. Seeded, so a test is the same every time. Points are [x, y] in page coordinates.
 */
import type { PtPoint } from '../types';
import { box, line, rng, wave, type GenOpts } from './strokes';

/** A box with rounded corners (radius r), drawn as one stroke that starts and ends near the top left. */
export function roundBox(x: number, y: number, w: number, h: number, r: number, o: GenOpts = {}): PtPoint[] {
  const g = rng(o.seed ?? 9), wob = o.wob ?? 1.6, pts: PtPoint[] = [];
  const push = (px: number, py: number): void => { pts.push([px + (g() - 0.5) * wob, py + (g() - 0.5) * wob]); };
  const edge = (a: PtPoint, b: PtPoint): void => {
    const n = Math.max(6, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
    for (let i = 0; i < n; i++) push(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n);
  };
  const arc = (cx: number, cy: number, a0: number): void => { for (let i = 0; i <= 6; i++) { const a = a0 + (Math.PI / 2) * (i / 6); push(cx + r * Math.cos(a), cy + r * Math.sin(a)); } };
  edge([x + r, y], [x + w - r, y]); arc(x + w - r, y + r, -Math.PI / 2);
  edge([x + w, y + r], [x + w, y + h - r]); arc(x + w - r, y + h - r, 0);
  edge([x + w - r, y + h], [x + r, y + h]); arc(x + r, y + h - r, Math.PI / 2);
  edge([x, y + h - r], [x, y + r]); arc(x + r, y + r, Math.PI);
  for (let i = 0; i < 3; i++) push(x + r + 4 + i * 4, y + (g() - 0.5) * 2);
  return pts;
}

/** A polyline through the given vertices, wobbled. */
export function poly(vs: PtPoint[], o: GenOpts & { step?: number } = {}): PtPoint[] {
  const g = rng(o.seed ?? 10), wob = o.wob ?? 1.6, step = o.step ?? 5, pts: PtPoint[] = [];
  for (let k = 1; k < vs.length; k++) {
    const a = vs[k - 1], b = vs[k], n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let i = 0; i < n; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n + (g() - 0.5) * wob, a[1] + ((b[1] - a[1]) * i) / n + (g() - 0.5) * wob]);
  }
  const l = vs[vs.length - 1];
  pts.push([l[0], l[1]]);
  return pts;
}

/** A table: an outline and `rows - 1` lines across (and `cols - 1` dividers), each its own stroke. */
export function tableSketch(x: number, y: number, w: number, h: number, rows: number, cols = 1, seed = 20, wob = 1.8): PtPoint[][] {
  const out: PtPoint[][] = [box(x, y, w, h, { seed, wob })];
  for (let i = 1; i < rows; i++) out.push(line([x + 2, y + (h * i) / rows], [x + w - 2, y + (h * i) / rows + 1], { bow: 0.01, seed: seed + i, wob }));
  for (let j = 1; j < cols; j++) out.push(line([x + (w * j) / cols, y + 2], [x + (w * j) / cols + 1, y + h - 2], { bow: 0.01, seed: seed + 10 + j, wob }));
  return out;
}

/** A bar chart: an outline and bars (vertical strokes) of the given heights, as fractions of the box. */
export function barsSketch(x: number, y: number, w: number, h: number, heights: number[], seed = 30, wob = 1.8): PtPoint[][] {
  const out: PtPoint[][] = [box(x, y, w, h, { seed, wob })];
  heights.forEach((f, i) => {
    const bx = x + (w * (i + 0.7)) / (heights.length + 0.4);
    out.push(line([bx, y + h - 4], [bx + 1, y + h - 4 - (h - 12) * f], { bow: 0.01, seed: seed + i + 1, wob }));
  });
  return out;
}

/** A line chart: an outline and a line that climbs to the right in legs. */
export function lineChartSketch(x: number, y: number, w: number, h: number, seed = 40, wob = 1.8): PtPoint[][] {
  const vs: PtPoint[] = [[x + 0.1 * w, y + 0.8 * h], [x + 0.3 * w, y + 0.55 * h], [x + 0.45 * w, y + 0.65 * h], [x + 0.65 * w, y + 0.35 * h], [x + 0.9 * w, y + 0.15 * h]];
  return [box(x, y, w, h, { seed, wob }), poly(vs, { seed: seed + 1, wob })];
}

/** Lines of text: wavy strokes under each other, left edges roughly together. */
export function textLines(x: number, y: number, widths: number[], gap = 18, seed = 50): PtPoint[][] {
  const g = rng(seed);
  return widths.map((wd, i) => wave(x + (g() - 0.5) * 8, y + i * gap, wd, 3.2 + g(), 13 + g() * 4, { seed: seed + i }));
}
