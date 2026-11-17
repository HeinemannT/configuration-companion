/**
 * Message router — thin dispatcher over the handler registry.
 *
 * Three entry points map Chrome's messaging architecture to a single
 * handler registry. Domain modules in handlers/ register their own types.
 *
 * Every message passes two checks before its handler runs:
 * 1. The sender kind may send this type (allow-list, message-access.ts).
 * 2. The request is bound to its own server profile (profile-scope.ts): a
 *    content script or an embedded Companion window goes to the profile of
 *    its tab's page; the side panel to the profile its window shows; an
 *    extension page in its own tab to the profile it names. The handler gets
 *    that profile's context as `meta.ctx`.
 *
 * To add a new message type:
 *   1. Add the type to messages.ts and an entry to message-access.ts
 *   2. Create or edit a handler file in handlers/
 *   3. Call register('MY_TYPE', handler) — done
 */

import type { InspectorMessage } from './types';
import type { SwContext } from './sw-context';
import { getCtx } from './sw-context';
import { getHandler } from './handler-registry';
import { log, errorMessage } from './logger';
import { errorKindOf } from './error-kind';
import { senderKindMay, type SenderKind } from './message-access';
import { noteRefusal, senderKindOf } from './sender-trust';
import { isPageLocal, PAGE_NOT_SET_UP_ERROR } from './page-environment';
import { displayProfileOf, profileIdForUrl, scopeFor, tabUrlOf } from './profile-scope';

/** The typed reply sent when a handler throws before it answered. */
export function requestFailed(msg: InspectorMessage, e: unknown): InspectorMessage {
  const errorKind = errorKindOf(e);
  return {
    type: 'REQUEST_FAILED',
    requestType: msg.type,
    error: errorMessage(e),
    ...(errorKind ? { errorKind } : {}),
  };
}

// Import handler modules — registration happens at import time
import './handlers/inspect';
import './handlers/profiles';
import './handlers/objects';
import './handlers/ec';
import './handlers/json-shape';
import './handlers/studio';
import './handlers/access';
import './handlers/access-workspace';
import './handlers/enrichment';
import './handlers/detection';
import './handlers/history';
import './handlers/windows';
import './handlers/compare';
import './handlers/object-search';
import './handlers/object-window';
import './handlers/custom-properties';
import './handlers/browse';
import './handlers/code-refs';
import './handlers/code-search';
import './handlers/transport';
import './handlers/transport-window';
import './handlers/bmp-goto';
import './handlers/layout';
import './handlers/site-access';
import './handlers/ai';
import './handlers/page-prefs';

// ── Routing ──────────────────────────────────────────────────────

/** Extension pages may say which window (side panel) or profile (a page in
 *  its own tab) they belong to; messaging.ts adds it to every message. */
export interface RouteHint { windowId?: number; profileId?: string }
type Routed = InspectorMessage & { _route?: RouteHint; environment?: unknown };

export const UNKNOWN_PROFILE_ERROR =
  'This window belongs to a server profile that no longer exists in Companion. Close it and open it again.';

interface Route {
  ctx: SwContext;
  /** Set when no profile could be resolved for a content script or frame. */
  error?: string;
}

/** The profile named explicitly by an extension page: the profile part of an
 *  environment token (`profileId@server`) or the route hint. */
function namedProfile(msg: Routed): string | undefined {
  if (typeof msg.environment === 'string' && msg.environment.includes('@')) return msg.environment.split('@')[0];
  return msg._route?.profileId;
}

async function resolveRoute(
  kind: SenderKind,
  msg: Routed,
  where: { tabId?: number; tabUrl?: string; windowId?: number },
): Promise<Route> {
  const base = getCtx();
  // A unit-test harness installs a plain mock without scopes: use it as is.
  if (!base.scopeFor) return { ctx: base };
  let profileId: string | null | undefined;
  let error: string | undefined;
  if (kind === 'content' || kind === 'frame') {
    const url = where.tabUrl ?? (where.tabId != null ? tabUrlOf(where.tabId) : undefined);
    profileId = profileIdForUrl(url);
    if (!profileId) error = PAGE_NOT_SET_UP_ERROR;
  } else {
    const named = namedProfile(msg);
    if (named) {
      profileId = named;
      if (!scopeFor(named)) error = UNKNOWN_PROFILE_ERROR;
    } else {
      profileId = displayProfileOf(where.windowId ?? msg._route?.windowId);
    }
  }
  const scope = error ? null : scopeFor(profileId);
  if (!scope) return { ctx: base, ...(error ? { error } : {}) };
  await scope.ready;
  return { ctx: scope.ctx };
}

/** Whether an unresolved request may still run on the base context (whose
 *  client is null): page facts from a page, and everything from Companion's
 *  own pages (settings, profiles and AI setup work without a server). */
function mayRunUnbound(kind: SenderKind, type: string, error: string | undefined): boolean {
  if (kind === 'extension') return error !== UNKNOWN_PROFILE_ERROR;
  return isPageLocal(type);
}

function refuse(kind: SenderKind | null, msg: InspectorMessage, where: string | undefined): void {
  const base = getCtx();
  log.warn(`router:${kind ?? 'unknown'}:refused`, `${msg.type} from ${where ?? 'unknown sender'}`);
  noteRefusal(kind, msg.type, where, (level, message, detail, meta) => base.logActivity(level, message, detail, meta));
}

// ── Entry points ─────────────────────────────────────────────────

