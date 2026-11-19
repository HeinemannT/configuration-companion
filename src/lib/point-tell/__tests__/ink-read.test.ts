import { describe, expect, it } from 'vitest';
import { fixtureScene } from './fixture';
import { box, cross, ellipse, letters, line, tick, wave, zigzag } from './strokes';
import { analyze } from '../ink-features';
import { joinsGroup, readInk, GROUP_MS } from '../ink-read';
import type { PtPoint } from '../types';

const scene = fixtureScene();
const read = (...strokes: PtPoint[][]) => readInk(scene, strokes.map(points => ({ points })));

describe('reading one stroke', () => {
  it('a loop around two buttons: they are the targets', () => {
    const r = read(ellipse(266, 460, 190, 40));
    expect(r.kind).toBe('select');
    expect(r.targets.sort()).toEqual(['btn_export', 'btn_new_risk']);
    expect(r.reading).toBe('2 objects');
    expect(r.meaning).toBeUndefined();
  });

  it('a loop around one object names it', () => {
    const r = read(ellipse(933, 200, 185, 130));
    expect(r.kind).toBe('select');
    expect(r.targets).toEqual(['chart_by_status']);
    expect(r.reading).toBe('By status');
  });

  it('a line from an object to a place beside another is a move, with the place from the layout', () => {
    const r = read(line([330, 460], [120, 458], { hook: true, bow: 0.08 }));
    expect(r.kind).toBe('move');
    expect(r.targets).toEqual(['btn_export']);
    expect(r.meaning).toMatchObject({ kind: 'move', to: { before: 'btn_new_risk' } });
    expect(r.reading).toBe('Move Export before New risk');
  });

  it('a line from an object to a tab pill moves it into that tab', () => {
    const r = read(line([180, 460], [232, 68], { hook: true, bow: 0.06 }));
    expect(r.kind).toBe('move');
    expect(r.meaning).toMatchObject({ kind: 'move', to: { into: 'tab_details' } });
  });

  it('a rough box on empty grid is an add, in grid words', () => {
    const r = read(box(560, 436, 380, 58));
    expect(r.kind).toBe('add');
    expect(r.targets).toEqual([]);
    expect(r.meaning?.kind).toBe('add');
    expect(r.reading).toMatch(/^Add in row \d+, columns? \d/);
  });

  it('a scratch-out over an object is crossed out, never a delete', () => {
    const r = read(zigzag(790, 130, 260, 150, 6));
    expect(r.kind).toBe('crossed');
    expect(r.meaning).toEqual({ kind: 'crossed' });
    expect(r.targets).toEqual(['chart_by_status']);
    expect(r.reading).toBe('Crossed out By status');
  });

  it('an underline under an object is a change, also when it starts on that object', () => {
    const r = read(line([110, 292], [300, 294], { bow: 0 }));
    expect(r.kind).toBe('change');
    expect(r.targets).toEqual(['tbl_open_risks']);
    const q = read(line([110, 412], [300, 414], { bow: 0.01 }));
    expect(q.kind).toBe('change');
    expect(q.targets).toEqual(['txt_info']);
  });

  it('a squiggle under an object is a change too', () => {
    const r = read(wave(120, 408, 130));
    expect(r.kind).toBe('change');
    expect(r.targets).toEqual(['txt_info']);
    expect(r.reading).toBe('Change Info');
  });

  it('anything else is plain ink with the objects it touches', () => {
    const r = read(tick(250, 240));
    expect(r.kind).toBe('plain');
    expect(r.meaning).toBeUndefined();
    expect(r.reading).toBeUndefined();
    expect(r.targets).toContain('tbl_open_risks');
    expect(r.place.over).toContain('tbl_open_risks');
  });

  it('a line from nowhere, a short line and a tap stay plain', () => {
    expect(read(line([600, 560], [800, 580], { hook: true })).kind).toBe('plain');
    expect(read(line([150, 450], [185, 478], { bow: 0 })).kind).toBe('plain');
    expect(read([[300, 460], [302, 461]]).kind).toBe('plain');
  });

  it('a scribble that covers no object is not crossed out', () => {
    expect(read(zigzag(300, 560, 60, 30, 5)).kind).toBe('plain');
  });

  it('never throws on rubbish', () => {
    expect(readInk(scene, []).kind).toBe('plain');
    expect(readInk(scene, [{ points: [] }]).kind).toBe('plain');
    expect(readInk(scene, [{ points: [[Number.NaN, 5], [3, Number.NaN]] }]).kind).toBe('plain');
  });
});

describe('reading a group of strokes', () => {
  it('two strokes that cross over an object are crossed out', () => {
    const [a, b] = cross(268, 442, 160, 36);
    const r = read(a, b);
    expect(r.kind).toBe('crossed');
    expect(r.targets).toEqual(['btn_export']);
  });

  it('two strokes that cross over nothing are plain', () => {
    const [a, b] = cross(600, 540, 60, 40);
    expect(read(a, b).kind).toBe('plain');
  });

  it('an arrow drawn with a separate head is still a move', () => {
    const shaft = line([330, 460], [130, 458], { bow: 0.05, seed: 11 });
    const head = line([150, 448], [128, 458], { bow: 0, n: 6, seed: 12 });
    const r = read(shaft, head);
    expect(r.kind).toBe('move');
    expect(r.targets).toEqual(['btn_export']);
  });

  it('handwriting is plain ink, however many strokes', () => {
    const r = read(...letters(300, 520, 5));
    expect(r.kind).toBe('plain');
    expect(r.meaning).toBeUndefined();
  });
});

describe('features', () => {
  it('tells an arrow, a loop and a flat line apart', () => {
    expect(analyze(line([0, 0], [200, 10], { hook: true })).arrowish).toBe(true);
    expect(analyze(ellipse(100, 100, 60, 40)).closed).toBe(true);
    expect(analyze(wave(0, 0, 120)).flat).toBe(true);
    expect(analyze(zigzag(0, 0, 100, 80, 6)).scribble).toBe(true);
  });
});

describe('which strokes belong together', () => {
  const box0 = { left: 100, top: 100, width: 40, height: 30 };
  it('close in time and in space', () => {
    expect(joinsGroup({ box: box0, endedAt: 1000 }, { left: 150, top: 105, width: 30, height: 30 }, 1000 + 400)).toBe(true);
  });
  it('not after the window, not far away', () => {
    expect(joinsGroup({ box: box0, endedAt: 1000 }, { left: 150, top: 105, width: 30, height: 30 }, 1000 + GROUP_MS + 50)).toBe(false);
    expect(joinsGroup({ box: box0, endedAt: 1000 }, { left: 400, top: 105, width: 30, height: 30 }, 1100)).toBe(false);
  });
});

describe('an arrow with separate head strokes', () => {
  it('reads as one move however many head strokes', () => {
    const shaft = line([330, 460], [130, 458], { bow: 0.05, seed: 11 });
    const h1 = line([150, 448], [128, 458], { bow: 0, n: 6, seed: 12 });
    const h2 = line([150, 470], [128, 458], { bow: 0, n: 6, seed: 13 });
    expect(read(shaft, h1, h2).kind).toBe('move');
  });
  it('a word of six strokes stays plain', () => {
    expect(read(...letters(300, 520, 5), line([420, 515], [421, 530], { bow: 0, n: 5 })).kind).toBe('plain');
  });
});

describe('a squiggle is never an arrow', () => {
  it('a wave over the middle of an object is plain, not a move', () => {
    const r = read(wave(120, 150, 140, 6, 22));
    expect(r.kind).toBe('plain');
  });
});
