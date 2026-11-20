/**
 * Background service worker — thin entry point.
 * State, context, port management, boot sequence.
 * All logic delegated to focused modules.
 */

import type { InspectorMessage, InspectorSettings } from './lib/types';
import { DEFAULT_SETTINGS } from './lib/types';
import { ObjectCache } from './lib/object-cache';
import { HistoryManager } from './lib/history';
import { FavoritesManager } from './lib/favorites';
import { ScriptHistoryManager } from './lib/script-history';
import { StylePresetStore } from './lib/style-presets';
import type { SwContext } from './lib/sw-context';
import { setSwContext } from './lib/sw-context';
import { log } from './lib/logger';
import { BUILD_ID } from './lib/build-info';

// Modules
import { loadTabDetection, getTabDetection } from './lib/detection';
import { computeConnectionState, ensureConnectionMonitoring, noteLoginEvidence, pollHealth, runRecoveryCheck, setBadgeOwner, validateConnection } from './lib/connection';
import { RECOVERY_ALARM } from './lib/connection-recovery';
import { releaseTab } from './lib/enrichment';
import { isExtensionPageSender, watchFrameTabs } from './lib/sender-trust';
import { acceptKeepAlivePort, KEEPALIVE_PORT } from './lib/keep-alive';
import { holdFeedForPort } from './lib/code-index-service';
import { ensureContentScript } from './lib/content-script-injection';
import { setFrameTabPreparer } from './lib/frame-launcher';

// Every window opened from a tab (toolbar, shortcuts, context menu, side
// panel) first injects the content script a tab loaded before an extension
// reload lacks.
setFrameTabPreparer(ensureContentScript);
import { shouldAcceptPanelClaim, type PanelClaim } from './lib/panel-ownership';
import { restoreActivity, logActivity } from './lib/activity';
import { logPageDiagnostic } from './lib/page-diagnostics';
import { registerContextMenus, POINT_TELL_MENU_ID, NEW_PAGE_MENU_ID } from './lib/context-menus';
import { newPageHere, togglePointTell } from './lib/handlers/point-tell';
import { createSettingsReady, loadStoredSettings, handleSessionCookieChanged, settingsLoadedCleanly, onSettingsStatus, settingsStatus, redactSettings } from './lib/settings';
import { registerTabListeners, sendPageInfoToPanel, lastFocusedWindowId, seedActiveTabs } from './lib/tab-awareness';
import { boundForTab, displayProfileOf, forgetWindow, liveScopes, noteTabUrl, profileOfTab, restoreWindowState, scopeFor } from './lib/profile-scope';
import { handleContentMessage, handlePanelMessage, handleOneShotMessage, toggleInspect, toggleBlueprint } from './lib/message-router';
import { getContextRid, deleteContextRid } from './lib/context-rid';
import { openEditorWindow, openExtendedWindow } from './lib/editor';
import { openCodeSearchWindow } from './lib/codesearch-launcher';
import { initSiteAccess, reconcileProfileOrigins } from './lib/site-access';
import { clearAbandonedPrivateSessionRules } from './lib/bmp-private-session';
import { openCompareWindow } from './lib/diff-launcher';
import { openObjectViewWindow } from './lib/objectview-launcher';
import { openSidePanelFromCommand } from './lib/side-panel-command';
import { initCompanionTabs } from './lib/companion-tabs';
import { logIdForError, takeHeldLogEntry } from './lib/toast-log';
import { lockExtensionStorage } from './lib/storage-access';
import { forgetEnrichBudget } from './lib/enrich-budget';
import { sweepLaunchContexts } from './lib/local-data';
import { pointTellOnInWindow } from './lib/point-tell-state';

// Deliberately global so the exact loaded build is visible from the service
// worker DevTools console, even when manifest.version has not changed.
(globalThis as typeof globalThis & { __CREV_BUILD_ID__?: string }).__CREV_BUILD_ID__ = BUILD_ID;

// ── State ───────────────────────────────────────────────────────

// The base context belongs to no server profile. Every request runs on the
// context of its own profile (profile-scope.ts); these stores are never loaded
// and the base client is always null, so a path that forgot to bind its
// profile fails closed instead of reaching another server.
const cache = new ObjectCache('_unbound');
const history = new HistoryManager('_unbound');
const favorites = new FavoritesManager('_unbound');
const scriptHistory = new ScriptHistoryManager('_unbound');
const stylePresets = new StylePresetStore('_unbound');
let unboundClientReads = 0;
/** Per-window inspect-mode flag. Persisted to chrome.storage.session so
 *  toggling survives SW idle-suspend within a single browser session.
 *  Window IDs aren't stable across browser restarts; cleanup happens on
 *  chrome.windows.onRemoved + at boot we drop entries whose window
 *  doesn't exist anymore. */
