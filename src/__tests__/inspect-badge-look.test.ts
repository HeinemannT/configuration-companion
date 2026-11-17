/**
 * Inspect mode outlines and badges (owner's picks 2a, 2b, 3, 4, 6):
 *  - 2a tick colour readable on white for every type colour;
 *  - 2b the left anchor: nested badges on one rail, a badge above a
 *    clipping host pulled inside, fit tiles keep the anchor, controls at
 *    the top right stay free;
 *  - 3 nesting classification;
 *  - 6 background detection from computed backgrounds;
 *  - 4 the locate plan (on screen, edge flag).
 */
import { describe, expect, it } from 'vitest';
import { classifyBackdrop, contrast, isChartType, locatePlan, nestingLevel, spotBox, tickColor, TICK_CONTRAST } from '../lib/badge-look';
import { clearOf, layoutBadges, FIT_W, type BadgeInput, type Box } from '../content-badge-layout';
import { DEFAULT_TYPE_COLOR, getTypeColor } from '../lib/type-registry';

const box = (top: number, left: number, w: number, h: number): Box => ({ top, left, bottom: top + h, right: left + w });
const moved = (b: Box, o: { dx: number; dy: number }): Box => ({ top: b.top + o.dy, bottom: b.bottom + o.dy, left: b.left + o.dx, right: b.right + o.dx });
const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const left = (natural: Box, host: Box, extra: Partial<BadgeInput> = {}): BadgeInput => ({ natural, host, visibleTop: 0, anchor: 'left', ...extra });

describe('2a: tick colour', () => {
  const TYPES = ['Organisation', 'Page', 'Scorecard', 'Strategy', 'Theme', 'Risk', 'Issue', 'InputView', 'InputSet', 'TextInput', 'ButtonInput',
    'Container', 'TabSet', 'Tab', 'BarChart', 'RiskChart', 'ExtendedTable', 'ButtonGroup'];

  it('darkens every type colour to at least 4.8:1 on white, keeping a dark one as is', () => {
    for (const t of TYPES) {
      const c = tickColor(getTypeColor(t));
      expect(contrast(c, '#ffffff'), `${t} ${c}`).toBeGreaterThanOrEqual(TICK_CONTRAST);
    }
    expect(contrast(tickColor(DEFAULT_TYPE_COLOR), '#ffffff')).toBeGreaterThanOrEqual(TICK_CONTRAST);
    expect(tickColor('#161616')).toBe('#161616');
  });

  it('keeps the hue: only darkens', () => {
    const c = tickColor('#6fdc8c');
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(contrast('#6fdc8c', '#ffffff')).toBeLessThan(2);
  });
});

