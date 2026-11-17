/**
 * Blueprint layout-builder handlers. Thin: resolve context + load, or apply an edit. All the
 * logic lives in layout-service (shell) + layout/ (pure core). The SW is stateless per request —
 * the panel owns the editable model + history and passes baseline+desired back on apply.
 */
import { register } from '../handler-registry';
import { boundCtxForTab, ctxOf, getCtx } from '../sw-context';
import type { SwContext } from '../sw-context';
import { loadPage, applyPage, loadBlastRadius, loadFlowRefs, loadFlowRefChildren, preflightPortableIds } from '../layout-service';
import { ensureContentScript, ensureBlueprintScript } from '../tab-awareness';
import { toggleInspect } from './inspect';
import { reportFrameOpenFailure } from '../frame-open-failure';
import { errorMessage, log } from '../logger';
import type { PlanNote } from '../layout/types';
import type { ApplyResult } from '../layout/sync';
import type { ActivityMeta } from '../types';
import { environmentMismatchError, environmentToken } from '../environment';

const BLUEPRINT_VERSION_ERROR = 'Blueprint requires BMP 5.6.3 or newer.';

function blueprintActivityMeta(
  page: { pageRid: string; pageId: string; pageClass?: string },
  action: string,
  durationMs?: number,
): ActivityMeta {
  return {
    category: 'blueprint',
    action,
    object: {
      rid: page.pageRid,
      businessId: page.pageId,
      type: page.pageClass ?? 'Page',
      name: page.pageId,
    },
    ...(durationMs == null ? {} : { durationMs }),
  };
}

function blueprintSupported(ctx: SwContext): boolean {
  return ctx.client?.supportsLookup !== false;
}

/** One plan note as a human-readable line for the LOG tab detail — mirrors what `planRow` shows in the
 *  overlay (action · type · object → where · detail) but in plain text, so the persistent record reads
 *  the same as the live panel without decoding the raw EC below it. */
function formatNotes(notes: PlanNote[]): string {
  return notes
    .map(n => {
      const act = n.action ?? n.verb;
      const obj = n.object ?? n.text ?? '';
      const type = n.objectType ? `${n.objectType} ` : '';
      const where = n.where ? ` → ${n.where}` : '';
      const det = n.detail ? `  (${n.detail})` : '';
      return `• ${act} ${type}${obj}${where}${det}`.replace(/\s+/g, ' ').trim();
    })
    .join('\n');
}

function verificationText(res: ApplyResult): string {
  if (res.unverified) return res.error || 'The write completed, but Blueprint could not verify the refreshed layout.';
  if (res.partial) return res.error || 'The refreshed layout shows that only part of the requested change landed.';
  if (!res.ok) return res.error || 'The refreshed layout did not match the requested change.';
  return 'Verified against a fresh layout read.';
}

/** Persistent Apply record. The server's write response comes first because it is the primary
 * execution evidence; Blueprint's interpretation and generated program remain available below it. */
function applyActivityDetail(res: ApplyResult, timings: string[]): string {
  const execution = res.executionLog || 'No execution log was returned by BMP.';
  const requested = formatNotes(res.notes) || 'No requested changes.';
  const script = res.script || 'No Extended Code was executed.';
  return [
    'BMP execution log',
    execution,
    '',
    'Verification',
    verificationText(res),
    '',
    'Requested changes',
    requested,
    '',
    'Generated Extended Code',
    script,
    '',
    'Diagnostics',
    `EC calls: ${timings.join(' | ') || 'none'}`,
  ].join('\n');
}

/** Set blueprint mode for a window + broadcast to its panel and content tab. Shared by the
 *  toggle handler and the inspect handler — blueprint and inspect are mutually exclusive (each runs
 *  its own document-wide overlay + observer, so only one should paint at a time). `tabId` pins the
 *  content tab explicitly (the post-apply resume targets the tab that reloaded, which may no longer
 *  be the window's active tab); default is the window's active tab. */
