/**
 * AI coding-assistant handlers.
 *
 * Config CRUD (get/save/remove), the connection test, and model listing are
 * one-shot request/response. A completion (AI_REQUEST) is fire-and-forget: the
 * reply streams back as AI_CHUNK / AI_DONE / AI_ERROR broadcasts keyed by
 * requestId (the same broadcast primitive Code Search uses), and AI_CANCEL
 * aborts an in-flight request.
 *
 * API keys live ONLY in the service worker: one per provider, stored AES-GCM
 * encrypted in settings.ai.keys[provider].apiKeyEnc, decrypted here on the way
 * to a provider request, never sent to a UI surface (pages see 'set').
 */

import { register } from '../handler-registry';
import { ctxOf, getCtx, type SwContext } from '../sw-context';
import type { AiSettings, InspectorMessage, ObjectReference } from '../types';
import type { AiProviderId } from '../ai/types';
import { updateSettings } from '../settings';
import { encrypt, decrypt } from '../crypto';
import { sendFireForget } from '../messaging';
import {
  listModels,
  providerCheckFailure,
  providerErrorContext,
  streamChat,
  streamCompletion,
  testConnection,
  type ProviderCheck,
} from '../ai/client';
import { providerErrorSentence } from '../ai/provider-errors';
import { buildChatSystem } from '../ai/sidebar-prompt';
import { executeAiTool } from './ai-tools';
import { buildWorkspacePrimer } from './ai-primer';
import { openExtendedWindow } from '../editor';
import {
  activeKeyEnc,
  hasActiveKey,
  parseCustomProviderJson,
  pickDefaultModel,
  providerLabel,
  redactAiSettings,
  PROVIDERS,
  resolveProvider,
  webAccessEnabled,
  type BuiltinProviderId,
} from '../ai/providers';
import { errorMessage, log } from '../logger';
import { userScript } from '../script-kinds';
import { reconcileProfileOrigins } from '../site-access';
import { ChangeTicketLifecycle, type ChangePreviewScope, type ChangeTicketTargetContext } from '../ai/change-ticket';
import type { ToolResult } from '../ai/tools';
import { toolFailure, toolSuccess } from '../ai/tool-results';
import type { BmpClient } from '../bmp-client';
import { openPanelOnTab } from '../companion-tabs';
import {
  editorContextForTab,
  isCurrentEditorContext,
  storeEditorContext,
} from '../ai/editor-context';

/** In-flight completions, keyed by requestId — AI_CANCEL aborts them. */
const inflight = new Map<string, AbortController>();
export const AI_CHAT_DEADLINE_MS = 45_000;
export const AI_CHAT_WEB_DEADLINE_MS = 90_000;

const CHANGE_PREVIEW_TTL_MS = 10 * 60_000;
/** Capabilities deliberately live only in SW memory. An MV3 restart
 * invalidates them, forcing a fresh Preview before any Run. */
const changePreviews = new ChangeTicketLifecycle(CHANGE_PREVIEW_TTL_MS);

function changePreviewScope(client: BmpClient | null, ctx: SwContext): ChangePreviewScope | null {
  if (!client?.commandUser) return null;
  return {
    profileId: ctx.settings.activeProfileId,
    serverUrl: client.serverUrl,
    actor: client.commandUser,
  };
}

function ecResultText(result: { log?: string; error?: string }, fallback: string): string {
  return result.error ?? result.log ?? fallback;
}

function previewFailure(code: string, message: string): ToolResult {
  const line = message.match(/\bline\s+(\d+)\b/i)?.[1];
  return {
    content: message,
    isError: true,
    structuredContent: toolFailure('preview_ec', message, {
      ...(code ? { attemptedCode: code } : {}),
      ...(line ? { line: Number(line) } : {}),
    }),
  };
}

function previewSuccess(content: string): ToolResult {
  const log = content.slice(0, 7_000);
  return {
    content,
    isError: false,
    structuredContent: toolSuccess('preview_ec', {
      ok: true,
      log,
      hasWarning: false,
      complete: log.length === content.length,
    }),
  };
}

