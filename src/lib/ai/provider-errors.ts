/**
 * Provider failures in the configurator's words.
 *
 * Both dialects turn a failed HTTP response, a stream error or a refusal into
 * one ProviderError with a `kind`. The kind decides whether the request is
 * retried (http.ts) and which sentence the panel shows. Each sentence says
 * what is wrong and what to do, in the style of src/lib/connection-copy.ts.
 * The provider's own message stays in `detail` for the tooltip and the log.
 * No error text ever contains the API key: requests send it only as a header.
 */

export type ProviderErrorKind =
  | 'auth'        // the key is wrong, revoked or lacks permission
  | 'credit'      // the key works, the account has no credit or quota
  | 'model'       // the model id does not exist or is not available to the key
  | 'rate'        // rate limit, temporary
  | 'overloaded'  // provider overloaded or failing, temporary
  | 'network'     // no answer at all
  | 'permission'  // Companion has no host permission for the provider origin
  | 'refusal'     // the model declined the request
  | 'too-large'   // the request is larger than the provider accepts
  | 'other';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  /** The provider's own message, when it sent one. */
  readonly detail?: string;
  /** Delay the provider asked for before a retry, in milliseconds. */
  readonly retryAfterMs?: number;
  /** The provider's `x-should-retry` answer, when it sent one. */
  readonly shouldRetry?: boolean;

  constructor(kind: ProviderErrorKind, message: string, opts: { status?: number; detail?: string; retryAfterMs?: number; shouldRetry?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.detail = opts.detail;
    this.retryAfterMs = opts.retryAfterMs;
    this.shouldRetry = opts.shouldRetry;
  }

  /** Temporary failures that a later identical request can fix. */
  get retryable(): boolean {
    if (this.shouldRetry !== undefined) return this.shouldRetry;
    return this.kind === 'rate' || this.kind === 'overloaded' || this.kind === 'network';
  }
}

export interface ProviderErrorContext {
  /** Provider name as the user knows it ("Anthropic", "DeepSeek", a custom name). */
  provider: string;
  /** Where the user manages keys and credit ("Claude Console"). */
  console?: string;
  model?: string;
  /** Host of the provider API, for the permission sentence. */
  host?: string;
}

