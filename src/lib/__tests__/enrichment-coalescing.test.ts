/**
 * Badge requests share posts across ENRICH_BADGES messages, frames and tabs:
 * cache hits are answered at once, the rest are sent as few background
 * posts as the chunk size allows, and each post's results are sent as soon as
 * it returns, only to the tabs that asked for them (cloned servers share
 * RIDs, so a name must never reach a tab that did not ask).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { BADGE_CHUNK_SIZE } from '../constants';
import { COALESCE_WINDOW_MS, enrichBadges, incrementGeneration, releaseTab, resetEnrichment } from '../enrichment';
import { requestClassOf } from '../request-class';
import { setSwContext, type SwContext } from '../sw-context';
import type { BmpObject, InspectorMessage } from '../types';

type Result = { results: Record<string, { businessId: string; type: string; name: string }>; error?: string };

function harness() {
  mockChromeStorage();
  const calls: Array<{ rids: string[]; signal: AbortSignal; finish(result?: Result): void }> = [];
  const batchEnrich = vi.fn((rids: string[], signal: AbortSignal) => new Promise<Result>(resolve => {
    calls.push({
      rids: [...rids], signal,
      finish: result => resolve(result ?? { results: Object.fromEntries(rids.map(rid => [rid, { businessId: `b${rid}`, type: 'Scorecard', name: `N${rid}` }])) }),
    });
  }));
  const store = new Map<string, BmpObject>();
  const broadcasts: InspectorMessage[] = [];
  const portMessages = new Map<number, InspectorMessage[]>();
  const contentPorts = new Map<number, chrome.runtime.Port>();
  for (const tab of [7, 8]) {
    portMessages.set(tab, []);
    contentPorts.set(tab, { postMessage: (m: InspectorMessage) => portMessages.get(tab)!.push(m) } as unknown as chrome.runtime.Port);
  }
  const ctx = {
    client: { batchEnrich },
    cache: {
      get: (rid: string) => store.get(rid),
      putAll: (objects: BmpObject[]) => { for (const o of objects) store.set(o.rid, o); },
      invalidate: (rid: string) => store.delete(rid),
      flush: vi.fn(async () => {}),
      get size() { return store.size; },
    },
    contentPorts,
    logActivity: vi.fn(), sendToPanel: vi.fn(),
    broadcastToContent: (m: InspectorMessage) => broadcasts.push(m),
  } as unknown as SwContext;
  setSwContext(ctx);
  const seed = (rid: string) => store.set(rid, { rid, businessId: `c${rid}`, type: 'Scorecard', name: `C${rid}`, identityEnriched: true, source: 'server', discoveredAt: 0, updatedAt: 0 });
  return { calls, batchEnrich, broadcasts, portMessages, seed, store };
}

const rids = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(1000 + from + i));

afterEach(() => { resetEnrichment(); incrementGeneration(); });

describe('badge request coalescing', () => {
  it('turns staged messages from several frames and tabs into one post', async () => {
    const h = harness();
    // A page renders in stages: header, then the body, from two tabs.
    const done = [
      enrichBadges(['1001'], 7),
      enrichBadges(rids(2, 6), 7),
      enrichBadges(['1001', ...rids(12, 4)], 8),
    ];
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0].rids).toEqual(['1001', ...rids(2, 6), ...rids(12, 4)]);
    h.calls[0].finish();
    await Promise.all(done);
    expect(h.batchEnrich).toHaveBeenCalledTimes(1);
    expect(requestClassOf(h.calls[0].signal).requestClass).toBe('background');
  });

  it('does not delay the first chunk by more than the short window', async () => {
    const h = harness();
    const t0 = performance.now();
    void enrichBadges(['1001'], 7);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), { interval: 1 });
    expect(performance.now() - t0).toBeLessThan(COALESCE_WINDOW_MS + 40);
    h.calls[0].finish();
  });

  it('answers cache hits at once to the tab that asked, before any post', async () => {
    const h = harness();
    h.seed('1001');
    const done = enrichBadges(['1001', '1002'], 8);
    expect(h.portMessages.get(8)).toEqual([{ type: 'BADGE_ENRICHMENT', enrichments: { '1001': expect.objectContaining({ businessId: 'c1001' }) } }]);
    expect(h.portMessages.get(7)).toEqual([]);
    expect(h.calls).toHaveLength(0);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0].rids).toEqual(['1002']);
    h.calls[0].finish();
    await done;
  });

  it('answers a reloaded page from the cache although the identity was sent before', async () => {
    const h = harness();
    const first = enrichBadges(['1001'], 7);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.calls[0].finish();
    await first;
    // The page reloads: its new content script asks again and must get an answer.
    await enrichBadges(['1001'], 7);
    expect(h.portMessages.get(7)).toHaveLength(2); // the post's answer, then the cache hit
    expect(h.portMessages.get(7)![1]).toEqual({ type: 'BADGE_ENRICHMENT', enrichments: { '1001': expect.objectContaining({ businessId: 'b1001' }) } });
    expect(h.broadcasts).toEqual([]);
    expect(h.batchEnrich).toHaveBeenCalledTimes(1);
  });

  it('lets rids that arrive during a post join the next chunk, and answers each tab per chunk', async () => {
    const h = harness();
    const n = BADGE_CHUNK_SIZE;
    const first = enrichBadges(rids(0, n + 2), 7);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0].rids).toHaveLength(n);
    const later = [enrichBadges(rids(100, 3), 7), enrichBadges(rids(103, 3), 8)];
    h.calls[0].finish();
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    // The first chunk's results are out before the second post returns.
    expect(h.portMessages.get(7)).toHaveLength(1);
    expect(h.portMessages.get(8)).toHaveLength(0);
    expect(h.calls[1].rids).toEqual([...rids(n, 2), ...rids(100, 6)]);
    h.calls[1].finish();
    await Promise.all([first, ...later]);
    expect(h.batchEnrich).toHaveBeenCalledTimes(2);
    // One answer per tab for the shared chunk, each with only its own rids.
    expect(h.portMessages.get(7)).toHaveLength(2);
    const toEight = h.portMessages.get(8) as Array<{ enrichments: Record<string, unknown> }>;
    expect(toEight).toHaveLength(1);
    expect(Object.keys(toEight[0].enrichments)).toEqual(rids(103, 3));
    expect(h.broadcasts).toEqual([]);
  });

  it('drops the rids of a tab that left its page, and supersedes its waiting post', async () => {
    const h = harness();
    const first = enrichBadges(rids(0, BADGE_CHUNK_SIZE), 7);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const left = enrichBadges(rids(BADGE_CHUNK_SIZE, 5), 7);       // only tab 7 wants these
    const shared = enrichBadges(rids(30, 2), 8);     // tab 8 wants these
    releaseTab(7);
    // The post in flight belonged only to tab 7: superseded (leaves the
    // transport queue if it is still waiting there), not interrupted.
    expect(requestClassOf(h.calls[0].signal).supersede?.aborted).toBe(true);
    expect(h.calls[0].signal.aborted).toBe(false);
    await left; // settled without a post
    h.calls[0].finish();
    await first;
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1].rids).toEqual(rids(30, 2));
    h.calls[1].finish();
    await shared;
    // Superseded results are kept in the cache (the next visit is warm) but
    // not broadcast, and nothing is reported as failed.
    expect(h.store.has(rids(0, 1)[0])).toBe(true);
    const sent = h.portMessages.get(8) as Array<{ enrichments: Record<string, unknown> }>;
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0].enrichments)).toEqual(rids(30, 2));
    expect(h.portMessages.get(7)).toEqual([]);
    expect(h.broadcasts).toEqual([]);
  });

  it('still answers a reloaded page that asks again while its old post is out', async () => {
    const h = harness();
    const old = enrichBadges(['1001', '1002'], 7);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    releaseTab(7);               // the page reloads …
    const fresh = enrichBadges(['1001'], 7); // … and its new script asks again
    h.calls[0].finish();
    await Promise.all([old, fresh]);
    expect(h.portMessages.get(7)).toContainEqual({ type: 'BADGE_ENRICHMENT', enrichments: expect.objectContaining({ '1001': expect.objectContaining({ businessId: 'b1001' }) }) });
    expect(h.batchEnrich).toHaveBeenCalledTimes(1);
  });

  it('re-sends wanted rids when their superseded post was dropped before it was sent', async () => {
    const h = harness();
    const old = enrichBadges(['1001'], 7);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    releaseTab(7);
    const fresh = enrichBadges(['1001'], 7);
    h.calls[0].finish({ results: {}, error: 'BMP request cancelled' });
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1].rids).toEqual(['1001']);
    h.calls[1].finish();
    await Promise.all([old, fresh]);
    expect(h.portMessages.get(7)!.some(m => m.type === 'BADGE_ENRICHMENT' && (m as { enrichments: Record<string, { businessId?: string }> }).enrichments['1001']?.businessId === 'b1001')).toBe(true);
  });

  it('sends chunks of at most BADGE_CHUNK_SIZE objects (the server cost grows with the square)', async () => {
    const h = harness();
    const done = enrichBadges(rids(0, 2 * BADGE_CHUNK_SIZE + 1), 7);
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(h.calls).toHaveLength(i + 1));
      h.calls[i].finish();
    }
    await done;
    expect(h.calls.map(c => c.rids.length)).toEqual([BADGE_CHUNK_SIZE, BADGE_CHUNK_SIZE, 1]);
  });

  it('starts the new generation while the old one still waits for its post', async () => {
    const h = harness();
    void enrichBadges(['1001'], 7);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    incrementGeneration(); // profile switch; the old post never returns here
    const fresh = enrichBadges(['1002'], 7);
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    h.calls[1].finish();
    await fresh;
  });

  it('keeps a rid another tab still wants when the first tab leaves', async () => {
    const h = harness();
    const a = enrichBadges(['1001'], 7);
    const b = enrichBadges(['1001'], 8);
    releaseTab(7);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0].rids).toEqual(['1001']);
    h.calls[0].finish();
    await Promise.all([a, b]);
    expect(h.portMessages.get(8)).toContainEqual({ type: 'BADGE_ENRICHMENT', enrichments: { '1001': expect.objectContaining({ businessId: 'b1001' }) } });
    expect(h.portMessages.get(7)).toEqual([]);
  });
});