/** One implementation for both generation-time validation and the card's
 * explicit Preview action. Successful final-change Preview issues the same
 * exact-code, environment-bound capability consumed by Run. */
async function previewChangeCode(
  code: string,
  expectedTarget: ChangeTicketTargetContext | undefined,
  signal: AbortSignal | undefined,
  ctx: SwContext,
): Promise<ToolResult & { previewId?: string }> {
  const clientAtStart = ctx.client;
  if (!clientAtStart) return previewFailure(code, 'Not connected to BMP');
  const profileAtStart = ctx.settings.activeProfileId;
  const serverAtStart = clientAtStart.serverUrl;
  const trimmed = code.trim();
  if (!trimmed) return previewFailure('', 'The proposal contains no Extended Code.');
  try {
    const result = signal
      ? await clientAtStart.executeEc(userScript(trimmed), undefined, false, signal)
      : await clientAtStart.executeEc(userScript(trimmed), undefined, false);
    if (!result.ok || result.hasWarning) {
      return previewFailure(trimmed, result.hasWarning
        ? `Preview returned a warning: ${ecResultText(result, 'Review the code before running.')}`
        : ecResultText(result, 'Preview failed.'));
    }
    const current = ctx;
    if (current.client !== clientAtStart
      || current.settings.activeProfileId !== profileAtStart
      || clientAtStart.serverUrl !== serverAtStart) {
      return previewFailure(trimmed, 'The BMP connection changed during Preview. Preview again.');
    }
    const scope = changePreviewScope(clientAtStart, ctx);
    if (!scope) {
      return previewFailure(trimmed, 'The command identity could not be verified. Reconnect and Preview again.');
    }
    const content = ecResultText(result, 'Preview successful');
    return {
      ...previewSuccess(content),
      previewId: changePreviews.issue(trimmed, scope, content, expectedTarget),
    };
  } catch (error) {
    return previewFailure(trimmed, errorMessage(error));
  }
}

function aiConfig(): AiSettings | undefined {
  return getCtx().settings.ai;
}

/** What config messages carry to pages: never a key, only 'set' markers. */
function aiPayload(ai: AiSettings | undefined) {
  return {
    configured: hasActiveKey(ai),
    ...(ai ? { provider: ai.provider, model: ai.model, ai: redactAiSettings(ai) } : {}),
    ...(ai?.customProvider ? { customProvider: ai.customProvider } : {}),
  };
}

function broadcastAiConfig(ai: AiSettings | undefined): void {
  // Open editor / studio surfaces show or hide the assistant live.
  sendFireForget({ type: 'AI_CONFIG_CHANGED', ...aiPayload(ai) });
}

/** Store a changed AI configuration and keep the provider grants in step. */
async function storeAi(ctx: SwContext, change: (ai: AiSettings | undefined) => AiSettings): Promise<AiSettings> {
  let next: AiSettings | undefined;
  const saved = await updateSettings(current => {
    next = change(current.ai);
    return { ...current, ai: next };
  });
  if (!saved.ok) throw new Error(saved.error);
  await reconcileProfileOrigins(ctx.settings.profiles.map(p => p.bmpUrl), ctx.settings.ai);
  return ctx.settings.ai ?? next!;
}

function emptyAi(provider: AiProviderId = 'anthropic'): AiSettings {
  return { provider, model: provider === 'custom' ? '' : PROVIDERS[provider].defaultModel, keys: {} };
}

/** Decrypt the stored key of one provider, or '' when it has none. */
async function storedKey(ai: AiSettings | undefined, provider: AiProviderId): Promise<string> {
  const enc = ai?.keys?.[provider]?.apiKeyEnc;
  return enc ? decrypt(enc) : '';
}

/** The provider origin must be granted before the worker can call it; the
 *  panel asks for it in the user's click. Unknown (tests, no API): allowed. */
async function originGranted(origin: string): Promise<boolean> {
  try {
    if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return true;
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return true;
  }
}

