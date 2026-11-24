import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { listAnthropicModels, streamAnthropic } from '../anthropic';
import { streamOpenAiCompat, listModels } from '../openai-compat';
import { retryClock } from '../http';
import { classifyProviderFailure, ProviderError, redactSecrets } from '../provider-errors';

// ── Fake fetch Response helpers (avoid depending on the runtime's ReadableStream
//    / Response construction — readSse only uses response.body.getReader()). ──

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
function errBody(status: number, body: string, headers: Record<string, string> = {}): any {
  return { ok: false, status, text: () => Promise.resolve(body), headers: new Headers(headers) };
}
function jsonOk(obj: unknown): any {
  return { ok: true, status: 200, json: () => Promise.resolve(obj) };
}

const sleeps: number[] = [];
beforeEach(() => {
  sleeps.length = 0;
  vi.spyOn(retryClock, 'sleep').mockImplementation(async (ms: number) => { sleeps.push(ms); });
  vi.spyOn(retryClock, 'random').mockReturnValue(0.5);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('streamAnthropic', () => {
  it('shapes the request and streams text_delta frames', async () => {
    const calls: any[] = [];
    const fetchMock = vi.fn((url: string, init: any) => { calls.push({ url, init }); return Promise.resolve(okStream([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])); });
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    const { text } = await streamAnthropic({ model: 'claude-opus-4-8', apiKey: 'sk-a', system: 'SYS', user: 'USR', onChunk: d => chunks.push(d) });

    expect(text).toBe('Hello');
    expect(chunks).toEqual(['Hel', 'lo']);
    const { url, init } = calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-a');
    // First-party API: current API version (no sampling parameters are sent).
    expect(init.headers['anthropic-version']).toBe('2026-10-21');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.max_tokens).toBe(8192);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBeUndefined();
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toBe('SYS');
    expect(body.messages).toEqual([{ role: 'user', content: 'USR' }]);
  });

  it('rejects on an SSE error frame with a plain sentence and keeps the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'event: error\ndata: {"error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]))));
    const error = await streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} }).catch(e => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'overloaded', detail: 'Overloaded', message: 'Anthropic is overloaded right now. Try again in a minute.' });
  });

  it('rejects a wrong key without retrying and says what to do', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errBody(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')));
    vi.stubGlobal('fetch', fetchMock);
    const error = await streamAnthropic({ model: 'm', apiKey: 'bad', system: '', user: 'u', onChunk: () => {} }).catch(e => e);
    expect(error).toMatchObject({ kind: 'auth', status: 401, detail: 'invalid x-api-key' });
    expect(error.message).toBe('Anthropic rejected the API key. Check that you pasted the whole key, or create a new key in the Claude Console.');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries 529 overloaded with backoff, then succeeds', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(n++ < 2
      ? errBody(529, '{"error":{"type":"overloaded_error","message":"Overloaded"}}')
      : okStream(['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n']))));
    const onRetry = vi.fn();
    const { text } = await streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {}, onRetry });
    expect(text).toBe('OK');
    expect(sleeps).toEqual([600, 1200]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('honours retry-after on 429 and gives up when the wait is too long', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(n++ === 0
      ? errBody(429, '{"error":{"type":"rate_limit_error","message":"slow down"}}', { 'retry-after': '3' })
      : okStream(['event: message_stop\ndata: {}\n\n']))));
    await streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} });
    expect(sleeps).toEqual([3000]);

    sleeps.length = 0;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(errBody(429, '{"error":{"type":"rate_limit_error","message":"slow down"}}', { 'retry-after': '120' }))));
    const error = await streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} }).catch(e => e);
    expect(error).toMatchObject({ kind: 'rate' });
    expect(sleeps).toEqual([]);
  });

  it('does not retry an x-should-retry: false response', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errBody(503, '{"error":{"type":"api_error","message":"no"}}', { 'x-should-retry': 'false' })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} })).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('a low credit balance is a credit error, never retried', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errBody(400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}')));
    vi.stubGlobal('fetch', fetchMock);
    const error = await streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} }).catch(e => e);
    expect(error).toMatchObject({ kind: 'credit' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('a network failure is retried and then named plainly', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchMock);
    const error = await streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} }).catch(e => e);
    expect(error).toMatchObject({ kind: 'network', message: 'Companion could not reach Anthropic. Check your network or VPN, then try again.' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('an aborted request is not retried and keeps the abort reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(() => { controller.abort(reason); return Promise.reject(reason); }));
    await expect(streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {}, signal: controller.signal }))
      .rejects.toBe(reason);
  });

  it('a refusal stop reason throws a refusal error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"x"}}}\n\n',
    ]))));
    const error = await streamAnthropic({ model: 'claude-opus-5-5', apiKey: 'k', system: '', user: 'u', onChunk: () => {} }).catch(e => e);
    expect(error).toMatchObject({ kind: 'refusal', detail: 'cyber: x' });
  });

  it('Opus 5.5: thinking headroom, explicit effort and the default refusal fallback', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: any) => { calls.push(init); return Promise.resolve(okStream(['event: message_stop\ndata: {}\n\n'])); }));
    await streamAnthropic({ model: 'claude-opus-5-5', maxTokens: 4096, effort: 'low', apiKey: 'k', system: '', user: 'u', onChunk: () => {} });
    const body = JSON.parse(calls[0].body);
    expect(body.max_tokens).toBe(16000);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.fallbacks).toBe('default');
    expect(body.thinking).toBeUndefined();
    expect(calls[0].headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
  });

  it('a custom Anthropic-compatible endpoint keeps the 2023-06-01 version and no extras', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => { calls.push({ url, init }); return Promise.resolve(okStream(['event: message_stop\ndata: {}\n\n'])); }));
    await streamAnthropic({ baseUrl: 'https://gw.example.test', firstParty: false, model: 'claude-opus-5-5', apiKey: 'k', system: '', user: 'u', onChunk: () => {} });
    expect(calls[0].url).toBe('https://gw.example.test/v1/messages');
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].init.headers['anthropic-beta']).toBeUndefined();
    expect(JSON.parse(calls[0].init.body).fallbacks).toBeUndefined();
  });

  it('omits the system block when system is empty', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => { calls.push(init); return Promise.resolve(okStream(['event: message_stop\ndata: {}\n\n'])); }));
    await streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} });
    expect(JSON.parse(calls[0].body).system).toBeUndefined();
  });
});

