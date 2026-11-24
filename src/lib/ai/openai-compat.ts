/**
 * OpenAI-compatible chat-completions dialect — one implementation, three
 * providers (OpenAI, DeepSeek, Grok). They share the wire format:
 *
 *   POST {baseUrl}/chat/completions   Authorization: Bearer <key>
 *   body: { model, stream, messages:[{role:'system'...},{role:'user'...}] }
 *   SSE:  `data: {json}` lines, text at choices[0].delta.content, `data: [DONE]`
 *
 * `listModels` hits `GET {baseUrl}/models` to populate the model picker.
 *
 * Requests retry temporary failures (http.ts). Prompt caching is automatic on
 * these providers (no markers); cached tokens are read from usage. A turn cut
 * off at the output limit never runs its last tool call, and a refusal or a
 * content filter stop surfaces as a ProviderError.
 */

export interface OpenAiEndpoint {
  /** Names used in error sentences. */
  errorContext?: ProviderErrorContext;
  retryPolicy?: RetryPolicy;
  onRetry?: () => void;
}

function contextFor(opts: OpenAiEndpoint & { baseUrl: string; model?: string }): ProviderErrorContext {
  if (opts.errorContext) return opts.errorContext;
  let host = opts.baseUrl;
  try { host = new URL(opts.baseUrl).host; } catch { /* keep the raw address */ }
  return { provider: host, model: opts.model, host };
}

function refusal(ctx: ProviderErrorContext, detail?: string): ProviderError {
  return new ProviderError('refusal', providerErrorSentence('refusal', ctx), { detail });
}

import { readSse } from './sse';
import { fetchProvider, type RetryPolicy } from './http';
import { ProviderError, providerErrorFromStream, providerErrorSentence, type ProviderErrorContext } from './provider-errors';
import type { ToolCall } from './tools';
import type { toOpenAiTools } from './tool-contracts';
import type { AiMaxTokensParam, AiProviderTiming, AiTokenUsage } from './types';

export interface OpenAiStreamOpts extends OpenAiEndpoint {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  maxTokensParam?: AiMaxTokensParam;
  apiKey: string;
  system: string;
  user: string;
  signal?: AbortSignal;
  onChunk: (delta: string) => void;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  /** The concrete model that served the request. Routers such as OpenRouter
   * may return a different id from the model requested by the client. */
  model?: string;
  choices?: Array<{
    delta?: { content?: string; refusal?: string | null; tool_calls?: OpenAiToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; type?: string; code?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

const EMPTY_USAGE = (): AiTokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

function requestsStreamingUsage(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'openrouter.ai' || host === 'api.openai.com';
  } catch {
    return false;
  }
}

function captureUsage(target: AiTokenUsage, parsed: OpenAiChunk): void {
  const usage = parsed.usage;
  if (!usage) return;
  const providerInput = (usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0);
  target.inputTokens = usage.prompt_tokens ?? (providerInput || target.inputTokens);
  target.cachedInputTokens = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? target.cachedInputTokens;
  target.outputTokens = usage.completion_tokens ?? target.outputTokens;
  target.reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? target.reasoningTokens;
}

export async function streamOpenAiCompat(opts: OpenAiStreamOpts): Promise<{ text: string; usage: AiTokenUsage; resolvedModel?: string; finishReason: string | null }> {
  const url = `${opts.baseUrl}/chat/completions`;
  const ctx = contextFor(opts);
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  const response = await fetchProvider(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      ...(requestsStreamingUsage(opts.baseUrl) ? { stream_options: { include_usage: true } } : {}),
      messages,
      ...outputLimit(opts.maxTokens, opts.maxTokensParam),
    }),
  }, { ctx, signal: opts.signal, policy: opts.retryPolicy, onRetry: opts.onRetry });

  let text = '';
  let resolvedModel: string | undefined;
  let finishReason: string | null = null;
  let refused = '';
  const usage = EMPTY_USAGE();
  await readSse(response, (frame) => {
    if (!frame.data || frame.data === '[DONE]') return;
    const parsed = safeParse(frame.data);
    if (!parsed) return;
    resolvedModel ??= parsed.model;
    if (parsed.error?.message) throw providerErrorFromStream(parsed.error.type ?? parsed.error.code ?? '', parsed.error.message, ctx);
    captureUsage(usage, parsed);
    const choice = parsed.choices?.[0];
    if (choice?.delta?.refusal) refused += choice.delta.refusal;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (delta) { text += delta; opts.onChunk(delta); }
  });
  if (refused || finishReason === 'content_filter') throw refusal(ctx, refused || 'content_filter');
  return { text, usage, finishReason, ...(resolvedModel ? { resolvedModel } : {}) };
}

// ── Tool-aware turn (chat orchestrator) ──────────────────────────

/** An OpenAI message we send back on a tool turn. `tool` role carries a
 *  single tool result keyed by tool_call_id. */
export type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAiTurnOpts extends OpenAiEndpoint {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  maxTokensParam?: AiMaxTokensParam;
  apiKey: string;
  messages: OpenAiMessage[];
  /** Omit / empty to force a tools-off final answer. */
  tools?: ReturnType<typeof toOpenAiTools>;
  /** Force the single evidence follow-up selected by the orchestrator. */
  forceTool?: string;
  /** Require one of the supplied terminal tools while leaving the semantic
   * choice to the model. Mutually exclusive with forceTool. */
  requireTool?: boolean;
  signal?: AbortSignal;
  onText: (delta: string) => void;
}