function permissionFailure(provider: BuiltinProviderId): ProviderCheck {
  const meta = PROVIDERS[provider];
  const kind = 'permission' as const;
  return { ok: false, kind, error: providerErrorSentence(kind, providerErrorContext(meta, '')) };
}

register('AI_GET_CONFIG', (_msg, respond) => {
  const ai = aiConfig();
  respond({ type: 'AI_CONFIG_DATA', configured: hasActiveKey(ai), provider: ai?.provider, model: ai?.model, customProvider: ai?.customProvider });
});

/** Make a built-in provider (or the custom one) active with a model. A key in
 *  the message is stored for that provider only; other providers' keys stay. */
register('AI_SAVE_CONFIG', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  try {
    const prev = ctx.settings.ai;
    if (msg.provider === 'custom' && !prev?.customProvider) throw new Error('Import custom provider JSON first');
    const apiKeyEnc = msg.apiKey?.trim() ? await encrypt(msg.apiKey.trim()) : prev?.keys?.[msg.provider]?.apiKeyEnc ?? '';
    if (!apiKeyEnc) throw new Error(`Paste the API key for ${providerLabel(msg.provider, prev?.customProvider)} first.`);
    const candidate: AiSettings = { ...(prev ?? emptyAi(msg.provider)), provider: msg.provider, model: msg.model };
    resolveProvider(candidate); // validate provider/model before persisting
    const ai = await storeAi(ctx, current => {
      const base = current ?? emptyAi(msg.provider);
      const entry = base.keys[msg.provider];
      // A new key or another model invalidates the previous check.
      const keepTest = !msg.apiKey && entry?.lastTest?.model === msg.model;
      return {
        ...base,
        provider: msg.provider,
        model: msg.model,
        keys: {
          ...base.keys,
          [msg.provider]: { apiKeyEnc, model: msg.model, ...(keepTest && entry?.lastTest ? { lastTest: entry.lastTest } : {}) },
        },
      };
    });
    respond({ type: 'AI_CONFIG_SAVED', ok: true, ...aiPayload(ai) });
    broadcastAiConfig(ai);
  } catch (e) {
    respond({ type: 'AI_CONFIG_SAVED', ok: false, ...aiPayload(aiConfig()), error: errorMessage(e) });
  }
});

/** The setup check: list the provider's models with the key (proves the key,
 *  costs no tokens), preselect a model, then send one tiny generation with it
 *  (proves credit and model access). A key that lists models is stored for
 *  its provider and the provider becomes active. */
register('AI_CHECK_KEY', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const provider = msg.provider;
  const reply = (check: ProviderCheck & { models?: string[]; model?: string; ms?: number }, ai?: AiSettings) => respond({
    ...(ai ? aiPayload(ai) : {}),
    type: 'AI_KEY_CHECKED',
    provider,
    ok: check.ok,
    ...(check.models ? { models: check.models } : {}),
    ...(check.model ? { model: check.model } : {}),
    ...(check.ms !== undefined ? { ms: check.ms } : {}),
    ...(check.error ? { error: check.error } : {}),
    ...(check.kind ? { kind: check.kind } : {}),
    ...(check.detail ? { detail: check.detail } : {}),
  });
  try {
    const meta = PROVIDERS[provider];
    if (!meta) { reply({ ok: false, kind: 'other', error: 'Unknown provider.' }); return; }
    const prev = ctx.settings.ai;
    const pasted = msg.apiKey?.trim() ?? '';
    const key = pasted || await storedKey(prev, provider);
    if (!key) { reply({ ok: false, kind: 'auth', error: `Paste the API key for ${meta.label}.` }); return; }
    if (!await originGranted(meta.origin)) { reply(permissionFailure(provider)); return; }
    const probe: AiSettings = { provider, model: msg.model ?? meta.defaultModel, keys: {} };
    let models: string[];
    try {
      models = await listModels(probe, key);
    } catch (e) {
      reply(providerCheckFailure(e));
      return;
    }
    const model = msg.model?.trim() || pickDefaultModel(provider, models, prev?.keys?.[provider]?.model);
    const started = Date.now();
    const test = await testConnection({ ...probe, model }, key);
    const ms = Date.now() - started;
    const lastTest = { ok: test.ok, ms, at: Date.now(), model };
    const apiKeyEnc = pasted ? await encrypt(pasted) : prev?.keys?.[provider]?.apiKeyEnc ?? '';
    const ai = await storeAi(ctx, current => {
      const base = current ?? emptyAi(provider);
      return {
        ...base,
        provider,
        model,
        keys: { ...base.keys, [provider]: { apiKeyEnc, model, lastTest } },
      };
    });
    reply({ ...test, models, model, ms }, ai);
    broadcastAiConfig(ai);
    ctx.logActivity(test.ok ? 'info' : 'warn', `AI key check (${meta.label}, ${model})`, test.ok ? `${ms} ms` : test.detail ?? test.error);
  } catch (e) {
    reply({ ok: false, kind: 'other', error: errorMessage(e) });
  }
});

