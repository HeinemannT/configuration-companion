/**
 * Anthropic Messages API dialect. Streaming only, raw fetch (the extension
 * ships no SDK).
 *
 * POST {baseUrl}/v1/messages
 *   headers: x-api-key, anthropic-version, content-type,
 *            anthropic-dangerous-direct-browser-access, [anthropic-beta]
 *   body: { model, max_tokens, stream, system:[...], tools, tool_choice,
 *           messages, [output_config], [fallbacks] }
 *
 * Current practice applied here (claude-api skill, 2026-11):
 * - No temperature / top_p / top_k and no `thinking` field. Models that think
 *   by default (Opus 5.5, Sonnet 5.5, Fable) get `max_tokens` headroom and an
 *   explicit `output_config.effort` instead.
 * - Forced `tool_choice` (`any` / `tool`) is sent only to models that accept
 *   it; the others get `auto` with the single terminal tool offered.
 * - Every streamed content block is kept verbatim (thinking with signature,
 *   server tool blocks, text with citations, fallback markers) and echoed back
 *   unchanged on the next request, as preserved thinking requires.
 * - Prompt caching: breakpoints on the last tool, the system block and the
 *   last message (3 of the 4 allowed).
 * - First-party API only: API version 2026-10-21, the server-side refusal
 *   fallback (`fallbacks: "default"`), and the web search / web fetch server
 *   tools. Custom Anthropic-compatible endpoints keep 2023-06-01 and none of
 *   the extras, because proxies may not implement them.
 */

import { anthropicModelTraits, PROVIDERS } from './providers';
import { readSse } from './sse';
import { fetchProvider, type RetryPolicy } from './http';
import { ProviderError, providerErrorFromStream, providerErrorSentence, type ProviderErrorContext } from './provider-errors';
import type { ToolCall } from './tools';
import type { toAnthropicTools } from './tool-contracts';
import type { AiProviderTiming, AiTokenUsage, AiWebSource } from './types';

export const ANTHROPIC_API_VERSION = '2026-10-21';
/** Kept for custom Anthropic-compatible endpoints. */
export const ANTHROPIC_COMPAT_API_VERSION = '2023-06-01';
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_TOKENS = 8192;
/** Output room for thinking on models that think by default; streaming keeps
 *  a large value safe from timeouts and only used tokens are billed. */
const THINKING_MIN_MAX_TOKENS = 16_000;
/** Server-tool turns the server pauses (`pause_turn`) are resumed this often. */
export const MAX_PAUSE_CONTINUATIONS = 3;

export type AnthropicEffort = 'low' | 'medium' | 'high';

export interface AnthropicEndpoint {
  /** API base URL; defaults to Anthropic for legacy/direct callers. */
  baseUrl?: string;
  /** True for api.anthropic.com (built-in provider). Custom endpoints: false. */
  firstParty?: boolean;
  /** Names used in error sentences. */
  errorContext?: ProviderErrorContext;
  retryPolicy?: RetryPolicy;
  onRetry?: () => void;
}

export interface AnthropicStreamOpts extends AnthropicEndpoint {
  model: string;
  maxTokens?: number;
  apiKey: string;
  /** Stable persona + knowledge prefix (empty string = no system block). */
  system: string;
  /** Volatile user message. */
  user: string;
  effort?: AnthropicEffort;
  signal?: AbortSignal;
  onChunk: (delta: string) => void;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  content_block?: RawBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    citation?: Record<string, unknown>;
    stop_reason?: string;
    stop_details?: { category?: string | null; explanation?: string | null } | null;
  };
  error?: { type?: string; message?: string };
  message?: { usage?: AnthropicUsage; model?: string };
  usage?: AnthropicUsage;
}

const EMPTY_USAGE = (): AiTokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

function captureUsage(target: AiTokenUsage, usage?: AnthropicUsage): void {
  if (!usage) return;
  const uncached = usage.input_tokens ?? 0;
  const cached = usage.cache_read_input_tokens ?? target.cachedInputTokens;
  const written = usage.cache_creation_input_tokens ?? target.cacheWriteTokens;
  target.cachedInputTokens = cached;
  target.cacheWriteTokens = written;
  target.inputTokens = Math.max(target.inputTokens, uncached + cached + written);
  target.outputTokens = Math.max(target.outputTokens, usage.output_tokens ?? 0);
  const server = usage.server_tool_use;
  if (server?.web_search_requests !== undefined) target.webSearchRequests = server.web_search_requests;
  if (server?.web_fetch_requests !== undefined) target.webFetchRequests = server.web_fetch_requests;
}

