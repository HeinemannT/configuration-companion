/**
 * Opens the Transport (beta) window from the side panel. The window's own
 * requests are in handlers/transport.ts.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { openTransportWindow } from '../transport-launcher';
import { resolveFrameTargetTabId } from '../frame-launcher';
import { reportFrameOpenFailure } from '../frame-open-failure';

register('OPEN_TRANSPORT', async (_msg, _respond, meta) => {
  const target = { tabId: meta.senderTabId, windowId: meta.panelWindowId };
  const disposition = await openTransportWindow(target);
  // Nothing opened (no BMP page in the panel's window): the panel says why.
  if (disposition === 'failed') await reportFrameOpenFailure(ctxOf(meta), meta.panelWindowId, await resolveFrameTargetTabId(target));
});
