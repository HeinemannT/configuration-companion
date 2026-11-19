/**
 * Side-panel browser adapter — boot and header/status rendering.
 * Message precedence and tab lifecycle live in panel-orchestrator.ts; this
 * module supplies the concrete tabs, DOM operations, and Chrome listeners.
 */

import { shortcutLabel } from '../lib/shortcuts';
import { escapeLayers } from '../lib/escape-layers';
import { installCheatSheetKey } from '../lib/cheat-sheet';
import type { BmpObject, InspectorMessage } from '../lib/types';
import { h, render, svg } from '../lib/dom';
import { delegate } from './delegate';
import { log } from '../lib/logger';
import { ICON_PULSE } from '../lib/icons';
import { S, sendMessage, getActivePanel, getTabPanel, tabPanelId, onPortMessage, onReconnect, onWorkStatus, connectPanel } from './state';
import { requestOriginsInGesture, refreshSiteAccess } from './site-access-strip';
import type { Tab } from './tabs/tab-types';
import { ConnectTab } from './tabs/connect-tab';
import { BrowseTab } from './tabs/browse-tab';
import { LogTab } from './tabs/log-tab';
import { UtilitiesTab } from './tabs/utilities-tab';
import { applyPrimaryActions, buildPrimaryActions, type PrimaryActionsState } from './header-actions';
import { AiTab } from './tabs/ai-tab';
import { provisionalConnectionSnapshot } from '../lib/connection-snapshot';
import { objectChip } from '../lib/object-chip';
import { runtimeVersion } from '../lib/build-info';
import { createPanelOrchestrator, type PanelTabId } from './panel-orchestrator';
import { describeConnection } from '../lib/connection-copy';
import { CONNECTION_VIEW_CHANGED, selectProfileOptimistically } from './optimistic-profile';
import { originPatternFor } from '../lib/site-access';
import { copyText } from '../lib/copy-feedback';
import { statusFlash } from '../lib/dom';
import { icon, mountShellSprites } from './icons';
import { bandView, serverControlView } from './connection-view';
import { applyServerControl, buildServerControl, glanceAtPage, setMarkWorking, showPanelInactive } from './server-control';
import { NextCheckClock, chromeNextCheckDeps } from './next-check';
import { openBmp } from './open-bmp';
import { installPanelShowInLog } from '../lib/show-in-log';
import { announce, mountLiveRegions } from './announce';
import { toggleMenu } from './menu';
import { displayHost } from './tabs/connect-tab';
import { openObjectViewMessage } from '../lib/open-object';

// ── Tab instances ────────────────────────────────────────────────

const app = document.getElementById('app')!;
const initialSessionState = chrome.storage.session.get([
  'crev_active_tab',
  'crev_settings_snapshot',
  'crev_conn_snapshot',
]).catch((e: unknown) => {
  log.swallow('panel:initialSessionState', e);
  return {} as Record<string, unknown>;
});

/** Open `rid` in the object window on this window's BMP tab. Browse's rows
 *  and crumb use it; it never switches the panel's tab. */
function openInObjectWindow(rid: string) {
  let obj: BmpObject | null = null;
  for (const tab of Object.values(tabs)) {
    obj = tab.findObject?.(rid) ?? null;
    if (obj) break;
  }
  const known = obj ?? (S.context?.rid === rid ? S.context : null);
  sendMessage(openObjectViewMessage(rid, known));
}

const tabs: Record<PanelTabId, Tab> = {
  connect: new ConnectTab(sendMessage),
  browse: new BrowseTab(sendMessage, openInObjectWindow),
  utilities: new UtilitiesTab(sendMessage),
  ai: new AiTab(sendMessage),
  log: new LogTab(sendMessage),
};
const aiTab = tabs.ai as AiTab;
const browseTab = tabs.browse as BrowseTab;

/** The AI tab is present ONLY when a provider key is configured (zero-footprint).
 *  `S.settings.ai` exists iff a key was saved (the session snapshot keeps the
 *  provider even with the key stripped). Kept in sync via AI_CONFIG_CHANGED. */
let aiEnabled = false;
function computeAiEnabled(): boolean { return !!S.settings.ai; }

/** The current object the mark last glanced for (enrichment repaints the pill too). */
let glancedRid: string | null = null;
const logTab = tabs.log as LogTab;
logTab.onActivityChange(() => updateStatusBar());
onWorkStatus(status => logTab.showWorkStatus(status));

