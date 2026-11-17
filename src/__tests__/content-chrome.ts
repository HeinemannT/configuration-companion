/**
 * A `chrome` global as a content script sees it once the worker has closed
 * extension storage to content scripts (lib/storage-access.ts): every
 * `chrome.storage.local` / `.session` method and `onChanged` throws, and each
 * touch is recorded so a test can assert none happened even where the code
 * swallows the error. Messages go to `onMessage`, which plays the worker.
 */
import { vi } from 'vitest';

export interface ContentChrome {
  chrome: typeof chrome;
  /** `local.get`, `session.set`, `onChanged.addListener`, … in call order. */
  touched: string[];
  sendMessage: ReturnType<typeof vi.fn>;
}

export function contentChrome(
  onMessage: (msg: Record<string, unknown>) => unknown,
  extra: Record<string, unknown> = {},
): ContentChrome {
  const touched: string[] = [];
  const forbidden = (area: string) => new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      return () => {
        touched.push(`${area}.${prop}`);
        throw new Error(`Access to storage is not allowed from this context (${area}.${prop}).`);
      };
    },
  });
  const sendMessage = vi.fn(async (msg: Record<string, unknown>) => onMessage(msg));
  const value = {
    storage: { local: forbidden('local'), session: forbidden('session'), onChanged: forbidden('onChanged') },
    runtime: { id: 'test', lastError: null, sendMessage, getURL: (p: string) => `chrome-extension://test/${p}` },
    ...extra,
  } as unknown as typeof chrome;
  return { chrome: value, touched, sendMessage };
}
