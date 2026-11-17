import { describe, it, expect } from 'vitest';
import { PROVIDERS, AI_PROVIDER_IDS, customProviderOrigins, parseCustomProviderJson, resolveProvider, isPlainTextAiAddress } from '../providers';

describe('providers', () => {
  it('lists the four supported providers', () => {
    expect(AI_PROVIDER_IDS).toEqual(['anthropic', 'openai', 'deepseek', 'grok']);
  });

  it('marks the three OpenAI-compatible providers', () => {
    expect(PROVIDERS.anthropic.openAiCompat).toBe(false);
    expect(PROVIDERS.openai.openAiCompat).toBe(true);
    expect(PROVIDERS.deepseek.openAiCompat).toBe(true);
    expect(PROVIDERS.grok.openAiCompat).toBe(true);
  });

  it('uses the current token-limit field while retaining DeepSeek compatibility', () => {
    expect(PROVIDERS.openai.maxTokensParam).toBe('max_completion_tokens');
    expect(PROVIDERS.grok.maxTokensParam).toBe('max_completion_tokens');
    expect(PROVIDERS.deepseek.maxTokensParam).toBe('max_tokens');
  });

  it('uses DeepSeek V4 Flash for new configurations while retaining the legacy alias as a suggestion', () => {
    expect(PROVIDERS.deepseek.defaultModel).toBe('deepseek-v4-flash');
    expect(PROVIDERS.deepseek.suggestedModels).toContain('deepseek-chat');
  });

  it('has a default model in each suggestion list', () => {
    for (const id of AI_PROVIDER_IDS) {
      const p = PROVIDERS[id];
      expect(p.suggestedModels).toContain(p.defaultModel);
    }
  });

  it('parses one custom provider and separates its plaintext key', () => {
    const parsed = parseCustomProviderJson(JSON.stringify({
      name: 'Local Gateway', vendor: 'gateway', apiKey: ' secret ', apiType: 'openai',
      models: [{ id: 'model-a', name: 'Model A', url: 'https://ai.example.test/v1/', toolCalling: true, vision: false, maxInputTokens: 32000, maxOutputTokens: 4096, maxTokensParam: 'max_completion_tokens' }],
    }));
    expect(parsed.apiKey).toBe('secret');
    expect(parsed.provider).toEqual({
      name: 'Local Gateway', vendor: 'gateway', apiType: 'openai',
      models: [{ id: 'model-a', name: 'Model A', url: 'https://ai.example.test/v1', toolCalling: true, vision: false, maxInputTokens: 32000, maxOutputTokens: 4096, maxTokensParam: 'max_completion_tokens' }],
    });
    expect(JSON.stringify(parsed.provider)).not.toContain('secret');
  });

  it('resolves the selected custom model dialect, URL, origin and output limit', () => {
    const customProvider = parseCustomProviderJson(JSON.stringify({
      name: 'Messages Proxy', vendor: 'proxy', apiType: 'anthropic',
      models: [{ id: 'claude', name: 'Claude', url: 'https://proxy.example.test', toolCalling: true, maxOutputTokens: 12000, maxTokensParam: 'max_completion_tokens' }],
    })).provider;
    expect(resolveProvider({ provider: 'custom', model: 'claude', customProvider })).toMatchObject({
      label: 'Messages Proxy', baseUrl: 'https://proxy.example.test', origin: 'https://proxy.example.test/*', openAiCompat: false, maxOutputTokens: 12000, maxTokensParam: 'max_completion_tokens',
    });
    expect(customProviderOrigins(customProvider)).toEqual(['https://proxy.example.test/*']);
  });

  it('rejects unusable custom catalogues', () => {
    expect(() => parseCustomProviderJson('{bad')).toThrow('Invalid JSON');
    expect(() => parseCustomProviderJson(JSON.stringify({ name: 'X', vendor: 'x', apiType: 'responses', models: [] }))).toThrow('apiType');
    expect(() => parseCustomProviderJson(JSON.stringify({
      name: 'X', vendor: 'x', apiType: 'openai',
      models: [{ id: 'm', name: 'M', url: 'https://x.test/v1', toolCalling: false }],
    }))).toThrow('At least one model must support tool calling');
    expect(() => parseCustomProviderJson(JSON.stringify({
      name: 'X', vendor: 'x', apiType: 'openai',
      models: [{ id: 'm', name: 'M', url: 'https://x.test/v1', toolCalling: true, maxTokensParam: 'tokens' }],
    }))).toThrow('maxTokensParam');
  });

  it('refuses to run the assistant with a catalogue model that lacks tool calling', () => {
    const customProvider = parseCustomProviderJson(JSON.stringify({
      name: 'Mixed', vendor: 'mixed', apiType: 'openai',
      models: [
        { id: 'plain', name: 'Plain', url: 'https://x.test/v1', toolCalling: false },
        { id: 'agent', name: 'Agent', url: 'https://x.test/v1', toolCalling: true },
      ],
    })).provider;
    expect(() => resolveProvider({ provider: 'custom', model: 'plain', customProvider }))
      .toThrow('does not support tool calling');
  });
});

describe('isPlainTextAiAddress', () => {
  it.each([
    'http://models.example.com/v1',
    'http://10.0.0.5:8080/v1',
    'http://192.168.1.2',
    'http://128.0.0.1',
    'http://localhost.example.com',
  ])('warns for plain http to %s', (url) => {
    expect(isPlainTextAiAddress(url)).toBe(true);
  });

  it.each([
    'https://api.example.com/v1',
    'http://localhost:11434/v1',
    'http://LOCALHOST/v1',
    'http://127.0.0.1:8080',
    'http://127.12.200.9/v1',
    'http://[::1]:8080/v1',
    '  http://localhost:1234  ',
  ])('stays quiet for %s', (url) => {
    expect(isPlainTextAiAddress(url)).toBe(false);
  });

  it('does not judge empty or invalid text', () => {
    expect(isPlainTextAiAddress('')).toBe(false);
    expect(isPlainTextAiAddress('http://')).toBe(false);
    expect(isPlainTextAiAddress('not a url')).toBe(false);
  });
});
