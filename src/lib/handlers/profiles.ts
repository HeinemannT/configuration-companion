/**
 * Profile and settings handlers.
 *
 * Settings are global (getCtx()); which profile a window shows is per window
 * (profile-scope.ts). Settings sent to a page are always redacted: no stored
 * password, no AI key. Every write reports whether it was stored.
 */

import { clearCodeIndex } from '../code-index-service';
import { register, type HandlerMeta } from '../handler-registry';
import { ctxOf, getCtx, type SwContext } from '../sw-context';
import {
  loadStoredSettings, matchProfile, redactSettings, setManualOverride, settingsStatus, snapshotSettings, updateSettings,
} from '../settings';
import { evictPooledClient } from '../client-pool';
import { computeConnectionState, notConfiguredConnectionState, validateConnection } from '../connection';
import { reconcileProfileOrigins, syncRegisteredScripts } from '../site-access';
import { log } from '../logger';
import { parseServerUrl } from '../server-url';
import { saveVerdict } from '../connection-copy';
import {
  displayProfileOf, publishWindowProfile, refreshScopes, restoreWindowState, scopeFor, setWindowDisplay, windowsShowing,
} from '../profile-scope';
import { clearProfileLocalData } from '../local-data';
import type { InspectorSettings, ServerProfile } from '../types';

/** The URL of the active tab in `windowId` (or the last-focused window). */
async function activeTabUrl(windowId: number | undefined): Promise<string | undefined> {
  try {
    const [tab] = await chrome.tabs.query(windowId != null
      ? { active: true, windowId }
      : { active: true, lastFocusedWindow: true });
    return tab?.url;
  } catch { return undefined; }
}

/** Keep host grants equal to BMP profile origins plus the selected AI provider origin.
 *  Profile changes revoke orphaned grants and re-sync content-script registrations. */
const reconcileAccess = (): void => {
  const ctx = getCtx();
  void reconcileProfileOrigins(ctx.settings.profiles.map(p => p.bmpUrl), ctx.settings.ai);
};

/** The profile the requesting window shows. */
function shownProfile(meta: HandlerMeta | undefined): string {
  return meta?.ctx?.profileId ?? displayProfileOf(meta?.panelWindowId);
}

/** Settings as the requesting window may see them. */
function settingsFor(meta: HandlerMeta | undefined): InspectorSettings {
  const settings = getCtx().settings;
  return redactSettings(settings, getCtx().scopeFor ? shownProfile(meta) : settings.activeProfileId);
}

/** Tell every panel what it may see after a settings change. */
function publishSettings(): void {
  const base = getCtx();
  for (const windowId of base.panelPortByWindow.keys()) {
    base.sendToPanelByWindow(windowId, { type: 'SETTINGS_DATA', settings: redactSettings(base.settings, displayProfileOf(windowId)) });
  }
}

register('GET_SETTINGS', (_msg, respond, meta) => {
  respond({ type: 'SETTINGS_DATA', settings: settingsFor(meta) });
  if (settingsStatus().status !== 'loaded') respond({ type: 'SETTINGS_STATUS', ...settingsStatus() });
  snapshotSettings();
});

register('RETRY_SETTINGS_LOAD', async (_msg, respond, meta) => {
  const ok = await loadStoredSettings();
  if (ok) {
    await restoreWindowState();
    refreshScopes();
    reconcileAccess();
    void syncRegisteredScripts();
  }
  respond({ type: 'SETTINGS_STATUS', ...settingsStatus() });
  respond({ type: 'SETTINGS_DATA', settings: settingsFor(meta) });
  if (ok) publishSettings();
});

/** Settings a page may change with SAVE_SETTINGS. Profiles, passwords and
 *  the AI key have their own messages. */
const PAGE_SETTINGS = new Set<keyof InspectorSettings>(['autoDetect', 'enrichMode', 'saveTarget', 'commandAuthMigrationNotices']);

