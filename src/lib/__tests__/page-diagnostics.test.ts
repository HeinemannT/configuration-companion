/**
 * Page-connection diagnostics reach the Log once per page load and tab, and
 * never for extension or browser pages.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { setSwContext } from '../sw-context';
import { _resetPageDiagnosticsForTests, isWebPage, logPageDiagnostic, notePageLoad } from '../page-diagnostics';

let logActivity: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockChromeStorage();
  (globalThis as unknown as { chrome: { tabs: unknown } }).chrome.tabs = {
    get: vi.fn(async (id: number) => ({ id, url: id === 9 ? 'chrome-extension://abc/editor/editor.html' : 'https://bmp.test/portal' })),
  };
  _resetPageDiagnosticsForTests();
  logActivity = vi.fn();
  setSwContext({ logActivity } as never);
});

describe('page diagnostics', () => {
  it('logs each diagnostic once per page load and tab', async () => {
    expect(await logPageDiagnostic(1, 'inject', 'Connecting to the page…')).toBe(true);
    expect(await logPageDiagnostic(1, 'inject', 'Connecting to the page…')).toBe(false);
    expect(await logPageDiagnostic(1, 'page-ready', 'Companion ready on this page')).toBe(true);
    // Another tab has its own page load.
    expect(await logPageDiagnostic(2, 'inject', 'Connecting to the page…')).toBe(true);
    expect(logActivity).toHaveBeenCalledTimes(3);
    expect(logActivity).toHaveBeenCalledWith('info', 'Connecting to the page…', undefined, { category: 'system', action: 'inject' });
  });

  it('logs again after the tab starts a new page load', async () => {
    await logPageDiagnostic(1, 'detection:not-detected', 'This page is not BMP');
    await notePageLoad(1);
    expect(await logPageDiagnostic(1, 'detection:not-detected', 'This page is not BMP')).toBe(true);
    expect(logActivity).toHaveBeenLastCalledWith('info', 'This page is not BMP', undefined, { category: 'system', action: 'detection' });
  });

  it('remembers across a worker restart (session storage)', async () => {
    await logPageDiagnostic(1, 'inject', 'Connecting to the page…');
    await vi.waitFor(() => expect(chrome.storage.session.set).toHaveBeenCalled());
    // The worker wakes up again: its memory is empty, the session copy is not.
    _resetPageDiagnosticsForTests();
    expect(await logPageDiagnostic(1, 'inject', 'Connecting to the page…')).toBe(false);
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it('never logs extension or browser pages', async () => {
    expect(await logPageDiagnostic(9, 'detection:not-detected', 'This page is not BMP')).toBe(false);
    expect(await logPageDiagnostic(3, 'inject', 'Connecting to the page…', undefined, 'chrome://extensions')).toBe(false);
    expect(await logPageDiagnostic(undefined, 'inject', 'Connecting to the page…')).toBe(false);
    expect(logActivity).not.toHaveBeenCalled();
    expect(isWebPage('https://bmp.test/')).toBe(true);
    expect(isWebPage('chrome-extension://abc/sidepanel.html')).toBe(false);
  });
});