// ── Message routing ──────────────────────────────────────────────

const orchestrator = createPanelOrchestrator({
  app,
  tabs,
  logTab,
  aiTab,
  getActivePanel,
  getTabPanel: (tab) => getTabPanel(tab),
  persistActiveTab: (tab) => {
    chrome.storage.session.set({ crev_active_tab: tab }).catch(e => log.swallow('panel:persistTab', e));
  },
  showSelectedTab: (tab) => {
    for (const btn of app.querySelectorAll<HTMLElement>('.tab[data-tab]')) {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
      btn.tabIndex = isActive ? 0 : -1;
    }
    for (const panelName of tabOrder()) {
      getTabPanel(panelName)?.classList.toggle('active', panelName === tab);
    }
    refreshConnectionBand();
  },
  renderActiveTab,
  ensureAiTab,
  syncAiTab,
  updateToggle,
  updateContextPill,
  updateLatencyPill,
  updateHeaderStatus,
  refreshConnectionBand,
  updateStatusBar,
  refreshSiteAccess,
});

onPortMessage(orchestrator.accept);

// An error toast's "Show in Log": straight to the entry, or via the worker when the error has none yet.
installPanelShowInLog(
  (id) => orchestrator.accept({ type: 'SHOW_LOG_ENTRY', id }),
  (request) => { sendMessage({ type: 'SHOW_IN_LOG', text: request.text, ...(request.detail ? { detail: request.detail } : {}) }); },
);

// Another panel document claimed this window; this one gets no more updates.
document.addEventListener('crev:panel-superseded', () => {
  const control = document.getElementById('header-status');
  if (control) showPanelInactive(control);
});

// An optimistic profile selection changed S.connState: repaint the chrome
// that shows it (the worker's next push repaints it again).
document.addEventListener(CONNECTION_VIEW_CHANGED, () => {
  updateHeaderStatus();
  refreshConnectionBand();
  updateStatusBar();
});

// On reconnect, state.ts re-establishes transport identity. The orchestrator
// remains responsible only for refreshing the selected surface.
onReconnect(() => {
  sendMessage({ type: 'GET_CONNECTION_STATE' });
  sendMessage({ type: 'GET_SETTINGS' });
  sendMessage({ type: 'GET_DETECTION' });
  tabs[S.activeTab as PanelTabId]?.activate();
});

connectPanel();

// Runtime broadcasts use the same consequence pipeline as port messages.
chrome.runtime.onMessage.addListener((msg: InspectorMessage) => {
  orchestrator.accept(msg);
  return undefined;
});

// ── Render ───────────────────────────────────────────────────────

/** Every tab that can exist, in bar order. Used for id/label lookups + the
 *  stored-active-tab validity check. The AI slot is only rendered when
 *  configured — see tabOrder(). */
const ALL_TABS = ['connect', 'browse', 'utilities', 'ai', 'log'] as const;

/** The tabs actually rendered right now: base three, plus AI (before Log)
 *  when a provider key is configured. */
function tabOrder(): PanelTabId[] {
  return aiEnabled
    ? ['connect', 'browse', 'utilities', 'ai', 'log']
    : ['connect', 'browse', 'utilities', 'log'];
}

const TAB_LABELS: Record<string, string> = {
  connect: 'Connect', browse: 'Browse', utilities: 'Utilities', ai: 'AI', log: 'Log',
};
const TAB_TITLES: Record<string, string> = {
  connect: 'Servers and settings',
  browse: 'Find objects, and the structure of the page you are on (press / to search)',
  utilities: 'Code Search, Transport, Access, Colors and Images',
  ai: 'Ask about your workspace: a tool-using AI chat grounded in your context',
  log: 'Your saves, runs and errors',
};

const tabButtonId = (t: string) => `tab-${t}`;

