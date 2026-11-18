// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_DISMISS_MS, ERROR_DISMISS_MS, SHOW_IN_LOG_LABEL, setShowInLogHandler, showToast,
} from '../toast';

const toasts = () => Array.from(document.querySelectorAll<HTMLElement>('.crev-toast:not(.crev-toast--exit)'));

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  setShowInLogHandler(null);
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('toast timing', () => {
  it('keeps success and info toasts short', () => {
    showToast('Saved', 'success');
    showToast('FYI', 'info');
    vi.advanceTimersByTime(AUTO_DISMISS_MS + 400);
    expect(toasts()).toHaveLength(0);
  });

  it('keeps a long toast twice as long', () => {
    showToast('Blueprint: 1 change applied.', 'success', undefined, { long: true });
    vi.advanceTimersByTime(AUTO_DISMISS_MS + 400);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(AUTO_DISMISS_MS + 400);
    expect(toasts()).toHaveLength(0);
  });

  it('keeps an error toast for 10 seconds', () => {
    showToast('Save failed', 'error');
    vi.advanceTimersByTime(ERROR_DISMISS_MS - 100);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(100 + 400);
    expect(toasts()).toHaveLength(0);
  });

  it('pauses while the pointer is over the toast and resumes after', () => {
    showToast('Save failed', 'error');
    const toast = toasts()[0];
    vi.advanceTimersByTime(4000);
    toast.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(60_000);
    expect(toasts()).toHaveLength(1);
    toast.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(5000);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(toasts()).toHaveLength(0);
  });

  it('pauses while focus is inside the toast, and not when focus moves between its buttons', () => {
    setShowInLogHandler(() => undefined);
    showToast('Save failed', 'error');
    const toast = toasts()[0];
    const close = toast.querySelector('.crev-toast__close');
    toast.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(60_000);
    expect(toasts()).toHaveLength(1);
    toast.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: close }));
    vi.advanceTimersByTime(60_000);
    expect(toasts()).toHaveLength(1);
    toast.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    vi.advanceTimersByTime(ERROR_DISMISS_MS + 400);
    expect(toasts()).toHaveLength(0);
  });

  it('leaves a moment to read after a late pause', () => {
    showToast('Save failed', 'error');
    const toast = toasts()[0];
    vi.advanceTimersByTime(ERROR_DISMISS_MS - 50);
    toast.dispatchEvent(new MouseEvent('mouseenter'));
    toast.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(1000);
    expect(toasts()).toHaveLength(1);
  });
});

describe('error toast controls', () => {
  it('has a labelled dismiss button that removes the toast', () => {
    showToast('Save failed', 'error');
    const close = document.querySelector<HTMLButtonElement>('.crev-toast__close');
    expect(close?.getAttribute('aria-label')).toBe('Dismiss');
    close!.click();
    vi.advanceTimersByTime(400);
    expect(document.querySelector('.crev-toast')).toBeNull();
  });

  it('gives no dismiss button to success and info toasts', () => {
    showToast('Saved', 'success');
    showToast('FYI', 'info');
    expect(document.querySelector('.crev-toast__close')).toBeNull();
  });

  it('keeps the alert role and key replacement', () => {
    showToast('Save failed', 'error', undefined, { key: 'k' });
    showToast('Save failed again', 'error', undefined, { key: 'k' });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].getAttribute('role')).toBe('alert');
  });

  it('shows at most three toasts', () => {
    for (let i = 0; i < 5; i++) showToast(`E${i}`, 'error');
    expect(toasts()).toHaveLength(3);
  });

  it('offers Show in Log on an error, carrying its text, detail and Log entry', () => {
    const handler = vi.fn();
    setShowInLogHandler(handler);
    showToast('Save failed', 'error', undefined, { detail: 'rid 42', logId: 7 });
    const action = Array.from(document.querySelectorAll('button')).find(b => b.textContent === SHOW_IN_LOG_LABEL);
    action!.click();
    expect(handler).toHaveBeenCalledWith({ text: 'Save failed', detail: 'rid 42', logId: 7 });
  });

  it('offers Show in Log on no other kind, nor when switched off', () => {
    setShowInLogHandler(vi.fn());
    showToast('Saved', 'success');
    showToast('Could not copy', 'error', undefined, { showInLog: false });
    expect(Array.from(document.querySelectorAll('button')).some(b => b.textContent === SHOW_IN_LOG_LABEL)).toBe(false);
  });

  it('keeps an explicit action instead of Show in Log', () => {
    setShowInLogHandler(vi.fn());
    showToast('Saved elsewhere', 'error', { label: 'Reload', onClick: vi.fn() });
    const labels = Array.from(document.querySelectorAll('button')).map(b => b.textContent);
    expect(labels).toContain('Reload');
    expect(labels).not.toContain(SHOW_IN_LOG_LABEL);
  });
});
