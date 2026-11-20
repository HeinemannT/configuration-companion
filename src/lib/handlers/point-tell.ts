/**
 * Point and tell, the worker's part. The page owns the mode: the side panel's toggle reaches the
 * window's active tab, and the page answers with POINT_TELL_STATE, which is passed on to that window's
 * panel. Inspect and Blueprint are exclusive with it: turning it on turns them off first (Blueprint
 * through its own exit check, so unsaved changes are never dropped without the question); turning
 * either of them on is seen by the page itself (content.ts, the entry of the page bundle).
 */

import { register } from '../handler-registry';
import { deliverSketch, fetchStatus, requeueSketch, type SendDeps, type SketchPush } from '../claude-link';
import { DESKTOP_CONFIG, handoverFor } from '../point-tell/desktop-policy';
import { ctxOf, type SwContext } from '../sw-context';
import { ensureContentScript } from '../tab-awareness';
import { reportFrameOpenFailure } from '../frame-open-failure';
import { errorMessage, log } from '../logger';
import { VOICE_KEY, readVoicePrefs } from '../point-tell/voice';
import { toggleInspect } from './inspect';
import { setBlueprintActive } from './layout';

/** Inspect and Blueprint off for a window. False when Blueprint's exit check kept it open. */
async function clearOtherModes(windowId: number, ctx: SwContext): Promise<boolean> {
  if (ctx.isInspectActive(windowId)) await toggleInspect(windowId);
  if (ctx.blueprintActiveByWindow.get(windowId) === true && !(await setBlueprintActive(windowId, false))) return false;
  return true;
}

/**
 * Turn Point and tell on or off in a window's shown tab (or the given tab). Used by the panel button, the
 * keyboard command and the right-click entry; the last two are invocations of the extension on that tab,
 * which is what gives Chrome's `activeTab` permission, the one Screenshot needs.
 */
export async function togglePointTell(ctx: SwContext, opts: { windowId?: number; tabId?: number; panelWindowId?: number | null } = {}): Promise<void> {
  let windowId = opts.windowId;
  if (windowId == null && opts.tabId != null) windowId = (await chrome.tabs.get(opts.tabId).catch(() => undefined))?.windowId;
  windowId ??= (await chrome.windows.getLastFocused({ populate: false }).catch(() => null))?.id;
  if (windowId == null) return;
  // Exclusive with Inspect and Blueprint. Harmless when Point and tell is the one being turned off:
  // then neither of them is on.
  if (!(await clearOtherModes(windowId, ctx))) return;
  let tabId = opts.tabId;
  if (tabId == null) {
    const tabs = await chrome.tabs.query({ active: true, windowId }).catch(() => [] as chrome.tabs.Tab[]);
    tabId = tabs[0]?.id;
  }
  let reached = false;
  if (tabId != null) {
    await ensureContentScript(tabId);
    try { await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_POINT_TELL' }); reached = true; }
    catch (e) { log.swallow('handler:togglePointTell', e); }
  }
  // The window's tab has no page tools: the panel says why.
  if (!reached) await reportFrameOpenFailure(ctx, opts.panelWindowId ?? undefined, tabId);
}

/** The right-click entry "New page here": the page turns Point and tell on when it is off and asks for the page's name. */
export async function newPageHere(tabId: number): Promise<void> {
  await ensureContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, { type: 'POINT_TELL_NEW_PAGE' });
}

// Panel -> worker -> page (shaped like TOGGLE_INSPECT: the page owns the state).
register('TOGGLE_POINT_TELL', async (_msg, _respond, meta) => {
  await togglePointTell(ctxOf(meta), { ...(meta.panelWindowId != null ? { windowId: meta.panelWindowId } : {}), panelWindowId: meta.panelWindowId });
});

// Page -> worker -> panel (shaped like INSPECT_STATE / BLUEPRINT_STATE toward the panel).
register('POINT_TELL_STATE', async (msg, _respond, meta) => {
  if (meta.senderTabId == null || typeof msg.active !== 'boolean') return;
  const tab = await chrome.tabs.get(meta.senderTabId).catch(() => undefined);
  if (tab?.windowId == null) return;
  ctxOf(meta).sendToPanelByWindow(tab.windowId, { type: 'POINT_TELL_STATE', active: msg.active });
});

