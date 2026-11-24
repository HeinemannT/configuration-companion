/**
 * Drawings that are not arrows and must keep their reading when the arrow rules grow: handwriting, letters and
 * digits (7, 1, L, V, T, P, 9), check marks, underlines, squiggles, loops with a tail, a widget sketch, a cross,
 * and a long stroke with a short one near it that is no head. Each is drawn small and big (three times the size,
 * as a broad brush on a wide page does), at a few places.
 */
import type { PtPoint } from '../types';
import { cross, letters, line, rng, tick, wave } from './strokes';
import { poly, tableSketch } from './sketches';

export interface NotArrow { name: string; strokes: PtPoint[][] }

/** A smooth curve through points (unit coordinates), a little unsteady. */
const curve = (vs: PtPoint[], seed: number): PtPoint[] => {
  const g = rng(seed), out: PtPoint[] = [];
  for (let i = 0; i < vs.length - 1; i++) {
    const p0 = vs[Math.max(0, i - 1)], p1 = vs[i], p2 = vs[i + 1], p3 = vs[Math.min(vs.length - 1, i + 2)];
    for (let k = 0; k < 12; k++) {
      const t = k / 12, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]) + (g() - 0.5) * 0.01, f(p0[1], p1[1], p2[1], p3[1]) + (g() - 0.5) * 0.01]);
    }
  }
  out.push(vs[vs.length - 1]);
  return out;
};

