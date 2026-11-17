/**
 * Settings: load, migrate, store, redact.
 *
 * Stored settings are the user's server profiles, saved passwords and AI key.
 * They must never be lost silently:
 * - Nothing is written until the stored value was read successfully in this
 *   worker life. A failed read leaves the extension in the "settings could not
 *   be read" state (SETTINGS_STATUS failed) with Retry; defaults never
 *   overwrite stored data.
 * - Every write reports its outcome. A failed write leaves the stored value as
 *   it was and the in-memory settings are rolled back to match it.
 * - Before each overwrite the previous stored value is kept as one backup
 *   entry (`crev_settings_backup`). It is restored automatically only when the
 *   main entry is missing or unreadable and the backup is valid.
 *
 * Which server a request goes to is not decided here (profile-scope.ts);
 * `activeProfileId` is only the profile a fresh window starts with.
 */

import type { InspectorSettings, ServerProfile } from './types';
import { getCtx } from './sw-context';
import { clearCommandAuthSession } from './bmp-auth';
import { markPortalSignedOut, noteLoginEvidence, normalizeUrl, resetConnectionState, runAuthTest } from './connection';
import { log, errorMessage } from './logger';
import { MANUAL_OVERRIDE_DURATION } from './constants';
import { encrypt, decrypt, DecryptError } from './crypto';
import { setGrantReconciliationAllowed } from './site-access';
import { pooledClient } from './client-pool';

export const SETTINGS_KEY = 'crev_settings';
export const SETTINGS_BACKUP_KEY = 'crev_settings_backup';

let resolveSettings: () => void;
let settingsReadyPromise: Promise<void>;
/** Per-window manual override window, keyed `windowId|profileId`. Auto-detect
 *  in that window skips the profile while its override is active, so
 *  manually picking "dev" on the sbx tab only suppresses detection back to
 *  sbx, not to prod, and only in that window. */
const manualOverrideUntil = new Map<string, number>();

export function createSettingsReady(): { settingsReady: Promise<void>; resolveSettings: () => void } {
  settingsReadyPromise = new Promise<void>(r => { resolveSettings = r; });
  return { settingsReady: settingsReadyPromise, resolveSettings };
}

/** Apply schema migrations to a raw stored settings object, in place. Returns
 *  true if anything changed (so the caller can persist once). Pure + exported
 *  for unit testing — no ctx, no I/O.
 *  - v0 → v1: flat {bmpUrl,bmpUser,bmpPass} → a single profile in `profiles[]`.
 *  - v1 → v2: legacy auth strategy.
 *  - v2 → v3: AI settings.
 *  - v3 → v4: explicit portal-vs-stored command identity. */
export function migrateStoredSettings(s: Record<string, unknown>): boolean {
  let migrated = false;
  // The standalone Paint Format feature was removed in favor of Blueprint's
  // staged paintbrush. Drop its obsolete per-user copy mask on first load.
  if ('paintProps' in s) {
    delete s.paintProps;
    migrated = true;
  }
  if (!s.profiles && (s.bmpUrl || s.bmpUser)) {
    const id = crypto.randomUUID();
    s.profiles = [{ id, label: 'Default', bmpUrl: s.bmpUrl || '', bmpUser: s.bmpUser || '', bmpPass: s.bmpPass || '' }];
    s.activeProfileId = id;
    s.autoDetect = true;
    delete s.bmpUrl; delete s.bmpUser; delete s.bmpPass;
    s.schemaVersion = 1;
    migrated = true;
  }
  if (!s.schemaVersion) s.schemaVersion = 1;
  if ((s.schemaVersion as number) < 2 && Array.isArray(s.profiles)) {
    s.profiles = (s.profiles as Array<ServerProfile & { authMode?: 'session' | 'password' | 'auto' }>).map(p => ({
      ...p,
      authMode: p.authMode ?? (p.bmpPass?.trim() ? 'auto' : 'session'),
    }));
    s.schemaVersion = 2;
    migrated = true;
  }
  // v2 → v3: the optional `ai` field was introduced. No data reshaping needed
  // (it's absent until the user configures a provider), but bump the version so
  // stored data advances in lockstep with DEFAULT_SETTINGS.
  if ((s.schemaVersion as number) < 3) {
    s.schemaVersion = 3;
    migrated = true;
  }
  // v3 → v4: command authentication becomes an explicit identity choice.
  // Legacy `auto` intentionally migrates to stored when complete credentials
  // exist: these profiles were configured to use that account and must no
  // longer silently change actor based on browser-session availability.
  if ((s.schemaVersion as number) < 4) {
    if (Array.isArray(s.profiles)) {
      const notices = Array.isArray(s.commandAuthMigrationNotices)
        ? s.commandAuthMigrationNotices as Array<{ profileId: string; user: string }>
        : [];
      s.profiles = (s.profiles as Array<ServerProfile & { authMode?: 'session' | 'password' | 'auto' }>).map(p => {
        const completeStoredLogin = Boolean(p.bmpUser?.trim() && p.bmpPass?.trim());
        const commandAuthMode = p.authMode === 'password'
          || (p.authMode === 'auto' && completeStoredLogin)
          ? 'stored'
          : 'portal';
        if (p.authMode === 'auto' && completeStoredLogin
          && !notices.some(notice => notice.profileId === p.id)) {
          notices.push({ profileId: p.id, user: p.bmpUser.trim() });
        }
        const { authMode: _legacyAuthMode, ...profile } = p;
        return { ...profile, commandAuthMode, commandAuthRevision: p.commandAuthRevision || crypto.randomUUID() };
      });
      if (notices.length) s.commandAuthMigrationNotices = notices;
    }
    s.schemaVersion = 4;
    migrated = true;
  }
  return migrated;
}

