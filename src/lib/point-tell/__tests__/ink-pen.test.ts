import { describe, expect, it } from 'vitest';
import { BRUSH, Pen, dense, packStroke, unpackStroke } from '../ink-pen';

/** Draw a straight-ish stroke at `v` px per ms with 8 ms between samples. */
function stroke(v: number, len = 300, pressure = 0, type = 'mouse'): Pen {
  let t = 0;
  const pen = new Pen(() => t);
  pen.down(10, 50, t, pressure, type);
  const steps = Math.round(len / (v * 8));
  for (let i = 1; i <= steps; i++) { t = i * 8; pen.move(10 + v * t, 50 + Math.sin(i / 4) * 1.2, t, pressure); }
  return pen;
}

const maxR = (cps: Array<{ r: number }>): number => Math.max(...cps.map(c => c.r));

describe('the brush pen', () => {
  it('writes fatter when slow and thinner when fast', () => {
    const slow = stroke(0.25); const fast = stroke(2.2);
    const slowMid = slow.cps[Math.floor(slow.cps.length / 2)].r;
    const fastMid = fast.cps[Math.floor(fast.cps.length / 2)].r;
    expect(slowMid).toBeGreaterThan(fastMid * 1.8);
  });

  it('opens from a landing dot: the start is narrower than the middle', () => {
    const pen = stroke(0.5);
    const cps = pen.cps;
    expect(cps[0].r).toBeLessThan(cps[Math.floor(cps.length / 2)].r);
    expect(cps[0].r).toBeGreaterThan(0);
  });

  it('a tap leaves a dot', () => {
    let t = 0;
    const pen = new Pen(() => t);
    pen.down(20, 20, t, 0, 'mouse');
    t = 60;
    const cps = pen.up(t);
    expect(cps).toHaveLength(1);
    expect(cps[0].r).toBeGreaterThan(0.3);
  });

  it('lifts off with a taper: the end is thinner than the middle, a flick runs on as a hairline', () => {
    const slow = stroke(0.3);
    const a = slow.up(10_000);
    expect(a[a.length - 1].r).toBeLessThan(maxR(a) * 0.75);
    const fast = stroke(2.4, 400);
    const before = fast.cps.length;
    const b = fast.up(fast.cps[before - 1].t + 4);
    expect(b.length).toBeGreaterThan(before);           // the hairline carries on
    expect(b[b.length - 1].r).toBeLessThan(0.6);
  });

  it('a stylus draws its width from pressure', () => {
    const light = stroke(0.4, 200, 0.15, 'pen'); const hard = stroke(0.4, 200, 0.9, 'pen');
    expect(maxR(hard.cps)).toBeGreaterThan(maxR(light.cps) * 2);
  });

  it('keeps the width inside the pen and the tip at the pointer', () => {
    const pen = stroke(0.2);
    expect(maxR(pen.cps)).toBeLessThanOrEqual(BRUSH.R * 2.3 + 1e-6);
    const tail = pen.tailView();
    const last = tail.v[tail.v.length - 1];
    expect(last.x).toBeCloseTo(pen.tip.x, 6);
    expect(last.y).toBeCloseTo(pen.tip.y, 6);
  });

  it('bakes settled parts once, and only the tail is left to redraw', () => {
    const pen = stroke(0.5, 200);
    const first = pen.bakedChunk();
    expect(first?.n).toBeGreaterThan(0);
    expect(pen.bakedChunk()).toBeNull();
    expect(pen.tailView().i0).toBeGreaterThan(0);
  });
});

describe('dense samples and storing', () => {
  it('samples a line at the step', () => {
    const d = dense([{ x: 0, y: 0, r: 2 }, { x: 30, y: 0, r: 2 }, { x: 60, y: 0, r: 2 }], 0, 2, 1.5);
    expect(d.n).toBeGreaterThan(30);
    for (let i = 1; i < d.n; i++) expect(Math.hypot(d.x[i] - d.x[i - 1], d.y[i] - d.y[i - 1])).toBeLessThan(3);
  });

  it('packs a stroke into few points and draws the same line from them', () => {
    const pen = stroke(0.6, 500);
    const cps = pen.up(99_999);
    const packed = packStroke(cps);
    expect(packed.points.length).toBeLessThan(cps.length / 2);
    expect(packed.points.length).toBe(packed.r.length);
    // Every original point is within a pixel of the line the packed points draw.
    const a = dense(cps, 0, cps.length - 1, 1.5);
    const b = dense(unpackStroke(packed.points, packed.r), 0, packed.points.length - 1, 1.5);
    let worst = 0;
    for (let i = 0; i < a.n; i += 3) {
      let best = 1e9;
      for (let j = 0; j < b.n; j++) best = Math.min(best, Math.hypot(a.x[i] - b.x[j], a.y[i] - b.y[j]));
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(1.2);
  });

  it('a page of thirty marks stays small', () => {
    const marks = Array.from({ length: 30 }, () => { const p = packStroke(stroke(0.5, 400).up(99_999)); return JSON.stringify({ points: p.points, r: p.r }); });
    expect(marks.join('').length).toBeLessThan(30 * 1500);
  });
});