function buildTabBar(): HTMLElement {
  const bar = h('div', { class: 'tab-bar ui', role: 'tablist', 'aria-label': 'Companion' },
    ...tabOrder().map(t => {
      const label = TAB_LABELS[t] ?? (t.charAt(0).toUpperCase() + t.slice(1));
      const selected = S.activeTab === t;
      return h('button', {
        class: `tab ${selected ? 'active' : ''}`,
        id: tabButtonId(t),
        type: 'button',
        role: 'tab',
        'aria-selected': selected ? 'true' : 'false',
        'aria-controls': tabPanelId(t),
        tabindex: selected ? '0' : '-1',
        'data-action': 'tab',
        'data-tab': t,
        title: TAB_TITLES[t] ?? '',
      }, label);
    }),
  );
  // Arrow keys move between tabs and select them (automatic activation).
  bar.addEventListener('keydown', (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const all = [...bar.querySelectorAll<HTMLButtonElement>('.tab[data-tab]')];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1
      : (at + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
    const name = all[next].dataset.tab as PanelTabId;
    orchestrator.selectTab(name);
    document.getElementById(tabButtonId(name))?.focus();
  });
  return bar;
}

function buildTabContent(): HTMLElement {
  return h('div', { class: 'tab-content' },
    ...tabOrder().map(t =>
      h('div', {
        class: `tab-panel ${S.activeTab === t ? 'active' : ''}`,
        id: tabPanelId(t),
        role: 'tabpanel',
        'aria-labelledby': tabButtonId(t),
      }),
    ),
  );
}

/** Add / remove the AI tab live when the provider key is configured / cleared.
 *  Rebuilds the tab bar + content panels in place (cheap; the tab instances
 *  persist, so the chat transcript survives). */
function syncAiTab(): void {
  const wasEnabled = aiEnabled;
  aiEnabled = computeAiEnabled();
  if (aiEnabled === wasEnabled) return;
  const bar = app.querySelector('.tab-bar');
  const content = app.querySelector('.tab-content');
  if (bar) bar.replaceWith(buildTabBar());
  if (content) content.replaceWith(buildTabContent());
  renderActiveTab();
}

function ensureAiTab(): void {
  if (aiEnabled) return;
  aiEnabled = true;
  app.querySelector('.tab-bar')?.replaceWith(buildTabBar());
  app.querySelector('.tab-content')?.replaceWith(buildTabContent());
}

/** The connection band: one sentence, one primary action, Retry, Details. */
function buildBand(): HTMLElement {
  return h('div', { class: 'conn-band ui', id: 'conn-band', hidden: true },
    h('p', { class: 'cb-s', id: 'cb-sentence' }),
    h('div', { class: 'cb-a' },
      h('button', { class: 'ui-btn primary cb-btn', type: 'button', id: 'cb-primary', 'data-action': 'band-fix', hidden: true }),
      h('button', { class: 'ui-btn ghost cb-btn', type: 'button', id: 'cb-retry', 'data-action': 'reconnect', hidden: true },
        icon('s-refresh', 'ic-sm'), h('span', null, 'Retry')),
      h('span', { class: 'cb-next', id: 'cb-next' }),
      h('span', { class: 'cb-sp' }),
      h('button', {
        class: 'cb-dtl', type: 'button', id: 'cb-dtl', 'data-action': 'band-details',
        'aria-expanded': 'false', 'aria-controls': 'cb-detail', hidden: true,
      }, 'Details', icon('i-chev', 'ic-sm')),
    ),
    h('div', { class: 'cb-detail', id: 'cb-detail', hidden: true },
      h('code', { id: 'cb-detail-text' }),
      h('button', {
        class: 'ui-ibtn ui-ibtn-sm', type: 'button', 'data-action': 'band-copy',
        title: 'Copy details', 'aria-label': 'Copy details',
      }, icon('i-copy')),
    ),
  );
}

const nextCheck = new NextCheckClock(chromeNextCheckDeps((text) => {
  const el = document.getElementById('cb-next');
  if (el) el.textContent = text ?? '';
}));

function buildApp(): void {
  mountShellSprites(document);
  mountLiveRegions(document);
  const header = h('div', { class: 'header ui' },
    // The switcher carries the mark in its status ring (server-control.ts).
    buildServerControl(),
    h('span', { class: 'hdr-sp' }),
    // The four main actions: Inspect, Blueprint, Point and tell, Extended Code. Everything else is in Utilities.
    buildPrimaryActions(primaryActionsState()),
  );

  const tabBar = buildTabBar();
  const tabContent = buildTabContent();

  // Cache count gets a label so the lone "0" in the corner isn't a mystery.
  // Hidden entirely when zero — nothing useful to surface yet.
  // Only the message is a live region; latency and counts change too often to be read out.
  const statusBar = h('div', { class: 'status-bar', id: 'status-bar' },
    h('div', { class: 'status-bar-activity is-idle', 'aria-live': 'polite' }, idleText()),
    renderContextPill(),
    renderLatencyPill(),
  );

  // Feedback line — short confirmations (badge copies, saves) overlay the
  // status bar's right side for ~1.8s, then the quiet line returns.
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener('crev:status-flash', (e) => {
    const bar = document.getElementById('status-bar');
    if (!bar) return;
    let el = bar.querySelector<HTMLElement>('.status-bar-flash');
    if (!el) { el = h('span', { class: 'status-bar-flash' }); bar.appendChild(el); }
    el.textContent = String((e as CustomEvent).detail ?? '');
    bar.classList.add('status-bar--flash');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { bar.classList.remove('status-bar--flash'); }, 1800);
  });

  render(app, header, tabBar, buildBand(), tabContent, statusBar);
  updateToggle();
  updateHeaderStatus();
  refreshConnectionBand();
  updateStatusBar();
  app.removeAttribute('aria-busy');

  delegate(app, {
    tab: (el) => {
      const tabName = el.dataset.tab;
      if (tabName && (ALL_TABS as readonly string[]).includes(tabName)) {
        orchestrator.selectTab(tabName as PanelTabId);
      }
    },
    reconnect: () => startConnectionTest(),
    'band-fix': () => runBandFix(),
    'band-details': (el) => {
      const detail = document.getElementById('cb-detail');
      if (!detail) return;
      bandDetailsOpen = detail.hidden !== false; // 'until-found' is hidden too
      detail.hidden = !bandDetailsOpen;
      el.setAttribute('aria-expanded', String(bandDetailsOpen));
    },
    'band-copy': () => {
      const text = describeConnection(S.connState).detail ?? '';
      void copyText(text).then(ok => statusFlash(ok ? 'Copied' : 'Copy failed'));
    },
  });

  app.querySelector('#toggle-inspect')?.addEventListener('click', () => sendMessage({ type: 'TOGGLE_INSPECT' }));
  app.querySelector('#toggle-blueprint')?.addEventListener('click', () => sendMessage({ type: 'BLUEPRINT_TOGGLE' }));
  app.querySelector('#toggle-point-tell')?.addEventListener('click', () => sendMessage({ type: 'TOGGLE_POINT_TELL' })); // Point and tell
  app.querySelector('#open-extended')?.addEventListener('click', () => sendMessage({ type: 'OPEN_EXTENDED' }));
  app.querySelector('#header-status')?.addEventListener('click', (e) => showServerMenu(e.currentTarget as HTMLElement));
  // Keyboard: ArrowDown on the switcher opens its menu.
  app.querySelector<HTMLElement>('#header-status')?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).click();
  });

  renderActiveTab();
}