// Page -> worker: the voice-comment setting. Content scripts cannot read the extension's storage, so the
// page asks; `noticed` stores that the first-use line (where the audio goes) was shown, and `on: true` is
// the answer "Turn on" to the confirm in the comment field (the same setting as in Preferences; turning it
// on there is the only way the microphone's question is asked again, so the notice counts as shown).
register('POINT_TELL_VOICE', async (msg, respond) => {
  let prefs = readVoicePrefs(undefined);
  try {
    prefs = readVoicePrefs((await chrome.storage.local.get(VOICE_KEY))[VOICE_KEY]);
    const next = { ...prefs, ...(msg.on === true && !prefs.on ? { on: true, noticed: true } : {}), ...(msg.noticed === true ? { noticed: true } : {}) };
    if (next.on !== prefs.on || next.noticed !== prefs.noticed) { prefs = next; await chrome.storage.local.set({ [VOICE_KEY]: prefs }); }
  } catch (e) { log.swallow('handler:pointTellVoice', e); }
  respond({ type: 'POINT_TELL_VOICE_DATA', prefs });
});

// Page -> worker: the name of the server profile the page belongs to, for the copied brief (read from what is already held; no server call).
register('POINT_TELL_SERVER', async (_msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const profile = ctx.settings?.profiles?.find(p => p.id === ctx.settings.activeProfileId);
  respond({ type: 'POINT_TELL_SERVER_DATA', ...(profile?.label ? { name: profile.label } : {}) });
});

// Page -> worker: Send to Claude. The brief goes over a short-lived WebSocket to Claude Desktop's local
// listener (loopback; no host permission). The port that answered is kept for the session so the next
// send does not probe the range; a failed remembered port is dropped.
const LINK_PORT_KEY = 'crev_claude_link_port';
/**
 * Test only: one port to try instead of the range, so a test's own listener is reached and the user's Claude Desktop
 * is not. Read from session storage, which pages and content scripts cannot write (storage-access.ts); set from the
 * worker's console or by a test rig. Never set by Companion itself.
 */
export const LINK_TEST_PORT_KEY = 'crev_claude_link_test_port';

/** Which ports to try: the test port alone when one is set, else the range with the remembered port first. */
/** Test only, with the test port: how many ports from it to try (1 to 5), so a test can run several copies. */
export const LINK_TEST_COUNT_KEY = 'crev_claude_link_test_port_count';

export async function linkDeps(): Promise<SendDeps> {
  const kept = await chrome.storage.session.get([LINK_PORT_KEY, LINK_TEST_PORT_KEY, LINK_TEST_COUNT_KEY]).catch(() => ({})) as Record<string, unknown>;
  const test = kept[LINK_TEST_PORT_KEY];
  if (typeof test === 'number' && Number.isInteger(test) && test >= 1024 && test <= 65535) {
    const n = kept[LINK_TEST_COUNT_KEY];
    const count = typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
    const remembered = kept[LINK_PORT_KEY];
    return { basePort: test, count, preferred: typeof remembered === 'number' ? remembered : null };
  }
  const remembered = kept[LINK_PORT_KEY];
  return { preferred: typeof remembered === 'number' ? remembered : null };
}

/** The link's settings for every conversation: the ports, and Companion's settings for a copy that holds older ones. */
async function linkDepsWithConfig(): Promise<SendDeps> {
  return { ...(await linkDeps()), config: DESKTOP_CONFIG };
}

// The page makes the key once per press of Send and sends it again when the worker gave no answer (the worker can be
// stopped mid-send); a server with `key` keeps the sketch once, an older one is looked up in its list first.
register('POINT_TELL_SEND', async (msg, respond) => {
  if (msg.type !== 'POINT_TELL_SEND') return;
  const push: SketchPush = {
    text: msg.text,
    ...(msg.page ? { page: msg.page } : {}),
    ...(msg.pageKey ? { pageKey: msg.pageKey } : {}),
    ...(msg.picture ? { picture: msg.picture } : {}),
    ...(msg.key && /^[A-Za-z0-9_-]{1,64}$/.test(msg.key) ? { key: msg.key } : {}),
    ...(msg.follows ? { follows: msg.follows } : {}),
    handover: handoverFor(),
  };
  const result = await deliverSketch(push, await linkDepsWithConfig(), { ...(msg.retry ? { retry: true } : {}), ...(msg.since ? { since: msg.since } : {}) });
  if (result.ok) await chrome.storage.session.set({ [LINK_PORT_KEY]: result.port }).catch(() => undefined);
  else if (result.reason === 'none') await chrome.storage.session.remove(LINK_PORT_KEY).catch(() => undefined);
  // The hello stays in the worker: the page needs only the outcome.
  if (result.ok) delete result.hello;
  respond({ type: 'POINT_TELL_SEND_DATA', result });
});