register('SAVE_SETTINGS', async (msg, respond, meta) => {
  const base = getCtx();
  const change: Partial<InspectorSettings> = {};
  for (const [k, v] of Object.entries(msg.settings)) {
    if (PAGE_SETTINGS.has(k as keyof InspectorSettings)) (change as Record<string, unknown>)[k] = v;
    else log.warn('handler:saveSettings', `ignored setting ${k}`);
  }
  const prevMode = base.settings.enrichMode;
  const result = await updateSettings(current => ({ ...current, ...change }));
  if (!result.ok) {
    respond({ type: 'SETTINGS_SAVE_FAILED', error: result.error });
    respond({ type: 'SETTINGS_DATA', settings: settingsFor(meta) });
    ctxOf(meta).toast(result.error, 'error');
    return;
  }
  if (base.settings.enrichMode !== prevMode) {
    base.broadcastToContent({ type: 'ENRICH_MODE', mode: base.settings.enrichMode });
  }
  publishSettings();
});

register('SAVE_PROFILE', async (msg, respond, meta) => {
  const base = getCtx();
  // The panel normalises too, but the worker owns the stored value: a
  // scheme-less or deep-link URL must never reach storage or requests.
  const parsed = parseServerUrl(msg.profile.bmpUrl);
  if (!parsed.ok) {
    respond({ type: 'PROFILE_VERDICT', profileId: msg.profile.id, ok: false, text: parsed.error, detail: null });
    return;
  }
  const previous = base.settings.profiles.find(p => p.id === msg.profile.id);
  // A page never holds the stored password. An empty password on an existing
  // profile keeps the stored one; `clearPassword` removes it.
  const bmpPass = msg.profile.bmpPass
    ? msg.profile.bmpPass
    : msg.profile.clearPassword ? '' : previous?.bmpPass ?? '';
  const { hasStoredPassword: _has, clearPassword: _clear, passwordUnreadable: _unreadable, ...sent } = msg.profile;
  const incoming: ServerProfile = { ...sent, bmpUrl: parsed.url, bmpPass };
  const authChanged = !previous
    || previous.bmpUrl !== incoming.bmpUrl
    || previous.bmpUser !== incoming.bmpUser
    || previous.bmpPass !== incoming.bmpPass
    || (previous.commandAuthMode ?? 'portal') !== (incoming.commandAuthMode ?? 'portal');
  const profile: ServerProfile = {
    ...incoming,
    commandAuthMode: incoming.commandAuthMode ?? 'portal',
    commandAuthRevision: authChanged
      ? crypto.randomUUID()
      : previous?.commandAuthRevision ?? incoming.commandAuthRevision ?? crypto.randomUUID(),
    // Still unreadable only while no new password was entered.
    ...(previous?.passwordUnreadable && !incoming.bmpPass ? { passwordUnreadable: true } : {}),
  };
  // A server added or edited while its BMP page is in front is the one the
  // user means to work with: this window shows it.
  const frontUrl = await activeTabUrl(meta?.panelWindowId);
  let showHere = false;
  const result = await updateSettings(current => {
    const profiles = [...current.profiles];
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
    showHere = profiles.length === 1 || (!!frontUrl && matchProfile(frontUrl, profiles)?.id === profile.id);
    const keepLast = !showHere && current.activeProfileId && profiles.some(p => p.id === current.activeProfileId);
    // The profile last chosen (here: saved while its page is in front) is
    // the one a fresh window starts with.
    return { ...current, profiles, activeProfileId: keepLast ? current.activeProfileId : profile.id };
  });
  if (!result.ok) {
    respond({ type: 'SETTINGS_DATA', settings: settingsFor(meta) });
    respond({ type: 'PROFILE_VERDICT', profileId: profile.id, ok: false, text: `Not saved. ${result.error}`, detail: null });
    return;
  }
  reconcileAccess(); // an edited URL orphans its old origin; the new one was requested in the panel
  refreshScopes();   // a changed login replaces this profile's client (and only it)
  const windowId = meta?.panelWindowId;
  if (windowId != null && showHere && setWindowDisplay(windowId, profile.id, false)) {
    await publishWindowProfile(windowId, profile.id, false);
  }
  respond({ type: 'SETTINGS_DATA', settings: settingsFor(meta) });
  publishSettings();
  snapshotSettings();

  // Verdict: test the saved profile now and say whether it works.
  const shownHere = getCtx().scopeFor ? displayProfileOf(windowId) === profile.id : getCtx().settings.activeProfileId === profile.id;
  const scope = scopeFor(profile.id);
  if (shownHere) {
    const bound: SwContext | undefined = scope?.ctx;
    if (scope) await scope.ready;
    await validateConnection('explicit', bound);
    const state = computeConnectionState(bound);
    respond({ type: 'PROFILE_VERDICT', profileId: profile.id, ...saveVerdict(state) });
  } else {
    respond({
      type: 'PROFILE_VERDICT',
      profileId: profile.id,
      ok: true,
      text: 'Saved. Select this server to connect to it.',
      detail: null,
    });
  }
});