// ── Load state ──────────────────────────────────────────────────

export type SettingsLoadStatus = 'loading' | 'loaded' | 'failed';

let status: SettingsLoadStatus = 'loading';
let statusError: string | null = null;
let backupAvailable = false;
/** The value in storage right now, exactly as stored (passwords encrypted).
 *  The next write keeps it as the backup entry. */
let lastStored: unknown = undefined;

export const SETTINGS_NOT_LOADED_ERROR =
  'Companion could not read its stored settings, so nothing was saved. Use Retry in the side panel first.';

type StatusListener = (s: { status: SettingsLoadStatus; error?: string; backupAvailable?: boolean }) => void;
const statusListeners: StatusListener[] = [];
/** The worker forwards status changes to the side panels. */
export function onSettingsStatus(fn: StatusListener): void { statusListeners.push(fn); }

export function settingsStatus(): { status: SettingsLoadStatus; error?: string; backupAvailable?: boolean } {
  return {
    status,
    ...(statusError ? { error: statusError } : {}),
    ...(status === 'failed' ? { backupAvailable } : {}),
  };
}

function publishStatus(): void {
  const s = settingsStatus();
  for (const fn of statusListeners) {
    try { fn(s); } catch (e) { log.swallow('settings:statusListener', e); }
  }
}

/** True only after stored settings were read and applied without error in
 *  this worker life. Writes and grant reconciliation wait for it. */
export function settingsLoadedCleanly(): boolean {
  return status === 'loaded';
}

/** A stored value that can be parsed as settings. */
function readable(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const profiles = (raw as Record<string, unknown>).profiles;
  return profiles === undefined || Array.isArray(profiles);
}

/** Decrypt one stored password. An unreadable value (another extension ID,
 *  corrupted storage) is dropped and flagged; the ciphertext is never used as
 *  a password and never written back. */
export async function decryptProfilePassword(p: ServerProfile): Promise<ServerProfile> {
  if (!p.bmpPass) return { ...p, bmpPass: '' };
  try {
    const bmpPass = await decrypt(p.bmpPass);
    const { passwordUnreadable: _cleared, ...rest } = p;
    return { ...rest, bmpPass };
  } catch (e) {
    if (!(e instanceof DecryptError)) throw e;
    log.warn('settings:decrypt', e, `stored password for ${p.label} cannot be decrypted; it must be entered again`);
    return { ...p, bmpPass: '', passwordUnreadable: true };
  }
}

/** Parse a stored value without touching it (it may become the backup).
 *  Throws when it cannot be used; nothing is assigned then. */
