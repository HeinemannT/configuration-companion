/**
 * Site access from the panel. Access is derived from the servers the user
 * entered (grant on save, revoke on remove — see lib/site-access), so there is
 * no separate grant surface: a missing grant shows as "Grant access" on the
 * server's row, and as the connection band when it is the window's server.
 *
 * The request itself MUST run here in the panel, inside the click's user
 * gesture — a hop to the service worker would drop the gesture and the
 * browser would reject the prompt.
 */
import { showToast } from '../lib/toast';
import { log } from '../lib/logger';
import { originPatternFor } from '../lib/site-access';
import { sendMessage } from './state';

const listeners = new Set<() => void>();
let watching = false;

function notify(): void {
  for (const cb of listeners) {
    try { cb(); } catch (e) { log.swallow('siteAccess:listener', e); }
  }
}

/** Run `cb` whenever a grant changes: a browser-side revoke, a grant, or a request from the panel. */
export function onSiteAccessChanged(cb: () => void): void {
  listeners.add(cb);
  if (watching) return;
  watching = true;
  try {
    chrome.permissions.onAdded.addListener(notify);
    chrome.permissions.onRemoved.addListener(notify);
  } catch (e) { log.swallow('siteAccess:listeners', e); }
}

/** Tell listeners to re-read grants (settings changed: servers were added or removed). */
export function refreshSiteAccess(): void { notify(); }

/** Request `origins` inside the CURRENT user gesture, then let the SW sync registrations and boot
 *  the active tab if it just became accessible. Returns whether the user granted. */
export async function requestOriginsInGesture(origins: string[]): Promise<boolean> {
  if (!origins.length) return true;
  try {
    const granted = await chrome.permissions.request({ origins });
    if (granted) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
      const tabPattern = originPatternFor(tab?.url);
      sendMessage({ type: 'SITE_ACCESS_CHANGED', tabId: tabPattern && origins.includes(tabPattern) ? tab?.id : undefined });
    }
    notify();
    return granted;
  } catch (e) {
    log.swallow('siteAccess:request', e);
    showToast('Permission request failed', 'error');
    return false;
  }
}
