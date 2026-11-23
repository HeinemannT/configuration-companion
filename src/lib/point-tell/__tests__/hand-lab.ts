/**
 * The labs behind ink-hand.test.ts: each lab is a name, a seeded list of drawn cases and the lowest rate
 * the reader may reach. A case is strokes plus what the reader must say about them.
 */
import { analyze } from '../ink-features';
import { arrowOf } from '../gestures';
import { readInk, type InkReading } from '../ink-read';
import type { PtScene } from '../resolve';
import type { PtPoint } from '../types';
import { fixtureScene } from './fixture';
import { arrow, between, circle, circleTwo, cross, CIRCLE_STYLES, HEAD_STYLES, REAL_HEADS, pen, dense, pick, type CircleStyle, type CrossStyle, type Rnd } from './hand';
import { box, letters, line, rng, wave, zigzag } from './strokes';
import { barsSketch, tableSketch, textLines } from './sketches';

/** The reader a lab runs against; the tests use the real one, a comparison can pass another. */
export interface Impl { readInk: typeof readInk; analyze: typeof analyze }
export const REAL: Impl = { readInk, analyze };
export interface Case { strokes: PtPoint[][]; ok: (scene: PtScene, impl?: Impl) => boolean }
export type Lab = [name: string, make: (n: number) => Case[], min: number];

const cases = (n: number, f: (r: Rnd, i: number) => Omit<Case, 'ok'> & { want: (r: InkReading, impl: Impl) => boolean }): Case[] =>
  Array.from({ length: n }, (_, i) => {
    const c = f(rng(1000 + i * 7919), i);
    return { strokes: c.strokes, ok: (scene: PtScene, impl: Impl = REAL) => c.want(impl.readInk(scene, c.strokes.map(points => ({ points }))), impl) };
  });

const sc = fixtureScene();
const rectOf = (id: string) => sc.targets.find(t => t.id === id)?.rect ?? sc.pills.find(t => t.id === id)!.rect;
const inRect = (r: Rnd, rc: { left: number; top: number; width: number; height: number }, m = 0.15): PtPoint =>
  [between(r, rc.left + rc.width * m, rc.left + rc.width * (1 - m)), between(r, rc.top + rc.height * m, rc.top + rc.height * (1 - m))];
const only = (id: string) => (x: InkReading) => x.kind === 'select' && x.targets.length === 1 && x.targets[0] === id;

// ── Circles ─────────────────────────────────────────────────────────────────────────────────────

/** A loop around a rectangle: loose, off centre, a little squashed. */
function loopAround(r: Rnd, rc: { left: number; top: number; width: number; height: number }, style: CircleStyle): PtPoint[] {
  const cx = rc.left + rc.width / 2 + between(r, -0.06, 0.06) * rc.width, cy = rc.top + rc.height / 2 + between(r, -0.1, 0.1) * rc.height;
  const k = between(r, 1.15, 1.5);
  return circle(cx, cy, Math.max(rc.width * 0.5 * k * 1.1, 14), rc.height * 0.5 * k * 1.2 + 10, style, r);
}

const CIRCLE: Lab[] = [];
for (const style of CIRCLE_STYLES) {
  CIRCLE.push([`closed, ${style}, 20-400 px`, n => cases(n, r => {
    const size = Math.exp(between(r, Math.log(10), Math.log(200))), ry = size * between(r, 0.5, 1);
    const s = [circle(500, 500, size, ry, style, r)];
    return { strokes: s, want: (_x, impl) => impl.analyze(s[0]).closed };
  }), style === 'double-hook' ? 0.88 : 0.97]);
  CIRCLE.push([`select button, ${style}`, n => cases(n, r => ({ strokes: [loopAround(r, rectOf('btn_export'), style)], want: only('btn_export') })), 0.97]);
}
CIRCLE.push(['select chart, all styles', n => cases(n, r => ({ strokes: [loopAround(r, rectOf('chart_by_status'), pick(r, CIRCLE_STYLES))], want: only('chart_by_status') })), 0.97]);
CIRCLE.push(['select button, drawn in two strokes', n => cases(n, r => {
  const rc = rectOf('btn_export');
  return { strokes: circleTwo(rc.left + rc.width / 2, rc.top + rc.height / 2, rc.width * 0.72, rc.height * 1.1 + 12, r), want: only('btn_export') };
}), 0.85]);
CIRCLE.push(['select table cell area (loop inside one object)', n => cases(n, r => {
  const c = inRect(r, rectOf('tbl_open_risks'), 0.25), rad = between(r, 25, 60);
  return { strokes: [circle(c[0], c[1], rad * 1.3, rad, pick(r, CIRCLE_STYLES), r)], want: x => x.kind === 'select' && x.targets[0] === 'tbl_open_risks' };
}), 0.97]);
CIRCLE.push(['loop around two buttons, all styles', n => cases(n, r => {
  const a = rectOf('btn_new_risk'), b = rectOf('btn_export');
  const rc = { left: a.left, top: a.top, width: b.left + b.width - a.left, height: a.height };
  return { strokes: [loopAround(r, rc, pick(r, CIRCLE_STYLES))], want: x => x.kind === 'select' && x.targets.length === 2 };
}), 0.97]);

