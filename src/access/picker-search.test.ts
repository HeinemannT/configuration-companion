import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPickerSearch } from './picker-search';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('debounces typing and deduplicates rerenders without an automatic failure loop', async () => {
  const publish = vi.fn(), load = vi.fn().mockRejectedValue(Error('Connection lost'));
  const search = createPickerSearch(publish);
  search.update('a', load); search.update('ab', load); search.update('abc', load);
  await vi.runAllTimersAsync();
  expect(load).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenLastCalledWith({ phase: 'failed', error: 'Connection lost' });
  search.update('abc', load); await vi.runAllTimersAsync();
  expect(load).toHaveBeenCalledTimes(1);
  load.mockResolvedValueOnce(['Alice']);
  search.retry(); await vi.runAllTimersAsync();
  expect(load).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenLastCalledWith({ phase: 'complete', result: ['Alice'] });
});

it('rejects late success and failure from earlier generations of the same query', async () => {
  const publish = vi.fn(), search = createPickerSearch(publish);
  let oldSuccess!: (value: string) => void, oldFailure!: (error: Error) => void;
  const signals: AbortSignal[] = [];
  search.update('A', signal => { signals.push(signal); return new Promise<string>(resolve => { oldSuccess = resolve; }); });
  await vi.advanceTimersByTimeAsync(220);
  search.update('B', signal => { signals.push(signal); return new Promise<string>((_resolve, reject) => { oldFailure = reject; }); });
  await vi.advanceTimersByTimeAsync(220);
  search.update('A', async () => 'new A');
  await vi.runAllTimersAsync();
  const count = publish.mock.calls.length;
  oldSuccess('old A'); oldFailure(Error('old B')); await vi.runAllTimersAsync();
  expect(publish).toHaveBeenCalledTimes(count);
  expect(publish).toHaveBeenLastCalledWith({ phase: 'complete', result: 'new A' });
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

it('closing a picker cancels debounce and makes late replies inert', async () => {
  const publish = vi.fn(), search = createPickerSearch(publish), load = vi.fn(async () => 'result');
  search.update('pending', load); search.cancel(); await vi.runAllTimersAsync();
  expect(load).not.toHaveBeenCalled();
  let release!: (value: string) => void;
  search.update('running', () => new Promise<string>(resolve => { release = resolve; }));
  await vi.advanceTimersByTimeAsync(220); search.cancel();
  const count = publish.mock.calls.length;
  release('late'); await vi.runAllTimersAsync();
  expect(publish).toHaveBeenCalledTimes(count);
});
