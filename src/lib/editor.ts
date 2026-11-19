import { boundCtxForTab, getCtx, type SwContext } from './sw-context';
import { resolveTabPageContext } from './page-context-resolver';
import { log } from './logger';
import { type EditorContext, type ObjectIdentity } from './editor-types';
import { computeOverrides } from './editor-types';
import { launchFrame, resolveFrameTargetTabId } from './frame-launcher';
import type { FrameMountDisposition } from './types';
import {
  beginEditorLaunchSession,
  failEditorLaunchContext,
  publishEditorLaunchContext,
  releaseEditorLaunchContext,
} from './editor-launch-session';
import { ENVIRONMENT_CHANGED_ERROR, environmentToken } from './environment';
import { errorKindOf } from './error-kind';

// ── Public API ────────────────────────────────────────────────────

/** The object the BMP page is currently rendering — the real EC execution
 *  context (`this`): the object the page is bound to at runtime (e.g. the
 *  CeRiskAssessment whose detail page hosts the widget). The widget's
 *  `.location` can't give this — it returns the page/template, not the
 *  enterprise instance the template renders for.
 *
 *  Resolves the effective tab (explicit `tabId`, else the active tab of the
 *  window), then defers to the shared page-context resolver — the SAME rule the
 *  footer and Page tab use (URL deep-link wins; fiber fills routed pages).
 *  Returns undefined when there's no current page object. Defensive: never
 *  throws (tab may be gone / chrome.tabs absent in tests). */
async function getCurrentPageRid(
  target?: { tabId?: number; windowId?: number },
): Promise<string | undefined> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs) return undefined;
    let tabId = target?.tabId;
    if (tabId == null && typeof chrome.tabs.query === 'function') {
      const q: chrome.tabs.QueryInfo = target?.windowId != null
        ? { active: true, windowId: target.windowId }
        : { active: true, lastFocusedWindow: true };
      tabId = (await chrome.tabs.query(q))[0]?.id;
    }
    if (tabId == null) return undefined;
    const rid = (await resolveTabPageContext(tabId)).rid;
    // Final BMP-shape guard for `BigInt()` safety in executeEc.
    return rid && /^-?\d+$/.test(rid) ? rid : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve launch-time decoration for the EC execution-context chip. Keep this
 *  cache-only: a missing label must not add another serialized BMP command to
 *  editor startup. The RID still renders and can be enriched elsewhere. */
function resolveContextIdentity(
  contextRid: string | undefined,
  instanceRid: string,
  swCtx: SwContext,
): ObjectIdentity | undefined {
  if (!contextRid || contextRid === instanceRid) return undefined;
  const cached = swCtx.cache.get(contextRid);
  if (cached?.type || cached?.name) {
    return { rid: contextRid, businessId: cached.businessId ?? '', type: cached.type ?? '', name: cached.name ?? '' };
  }
  // Rid known but identity unresolved — still surface it (rid-only chip).
  return { rid: contextRid, businessId: '', type: '', name: '' };
}

