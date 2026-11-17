/**
 * @vitest-environment happy-dom
 *
 * The toast container must carry position:fixed INLINE. toast.ts is shared
 * between the content script and the side panel; in the content script a
 * connection toast can fire before any overlay stylesheet is injected
 * (pre-Inspect). Without inline position the container would fall into normal
 * page flow at the bottom — the same "bottom-left leak" class as the overlays.
 * Only `position` is inlined (the coords differ per context and stay in CSS).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { showToast, truncateMiddle } from '../toast';

describe('toast container positioning', () => {
  afterEach(() => {
    document.getElementById('crev-toast-container')?.remove();
    vi.restoreAllMocks();
  });

  it('sets position:fixed inline, so it floats with no stylesheet present', () => {
    expect(document.getElementById('crev-toast-container')).toBeNull();
    showToast('probe', 'info');
    const container = document.getElementById('crev-toast-container') as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.style.position).toBe('fixed');
  });

  it('sets z-index inline and is a polite live region that never takes focus', () => {
    const before = document.activeElement;
    showToast('probe', 'info');
    const container = document.getElementById('crev-toast-container') as HTMLElement;
    expect(container.style.zIndex).toBe('2147483647');
    expect(container.getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement).toBe(before);
  });

  it('makes an error toast an alert', () => {
    showToast('failed', 'error');
    expect(document.querySelector('.crev-toast--error')?.getAttribute('role')).toBe('alert');
    showToast('ok', 'success');
    expect(document.querySelector('.crev-toast--success')?.hasAttribute('role')).toBe(false);
  });

  it('replaces a toast with the same key instead of stacking', () => {
    showToast('Copied RID', 'success', undefined, { key: 'copy', detail: '1' });
    showToast('Copied ID', 'success', undefined, { key: 'copy', detail: '2' });
    showToast('Other', 'info');
    const texts = [...document.querySelectorAll('.crev-toast')].map(t => t.textContent);
    expect(texts).toEqual(['Copied ID2', 'Other']);
  });

  it('shortens a long value in the middle and keeps the full value as the title', () => {
    const rid = '6655481628892308703665548162889230870399';
    showToast('Copied RID', 'success', undefined, { detail: rid });
    const detail = document.querySelector('.crev-toast__detail')!.textContent!;
    expect(detail.length).toBe(36);
    expect(detail.startsWith('665548')).toBe(true);
    expect(detail.endsWith('870399')).toBe(true);
    expect(detail).toContain('…');
    expect((document.querySelector('.crev-toast') as HTMLElement).title).toBe(rid);
    expect(truncateMiddle('short')).toBe('short');
  });
});
