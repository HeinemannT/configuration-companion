import { describe, expect, it } from 'vitest';
import { EventLevel, levelOf, rmsOf, smooth } from '../voice-level';

describe('the level of the voice', () => {
  it('silence is 128 in every byte and has no level', () => {
    expect(rmsOf(new Uint8Array(64).fill(128))).toBe(0);
    expect(rmsOf([])).toBe(0);
    expect(levelOf(0)).toBe(0);
  });

  it('a full-scale wave has an rms near 0.7 and fills the range', () => {
    const wave = Array.from({ length: 256 }, (_, i) => 128 + Math.round(127 * Math.sin(i / 4)));
    expect(rmsOf(wave)).toBeGreaterThan(0.6);
    expect(levelOf(rmsOf(wave))).toBe(1);
  });

  it('a noise floor stays at rest and ordinary speech is well up the range', () => {
    expect(levelOf(0.01)).toBe(0);
    expect(levelOf(0.08)).toBeGreaterThan(0.4);
    expect(levelOf(0.08)).toBeLessThan(levelOf(0.15));
  });

  it('rises quickly and falls slowly', () => {
    const up = smooth(0, 1) - 0;
    const down = 1 - smooth(1, 0);
    expect(up).toBeGreaterThan(down);
    expect(smooth(0.5, 0.5)).toBe(0.5);
    // The same in a few small steps as in one large one.
    let v = 0;
    for (let i = 0; i < 4; i++) v = smooth(v, 1, 25);
    expect(v).toBeCloseTo(smooth(0, 1, 100), 5);
  });
});

describe('the level from the recogniser alone', () => {
  it('swells while speech goes on, lifts at a result, and falls back at the end', () => {
    const l = new EventLevel();
    expect(l.next(0.5)).toBe(0);
    l.event('speechstart');
    expect(l.next(0.5)).toBeCloseTo(0.55);
    l.event('result');
    expect(l.next(0.5)).toBeGreaterThan(0.55);
    l.event('speechend');
    for (let i = 0; i < 12; i++) l.next(0.5);
    expect(l.next(0.5)).toBeLessThan(0.2);
    l.event('soundend');
    for (let i = 0; i < 12; i++) l.next(0.5);
    expect(l.next(0.5)).toBe(0);
  });
  it('stays inside 0..1 whatever the wobble', () => {
    const l = new EventLevel();
    l.event('result');
    for (const r of [0, 1, 0.3, 0.9]) { const v = l.next(r); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
});
