/**
 * SW-side page-context resolution.
 *
 * The content script resolves page context with `resolvePageContext()` (the
 * pure rule in page-context.ts) from the DOM URL + the React fiber. The SW has
 * no DOM, but the same question — "what object is this tab rendering" — is
 * asked by the footer (GET_CONTEXT_RID), the editor's EC execution `this`
 * (getCurrentPageRid), and the Extended Code console.
 *
 * This module answers it with the SAME rule, fed by the SW's two inputs: the
 * per-tab fiber cache (populated from the content script's PAGE_CONTEXT) and
 * the tab's address-bar `?rid=`/`?tabrid=`. One implementation, so the SW
 * surfaces can't drift from the Page tab.
 */

import { getPageContext, pageContextIsCurrent, setPageContext } from './context-rid';
import { getCtx } from './sw-context';
import { resolvePageContext, type UrlRids } from './page-context';
import type { PageContext } from './types';

/** Read the tab's `?rid=` / `?tabrid=` from the address bar. The SW has no
 *  active-tab-anchor (that's a DOM signal the content script folds in), so this
 *  is the URL provider's SW half. Only BMP-shaped rids (Java long: digits,
 *  optionally negative) pass — a foreign tab whose URL carries `?rid=foo` must
 *  not bind a coincidental object or break `BigInt()` downstream. */
async function urlRidsForTab(tabId: number): Promise<UrlRids> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs?.get) return {};
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return {};
    const p = new URL(tab.url).searchParams;
    const rid = p.get('rid');
    const tabRid = p.get('tabrid') ?? p.get('tabRid');
    return {
      rid: rid && /^-?\d+$/.test(rid) ? rid : undefined,
      tabRid: tabRid && /^-?\d+$/.test(tabRid) ? tabRid : undefined,
    };
  } catch {
    return {};
  }
}

/** The bound object + active tab for a given tab, via the shared priority rule
 *  (URL deep-link wins for `rid`; fiber fills the gap and owns `tabRid`).
 *  Defensive: never throws. */
export async function resolveTabPageContext(tabId: number): Promise<PageContext> {
  await refreshIfStale(tabId);
  const fiber = getPageContext(tabId) ?? null;
  const url = await urlRidsForTab(tabId);
  return resolvePageContext(url, fiber);
}

/** How long a reader waits for the page's answer. */
export const PAGE_CONTEXT_ASK_MS = 1_000;

/** Page info is refreshed only while something shows it (a panel, Inspect).
 *  A reader that needs the bound object at another time (an editor's EC
 *  `this`, Studio) asks the page once here: the page context only, no widget
 *  scan and no walk over every component. */
async function refreshIfStale(tabId: number): Promise<void> {
  if (pageContextIsCurrent(tabId)) return;
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage || !getCtx().contentPorts?.has(tabId)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTEXT' }) as Promise<{ rid?: unknown; tabRid?: unknown } | undefined>,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), PAGE_CONTEXT_ASK_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (!answer) return;
    const rid = typeof answer.rid === 'string' && /^-?\d{1,20}$/.test(answer.rid) ? answer.rid : undefined;
    const tabRid = typeof answer.tabRid === 'string' && /^-?\d{1,20}$/.test(answer.tabRid) ? answer.tabRid : undefined;
    setPageContext(tabId, { rid, tabRid });
  } catch {
    // No content script in the tab: the address bar alone answers.
  }
}