// ── Arrows ──────────────────────────────────────────────────────────────────────────────────────

const ARROWS: Lab[] = [];
for (const head of HEAD_STYLES) {
  ARROWS.push([`pointer onto a button, ${head}`, n => cases(n, r => {
    const tip = inRect(r, rectOf('btn_export'), 0.2), tail: PtPoint = [tip[0] + between(r, 80, 350), tip[1] + between(r, 50, 160)];
    const s = arrow(tail, tip, r, { head });
    return { strokes: s, want: x => (head === 'line' || x.kind === 'select') && x.kind === 'select' && x.targets[0] === 'btn_export' && x.pointer === true };
  }), 0.88]);
  ARROWS.push([`pointer onto the chart from the left of it, ${head}`, n => cases(n, r => {
    const tip = inRect(r, rectOf('chart_by_status'), 0.3), tail: PtPoint = [1150 + between(r, 0, 100), tip[1] + between(r, 120, 260)];
    return { strokes: arrow(tail, tip, r, { head }), want: x => x.kind === 'select' && x.targets[0] === 'chart_by_status' };
  }), 0.88]);
  ARROWS.push([`move: button to before another, ${head}`, n => cases(n, r => {
    const tail = inRect(r, rectOf('btn_export'), 0.2), tip: PtPoint = [between(r, 108, 150), between(r, 448, 472)];
    return { strokes: arrow(tail, tip, r, { head }), want: x => x.kind === 'move' && x.targets[0] === 'btn_export' };
  }), 0.88]);
  ARROWS.push([`move: button into a tab, ${head}`, n => cases(n, r => {
    const tail = inRect(r, rectOf('btn_export'), 0.2), tip = inRect(r, rectOf('tab_details'), 0.25);
    return { strokes: arrow(tail, tip, r, { head }), want: x => x.kind === 'move' && x.targets[0] === 'btn_export' && x.meaning?.kind === 'move' };
  }), 0.88]);
  ARROWS.push([`move: button into a drawn square, ${head}`, n => cases(n, r => {
    const tail = inRect(r, rectOf('btn_new_risk'), 0.2), tip: PtPoint = [between(r, 620, 860), between(r, 450, 480)];
    const sq = box(560, 436, 380, 58, { seed: 1 + Math.floor(r() * 50) });
    const a = arrow(tail, tip, r, { head });
    return { strokes: r() < 0.5 ? [...a, sq] : [sq, ...a], want: x => x.kind === 'move' && x.targets[0] === 'btn_new_risk' && x.meaning?.kind === 'move' && x.meaning.columns !== undefined };
  }), 0.88]);
}
ARROWS.push(['a short arrow (60-100 px) onto a button', n => cases(n, r => {
  const tip = inRect(r, rectOf('btn_export'), 0.25), a = between(r, 0, 6.28), l = between(r, 60, 100);
  return { strokes: arrow([tip[0] + Math.cos(a) * l, tip[1] + 30 + Math.abs(Math.sin(a)) * l], tip, r, { head: pick(r, REAL_HEADS) }), want: x => x.kind === 'select' && x.targets[0] === 'btn_export' };
}), 0.8]);
ARROWS.push(['the tip is the arrow point (within 14 px), every head', n => cases(n, r => {
  const head = pick(r, REAL_HEADS), tail = inRect(r, rectOf('btn_export'), 0.2);
  const tip: PtPoint = [between(r, 520, 900), between(r, 520, 640)];
  const s = arrow(tail, tip, r, { head });
  return { strokes: s, want: () => {
    const ends = arrowOf(sc, s.map(points => ({ points })));
    return !!ends && Math.hypot(ends.tip[0] - tip[0], ends.tip[1] - tip[1]) <= 14 && ends.from.id === 'btn_export';
  } };
}), 0.88]);

