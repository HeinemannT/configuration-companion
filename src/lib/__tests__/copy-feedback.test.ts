/**
 * @vitest-environment happy-dom
 *
 * The one copy path: a result with a reason, one failure sentence per reason,
 * the textarea fallback, and the toast variant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPY_FAILURE_MESSAGES,
  copyFailureMessage,
  copyTextResult,
  copyWithFeedback,
  copyWithToast,
  legacyCopy,
} from '../copy-feedback';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('copyTextResult', () => {
  it('reports ok when the async API writes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyTextResult('abc', { clipboard: { writeText }, isSecureContext: true })).toEqual({ ok: true, reason: 'ok' });
    expect(writeText).toHaveBeenCalledWith('abc');
  });

  it('reports blocked when the write is refused and there is no fallback', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    expect(await copyTextResult('abc', { clipboard: { writeText }, isSecureContext: true })).toEqual({ ok: false, reason: 'blocked' });
  });

  it('reports insecure when the API is missing on a non-secure page', async () => {
    expect(await copyTextResult('abc', { clipboard: undefined, isSecureContext: false })).toEqual({ ok: false, reason: 'insecure' });
  });

  it('reports no-api when the API is missing on a secure page', async () => {
    expect(await copyTextResult('abc', { clipboard: null, isSecureContext: true })).toEqual({ ok: false, reason: 'no-api' });
  });

  it('falls back to the synchronous copy when the API is missing', async () => {
    const fallback = vi.fn().mockReturnValue(true);
    expect(await copyTextResult('abc', { clipboard: undefined, isSecureContext: false, legacyCopy: fallback })).toEqual({ ok: true, reason: 'ok' });
    expect(fallback).toHaveBeenCalledWith('abc');
  });

  it('falls back when the API refuses, and keeps the reason if the fallback fails too', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    expect((await copyTextResult('a', { clipboard: { writeText }, legacyCopy: () => true })).ok).toBe(true);
    expect(await copyTextResult('a', { clipboard: { writeText }, legacyCopy: () => false })).toEqual({ ok: false, reason: 'blocked' });
    expect(await copyTextResult('a', { clipboard: undefined, isSecureContext: false, legacyCopy: () => { throw new Error('x'); } })).toEqual({ ok: false, reason: 'insecure' });
  });
});

describe('legacyCopy', () => {
  it('copies through a temporary textarea and removes it', () => {
    let copiedValue = '';
    (document as unknown as { execCommand: (c: string) => boolean }).execCommand = vi.fn((cmd: string) => {
      copiedValue = (document.querySelector('textarea') as HTMLTextAreaElement).value;
      return cmd === 'copy';
    });
    expect(legacyCopy('hello')).toBe(true);
    expect(copiedValue).toBe('hello');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('is false when execCommand refuses', () => {
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    expect(legacyCopy('x')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });
});

describe('failure sentences', () => {
  it('has one distinct sentence per failure reason and none for ok', () => {
    expect(copyFailureMessage('ok')).toBe('');
    const all = Object.values(COPY_FAILURE_MESSAGES);
    expect(new Set(all).size).toBe(3);
    expect(copyFailureMessage('insecure')).toBe('Copy failed: this page is not secure (http), so the browser blocks the clipboard.');
    for (const m of all) expect(m.startsWith('Copy failed:')).toBe(true);
  });
});

describe('copyWithFeedback', () => {
  it('puts the reason sentence on the target after a failure', async () => {
    vi.useFakeTimers();
    try {
      const button = document.createElement('button');
      const ok = await copyWithFeedback('x', button, { writeResult: async () => ({ ok: false, reason: 'insecure' }) });
      expect(ok).toBe(false);
      expect(button.getAttribute('title')).toBe(COPY_FAILURE_MESSAGES.insecure);
    } finally { vi.useRealTimers(); }
  });
});

describe('copyWithToast', () => {
  const toastTexts = () => [...document.querySelectorAll('.crev-toast')].map(t => t.querySelector('.crev-toast__text')?.textContent);

  it('shows a success toast after a successful copy', async () => {
    const r = await copyWithToast('abc', { okMessage: 'Copied RID', key: 'k1', write: async () => ({ ok: true, reason: 'ok' }) });
    expect(r.ok).toBe(true);
    expect(toastTexts()).toEqual(['Copied RID']);
    expect(document.querySelector('.crev-toast--success')).not.toBeNull();
  });

  it('shows the reason sentence as an error toast after a failure', async () => {
    const r = await copyWithToast('abc', { key: 'k2', write: async () => ({ ok: false, reason: 'insecure' }) });
    expect(r.ok).toBe(false);
    expect(toastTexts()).toEqual([COPY_FAILURE_MESSAGES.insecure]);
    expect(document.querySelector('.crev-toast--error')?.getAttribute('role')).toBe('alert');
  });
});
