/**
 * Page-connection diagnostics in the Log ("Connecting to the page…",
 * "Companion ready on this page", the BMP detection result).
 *
 * Each one is recorded at most once per page load and tab. A page load
 * starts when the tab reports `status: 'loading'` (tab-awareness). The
 * record of what was logged lives in `chrome.storage.session`, so a worker
 * that wakes up again and re-injects into the same page does not log it a
 * second time. The same sentence from several tabs within the merge window
 * folds into one entry (activity-policy `findRepeat`).
 *
 * Only web pages are logged. Extension pages and browser pages are never
 * BMP pages and are not reported as "not BMP".
 */

import { getCtx } from './sw-context';
import { log } from './logger';

const KEY = 'crev_page_diagnostics';

/** tab id → diagnostics already logged for the tab's current page load. */
type Logged = Record<string, string[]>;

let state: Logged | null = null;
let loading: Promise<Logged> | null = null;

function load(): Promise<Logged> {
  if (state) return Promise.resolve(state);
  loading ??= (async () => {
    let saved: unknown;
    try { saved = (await chrome.storage.session.get(KEY))?.[KEY]; } catch (e) { log.swallow('pageDiagnostics:load', e); }
    state ??= saved && typeof saved === 'object' ? { ...(saved as Logged) } : {};
    return state;
  })();
  return loading;
}

function save(s: Logged): void {
  try { chrome.storage.session.set({ [KEY]: s }).catch(e => log.swallow('pageDiagnostics:save', e)); }
  catch (e) { log.swallow('pageDiagnostics:save', e); }
}

/** A web page (http or https), not an extension or browser page. */
export function isWebPage(url: string | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

/** The tab started a new page load (or closed): its diagnostics may be
 *  logged again. */
export function notePageLoad(tabId: number): Promise<void> {
  return load().then(s => {
    if (!(String(tabId) in s)) return;
    delete s[String(tabId)];
    save(s);
  });
}

/**
 * Log a page diagnostic for `tabId` unless this page load already has it.
 * `key` names the diagnostic (`inject`, `page-ready`, `detection:<phase>`).
 * `url` is the page address when the caller knows it; else it is read from
 * the tab. Returns whether the entry was logged.
 */
export async function logPageDiagnostic(tabId: number | undefined, key: string, message: string, detail?: string, url?: string): Promise<boolean> {
  if (tabId == null) return false;
  let pageUrl = url;
  if (pageUrl === undefined) {
    try { pageUrl = (await chrome.tabs.get(tabId))?.url; } catch { return false; }
  }
  if (!isWebPage(pageUrl)) return false;
  const s = await load();
  const logged = s[String(tabId)] ?? [];
  if (logged.includes(key)) return false;
  s[String(tabId)] = [...logged, key];
  save(s);
  getCtx().logActivity('info', message, detail, { category: 'system', action: key.split(':')[0] });
  return true;
}

/** Test hook: forget the in-memory copy. */
export function _resetPageDiagnosticsForTests(): void {
  state = null;
  loading = null;
}
