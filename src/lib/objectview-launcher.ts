/**
 * Object window launcher — mounts the object window as an in-page frame on
 * the active tab.
 *
 * The window is objectview/window.html (structure tree plus detail pane). All
 * opens share one resource key, so opening another object while the window
 * is live posts an activation and the window navigates inside the frame
 * (with back/forward) instead of reloading the iframe.
 */

import { boundCtxForTab, getCtx, type SwContext } from './sw-context';
import { launchFrame, resolveFrameTargetTabId } from './frame-launcher';
import { environmentToken } from './environment';
import { log } from './logger';
import { prefetchObjectRoot } from './handlers/object-window';
import type { ObjectWindowDraft, ObjectWindowFocus, ObjectWindowOrigin } from './types';

export const OBJECT_WINDOW_RESOURCE_KEY = 'objectview:window';

export async function openObjectViewWindow(
  rid: string,
  target?: { tabId?: number; windowId?: number },
  known: { name?: string; type?: string; businessId?: string; reveal?: boolean; from?: { rid: string; line?: number }; focus?: ObjectWindowFocus; origin?: ObjectWindowOrigin; draft?: ObjectWindowDraft } = {},
  requester?: SwContext,
) {
  await getCtx().settingsReady;
  // The window works on the server of the page it is mounted in.
  const tabId = await resolveFrameTargetTabId(target);
  const ctx = await boundCtxForTab(tabId, requester);

  // The sender's own knowledge (the badge's enrichment) first, then the
  // service worker's object cache.
  const cached = ctx.cache.get(rid);
  const name = known.name || cached?.name || '';
  const type = known.type || cached?.type || '';
  const businessId = known.businessId || cached?.businessId || '';

  // Start the read now, in parallel with mounting the frame: the window's
  // OPEN_OBJECT_ROOT joins it, so the data is waiting when the window asks.
  prefetchObjectRoot(rid, type || undefined, ctx);

  const contextWrite = chrome.storage.local.set({
      [`crev_objectview_ctx_${rid}`]: { rid, name, type, businessId, environment: environmentToken(ctx), savedAt: Date.now() },
    }).catch((e: unknown) => {
    log.swallow('objectview:ctxStore', e);
  });

  const label = name ? `${type || 'Object'} · ${name}` : `Object · ${businessId || rid}`;
  const frameLaunch = launchFrame({
    kind: 'objectview',
    path: `objectview/window.html#${rid}`,
    label,
    defaultWidth: 900,
    defaultHeight: 720,
    resourceKey: OBJECT_WINDOW_RESOURCE_KEY,
    activation: {
      type: 'objectview',
      rid,
      ...(name ? { name } : {}),
      ...(type ? { objectType: type } : {}),
      ...(businessId ? { businessId } : {}),
      ...(known.reveal ? { reveal: true } : {}),
      ...(known.from ? { from: known.from } : {}),
      ...(known.focus ? { focus: known.focus } : {}),
      ...(known.origin ? { origin: known.origin } : {}),
      ...(known.draft ? { draft: known.draft } : {}),
    },
    tabId: tabId ?? target?.tabId,
    windowId: target?.windowId,
  });
  // The stored context is only a title hint; it must not delay mounting the
  // frame. The authoritative read updates the title again.
  await Promise.all([contextWrite, frameLaunch]);
}
