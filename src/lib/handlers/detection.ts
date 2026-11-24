/**
 * BMP detection and page info handlers.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { getTabDetection, setTabDetection, updateBadge } from '../detection';
import { sendPageInfoToPanel, queuePageInfoForTab, handleGetDetection } from '../tab-awareness';
import { clearContextRid, getContextRid, getPageContext, setPageContext, deleteContextRid, markPageContextStale } from '../context-rid';
import type { SwContext } from '../sw-context';
import { resolvePanelContextForTab, sendPanelContextForTab } from '../panel-context-sync';
import { setCurrentPosition } from '../current-position';
import { isRidShaped } from '../validate-inbound';
import type { DetectionPhase } from '../types';
import { logPageDiagnostic } from '../page-diagnostics';
import { releaseTab } from '../enrichment';
import { releaseEditPageFields } from './inspect';

register('DETECTION_RESULT', (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const phase: DetectionPhase = msg.isBmp ? 'detected' : 'not-detected';
  const senderTabId = meta.senderTabId;

  // Only log when detection state actually changes, once per page load and
  // tab, and only for web pages (page-diagnostics).
  const prevDet = senderTabId != null ? getTabDetection(senderTabId) : undefined;
  if (!prevDet || prevDet.phase !== phase) {
    const pct = Math.round(msg.confidence * 100);
    void logPageDiagnostic(senderTabId, `detection:${phase}`, msg.isBmp ? 'Found a BMP page' : 'This page is not BMP', `BMP detection score ${pct}%`);
  }
  if (senderTabId != null) {
    setTabDetection(senderTabId, { phase, confidence: msg.confidence, signals: msg.signals });
    void updateBadge(senderTabId, msg.isBmp);
  }
  // Route the DETECTION_STATE to the panel in the SAME window as the
  // tab that fired the result — and only if the tab is the active tab
  // of that window. Other windows' panels stay quiet.
  if (senderTabId == null) return;
  chrome.tabs.get(senderTabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id !== senderTabId) return;
      ctx.sendToPanelByWindow(tab.windowId!, { type: 'DETECTION_STATE', phase, confidence: msg.confidence, signals: msg.signals });
    });
  });
});

/**
 * The page's context identity is kept current for something that shows it:
 * the side panel of the tab's window, or Inspect in that window (its page
 * heading names the bound object). With neither, a render only marks the
 * tab's page context stale; a reader that needs it later (the editor's EC
 * `this`, Studio, the panel when it opens) asks the page then
 * (page-context-resolver, GET_PAGE_INFO on panel open).
 *
 * The page info itself (the widget scan and the walk over the page's
 * components) has one reader, the side panel: it is asked for only while a
 * panel is open in the window, once per burst (queuePageInfoForTab). Inspect
 * alone does not ask for it, so the tab's page context is marked stale on a
 * render and the next reader asks the page for the context only.
 */
export function pageInfoShown(ctx: Pick<SwContext, 'panelPortByWindow' | 'isInspectActive'>, windowId: number): boolean {
  return ctx.panelPortByWindow.has(windowId) || ctx.isInspectActive(windowId);
}

register('GET_PAGE_INFO', (_msg, _respond, meta) => {
  sendPageInfoToPanel(undefined, 1, meta.panelWindowId);
});

// SPA navigation in BMP — content-observer.ts fires this when the URL flips
// without a real navigation. Refresh the panel's widget list from the active
// tab so the Page tab doesn't get stuck on stale grey "?" badges.
//
// Active-tab guard: a user with multiple BMP tabs open shouldn't have the
// panel's widget list jerked by background-tab navigation. We only refresh
// when the change is in the tab the panel is currently representing.
//
// SW-startup edge case: the active-tab map is empty between SW spawn
// and the first `chrome.tabs.onActivated` fire (~immediate on real use but
// not synchronous). If we don't know the active tab yet, query Chrome
// directly instead of dropping the signal — MV3 service workers respawn
// after ~30 s idle so this race actually matters every time the user
// triggers a panel action after a coffee break.
register('BMP_URL_CHANGED', (msg, _respond, meta) => {
  const tabId = meta.senderTabId;
  if (tabId == null) return;
  // Someone moving quickly from page to page: the badge naming still queued for the pages passed
  // through is dropped, so the page they rest on is named first instead of last. The page asks
  // again for what it shows now (its request follows this message on the same port).
  // The edit-page field read of a form left behind is ended too. (A tab switch inside a page, see
  // BMP_PAGE_RENDER_CHANGED, keeps it: the form can still be on screen.)
  if (msg.left) { releaseTab(tabId); releaseEditPageFields(tabId); }
  // Per-window active-tab gate: only refresh if the navigating tab is
  // the active tab of its OWN window. Previously a global activeTabId
  // singleton was used, which broke when the user had BMP tabs in two
  // windows — navigating window B's tab would do nothing because
  // window A's tab id was the global "active". sendPageInfoToPanel
  // routes the response to the panel in the navigating tab's window
  // via sendToPanelByTab, so other windows' panels stay quiet.
  // SPA navigation changed the bound object. Drop BOTH the old page cache and
  // any object the user selected on that page; the new page becomes context as
  // soon as its URL/fiber signal resolves.
  deleteContextRid(tabId);
  const ctx = ctxOf(meta);
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    if (!pageInfoShown(ctx, tab.windowId)) return;
    const panel = ctx.panelPortByWindow.has(tab.windowId);
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id === tabId) {
        if (panel) queuePageInfoForTab(tabId);
        void sendPanelContextForTab(tabId);
      }
    });
  });
});

