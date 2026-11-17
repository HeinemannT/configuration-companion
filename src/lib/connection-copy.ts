/**
 * The words a configurator sees for each connection state.
 *
 * One table serves the panel header, the Connect status strip, the profile
 * row, and the page toast, so a state never reads differently in two places.
 * Each non-working state has one plain sentence that says what is wrong and
 * what to do. The underlying error text is kept apart in `detail` so a surface
 * can show it on request without crowding the sentence.
 */
import type { ConnectionState } from './types';
import { unknownIdentityMap } from './identity-map';

export type ConnectionTone = 'ok' | 'online' | 'warn' | 'fail' | 'pending';

export interface ConnectionCopy {
  /** Short label for the header and the profile row. */
  label: string;
  /** One sentence: what is wrong and what to do (or, when working, what is connected). */
  sentence: string;
  /** Underlying error text, when there is one. */
  detail: string | null;
  tone: ConnectionTone;
  /** True when the connection is not working: surfaces show a Retry control. */
  retry: boolean;
  /** The one control that fixes the state, when Retry alone cannot. */
  fix: 'grant-access' | 'edit-profile' | 'open-bmp' | null;
}

/** The sentence for a server whose site Companion may not use yet. */
export const CONNECTION_NEEDS_ACCESS_SENTENCE = 'Companion has no permission for this site. Select Grant access and allow it in the browser prompt.';

function where(s: ConnectionState): string {
  return s.workspace ?? s.profileLabel ?? 'the server';
}

/** Map a connection state to its user-facing words. Pure; covered by tests. */
export function describeConnection(s: ConnectionState): ConnectionCopy {
  const detail = s.detail ?? s.authError ?? null;
  const stored = (s.identities ?? unknownIdentityMap()).command.source === 'stored-login';
  const base = { detail, retry: true, fix: null } as const;
  switch (s.display) {
    case 'not-configured':
      return { ...base, detail: null, retry: false, label: 'No server', sentence: 'No server is set up. Add your BMP server in Connect.', tone: 'pending' };
    case 'checking':
      return { ...base, detail: null, label: 'Checking…', sentence: `Checking the connection to ${where(s)}.`, tone: 'pending' };
    case 'reconnecting':
      return { ...base, detail: null, label: 'Reconnecting…', sentence: `Reconnecting to ${where(s)}.`, tone: 'warn' };
    case 'connected': {
      const actor = (s.identities ?? unknownIdentityMap()).command;
      const user = actor.status === 'connected' && actor.user ? ` as ${actor.user}` : '';
      const version = s.version ? ` (BMP ${s.version.replace(/^v\.?/i, '')})` : '';
      return {
        detail: null, retry: false, fix: null,
        label: s.profileLabel ?? 'Connected',
        sentence: `Connected to ${where(s)}${user}${version}.`,
        tone: 'ok',
      };
    }
    case 'online':
      return { ...base, label: 'Not signed in', sentence: 'The server answers, but Companion is not signed in yet. Select Retry to sign in.', tone: 'online' };
    case 'identity-mismatch':
      return { ...base, label: 'User mismatch', sentence: 'The BMP page and Companion use different users. Sign in to BMP as the intended user, then select Retry.', tone: 'fail' };
    case 'command-failed':
      return { ...base, label: 'Commands failing', sentence: 'The server answers, but BMP commands fail. Companion checks again automatically; select Retry to check now.', tone: 'fail' };
    case 'needs-login':
      return { ...base, fix: 'open-bmp', label: 'Sign in to BMP', sentence: 'You are not signed in to BMP. Sign in on a BMP page; Companion reconnects by itself.', tone: 'warn' };
    case 'no-config-access':
      return { ...base, label: 'No config access', sentence: 'This BMP user has no Configuration Access role. Ask a BMP administrator for the role, or sign in as another user.', tone: 'fail' };
    case 'auth-failed':
      return stored
        ? { ...base, fix: 'edit-profile', label: 'Sign-in failed', sentence: 'BMP rejected the stored login. Edit the server and check the user name and password.', tone: 'fail' }
        : { ...base, label: 'Sign-in failed', sentence: 'Companion could not sign in with your BMP session. Sign in to BMP again, then select Retry.', tone: 'fail' };
    case 'needs-password':
      return { ...base, fix: 'edit-profile', label: 'Password needed', sentence: 'The saved password cannot be read in this browser. Edit the server and enter the password again.', tone: 'warn' };
    case 'server-down':
      return { ...base, label: 'Server down', sentence: 'The server answers, but BMP reports that it is not running. Companion checks again automatically.', tone: 'fail' };
    case 'unreachable':
      return s.networkOffline
        ? { ...base, label: 'No network', sentence: 'This computer is offline. Companion reconnects when the network returns.', tone: 'warn' }
        : { ...base, label: 'Unreachable', sentence: 'The server does not answer. Check the address and your network or VPN; Companion checks again automatically.', tone: 'fail' };
    case 'not-workspace':
      return { ...base, fix: 'edit-profile', label: 'Not a workspace', sentence: 'The server answers, but this address is not a BMP workspace. Edit the server and use the workspace address, for example host/Workspace.', tone: 'fail' };
    case 'needs-access':
      return { ...base, fix: 'grant-access', label: 'No access', sentence: CONNECTION_NEEDS_ACCESS_SENTENCE, tone: 'warn' };
    default: {
      const unknown: never = s.display;
      void unknown;
      return { ...base, label: 'Checking…', sentence: 'Checking the connection.', tone: 'pending' };
    }
  }
}