async function parseStored(raw: Record<string, unknown>, base: InspectorSettings): Promise<{ settings: InspectorSettings; migrated: boolean }> {
  const s = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  let migrated = migrateStoredSettings(s);
  const merged = { ...base, ...s } as InspectorSettings;
  if (!Array.isArray(merged.profiles)) merged.profiles = [];
  const decrypted = await Promise.all(merged.profiles.map(decryptProfilePassword));
  // A newly unreadable password is persisted as "needs entry" so the
  // ciphertext is gone from storage, not merely ignored in memory.
  if (decrypted.some((p, i) => p.passwordUnreadable && merged.profiles[i].bmpPass)) migrated = true;
  return { settings: { ...merged, profiles: decrypted }, migrated };
}

/** Apply stored settings. `readOk` is false when the storage read itself
 *  failed. `backup` is the stored backup entry, used only when the main
 *  entry is missing or unreadable. Returns whether settings are loaded. */
export async function loadSettingsFrom(stored: unknown, readOk = true, backup?: unknown): Promise<boolean> {
  const ctx = getCtx();
  let ok = false;
  let restored = false;
  let migrated = false;
  try {
    if (!readOk) throw new Error('The browser could not read the stored settings.');
    let source: unknown = stored;
    if (stored == null || !readable(stored)) {
      if (readable(backup)) {
        source = backup;
        restored = true;
      } else if (stored != null) {
        throw new Error('The stored settings are not in a readable format.');
      }
    }
    if (source != null) {
      const parsed = await parseStored(source as Record<string, unknown>, ctx.settings);
      ctx.settings = parsed.settings;
      migrated = parsed.migrated;
      lastStored = source;
    } else {
      lastStored = undefined; // first start: nothing stored, nothing to back up
    }
    ok = true;
  } catch (e) {
    statusError = errorMessage(e);
    backupAvailable = readable(backup);
    log.warn('settings:load', e, 'stored settings could not be read; nothing will be written until they are');
    if (backupAvailable) {
      log.info('settings:backup', `A backup of the previous settings exists (${SETTINGS_BACKUP_KEY}); it is used automatically only when the main entry is missing or unreadable.`);
    }
  }
  status = ok ? 'loaded' : 'failed';
  if (ok) {
    statusError = null;
    backupAvailable = false;
    snapshotSettings();
    if (restored) {
      log.warn('settings:restored', `The stored settings were missing or unreadable; restored them from ${SETTINGS_BACKUP_KEY}.`);
      try { ctx.logActivity('warn', 'Settings restored from the backup', 'The stored settings were missing or unreadable, so the previous copy was used.', { category: 'system', action: 'settings-restored' }); }
      catch (e) { log.swallow('settings:restoredLog', e); }
    }
    // Persist a migration or a restore once so stored data advances.
    if (migrated || restored) void saveSettings();
  }
  setGrantReconciliationAllowed(ok);
  resolveSettings?.();
  publishStatus();
  return ok;
}

/** Read the stored settings (and backup) and apply them. Used at boot and by
 *  Retry. A second call after a clean load does nothing. */
export async function loadStoredSettings(): Promise<boolean> {
  if (status === 'loaded') return true;
  let readOk = true;
  const raw = await chrome.storage.local.get([SETTINGS_KEY, SETTINGS_BACKUP_KEY]).catch(e => {
    readOk = false;
    log.swallow('settings:read', e);
    return {} as Record<string, unknown>;
  }) as Record<string, unknown>;
  return loadSettingsFrom(raw[SETTINGS_KEY], readOk, raw[SETTINGS_BACKUP_KEY]);
}

// ── Writes ──────────────────────────────────────────────────────

export type SettingsWriteResult = { ok: true } | { ok: false; error: string };

let saveChain: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = saveChain.catch(() => { /* a failed write must not block the next */ }).then(task);
  saveChain = next;
  return next;
}

