/**
 * Thin conversation-protocol adapters. They own provider message history,
 * function/tool projection, tool-result turns, and assistant-turn persistence.
 * Retry, budgeting, terminal artifacts, Preview, and product policy stay in
 * the shared orchestrator.
 */

import {
  MAX_PAUSE_CONTINUATIONS,
  streamAnthropicTurn,
  type AnthropicContentBlock,
  type AnthropicEffort,
  type AnthropicMessage,
  type AnthropicServerTool,
  type ServerToolTrace,
} from './anthropic';
import { streamOpenAiTurn, type OpenAiMessage } from './openai-compat';
import type { ProviderErrorContext } from './provider-errors';
import { scrubModelReasoning, ToolMarkupScrubber } from './scrub';
import { toAnthropicTools, toOpenAiTools, type ToolDef } from './tool-contracts';
import { toolResultForModel, type ToolCall, type ToolResult } from './tools';
import type { AiChatTurn, AiProviderTiming, AiTokenUsage, AiWebSource } from './types';

export interface ProviderToolSelection {
  tools: ToolDef[];
  forceTool?: string;
  requireTool?: boolean;
}

export interface ProviderConversationTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: AiTokenUsage;
  timing: AiProviderTiming;
  /** Concrete provider response model. Important when the requested model is
   * a router rather than a fixed model id. */
  resolvedModel?: string;
  /** Pages the provider's web tools cited or read on this turn. */
  sources?: AiWebSource[];
  /** Provider-run tool calls (web search / fetch), for the tool trace. */
  serverTools?: ServerToolTrace[];
  /** Why the provider stopped (`end_turn`, `tool_use`, `max_tokens`, ...). */
  stopReason?: string | null;
  appendAssistant: () => void;
}

export interface ProviderConversation {
  requestTurn: (selection: ProviderToolSelection) => Promise<ProviderConversationTurn>;
  appendToolResults: (results: readonly { call: ToolCall; result: ToolResult }[]) => void;
  appendUserNote: (note: string) => void;
  appendFinalNote: (note: string) => void;
}

interface ConversationBaseOptions {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  apiKey: string;
  system: string;
  history: readonly AiChatTurn[];
  user: string;
  signal?: AbortSignal;
  errorContext?: ProviderErrorContext;
  /** Called before a request is repeated after a temporary failure. */
  onRetry?: () => void;
}

interface AnthropicConversationOptions extends ConversationBaseOptions {
  /** The built-in Anthropic API (not a custom compatible endpoint). */
  firstParty?: boolean;
  /** Web search / web fetch, offered whenever discovery tools are. */
  serverTools?: AnthropicServerTool[];
  effort?: AnthropicEffort;
}

function addUsage(target: AiTokenUsage, usage: AiTokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  if (usage.webSearchRequests) target.webSearchRequests = (target.webSearchRequests ?? 0) + usage.webSearchRequests;
  if (usage.webFetchRequests) target.webFetchRequests = (target.webFetchRequests ?? 0) + usage.webFetchRequests;
}

