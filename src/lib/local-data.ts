/**
 * Local data the extension keeps outside its settings, and how to delete it.
 *
 * STORED_KEYS below is the one list of every key family the extension writes
 * to `chrome.storage.local` / `.session`, every IndexedDB database it opens,
 * and the page or extension-page web storage it uses (which the worker cannot
 * reach). Each entry says what deleting a server profile and "Reset all" do
 * with it. `local-data.test.ts` fails when a key literal in the source is not
 * covered by an entry, so a new key cannot be forgotten.
 *
 * - Deleting a server profile removes everything stored for that profile:
 *   object cache, history, favourites, script history, style presets, launch
 *   contexts opened for it, Access drafts, journals and recovery pointers,
 *   its schema, root-category and colour-set cache entries, its Access-mode
 *   recents and subjects, its sign-in tokens, its connection snapshot and
 *   Compare pivot, and the script ledger of its server when no other profile
 *   uses that server. (Its code index is removed by the caller.)
 * - "Reset all" removes every profile's working data: caches, history, script
 *   history, launch contexts, Access drafts and journals, Compare pivots, page
 *   diagnostics, script ledgers, window positions, the Blueprint ID recipe,
 *   Access-mode recents and subjects. Settings and their backup, server
 *   profiles, sign-ins, favourites, style presets and editor view
 *   preferences are kept on purpose.
 *
 * Launch contexts carry a `savedAt` and are swept at worker start once a
 * week old (sweepLaunchContexts).
 */
import { log } from './logger';
import { codeReadCache } from './code-scope-read';
import { clearFeeds } from './code-feed';
import { nameCatalogs } from './object-search';
import { forgetProfileColorSets } from './color-set-cache';
import { forgetProfile as forgetProfileSchemas } from './type-schema-cache';

/** What a purge does with one key family. */
export type OnProfile =
  | 'keep'
  /** The key embeds the profile id: `<key><profileId><suffix>`. */
  | 'profile-key'
  /** The value's `environment` (`profileId@server`) names the profile; a value without one goes too. */
  | 'env-value'
  /** The key ends with an environment token: `<key>profileId@server`. */
  | 'env-key'
  /** The value is a map whose keys are environment tokens or profile ids: drop that profile's entries. */
  | 'entries'
  /** The value is a map of records with a `serverId` environment token: drop that profile's records. */
  | 'server-id-entries'
  /** The key ends with a server URL: removed when no remaining profile uses that server. */
  | 'server-url-key'
  | 'remove';

export interface StoredKey {
  /** Exact key, or the prefix of a key family. */
  key: string;
  match: 'exact' | 'prefix';
  /** For 'profile-key': the text after the profile id (`crev_<id>_history`). */
  suffix?: string;
  area: 'local' | 'session' | 'indexeddb' | 'page' | 'extension-page';
  onProfile: OnProfile;
  onReset: 'keep' | 'remove';
  what: string;
}

const PROFILE_KEY = 'crev_';