/** Unit shapes (about 0..1 wide and 0..1.4 high), as strokes of unit points. */
const SHAPES: Record<string, (seed: number) => PtPoint[][]> = {
  'seven, one stroke': s => [poly([[0, 0], [1, 0], [0.3, 1.4]], { seed: s, wob: 0.01, step: 0.03 })],
  'seven, two strokes': s => [poly([[0, 0], [1, 0]], { seed: s, wob: 0.01, step: 0.03 }), poly([[1, 0], [0.3, 1.4]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'one with a flag': s => [poly([[0.2, 0.3], [0.6, 0], [0.6, 1.4]], { seed: s, wob: 0.01, step: 0.03 })],
  'one with a flag and a foot': s => [poly([[0.2, 0.3], [0.6, 0], [0.6, 1.4]], { seed: s, wob: 0.01, step: 0.03 }), poly([[0.25, 1.4], [0.95, 1.4]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'L, one stroke': s => [poly([[0, 0], [0, 1.4], [0.8, 1.4]], { seed: s, wob: 0.01, step: 0.03 })],
  'L, two strokes': s => [poly([[0, 0], [0, 1.4]], { seed: s, wob: 0.01, step: 0.03 }), poly([[0, 1.4], [0.8, 1.4]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'V, one stroke': s => [poly([[0, 0], [0.5, 1.4], [1, 0]], { seed: s, wob: 0.01, step: 0.03 })],
  'V, two strokes': s => [poly([[0, 0], [0.5, 1.4]], { seed: s, wob: 0.01, step: 0.03 }), poly([[0.5, 1.4], [1, 0]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'T, two strokes': s => [poly([[0, 0], [1, 0]], { seed: s, wob: 0.01, step: 0.03 }), poly([[0.5, 0], [0.5, 1.4]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'check mark, one stroke': s => [poly([[0, 0.8], [0.35, 1.3], [1.1, 0]], { seed: s, wob: 0.01, step: 0.03 })],
  'check mark, two strokes': s => [poly([[0, 0.8], [0.35, 1.3]], { seed: s, wob: 0.01, step: 0.03 }), poly([[0.35, 1.3], [1.1, 0]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'P, one stroke': s => [curve([[0, 1.4], [0, 0.7], [0, 0.02], [0.5, 0], [0.8, 0.3], [0.5, 0.65], [0.02, 0.7]], s)],
  'P, two strokes': s => [poly([[0, 0], [0, 1.4]], { seed: s, wob: 0.01, step: 0.03 }), curve([[0, 0.02], [0.5, 0], [0.8, 0.3], [0.5, 0.65], [0.02, 0.7]], s + 1)],
  'nine, one stroke': s => [curve([[0.8, 0.35], [0.45, 0], [0.1, 0.3], [0.4, 0.65], [0.8, 0.4], [0.8, 0.9], [0.7, 1.4]], s)],
  'nine, two strokes': s => [curve([[0.8, 0.35], [0.45, 0], [0.1, 0.3], [0.4, 0.65], [0.8, 0.4]], s), poly([[0.8, 0.3], [0.75, 1.4]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'J with a dot': s => [curve([[0.7, 0.3], [0.7, 1.1], [0.4, 1.4], [0.1, 1.2]], s), poly([[0.7, 0.05], [0.72, 0.1]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'question mark': s => [curve([[0.1, 0.25], [0.5, 0], [0.85, 0.3], [0.5, 0.7], [0.5, 1.05]], s), poly([[0.5, 1.3], [0.52, 1.36]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'a loop with a tail (lasso)': s => [curve([[0.5, 0.1], [0.95, 0.4], [0.5, 0.75], [0.05, 0.4], [0.5, 0.1], [0.7, 0.8], [0.9, 1.4]], s)],
  'a C': s => [curve([[0.9, 0.1], [0.4, 0], [0, 0.7], [0.4, 1.4], [0.9, 1.3]], s)],
  'a U': s => [curve([[0, 0], [0.05, 1.1], [0.5, 1.4], [0.95, 1.1], [1, 0]], s)],
  'an S': s => [curve([[0.9, 0.1], [0.4, 0], [0.1, 0.35], [0.5, 0.7], [0.9, 1.05], [0.6, 1.4], [0.1, 1.3]], s)],
  'a long line and a dash across its middle': s => [poly([[0, 0.7], [2, 0.7]], { seed: s, wob: 0.01, step: 0.03 }), poly([[1, 0.55], [1, 0.85]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'a long line and a dash across its end (a T on its side)': s => [poly([[0, 0.7], [2, 0.7]], { seed: s, wob: 0.01, step: 0.03 }), poly([[2, 0.45], [2, 0.95]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'a long line and a short line beside its end (an equals sign)': s => [poly([[0, 0.7], [2, 0.7]], { seed: s, wob: 0.01, step: 0.03 }), poly([[1.5, 0.85], [2, 0.85]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'a long line and a short line going on from its end': s => [poly([[0, 0.7], [2, 0.7]], { seed: s, wob: 0.01, step: 0.03 }), poly([[2.05, 0.7], [2.4, 0.72]], { seed: s + 1, wob: 0.01, step: 0.03 })],
  'a curve and a dot past its end': s => [curve([[0, 0], [0.6, 0.3], [1, 1], [1.2, 1.4]], s), poly([[1.25, 1.5], [1.27, 1.55]], { seed: s + 1, wob: 0.01, step: 0.03 })],
};

const at = (strokes: PtPoint[][], x: number, y: number, size: number): PtPoint[][] => strokes.map(st => st.map(([u, v]) => [x + u * size, y + v * size] as PtPoint));

/** Every drawing at each size and place, named. Places are in the fixture page (1000 px wide from x = 100). */
export function notArrows(): NotArrow[] {
  const out: NotArrow[] = [];
  const places: Array<[string, number, number]> = [['on the table', 200, 140], ['in empty space', 600, 520], ['on the text', 140, 330]];
  let seed = 1;
  for (const [shape, make] of Object.entries(SHAPES)) {
    for (const size of [40, 120]) for (const [where, x, y] of places) out.push({ name: `${shape}, ${size} px, ${where}`, strokes: at(make(seed++), x, y, size) });
  }
  for (const k of [3, 5]) out.push({ name: `handwriting, ${k} letters`, strokes: letters(300, 520, k, { seed: k }) });
  out.push({ name: 'big handwriting on the table', strokes: letters(0, 0, 4, { seed: 9 }).map(st => st.map(([u, v]) => [200 + u * 3, 180 + v * 3] as PtPoint)) });
  out.push({ name: 'a tick on the table', strokes: [tick(250, 240)] });
  out.push({ name: 'a big tick on the table', strokes: [tick(0, 0).map(([u, v]) => [250 + u * 3, 150 + v * 3] as PtPoint)] });
  out.push({ name: 'an underline under the text', strokes: [line([110, 412], [300, 414], { bow: 0.01 })] });
  out.push({ name: 'a squiggle under the text', strokes: [wave(120, 408, 130)] });
  out.push({ name: 'a big squiggle in empty space', strokes: [wave(560, 540, 400, 12, 40)] });
  out.push({ name: 'a table sketch', strokes: tableSketch(560, 520, 380, 120, 3, 2, 20) });
  out.push({ name: 'a cross on a button', strokes: cross(268, 442, 160, 36) });
  out.push({ name: 'a big cross on the table', strokes: cross(200, 120, 400, 160) });
  return out;
}