export async function openEditorWindow(
  rid: string,
  preferredProperty?: string,
  target?: { tabId?: number; windowId?: number },
  opts?: { scrollToLine?: number; scrollToText?: string; proposal?: string },
  requester?: SwContext,
) {
  const requestedAt = Date.now();
  await getCtx().settingsReady;
  const settingsReadyAt = Date.now();
  const targetTabId = await resolveFrameTargetTabId(target);
  const targetResolvedAt = Date.now();
  if (targetTabId == null) {
    log.warn('editor:noTargetTab', 'No active tab is available for the editor launch');
    return;
  }
  // The editor works on the server of the page it is mounted in.
  const swCtx = await boundCtxForTab(targetTabId, requester);
  const frozenTarget = { tabId: targetTabId };
  const cached = swCtx.cache.get(rid);
  const loadingContext: EditorContext = {
    environment: environmentToken(swCtx),
    instance: {
      rid,
      businessId: cached?.businessId ?? '',
      type: cached?.type ?? '',
      name: cached?.name ?? '',
    },
    template: null,
    instanceCode: {},
    templateCode: {},
    overrides: {},
    saveTarget: swCtx.settings.saveTarget,
    property: preferredProperty ?? 'expression',
    loading: true,
    scrollToLine: opts?.scrollToLine,
    scrollToText: opts?.scrollToText,
    ...(opts?.proposal ? { proposal: opts.proposal } : {}),
  };

  const launchSession = await beginEditorLaunchSession(rid, loadingContext);
  const placeholderStoredAt = Date.now();

  const label = cached?.name
    ? `${cached.type || 'Object'} · ${cached.name}`
    : `Editor · ${cached?.businessId || rid}`;
  const disposition = await launchFrame({
    kind: 'editor',
    path: launchSession.path,
    label,
    defaultWidth: 960,
    defaultHeight: 640,
    // Resource identity includes the BMP environment. Same-profile launches
    // preserve drafts; a profile switch must never reuse stale editor context.
    resourceKey: `editor:${loadingContext.environment}:${rid}`,
    activation: {
      type: 'editor',
      rid,
      property: preferredProperty,
      scrollToLine: opts?.scrollToLine,
      scrollToText: opts?.scrollToText,
      ...(opts?.proposal ? { proposal: opts.proposal } : {}),
    },
    tabId: targetTabId,
  });
  const frameMountedAt = Date.now();

  if (disposition === 'activated' || disposition === 'superseded' || disposition === 'dropped' || disposition === 'failed') {
    await releaseEditorLaunchContext(launchSession);
    return;
  }

  try {
    const contextStartedAt = Date.now();
    const ctx = await buildEditorContext(rid, preferredProperty, frozenTarget, opts, swCtx);
    const contextFinishedAt = Date.now();
    const publishStartedAt = Date.now();
    ctx.launchTiming = {
      requestedAt,
      settingsReadyAt,
      targetResolvedAt,
      placeholderStoredAt,
      frameMountedAt,
      contextStartedAt,
      contextFinishedAt,
      publishStartedAt,
    };
    await publishEditorLaunchContext(launchSession, ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to load code from BMP';
    await failEditorLaunchContext(launchSession, loadingContext, message);
  }
}

/** Fetch and compose the complete editor context without opening a frame.
 *  Used both for initial launch and the in-window Retry action. */
export async function buildEditorContext(
  rid: string,
  preferredProperty?: string,
  target?: { tabId?: number; windowId?: number },
  opts?: { scrollToLine?: number; scrollToText?: string; proposal?: string },
  bound?: SwContext,
): Promise<EditorContext> {
  await getCtx().settingsReady;
  const swCtx = bound ?? getCtx();
  const environment = environmentToken(swCtx);
  const client = swCtx.client;
  const saveTarget = swCtx.settings.saveTarget;
  // Page-context detection is independent of the BMP editor query. Starting it
  // now removes a tabs/page-resolution waterfall after the server response.
  const pageRidPromise = getCurrentPageRid(target);

  // Single EC call: identity + template + all code properties
  let editorData: import('../lib/bmp-client').EditorContextData | null = null;
  let loadError: string | undefined;
  let loadErrorKind: import('./error-kind').BmpErrorKind | undefined;
  if (client) {
    try {
      // Pass the caller's requested property so it's fetched too — otherwise
      // Edit on e.g. afterExpression / showExpression / initExpression would
      // open `expression` (the property wasn't in the fetched code map).
      editorData = await client.fetchEditorContext(rid, preferredProperty ? [preferredProperty] : []);
    } catch (e) {
      log.swallow('editor:fetchContext', e);
      loadError = e instanceof Error ? e.message : 'Failed to load code from BMP';
      loadErrorKind = errorKindOf(e);
    }
  } else {
    loadError = 'No BMP connection is available';
    loadErrorKind = 'not-signed-in';
  }
  if (environmentToken(swCtx) !== environment) throw new Error(ENVIRONMENT_CHANGED_ERROR);

  // Fall back to cache for identity if EC failed or threw
  if (!editorData) {
    const cached = swCtx.cache.get(rid);
    editorData = {
      instance: {
        rid,
        businessId: cached?.businessId ?? '',
        type: cached?.type ?? '',
        name: cached?.name ?? '',
      },
      template: null,
      instanceCode: {},
      templateCode: {},
    };
    loadError ??= 'BMP did not find this object.';
  }

  const { instance, template, instanceCode, templateCode } = editorData;

  // Determine initial property — caller hint first, then instance, then template.
  // Caller-requested fields are retained in the fetched maps even when empty,
  // allowing an explicit Create action to open a new code value safely.
  const hintValid = preferredProperty
    && (Object.prototype.hasOwnProperty.call(instanceCode, preferredProperty)
      || Object.prototype.hasOwnProperty.call(templateCode, preferredProperty));
  const property = hintValid
    ? preferredProperty!
    : (Object.keys(instanceCode)[0] ?? Object.keys(templateCode)[0] ?? 'expression');

  // Resolve the EC execution context (`this`). The object the BMP page is
  // currently rendering (`?rid=`) is the real runtime context — for an
  // enterprise detail page that's the enterprise instance, NOT the
  // page/template that `.location` returns. Fall back to `.location`, then
  // (via getExecutionRid) the widget itself.
  const pageRid = await pageRidPromise;
  const executionContextRid = pageRid ?? editorData.locationRid;
  const executionContext = resolveContextIdentity(executionContextRid, instance.rid, swCtx);
  if (environmentToken(swCtx) !== environment) throw new Error(ENVIRONMENT_CHANGED_ERROR);

  const ctx: EditorContext = {
    environment,
    instance,
    template,
    instanceCode,
    templateCode,
    overrides: template ? computeOverrides(instanceCode, templateCode) : {},
    saveTarget,
    property,
    loadError,
    ...(loadErrorKind ? { loadErrorKind } : {}),
    executionContextRid,
    executionContext,
    useLookup: client?.supportsLookup !== false,
    scrollToLine: opts?.scrollToLine,
    scrollToText: opts?.scrollToText,
    ...(opts?.proposal ? { proposal: opts.proposal } : {}),
  };
  return ctx;
}

/** Open a standalone Extended Code overlay bound to the page's execution
 *  context. When the caller doesn't pass an explicit `pageRid`, it's resolved
 *  through the shared resolver — so the console gets the right `this` on BMP's
 *  custom-routed pages (where the URL has no `?rid=`) instead of opening
 *  contextless. */
export async function openExtendedWindow(
  pageRidOverride?: string,
  target?: { tabId?: number; windowId?: number },
  initialCode?: string,
  requester?: SwContext,
): Promise<FrameMountDisposition> {
  await getCtx().settingsReady;
  const targetTabId = await resolveFrameTargetTabId(target);
  // No tab to open on: nothing is prepared (the caller says why).
  if (targetTabId == null) return 'failed';
  const swCtx = await boundCtxForTab(targetTabId, requester);
  const environment = environmentToken(swCtx);
  const client = swCtx.client;

  const pageRid = pageRidOverride ?? await getCurrentPageRid(targetTabId != null ? { tabId: targetTabId } : target);

  let name = '';
  let type = '';
  let businessId = '';
  let templateBusinessId: string | undefined;

  // The scratch window needs identity only for its title/context chip. Keep
  // startup strictly cache-only: a cosmetic BMP lookup would occupy the
  // serialized command channel and could delay the editor's first Preview/Run.
  // The execution RID remains available even when the decoration is sparse.
  if (pageRid) {
    const cached = swCtx.cache.get(pageRid);
    if (cached?.name || cached?.type || cached?.businessId) {
      name = cached.name ?? '';
      type = cached.type ?? '';
      businessId = cached.businessId ?? '';
      templateBusinessId = cached.templateBusinessId;
    }
  }
  if (environmentToken(swCtx) !== environment) throw new Error(ENVIRONMENT_CHANGED_ERROR);

  const ctx: EditorContext = {
    environment,
    instance: {
      rid: pageRid ?? '',
      businessId,
      type,
      name,
      ...(templateBusinessId ? { templateBusinessId } : {}),
    },
    template: null,
    instanceCode: {},
    templateCode: {},
    overrides: {},
    saveTarget: swCtx.settings.saveTarget,
    property: null,
    extended: true,
    ...(initialCode ? { initialCode } : {}),
    executionContextRid: pageRid,
    useLookup: client?.supportsLookup !== false,
  };

  // The handoff carries code (an AI or search handoff): session storage only,
  // never extension-local storage, and gone when the browser closes.
  await chrome.storage.session.set({ crev_editor_ctx_extended: ctx });
  return launchFrame({
    kind: 'editor',
    path: 'editor/editor.html#extended',
    label: name ? `Extended Code · ${name}` : 'Extended Code',
    defaultWidth: 960,
    defaultHeight: 640,
    resourceKey: `editor:extended:${environment}`,
    // A code handoff is a new scratch document, not merely a request to focus
    // the existing one. Replacing it must therefore use the dirty guard.
    replaceExisting: !!initialCode,
    tabId: targetTabId ?? target?.tabId,
    windowId: target?.windowId,
  });
}