describe('streamOpenAiCompat', () => {
  it('shapes the request and streams delta.content, terminating on [DONE]', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => { calls.push({ url, init }); return Promise.resolve(okStream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ])); }));

    const chunks: string[] = [];
    const { text } = await streamOpenAiCompat({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      maxTokens: 4096,
      maxTokensParam: 'max_tokens',
      apiKey: 'sk-d',
      system: 'S',
      user: 'U',
      onChunk: d => chunks.push(d),
    });

    expect(text).toBe('Hello');
    expect(chunks).toEqual(['Hel', 'lo']);
    const { url, init } = calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer sk-d');
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('deepseek-chat');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
  });

  it('handles SSE payloads split across stream chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'data: {"choices":[{"delta":{"con',
      'tent":"AB"}}]}\n\ndata: [DONE]\n\n',
    ]))));
    const chunks: string[] = [];
    const { text } = await streamOpenAiCompat({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'k', system: '', user: 'u', onChunk: d => chunks.push(d) });
    expect(text).toBe('AB');
    expect(chunks).toEqual(['AB']);
  });

  it('defaults configured OpenAI-format limits to max_completion_tokens', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => {
      calls.push(init);
      return Promise.resolve(okStream(['data: [DONE]\n\n']));
    }));
    await streamOpenAiCompat({
      baseUrl: 'https://api.example.test/v1',
      model: 'reasoning-model',
      maxTokens: 2048,
      apiKey: 'k',
      system: '',
      user: 'u',
      onChunk: () => {},
    });
    const body = JSON.parse(calls[0].body);
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it('drops the system message when empty', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => { calls.push(init); return Promise.resolve(okStream(['data: [DONE]\n\n'])); }));
    await streamOpenAiCompat({ baseUrl: 'https://api.x.ai/v1', model: 'grok-4', apiKey: 'k', system: '', user: 'u', onChunk: () => {} });
    expect(JSON.parse(calls[0].body).messages).toEqual([{ role: 'user', content: 'u' }]);
    expect(JSON.parse(calls[0].body).max_tokens).toBeUndefined();
  });

  it('rejects on a non-2xx after retrying a rate limit', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errBody(429, '{"error":{"message":"rate limit"}}')));
    vi.stubGlobal('fetch', fetchMock);
    const error = await streamOpenAiCompat({
      baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {},
      errorContext: { provider: 'OpenAI', console: 'OpenAI dashboard' },
    }).catch(e => e);
    expect(error).toMatchObject({ kind: 'rate', detail: 'rate limit', message: 'OpenAI is limiting requests from this key right now. Wait a minute, then try again.' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('an exhausted quota is a credit error and is not retried', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errBody(429, '{"error":{"message":"You exceeded your current quota.","type":"insufficient_quota","code":"insufficient_quota"}}')));
    vi.stubGlobal('fetch', fetchMock);
    const error = await streamOpenAiCompat({ baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} }).catch(e => e);
    expect(error).toMatchObject({ kind: 'credit' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('a model that does not exist says to choose another model', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(errBody(404, '{"error":{"message":"The model `gpt-9` does not exist","code":"model_not_found"}}'))));
    const error = await streamOpenAiCompat({
      baseUrl: 'https://api.openai.com/v1', model: 'gpt-9', apiKey: 'k', system: '', user: 'u', onChunk: () => {},
      errorContext: { provider: 'OpenAI', model: 'gpt-9' },
    }).catch(e => e);
    expect(error).toMatchObject({ kind: 'model', message: 'The model gpt-9 is not available for this key. Choose another model.' });
  });

  it('a streamed refusal or content filter stop throws a refusal error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'data: {"choices":[{"delta":{"refusal":"I can not help with that."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))));
    await expect(streamOpenAiCompat({ baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} }))
      .rejects.toMatchObject({ kind: 'refusal' });
  });
});

