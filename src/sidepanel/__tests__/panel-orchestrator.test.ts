// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry, InspectorMessage } from '../../lib/types';
import { S } from '../state';
import {
  createPanelOrchestrator,
  type PanelOrchestratorHost,
  type PanelOrchestratorServices,
  type PanelTabId,
} from '../panel-orchestrator';
import type { Tab } from '../tabs/tab-types';

interface Harness {
  trace: string[];
  host: PanelOrchestratorHost;
  services: PanelOrchestratorServices;
  panels: Record<PanelTabId, HTMLElement>;
}

function tab(id: PanelTabId, trace: string[], changed = true): Tab {
  return {
    handleMessage: vi.fn(() => {
      trace.push(`handle:${id}:${S.cacheCount}`);
      return changed;
    }),
    render: vi.fn(() => { trace.push(`render:${id}`); }),
    activate: vi.fn(() => { trace.push(`activate:${id}`); }),
    deactivate: vi.fn(() => { trace.push(`deactivate:${id}`); }),
  };
}

function harness(): Harness {
  const trace: string[] = [];
  const app = document.createElement('main');
  document.body.replaceChildren(app);
  const ids: PanelTabId[] = ['connect', 'browse', 'utilities', 'ai', 'log'];
  const panels = Object.fromEntries(ids.map(id => {
    const panel = document.createElement('section');
    panel.dataset.tab = id;
    app.appendChild(panel);
    return [id, panel];
  })) as Record<PanelTabId, HTMLElement>;

  const tabs = Object.fromEntries(ids.map(id => [id, tab(id, trace)])) as Record<PanelTabId, Tab>;
  const logTab = Object.assign(tabs.log, {
    showWorkStatus: vi.fn(() => { trace.push('work-status'); }),
    reveal: vi.fn((id: number) => { trace.push(`reveal:${id}`); }),
  });
  const aiTab = Object.assign(tabs.ai, {
    submitHandoff: vi.fn(() => { trace.push('ai-handoff'); }),
  });

  const host: PanelOrchestratorHost = {
    app,
    tabs,
    logTab,
    aiTab,
    getActivePanel: () => panels[S.activeTab as PanelTabId] ?? null,
    getTabPanel: id => panels[id],
    persistActiveTab: id => { trace.push(`persist:${id}`); },
    showSelectedTab: id => { trace.push(`show:${id}`); },
    renderActiveTab: () => { trace.push(`render-active:${S.activeTab}`); },
    ensureAiTab: () => { trace.push('ensure-ai'); },
    syncAiTab: () => { trace.push('sync-ai'); },
    updateToggle: () => { trace.push('chrome:toggle'); },
    updateContextPill: () => { trace.push('chrome:context'); },
    updateLatencyPill: () => { trace.push('chrome:latency'); },
    updateHeaderStatus: () => { trace.push('chrome:header'); },
    refreshConnectionBand: () => { trace.push('chrome:strip'); },
    updateStatusBar: () => { trace.push('chrome:status'); },
    refreshSiteAccess: () => { trace.push('chrome:access'); },
  };

  const services: PanelOrchestratorServices = {
    showToast: vi.fn(() => { trace.push('toast'); }),
    dispatchBroadcast: vi.fn(() => { trace.push(`broadcast:${S.cacheCount}`); return 0; }),
    statusFlash: vi.fn((text: string) => { trace.push(`flash:${text}`); }),
  };

  return { trace, host, services, panels };
}