/** Every key family the extension stores, and what each purge does with it. */
export const STORED_KEYS: readonly StoredKey[] = [
  // Settings: kept by both on purpose (profiles, AI key, preferences).
  { key: 'crev_settings', match: 'exact', area: 'local', onProfile: 'keep', onReset: 'keep', what: 'settings and server profiles' },
  { key: 'crev_settings_backup', match: 'exact', area: 'local', onProfile: 'keep', onReset: 'keep', what: 'settings backup' },
  // Per-profile stores (`crev_<profileId>_<suffix>`).
  ...(['cache', 'cache_date', 'history', 'script_history'] as const).map((suffix): StoredKey => ({
    key: PROFILE_KEY, match: 'prefix', suffix: `_${suffix}`, area: 'local', onProfile: 'profile-key', onReset: 'remove', what: `per-profile ${suffix}` })),
  ...(['favorites', 'style_presets', 'changes'] as const).map((suffix): StoredKey => ({
    key: PROFILE_KEY, match: 'prefix', suffix: `_${suffix}`, area: 'local', onProfile: 'profile-key', onReset: 'keep', what: `per-profile ${suffix} (kept by Reset all)` })),
  { key: 'crev_object_cache', match: 'exact', area: 'local', onProfile: 'remove', onReset: 'remove', what: 'object cache before profiles (legacy)' },
  { key: 'crev_inspect_active', match: 'exact', area: 'local', onProfile: 'remove', onReset: 'remove', what: 'global Inspect flag (legacy)' },
  { key: 'crev_activity', match: 'exact', area: 'local', onProfile: 'keep', onReset: 'remove', what: 'activity log' },
  // Launch contexts: per object, swept after a week.
  { key: 'crev_objectview_ctx_', match: 'prefix', area: 'local', onProfile: 'env-value', onReset: 'remove', what: 'object window launch context' },
  { key: 'crev_editor_ctx_', match: 'prefix', area: 'local', onProfile: 'env-value', onReset: 'remove', what: 'editor context (legacy local copy)' },
  { key: 'crev_editor_ctx_', match: 'prefix', area: 'session', onProfile: 'env-value', onReset: 'remove', what: 'Extended Code editor context' },
  { key: 'crev_cvo_studio_ctx_', match: 'prefix', area: 'local', onProfile: 'env-value', onReset: 'remove', what: 'CVO studio context' },
  { key: 'crev_editor_launch_', match: 'prefix', area: 'session', onProfile: 'env-value', onReset: 'remove', what: 'editor launch handoff' },
  { key: 'crev_editor_session_', match: 'prefix', area: 'session', onProfile: 'env-value', onReset: 'remove', what: 'editor session context' },
  // Server caches.
  { key: 'crev_color_sets_v2', match: 'exact', area: 'local', onProfile: 'entries', onReset: 'remove', what: 'colour-set cache (by environment)' },
  { key: 'crev_schema_cache_v2', match: 'exact', area: 'local', onProfile: 'server-id-entries', onReset: 'remove', what: 'type schema cache' },
  { key: 'crev_root_category_cache_v1', match: 'exact', area: 'local', onProfile: 'server-id-entries', onReset: 'remove', what: 'root category cache' },
  { key: 'crev_script_ledger:', match: 'prefix', area: 'local', onProfile: 'server-url-key', onReset: 'remove', what: 'script ledger of a server' },
  { key: 'crev_update_check', match: 'exact', area: 'local', onProfile: 'keep', onReset: 'remove', what: 'release check cache' },
  // Transport (beta): one draft per workspace (`crev_transport_draft:<environment>`).
  { key: 'crev_transport_draft:', match: 'prefix', area: 'local', onProfile: 'env-key', onReset: 'remove', what: 'Transport draft of a workspace' },
  // Transport (beta): what undoes the last apply to a target (`crev_transport_undo:<environment>|<target>`).
  { key: 'crev_transport_undo:', match: 'prefix', area: 'local', onProfile: 'env-key', onReset: 'remove', what: 'Transport undo of the last apply' },
  // Access.
  { key: 'access-pending:', match: 'prefix', area: 'local', onProfile: 'env-key', onReset: 'remove', what: 'Access apply recovery pointer' },
  { key: 'crev_access_mode_recents', match: 'exact', area: 'local', onProfile: 'entries', onReset: 'remove', what: 'Access mode recents (by profile)' },
  { key: 'crev_access_mode_subjects', match: 'exact', area: 'session', onProfile: 'env-value', onReset: 'remove', what: 'Access mode subjects' },
  { key: 'crev_access_mode_subject:', match: 'prefix', area: 'session', onProfile: 'env-key', onReset: 'remove', what: 'Access mode chosen subject' },
  { key: 'companion-access', match: 'exact', area: 'indexeddb', onProfile: 'env-key', onReset: 'remove', what: 'Access workspace drafts' },
  { key: 'companion-access-operations', match: 'exact', area: 'indexeddb', onProfile: 'env-value', onReset: 'remove', what: 'Access apply journals' },
  { key: 'crev-code-index', match: 'exact', area: 'indexeddb', onProfile: 'keep', onReset: 'keep', what: 'code index (cleared by the caller: clearCodeIndex)' },
  // Page-layer preferences (served to content scripts by handlers/page-prefs.ts).
  { key: 'crev_overlay_bounds_', match: 'prefix', area: 'local', onProfile: 'keep', onReset: 'remove', what: 'in-page window positions' },
  { key: 'crev_blueprint_portable_ids', match: 'exact', area: 'local', onProfile: 'keep', onReset: 'remove', what: 'Blueprint portable-ID recipe' },
  // Editor view preferences: kept like settings.
  ...['crev_editor_output_height', 'crev_editor_wrap', 'crev_editor_decode', 'crev_editor_table'].map((key): StoredKey => ({
    key, match: 'exact', area: 'local', onProfile: 'keep', onReset: 'keep', what: 'editor view preference' })),
  // Session: connection and sign-in.
  { key: 'crev_compare_pivot', match: 'prefix', area: 'session', onProfile: 'remove', onReset: 'remove', what: 'Compare pivot (legacy: no longer written)' },
  { key: 'crev_conn_snapshot_by_profile', match: 'exact', area: 'session', onProfile: 'entries', onReset: 'keep', what: 'connection snapshot per profile' },
  { key: 'crev_command_auth_v2_', match: 'prefix', area: 'session', onProfile: 'profile-key', suffix: '', onReset: 'keep', what: 'command sign-in token' },
  { key: 'crev_jwt_', match: 'prefix', area: 'session', onProfile: 'profile-key', suffix: '', onReset: 'keep', what: 'portal token' },
  { key: 'crev_page_diagnostics', match: 'exact', area: 'session', onProfile: 'remove', onReset: 'remove', what: 'page diagnostics' },
  { key: 'crev_connection_trace', match: 'exact', area: 'session', onProfile: 'keep', onReset: 'remove', what: 'connection trace (diagnostics)' },
  // Session: state of open windows and the running worker, rebuilt as the user works.
  ...['crev_conn_snapshot', 'crev_settings_snapshot', 'crev_debug', 'crev_connection_trace_enabled', 'crev_tab_detection',
    'crev_inspect_active_by_window', 'crev_blueprint_active_by_window', 'crev_blueprint_tab_by_window', 'crev_display_by_window',
    'crev_frame_served', 'crev_active_tab', 'crev_conn_recovery'].map((key): StoredKey => ({
    key, match: 'exact', area: 'session', onProfile: 'keep', onReset: 'keep', what: 'running state' })),
  // Web storage the worker cannot reach: a BMP page's own storage (written by
  // content scripts) and Companion pages' localStorage. Tab- or view-only state.
  { key: 'crev_bp_resume', match: 'exact', area: 'page', onProfile: 'keep', onReset: 'keep', what: 'Blueprint resume flag (page sessionStorage, one reload)' },
  { key: 'crev_bp_target:', match: 'prefix', area: 'page', onProfile: 'keep', onReset: 'keep', what: 'Blueprint edit target chosen for a page (page sessionStorage)' },
  { key: 'crev_inspect', match: 'exact', area: 'page', onProfile: 'keep', onReset: 'keep', what: 'Inspect on/off (page sessionStorage)' },
];

