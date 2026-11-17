// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../view', () => ({ render: vi.fn() }));
vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));

import { bp, resetState } from '../state';
import {
  loadPortableIdConfig,
  portableIdsAvailable,
  setPortableIdPatternDraft,
  setPortableIdsEnabled,
} from '../id-config';

import { contentChrome, type ContentChrome } from '../../__tests__/content-chrome';

// The worker keeps the recipe (handlers/page-prefs.ts); the content script
// cannot touch extension storage itself.
const storageGet = vi.fn();
const storageSet = vi.fn();
let page: ContentChrome;

beforeEach(async () => {
  vi.useFakeTimers();
  resetState();
  storageGet.mockReset();
  storageSet.mockReset();
  storageGet.mockResolvedValue({});
  storageSet.mockResolvedValue(undefined);
  page = contentChrome(async msg => {
    if (msg.type === 'PORTABLE_IDS_GET') {
      const stored = await storageGet();
      return { type: 'PORTABLE_IDS_DATA', config: stored.crev_blueprint_portable_ids ?? { enabled: false, pattern: '{page}_{parent}_{class}_{name}' } };
    }
    if (msg.type === 'PORTABLE_IDS_SAVE') {
      await storageSet({ crev_blueprint_portable_ids: msg.config });
      return { type: 'PORTABLE_IDS_DATA', config: msg.config };
    }
    return undefined;
  });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: page.chrome });
  await loadPortableIdConfig();
});

afterEach(() => {
  vi.useRealTimers();
  // No path of the recipe reads or writes extension storage from the page.
  expect(page.touched).toEqual([]);
});

describe('Blueprint Automatic ID Assignment persistence', () => {
  it('is available for templates and standalone EditPages, but not normal instances', () => {
    expect(portableIdsAvailable({ pageId: 'p', pageRid: '1', tabsetId: 't', target: 'template' })).toBe(true);
    expect(portableIdsAvailable({ pageId: 'p', pageRid: '1', tabsetId: '', target: 'instance', surface: 'edit-page' })).toBe(true);
    expect(portableIdsAvailable({ pageId: 'p', pageRid: '1', tabsetId: 't', target: 'instance' })).toBe(false);
  });

  it('loads one global recipe through the worker', async () => {
    storageGet.mockResolvedValue({
      crev_blueprint_portable_ids: {
        enabled: true,
        pattern: '{page}_{class}_{name}_{hash4}',
      },
    });

    await loadPortableIdConfig();

    expect(bp.idConfig).toEqual({
      enabled: true,
      pattern: '{page}_{class}_{name}_{hash4}',
    });
  });

  it('debounces valid pattern drafts into storage', async () => {
    expect(setPortableIdPatternDraft('{page}_{name}')).toBeNull();

    await vi.advanceTimersByTimeAsync(349);
    expect(storageSet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledWith({
      crev_blueprint_portable_ids: {
        enabled: false,
        pattern: '{page}_{name}',
      },
    }));
  });

  it('can be disabled while the visible draft is invalid', async () => {
    storageGet.mockResolvedValue({
      crev_blueprint_portable_ids: {
        enabled: true,
        pattern: '{page}_{class}_{name}',
      },
    });
    await loadPortableIdConfig();
    expect(setPortableIdPatternDraft('{page}_{unknown}')).toBe('Unknown tag {unknown}.');

    setPortableIdsEnabled(false);

    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledWith({
      crev_blueprint_portable_ids: {
        enabled: false,
        pattern: '{page}_{class}_{name}',
      },
    }));
    expect(bp.idConfig).toEqual({
      enabled: false,
      pattern: '{page}_{class}_{name}',
    });
  });
});
