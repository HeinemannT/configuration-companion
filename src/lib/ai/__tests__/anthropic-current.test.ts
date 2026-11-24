/**
 * Current Anthropic practice in the provider client (claude-api skill,
 * 2026-11): request shape per model, prompt-cache breakpoints, verbatim echo
 * of thinking / server-tool / citation blocks, refusal fallback echo rules,
 * stop reasons, web tools, pause_turn continuation, and the chat loop's
 * parallel tool calls and web sources. Verified against documented wire
 * shapes only; no live provider is called.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { anthropicWebTools, buildAnthropicTurnRequest, streamAnthropicTurn } from '../anthropic';
import { anthropicModelTraits, chatModels, pickDefaultModel, providerFromKey, webAccessEnabled } from '../providers';
import { createAnthropicConversation } from '../provider-conversation';
import { streamChat, TRUNCATED_ANSWER_NOTE } from '../client';
import { WEB_ACCESS_POLICY } from '../sidebar-prompt';
import type { AiChatEvent, AiSettings } from '../types';
import type { ToolCall, ToolResult } from '../tools';

function streamBody(parts: string[]) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    getReader() {
      return {
        read: () => Promise.resolve(
          i < parts.length ? { value: enc.encode(parts[i++]), done: false } : { value: undefined, done: true },
        ),
      };
    },
  };
}
function okStream(parts: string[]): any {
  return { ok: true, status: 200, body: streamBody(parts) };
}
const ev = (data: Record<string, unknown>) => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;

const TOOL = { name: 'read_type', description: 'd', input_schema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const } };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('model traits and provider helpers', () => {
  it('knows which models reject a forced tool choice and which think by default', () => {
    expect(anthropicModelTraits('claude-opus-5-5')).toMatchObject({ forcedToolChoice: false, thinksByDefault: true, effort: true, fallbacks: true, webSearchTool: 'web_search_20260209', webFetchTool: 'web_fetch_20260209' });
    expect(anthropicModelTraits('claude-sonnet-5-5')).toMatchObject({ forcedToolChoice: false, fallbacks: true });
    expect(anthropicModelTraits('claude-opus-4-8')).toMatchObject({ forcedToolChoice: true, thinksByDefault: false, fallbacks: false });
    expect(anthropicModelTraits('claude-haiku-5-5')).toMatchObject({ forcedToolChoice: true, fallbacks: false, webSearchTool: 'web_search_20250305', webFetchTool: null });
    expect(anthropicModelTraits('claude-haiku-4-5')).toMatchObject({ effort: false, thinksByDefault: false });
    expect(anthropicModelTraits('some-proxy-model')).toMatchObject({ forcedToolChoice: true, effort: false, fallbacks: false });
  });

  it('recognises only unambiguous key prefixes', () => {
    expect(providerFromKey('sk-ant-api03-FAKE')).toBe('anthropic');
    expect(providerFromKey('  xai-FAKE ')).toBe('grok');
    expect(providerFromKey('sk-proj-FAKE')).toBe('openai');
    expect(providerFromKey('sk-0123456789abcdef')).toBeNull(); // DeepSeek or legacy OpenAI
  });

  it('filters live lists to chat models and preselects a sensible default', () => {
    expect(chatModels('openai', ['text-embedding-3-large', 'gpt-5.2', 'whisper-1', 'gpt-5-mini', 'dall-e-3', 'gpt-4o-realtime-preview']))
      .toEqual(['gpt-5-mini', 'gpt-5.2']);
    expect(pickDefaultModel('anthropic', ['claude-sonnet-5-5', 'claude-opus-5-5'])).toBe('claude-opus-5-5');
    expect(pickDefaultModel('anthropic', ['claude-sonnet-5-5', 'claude-opus-5-5'], 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(pickDefaultModel('deepseek', ['deepseek-chat', 'deepseek-reasoner'])).toBe('deepseek-chat');
    expect(pickDefaultModel('grok', ['grok-5'])).toBe('grok-5');
  });

  it('web access is on by default only for the built-in Anthropic provider', () => {
    const base = { model: 'm', keys: {} } as const;
    expect(webAccessEnabled({ ...base, provider: 'anthropic' })).toBe(true);
    expect(webAccessEnabled({ ...base, provider: 'anthropic', webAccess: false })).toBe(false);
    expect(webAccessEnabled({ ...base, provider: 'openai' })).toBe(false);
    expect(webAccessEnabled({
      ...base, provider: 'custom', model: 'a',
      customProvider: { name: 'G', vendor: 'g', apiType: 'anthropic', models: [{ id: 'a', name: 'A', url: 'https://g.test', toolCalling: true }] },
    })).toBe(false);
  });

  it('web tool versions follow the model', () => {
    expect(anthropicWebTools('claude-opus-5-5')).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
    ]);
    expect(anthropicWebTools('claude-haiku-4-5')).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
  });
});

describe('Anthropic request shape', () => {
  it('Opus 5.5: no forced tool_choice; auto with one call for a required terminal', () => {
    const { body, headers } = buildAnthropicTurnRequest({
      model: 'claude-opus-5-5', apiKey: 'k', system: 'S', messages: [{ role: 'user', content: 'u' }],
      tools: [TOOL], requireTool: true, effort: 'medium', onText: () => {},
    });
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.max_tokens).toBe(16000);
    expect(body.fallbacks).toBe('default');
    expect(headers['anthropic-version']).toBe('2026-10-21');
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('thinking');
  });

  it('Opus 4.8 keeps the forced choices it accepts', () => {
    const force = buildAnthropicTurnRequest({ model: 'claude-opus-4-8', apiKey: 'k', system: '', messages: [], tools: [TOOL], forceTool: 'read_type', onText: () => {} });
    expect(force.body.tool_choice).toEqual({ type: 'tool', name: 'read_type', disable_parallel_tool_use: true });
    const any = buildAnthropicTurnRequest({ model: 'claude-opus-4-8', apiKey: 'k', system: '', messages: [], tools: [TOOL], requireTool: true, onText: () => {} });
    expect(any.body.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
    const auto = buildAnthropicTurnRequest({ model: 'claude-opus-4-8', apiKey: 'k', system: '', messages: [], tools: [TOOL], onText: () => {} });
    expect(auto.body.tool_choice).toEqual({ type: 'auto' });
  });

  it('server tools go first, the cache breakpoint stays on the last tool, system and last message', () => {
    const { body } = buildAnthropicTurnRequest({
      model: 'claude-opus-5-5', apiKey: 'k', system: 'S',
      messages: [
        { role: 'user', content: 'u' },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: '', signature: 'sig' }] },
      ],
      tools: [TOOL], serverTools: anthropicWebTools('claude-opus-5-5'), onText: () => {},
    });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.map(t => t.name)).toEqual(['web_search', 'web_fetch', 'read_type']);
    expect(tools.map(t => !!t.cache_control)).toEqual([false, false, true]);
    expect((body.system as any)[0].cache_control).toEqual({ type: 'ephemeral' });
    const last = (body.messages as any[]).at(-1).content;
    // A thinking block cannot carry a breakpoint: the text before it does.
    expect(last[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(last[1].cache_control).toBeUndefined();
  });

  it('tools-off turns send no tools and no server tools', () => {
    const { body } = buildAnthropicTurnRequest({ model: 'claude-opus-5-5', apiKey: 'k', system: '', messages: [], tools: [], serverTools: anthropicWebTools('claude-opus-5-5'), onText: () => {} });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});

describe('Anthropic stream: blocks echoed verbatim', () => {
  it('keeps thinking with its signature, server tool blocks and citations, and collects sources', async () => {
    const citation = { type: 'web_search_result_location', url: 'https://www.corporater.com/docs/x', title: 'Corporater docs', cited_text: 'c', encrypted_index: 'EI' };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      ev({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, cache_read_input_tokens: 900 } } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' } }),
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"Corporater BMP"}' } }),
      ev({ type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://www.corporater.com/docs/x', title: 'Corporater docs', encrypted_content: 'E' }] } }),
      ev({ type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'BMP is a platform.' } }),
      ev({ type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation } }),
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40, server_tool_use: { web_search_requests: 1 } } }),
    ]))));
    const turn = await streamAnthropicTurn({ model: 'claude-opus-5-5', apiKey: 'k', system: '', messages: [], tools: [TOOL], onText: () => {} });
    expect(turn.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'SIG' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Corporater BMP' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://www.corporater.com/docs/x', title: 'Corporater docs', encrypted_content: 'E' }] },
      { type: 'text', text: 'BMP is a platform.', citations: [citation] },
    ]);
    expect(turn.toolCalls).toEqual([]);
    expect(turn.sources).toEqual([{ url: 'https://www.corporater.com/docs/x', title: 'Corporater docs' }]);
    expect(turn.serverTools).toEqual([{ name: 'web_search', summary: 'Searched the web for “Corporater BMP”', ok: true }]);
    expect(turn.usage).toMatchObject({ inputTokens: 1000, cachedInputTokens: 900, outputTokens: 40, webSearchRequests: 1 });
  });

  it('a web fetch result is a source; a failed server tool is marked in the trace', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_fetch', input: { url: 'https://example.org/page' } } }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'web_fetch_tool_result', tool_use_id: 's1', content: { type: 'web_fetch_result', url: 'https://example.org/page', content: { type: 'document', title: 'Example page', source: { type: 'text', media_type: 'text/plain', data: '...' } } } } }),
      ev({ type: 'content_block_start', index: 2, content_block: { type: 'server_tool_use', id: 's2', name: 'web_fetch', input: { url: 'javascript:alert(1)' } } }),
      ev({ type: 'content_block_start', index: 3, content_block: { type: 'web_fetch_tool_result', tool_use_id: 's2', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } } }),
      ev({ type: 'content_block_start', index: 4, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: 'Read it.' } }),
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ]))));
    const turn = await streamAnthropicTurn({ model: 'claude-opus-5-5', apiKey: 'k', system: '', messages: [], tools: [TOOL], onText: () => {} });
    expect(turn.sources).toEqual([{ url: 'https://example.org/page', title: 'Example page' }]);
    expect(turn.serverTools.map(t => t.ok)).toEqual([true, false]);
  });

  it('after a fallback marker, only text and paired server blocks before it are echoed and its tool calls are dropped', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'A' } }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Partial ' } }),
      ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'old', name: 'read_type' } }),
      ev({ type: 'content_block_start', index: 3, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } }),
      ev({ type: 'content_block_start', index: 4, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: 'rest.' } }),
      ev({ type: 'content_block_start', index: 5, content_block: { type: 'tool_use', id: 'new', name: 'read_type' } }),
      ev({ type: 'content_block_delta', index: 5, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    ]))));
    const turn = await streamAnthropicTurn({ model: 'claude-opus-5-5', apiKey: 'k', system: '', messages: [], tools: [TOOL], onText: () => {} });
    expect(turn.content.map(b => b.type)).toEqual(['text', 'fallback', 'text', 'tool_use']);
    expect(turn.toolCalls.map(c => c.id)).toEqual(['new']);
    expect(turn.text).toBe('Partial rest.');
  });

  it('max_tokens never runs a possibly truncated tool call', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'read_type' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ty' } }),
      ev({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
    ]))));
    const turn = await streamAnthropicTurn({ model: 'claude-opus-4-8', apiKey: 'k', system: '', messages: [], tools: [TOOL], onText: () => {} });
    expect(turn.toolCalls).toEqual([]);
    expect(turn.content).toEqual([]);
    expect(turn.stopReason).toBe('max_tokens');
  });

  it('a refusal throws a refusal error with its category', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      ev({ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: null } } }),
    ]))));
    await expect(streamAnthropicTurn({ model: 'claude-opus-5-5', apiKey: 'k', system: '', messages: [], onText: () => {} }))
      .rejects.toMatchObject({ kind: 'refusal', detail: 'bio' });
  });
});

describe('Anthropic conversation', () => {
  it('resumes a paused server-tool turn by sending the paused content back, without a user message', async () => {
    const bodies: any[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(n++ === 0
        ? [
            ev({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } } }),
            ev({ type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } } }),
          ]
        : [
            ev({ type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [] } }),
            ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
            ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } }),
            ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7, server_tool_use: { web_search_requests: 1 } } }),
          ]));
    }));
    const conversation = createAnthropicConversation({
      baseUrl: 'https://api.anthropic.com', firstParty: true, model: 'claude-opus-5-5', apiKey: 'k', system: 'S',
      history: [], user: 'question', serverTools: anthropicWebTools('claude-opus-5-5'),
    });
    const turn = await conversation.requestTurn({ tools: [{ name: 'read_type', description: 'd', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }] });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(bodies[1].messages[1].content[0]).toMatchObject({ type: 'server_tool_use', id: 's1' });
    expect(turn.text).toBe('Done.');
    expect(turn.usage).toMatchObject({ outputTokens: 12, webSearchRequests: 2 });
    expect(bodies[0].tools.map((t: any) => t.name)).toEqual(['web_search', 'web_fetch', 'read_type']);
  });

  it('offers web tools only on discovery turns, never on a required terminal', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream([ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })]));
    }));
    const conversation = createAnthropicConversation({
      baseUrl: 'https://api.anthropic.com', firstParty: true, model: 'claude-opus-5-5', apiKey: 'k', system: 'S',
      history: [], user: 'q', serverTools: anthropicWebTools('claude-opus-5-5'),
    });
    await conversation.requestTurn({ tools: [{ name: 'answer_user', description: 'd', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }], requireTool: true });
    expect(bodies[0].tools.map((t: any) => t.name)).toEqual(['answer_user']);
  });
});

describe('chat loop', () => {
  const settings: AiSettings = { provider: 'anthropic', model: 'claude-opus-5-5', keys: {} };

  it('runs one round of parallel tool calls together and returns every result in one message', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Promise.resolve(okStream(bodies.length === 1
        ? [
            ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read_type' } }),
            ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"type":"A"}' } }),
            ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'read_type' } }),
            ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"type":"B"}' } }),
            ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
          ]
        : [
            ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
            ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Both read.' } }),
            ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
          ]));
    }));
    let running = 0;
    let peak = 0;
    const executeTool = vi.fn(async (call: ToolCall): Promise<ToolResult> => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5));
      running--;
      return { content: `type ${String(call.input.type)}`, isError: false };
    });
    const events: AiChatEvent[] = [];
    const metrics = await streamChat({ settings: { ...settings, webAccess: false }, apiKey: 'k', system: 'S', history: [], text: 'compare', onEvent: e => events.push(e), executeTool });
    expect(peak).toBe(2);
    const results = bodies[1].messages.at(-1).content;
    expect(results.map((r: any) => [r.type, r.tool_use_id])).toEqual([['tool_result', 'a'], ['tool_result', 'b']]);
    expect(metrics.toolCallsExecuted).toBe(2);
    expect(events.filter(e => e.kind === 'tool-end')).toHaveLength(2);
  });

  it('with web access: adds the web policy to the system prompt, traces web tools and emits sources', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream([
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'ISO 31000' } } }),
        ev({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [] } }),
        ev({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
        ev({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'ISO 31000 is a risk standard.' } }),
        ev({ type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://www.iso.org/iso-31000', title: 'ISO 31000', cited_text: 'x', encrypted_index: 'e' } } }),
        ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9, server_tool_use: { web_search_requests: 1 } } }),
      ]));
    }));
    const events: AiChatEvent[] = [];
    const metrics = await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'What is ISO 31000?', onEvent: e => events.push(e), executeTool: vi.fn() });
    expect(bodies[0].system[0].text).toContain(WEB_ACCESS_POLICY);
    expect(bodies[0].tools.slice(0, 2).map((t: any) => t.type)).toEqual(['web_search_20260209', 'web_fetch_20260209']);
    expect(events).toContainEqual({ kind: 'tool-end', name: 'web_search', summary: 'Searched the web for “ISO 31000”', ok: true });
    const sources = events.find(e => e.kind === 'sources');
    expect(sources).toEqual({ kind: 'sources', sources: [{ url: 'https://www.iso.org/iso-31000', title: 'ISO 31000' }] });
    expect(events.findIndex(e => e.kind === 'sources')).toBeLessThan(events.findIndex(e => e.kind === 'text-delta'));
    expect(metrics.webSearchRequests).toBe(1);
  });

  it('without web access: no web tools and no web policy', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream([
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
        ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      ]));
    }));
    await streamChat({ settings: { ...settings, webAccess: false }, apiKey: 'k', system: 'S', history: [], text: 'hi', onEvent: () => {}, executeTool: vi.fn() });
    expect(bodies[0].system[0].text).not.toContain('<web-access>');
    expect(bodies[0].tools.some((t: any) => String(t.type ?? '').startsWith('web_'))).toBe(false);
  });

  it('marks an answer cut off at the output limit', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A long answer' } }),
      ev({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
    ]))));
    const events: AiChatEvent[] = [];
    await streamChat({ settings: { ...settings, webAccess: false }, apiKey: 'k', system: 'S', history: [], text: 'explain', onEvent: e => events.push(e), executeTool: vi.fn() });
    const text = events.filter(e => e.kind === 'text-delta').map(e => (e as { delta: string }).delta).join('');
    expect(text).toBe(`A long answer\n\n${TRUNCATED_ANSWER_NOTE}`);
  });

  it('a provider error reaches the chat as one plain sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false, status: 401, headers: new Headers(), text: () => Promise.resolve('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
    })));
    const events: AiChatEvent[] = [];
    const metrics = await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'hi', onEvent: e => events.push(e), executeTool: vi.fn() });
    expect(events).toContainEqual({ kind: 'error', message: 'Anthropic rejected the API key. Check that you pasted the whole key, or create a new key in the Claude Console.' });
    expect(metrics.terminalOutcome).toBe('error');
  });
});
