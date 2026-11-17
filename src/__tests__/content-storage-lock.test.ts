/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings":{"enableIframePageLoading":true}}
 *
 * Content scripts cannot read extension storage (lib/storage-access.ts): the
 * worker restricts it to trusted contexts. These tests hold the content side
 * to that: the bundles never reach `chrome.storage.local`, `.sync` or
 * `onChanged`, and the in-page window placement goes through the worker.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as esbuild from 'esbuild';
import { contentChrome, type ContentChrome } from './content-chrome';

const ENTRIES = ['src/content.ts', 'src/content-blueprint-entry.ts', 'src/interceptor.ts'];

describe('content bundles', () => {
  it.each(ENTRIES)('%s has no path to extension-local storage', async entry => {
    const result = await esbuild.build({
      entryPoints: [entry], bundle: true, write: false, format: 'iife', minify: false,
      loader: { '.css': 'text', '.svg': 'text' }, logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    const hits = code.split('\n').filter(line => /storage\??\.(local|sync|onChanged)\b|setAccessLevel/.test(line));
    expect(hits).toEqual([]);
  }, 60_000);
});

describe('in-page window placement', () => {
  let page: ContentChrome;
  afterEach(() => {
    document.querySelectorAll('.crev-eo-host').forEach(h => h.remove());
    delete (globalThis as any).chrome;
    vi.useRealTimers();
  });

  async function mountWith(stored: unknown) {
    vi.resetModules();
    page = contentChrome(msg => msg.type === 'FRAME_BOUNDS_GET'
      ? { type: 'FRAME_BOUNDS_DATA', bounds: stored }
      : msg.type === 'FRAME_BOUNDS_SAVE' ? { type: 'FRAME_BOUNDS_DATA', bounds: msg.bounds } : undefined);
    (globalThis as any).chrome = page.chrome;
    const m = await import('../content-frame-overlay');
    await m.mountFrameOverlay({ kind: 'objectview', url: 'about:blank', label: 'Object', defaultWidth: 600, defaultHeight: 400 });
    return document.querySelector<HTMLElement>('.crev-eo-host')!;
  }

  it('restores the placement the worker answers, without touching storage', async () => {
    const host = await mountWith({ left: 40, top: 30, width: 500, height: 300 });
    expect(page.sendMessage).toHaveBeenCalledWith({ type: 'FRAME_BOUNDS_GET', kind: 'objectview' });
    expect(host.style.left).toBe('40px');
    expect(host.style.width).toBe('500px');
    expect(page.touched).toEqual([]);
  });

  it('saves a corrected placement through the worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await mountWith({ left: -5000, top: 30, width: 500, height: 300 });
    await vi.advanceTimersByTimeAsync(450);
    const save = page.sendMessage.mock.calls.map(c => c[0]).find(m => m.type === 'FRAME_BOUNDS_SAVE');
    expect(save).toMatchObject({ type: 'FRAME_BOUNDS_SAVE', kind: 'objectview', bounds: { width: 500, height: 300 } });
    expect(save.bounds.left).toBeGreaterThanOrEqual(0);
    expect(page.touched).toEqual([]);
  });

  it('opens at the default place when the worker has nothing', async () => {
    const host = await mountWith(null);
    expect(host.style.width).toBe('600px');
    expect(page.touched).toEqual([]);
  });
});
