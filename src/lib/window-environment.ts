/**
 * A Companion window embedded in a page works on that page's server. The
 * worker binds every request of the window to the profile of the page around
 * it (message-router.ts) and refuses a write whose environment differs.
 *
 * This watcher makes the same fact visible inside the window: when the page
 * under the window now belongs to another server (or to none) than the data
 * the window shows, a banner says so and `blocked()` turns true until the
 * window is reloaded or closed. It asks the worker only for its connection
 * state (no server request), when the window gains focus or becomes visible.
 */
import type { ConnectionState, InspectorMessage } from './types';

export interface WindowEnvironmentWatch {
  /** Re-check now (also runs on focus and visibility). */
  check(): Promise<void>;
  /** True while the page belongs to another server than the window's data. */
  blocked(): boolean;
  dispose(): void;
}

const BANNER_ID = 'crev-window-environment';

function bannerText(pinnedLabel: string | null, now: ConnectionState): string {
  const from = pinnedLabel ? `“${pinnedLabel}”` : 'another server';
  if (!now.environment || now.display === 'not-configured') {
    return `This window shows data from ${from}, but its page no longer belongs to a server Companion is set up for. Saving is blocked. Close the window, or reload it on a server page.`;
  }
  return `This window shows data from ${from}, but its page now belongs to “${now.profileLabel ?? 'another server'}”. Saving is blocked. Reload the window to work on “${now.profileLabel ?? 'that server'}”, or close it.`;
}

function showBanner(text: string | null): void {
  let el = document.getElementById(BANNER_ID);
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'alert');
    // Inline so it shows whatever the window's stylesheet does.
    el.style.cssText = 'position:sticky;top:0;z-index:2147483000;margin:0;padding:8px 12px;font:13px/1.4 system-ui,sans-serif;'
      + 'background:#5c1f1b;color:#ffdad6;border-bottom:1px solid #8c3a33';
    document.body.prepend(el);
  }
  el.textContent = text;
}

/** Watch the page's server against the environment the window's data came
 *  from (`pinned`, `profileId@server`; undefined until data was read). */
export function watchWindowEnvironment(pinned: () => string | undefined): WindowEnvironmentWatch {
  let pinnedLabel: string | null = null;
  let isBlocked = false;
  let disposed = false;
  const check = async (): Promise<void> => {
    if (disposed) return;
    let state: ConnectionState | undefined;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' } satisfies InspectorMessage) as InspectorMessage | undefined;
      if (res?.type === 'CONNECTION_STATE') state = res.state;
    } catch { return; }
    const expected = pinned();
    if (!state || !expected || disposed) return;
    if (state.environment === expected) {
      pinnedLabel = state.profileLabel ?? pinnedLabel;
      if (isBlocked) { isBlocked = false; showBanner(null); }
      return;
    }
    // The profile part decides; the same profile with a refreshed client
    // keeps its token, so any difference is another server.
    isBlocked = true;
    showBanner(bannerText(pinnedLabel, state));
  };
  const onFocus = () => { void check(); };
  const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisible);
  void check();
  return {
    check,
    blocked: () => isBlocked,
    dispose: () => {
      disposed = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