/** A content block exactly as the API returned it (thinking, server tools,
 *  citations, fallback markers, and types this client does not know yet). */
export type RawBlock = { type: string } & Record<string, unknown>;

/** Anthropic message content block we send back on a tool turn. */
export type AnthropicContentBlock =
  | { type: 'text'; text: string; citations?: unknown[] }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | RawBlock;

export type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] };

/** A 5-minute ephemeral cache breakpoint. Anthropic caps a request at 4 of
 *  these; the tool turn uses at most 3 (tools, system, turn boundary). */
const CACHE_CONTROL = { type: 'ephemeral' } as const;

type WireBlock = AnthropicContentBlock & { cache_control?: typeof CACHE_CONTROL };
type WireMessage = { role: 'user' | 'assistant'; content: string | WireBlock[] };
type ClientTool = ReturnType<typeof toAnthropicTools>[number];

/** A server tool definition (web search / web fetch). */
export type AnthropicServerTool = { type: string; name: string } & Record<string, unknown>;
type WireTool = (ClientTool | AnthropicServerTool) & { cache_control?: typeof CACHE_CONTROL };

/** The web tools for a model, as the claude-api skill documents them. The
 *  20260209 versions filter results dynamically (no separate code execution
 *  tool). Older models get the basic web search only. */
export function anthropicWebTools(model: string): AnthropicServerTool[] {
  const traits = anthropicModelTraits(model);
  const tools: AnthropicServerTool[] = [{ type: traits.webSearchTool, name: 'web_search', max_uses: 5 }];
  if (traits.webFetchTool) tools.push({ type: traits.webFetchTool, name: 'web_fetch', max_uses: 5 });
  return tools;
}

/** Put a cache breakpoint on the LAST tool definition. Tool defs serialize as
 *  one unit before system, so one breakpoint at the tail caches all of them,
 *  provided the set stays byte-stable (TOOL_DEFS is a fixed-order constant and
 *  server tools always come first). */
function withToolCacheBreakpoint(tools: Array<ClientTool | AnthropicServerTool>): WireTool[] {
  return tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: CACHE_CONTROL } : { ...t }));
}

/** Put a cache breakpoint on the last content block of the FINAL message. This
 *  moves the breakpoint forward every request so consecutive requests inside
 *  the tool loop re-read the prefix instead of falling outside the 20-block
 *  lookback window. A string content is promoted to one text block. Thinking
 *  blocks cannot carry a breakpoint, so the last other block takes it. */
function withHistoryCacheBreakpoint(messages: AnthropicMessage[]): WireMessage[] {
  if (messages.length === 0) return messages;
  const out: WireMessage[] = messages.slice();
  const last = out[out.length - 1];
  const blocks: WireBlock[] = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]
    : last.content.map(b => ({ ...b }));
  for (let i = blocks.length - 1; i >= 0; i--) {
    const type = blocks[i].type;
    if (type === 'thinking' || type === 'redacted_thinking' || type === 'fallback') continue;
    blocks[i] = { ...blocks[i], cache_control: CACHE_CONTROL };
    break;
  }
  out[out.length - 1] = { role: last.role, content: blocks };
  return out;
}

function defaultErrorContext(opts: AnthropicEndpoint & { model: string }): ProviderErrorContext {
  return opts.errorContext ?? { provider: 'Anthropic', console: 'Claude Console', model: opts.model, host: 'api.anthropic.com' };
}

function isFirstParty(opts: AnthropicEndpoint): boolean {
  if (opts.firstParty !== undefined) return opts.firstParty;
  return !opts.baseUrl || opts.baseUrl === PROVIDERS.anthropic.baseUrl;
}

function requestHeaders(apiKey: string, firstParty: boolean, betas: string[]): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': firstParty ? ANTHROPIC_API_VERSION : ANTHROPIC_COMPAT_API_VERSION,
    'content-type': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}),
  };
}

