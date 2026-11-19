import { describe, expect, it } from 'vitest';
import { fixtureScene } from './fixture';
import { box, letters, line, wave } from './strokes';
import { barsSketch, lineChartSketch, poly, roundBox, tableSketch, textLines } from './sketches';
import { GROUP_INSIDE_MS, joinsGroup, readInk } from '../ink-read';
import { isAddableWidget } from '../vocabulary';
import { WIDGET_TYPES } from '../widget-read';
import type { PtPoint } from '../types';

const scene = fixtureScene();
const read = (...strokes: PtPoint[][]) => readInk(scene, strokes.map(points => ({ points })));
/** Empty grid to the right of the buttons, in the fixture page. */
const AT = { x: 480, y: 440, w: 560 };
const kindOf = (r: ReturnType<typeof read>) => (r.meaning?.kind === 'add' ? r.meaning.widget : undefined);
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe('the widget types a sketch stands for', () => {
  it('are all in the add list', () => {
    for (const types of Object.values(WIDGET_TYPES)) for (const t of types) expect(isAddableWidget(t), t).toBe(true);
  });
});

describe('sketching a widget on empty grid', () => {
  it('a box with lines across is a table, with its width in columns and its row', () => {
    const r = read(...tableSketch(AT.x, AT.y, AT.w, 120, 4, 1, 20));
    expect(r.kind).toBe('add');
    expect(r.targets).toEqual([]);
    expect(r.meaning).toMatchObject({ kind: 'add', widget: 'table', types: ['ExtendedTable'] });
    expect(r.reading).toMatch(/^Table, about 3 columns wide, row \d+$/);
  });

  it('a table with vertical dividers is still a table; so is one whose outline is four lines', () => {
    expect(kindOf(read(...tableSketch(AT.x, AT.y, AT.w, 120, 3, 3, 21)))).toBe('table');
    const x = AT.x, y = AT.y, w = AT.w, h = 120;
    const sides = [
      line([x, y], [x + w, y + 2], { bow: 0.01, seed: 1 }), line([x + w, y], [x + w + 2, y + h], { bow: 0.01, seed: 2 }),
      line([x + w, y + h], [x, y + h - 2], { bow: 0.01, seed: 3 }), line([x, y + h], [x + 1, y], { bow: 0.01, seed: 4 }),
    ];
    const rows = [line([x + 2, y + 40], [x + w - 2, y + 41], { bow: 0.01, seed: 5 }), line([x + 2, y + 80], [x + w - 2, y + 79], { bow: 0.01, seed: 6 })];
    expect(kindOf(read(...sides, ...rows))).toBe('table');
  });

  it('a box with bars of different heights is a chart with the bar candidates', () => {
    const r = read(...barsSketch(AT.x, AT.y, 420, 140, [0.4, 0.8, 0.6, 1.0, 0.5]));
    expect(r.meaning).toMatchObject({ kind: 'add', widget: 'chart', types: ['BarChart', 'BarLineChart'] });
    expect(r.reading).toMatch(/^Chart, about \d columns? wide/);
  });

  it('a box with a rising line is a chart with the line candidates', () => {
    const r = read(...lineChartSketch(AT.x, AT.y, 420, 140));
    expect(r.meaning).toMatchObject({ kind: 'add', widget: 'chart', types: ['LineChart', 'AreaChart'] });
  });

  it('a small rounded box is a button; a sharp one stays an add here', () => {
    const r = read(roundBox(AT.x, AT.y + 6, 130, 38, 14));
    expect(r.meaning).toMatchObject({ kind: 'add', widget: 'button', types: ['ActionButton'] });
    expect(r.reading).toMatch(/^Button, about 1 column wide/);
    const sharp = read(box(AT.x, AT.y + 6, 130, 38, { seed: 3 }));
    expect(sharp.kind).toBe('add');
    expect(kindOf(sharp)).toBeUndefined();
  });

  it('a small box with a short scribble in it is a button', () => {
    const r = read(box(AT.x, AT.y + 6, 140, 40, { seed: 4 }), wave(AT.x + 30, AT.y + 26, 80, 3, 12, { seed: 4 }));
    expect(kindOf(r)).toBe('button');
  });

  it('wavy lines under each other, with no box, are text; so are they in a box with nothing else', () => {
    const lines = textLines(AT.x, AT.y + 10, [300, 280, 150]);
    const r = read(...lines);
    expect(r.meaning).toMatchObject({ widget: 'text', types: ['TextElement'] });
    const framed = [box(AT.x - 10, AT.y - 4, 340, 90, { seed: 8 }), ...lines.slice(0, 2).map((_, i) => wave(AT.x + 6, AT.y + 22 + i * 24, 280 - i * 40, 3.2, 14, { seed: 60 + i }))];
    expect(kindOf(read(...framed))).toBe('text');
  });

  it('an empty box, and a box with something unclear in it, stay an add here with no kind', () => {
    const empty = read(box(AT.x, AT.y, AT.w, 120, { seed: 5 }));
    expect(empty.kind).toBe('add');
    expect(kindOf(empty)).toBeUndefined();
    const unclear = read(box(AT.x, AT.y, AT.w, 120, { seed: 5 }), line([AT.x + 40, AT.y + 20], [AT.x + 300, AT.y + 100], { bow: 0.02 }));
    expect(unclear.kind).toBe('add');
    expect(kindOf(unclear)).toBeUndefined();
  });

  it('one line across a box is not enough for a table, and two bars are not a chart', () => {
    expect(kindOf(read(...tableSketch(AT.x, AT.y, AT.w, 120, 2, 1, 22)))).toBeUndefined();
    expect(kindOf(read(...barsSketch(AT.x, AT.y, 420, 140, [0.4, 0.9], 31)))).toBeUndefined();
  });

  it('a sketch over existing objects is not a widget', () => {
    // On the chart "By status", and around the two buttons.
    expect(kindOf(read(...tableSketch(780, 120, 300, 150, 4, 1, 23)))).toBeUndefined();
    const around = read(...tableSketch(110, 430, 340, 60, 3, 1, 24));
    expect(kindOf(around)).toBeUndefined();
  });

  it('handwriting and a lone zigzag are not widgets', () => {
    expect(read(...letters(AT.x, AT.y + 30, 5)).kind).toBe('plain');
    expect(read(poly([[AT.x, AT.y + 60], [AT.x + 60, AT.y + 10], [AT.x + 120, AT.y + 60], [AT.x + 180, AT.y + 10]])).kind).toBe('plain');
  });

  it('is read the same however the hand shakes', () => {
    const hits = { table: 0, bars: 0, line: 0, button: 0, text: 0 };
    for (const s of SEEDS) {
      const wob = 1.2 + (s % 4);
      if (kindOf(read(...tableSketch(AT.x, AT.y, AT.w, 120, 4, s % 2 ? 1 : 3, s * 11, wob))) === 'table') hits.table++;
      if (kindOf(read(...barsSketch(AT.x, AT.y, 420, 140, [0.4, 0.8, 0.6, 1.0, 0.5], s * 7, wob))) === 'chart') hits.bars++;
      if (kindOf(read(...lineChartSketch(AT.x, AT.y, 420, 140, s * 5, wob))) === 'chart') hits.line++;
      if (kindOf(read(roundBox(AT.x, AT.y + 6, 130, 38, 14, { seed: s * 3, wob }))) === 'button') hits.button++;
      if (kindOf(read(...textLines(AT.x, AT.y + 10, [300, 280, 150], 18, s * 13))) === 'text') hits.text++;
    }
    expect(hits).toEqual({ table: 8, bars: 8, line: 8, button: 8, text: 8 });
  });
});

describe('which strokes of a sketch belong together', () => {
  const group = { box: { left: 480, top: 440, width: 560, height: 120 }, endedAt: 1000 };
  it('a line drawn inside the box is still part of it after a calm pause', () => {
    expect(joinsGroup(group, { left: 500, top: 490, width: 520, height: 2 }, 1000 + 2600)).toBe(true);
    expect(joinsGroup(group, { left: 500, top: 490, width: 520, height: 2 }, 1000 + GROUP_INSIDE_MS + 100)).toBe(false);
  });
  it('a stroke next to a small group still has to start soon', () => {
    const small = { box: { left: 100, top: 100, width: 40, height: 30 }, endedAt: 1000 };
    expect(joinsGroup(small, { left: 105, top: 105, width: 10, height: 10 }, 1000 + 2600)).toBe(false);
  });
});