const inspectActiveByWindow = new Map<number, boolean>();
/** Per-window blueprint-mode toggle state. On the ctx (not a handler-local Map) so it sits with the
 *  other per-window UI toggles and can be cleared on a profile switch (the loaded layout is env-bound). */
const blueprintActiveByWindow = new Map<number, boolean>();
const blueprintTabByWindow = new Map<number, number>();
let settings: InspectorSettings = { ...DEFAULT_SETTINGS };

const contentPorts = new Map<number, chrome.runtime.Port>();

// Side-panel ports indexed by the windowId they live in. Chrome allows one
// panel per browser window; with two windows open the user can have two
// panel instances connected simultaneously. The original singleton
// `panelPort` made the second connect silently steal the first panel's
// channel, which is the bug this Map fixes.
const panelPortByWindow = new Map<number, chrome.runtime.Port>();
// Retained across transient port disconnects so an older document cannot
// reclaim the window during the newer document's reconnect delay. A genuinely
// reopened panel has a later creation timestamp; window teardown clears it.
const panelClaimByWindow = new Map<number, PanelClaim>();
// Reverse lookup so the disconnect handler can find which windowId a
// disconnecting port was attached to (Chrome doesn't give us the windowId
// in the disconnect event).
const portToWindowId = new Map<chrome.runtime.Port, number>();

const PANEL_MSG_CAP = 100;
const pendingPanelMessages: InspectorMessage[] = [];

function broadcastToPanels(msg: InspectorMessage) {
  if (panelPortByWindow.size === 0) {
    // No panels open — queue with the same dedup semantics as the legacy
    // singleton path so the first panel that opens after the SW starts
    // gets fresh state without duplicates.
    const DEDUP_TYPES = new Set(['CONNECTION_STATE', 'DETECTION_STATE']);
    if (DEDUP_TYPES.has(msg.type)) {
      const idx = pendingPanelMessages.findIndex(m => m.type === msg.type);
      if (idx >= 0) pendingPanelMessages.splice(idx, 1);
    }
    pendingPanelMessages.push(msg);
    if (pendingPanelMessages.length > PANEL_MSG_CAP) {
      const dropped = pendingPanelMessages.length - PANEL_MSG_CAP;
      log.warn('sw:panelOverflow', `Panel queue overflowed, dropping ${dropped} oldest messages`);
      pendingPanelMessages.splice(0, dropped);
    }
    return;
  }
  for (const port of panelPortByWindow.values()) {
    try { port.postMessage(msg); }
    catch (e) { log.swallow('sw:broadcastToPanels', e); }
  }
}

function sendToPanelByWindow(windowId: number, msg: InspectorMessage) {
  const port = panelPortByWindow.get(windowId);
  if (port) {
    try { port.postMessage(msg); }
    catch (e) { log.swallow('sw:sendToPanelByWindow', e); }
  }
}

/** Panels whose window shows `profileId`. */
function sendToProfilePanels(profileId: string, msg: InspectorMessage) {
  for (const [windowId, port] of panelPortByWindow) {
    if (displayProfileOf(windowId) !== profileId) continue;
    try { port.postMessage(msg); }
    catch (e) { log.swallow('sw:sendToProfilePanels', e); }
  }
}

/** Content scripts of the tabs whose page belongs to `profileId`. */
function broadcastToProfileContent(profileId: string, msg: InspectorMessage) {
  for (const [tabId, port] of contentPorts) {
    if (profileOfTab(tabId) !== profileId) continue;
    try { port.postMessage(msg); } catch (e) { log.swallow('sw:broadcastToProfileContent', e); }
  }
}

function sendToPanelByTab(tabId: number, msg: InspectorMessage) {
  // Look up the tab's windowId then route. Cheap call (Chrome cache);
  // fire-and-forget — if the tab is gone, no panel needs the message.
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    sendToPanelByWindow(tab.windowId, msg);
  });
}

// ── Context ─────────────────────────────────────────────────────

const { settingsReady: settingsLoaded, resolveSettings } = createSettingsReady();
// Routing waits for settings and for the per-window and per-tab state rebuilt
// from the browser (a restarted worker has none).
const settingsReady = settingsLoaded.then(() => restoreWindowState()).catch(e => log.swallow('sw:restoreWindows', e));

