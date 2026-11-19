/**
 * ISOLATED world content script — thin boot + message dispatch layer.
 * State lives in ContentState, logic in content-overlays/tooltip/observer.
 */

import type { InspectorMessage, ConnectionState, WidgetInfo, PageContext, EditPageContext } from './lib/types';
import { setCurrentIdentities } from './lib/command-actor';
import { unknownIdentityMap } from './lib/identity-map';
import { nextConnectionNotification } from './lib/connection-notification';
import { traceConnectionDiagnostic } from './lib/connection-trace';
import { extractUrlRids, scanPageWidgets, detectBmpPage, findTabButton, isTabActive, getAllRidElements } from './lib/dom-scanner';
import { resolvePageContext } from './lib/page-context';
import { log } from './lib/logger';
import { connectPort, disconnectPort, sendToSW, onPortMessage, onReconnect } from './lib/content-port';
import { dispatchBroadcast } from './lib/handler-registry';
import { parseInterceptorMessage } from './lib/validate-inbound';
import { showToast } from './lib/toast';
import { installPageShowInLog } from './lib/show-in-log';
import { copyWithToast } from './lib/copy-feedback';
import { ensureOverlayStyle, OVERLAY_STYLE_ID } from './content-overlay-style';

import { ContentState } from './content-state';
import { syncOverlays, removeOverlays, updateLabels, pointAt } from './content-overlays';
import { removePageHeaderIdentity, syncPageHeaderIdentity } from './content-page-header';
import { editPageOverlayTargets, ensureEditPageInspection } from './content-edit-page-inspect';
import { hasStandaloneEditPage, renderedEditPageHosts } from './lib/edit-page-dom';
import { scheduleTooltipForElement, hideTooltip, wireObjectPopover, TOOLTIP_Z_INDEX } from './content-tooltip';
import { placeNewBadges, watchBadgeLayout } from './content-badge-layout';
import { endLocate, locateElement, markCurrent } from './content-current';
import { scheduleHoverPrefetch, cancelHoverPrefetch } from './content-hover-prefetch';
import { startObserver } from './content-observer';
import { adoptMountedFrames, mountFrameOverlay, setFrameServer, teardownFrameOverlayModule } from './content-frame-overlay';
import { BP_RESUME_KEY } from './lib/blueprint-resume';
import { readResume } from './content-blueprint/resume-note';
import { sendFireForget } from './lib/messaging';

declare global {
  interface Window {
    __crev_content_loaded?: boolean;
    __crev_observer?: MutationObserver;
    /** Teardown for the CURRENT content-script instance. A re-injection
     *  (chrome.scripting.executeScript re-runs this file in the same
     *  isolated world) calls the PREVIOUS instance's teardown — reachable
     *  only via window, since module closures don't survive the re-run —
     *  to dispose its port, observer, and listeners before booting fresh.
     *  Without this, every SW idle→reinject cycle stacks another live
     *  instance (duplicate MOUNT_FRAME → two editor windows; a stale
     *  observer/port that re-paints overlays after inspect is toggled off). */
    __crev_teardown?: () => void;
    // Blueprint bridge — the editor lives in a separately-injected content-blueprint.js,
    // not in this always-on bundle. These hooks are how content.ts hands it a live rid resolver and
    // a queued activation without a static import (which would pull the ~150 KB editor back in).
    // Full contract documented in content-blueprint-entry.ts, which is the sole reader of all three.
    __crevBpResolver?: () => string | undefined;
    __crevBpResumePrefer?: 'template' | 'instance';
    /** True once content-blueprint.js has published `__crevBpCmd`.
     *  Until then, commands are buffered in `__crevBpPendingCmds` and drained
     *  in order on the entry's init — see the queue rationale on `sendBlueprintCmd`. */
    __crevBpEntryReady?: boolean;
    /** Order-preserving buffer for commands issued before the entry script
     *  exists (the first-injection window). Drained on init. */
    __crevBpPendingCmds?: BlueprintCmd[];
    /** Published by content-blueprint.js: runs one command. This `window` is
     *  the content scripts' isolated world, which page script cannot see. */
    __crevBpCmd?: (detail: unknown) => void;
    /** Published by content-blueprint.js: whether Point and tell is on in this tab (the page owns that mode). */
    __crevPtActive?: boolean;
  }
}

/** Blueprint command channel: a function call inside the isolated world both
 *  content scripts share. It used to be a `crev-bp-cmd` DOM event, which page
 *  script could dispatch too; a function on the isolated-world `window` is out
 *  of the page's reach. */
type BlueprintCmd =
  | { cmd: 'enable' }
  | { cmd: 'disable' }
  | { cmd: 'resetOverlayCaches' }
  | { cmd: 'setResumePrefer'; prefer: 'template' | 'instance' }
  | { cmd: 'select'; rid: string }
  | { cmd: 'pointTellEnable' }
  | { cmd: 'pointTellNewPage' }
  | { cmd: 'pointTellDisable' };