// Page -> worker: "Send again" on a sketch nobody works on, by the server's id (servers with `requeue`).
register('POINT_TELL_REQUEUE', async (msg, respond) => {
  if (msg.type !== 'POINT_TELL_REQUEUE') return;
  respond({ type: 'POINT_TELL_REQUEUE_DATA', result: await requeueSketch(msg.id, await linkDepsWithConfig()) });
});

// Page -> worker: the sent sketches with their states and Claude's replies (a short-lived socket again, nothing
// stays open). `seen` says which replies the user looked at, per sketch; it is kept for the browser session so a
// badge does not come back after a reload.
const SEEN_KEY = 'crev_pt_seen_rev';
register('POINT_TELL_STATUS', async (msg, respond) => {
  if (msg.type !== 'POINT_TELL_STATUS') return;
  const store = chrome.storage.session;
  const held = ((await store.get(SEEN_KEY).catch(() => ({}))) as Record<string, unknown>)[SEEN_KEY];
  const seen: Record<string, number> = held && typeof held === 'object' ? { ...(held as Record<string, number>) } : {};
  if (msg.seen && typeof msg.seen === 'object') {
    let changed = false;
    for (const [k, v] of Object.entries(msg.seen)) if (typeof v === 'number' && v > (seen[k] ?? 0)) { seen[k] = v; changed = true; }
    if (changed) await store.set({ [SEEN_KEY]: seen }).catch(() => undefined);
  }
  const result = await fetchStatus(await linkDepsWithConfig());
  if (result.ok) await store.set({ [LINK_PORT_KEY]: result.port }).catch(() => undefined);
  respond({ type: 'POINT_TELL_STATUS_DATA', result, seen });
});

// Page or panel -> worker: the Claude Desktop page (claude-setup/), where the desktop extension is downloaded and
// its state shown. One tab: an open one is brought forward. It opens next to the tab that asked.
const SETUP_PATH = 'claude-setup/claude-setup.html';
export async function openClaudeSetup(meta: { senderTabId?: number; panelWindowId?: number | null }): Promise<void> {
  const url = chrome.runtime.getURL(SETUP_PATH);
  const existing = (await chrome.tabs.query({})).find(t => (t.url ?? t.pendingUrl)?.split(/[?#]/)[0] === url);
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  const opener = meta.senderTabId != null ? await chrome.tabs.get(meta.senderTabId).catch(() => undefined)
    : (await chrome.tabs.query({ active: true, ...(meta.panelWindowId != null ? { windowId: meta.panelWindowId } : { lastFocusedWindow: true }) }).catch(() => []))[0];
  await chrome.tabs.create({ url, ...(opener?.id != null ? { windowId: opener.windowId, index: opener.index + 1, openerTabId: opener.id } : {}) });
}
register('OPEN_CLAUDE_SETUP', async (_msg, _respond, meta) => {
  try { await openClaudeSetup(meta); } catch (e) { log.swallow('handler:openClaudeSetup', e); }
});

// Page -> worker: a picture of the visible part of the sender's tab, for the Screenshot button. The page
// has hidden the dock and the field. `captureVisibleTab` needs `activeTab`, which Chrome gives on an
// invocation of the extension on the tab (shortcut, right-click entry, toolbar); the page falls back to
// Chrome's own tab capture when it is refused. It takes the shown tab of the window, so a tab that is not
// the shown one is refused rather than another tab being captured.
register('POINT_TELL_CAPTURE', async (_msg, respond, meta) => {
  const tabId = meta.senderTabId;
  const tab = tabId == null ? undefined : await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || tab.windowId == null) { respond({ type: 'POINT_TELL_CAPTURE_DATA', ok: false, error: 'No tab to take a picture of.' }); return; }
  if (!tab.active) { respond({ type: 'POINT_TELL_CAPTURE_DATA', ok: false, error: 'This tab is not the one shown.' }); return; }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    respond({ type: 'POINT_TELL_CAPTURE_DATA', ok: true, dataUrl });
  } catch (e) {
    log.swallow('handler:pointTellCapture', e);
    respond({ type: 'POINT_TELL_CAPTURE_DATA', ok: false, error: errorMessage(e) });
  }
});
