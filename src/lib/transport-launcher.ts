/**
 * Transport (beta) launcher: mounts transport/transport.html as an in-page
 * frame on the active tab. One window: a later open brings it forward with
 * its scan and selection as they are. `tab` hands it the tab to show, also
 * when it is already open (a frame activation, delivered when the window is
 * ready).
 */

import { launchFrame } from './frame-launcher';
import type { FrameMountDisposition, TransportFrameActivation } from './types';

export const TRANSPORT_RESOURCE_KEY = 'transport:window';
export const TRANSPORT_PAGE = 'transport/transport.html';
export const TRANSPORT_WINDOW_LABEL = 'Transport (beta)';

export async function openTransportWindow(target?: { tabId?: number; windowId?: number }, tab?: TransportFrameActivation['tab']): Promise<FrameMountDisposition> {
  return launchFrame({
    kind: 'transport',
    path: TRANSPORT_PAGE,
    label: TRANSPORT_WINDOW_LABEL,
    defaultWidth: 900,
    defaultHeight: 660,
    resourceKey: TRANSPORT_RESOURCE_KEY,
    ...(tab ? { activation: { type: 'transport', tab } satisfies TransportFrameActivation } : {}),
    tabId: target?.tabId,
    windowId: target?.windowId,
  });
}