/** Send a command to the (lazily-injected) Blueprint editor.
 *
 *  content-blueprint.js publishes `__crevBpCmd` only at the end of its own
 *  injection, so any command issued during the first-injection window
 *  would be lost. Buffer commands in an
 *  order-preserving queue until the entry signals `__crevBpEntryReady`; the
 *  entry drains the queue in order on init. This makes the channel reliable for
 *  ALL commands — previously only `enable` had an ad-hoc fallback, so a fast
 *  on→off toggle during that window could leave Blueprint enabled against the
 *  user's last action (the disable was silently dropped). */
function sendBlueprintCmd(detail: BlueprintCmd): void {
  if (window.__crevBpEntryReady && window.__crevBpCmd) {
    window.__crevBpCmd(detail);
  } else {
    (window.__crevBpPendingCmds ??= []).push(detail);
  }
}

// ── Single state instance ────────────────────────────────────────

const s = new ContentState();

// Blueprint resolves "what page is this" through the same URL ⊕ fiber rule as the Page tab —
// custom-routed pages (a group's landing page) have no `?rid=`, only the fiber knows the bound
// object. The fiber cache is filled synchronously on demand: EXTRACT_FIBERS is a CustomEvent the
// MAIN-world interceptor answers in the same dispatch (its PAGE_CONTEXT reply lands in
// handleFiberPageContext before dispatchEvent returns). Cached until a URL change clears it
// (content-observer), so this doesn't re-walk fibers on every blueprint mutation tick.
//
// Published onto `window` rather than passed to a `setBlueprintRidResolver` import — the resolver is
// a closure over ContentState (`s.fiberPageContext`) that content-blueprint-entry.ts (a SEPARATE
// content-script injection) reads by reference. All content scripts injected into one
// tab share one ISOLATED-world `window`, so this is a live bridge, not a snapshot.
function getResolvedPageRid(): string | undefined {
  const url = extractUrlRids();
  if (url.rid) return url.rid;
  if (!s.fiberPageContext?.rid) {
    document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'EXTRACT_FIBERS' } }));
  }
  return resolvePageContext(url, s.fiberPageContext).rid;
}

/** The identity shown beside BMP's visible page heading. An edit route is
 * visually a form definition, so prefer its exact EditPage RID there while
 * leaving the normal bound-object resolver untouched everywhere else. */
function getPageHeaderRid(): string | undefined {
  return hasStandaloneEditPage()
    ? s.editPageContext?.editPageRid ?? getResolvedPageRid()
    : getResolvedPageRid();
}

// Blueprint edits the structure visible on screen. On a standalone create/edit route that structure
// is the exact EditPage definition; the general inspector/execution context remains the bound object.
window.__crevBpResolver = () => {
  // A create/edit URL normally carries the parent object's `rid`, so
  // getResolvedPageRid() has no reason to request a fiber scan. The rendered
  // surface is nevertheless an EditPage and its identity only exists in
  // editionContext. Ask for that context independently; the MAIN-world
  // interceptor replies synchronously through `crev-interceptor`, so the
  // value is available before this resolver returns.
  if (!s.editPageContext && hasStandaloneEditPage()) {
    document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'EXTRACT_FIBERS' } }));
  }
  return hasStandaloneEditPage()
    ? s.editPageContext?.editPageRid ?? getResolvedPageRid()
    : getResolvedPageRid();
};

function syncInspectSurface(): void {
  // Standalone create/edit forms expose their configuration only through
  // React. Refresh that bounded context before joining native controls to the
  // cached EditField list; the CustomEvent round-trip is synchronous.
  if (renderedEditPageHosts().length > 0) {
    document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'EXTRACT_FIBERS' } }));
  }
  syncOverlays(s, editPageOverlayTargets(s));
  syncPageHeaderIdentity(s, getPageHeaderRid());
  placeNewBadges();
  void ensureEditPageInspection(s).then(fresh => {
    if (!fresh) return;
    syncOverlays(s, editPageOverlayTargets(s));
    placeNewBadges();
  });
}

// Whether this content.ts instance has already asked the SW to inject content-blueprint.js. Reset on
// every fresh content.ts instance (a new page load or SW idle→reinject cycle) — a re-injection into a
// tab that already has content-blueprint.js alive is harmless (that entry script guards its own
// re-entry the same way content.ts does), just a redundant round trip.
let blueprintInjected = false;

/** Turn Blueprint on for this tab. First call requests the on-demand injection (content-blueprint.js
 *  is not part of this always-on bundle); every call sends the enable command through
 *  `sendBlueprintCmd`, which buffers it until the entry script is listening (so the enable — and any
 *  disable that races behind it — is delivered in order, never dropped). */
function activateBlueprint(): void {
  ensureBlueprintBundle();
  sendBlueprintCmd({ cmd: 'enable' });
}

