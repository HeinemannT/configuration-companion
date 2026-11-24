/**
 * The page context's identity is named through the badge queue with the tab
 * as its requester, so a tab that leaves its page drops that rid from the
 * queue (enrichment.ts releaseTab) like any badge of the page.
 */
import { describe, expect, it, vi } from 'vitest';

const RID = '8123456789012345678';
const enrichBadges = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../enrichment', async importOriginal => ({ ...(await importOriginal<typeof import('../enrichment')>()), enrichBadges }));
const ctx = vi.hoisted(() => ({ client: {}, cache: { get: () => undefined } }));
vi.mock('../sw-context', async importOriginal => ({
  ...(await importOriginal<typeof import('../sw-context')>()),
  boundCtxForTab: async () => ctx,
}));

describe('page context naming', () => {
  it('asks the badge queue on behalf of the tab', async () => {
    const { setContextRid } = await import('../context-rid');
    const { resolvePanelContextForTab } = await import('../panel-context-sync');
    setContextRid(7, { rid: RID });
    await resolvePanelContextForTab(7);
    expect(enrichBadges).toHaveBeenCalledWith([RID], 7, ctx);
  });
});
