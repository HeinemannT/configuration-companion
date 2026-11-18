/**
 * Side-panel consequence owner.
 *
 * Both inbound transports and every tab transition enter here.  The public
 * interface is deliberately small; the implementation owns the ordering
 * between claims, shared state, always-live tabs, the visible tab, panel
 * chrome, and broadcast subscribers.
 */

import { showSettingsStatus } from './settings-status';
import type { InspectorMessage } from '../lib/types';
import { dispatchBroadcast } from '../lib/handler-registry';
import { showToast, type ToastOptions } from '../lib/toast';
import { contextFromData } from './context-state';
import { workStatusForMessage, type WorkStatus } from './work-status';
import { S, sendMessage } from './state';
import { resetObjectPreview } from '../lib/object-chip';
import { statusFlash } from '../lib/dom';
import type { Tab } from './tabs/tab-types';

export type PanelTabId = 'connect' | 'browse' | 'ai' | 'log';

interface LiveLogTab extends Tab {
  showWorkStatus(status: WorkStatus): void;
  /** Open the entry in the list and highlight it, once it is there. */
  reveal(id: number): void;
}

interface LiveAiTab extends Tab {
  submitHandoff(
    text: Extract<InspectorMessage, { type: 'AI_CHAT_HANDOFF' }>['text'],
    quote: Extract<InspectorMessage, { type: 'AI_CHAT_HANDOFF' }>['quote'],
    envelope: Extract<InspectorMessage, { type: 'AI_CHAT_HANDOFF' }>['envelope'],
  ): void;
}

export interface PanelOrchestratorHost {
  readonly app: HTMLElement;
  readonly tabs: Record<PanelTabId, Tab>;
  readonly logTab: LiveLogTab;
  readonly aiTab: LiveAiTab;

  getActivePanel(): HTMLElement | null;
  getTabPanel(tab: PanelTabId): HTMLElement | null;
  persistActiveTab(tab: PanelTabId): void;
  showSelectedTab(tab: PanelTabId): void;
  renderActiveTab(): void;

  ensureAiTab(): void;
  syncAiTab(): void;

  updateToggle(): void;
  updateContextPill(): void;
  updateLatencyPill(): void;
  updateHeaderStatus(): void;
  refreshConnectionBand(): void;
  updateStatusBar(): void;
  refreshSiteAccess(): void;
}

export interface PanelOrchestratorServices {
  showToast(text: string, kind: Extract<InspectorMessage, { type: 'TOAST' }>['kind'], options?: ToastOptions): void;
  dispatchBroadcast(msg: InspectorMessage): number;
  /** One line in the status bar's notice slot. */
  statusFlash(text: string): void;
}

const defaultServices: PanelOrchestratorServices = {
  showToast: (text, kind, options) => showToast(text, kind, undefined, options),
  dispatchBroadcast,
  statusFlash,
};

export interface PanelOrchestrator {
  accept(msg: InspectorMessage): void;
  selectTab(tab: PanelTabId): void;
}

interface SharedConsequences {
  headerChanged: boolean;
  forceActiveRender: boolean;
}

const AI_LIVE_MESSAGES = new Set<InspectorMessage['type']>([
  'AI_CHAT_EVENT',
  'AI_EDITOR_CONTEXT',
  'AI_CONFIG_CHANGED',
  'PROFILE_SWITCHED',
]);

/** Results that settle state owned by one tab must reach that owner even when
 * it is hidden. Activation refresh remains the default for ordinary data; this
 * list is reserved for in-flight flags and responses that cannot be inferred
 * safely from some other message. */
const LIVE_RESULT_OWNER = new Map<InspectorMessage['type'], PanelTabId>([
  ['AI_CONFIG_SAVED', 'connect'],
  ['PROFILE_VERDICT', 'connect'],
  ['AI_TEST_RESULT', 'connect'],
  ['AI_MODELS_RESULT', 'connect'],
  ['BROWSE_TREE_DATA', 'browse'],
  ['BROWSE_SEARCH_RESULT', 'browse'],
  ['BROWSE_RESOLVE_RESULT', 'browse'],
  ['CACHE_DATA', 'browse'],
  ['LOCATE_RESULT', 'browse'],
  ['CHANGES_DATA', 'log'],
]);

