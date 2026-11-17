import { describe, it, expect } from 'vitest';
import type { ActivityEntry } from '../types';
import { MERGE_WINDOW_MS, findRepeat, isUserWork, mergeRepeat, tidyMessage, trimActivity } from '../activity-policy';
import { transportActivity } from '../transport-activity';

const e = (id: number, change: Partial<ActivityEntry> = {}): ActivityEntry =>
  ({ id, time: id * 1000, level: 'info', message: `m${id}`, ...change });

describe('activity policy', () => {
  it('counts saves, runs, connection events and errors as user work', () => {
    expect(isUserWork({ level: 'success', category: 'change' })).toBe(true);
    expect(isUserWork({ level: 'success', category: 'connection' })).toBe(true);
    expect(isUserWork({ level: 'error', category: 'system' })).toBe(true);
    expect(isUserWork({ level: 'info', category: 'system' })).toBe(false);
    expect(isUserWork({ level: 'success' })).toBe(false);
  });

  it('evicts diagnostics before user work', () => {
    const list = [e(1, { category: 'change' }), e(2), e(3, { category: 'execution' }), e(4), e(5)];
    trimActivity(list, 3);
    expect(list.map(x => x.id)).toEqual([1, 3, 5]);
    trimActivity(list, 2); // only user work left to drop after the last diagnostic
    expect(list.map(x => x.id)).toEqual([1, 3]);
    trimActivity(list, 1);
    expect(list.map(x => x.id)).toEqual([3]);
  });

  it('keeps the newest diagnostics when the log is full of user work', () => {
    const list = Array.from({ length: 20 }, (_, i) => e(i + 1, { category: 'change' }));
    list.push(e(21, { category: 'system' }));
    trimActivity(list, 20); // floor: 2 diagnostics
    expect(list.at(-1)?.id).toBe(21);
    expect(list[0].id).toBe(2);
    list.push(e(22, { category: 'system' }), e(23, { category: 'system' }));
    trimActivity(list, 20);
    expect(list.filter(x => !isUserWork(x)).map(x => x.id)).toEqual([22, 23]);
    expect(list).toHaveLength(20);
  });

  it('folds a repeated diagnostic within the window into the earlier entry', () => {
    const list = [e(1, { message: 'Found a BMP page', category: 'system' }), e(2, { category: 'change' })];
    const next = e(3, { message: 'Found a BMP page', category: 'system', time: 1000 + MERGE_WINDOW_MS - 1 });
    const at = findRepeat(list, next);
    expect(at).toBe(0);
    const merged = mergeRepeat(list, at, next);
    expect(merged).toMatchObject({ id: 1, count: 2, time: next.time });
    expect(list.map(x => x.id)).toEqual([2, 1]);
    expect(findRepeat(list, { ...next, time: next.time + MERGE_WINDOW_MS + 1 })).toBe(-1);
    expect(findRepeat(list, e(9, { message: 'm2', category: 'change', time: 2500 }))).toBe(-1); // user work never folds
  });

  it('moves a trailing "(123ms)" into the duration', () => {
    expect(tidyMessage('Saved Rating on KRI (186ms)')).toEqual({ message: 'Saved Rating on KRI', durationMs: 186 });
    expect(tidyMessage('Saved Rating (186ms)', { durationMs: 190 })).toEqual({ message: 'Saved Rating', durationMs: 190 });
    expect(tidyMessage('Saved Rating')).toEqual({ message: 'Saved Rating' });
  });
});

describe('transport activity', () => {
  const base = { intent: 'read' as const, operation: '9×IntegrationGetObjectCommand', commandCount: 9, queueDepth: 0, queueWaitMs: 0, durationMs: 510, requestBytes: 2206, responseBytes: 4_324_730, attempts: 1 };

  it('a large, fast read is a diagnostic with a readable sentence', () => {
    const a = transportActivity({ ok: true, ...base })!;
    expect(a.level).toBe('info');
    expect(a.message).toBe('Read 9 objects');
    expect(a.meta).toEqual({ category: 'system', action: 'server-request', durationMs: 510 });
    expect(a.detail).toContain('9×IntegrationGetObjectCommand');
    expect(a.detail).toContain('4.1 MB answer');
    expect(a.message).not.toMatch(/load|Command/);
  });

  it('an ordinary request is not logged; a failure is an error', () => {
    expect(transportActivity({ ok: true, ...base, responseBytes: 10_000 })).toBeNull();
    const f = transportActivity({ ok: false, ...base, error: { kind: 'network', message: 'socket closed' } } as never)!;
    expect(f).toMatchObject({ level: 'error', message: 'Could not read 9 objects (network)' });
    expect(transportActivity({ ok: false, ...base, error: { kind: 'cancelled', message: 'x' } } as never)).toBeNull();
  });

  it('a retried read says so without becoming a warning', () => {
    expect(transportActivity({ ok: true, ...base, responseBytes: 100, attempts: 2 })).toMatchObject({
      level: 'info', message: 'Read 9 objects, answered after 2 attempts',
    });
  });
});
