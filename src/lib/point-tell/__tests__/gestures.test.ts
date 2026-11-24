import { describe, expect, it } from 'vitest';
import { fixtureScene } from './fixture';
import { box, ellipse, line, wave } from './strokes';
import { analyze } from '../ink-features';
import { arrowOf, pairMove, pointerTarget, struckThrough } from '../gestures';
import { readInk } from '../ink-read';
import type { PtPoint } from '../types';

const scene = fixtureScene();
const read = (...strokes: PtPoint[][]) => readInk(scene, strokes.map(points => ({ points })));
const strokes = (...s: PtPoint[][]) => s.map(points => ({ points }));

describe('crossed out', () => {
  it('a straight line across an object, both ends on it', () => {
    const r = read(line([272, 460], [426, 461], { bow: 0 }));
    expect(r.kind).toBe('crossed');
    expect(r.targets).toEqual(['btn_export']);
    expect(r.reading).toBe('Crossed out Export');
    expect(r.meaning).toEqual({ kind: 'crossed' });
  });

  it('a diagonal slash across a wide object', () => {
    expect(struckThrough(scene, analyze(line([110, 322], [590, 418], { bow: 0 })))).toBe('txt_info');
  });

  it('a short line, an underline and a line that leaves the object are not struck through', () => {
    expect(struckThrough(scene, analyze(line([150, 450], [185, 478], { bow: 0 })))).toBeNull();
    expect(read(line([110, 412], [300, 414], { bow: 0.01 })).kind).toBe('change');
    expect(struckThrough(scene, analyze(line([280, 460], [600, 462], { bow: 0 })))).toBeNull();
  });

  it('a wavy line is a change, not crossed out', () => {
    expect(read(wave(120, 408, 130)).kind).toBe('change');
  });
});

describe('a pointer', () => {
  it('an arrow from empty space onto an object is about that object, like a loop', () => {
    const r = read(line([700, 580], [352, 462], { hook: true, bow: 0.05 }));
    expect(r.kind).toBe('select');
    expect(r.targets).toEqual(['btn_export']);
    expect(r.reading).toBe('Export');
    expect(r.meaning).toBeUndefined();
  });

  it('an arrow that starts on an object is still a move, and one on empty space is an arrow with no operation', () => {
    expect(read(line([330, 460], [120, 458], { hook: true, bow: 0.08 })).kind).toBe('move');
    const empty = read(line([700, 580], [900, 590], { hook: true }));
    expect(empty.kind).toBe('arrow');
    expect(empty.targets).toEqual([]);
    expect(empty.meaning).toBeUndefined();
    expect(empty.reading).toBe('Arrow');
    expect(read(line([700, 580], [900, 590])).kind).toBe('plain');
    expect(pointerTarget(scene, analyze(line([700, 580], [900, 590], { hook: true })))).toBeNull();
  });
});

describe('an arrow into a square', () => {
  const arrow = line([160, 460], [700, 468], { hook: true, bow: 0.02, seed: 21 });
  const square = box(560, 436, 380, 58, { seed: 5 });

  it('one mark made of both: move that object there, at the square\'s width', () => {
    for (const order of [[arrow, square], [square, arrow]]) {
      const r = read(...order);
      expect(r.kind).toBe('move');
      expect(r.targets).toEqual(['btn_new_risk']);
      expect(r.meaning).toMatchObject({ kind: 'move', to: { after: 'btn_export' }, columns: 2 });
      expect(r.reading).toBe('Move New risk after Export, about 2 columns wide');
    }
  });

  it('a sketched widget as the square works the same: the kind does not matter to a move', () => {
    const r = read(arrow, box(560, 436, 380, 58, { seed: 9 }), line([570, 465], [930, 466], { bow: 0, n: 20 }));
    expect(r.kind).toBe('move');
    expect(r.targets).toEqual(['btn_new_risk']);
  });

  it('the pieces can be put together after the fact: the arrow alone, the square alone', () => {
    const ends = arrowOf(scene, strokes(arrow));
    expect(ends?.from.id).toBe('btn_new_risk');
    const sq = strokes(square);
    const paired = pairMove(scene, ends!, readInk(scene, sq), sq);
    expect(paired?.meaning).toMatchObject({ kind: 'move', columns: 2 });
  });

  it('an arrow that ends outside the square is a move of its own, and the square an add', () => {
    expect(pairMove(scene, { from: { id: 'btn_new_risk', kind: 'widget', rect: { left: 100, top: 440, width: 166, height: 40 } }, tip: [300, 560] }, readInk(scene, strokes(square)), strokes(square))).toBeNull();
    const r = read(line([160, 460], [700, 540], { hook: true, bow: 0.02 }), square);
    expect(r.kind).not.toBe('move');
  });

  it('a loop is not a square: an arrow ending in a loop around objects pairs with nothing', () => {
    const lp = strokes(ellipse(266, 460, 190, 40));
    const ends = arrowOf(scene, strokes(line([700, 580], [352, 462], { bow: 0.05 })));
    expect(ends).toBeNull();
    expect(pairMove(scene, { from: { id: 'btn_new_risk', kind: 'widget', rect: { left: 100, top: 440, width: 166, height: 40 } }, tip: [266, 460] }, readInk(scene, lp), lp)).toBeNull();
  });

  it('an object that is already there is not moved', () => {
    const ends = arrowOf(scene, strokes(line([330, 460], [700, 468], { hook: true, bow: 0.02 })));
    expect(ends?.from.id).toBe('btn_export');
    const sq = strokes(square);
    expect(pairMove(scene, ends!, readInk(scene, sq), sq)).toBeNull();
  });
});
