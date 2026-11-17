/**
 * SW-side launcher for the CVO Studio overlay — the CustomVisualization
 * sibling of openEditorWindow(). Fetches the CVO's html + javascript in one EC
 * call, stashes a lean StudioContext in chrome.storage.local, and mounts the
 * studio iframe overlay on the target tab (same frame-overlay path as the
 * editor). Save flows back through the existing SAVE_PROPERTY handler.
 */
import { boundCtxForTab, getCtx, type SwContext } from './sw-context'
import { errorMessage, log } from './logger'
import { errorKindOf } from './error-kind'
import { launchFrame, resolveFrameTargetTabId } from './frame-launcher'
import { resolveTabPageContext } from './page-context-resolver'
import { STUDIO_CTX_PREFIX, type StudioContext, type StudioCodeProp } from './studio-types'
import { modeForType, ALL_STUDIO_PROPS } from './studio-mode'
import { ENVIRONMENT_CHANGED_ERROR, environmentToken } from './environment'

/** The object the BMP page is currently rendering — the default render context
 *  for the live-`_data` fetch (the data servlet is gated on it being org-rooted).
 *  Mirrors the editor's getCurrentPageRid; defensive (tab may be gone / no
 *  chrome.tabs in tests). Returns undefined when there's no current page object. */
async function getRenderContextRid(target?: { tabId?: number; windowId?: number }): Promise<string | undefined> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs) return undefined
    let tabId = target?.tabId
    if (tabId == null && typeof chrome.tabs.query === 'function') {
      const q: chrome.tabs.QueryInfo = target?.windowId != null
        ? { active: true, windowId: target.windowId }
        : { active: true, lastFocusedWindow: true }
      tabId = (await chrome.tabs.query(q))[0]?.id
    }
    if (tabId == null) return undefined
    const rid = (await resolveTabPageContext(tabId)).rid
    return rid && /^-?\d+$/.test(rid) ? rid : undefined
  } catch {
    return undefined
  }
}

export async function openStudioWindow(
  rid: string,
  preferredProperty?: string,
  target?: { tabId?: number; windowId?: number },
  requester?: SwContext,
): Promise<void> {
  await getCtx().settingsReady
  // Studio works on the server of the page it is mounted in.
  const targetTabId = await resolveFrameTargetTabId(target)
  const swCtx = await boundCtxForTab(targetTabId, requester)
  if (targetTabId != null) target = { tabId: targetTabId }
  const environment = environmentToken(swCtx)
  const client = swCtx.client
  const saveTarget = swCtx.settings.saveTarget

  // One EC round-trip: identity + template + the code maps. The object's type
  // (and so its mode/file list) isn't known yet, so fetch the union of every
  // mode's props — absent ones come back empty and are trimmed below.
  let data: import('./bmp-client').EditorContextData | null = null
  let loadError: string | undefined
  let loadErrorKind: import('./error-kind').BmpErrorKind | undefined
  if (client) {
    try {
      data = await client.fetchEditorContext(rid, [...ALL_STUDIO_PROPS])
      if (!data) loadError = 'BMP did not find this object.'
    } catch (e) {
      log.swallow('cvo-studio:fetchContext', e)
      loadError = errorMessage(e)
      loadErrorKind = errorKindOf(e)
    }
  } else {
    loadError = 'Not connected to BMP'
    loadErrorKind = 'not-signed-in'
  }
  if (environmentToken(swCtx) !== environment) throw new Error(ENVIRONMENT_CHANGED_ERROR)

  // The code was not read: the studio opens on the error, never on empty
  // code slots that a save would write back over the real code.
  if (!data) {
    const cached = swCtx.cache.get(rid)
    data = {
      instance: { rid, businessId: cached?.businessId ?? '', type: cached?.type ?? '', name: cached?.name ?? '' },
      template: null,
      instanceCode: {},
      templateCode: {},
    }
  }

  const { instance, template, instanceCode, templateCode } = data
  const mode = modeForType(instance.type)
  const modeProps = mode.files.map(f => f.prop)
  const trim = (code: Record<string, string>): Record<string, string> =>
    Object.fromEntries(modeProps.map(p => [p, code[p] ?? '']))
  const property: StudioCodeProp = preferredProperty && modeProps.includes(preferredProperty)
    ? preferredProperty
    : modeProps[0]
  const renderContextRid = mode.hasSandbox ? await getRenderContextRid(target) : undefined
  if (environmentToken(swCtx) !== environment) throw new Error(ENVIRONMENT_CHANGED_ERROR)

  const ctx: StudioContext = {
    environment,
    mode: mode.key,
    instance,
    template,
    instanceCode: trim(instanceCode),
    templateCode: trim(templateCode),
    saveTarget,
    property,
    renderContextRid,
    ...(loadError ? { loadError } : {}),
    ...(loadErrorKind ? { loadErrorKind } : {}),
  }

  // Stash the context for the studio page to read on load. A CVO's html+js can
  // be hundreds of KB, so clear any stale studio contexts first (read-once
  // handoff — bounds storage growth to the one we're about to open) and guard
  // the write so a full quota surfaces a clear error instead of launching a
  // studio that loads into "No CVO context found".
  try {
    const all = await chrome.storage.local.get(null)
    const stale = Object.keys(all).filter(k => k.startsWith(STUDIO_CTX_PREFIX))
    if (stale.length) await chrome.storage.local.remove(stale)
    // `savedAt`: an unopened context is swept after a week (local-data.ts).
    await chrome.storage.local.set({ [`${STUDIO_CTX_PREFIX}${rid}`]: { ...ctx, savedAt: Date.now() } })
  } catch (e) {
    log.swallow('cvo-studio:stashContext', e)
    throw new Error('Could not open the studio: browser storage is full. Clear some space and try again.')
  }

  const label = instance.name
    ? `${mode.title} · ${instance.name}`
    : `${mode.title} · ${instance.businessId || rid}`
  await launchFrame({
    kind: 'cvo-studio',
    path: `studio/studio.html#${rid}`,
    label,
    defaultWidth: 1100,
    defaultHeight: 720,
    tabId: target?.tabId,
    windowId: target?.windowId,
  })
}
