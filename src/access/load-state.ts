import { describeConnection } from '../lib/connection-copy';
import type { ConnectionState } from '../lib/types';
import { unknownIdentityMap } from '../lib/identity-map';

export interface LoadFailure { title: string; sentence: string; detail: string }

function state(display: ConnectionState['display'], workspace: string, networkOffline: boolean): ConnectionState {
  return { display, workspace, networkOffline, identities: unknownIdentityMap(), version: null, responseMs: null, profileLabel: null,
    authError: null, lastUpdate: 0 };
}

const unreachable = /failed to fetch|networkerror|network error|unreachable|timed? ?out|econn|could not connect|no connection/i;

/** Words for a failed workspace load, in the sentences the rest of Companion uses for connection states. */
export function loadFailure(error: unknown, online: boolean, where: string): LoadFailure {
  const detail = error instanceof Error ? error.message : String(error);
  if (!online) return { title: 'No connection', sentence: describeConnection(state('unreachable', where, true)).sentence, detail };
  if (unreachable.test(detail)) return { title: 'No connection', sentence: describeConnection(state('unreachable', where, false)).sentence, detail };
  return { title: 'Server error', sentence: describeConnection(state('command-failed', where, false)).sentence, detail };
}
