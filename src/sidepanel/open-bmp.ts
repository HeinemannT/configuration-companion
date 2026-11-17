/**
 * "Open BMP" for the Sign in to BMP state: bring the server's existing BMP
 * tab to the front (this window first), or open the workspace in a new tab.
 */
import { parseServerUrl } from '../lib/server-url';

export interface TabLike {
  id?: number;
  windowId?: number;
  url?: string;
  active?: boolean;
  lastAccessed?: number;
}

/** True when `tabUrl` is a page of the workspace at `bmpUrl` (same origin, path inside it). */
export function isWorkspaceTab(tabUrl: string | undefined, bmpUrl: string): boolean {
  if (!tabUrl) return false;
  const parsed = parseServerUrl(bmpUrl);
  if (!parsed.ok) return false;
  try {
    const base = new URL(parsed.url);
    const tab = new URL(tabUrl);
    if (tab.origin !== base.origin) return false;
    const root = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    const path = tab.pathname.endsWith('/') ? tab.pathname : `${tab.pathname}/`;
    return path.toLowerCase().startsWith(root.toLowerCase());
  } catch {
    return false;
  }
}

/** The tab to bring forward: in `windowId` first, then the active one, then the most recent. */
export function pickBmpTab<T extends TabLike>(tabs: readonly T[], bmpUrl: string, windowId: number | null): T | null {
  const candidates = tabs.filter(t => t.id != null && isWorkspaceTab(t.url, bmpUrl));
  if (!candidates.length) return null;
  const score = (t: T) => (t.windowId === windowId ? 4 : 0) + (t.active ? 2 : 0);
  return [...candidates].sort((a, b) => score(b) - score(a) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

export interface OpenBmpApi {
  currentWindowId(): Promise<number | null>;
  queryTabs(): Promise<TabLike[]>;
  focusTab(tab: TabLike): Promise<void>;
  createTab(url: string, windowId: number | null): Promise<void>;
}

export const chromeOpenBmpApi: OpenBmpApi = {
  async currentWindowId() {
    try { return (await chrome.windows.getCurrent()).id ?? null; } catch { return null; }
  },
  async queryTabs() {
    try { return await chrome.tabs.query({}); } catch { return []; }
  },
  async focusTab(tab) {
    if (tab.id == null) return;
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  },
  async createTab(url, windowId) {
    await chrome.tabs.create({ url, active: true, ...(windowId != null ? { windowId } : {}) });
  },
};

/** Focus the workspace's tab or open it. Returns what happened. */
export async function openBmp(bmpUrl: string, api: OpenBmpApi = chromeOpenBmpApi): Promise<'focused' | 'opened' | 'failed'> {
  const parsed = parseServerUrl(bmpUrl);
  if (!parsed.ok) return 'failed';
  try {
    const windowId = await api.currentWindowId();
    const tab = pickBmpTab(await api.queryTabs(), parsed.url, windowId);
    if (tab) {
      await api.focusTab(tab);
      return 'focused';
    }
    await api.createTab(parsed.url, windowId);
    return 'opened';
  } catch {
    return 'failed';
  }
}
