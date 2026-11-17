/**
 * Why the tree rows' facts (object-row-facts.ts) could not be read, in one
 * line. The object window, Browse and Compare show this line with a Retry
 * control instead of rows that silently read "(not read)". Session and
 * connection causes use the connection sentences (connection-copy.ts), so a
 * lost sign-in reads the same everywhere.
 *
 * Pure: no chrome.*, no transport.
 */

import { describeConnection } from './connection-copy';
import { errorKindOf, type BmpErrorKind } from './error-kind';
import { unknownIdentityMap } from './identity-map';
import type { ConnectionState } from './types';

export interface RowFactsFailure {
  /** The underlying error text (shown on hover). */
  message: string;
  kind?: BmpErrorKind;
  /** Rows without any facts because of this failure. */
  rows?: number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Text patterns of session and connection failures whose error carries no
 *  kind (they crossed the message boundary as text). */
const SIGNED_OUT = /\b(?:not signed in|sign-in page|login ticket|authentication|HTTP 401)\b|^Not connected\b/i;
const UNREACHABLE = /\b(?:Cannot reach BMP|Failed to fetch|NetworkError|ECONNRESET|connection reset)\b/i;
const TIMED_OUT = /\btimed out\b/i;

/** The failure of a row-facts read: its message and, when it is known or
 *  can be told from the text, its kind. */
export function rowFactsFailure(e: unknown, rows?: number): RowFactsFailure {
  const message = msg(e) || 'Unknown error';
  let kind = errorKindOf(e);
  if (!kind || kind === 'server') {
    if (SIGNED_OUT.test(message)) kind = 'not-signed-in';
    else if (UNREACHABLE.test(message)) kind = 'network';
    else if (TIMED_OUT.test(message)) kind = 'timeout';
  }
  return { message, ...(kind ? { kind } : {}), ...(rows != null ? { rows } : {}) };
}

function sentence(display: ConnectionState['display']): string {
  return describeConnection({
    display, identities: unknownIdentityMap(), version: null, responseMs: null, profileLabel: null,
    workspace: null, authError: null, networkOffline: false, lastUpdate: 0,
  }).sentence;
}

const MAX_DETAIL = 160;

/** One line: what is missing and why. */
export function rowFactsNote(f: RowFactsFailure): string {
  const what = 'Names and markers of the rows could not be read.';
  switch (f.kind) {
    case 'not-signed-in': return `${what} ${sentence('needs-login')}`;
    case 'network': return `${what} ${sentence('unreachable')}`;
    case 'permission': return `${what} ${sentence('no-config-access')}`;
    case 'timeout': return `${what} The server did not answer in time.`;
    case 'cancelled': return 'Names and markers of the rows were not read: the read was cancelled.';
    default: {
      const detail = f.message.replace(/\s+/g, ' ').trim();
      return `${what} ${detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail}`;
    }
  }
}