/** Ask the Blueprint tab whether it may close (its one exit check asks the user when changes are
 *  unsaved). A tab that cannot answer (gone, no content script) has nothing to keep. */
export async function blueprintMayExit(tabId: number | undefined): Promise<boolean> {
  if (tabId == null) return true;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'BLUEPRINT_REQUEST_EXIT' }) as { ok?: unknown } | undefined;
    return res?.ok !== false;
  } catch (e) {
    log.swallow('blueprint:requestExit', e);
    return true;
  }
}

/** Returns false when the change did not happen (the user kept editing, or, with `onUnreachable`,
 *  the tab to open on has no page tools: then it is told the tab and Blueprint stays off). `force` skips the
 *  exit check: the overlay's X asked already, in the page. */
export async function setBlueprintActive(windowId: number, active: boolean, tabId?: number, force = false, onUnreachable?: (tabId: number | undefined) => void): Promise<boolean> {
  const base = getCtx();
  // Blueprint works on the server of the page it opens on.
  const pageTab = tabId ?? (active
    ? (await chrome.tabs.query({ active: true, windowId }).catch(() => [] as chrome.tabs.Tab[]))[0]?.id
    : base.blueprintTabByWindow.get(windowId));
  const ctx = await boundCtxForTab(pageTab, base);
  if (active && !blueprintSupported(ctx)) {
    ctx.toast(BLUEPRINT_VERSION_ERROR, 'info');
    return false;
  }
  const unchanged = ctx.blueprintActiveByWindow.get(windowId) === active;
  if (unchanged && !force) return true;
  // Every way out except the overlay's own X (which asked in the page) goes through the exit check.
  if (!active && !force && !(await blueprintMayExit(tabId ?? base.blueprintTabByWindow.get(windowId)))) return false;
  // Capture the owner before changing either map. Turning Blueprint OFF must follow the session back
  // to the tab it was opened in — the window's currently-active tab may have changed since then.
  const pinnedTabId = ctx.blueprintTabByWindow.get(windowId);
  ctx.blueprintActiveByWindow.set(windowId, active);
  if (!unchanged) ctx.logActivity('info', active ? 'Turned Blueprint on' : 'Turned Blueprint off');
  const state = { type: 'BLUEPRINT_STATE' as const, active };
  ctx.sendToPanelByWindow(windowId, state);
  let reached = !active;
  let target: number | undefined;
  try {
    target = tabId ?? (!active ? pinnedTabId : undefined)
      ?? (await chrome.tabs.query({ active: true, windowId }))[0]?.id;
    if (target != null) {
      if (active) ctx.blueprintTabByWindow.set(windowId, target); else ctx.blueprintTabByWindow.delete(windowId);
      await ensureContentScript(target);
      if (active) {
        try { await chrome.tabs.sendMessage(target, state); reached = true; }
        catch (e) { log.swallow('blueprint:toggleTab', e); }
      } else chrome.tabs.sendMessage(target, state).catch(e => log.swallow('blueprint:toggleTab', e));
    } else if (!active) { ctx.blueprintTabByWindow.delete(windowId); }
  } catch (e) { log.swallow('blueprint:toggleQuery', e); }
  if (!reached && onUnreachable) {
    // The tab cannot run Blueprint (not a BMP page with the page tools): it stays off. Only a
    // caller that reports it backs off (a resume after Apply targets a tab that is reloading).
    ctx.blueprintActiveByWindow.set(windowId, false);
    ctx.blueprintTabByWindow.delete(windowId);
    ctx.sendToPanelByWindow(windowId, { type: 'BLUEPRINT_STATE', active: false });
    ctx.persistBlueprintState();
    onUnreachable?.(target);
    return false;
  }
  // Persist so the toggle survives an MV3 SW idle-suspend (mirrors setInspectActive). After a restart
  // the boot restore repopulates this, so BLUEPRINT_TOGGLE / the Blueprint command / the side-panel toggle read
  // the true state instead of an empty map — the fix for "Exit does nothing after the SW slept".
  ctx.persistBlueprintState();
  return true;
}

