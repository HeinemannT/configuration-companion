// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));

import { pt, resetState } from '../state';
import { hooks } from '../marks';
import { canUndo, commitStroke, forgetGroup, resetHistory, undo } from '../ink-marks';
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