/** The page bundle (Blueprint and Point and tell share it) is requested once per content-script instance. */
function ensureBlueprintBundle(): void {
  if (blueprintInjected) return;
  blueprintInjected = true;
  sendFireForget({ type: 'INJECT_BLUEPRINT' });
}

/** Point and tell on or off for this tab. The mode lives in the page bundle; it publishes its state. */
function setPointTell(active: boolean): void {
  if (active) { ensureBlueprintBundle(); sendBlueprintCmd({ cmd: 'pointTellEnable' }); }
  else if (window.__crevBpEntryReady || window.__crevBpPendingCmds?.length) sendBlueprintCmd({ cmd: 'pointTellDisable' });
}

// ── Inspect mode ─────────────────────────────────────────────────

// Per-tab record of whether inspect was on, so a fresh content-script instance
// can repaint borders immediately instead of waiting for the SW. sessionStorage
// survives a re-injection (same page) but not a cross-origin navigation, which
// is exactly the scope we want. Reads/writes are guarded — sessionStorage can
// throw in sandboxed frames or when storage is disabled.
const INSPECT_SS_KEY = 'crev_inspect';
function persistInspect(active: boolean): void {
  try { sessionStorage.setItem(INSPECT_SS_KEY, active ? '1' : '0'); } catch { /* sandboxed / disabled */ }
}
function wasInspecting(): boolean {
  try { return sessionStorage.getItem(INSPECT_SS_KEY) === '1'; } catch { return false; }
}

function setInspectMode(active: boolean) {
  s.inspectActive = active;
  // Inspect is per window: the service worker is the only source of this state (it pushes to every
  // page of the toggled window), so pages do not sync it between themselves.
  persistInspect(active);
  if (active) {
    setPointTell(false); // Inspect and Point and tell never share a page
    injectStyles();
    syncInspectSurface();
  } else {
    if (s.debounceTimer) { clearTimeout(s.debounceTimer); s.debounceTimer = null; }
    removePageHeaderIdentity(s);
    removeOverlays(s);
    s.requestedRids.clear();
  }
}

// ── Style injection ──────────────────────────────────────────────

function injectStyles() {
  if (s.styleInjected) return;
  // The stylesheet itself is injected via the shared helper (also called on a frame-overlay mount, so
  // the EC editor is positioned even when Inspect was never pressed). The tooltip + listeners + banner
  // below are inspect-mode setup and stay guarded by styleInjected.
  ensureOverlayStyle();

  const tooltip = document.createElement('div');
  tooltip.id = 'crev-tooltip';
  tooltip.style.position = 'fixed'; // leak floor — never fall into page flow if the stylesheet is absent
  tooltip.style.zIndex = TOOLTIP_Z_INDEX;
  // documentElement, NOT body — BMP puts transforms on body-level wrappers,
  // and a transformed ancestor traps position:fixed in its stacking context,
  // which painted the card UNDER outlines/badges. Same escape hatch the
  // frame overlays use.
  document.documentElement.appendChild(tooltip);
  wireObjectPopover(s, tooltip);

  // Delegated hover handler for the badge pills. Hovering the pill (not the
  // whole widget) shows the info card — the widget body stays clickable for
  // BMP without summoning the tooltip. Attached with the injection-lifetime
  // AbortSignal so resetContentState() detaches it — without that, a
  // double-injection would pile up identical listeners and we'd be running
  // this on every mouse move.
  document.body.addEventListener('mouseover', (e) => {
    if (!s.inspectActive) return;
    // Moving onto (or within) the hover card must not count as "left the
    // label" — every child span re-fires mouseover here, and the card's own
    // one-time mouseenter can't keep cancelling the hide timer. Clicking or
    // text-selecting an id inside the card was killing it mid-gesture.
    if ((e.target as HTMLElement).closest?.('#crev-tooltip')) return;
    const pill = (e.target as HTMLElement).closest?.('.crev-label') as HTMLElement | null;
    if (pill === s.hoveredLabelEl) return;
    s.hoveredLabelEl = pill;
    const rid = pill?.getAttribute('data-crev-label');
    if (pill && rid) {
      scheduleTooltipForElement(s, pill, rid);
      // A resting pointer often precedes a double-click: read the object
      // window's root in the background meanwhile.
      scheduleHoverPrefetch(rid, s.enrichments.get(rid)?.type);
    } else {
      cancelHoverPrefetch();
      hideTooltip(s);
    }
  }, { signal: s.listenerLifetime.signal });

  // Badges that collide, leave the viewport or slide under a sticky header
  // are moved once the page settles (content-badge-layout.ts).
  watchBadgeLayout(s.listenerLifetime.signal);

  // Click-to-open lives on the badge pill itself (content-overlays.ts).
  // No document-level body click handler — clicks on widget body fall
  // through to BMP's own click handling, which is what users expect.

  s.styleInjected = true;
}