/** One sentence per kind: what is wrong and what to do. No em dashes. */
export function providerErrorSentence(kind: ProviderErrorKind, ctx: ProviderErrorContext, detail?: string): string {
  const where = ctx.console ? `the ${ctx.console}` : `your ${ctx.provider} account`;
  switch (kind) {
    case 'auth':
      return `${ctx.provider} rejected the API key. Check that you pasted the whole key, or create a new key in ${where}.`;
    case 'credit':
      return `${ctx.provider} accepted the key, but the account has no credit left. Add credit in ${where}, then check again.`;
    case 'model':
      return ctx.model
        ? `The model ${ctx.model} is not available for this key. Choose another model.`
        : 'This model is not available for this key. Choose another model.';
    case 'rate':
      return `${ctx.provider} is limiting requests from this key right now. Wait a minute, then try again.`;
    case 'overloaded':
      return `${ctx.provider} is overloaded right now. Try again in a minute.`;
    case 'network':
      return `Companion could not reach ${ctx.provider}. Check your network or VPN, then try again.`;
    case 'permission':
      return `Companion has no permission to reach ${ctx.host ?? ctx.provider}. Select Check key and allow it in the browser prompt.`;
    case 'refusal':
      return 'The model declined this request. Rephrase it, or ask about another part of the configuration.';
    case 'too-large':
      return 'The request is larger than the model accepts. Start a new conversation or attach less context.';
    default:
      return detail ? `${ctx.provider} returned an error: ${detail}` : `${ctx.provider} returned an error. Try again.`;
  }
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

interface ErrorBody {
  error?: { type?: string; code?: string | number; message?: string; details?: { error_code?: string } } | string;
  message?: string;
}

/** Providers sometimes quote a masked key fragment in an error message.
 *  Drop anything key-shaped so no part of a key reaches the panel or a log. */
export function redactSecrets(text: string): string {
  return text.replace(/\b(?:sk|xai|key)-[A-Za-z0-9_*-]{4,}/gi, '[key]');
}

/** Read the provider's error type and message from a JSON (or text) body. */
export function parseErrorBody(raw: string): { type: string; code: string; message: string } {
  let json: ErrorBody | null = null;
  try { json = raw ? JSON.parse(raw) as ErrorBody : null; } catch { /* plain text body */ }
  const error = typeof json?.error === 'object' ? json.error : undefined;
  const message = (typeof json?.error === 'string' ? json.error : error?.message) ?? json?.message ?? raw.slice(0, 300);
  return {
    type: String(error?.type ?? ''),
    code: String(error?.details?.error_code ?? error?.code ?? ''),
    message: redactSecrets(String(message ?? '').trim()),
  };
}

/** Classify a provider failure from its status and body. Pure; tested. */
export function classifyProviderFailure(status: number, type: string, code: string, message: string): ProviderErrorKind {
  const text = `${type} ${code} ${message}`.toLowerCase();
  if (/credit balance|insufficient_quota|insufficient balance|billing|payment required|spend limit|enforced_spend_limit|exceeded your current quota|no credits/.test(text)) return 'credit';
  if (status === 402) return 'credit';
  if (status === 401 || type === 'authentication_error' || /invalid[ _-]?api[ _-]?key|incorrect api key|invalid x-api-key/.test(text)) return 'auth';
  if (status === 403 || type === 'permission_error') {
    return /model/.test(text) ? 'model' : 'auth';
  }
  if (status === 404 || type === 'not_found_error' || code === 'model_not_found' || /model.*(not found|does not exist|not available|unknown)|(unknown|invalid) model/.test(text)) return 'model';
  if (status === 413 || type === 'request_too_large' || /prompt is too long|context length|maximum context/.test(text)) return 'too-large';
  if (status === 429 || type === 'rate_limit_error') return 'rate';
  if (status === 529 || status >= 500 || type === 'overloaded_error' || type === 'api_error') return 'overloaded';
  return 'other';
}

/** Build the error for a non-2xx response. Reads (and consumes) the body. */
export async function providerErrorFromResponse(response: Response, ctx: ProviderErrorContext): Promise<ProviderError> {
  let raw = '';
  try { raw = await response.text(); } catch { /* body already consumed */ }
  const body = parseErrorBody(raw);
  const kind = classifyProviderFailure(response.status, body.type, body.code, body.message);
  const shouldRetryHeader = response.headers?.get('x-should-retry');
  return new ProviderError(kind, providerErrorSentence(kind, ctx, body.message || `HTTP ${response.status}`), {
    status: response.status,
    detail: body.message || undefined,
    // A spend cap is a 429 with no retry-after and never heals by retrying.
    retryAfterMs: kind === 'credit' ? undefined : retryAfterMs(response.headers),
    ...(shouldRetryHeader === 'true' ? { shouldRetry: true } : shouldRetryHeader === 'false' ? { shouldRetry: false } : {}),
  });
}

/** Build the error for an `error` event inside an otherwise successful stream. */
export function providerErrorFromStream(type: string, message: string, ctx: ProviderErrorContext): ProviderError {
  message = redactSecrets(message);
  const kind = classifyProviderFailure(0, type, '', message);
  return new ProviderError(kind, providerErrorSentence(kind, ctx, message || type), { detail: message || type || undefined });
}

/** A fetch that rejected without a response: network, or an aborted request. */
export function providerErrorFromFetchFailure(error: unknown, ctx: ProviderErrorContext): unknown {
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) return error;
  if (error instanceof ProviderError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ProviderError('network', providerErrorSentence('network', ctx), { detail });
}
