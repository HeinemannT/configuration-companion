/**
 * client-pool: one BmpClient per server profile, kept while the profile's
 * command identity is unchanged, retired and replaced when any part of it
 * changes, and dropped when the profile is deleted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { JavaEnum, JavaWriter, type JavaClassDesc } from '../java-serial';
import { registerBmpTypes } from '../bmp-types';
import { onClientRetired, type BmpClient } from '../bmp-client';
import { clientForProfile, clientMatchesProfile, evictPooledClient, pooledClient } from '../client-pool';
import type { ServerProfile } from '../types';

const enumDesc = (name: string): JavaClassDesc => ({ name, uid: 0n, flags: 0x12, fields: [], parent: null });

function ticketBytes(user: string): Uint8Array<ArrayBuffer> {
  registerBmpTypes();
  const writer = new JavaWriter();
  writer.writeStreamHeader();
  writer.writeObject({
    $type: 'com.corporater.bmp.base.system.auth.LoginTicket',
    key: 9223372036854775707n,
    clientUserAgent: new JavaEnum(enumDesc('com.corporater.bmp.base.system.auth.ClientUserAgent'), 'STUDIO'),
    onBehalfOfId: user,
    onBehalfOfType: new JavaEnum(enumDesc('com.corporater.bmp.base.system.auth.OnBehalfOfType'), 'USER'),
    principalId: user,
    principalType: new JavaEnum(enumDesc('com.corporater.bmp.base.system.auth.PrincipalType'), 'USER'),
  });
  return writer.toBytes() as Uint8Array<ArrayBuffer>;
}

let seq = 0;
let profileId = '';
function profile(over: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: profileId, label: 'Example', bmpUrl: 'https://bmp.example.test/App/',
    bmpUser: 'user', bmpPass: 'secret', commandAuthMode: 'stored', commandAuthRevision: 'r1',
    ...over,
  };
}

beforeEach(() => {
  mockChromeStorage();
  profileId = `pool-${++seq}`;
});
afterEach(() => {
  evictPooledClient(profileId);
  vi.restoreAllMocks();
});

describe('clientMatchesProfile', () => {
  const created = () => clientForProfile(profile(), () => {}).client;

  it('matches the profile it was made from, and an equivalent spelling of its address', () => {
    const client = created();
    expect(clientMatchesProfile(client, profile())).toBe(true);
    // The address is compared after normalization: scheme and trailing slash added.
    expect(clientMatchesProfile(client, profile({ bmpUrl: '  bmp.example.test/App ' }))).toBe(true);
  });

  it.each<[string, Partial<ServerProfile>]>([
    ['server address', { bmpUrl: 'https://bmp.example.test/Other/' }],
    ['user', { bmpUser: 'someone-else' }],
    ['password', { bmpPass: 'changed' }],
    ['auth mode', { commandAuthMode: 'portal' }],
    ['auth revision', { commandAuthRevision: 'r2' }],
  ])('does not match after a change of %s', (_name, change) => {
    const client = created();
    expect(clientMatchesProfile(client, profile(change))).toBe(false);
  });

  it('treats a missing auth mode as portal and a missing revision as empty', () => {
    const legacy = { ...profile({ commandAuthMode: 'portal', commandAuthRevision: '' }) };
    const client = clientForProfile(legacy, () => {}).client;
    const bare = profile() as Partial<ServerProfile>;
    delete bare.commandAuthMode; delete bare.commandAuthRevision;
    expect(clientMatchesProfile(client, bare as ServerProfile)).toBe(true);
    expect(clientMatchesProfile(client, profile({ commandAuthMode: 'stored', commandAuthRevision: '' }))).toBe(false);
  });
});

describe('clientForProfile', () => {
  it('creates a client once and reuses it while the profile is unchanged', () => {
    const onCreated = vi.fn();
    const first = clientForProfile(profile(), onCreated);
    const again = clientForProfile(profile({ label: 'Renamed' }), onCreated);
    expect(first.replaced).toBe(false);
    expect(again).toEqual({ client: first.client, replaced: false });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(first.client);
    expect(pooledClient(profileId)).toBe(first.client);
    expect(first.client.serverUrl).toBe('https://bmp.example.test/App/');
    expect(first.client.authMode).toBe('stored');
    expect(first.client.authRevision).toBe('r1');
  });

  it.each<[string, Partial<ServerProfile>]>([
    ['server address', { bmpUrl: 'https://bmp.example.test/Other/' }],
    ['user', { bmpUser: 'someone-else' }],
    ['password', { bmpPass: 'changed' }],
    ['auth mode', { commandAuthMode: 'portal' }],
    ['auth revision', { commandAuthRevision: 'r2' }],
  ])('retires and replaces the client after a change of %s', (_name, change) => {
    const retired: BmpClient[] = [];
    const stop = onClientRetired(c => { retired.push(c); });
    try {
      const onCreated = vi.fn();
      const old = clientForProfile(profile(), onCreated).client;
      const next = clientForProfile(profile(change), onCreated);
      expect(next.replaced).toBe(true);
      expect(next.client).not.toBe(old);
      expect(retired).toEqual([old]);
      expect(onCreated).toHaveBeenCalledTimes(2);
      expect(pooledClient(profileId)).toBe(next.client);
      expect(clientMatchesProfile(next.client, profile(change))).toBe(true);
    } finally { stop(); }
  });

  it('keeps clients of different profiles apart', () => {
    const a = clientForProfile(profile(), () => {}).client;
    const otherId = `${profileId}-b`;
    try {
      const b = clientForProfile(profile({ id: otherId }), () => {}).client;
      expect(b).not.toBe(a);
      expect(pooledClient(profileId)).toBe(a);
    } finally { evictPooledClient(otherId); }
  });
});

describe('evictPooledClient', () => {
  it('retires and drops the client; the next request creates a new one', () => {
    const retired: BmpClient[] = [];
    const stop = onClientRetired(c => { retired.push(c); });
    try {
      const old = clientForProfile(profile(), () => {}).client;
      evictPooledClient(profileId);
      expect(retired).toEqual([old]);
      expect(pooledClient(profileId)).toBeUndefined();
      const next = clientForProfile(profile(), () => {});
      expect(next.client).not.toBe(old);
      // The old client had already left the pool: nothing was replaced.
      expect(next.replaced).toBe(false);
      evictPooledClient('no-such-profile'); // no client: nothing happens
      expect(retired).toEqual([old]);
    } finally { stop(); }
  });
});

describe('in-flight work on a retired client', () => {
  it('a sign-in that answers after the credential change does not reach the old client', async () => {
    let answer!: (r: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>(resolve => { answer = resolve; }));
    const old = clientForProfile(profile(), () => {}).client;
    const pending = old.auth.getLoginTicket();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const next = clientForProfile(profile({ bmpPass: 'changed' }), () => {});
    expect(next.replaced).toBe(true);
    answer(new Response(ticketBytes('user')));

    await expect(pending).rejects.toThrow();
    expect(old.commandUser).toBeNull();
    // A retired client does not sign in again with the old credentials.
    const callsBefore = vi.mocked(fetch).mock.calls.length;
    await expect(old.auth.getLoginTicket()).rejects.toThrow(/retired/);
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });
});
