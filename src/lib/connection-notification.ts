import type { ConnectionState } from './types';
import { describeConnection } from './connection-copy';

export interface ConnectionNotificationCursor {
  initialized: boolean;
  incidentEpoch: number;
  recoveryEpoch: number;
}

export type ConnectionNotification = { text: string; kind: 'success' | 'error' };

/** Project semantic incident epochs into user notifications. Display adjacency,
 * transport generations and timestamps are deliberately irrelevant. */
export function nextConnectionNotification(
  state: ConnectionState,
  previous: ConnectionNotificationCursor,
): { cursor: ConnectionNotificationCursor; notification: ConnectionNotification | null } {
  const incidentEpoch = state.incidentEpoch ?? 0;
  const recoveryEpoch = state.recoveryEpoch ?? 0;
  const cursor = { initialized: true, incidentEpoch, recoveryEpoch };
  if (!previous.initialized) return { cursor, notification: null };

  if (incidentEpoch > previous.incidentEpoch) {
    // The page toast uses the same sentence as the side panel, so a
    // configurator without the panel open is still told what to do.
    const text = `Companion: ${describeConnection(state).sentence}`;
    return { cursor, notification: { text, kind: 'error' } };
  }
  // A recovery notification is only valid when this consumer observed the
  // matching incident. A newly opened content script may receive a later
  // recovery epoch from storage without ever having seen the outage.
  if (recoveryEpoch > previous.recoveryEpoch
    && previous.incidentEpoch === recoveryEpoch) {
    return {
      cursor,
      notification: { text: `Connected to ${state.profileLabel ?? 'server'}`, kind: 'success' },
    };
  }
  return { cursor, notification: null };
}
