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
  it.each(['success-first', 'failure-first'])('preserves a concurrent success (%s) without blocking later invalidation', async order => {
    mockChromeStorage();
    incrementGeneration();
    const state = new ContentState();
    const cache = new ObjectCache();
    const identity = { businessId: 'resolved', type: 'TextElement' };
    type Result = { results: Record<string, typeof identity>; error?: string };
    let finishFailure!: (result: Result) => void;
    let finishSuccess!: (result: Result) => void;
    const failure: Result = { results: {}, error: 'Connection lost' };
    const batchEnrich = vi.fn()
      .mockImplementationOnce(() => new Promise<Result>(resolve => { finishFailure = resolve; }))
      .mockImplementationOnce(() => new Promise<Result>(resolve => { finishSuccess = resolve; }))
      .mockResolvedValue(failure);
    const broadcast = vi.fn((message: InspectorMessage) => {
      if (message.type === 'BADGE_ENRICHMENT') state.receiveEnrichments(message.enrichments);
    });
    setSwContext({ client: { batchEnrich }, cache, logActivity: vi.fn(), sendToPanel: vi.fn(),
      broadcastToContent: broadcast } as unknown as SwContext);
    const failing = enrichBadges(['42']);
    const succeeding = enrichBadges(['42']);
    if (order === 'success-first') {
      finishSuccess({ results: { '42': identity } });
      await succeeding;
      finishFailure(failure);
      await failing;
      expect(broadcast).toHaveBeenCalledTimes(1);
    } else {
      finishFailure(failure);
      await failing;
      finishSuccess({ results: { '42': identity } });
      await succeeding;
    }
    expect(state.enrichments.get('42')).toEqual(identity);
    expect(cache.get('42')).toMatchObject(identity);
    const calls = batchEnrich.mock.calls.length;
    await enrichBadges(['42']);
    expect(batchEnrich).toHaveBeenCalledTimes(calls);
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

  it('cancels all concurrent batches even if a cache-only caller ran last', async () => {
    mockChromeStorage();
    incrementGeneration();
    const signals: AbortSignal[] = [];
    const batchEnrich = vi.fn((_rids: string[], signal: AbortSignal) => new Promise((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const broadcast = vi.fn();
    const ctx = {
      client: { batchEnrich }, cache: { get: (rid: string) => rid === '3' ? { businessId: 'cached' } : undefined,
        flush: vi.fn(async () => {}), size: 1 },
      logActivity: vi.fn(), sendToPanel: vi.fn(), broadcastToContent: broadcast,
    } as unknown as SwContext;
    setSwContext(ctx);
    const first = enrichBadges(['1']);
    const second = enrichBadges(['2']);
    await enrichBadges(['3']);
    expect(signals).toHaveLength(2);
    incrementGeneration();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    await Promise.all([first, second]);
    expect(broadcast.mock.calls.flat()).not.toContainEqual({ type: 'BADGE_ENRICHMENT', enrichments: { '1': {} } });
    expect(batchEnrich).toHaveBeenCalledTimes(2);
  });
});