/** Flip blueprint on/off for a window (defaulting to the last-focused one — used by both the
 *  BLUEPRINT_TOGGLE message and the toggle-blueprint keyboard command). Blueprint and inspect are mutually
 *  exclusive, so turning blueprint on turns inspect off. */
export async function toggleBlueprint(windowId?: number, onUnreachable?: (tabId: number | undefined) => void): Promise<void> {
  const ctx = getCtx();
  const wid = windowId ?? (await chrome.windows.getLastFocused().catch(() => null))?.id;
  if (wid == null) return;
  const next = !ctx.blueprintActiveByWindow.get(wid);
  if (next && ctx.isInspectActive(wid)) await toggleInspect(wid); // blueprint on ⇒ inspect off
  await setBlueprintActive(wid, next, undefined, false, onUnreachable);
}

register('BLUEPRINT_TOGGLE', async (_msg, _respond, meta) => {
  let unreachable: { tabId: number | undefined } | null = null;
  await toggleBlueprint(meta.panelWindowId ?? undefined, tabId => { unreachable = { tabId }; });
  // The window's tab has no page tools: the panel says why.
  const missed = unreachable as { tabId: number | undefined } | null;
  if (missed) await reportFrameOpenFailure(ctxOf(meta), meta.panelWindowId, missed.tabId);
});

// Object window "Edit in Blueprint": the in-page Blueprint editor on the sender tab (the window's
// tab), with the object selected once the page model is loaded. A set, never a toggle: an open
// Blueprint stays open and only moves its selection.
register('OPEN_BLUEPRINT_FOR', async (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  const tabId = meta.senderTabId;
  if (tabId == null || typeof msg.rid !== 'string' || !/^-?\d+$/.test(msg.rid)) return;
  if (!blueprintSupported(ctx)) { ctx.toast(BLUEPRINT_VERSION_ERROR, 'info'); return; }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (ctx.isInspectActive(tab.windowId)) await toggleInspect(tab.windowId); // same exclusivity as toggle
    await setBlueprintActive(tab.windowId, true, tabId);
    chrome.tabs.sendMessage(tabId, { type: 'BLUEPRINT_SELECT', rid: msg.rid }).catch(e => log.swallow('blueprint:select', e));
  } catch (e) { log.swallow('blueprint:openFor', e); }
});

// The overlay X is tied to a concrete content tab, so derive the window from that sender and pin the
// OFF broadcast back to the same tab. `force` heals any stale worker map as well: even if the MV3
// worker restored "off" while an old overlay is visibly alive, the explicit close still tears it down.
register('BLUEPRINT_CLOSE', async (_msg, _respond, meta) => {
  if (meta.senderTabId != null) {
    try {
      const tab = await chrome.tabs.get(meta.senderTabId);
      await setBlueprintActive(tab.windowId, false, meta.senderTabId, true);
      return;
    } catch (e) { log.swallow('blueprint:closeTab', e); }
  }
  if (meta.panelWindowId != null) await setBlueprintActive(meta.panelWindowId, false, undefined, true);
});

// Content → SW: the tab is activating Blueprint for the first time and needs the editor's
// content-blueprint.js injected (it's not part of the always-on content bundle).
// Fire-and-forget; content.ts follows up with the enable command (`window.__crevBpCmd`, or the
// pending-command queue the newly-injected script drains on its own init).
register('INJECT_BLUEPRINT', async (_msg, _respond, meta) => {
  if (meta.senderTabId == null || !blueprintSupported(ctxOf(meta))) return;
  await ensureBlueprintScript(meta.senderTabId);
});

