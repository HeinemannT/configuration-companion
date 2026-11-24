/**
 * Provider metadata — base URLs, host-permission origins, default + suggested
 * models. Pure data with no runtime dependencies, so it is safe to import from
 * the service worker (client, handler), the low-level site-access module, and
 * the sidepanel UI alike.
 */

import type { AiApiType, AiCustomProvider, AiMaxTokensParam, AiProviderId, AiProviderKey, AiSettings } from './types';

export type BuiltinProviderId = Exclude<AiProviderId, 'custom'>;

export interface ProviderMeta {
  id: AiProviderId;
  label: string;
  /** Base URL. For OpenAI-compatible providers this already includes `/v1`;
   *  the request appends `/chat/completions`. For Anthropic the request appends
   *  `/v1/messages`. */
  baseUrl: string;
  /** Host-permission match pattern requested when a key is saved. */
  origin: string;
  /** Suggested default model (editable). */
  defaultModel: string;
  /** Static suggestion list for the model datalist. */
  suggestedModels: string[];
  /** True for the OpenAI `/chat/completions` dialect (openai / deepseek / grok). */
  openAiCompat: boolean;
  /** Optional selected-model limits from a custom catalogue. */
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** OpenAI-compatible output-limit field. Defaults to max_completion_tokens. */
  maxTokensParam?: AiMaxTokensParam;
  /** True only for the first-party Anthropic API: its server-side web search
   *  and web fetch tools, refusal fallbacks and current API version. Custom
   *  Anthropic-compatible endpoints are proxies that may not implement them. */
  firstPartyAnthropic?: boolean;
  /** Where the user manages keys and credit, for error copy. */
  console?: string;
}

export const PROVIDERS: Record<BuiltinProviderId, ProviderMeta> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    origin: 'https://api.anthropic.com/*',
    // Anthropic's current default model (claude-api skill, 2026-11).
    defaultModel: 'claude-opus-5-5',
    suggestedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    openAiCompat: false,
    firstPartyAnthropic: true,
    console: 'Claude Console',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    origin: 'https://api.openai.com/*',
    // Static fallbacks only. The live model list is preferred.
    defaultModel: 'gpt-5.2',
    suggestedModels: ['gpt-5.2', 'gpt-5-mini'],
    openAiCompat: true,
    maxTokensParam: 'max_completion_tokens',
    console: 'OpenAI dashboard',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    origin: 'https://api.deepseek.com/*',
    defaultModel: 'deepseek-v4-flash',
    suggestedModels: ['deepseek-v4-flash', 'deepseek-chat'],
    openAiCompat: true,
    maxTokensParam: 'max_tokens',
    console: 'DeepSeek platform',
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    baseUrl: 'https://api.x.ai/v1',
    origin: 'https://api.x.ai/*',
    defaultModel: 'grok-4',
    suggestedModels: ['grok-4'],
    openAiCompat: true,
    maxTokensParam: 'max_completion_tokens',
    console: 'xAI console',
  },
};

export const AI_PROVIDER_IDS: BuiltinProviderId[] = ['anthropic', 'openai', 'deepseek', 'grok'];

// ── Per-provider keys (settings schema v5) ───────────────────────

/** The active provider's encrypted key, or '' when it has none. */
export function activeKeyEnc(ai: AiSettings | undefined): string {
  return ai?.keys?.[ai.provider]?.apiKeyEnc ?? '';
}

/** True when the active provider has a key: the assistant is available. */
export function hasActiveKey(ai: AiSettings | undefined): boolean {
  return !!activeKeyEnc(ai);
}

/** AI settings as a page may see them: each provider's key is only the
 *  marker 'set'. Fields are listed, not spread, so a key-bearing field added
 *  later cannot slip through. */
export function redactAiSettings(ai: AiSettings): AiSettings {
  const keys: AiSettings['keys'] = {};
  for (const [id, entry] of Object.entries(ai.keys ?? {}) as Array<[AiProviderId, AiProviderKey | undefined]>) {
    if (!entry?.apiKeyEnc) continue;
    keys[id] = {
      apiKeyEnc: 'set',
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.lastTest ? { lastTest: { ...entry.lastTest } } : {}),
    };
  }
  return {
    provider: ai.provider,
    model: ai.model,
    keys,
    ...(ai.customProvider ? { customProvider: ai.customProvider } : {}),
    ...(ai.webAccess !== undefined ? { webAccess: ai.webAccess } : {}),
  };
}

/** Providers that keep a key, in display order. */
export function keyedProviders(ai: AiSettings | undefined): AiProviderId[] {
  const ids: AiProviderId[] = [...AI_PROVIDER_IDS, 'custom'];
  return ids.filter(id => !!ai?.keys?.[id]?.apiKeyEnc);
}

/** Display name of a provider, including the custom catalogue's own name. */
export function providerLabel(id: AiProviderId, custom?: AiCustomProvider): string {
  return id === 'custom' ? custom?.name ?? 'Custom endpoint' : PROVIDERS[id].label;
}