register('AI_SAVE_CUSTOM_PROVIDER', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  try {
    const parsed = parseCustomProviderJson(msg.json);
    const prev = ctx.settings.ai;
    const apiKeyEnc = parsed.apiKey ? await encrypt(parsed.apiKey) : prev?.keys?.custom?.apiKeyEnc ?? '';
    if (!apiKeyEnc) throw new Error('apiKey is required when adding a custom provider');
    const model = parsed.provider.models.find(item => item.toolCalling)?.id ?? parsed.provider.models[0].id;
    resolveProvider({ provider: 'custom', model, customProvider: parsed.provider });
    const ai = await storeAi(ctx, current => {
      const base = current ?? emptyAi('custom');
      return {
        ...base,
        provider: 'custom',
        model,
        customProvider: parsed.provider,
        keys: { ...base.keys, custom: { apiKeyEnc, model } },
      };
    });
    respond({ type: 'AI_CONFIG_SAVED', ok: true, ...aiPayload(ai) });
    broadcastAiConfig(ai);
  } catch (e) {
    respond({ type: 'AI_CONFIG_SAVED', ok: false, ...aiPayload(aiConfig()), error: errorMessage(e) });
  }
});

/** Remove one provider's key. Nothing else changes; when it was the active
 *  provider the assistant disappears until another key is chosen. */
register('AI_REMOVE_KEY', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  try {
    const ai = await storeAi(ctx, current => {
      const base = current ?? emptyAi();
      const { [msg.provider]: _removed, ...keys } = base.keys;
      return { ...base, keys };
    });
    respond({ type: 'AI_CONFIG_SAVED', ok: true, ...aiPayload(ai) });
    broadcastAiConfig(ai);
  } catch (e) {
    respond({ type: 'AI_CONFIG_SAVED', ok: false, ...aiPayload(aiConfig()), error: errorMessage(e) });
  }
});

register('AI_SET_WEB_ACCESS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  try {
    const ai = await storeAi(ctx, current => ({ ...(current ?? emptyAi()), webAccess: msg.on }));
    respond({ type: 'AI_CONFIG_SAVED', ok: true, ...aiPayload(ai) });
    broadcastAiConfig(ai);
  } catch (e) {
    respond({ type: 'AI_CONFIG_SAVED', ok: false, ...aiPayload(aiConfig()), error: errorMessage(e) });
  }
});

