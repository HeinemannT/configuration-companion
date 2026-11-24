/**
 * One provider request with bounded retries.
 *
 * Retries cover temporary failures only: rate limits, overloads, 5xx and
 * network errors (ProviderError.retryable). The provider's `retry-after`
 * (or `retry-after-ms`) wins over the backoff; a wait longer than the budget
 * is not slept through, the error is returned instead so the user is not left
 * watching a silent panel. An aborted signal stops both the request and the
 * wait at once. Only the request is retried, never a stream that already
 * produced output: callers read the body after this returns.
 */

import {
  ProviderError,
  providerErrorFromFetchFailure,
  providerErrorFromResponse,
  type ProviderErrorContext,
} from './provider-errors';

export interface RetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  /** First backoff; doubles per attempt with jitter. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** A provider-requested wait above this is not slept through. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 600,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 20_000,
};

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

/** Test seam: replaced to make backoff instant. */
export const retryClock = {
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortReason(signal)); return; }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); reject(abortReason(signal)); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
  random: Math.random,
};

export function backoffDelay(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number | null {
  if (retryAfterMs !== undefined) return retryAfterMs <= policy.maxRetryAfterMs ? retryAfterMs : null;
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(exp * (0.75 + retryClock.random() * 0.5));
}

export interface FetchProviderOptions {
  ctx: ProviderErrorContext;
  signal?: AbortSignal;
  policy?: RetryPolicy;
  /** Called before each retry, for metrics. */
  onRetry?: (attempt: number, error: ProviderError, delayMs: number) => void;
}

/** POST/GET to a provider. Resolves with an OK response; rejects with a
 *  ProviderError (or the abort reason). */
export async function fetchProvider(url: string, init: RequestInit, opts: FetchProviderOptions): Promise<Response> {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
  for (let attempt = 0; ; attempt++) {
    let error: unknown;
    try {
      const response = await fetch(url, { ...init, signal: opts.signal });
      if (response.ok) return response;
      error = await providerErrorFromResponse(response, opts.ctx);
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? e;
      error = providerErrorFromFetchFailure(e, opts.ctx);
    }
    if (!(error instanceof ProviderError) || !error.retryable || attempt >= policy.maxRetries) throw error;
    const delay = backoffDelay(attempt, policy, error.retryAfterMs);
    if (delay === null) throw error;
    opts.onRetry?.(attempt + 1, error, delay);
    await retryClock.sleep(delay, opts.signal);
  }
}