const ctx: SwContext = {
  get client() {
    // Fail closed: the base context belongs to no server.
    if (unboundClientReads++ === 0) log.warn('sw:unboundClient', new Error('a request read the client without a bound profile').stack ?? '');
    return null;
  },
  set client(_v) { /* clients belong to profile scopes */ },
  get hasPanel() { return panelPortByWindow.size > 0; },
  panelPortByWindow,
  contentPorts,
  cache,
  history,
  favorites,
  stylePresets,
  scriptHistory,
  get settings() { return settings; },
  set settings(v) { settings = v; },
  inspectActiveByWindow,
  blueprintActiveByWindow,
  blueprintTabByWindow,
  isInspectActive(windowId: number | undefined): boolean {
    return windowId != null && inspectActiveByWindow.get(windowId) === true;
  },
  setInspectActive(windowId: number, active: boolean): void {
    if (active) inspectActiveByWindow.set(windowId, true);
    else inspectActiveByWindow.delete(windowId);
    persistInspectState();
  },
  persistBlueprintState,
  settingsReady,
  logActivity,
  sendToPanel: broadcastToPanels,
  sendToPanelByWindow,
  sendToPanelByTab,
  broadcastToContent(msg: InspectorMessage) {
    for (const port of contentPorts.values()) {
      try { port.postMessage(msg); } catch (e) { log.swallow('sw:broadcastToContent', e); }
    }
  },
  scopeFor: (profileId: string) => scopeFor(profileId)?.ctx ?? null,
  boundForTab,
  boundContexts: () => liveScopes().map(s => s.ctx),
  sendToProfilePanels,
  broadcastToProfileContent,
  toast(text, kind) {
    // Push the TOAST to every connected panel. Callers that ALSO want a
    // permanent record in the Log tab call ctx.logActivity() separately —
    // we don't mirror automatically so handlers that already log can't
    // accidentally double-log.
    ctx.sendToPanel(kind === 'error' ? { type: 'TOAST', text, kind, logId: logIdForError(text) } : { type: 'TOAST', text, kind });
  },
};

// ── Init ─────────────────────────────────────────────────────────

// Extension storage is for Companion's pages and this worker only: content
// scripts must not read profiles, the AI key or caches (storage-access.ts).
// First thing at every start, before any storage read or write below.
const storageLocked = lockExtensionStorage();
setSwContext(ctx);
registerTabListeners();
// The toolbar badge shows the state of the profile the focused window shows.
setBadgeOwner(profileId => profileId === displayProfileOf(lastFocusedWindowId()));
// Settings that could not be read are a state the panels show, with Retry.
onSettingsStatus(status => broadcastToPanels({ type: 'SETTINGS_STATUS', ...status }));

// ── Boot ────────────────────────────────────────────────────────

/** Per-window inspect state restore. Runs in parallel with the other
 *  state-manager loads so it completes BEFORE settingsReady resolves —
 *  otherwise handlers gated on settingsReady could read an empty
 *  inspectActiveByWindow Map and miss the user's pre-restart toggle. */
async function restoreInspectState(): Promise<void> {
  try {
    const sess = await chrome.storage.session.get('crev_inspect_active_by_window');
    const saved = sess.crev_inspect_active_by_window as Record<string, boolean> | undefined;
    if (!saved) return;
    const liveWindows = await chrome.windows.getAll();
    const liveIds = new Set(liveWindows.map(w => w.id).filter((id): id is number => id != null));
    for (const [k, v] of Object.entries(saved)) {
      const id = Number(k);
      // Drop entries for closed windows so a future window assigned the
      // same id doesn't inherit stale state.
      if (Number.isFinite(id) && liveIds.has(id) && v === true) {
        inspectActiveByWindow.set(id, true);
      }
    }
  } catch (e) { log.swallow('sw:restoreInspect', e); }
}

/** Per-window blueprint state restore — the mirror of restoreInspectState. Runs inside the boot
 *  Promise.all so it completes BEFORE settingsReady resolves; since every handler awaits settingsReady,
 *  the toggle/exit paths never read an empty map after an SW restart (that was the "X does nothing" bug).
 *  Entries for windows that no longer exist are dropped so a recycled window id can't inherit stale state. */
