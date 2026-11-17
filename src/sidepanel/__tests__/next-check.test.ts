import { describe, it, expect, vi } from 'vitest';
import { NextCheckClock, nextCheckText, nextTickDelay, type NextCheckDeps } from '../next-check';

describe('nextCheckText', () => {
  it('counts seconds under a minute, minutes above, and says when it is due', () => {
    expect(nextCheckText(null, 0)).toBeNull();
    expect(nextCheckText(28_000, 0)).toBe('Next check in 28 s');
    expect(nextCheckText(27_200, 0)).toBe('Next check in 28 s');
    expect(nextCheckText(120_000, 0)).toBe('Next check in 2 min');
    expect(nextCheckText(0, 10)).toBe('Checking now');
  });

  it('ticks every second near the check and rarely before it', () => {
    expect(nextTickDelay(28_000, 0)).toBe(1_000);
    expect(nextTickDelay(28_400, 0)).toBe(400);
    expect(nextTickDelay(300_000, 0)).toBe(30_000);
    expect(nextTickDelay(0, 5)).toBe(2_000);
  });
});

function harness(alarm: { scheduledTime: number } | undefined) {
  let now = 0;
  let visible = true;
  let visibility: (() => void) | null = null;
  const timers: { cb: () => void; at: number; id: number }[] = [];
  let seq = 0;
  const texts: (string | null)[] = [];
  const current = { alarm };
  const deps: NextCheckDeps = {
    getAlarm: vi.fn(async () => current.alarm),
    onText: (t) => texts.push(t),
    isVisible: () => visible,
    onVisibilityChange: (cb) => { visibility = cb; },
    now: () => now,
    setTimer: (cb, ms) => { const id = ++seq; timers.push({ cb, at: now + ms, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.cb();
      await Promise.resolve(); await Promise.resolve();
    }
    now = end;
  };
  return {
    deps, texts, timers, current, advance,
    hide: () => { visible = false; visibility?.(); },
    show: async () => { visible = true; visibility?.(); await Promise.resolve(); await Promise.resolve(); },
  };
}

describe('NextCheckClock', () => {
  it('reads the real alarm and counts down while visible', async () => {
    const h = harness({ scheduledTime: 3_000 });
    const clock = new NextCheckClock(h.deps);
    clock.setActive(true);
    await Promise.resolve(); await Promise.resolve();
    expect(h.texts.at(-1)).toBe('Next check in 3 s');
    await h.advance(1_000);
    expect(h.texts.at(-1)).toBe('Next check in 2 s');
    expect(h.deps.getAlarm).toHaveBeenCalledTimes(1);
  });

  it('keeps no timer while the panel is hidden and re-reads the alarm when shown', async () => {
    const h = harness({ scheduledTime: 30_000 });
    const clock = new NextCheckClock(h.deps);
    clock.setActive(true);
    await Promise.resolve(); await Promise.resolve();
    h.hide();
    expect(h.timers).toHaveLength(0);
    await h.advance(20_000);
    h.current.alarm = { scheduledTime: 80_000 };
    await h.show();
    expect(h.deps.getAlarm).toHaveBeenCalledTimes(2);
    expect(h.texts.at(-1)).toBe('Next check in 1 min');
  });

  it('re-reads the alarm once the check is due, and clears the text when inactive', async () => {
    const h = harness({ scheduledTime: 1_000 });
    const clock = new NextCheckClock(h.deps);
    clock.setActive(true);
    await Promise.resolve(); await Promise.resolve();
    h.current.alarm = { scheduledTime: 61_000 };
    await h.advance(3_100);
    expect(h.texts).toContain('Checking now');
    expect(h.texts.at(-1)).toBe('Next check in 58 s');
    clock.setActive(false);
    expect(h.texts.at(-1)).toBeNull();
    expect(h.timers).toHaveLength(0);
  });
});
