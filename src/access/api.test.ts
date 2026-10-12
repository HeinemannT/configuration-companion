import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createAccessApi } from './api';
import { emptyModel } from '../lib/access-workspace/model';
import { RuntimeRequestError, sendRequestBounded } from '../lib/messaging';

vi.mock('../lib/messaging', async importOriginal => ({ ...await importOriginal<typeof import('../lib/messaging')>(), sendRequestBounded: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
const response = (data: unknown) => ({ type: 'ACCESS_WORKSPACE_RESULT' as const, ok: true, data });
it('recovers a lost start reply by polling and leaves write acknowledgement to durable draft saving', async () => {
  const send = vi.mocked(sendRequestBounded);
  send.mockRejectedValueOnce(Error('Reply lost')).mockResolvedValueOnce(response({ state: 'running', progress: 'Verifying…' })).mockResolvedValueOnce(response({ state: 'complete', result: { operationId: 'receipt' } }));
  const progress = vi.fn(), api = createAccessApi('env', progress);
  const request = api({ operation: 'apply', baseline: emptyModel(), draft: emptyModel() });
  await vi.runAllTimersAsync();
  expect(await request).toEqual({ operationId: 'receipt' });
  expect(send.mock.calls.map(([message]) => 'request' in message ? message.request.operation : '')).toEqual(['start', 'status', 'status']);
  expect(progress).toHaveBeenCalledWith('Verifying…');
});
it('keeps the server rejection and never resends a refused start', async () => {
  const send = vi.mocked(sendRequestBounded);
  send.mockResolvedValue({ type: 'ACCESS_WORKSPACE_RESULT', ok: false, error: 'Wrong connection' });
  await expect(createAccessApi('env', () => {})({ operation: 'apply', baseline: emptyModel(), draft: emptyModel() })).rejects.toThrow('Wrong connection');
  expect(send).toHaveBeenCalledTimes(1);
});

const operations = () => vi.mocked(sendRequestBounded).mock.calls.map(([message]) =>
  message.type === 'ACCESS_WORKSPACE_REQUEST' ? message.request : null);
const lostReply = () => new RuntimeRequestError('Message port closed', 'runtime');
it('recovers lost status replies for the same write without replay or early acknowledgement', async () => {
  const send = vi.mocked(sendRequestBounded), progress = vi.fn();
  send.mockResolvedValueOnce(response(undefined)).mockRejectedValueOnce(lostReply())
    .mockRejectedValueOnce(new RuntimeRequestError('Timed out', 'timeout'))
    .mockResolvedValueOnce(response({ state: 'running', progress: 'Verifying…' }))
    .mockRejectedValueOnce(lostReply())
    .mockResolvedValueOnce(response({ state: 'complete', result: { operationId: 'saved-receipt' } }));
  const pending = createAccessApi('env', progress)({ operation: 'apply', baseline: emptyModel(), draft: emptyModel() });
  await vi.runAllTimersAsync();
  expect(await pending).toEqual({ operationId: 'saved-receipt' });
  expect(operations().filter(r => r?.operation === 'start')).toHaveLength(1);
  expect(new Set(operations().map(r => r && 'id' in r ? r.id : null)).size).toBe(1);
  expect(operations().some(r => r?.operation === 'acknowledge' || r?.operation === 'cancel')).toBe(false);
  expect(progress).toHaveBeenCalledWith('Reconnecting to Companion…');
  expect(progress).toHaveBeenCalledWith('Verifying…');
});

it.each(['lost', 'pending'])('returns completed reads even when acknowledgement is %s', async mode => {
  const send = vi.mocked(sendRequestBounded);
  send.mockResolvedValueOnce(response(undefined)).mockResolvedValueOnce(response({ state: 'complete', result: ['result'] }));
  if (mode === 'lost') send.mockRejectedValueOnce(lostReply());
  else send.mockImplementationOnce(() => new Promise(() => {}));
  expect(await createAccessApi('env', vi.fn())({ operation: 'principals', query: 'sam', kind: 'User' })).toEqual(['result']);
  expect(operations().map(r => r?.operation)).toEqual(['start', 'status', 'acknowledge']);
});

it.each([
  response({ state: 'failed', error: 'Apply was interrupted during writing. Reload from BMP to reconcile; do not repeat the write.' }),
  { type: 'ACCESS_WORKSPACE_RESULT' as const, ok: false, error: 'Operation belongs to another environment.' },
])('keeps explicit worker failures terminal after transport recovery', async failure => {
  const send = vi.mocked(sendRequestBounded);
  send.mockResolvedValueOnce(response(undefined)).mockRejectedValueOnce(lostReply()).mockResolvedValueOnce(failure);
  const result = expect(createAccessApi('env', vi.fn())({ operation: 'apply', baseline: emptyModel(), draft: emptyModel() }))
    .rejects.toThrow('error' in failure ? failure.error : 'Apply was interrupted');
  await vi.runAllTimersAsync(); await result;
  expect(operations().map(r => r?.operation)).toEqual(['start', 'status', 'status']);
});

it('bounds lost-status recovery and retains uncertain writes for reconciliation', async () => {
  const send = vi.mocked(sendRequestBounded);
  send.mockResolvedValueOnce(response(undefined)).mockRejectedValue(lostReply());
  const result = expect(createAccessApi('env', vi.fn())({ operation: 'apply', baseline: emptyModel(), draft: emptyModel() }))
    .rejects.toThrow('apply outcome is not confirmed');
  await vi.runAllTimersAsync(); await result;
  expect(operations().map(r => r?.operation)).toEqual(['start', 'status', 'status', 'status', 'status']);
});

it('cancels an obsolete read promptly during recovery backoff without another status poll', async () => {
  const send = vi.mocked(sendRequestBounded), controller = new AbortController();
  send.mockResolvedValueOnce(response(undefined)).mockRejectedValueOnce(lostReply()).mockResolvedValue(response(undefined));
  const result = expect(createAccessApi('env', vi.fn())({ operation: 'search', query: 'old' }, { signal: controller.signal }))
    .rejects.toThrow('Obsolete search');
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(new Error('Obsolete search'));
  await vi.runAllTimersAsync(); await result;
  expect(operations().map(r => r?.operation)).toEqual(['start', 'status', 'cancel']);
});

it('rejects invalid status replies without retrying or dispatching another write', async () => {
  const send = vi.mocked(sendRequestBounded);
  send.mockResolvedValueOnce(response(undefined)).mockResolvedValueOnce(response({ state: 'unknown' }));
  await expect(createAccessApi('env', vi.fn())({ operation: 'apply', baseline: emptyModel(), draft: emptyModel() }))
    .rejects.toThrow('invalid operation status');
  expect(operations().map(r => r?.operation)).toEqual(['start', 'status']);
});

it('repeats read cleanup when cancellation races late worker registration', async () => {
  const send = vi.mocked(sendRequestBounded), controller = new AbortController();
  let accept!: (value: ReturnType<typeof response>) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; })).mockResolvedValue(response(undefined));
  const result = expect(createAccessApi('env', vi.fn())({ operation: 'search', query: 'old' }, { signal: controller.signal }))
    .rejects.toThrow('Obsolete');
  controller.abort(Error('Obsolete'));
  expect(operations().map(r => r?.operation)).toEqual(['start', 'cancel']);
  // The first cancellation reached the worker before it knew this operation.
  accept(response(undefined));
  await vi.runAllTimersAsync(); await result;
  expect(operations().map(r => r?.operation)).toEqual(['start', 'cancel', 'cancel']);
  expect(new Set(operations().map(r => r && 'id' in r ? r.id : null)).size).toBe(1);
});