async function restoreBlueprintState(): Promise<void> {
  try {
    const sess = await chrome.storage.session.get(['crev_blueprint_active_by_window', 'crev_blueprint_tab_by_window']);
    const active = sess.crev_blueprint_active_by_window as Record<string, boolean> | undefined;
    const tabs = sess.crev_blueprint_tab_by_window as Record<string, number> | undefined;
    if (!active && !tabs) return;
    const liveWindows = await chrome.windows.getAll();
    const liveIds = new Set(liveWindows.map(w => w.id).filter((id): id is number => id != null));
    for (const [k, v] of Object.entries(active ?? {})) {
      const id = Number(k);
      if (Number.isFinite(id) && liveIds.has(id) && v === true) blueprintActiveByWindow.set(id, true);
    }
    for (const [k, v] of Object.entries(tabs ?? {})) {
      const id = Number(k);
      // Only keep the pinned tab for a window whose blueprint is (still) active — a stale tab for an
      // inactive window is noise the toggle would ignore anyway.
      if (Number.isFinite(id) && liveIds.has(id) && blueprintActiveByWindow.get(id) === true) blueprintTabByWindow.set(id, v);
    }
  } catch (e) { log.swallow('sw:restoreBlueprint', e); }
}

// Boot: load state managers independently (one failure must not block the rest)
void storageLocked.then(() => Promise.all([
  restoreActivity().catch(e => log.swallow('sw:activity', e)),
  loadTabDetection().catch(e => log.swallow('sw:tabDetection', e)),
  restoreInspectState().catch(e => log.swallow('sw:restoreInspect', e)),
  restoreBlueprintState().catch(e => log.swallow('sw:restoreBlueprint', e)),
  seedActiveTabs().catch(e => log.swallow('sw:seedTabs', e)),
]).then(async () => {
  await loadStoredSettings();

  // Drop the legacy global inspect-active key one-shot so storage stays clean.
  chrome.storage.local.remove('crev_inspect_active').catch(() => { /* fine if absent */ });
  // Per-object launch contexts older than a week (local-data.ts).
  void sweepLaunchContexts().catch(e => log.swallow('sw:sweepLaunch', e));
})).catch(e => {
  log.swallow('sw:init', e);
  resolveSettings(); // ensure settingsReady resolves even on catastrophic failure
});

function persistInspectState() {
  const obj: Record<string, boolean> = {};
  for (const [k, v] of inspectActiveByWindow) if (v) obj[String(k)] = true;
  chrome.storage.session.set({ crev_inspect_active_by_window: obj })
    .catch(e => log.swallow('sw:persistInspect', e));
}

/** Per-window blueprint toggle state, persisted to chrome.storage.session so it survives an MV3 SW
 *  idle-suspend within a browser session — the same treatment inspect gets above, and for the same
 *  reason: the toggle (BLUEPRINT_TOGGLE / the Blueprint command / the side-panel button) reads the in-memory map
 *  to decide on/off, and a wiped map made it flip the WRONG way (an empty map read as "off" → re-activate,
 *  so Exit appeared dead). Restored at boot BEFORE settingsReady (see restoreBlueprintState). The pinned
 *  tab rides along so a post-apply resume still targets the right tab after a restart. */