describe('provider errors', () => {
  it.each([
    [401, 'authentication_error', '', 'invalid x-api-key', 'auth'],
    [403, 'permission_error', '', 'model not allowed for this key', 'model'],
    [402, '', '', 'payment required', 'credit'],
    [400, 'invalid_request_error', '', 'Your credit balance is too low to access the Anthropic API.', 'credit'],
    [404, 'not_found_error', '', 'model: claude-x', 'model'],
    [413, 'request_too_large', '', 'too big', 'too-large'],
    [429, 'rate_limit_error', '', 'slow', 'rate'],
    [529, 'overloaded_error', '', 'Overloaded', 'overloaded'],
    [500, 'api_error', '', 'boom', 'overloaded'],
    [400, 'invalid_request_error', '', 'messages: bad', 'other'],
  ] as const)('%i %s → %s', (status, type, code, message, kind) => {
    expect(classifyProviderFailure(status, type, code, message)).toBe(kind);
  });

  it('never carries a key fragment the provider quoted', () => {
    expect(redactSecrets('Incorrect API key provided: sk-proj-abc****wxyz. You can find')).toBe('Incorrect API key provided: [key]. You can find');
    expect(redactSecrets('bad key xai-1234567890')).toBe('bad key [key]');
  });
});

describe('listModels', () => {
  it('returns sorted model ids', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonOk({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }))));
    expect(await listModels('https://api.openai.com/v1', 'k')).toEqual(['gpt-a', 'gpt-b']);
  });

  it('lists Anthropic models through the Models API, following pages', async () => {
    const urls: string[] = [];
    const headers: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => {
      urls.push(url);
      headers.push(init.headers);
      return Promise.resolve(jsonOk(urls.length === 1
        ? { data: [{ id: 'claude-opus-5-5' }], has_more: true, last_id: 'claude-opus-5-5' }
        : { data: [{ id: 'claude-haiku-5-5' }], has_more: false }));
    }));
    expect(await listAnthropicModels({ apiKey: 'sk-ant-FAKE' })).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    expect(urls[0]).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(urls[1]).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5');
    expect(headers[0]['x-api-key']).toBe('sk-ant-FAKE');
    expect(headers[0]['anthropic-dangerous-direct-browser-access']).toBe('true');
  });
});
