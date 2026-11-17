/**
 * Compare launcher: mounts diff/diff.html (the Compare window) as an in-page
 * frame on the active tab. One window: a later open brings it forward and
 * hands it the new pair (or side A with the picker for side B).
 */

import { launchFrame } from './frame-launcher';
import type { CompareFrameActivation } from './types';

export const COMPARE_RESOURCE_KEY = 'diff:window';

export async function openCompareWindow(activation: CompareFrameActivation, target?: { tabId?: number; windowId?: number }) {
  await launchFrame({
    kind: 'diff',
    path: 'diff/diff.html',
    label: 'Compare',
    defaultWidth: 1000,
    defaultHeight: 680,
    resourceKey: COMPARE_RESOURCE_KEY,
    activation,
    tabId: target?.tabId,
    windowId: target?.windowId,
  });
}
