/**
 * Per-site access management. The extension ships with NO host permissions: nothing is injected
 * anywhere until the user grants a site through Chrome's standard permission prompt
 * (`chrome.permissions.request`, fired from the side panel — a request must come from a user
 * gesture in an extension page). This replaces the old `<all_urls>` static content scripts, which
 * ran the observer + MAIN-world interceptor on EVERY site and visibly hurt DOM-heavy apps
 * (Google Maps was the reported casualty).
 *
 * For each granted origin the two content scripts are REGISTERED dynamically
 * (`chrome.scripting.registerContentScripts`, persistent across restarts) so future loads of that
 * site behave exactly like the old static injection: content.js at document_idle (ISOLATED) and
 * interceptor.js at document_start (MAIN world). Grants and revocations (chrome://extensions →
 * site settings) are observed via `permissions.onAdded/onRemoved` and re-synced.
 *
 * The panel requests the prompt itself; the SW's job (this module) is registry sync + the
 * first-time injection into the already-open tab that was just granted.
 */
import { log } from './logger';
import { customProviderOrigins, keyedProviders, PROVIDERS } from './ai/providers';
import type { AiSettings } from './ai/types';

const CONTENT_ID = 'crev-content';
const INTERCEPTOR_ID = 'crev-interceptor';
/** Origins on which Companion may inspect the page. Provider API permissions are
 *  fetch-only and must never enter this set. Populated from saved profiles by
 *  reconcileProfileOrigins once settings are ready. */
const pageOrigins = new Set<string>();
/** False until the profile origins are known (settings loaded). Until then
 *  existing registrations are left exactly as they are. */
let pageOriginsKnown = false;

/** `https://host/*` match pattern for a page URL — null for non-http(s) schemes. */
export function originPatternFor(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}/*`;
  } catch { return null; }
}

/** Whether `url` is on the origin of a configured server profile: the only
 *  pages Companion's page tools may run on. A granted origin alone does not
 *  qualify (an AI provider's API origin is granted for fetches only). */
export function isProfilePage(url: string | undefined, profileUrls: ReadonlyArray<string | undefined>): boolean {
  const pattern = originPatternFor(url);
  return !!pattern && profileUrls.some(profileUrl => originPatternFor(profileUrl) === pattern);
}

/** Typed preflight failure for BMP HTTP calls. Callers can surface the existing
 * site-access repair UI without matching Chrome's browser-specific CORS text. */
export class HostAccessError extends Error {
  readonly code = 'needs-access';
  readonly origin: string;

  constructor(origin: string) {
    super(`Site access required for ${origin}`);
    this.name = 'HostAccessError';
    this.origin = origin;
  }
}

/** Whether the extension may fetch the supplied HTTP(S) URL. Test/Node
 * environments without Chrome's permissions API retain permissive behavior. */
export async function hasHostAccess(url: string): Promise<boolean> {
  const origin = originPatternFor(url);
  if (!origin) return false;
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return true;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/** Guard an extension-origin BMP fetch before it reaches the network. */
export async function assertHostAccess(url: string): Promise<void> {
  const origin = originPatternFor(url);
  if (!origin) throw new HostAccessError(url);
  if (!(await hasHostAccess(url))) throw new HostAccessError(origin);
}

/** All granted host patterns (the optional_host_permissions the user has approved). */
export async function grantedOrigins(): Promise<string[]> {
  try {
    const all = await chrome.permissions.getAll();
    return all.origins ?? [];
  } catch { return []; }
}

let syncTail: Promise<void> = Promise.resolve();

/** Re-derive the dynamic content-script registrations from the profile
 *  origins the user granted. Idempotent and serialized: it changes only what
 *  differs (register what is missing, update a changed origin list, remove
 *  only when no origin is left), never unregisters-then-registers, and does
 *  nothing before the profile origins are known (a worker start or a failed
 *  settings read keeps the existing registrations). */
export function syncRegisteredScripts(): Promise<void> {
  const task = syncTail.catch(() => { /* a failed sync must not block the next */ }).then(syncRegisteredScriptsOnce);
  syncTail = task;
  return task;
}

const sameSet = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  !!a && a.length === b.length && b.every(x => a.includes(x));

async function syncRegisteredScriptsOnce(): Promise<void> {
  if (!pageOriginsKnown) return;
  const origins = (await Promise.all([...pageOrigins].map(async origin => {
    try {
      return await chrome.permissions.contains({ origins: [origin] }) ? origin : null;
    } catch {
      return null;
    }
  }))).filter((origin): origin is string => origin !== null);
  let existing: chrome.scripting.RegisteredContentScript[] = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_ID, INTERCEPTOR_ID] });
  } catch (e) { log.swallow('siteAccess:registered', e); return; }
  if (!origins.length) {
    if (existing.length) {
      try { await chrome.scripting.unregisterContentScripts({ ids: existing.map(s => s.id) }); }
      catch (e) { log.swallow('siteAccess:unregister', e); }
    }
    return;
  }
  const wanted: chrome.scripting.RegisteredContentScript[] = [
    { id: CONTENT_ID, js: ['content.js'], matches: origins, runAt: 'document_idle', persistAcrossSessions: true },
    { id: INTERCEPTOR_ID, js: ['interceptor.js'], matches: origins, runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
  ];
  const missing = wanted.filter(w => !existing.some(e => e.id === w.id));
  const changed = wanted.filter(w => {
    const e = existing.find(x => x.id === w.id);
    return e && !sameSet(e.matches, origins);
  });
  try {
    if (missing.length) await chrome.scripting.registerContentScripts(missing);
    if (changed.length) await chrome.scripting.updateContentScripts(changed);
  } catch (e) { log.swallow('siteAccess:register', e); }
}