/** `crev_` text in the source that is not a storage key. */
export const NOT_STORAGE_KEYS: readonly string[] = [
  'crev_ai_evaluation', 'crev_ai_sidebar_evaluation', // AI evaluation campaign names
  'crev_qa_btn_show', // a BMP object ID quoted in a comment
];

const LAUNCH_PREFIXES = ['crev_objectview_ctx_', 'crev_editor_ctx_', 'crev_cvo_studio_ctx_'];
/** Launch contexts older than this are swept at worker start. */
export const LAUNCH_CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Whether an environment token (`profileId@server`) belongs to the profile. */
function ofProfile(environment: unknown, profileId: string): boolean {
  return typeof environment === 'string' && environment.startsWith(`${profileId}@`);
}

const sameServer = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

function entryMatches(entry: StoredKey, key: string): boolean {
  if (entry.match === 'exact') return key === entry.key;
  if (!key.startsWith(entry.key)) return false;
  return entry.suffix === undefined || entry.suffix === '' || key.endsWith(entry.suffix);
}

/** The entry that covers `key` in `area`: the most specific one (longest key + suffix). */
export function storedKeyFor(area: StoredKey['area'], key: string): StoredKey | undefined {
  let best: StoredKey | undefined;
  for (const entry of STORED_KEYS) {
    if (entry.area !== area || !entryMatches(entry, key)) continue;
    const score = entry.key.length + (entry.suffix?.length ?? 0) + (entry.match === 'exact' ? 1_000 : 0);
    const bestScore = best ? best.key.length + (best.suffix?.length ?? 0) + (best.match === 'exact' ? 1_000 : 0) : -1;
    if (score > bestScore) best = entry;
  }
  return best;
}