/** Key prefixes that identify a provider without doubt. DeepSeek keys and
 *  legacy OpenAI keys both start with a bare `sk-`, so those are not guessed. */
const KEY_PREFIXES: Array<[prefix: string, provider: BuiltinProviderId]> = [
  ['sk-ant-', 'anthropic'],
  ['xai-', 'grok'],
  ['sk-proj-', 'openai'],
  ['sk-svcacct-', 'openai'],
];

/** The provider a pasted key belongs to, when its prefix says so. */
export function providerFromKey(key: string): BuiltinProviderId | null {
  const trimmed = key.trim();
  for (const [prefix, provider] of KEY_PREFIXES) {
    if (trimmed.startsWith(prefix)) return provider;
  }
  return null;
}

/** Model ids from a provider's live list that can serve a chat with tools.
 *  OpenAI lists embeddings, speech, image and moderation models too. */
export function chatModels(provider: AiProviderId, ids: readonly string[]): string[] {
  const unique = [...new Set(ids.filter(Boolean))];
  if (provider === 'openai') {
    return unique
      .filter(id => /^(gpt-|o\d|chatgpt-)/.test(id))
      .filter(id => !/(embedding|tts|whisper|dall-e|image|audio|realtime|transcribe|moderation|search|instruct)/.test(id))
      .sort();
  }
  if (provider === 'grok') return unique.filter(id => !/(image|imagine|vision-beta)/.test(id)).sort();
  if (provider === 'anthropic') return unique; // the Models API already lists newest first
  return unique.sort();
}

/** The model to preselect: the one last used with this provider if it is
 *  still offered, then the provider's suggestions in order, then the first. */
export function pickDefaultModel(provider: BuiltinProviderId, models: readonly string[], lastUsed?: string): string {
  if (lastUsed && models.includes(lastUsed)) return lastUsed;
  const meta = PROVIDERS[provider];
  for (const preferred of [meta.defaultModel, ...meta.suggestedModels]) {
    if (models.includes(preferred)) return preferred;
  }
  return models[0] ?? lastUsed ?? meta.defaultModel;
}

// ── Anthropic model traits ───────────────────────────────────────

export interface AnthropicModelTraits {
  /** `tool_choice` `any` / `tool` is accepted. Claude Fable 5.1/5.2, Mythos
   *  5.1/5.2, Opus 5.5 and Sonnet 5.5 reject it with a 400. */
  forcedToolChoice: boolean;
  /** Thinking runs when the request omits `thinking`, so `max_tokens` needs
   *  headroom for it. */
  thinksByDefault: boolean;
  /** `output_config.effort` is accepted. */
  effort: boolean;
  /** Server-side refusal fallback (`fallbacks: "default"`) is offered. */
  fallbacks: boolean;
  /** Web tool versions this model takes. The 20260209 versions add dynamic
   *  filtering; older models take the basic web search only. */
  webSearchTool: 'web_search_20260209' | 'web_search_20250305';
  webFetchTool: 'web_fetch_20260209' | null;
}

const NEW_TOOL_CHOICE_RULES = /^claude-(fable-5-[12]|mythos-5-[12]|opus-5-5|sonnet-5-5)(?![-\w])/;
const THINKS_BY_DEFAULT = /^claude-(fable-5|mythos-5|opus-5|sonnet-5|sonnet-5-5|haiku-5-5)(?![\w])/;
const EFFORT = /^claude-(fable-5|mythos-5|opus-5|opus-4-[5-9]|sonnet-5|sonnet-4-6|haiku-5-5)(?![\w])/;
const FALLBACKS = /^claude-(fable-5-[12]|fable-5|opus-5-5|opus-5|sonnet-5-5)(?![-\w])/;
const DYNAMIC_WEB_TOOLS = /^claude-(fable-5|mythos-5|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-6)(?![\w])/;

/** What a Claude model id accepts. Unknown ids get the conservative set. */
export function anthropicModelTraits(model: string): AnthropicModelTraits {
  const id = model.trim().toLowerCase();
  const dynamicWeb = DYNAMIC_WEB_TOOLS.test(id);
  return {
    forcedToolChoice: !NEW_TOOL_CHOICE_RULES.test(id),
    thinksByDefault: THINKS_BY_DEFAULT.test(id),
    effort: EFFORT.test(id),
    fallbacks: FALLBACKS.test(id),
    webSearchTool: dynamicWeb ? 'web_search_20260209' : 'web_search_20250305',
    webFetchTool: dynamicWeb ? 'web_fetch_20260209' : null,
  };
}

/** Whether the provider can give the chat web access. Only the first-party
 *  Anthropic API has comparable server-side tools; the chat/completions
 *  dialect has none, and custom endpoints are not assumed to have them. */
export function webAccessSupported(meta: Pick<ProviderMeta, 'firstPartyAnthropic'>): boolean {
  return !!meta.firstPartyAnthropic;
}

