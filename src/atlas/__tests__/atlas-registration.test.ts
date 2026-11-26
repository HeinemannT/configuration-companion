/**
 * Atlas is a page in its own tab, registered like Colors and images (build
 * entry, generated output, side panel entry, one tab per server, who may send
 * its messages), and its reads go through the scripts of lib/atlas.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import viteConfig from '../../../vite.config';
import { GENERATED_ROOT_DIRECTORIES } from '../../../scripts/build-output-paths.mjs';
import { ATLAS_FIELD as F, ATLAS_ROW as R } from '../../lib/atlas/atlas-ec';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('Atlas page registration', () => {
  it('is a build entry and a generated output directory, and no in-page window', async () => {
    const { isFrameKind } = await import('../../lib/handlers/page-prefs');
    expect(isFrameKind('atlas')).toBe(false);
    const manifest = JSON.parse(read('manifest.json')) as { web_accessible_resources: Array<{ resources: string[] }> };
    // A page in its own tab is not web accessible: no BMP page may embed it.
    expect(manifest.web_accessible_resources.flatMap(w => w.resources)).not.toContain('atlas/*');
    const input = viteConfig.build?.rolldownOptions?.input as Record<string, string>;
    expect(input['atlas/atlas'].replace(/\\/g, '/')).toMatch(/src\/atlas\/atlas\.html$/);
    expect(read('vite.config.ts')).toContain("{ dir: 'atlas', file: 'atlas' }");
    expect(GENERATED_ROOT_DIRECTORIES).toContain('atlas');
    expect(read('.gitignore').split(/\r?\n/)).toContain('/atlas/');
  });

  it('the object window may ask for it; only Companion\'s own pages send its requests', async () => {
    const { MESSAGE_ACCESS } = await import('../../lib/message-access');
    expect(MESSAGE_ACCESS.OPEN_ATLAS).toEqual(['frame']);
    for (const type of ['ATLAS_MODEL', 'ATLAS_OBJECT', 'ATLAS_ROUTE', 'ATLAS_OPEN']) expect(MESSAGE_ACCESS[type], type).toEqual([]);
  });
});

describe('Atlas page opening', () => {
  const env = 'p1@https://bmp.example/Demo/';
  const base = 'chrome-extension://test/atlas/atlas.html?environment=' + encodeURIComponent(env);
  let tabs: Array<{ id: number; windowId: number; index: number; url: string; active?: boolean }>;
  const create = vi.fn(async (_o: { url: string }) => ({}));
  const update = vi.fn(async () => ({}));
  const sendMessage = vi.fn(async () => ({ ok: true }));

  beforeEach(() => {
    vi.resetModules();
    create.mockClear(); update.mockClear(); sendMessage.mockClear();
    tabs = [{ id: 4, windowId: 2, index: 0, url: 'https://bmp.example/Demo/#/x', active: true }];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { getURL: (p: string) => `chrome-extension://test/${p}`, sendMessage },
      tabs: { get: vi.fn(async (id: number) => tabs.find(t => t.id === id)), query: vi.fn(async (q: { active?: boolean }) => (q.active ? tabs.filter(t => t.active) : tabs)), create, update },
      windows: { update: vi.fn(async () => ({})) },
    };
    vi.doMock('../../lib/handler-registry', () => ({ register: vi.fn() }));
    vi.doMock('../../lib/companion-tabs', () => ({ closePanelInWindow: vi.fn(async () => {}) }));
    vi.doMock('../../lib/environment', () => ({ environmentToken: () => env, environmentMatches: () => true, environmentMismatchError: () => '' }));
  });

  const ctx = { client: {}, settings: { activeProfileId: 'p1' } } as never;

  it('opens a tab for the server next to the page it was asked from, on the object', async () => {
    const { openAtlasPage } = await import('../../lib/handlers/atlas');
    await openAtlasPage({ rid: '8265908289559776224', objectType: 'CeRiskAssessment' }, { senderTabId: 4 }, ctx);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 2, index: 1, openerTabId: 4 }));
    const url = create.mock.calls[0][0].url;
    expect(url.split('#')[0]).toBe(base);
    expect(new URLSearchParams(url.split('#')[1]).get('rid')).toBe('8265908289559776224');
    expect(new URLSearchParams(url.split('#')[1]).get('tab')).toBe('4');
  });

  it('brings the open tab of that server forward and tells it where to go', async () => {
    tabs.push({ id: 9, windowId: 2, index: 1, url: base + '#tab=4' });
    const { openAtlasPage } = await import('../../lib/handlers/atlas');
    await openAtlasPage({ objectType: 'CeControlMeasure' }, { senderTabId: 4 }, ctx);
    expect(create).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ATLAS_NAVIGATE', tabId: 9, environment: env, objectType: 'CeControlMeasure' }));
    expect(update).toHaveBeenCalledWith(9, { active: true });
  });
});

describe('Atlas reads', () => {
  const link = (cls: string, name: string) => `com.corporater.bmp.model.model.enterprise.${cls}\u0003${name}\u0003Label\u0004`;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../lib/handler-registry', () => ({ register: vi.fn() }));
  });

  it('reads the properties, then per class what they hold and how many objects fill them; a class that cannot be read keeps what its references name', async () => {
    const { readAtlasModel } = await import('../../lib/handlers/atlas');
    const properties = [
      ['controls', 'Controls', 'ReferenceMethodConfig', 'true', '[]', '', link('CeRiskAssessment', 'Enterprise risk assessment')],
      ['owner', 'Owner', 'ReferenceMethodConfig', 'false', '[User]', '', link('CeBroken', 'Broken')],
    ].map(r => r.join(F)).join(R) + R;
    const executeEc = vi.fn(async (code: string) => {
      if (code.includes('root.property.descendants()')) return { ok: true, log: properties };
      if (code.includes('SELECT CeRiskAssessment')) return { ok: true, log: `#${F}19${F}19${R}controls${F}CeControlMeasure${F}12${R}` };
      return { ok: false, error: 'Unknown class' };
    });
    const model = await readAtlasModel({ executeEc } as never);
    expect(model.edges).toEqual([
      { from: 'CeBroken', prop: 'owner', label: 'Label', multi: false, to: ['User'], declared: true },
      { from: 'CeRiskAssessment', prop: 'controls', label: 'Label', multi: true, to: ['CeControlMeasure'], declared: false, filled: 12 },
    ]);
    expect(model.types.CeRiskAssessment).toEqual({ cls: 'CeRiskAssessment', name: 'Enterprise risk assessment', count: 19, seen: 19 });
    expect(model.types.CeBroken.count).toBeUndefined();
    expect(model.unread).toEqual(['CeBroken']);
  });

  it('reads an object once: its own name and class', async () => {
    const { readAtlasObject } = await import('../../lib/handlers/atlas');
    const executeEcOn = vi.fn(async (_code: string, _rid: string) => ({ ok: true, log: ['11', '101', 'A risk', 'CeRiskAssessment'].join(F) + R }));
    expect(await readAtlasObject({ executeEcOn } as never, '11')).toEqual({ rid: '11', id: '101', name: 'A risk', cls: 'CeRiskAssessment' });
    expect(executeEcOn).toHaveBeenCalledTimes(1);
    expect(executeEcOn.mock.calls[0][1]).toBe('11');
    await expect(readAtlasObject({ executeEcOn: vi.fn(async () => ({ ok: false, error: 'No access' })) } as never, '11')).rejects.toThrow('No access');
  });

  it('opens objects and code only on a page of the same server', async () => {
    const { isPageOf } = await import('../../lib/handlers/atlas');
    const server = 'https://bmp.example/Steadfast/';
    expect(isPageOf(server, 'https://bmp.example/Steadfast/?rid=1')).toBe(true);
    expect(isPageOf(server, 'https://bmp.example/Steadfast')).toBe(true);
    expect(isPageOf(server, 'https://bmp.example/SteadfastDev/')).toBe(false);
    expect(isPageOf('https://bmp.example', 'https://bmp.example.evil.net/')).toBe(false);
    expect(isPageOf(server, 'http://bmp.example/Steadfast/')).toBe(false);
    expect(isPageOf(server, undefined)).toBe(false);
    expect(isPageOf('chrome-extension://x/', 'chrome-extension://x/a')).toBe(false);
  });

  it('reads the objects of a way from the type, or from one object as the command\'s context', async () => {
    const { readAtlasRoute } = await import('../../lib/handlers/atlas');
    const row = ['11', '101', 'A risk', 'CeRiskAssessment', '21', '7', 'A control', 'CeControlMeasure'].join(F) + F + R;
    const executeEc = vi.fn(async (_code: string) => ({ ok: true, log: row + '\n\nDuration : 5ms' }));
    const executeEcOn = vi.fn(async (_code: string, _rid: string) => ({ ok: true, log: row }));
    const steps = [{ dir: 'out' as const, prop: 'controls' }];
    const classes = ['CeRiskAssessment', 'CeControlMeasure'];
    expect(await readAtlasRoute({ executeEc, executeEcOn } as never, classes, steps)).toEqual([[
      { rid: '11', id: '101', name: 'A risk', cls: 'CeRiskAssessment' }, { rid: '21', id: '7', name: 'A control', cls: 'CeControlMeasure' },
    ]]);
    expect(executeEc.mock.calls[0][0]).toContain('SELECT CeRiskAssessment');
    await readAtlasRoute({ executeEc, executeEcOn } as never, classes, steps, '11');
    // Objects of another type that the reference also holds are not rows of this route.
    expect(await readAtlasRoute({ executeEc, executeEcOn } as never, ['CeRiskAssessment', 'CeAsset'], steps)).toEqual([]);
    expect(executeEcOn.mock.calls[0][0]).toContain('LIST().merge(this.object)');
    expect(executeEcOn.mock.calls[0][1]).toBe('11');
  });
});