export interface OpenAiTurnResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  /** The assistant message to append for the next turn. */
  assistantMessage: OpenAiMessage;
  usage: AiTokenUsage;
  timing: AiProviderTiming;
  /** Concrete provider response model, when the wire protocol reports it. */
  resolvedModel?: string;
}

interface ToolCallAcc { id: string; name: string; args: string; }

function outputLimit(maxTokens?: number, param: AiMaxTokensParam = 'max_completion_tokens'): Partial<Record<AiMaxTokensParam, number>> {
  return maxTokens ? { [param]: maxTokens } : {};
}

/** Run ONE OpenAI-compatible turn with optional tools. Streams text via
 *  onText and accumulates streamed `delta.tool_calls` (by index) into parsed
 *  ToolCalls. Returns the finish reason + the assistant message to replay. */
export async function streamOpenAiTurn(opts: OpenAiTurnOpts): Promise<OpenAiTurnResult> {
  const url = `${opts.baseUrl}/chat/completions`;
  const ctx = contextFor(opts);
  const useTools = opts.tools && opts.tools.length > 0;
  const forced = !!opts.forceTool || !!opts.requireTool;
  const requestStarted = Date.now();
  const response = await fetchProvider(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      ...(requestsStreamingUsage(opts.baseUrl) ? { stream_options: { include_usage: true } } : {}),
      messages: opts.messages,
      ...outputLimit(opts.maxTokens, opts.maxTokensParam),
      ...(useTools ? {
        tools: opts.tools,
        // Discovery turns may ask for several read-only tools at once (the
        // provider default); a terminal choice is exactly one call.
        ...(forced ? { parallel_tool_calls: false } : {}),
        ...(opts.forceTool
          ? { tool_choice: { type: 'function', function: { name: opts.forceTool } } }
          : opts.requireTool ? { tool_choice: 'required' } : {}),
      } : {}),
    }),
  }, { ctx, signal: opts.signal, policy: opts.retryPolicy, onRetry: opts.onRetry });

  const timing: AiProviderTiming = { firstByteMs: Date.now() - requestStarted };

  let text = '';
  let finishReason: string | null = null;
  let resolvedModel: string | undefined;
  let refused = '';
  const calls = new Map<number, ToolCallAcc>();
  const usage = EMPTY_USAGE();

  await readSse(response, (frame) => {
    if (!frame.data || frame.data === '[DONE]') return;
    const parsed = safeParse(frame.data);
    if (!parsed) return;
    resolvedModel ??= parsed.model;
    if (parsed.error?.message) throw providerErrorFromStream(parsed.error.type ?? parsed.error.code ?? '', parsed.error.message, ctx);
    captureUsage(usage, parsed);
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.delta?.refusal) refused += choice.delta.refusal;
    if (timing.firstOutputMs === undefined
        && (choice.delta?.content || (choice.delta?.tool_calls?.length ?? 0) > 0)) {
      timing.firstOutputMs = Date.now() - requestStarted;
    }
    if (choice.delta?.content) { text += choice.delta.content; opts.onText(choice.delta.content); }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const acc = calls.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name = tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
      calls.set(idx, acc);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  });

  if (refused || finishReason === 'content_filter') throw refusal(ctx, refused || 'content_filter');

  const toolCalls: ToolCall[] = [];
  const rawCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  // `length`: cut off at the output limit, possibly inside a tool call's
  // arguments. Never run those; the orchestrator retries the turn.
  if (finishReason !== 'length') for (const idx of [...calls.keys()].sort((a, b) => a - b)) {
    const acc = calls.get(idx)!;
    const id = acc.id || `call_${idx}`;
    toolCalls.push({ id, name: acc.name, input: parseToolArgs(acc.args) });
    rawCalls.push({ id, type: 'function', function: { name: acc.name, arguments: acc.args || '{}' } });
  }

  const assistantMessage: OpenAiMessage = rawCalls.length
    ? { role: 'assistant', content: text || null, tool_calls: rawCalls }
    : { role: 'assistant', content: text };

  return {
    text,
    toolCalls,
    finishReason,
    assistantMessage,
    usage,
    timing,
    ...(resolvedModel ? { resolvedModel } : {}),
  };
}

function parseToolArgs(args: string): Record<string, unknown> {
  const trimmed = args.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

interface ModelsResponse {
  data?: Array<{ id?: string }>;
  error?: { message?: string };
}

/** List available model ids. Costs no tokens and proves the key. */
export async function listModels(baseUrl: string, apiKey: string, signal?: AbortSignal, endpoint: OpenAiEndpoint = {}): Promise<string[]> {
  const ctx = contextFor({ ...endpoint, baseUrl });
  const response = await fetchProvider(`${baseUrl}/models`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  }, { ctx, signal, policy: endpoint.retryPolicy });
  const json = (await response.json()) as ModelsResponse;
  if (json.error?.message) throw providerErrorFromStream('', json.error.message, ctx);
  return (json.data ?? [])
    .map(m => m.id)
    .filter((id): id is string => !!id)
    .sort();
}

function safeParse(data: string): OpenAiChunk | null {
  try { return JSON.parse(data) as OpenAiChunk; } catch { return null; }
}