async function writeCurrent(): Promise<SettingsWriteResult> {
  if (status !== 'loaded') return { ok: false, error: SETTINGS_NOT_LOADED_ERROR };
  try {
    const settings = getCtx().settings;
    const profiles = await Promise.all(settings.profiles.map(async p => {
      const { hasStoredPassword: _has, clearPassword: _clear, ...rest } = p;
      return { ...rest, bmpPass: p.bmpPass ? await encrypt(p.bmpPass) : '' };
    }));
    const next = { ...settings, profiles };
    const write: Record<string, unknown> = { [SETTINGS_KEY]: next };
    // One backup entry: the value this write replaces.
    if (lastStored != null) write[SETTINGS_BACKUP_KEY] = lastStored;
    await chrome.storage.local.set(write);
    lastStored = next;
    return { ok: true };
  } catch (e) {
    log.warn('settings:save', e, 'settings write failed; stored settings unchanged');
    return { ok: false, error: `Companion could not store the settings (${errorMessage(e)}). Nothing was changed.` };
  }
}

/** Store the settings in memory as they are. Refused until settings were
 *  loaded; the result says whether the write happened. */
export function saveSettings(): Promise<SettingsWriteResult> {
  return serial(writeCurrent);
}

/** Change settings and store them. On a failed (or refused) write the
 *  in-memory settings return to the stored ones, so what Companion shows is
 *  what survives a restart. */
export function updateSettings(change: (current: InspectorSettings) => InspectorSettings): Promise<SettingsWriteResult> {
  return serial(async () => {
    if (status !== 'loaded') return { ok: false as const, error: SETTINGS_NOT_LOADED_ERROR };
    const ctx = getCtx();
    const previous = ctx.settings;
    ctx.settings = change(previous);
    const result = await writeCurrent();
    if (!result.ok) ctx.settings = previous;
    else snapshotSettings();
    return result;
  });
}

// ── Redaction ───────────────────────────────────────────────────

/** Settings as any page may see them: no stored password (a flag says one
 *  exists) and no AI key (the 'set' marker says one is configured).
 *  `activeProfileId` is the profile the receiving window shows. */
export function redactSettings(s: InspectorSettings, activeProfileId: string = s.activeProfileId): InspectorSettings {
  return {
    ...s,
    activeProfileId,
    profiles: s.profiles.map(p => {
      const { clearPassword: _clear, ...rest } = p;
      return { ...rest, bmpPass: '', hasStoredPassword: !!p.bmpPass };
    }),
    ...(s.ai ? { ai: { ...s.ai, apiKeyEnc: s.ai.apiKeyEnc ? 'set' : '' } } : {}),
  };
}

/** Snapshot settings to session storage for instant panel boot, redacted:
 *  someone who reads chrome.storage.session never sees credentials. */
export function snapshotSettings(): void {
  const s = getCtx().settings;
  chrome.storage.session.set({ crev_settings_snapshot: redactSettings(s) }).catch(e => log.swallow('settings:snapshot', e));
}

// ── Profiles ────────────────────────────────────────────────────

/** Best-match profile for a page URL, or null. Origins must match exactly and
 *  paths match on a segment boundary, so `/CorpoWebserver` includes all of
 *  `/CorpoWebserver/...` without also claiming `/CorpoWebserverTest`.
 *  Among valid matches the most specific (longest) base path wins. */
export function matchProfile(pageUrl: string, profiles: ServerProfile[]): ServerProfile | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }

  let best: { profile: ServerProfile; len: number } | null = null;
  for (const p of profiles) {
    let base: URL;
    try {
      base = new URL(normalizeUrl(p.bmpUrl));
    } catch {
      continue;
    }
    if (page.origin !== base.origin) continue;

    const basePath = base.pathname.replace(/\/+$/, '') || '/';
    const pathMatches = basePath === '/'
      || page.pathname === basePath
      || page.pathname.startsWith(`${basePath}/`);
    if (pathMatches && (!best || basePath.length > best.len)) {
      best = { profile: p, len: basePath.length };
    }
  }
  return best?.profile ?? null;
}

/** Suppress auto-detect back to `suppressedProfileId` in one window for
 *  MANUAL_OVERRIDE_DURATION: the user picked another profile by hand there. */
export function setManualOverride(windowId: number | undefined, suppressedProfileId: string): void {
  if (!suppressedProfileId) return;
  manualOverrideUntil.set(`${windowId ?? ''}|${suppressedProfileId}`, Date.now() + MANUAL_OVERRIDE_DURATION);
}

export function isManualOverride(windowId: number | undefined, profileId: string): boolean {
  return (manualOverrideUntil.get(`${windowId ?? ''}|${profileId}`) ?? 0) > Date.now();
}

