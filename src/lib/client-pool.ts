/**
 * One BmpClient per server profile.
 *
 * A client holds the profile's command session, capability probes and its
 * transport (one post at a time per server, see bmp-transport.ts). Clients are
 * created on demand and kept until the profile's command credentials change or
 * the profile is deleted; focusing another window never replaces one.
 */
import type { ServerProfile } from './types';
import { BmpClient } from './bmp-client';
import { normalizeUrl } from './connection';

const pool = new Map<string, BmpClient>();

export function clientMatchesProfile(client: BmpClient, profile: ServerProfile): boolean {
  return client.serverUrl === normalizeUrl(profile.bmpUrl) && client.username === profile.bmpUser
    && client.authMode === (profile.commandAuthMode ?? 'portal') && client.passwordMatches(profile.bmpPass)
    && client.authRevision === (profile.commandAuthRevision ?? '');
}

/** The profile's client, created (or replaced after a credential change) on
 *  demand. `onCreated` runs once for each new client, before it is used. The
 *  second value says whether an older client of this profile was retired. */
export function clientForProfile(
  profile: ServerProfile,
  onCreated: (client: BmpClient) => void,
): { client: BmpClient; replaced: boolean } {
  const existing = pool.get(profile.id);
  if (existing && clientMatchesProfile(existing, profile)) return { client: existing, replaced: false };
  if (existing) existing.retire();
  const client = new BmpClient(
    normalizeUrl(profile.bmpUrl),
    profile.bmpUser,
    profile.bmpPass,
    profile.id,
    profile.commandAuthMode ?? 'portal',
    profile.commandAuthRevision ?? '',
  );
  pool.set(profile.id, client);
  onCreated(client);
  return { client, replaced: !!existing };
}

/** The pooled client of a profile, if one exists. */
export function pooledClient(profileId: string): BmpClient | undefined {
  return pool.get(profileId);
}

/** Retire and drop a profile's client (credentials changed, profile deleted). */
export function evictPooledClient(profileId: string): void {
  const c = pool.get(profileId);
  if (c) { c.retire(); pool.delete(profileId); }
}
