/**
 * A page's requests go to the page's own server.
 *
 * The router (message-router.ts) resolves the profile of every content-script
 * request, and of every Companion window embedded in a page, from the tab's
 * URL. When no stored profile matches the page, a request that needs a
 * server is refused with PAGE_NOT_SET_UP_ERROR. Page facts (detection, page
 * context, replies) still run: they read or record the page itself.
 */

export const PAGE_NOT_SET_UP_ERROR = 'This page does not belong to a server Companion is set up for.';

/** Page facts and replies to worker requests. They read or record the page
 *  itself, not the server, so they run whatever profile the page has. */
const PAGE_LOCAL = new Set<string>([
  'DETECTION_RESULT',
  'CHECK_BMP_SIGNALS',
  'PAGE_INFO',
  'PAGE_CONTEXT',
  'EDIT_PAGE_CONTEXT',
  'BMP_URL_CHANGED',
  'BMP_PAGE_RENDER_CHANGED',
  'CREV_OVERLAY_CLOSE_REQUEST',
  'CREV_FRAME_ACTIVATE',
  'BLUEPRINT_CLOSE',
  'GET_CONNECTION_STATE',
  'GET_DETECTION',
]);

export function isPageLocal(type: string): boolean {
  return PAGE_LOCAL.has(type) || /_(?:RESULT|DATA)$/.test(type);
}