function renderActiveTab() {
  const tab = tabs[S.activeTab as PanelTabId];
  const panel = getActivePanel();
  if (tab && panel) tab.render(panel);
}

// ── Header/Status helpers ────────────────────────────────────────

/** What the header's action buttons read: the panel's mode flags and the page and server state. */
function primaryActionsState(): PrimaryActionsState {
  return {
    inspectActive: S.inspectActive,
    blueprintActive: S.blueprintActive,
    pointTellActive: S.pointTellActive,
    blueprintSupported: S.connState.blueprintSupported !== false,
    bmpDetected: S.bmpDetected,
  };
}

function updateToggle() {
  applyPrimaryActions(app, primaryActionsState());
}

/** Request a connection test and show it as running until the answer. The
 *  worker always answers CONNECTION_TEST with the resulting state, even when
 *  it equals the previous one, so the spinner cannot stay on. A bounded
 *  local fallback covers a lost port. */
let testSpinnerTimer: ReturnType<typeof setTimeout> | null = null;
function startConnectionTest(): void {
  if (!sendMessage({ type: 'CONNECTION_TEST' })) return;
  document.getElementById('cb-retry')?.classList.add('spinning');
  if (testSpinnerTimer) clearTimeout(testSpinnerTimer);
  testSpinnerTimer = setTimeout(() => {
    testSpinnerTimer = null;
    document.getElementById('cb-retry')?.classList.remove('spinning');
  }, 35_000);
}

function activeProfile() {
  return S.settings.profiles.find(p => p.id === S.settings.activeProfileId);
}