function persistBlueprintState() {
  const active: Record<string, boolean> = {};
  for (const [k, v] of blueprintActiveByWindow) if (v) active[String(k)] = true;
  const tabs: Record<string, number> = {};
  for (const [k, v] of blueprintTabByWindow) tabs[String(k)] = v;
  chrome.storage.session.set({ crev_blueprint_active_by_window: active, crev_blueprint_tab_by_window: tabs })
    .catch(e => log.swallow('sw:persistBlueprint', e));
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(e => log.swallow('sw:sidePanel', e));
// Companion's own pages in a tab (Access, Colors and images) show no side panel.
initCompanionTabs();

// Per-site access: reconcile the dynamic content-script registrations with the granted origins at
// boot and on every grant/revoke. Nothing is injected anywhere until the user approves a site.
initSiteAccess();
void clearAbandonedPrivateSessionRules().catch(e => log.swallow('auth:clearPrivateRules', e));
// Access invariant: grants equal configured BMP origins plus the selected AI provider origin.
// This also migrates legacy broad grants carried over from older installs.
// A failed settings read leaves only the empty defaults in memory; reconciling against them would
// revoke every grant the user made. Grants stay untouched until settings load cleanly.
void settingsReady.then(() => {
  if (!settingsLoadedCleanly()) {
    log.warn('sw:reconcileSkipped', 'Settings did not load; site access grants were left unchanged');
    return;
  }
  return reconcileProfileOrigins(ctx.settings.profiles.map(p => p.bmpUrl), ctx.settings.ai);
});

chrome.windows.onRemoved.addListener((id) => {
  // Drop the closed window's inspect-mode entry; otherwise a future
  // window assigned the same ID would inherit stale state.
  if (inspectActiveByWindow.delete(id)) persistInspectState();
  // Same for blueprint (active flag + pinned tab), for the same recycled-window-id reason.
  const hadBp = blueprintActiveByWindow.delete(id);
  const hadTab = blueprintTabByWindow.delete(id);
  if (hadBp || hadTab) persistBlueprintState();
  panelClaimByWindow.delete(id);
  forgetWindow(id);
});

// ── Context menus ──────────────────────────────────────────────

// Created on install and update only: Chrome keeps them across worker restarts.
registerContextMenus();

// Clean up context menu state when tabs close
chrome.tabs.onRemoved.addListener((tabId) => { deleteContextRid(tabId); forgetEnrichBudget(tabId); });
// A tab that closes or loads a new page: its object windows are gone, and so
// is what they were served (sender-trust.ts).
watchFrameTabs(chrome.tabs);

// When a BMP session cookie disappears (logout/expiry), release any borrowed
// token chain so the extension's access tracks the user's login. The handler is
// async (it awaits settingsReady + re-probes the cookie); swallow its promise.
chrome.cookies.onChanged.addListener((info) => { void handleSessionCookieChanged(info); });

async function handleContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  const tabId = tab?.id;
  if (!tabId) return;
  const ctxRid = getContextRid(tabId);
  const menuIdEarly = typeof info.menuItemId === 'string' ? info.menuItemId : '';
  // Needs no object. Choosing it is an invocation on this tab: Chrome grants activeTab (Screenshot).
  if (menuIdEarly === NEW_PAGE_MENU_ID) { void newPageHere(tabId).catch(e => log.swallow('sw:newPageMenu', e)); return; }
  if (menuIdEarly === POINT_TELL_MENU_ID) { void togglePointTell(ctx, { tabId }).catch(e => log.swallow('sw:pointTellMenu', e)); return; }
  // Code search needs no object: without one it opens empty.
  if (!ctxRid && menuIdEarly === 'crev-search-code') { void openCodeSearchWindow({ tabId }); return; }
  if (!ctxRid) return;

  const menuId = typeof info.menuItemId === 'string' ? info.menuItemId : '';
  // The tab's own profile: names and IDs come from that server's cache.
  noteTabUrl(tabId, tab?.url);
  const bound = scopeFor(profileOfTab(tabId))?.ctx;
  const cached = (rid: string) => bound?.cache.get(rid);
  const reportFail = (action: string) => (e: unknown) => {
    ctx.logActivity('error', `${action} failed`, e instanceof Error ? e.message : String(e));
  };
  switch (menuId) {
    case 'crev-copy-primary-id': {
      const hit = cached(ctxRid.rid);
      const primaryId = hit?.templateBusinessId ?? ctxRid.businessId ?? hit?.businessId ?? ctxRid.rid;
      chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text: primaryId }).catch(reportFail('Copy primary ID'));
      break;
    }
    case 'crev-copy-rid':
      chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text: ctxRid.rid }).catch(reportFail('Copy RID'));
      break;
    case 'crev-copy-bid':
      chrome.tabs.sendMessage(tabId, {
        type: 'COPY_TO_CLIPBOARD',
        text: ctxRid.businessId ?? cached(ctxRid.rid)?.businessId ?? ctxRid.rid,
      }).catch(reportFail('Copy instance ID'));
      break;
    case 'crev-copy-name':
      chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text: ctxRid.name ?? '' }).catch(reportFail('Copy name'));
      break;
    case 'crev-view-props':
      // The right-click already made this object the current position; the
      // menu item opens it in the object window on this tab.
      if (!bound) { ctx.logActivity('warn', 'Open object window failed', 'This page does not belong to a server Companion is set up for.'); break; }
      openObjectViewWindow(ctxRid.rid, { tabId }, { name: ctxRid.name, type: ctxRid.type, businessId: ctxRid.businessId }, bound)
        .catch(reportFail('Open object window'));
      break;
    case 'crev-open-editor':
      // Context menu fires for a specific tab \u2014 mount the editor there
      // rather than on lastFocusedWindow's active tab.
      if (!bound) { ctx.logActivity('warn', 'Open editor failed', 'This page does not belong to a server Companion is set up for.'); break; }
      openEditorWindow(ctxRid.rid, undefined, { tabId }, undefined, bound).catch(reportFail('Open editor'));
      break;
    case 'crev-search-code':
      void openCodeSearchWindow({ tabId }, { type: 'codesearch', context: { rid: ctxRid.rid, ...(ctxRid.name ? { name: ctxRid.name } : {}), ...(ctxRid.type ? { type: ctxRid.type } : {}), ...(ctxRid.businessId ? { businessId: ctxRid.businessId } : {}) } });
      break;
    case 'crev-compare':
      // The object under the cursor is side A; the picker offers side B.
      void openCompareWindow({ type: 'diff', left: { rid: ctxRid.rid, ...(ctxRid.name ? { name: ctxRid.name } : {}), ...(ctxRid.type ? { type: ctxRid.type } : {}), ...(ctxRid.businessId ? { businessId: ctxRid.businessId } : {}) } }, { tabId });
      break;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => { void handleContextMenuClick(info, tab); });