// React render/tab change without a page-owner change. Refresh the visible
// widget/context snapshot, but deliberately keep contextRid: a render is not
// navigation and must not erase the object the user explicitly selected.
register('BMP_PAGE_RENDER_CHANGED', (msg, _respond, meta) => {
  const tabId = meta.senderTabId;
  if (tabId == null) return;
  if (msg.left) releaseTab(tabId); // a tab switch: see BMP_URL_CHANGED
  const ctx = ctxOf(meta);
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    if (!pageInfoShown(ctx, tab.windowId)) { markPageContextStale(tabId); return; }
    const panel = ctx.panelPortByWindow.has(tab.windowId);
    // Inspect alone: no page scan follows to refresh the context, so the
    // identity lookup below asks the page for its context only.
    if (!panel) markPageContextStale(tabId);
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id === tabId) {
        if (panel) queuePageInfoForTab(tabId);
        void sendPanelContextForTab(tabId);
      }
    });
  });
});

// Fiber-derived page context from the content script (the bound object + active
// tab). Cache it per tab for the footer (GET_CONTEXT_RID) and the editor's EC
// `this` (getCurrentPageRid), then refresh the panel that represents this tab.
register('PAGE_CONTEXT', (msg, _respond, meta) => {
  const tabId = meta.senderTabId;
  if (tabId == null) return;
  const prev = getPageContext(tabId);
  // No change (the page told us again: the cached context is current).
  if (prev?.rid === msg.rid && prev?.tabRid === msg.tabRid) { if (prev) setPageContext(tabId, prev); return; }
  // A fiber-only route can change pages without changing the URL. An explicit
  // object selection belongs to the old page and must not survive that switch.
  if (prev?.rid && prev.rid !== msg.rid) clearContextRid(tabId);
  setPageContext(tabId, { rid: msg.rid, tabRid: msg.tabRid });
  const ctx = ctxOf(meta);
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    if (!pageInfoShown(ctx, tab.windowId)) return;
    const panel = ctx.panelPortByWindow.has(tab.windowId);
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id !== tabId) return; // only the active tab's panel
      if (panel) queuePageInfoForTab(tabId); // Browse's Here tree
      // Footer + AI chip use the same cache-first/live-fallback identity as the
      // Extended window, with a post-lookup race check inside the helper.
      void sendPanelContextForTab(tabId);
    });
  });
});

register('GET_DETECTION', (_msg, _respond, meta) => {
  handleGetDetection(meta.panelWindowId);
});

register('GET_CONTEXT_RID', async (_msg, respond, meta) => {
  const ctx = ctxOf(meta);
  // Resolution order:
  //   1. Active tab of the requesting panel's window (multi-window aware).
  //   2. lastFocusedWindow fallback for non-panel callers.
  const tabId = meta.panelWindowId != null
    ? (await chrome.tabs.query({ active: true, windowId: meta.panelWindowId }))[0]?.id
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  // Two sources, in priority order:
  //   1. contextRidMap — set when the user right-clicks an object in BMP
  //      (most specific — that's the user's intent).
  //   2. The resolved page context (shared resolver: URL `?rid=` ⊕ the fiber
  //      page context), so a freshly-opened panel shows the bound object even
  //      on BMP's custom-routed pages where the URL is blank.
  const entry = tabId != null ? await resolvePanelContextForTab(tabId) : undefined;
  // The object type is carried via 'objectType' to avoid collision with the
  // 'type' message discriminant (duplicate key would overwrite the discriminant).
  const payload = {
    type: 'CONTEXT_RID_DATA' as const,
    rid: entry?.rid,
    name: entry?.name,
    objectType: entry?.type,
    businessId: entry?.businessId,
    ...(entry && tabId != null && getContextRid(tabId)?.rid === entry.rid ? { pointed: true as const } : {}),
  };
  respond(payload);
  if (meta.panelWindowId != null) ctx.sendToPanelByWindow(meta.panelWindowId, payload);
  else ctx.sendToPanel(payload);
});

// The panel's bar clears the pointed-at object: the position is the page's object again.
register('CLEAR_CONTEXT_RID', async (_msg, _respond, meta) => {
  if (meta.panelWindowId == null) return;
  const tabId = (await chrome.tabs.query({ active: true, windowId: meta.panelWindowId }))[0]?.id;
  if (tabId == null) return;
  clearContextRid(tabId);
  await sendPanelContextForTab(tabId);
});

// Current position (lib/current-position.ts). Senders: content (badge click,
// right-click), the object window frame (its tab is the sender tab) and the
// side panel's page picker (its window's active tab).
register('SET_CONTEXT_RID', async (msg, _respond, meta) => {
  if (typeof msg.rid !== 'string' || !isRidShaped(msg.rid)) return;
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 400 ? v : undefined);
  const tabId = meta.senderTabId ?? (meta.panelWindowId != null
    ? (await chrome.tabs.query({ active: true, windowId: meta.panelWindowId }))[0]?.id
    : undefined);
  const source = msg.source === 'badge' || msg.source === 'contextmenu' || msg.source === 'window' || msg.source === 'picker'
    ? msg.source : undefined;
  setCurrentPosition(tabId, { rid: msg.rid, name: str(msg.name), type: str(msg.objectType), businessId: str(msg.businessId) }, source);
});
