/**
 * Transport (beta) window (transport/transport.html): find objects on the
 * page's workspace in several ways and collect them into one transport (kept
 * per workspace as a draft in local storage, restored when the window opens);
 * compare it with a connected workspace, build a comparison script to paste,
 * or build scripts for any workspace; read the transport log on demand. Every
 * read is a preview run (handlers/transport.ts); with a connected target,
 * Companion also applies the scripts there after an explicit confirmation.
 * Closing the window cancels a read in progress, and an apply stops after
 * the part that runs.
 */

import { installCloseHandshake } from '../lib/frame-close-handshake';
import { escapeLayers } from '../lib/escape-layers';
import { fromParent, postToParent } from '../lib/frame-parent';
import { messageReplacePort } from '../lib/code-replace-port';
import type { TransportFrameActivation } from '../lib/types';
import { sendFireForget, sendRequestBounded } from '../lib/messaging';
import { watchWindowEnvironment } from '../lib/window-environment';
import { ICON_SPRITE } from '../lib/icon-sprite';
import type { InspectorMessage } from '../lib/types';
import { commandUserOf } from '../lib/identity-map';
import { TransportController, type TransportConnection } from './transport-controller';
import { NumericIdsController } from './numeric-ids-controller';
import { indexCodeAccess } from './numeric-ids-code';
import { defaultSince } from './transport-model';
import { closeWherePopover, mountTransportView } from './transport-view';

async function connection(): Promise<TransportConnection | null> {
  const res = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' } satisfies InspectorMessage) as InspectorMessage | undefined;
  if (res?.type !== 'CONNECTION_STATE' || !res.state.environment) return null;
  return { environment: res.state.environment, label: res.state.profileLabel || res.state.workspace || '', user: commandUserOf(res.state) };
}

const store = {
  get: async (key: string) => (await chrome.storage.local.get(key))[key],
  set: async (key: string, value: unknown) => { await chrome.storage.local.set({ [key]: value }); },
  remove: async (key: string) => { await chrome.storage.local.remove(key); },
};

const ctl = new TransportController({
  request: (msg, timeoutMs, signal) => sendRequestBounded(msg, { timeoutMs, signal }),
  post: msg => sendFireForget(msg),
  connection,
  now: () => new Date(),
  store,
}, { since: defaultSince(new Date()) });

// The Numeric IDs tab: reads on its own when it is opened; takes the areas Find holds in full.
const numeric = new NumericIdsController({
  request: (msg, timeoutMs, signal) => sendRequestBounded(msg, { timeoutMs, signal }),
  connection,
  now: () => new Date(),
  store,
  code: indexCodeAccess(),
  replacePort: environment => messageReplacePort(environment),
  findRows: root => ctl.completeRows(root),
});

const environmentWatch = watchWindowEnvironment(() => ctl.connection?.environment);

const host = document.getElementById('transport-root')!;
const sprite = document.createElement('div');
sprite.innerHTML = ICON_SPRITE;
document.body.prepend(sprite.firstElementChild!);
mountTransportView(host, ctl, { numeric, workspace: () => ctl.connection?.label ?? '', openCodeSearch: () => sendFireForget({ type: 'OPEN_CODE_SEARCH' }) });

// Learn the server now, so a later change of the page's server shows the
// banner; then the workspace's draft and the connected workspaces (neither
// sends anything to a server).
void (async () => {
  try { ctl.connection = await connection(); } catch { /* asked again on Find */ }
  void environmentWatch.check();
  ctl.startBrowse();
  await ctl.restoreDraft();
  await ctl.loadTargets();
})();

installCloseHandshake(() => true, () => { ctl.dispose(); numeric.dispose(); });
window.addEventListener('pagehide', () => { ctl.dispose(); numeric.dispose(); });

const esc = escapeLayers();
esc.register({ kind: 'popover', name: 'transport-where', isOpen: () => [...host.querySelectorAll<HTMLElement>('.tr-pop')].some(p => !p.hidden), close: () => closeWherePopover(host) });
esc.register({ kind: 'window', name: 'transport', isOpen: () => true, close: () => { postToParent({ type: 'CREV_OVERLAY_CLOSE_PLEASE' }); } });
esc.register({ kind: 'dialog', name: 'numeric-ids-confirm', isOpen: () => numeric.confirm?.phase === 'ready', close: () => numeric.cancelConfirm() });
esc.listen(document);

// The side panel (or another window) can ask for a tab, also when this window is already open.
window.addEventListener('message', e => {
  if (!fromParent(e)) return;
  const m = e.data as { type?: string; activation?: TransportFrameActivation } | undefined;
  if (m?.type === 'CREV_FRAME_ACTIVATE' && m.activation?.type === 'transport') ctl.showTab(m.activation.tab);
});
postToParent({ type: 'CREV_FRAME_READY' });