/** Body fields that depend on the model: output room, effort, fallback. */
function modelFields(model: string, maxTokens: number, firstParty: boolean, effort?: AnthropicEffort): { fields: Record<string, unknown>; betas: string[] } {
  const traits = anthropicModelTraits(model);
  const fields: Record<string, unknown> = {
    max_tokens: traits.thinksByDefault ? Math.max(maxTokens, THINKING_MIN_MAX_TOKENS) : maxTokens,
  };
  if (effort && traits.effort) fields.output_config = { effort };
  const betas: string[] = [];
  if (firstParty && traits.fallbacks) {
    fields.fallbacks = 'default';
    betas.push(ANTHROPIC_FALLBACK_BETA);
  }
  return { fields, betas };
}

function refusalError(ctx: ProviderErrorContext, details?: { category?: string | null; explanation?: string | null } | null): ProviderError {
  const detail = [details?.category, details?.explanation].filter(Boolean).join(': ') || undefined;
  return new ProviderError('refusal', providerErrorSentence('refusal', ctx), { detail });
}

function streamFailure(frame: { data: string }, ctx: ProviderErrorContext): ProviderError {
  const parsed = safeParse(frame.data);
  return providerErrorFromStream(parsed?.error?.type ?? '', parsed?.error?.message ?? 'Anthropic streaming error', ctx);
}

export interface AnthropicOneShotResult {
  text: string;
  usage: AiTokenUsage;
  stopReason: string | null;
}

export async function streamAnthropic(opts: AnthropicStreamOpts): Promise<AnthropicOneShotResult> {
  const url = `${opts.baseUrl ?? PROVIDERS.anthropic.baseUrl}/v1/messages`;
  const firstParty = isFirstParty(opts);
  const ctx = defaultErrorContext(opts);
  const system = opts.system
    ? [{ type: 'text', text: opts.system, cache_control: CACHE_CONTROL }]
    : undefined;
  const { fields, betas } = modelFields(opts.model, opts.maxTokens ?? MAX_TOKENS, firstParty, opts.effort);
  const body = {
    model: opts.model,
    ...fields,
    stream: true,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: opts.user }],
  };

  const response = await fetchProvider(url, {
    method: 'POST',
    headers: requestHeaders(opts.apiKey, firstParty, betas),
    body: JSON.stringify(body),
  }, { ctx, signal: opts.signal, policy: opts.retryPolicy, onRetry: opts.onRetry });

  let text = '';
  let stopReason: string | null = null;
  let stopDetails: NonNullable<AnthropicEvent['delta']>['stop_details'];
  const usage = EMPTY_USAGE();
  await readSse(response, (frame) => {
    if (frame.event === 'error') throw streamFailure(frame, ctx);
    if (frame.event === 'message_stop') return;
    if (!frame.data || frame.data === '[DONE]') return;
    const parsed = safeParse(frame.data);
    if (!parsed) return;
    if (parsed.type === 'error') throw streamFailure(frame, ctx);
    captureUsage(usage, parsed.message?.usage ?? parsed.usage);
    if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
      stopReason = parsed.delta.stop_reason;
      stopDetails = parsed.delta.stop_details;
    }
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta.text) {
      text += parsed.delta.text;
      opts.onChunk(parsed.delta.text);
    }
  });
  if (stopReason === 'refusal') throw refusalError(ctx, stopDetails);
  return { text, usage, stopReason };
}

// ── Tool-aware turn (chat orchestrator) ──────────────────────────

export interface AnthropicTurnOpts extends AnthropicEndpoint {
  model: string;
  maxTokens?: number;
  apiKey: string;
  /** Cached persona + knowledge + tool guidance + rendered context. */
  system: string;
  messages: AnthropicMessage[];
  /** Omit / empty to force a tools-off final answer. */
  tools?: ReturnType<typeof toAnthropicTools>;
  /** Provider-run tools (web search / web fetch). Sent only with `tools`. */
  serverTools?: AnthropicServerTool[];
  /** Require this one tool. Models that reject a forced choice get `auto`
   *  with the caller offering only this tool. */
  forceTool?: string;
  /** Require one of the supplied terminal tools while leaving the semantic
   * choice to the model. Mutually exclusive with forceTool. */
  requireTool?: boolean;
  effort?: AnthropicEffort;
  signal?: AbortSignal;
  /** Streamed assistant text deltas. */
  onText: (delta: string) => void;
}

