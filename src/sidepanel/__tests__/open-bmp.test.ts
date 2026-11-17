import { describe, it, expect, vi } from 'vitest';
import { isWorkspaceTab, openBmp, pickBmpTab, type OpenBmpApi, type TabLike } from '../open-bmp';

const URL_ = 'https://bmp.test/Steadfast/';

describe('open BMP', () => {
  it('matches pages of the workspace only', () => {
    expect(isWorkspaceTab('https://bmp.test/Steadfast/?rid=1', URL_)).toBe(true);
    expect(isWorkspaceTab('https://bmp.test/Steadfast', URL_)).toBe(true);
    expect(isWorkspaceTab('https://bmp.test/SteadfastQA/', URL_)).toBe(false);
    expect(isWorkspaceTab('https://other.test/Steadfast/', URL_)).toBe(false);
    expect(isWorkspaceTab(undefined, URL_)).toBe(false);
  });

  it('prefers a tab in this window, then the active one, then the most recent', () => {
    const tabs: TabLike[] = [
      { id: 1, windowId: 2, url: `${URL_}?a`, active: true, lastAccessed: 9 },
      { id: 2, windowId: 1, url: `${URL_}?b`, lastAccessed: 1 },
      { id: 3, windowId: 1, url: 'https://elsewhere.test/', active: true },
    ];
    expect(pickBmpTab(tabs, URL_, 1)?.id).toBe(2);
    expect(pickBmpTab(tabs, URL_, 7)?.id).toBe(1);
    expect(pickBmpTab([], URL_, 1)).toBeNull();
  });

  const api = (tabs: TabLike[]): OpenBmpApi & { focused: TabLike[]; created: [string, number | null][] } => {
    const focused: TabLike[] = [];
    const created: [string, number | null][] = [];
    return {
      focused, created,
      currentWindowId: vi.fn(async () => 1),
      queryTabs: vi.fn(async () => tabs),
      focusTab: vi.fn(async (t: TabLike) => { focused.push(t); }),
      createTab: vi.fn(async (u: string, w: number | null) => { created.push([u, w]); }),
    };
  };

  it('focuses the existing BMP tab', async () => {
    const a = api([{ id: 5, windowId: 1, url: `${URL_}web/x` }]);
    expect(await openBmp(URL_, a)).toBe('focused');
    expect(a.focused.map(t => t.id)).toEqual([5]);
    expect(a.created).toEqual([]);
  });

  it('opens the workspace in this window when no tab shows it', async () => {
    const a = api([{ id: 5, windowId: 1, url: 'https://elsewhere.test/' }]);
    expect(await openBmp('bmp.test/Steadfast', a)).toBe('opened');
    expect(a.created).toEqual([[URL_, 1]]);
  });

  it('fails without a usable address', async () => {
    expect(await openBmp('not a url', api([]))).toBe('failed');
  });
});
