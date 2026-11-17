import { beforeEach, expect, it, vi } from 'vitest';
import { cancelOperation, operationStatus, releaseOperation, startOperation } from './operations';

vi.mock('./journal', () => ({ readJournal: vi.fn(async () => undefined) }));
beforeEach(() => vi.clearAllMocks());
it('does not replay an operation when its start reply is lost', async () => {
  const run = vi.fn(async () => ({ saved: true })), id = crypto.randomUUID();
  startOperation(id, 'env', true, run); startOperation(id, 'env', true, run);
  await vi.waitFor(async () => expect(await operationStatus(id, 'env')).toMatchObject({ state: 'complete', result: { saved: true } }));
  expect(run).toHaveBeenCalledTimes(1);
  await expect(operationStatus(id, 'other')).rejects.toThrow('another environment');
  releaseOperation(id, 'env');
});
it('exposes page progress and cancels reads without cancelling writes', async () => {
  const id = crypto.randomUUID(); let readSignal: AbortSignal | undefined;
  startOperation(id, 'env', false, async context => {
    readSignal = context.signal; context.progress?.('2 of 98 pages');
    return new Promise((_resolve, reject) => context.signal?.addEventListener('abort', () => reject(Error('cancelled'))));
  });
  await Promise.resolve();
  expect(await operationStatus(id, 'env')).toMatchObject({ state: 'running', progress: '2 of 98 pages' });
  cancelOperation(id, 'other'); expect(readSignal?.aborted).toBe(false);
  cancelOperation(id, 'env'); expect(readSignal?.aborted).toBe(true);
  await vi.waitFor(async () => expect(await operationStatus(id, 'env')).toMatchObject({ state: 'failed' }));
  releaseOperation(id, 'env');
  const writeId = crypto.randomUUID(); let writeSignal: AbortSignal | undefined;
  startOperation(writeId, 'env', true, async context => { writeSignal = context.signal; return 'receipt'; });
  await Promise.resolve(); cancelOperation(writeId, 'env'); expect(writeSignal?.aborted).toBe(false);
  await vi.waitFor(async () => expect(await operationStatus(writeId, 'env')).toMatchObject({ state: 'complete' }));
  releaseOperation(writeId, 'env');
});
