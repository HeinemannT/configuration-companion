/**
 * Per-site access handler. The PANEL fires chrome.permissions.request itself (the standard Chrome
 * prompt needs a user gesture in an extension page) and then tells the SW the world changed; this
 * handler re-syncs the dynamic content-script registrations and boots the freshly-granted tab so
 * the user doesn't have to reload it (registered scripts only apply to future page loads).
 */
import { register } from '../handler-registry';
import { boundContexts, ctxOf } from '../sw-context';
import { syncRegisteredScripts, injectIntoTab } from '../site-access';
import { mayInjectPageTools, sendPageInfoToPanel } from '../content-script-injection';
import { validateConnection } from '../connection';

register('SITE_ACCESS_CHANGED', async (msg, _respond, meta) => {
  await syncRegisteredScripts();
  // Host access changes the available network evidence. Revalidate reachability and identity now
  // so the panel cannot retain an "unreachable" result computed before the user clicked Allow.
  for (const bound of boundContexts()) void validateConnection('evidence-change', bound);
  if (msg.tabId != null) {
    // Only a page of a configured server profile gets the page tools; a
    // grant for an AI provider's API origin is for fetches only.
    const tab = await chrome.tabs.get(msg.tabId).catch(() => undefined);
    if (!(await mayInjectPageTools(tab?.url))) return;
    await injectIntoTab(msg.tabId);
    ctxOf(meta).logActivity('success', 'Site access granted: Companion enabled');
    // Detection + Page tab refresh now that the content script is live.
    setTimeout(() => sendPageInfoToPanel(msg.tabId), 300);
  }
});
