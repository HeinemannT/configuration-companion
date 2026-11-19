import { describe, expect, it } from 'vitest';
import { commandUserOf as signedInUser } from '../../lib/identity-map';

describe('signedInUser', () => {
  it('is the user the connection runs commands as', () => {
    expect(signedInUser({ identities: { command: { status: 'connected', user: 'admin' } } })).toBe('admin');
  });
  it('is empty while the user is not known', () => {
    expect(signedInUser({ identities: { command: { status: 'unknown', user: 'admin' } } })).toBe('');
    expect(signedInUser({ identities: { command: { status: 'connected', user: null } } })).toBe('');
    expect(signedInUser({})).toBe('');
    expect(signedInUser(null)).toBe('');
  });
});