// ── Crosses ─────────────────────────────────────────────────────────────────────────────────────

const X_STYLES: readonly CrossStyle[] = ['two', 'curved', 'lopsided', 'one'];
const crossOn = (id: string, wf: [number, number], hf: [number, number], abs = false): ((r: Rnd) => PtPoint[][]) => r => {
  const rc = rectOf(id), w = abs ? between(r, wf[0], wf[1]) : rc.width * between(r, wf[0], wf[1]), h = abs ? between(r, hf[0], hf[1]) : rc.height * between(r, hf[0], hf[1]);
  const c = [rc.left + rc.width / 2 + between(r, -0.04, 0.04) * rc.width, rc.top + rc.height / 2 + between(r, -0.05, 0.05) * rc.height];
  return cross(c[0], c[1], w, h, pick(r, X_STYLES), r);
};
const crossedOn = (id: string) => (x: InkReading) => x.kind === 'crossed' && x.targets[0] === id;

const CROSSES: Lab[] = [];
for (const style of ['two', 'curved', 'lopsided', 'one', 'plus'] as CrossStyle[]) {
  CROSSES.push([`X over a button, ${style}`, n => cases(n, r => {
    const rc = rectOf('btn_export');
    return { strokes: cross(rc.left + rc.width / 2, rc.top + rc.height / 2, rc.width * between(r, 0.6, 0.95), rc.height * between(r, 0.65, 0.95), style, r), want: crossedOn('btn_export') };
  }), 0.9]);
  CROSSES.push([`X over the chart, ${style}`, n => cases(n, r => {
    const rc = rectOf('chart_by_status');
    return { strokes: cross(rc.left + rc.width / 2, rc.top + rc.height / 2, rc.width * between(r, 0.5, 0.9), rc.height * between(r, 0.5, 0.9), style, r), want: crossedOn('chart_by_status') };
  }), 0.9]);
}
CROSSES.push(['small X on a button (30-60 px)', n => cases(n, r => ({ strokes: crossOn('btn_export', [30, 60], [26, 36], true)(r), want: crossedOn('btn_export') })), 0.9]);
CROSSES.push(['small X on a big text widget (50-90 px)', n => cases(n, r => ({ strokes: crossOn('txt_info', [50, 90], [40, 70], true)(r), want: crossedOn('txt_info') })), 0.9]);
CROSSES.push(['small X on a table (60-100 px)', n => cases(n, r => ({ strokes: crossOn('tbl_open_risks', [60, 100], [50, 90], true)(r), want: crossedOn('tbl_open_risks') })), 0.9]);
CROSSES.push(['X on a tab pill', n => cases(n, r => ({ strokes: crossOn('tab_details', [26, 60], [22, 30], true)(r), want: x => x.kind === 'crossed' && x.targets[0] === 'tab_details' })), 0.9]);
CROSSES.push(['X wider than its button (overshoot)', n => cases(n, r => {
  const rc = rectOf('btn_export');
  return { strokes: cross(rc.left + rc.width / 2, rc.top + rc.height / 2, rc.width * between(r, 1.05, 1.3), rc.height * between(r, 1.4, 2), pick(r, ['two', 'curved', 'one'] as CrossStyle[]), r), want: crossedOn('btn_export') };
}), 0.9]);
CROSSES.push(['the two strokes drawn far apart in time are still one X (shape only)', n => cases(n, r => {
  const rc = rectOf('btn_export');
  return { strokes: cross(rc.left + rc.width / 2, rc.top + rc.height / 2, rc.width * 0.8, rc.height * 0.8, 'two', r), want: crossedOn('btn_export') };
}), 0.9]);

// ── What must not change ────────────────────────────────────────────────────────────────────────

