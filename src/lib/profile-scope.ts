/**
 * Every request is bound to its own server profile.
 *
 * Companion can be open on several servers at once (two browser windows, two
 * tabs). Each server profile gets its own *scope*: a BmpClient (command
 * session, capability probes, load governor and post lane), a connection
 * monitor, badge naming, object cache, history, favourites, script history
 * and style presets. A scope is created on demand and lives until its profile
 * is deleted. Focusing a window or activating a tab never replaces or resets a
 * scope and never changes where another window's requests go.
 *
 * A scope's `ctx` is a SwContext bound to that profile: `client`, `cache` and
 * friends are the profile's own, `settings.activeProfileId` reads as the
 * profile id (so environmentToken(ctx) names it), and `sendToPanel` /
 * `broadcastToContent` / `toast` reach only the panels and tabs of that
 * profile. The router hands it to handlers as `meta.ctx`.
 *
 * Which profile a sender belongs to (message-router.ts):
 * - a content script, or a Companion window embedded in a page: the profile
 *   whose address matches the tab's URL (longest match), else refused;
 * - the side panel: the profile its window shows (`displayProfileOf`), which
 *   follows the window's front tab unless the user picked one by hand;
 * - an extension page in its own tab (Access): the profile it names.
 *
 * "Active profile" is therefore a display concept per browser window;
 * `settings.activeProfileId` only remembers the last profile picked by hand,
 * for a fresh window.
 */
import type { SwContext } from './sw-context';
import { getCtx } from './sw-context';
import { SCRIPT_PAUSE_ACTION, SCRIPT_RESUME_ACTION, type InspectorMessage, type InspectorSettings } from './types';
import { ObjectCache } from './object-cache';
import { HistoryManager } from './history';
import { FavoritesManager } from './favorites';
import { ScriptHistoryManager } from './script-history';
import { StylePresetStore } from './style-presets';
import { clientForProfile, evictPooledClient } from './client-pool';
import {
  bindConnectionClient, computeConnectionState, disposeConnection, ensureConnectionMonitoring, resetConnectionState, restoreConnectionEvidence,
} from './connection';
import { disposeEnricher, incrementGeneration } from './enrichment';
import { isManualOverride, matchProfile, redactSettings } from './settings';
import { sendFireForget } from './messaging';
import { loadSentence } from './load-governor';
import { logActivity } from './activity';
import { logIdForError } from './toast-log';
import { log } from './logger';
import { forgetProfileSearch } from './code-feed';

// ── Tabs: which profile a page belongs to ───────────────────────

const tabUrls = new Map<number, string>();

export function noteTabUrl(tabId: number, url: string | undefined): void {
  if (url) tabUrls.set(tabId, url);
}

export function forgetTab(tabId: number): void {
  tabUrls.delete(tabId);
}

export function tabUrlOf(tabId: number): string | undefined {
  return tabUrls.get(tabId);
}

/** The profile a page URL belongs to (longest address match), or null. */
export function profileIdForUrl(url: string | undefined): string | null {
  if (!url) return null;
  return matchProfile(url, getCtx().settings.profiles)?.id ?? null;
}

export function profileOfTab(tabId: number): string | null {
  return profileIdForUrl(tabUrls.get(tabId));
}

// ── Windows: which profile a window shows ───────────────────────

interface WindowDisplay { profileId: string; manual: boolean }
const displayByWindow = new Map<number, WindowDisplay>();
const DISPLAY_KEY = 'crev_display_by_window';

function profileExists(id: string | undefined): id is string {
  return !!id && getCtx().settings.profiles.some(p => p.id === id);
}

/** The profile a browser window shows in its side panel and header. Falls
 *  back to the last profile picked by hand, then to the first profile. */
export function displayProfileOf(windowId: number | undefined): string {
  const shown = windowId != null ? displayByWindow.get(windowId)?.profileId : undefined;
  if (profileExists(shown)) return shown;
  const settings = getCtx().settings;
  if (profileExists(settings.activeProfileId)) return settings.activeProfileId;
  return settings.profiles[0]?.id ?? '';
}

export function isManualDisplay(windowId: number | undefined): boolean {
  return windowId != null && displayByWindow.get(windowId)?.manual === true;
}

/** Record what a window shows. Returns true when it changed. Writes nothing
 *  to settings. */
export function setWindowDisplay(windowId: number, profileId: string, manual: boolean): boolean {
  const previous = displayByWindow.get(windowId);
  if (previous?.profileId === profileId && previous.manual === manual) return false;
  displayByWindow.set(windowId, { profileId, manual });
  persistDisplay();
  return previous?.profileId !== profileId;
}

export function forgetWindow(windowId: number): void {
  if (displayByWindow.delete(windowId)) persistDisplay();
}

/** Windows that show `profileId`. */
export function windowsShowing(profileId: string, windowIds: Iterable<number>): number[] {
  return [...windowIds].filter(id => displayProfileOf(id) === profileId);
}