// ── Connection state + toasts ────────────────────────────────────

function handleConnectionState(state: ConnectionState) {
  setCurrentIdentities(state.identities ?? unknownIdentityMap());
  s.prevConnDisplay = state.display;
  s.environment = state.environment ?? null;
  setFrameServer(state);

  const projected = nextConnectionNotification(state, {
    initialized: s.connectionEpochsSeen,
    incidentEpoch: s.lastIncidentEpoch,
    recoveryEpoch: s.lastRecoveryEpoch,
  });
  s.connectionEpochsSeen = projected.cursor.initialized;
  s.lastIncidentEpoch = projected.cursor.incidentEpoch;
  s.lastRecoveryEpoch = projected.cursor.recoveryEpoch;
  if (projected.notification) {
    traceConnectionDiagnostic({
      source: 'content-notification',
      semanticRevision: state.semanticRevision,
      decision: `${projected.notification.kind}:${state.incidentEpoch ?? 0}:${state.recoveryEpoch ?? 0}`,
    });
    showToast(projected.notification.text, projected.notification.kind);
  }
}

function handleProfileSwitched(label: string) {
  showToast(`Switched to ${label}`, 'info');
  // Any Blueprint overlay belongs to the previous server: leave it through the one exit check, so
  // unsaved changes are never dropped without the confirm. (Since requests are bound to the page's
  // own server, a panel's switch no longer reaches pages; this covers any sender that still does.)
  void requestBlueprintExit().then(ok => {
    if (!ok) return;
    sendToSW({ type: 'BLUEPRINT_CLOSE' });
    sendBlueprintCmd({ cmd: 'disable' });
    sendBlueprintCmd({ cmd: 'resetOverlayCaches' }); // colours + InputSet lists are per-workspace — drop the overlay's caches
  });
  s.resetEditPageInspection();
}

/** The Blueprint exit check (content-blueprint-entry.ts publishes it once the editor is loaded).
 *  Without a loaded editor there is nothing to lose. */
function requestBlueprintExit(): Promise<boolean> {
  const ask = window.__crevBpRequestExit;
  if (!ask) return Promise.resolve(true);
  return ask().catch(() => true);
}

// ── BMP Detection ────────────────────────────────────────────────

function publishDetection(result: ReturnType<typeof detectBmpPage>, requestMainWorldSignals = true) {
  const normalized = { ...result, signals: [...new Set(result.signals)] };
  const previous = s.lastDetection;
  s.lastDetection = normalized;
  const changed = !previous
    || previous.isBmp !== normalized.isBmp
    || previous.confidence !== normalized.confidence
    || previous.signals.join('\u0000') !== normalized.signals.join('\u0000');
  if (changed) {
    sendToSW({
      type: 'DETECTION_RESULT',
      confidence: normalized.confidence,
      signals: normalized.signals,
      isBmp: normalized.isBmp,
    });
    if (requestMainWorldSignals) {
      document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'CHECK_BMP_SIGNALS' } }));
    }
  }
  return normalized;
}

function runDetection() {
  return publishDetection(detectBmpPage());
}

// ── Page info for side panel ─────────────────────────────────────

function handlePageInfoRequest(): { url: string; rid?: string; tabRid?: string; tabName?: string; contextSource?: PageContext['source']; editContext?: EditPageContext; widgets: WidgetInfo[]; detection?: { confidence: number; signals: string[]; isBmp: boolean } } {
  const urlRids = extractUrlRids();
  // Detection is a cheap snapshot, not a boot-time truth. BMP's React root may
  // mount after this content script, so every explicit page-info request reads
  // the current DOM instead of trusting a stale negative cache.
  const det = runDetection();
  // Always scan widgets when there ARE data-rid elements, regardless of the
  // detection confidence score. The score is informational; a low-confidence
  // page that still has data-rid elements is worth listing rather than
  // hiding behind a detection gate. The empty state remains accurate on
  // truly non-BMP pages because scanPageWidgets returns [] in that case.
  const widgets = scanPageWidgets();

  // Context is core page identity, whereas detection is only a confidence/UI
  // signal. Never gate the fiber provider on the heuristic detector.
  document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'EXTRACT_FIBERS' } }));

  // Single resolution — URL ⊕ fiber. On a custom-routed page (no `?rid=`) the
  // bound object comes from the fiber context the interceptor posted; the
  // EXTRACT_FIBERS dispatch above keeps it fresh (a late PAGE_CONTEXT triggers
  // a re-query, see the PAGE_CONTEXT handler).
  const ctx = resolvePageContext(urlRids, s.fiberPageContext);

  return {
    url: window.location.href,
    rid: ctx.rid,
    tabRid: ctx.tabRid,
    tabName: ctx.tabName,
    contextSource: ctx.source,
    editContext: s.editPageContext ?? undefined,
    widgets,
    detection: { confidence: det.confidence, signals: det.signals, isBmp: det.isBmp },
  };
}