// ── Port connections ────────────────────────────────────────────

/** Safe postMessage — swallows errors from disconnected ports. */
function safeSend(port: chrome.runtime.Port, msg: InspectorMessage) {
  try { port.postMessage(msg); }
  catch (e) { log.swallow('sw:safeSend', e); }
}

/** Push initial state to a newly connected content port (after settingsReady). */
function initContentPort(port: chrome.runtime.Port, tabId: number | undefined) {
  // The tab's top page decides its server (a content script may run in a
  // sub-frame); its URL is current at connect time.
  const pageUrl = port.sender?.tab?.url ?? port.sender?.url;
  if (tabId != null) noteTabUrl(tabId, pageUrl);
  port.onMessage.addListener((msg: InspectorMessage) => {
    void handleContentMessage(msg, tabId ?? undefined, (tabId != null ? undefined : pageUrl));
  });

  // All initial pushes gated on settingsReady — inspect state and cache
  // are only valid after boot completes (restored from storage). Inspect
  // is per-window: this content port belongs to a tab in some window;
  // we look up that window's flag.
  void settingsReady.then(async () => {
    let inspectForWindow = false;
    if (tabId != null) {
      try {
        const tab = await chrome.tabs.get(tabId);
        inspectForWindow = inspectActiveByWindow.get(tab.windowId) === true;
      } catch { /* tab gone */ }
    }
    safeSend(port, { type: 'INSPECT_STATE', active: inspectForWindow });
    safeSend(port, { type: 'ENRICH_MODE', mode: settings.enrichMode });
    // Writable content affordances must carry the exact
    // environment they were rendered under. Push the current token on every
    // connect, even when connection display did not change.
    // The page's own profile: its connection state, its monitor.
    const scope = tabId != null ? scopeFor(profileOfTab(tabId)) : null;
    if (!scope) return;
    await scope.ready;
    safeSend(port, { type: 'CONNECTION_STATE', state: computeConnectionState(scope.ctx) });
    // A BMP page is a surface that shows connection state (the overlay works
    // without the side panel). Its arrival validates stale evidence, and a
    // page load while "Sign in to BMP" is shown may be the fresh login.
    ensureConnectionMonitoring(scope.ctx);
    noteLoginEvidence(scope.ctx);

    // No cached identities are pushed here: the page asks for the rids it
    // shows (ENRICH_BADGES) and gets cache hits answered at once.
  });

  // Notify the panel that lives in the same window as the connecting
  // content script (if any). Previously we asked Chrome for the "active
  // tab" globally and pushed to the singleton panel; with multiple
  // windows that surfaced the wrong tab's data in the wrong panel.
  if (tabId != null && panelPortByWindow.size > 0) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      const windowId = tab.windowId;
      if (windowId == null) return;
      // Active-tab gate per window: only push if the connecting tab is
      // the active tab of its window (background BMP tabs shouldn't
      // jerk that window's panel).
      chrome.tabs.query({ active: true, windowId }, (actives) => {
        if (actives[0]?.id !== tabId) return;
        void logPageDiagnostic(tabId, 'page-ready', 'Companion ready on this page', undefined, tab.url);
        sendPageInfoToPanel(tabId);
        const det = getTabDetection(tabId);
        sendToPanelByWindow(windowId, {
          type: 'DETECTION_STATE',
          ...(det ?? { phase: 'checking' as import('./lib/types').DetectionPhase, confidence: 0, signals: [] }),
        } satisfies InspectorMessage);
      });
    });
  }
}

/** Push initial state to a newly connected panel port. The port is not
 *  yet registered in `panelPortByWindow` — that happens after the first
 *  PANEL_HELLO message arrives carrying the panel's windowId. */
