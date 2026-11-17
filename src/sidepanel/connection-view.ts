/**
 * What the panel shell shows for the connection: the header's server control
 * and the band under the tab bar. Pure; the words come from connection-copy.
 */
import type { ConnectionState, InspectorSettings } from '../lib/types';
import { describeConnection, type ConnectionCopy } from '../lib/connection-copy';
import { isRecoverableDisplay } from '../lib/connection-recovery';
import { unknownIdentityMap } from '../lib/identity-map';

export type DotTone = 'ok' | 'warn' | 'fail' | 'idle';

export function dotTone(copy: ConnectionCopy, display: ConnectionState['display']): DotTone {
  if (display === 'not-configured' || display === 'checking') return 'idle';
  switch (copy.tone) {
    case 'ok': return 'ok';
    case 'fail': return 'fail';
    case 'pending': return 'idle';
    default: return 'warn';
  }
}

/** The header ring around the mark: the state's colour, a spinning arc
 *  while connecting, dashed when no server is chosen. */
export type RingState = 'ok' | 'warn' | 'fail' | 'connecting' | 'none';

/** Ink of the second line: muted, or the state's text colour. */
export type LineTone = 'muted' | 'warn' | 'error';

export interface ServerControlView {
  /** Server name, or "No server". */
  name: string;
  /** Second line: the user when connected, otherwise the state's label
   *  ("Unreachable", "Sign in to BMP"); "Add a server" before one exists. */
  word: string;
  /** The ink of the second line. */
  tone: LineTone;
  ring: RingState;
  empty: boolean;
  /** Tooltip and accessible description. */
  title: string;
}

/** The ring for a connection state. Checking and reconnecting spin; every
 *  other state takes the tone of its words (connection-copy). */
export function ringState(copy: ConnectionCopy, display: ConnectionState['display']): RingState {
  if (display === 'not-configured') return 'none';
  if (display === 'checking' || display === 'reconnecting') return 'connecting';
  switch (dotTone(copy, display)) {
    case 'ok': return 'ok';
    case 'fail': return 'fail';
    case 'warn': return 'warn';
    default: return 'connecting';
  }
}

export function serverControlView(s: ConnectionState, settings: Pick<InspectorSettings, 'profiles' | 'activeProfileId'>): ServerControlView {
  const profile = settings.profiles.find(p => p.id === settings.activeProfileId);
  // One name for one server: the tooltip uses the profile name the control shows.
  const copy = describeConnection(profile ? { ...s, workspace: profile.label } : s);
  const empty = !profile;
  const name = empty ? 'No server' : profile.label || s.profileLabel || 'Server';
  const ring: RingState = empty ? 'none' : ringState(copy, s.display);
  let word: string;
  if (empty) word = 'Add a server';
  else if (s.display === 'connected') word = (s.identities ?? unknownIdentityMap()).command.user || 'Connected';
  else word = copy.label;
  return {
    name,
    word,
    tone: ring === 'fail' ? 'error' : ring === 'warn' ? 'warn' : 'muted',
    ring,
    empty,
    title: empty
      ? 'Switch server. No server is set up.'
      : ['Switch server.', copy.sentence, copy.detail].filter(Boolean).join(' '),
  };
}

export type BandAction = 'grant-access' | 'edit-profile' | 'open-bmp';

export interface BandView {
  tone: 'warn' | 'fail';
  sentence: string;
  primary: { action: BandAction; label: string } | null;
  retry: boolean;
  detail: string | null;
  /** Show the time of the next automatic check (from the recovery alarm). */
  nextCheck: boolean;
}

const PRIMARY_LABEL: Record<BandAction, string> = {
  'grant-access': 'Grant access',
  'edit-profile': 'Edit server',
  'open-bmp': 'Open BMP',
};

/** The band for a broken connection; null while working, checking or unset. */
export function bandView(s: ConnectionState): BandView | null {
  if (s.display === 'connected' || s.display === 'not-configured'
    || s.display === 'checking' || s.display === 'reconnecting') return null;
  const copy = describeConnection(s);
  if (!copy.retry) return null;
  const primary = copy.fix ? { action: copy.fix, label: PRIMARY_LABEL[copy.fix] } : null;
  return {
    tone: copy.tone === 'fail' ? 'fail' : 'warn',
    sentence: copy.sentence,
    primary,
    // Retry cannot help when the fix is a permission or a profile edit.
    retry: copy.fix !== 'grant-access' && copy.fix !== 'edit-profile',
    detail: copy.detail,
    nextCheck: isRecoverableDisplay(s.display),
  };
}
