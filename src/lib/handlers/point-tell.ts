/**
 * Point and tell, the worker's part. The page owns the mode: the side panel's toggle reaches the
 * window's active tab, and the page answers with POINT_TELL_STATE, which is passed on to that window's
 * panel. Inspect and Blueprint are exclusive with it: turning it on turns them off first (Blueprint
 * through its own exit check, so unsaved changes are never dropped without the question); turning
 * either of them on is seen by the page itself (content.ts, the entry of the page bundle).
 */

import { register } from '../handler-registry';
import { ctxOf, type SwContext } from '../sw-context';
import { ensureContentScript } from '../tab-awareness';
import { reportFrameOpenFailure } from '../frame-open-failure';
import { errorMessage, log } from '../logger';
import { isRidShaped } from '../rid-shape';
import { routedProps } from '../point-tell/routes';
import { VOICE_KEY, readVoicePrefs } from '../point-tell/voice';
import { ChangeTicketLifecycle, type ChangePreviewScope } from '../ai/change-ticket';
import { buildAncestorsEc, parseAncestors } from '../browse-tree';
import { buildCreatePageEc, buildReadBackEc, checkCreatePage, parseCreatePage } from '../point-tell/create-page';
import { CONTEXT_OBJECT, createEcFrame } from '../ec-parser';
import { environmentMatches, environmentMismatchError, environmentToken } from '../environment';
import { userScript } from '../script-kinds';
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

// Page -> worker: the notes asked for changes to be staged. Point and tell is already off in the page;
// Blueprint opens on that same tab, where the page loads the changes into it.
register('POINT_TELL_STAGE', async (_msg, _respond, meta) => {
  const tabId = meta.senderTabId;
  if (tabId == null) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.windowId == null) return;
  const ctx = ctxOf(meta);
  if (ctx.isInspectActive(tab.windowId)) await toggleInspect(tab.windowId);
  await setBlueprintActive(tab.windowId, true, tabId);
});

/** Code longer than this is not copied into the text: the AI would be given half of it. */
const MAX_BODY = 8000;
const MAX_READ = 12;

// Page -> worker: what the noted objects hold in text properties and code, read once on Copy (version 1.1).
register('POINT_TELL_READ_NOW', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'POINT_TELL_NOW_DATA', ok: false, error: 'Not connected' }); return; }
  const wanted = (Array.isArray(msg.items) ? msg.items : [])
    .filter(i => !!i && isRidShaped(i.rid) && typeof i.className === 'string' && i.className.length < 80)
    .filter(i => { const r = routedProps(i.className); return r.code.length > 0 || r.text.length > 0; })
    .filter((i, at, all) => all.findIndex(o => o.rid === i.rid) === at)
    .slice(0, MAX_READ);
  if (!wanted.length) { respond({ type: 'POINT_TELL_NOW_DATA', ok: true, objects: {} }); return; }
  try {
    const { objects } = await ctx.client.readFullObjects(wanted.map(i => i.rid));
    const out: Record<string, { text: Record<string, string>; code: Record<string, string>; omitted: string[] }> = {};
    for (const { rid, className } of wanted) {
      const obj = objects[rid];
      if (!obj) continue;
      const { code, text } = routedProps(className);
      const entry = { text: {} as Record<string, string>, code: {} as Record<string, string>, omitted: [] as string[] };
      for (const prop of text) { const v = obj.props[prop]; if (v && v.text) entry.text[prop] = v.text; }
      for (const prop of code) {
        const v = obj.props[prop];
        if (!v || !v.text) continue;
        if (v.text.length > MAX_BODY) entry.omitted.push(prop); else entry.code[prop] = v.text;
      }
      out[rid] = entry;
    }
    respond({ type: 'POINT_TELL_NOW_DATA', ok: true, objects: out });
  } catch (e) {
    respond({ type: 'POINT_TELL_NOW_DATA', ok: false, error: errorMessage(e) });
  }
});

/** The receipts of previews: one use each, ten minutes, lost when the worker restarts (then a new preview is needed). */
const pagePreviews = new ChangeTicketLifecycle(10 * 60_000);

const scopeOf = (ctx: SwContext): ChangePreviewScope | null => (ctx.client?.commandUser ? { profileId: ctx.settings.activeProfileId, serverUrl: ctx.client.serverUrl, actor: ctx.client.commandUser } : null);

// Page -> worker: where a new page may go. Read-only.
register('POINT_TELL_PARENTS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'POINT_TELL_PARENTS_DATA', ok: false, error: 'Not connected' }); return; }
  if (!isRidShaped(msg.rid)) { respond({ type: 'POINT_TELL_PARENTS_DATA', ok: false, error: 'Not an object RID' }); return; }
  try {
    const frame = createEcFrame();
    const r = await ctx.client.executeEcOn(buildAncestorsEc(CONTEXT_OBJECT, frame), msg.rid, undefined, 20_000);
    const crumbs = r.ok ? parseAncestors(r.log ?? '', frame) : [];
    respond({ type: 'POINT_TELL_PARENTS_DATA', ok: true, parents: crumbs.slice().reverse() });
  } catch (e) {
    respond({ type: 'POINT_TELL_PARENTS_DATA', ok: false, error: errorMessage(e) });
  }
});