/** One provider-run tool call, for the chat's tool trace. */
export interface ServerToolTrace {
  name: string;
  summary: string;
  ok: boolean;
}

export interface AnthropicTurnResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string | null;
  /** Assistant content blocks to append for the next turn, echoed verbatim
   *  (thinking, server tools, citations) so the transcript stays valid. */
  content: AnthropicContentBlock[];
  usage: AiTokenUsage;
  timing: AiProviderTiming;
  /** Concrete provider response model, when the wire protocol reports it. */
  resolvedModel?: string;
  /** Pages the model cited or read (web access). */
  sources: AiWebSource[];
  serverTools: ServerToolTrace[];
}

/** Accumulator for one streamed content block. */
interface BlockAcc {
  block: RawBlock;
  text: string;
  json: string;
  thinking: string;
  signature: string;
  citations: unknown[];
}

/** Build the request body for one tool turn. Exported for tests. */
export function buildAnthropicTurnRequest(opts: AnthropicTurnOpts): { body: Record<string, unknown>; headers: Record<string, string> } {
  const firstParty = isFirstParty(opts);
  const traits = anthropicModelTraits(opts.model);
  // Prompt-cache breakpoints (max 4 per request; reads cost 0.1x input). The
  // prefix serializes as tools → system → messages: one breakpoint at the
  // end of each segment. The moving message breakpoint matters because the
  // cache lookback walks only 20 blocks and one tool loop can add more.
  const system = opts.system
    ? [{ type: 'text', text: opts.system, cache_control: CACHE_CONTROL }]
    : undefined;
  const clientTools = opts.tools ?? [];
  const useTools = clientTools.length > 0;
  const allTools = useTools ? [...(opts.serverTools ?? []), ...clientTools] : [];
  const tools = useTools ? withToolCacheBreakpoint(allTools) : undefined;
  const { fields, betas } = modelFields(opts.model, opts.maxTokens ?? MAX_TOKENS, firstParty, opts.effort);
  const forced = !!opts.forceTool || !!opts.requireTool;
  let toolChoice: Record<string, unknown> | undefined;
  if (useTools) {
    if (opts.forceTool && traits.forcedToolChoice) toolChoice = { type: 'tool', name: opts.forceTool, disable_parallel_tool_use: true };
    else if (opts.requireTool && traits.forcedToolChoice) toolChoice = { type: 'any', disable_parallel_tool_use: true };
    // Discovery turns may call several read-only tools at once; the loop runs
    // them together and returns every result in one user message.
    else toolChoice = forced ? { type: 'auto', disable_parallel_tool_use: true } : { type: 'auto' };
  }
  return {
    body: {
      model: opts.model,
      ...fields,
      stream: true,
      ...(system ? { system } : {}),
      ...(tools ? { tools, tool_choice: toolChoice } : {}),
      messages: withHistoryCacheBreakpoint(opts.messages),
    },
    headers: requestHeaders(opts.apiKey, firstParty, betas),
  };
}

/** Run ONE Anthropic turn with optional tools. Streams text via onText and
 *  accumulates every content block. Returns the stop reason, the tool calls to
 *  run, and the assistant content to echo. A refusal throws a ProviderError;
 *  `max_tokens` drops the (possibly truncated) tool calls. */
