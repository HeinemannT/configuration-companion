import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendFireForget = vi.fn();
vi.mock('../lib/messaging', () => ({ sendFireForget: (m: unknown) => sendFireForget(m) }));

const { scheduleHoverPrefetch, cancelHoverPrefetch, resetHoverPrefetch, HOVER_PREFETCH_DELAY } = await import('../content-hover-prefetch');

describe('hover prefetch (content side)', () => {
  beforeEach(() => { vi.useFakeTimers(); sendFireForget.mockClear(); resetHoverPrefetch(); });
  afterEach(() => vi.useRealTimers());

  it('asks for the root read once the pointer rests on a badge', () => {
    scheduleHoverPrefetch('700', 'TextElement');
    vi.advanceTimersByTime(HOVER_PREFETCH_DELAY - 1);
    expect(sendFireForget).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendFireForget).toHaveBeenCalledWith({ type: 'PREFETCH_OBJECT_VIEW', rid: '700', objectType: 'TextElement' });
  });

  it('sends nothing for fly-over and only the last badge rested on', () => {
    scheduleHoverPrefetch('700');
    vi.advanceTimersByTime(50);
    scheduleHoverPrefetch('701');
    vi.advanceTimersByTime(50);
    cancelHoverPrefetch();
    vi.advanceTimersByTime(1000);
    expect(sendFireForget).not.toHaveBeenCalled();
    scheduleHoverPrefetch('702');
    vi.advanceTimersByTime(HOVER_PREFETCH_DELAY);
    expect(sendFireForget.mock.calls.map(c => (c[0] as { rid: string }).rid)).toEqual(['702']);
  });

  it('does not ask again for the same badge right away', () => {
    scheduleHoverPrefetch('700');
    vi.advanceTimersByTime(HOVER_PREFETCH_DELAY);
    scheduleHoverPrefetch('700');
    vi.advanceTimersByTime(HOVER_PREFETCH_DELAY);
    expect(sendFireForget).toHaveBeenCalledTimes(1);
  });
});