register('AI_TEST', async (_msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const ai = aiConfig();
  if (!ai || !hasActiveKey(ai)) { respond({ type: 'AI_TEST_RESULT', ok: false, error: 'No API key configured' }); return; }
  try {
    const providerMeta = resolveProvider(ai);
    if (!await originGranted(providerMeta.origin)) {
      const kind = 'permission' as const;
      respond({ type: 'AI_TEST_RESULT', ok: false, model: ai.model, kind, error: providerErrorSentence(kind, providerErrorContext(providerMeta, ai.model)) });
      return;
    }
    const key = await storedKey(ai, ai.provider);
    const started = Date.now();
    const res = await testConnection(ai, key);
    const ms = Date.now() - started;
    // Persist the outcome (key-free) so the Connect tab's AI card can render
    // the result after a reload. Survives in the session snapshot.
    try {
      await storeAi(ctx, current => {
        const base = current ?? ai;
        const entry = base.keys[ai.provider];
        if (!entry) return base;
        return { ...base, keys: { ...base.keys, [ai.provider]: { ...entry, lastTest: { ok: res.ok, ms, at: Date.now(), model: ai.model } } } };
      });
    } catch (e) {
      log.warn('handler:aiTest', errorMessage(e));
    }
    respond({ type: 'AI_TEST_RESULT', ok: res.ok, model: ai.model, ms, ...(res.error ? { error: res.error } : {}), ...(res.kind ? { kind: res.kind } : {}) });
  } catch (e) {
    respond({ type: 'AI_TEST_RESULT', ok: false, error: errorMessage(e) });
  }
});

/** Live model list for one provider with its stored key. */
register('AI_LIST_MODELS', async (msg, respond) => {
  const ai = aiConfig();
  const provider = msg.provider;
  if (!ai?.keys?.[provider]?.apiKeyEnc) { respond({ type: 'AI_MODELS_RESULT', ok: false, provider, error: 'No API key configured' }); return; }
  let providerMeta;
  try { providerMeta = resolveProvider({ ...ai, provider, model: ai.keys[provider]?.model ?? ai.model }); }
  catch (e) { respond({ type: 'AI_MODELS_RESULT', ok: false, provider, error: errorMessage(e) }); return; }
  if (provider === 'custom') {
    respond({ type: 'AI_MODELS_RESULT', ok: true, provider, models: providerMeta.suggestedModels });
    return;
  }
  if (!await originGranted(providerMeta.origin)) {
    const failure = permissionFailure(provider);
    respond({ type: 'AI_MODELS_RESULT', ok: false, provider, error: failure.error, kind: failure.kind });
    return;
  }
  try {
    const key = await storedKey(ai, provider);
    const models = await listModels({ provider, model: ai.keys[provider]?.model ?? providerMeta.defaultModel, keys: {} }, key);
    respond({ type: 'AI_MODELS_RESULT', ok: true, provider, models, model: pickDefaultModel(provider, models, ai.keys[provider]?.model) });
  } catch (e) {
    const failure = providerCheckFailure(e);
    respond({ type: 'AI_MODELS_RESULT', ok: false, provider, ...(failure.error ? { error: failure.error } : {}), ...(failure.kind ? { kind: failure.kind } : {}) });
  }
});

register('AI_REQUEST', async (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  const { payload } = msg;
  const rid = payload.requestId;
  const broadcast = (m: InspectorMessage) => sendFireForget(m);

  const ai = ctx.settings.ai;
  if (!ai || !hasActiveKey(ai)) { broadcast({ type: 'AI_ERROR', requestId: rid, message: 'No API key configured' }); return; }

  const controller = new AbortController();
  inflight.set(rid, controller);
  try {
    const key = await decrypt(activeKeyEnc(ai));
    await streamCompletion({
      settings: ai,
      apiKey: key,
      payload,
      signal: controller.signal,
      onChunk: (delta) => broadcast({ type: 'AI_CHUNK', requestId: rid, delta }),
    });
    broadcast({ type: 'AI_DONE', requestId: rid });
    ctx.logActivity('info', `AI ${payload.intent} (${ai.model})`);
  } catch (e) {
    // A caller-initiated abort is not an error — the UI already reset.
    if (controller.signal.aborted) {
      log.debug('handler:ai', `AI request ${rid} aborted`);
    } else {
      broadcast({ type: 'AI_ERROR', requestId: rid, message: errorMessage(e) });
      ctx.logActivity('warn', `AI ${payload.intent} failed`, errorMessage(e));
    }
  } finally {
    inflight.delete(rid);
  }
});

