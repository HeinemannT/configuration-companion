import { beforeEach, expect, it, vi } from 'vitest';
const { ctx } = vi.hoisted(() => ({ ctx: { client: { serverUrl: 'https://example.test/' }, settings: { activeProfileId: 'demo' } } }));
vi.mock('../sw-context', () => ({ getCtx: () => ctx }));
vi.mock('../access-workspace/service', () => ({ handleAccessRequest: vi.fn() }));
import { openAccessWorkspace } from '../handlers/access-workspace';
import { openColorsImages } from '../handlers/colors-images';
import { isCompanionTabUrl } from '../companion-tabs';

// Every page Companion opens as a tab must be one whose side panel is turned
// off (companion-tabs.ts); a new page added to a handler without being listed
// there shows the panel beside it.
const created: string[] = [];
beforeEach(() => {
  created.length = 0;
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => 'chrome-extension://test/' + path },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      create: vi.fn(async ({ url }: { url: string }) => { created.push(url); return { id: 7, url }; }),
      update: vi.fn(), move: vi.fn(),
    },
    windows: { update: vi.fn() },
  });
});

it('Access opens at an address whose panel is off', async () => {
  await openAccessWorkspace();
  expect(created).toHaveLength(1);
  expect(isCompanionTabUrl(created[0])).toBe(true);
});

it('Colors and images opens at an address whose panel is off, with or without a tab in its hash', async () => {
  await openColorsImages(undefined);
  await openColorsImages('colors');
  expect(created).toHaveLength(2);
  expect(created.every(isCompanionTabUrl)).toBe(true);
});
