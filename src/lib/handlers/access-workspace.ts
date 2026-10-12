import { register, type HandlerMeta } from '../handler-registry';
import { getCtx } from '../sw-context';
import { environmentToken } from '../environment';
import { handleAccessRequest } from '../access-workspace/service';
import { parseAccessDestination, type AccessDestination } from '../access-workspace/entry';

let launching: Promise<void> | undefined;
export async function openAccessWorkspace(destination?: AccessDestination, expectedEnvironment?: string,
  source: Pick<HandlerMeta, 'senderTabId' | 'panelWindowId'> = {}): Promise<void> {
  const ctx = getCtx(), environment = environmentToken(ctx);
  if (!ctx.client || !ctx.settings.activeProfileId) throw new Error('Choose a BMP connection in Companion first.');
  if (destination && !expectedEnvironment) throw new Error('This object’s BMP connection is unknown. Reopen it in Companion before opening Access.');
  if (expectedEnvironment && expectedEnvironment !== environment) throw new Error('Select this object’s BMP connection in Companion first.');
  const target = parseAccessDestination(destination);
  if (destination && !target) throw new Error('This Access link has no valid target.');
  // Capture the initiating tab before a queued launch changes the active tab.
  const opener = source.senderTabId != null ? await chrome.tabs.get(source.senderTabId).catch(() => undefined)
    : (await chrome.tabs.query({ active: true, ...(source.panelWindowId != null
      ? { windowId: source.panelWindowId } : { lastFocusedWindow: true }) }))[0];
  // Serialize tab creation, but retain each explicit navigation request.
  const task = (launching ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (environmentToken(getCtx()) !== environment) throw new Error('The connection changed. Open Access again.');
    const url = chrome.runtime.getURL('access/access.html') + '?environment=' + encodeURIComponent(environment);
    const entryUrl = target ? url + '#open=' + encodeURIComponent(JSON.stringify(target)) : url;
    const existing = (await chrome.tabs.query({})).find(tab => (tab.url ?? tab.pendingUrl)?.split('#')[0] === url);
    // Re-read the index: tabs may have moved while another launch was running.
    const origin = opener?.id != null ? await chrome.tabs.get(opener.id).catch(() => undefined) : undefined;
    if (existing?.id != null) {
      if (target) {
        // Runtime messaging reaches extension pages without reloading their draft or editor.
        const reply = await chrome.runtime.sendMessage({ type: 'ACCESS_WORKSPACE_NAVIGATE', tabId: existing.id, environment, destination: target }).catch(() => undefined) as { ok?: boolean } | undefined;
        if (!reply?.ok) await chrome.tabs.update(existing.id, { url: entryUrl });
      }
      if (origin?.id !== existing.id && origin?.id != null) {
        const index = origin.index + (existing.windowId === origin.windowId && existing.index < origin.index ? 0 : 1);
        if (existing.windowId !== origin.windowId || existing.index !== index)
          await chrome.tabs.move(existing.id, { windowId: origin.windowId, index });
      }
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(origin?.windowId ?? existing.windowId, { focused: true });
    } else await chrome.tabs.create({ url: entryUrl, ...(origin?.id != null
      ? { windowId: origin.windowId, index: origin.index + 1, openerTabId: origin.id } : {}) });
  });
  launching = task;
  try { await task; } finally { if (launching === task) launching = undefined; }
}
register('OPEN_ACCESS_WORKSPACE', async (msg, respond, meta) => {
  try { await openAccessWorkspace(msg.destination, msg.environment, meta); respond({ type: 'ACCESS_WORKSPACE_RESULT', ok: true }); }
  catch (e) { const error = e instanceof Error ? e.message : String(e); getCtx().toast(error, 'error'); respond({ type: 'ACCESS_WORKSPACE_RESULT', ok: false, error }); }
});
register('ACCESS_WORKSPACE_REQUEST', async (msg, respond) => {
  try {
    const ctx = getCtx(), client = ctx.client;
    const assertEnvironment = () => {
      if (!client || !msg.environment || environmentToken(ctx) !== msg.environment || ctx.client !== client) throw new Error('This workspace belongs to a different connection. Select its original connection in Companion to continue. Your draft is retained.');
    };
    const control = ['status', 'cancel', 'acknowledge'].includes(msg.request.operation);
    if (!control) assertEnvironment();
    const name = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId)?.label ?? client?.serverUrl ?? '';
    const data = await handleAccessRequest(client!, msg.environment, name, msg.request, assertEnvironment);
    // An apply continues against the captured client. Return its receipt even if the profile switched.
    if (msg.request.operation !== 'apply' && !control) assertEnvironment();
    respond({ type: 'ACCESS_WORKSPACE_RESULT', ok: true, data });
  } catch (e) { respond({ type: 'ACCESS_WORKSPACE_RESULT', ok: false, error: e instanceof Error ? e.message : String(e) }); }
});