export function createPanelOrchestrator(
  host: PanelOrchestratorHost,
  services: PanelOrchestratorServices = defaultServices,
): PanelOrchestrator {
  const selectTab = (tab: PanelTabId): void => {
    const previous = S.activeTab as PanelTabId;
    S.activeTab = tab;
    host.persistActiveTab(tab);

    host.tabs[previous]?.deactivate();
    host.tabs[tab]?.activate();
    host.showSelectedTab(tab);
    host.renderActiveTab();
  };

  const claimMessage = (msg: InspectorMessage): boolean => {
    if (msg.type === 'TOAST') {
      if (msg.logId != null) services.showToast(msg.text, msg.kind, { logId: msg.logId });
      else services.showToast(msg.text, msg.kind);
      return true;
    }
    if (msg.type === 'SHOW_LOG_ENTRY') {
      host.logTab.reveal(msg.id);
      selectTab('log');
      return true;
    }
    if (msg.type === 'REQUEST_FAILED') {
      services.showToast(msg.error, 'error');
      return true;
    }
    // A header button whose window or page mode could not open on the tab.
    if (msg.type === 'PANEL_NOTICE') {
      services.statusFlash(msg.text);
      return true;
    }

    if (msg.type === 'AI_CHAT_HANDOFF') {
      host.ensureAiTab();
      selectTab('ai');
      host.aiTab.submitHandoff(msg.text, msg.quote, msg.envelope);
      return true;
    }

    return false;
  };

  const reduceSharedState = (msg: InspectorMessage): SharedConsequences => {
    let headerChanged = false;
    let forceActiveRender = false;

    switch (msg.type) {
      case 'INSPECT_STATE':
        S.inspectActive = msg.active;
        host.updateToggle();
        break;
      case 'BLUEPRINT_STATE':
        S.blueprintActive = msg.active;
        host.updateToggle();
        break;
      case 'CACHE_STATS':
        S.cacheCount = msg.count;
        break;
      case 'SETTINGS_STATUS':
        showSettingsStatus(msg, sendMessage);
        break;
      case 'SETTINGS_DATA':
        S.settings = msg.settings;
        headerChanged = true;
        if (!S.settings.ai && S.activeTab === 'ai') selectTab('connect');
        host.syncAiTab();
        host.refreshSiteAccess();
        break;
      case 'CONNECTION_STATE':
        S.connState = msg.state;
        headerChanged = true;
        host.updateToggle();
        host.updateLatencyPill();
        break;
      case 'DETECTION_STATE':
        S.bmpDetected = msg.phase === 'detected' ? true : msg.phase === 'not-detected' ? false : null;
        headerChanged = true;
        break;
      case 'PAGE_INFO':
        if (msg.detection) {
          S.bmpDetected = msg.detection.isBmp;
          headerChanged = true;
        }
        S.page = msg.rid
          ? {
              rid: msg.rid,
              ...(msg.tabRid ? { tabRid: msg.tabRid } : {}),
              ...(msg.tabName ? { tabName: msg.tabName } : {}),
            }
          : null;
        break;
      case 'CONTEXT_RID_DATA':
        S.context = contextFromData(S.context, msg);
        host.updateContextPill();
        break;
      case 'EC_RESULT':
        if ('durationMs' in msg && typeof msg.durationMs === 'number') {
          S.lastEcMs = msg.durationMs;
          host.updateLatencyPill();
        }
        break;
      case 'PROFILE_SWITCHED':
        resetObjectPreview();
        headerChanged = true;
        S.settings = { ...S.settings, activeProfileId: msg.profileId };
        S.context = null;
        S.page = null;
        host.updateContextPill();
        forceActiveRender = true;
        break;
      case 'FAVORITES_DATA':
        S.favoriteEntries = msg.entries;
        break;
      case 'AI_CONFIG_CHANGED':
        S.settings = {
          ...S.settings,
          ai: msg.configured
            ? {
                provider: msg.provider ?? S.settings.ai?.provider ?? 'anthropic',
                model: msg.model ?? '',
                apiKeyEnc: 'set',
                ...(msg.customProvider
                  ? { customProvider: msg.customProvider }
                  : S.settings.ai?.customProvider
                    ? { customProvider: S.settings.ai.customProvider }
                    : {}),
              }
            : undefined,
        };
        if (!msg.configured && S.activeTab === 'ai') selectTab('connect');
        host.syncAiTab();
        break;
    }

    return { headerChanged, forceActiveRender };
  };

  const deliver = (tabId: PanelTabId, msg: InspectorMessage): boolean => {
    const tab = host.tabs[tabId];
    const changed = tab.handleMessage(msg);
    if (!changed || S.activeTab !== tabId) return false;
    const panel = host.getActivePanel();
    if (panel && host.app.contains(panel)) tab.render(panel);
    return changed;
  };

  const accept = (msg: InspectorMessage): void => {
    const workStatus = workStatusForMessage(msg);
    if (workStatus) host.logTab.showWorkStatus(workStatus);

    if (claimMessage(msg)) return;

    // Server load is per server: only the one this panel shows.
    if (msg.type === 'SERVER_LOAD' && msg.profileId && S.settings.activeProfileId && msg.profileId !== S.settings.activeProfileId) return;

    // A late environment-bound answer from the previous profile is dropped.
    if (msg.type === 'BROWSE_TREE_DATA') {
      const separator = msg.environment.indexOf('@');
      const profileId = separator >= 0 ? msg.environment.slice(0, separator) : '';
      if (profileId && S.settings.activeProfileId && profileId !== S.settings.activeProfileId) return;
    }

    const consequences = reduceSharedState(msg);
    const delivered = new Set<PanelTabId>();
    let liveOnly = false;

    if (msg.type === 'ACTIVITY_LOG' || msg.type === 'ACTIVITY_ENTRY') {
      deliver('log', msg);
      delivered.add('log');
      // A saved change marks Browse's page tree for a re-read (when shown).
      if (msg.type === 'ACTIVITY_ENTRY') {
        deliver('browse', msg);
        delivered.add('browse');
      }
      liveOnly = true;
    }
    if (AI_LIVE_MESSAGES.has(msg.type)) {
      deliver('ai', msg);
      delivered.add('ai');
      if (msg.type !== 'PROFILE_SWITCHED') liveOnly = true;
    }

    if (msg.type === 'PROFILE_SWITCHED') {
      // Workspace identity invalidates every tab, including hidden ones. Each
      // tab clears its own projections before a later activation refreshes.
      for (const tabId of Object.keys(host.tabs) as PanelTabId[]) {
        if (!delivered.has(tabId)) deliver(tabId, msg);
        delivered.add(tabId);
      }
      liveOnly = true;
    } else {
      const owner = LIVE_RESULT_OWNER.get(msg.type);
      if (owner && !delivered.has(owner)) {
        deliver(owner, msg);
        delivered.add(owner);
        liveOnly = true;
      }
    }

    const activeTab = S.activeTab as PanelTabId;
    if (!liveOnly && !delivered.has(activeTab)) deliver(activeTab, msg);
    if (consequences.forceActiveRender) host.renderActiveTab();

    if (consequences.headerChanged) {
      host.updateHeaderStatus();
      host.refreshConnectionBand();
      host.updateStatusBar();
    }
    if (msg.type === 'ACTIVITY_ENTRY' || msg.type === 'CACHE_STATS') {
      host.updateStatusBar();
    }

    services.dispatchBroadcast(msg);
  };

  return { accept, selectTab };
}