function persistDisplay(): void {
  const obj: Record<string, WindowDisplay> = {};
  for (const [k, v] of displayByWindow) obj[String(k)] = v;
  chrome.storage?.session?.set({ [DISPLAY_KEY]: obj })?.catch(e => log.swallow('scope:persistDisplay', e));
}

/** After a worker restart: rebuild tab URLs and what each window shows from
 *  the browser's real state, before the first message is routed. A window
 *  shows its front tab's profile unless the user had picked one by hand. */
export async function restoreWindowState(): Promise<void> {
  let saved: Record<string, WindowDisplay> = {};
  try {
    const raw = await chrome.storage.session.get(DISPLAY_KEY);
    saved = (raw[DISPLAY_KEY] as Record<string, WindowDisplay> | undefined) ?? {};
  } catch (e) { log.swallow('scope:restoreDisplay', e); }
  let windows: chrome.windows.Window[] = [];
  try { windows = await chrome.windows.getAll({ populate: true }); }
  catch (e) { log.swallow('scope:windows', e); }
  const settings = getCtx().settings;
  for (const w of windows) {
    if (w.id == null) continue;
    for (const tab of w.tabs ?? []) if (tab.id != null) noteTabUrl(tab.id, tab.url);
    const front = (w.tabs ?? []).find(t => t.active);
    const previous = saved[String(w.id)];
    const fromTab = front?.url ? matchProfile(front.url, settings.profiles)?.id : undefined;
    if (previous?.manual && profileExists(previous.profileId)) displayByWindow.set(w.id, previous);
    else if (fromTab && settings.autoDetect !== false) displayByWindow.set(w.id, { profileId: fromTab, manual: false });
    else if (profileExists(previous?.profileId)) displayByWindow.set(w.id, previous);
  }
  persistDisplay();
}

// ── Scopes ──────────────────────────────────────────────────────

export interface ProfileScope {
  readonly profileId: string;
  readonly ctx: SwContext;
  /** Stores loaded and connection evidence restored. */
  readonly ready: Promise<void>;
}

const scopes = new Map<string, ProfileScope>();

/** The scope of a stored profile, created on first use; null when no such
 *  profile exists. */
export function scopeFor(profileId: string | null | undefined): ProfileScope | null {
  if (!profileExists(profileId ?? undefined)) return null;
  const id = profileId as string;
  let scope = scopes.get(id);
  if (!scope) {
    scope = createScope(getCtx(), id);
    scopes.set(id, scope);
  }
  return scope;
}

export function liveScopes(): ProfileScope[] {
  return [...scopes.values()];
}

/** Settings changed: drop scopes of deleted profiles and let every client
 *  notice changed credentials (the client getter replaces it). */
export function refreshScopes(): void {
  for (const [id, scope] of scopes) {
    if (!profileExists(id)) {
      scopes.delete(id);
      evictPooledClient(id);
      disposeConnection(id);
      disposeEnricher(id);
      continue;
    }
    void scope.ctx.client; // replaces a client whose credentials changed
  }
}

/** Test hook. */
export function resetScopes(): void {
  scopes.clear();
  tabUrls.clear();
  displayByWindow.clear();
}

