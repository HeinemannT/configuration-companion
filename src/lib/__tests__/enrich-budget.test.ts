/**
 * A page may ask for only so many badge identities (enrich-budget.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { admitEnrichRids, ENRICH_RIDS_PER_MESSAGE, ENRICH_RIDS_PER_MINUTE, forgetEnrichBudget, resetEnrichBudgets } from '../enrich-budget';

const rids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => String(1_000_000 + from + i));

describe('badge rid budget', () => {
  beforeEach(() => resetEnrichBudgets());

  it('admits at most the per-message cap and refuses the rest', () => {
    const { admitted, refused } = admitEnrichRids(1, rids(ENRICH_RIDS_PER_MESSAGE + 7), 0);
    expect(admitted).toHaveLength(ENRICH_RIDS_PER_MESSAGE);
    expect(refused).toHaveLength(7);
  });

  it('drops duplicates and values that are not rids before counting', () => {
    const { admitted, refused } = admitEnrichRids(1, ['1234567', '1234567', ' 1234567 ', 'x', 12345678, '12', null], 0);
    expect(admitted).toEqual(['1234567']);
    expect(refused).toEqual([]);
    expect(admitEnrichRids(1, 'not an array', 0)).toEqual({ admitted: [], refused: [] });
  });

  it('caps a tab per minute and frees the budget after the minute', () => {
    let total = 0;
    for (let i = 0; i < 5; i++) total += admitEnrichRids(7, rids(ENRICH_RIDS_PER_MESSAGE, i * ENRICH_RIDS_PER_MESSAGE), 1_000 + i).admitted.length;
    expect(total).toBe(ENRICH_RIDS_PER_MINUTE);
    expect(admitEnrichRids(7, rids(5, 99_000), 30_000).refused).toHaveLength(5);
    // Other tabs have their own budget.
    expect(admitEnrichRids(8, rids(5, 99_000), 30_000).admitted).toHaveLength(5);
    // A minute after the first asks, the budget is back.
    expect(admitEnrichRids(7, rids(5, 99_000), 61_010).admitted).toHaveLength(5);
  });

  it('starts over for a closed tab', () => {
    admitEnrichRids(9, rids(ENRICH_RIDS_PER_MESSAGE), 0);
    admitEnrichRids(9, rids(ENRICH_RIDS_PER_MESSAGE, 5_000), 0);
    admitEnrichRids(9, rids(ENRICH_RIDS_PER_MESSAGE, 10_000), 0);
    expect(admitEnrichRids(9, rids(1, 20_000), 1).admitted).toEqual([]);
    forgetEnrichBudget(9);
    expect(admitEnrichRids(9, rids(1, 20_000), 2).admitted).toHaveLength(1);
  });

  it('the handler answers refused rids empty and enriches only the admitted ones', async () => {
    vi.resetModules();
    const enrichBadges = vi.fn(async () => {});
    vi.doMock('../enrichment', () => ({ enrichBadges }));
    const posted: unknown[] = [];
    const ctx: any = { contentPorts: new Map([[4, { postMessage: (m: unknown) => posted.push(m) }]]) };
    await import('../handlers/enrichment');
    const { getHandler } = await import('../handler-registry');
    const many = rids(ENRICH_RIDS_PER_MESSAGE + 2);
    await getHandler('ENRICH_BADGES')!({ type: 'ENRICH_BADGES', rids: many } as never, () => {}, { isOneShot: false, senderTabId: 4, ctx });
    expect(enrichBadges).toHaveBeenCalledWith(many.slice(0, ENRICH_RIDS_PER_MESSAGE), 4, ctx);
    expect(posted).toEqual([{ type: 'BADGE_ENRICHMENT', enrichments: { [many[ENRICH_RIDS_PER_MESSAGE]]: {}, [many[ENRICH_RIDS_PER_MESSAGE + 1]]: {} } }]);
    vi.doUnmock('../enrichment');
  });
});
