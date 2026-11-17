/**
 * Tests for ObjectCache's TTL eviction. Phase-4 added a 1h TTL so
 * server-side renames (Config Studio) eventually propagate. The
 * surrounding LRU + persistence behaviour is covered elsewhere; here
 * we just lock down the timestamp arithmetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectCache } from '../object-cache';

describe('ObjectCache TTL', () => {
  // chrome.storage.local mock — get always returns empty; set is a no-op.
  beforeEach(() => {
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    };
  });

  it('returns cached object when within TTL', async () => {
    const cache = new ObjectCache('test');
    const now = Date.now();
    cache.put({
      rid: '1', businessId: 'foo', name: 'Foo', type: 'Scorecard',
      source: 'server', discoveredAt: now, updatedAt: now,
    });
    expect(cache.get('1')?.name).toBe('Foo');
  });

  it('evicts and returns undefined when entry is older than the TTL', () => {
    const cache = new ObjectCache('test');
    const longAgo = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    cache.put({
      rid: '1', businessId: 'foo', name: 'StaleName', type: 'Scorecard',
      source: 'server', discoveredAt: longAgo, updatedAt: longAgo,
    });
    expect(cache.get('1')).toBeUndefined();
    // The stale entry should also have been evicted from the cache,
    // so subsequent gets stay empty without us having to re-check
    // the timestamp every time.
    expect(cache.size).toBe(0);
  });

  it('anchors the TTL on the server read (enrichedAt), not on the last merge', () => {
    const cache = new ObjectCache('test');
    const now = Date.now();
    cache.put({
      rid: '1', businessId: 'foo', name: 'Re-read', type: 'Scorecard',
      source: 'server', identityEnriched: true,
      discoveredAt: now - 5 * 60 * 60 * 1000, // discovered 5h ago
      enrichedAt: now, // identity read from the server just now
      updatedAt: now,
    });
    expect(cache.get('1')?.name).toBe('Re-read');
  });

  it('rediscovery in the page does not extend the lifetime of an old identity', () => {
    const cache = new ObjectCache('test');
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    cache.put({
      rid: '1', businessId: 'foo', name: 'Old', type: 'Scorecard',
      source: 'server', identityEnriched: true,
      discoveredAt: twoHoursAgo, enrichedAt: twoHoursAgo, updatedAt: twoHoursAgo,
    });
    // The DOM scan finds the object again on every page load. Before the fix
    // this merge refreshed updatedAt and the entry never expired.
    const now = Date.now();
    cache.put({ rid: '1', source: 'dom', discoveredAt: now, updatedAt: now });
    expect(cache.get('1')).toBeUndefined();
  });

  it('TTL miss does not break subsequent puts', () => {
    const cache = new ObjectCache('test');
    const longAgo = Date.now() - 2 * 60 * 60 * 1000;
    cache.put({
      rid: '1', businessId: 'foo', name: 'Old', type: 'Scorecard',
      source: 'server', discoveredAt: longAgo, updatedAt: longAgo,
    });
    cache.get('1'); // triggers eviction
    const now = Date.now();
    cache.put({
      rid: '1', businessId: 'foo', name: 'Fresh', type: 'Scorecard',
      source: 'server', discoveredAt: now, updatedAt: now,
    });
    expect(cache.get('1')?.name).toBe('Fresh');
  });
});
