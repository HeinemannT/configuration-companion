/**
 * EC execution, property save, and editor handlers.
 */

import { noteSavedObject } from '../code-index-service';
import { register } from '../handler-registry';
import { ctxOf, type SwContext } from '../sw-context';
import { savesViaExtendedCode } from '../object-read';
import { buildEditorContext, openEditorWindow, openExtendedWindow } from '../editor';
import { resolveFrameTargetTabId } from '../frame-launcher';
import { reportFrameOpenFailure } from '../frame-open-failure';
import { errorMessage, log } from '../logger';
import { userScript } from '../script-kinds';
import { invalidateRid, publishIdentity } from '../enrichment';
import type { ActivityMeta } from '../types';
import { activityObject, activityObjectLabel, ecActivityDetail } from '../activity-format';
import { saveIdentity } from '../identity-save';
import { environmentMatches, environmentMismatchError, environmentToken } from '../environment';
import { currentCommandActor } from '../command-actor';
import { errorKindOf } from '../error-kind';
import { isOutcomeUnknown, MAY_HAVE_SAVED } from '../save-check';

function commandOrigin(ctx: SwContext) {
  const client = ctx.client!;
  const profileId = ctx.settings?.activeProfileId;
  const epoch = client.auth?.sessionEpoch;
  const actor = currentCommandActor(ctx.profileId);
  return {
    meta: {
      profileId,
      commandActor: client.commandUser ?? actor?.user,
      commandAuthSource: client.authMode === 'stored' ? 'stored-login' as const : 'portal-session' as const,
    },
    isCurrent: () => ctx.client === client && ctx.settings?.activeProfileId === profileId
      && client.auth?.sessionEpoch === epoch,
    assertSession: () => {
      if (client.auth?.sessionEpoch !== epoch) throw new Error('BMP connection changed. Reload before saving.');
    },
  };
}

register('EC_EXECUTE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'EC_RESULT', ok: false, error: 'Not connected' }); return; }
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'EC_RESULT', ok: false, error: environmentMismatchError(ctx, msg.environment) });
    return;
  }
  const client = ctx.client;
  const origin = commandOrigin(ctx);
  const cached = msg.objectRid ? ctx.cache.get(msg.objectRid) : undefined;
  const startTime = Date.now();
  try {
    const result = await client.executeEc(userScript(msg.code), msg.objectRid, msg.transactional ?? false);
    const durationMs = Date.now() - startTime;
    respond({ type: 'EC_RESULT', ...result, durationMs });
    if (origin.isCurrent()) ctx.scriptHistory.record({
      code: msg.code, timestamp: Date.now(), ok: result.ok,
      mode: msg.transactional ? 'execute' : 'preview', durationMs,
    });
    if (origin.isCurrent() && msg.objectRid && result.ok) {
      ctx.history.record({
        rid: msg.objectRid,
        name: cached?.name,
        type: cached?.type,
        businessId: cached?.businessId,
        templateBusinessId: cached?.templateBusinessId,
        action: 'ec-executed',
        timestamp: Date.now(),
      });
    }
    // Activity log: EC runs are first-class actions worth surfacing in the Log
    // tab — previously only enrichment / connection / detection touched it.
    const mode = msg.transactional ? 'execute' : 'preview';
    const object = msg.objectRid ? activityObject(msg.objectRid, cached) : undefined;
    const target = object ? activityObjectLabel(object, msg.objectRid!) : 'standalone code';
    const property = msg.property ? ` · ${msg.property}` : '';
    const verb = msg.transactional ? 'Executed' : 'Previewed';
    const meta: ActivityMeta = {
      ...origin.meta,
      category: 'execution',
      action: mode,
      ...(object ? { object } : {}),
      durationMs,
    };
    const detail = ecActivityDetail(result);
    if (result.ok) {
      ctx.logActivity('success', `${verb} EC on ${target}${property} (${durationMs}ms)`, detail, meta);
    } else {
      ctx.logActivity('error', `EC ${mode} failed on ${target}${property} (${durationMs}ms)`, detail, meta);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    respond({ type: 'EC_RESULT', ok: false, error: errorMessage(e) });
    const object = msg.objectRid ? activityObject(msg.objectRid, cached) : undefined;
    ctx.logActivity('error', `EC request failed on ${activityObjectLabel(object, msg.objectRid ?? 'standalone code')}`, errMsg, {
      ...origin.meta,
      category: 'execution',
      action: msg.transactional ? 'execute' : 'preview',
      ...(object ? { object } : {}),
    });
    // A transport failure can occur after BMP received a write. Do not imply
    // rollback, or show this old workspace's toast over the new workspace.
    if (origin.isCurrent()) ctx.toast(`EC request failed: ${errMsg}`, 'error');
  }
});

