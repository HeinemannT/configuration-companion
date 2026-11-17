/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings":{"enableIframePageLoading":true}}
 *
 * The identity in a Companion window's title bar: the server name (normal
 * ink), the user and the session kind (muted), as separate parts. A narrow
 * title bar drops the session kind first, then the user, then truncates the
 * server name: the parts wrap onto a second line that the fixed height hides.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../../content-overlay.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

async function freshModule() {
  vi.resetModules();
  (globalThis as any).chrome = { storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } } };
  return import('../../content-frame-overlay');
}

const server = () => document.querySelector<HTMLElement>('#crev-frame-overlay-objectview .crev-eo-titlebar-server')!;
const parts = () => [...server().children].map(c => [c.className, c.textContent]);
const OBJECT = { kind: 'objectview' as const, url: 'about:blank', label: 'Object', defaultWidth: 900, defaultHeight: 600 };

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[}{;]\\s*)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, selector).not.toBeNull();
  return m![1];
}

afterEach(() => {
  document.documentElement.querySelectorAll('.crev-eo-host').forEach(h => h.remove());
  document.getElementById('crev-inspector-styles')?.remove();
  delete (globalThis as any).chrome;
});

describe('window title bar identity', () => {
  it('splits server, user and session kind, in the product words for each session', async () => {
    const m = await freshModule();
    m.setFrameServer({ profileLabel: 'Test server', identities: { command: { status: 'connected', user: 'alex', source: 'portal-session' } } });
    await m.mountFrameOverlay(OBJECT);
    expect(parts()).toEqual([['crev-eo-srv-name', 'Test server'], ['crev-eo-srv-user', 'alex'], ['crev-eo-srv-kind', 'browser session']]);
    expect(server().title).toBe('Works on Test server · alex · browser session');

    m.setFrameServer({ profileLabel: 'Test server', identities: { command: { status: 'connected', user: 'cfg', source: 'stored-login' } } });
    expect(parts()).toEqual([['crev-eo-srv-name', 'Test server'], ['crev-eo-srv-user', 'cfg'], ['crev-eo-srv-kind', 'stored configuration login']]);
  });

  it('shows only the server without a signed-in user, and nothing without a server', async () => {
    const m = await freshModule();
    await m.mountFrameOverlay(OBJECT);
    m.setFrameServer({ profileLabel: 'Test server', identities: { command: { status: 'failed', user: 'alex', source: 'portal-session' } } });
    expect(parts()).toEqual([['crev-eo-srv-name', 'Test server']]);
    expect(server().title).toBe('Works on Test server');
    m.setFrameServer(null);
    expect(parts()).toEqual([]);
    expect(server().title).toBe('');
  });

  it('drops the session kind, then the user, before the server name truncates', () => {
    const box = rule('.crev-eo-titlebar-server');
    // One visible line; parts that do not fit wrap onto the hidden second line.
    expect(box).toContain('flex-wrap: wrap');
    expect(box).toContain('height: 16px');
    expect(box).toContain('line-height: 16px');
    expect(box).toContain('overflow: hidden');
    expect(box).toContain('min-width: 0');
    // Alone on its line, the server name shrinks with an ellipsis.
    const part = rule('.crev-eo-titlebar-server > span');
    expect(part).toContain('min-width: 0');
    expect(part).toContain('text-overflow: ellipsis');
    expect(part).toContain('white-space: nowrap');
    // The name reads normal, the rest muted; the separators go with their part.
    expect(rule('.crev-eo-srv-name')).toContain('#525252');
    expect(box).toContain('color: #8d8d8d');
    expect(rule('.crev-eo-srv-user::before,\n.crev-eo-srv-kind::before')).toContain('content: "·"');
  });

  it('keeps the window positioned inline (the overlay invariant)', async () => {
    const m = await freshModule();
    m.setFrameServer({ profileLabel: 'Test server', identities: { command: { status: 'connected', user: 'alex', source: 'portal-session' } } });
    await m.mountFrameOverlay(OBJECT);
    const host = document.getElementById('crev-frame-overlay-objectview')!;
    expect(host.style.position).toBe('fixed');
    expect(host.style.zIndex).not.toBe('');
  });
});