export async function streamAnthropicTurn(opts: AnthropicTurnOpts): Promise<AnthropicTurnResult> {
  const url = `${opts.baseUrl ?? PROVIDERS.anthropic.baseUrl}/v1/messages`;
  const ctx = defaultErrorContext(opts);
  const request = buildAnthropicTurnRequest(opts);

  const requestStarted = Date.now();
  const response = await fetchProvider(url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  }, { ctx, signal: opts.signal, policy: opts.retryPolicy, onRetry: opts.onRetry });

  const timing: AiProviderTiming = { firstByteMs: Date.now() - requestStarted };

  const blocks = new Map<number, BlockAcc>();
  let stopReason: string | null = null;
  let stopDetails: NonNullable<AnthropicEvent['delta']>['stop_details'];
  let resolvedModel: string | undefined;
  const usage = EMPTY_USAGE();

  await readSse(response, (frame) => {
    if (frame.event === 'error') throw streamFailure(frame, ctx);
    if (!frame.data || frame.data === '[DONE]') return;
    const parsed = safeParse(frame.data);
    if (!parsed) return;
    if (parsed.type === 'error') throw streamFailure(frame, ctx);
    resolvedModel ??= parsed.message?.model;
    captureUsage(usage, parsed.message?.usage ?? parsed.usage);
    switch (parsed.type) {
      case 'content_block_start': {
        const idx = parsed.index ?? 0;
        const block: RawBlock = parsed.content_block?.type ? { ...parsed.content_block } : { type: 'text', text: '' };
        if (block.type === 'tool_use' || block.type === 'server_tool_use') timing.firstOutputMs ??= Date.now() - requestStarted;
        blocks.set(idx, {
          block,
          text: typeof block.text === 'string' ? block.text : '',
          json: '',
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
          signature: typeof block.signature === 'string' ? block.signature : '',
          citations: Array.isArray(block.citations) ? [...block.citations as unknown[]] : [],
        });
        break;
      }
      case 'content_block_delta': {
        const idx = parsed.index ?? 0;
        const acc = blocks.get(idx) ?? { block: { type: 'text' }, text: '', json: '', thinking: '', signature: '', citations: [] };
        const delta = parsed.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          timing.firstOutputMs ??= Date.now() - requestStarted;
          acc.text += delta.text;
          opts.onText(delta.text);
        } else if (delta?.type === 'input_json_delta' && delta.partial_json != null) {
          acc.json += delta.partial_json;
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          acc.thinking += delta.thinking;
        } else if (delta?.type === 'signature_delta' && delta.signature) {
          acc.signature += delta.signature;
        } else if (delta?.type === 'citations_delta' && delta.citation) {
          acc.citations.push(delta.citation);
        }
        blocks.set(idx, acc);
        break;
      }
      case 'message_delta':
        if (parsed.delta?.stop_reason) {
          stopReason = parsed.delta.stop_reason;
          stopDetails = parsed.delta.stop_details;
        }
        break;
      default:
        break;
    }
  });

  if (stopReason === 'refusal') throw refusalError(ctx, stopDetails);

  const finished = [...blocks.keys()].sort((a, b) => a - b).map((idx) => finishBlock(blocks.get(idx)!, idx));
  const content = echoableContent(finished);
  const lastFallback = finished.map(b => b.type).lastIndexOf('fallback');
  const toolCalls: ToolCall[] = [];
  let text = '';
  finished.forEach((block, index) => {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    // A fallback discards tool calls the declining model made before it.
    if (block.type === 'tool_use' && index > lastFallback) {
      toolCalls.push({ id: String(block.id), name: String(block.name ?? ''), input: (block.input ?? {}) as Record<string, unknown> });
    }
  });

  return {
    text,
    // A turn cut off at max_tokens may end inside a tool input. Never run it;
    // the orchestrator treats the empty result as a truncated turn.
    toolCalls: stopReason === 'max_tokens' ? [] : toolCalls,
    stopReason,
    content: stopReason === 'max_tokens' ? content.filter(b => b.type !== 'tool_use') : content,
    usage,
    timing,
    ...(resolvedModel ? { resolvedModel } : {}),
    sources: webSources(finished),
    serverTools: serverToolTrace(finished),
  };
}

function finishBlock(acc: BlockAcc, idx: number): RawBlock {
  const block = acc.block;
  switch (block.type) {
    case 'text':
      return { ...block, type: 'text', text: acc.text, ...(acc.citations.length ? { citations: acc.citations } : {}) };
    case 'tool_use':
    case 'server_tool_use':
      return { ...block, id: block.id ?? `tool_${idx}`, input: acc.json ? parseToolInput(acc.json) : (block.input ?? {}) };
    case 'thinking':
      return { ...block, thinking: acc.thinking, signature: acc.signature };
    default:
      // Server tool results, redacted thinking, fallback markers and unknown
      // types arrive complete in content_block_start.
      return block;
  }
}

/** Blocks that can be sent back. Empty text without citations is invalid.
 *  Before the last fallback marker only text and paired server-tool blocks
 *  are kept, as the API's fallback echo rules require. */