register('AI_CANCEL', (msg, _respond, meta) => {
  const controller = inflight.get(msg.requestId);
  if (controller) { controller.abort(); inflight.delete(msg.requestId); }
});

// ── Chat (tool-using conversation) ───────────────────────────────

const PRIMER_SUCCESS_TTL_MS = 10 * 60_000;
const PRIMER_FAILURE_TTL_MS = 30_000;
interface CachedPrimer { value: string | null; expiresAt: number }
/** Cache by complete live environment identity, not only editable profile id. */
const primerByServer = new Map<string, CachedPrimer>();
const primerInflightByServer = new Map<string, Promise<string | null>>();

/** Get (and lazily build + cache) the workspace primer for a server. Degrades
 *  to null on any failure. Cheap after the first turn (one Map lookup). */
async function workspacePrimerFor(serverId: string, signal: AbortSignal | undefined, ctx: SwContext): Promise<string | null> {
  const cached = primerByServer.get(serverId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) primerByServer.delete(serverId);
  const pending = primerInflightByServer.get(serverId);
  if (pending) return pending;
  if (!ctx.client) return null;
  const request = buildWorkspacePrimer(ctx.client, signal).then(primer => {
    primerByServer.set(serverId, {
      value: primer,
      expiresAt: Date.now() + (primer ? PRIMER_SUCCESS_TTL_MS : PRIMER_FAILURE_TTL_MS),
    });
    return primer;
  });
  primerInflightByServer.set(serverId, request);
  try {
    return await request;
  } finally {
    if (primerInflightByServer.get(serverId) === request) primerInflightByServer.delete(serverId);
  }
}

register('AI_CHAT_SEND', async (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  const rid = msg.requestId;
  const emit = (event: import('../ai/types').AiChatEvent) =>
    sendFireForget({ type: 'AI_CHAT_EVENT', requestId: rid, event });

  const ai = ctx.settings.ai;
  if (!ai || !hasActiveKey(ai)) { emit({ kind: 'error', message: 'No API key configured' }); return; }

  const controller = new AbortController();
  // Web search and page reads run inside the provider request, so a turn with
  // web access gets a longer deadline.
  const deadlineMs = webAccessEnabled(ai) ? AI_CHAT_WEB_DEADLINE_MS : AI_CHAT_DEADLINE_MS;
  const timeoutReason = new DOMException(
    `The AI request exceeded ${Math.round(deadlineMs / 1000)} seconds and was stopped. Nothing was executed.`,
    'TimeoutError',
  );
  const deadline = setTimeout(() => controller.abort(timeoutReason), deadlineMs);
  let streamStarted = false;
  inflight.set(rid, controller);
  try {
    const key = await decrypt(activeKeyEnc(ai));
    const primerEnvironment = [
      msg.envelope.server.id,
      ctx.client?.serverUrl ?? msg.envelope.server.url,
      ctx.client?.username ?? '',
    ].join('\u0000');
    const basePrompt = buildChatSystem(msg.envelope);
    const knownObjects = new Map<string, ObjectReference>(
      msg.envelope.sources.map(source => [source.object.rid, source.object]),
    );
    streamStarted = true;
    const metrics = await streamChat({
      settings: ai,
      apiKey: key,
      system: basePrompt.system,
      context: basePrompt.context,
      loadFullPrompt: async () => {
        const primer = await workspacePrimerFor(primerEnvironment, controller.signal, ctx);
        const prompt = buildChatSystem(msg.envelope, primer);
        return { system: prompt.system, context: prompt.context };
      },
      history: msg.history,
      text: msg.text,
      pageRid: msg.envelope.page?.rid,
      onEvent: emit,
      executeTool: async (call, signal) => {
        const result = await executeAiTool(call, signal, msg.envelope, ctx);
        result.objects?.forEach(object => knownObjects.set(object.rid, object));
        return result;
      },
      executeChangePreview: ({ code, targetRid }, signal) => {
        const target = targetRid ? knownObjects.get(targetRid) : undefined;
        return previewChangeCode(code, targetRid ? {
          rid: targetRid,
          ...(target?.businessId ? { businessId: target.businessId } : {}),
        } : undefined, signal, ctx);
      },
      signal: controller.signal,
    });
    const failed = metrics.terminalOutcome === 'timeout' || metrics.terminalOutcome === 'error';
    ctx.logActivity(
      failed || metrics.toolErrors ? 'warn' : 'info',
      `AI chat (${ai.model})`,
      JSON.stringify(metrics),
      { category: 'system', action: 'ai-eval-trace', durationMs: metrics.durationMs },
    );
  } catch (e) {
    // streamChat handles its own done/error events; this guards decrypt /
    // prompt-build failures before the stream starts.
    if (!controller.signal.aborted) emit({ kind: 'error', message: errorMessage(e) });
    else if (!streamStarted && controller.signal.reason === timeoutReason) {
      emit({ kind: 'error', message: timeoutReason.message });
    }
  } finally {
    clearTimeout(deadline);
    inflight.delete(rid);
  }
});