// Post-apply resume: apply toggles blueprint OFF and reloads the page (the live grid only reflows on
// a real load); the fresh content script then asks to turn it back ON so the editing session
// continues on the fresh model. Deterministic set (not a toggle) — an already-on window is a no-op.
register('BLUEPRINT_RESUME', async (_msg, _respond, meta) => {
  if (meta.senderTabId == null) return;
  try {
    const tab = await chrome.tabs.get(meta.senderTabId);
    if (tab?.windowId == null) return;
    if (ctxOf(meta).isInspectActive(tab.windowId)) await toggleInspect(tab.windowId); // same exclusivity as toggle
    await setBlueprintActive(tab.windowId, true, meta.senderTabId);
  } catch (e) { log.swallow('blueprint:resume', e); }
});

/** Environment fingerprint stamped at load and re-checked at apply (environmentToken): the page's own
 *  profile id with the live server URL, so a profile reconfigured to a different workspace under the
 *  same id can't silently receive a commit meant for the old one. */
// LAYOUT_LOAD/APPLY are request/response: the content overlay sends them via `sendRequest`
// (one-shot), so the handler's `respond` IS sendResponse and goes straight back to the sender.

register('LAYOUT_LOAD', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: 'Not connected' }); return; }
  if (!blueprintSupported(ctx)) { respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: BLUEPRINT_VERSION_ERROR }); return; }
  const environment = environmentToken(ctx);
  const t0 = Date.now();
  const timings: string[] = []; // operation-local — see makeLayoutIO
  try {
    const res = await loadPage(ctx.client, msg.rid, msg.prefer, timings);
    if (!res) {
      respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: 'Not an editable page (no tabset resolved)' });
      ctx.logActivity('warn', 'This page cannot be edited in Blueprint', `RID ${msg.rid}`);
      return;
    }
    respond({
      type: 'LAYOUT_LOAD_RESULT', ok: true, env: environment,
      ctx: res.ctx, model: res.load.model, baseline: res.load.baseline, orphans: res.load.orphans,
    });
    ctx.logActivity('success', `Opened Blueprint for ${res.ctx.pageId}`, [`${res.ctx.pageClass} ${res.ctx.pageId}${res.ctx.resultOnly ? ' (result-only, no tabset)' : ''}`, `EC calls: ${timings.join(' | ')}`].join('\n'), { category: 'system', action: 'blueprint-load', durationMs: Date.now() - t0 });
  } catch (e) {
    respond({ type: 'LAYOUT_LOAD_RESULT', ok: false, error: errorMessage(e) });
    ctx.logActivity('error', 'Blueprint load threw', e instanceof Error ? e.message : String(e));
  }
});

register('LAYOUT_APPLY', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, error: 'Not connected' }); return; }
  if (!blueprintSupported(ctx)) {
    respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, error: BLUEPRINT_VERSION_ERROR });
    return;
  }
  // Wrong-env guard: refuse a commit whose load happened against another server than the one the
  // page belongs to now.
  if (msg.env !== environmentToken(ctx)) {
    respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false,
      error: environmentMismatchError(ctx, msg.env) });
    ctx.logActivity('warn', 'Blueprint not applied: the page belongs to another server', `loaded on ${msg.env}, page now on ${environmentToken(ctx)}`);
    return;
  }
  if (msg.portableIds && Object.keys(msg.portableIds).length && msg.ctx.target !== 'template') {
    respond({
      type: 'LAYOUT_APPLY_RESULT',
      ok: false,
      noop: false,
      error: 'Automatic ID assignment is available only while editing a template.',
    });
    return;
  }
  const t0 = Date.now();
  const timings: string[] = []; // operation-local — see makeLayoutIO
  try {
    const res = await applyPage(ctx.client, msg.ctx, msg.baseline, msg.desired, timings, msg.portableIds);
    respond({
      type: 'LAYOUT_APPLY_RESULT', ok: res.ok, noop: res.noop, stale: res.stale, partial: res.partial,
      unverified: res.unverified,
      script: res.script, executionLog: res.executionLog, notes: res.notes,
      model: res.model, baseline: res.baseline, error: res.error,
    });
    // Audit trail: the applied EC is first-class — record it so a mis-apply is reconstructable.
    // The detail leads with BMP's actual commit response, followed by Blueprint's verification,
    // requested changes, generated EC, and internal timings. A partial apply is logged loudly at
    // 'error' even when ok:true because BMP EC is not atomic.
    const detail = () => applyActivityDetail(res, timings);
    const durationMs = Date.now() - t0;
    const meta = blueprintActivityMeta(msg.ctx, 'apply', durationMs);
    if (res.noop) {
      ctx.logActivity('success', 'Blueprint apply: no changes', undefined, meta);
    } else if (res.unverified) {
      // Commit ran but the reconcile re-fetch failed — warn (ok) / error (errored partway), never a bare
      // "apply failed": the write most likely landed and the page reloads to show the truth.
      ctx.logActivity(res.ok ? 'warn' : 'error', 'Blueprint apply unverified', detail(), meta);
    } else if (res.partial) {
      ctx.logActivity('error', 'Blueprint partially applied', detail(), meta);
    } else if (res.ok) {
      ctx.logActivity('success', `Blueprint applied ${res.plan.length} step(s) (${durationMs}ms)`, detail(), meta);
    } else {
      ctx.logActivity('error', 'Blueprint apply failed', detail(), meta);
    }
  } catch (e) {
    respond({ type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, error: errorMessage(e) });
    ctx.logActivity('error', 'Blueprint apply threw', e instanceof Error ? e.message : String(e), blueprintActivityMeta(msg.ctx, 'apply'));
  }
});