register('SAVE_PROPERTY', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'SAVE_RESULT', ok: false, error: 'Not connected', notSent: true }); return; }
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'SAVE_RESULT', ok: false, error: environmentMismatchError(ctx, msg.environment), notSent: true });
    return;
  }
  const client = ctx.client;
  const origin = commandOrigin(ctx);
  const object = activityObject(msg.rid, ctx.cache.get(msg.rid), { ...msg.objectLabel, type: msg.objectLabel?.type ?? msg.objectType });
  // Script props, TextElement bodies and every expression slot are saved as EC
  // string literals (saveCodeViaEc). BMP rejects their typed binary save
  // ("argument type mismatch"); `_o.change(p := "…")` is the verified route.
  const isCodeProp = savesViaExtendedCode(msg.property, msg.valueKind);
  const startTime = Date.now();
  try {
    const result = isCodeProp
      ? await client.saveCodeViaEc(msg.rid, msg.property, msg.value)
      : await client.saveProperty(msg.rid, msg.objectType, msg.property, msg.value);
    const durationMs = Date.now() - startTime;
    // Log the save outcome — useful when the editor reports failure but BMP
    // actually saved. If you see ok=true here but the UI says "save failed",
    // the response was lost between SW and the editor (MV3 SW unload race).
    log.debug('handler:save', `SAVE_PROPERTY ${msg.property} on ${msg.rid}: ok=${result.ok}, ${durationMs}ms${result.error ? `, error=${result.error}` : ''}`);
    respond({ type: 'SAVE_RESULT', ...result });
    const label = activityObjectLabel(object, msg.rid);
    const meta: ActivityMeta = {
      ...origin.meta,
      category: 'change',
      action: 'save-property',
      object,
      durationMs,
    };
    if (result.ok) {
      ctx.logActivity('success', `Saved ${msg.property} on ${label} (${durationMs}ms)`, undefined, meta);
      // Drop the cached enrichment + re-fetch so badges / side panel
      // pick up any name/type/businessId change immediately. Fire-and-
      // forget; this doesn't block the editor's "saved" UI.
      if (origin.isCurrent()) invalidateRid(msg.rid, ctx).catch(e => log.swallow('handler:save:invalidate', e));
      // A local copy of the code takes the saved text (no server read).
      if (origin.isCurrent()) noteSavedObject(msg.rid, isCodeProp ? { [msg.property]: msg.value } : undefined, ctx);
    } else if (result.outcomeUnknown) {
      // The answer did not arrive: BMP may have stored the value. The caller
      // re-reads and says which; nothing here may imply "not saved".
      ctx.logActivity('warn', `No answer for ${msg.property} on ${label} (${durationMs}ms); the save may have been applied`, result.error, meta);
      if (origin.isCurrent()) invalidateRid(msg.rid, ctx).catch(e => log.swallow('handler:save:invalidate', e));
    } else {
      ctx.logActivity('error', `Save failed for ${msg.property} on ${label} (${durationMs}ms)`, result.error, meta);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    respond({ type: 'SAVE_RESULT', ok: false, error: errorMessage(e), ...(isOutcomeUnknown(errorKindOf(e)) ? { outcomeUnknown: true } : {}) });
    ctx.logActivity('error', `Save request failed for ${msg.property} on ${activityObjectLabel(object, msg.rid)}`, errMsg, {
      ...origin.meta,
      category: 'change',
      action: 'save-property',
      object,
    });
    // Thrown save means SW lost track before BMP responded. Editor
    // window may already be torn down — surface via toast so the user
    // doesn't think the save silently succeeded.
    if (origin.isCurrent()) ctx.toast(isOutcomeUnknown(errorKindOf(e)) ? `${MAY_HAVE_SAVED} ${errMsg}` : `Save failed: ${errMsg}`, 'error');
  }
});

