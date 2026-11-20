import { describe, expect, it } from 'vitest';
import { listenerSpot, TUCK, type SpotInput } from '../listener-spot';
import { dampingFor, springAt, springEasing } from '../spring';
import { shownNumbers } from '../numbering';
import type { PtMark } from '../types';

const input = (o: Partial<SpotInput> = {}): SpotInput => ({
  card: { left: 400, top: 300, width: 268, height: 100 },
  size: 36, reach: 44,
  view: { left: 0, top: 0, right: 1440, bottom: 800 },
  ink: [], avoid: [],
  ...o,
});

describe('where the listener sits', () => {
  it('above the right end of the field when the room is free', () => {
    const s = listenerSpot(input());
    expect(s).toEqual({ side: 'top', left: 400 + 268 - 36 - 18 });
  });

  it('moves to the left end when ink is at the right end', () => {
    const s = listenerSpot(input({ ink: [[640, 280], [645, 285]] }));
    expect(s?.side).toBe('top');
    expect(s?.left).toBe(414);
  });

  it('keeps off a number badge', () => {
    const s = listenerSpot(input({ avoid: [{ left: 636, top: 262, width: 24, height: 24 }] }));
    expect(s?.left).not.toBe(400 + 268 - 36 - 18);
  });

  it('goes below the field near the top of the page', () => {
    const s = listenerSpot(input({ card: { left: 400, top: 20, width: 268, height: 100 } }));
    expect(s?.side).toBe('bottom');
  });

  it('goes below when the whole edge above is inked', () => {
    const ink: Array<[number, number]> = [];
    for (let x = 380; x < 700; x += 5) ink.push([x, 285]);
    expect(listenerSpot(input({ ink }))?.side).toBe('bottom');
  });

  it('is nowhere when no side has room: nothing is covered', () => {
    const ink: Array<[number, number]> = [];
    for (let x = 380; x < 760; x += 5) { ink.push([x, 285]); ink.push([x, 420]); }
    expect(listenerSpot(input({ ink }))).toBeNull();
    expect(listenerSpot(input({ card: { left: 400, top: 20, width: 268, height: 100 }, view: { left: 0, top: 0, right: 1440, bottom: 120 } }))).toBeNull();
  });

  it('keeps the ripples inside the window', () => {
    const s = listenerSpot(input({ card: { left: 1130, top: 300, width: 268, height: 100 }, view: { left: 0, top: 0, right: 1400, bottom: 800 } }));
    expect(s?.left).toBeLessThan(1130 + 268 - 36 - 18);
  });

  it('a box tucks behind the edge by TUCK', () => {
    expect(TUCK).toBeGreaterThan(0);
  });
});

describe('the spring', () => {
  it('starts at 0, ends at 1, overshoots by about the asked amount once', () => {
    expect(springAt(0, 0.05)).toBe(0);
    expect(springAt(1, 0.05)).toBe(1);
    let peak = 0;
    for (let i = 0; i <= 400; i++) peak = Math.max(peak, springAt(i / 400, 0.05));
    expect(peak).toBeGreaterThan(1.03);
    expect(peak).toBeLessThan(1.07);
  });

  it('is damped more for a smaller overshoot', () => {
    expect(dampingFor(0.02)).toBeGreaterThan(dampingFor(0.1));
    expect(dampingFor(0.05)).toBeCloseTo(0.69, 1);
  });

  it('is a linear() easing with exact ends', () => {
    const e = springEasing(0.05, 20);
    expect(e.startsWith('linear(0, ')).toBe(true);
    expect(e.endsWith(', 1)')).toBe(true);
    expect(e.split(',').length).toBe(21);
  });

  it('has settled before the end', () => {
    expect(Math.abs(springAt(0.9, 0.05) - 1)).toBeLessThan(0.02);
  });
});

describe('the numbers people see', () => {
  const m = (n: number, page = false): Pick<PtMark, 'n' | 'meaning'> => ({ n, meaning: page ? ({ kind: 'add', page: true } as PtMark['meaning']) : undefined });
  it('count the marks that are lines of the brief, from 1, without gaps', () => {
    const nums = shownNumbers([m(1, true), m(2), m(4), m(7)]);
    expect([...nums.entries()]).toEqual([[2, 1], [4, 2], [7, 3]]);
    expect(nums.has(1)).toBe(false);
  });

  it('are all there is when no mark drew a page', () => {
    expect([...shownNumbers([m(1), m(2)]).values()]).toEqual([1, 2]);
  });
});
