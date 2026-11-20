/**
 * One press on the page: a click, a stroke, or (with voice comments on) a hold that starts voice once the press has
 * stayed still for HOLD_TO_TALK_MS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_TO_TALK_MS, Press, STILL_PX } from '../press-hold';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const press = (holdable = true, taken = true) => {
  const onHold = vi.fn(() => taken);
  return { p: new Press(100, 100, { holdable, onHold }), onHold };
};

describe('a still press', () => {
  it('fires at the time, not before, and is a hold when let go', () => {
    const { p, onHold } = press();
    vi.advanceTimersByTime(HOLD_TO_TALK_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    expect(p.charging).toBe(true);
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(p.phase).toBe('held');
    expect(p.up()).toBe('held');
  });

  it('tolerates a few pixels of tremor', () => {
    const { p, onHold } = press();
    expect(p.move(102, 101)).toBeNull();
    expect(p.move(100 + STILL_PX - 0.5, 100)).toBeNull();
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('once held, movement is ignored: nothing becomes a stroke', () => {
    const { p } = press();
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(p.move(180, 160)).toBeNull();
    expect(p.phase).toBe('held');
  });
});

describe('a press that moves', () => {
  it('is a stroke as soon as it passes the distance, and never fires', () => {
    const { p, onHold } = press();
    vi.advanceTimersByTime(HOLD_TO_TALK_MS - 50);
    expect(p.move(100 + STILL_PX, 100)).toBe('stroke');
    expect(p.charging).toBe(false);
    expect(p.move(140, 100)).toBeNull(); // said once
    vi.advanceTimersByTime(HOLD_TO_TALK_MS * 3);
    expect(onHold).not.toHaveBeenCalled();
    expect(p.up()).toBe('stroke');
  });

  it('a slow, deliberate start (10 px a second) is still a stroke before the time', () => {
    const { p, onHold } = press();
    let kind: string | null = null;
    for (let t = 0; t < HOLD_TO_TALK_MS && !kind; t += 16) { vi.advanceTimersByTime(16); kind = p.move(100 + (t / 1000) * 10, 100); }
    // 10 px/s crosses STILL_PX after 400 ms.
    expect(kind).toBe('stroke');
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(onHold).not.toHaveBeenCalled();
  });
});

describe('released or lost early', () => {
  it('let go before the time: a click, and the hold never comes', () => {
    const { p, onHold } = press();
    vi.advanceTimersByTime(HOLD_TO_TALK_MS / 2);
    expect(p.up()).toBe('click');
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('cancelled while charging: the hold never comes; cancelled while held: it says so', () => {
    const a = press();
    expect(a.p.cancel()).toBe('press');
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(a.onHold).not.toHaveBeenCalled();
    const b = press();
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(b.p.cancel()).toBe('held');
  });
});

describe('when voice cannot start', () => {
  it('a press that may not hold (voice off) is a click however long it stays', () => {
    const { p, onHold } = press(false);
    expect(p.charging).toBe(false);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS * 4);
    expect(onHold).not.toHaveBeenCalled();
    expect(p.up()).toBe('click');
  });

  it('a hold that was not taken goes on as before: a click, or a stroke when it moves', () => {
    const a = press(true, false);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(a.onHold).toHaveBeenCalledTimes(1);
    expect(a.p.phase).toBe('press');
    expect(a.p.up()).toBe('click');
    const b = press(true, false);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(b.p.move(120, 100)).toBe('stroke');
  });
});
