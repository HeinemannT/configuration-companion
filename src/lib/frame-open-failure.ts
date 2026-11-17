/**
 * Why a window or page mode the side panel asked for did not open on the
 * active tab of its browser window, in one plain line for the panel's
 * notice area (PANEL_NOTICE). The header buttons (code editor, code search,
 * Inspect, Blueprint) mount into that tab, which must be a BMP page with
 * the page tools.
 */

import { CONNECTION_NEEDS_ACCESS_SENTENCE } from './connection-copy';
import { hasHostAccess, isProfilePage } from './site-access';
import type { InspectorMessage } from './types';

export type FrameOpenFailure = 'no-page' | 'site-not-granted';

export const NO_PAGE_NOTICE = 'Open a BMP page in this window first.';

export function frameOpenNotice(failure: FrameOpenFailure): string {
  return failure === 'site-not-granted' ? CONNECTION_NEEDS_ACCESS_SENTENCE : NO_PAGE_NOTICE;
}

/** The failure for the tab a mount was meant for: a known server whose
 *  site is not granted, or anything else (no tab, not a BMP page). */
export async function frameOpenFailure(tabId: number | undefined, profileUrls: ReadonlyArray<string | undefined>): Promise<FrameOpenFailure> {
  if (tabId == null) return 'no-page';
  let url: string | undefined;
  try { url = (await chrome.tabs.get(tabId))?.url; } catch { return 'no-page'; }
  if (url && isProfilePage(url, profileUrls) && !(await hasHostAccess(url))) return 'site-not-granted';
  return 'no-page';
}

/** The panel message for a failure. */
export function frameOpenNoticeMessage(failure: FrameOpenFailure): Extract<InspectorMessage, { type: 'PANEL_NOTICE' }> {
  return { type: 'PANEL_NOTICE', failure, text: frameOpenNotice(failure) };
}

/** What the report needs from the worker context. */
export interface FrameFailureSink {
  settings: { profiles: ReadonlyArray<{ bmpUrl?: string }> };
  sendToPanelByWindow(windowId: number, msg: InspectorMessage): void;
}

/** Tell the panel of `windowId` why nothing opened on `tabId`. Only a panel
 *  that asked is told (no window: nothing is sent). */
export async function reportFrameOpenFailure(ctx: FrameFailureSink, windowId: number | undefined, tabId: number | undefined): Promise<FrameOpenFailure | null> {
  if (windowId == null) return null;
  const failure = await frameOpenFailure(tabId, ctx.settings.profiles.map(p => p.bmpUrl));
  ctx.sendToPanelByWindow(windowId, frameOpenNoticeMessage(failure));
  return failure;
}
