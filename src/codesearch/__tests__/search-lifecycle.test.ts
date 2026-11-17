import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelledText, isQuietEnd, NO_ANSWER_TEXT, QUIET_MS, startWatchdog, STOPPED_TEXT } from '../search-lifecycle';

describe('search end states', () => {
  it('words a stop and a replaced search as plain notes, not errors', () => {
    expect(cancelledText('stopped')).toBe('Stopped.');
    expect(cancelledText('superseded')).toBe('Stopped: another search started in this window.');
    expect(cancelledText('superseded', true)).toBe('Stopped: another search started in another code search window.');
    for (const t of [STOPPED_TEXT, NO_ANSWER_TEXT, cancelledText('superseded')]) expect(isQuietEnd(t)).toBe(true);
    expect(isQuietEnd('The server scan failed')).toBe(false);
    expect(isQuietEnd(undefined)).toBe(false);
  });
});

describe('watchdog', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ends with no answer when the worker does not know the search', async () => {
    const onDead = vi.fn();
    startWatchdog({ ask: async () => false, onDead });
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(onDead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('ends with no answer when the worker does not reply', async () => {
    const onDead = vi.fn();
    startWatchdog({ ask: async () => undefined, onDead });
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
    const onThrow = vi.fn();
    startWatchdog({ ask: () => Promise.reject(new Error('timeout')), onDead: onThrow });
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(onThrow).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting while the worker still runs the search, and hits restart the clock', async () => {
    const onDead = vi.fn();
    const ask = vi.fn(async () => true);
    const dog = startWatchdog({ ask, onDead });
    await vi.advanceTimersByTimeAsync(QUIET_MS - 10);
    dog.touch();
    await vi.advanceTimersByTimeAsync(QUIET_MS - 10);
    expect(ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(onDead).not.toHaveBeenCalled();
  });

  it('stays silent once stopped (done or a user stop arrived)', async () => {
    const ask = vi.fn(async () => false);
    const onDead = vi.fn();
    const dog = startWatchdog({ ask, onDead });
    dog.stop();
    await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
    expect(ask).not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
  });
});
