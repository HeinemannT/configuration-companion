// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentState } from '../../content-state';
import { syncOverlays, updateLabels } from '../../content-overlays';
import { sendToSW } from '../content-port';
import { enrichBadges, incrementGeneration, invalidateRid, refreshEnrichment } from '../enrichment';
import { mockChromeStorage } from './chrome-mock';
import { ObjectCache } from '../object-cache';
import { setSwContext, type SwContext } from '../sw-context';
import type { InspectorMessage } from '../types';

vi.mock('../content-port', () => ({ sendToSW: vi.fn() }));
vi.mock('../dom-scanner', () => ({ getAllRidElements: () => [] }));
vi.mock('../constants', async importOriginal => ({
  ...await importOriginal<typeof import('../constants')>(), ENRICHMENT_RETRY_DELAY: 0,
}));

afterEach(() => { incrementGeneration(); document.body.replaceChildren(); vi.clearAllMocks(); });

describe('badge failure and recovery across worker/content state', () => {
  it('answers concurrent requests for one rid from one post without blocking later invalidation', async () => {
    mockChromeStorage();
    incrementGeneration();
    const state = new ContentState();
    const cache = new ObjectCache();
    const identity = { businessId: 'resolved', type: 'TextElement' };
    const failure = { results: {}, error: 'Connection lost' };
    const batchEnrich = vi.fn()
      .mockResolvedValueOnce({ results: { '42': identity } })
      .mockResolvedValue(failure);
    const broadcast = vi.fn((message: InspectorMessage) => {
      if (message.type === 'BADGE_ENRICHMENT') state.receiveEnrichments(message.enrichments);
    });
    const toTab = vi.fn((message: InspectorMessage) => broadcast(message));
    const contentPorts = new Map([[7, { postMessage: toTab }], [8, { postMessage: toTab }]]);
    setSwContext({ client: { batchEnrich }, cache, logActivity: vi.fn(), sendToPanel: vi.fn(),
      contentPorts, broadcastToContent: broadcast } as unknown as SwContext);
    // Two frames ask for the same rid at once: one post, each asking tab answered once.
    await Promise.all([enrichBadges(['42'], 7), enrichBadges(['42'], 8)]);
    expect(batchEnrich).toHaveBeenCalledTimes(1);
    expect(toTab).toHaveBeenCalledTimes(2);
    expect(state.enrichments.get('42')).toEqual(identity);
    expect(cache.get('42')).toMatchObject(identity);
    // Later requests are answered from the cache.
    await enrichBadges(['42']);
    expect(batchEnrich).toHaveBeenCalledTimes(1);
    // An explicit edit invalidates the identity; it must not be kept forever.
    await invalidateRid('42');
    expect(state.enrichments.get('42')).toEqual({});
  });

  it('stops loading after batch failure, avoids render retry loops, and reloads only failed identities on recovery', async () => {
    mockChromeStorage();
    incrementGeneration();
    const state = new ContentState();
    state.inspectActive = true;
    const targets = ['42', '43'].map(rid => {
      const element = document.createElement('div');
      document.body.append(element);
      return { element, rid };
    });
    state.receiveEnrichments({ '43': { businessId: 'existing', type: 'TextElement' } });
    const batchEnrich = vi.fn().mockResolvedValueOnce({ results: {}, error: 'Connection lost' })
      .mockResolvedValueOnce({ results: {}, error: 'Connection lost' })
      .mockResolvedValue({ results: { '42': { businessId: 'recovered', type: 'TextElement' } } });
    const messages: InspectorMessage[] = [];
    setSwContext({
      client: { batchEnrich }, cache: new ObjectCache(), logActivity: vi.fn(), sendToPanel: vi.fn(),
      broadcastToContent: (message: InspectorMessage) => {
        messages.push(message);
        if (message.type === 'BADGE_ENRICHMENT') {
          state.receiveEnrichments(message.enrichments);
          updateLabels(state);
        } else if (message.type === 'RE_ENRICH') {
          state.retryFailedEnrichments();
          syncOverlays(state, targets);
        }
      },
    } as unknown as SwContext);
    syncOverlays(state, targets);
    await enrichBadges(['42']);
    expect(batchEnrich).toHaveBeenCalledTimes(2);
    expect(state.enrichments.get('42')).toEqual({});
    expect(state.requestedRids.has('42')).toBe(false);
    vi.mocked(sendToSW).mockClear();
    syncOverlays(state, targets);
    expect(sendToSW).not.toHaveBeenCalled();

    refreshEnrichment();
    expect(messages.some(message => message.type === 'RE_ENRICH')).toBe(true);
    expect(sendToSW).toHaveBeenCalledWith({ type: 'ENRICH_BADGES', rids: ['42'] });
    expect(state.enrichments.get('43')?.businessId).toBe('existing');
    await enrichBadges(['42']);
    expect(batchEnrich).toHaveBeenCalledTimes(3);
    expect(state.enrichments.get('42')?.businessId).toBe('recovered');
    expect(targets[0].element.textContent).toContain('recovered');
  });

  it('drops waiting badge work on a generation change without interrupting the post in flight', async () => {
    mockChromeStorage();
    incrementGeneration();
    const signals: AbortSignal[] = [];
    let finish!: (value: unknown) => void;
    const batchEnrich = vi.fn((_rids: string[], signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(resolve => { finish = resolve; });
    });
    const broadcast = vi.fn();
    const ctx = {
      client: { batchEnrich }, cache: { get: (rid: string) => rid === '3' ? { businessId: 'cached', identityEnriched: true } : undefined,
        putAll: vi.fn(), flush: vi.fn(async () => {}), size: 1 },
      logActivity: vi.fn(), sendToPanel: vi.fn(), broadcastToContent: broadcast,
    } as unknown as SwContext;
    setSwContext(ctx);
    const first = enrichBadges(['1']);
    const second = enrichBadges(['2']);
    await enrichBadges(['3']); // cache only: answered at once
    await vi.waitFor(() => expect(batchEnrich).toHaveBeenCalledTimes(1));
    expect(batchEnrich.mock.calls[0][0]).toEqual(['1', '2']); // coalesced
    const { requestClassOf } = await import('../request-class');
    const { requestClass, supersede } = requestClassOf(signals[0]);
    expect(requestClass).toBe('background');
    incrementGeneration();
    // Waiting work leaves the queue; the post in flight is not aborted.
    expect(supersede?.aborted).toBe(true);
    expect(signals[0].aborted).toBe(false);
    await Promise.all([first, second]);
    finish({ results: { '1': { businessId: 'stale' } } });
    await new Promise(r => setTimeout(r, 0));
    expect(broadcast.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ enrichments: { '1': { businessId: 'stale' } } }));
    expect(broadcast.mock.calls.flat()).not.toContainEqual({ type: 'BADGE_ENRICHMENT', enrichments: { '1': {} } });
    expect(batchEnrich).toHaveBeenCalledTimes(1);
  });
});