/** First-time injection into an already-open tab right after its origin was granted — the
 *  registered scripts only cover FUTURE page loads. Mirrors the static pair. */
export async function injectIntoTab(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['interceptor.js'], world: 'MAIN' });
  } catch (e) { log.swallow('siteAccess:injectInterceptor', e); }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) { log.swallow('siteAccess:injectContent', e); }
}

/** Wire the permission listeners + reconcile at boot. Called once from the service worker. */
export function initSiteAccess(): void {
  try {
    chrome.permissions.onAdded.addListener(() => { void syncRegisteredScripts(); });
    chrome.permissions.onRemoved.addListener(() => { void syncRegisteredScripts(); });
  } catch (e) { log.swallow('siteAccess:listeners', e); }
  void syncRegisteredScripts();
}

/** False after a failed settings load: the in-memory profile list is then the
 *  empty default, and reconciling against it would revoke every grant. */
let reconciliationAllowed = true;
export function setGrantReconciliationAllowed(allowed: boolean): void {
  reconciliationAllowed = allowed;
}

/** Make the granted origins EXACTLY the configured profiles plus the selected AI model's API
 *  origin, then re-sync content-script registrations. A removed or replaced AI configuration
 *  therefore drops its old provider grant instead of keeping every provider indefinitely.
 *  Runs at SW boot and after every profile/AI change. Granting stays in the panel because
 *  permissions.request needs a user gesture; removal needs none. */
export async function reconcileProfileOrigins(
  profileUrls: Array<string | undefined>,
  ai?: AiSettings,
): Promise<void> {
  if (!reconciliationAllowed) {
    log.warn('siteAccess:reconcileBlocked', 'settings did not load; grants left unchanged');
    return;
  }
  const configuredPages = profileUrls.map(originPatternFor).filter((p): p is string => !!p);
  pageOrigins.clear();
  for (const origin of configuredPages) pageOrigins.add(origin);
  pageOriginsKnown = true;
  const keep = new Set(configuredPages);
  // Every provider that keeps a key keeps its API origin, so switching the
  // active provider never needs a new browser prompt. Removing a key drops it.
  for (const provider of keyedProviders(ai)) {
    try {
      if (provider === 'custom') customProviderOrigins(ai?.customProvider).forEach(origin => keep.add(origin));
      else keep.add(PROVIDERS[provider].origin);
    } catch (e) {
      // Malformed legacy settings must not pin an otherwise-unused grant.
      log.swallow('siteAccess:resolveAiOrigin', e);
    }
  }
  const granted = await grantedOrigins();
  const drop = granted.filter(o => !keep.has(o));
  if (drop.length) {
    try {
      await chrome.permissions.remove({ origins: drop });
    } catch {
      // Some patterns can refuse batch removal (e.g. a legacy <all_urls>) — retry one by one.
      for (const o of drop) {
        try { await chrome.permissions.remove({ origins: [o] }); } catch (e) { log.swallow('siteAccess:remove', e); }
      }
    }
  }
  await syncRegisteredScripts();
}
