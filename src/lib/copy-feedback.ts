/**
 * Clipboard copy with honest feedback: "Copied" appears only after the
 * clipboard write succeeded, and a failed write (blocked permission, no
 * focus, no clipboard API) shows "Copy failed" instead of nothing.
 *
 * Shared by the hover card (object-card.ts) and the object window.
 */

import { showToast } from './toast';

export type CopyReason = 'ok' | 'insecure' | 'blocked' | 'no-api';

export interface CopyResult {
  ok: boolean;
  reason: CopyReason;
}

/** One sentence per failure reason; the single source for every copy surface. */
export const COPY_FAILURE_MESSAGES: Record<Exclude<CopyReason, 'ok'>, string> = {
  insecure: 'Copy failed: this page is not secure (http), so the browser blocks the clipboard.',
  blocked: 'Copy failed: the browser blocked clipboard access.',
  'no-api': 'Copy failed: this browser has no clipboard access here.',
};

/** The sentence for a failed copy ('' for a successful one). */
export function copyFailureMessage(reason: CopyReason): string {
  return reason === 'ok' ? '' : COPY_FAILURE_MESSAGES[reason];
}

export interface CopyEnv {
  clipboard?: { writeText?: (text: string) => Promise<void> } | null;
  /** `window.isSecureContext`; only an explicit `false` counts as insecure. */
  isSecureContext?: boolean;
  /** Synchronous fallback (textarea + execCommand); omit to disable. */
  legacyCopy?: ((text: string) => boolean) | null;
}

/** Copy through a temporary textarea and `document.execCommand('copy')`. */
export function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function' || !document.body) return false;
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  document.body.append(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    try { previous?.focus?.(); } catch { /* element gone */ }
  }
}

function defaultEnv(): CopyEnv {
  return {
    clipboard: typeof navigator === 'undefined' ? null : navigator.clipboard,
    isSecureContext: typeof window === 'undefined' ? undefined : window.isSecureContext,
    legacyCopy,
  };
}

/** Write `text` to the clipboard and say why it failed, if it did. */
export async function copyTextResult(text: string, env: CopyEnv = defaultEnv()): Promise<CopyResult> {
  const api = env.clipboard?.writeText ? env.clipboard : null;
  let reason: CopyReason;
  if (api) {
    try {
      await api.writeText!(text);
      return { ok: true, reason: 'ok' };
    } catch {
      reason = 'blocked';
    }
  } else {
    reason = env.isSecureContext === false ? 'insecure' : 'no-api';
  }
  // The async API is missing or refused: the synchronous path still works on
  // insecure pages and when focus rules reject the async call.
  try {
    if (env.legacyCopy?.(text)) return { ok: true, reason: 'ok' };
  } catch { /* keep the original reason */ }
  return { ok: false, reason };
}

/** Write `text` to the clipboard. Resolves true only when the write succeeded. */
export async function copyText(text: string): Promise<boolean> {
  return (await copyTextResult(text)).ok;
}

export interface CopyToastOptions {
  /** Success message; default "Copied". */
  okMessage?: string;
  /** Monospace value shown after the success message. */
  detail?: string;
  /** Replaces a toast with the same key. */
  key?: string;
  /** Injected for tests. */
  write?: (text: string) => Promise<CopyResult>;
}

/** Copy `text` and report the result as a toast. Returns the result. */
export async function copyWithToast(text: string, opts: CopyToastOptions = {}): Promise<CopyResult> {
  const result = await (opts.write ?? copyTextResult)(text);
  if (result.ok) showToast(opts.okMessage ?? COPY_OK_TEXT, 'success', undefined, { key: opts.key, detail: opts.detail });
  else showToast(copyFailureMessage(result.reason), 'error', undefined, { key: opts.key });
  return result;
}

export const COPY_OK_TEXT = 'Copied';
export const COPY_FAILED_TEXT = 'Copy failed';

export interface CopyFeedbackOptions {
  /** How long the feedback stays (ms). */
  ms?: number;
  /** Replace this element's text with the result, then restore it. */
  textTarget?: HTMLElement;
  /** Classes added to `target` for the result (removed afterwards). */
  okClass?: string;
  failClass?: string;
  /** Injected for tests. */
  write?: (text: string) => Promise<boolean>;
  /** Injected for tests: like `write`, but with the failure reason. */
  writeResult?: (text: string) => Promise<CopyResult>;
}

/** Copy `text` and show the result on `target`. Returns whether it worked. */
export async function copyWithFeedback(text: string, target: HTMLElement, opts: CopyFeedbackOptions = {}): Promise<boolean> {
  const result: CopyResult = opts.write
    ? ((await opts.write(text)) ? { ok: true, reason: 'ok' } : { ok: false, reason: 'blocked' })
    : await (opts.writeResult ?? copyTextResult)(text);
  const ok = result.ok;
  const sentence = copyFailureMessage(result.reason);
  const cls = ok ? opts.okClass : opts.failClass;
  const label = ok ? COPY_OK_TEXT : COPY_FAILED_TEXT;
  const textTarget = opts.textTarget;
  const original = textTarget?.textContent ?? null;
  const originalTitle = target.getAttribute('title');
  if (textTarget) textTarget.textContent = label;
  if (cls) target.classList.add(cls);
  if (!ok) target.setAttribute('title', sentence);
  setTimeout(() => {
    if (textTarget && textTarget.textContent === label) textTarget.textContent = original;
    if (cls) target.classList.remove(cls);
    if (!ok) {
      if (originalTitle == null) target.removeAttribute('title');
      else target.setAttribute('title', originalTitle);
    }
  }, opts.ms ?? (ok ? 1200 : 2000));
  return ok;
}