// Page -> worker: create the empty page. The one write here that is not a Blueprint apply: previewed on the server first (a
// warning stops it, for instance a duplicate ID that BMP would replace), one use of the receipt, the same script, read back after.
register('POINT_TELL_CREATE_PAGE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const fail = (error: string, outcomeUnknown = false): void => respond({ type: 'POINT_TELL_CREATE_PAGE_RESULT', ok: false, error, ...(outcomeUnknown ? { outcomeUnknown: true } : {}) });
  const client = ctx.client;
  if (!client) { fail('Not connected'); return; }
  if (!environmentMatches(ctx, msg.environment)) { fail(environmentMismatchError(ctx, msg.environment)); return; }
  const bad = checkCreatePage(msg.plan);
  if (bad) { fail(bad); return; }
  const scope = scopeOf(ctx);
  if (!scope) { fail('Sign in to BMP first.'); return; }
  const code = userScript(buildCreatePageEc(msg.plan));
  try {
    if (msg.phase === 'preview') {
      const preview = await client.executeEc(code, undefined, false);
      const warnings = (preview.outputEntries ?? []).filter(e => e.logType === 'WARNING').map(e => e.message);
      const text = preview.error || preview.log || '';
      if (!preview.ok || preview.hasError) { fail(firstLine(errorLine(preview.outputEntries) ?? text) || 'BMP did not accept this.'); return; }
      if (preview.hasWarning || warnings.length) { fail(firstLine(warnings[0] ?? text)); return; }
      respond({ type: 'POINT_TELL_CREATE_PAGE_RESULT', ok: true, previewId: pagePreviews.issue(code, scope, text), environment: environmentToken(ctx) });
      return;
    }
    const used = msg.previewId ? pagePreviews.consume(msg.previewId, scope) : null;
    if (!used || !used.ok || used.code !== code) { fail('Check again, then create the page.'); return; }
    const res = await client.executeEc(code, undefined, true);
    if (!res.ok) { fail(firstLine(res.error || res.log || 'The page was not created.'), !!res.outcomeUnknown); return; }
    const made = parseCreatePage(res.log ?? '');
    if (!made) { fail('Whether the page was created is not known. Look under its parent before trying again.', true); return; }
    // Read back: the page is there, of the class asked, under the parent asked.
    const back = await client.executeEc(userScript(buildReadBackEc(made.rid)), undefined, false);
    const seen = parseCreatePage(back.log ?? '');
    if (!seen || seen.className !== msg.plan.kind || (seen.parentRid && seen.parentRid !== msg.plan.parentRid)) {
      ctx.logActivity('warn', 'Point and tell: the new page could not be confirmed', `RID ${made.rid}`, { category: 'change', action: 'create-page' });
      fail('The page was written, but reading it back did not match. Look under its parent before trying again.', true);
      return;
    }
    ctx.logActivity('success', `Point and tell: created ${msg.plan.kind} ${made.id || made.rid}`, `Under RID ${msg.plan.parentRid}`, { category: 'change', action: 'create-page' });
    respond({ type: 'POINT_TELL_CREATE_PAGE_RESULT', ok: true, rid: made.rid, id: made.id });
  } catch (e) {
    fail(errorMessage(e), msg.phase === 'commit');
  }
});

/** BMP's first line, without the position in the script and the tail about what it did instead. */
const firstLine = (t: string): string => (t.split(/\r?\n/).find(l => l.trim()) ?? '').replace(/ A new id was assigned instead.*$/, '').replace(/ at line \d+, column \d+.*$/, '').trim().slice(0, 240);
const errorLine = (entries: ReadonlyArray<{ logType?: string; message: string }> | undefined): string | undefined => entries?.find(e => e.logType === 'ERROR')?.message;

// Page -> worker: the voice-comment setting. Content scripts cannot read the extension's storage, so the
// page asks; `noticed` stores that the first-use line (where the audio goes) was shown.
register('POINT_TELL_VOICE', async (msg, respond) => {
  let prefs = readVoicePrefs(undefined);
  try {
    prefs = readVoicePrefs((await chrome.storage.local.get(VOICE_KEY))[VOICE_KEY]);
    if (msg.noticed === true && !prefs.noticed) { prefs = { ...prefs, noticed: true }; await chrome.storage.local.set({ [VOICE_KEY]: prefs }); }
  } catch (e) { log.swallow('handler:pointTellVoice', e); }
  respond({ type: 'POINT_TELL_VOICE_DATA', prefs });
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