interface ProfileScope { profileId: string; serverUrl?: string; remainingServerUrls?: readonly string[] }

/** What deleting `scope.profileId` does with one stored key: remove it, rewrite its value, or keep it. */
function profilePurge(entry: StoredKey, key: string, value: unknown, scope: ProfileScope): { remove: true } | { rewrite: unknown } | null {
  const { profileId } = scope;
  switch (entry.onProfile) {
    case 'keep': return null;
    case 'remove': return { remove: true };
    case 'profile-key': {
      const rest = key.slice(entry.key.length);
      const suffix = entry.suffix ?? '';
      const id = suffix ? rest.slice(0, rest.length - suffix.length) : rest;
      return id === profileId ? { remove: true } : null;
    }
    case 'env-value': {
      const env = (value as { environment?: unknown } | null)?.environment;
      return env === undefined || ofProfile(env, profileId) ? { remove: true } : null;
    }
    case 'env-key': return ofProfile(key.slice(entry.key.length), profileId) ? { remove: true } : null;
    case 'entries': {
      if (!value || typeof value !== 'object') return null;
      const map = value as Record<string, unknown>;
      const drop = Object.keys(map).filter(k => k === profileId || ofProfile(k, profileId));
      if (!drop.length) return null;
      const rest = { ...map };
      for (const k of drop) delete rest[k];
      return { rewrite: rest };
    }
    case 'server-id-entries': {
      if (!value || typeof value !== 'object') return null;
      const map = value as Record<string, { serverId?: unknown } | null>;
      const drop = Object.keys(map).filter(k => ofProfile(map[k]?.serverId, profileId) || ofProfile(k, profileId));
      if (!drop.length) return null;
      const rest = { ...map };
      for (const k of drop) delete rest[k];
      return { rewrite: rest };
    }
    case 'server-url-key': {
      const url = key.slice(entry.key.length);
      if (!scope.serverUrl || !sameServer(url, scope.serverUrl)) return null;
      return (scope.remainingServerUrls ?? []).some(other => sameServer(other, url)) ? null : { remove: true };
    }
  }
}

function open(name: string, store: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Delete the records of one store whose key or value names the profile. */
async function deleteMatching(name: string, store: string, matches: (key: IDBValidKey, value: unknown) => boolean): Promise<void> {
  const db = await open(name, store);
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const cursor = tx.objectStore(store).openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        if (matches(c.key, c.value)) c.delete();
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error(`Could not clean ${name}`));
    });
  } finally { db.close(); }
}

function deleteDatabase(name: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise(resolve => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = () => resolve();
    // An open Access tab closes its handle on versionchange; do not wait forever.
    request.onblocked = () => setTimeout(resolve, 2_000);
  });
}

/** The records of each Access database that belong to a profile. */
const ACCESS_STORES: Record<string, { store: string; matches: (key: IDBValidKey, value: unknown, profileId: string) => boolean }> = {
  'companion-access': { store: 'workspaces', matches: (key, _v, id) => ofProfile(Array.isArray(key) ? key[1] : key, id) },
  'companion-access-operations': { store: 'applies', matches: (_k, value, id) => ofProfile((value as { environment?: unknown } | null)?.environment, id) },
};