const plainAnd = (x: InkReading) => x.kind === 'plain';
const FALSE: Lab[] = [
  ['handwriting stays plain', n => cases(n, (r, i) => ({ strokes: letters(300 + i, 520, 3 + Math.floor(r() * 4), { seed: i + 1 }), want: plainAnd })), 1],
  ['a tiny x (12-20 px) on a button stays plain', n => cases(n, r => ({ strokes: crossOn('btn_export', [12, 20], [12, 18], true)(r), want: plainAnd })), 0.97],
  ['a small x beside handwriting stays plain', n => cases(n, (r, i) => {
    const w = letters(300, 520, 4, { seed: i + 1 }), x = cross(300 + 4 * 16 + 20, 520, between(r, 12, 20), between(r, 12, 20), 'two', r);
    return { strokes: [...w, ...x], want: plainAnd };
  }), 1],
  ['a circle in empty space is no select, move or cross', n => cases(n, r => ({ strokes: [circle(800, 580, between(r, 20, 60), between(r, 20, 50), pick(r, CIRCLE_STYLES), r)], want: x => x.kind === 'plain' || x.kind === 'add' })), 1],
  ['V, T and L from two strokes over a button are not crossed', n => cases(n, r => {
    const rc = rectOf('btn_export'), x = rc.left + rc.width / 2, y = rc.top + rc.height / 2, w = between(r, 40, 100), h = between(r, 20, 36);
    const kind = pick(r, ['V', 'T', 'L']);
    const P = (p: PtPoint[]) => pen(dense(p), r, { step: between(r, 4, 12) });
    const s = kind === 'V' ? [P([[x - w / 2, y - h / 2], [x, y + h / 2]]), P([[x, y + h / 2], [x + w / 2, y - h / 2]])]
      : kind === 'T' ? [P([[x - w / 2, y - h / 2], [x + w / 2, y - h / 2]]), P([[x, y - h / 2], [x, y + h / 2]])]
        : [P([[x - w / 2, y - h / 2], [x - w / 2, y + h / 2]]), P([[x - w / 2, y + h / 2], [x + w / 2, y + h / 2]])];
    return { strokes: s, want: x2 => x2.kind !== 'crossed' && x2.kind !== 'select' };
  }), 1],
  ['a squiggle under text stays a change', n => cases(n, (r, i) => ({ strokes: [wave(120 + (i % 5), 408, between(r, 100, 160), between(r, 3, 5), between(r, 12, 16), { seed: i })], want: x => x.kind === 'change' && x.targets[0] === 'txt_info' })), 1],
  ['an underline stays a change', n => cases(n, (r, i) => ({ strokes: [line([110, 412 + between(r, -3, 3)], [110 + between(r, 150, 330), 414], { bow: 0.01, seed: i + 1 })], want: x => x.kind === 'change' && x.targets[0] === 'txt_info' })), 1],
  ['a scratch-out over the chart stays crossed', n => cases(n, (r, i) => ({ strokes: [zigzag(790, 130, between(r, 240, 280), between(r, 130, 160), 6, { seed: i + 1 })], want: crossedOn('chart_by_status') })), 1],
  ['a wave over an object is not a move', n => cases(n, (r, i) => ({ strokes: [wave(120, 150, between(r, 100, 180), between(r, 4, 8), between(r, 16, 26), { seed: i + 3 })], want: x => x.kind !== 'move' && x.kind !== 'crossed' })), 1],
  ['a line from nowhere to nowhere stays plain', n => cases(n, r => ({ strokes: arrow([600, 560], [between(r, 760, 900), between(r, 560, 620)], r, { head: pick(r, HEAD_STYLES) }), want: plainAnd })), 1],
  ['table, bars and text sketches stay adds', n => cases(Math.min(n, 30), (r, i) => {
    const k = i % 3;
    const s = k === 0 ? tableSketch(560, 520, 380, 120, 3, 2, 20 + i) : k === 1 ? barsSketch(560, 520, 300, 140, [0.5, 0.8, 0.3, 0.9], 30 + i) : textLines(560, 520, [200, 160, 180], 18, 50 + i);
    return { strokes: s, want: x => x.kind === 'add' || x.kind === 'plain' };
  }), 1],
  ['a zigzag in empty space is plain', n => cases(n, (r, i) => ({ strokes: [zigzag(300, 560, between(r, 50, 120), between(r, 30, 60), 6, { seed: i + 1 })], want: plainAnd })), 1],
  ['a rough box on empty grid is an add', n => cases(n, (r, i) => ({ strokes: [box(560, 436, between(r, 300, 400), between(r, 50, 70), { seed: i + 1 })], want: x => x.kind === 'add' })), 1],
];

export const CIRCLE_LAB = CIRCLE, ARROW_LAB = ARROWS, CROSS_LAB = CROSSES, FALSE_LAB = FALSE;
