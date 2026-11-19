/**
 * Point and tell is owned by the page (its notes and its mode live there). The worker only asks:
 * "is it on in this tab?" so the side panel's button can show the truth when a panel connects or
 * the user switches tabs. A tab that cannot answer (no page tools, still loading) is "off".
 */
import { log } from './logger';

/** Whether Point and tell is on in `tabId`. */
export async function pointTellOnIn(tabId: number | undefined): Promise<boolean> {
  if (tabId == null) return false;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'POINT_TELL_QUERY' }) as { active?: unknown } | undefined;
    return res?.active === true;
  } catch (e) {
    log.swallow('pointTell:query', e);
    return false;
  }
}

/** Whether Point and tell is on in the active tab of `windowId`. */
export async function pointTellOnInWindow(windowId: number): Promise<boolean> {
  const tabs = await chrome.tabs.query({ active: true, windowId }).catch(() => [] as chrome.tabs.Tab[]);
  return pointTellOnIn(tabs[0]?.id);
}