/** The band's primary action. Grant access must run inside this click. */
function runBandFix(): void {
  const view = bandView(S.connState);
  const action = view?.primary?.action;
  const profile = activeProfile();
  if (action === 'grant-access') {
    const origin = originPatternFor(profile?.bmpUrl);
    if (origin) void requestOriginsInGesture([origin]);
  } else if (action === 'edit-profile') {
    orchestrator.selectTab('connect');
    document.dispatchEvent(new CustomEvent('crev:edit-active-profile'));
  } else if (action === 'open-bmp' && profile) {
    void openBmp(profile.bmpUrl).then((result) => {
      if (result === 'failed') statusFlash('Could not open BMP');
    });
  }
}

let bandDetailsOpen = false;
let lastAnnounced: string | null = null;

function refreshConnectionBand() {
  const band = document.getElementById('conn-band');
  if (!band) return;
  const view = bandView(S.connState);
  band.hidden = !view;
  app.querySelector('.tab-content')?.classList.toggle('stale', !!view && view.tone === 'fail' && S.activeTab === 'browse');
  nextCheck.setActive(!!view?.nextCheck);
  if (S.connState.validation !== 'validating') {
    if (testSpinnerTimer) { clearTimeout(testSpinnerTimer); testSpinnerTimer = null; }
    document.getElementById('cb-retry')?.classList.remove('spinning');
  }

  // Announce state changes once: errors assertively, the rest politely. The
  // state the panel opens with is not announced unless it is broken.
  const said = view ? view.sentence
    : S.connState.display === 'connected' ? describeConnection(S.connState).sentence : '';
  if (said !== lastAnnounced) {
    if (said && (lastAnnounced !== null || view)) announce(said, view?.tone === 'fail');
    lastAnnounced = said;
  }
  if (!view) return;

  band.className = `conn-band ui ${view.tone}`;
  const sentence = document.getElementById('cb-sentence');
  if (sentence) sentence.textContent = view.sentence;
  const primary = document.getElementById('cb-primary');
  if (primary) {
    primary.hidden = !view.primary;
    primary.textContent = view.primary?.label ?? '';
  }
  const retry = document.getElementById('cb-retry');
  if (retry) retry.hidden = !view.retry;
  const dtl = document.getElementById('cb-dtl');
  const detail = document.getElementById('cb-detail');
  const detailText = document.getElementById('cb-detail-text');
  if (dtl && detail && detailText) {
    dtl.hidden = !view.detail;
    detailText.textContent = view.detail ?? '';
    detail.hidden = !view.detail || !bandDetailsOpen;
    dtl.setAttribute('aria-expanded', String(!!view.detail && bandDetailsOpen));
  }
}

function updateHeaderStatus() {
  const control = document.getElementById('header-status');
  if (control) {
    applyServerControl(control, serverControlView(S.connState, S.settings));
  }
  applyPrimaryActions(app, primaryActionsState());
}

/** The header's server switcher: one item per server, then Connect, then
 *  the project links and the version (they had their own menu under the
 *  logo before the mark moved into the switcher). Links open in a real tab;
 *  the panel keeps its place. */
function showServerMenu(anchor: HTMLElement): void {
  const profiles = S.settings.profiles;
  const manage = { label: profiles.length ? 'Manage servers' : 'Add a server', iconId: 'i-plus', onSelect: () => orchestrator.selectTab('connect') };
  const open = (url: string) => () => { window.open(url, '_blank', 'noopener'); };
  toggleMenu({
    anchor,
    label: 'Servers',
    className: 'srv-menu',
    items: [
      ...profiles.map(p => ({
        label: p.label || p.bmpUrl,
        sub: displayHost(p.bmpUrl),
        checked: p.id === S.settings.activeProfileId,
        onSelect: () => selectProfileOptimistically(p.id),
      })),
      ...(profiles.length ? ['separator' as const] : []),
      manage,
      'separator',
      { label: 'GitHub repo', onSelect: open('https://github.com/HeinemannT/configuration-companion') },
      { label: 'Releases', onSelect: open('https://github.com/HeinemannT/configuration-companion/releases') },
    ],
    footer: runtimeVersion(chrome.runtime.getManifest().version),
  });
}

/** The bar's resting text: Ready only while the server is connected. */
function idleText(): string {
  if (!S.settings.profiles.length) return 'No server';
  return S.connState.display === 'connected' ? 'Ready' : describeConnection(S.connState).label;
}

function updateStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar) return;
  const connected = S.connState.display === 'connected' && S.settings.profiles.length > 0;

  const activity = bar.querySelector<HTMLElement>('.status-bar-activity');
  if (activity) {
    const text = logTab.latestActivityMsg ?? idleText();
    if (activity.textContent !== text) activity.textContent = text;
    activity.title = logTab.latestActivityTitle ?? '';
    activity.classList.toggle('is-working', logTab.isWorking);
    activity.classList.toggle('is-idle', !logTab.latestActivityMsg);
  }
  // The mark reads along while the same work is running.
  const control = document.getElementById('header-status');
  if (control) setMarkWorking(control, logTab.isWorking);

  // Cached objects: only next to a working connection.
  const count = bar.querySelector<HTMLElement>('.status-bar-count');
  if (connected && S.cacheCount > 0) {
    const text = `${S.cacheCount} cached`;
    const title = `${S.cacheCount} cached ${S.cacheCount === 1 ? 'object' : 'objects'}`;
    if (count) { count.textContent = text; count.title = title; }
    else bar.appendChild(h('div', { class: 'status-bar-count', title }, text));
  } else {
    count?.remove();
  }

  updateContextPill();
  updateLatencyPill();
}

// ── Status bar: context + latency chips ───────────────────────────

/** Active-context chip — shows the tab's current position (the object the
 *  user last pointed at, else the page's object) regardless of which panel
 *  tab is visible. Click shows it in Browse's tree; its preview card opens
 *  the object window. */
function renderContextPill(): HTMLElement | null {
  const c = S.context;
  // No server: no page context to show.
  if (!S.settings.profiles.length) return h('div', { class: 'status-bar-context', id: 'status-bar-context', hidden: true });
  if (!c?.rid) return h('div', { class: 'status-bar-context status-bar-context--empty', id: 'status-bar-context', title: `No object. Turn on Inspect (${shortcutLabel('browser.inspect')}) and click a badge, or right-click an element on the BMP page.` }, 'no object');
  // Never a raw RID as the label: the name, else the ID, else the type.
  const label = c.name || c.businessId || c.type || 'Object';
  // When the context is a Tab, prefix the label so it's distinguishable
  // from a same-named widget at a glance — tabs live alongside scorecards
  // and widgets in the chip slot.
  const prefix = c.type === 'Tab' ? 'Tab: ' : '';
  const chip = objectChip(c, {
    environment: c.environment,
    size: 'xs',
    label: prefix + label,
    className: `status-bar-context${c.type === 'Tab' ? ' status-bar-context--tab' : ''}`,
    onActivate: () => revealInBrowse(),
    onOpenFull: () => openInObjectWindow(c.rid),
  });
  chip.id = 'status-bar-context';
  chip.title = `Show ${prefix}${label} in Browse`;
  return chip;
}
/** Context pill: switch to Browse and reveal the current position's row. */
function revealInBrowse(): void {
  browseTab.revealCurrent();
  if (S.activeTab === 'browse') renderActiveTab();
  else orchestrator.selectTab('browse');
}

function updateContextPill(): void {
  // The AI tab mirrors S.context as its selection chip — every context change
  // or enrichment that repaints the pill must also refresh the chips, or the
  // chip badge stays on the sparse (grey) identity forever.
  (tabs['ai'] as AiTab | undefined)?.contextChanged();
  // A new current object: the mark glances at the page it came from.
  const rid = S.context?.rid ?? null;
  if (rid && rid !== glancedRid) {
    const control = document.getElementById('header-status');
    if (control) glanceAtPage(control);
  }
  glancedRid = rid;
  const old = document.getElementById('status-bar-context');
  const next = renderContextPill();
  if (!old || !next) return;
  old.replaceWith(next);
}

/** Latency traffic light — 6-step ramp plus a grey "X" for "no data".
 *  Thresholds are tuned for a typical setup where the bridge daemon sits
 *  behind an SSH tunnel + a remote BMP server (the project's reference
 *  configuration). Health-ping latency for that path runs ~50–120 ms on a
 *  healthy day; EC round-trips on small queries run 100–400 ms.
 *
 *  Tooltip explains what the number is so users on a different setup can
 *  recalibrate mentally without us having to ship per-deployment knobs.
 *
 *  Data source preference: latest EC duration (real user-perceived signal)
 *  if recent, else the health-poll responseMs. Falls back to grey X when
 *  not connected. */