register('AI_CHAT_CANCEL', (msg, _respond, meta) => {
  const controller = inflight.get(msg.requestId);
  if (controller) { controller.abort(); inflight.delete(msg.requestId); }
});

register('AI_PREVIEW_CODE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  if (!ctx.client) { respond({ type: 'AI_PREVIEW_RESULT', requestId: msg.requestId, purpose: 'verification', ok: false, resultText: 'Not connected to BMP' }); return; }
  try {
    const res = await ctx.client.executeEc(userScript(msg.code), undefined, false);
    respond({
      type: 'AI_PREVIEW_RESULT',
      requestId: msg.requestId,
      purpose: 'verification',
      ok: res.ok && !res.hasWarning,
      resultText: res.hasWarning
        ? `Preview returned a warning: ${res.log ?? res.error ?? 'Review the code.'}`
        : res.ok ? (res.log ?? '(no output)') : (res.error ?? res.log ?? 'EC error'),
    });
  } catch (e) {
    respond({ type: 'AI_PREVIEW_RESULT', requestId: msg.requestId, purpose: 'verification', ok: false, resultText: errorMessage(e) });
  }
});

register('AI_PREVIEW_CHANGE', async (msg, respond, meta) => {
  const reply = (
    ok: boolean,
    resultText: string,
    previewId?: string,
    runnable = false,
  ) => respond({
    type: 'AI_PREVIEW_CHANGE_RESULT',
    requestId: msg.requestId,
    purpose: 'change',
    ok,
    resultText,
    previewId,
    runnable,
  });
  const result = await previewChangeCode(msg.proposal.code, msg.expectedTarget, undefined, ctxOf(meta));
  reply(!result.isError, result.content, result.previewId, !result.isError && !!result.previewId);
});

register('AI_RUN_CHANGE', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const reply = (ok: boolean, resultText: string, partial?: boolean) => respond({
    type: 'AI_RUN_CHANGE_RESULT', requestId: msg.requestId, ok, resultText, ...(partial ? { partial } : {}),
  });
  const clientAtStart = ctx.client;
  if (!clientAtStart) { reply(false, 'Not connected to BMP'); return; }
  const scope = changePreviewScope(clientAtStart, ctx);
  if (!scope) { reply(false, 'Not connected to BMP'); return; }
  const preview = changePreviews.consume(msg.previewId, scope);
  if (!preview.ok && (preview.reason === 'missing' || preview.reason === 'expired')) {
    reply(false, 'Preview expired. Preview the change again before running.');
    return;
  }
  if (!preview.ok) {
    reply(false, 'The active environment changed. Preview the change again.');
    return;
  }
  try {
    const execution = await clientAtStart.executeEc(preview.code, undefined, true);
    if (!execution.ok || execution.hasWarning) {
      const detail = execution.hasWarning
        ? `Run returned a warning: ${ecResultText(execution, 'Read back the affected objects before retrying.')}`
        : ecResultText(execution, 'Run failed. Read back the affected objects before retrying.');
      ctx.logActivity('error', 'AI Change Ticket run needs review', detail, { category: 'execution', action: 'ai-change-run' });
      reply(false, detail, true);
      return;
    }
    const detail = ecResultText(execution, 'Executed successfully.');
    ctx.logActivity('success', 'AI Change Ticket executed', detail, { category: 'execution', action: 'ai-change-run' });
    reply(true, detail);
  } catch (e) {
    const detail = errorMessage(e);
    ctx.logActivity('error', 'AI Change Ticket run failed', detail, { category: 'execution', action: 'ai-change-run' });
    reply(false, detail, true);
  }
});

