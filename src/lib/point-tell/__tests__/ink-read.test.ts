import { describe, expect, it } from 'vitest';
import { fixtureScene } from './fixture';
import { arrowOf } from '../gestures';
import { arrow, circle, circleTwo, cross as handCross } from './hand';
import { box, cross, ellipse, letters, line, rng, tick, wave, zigzag } from './strokes';
import { poly } from './sketches';
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

describe('a loop as a hand draws it', () => {
  const around = (...hooks: Array<'overshoot' | 'gap' | 'hook' | 'double-hook' | 'spiral' | 'kink'>) => hooks.map(style => read(circle(349, 460, 120, 46, style, rng(5))));
  it('overshooting, short of closing, hooked at the ends, spiralling: still a loop around the button', () => {
    for (const r of around('overshoot', 'gap', 'hook', 'double-hook', 'spiral', 'kink')) {
      expect(r.kind).toBe('select');
      expect(r.targets).toEqual(['btn_export']);
    }
  });
  it('a loop drawn as two arcs is one loop', () => {
    const r = read(...circleTwo(349, 460, 120, 46, rng(7)));
    expect(r.kind).toBe('select');
    expect(r.targets).toEqual(['btn_export']);
  });
  it('two arcs that do not meet are not a loop', () => {
    const a = circleTwo(349, 460, 120, 46, rng(7));
    expect(read(a[0], a[1].map(([x, y]) => [x + 300, y + 120] as PtPoint)).kind).toBe('plain');
  });
  it('a figure seven or a V is no loop', () => {
    expect(analyze(poly([[300, 350], [400, 350], [333, 400]])).closed).toBe(false);
    expect(analyze(poly([[300, 350], [350, 420], [400, 350]])).closed).toBe(false);
  });
});

describe('an arrow as a hand draws it', () => {
  const from = (): PtPoint => [330, 460];
  const heads = ['hook', 'w', 'triangle', 'v', 'two', 'first', 'chevron'] as const;
  it('every head style moves the object it starts on', () => {
    for (const head of heads) {
      const r = read(...arrow(from(), [130, 458], rng(3), { head, bow: 0.04 }));
      expect(r.kind, head).toBe('move');
      expect(r.targets, head).toEqual(['btn_export']);
    }
  });
  it('every head style points at the object it ends on, from empty space', () => {
    for (const head of heads) {
      const r = read(...arrow([700, 580], [352, 462], rng(4), { head, bow: -0.05 }));
      expect(r.kind, head).toBe('select');
      expect(r.targets, head).toEqual(['btn_export']);
      expect(r.pointer, head).toBe(true);
    }
  });
  it('the tip is the point of the head, not the end of a barb', () => {
    for (const head of heads) {
      const ends = arrowOf(scene, arrow(from(), [700, 560], rng(9), { head }).map(points => ({ points })));
      expect(ends?.from.id, head).toBe('btn_export');
      expect(Math.hypot(ends!.tip[0] - 700, ends!.tip[1] - 560), head).toBeLessThanOrEqual(14);
    }
  });
  it('a head drawn first, with the shaft then drawn from its tail, still reads in that direction', () => {
    const [v, shaft] = arrow(from(), [130, 458], rng(3), { head: 'first', bow: 0 });
    const r = read(v, shaft);
    expect(r.kind).toBe('move');
    expect(r.meaning).toMatchObject({ kind: 'move', to: { before: 'btn_new_risk' } });
  });
  it('an arrow with a head into a drawn square is still the pair', () => {
    for (const head of heads) {
      const r = read(...arrow([200, 460], [700, 468], rng(2), { head, bow: 0.02 }), box(560, 436, 380, 58, { seed: 5 }));
      expect(r.kind, head).toBe('move');
      expect(r.targets, head).toEqual(['btn_new_risk']);
      expect(r.meaning, head).toMatchObject({ kind: 'move', columns: 2 });
    }
  });
  it('a W of strokes at the end of a squiggle is no arrow', () => {
    expect(read(wave(120, 150, 150, 6, 22), ...letters(300, 520, 2)).kind).toBe('plain');
  });
  it('a seven and a hooked letter L are no arrow', () => {
    expect(read(poly([[300, 540], [400, 540], [330, 580]])).kind).toBe('plain');
    expect(read(poly([[600, 500], [600, 590], [640, 590]])).kind).toBe('plain');
  });
});

describe('an X as a hand draws it', () => {
  const x = (style: 'two' | 'curved' | 'lopsided' | 'one', cx: number, cy: number, w: number, h: number) => handCross(cx, cy, w, h, style, rng(11));
  it('two strokes, curved strokes, off-centre strokes and one stroke over a button', () => {
    for (const style of ['two', 'curved', 'lopsided', 'one'] as const) {
      const r = read(...x(style, 349, 460, 130, 30));
      expect(r.kind, style).toBe('crossed');
      expect(r.targets, style).toEqual(['btn_export']);
    }
  });
  it('a small X on a big widget, a table and a tab', () => {
    expect(read(...x('two', 350, 370, 70, 50)).targets).toEqual(['txt_info']);
    expect(read(...x('two', 400, 200, 80, 70)).targets).toEqual(['tbl_open_risks']);
    expect(read(...x('two', 140, 65, 36, 24)).targets).toEqual(['tab_overview']);
  });
  it('an X bigger than its button', () => {
    const r = read(...x('two', 349, 460, 200, 80));
    expect(r.kind).toBe('crossed');
    expect(r.targets).toEqual(['btn_export']);
  });
  it('a tiny x, a plus on a widget, a V, a T and an L are not crossed out', () => {
    expect(read(...x('two', 349, 460, 16, 14)).kind).toBe('plain');
    expect(read(...handCross(350, 370, 70, 50, 'plus', rng(2))).kind).toBe('plain');
    const P = (...v: PtPoint[]) => poly(v, { seed: 3 });
    expect(read(P([300, 440], [349, 478]), P([349, 478], [398, 440])).kind).not.toBe('crossed');
    expect(read(P([300, 445], [400, 445]), P([350, 445], [350, 478])).kind).not.toBe('crossed');
    expect(read(P([310, 440], [310, 478]), P([310, 478], [400, 478])).kind).not.toBe('crossed');
  });
  it('a tick with an underline is not an X', () => {
    expect(read(tick(300, 430), line([296, 480], [350, 480], { bow: 0, seed: 4 })).kind).not.toBe('crossed');
  });
});

describe('which strokes belong together: arrows and crosses', () => {
  it('the head of an arrow drawn after a pause, touching the line, joins it', () => {
    const shaft = { left: 130, top: 455, width: 200, height: 8 };
    const head = { left: 126, top: 446, width: 26, height: 26 };
    expect(joinsGroup({ box: shaft, endedAt: 1000 }, head, 1000 + 2800)).toBe(true);
    expect(joinsGroup({ box: shaft, endedAt: 1000 }, head, 1000 + 4200)).toBe(false);
  });
  it('a small stroke that does not touch the line waits no longer than usual', () => {
    const shaft = { left: 130, top: 455, width: 200, height: 8 };
    expect(joinsGroup({ box: shaft, endedAt: 1000 }, { left: 300, top: 500, width: 20, height: 20 }, 1000 + 2800)).toBe(false);
  });
  it('the second stroke of an X on a flat button joins after a pause', () => {
    const first = { left: 268, top: 442, width: 160, height: 36 };
    const second = { left: 268, top: 442, width: 160, height: 36 };
    expect(joinsGroup({ box: first, endedAt: 1000 }, second, 1000 + 3000)).toBe(true);
  });
});
