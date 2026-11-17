import { describe, it, expect } from 'vitest';
import type { ConnectionState, InspectorSettings } from '../../lib/types';
import { DEFAULT_SETTINGS } from '../../lib/types';
import { bandView, serverControlView, type RingState } from '../connection-view';

function state(change: Partial<ConnectionState> = {}): ConnectionState {
  return {
    display: 'connected',
    identities: {
      portal: { status: 'connected', user: 'admin', source: 'portal-session' },
      command: { status: 'connected', user: 'admin', source: 'portal-session' },
      sameUser: true,
    },
    version: '5.7.2', responseMs: 12, profileLabel: 'Steadfast DEV', workspace: 'Steadfast',
    authError: null, networkOffline: false, lastUpdate: 0,
    ...change,
  };
}

const settings: InspectorSettings = {
  ...DEFAULT_SETTINGS,
  profiles: [{ id: 'p', label: 'Steadfast DEV', bmpUrl: 'https://dev.example.com/Steadfast/', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' }],
  activeProfileId: 'p',
};

describe('server control', () => {
  it('shows the server and its user when connected, in a green ring', () => {
    const v = serverControlView(state(), settings);
    expect(v).toMatchObject({ name: 'Steadfast DEV', word: 'admin', ring: 'ok', tone: 'muted', empty: false });
    expect(v.title).toContain('Switch server.');
  });

  it('says Connected when the user is not known yet', () => {
    const unknownUser = state({ identities: { ...state().identities!, command: { status: 'connected', user: null, source: 'portal-session' } } });
    expect(serverControlView(unknownUser, settings)).toMatchObject({ word: 'Connected', ring: 'ok' });
  });

  it('shows the state word when broken, in the state ink', () => {
    expect(serverControlView(state({ display: 'unreachable' }), settings)).toMatchObject({ word: 'Unreachable', tone: 'error', ring: 'fail' });
    expect(serverControlView(state({ display: 'needs-login' }), settings)).toMatchObject({ word: 'Sign in to BMP', tone: 'warn', ring: 'warn' });
    expect(serverControlView(state({ display: 'needs-access' }), settings)).toMatchObject({ word: 'No access', tone: 'warn', ring: 'warn' });
  });

  it('spins while checking or reconnecting, with the connecting words in the muted ink', () => {
    expect(serverControlView(state({ display: 'checking' }), settings)).toMatchObject({ word: 'Checking…', tone: 'muted', ring: 'connecting' });
    expect(serverControlView(state({ display: 'reconnecting' }), settings)).toMatchObject({ word: 'Reconnecting…', tone: 'muted', ring: 'connecting' });
  });

  it('maps every connection state to one ring', () => {
    const expected: Record<ConnectionState['display'], RingState> = {
      connected: 'ok',
      checking: 'connecting', reconnecting: 'connecting',
      online: 'warn', 'needs-login': 'warn', 'needs-password': 'warn', 'needs-access': 'warn',
      'identity-mismatch': 'fail', 'command-failed': 'fail', 'auth-failed': 'fail', 'server-down': 'fail',
      unreachable: 'fail', 'no-config-access': 'fail', 'not-workspace': 'fail',
      'not-configured': 'none',
    };
    for (const [display, ring] of Object.entries(expected) as Array<[ConnectionState['display'], RingState]>) {
      const v = serverControlView(state({ display }), settings);
      expect(v.ring, display).toBe(ring);
      expect(v.tone, display).toBe(ring === 'fail' ? 'error' : ring === 'warn' ? 'warn' : 'muted');
    }
    // Offline is a wait, not a failure.
    expect(serverControlView(state({ display: 'unreachable', networkOffline: true }), settings)).toMatchObject({ word: 'No network', ring: 'warn' });
  });

  it('says No server and Add a server, in a dashed ring, before a server exists', () => {
    expect(serverControlView(state({ display: 'not-configured' }), { profiles: [], activeProfileId: '' }))
      .toMatchObject({ name: 'No server', word: 'Add a server', tone: 'muted', ring: 'none', empty: true });
    // A chosen server that went away is no server either, whatever the state.
    expect(serverControlView(state(), { profiles: [], activeProfileId: 'gone' })).toMatchObject({ ring: 'none', empty: true });
  });
});

describe('connection band', () => {
  it('is absent while working or checking', () => {
    for (const display of ['connected', 'checking', 'reconnecting', 'not-configured'] as const) {
      expect(bandView(state({ display })), display).toBeNull();
    }
  });

  it('Unreachable: Retry, the next automatic check, and the detail', () => {
    const v = bandView(state({ display: 'unreachable', detail: 'Failed to fetch' }))!;
    expect(v).toMatchObject({ tone: 'fail', primary: null, retry: true, nextCheck: true, detail: 'Failed to fetch' });
    expect(v.sentence).toMatch(/does not answer/);
  });

  it('Sign in to BMP: Open BMP and Retry', () => {
    expect(bandView(state({ display: 'needs-login' }))).toMatchObject({
      tone: 'warn', primary: { action: 'open-bmp', label: 'Open BMP' }, retry: true, nextCheck: false,
    });
  });

  it('Password needed and No access: only the fixing action', () => {
    expect(bandView(state({ display: 'needs-password' }))).toMatchObject({ primary: { action: 'edit-profile', label: 'Edit server' }, retry: false });
    expect(bandView(state({ display: 'needs-access' }))).toMatchObject({ primary: { action: 'grant-access', label: 'Grant access' }, retry: false });
  });
});