register('DELETE_PROFILE', async (msg, respond, meta) => {
  const base = getCtx();
  const shownBefore = windowsShowing(msg.profileId, base.panelPortByWindow.keys());
  const deletedServer = base.settings.profiles.find(p => p.id === msg.profileId)?.bmpUrl;
  const result = await updateSettings(current => {
    const profiles = current.profiles.filter(p => p.id !== msg.profileId);
    const activeProfileId = current.activeProfileId === msg.profileId ? profiles[0]?.id ?? '' : current.activeProfileId;
    return { ...current, profiles, activeProfileId };
  });
  if (!result.ok) {
    ctxOf(meta).toast(`Not removed. ${result.error}`, 'error');
    respond({ type: 'SETTINGS_DATA', settings: settingsFor(meta) });
    return;
  }
  // Drop the pooled client, monitor and badge state of the deleted profile.
  evictPooledClient(msg.profileId);
  refreshScopes();
  void clearProfileLocalData(msg.profileId, {
    serverUrl: deletedServer,
    remainingServerUrls: getCtx().settings.profiles.map(p => p.bmpUrl),
  }).catch(e => log.swallow('handler:cleanupProfile', e));
  void clearCodeIndex(msg.profileId);
  reconcileAccess(); // revoke the deleted profile's origin (unless another profile shares it)
  respond({ type: 'SETTINGS_DATA', settings: settingsFor(meta) });
  publishSettings();
  for (const windowId of shownBefore) {
    const next = displayProfileOf(windowId);
    if (next) void publishWindowProfile(windowId, next, false);
  }
  snapshotSettings();
});

/** The user picked a profile by hand in one window's panel. That window
 *  shows it (and says "Switched to …"); pages keep their own servers; the
 *  pick is remembered as the profile a fresh window starts with. */
register('SET_ACTIVE_PROFILE', async (msg, respond, meta) => {
  const base = getCtx();
  const profile = base.settings.profiles.find(p => p.id === msg.profileId);
  if (!profile) return;
  const windowId = meta?.panelWindowId;
  const previousId = base.scopeFor ? displayProfileOf(windowId) : base.settings.activeProfileId;
  if (previousId === msg.profileId) {
    respond({ type: 'SETTINGS_DATA', settings: settingsFor(meta) });
    return;
  }
  // Suppress auto-detect back to what the user just switched away from, in
  // this window only.
  if (previousId) setManualOverride(windowId, previousId);
  if (windowId != null) setWindowDisplay(windowId, msg.profileId, true);
  const saved = await updateSettings(current => ({ ...current, activeProfileId: msg.profileId }));
  if (!saved.ok) log.warn('handler:setActiveProfile', saved.error);
  if (windowId != null) await publishWindowProfile(windowId, msg.profileId, true);
  else base.sendToPanel({ type: 'PROFILE_SWITCHED', profileId: msg.profileId, label: profile.label, manual: true });
  respond({ type: 'SETTINGS_DATA', settings: redactSettings(base.settings, msg.profileId) });
});

/** A request without a stored profile (a page Companion is not set up for). */
function unbound(meta: HandlerMeta | undefined): boolean {
  const ctx = ctxOf(meta);
  return !ctx.profileId && !!ctx.scopeFor;
}

register('CONNECTION_TEST', async (_msg, respond, meta) => {
  if (unbound(meta)) { respond({ type: 'CONNECTION_STATE', state: notConfiguredConnectionState() }); return; }
  const ctx = ctxOf(meta);
  await validateConnection('explicit', ctx);
  // Always answer, even when the state did not change: the panel's spinner
  // waits for this reply, and a deduplicated broadcast would never arrive.
  respond({ type: 'CONNECTION_STATE', state: computeConnectionState(ctx) });
});

register('GET_CONNECTION_STATE', (_msg, respond, meta) => {
  if (unbound(meta)) { respond({ type: 'CONNECTION_STATE', state: notConfiguredConnectionState() }); return; }
  respond({ type: 'CONNECTION_STATE', state: computeConnectionState(ctxOf(meta)) });
});
