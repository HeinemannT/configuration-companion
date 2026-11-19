/**
 * The Transport window is registered like the other in-page windows: its
 * frame kind, the manifest's web-accessible pages, the build entry and the
 * generated output list, the launcher's MOUNT_FRAME, the side panel button
 * and the OPEN_TRANSPORT message.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import viteConfig from '../../../vite.config';
import { GENERATED_ROOT_DIRECTORIES } from '../../../scripts/build-output-paths.mjs';
import { ICON_SPRITE } from '../../lib/icon-sprite';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('Transport window registration', () => {
  it('is a frame kind', async () => {
    const { isFrameKind } = await import('../../lib/handlers/page-prefs');
    expect(isFrameKind('transport')).toBe(true);
    expect(read('src/content-frame-overlay.ts')).toMatch(/transport: true/);
  });

  it('is a web-accessible page, a build entry and a generated output directory', () => {
    const manifest = JSON.parse(read('manifest.json')) as { web_accessible_resources: Array<{ resources: string[] }>; host_permissions?: string[] };
    expect(manifest.web_accessible_resources.flatMap(w => w.resources)).toContain('transport/*');
    expect(manifest.host_permissions ?? []).toEqual([]);
    const input = viteConfig.build?.rolldownOptions?.input as Record<string, string>;
    expect(input['transport/transport'].replace(/\\/g, '/')).toMatch(/src\/transport\/transport\.html$/);
    expect(read('vite.config.ts')).toContain("{ dir: 'transport', file: 'transport' }");
    expect(GENERATED_ROOT_DIRECTORIES).toContain('transport');
    expect(read('.gitignore').split(/\r?\n/)).toContain('/transport/');
    const html = read('src/transport/transport.html');
    expect(html).toContain('src="./transport.ts"');
    expect(html).toContain('href="./transport.css"');
  });

  it('the launcher mounts transport/transport.html as kind transport', async () => {
    const sendMessage = vi.fn(async () => ({ type: 'FRAME_MOUNT_RESULT', disposition: 'mounted' }));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
      tabs: { get: vi.fn(async (id: number) => ({ id })), query: vi.fn(async () => [{ id: 4 }]), sendMessage },
    };
    const { openTransportWindow } = await import('../../lib/transport-launcher');
    expect(await openTransportWindow({ windowId: 2 })).toBe('mounted');
    expect(sendMessage).toHaveBeenCalledWith(4, expect.objectContaining({
      type: 'MOUNT_FRAME', kind: 'transport', url: 'chrome-extension://test/transport/transport.html', label: 'Transport (beta)', resourceKey: 'transport:window',
    }));
  });

  it('the launcher hands a tab to the window, also when it is open (a frame activation)', async () => {
    const sendMessage = vi.fn(async () => ({ type: 'FRAME_MOUNT_RESULT', disposition: 'activated' }));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
      tabs: { get: vi.fn(async (id: number) => ({ id })), query: vi.fn(async () => [{ id: 4 }]), sendMessage },
    };
    const { openTransportWindow } = await import('../../lib/transport-launcher');
    expect(await openTransportWindow({ windowId: 2 }, 'numeric')).toBe('activated');
    expect(sendMessage).toHaveBeenCalledWith(4, expect.objectContaining({ resourceKey: 'transport:window', activation: { type: 'transport', tab: 'numeric' } }));
    sendMessage.mockClear();
    await openTransportWindow({ windowId: 2 });
    expect(sendMessage.mock.calls[0]).toEqual([4, expect.not.objectContaining({ activation: expect.anything() })]);
    // The side panel asks for the tab, the window asks for the rest.
    expect(read('src/sidepanel/utilities.ts')).toContain("message: { type: 'OPEN_TRANSPORT', tab: 'numeric' }");
    expect(read('src/transport/transport.ts')).toContain("m.activation?.type === 'transport'");
    expect(read('src/transport/transport.ts')).toContain("postToParent({ type: 'CREV_FRAME_READY' })");
  });

  it('the numeric ID reads and the change are registered and accepted from the window frame only', async () => {
    const { getHandler } = await import('../../lib/handler-registry');
    await import('../../lib/handlers/transport');
    const { MESSAGE_ACCESS } = await import('../../lib/message-access');
    for (const type of ['NUMERIC_IDS_SCAN', 'NUMERIC_IDS_ORIGINS', 'NUMERIC_IDS_RUN']) {
      expect(getHandler(type), type).toBeTypeOf('function');
      expect(MESSAGE_ACCESS[type], type).toEqual(['frame']);
    }
  });

  it('the targets and the part run are registered and accepted from the window frame only', async () => {
    const { getHandler } = await import('../../lib/handler-registry');
    await import('../../lib/handlers/transport');
    const { MESSAGE_ACCESS } = await import('../../lib/message-access');
    for (const type of ['TRANSPORT_TARGETS', 'TRANSPORT_RUN_PART']) {
      expect(getHandler(type), type).toBeTypeOf('function');
      expect(MESSAGE_ACCESS[type], type).toEqual(['frame']);
    }
  });

  it('OPEN_TRANSPORT is registered and sent by the side panel only', async () => {
    const { getHandler } = await import('../../lib/handler-registry');
    await import('../../lib/handlers/transport-window');
    expect(getHandler('OPEN_TRANSPORT')).toBeTypeOf('function');
    const { MESSAGE_ACCESS } = await import('../../lib/message-access');
    expect(MESSAGE_ACCESS.OPEN_TRANSPORT).toEqual([]);
    expect(read('src/lib/message-router.ts')).toContain("import './handlers/transport-window';");
    // The panel's Utilities tab opens it (its own drawing; the share graph stays the diagram widget's).
    const utilities = read('src/sidepanel/utilities.ts');
    expect(utilities).toContain("icon: 's-transport', message: { type: 'OPEN_TRANSPORT' }");
    expect(read('src/sidepanel/icons.ts')).toContain('id="s-transport"');
    expect(ICON_SPRITE).toContain('id="i-share"');
  });
});