function echoableContent(blocks: RawBlock[]): AnthropicContentBlock[] {
  const lastFallback = blocks.map(b => b.type).lastIndexOf('fallback');
  const resultIds = new Set(blocks.filter(b => typeof b.tool_use_id === 'string').map(b => b.tool_use_id as string));
  return blocks.filter((block, index) => {
    if (block.type === 'text' && !block.text && !block.citations) return false;
    if (index >= lastFallback) return true;
    if (block.type === 'text') return true;
    if (block.type === 'server_tool_use') return resultIds.has(String(block.id));
    if (typeof block.tool_use_id === 'string') return true; // a server tool result
    return false;
  });
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Pages behind an answer: every URL a text block cites, then every page
 *  web fetch read. Search results the answer does not cite are left out. */
function webSources(blocks: RawBlock[]): AiWebSource[] {
  const out = new Map<string, AiWebSource>();
  const add = (rawUrl: unknown, title: unknown) => {
    const url = httpUrl(rawUrl);
    if (!url || out.has(url) || out.size >= 12) return;
    out.set(url, { url, ...(typeof title === 'string' && title.trim() ? { title: title.trim().slice(0, 200) } : {}) });
  };
  for (const block of blocks) {
    if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const citation of block.citations as Array<Record<string, unknown>>) add(citation?.url, citation?.title);
    }
  }
  for (const block of blocks) {
    if (block.type !== 'web_fetch_tool_result') continue;
    const result = block.content as Record<string, unknown> | undefined;
    if (result?.type !== 'web_fetch_result') continue;
    const document = result.content as Record<string, unknown> | undefined;
    add(result.url, document?.title);
  }
  return [...out.values()];
}

function serverToolTrace(blocks: RawBlock[]): ServerToolTrace[] {
  const results = new Map(blocks
    .filter(b => typeof b.tool_use_id === 'string')
    .map(b => [b.tool_use_id as string, b]));
  return blocks.filter(b => b.type === 'server_tool_use').map((block) => {
    const input = (block.input ?? {}) as Record<string, unknown>;
    const name = String(block.name ?? 'web_search');
    const summary = name === 'web_fetch'
      ? `Read ${typeof input.url === 'string' ? input.url : 'a web page'}`
      : name === 'web_search'
        ? `Searched the web for “${typeof input.query === 'string' ? input.query : ''}”`
        : name;
    const result = results.get(String(block.id));
    const content = result?.content as Record<string, unknown> | unknown[] | undefined;
    const failed = !result
      || (!!content && !Array.isArray(content) && (typeof content.error_code === 'string' || String(content.type ?? '').endsWith('_error')));
    return { name, summary, ok: !failed };
  });
}

/** Parse an accumulated tool-input JSON blob. Empty / malformed → `{}` so a
 *  bad delta never crashes the loop. */
function parseToolInput(json: string): Record<string, unknown> {
  const trimmed = json.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeParse(data: string): AnthropicEvent | null {
  try { return JSON.parse(data) as AnthropicEvent; } catch { return null; }
}

// ── Models API ───────────────────────────────────────────────────

interface ModelsPage {
  data?: Array<{ id?: string }>;
  has_more?: boolean;
  last_id?: string;
}

/** List the models this key may use (GET /v1/models). Costs no tokens and
 *  proves the key, so the setup check starts here. */
export async function listAnthropicModels(opts: AnthropicEndpoint & { apiKey: string; signal?: AbortSignal }): Promise<string[]> {
  const base = opts.baseUrl ?? PROVIDERS.anthropic.baseUrl;
  const firstParty = isFirstParty(opts);
  const ctx = defaultErrorContext({ ...opts, model: '' });
  const ids: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ limit: '1000', ...(after ? { after_id: after } : {}) });
    const response = await fetchProvider(`${base}/v1/models?${query}`, {
      method: 'GET',
      headers: requestHeaders(opts.apiKey, firstParty, []),
    }, { ctx, signal: opts.signal, policy: opts.retryPolicy });
    const json = await response.json() as ModelsPage;
    for (const model of json.data ?? []) if (model.id) ids.push(model.id);
    if (!json.has_more || !json.last_id) break;
    after = json.last_id;
  }
  return ids;
}