function createScope(base: SwContext, profileId: string): ProfileScope {
  const cache = new ObjectCache(profileId);
  const history = new HistoryManager(profileId);
  const favorites = new FavoritesManager(profileId);
  const scriptHistory = new ScriptHistoryManager(profileId);
  const stylePresets = new StylePresetStore(profileId);
  let viewBase: InspectorSettings | null = null;
  let view: InspectorSettings | null = null;

  const onClientReplaced = () => {
    // New command credentials: a fresh session, fresh capability probes and
    // fresh badge names for this profile only.
    incrementGeneration(ctx);
    resetConnectionState(ctx);
    ensureConnectionMonitoring(ctx);
    // What the code search kept was read with the old credentials' rights.
    forgetProfileSearch(profileId);
  };

  const ctx: SwContext = {
    profileId,
    get client() {
      const profile = base.settings.profiles.find(p => p.id === profileId);
      if (!profile?.bmpUrl) return null;
      const { client, replaced } = clientForProfile(profile, created => {
        created.cache = cache;
        const loadMessage = (state: import('./load-governor').LoadState) => {
          const notice = created.governor.memoryNotice();
          return { type: 'SERVER_LOAD' as const, state, sentence: loadSentence(state), ...(notice ? { notice } : {}), profileId };
        };
        created.setLoadObserver(state => sendFireForget(loadMessage(state)));
        // The script gauge: the background limit's start and end go to the
        // Log (once per server), the memory notice to the side panel status.
        created.governor.setNoticeListener(profileId, (text, kind) => {
          if (kind === 'background') logActivity('warn', text, undefined, { category: 'system', action: SCRIPT_PAUSE_ACTION, profileId }, profileId);
          else if (kind === 'background-end') logActivity('info', text, undefined, { category: 'system', action: SCRIPT_RESUME_ACTION, profileId }, profileId);
          else sendFireForget(loadMessage(created.governor.state()));
        });
        bindConnectionClient(created, profileId, ctx);
      });
      if (replaced) queueMicrotask(onClientReplaced);
      return client;
    },
    set client(_v) { /* a scope owns its client; see client-pool.ts */ },
    get hasPanel() { return base.hasPanel; },
    panelPortByWindow: base.panelPortByWindow,
    contentPorts: base.contentPorts,
    cache,
    history,
    favorites,
    scriptHistory,
    stylePresets,
    get settings() {
      const s = base.settings;
      if (s !== viewBase) {
        viewBase = s;
        view = s.activeProfileId === profileId ? s : { ...s, activeProfileId: profileId };
      }
      return view!;
    },
    set settings(v) {
      // Settings are global; the bound profile id never leaks into storage.
      base.settings = { ...v, activeProfileId: base.settings.activeProfileId };
    },
    inspectActiveByWindow: base.inspectActiveByWindow,
    blueprintActiveByWindow: base.blueprintActiveByWindow,
    blueprintTabByWindow: base.blueprintTabByWindow,
    isInspectActive: (windowId) => base.isInspectActive(windowId),
    setInspectActive: (windowId, active) => base.setInspectActive(windowId, active),
    persistBlueprintState: () => base.persistBlueprintState(),
    settingsReady: base.settingsReady,
    logActivity: (level, message, detail, meta) => logActivity(level, message, detail, meta, profileId),
    sendToPanel: (msg: InspectorMessage) => base.sendToProfilePanels?.(profileId, msg),
    sendToPanelByWindow: (windowId, msg) => base.sendToPanelByWindow(windowId, msg),
    sendToPanelByTab: (tabId, msg) => base.sendToPanelByTab(tabId, msg),
    broadcastToContent: (msg: InspectorMessage) => base.broadcastToProfileContent?.(profileId, msg),
    toast: (text, kind) => base.sendToProfilePanels?.(profileId, kind === 'error'
      ? { type: 'TOAST', text, kind, logId: logIdForError(text, profileId) }
      : { type: 'TOAST', text, kind }),
    scopeFor: (id) => base.scopeFor?.(id) ?? null,
    sendToProfilePanels: base.sendToProfilePanels,
    boundForTab: base.boundForTab,
    boundContexts: base.boundContexts,
    broadcastToProfileContent: base.broadcastToProfileContent,
  };

  const loadAll = [cache, history, favorites, scriptHistory, stylePresets]
    .map(store => store.load().catch(e => log.swallow(`scope:load:${profileId}`, e)));
  const ready = Promise.all(loadAll)
    .then(() => restoreConnectionEvidence(ctx))
    .then(() => {
      if (base.hasPanel || base.contentPorts.size > 0) ensureConnectionMonitoring(ctx);
    })
    .catch(e => log.swallow(`scope:ready:${profileId}`, e));

  return { profileId, ctx, ready };
}

/** Tell one window's side panel that it now shows `profileId`: its settings
 *  view, connection state and cache count. Requests elsewhere are untouched;
 *  nothing is written to settings. `manual` is true only when the user picked
 *  the profile by hand (only then does the panel say "Switched to …"). */
export async function publishWindowProfile(windowId: number, profileId: string, manual: boolean): Promise<void> {
  const base = getCtx();
  const profile = base.settings.profiles.find(p => p.id === profileId);
  const scope = scopeFor(profileId);
  if (!profile || !scope) return;
  const send = (msg: InspectorMessage) => base.sendToPanelByWindow(windowId, msg);
  send({ type: 'PROFILE_SWITCHED', profileId, label: profile.label, manual });
  send({ type: 'SETTINGS_DATA', settings: redactSettings(base.settings, profileId) });
  await scope.ready;
  if (displayProfileOf(windowId) !== profileId) return;
  send({ type: 'CACHE_STATS', count: scope.ctx.cache.size });
  send({ type: 'CONNECTION_STATE', state: computeConnectionState(scope.ctx) });
  ensureConnectionMonitoring(scope.ctx);
}

/** The window's front tab changed (focus, activation, navigation): show its
 *  server's profile, unless auto-detect is off or the user picked another
 *  profile by hand in this window moments ago. */
export function followFrontTab(windowId: number, url: string | undefined): void {
  const base = getCtx();
  if (!url || base.settings.autoDetect === false) return;
  const matched = matchProfile(url, base.settings.profiles);
  if (!matched) return;
  if (displayProfileOf(windowId) === matched.id) {
    if (isManualDisplay(windowId)) setWindowDisplay(windowId, matched.id, false);
    return;
  }
  if (isManualOverride(windowId, matched.id)) return;
  if (setWindowDisplay(windowId, matched.id, false)) void publishWindowProfile(windowId, matched.id, false);
}


/** The bound context of a tab's profile, stores loaded (SwContext.boundForTab). */
export async function boundForTab(tabId: number): Promise<SwContext | null> {
  const scope = scopeFor(profileOfTab(tabId));
  if (!scope) return null;
  await scope.ready;
  return scope.ctx;
}