/** Fiber page context arrived from the interceptor. Cache it locally (for the
 *  next PAGE_INFO) and forward to the SW, which caches it per tab for the
 *  footer + editor EC `this` and refreshes the panel when it changes. Deduped
 *  so a re-scan that yields the same context doesn't churn the SW/panel. */
function handleFiberPageContext(rid?: string, tabRid?: string) {
  const prev = s.fiberPageContext;
  if (prev?.rid === rid && prev?.tabRid === tabRid) return;
  s.fiberPageContext = (rid || tabRid) ? { rid, tabRid } : null;
  sendToSW({ type: 'PAGE_CONTEXT', rid, tabRid });
  if (s.inspectActive) {
    syncPageHeaderIdentity(s, getPageHeaderRid());
  }
}

function handleEditPageContext(context?: EditPageContext) {
  const previousRid = s.editPageContext?.editPageRid;
  s.editPageContext = context ?? null;
  if (previousRid !== context?.editPageRid) s.resetEditPageInspection();
  if (s.inspectActive && previousRid !== context?.editPageRid) {
    syncPageHeaderIdentity(s, getPageHeaderRid());
  }
}

// ── Service worker message handling ──────────────────────────────

onPortMessage((msg: InspectorMessage) => {
  switch (msg.type) {
    case 'INSPECT_STATE':
      setInspectMode(msg.active);
      break;
    // Blueprint: BLUEPRINT_STATE arrives via the one-shot channel (oneShotMessageListener), and
    // LAYOUT_LOAD/APPLY are request/response via sendRequest (content-blueprint/service.ts) — neither
    // is dispatched here.
    case 'BADGE_ENRICHMENT':
      // Drop the rid from `requestedRids` as soon as we get ANY
      // response — succeeded or failed. The dedup set's purpose is
      // to prevent duplicate in-flight queries, not to block
      // retries. Without this clear, a transient enrichment failure
      // would lock the rid out for the lifetime of the page.
      s.receiveEnrichments(msg.enrichments);
      if (s.inspectActive) {
        updateLabels(s, Object.keys(msg.enrichments));
        syncPageHeaderIdentity(s, getPageHeaderRid());
        // Names change the badges' widths: re-place them before that paints.
        placeNewBadges(true);
      }
      break;
    case 'ENRICH_MODE':
      if (msg.mode !== s.enrichMode) {
        s.enrichMode = msg.mode;
        if (s.inspectActive) {
          s.requestedRids.clear();
          removePageHeaderIdentity(s);
          removeOverlays(s);
          syncInspectSurface();
        }
      }
      break;
    case 'RE_ENRICH':
      s.retryFailedEnrichments();
      if (s.inspectActive) syncInspectSurface();
      break;
    case 'RESET_OVERLAY_CACHES':
      // A manual sidebar Reset — drop the blueprint overlay's per-workspace caches (colours + InputSet
      // lists) so the next style-mode / picker open re-fetches. (RE_ENRICH is NOT a safe hook — it also
      // fires on reconnect/enrichment, which would defeat the caches.)
      sendBlueprintCmd({ cmd: 'resetOverlayCaches' });
      break;
    case 'CONNECTION_STATE':
      handleConnectionState(msg.state);
      break;
    case 'PROFILE_SWITCHED':
      handleProfileSwitched(msg.label);
      break;
  }
  // Broadcast subscribers run last — see handler-registry.ts. The switch
  // above stays the source of truth for content-script state mutation; new
  // feature modules wanting to observe (without joining the switch) should
  // subscribe() instead.
  dispatchBroadcast(msg);
});

onReconnect(() => {
  s.requestedRids.clear();
  if (s.lastDetection) {
    const det = s.lastDetection;
    queueMicrotask(() => {
      sendToSW({ type: 'DETECTION_RESULT', confidence: det.confidence,
                 signals: det.signals, isBmp: det.isBmp });
    });
  }
  // Don't syncOverlays here — the SW sends INSPECT_STATE on port connect,
  // which triggers setInspectMode() → syncOverlays(). Calling it here
  // would race against the message and run with stale s.inspectActive.
});

// ── Context menu RID tracking ────────────────────────────────────

document.body.addEventListener('contextmenu', (e) => {
  const ridEl = (e.target as HTMLElement).closest?.('[data-rid]');
  if (ridEl) {
    const rid = ridEl.getAttribute('data-rid');
    if (rid) {
      const enrichment = s.enrichments.get(rid);
      // Right-click makes the widget the tab's current position (the
      // context menu acts on it; the side panel's context chip shows it).
      pointAt(rid, enrichment, 'contextmenu');
      markCurrent(rid);
      // Confirm the pick in-page — otherwise the only signal is the panel
      // updating, which the user may not be looking at (it can be on another
      // tab/window). Ring the element + a terse toast naming what's now context.
      flashContext(ridEl as HTMLElement);
      const label = enrichment?.name ?? enrichment?.businessId;
      showToast(label ? `Context: ${label}` : 'Context set', 'info');
    }
  }
}, { capture: true, signal: s.listenerLifetime.signal });