async function purgeArea(area: 'local' | 'session', decide: (entry: StoredKey, key: string, value: unknown) => { remove: true } | { rewrite: unknown } | null): Promise<void> {
  const storage = chrome.storage[area];
  let all: Record<string, unknown>;
  try { all = await storage.get(null); } catch (e) { log.swallow(`localData:${area}:read`, e); return; }
  const remove: string[] = [];
  const rewrite: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(all)) {
    const entry = storedKeyFor(area, key);
    if (!entry) continue;
    const action = decide(entry, key, value);
    if (!action) continue;
    if ('remove' in action) remove.push(key); else rewrite[key] = action.rewrite;
  }
  try {
    if (remove.length) await storage.remove(remove);
    if (Object.keys(rewrite).length) await storage.set(rewrite);
  } catch (e) { log.swallow(`localData:${area}:write`, e); }
}

/** Remove everything stored for one server profile. `serverUrl` is the deleted
 *  profile's server and `remainingServerUrls` those of the profiles left: a
 *  server's script ledger goes only when no profile uses that server any more. */
export async function clearProfileLocalData(
  profileId: string,
  opts: { serverUrl?: string; remainingServerUrls?: readonly string[] } = {},
): Promise<void> {
  // The worker's memory copies of that profile's servers.
  codeReadCache.clear(profileId);
  clearFeeds(profileId);
  nameCatalogs.clear(profileId);
  const scope: ProfileScope = { profileId, ...opts };
  // Caches with a memory copy drop that profile's entries there first, so a
  // later write-back cannot restore them.
  await forgetProfileColorSets(profileId).catch(e => log.swallow('localData:colorSets', e));
  await forgetProfileSchemas(profileId).catch(e => log.swallow('localData:schemas', e));
  await purgeArea('local', (entry, key, value) => profilePurge(entry, key, value, scope));
  await purgeArea('session', (entry, key, value) => profilePurge(entry, key, value, scope));
  for (const entry of STORED_KEYS) {
    if (entry.area !== 'indexeddb' || entry.onProfile === 'keep') continue;
    const access = ACCESS_STORES[entry.key];
    if (!access) continue;
    await deleteMatching(entry.key, access.store, (key, value) => access.matches(key, value, profileId))
      .catch(e => log.swallow(`localData:${entry.key}`, e));
  }
}

/** "Reset all": remove every profile's working data (what STORED_KEYS marks
 *  `onReset: 'remove'`). Settings, profiles, sign-ins, favourites, style
 *  presets and editor view preferences stay. */
export async function clearAllLocalData(_profileIds: readonly string[] = []): Promise<void> {
  // The worker's memory copies: the code the live search read, the name catalogs, the colour sets.
  codeReadCache.clear();
  clearFeeds();
  nameCatalogs.clear();
  await forgetProfileColorSets().catch(e => log.swallow('localData:colorSets', e));
  const reset = (entry: StoredKey) => entry.onReset === 'remove' ? { remove: true as const } : null;
  await purgeArea('local', reset);
  await purgeArea('session', reset);
  await Promise.all(STORED_KEYS
    .filter(entry => entry.area === 'indexeddb' && entry.onReset === 'remove')
    .map(entry => deleteDatabase(entry.key)));
}

/** Drop per-object launch contexts saved more than a week ago (or without a
 *  `savedAt`, written before it existed). Runs at worker start. */
export async function sweepLaunchContexts(now = Date.now()): Promise<void> {
  let all: Record<string, unknown>;
  try { all = await chrome.storage.local.get(null); } catch (e) { log.swallow('localData:sweepRead', e); return; }
  const stale = Object.entries(all)
    .filter(([key]) => LAUNCH_PREFIXES.some(prefix => key.startsWith(prefix)))
    .filter(([, value]) => {
      const savedAt = (value as { savedAt?: unknown } | null)?.savedAt;
      return typeof savedAt !== 'number' || now - savedAt > LAUNCH_CONTEXT_MAX_AGE_MS;
    })
    .map(([key]) => key);
  if (stale.length) await chrome.storage.local.remove(stale).catch(e => log.swallow('localData:sweep', e));
}
