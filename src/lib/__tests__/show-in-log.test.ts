// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COPIED_ERROR_TEXT, COPY_ERROR_FAILED_TEXT, errorDetailText, installPanelShowInLog, showInLogFromPage,
  type PageShowInLogDeps,
} from '../show-in-log';
import { setShowInLogHandler, showToast } from '../toast';
import { senderKindMay } from '../message-access';

function deps(reply: unknown, copied = true) {
  const d = {
    send: vi.fn(async () => reply),
    copy: vi.fn(async () => copied),
    toast: vi.fn(),
  };
  return d as typeof d & PageShowInLogDeps;
}

describe('Show in Log from a page', () => {
  it('asks the worker and does not copy when the panel opened', async () => {
    const d = deps({ type: 'SHOW_IN_LOG_RESULT', opened: true, logId: 3 });
    expect(await showInLogFromPage({ text: 'Save failed', detail: 'why', logId: 3 }, d)).toBe(true);
    expect(d.send).toHaveBeenCalledWith({ type: 'SHOW_IN_LOG', text: 'Save failed', detail: 'why', logId: 3 });
    expect(d.copy).not.toHaveBeenCalled();
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('copies the error and says so when the panel could not be opened', async () => {
    const d = deps({ type: 'SHOW_IN_LOG_RESULT', opened: false, logId: 3 });
    expect(await showInLogFromPage({ text: 'Save failed', detail: 'why' }, d)).toBe(false);
    expect(d.copy).toHaveBeenCalledWith('Save failed\nwhy');
    expect(d.toast).toHaveBeenCalledWith(COPIED_ERROR_TEXT, 'info', undefined, expect.objectContaining({ key: 'crev-show-in-log' }));
  });

  it('copies too when the worker does not answer', async () => {
    const d = deps(undefined);
    await showInLogFromPage({ text: 'Save failed' }, d);
    expect(d.copy).toHaveBeenCalledWith('Save failed');
  });

  it('reports a copy that failed as an error without another Show in Log', async () => {
    const d = deps({ type: 'SHOW_IN_LOG_RESULT', opened: false, logId: 3 }, false);
    await showInLogFromPage({ text: 'Save failed' }, d);
    expect(d.toast).toHaveBeenCalledWith(COPY_ERROR_FAILED_TEXT, 'error', undefined, expect.objectContaining({ showInLog: false }));
  });

  it('words the copied text as the spec says', () => {
    expect(COPIED_ERROR_TEXT).toBe('Copied the error details: open the side panel’s Log to see more.');
    expect(errorDetailText({ text: 'a' })).toBe('a');
  });
});

describe('Show in Log in the panel', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('switches to the entry directly when the error has a Log record', () => {
    const reveal = vi.fn();
    const ask = vi.fn();
    installPanelShowInLog(reveal, ask);
    showToast('Failed', 'error', undefined, { logId: 9 });
    document.querySelector<HTMLButtonElement>('.crev-toast__action')!.click();
    expect(reveal).toHaveBeenCalledWith(9);
    expect(ask).not.toHaveBeenCalled();
    setShowInLogHandler(null);
  });

  it('has the worker record an error that has no entry yet', () => {
    const reveal = vi.fn();
    const ask = vi.fn();
    installPanelShowInLog(reveal, ask);
    showToast('Permission request failed', 'error', undefined, { key: 'x' });
    document.querySelector<HTMLButtonElement>('.crev-toast__action')!.click();
    expect(ask).toHaveBeenCalledWith({ text: 'Permission request failed' });
    expect(reveal).not.toHaveBeenCalled();
    setShowInLogHandler(null);
  });
});

describe('message access', () => {
  it('lets pages, windows and the panel send SHOW_IN_LOG', () => {
    expect(senderKindMay('content', 'SHOW_IN_LOG')).toBe(true);
    expect(senderKindMay('frame', 'SHOW_IN_LOG')).toBe(true);
    expect(senderKindMay('extension', 'SHOW_IN_LOG')).toBe(true);
  });
});