function latencyLevel(ms: number | null, connected: boolean): { tier: number; label: string } {
  if (!connected) return { tier: -1, label: 'disconnected' };
  if (ms == null) return { tier: -1, label: 'no sample yet' };
  // 6-step ramp: 0=excellent → 5=problematic.
  if (ms <  80) return { tier: 0, label: 'excellent' };
  if (ms < 160) return { tier: 1, label: 'good' };
  if (ms < 320) return { tier: 2, label: 'ok' };
  if (ms < 600) return { tier: 3, label: 'slow' };
  if (ms < 1200) return { tier: 4, label: 'very slow' };
  return { tier: 5, label: 'problematic' };
}
function renderLatencyPill(): HTMLElement {
  const connected = S.connState.display === 'connected' && S.settings.profiles.length > 0;
  if (!connected) return h('div', { class: 'status-bar-latency', id: 'status-bar-latency', hidden: true });
  // Prefer EC ms (user-action) — falls back to health-ping responseMs.
  const ms = S.lastEcMs ?? S.connState.responseMs ?? null;
  const { tier, label } = latencyLevel(ms, connected);
  const source = S.lastEcMs != null ? 'last EC round-trip' : 'health-check ping';
  const text = ms == null
    ? '—'
    : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  const title = tier === -1
    ? (connected ? 'No latency sample yet. Run any query to see it' : 'Not connected to BMP')
    : `BMP latency: ${label} (${ms} ms, ${source})`;
  return h('div', { class: `status-bar-latency status-bar-latency--t${tier}`, id: 'status-bar-latency', title },
    h('span', { class: 'status-bar-latency-ic' }, svg(ICON_PULSE)),
    h('span', { class: 'status-bar-latency-value' }, text),
  );
}
function updateLatencyPill(): void {
  const old = document.getElementById('status-bar-latency');
  if (!old) return;
  old.replaceWith(renderLatencyPill());
}

// ── Boot ─────────────────────────────────────────────────────────

// Global Escape: bails out of Browse's page picker so the user can drop the
// modal expectation without hunting for the button to disarm it. The side
// panel is docked: Escape never closes it (no 'window' layer).
const escLayers = escapeLayers();
escLayers.register({ kind: 'panel', name: 'browse-pick', isOpen: () => true, close: () => browseTab.cancelPick() });
escLayers.listen(document);
// `?` lists the side panel's keys (Browse and the browser commands).
installCheatSheetKey(() => ({ window: 'sidepanel', title: 'Side panel: keyboard shortcuts' }));

void initialSessionState.then((result) => {
  if (result.crev_active_tab && typeof result.crev_active_tab === 'string') {
    // Migration: the removed Inspect tab ('workshop', legacy 'inspect' /
    // 'page') and the old Browse key ('objects') land on Browse. Unknown
    // values fall through to the default ('connect').
    const stored = result.crev_active_tab;
    const migrated = ['workshop', 'inspect', 'page', 'objects'].includes(stored) ? 'browse' : stored;
    if ((ALL_TABS as readonly string[]).includes(migrated)) {
      S.activeTab = migrated;
    }
  }
  // chrome.storage.session.get returns Record<string, any>; cast at
  // the slot since we can't constrain the union per-key.
  if (result.crev_settings_snapshot) S.settings = result.crev_settings_snapshot as typeof S.settings;
  if (result.crev_conn_snapshot) {
    const restored = provisionalConnectionSnapshot(result.crev_conn_snapshot, S.settings);
    if (restored) S.connState = restored;
  }
  aiEnabled = computeAiEnabled();
  // A stored 'ai' active tab is only valid once configured.
  if (S.activeTab === 'ai' && !aiEnabled) S.activeTab = 'connect';
  buildApp();
  sendMessage({ type: 'GET_CONNECTION_STATE' });
  sendMessage({ type: 'GET_SETTINGS' });
  sendMessage({ type: 'GET_DETECTION' }); // header's page-state (BMP vs not) for the active tab
  // Pull initial context so the status-bar context chip populates regardless
  // of which tab the user lands on; the SW handler is idempotent.
  sendMessage({ type: 'GET_CONTEXT_RID' });
  orchestrator.selectTab(S.activeTab as PanelTabId);
});