/** The bound context of a profile, when the worker has one (tests: none). */
function scopeCtx(profileId: string) {
  return getCtx().scopeFor?.(profileId) ?? undefined;
}

/** When a BMP session cookie is removed (the user logged out, or it expired),
 *  any profile whose LIVE connection was borrowed from that session must drop
 *  its minted token chain — otherwise the extension keeps Configuration Access
 *  after the user logged out.
 *
 *  - Only `explicit` (logout / API removal) and `expired` (true expiry) mean the
 *    session is gone; `overwrite` / `expired_overwrite` / `evicted` are not.
 *  - Gated on `settingsReady`.
 *  - Each candidate profile's own cookie is RE-PROBED via
 *    `chrome.cookies.get({url: bmpUrl})`, which applies host+path scoping.
 *  - Only portal-mode command auth is borrowed from the browser session. */
export async function handleSessionCookieRemoved(info: chrome.cookies.CookieChangeInfo): Promise<void> {
  if (info.cookie.name !== 'JSESSIONID' || !info.removed) return;
  if (info.cause !== 'explicit' && info.cause !== 'expired') return;

  const ctx = getCtx();
  await ctx.settingsReady;

  for (const p of ctx.settings.profiles.map(profile => ({ ...profile }))) {
    const client = pooledClient(p.id);
    const epoch = client?.auth.sessionEpoch;
    const borrowed = (p.commandAuthMode ?? 'portal') === 'portal';

    let stillPresent: boolean;
    try {
      stillPresent = (await chrome.cookies.get({ url: normalizeUrl(p.bmpUrl), name: 'JSESSIONID' })) != null;
    } catch (e) {
      // Observation failure is unknown, not proof of logout.
      log.warn('settings:cookieReprobe', e, 'cookie re-probe failed; preserving borrowed session');
      continue;
    }
    if (stillPresent) continue;  // the cookie that changed wasn't this profile's
    const current = ctx.settings.profiles.find(profile => profile.id === p.id);
    if (!current || pooledClient(p.id) !== client || client?.auth.sessionEpoch !== epoch
      || (['bmpUrl', 'bmpUser', 'bmpPass', 'commandAuthMode', 'commandAuthRevision'] as const)
        .some(field => current[field] !== p[field])) continue;

    const bound = scopeCtx(p.id);
    // In tests without bound contexts only the active profile has a monitor.
    const monitored = bound ?? (p.id === ctx.settings.activeProfileId ? undefined : null);
    if (!borrowed) {
      if (monitored !== null) markPortalSignedOut(monitored);
      continue;
    }

    if (client) client.logout();
    else void clearCommandAuthSession(p.id);
    log.info('settings:sessionCookieGone', `BMP session ended for ${p.label}; cleared the borrowed token`);
    if (monitored !== null) {
      resetConnectionState(monitored);
      // The page overlay depends on this state too: re-check with or
      // without an open side panel so "Sign in to BMP" appears at once.
      void runAuthTest('evidence-change', monitored);
    }
  }
}

/** All BMP session-cookie changes. Removal tears borrowed sessions down; a
 *  new session cookie for a portal-mode profile is login evidence that lets
 *  its "Sign in to BMP" state reconnect without a click. */
export async function handleSessionCookieChanged(info: chrome.cookies.CookieChangeInfo): Promise<void> {
  if (info.cookie.name !== 'JSESSIONID') return;
  if (info.removed) {
    await handleSessionCookieRemoved(info);
    return;
  }
  const ctx = getCtx();
  await ctx.settingsReady;
  for (const profile of ctx.settings.profiles) {
    if (!profile.bmpUrl || (profile.commandAuthMode ?? 'portal') !== 'portal') continue;
    const bound = scopeCtx(profile.id);
    if (!bound && profile.id !== ctx.settings.activeProfileId) continue;
    let applies = false;
    try {
      const current = await chrome.cookies.get({ url: normalizeUrl(profile.bmpUrl), name: 'JSESSIONID' });
      applies = current?.value === info.cookie.value;
    } catch (e) {
      log.swallow('settings:cookieAdded', e);
    }
    if (applies) noteLoginEvidence(bound);
  }
}