describe('PanelOrchestrator', () => {
  beforeEach(() => {
    S.activeTab = 'connect';
    S.cacheCount = 0;
    S.pointTellActive = false;
    S.context = null;
    S.page = null;
    S.settings = { ...S.settings, activeProfileId: 'current' };
  });

  it('reduces shared state before the active tab and publishes last', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'CACHE_STATS', count: 7 });

    expect(h.trace).toEqual([
      'handle:connect:7',
      'render:connect',
      'chrome:status',
      'broadcast:7',
    ]);
  });

  it('shows the page modes as the page and worker report them, Point and tell among them', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'POINT_TELL_STATE', active: true });
    expect(S.pointTellActive).toBe(true);
    expect(h.trace).toContain('chrome:toggle');

    h.trace.length = 0;
    panel.accept({ type: 'POINT_TELL_STATE', active: false });
    expect(S.pointTellActive).toBe(false);
    expect(h.trace).toContain('chrome:toggle');
  });

  it('keeps claims terminal and ahead of tab delivery and subscribers', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'TOAST', text: 'claimed', kind: 'info' });

    expect(h.trace).toEqual(['toast']);
    expect(h.services.dispatchBroadcast).not.toHaveBeenCalled();
  });

  it('shows a header button failure as one line in the notice slot', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'PANEL_NOTICE', failure: 'no-page', text: 'Open a BMP page in this window first.' });

    expect(h.trace).toEqual(['flash:Open a BMP page in this window first.']);
    expect(h.services.showToast).not.toHaveBeenCalled();
  });

  it('passes the Log entry of an error toast to the toast', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'TOAST', text: 'Save failed', kind: 'error', logId: 12 });

    expect(h.services.showToast).toHaveBeenCalledWith('Save failed', 'error', { logId: 12 });
  });

  it('switches to the Log tab and reveals the entry', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'SHOW_LOG_ENTRY', id: 12 });

    expect(S.activeTab).toBe('log');
    expect(h.trace.indexOf('reveal:12')).toBeGreaterThanOrEqual(0);
    expect(h.trace.indexOf('reveal:12')).toBeLessThan(h.trace.indexOf('activate:log'));
  });

  it('observes work before a message is claimed', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'FETCH_INBOUND', rid: '42', className: 'Widget' });

    expect(h.trace[0]).toBe('work-status');
  });

  it('refreshes an ordinary tab only when it becomes active', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'INSPECT_STATE', active: true });
    expect(h.host.tabs.browse.handleMessage).not.toHaveBeenCalled();

    h.trace.length = 0;
    panel.selectTab('browse');
    expect(h.trace).toEqual([
      'persist:browse',
      'deactivate:connect',
      'activate:browse',
      'show:browse',
      'render-active:browse',
    ]);
  });

  it('keeps Log live while hidden and renders it only while selected', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);
    const entry: ActivityEntry = {
      id: 1,
      time: 1,
      level: 'success',
      message: 'Saved',
    };

    panel.accept({ type: 'ACTIVITY_ENTRY', entry });
    expect(h.host.tabs.log.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.log.render).not.toHaveBeenCalled();
    // Browse hears saves while hidden (its page tree is re-read) but is not drawn.
    expect(h.host.tabs.browse.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.browse.render).not.toHaveBeenCalled();
    expect(h.host.tabs.connect.handleMessage).not.toHaveBeenCalled();

    panel.selectTab('log');
    h.trace.length = 0;
    panel.accept({ type: 'ACTIVITY_ENTRY', entry });
    expect(h.host.tabs.log.handleMessage).toHaveBeenCalledTimes(2);
    expect(h.trace.filter(item => item === 'render:log')).toHaveLength(1);
  });

  it('keeps AI live without double-delivery when AI is selected', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);
    const msg: InspectorMessage = { type: 'AI_EDITOR_CONTEXT', source: null };

    panel.accept(msg);
    expect(h.host.tabs.ai.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.ai.render).not.toHaveBeenCalled();

    panel.selectTab('ai');
    panel.accept(msg);
    expect(h.host.tabs.ai.handleMessage).toHaveBeenCalledTimes(2);
    expect(h.host.tabs.ai.render).toHaveBeenCalledTimes(1);
  });

  it('delivers owner-critical results while their tab is hidden without rendering it', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'BROWSE_TREE_DATA', rid: '9223372036854775807', environment: 'current@https://bmp.example', ok: false, error: 'x' });
    panel.accept({ type: 'AI_TEST_RESULT', ok: true, ms: 12 });

    expect(h.host.tabs.browse.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.browse.render).not.toHaveBeenCalled();
    expect(h.host.tabs.connect.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.connect.render).toHaveBeenCalledTimes(1);
  });

  it('invalidates shared profile state before live and active surfaces', () => {
    const h = harness();
    S.context = { rid: '9223372036854775807' };
    S.page = { rid: '9007199254740993' };
    vi.mocked(h.host.tabs.ai.handleMessage).mockImplementation(() => {
      h.trace.push(`handle:ai:context=${String(S.context)}`);
      return true;
    });
    vi.mocked(h.host.tabs.connect.handleMessage).mockImplementation(() => {
      h.trace.push(`handle:connect:context=${String(S.context)}`);
      return true;
    });
    const panel = createPanelOrchestrator(h.host, h.services);

    panel.accept({ type: 'PROFILE_SWITCHED', profileId: 'next', label: 'Next' });

    expect(S.context).toBeNull();
    expect(S.page).toBeNull();
    expect(h.trace).toContain('handle:ai:context=null');
    expect(h.trace).toContain('handle:connect:context=null');
    expect(h.host.tabs.browse.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.host.tabs.log.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.trace.at(-1)).toBe('broadcast:0');
  });

  it('rejects a late environment-bound result from the previous profile', () => {
    const h = harness();
    const panel = createPanelOrchestrator(h.host, h.services);
    panel.accept({ type: 'PROFILE_SWITCHED', profileId: 'next', label: 'Next' });
    vi.clearAllMocks();

    panel.accept({
      type: 'BROWSE_TREE_DATA',
      rid: '42',
      ok: false,
      environment: 'current@https://old.example',
    });

    expect(h.host.tabs.browse.handleMessage).not.toHaveBeenCalled();
    expect(h.services.dispatchBroadcast).not.toHaveBeenCalled();
  });
});