function initPanelPort(port: chrome.runtime.Port) {
  port.onMessage.addListener((msg: InspectorMessage) => {
    if (msg.type === 'PANEL_HELLO') {
      const { windowId, panelIncarnation, panelCreatedAt } = msg;
      // A second document can exist for one window (for example a stale
      // extension page beside Chrome's real side panel). Force-disconnecting
      // the previous port is unsafe: its reconnecting client returns after
      // 200 ms, steals the slot, and disconnects this port in turn. Retire the
      // old client explicitly and let it disconnect itself without retrying.
      const prev = panelPortByWindow.get(windowId);
      const incomingClaim = { panelIncarnation, panelCreatedAt };
      if (!shouldAcceptPanelClaim(panelClaimByWindow.get(windowId), incomingClaim)) {
        safeSend(port, { type: 'PANEL_SUPERSEDED' });
        return;
      }
      if (prev && prev !== port) {
        portToWindowId.delete(prev);
        safeSend(prev, { type: 'PANEL_SUPERSEDED' });
      }
      panelPortByWindow.set(windowId, port);
      panelClaimByWindow.set(windowId, incomingClaim);
      portToWindowId.set(port, windowId);

      void settingsReady.then(async () => {
        // The port may have been superseded while settings were still
        // restoring. Never let its delayed startup consume queued state or
        // initialize monitoring on behalf of a retired document.
        if (panelPortByWindow.get(windowId) !== port) return;
        // Per-window inspect + blueprint — this panel only cares about its own window. Re-pushed on
        // connect so a reopened sidebar reflects the current toggle state (mirrors INSPECT_STATE).
        safeSend(port, { type: 'INSPECT_STATE', active: inspectActiveByWindow.get(windowId) === true });
        safeSend(port, { type: 'BLUEPRINT_STATE', active: blueprintActiveByWindow.get(windowId) === true });
        // Point and tell lives in the page: ask the window's tab, push the answer when it comes.
        void pointTellOnInWindow(windowId).then(active => { if (panelPortByWindow.get(windowId) === port) safeSend(port, { type: 'POINT_TELL_STATE', active }); });
        // The profile this window shows: its settings view, state and cache.
        const shown = scopeFor(displayProfileOf(windowId));
        if (!settingsLoadedCleanly()) safeSend(port, { type: 'SETTINGS_STATUS', ...settingsStatus() });
        safeSend(port, { type: 'SETTINGS_DATA', settings: redactSettings(ctx.settings, displayProfileOf(windowId)) });
        if (shown) {
          await shown.ready;
          if (panelPortByWindow.get(windowId) !== port) return;
          safeSend(port, { type: 'CACHE_STATS', count: shown.ctx.cache.size });
          safeSend(port, { type: 'CONNECTION_STATE', state: computeConnectionState(shown.ctx) });
        }
        // Flush queued broadcasts to the newly-registered panel. Multiple
        // panels racing to flush would each pop the queue; only the
        // *first* panel gets the queued messages — that's intentional,
        // the queued payloads are state snapshots that are equally
        // useful to either panel and we don't want to double-fire
        // activity entries.
        for (const queued of pendingPanelMessages) safeSend(port, queued);
        pendingPanelMessages.length = 0;
        const heldLogEntry = takeHeldLogEntry(windowId);
        if (heldLogEntry != null) safeSend(port, { type: 'SHOW_LOG_ENTRY', id: heldLogEntry });
        // The helper is idempotent and won't turn a verified connection back
        // into "Reconnecting".
        if (shown) ensureConnectionMonitoring(shown.ctx);
      });
      return;
    }
    void handlePanelMessage(msg, port);
  });

}