/** Short verdict after saving a profile: "Connected as admin" or the one actionable error. */
export function saveVerdict(s: ConnectionState): { ok: boolean; text: string; detail: string | null } {
  const copy = describeConnection(s);
  if (s.display === 'connected') {
    const actor = (s.identities ?? unknownIdentityMap()).command;
    return { ok: true, text: actor.user ? `Connected as ${actor.user}` : 'Connected', detail: null };
  }
  return { ok: false, text: copy.sentence, detail: copy.detail };
}

/** One failed request in the words of the connection table: a title, one
 *  sentence with what to do, whether Retry applies, and the raw detail kept
 *  apart (behind "Details"). Used by every window that shows a failed read or
 *  write (object window, editor, Studio, Blueprint), as the panel, Compare and
 *  Access already do for the connection itself. Pure; covered by tests. */
export interface FailureCopy {
  title: string;
  sentence: string;
  detail: string | null;
  retry: boolean;
  fix: ConnectionCopy['fix'];
  /** No known cause: the detail is the only explanation, so it is shown open. */
  showDetail?: boolean;
}

/** Kinds as lib/error-kind.ts names them (kept as strings: no import cycle). */
type FailureKind = 'not-signed-in' | 'permission' | 'network' | 'timeout' | 'cancelled' | 'server' | 'protocol';

const UNREACHABLE = /failed to fetch|networkerror|network error|unreachable|err_name_not_resolved|could not connect|no connection|cannot reach/i;
const SIGNED_OUT = /not signed in|sign[- ]?in page|401|unauthori[sz]ed|session (has )?expired|no ticket/i;
const TIMED_OUT = /timed? ?out|did not answer in time|no answer/i;

function connectionState(display: ConnectionState['display'], where: string | undefined, offline: boolean): ConnectionState {
  return { display, workspace: where ?? null, networkOffline: offline, identities: unknownIdentityMap(), version: null, responseMs: null, profileLabel: null, authError: null, lastUpdate: 0 } as ConnectionState;
}

export function describeFailure(input: { error: string; kind?: FailureKind; online?: boolean; where?: string }): FailureCopy {
  const detail = input.error.trim() || null;
  const text = input.error;
  const kind: FailureKind | undefined = input.kind
    ?? (input.online === false || UNREACHABLE.test(text) ? 'network'
      : SIGNED_OUT.test(text) ? 'not-signed-in'
      : TIMED_OUT.test(text) ? 'timeout'
      : undefined);
  const fromState = (display: ConnectionState['display'], title: string): FailureCopy => {
    const c = describeConnection(connectionState(display, input.where, input.online === false));
    return { title, sentence: c.sentence, detail, retry: true, fix: c.fix };
  };
  switch (kind) {
    case 'network': return fromState('unreachable', input.online === false ? 'No network' : 'Server unreachable');
    case 'not-signed-in': return fromState('needs-login', 'Not signed in');
    case 'permission': return { title: 'No permission', sentence: 'This BMP user may not do this. Ask a BMP administrator for access, or sign in as another user.', detail, retry: false, fix: null };
    case 'timeout': return { title: 'No answer in time', sentence: 'BMP did not answer in time. Select Retry; if it keeps happening, the server is busy.', detail, retry: true, fix: null };
    case 'cancelled': return { title: 'Stopped', sentence: 'The request was stopped before BMP answered. Select Retry to run it again.', detail, retry: true, fix: null };
    case 'protocol': return { title: 'Incomplete answer', sentence: 'The answer from BMP was cut off or could not be read. Select Retry.', detail, retry: true, fix: null };
    case 'server': return { title: 'BMP reported an error', sentence: 'BMP answered with an error. The details say why; select Retry after fixing the cause.', detail, retry: true, fix: null };
    default: return { title: 'Something went wrong', sentence: 'The request failed. Select Retry; the details say why.', detail, retry: true, fix: null, showDetail: true };
  }
}
