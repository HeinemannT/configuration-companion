/**
 * Code search launcher: mounts codesearch/codesearch.html as an in-page
 * frame on the active tab. One window: a later open brings it forward and
 * hands it the activation (query, scope, target), so its results stay.
 */

import { launchFrame } from './frame-launcher';
import type { CodeSearchFrameActivation, FrameMountDisposition } from './types';

export const CODE_SEARCH_RESOURCE_KEY = 'codesearch:window';

export async function openCodeSearchWindow(target?: { tabId?: number; windowId?: number }, activation?: CodeSearchFrameActivation): Promise<FrameMountDisposition> {
  return launchFrame({
    kind: 'codesearch',
    path: 'codesearch/codesearch.html',
    label: 'Search code',
    defaultWidth: 860,
    defaultHeight: 620,
    resourceKey: CODE_SEARCH_RESOURCE_KEY,
    activation: activation ?? { type: 'codesearch' },
    tabId: target?.tabId,
    windowId: target?.windowId,
  });
}
