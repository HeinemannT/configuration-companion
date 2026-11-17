/**
 * Server URL entry: turn what a configurator types or pastes into the BMP
 * workspace root that every request is built from.
 *
 * Accepted input:
 *   - a bare host and workspace (`demo.corporater.dev/CorpoWebserver`) gets `https://`;
 *   - a deep link pasted from the address bar
 *     (`https://host/Ws/?isHome=true&rid=…`, `https://host/Ws/web/…`, `…#/page`)
 *     is reduced to the workspace root (`https://host/Ws/`).
 * The result always ends in `/` because request paths are appended to it.
 */

export type ServerUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** Path segments that BMP serves below a workspace root. A pasted deep link is
 *  cut at the first of these; everything before it is the workspace. */
const BMP_ROUTE_SEGMENTS = new Set([
  'web', 'cs', 'graphql', 'ticket', 'cstoken', 'health', 'buildnum', 'login', 'signin', 'logout',
]);

/** Parse and normalise a server URL typed by the user. */
export function parseServerUrl(raw: string): ServerUrlResult {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'Enter the address of the BMP workspace, for example demo.corporater.dev/CorpoWebserver.' };
  if (/\s/.test(text)) return { ok: false, error: 'The address contains a space. Paste the address of the BMP workspace as shown in the browser.' };

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  let candidate = text;
  if (schemeMatch && !/^https?:$/i.test(`${schemeMatch[1]}:`)) {
    // `host:8080/Ws` also matches the scheme pattern; only a following `//`
    // or a known non-web scheme identifies a real (unsupported) scheme.
    const isHostPort = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(text);
    if (!isHostPort) return { ok: false, error: 'Use an http:// or https:// address. BMP is served over the web.' };
  }
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate.replace(/^\/+/, '')}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: 'This is not a valid web address. Check the spelling of the server name.' };
  }
  if (!url.hostname || /[^a-z0-9.\-[\]:]/i.test(url.hostname) || url.hostname.startsWith('.') || url.hostname.endsWith('..')) {
    return { ok: false, error: 'This is not a valid web address. Check the spelling of the server name.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Remove the user name and password from the address. Choose a login mode below instead.' };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const kept: string[] = [];
  for (const segment of segments) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep the raw segment */ }
    if (BMP_ROUTE_SEGMENTS.has(decoded.toLowerCase())) break;
    // A file name (`page.html`) is never part of a workspace root.
    if (/\.(?:html?|jsp|do|aspx?)$/i.test(decoded)) break;
    kept.push(segment);
  }
  const path = kept.length ? `/${kept.join('/')}/` : '/';
  return { ok: true, url: `${url.protocol}//${url.host}${path}` };
}

/** The workspace name a new profile can be labelled with (`CorpoWebserver`). */
export function workspaceLabelFor(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return '';
  }
}
