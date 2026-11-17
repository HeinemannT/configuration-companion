/**
 * Batched reads that survive one bad id.
 *
 * BMP answers a batched object read with ONE exception when a single object
 * in it cannot be read (for example "ObjectProfileMappingImpl cannot be cast
 * to BusinessTreeObject"), so one bad rid loses every other answer. This
 * helper sends the whole batch first; when it fails with an error that can
 * come from one object, it halves the batch and retries each half, until the
 * failing ids are isolated. A batch of n ids with k bad ids costs about
 * 2·k·log2(n) extra requests, never one request per id.
 *
 * Two limits keep a failure that is not caused by one object cheap:
 *  - errors that belong to the connection (not connected, timeout, abort, a
 *    switched environment …) are rethrown at once, never split;
 *  - a request budget (default 1 + 8·⌈log2 n⌉, enough for about four bad
 *    ids). When it runs out, the ids not answered yet are returned in
 *    `unresolved` with the last error.
 *
 * Pure: no chrome.*, no transport.
 */

import { errorKindOf, isConnectionKind } from './error-kind';

export interface IsolatedRead<T> {
  /** Results of the batches that succeeded, in request order. */
  results: T[];
  /** Ids that failed on their own, with the error message. */
  failed: Record<string, string>;
  /** Ids left unanswered because the request budget ran out. */
  unresolved: string[];
  /** Error of the last failed request when `unresolved` is not empty. */
  error?: string;
  /** Number of read calls made. */
  requests: number;
}

export interface IsolateOptions {
  /** True when a failure may come from one id in the batch. Default:
   *  `isObjectLevelError`. */
  splittable?(error: unknown): boolean;
  /** Maximum number of read calls. Default: 1 + 8·⌈log2 n⌉. */
  maxRequests?: number;
  signal?: AbortSignal;
}

/** The messages our own connection layer produces (transport, auth, router,
 *  extension messaging). Matched as phrases, never as single words: a BMP
 *  object error can mention "session", "environment" or "login" in its
 *  text and still be caused by one object. */
const CONNECTION_ERROR = new RegExp([
  String.raw`^Not connected\b`,
  String.raw`\bactive BMP environment changed\b`,
  String.raw`\bBMP connection changed\b`,
  String.raw`\bBMP request cancelled\b`,
  String.raw`^Request (?:cancelled|timed out)$`,
  String.raw`\btimed out\b`,
  String.raw`^Cannot reach BMP\b`,
  String.raw`\bFailed to fetch\b`,
  String.raw`\bNetworkError\b`,
  String.raw`\bECONNRESET\b`,
  String.raw`\bconnection reset\b`,
  String.raw`^BMP rejected \S+ authentication\b`,
  String.raw`\bHTML sign-in page\b`,
  String.raw`^BMP redirected /cs/command\b`,
  String.raw`^Could not obtain a BMP login ticket\b`,
  String.raw`^Permission denied \(403\)`,
  String.raw`^Command failed: HTTP (?:401|403|5\d\d)\b`,
  String.raw`^Extension service worker\b`,
  String.raw`^No response$`,
  String.raw`^Aborted$`,
].join('|'), 'i');

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A failure that a single object can cause (not a connection failure). */
export function isObjectLevelError(e: unknown): boolean {
  if (e instanceof Error && e.name === 'AbortError') return false;
  if (isConnectionKind(errorKindOf(e))) return false;
  return !CONNECTION_ERROR.test(message(e));
}

export function defaultBudget(n: number): number {
  return 1 + 8 * Math.ceil(Math.log2(Math.max(2, n)));
}

export async function readIsolating<T>(
  ids: readonly string[],
  read: (ids: string[]) => Promise<T>,
  options: IsolateOptions = {},
): Promise<IsolatedRead<T>> {
  const splittable = options.splittable ?? isObjectLevelError;
  const budget = options.maxRequests ?? defaultBudget(ids.length);
  const out: IsolatedRead<T> = { results: [], failed: {}, unresolved: [], requests: 0 };
  const run = async (batch: string[]): Promise<void> => {
    if (!batch.length) return;
    options.signal?.throwIfAborted();
    if (out.requests >= budget) {
      out.unresolved.push(...batch);
      return;
    }
    out.requests++;
    try {
      out.results.push(await read(batch));
    } catch (e) {
      options.signal?.throwIfAborted();
      if (!splittable(e)) throw e;
      if (batch.length === 1) {
        out.failed[batch[0]] = message(e);
        return;
      }
      out.error = message(e);
      const mid = Math.ceil(batch.length / 2);
      await run(batch.slice(0, mid));
      await run(batch.slice(mid));
    }
  };
  await run([...ids]);
  if (!out.unresolved.length) delete out.error;
  return out;
}
