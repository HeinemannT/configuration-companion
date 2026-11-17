import { describe, it, expect } from 'vitest';
import type { ConnectionState } from '../types';
import { describeConnection, saveVerdict } from '../connection-copy';
import { unknownIdentityMap } from '../identity-map';

const ALL: ConnectionState['display'][] = [
  'not-configured', 'checking', 'reconnecting', 'connected', 'online', 'identity-mismatch', 'command-failed',
  'auth-failed', 'server-down', 'unreachable', 'needs-login', 'no-config-access', 'needs-access',
  'not-workspace', 'needs-password',
];

function state(change: Partial<ConnectionState> = {}): ConnectionState {
  return {
    display: 'connected',
    identities: {
      portal: { status: 'connected', user: 'admin', source: 'portal-session' },
      command: { status: 'connected', user: 'admin', source: 'portal-session' },
      sameUser: true,
    },
    version: '5.6.17.6', responseMs: 12, profileLabel: 'DEV QA', workspace: 'Steadfast-DEV',
    authError: null, networkOffline: false, lastUpdate: 0,
    ...change,
  };
}

describe('describeConnection', () => {
  it('gives every state a label and one sentence that ends with a full stop', () => {
    for (const display of ALL) {
      const c = describeConnection(state({ display }));
      expect(c.label, display).toBeTruthy();
      expect(c.sentence, display).toMatch(/^[A-Z].*\.$/);
      expect(c.sentence.split('. ').length, display).toBeLessThanOrEqual(3);
    }
  });

  it('offers Retry in every non-working state', () => {
    for (const display of ALL) {
      const c = describeConnection(state({ display }));
      const working = display === 'connected' || display === 'not-configured';
      expect(c.retry, display).toBe(!working);
    }
  });

  it('says what to do for the states that used to give no next step', () => {
    expect(describeConnection(state({ display: 'server-down' })).sentence).toMatch(/checks again automatically/);
    expect(describeConnection(state({ display: 'unreachable' })).sentence).toMatch(/Check the address and your network/);
    expect(describeConnection(state({ display: 'online' })).sentence).toMatch(/Select Retry to sign in/);
    expect(describeConnection(state({ display: 'needs-login' })).sentence).toMatch(/reconnects by itself/);
  });

  it('keeps the underlying error apart from the sentence, in every failure state', () => {
    for (const display of ['auth-failed', 'command-failed', 'needs-login', 'no-config-access', 'identity-mismatch'] as const) {
      const c = describeConnection(state({ display, authError: 'HTTP 502 from cstoken' }));
      expect(c.detail, display).toBe('HTTP 502 from cstoken');
      expect(c.sentence).not.toContain('HTTP 502');
    }
    expect(describeConnection(state({ display: 'unreachable', detail: 'No answer within 5 seconds.' })).detail)
      .toBe('No answer within 5 seconds.');
  });

  it('names the fixing control where Retry alone cannot help', () => {
    expect(describeConnection(state({ display: 'needs-access' })).fix).toBe('grant-access');
    expect(describeConnection(state({ display: 'not-workspace' })).fix).toBe('edit-profile');
    expect(describeConnection(state({ display: 'needs-password' })).fix).toBe('edit-profile');
    const storedRejected = describeConnection(state({
      display: 'auth-failed',
      identities: { ...unknownIdentityMap('stored'), command: { status: 'failed', user: null, source: 'stored-login' } },
    }));
    expect(storedRejected.fix).toBe('edit-profile');
    expect(storedRejected.sentence).toMatch(/user name and password/);
    expect(describeConnection(state({ display: 'auth-failed' })).fix).toBeNull();
  });

  it('distinguishes being offline from an unreachable server', () => {
    expect(describeConnection(state({ display: 'unreachable', networkOffline: true })).label).toBe('No network');
    expect(describeConnection(state({ display: 'unreachable' })).label).toBe('Unreachable');
  });
});

describe('saveVerdict', () => {
  it('reports "Connected as <user>" after a working save', () => {
    expect(saveVerdict(state())).toEqual({ ok: true, text: 'Connected as admin', detail: null });
  });

  it('reports the one actionable sentence otherwise', () => {
    const v = saveVerdict(state({ display: 'not-workspace', detail: 'GET cs/authentication answered HTTP 404.' }));
    expect(v.ok).toBe(false);
    expect(v.text).toMatch(/not a BMP workspace/);
    expect(v.detail).toBe('GET cs/authentication answered HTTP 404.');
  });
});