const keepAliveRefusalsLogged = new Set<string>();
chrome.runtime.onConnect.addListener((port) => {
  // An open code search window keeps the worker (and its code read cache)
  // alive with pings on this port; only that page may hold it.
  if (port.name === KEEPALIVE_PORT) {
    // Logged once per sender URL: the page stops when told, but a page that
    // does not listen must not fill the log.
    if (!acceptKeepAlivePort(port)) {
      const from = port.sender?.url ?? 'unknown sender';
      if (!keepAliveRefusalsLogged.has(from)) { keepAliveRefusalsLogged.add(from); log.warn('sw:keepAlivePortRefused', `keep-alive port from ${from}`); }
      return;
    }
    // The open window also holds the change feed of its server (code-feed):
    // embedded in a page, that page's profile; on its own (its tab's top
    // frame), the profile its requests go to (message-router).
    const feedTab = port.sender?.tab?.id;
    const embedded = feedTab != null && (port.sender?.frameId ?? 0) > 0;
    holdFeedForPort(port, async () => {
      if (embedded) return boundForTab(feedTab);
      const scope = scopeFor(displayProfileOf(undefined));
      if (!scope) return null;
      await scope.ready;
      return scope.ctx;
    });
    return;
  }
  if (port.name === 'content') {
    const tabId = port.sender?.tab?.id;
    if (tabId != null) {
      contentPorts.set(tabId, port);
      // Identity-guarded delete: a re-injection disconnects the old port and
      // connects a new one for the SAME tabId. If the old port's (possibly
      // out-of-order) onDisconnect deleted unconditionally, it would evict the
      // live new port — leaving contentPorts empty so ensureContentScript
      // re-injects again (loop) and toggleInspect/broadcastToContent can't
      // reach the tab. Only delete if THIS port is still the registered one.
      port.onDisconnect.addListener(() => {
        if (contentPorts.get(tabId) === port) {
          contentPorts.delete(tabId);
          // The page is gone: its badge requests that are still waiting are dropped.
          releaseTab(tabId);
        }
      });
    }
    initContentPort(port, tabId ?? undefined);
  }

  if (port.name === 'panel') {
    // Only Companion's own pages may claim a panel port: it receives settings
    // (including saved passwords) and may change profiles. A content script or
    // web page frame connecting with this name is refused.
    if (!isExtensionPageSender(port.sender)) {
      log.warn('sw:panelPortRefused', `panel port from ${port.sender?.url ?? 'unknown sender'}`);
      try { port.disconnect(); } catch { /* already closed */ }
      return;
    }
    port.onDisconnect.addListener(() => {
      const windowId = portToWindowId.get(port);
      portToWindowId.delete(port);
      if (windowId != null && panelPortByWindow.get(windowId) === port) {
        panelPortByWindow.delete(windowId);
      }
    });
    initPanelPort(port);
  }
});

// ── Keyboard shortcut ───────────────────────────────────────────

chrome.commands.onCommand.addListener((command, tab) => {
  log.info('sw:command', command);
  if (command === 'open-side-panel') {
    // `_execute_action` does not reliably inherit sidePanel's
    // openPanelOnActionClick behavior when invoked from a keyboard shortcut.
    // A normal command is a Chrome-recognised user gesture, so open the panel
    // explicitly while leaving the toolbar action's native toggle untouched.
    void openSidePanelFromCommand(tab).catch(e => log.swallow('sw:openSidePanelCommand', e));
  }
  if (command === 'toggle-inspect') {
    void toggleInspect();
  }
  if (command === 'toggle-blueprint') {
    void toggleBlueprint();
  }
  if (command === 'toggle-point-tell') {
    // A command is an invocation on this tab, which gives Chrome's activeTab (Screenshot needs it).
    void togglePointTell(ctx, { ...(tab?.id != null ? { tabId: tab.id } : {}) }).catch(e => log.swallow('sw:pointTellCommand', e));
  }
  if (command === 'open-search') {
    // No default key (Chrome allows four suggested keys); the user can set
    // one at chrome://extensions/shortcuts. Opens the code search window on
    // the most-recently-focused window's active tab.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      openCodeSearchWindow({ tabId: tabs[0]?.id }).catch(e => log.swallow('sw:openSearch', e));
    });
  }
  if (command === 'open-extended') {
    // Mount on the user's most-recently-focused window's active tab. We have no
    // panel context from a keyboard shortcut; openExtendedWindow resolves the
    // page context itself (shared resolver) from the targeted tab.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      openExtendedWindow(undefined, { tabId: tabs[0]?.id }).catch(e => log.swallow('sw:openExtended', e));
    });
  }
});

// ── Network state change → immediate re-poll ────────────────────

// Network recovery is evidence for every surface (panel or page overlay), so it validates fully.
self.addEventListener('online', () => { for (const s of liveScopes()) void validateConnection('evidence-change', s.ctx); });
self.addEventListener('offline', () => { for (const s of liveScopes()) void pollHealth(true, s.ctx); });

// ── Connection recovery ─────────────────────────────────────────
// Registered at top level so the alarm wakes a sleeping worker and the listener exists before
// Chrome dispatches the event (see connection-recovery.ts for the schedule).
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === RECOVERY_ALARM) void runRecoveryCheck().catch(e => log.swallow('sw:recoveryCheck', e));
});

// ── One-shot message handler ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: InspectorMessage, sender, sendResponse) => {
  return handleOneShotMessage(msg, sender, sendResponse);
});