// ── Messages from MAIN world interceptor (via CustomEvent) ───────

document.addEventListener('crev-interceptor', ((event: CustomEvent) => {
  // The page shares this `document` with the MAIN-world interceptor (see
  // lib/validate-inbound.ts) — a compromised/XSS'd page could forge this
  // event, so validate shape before acting on it. Malformed payloads are
  // dropped silently (allowlist).
  const msg = parseInterceptorMessage(event.detail);
  if (!msg) return;
  if (msg.type === 'OBJECTS_DISCOVERED') {
    sendToSW(msg);
  }

  if (msg.type === 'PAGE_CONTEXT') {
    handleFiberPageContext(msg.rid, msg.tabRid);
  }

  if (msg.type === 'EDIT_PAGE_CONTEXT') {
    handleEditPageContext(msg.context);
  }

  if (msg.type === 'BMP_SIGNALS_RESULT') {
    const mainSignals = msg.signals ?? [];
    if (s.lastDetection && mainSignals.length > 0) {
      const uniqueMainSignals = [...new Set(mainSignals)];
      const allSignals = [...new Set([...s.lastDetection.signals, ...uniqueMainSignals])];
      const extraWeight = uniqueMainSignals.length * 0.15;
      const confidence = Math.min(1, s.lastDetection.confidence + extraWeight);
      const isBmp = confidence >= 0.5;
      // This is the reply to CHECK_BMP_SIGNALS. Publishing it must not issue
      // the same synchronous CustomEvent request again or the two worlds
      // recurse until Chrome reports "Maximum call stack size exceeded".
      publishDetection({ confidence, signals: allSignals, isBmp }, false);
    }
  }
}) as EventListener, { signal: s.listenerLifetime.signal });

// ── One-shot message handler for side panel requests ─────────────

function oneShotMessageListener(msg: InspectorMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean {
  if (msg.type === 'INSPECT_STATE') {
    setInspectMode(msg.active);
    return false;
  }
  // Blueprint toggle arrives via chrome.tabs.sendMessage (one-shot), like INSPECT_STATE — the
  // SW's BLUEPRINT_TOGGLE handler relays here. (LAYOUT_*_RESULT come back on the port instead.)
  if (msg.type === 'BLUEPRINT_STATE') {
    if (msg.active) activateBlueprint(); else sendBlueprintCmd({ cmd: 'disable' });
    return false;
  }
  // Point and tell: the panel's toggle (relayed by the worker), the worker's explicit set, and its question.
  if (msg.type === 'TOGGLE_POINT_TELL') { setPointTell(window.__crevPtActive !== true); return false; }
  if (msg.type === 'POINT_TELL_SET') { setPointTell(msg.active === true); return false; }
  // The right-click entry "New page here": Point and tell is turned on (when it is not) and asks for the page's name.
  if (msg.type === 'POINT_TELL_NEW_PAGE') { if (window.__crevPtActive !== true) setPointTell(true); sendBlueprintCmd({ cmd: 'pointTellNewPage' }); return false; }
  if (msg.type === 'POINT_TELL_QUERY') { sendResponse({ active: window.__crevPtActive === true }); return false; }
  // The worker asks before it turns Blueprint off (shortcut, panel toggle, Inspect on): the editor
  // answers through its one exit check, which asks the user when changes are unsaved.
  if (msg.type === 'BLUEPRINT_REQUEST_EXIT') {
    void requestBlueprintExit().then(ok => sendResponse({ ok }));
    return true;
  }
  // Object window "Edit in Blueprint": queued behind the enable, so the editor selects the object
  // once its page model has loaded.
  if (msg.type === 'BLUEPRINT_SELECT') {
    if (typeof msg.rid === 'string' && /^-?\d+$/.test(msg.rid)) sendBlueprintCmd({ cmd: 'select', rid: msg.rid });
    return false;
  }
  if (msg.type === 'GET_PAGE_INFO') {
    const info = handlePageInfoRequest();
    sendResponse({ type: 'PAGE_INFO', ...info });
    return true;
  }
  // The worker asks for the bound object when something needs it now (an
  // editor's `this`) and no panel kept it current: the page context only,
  // without the widget scan or the walk over every component for objects.
  if (msg.type === 'GET_PAGE_CONTEXT') {
    document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'EXTRACT_FIBERS', contextOnly: true } }));
    const ctx = resolvePageContext(extractUrlRids(), s.fiberPageContext);
    sendResponse({ type: 'PAGE_CONTEXT', rid: s.fiberPageContext?.rid, tabRid: s.fiberPageContext?.tabRid, resolvedRid: ctx.rid });
    return false;
  }
  if (msg.type === 'LOCATE_ON_PAGE') {
    sendResponse({ found: locateOnPage(Array.isArray(msg.rids) ? msg.rids : []) });
    return false;
  }
  if (msg.type === 'COPY_TO_CLIPBOARD') {
    // Insecure pages have no async clipboard API: copyWithToast falls back and reports either way.
    void copyWithToast(String(msg.text ?? ''), { key: 'crev-copy', detail: String(msg.text ?? '') });
    return false;
  }
  if (msg.type === 'MOUNT_FRAME') {
    void mountFrameOverlay({
      kind: msg.kind,
      url: msg.url,
      label: msg.label,
      defaultWidth: msg.defaultWidth,
      defaultHeight: msg.defaultHeight,
      resourceKey: msg.resourceKey,
      replaceExisting: msg.replaceExisting,
      activation: msg.activation,
    }).then(disposition => {
      sendResponse({ type: 'FRAME_MOUNT_RESULT', disposition });
    }).catch(e => {
      log.swallow('content:mountFrame', e);
      sendResponse({ type: 'FRAME_MOUNT_RESULT', disposition: 'failed' });
    });
    return true;
  }
  if (msg.type === 'BMP_GOTO') {
    // In-place BMP navigation (from the Extended Code editor's "go to this
    // object" action). Switch BMP tab by clicking the matching tab button
    // (no page reload), then scroll-and-highlight the target widget once the
    // tab body re-renders. If we're already on the right tab, skip the click.
    handleBmpGoto(msg);
    return false;
  }
  return false;
}
chrome.runtime.onMessage.addListener(oneShotMessageListener);

