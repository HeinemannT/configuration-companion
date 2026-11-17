/**
 * Selecting a profile updates the panel at once, not only after the worker's
 * next connection push: the header shows the chosen profile with its last
 * known evidence (the per-profile snapshot), or "Checking…" when there is
 * none. The worker's CONNECTION_STATE then replaces it.
 */
import type { ConnectionState } from '../lib/types';
import { provisionalConnectionSnapshot } from '../lib/connection-snapshot';
import { unknownIdentityMap } from '../lib/identity-map';
import { S, sendMessage } from './state';

/** Event the panel shell listens to in order to repaint header and strip. */
export const CONNECTION_VIEW_CHANGED = 'crev:connection-view-changed';

function placeholder(profileId: string): ConnectionState {
  const profile = S.settings.profiles.find(p => p.id === profileId);
  let workspace: string | null = null;
  try {
    const path = new URL(profile?.bmpUrl ?? '').pathname.replace(/\/+$/, '');
    workspace = path ? path.slice(path.lastIndexOf('/') + 1) || null : null;
  } catch { /* unparsable URL: no workspace */ }
  return {
    display: 'checking',
    identities: unknownIdentityMap(profile?.commandAuthMode ?? 'portal'),
    version: null,
    responseMs: null,
    profileLabel: profile?.label ?? null,
    workspace,
    authError: null,
    detail: null,
    networkOffline: false,
    lastUpdate: Date.now(),
    validation: 'validating',
  };
}

/** Ask the worker to switch, and show the target profile immediately. */
export function selectProfileOptimistically(profileId: string): void {
  if (profileId === S.settings.activeProfileId) return;
  sendMessage({ type: 'SET_ACTIVE_PROFILE', profileId });
  S.settings = { ...S.settings, activeProfileId: profileId };
  const shown = placeholder(profileId);
  S.connState = shown;
  document.dispatchEvent(new CustomEvent(CONNECTION_VIEW_CHANGED));
  void chrome.storage.session.get('crev_conn_snapshot_by_profile').then((raw) => {
    const byProfile = raw.crev_conn_snapshot_by_profile as Record<string, unknown> | undefined;
    // Only while this selection is still the latest and no live push arrived.
    if (S.settings.activeProfileId !== profileId || S.connState !== shown || !byProfile) return;
    const restored = provisionalConnectionSnapshot(byProfile[profileId], S.settings);
    if (!restored) return;
    S.connState = restored;
    document.dispatchEvent(new CustomEvent(CONNECTION_VIEW_CHANGED));
  }).catch(() => { /* no snapshot: the placeholder stays until the worker answers */ });
}