register('LAYOUT_PORTABLE_ID_PREFLIGHT', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) {
    respond({ type: 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT', ok: false, error: 'Not connected' });
    return;
  }
  try {
    const portableIds = await preflightPortableIds(ctx.client, msg.requests);
    respond({ type: 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT', ok: true, portableIds });
  } catch (error) {
    respond({ type: 'LAYOUT_PORTABLE_ID_PREFLIGHT_RESULT', ok: false, error: errorMessage(error) });
  }
});

// Apply-preview blast radius. Best-effort and fire-and-respond: loadBlastRadius never throws (it
// fails silently to nulls), so the preview shows warnings only when the rref walk came back in time.
register('LAYOUT_BLAST', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) {
    respond({ type: 'LAYOUT_BLAST_RESULT', fanout: null, blast: null, flowBlast: null });
    return;
  }
  const res = await loadBlastRadius(ctx.client, msg.pageId, msg.containers, msg.flowContainers);
  respond({
    type: 'LAYOUT_BLAST_RESULT',
    fanout: res.fanout,
    blast: res.blast,
    flowBlast: res.flowBlast,
  });
});

// Flow "wire to existing" picker: the workspace's InputSets / EditPages, fetched lean at picker-open
// (never part of the main layout fetch). Stateless like every other layout handler.
register('LAYOUT_FLOW_REFS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'LAYOUT_FLOW_REFS_RESULT', ok: false, error: 'Not connected' }); return; }
  try {
    const refs = await loadFlowRefs(ctx.client, msg.refClass);
    respond({ type: 'LAYOUT_FLOW_REFS_RESULT', ok: true, refs });
  } catch (e) {
    respond({ type: 'LAYOUT_FLOW_REFS_RESULT', ok: false, error: errorMessage(e) });
  }
});

// Wire-to-existing follow-up: the on-demand children of ONE existing off-page InputSet/EditPage, so the
// cell shows its real current contents (staged adds layer on top). Fails soft — the UI keeps its note.
register('LAYOUT_FLOW_REF_CHILDREN', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'LAYOUT_FLOW_REF_CHILDREN_RESULT', ok: false, error: 'Not connected' }); return; }
  try {
    const children = await loadFlowRefChildren(ctx.client, msg.refId);
    respond({ type: 'LAYOUT_FLOW_REF_CHILDREN_RESULT', ok: true, children });
  } catch (e) {
    respond({ type: 'LAYOUT_FLOW_REF_CHILDREN_RESULT', ok: false, error: errorMessage(e) });
  }
});