function handleBmpGoto(msg: { rid?: string; tabRid?: string; tabName?: string }): void {
  for (const el of document.querySelectorAll('.crev-graph-highlight')) {
    el.classList.remove('crev-graph-highlight');
  }
  let needsTabSwitch = false;
  if (msg.tabName || msg.tabRid) {
    const tabButton = findTabButton(msg.tabRid, msg.tabName);
    if (tabButton) {
      const alreadyActive = isTabActive(tabButton);
      if (!alreadyActive) {
        // Click the tab anchor — BMP intercepts this and switches the tab
        // body in place (SPA-style, no page reload). This is the "smooth
        // switch" path; the full-reload NAVIGATE_BMP is never used here.
        tabButton.click();
        needsTabSwitch = true;
      }
    } else {
      console.warn('[crev] BMP_GOTO: no tab button found for', { tabName: msg.tabName, tabRid: msg.tabRid });
    }
  }
  if (msg.rid) {
    // After a tab switch the widget DOM may not exist yet — wait one
    // frame plus a beat for BMP to re-render before scrolling.
    if (needsTabSwitch) {
      setTimeout(() => scrollAndHighlight(msg.rid!), 250);
    } else {
      scrollAndHighlight(msg.rid);
    }
  }
}

// Tab matching + active-state detection live in dom-scanner.ts (the single
// source of truth for BMP's tab DOM shape). content.ts used to carry its own
// drifted copy that matched none of BMP's real `.corpo-tabSet__tab` anchors —
// so BMP_GOTO silently found no button and tab navigation did nothing.

