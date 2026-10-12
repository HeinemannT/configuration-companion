import { RuntimeRequestError } from '../lib/messaging';
import type { AccessRequest, AccessTask } from '../lib/access-workspace/model';

/** An explicit refusal or invalid protocol reply is not a lost message. */
export class AccessResponseError extends Error {}
export interface RequestOptions { signal?: AbortSignal; }
type Control = (request: AccessRequest, signal?: AbortSignal) => Promise<unknown>;
type Status = { state: 'running'; progress?: string } | { state: 'complete'; result: unknown } | { state: 'failed'; error: string };
const RECOVERY_DELAYS = [150, 400, 1000];
const OPERATION_TIMEOUT = 20 * 60_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      const reason: unknown = signal!.reason;
      reject(reason instanceof Error ? reason : new Error('Request cancelled.', { cause: reason }));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function readStatus(value: unknown): Status {
  const status = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (status?.state === 'complete') return { state: 'complete', result: status.result };
  if (status?.state === 'running') return { state: 'running', progress: typeof status.progress === 'string' ? status.progress : undefined };
  if (status?.state === 'failed') return { state: 'failed', error: typeof status.error === 'string' ? status.error : 'The request failed.' };
  throw new AccessResponseError('Companion returned an invalid operation status. Reload from BMP to check the outcome.');
}

/** Owns single-dispatch tasks, bounded status recovery, and read cleanup.
 * Write receipts are acknowledged separately, after the caller saves them durably. */
export function createOperationClient(control: Control, progress: (text: string) => void) {
  const activeReads = new Set<string>();
  const cancel = (id: string) => { void control({ operation: 'cancel', id }).catch(() => {}); };

  async function request(task: AccessRequest, options: RequestOptions = {}): Promise<any> {
    if (['acknowledge', 'status', 'cancel', 'start'].includes(task.operation)) return control(task, options.signal);
    options.signal?.throwIfAborted();
    const id = crypto.randomUUID(), write = task.operation === 'apply';
    const reportsProgress = ['load', 'reconcile', 'apply'].includes(task.operation);
    const started = Date.now();
    let complete = false, cancelled = false;
    const abort = () => { if (!write && !cancelled) { cancelled = true; cancel(id); } };
    if (!write) activeReads.add(id);
    options.signal?.addEventListener('abort', abort, { once: true });

    const checkDeadline = () => {
      options.signal?.throwIfAborted();
      if (Date.now() - started > OPERATION_TIMEOUT) throw new Error(write
        ? 'Apply is still running. Its receipt will be recovered when you reopen this workspace.'
        : 'Loading exceeded 20 minutes. Retry the load.');
    };
    async function statusWithRecovery(): Promise<Status> {
      for (let attempt = 0; ; attempt++) {
        checkDeadline();
        try {
          const status = await control({ operation: 'status', id }, options.signal);
          options.signal?.throwIfAborted();
          return readStatus(status);
        } catch (error) {
          options.signal?.throwIfAborted();
          if (!(error instanceof RuntimeRequestError) || error.kind === 'cancelled') throw error;
          if (attempt === RECOVERY_DELAYS.length) throw new Error(write
            ? 'Could not reconnect to Companion. The apply outcome is not confirmed. Reload from BMP to reconcile before applying again.'
            : 'Could not reconnect to Companion. Retry the request.', { cause: error });
          if (reportsProgress) progress('Reconnecting to Companion…');
          await delay(RECOVERY_DELAYS[attempt], options.signal);
        }
      }
    }

    try {
      // Never repeat start: a missing reply says nothing about whether it ran.
      try { await control({ operation: 'start', id, task: task as AccessTask }); }
      catch (error) { if (error instanceof AccessResponseError) throw error; }
      // Cancel can reach the worker before start has registered the task. Keep
      // observing start acceptance, then repeat read cleanup after that race.
      if (!write && options.signal?.aborted) { cancelled = true; cancel(id); }
      while (true) {
        const status = await statusWithRecovery();
        if (status.state === 'complete') {
          complete = true;
          // A received read result is usable even if its cleanup reply is lost.
          if (!write) void control({ operation: 'acknowledge', id }).catch(() => {});
          return status.result;
        }
        if (status.state === 'failed') throw new Error(status.error);
        if (reportsProgress && status.progress) progress(status.progress);
        await delay(Date.now() - started < 1000 ? 100 : 750, options.signal);
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
      activeReads.delete(id);
      if (!complete) abort();
    }
  }

  return { request, cancelReads: () => { for (const id of activeReads) cancel(id); } };
}
