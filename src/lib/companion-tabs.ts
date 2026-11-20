/**
 * Companion's own pages that open in a browser tab (Access, Colors and
 * images) show no side panel. The panel is global (manifest `side_panel`,
 * opened on the toolbar click), so it would stay beside such a tab and take
 * width the page needs. Chrome's documented way to keep the panel off some
 * tabs is `sidePanel.setOptions({ tabId, enabled: false })`. Nothing else here
 * sets per-tab options, so this module owns them: it disables a tab when a
 * Companion page loads in it, enables it again when that tab goes to another
 * page, and resets a tab that closes. In Chrome 151 that setting alone does not
 * take a panel that is already open off the tab, so when a Companion page is
 * opened in the window's active tab the panel of that window is also closed
 * (`sidePanel.close`, Chrome 141 and later).
 *
 * Asking for the panel on such a tab by hand (the keyboard command, "Show in
 * Log") enables it for that tab first. The toolbar button follows Chrome's
 * own rule for a tab with no panel.
 */

/** Pages that open as a tab. Windows and in-page frames are not listed: no
 *  panel sits beside them. */
export const COMPANION_TAB_PAGES: readonly string[] = ['access/access.html', 'colors-images/colors-images.html'];

const KEY = 'crev_panel_hidden_tabs';

export function isCompanionTabUrl(url: string | undefined): boolean {
  if (!url) return false;
  const base = chrome.runtime.getURL('');
  return COMPANION_TAB_PAGES.some(p => url === base + p || url.startsWith(base + p + '?') || url.startsWith(base + p + '#'));
}

/** Tabs whose panel this module turned off. Kept in session storage so a
 *  worker restart does not forget them (and leave a tab without a panel
 *  after it goes to a BMP page). */
let hidden: Set<number> | undefined;
/** Tabs where the user turned the panel back on by hand: a new address in the same Companion page does not hide it again. */
const asked = new Set<number>();
let loading: Promise<Set<number>> | undefined;

async function hiddenTabs(): Promise<Set<number>> {
  if (hidden) return hidden;
  loading ??= (async () => {
    let ids: number[] = [];
    try {
      const stored = (await chrome.storage.session.get(KEY))[KEY];
      if (Array.isArray(stored)) ids = stored.filter((n): n is number => Number.isInteger(n));
    } catch { /* no session storage: start empty */ }
    hidden = new Set([...ids, ...(hidden ?? [])]);
    return hidden;
  })();
  return loading;
}

function persist(): void {
  if (!hidden) return;
  chrome.storage.session.set({ [KEY]: [...hidden] }).catch(() => { /* kept in memory */ });
}

/** Test seam: forget everything held in memory. */
export function resetCompanionTabs(): void { hidden = undefined; loading = undefined; asked.clear(); }

/** The panel is off on this tab (synchronous; false until the stored set has loaded). */
export function panelHiddenOn(tabId: number, url?: string): boolean {
  return isCompanionTabUrl(url) || !!hidden?.has(tabId);
}

/**
 * Close the panel of a window. Observed in Chrome 151: an open panel stays
 * beside a tab whose setting was made earlier (the setting only keeps the
 * toolbar button and a later visit from showing it), so the panel is closed
 * outright. sidePanel.close exists from Chrome 141; before that the panel
 * stays until the user closes it. A closed panel is not brought back here:
 * opening one needs the user's action.
 */
export async function closePanelInWindow(windowId: number): Promise<void> {
  if (typeof chrome.sidePanel?.close !== 'function') return;
  await chrome.sidePanel.close({ windowId }).catch(() => { /* none open */ });
}

async function hide(tabId: number): Promise<void> {
  const set = await hiddenTabs();
  set.add(tabId);
  persist();
  await chrome.sidePanel.setOptions({ tabId, enabled: false });
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.active) await closePanelInWindow(tab.windowId);
}

async function show(tabId: number): Promise<void> {
  const set = await hiddenTabs();
  if (set.delete(tabId)) persist();
  await chrome.sidePanel.setOptions({ tabId, enabled: true });
}

/** A tab was created, or went to a new address. */
export async function companionTabSeen(tabId: number, url: string | undefined): Promise<void> {
  const set = await hiddenTabs();
  if (isCompanionTabUrl(url)) {
    if (!set.has(tabId) && !asked.has(tabId)) await hide(tabId);
  } else {
    asked.delete(tabId);
    if (set.has(tabId)) await show(tabId);
  }
}

/** A tab became the active one: its setting is made again, which in some
 *  Chrome versions takes an open panel off it. */
export async function companionTabActivated(tabId: number): Promise<void> {
  const set = await hiddenTabs();
  if (!set.has(tabId)) return;
  await chrome.sidePanel.setOptions({ tabId, enabled: false });
}

/** A tab closed: our record is dropped and its setting reset. */
export async function companionTabClosed(tabId: number): Promise<void> {
  asked.delete(tabId);
  const set = await hiddenTabs();
  if (!set.delete(tabId)) return;
  persist();
  // Chrome keeps a closed tab's setting; the best an extension can do is leave it enabled.
  await chrome.sidePanel.setOptions({ tabId, enabled: true }).catch(() => { /* nothing to reset */ });
}

/** Tabs that already hold a Companion page (a restored session, a worker
 *  that started after they opened). */
export async function sweepCompanionTabs(): Promise<void> {
  const set = await hiddenTabs();
  // Only what was recorded before the query can be stale; a tab created while it ran is not.
  const recorded = [...set];
  const tabs = await chrome.tabs.query({});
  const alive = new Set<number>();
  for (const t of tabs) {
    if (t.id == null) continue;
    alive.add(t.id);
    await companionTabSeen(t.id, t.url ?? t.pendingUrl);
  }
  let changed = false;
  for (const id of recorded) if (!alive.has(id)) { set.delete(id); changed = true; }
  if (changed) persist();
}

/**
 * Open the panel on a tab because the user asked for it. On a Companion page
 * the tab's panel is turned back on first. `open` must be called while the
 * user's action still counts, so neither call waits for the other: Chrome
 * handles them in the order they are made.
 */
export function openPanelOnTab(tabId: number, url?: string): Promise<void> {
  if (!panelHiddenOn(tabId, url)) return chrome.sidePanel.open({ tabId });
  hidden?.delete(tabId);
  asked.add(tabId);
  persist();
  const enabled = chrome.sidePanel.setOptions({ tabId, enabled: true });
  const opened = chrome.sidePanel.open({ tabId });
  return Promise.all([enabled, opened]).then(() => undefined);
}

export function initCompanionTabs(): void {
  chrome.tabs.onCreated.addListener(tab => {
    if (tab.id != null) void companionTabSeen(tab.id, tab.url || tab.pendingUrl).catch(() => { /* tab gone */ });
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    // Only a new address matters: a reload keeps the tab's setting.
    if (info.url == null) return;
    void companionTabSeen(tabId, info.url).catch(() => { /* tab gone */ });
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => { void companionTabActivated(tabId).catch(() => { /* tab gone */ }); });
  chrome.tabs.onRemoved.addListener(tabId => { void companionTabClosed(tabId); });
  void sweepCompanionTabs().catch(() => { /* a tab closed mid-sweep */ });
}