register('AI_APPLY_PROPOSAL', (msg, _respond, meta) => {
  // Relay to the open editor/studio surface (a separate page from the panel),
  // which shows the standard merge-diff proposal for target { rid, slot }.
  sendFireForget(msg);
});

register('AI_INSERT_AT_CURSOR', (msg, _respond, meta) => {
  // Relay to the open editor/studio surface, which inserts the code at its
  // cursor behind the standard merge-diff proposal for target { rid, slot }.
  sendFireForget(msg);
});

register('AI_OPEN_IN_EDITOR', (msg, _respond, meta) => {
  // Chat "Open in editor" (no editor chip attached): launch the Extended Code
  // editor in free-script mode preloaded with the block's code, mounted on the
  // panel window's active BMP tab (same target rule as OPEN_EXTENDED).
  //
  // Limitation (documented): if a free-script editor is ALREADY open, this
  // opens a second one — the SW cannot cheaply detect a scratch editor (it
  // broadcasts no object identity, so AI_EDITOR_CONTEXT stays null for it).
  // The attached-editor case is already covered by the code block's Apply
  // button (AI_APPLY_PROPOSAL → propose()); this action only shows when NO
  // editor chip is attached.
  openExtendedWindow(undefined, { tabId: meta.senderTabId, windowId: meta.panelWindowId }, msg.code)
    .catch(e => log.swallow('ai:openInEditor', e));
});

// ── Editor context (drives the chat tab's 'editor' chip) ─────────
// Editor frames are hosted by BMP tabs. Store their context per tab and route
// only the ACTIVE tab's value to the side panel attached to that Chrome window.
// The request/response message types are intentionally distinct: a raw
// chrome.runtime message from one editor must never update every open panel.
register('AI_EDITOR_CONTEXT_UPDATE', async (msg, _respond, meta) => {
  const tabId = meta.senderTabId;
  if (tabId == null) return;
  const generation = storeEditorContext(tabId, msg.source);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isCurrentEditorContext(tabId, generation) || !tab.active || tab.windowId == null) return;
    ctxOf(meta).sendToPanelByWindow(tab.windowId, {
      type: 'AI_EDITOR_CONTEXT',
      source: editorContextForTab(tabId),
    });
  } catch (e) {
    log.swallow('ai:editorContextUpdate', e);
  }
});

register('AI_GET_EDITOR_CONTEXT', async (_msg, respond, meta) => {
  if (meta.panelWindowId == null) {
    respond({ type: 'AI_EDITOR_CONTEXT', source: null });
    return;
  }
  try {
    const active = await chrome.tabs.query({ active: true, windowId: meta.panelWindowId });
    respond({ type: 'AI_EDITOR_CONTEXT', source: editorContextForTab(active[0]?.id) });
  } catch (e) {
    log.swallow('ai:getEditorContext', e);
    respond({ type: 'AI_EDITOR_CONTEXT', source: null });
  }
});

register('AI_CHAT_HANDOFF', (msg, _respond, meta) => {
  const ctx = ctxOf(meta);
  // Open the side panel on the sender's tab. No-op when already open; the forwarded message survives panel
  // startup via pendingPanelMessages.
  if (meta.senderTabId != null) {
    openPanelOnTab(meta.senderTabId, meta.senderUrl).catch(e => log.swallow('ai:handoff:open', e));
  }
  ctx.sendToPanel(msg);
});