register('SAVE_IDENTITY', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) {
    respond({ type: 'SAVE_IDENTITY_RESULT', ok: false, error: 'Not connected', notSent: true });
    return;
  }
  if (!environmentMatches(ctx, msg.environment)) {
    respond({ type: 'SAVE_IDENTITY_RESULT', ok: false, error: environmentMismatchError(ctx, msg.environment), notSent: true });
    return;
  }
  const client = ctx.client;
  const origin = commandOrigin(ctx);
  const object = activityObject(msg.rid, ctx.cache.get(msg.rid), msg.objectLabel);

  const startTime = Date.now();
  try {
    // The save ends with a fresh verification read of the full identity.
    // Keep it: the badges are then updated from it instead of a second read.
    let verified: Awaited<ReturnType<typeof client.lookupIdentity>> = null;
    const port = {
      lookupIdentity: async (rid: string, options?: { fresh?: boolean }) => {
        const identity = await client.lookupIdentity(rid, options);
        if (options?.fresh) verified = identity;
        return identity;
      },
      applyIdentityChanges: (rid: string, changes: Parameters<typeof client.applyIdentityChanges>[1]) => client.applyIdentityChanges(rid, changes),
    };
    const patch = {
      ...(msg.businessId !== undefined ? { businessId: msg.businessId } : {}),
      ...(msg.name !== undefined ? { name: msg.name } : {}),
      ...(msg.templateBusinessId !== undefined ? { templateBusinessId: msg.templateBusinessId } : {}),
    };
    const result = await saveIdentity(port, msg.rid, patch, origin.assertSession, msg.expect);
    if (!result.ok) {
      respond({ type: 'SAVE_IDENTITY_RESULT', ...result });
      return;
    }

    const durationMs = Date.now() - startTime;
    ctx.logActivity('success', `Saved identity on ${activityObjectLabel(object, msg.rid)} (${durationMs}ms)`, undefined, {
      ...origin.meta,
      category: 'change',
      action: 'save-property',
      object,
      durationMs,
    });
    respond({ type: 'SAVE_IDENTITY_RESULT', ...result });
    if (origin.isCurrent()) noteSavedObject(msg.rid, undefined, ctx);
    // The identity workflow already verified the write. Refreshing the
    // shared cache/badges is best-effort and must not turn a verified save
    // into a UI error if a later enrichment broadcast happens to fail.
    if (origin.isCurrent()) {
      if (verified) publishIdentity(msg.rid, verified, ctx);
      else invalidateRid(msg.rid, ctx).catch(e => log.swallow('handler:saveIdentity:invalidate', e));
    }
  } catch (e) {
    const error = errorMessage(e);
    respond({ type: 'SAVE_IDENTITY_RESULT', ok: false, error });
    ctx.logActivity('error', `Identity save failed on ${activityObjectLabel(object, msg.rid)}`, error, {
      ...origin.meta,
      category: 'change',
      action: 'save-property',
      object,
    });
  }
});

register('OPEN_EDITOR', (msg, _respond, meta) => {
  // Source-aware mount target: a content script that fired OPEN_EDITOR
  // mounts on its own tab; a side-panel-initiated OPEN_EDITOR mounts on
  // the panel's window's active tab. Without this, two-panel users could
  // click "Open Editor" in panel A and have the editor land on window B's
  // tab (whichever was most recently focused).
  void openEditorWindow(
    msg.rid,
    msg.property,
    { tabId: meta.senderTabId, windowId: meta.panelWindowId },
    { scrollToLine: msg.scrollToLine, scrollToText: msg.scrollToText },
    ctxOf(meta),
  );
  const ctx = ctxOf(meta);
  const cached = ctx.cache.get(msg.rid);
  if (cached) {
    ctx.history.record({
      rid: msg.rid,
      name: cached.name,
      type: cached.type,
      businessId: cached.businessId,
      templateBusinessId: cached.templateBusinessId,
      action: 'edited',
      timestamp: Date.now(),
    });
  }
});

register('FETCH_EDITOR_CONTEXT', (msg, respond, meta) => {
  void buildEditorContext(
    msg.rid,
    msg.property,
    { tabId: meta.senderTabId, windowId: meta.panelWindowId },
    undefined,
    ctxOf(meta),
  ).then(
    context => respond({ type: 'EDITOR_CONTEXT_DATA', rid: msg.rid, context }),
    e => respond({
      type: 'EDITOR_CONTEXT_DATA',
      rid: msg.rid,
      context: {
        environment: environmentToken(ctxOf(meta)),
        instance: { rid: msg.rid, businessId: '', type: '', name: '' },
        template: null,
        instanceCode: {},
        templateCode: {},
        overrides: {},
        saveTarget: 'instance',
        property: msg.property ?? 'expression',
        loadError: e instanceof Error ? e.message : 'Failed to load editor context',
      },
    }),
  );
});

register('EDITOR_LAUNCH_READY', (msg, _respond, meta) => {
  const phases = Object.fromEntries(Object.entries(msg.phases).map(([key, value]) => [
    key,
    Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0,
  ])) as typeof msg.phases;
  const ctx = ctxOf(meta);
  ctx.logActivity(
    'info',
    `Editor ready (${phases.totalMs}ms)`,
    [
      `settings ${phases.settingsMs}ms`,
      `target ${phases.targetMs}ms`,
      `placeholder ${phases.placeholderMs}ms`,
      `frame ${phases.frameMountMs}ms`,
      `context ${phases.contextMs}ms`,
      `publish/adopt ${phases.publishToAdoptMs}ms`,
      `editor boot ${phases.editorBootMs}ms`,
    ].join(' · '),
    { category: 'system', action: 'editor-launch', durationMs: phases.totalMs },
  );
});

register('OPEN_EXTENDED', async (_msg, _respond, meta) => {
  // Standalone Extended Code window — same path as the open-extended command,
  // exposed in the sidepanel header so users without a shortcut can still open it.
  const target = { tabId: meta.senderTabId, windowId: meta.panelWindowId };
  try {
    // Nothing opened (no BMP page in the panel's window): the panel says why.
    if (await openExtendedWindow(undefined, target, undefined, ctxOf(meta)) === 'failed') {
      await reportFrameOpenFailure(ctxOf(meta), meta.panelWindowId, await resolveFrameTargetTabId(target));
    }
  } catch (e) { log.swallow('handler:openExtended', e); }
});