export function createAnthropicConversation(options: AnthropicConversationOptions): ProviderConversation {
  const messages: AnthropicMessage[] = options.history.map(turn => ({ role: turn.role, content: turn.text }));
  messages.push({ role: 'user', content: options.user });

  return {
    requestTurn: async selection => {
      const scrubber = new ToolMarkupScrubber();
      let text = '';
      // Web tools ride along only while ordinary discovery tools are offered:
      // never on a forced terminal or a tools-off final turn.
      const discovery = selection.tools.length > 0 && !selection.forceTool && !selection.requireTool;
      const request = () => streamAnthropicTurn({
        baseUrl: options.baseUrl,
        firstParty: options.firstParty,
        model: options.model,
        maxTokens: options.maxTokens,
        apiKey: options.apiKey,
        system: options.system,
        messages,
        tools: toAnthropicTools(selection.tools),
        ...(discovery && options.serverTools?.length ? { serverTools: options.serverTools } : {}),
        ...(selection.forceTool ? { forceTool: selection.forceTool } : {}),
        ...(selection.requireTool ? { requireTool: true } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.errorContext ? { errorContext: options.errorContext } : {}),
        ...(options.onRetry ? { onRetry: options.onRetry } : {}),
        signal: options.signal,
        onText: delta => { text += scrubber.feed(delta); },
      });
      let turn = await request();
      const usage = { ...turn.usage };
      const sources = [...turn.sources];
      const serverTools = [...turn.serverTools];
      // A long server-tool turn pauses (`pause_turn`). Send the paused content
      // back unchanged and the server resumes; no extra user message.
      for (let resumed = 0; turn.stopReason === 'pause_turn' && resumed < MAX_PAUSE_CONTINUATIONS; resumed++) {
        if (turn.content.length) messages.push({ role: 'assistant', content: turn.content });
        turn = await request();
        addUsage(usage, turn.usage);
        sources.push(...turn.sources.filter(source => !sources.some(seen => seen.url === source.url)));
        serverTools.push(...turn.serverTools);
      }
      text += scrubber.flush();
      return {
        text: scrubModelReasoning(text),
        toolCalls: turn.toolCalls,
        usage,
        timing: turn.timing,
        stopReason: turn.stopReason,
        ...(turn.resolvedModel ? { resolvedModel: turn.resolvedModel } : {}),
        ...(sources.length ? { sources } : {}),
        ...(serverTools.length ? { serverTools } : {}),
        appendAssistant: () => {
          if (turn.content.length) messages.push({ role: 'assistant', content: turn.content });
        },
      };
    },
    appendToolResults: results => {
      const content: AnthropicContentBlock[] = results.map(({ call, result }) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: toolResultForModel(result, call.name),
        ...(result.isError ? { is_error: true } : {}),
      }));
      messages.push({ role: 'user', content });
    },
    appendUserNote: note => { messages.push({ role: 'user', content: note }); },
    appendFinalNote: note => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push({ type: 'text', text: note });
      } else {
        messages.push({ role: 'user', content: note });
      }
    },
  };
}

interface OpenAiConversationOptions extends ConversationBaseOptions {
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
}

export function createOpenAiConversation(options: OpenAiConversationOptions): ProviderConversation {
  const messages: OpenAiMessage[] = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  for (const turn of options.history) messages.push({ role: turn.role, content: turn.text });
  messages.push({ role: 'user', content: options.user });

  return {
    requestTurn: async selection => {
      const scrubber = new ToolMarkupScrubber();
      let text = '';
      const turn = await streamOpenAiTurn({
        baseUrl: options.baseUrl,
        model: options.model,
        maxTokens: options.maxTokens,
        maxTokensParam: options.maxTokensParam,
        apiKey: options.apiKey,
        messages,
        tools: toOpenAiTools(selection.tools),
        ...(selection.forceTool ? { forceTool: selection.forceTool } : {}),
        ...(selection.requireTool ? { requireTool: true } : {}),
        ...(options.errorContext ? { errorContext: options.errorContext } : {}),
        ...(options.onRetry ? { onRetry: options.onRetry } : {}),
        signal: options.signal,
        onText: delta => { text += scrubber.feed(delta); },
      });
      text += scrubber.flush();
      return {
        text: scrubModelReasoning(text),
        toolCalls: turn.toolCalls,
        usage: turn.usage,
        timing: turn.timing,
        stopReason: turn.finishReason,
        ...(turn.resolvedModel ? { resolvedModel: turn.resolvedModel } : {}),
        appendAssistant: () => { messages.push(turn.assistantMessage); },
      };
    },
    appendToolResults: results => {
      for (const { call, result } of results) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultForModel(result, call.name) });
      }
    },
    appendUserNote: note => { messages.push({ role: 'user', content: note }); },
    appendFinalNote: note => { messages.push({ role: 'user', content: note }); },
  };
}