/**
 * All handlers are gated on settingsReady.  When the SW wakes from
 * suspension, chrome.storage.local.get runs before any handler fires.
 */

/** Handle a message from the panel port (persistent connection). The
 *  port reference lets us look up which window the panel is in; the
 *  request goes to the profile that window shows. respond replies to THIS
 *  panel only. */
export async function handlePanelMessage(msg: InspectorMessage, port?: chrome.runtime.Port) {
  const ctx = getCtx();
  await ctx.settingsReady;
  // Panel ports are accepted only from extension pages (service-worker.ts);
  // a port that reports another sender is refused here too.
  if (port?.sender && senderKindOf(port.sender) !== 'extension') {
    refuse(senderKindOf(port.sender), msg, port.sender?.url);
    return;
  }
  const handler = getHandler(msg.type);
  if (handler) {
    const panelWindowId = port ? findWindowIdForPort(ctx, port) : undefined;
    const respond = port
      ? (r: InspectorMessage) => { try { port.postMessage(r); } catch { /* port closed */ } }
      : (r: InspectorMessage) => ctx.sendToPanel(r);
    try {
      const route = await resolveRoute('extension', msg as Routed, { windowId: panelWindowId });
      if (route.error && !mayRunUnbound('extension', msg.type, route.error)) throw new Error(route.error);
      await handler(msg, respond, { isOneShot: false, panelWindowId, ctx: route.ctx, senderKind: 'extension' });
    } catch (e) {
      // A throw would otherwise leave the panel waiting for a reply forever.
      log.swallow(`router:panel:${msg.type}`, e);
      respond(requestFailed(msg, e));
    }
  }
}

function findWindowIdForPort(ctx: ReturnType<typeof getCtx>, port: chrome.runtime.Port): number | undefined {
  for (const [windowId, p] of ctx.panelPortByWindow) {
    if (p === port) return windowId;
  }
  return undefined;
}

/** Handle a message from a content script port. `pageUrl` is the page the
 *  script runs in; requests go only to that page's own server. */
export async function handleContentMessage(msg: InspectorMessage, senderTabId?: number, pageUrl?: string) {
  const ctx = getCtx();
  await ctx.settingsReady;
  if (!senderKindMay('content', msg.type)) {
    refuse('content', msg, pageUrl);
    return;
  }
  const handler = getHandler(msg.type);
  if (handler) {
    const route = await resolveRoute('content', msg as Routed, { tabId: senderTabId, tabUrl: pageUrl });
    if (route.error && !mayRunUnbound('content', msg.type, route.error)) {
      // Badges waiting for this answer must stop loading rather than spin.
      if (msg.type === 'ENRICH_BADGES' && senderTabId != null) {
        const enrichments: Record<string, Record<string, never>> = {};
        for (const rid of msg.rids) enrichments[rid] = {};
        try { ctx.contentPorts.get(senderTabId)?.postMessage({ type: 'BADGE_ENRICHMENT', enrichments }); } catch { /* port closed */ }
      }
      log.info('router:content:unbound', `${msg.type}: ${route.error}`);
      return;
    }
    const bound = route.ctx;
    Promise.resolve(handler(msg, r => bound.sendToPanel(r), { senderTabId, isOneShot: false, ctx: bound, senderKind: 'content' }))
      .catch(e => log.swallow(`router:content:${msg.type}`, e));
  }
}

/** Handle a one-shot message (chrome.runtime.onMessage from extension pages,
 *  embedded windows and content scripts). */
export function handleOneShotMessage(
  msg: InspectorMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: InspectorMessage) => void,
): boolean {
  const handler = getHandler(msg.type);
  if (!handler) return false;
  const kind = senderKindOf(sender);
  if (!kind || !senderKindMay(kind, msg.type)) {
    refuse(kind, msg, sender.url);
    sendResponse(requestFailed(msg, new Error(kind === 'content'
      ? 'This request is not accepted from a page.'
      : 'This request is accepted only from Companion’s own pages.')));
    return false;
  }
  // Gate on settingsReady — handler calls sendResponse async after settings load.
  // We always return true to keep the message port open until then.
  const ctx = getCtx();
  ctx.settingsReady
    .then(async () => {
      const route = await resolveRoute(kind, msg as Routed, {
        tabId: sender.tab?.id,
        // The page around a content script or an embedded window decides
        // its server: the tab's URL, not the frame's own URL.
        tabUrl: kind === 'extension' ? undefined : sender.tab?.url ?? (kind === 'content' ? sender.url : undefined),
      });
      if (route.error && !mayRunUnbound(kind, msg.type, route.error)) throw new Error(route.error);
      return handler(msg, sendResponse, {
        senderTabId: sender.tab?.id, isOneShot: true, ctx: route.ctx, senderKind: kind,
        ...(sender.frameId != null ? { senderFrameId: sender.frameId } : {}),
        ...(typeof sender.documentId === 'string' ? { senderDocumentId: sender.documentId } : {}),
        ...(kind === 'frame' && typeof sender.url === 'string' ? { senderUrl: sender.url } : {}),
      });
    })
    .catch(e => {
      log.swallow(`router:oneshot:${msg.type}`, e);
      // Guarantee a typed response so the caller's chrome.runtime.sendMessage
      // promise resolves instead of hanging forever.
      try {
        sendResponse(requestFailed(msg, e));
      } catch { /* channel already closed */ }
    });
  return true;
}

// ── Legacy exports (used by service-worker.ts) ───────────────────

export { toggleInspect } from './handlers/inspect';
export { toggleBlueprint } from './handlers/layout';