describe('2b: the badge on the top-left edge', () => {
  it('puts the badges of nested hosts sharing a corner side by side on the rail, none covering another', () => {
    const outer = box(100, 100, 600, 400);
    const inner = box(110, 100, 300, 200);
    const items = [left(box(90, 112, 120, 20), outer), left(box(100, 112, 90, 20), inner), left(box(100, 112, 70, 20), inner)];
    const out = layoutBadges(items, 1280);
    const placed = items.map((it, i) => moved(it.natural, out[i]));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j]), `${i}/${j}`).toBe(false);
    // Along the rail (right), not down into the widget.
    expect(out[2].dy).toBe(0);
    expect(out[2].dx).toBeGreaterThan(0);
  });

  it('stacks below when the rail would leave the host', () => {
    const host = box(100, 100, 200, 300);
    const items = [left(box(90, 112, 150, 20), host), left(box(90, 112, 150, 20), host)];
    const out = layoutBadges(items, 1280);
    expect(overlap(moved(items[0].natural, out[0]), moved(items[1].natural, out[1]))).toBe(false);
    expect(out[1].dy).toBeGreaterThan(0);
  });

  it('pulls a badge that hangs above a host clipping its overflow inside it', () => {
    const host = box(200, 100, 500, 300);
    const [o] = layoutBadges([left(box(190, 112, 120, 20), host, { clip: host })], 1280);
    expect(190 + o.dy).toBeGreaterThanOrEqual(200);
    expect(o.dx).toBe(0);
    // No clip: it stays half above the line.
    expect(layoutBadges([left(box(190, 112, 120, 20), host)], 1280)[0]).toEqual({ dx: 0, dy: 0 });
  });

  it('stays below a sticky header with the new anchor', () => {
    const [o] = layoutBadges([left(box(50, 112, 120, 20), box(60, 100, 500, 400), { visibleTop: 80 })], 1280);
    expect(50 + o.dy).toBe(82);
  });

  it('leaves the widget\'s own controls at the top right free without moving', () => {
    // The old corner badge sat on the pencil and kebab; the edge badge does not touch them.
    const host = box(200, 700, 680, 300);
    const kebab = box(206, 1350, 20, 24);
    const pencil = box(206, 1326, 20, 24);
    const natural = box(190, 712, 146, 20);
    const [o] = layoutBadges([left(natural, host, { controls: [kebab, pencil], clip: { top: 0, left: 0, bottom: 900, right: 1400 } })], 1400);
    expect(o).toEqual({ dx: 0, dy: 0 });
    expect(overlap(moved(natural, o), kebab) || overlap(moved(natural, o), pencil)).toBe(false);
  });

  it('moves along the rail past a control it would cover', () => {
    const control = box(195, 150, 24, 24);
    const off = clearOf(box(190, 112, 120, 20), [control], { top: 0, left: 0, bottom: 900, right: 1280 }, [], undefined, 'left')!;
    expect(off.dx).toBeGreaterThan(0);
    expect(overlap(moved(box(190, 112, 120, 20), off), control)).toBe(false);
  });

  it('never moves a badge past its own widget: a control as wide as the widget sends it below', () => {
    // A narrow widget whose header control spans its width: "past the
    // control" would put the badge over the neighbouring column.
    const host = box(110, 12, 428, 400);
    const header = box(104, 12, 428, 26);
    const natural = box(100, 14, 320, 22);
    const [o] = layoutBadges([left(natural, host, { controls: [header], clip: { top: 0, left: 0, bottom: 900, right: 1280 } })], 1280);
    const at = moved(natural, o);
    expect(at.left).toBeGreaterThanOrEqual(host.left);
    expect(at.right).toBeLessThanOrEqual(host.right);
    expect(overlap(at, header)).toBe(false);
  });

  it('shortens its name to stay in its corner when the pencil and kebab of the widget are in the way', () => {
    // A 216px widget: the 171px badge would reach the pencil at 185.
    const host = box(110, 24, 216, 190);
    const pencil = box(118, 185, 24, 24);
    const kebab = box(118, 211, 24, 24);
    const natural = box(100, 36, 171, 20);
    const [o] = layoutBadges([left(natural, host, { controls: [pencil, kebab], textW: 140, clip: { top: 0, left: 0, bottom: 900, right: 1280 } })], 1280);
    expect(o.dx).toBe(0);
    expect(o.dy).toBe(0);
    expect(o.fit).toBeUndefined();
    // 171 - (207 - (185 - 2)) = 147 wide: the name loses 24 of its 140.
    expect(o.squeeze).toBe(116);
  });

  it('is the tile in its corner, not a badge dropped into the widget, when too little of the name would be left', () => {
    const host = box(110, 24, 120, 190);
    const pencil = box(118, 70, 24, 24);
    const natural = box(100, 36, 171, 20);
    const [o] = layoutBadges([left(natural, host, { controls: [pencil], textW: 140, clip: { top: 0, left: 0, bottom: 900, right: 1280 } })], 1280);
    expect(o).toEqual({ dx: 0, dy: 0, fit: true });
  });

  it('is not pulled left of its widget when the row is wider than the visible area: the name is shortened', () => {
    // The pane ends at 615; the badge row (name + sub-badges) would end at 693.
    const host = box(70, 133, 442, 300);
    const natural = box(60, 145, 548, 20);
    const [o] = layoutBadges([left(natural, host, { textW: 160, clip: { top: 0, left: 0, bottom: 900, right: 615 } })], 1280);
    expect(o.dx).toBe(0);
    expect(o.squeeze).toBe(160 - (693 - 613));
    // Too wide even with the shortest name: it stays on its widget and is cut at the right.
    const wide = box(60, 145, 700, 20);
    const [w] = layoutBadges([left(wide, host, { textW: 160, clip: { top: 0, left: 0, bottom: 900, right: 615 } })], 1280);
    expect(w.dx).toBe(0);
    expect(w.squeeze).toBeUndefined();
  });

  it('keeps the left corner when it shrinks to its tile next to a small element\'s text', () => {
    const text = box(320, 120, 60, 16);
    const host = box(310, 110, 100, 36);
    const natural = box(300, 122, 120, 20);
    const [o] = layoutBadges([left(natural, host, { text, clip: { top: 290, left: 0, bottom: 900, right: 1280 } })], 1280);
    expect(o.fit).toBe(true);
    const tile: Box = { top: natural.top + o.dy, bottom: natural.top + o.dy + 20, left: natural.left + o.dx, right: natural.left + o.dx + FIT_W };
    expect(overlap(tile, { top: text.top - 4, left: text.left - 4, bottom: text.bottom + 4, right: text.right + 4 })).toBe(false);
  });
});