/** Web access is on for these settings: supported and not switched off. */
export function webAccessEnabled(ai: AiSettings | undefined): boolean {
  if (!ai || ai.webAccess === false) return false;
  try { return webAccessSupported(resolveProvider(ai)); } catch { return false; }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function optionalMaxTokensParam(value: unknown, field: string): AiMaxTokensParam | undefined {
  if (value === undefined) return undefined;
  if (value !== 'max_tokens' && value !== 'max_completion_tokens') {
    throw new Error(`${field} must be "max_tokens" or "max_completion_tokens"`);
  }
  return value;
}

function apiBaseUrl(value: unknown, field: string): string {
  const raw = nonEmptyString(value, field).replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${field} must be a valid URL`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${field} must use http or https`);
  return raw;
}

/**
 * True when an AI provider address would send the API key and the prompt in
 * plain text: it parses, uses `http:`, and does not point at this machine
 * (`localhost`, 127.0.0.0/8, `[::1]`). Local models stay quiet. Text that is
 * not yet a valid URL is not judged here; the save path reports that.
 */
export function isPlainTextAiAddress(address: string): boolean {
  let parsed: URL;
  try { parsed = new URL(address.trim()); } catch { return false; }
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === '[::1]') return false;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets && octets[1] === '127' && octets.slice(2).every(o => Number(o) <= 255)) return false;
  return true;
}

export const PLAIN_TEXT_AI_ADDRESS_WARNING =
  'This address is not encrypted: the API key and the content you send travel in plain text.';

/** Parse the technical-user JSON format. The returned provider is safe to
 * persist; the plaintext key is returned separately for immediate encryption. */
export function parseCustomProviderJson(json: string): { provider: AiCustomProvider; apiKey?: string } {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Provider JSON must be an object');
  const input = raw as Record<string, unknown>;
  const apiType = input.apiType;
  if (apiType !== 'openai' && apiType !== 'anthropic') throw new Error('apiType must be "openai" or "anthropic"');
  if (!Array.isArray(input.models) || input.models.length === 0) throw new Error('models must contain at least one model');
  const models = input.models.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`models[${index}] must be an object`);
    const model = item as Record<string, unknown>;
    if (typeof model.toolCalling !== 'boolean') throw new Error(`models[${index}].toolCalling must be true or false`);
    if (model.vision !== undefined && typeof model.vision !== 'boolean') throw new Error(`models[${index}].vision must be true or false`);
    return {
      id: nonEmptyString(model.id, `models[${index}].id`),
      name: nonEmptyString(model.name, `models[${index}].name`),
      url: apiBaseUrl(model.url, `models[${index}].url`),
      toolCalling: model.toolCalling,
      ...(model.vision !== undefined ? { vision: model.vision } : {}),
      ...(optionalPositiveInteger(model.maxInputTokens, `models[${index}].maxInputTokens`) !== undefined
        ? { maxInputTokens: model.maxInputTokens as number } : {}),
      ...(optionalPositiveInteger(model.maxOutputTokens, `models[${index}].maxOutputTokens`) !== undefined
        ? { maxOutputTokens: model.maxOutputTokens as number } : {}),
      ...(optionalMaxTokensParam(model.maxTokensParam, `models[${index}].maxTokensParam`) !== undefined
        ? { maxTokensParam: model.maxTokensParam as AiMaxTokensParam } : {}),
    };
  });
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('Model ids must be unique');
  if (!models.some(model => model.toolCalling)) throw new Error('At least one model must support tool calling');
  const key = input.apiKey;
  if (key !== undefined && typeof key !== 'string') throw new Error('apiKey must be a string');
  return {
    provider: {
      name: nonEmptyString(input.name, 'name'),
      vendor: nonEmptyString(input.vendor, 'vendor'),
      apiType: apiType as AiApiType,
      models,
    },
    ...(typeof key === 'string' && key.trim() ? { apiKey: key.trim() } : {}),
  };
}

/** Resolve the selected settings into the same runtime shape as a built-in. */
export function resolveProvider(settings: Pick<AiSettings, 'provider' | 'model' | 'customProvider'>): ProviderMeta {
  if (settings.provider !== 'custom') return PROVIDERS[settings.provider];
  const custom = settings.customProvider;
  if (!custom) throw new Error('Custom provider configuration is missing');
  const model = custom.models.find(item => item.id === settings.model);
  if (!model) throw new Error(`Model "${settings.model}" is not in the custom provider JSON`);
  if (!model.toolCalling) throw new Error(`Model "${settings.model}" does not support tool calling`);
  return {
    id: 'custom',
    label: custom.name,
    baseUrl: model.url,
    origin: `${new URL(model.url).origin}/*`,
    defaultModel: custom.models.find(item => item.toolCalling)?.id ?? custom.models[0].id,
    suggestedModels: custom.models.filter(item => item.toolCalling).map(item => item.id),
    openAiCompat: custom.apiType === 'openai',
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    maxTokensParam: model.maxTokensParam,
  };
}

export function customProviderOrigins(provider: AiCustomProvider | undefined): string[] {
  if (!provider) return [];
  return [...new Set(provider.models.map(model => `${new URL(model.url).origin}/*`))];
}
