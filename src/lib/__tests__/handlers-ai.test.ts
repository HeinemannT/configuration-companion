/**
 * Tests for handlers/ai.ts — the AI config CRUD + the streaming completion's
 * cancel path. The provider dialects, prompt building, and SSE parsing have
 * their own suites; here we only assert the handler wiring: config read/write,
 * and that AI_CANCEL aborts the in-flight request's AbortController.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InspectorMessage } from '../types';

let recordedSignal: AbortSignal | null = null;
const sentBroadcasts: InspectorMessage[] = [];
const { streamChatMock, testConnectionMock, listModelsMock } = vi.hoisted(() => ({
  streamChatMock: vi.fn(),
  testConnectionMock: vi.fn(),
  listModelsMock: vi.fn(),
}));

vi.mock('../ai/client', () => ({
  streamCompletion: (opts: any) => {
    recordedSignal = opts.signal;
    // Hang until aborted (mimics a long stream).
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  },
  streamChat: streamChatMock,
  testConnection: testConnectionMock,
  listModels: listModelsMock,
  providerErrorContext: (meta: any, model: string) => ({ provider: meta.label, console: meta.console, model, host: new URL(meta.baseUrl).host }),
  providerCheckFailure: (e: any) => ({ ok: false, error: e.message, kind: e.kind ?? 'other' }),
}));

vi.mock('../crypto', () => ({
  encrypt: (s: string) => Promise.resolve(`enc:${s}`),
  decrypt: (s: string) => Promise.resolve(s.replace(/^enc:/, '')),
}));

const settingsHolder = vi.hoisted(() => ({ ctx: null as null | { settings: any } }));
vi.mock('../settings', () => ({
  saveSettings: () => Promise.resolve({ ok: true }),
  snapshotSettings: () => {},
  updateSettings: (change: (s: any) => any) => {
    settingsHolder.ctx!.settings = change(settingsHolder.ctx!.settings);
    return Promise.resolve({ ok: true });
  },
}));

vi.mock('../messaging', () => ({
  sendFireForget: (m: InspectorMessage) => { sentBroadcasts.push(m); },
}));

function makeCtx() {
  return {
    settings: { schemaVersion: 5, profiles: [], activeProfileId: '', autoDetect: true, saveTarget: 'template', enrichMode: 'widgets', ai: undefined as any },
    logActivity: vi.fn(),
  };
}

describe('handlers/ai', () => {
  let getHandler: (t: string) => any;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(async () => {
    vi.resetModules();
    streamChatMock.mockReset();
    testConnectionMock.mockReset().mockResolvedValue({ ok: true });
    listModelsMock.mockReset().mockResolvedValue(['claude-opus-5-5', 'claude-sonnet-5-5']);
    recordedSignal = null;
    sentBroadcasts.length = 0;
    const swctx = await import('../sw-context');
    ctx = makeCtx();
    settingsHolder.ctx = ctx;
    swctx.setSwContext(ctx as any);
    await import('../handlers/ai');
    ({ getHandler } = await import('../handler-registry'));
  });

  const call = (msg: InspectorMessage) => {
    const responses: InspectorMessage[] = [];
    const p = getHandler(msg.type)(msg, (r: InspectorMessage) => responses.push(r), { isOneShot: true });
    return { responses, done: Promise.resolve(p) };
  };

  it('AI_GET_CONFIG reports not-configured before a key is saved', async () => {
    const { responses, done } = call({ type: 'AI_GET_CONFIG' });
    await done;
    expect(responses[0]).toEqual({ type: 'AI_CONFIG_DATA', configured: false, provider: undefined, model: undefined });
  });

  it('AI_SAVE_CONFIG encrypts the key for its provider and stores provider + model', async () => {
    const { responses, done } = call({ type: 'AI_SAVE_CONFIG', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test-1' });
    await done;
    expect(ctx.settings.ai).toEqual({
      provider: 'anthropic', model: 'claude-opus-5-5',
      keys: { anthropic: { apiKeyEnc: 'enc:sk-ant-test-1', model: 'claude-opus-5-5' } },
    });
    expect(responses[0]).toMatchObject({ type: 'AI_CONFIG_SAVED', ok: true, configured: true, provider: 'anthropic', model: 'claude-opus-5-5' });
    // Pages see only the marker, never the ciphertext.
    expect(JSON.stringify(responses[0])).not.toContain('enc:');
    expect(sentBroadcasts).toContainEqual(expect.objectContaining({ type: 'AI_CONFIG_CHANGED', configured: true, provider: 'anthropic', model: 'claude-opus-5-5' }));
    expect(JSON.stringify(sentBroadcasts)).not.toContain('sk-ant-test-1');
  });

  it('switching provider keeps every other key, and switching back needs no key', async () => {
    ctx.settings.ai = {
      provider: 'anthropic', model: 'claude-opus-5-5',
      keys: { anthropic: { apiKeyEnc: 'enc:a', model: 'claude-opus-5-5' } },
    };
    await call({ type: 'AI_SAVE_CONFIG', provider: 'openai', model: 'gpt-5.2', apiKey: 'sk-proj-test' }).done;
    expect(ctx.settings.ai.keys).toEqual({
      anthropic: { apiKeyEnc: 'enc:a', model: 'claude-opus-5-5' },
      openai: { apiKeyEnc: 'enc:sk-proj-test', model: 'gpt-5.2' },
    });
    await call({ type: 'AI_SAVE_CONFIG', provider: 'anthropic', model: 'claude-opus-5-5' }).done;
    expect(ctx.settings.ai).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(ctx.settings.ai.keys.openai.apiKeyEnc).toBe('enc:sk-proj-test');
    expect(ctx.settings.ai.keys.anthropic.apiKeyEnc).toBe('enc:a');
  });

  it('AI_SAVE_CONFIG refuses a provider without a key and changes nothing', async () => {
    ctx.settings.ai = { provider: 'anthropic', model: 'claude-opus-5-5', keys: { anthropic: { apiKeyEnc: 'enc:a' } } };
    const { responses, done } = call({ type: 'AI_SAVE_CONFIG', provider: 'grok', model: 'grok-4' });
    await done;
    expect(responses[0]).toMatchObject({ type: 'AI_CONFIG_SAVED', ok: false, error: 'Paste the API key for Grok first.' });
    expect(ctx.settings.ai.provider).toBe('anthropic');
  });

  it('AI_CHECK_KEY lists models, preselects the default, tests it, then stores the key', async () => {
    ctx.settings.ai = { provider: 'openai', model: 'gpt-5.2', keys: { openai: { apiKeyEnc: 'enc:o', model: 'gpt-5.2' } } };
    const { responses, done } = call({ type: 'AI_CHECK_KEY', provider: 'anthropic', apiKey: 'sk-ant-test-2' });
    await done;
    expect(listModelsMock).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }), 'sk-ant-test-2');
    expect(testConnectionMock).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic', model: 'claude-opus-5-5' }), 'sk-ant-test-2');
    expect(responses[0]).toMatchObject({
      type: 'AI_KEY_CHECKED', provider: 'anthropic', ok: true,
      models: ['claude-opus-5-5', 'claude-sonnet-5-5'], model: 'claude-opus-5-5', configured: true,
    });
    expect(JSON.stringify(responses[0])).not.toContain('sk-ant-test-2');
    expect(ctx.settings.ai.provider).toBe('anthropic');
    expect(ctx.settings.ai.keys.anthropic).toMatchObject({ apiKeyEnc: 'enc:sk-ant-test-2', model: 'claude-opus-5-5', lastTest: { ok: true, model: 'claude-opus-5-5' } });
    expect(ctx.settings.ai.keys.openai.apiKeyEnc).toBe('enc:o');
  });

  it('AI_CHECK_KEY keeps nothing when the provider rejects the key', async () => {
    listModelsMock.mockRejectedValue(Object.assign(new Error('Anthropic rejected the API key. Check that you pasted the whole key, or create a new key in the Claude Console.'), { kind: 'auth' }));
    const { responses, done } = call({ type: 'AI_CHECK_KEY', provider: 'anthropic', apiKey: 'sk-ant-wrong' });
    await done;
    expect(responses[0]).toMatchObject({ type: 'AI_KEY_CHECKED', ok: false, kind: 'auth' });
    expect((responses[0] as any).error).toContain('rejected the API key');
    expect(testConnectionMock).not.toHaveBeenCalled();
    expect(ctx.settings.ai).toBeUndefined();
  });

  it('AI_CHECK_KEY stores a working key even when the account has no credit, and says so', async () => {
    testConnectionMock.mockResolvedValue({ ok: false, kind: 'credit', error: 'Anthropic accepted the key, but the account has no credit left. Add credit in the Claude Console, then check again.' });
    const { responses, done } = call({ type: 'AI_CHECK_KEY', provider: 'anthropic', apiKey: 'sk-ant-nocredit' });
    await done;
    expect(responses[0]).toMatchObject({ type: 'AI_KEY_CHECKED', ok: false, kind: 'credit', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] });
    expect(ctx.settings.ai.keys.anthropic).toMatchObject({ apiKeyEnc: 'enc:sk-ant-nocredit', lastTest: { ok: false } });
  });

  it('AI_CHECK_KEY with a model and no key re-checks the stored key', async () => {
    ctx.settings.ai = { provider: 'anthropic', model: 'claude-opus-5-5', keys: { anthropic: { apiKeyEnc: 'enc:stored', model: 'claude-opus-5-5' } } };
    await call({ type: 'AI_CHECK_KEY', provider: 'anthropic', model: 'claude-sonnet-5-5' }).done;
    expect(testConnectionMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5-5' }), 'stored');
    expect(ctx.settings.ai).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(ctx.settings.ai.keys.anthropic.apiKeyEnc).toBe('enc:stored');
  });

  it('AI_CHECK_KEY reports a missing host permission before any request', async () => {
    (globalThis as any).chrome = { permissions: { contains: vi.fn(async () => false) } };
    try {
      const { responses, done } = call({ type: 'AI_CHECK_KEY', provider: 'deepseek', apiKey: 'sk-0123456789abcdef0123' });
      await done;
      expect(responses[0]).toMatchObject({ type: 'AI_KEY_CHECKED', ok: false, kind: 'permission' });
      expect((responses[0] as any).error).toBe('Companion has no permission to reach api.deepseek.com. Select Check key and allow it in the browser prompt.');
      expect(listModelsMock).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as any).chrome;
    }
  });

  it('AI_SAVE_CUSTOM_PROVIDER encrypts the imported key and stores only sanitized metadata', async () => {
    ctx.settings.ai = { provider: 'anthropic', model: 'claude-opus-5-5', keys: { anthropic: { apiKeyEnc: 'enc:a' } } };
    const json = JSON.stringify({
      name: 'Gateway', vendor: 'gateway', apiKey: 'plain-secret', apiType: 'openai',
      models: [
        { id: 'no-tools', name: 'No tools', url: 'https://gateway.test/v1', toolCalling: false },
        { id: 'agent', name: 'Agent', url: 'https://gateway.test/v1', toolCalling: true, maxOutputTokens: 8000 },
      ],
    });
    const { responses, done } = call({ type: 'AI_SAVE_CUSTOM_PROVIDER', json });
    await done;
    expect(ctx.settings.ai).toMatchObject({ provider: 'custom', model: 'agent', keys: { custom: { apiKeyEnc: 'enc:plain-secret' }, anthropic: { apiKeyEnc: 'enc:a' } } });
    expect(ctx.settings.ai.customProvider).toMatchObject({ name: 'Gateway', vendor: 'gateway', apiType: 'openai' });
    expect(JSON.stringify(ctx.settings.ai.customProvider)).not.toContain('plain-secret');
    expect(responses[0]).toMatchObject({ type: 'AI_CONFIG_SAVED', ok: true, provider: 'custom', model: 'agent' });
    expect(JSON.stringify(responses[0])).not.toContain('plain-secret');
    expect(sentBroadcasts).toContainEqual(expect.objectContaining({ type: 'AI_CONFIG_CHANGED', provider: 'custom', model: 'agent' }));
  });

  it('AI_REMOVE_KEY removes only that provider key', async () => {
    ctx.settings.ai = {
      provider: 'openai', model: 'gpt-5.2',
      keys: { openai: { apiKeyEnc: 'enc:x' }, anthropic: { apiKeyEnc: 'enc:y' } },
    };
    const { responses, done } = call({ type: 'AI_REMOVE_KEY', provider: 'openai' });
    await done;
    expect(ctx.settings.ai.keys).toEqual({ anthropic: { apiKeyEnc: 'enc:y' } });
    expect(responses[0]).toMatchObject({ type: 'AI_CONFIG_SAVED', ok: true, configured: false });
    // Removal is broadcast too, so surfaces hide the assistant live.
    expect(sentBroadcasts).toContainEqual(expect.objectContaining({ type: 'AI_CONFIG_CHANGED', configured: false }));
  });

  it('AI_SET_WEB_ACCESS stores the switch without touching keys', async () => {
    ctx.settings.ai = { provider: 'anthropic', model: 'claude-opus-5-5', keys: { anthropic: { apiKeyEnc: 'enc:a' } } };
    await call({ type: 'AI_SET_WEB_ACCESS', on: false }).done;
    expect(ctx.settings.ai).toMatchObject({ webAccess: false, keys: { anthropic: { apiKeyEnc: 'enc:a' } } });
  });

  it('AI_TEST records the last check on the active provider entry', async () => {
    ctx.settings.ai = { provider: 'anthropic', model: 'claude-opus-5-5', keys: { anthropic: { apiKeyEnc: 'enc:k', model: 'claude-opus-5-5' } } };
    const { responses, done } = call({ type: 'AI_TEST' });
    await done;
    expect(responses[0]).toMatchObject({ type: 'AI_TEST_RESULT', ok: true, model: 'claude-opus-5-5' });
    expect(ctx.settings.ai.keys.anthropic.lastTest).toMatchObject({ ok: true, model: 'claude-opus-5-5' });
  });

  it('AI_CANCEL aborts the in-flight request and suppresses the error broadcast', async () => {
    ctx.settings.ai = { provider: 'anthropic', model: 'm', keys: { anthropic: { apiKeyEnc: 'enc:k' } } };
    const payload = { requestId: 'req-1', intent: 'ask' as const, lang: 'extended' as const, code: 'x', selection: null, instruction: 'go', context: {} };
    getHandler('AI_REQUEST')({ type: 'AI_REQUEST', payload }, () => {}, { isOneShot: true });
    // Let the handler reach streamCompletion (through the mocked decrypt await).
    await new Promise(r => setTimeout(r, 0));
    expect(recordedSignal).not.toBeNull();
    expect(recordedSignal!.aborted).toBe(false);

    getHandler('AI_CANCEL')({ type: 'AI_CANCEL', requestId: 'req-1' }, () => {}, { isOneShot: true });
    await new Promise(r => setTimeout(r, 0));

    expect(recordedSignal!.aborted).toBe(true);
    // No AI_ERROR after a user cancel.
    expect(sentBroadcasts.some(m => m.type === 'AI_ERROR')).toBe(false);
    expect(sentBroadcasts.some(m => m.type === 'AI_DONE')).toBe(false);
  });

  it('records provider usage and elapsed timing from an AI chat turn', async () => {
    ctx.settings.ai = { provider: 'openai', model: 'gpt-5.2', keys: { openai: { apiKeyEnc: 'enc:k' } } };
    streamChatMock.mockResolvedValue({
      durationMs: 260, providerRequests: 2, providerDurationMs: 175,
      inputTokens: 800, cachedInputTokens: 240, cacheWriteTokens: 0,
      outputTokens: 120, reasoningTokens: 30,
      modelRetries: 1, emptyResponseRetries: 0, previewRepairRetries: 1,
      toolRounds: 0, toolCallsRequested: 2, toolCallsExecuted: 2, automaticToolCalls: 2,
      previewDurationMs: 85, modelToolDurationMs: 0, duplicateCalls: 0, toolErrors: 0,
      budgetExhausted: false, tools: [],
    });
    const message = {
      type: 'AI_CHAT_SEND', requestId: 'chat-metrics', text: 'Change this object.', history: [],
      envelope: { v: 1, server: { id: 'server', url: 'https://bmp.test/' }, sources: [] },
    } as any;

    await getHandler('AI_CHAT_SEND')(message, () => {}, { isOneShot: true });

    expect(streamChatMock).toHaveBeenCalledOnce();
    expect(ctx.logActivity).toHaveBeenCalledWith(
      'info', 'AI chat (gpt-5.2)',
      expect.stringContaining('"inputTokens":800'),
      expect.objectContaining({ category: 'system', action: 'ai-eval-trace', durationMs: 260 }),
    );
  });

  it('aborts an AI chat exactly at the 45-second deadline and forwards the timeout event', async () => {
    vi.useFakeTimers();
    try {
      ctx.settings.ai = { provider: 'openai', model: 'gpt-5.2', keys: { openai: { apiKeyEnc: 'enc:k' } } };
      let signal: AbortSignal | undefined;
      streamChatMock.mockImplementation(({ signal: requestSignal, onEvent }: any) => new Promise(resolve => {
        signal = requestSignal;
        requestSignal.addEventListener('abort', () => {
          onEvent({ kind: 'error', message: (requestSignal.reason as Error).message });
          resolve(null);
        });
      }));
      const message = {
        type: 'AI_CHAT_SEND', requestId: 'chat-timeout', text: 'Explain this setting.', history: [],
        envelope: { v: 1, server: { id: 'server', url: 'https://bmp.test/' }, sources: [] },
      } as any;

      const done = getHandler('AI_CHAT_SEND')(message, () => {}, { isOneShot: true });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;

      expect(signal?.aborted).toBe(true);
      expect(sentBroadcasts).toContainEqual({
        type: 'AI_CHAT_EVENT', requestId: 'chat-timeout',
        event: { kind: 'error', message: 'The AI request exceeded 45 seconds and was stopped. Nothing was executed.' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