describe('3: nesting', () => {
  it('classifies containers, widgets and parts', () => {
    expect(nestingLevel({ type: 'ExtendedTable', hasMarkedChild: true, height: 400 })).toBe('container');
    expect(nestingLevel({ type: 'TabSet', hasMarkedChild: false, height: 400 })).toBe('container');
    expect(nestingLevel({ type: 'ExtendedTable', hasMarkedChild: false, height: 400 })).toBe('widget');
    expect(nestingLevel({ type: 'BarChart', hasMarkedChild: false, height: 300 })).toBe('widget');
    expect(nestingLevel({ type: 'TextInput', hasMarkedChild: false, height: 60 })).toBe('part');
    // A tab (a structural type) that is a short host is a part.
    expect(nestingLevel({ type: 'Tab', hasMarkedChild: false, height: 32 })).toBe('part');
    expect(nestingLevel({ hasMarkedChild: false, height: 30, inline: true })).toBe('part');
    expect(nestingLevel({ hasMarkedChild: false, height: 0 })).toBe('widget');
  });
});

describe('6: background', () => {
  const s = (color: string, image = 'none') => ({ color, image });

  it('finds the portal\'s dark header through transparent layers', () => {
    expect(classifyBackdrop([s('rgba(0, 0, 0, 0)'), s('transparent'), s('rgb(11, 61, 107)')])).toBe('dark');
  });

  it('keeps white and light pages light, and a faint dark wash is not opaque', () => {
    expect(classifyBackdrop([s('rgb(255, 255, 255)')])).toBe('light');
    expect(classifyBackdrop([s('rgba(11, 61, 107, 0.2)'), s('rgb(244, 244, 244)')])).toBe('light');
    expect(classifyBackdrop([])).toBe('light');
  });

  it('treats a background picture, a chart or a picture inside as an image', () => {
    expect(classifyBackdrop([s('rgba(0, 0, 0, 0)', 'url("hero.jpg")')])).toBe('image');
    expect(classifyBackdrop([s('rgb(255, 255, 255)')], true)).toBe('image');
    // A gradient alone is no picture.
    expect(classifyBackdrop([s('rgb(255, 255, 255)', 'linear-gradient(red, blue)')])).toBe('light');
    expect(isChartType('BarChart')).toBe(true);
    expect(isChartType('ExtendedTable')).toBe(false);
  });
});

describe('4: locate', () => {
  it('says when a target is on screen and where the edge flag goes when it is not', () => {
    expect(locatePlan(box(100, 100, 200, 100), 1280, 800)).toMatchObject({ inView: true, edge: null });
    expect(locatePlan(box(-400, 600, 200, 100), 1280, 800)).toEqual({ inView: false, edge: 'top', at: 700 });
    expect(locatePlan(box(1200, 10, 50, 100), 1280, 800)).toEqual({ inView: false, edge: 'bottom', at: 60 });
    expect(locatePlan(box(300, 1400, 100, 100), 1280, 800)).toMatchObject({ inView: false, edge: 'right' });
  });

  it('rings the target 3px outside, kept on screen', () => {
    expect(spotBox(box(100, 100, 200, 100), 1280, 800)).toEqual({ top: 97, left: 97, bottom: 203, right: 303 });
    expect(spotBox(box(-10, -10, 50, 50), 1280, 800)).toMatchObject({ top: 0, left: 0 });
  });
});