function scrollAndHighlight(rid: string): void {
  const escaped = rid.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
  const target = document.querySelector(`[data-rid="${escaped}"], [data-object-rid="${escaped}"]`);
  if (target instanceof HTMLElement) {
    target.classList.add('crev-graph-highlight');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/** Browse's "Locate on page": scroll the first of `rids` that has an element
 *  into view, dim the page around it and pulse a ring (an edge flag points
 *  to it while it is off screen; content-current.ts). It becomes the current
 *  object. The list is the object followed by its ancestors, because objects
 *  inside a widget (inputs of an input set) have no element of their own.
 *  Prefers a visible element. Returns the rid found, or null. */
function locateOnPage(rids: readonly unknown[]): string | null {
  const all = getAllRidElements(true);
  for (const rid of rids) {
    if (typeof rid !== 'string' || !/^-?\d+$/.test(rid)) continue;
    const labelled = document.querySelector(`.crev-label[data-crev-label="${rid}"]`)?.parentElement ?? null;
    const hits = all.filter(e => e.rid === rid).map(e => e.element);
    if (labelled) hits.unshift(labelled);
    const el = hits.find(e => (e as HTMLElement).offsetParent !== null) ?? hits[0];
    if (!(el instanceof HTMLElement)) continue;
    ensureOverlayStyle();
    const known = s.enrichments.get(rid);
    locateElement(el, { rid, name: known?.name || known?.businessId || 'Located object', type: known?.type });
    return rid;
  }
  return null;
}

/** Brief self-fading ring confirming a right-click context pick landed on this
 *  element. Restart-safe: drop the class + force reflow so a rapid second pick
 *  re-runs the animation instead of sitting idle on the spent one. */
function flashContext(el: HTMLElement): void {
  el.classList.remove('crev-context-flash');
  void el.offsetWidth;
  el.classList.add('crev-context-flash');
  setTimeout(() => el.classList.remove('crev-context-flash'), 1400);
}

// ── Init ─────────────────────────────────────────────────────────

function resetContentState() {
  endLocate();
  removePageHeaderIdentity(s);
  removeOverlays(s);
  teardownFrameOverlayModule();
  sendBlueprintCmd({ cmd: 'disable' });
  setPointTell(false);
  document.getElementById(OVERLAY_STYLE_ID)?.remove();
  document.getElementById('crev-tooltip')?.remove();
  document.getElementById('crev-toast-container')?.remove();
  // resetAll() aborts the listener lifetime and arms a fresh controller for
  // the next injection.
  s.resetAll();
}

/** Fully dispose THIS content-script instance. Stored on `window` so the
 *  next injection can reach it. resetContentState() handles the DOM +
 *  ContentState + lifetime-bound document listeners; the rest tears down
 *  the module-scoped registrations that resetContentState() can't see
 *  (they live in other modules' closures): the one-shot message listener,
 *  and the reconnecting port. */
function teardown() {
  resetContentState();
  try { chrome.runtime.onMessage.removeListener(oneShotMessageListener); } catch (e) { log.swallow('content:teardown:onMessage', e); }
  try { disconnectPort(); } catch (e) { log.swallow('content:teardown:port', e); }
}

// Guard against double injection. A re-injection re-runs this file in the
// same isolated world but with FRESH module closures — so we can't reach
// the previous instance's port/observer/listeners from here. The previous
// instance parked its teardown on window; run it to dispose that instance
// completely before we boot, otherwise both stay live (two MOUNT_FRAME
// handlers → duplicate editor windows; a stale observer/port that re-paints
// overlays after inspect is toggled off).
if (window.__crev_content_loaded) {
  try { window.__crev_teardown?.(); } catch (e) { log.swallow('content:init:teardownPrev', e); }
}
window.__crev_content_loaded = true;
window.__crev_teardown = teardown;
// The previous instance handed its open windows over instead of closing them
// (an object window or editor may hold unsaved edits): take them over.
try { adoptMountedFrames(); } catch (e) { log.swallow('content:init:adoptFrames', e); }

installPageShowInLog();
try { connectPort(); } catch (e) { log.swallow('content:init:port', e); }
try { runDetection(); } catch (e) { log.swallow('content:init:detection', e); }

// Optimistic inspect restore. If this tab was inspecting before this instance
// booted — e.g. the SW idled out and a panel/tab event re-injected content.js
// into the still-live page (the previous instance's teardown removed the
// overlays) — repaint the borders NOW from local state rather than waiting for
// the SW to reconnect and re-push INSPECT_STATE. That wait was the window where
// borders visibly disappeared "after a while". The real INSPECT_STATE reconciles
// when the port connects; enrichment refills lazily.
if (wasInspecting()) {
  try { setInspectMode(true); } catch (e) { log.swallow('content:init:restoreInspect', e); }
}
try {
  startObserver(s, runDetection, syncInspectSurface, () => {
    removePageHeaderIdentity(s);
    removeOverlays(s);
  });
} catch (e) { log.swallow('content:init:observer', e); }

// Post-apply blueprint resume. applyPage turns blueprint off + reloads the page (the live grid only
// reflows on a real load) and leaves a short-lived sessionStorage flag; consume it and ask the SW to
// re-enable blueprint for this tab, restoring the edit target (template vs instance). We wait for the
// first [data-rid] element before asking — enabling against a not-yet-rendered page would resolve no
// rid (landing pages) and anchor nothing. Bounded poll: BMP's first paint is normally < 2 s.
try {
  const raw = sessionStorage.getItem(BP_RESUME_KEY);
  if (raw) {
    sessionStorage.removeItem(BP_RESUME_KEY); // one-shot — a later manual reload must not re-trigger
    const r = readResume(raw, Date.now());
    if (r) {
      window.__crevBpResumePrefer = r.prefer;
      const askResume = (tries: number): void => {
        // A page with nothing on it yet (a page just created) has no [data-rid]: its breadcrumb is the sign that BMP has drawn it.
        if (document.querySelector('[data-rid], .corpo-breadcrumbs__item')) {
          sendFireForget({ type: 'BLUEPRINT_RESUME' });
          if (r.message) showToast(r.message, 'success', undefined, { long: true }); // the apply result, shown once Blueprint is back
          return;
        }
        if (tries > 0) setTimeout(() => askResume(tries - 1), 500);
      };
      askResume(24); // give BMP up to ~12 s to paint before giving up on the resume
    }
  }
} catch (e) { log.swallow('content:init:bpResume', e); }
