// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));

import { pt, resetState } from '../state';
import { hooks } from '../marks';
import { canUndo, commitStroke, dropReading, forgetGroup, resetHistory, undo } from '../ink-marks';
import { fixtureModel, fixtureScene } from '../../lib/point-tell/__tests__/fixture';
import { box, line } from '../../lib/point-tell/__tests__/strokes';
import type { PtPoint } from '../../lib/point-tell/types';

const draw = (points: PtPoint[], at: number) => commitStroke({ stroke: { points }, raw: points, startedAt: at, endedAt: at + 400 });

beforeEach(() => {
  sessionStorage.clear();
  resetState();
  resetHistory(); forgetGroup();
  pt.rid = '111';
  pt.model = fixtureModel();
  pt.scene = fixtureScene(pt.model);
  hooks.render = vi.fn();
});

const arrow = line([160, 460], [700, 468], { hook: true, bow: 0.02, seed: 21 });
const square = box(560, 436, 380, 58, { seed: 5 });

describe('an arrow and a square drawn as two marks', () => {
  it('square first, then the arrow into it: one move that keeps both drawings', () => {
    draw(square, 0);
    expect(pt.marks.map(m => m.meaning?.kind)).toEqual(['add']);
    const made = draw(arrow, 10_000);
    expect(pt.marks).toHaveLength(1);
    expect(made?.n).toBe(1);
    expect(pt.marks[0]).toMatchObject({ n: 1, targets: ['btn_new_risk'], meaning: { kind: 'move', to: { after: 'btn_export' }, columns: 2 } });
    expect(pt.marks[0].ink?.strokes).toHaveLength(2);
    expect(pt.marks[0].reading).toBe('Move New risk after Export, about 2 columns wide');
  });

  it('arrow first, then the square: the same one move', () => {
    draw(arrow, 0);
    const made = draw(square, 10_000);
    expect(pt.marks).toHaveLength(1);
    expect(made?.n).toBe(1);
    expect(pt.marks[0].meaning).toMatchObject({ kind: 'move', columns: 2 });
    expect(pt.marks[0].ink?.strokes).toHaveLength(2);
  });

  it('one undo takes the second drawing and the pairing back together; the numbers are not reused', () => {
    draw(square, 0);
    draw(arrow, 10_000);
    expect(canUndo()).toBe(true);
    undo();
    expect(pt.marks.map(m => [m.n, m.meaning?.kind])).toEqual([[1, 'add']]);
  });

  it('a square that has words of its own is left alone', () => {
    draw(square, 0);
    pt.marks = pt.marks.map(m => ({ ...m, text: 'A risk table' }));
    draw(arrow, 10_000);
    expect(pt.marks).toHaveLength(2);
  });

  it('an arrow that ends elsewhere is not paired', () => {
    draw(square, 0);
    draw(line([160, 460], [300, 560], { hook: true, bow: 0.02 }), 10_000);
    expect(pt.marks).toHaveLength(2);
  });
});

describe('a big arrow drawn as a curved shaft and a V after a pause', () => {
  // From the table in a wide curve to empty space right of the buttons, the V (barbs of about 70 px) drawn 2.5 s after the shaft.
  const shaft: PtPoint[] = Array.from({ length: 80 }, (_, i) => { const t = i / 79; return [200 + 650 * t - 120 * Math.sin(Math.PI * t), 200 + 330 * t + 90 * Math.sin(Math.PI * t)] as PtPoint; });
  const end = shaft[shaft.length - 1], before = shaft[shaft.length - 6];
  const l = Math.hypot(end[0] - before[0], end[1] - before[1]), d: PtPoint = [(end[0] - before[0]) / l, (end[1] - before[1]) / l];
  const point: PtPoint = [end[0] + d[0] * 20, end[1] + d[1] * 20];
  const barb = (s: number): PtPoint => [point[0] - d[0] * 62 - d[1] * 34 * s, point[1] - d[1] * 62 + d[0] * 34 * s];
  const v: PtPoint[] = [barb(1), point, barb(-1)];
  const vDense = v.flatMap((p, i) => (i ? Array.from({ length: 12 }, (_, k) => [v[i - 1][0] + ((p[0] - v[i - 1][0]) * (k + 1)) / 12, v[i - 1][1] + ((p[1] - v[i - 1][1]) * (k + 1)) / 12] as PtPoint) : [p]));
  it('is one mark, read as an arrow from the table; dropping the reading drops the arrow', () => {
    draw(shaft, 0);
    expect(pt.marks).toHaveLength(1);
    draw(vDense, 2500);
    expect(pt.marks).toHaveLength(1);
    expect(pt.marks[0].ink?.strokes).toHaveLength(2);
    expect(pt.marks[0].arrow).toMatchObject({ from: 'tbl_open_risks' });
    expect(pt.marks[0].reading).toBe('Arrow from Open risks');
    dropReading(pt.marks[0].n);
    expect(pt.marks[0].arrow).toBeUndefined();
    expect(pt.marks[0].reading).toBeUndefined();
  });
});
