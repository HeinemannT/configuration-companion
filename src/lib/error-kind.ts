/**
 * Error kinds that survive the query layer and the message boundary, so a
 * surface can tell "not signed in" from "server error" from "timed out"
 * without matching message text.
 *
 * Pure: no chrome.*, no transport import at runtime.
 */

// Type-only import: extension pages use these kinds without pulling the
// transport into their bundle.
import type { BmpTransportErrorKind } from './bmp-transport';

export type BmpErrorKind =
  /** No usable sign-in for BMP commands (ticket, 401, sign-in page). */
  | 'not-signed-in'
  | 'permission'
  /** BMP could not be reached. */
  | 'network'
  | 'timeout'
  | 'cancelled'
  /** BMP answered with an error: a server exception or an EC error. */
  | 'server'
  /** The response could not be decoded or was cut off. */
  | 'protocol';

export function kindFromTransport(kind: BmpTransportErrorKind): BmpErrorKind {
  switch (kind) {
    case 'auth': return 'not-signed-in';
    case 'http': return 'server';
    default: return kind;
  }
}

/** An error with a kind. Thrown by query methods that turn a failed EcResult
 *  into an exception. */
export class BmpRequestError extends Error {
  constructor(message: string, readonly kind: BmpErrorKind, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BmpRequestError';
  }
}

/** Turn a failed EC result into a typed error. A result without a transport
 *  kind failed on the server (EC error or server exception). */
export function ecResultError(
  result: { error?: string; log?: string; errorKind?: BmpErrorKind },
  fallback: string,
): BmpRequestError {
  return new BmpRequestError(result.error || result.log || fallback, result.errorKind ?? 'server');
}

/** The kind of an error, when it is known. */
export function errorKindOf(e: unknown): BmpErrorKind | undefined {
  if (e instanceof BmpRequestError) return e.kind;
  if (e instanceof Error && e.name === 'BmpTransportError' && typeof (e as { kind?: unknown }).kind === 'string') {
    return kindFromTransport((e as unknown as { kind: BmpTransportErrorKind }).kind);
  }
  if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
  if (e instanceof DOMException && e.name === 'TimeoutError') return 'timeout';
  return undefined;
}

/** True for kinds caused by the connection, not by one object or request. */
export function isConnectionKind(kind: BmpErrorKind | undefined): boolean {
  return kind === 'not-signed-in' || kind === 'network' || kind === 'timeout'
    || kind === 'cancelled' || kind === 'permission';
}
