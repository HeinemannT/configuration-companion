/**
 * Every RID a summary read asks for ends in exactly one place: named,
 * `missing` (the server says it is not there) or `failed` (ask again).
 * A per-object failure is never dropped silently.
 */
import { describe, expect, it } from 'vitest';
import { isNotThereError, readSummaries, type SummaryReader } from '../object-summaries';
import { framedLog, TEST_FRAME } from './ec-frame-fixtures';

const OK = '5100000000000000001';
const GONE = '5100000000000000002';
const BUSY = '5100000000000000003';
const QUIET = '5100000000000000004';

function contextReader(): SummaryReader {
  return {
    resolveRefs: async () => new Map(),
    executeEc: async () => ({ ok: false, error: 'not used' }),
    executeEcEach: async (_code, rids) => new Map(rids.map(rid => [rid,
      rid === OK ? { ok: true, log: framedLog([[OK, 'ClassConfig', 'Status type', 'status_type']]) }
      : rid === GONE ? { ok: false, error: 'Object read returned no data', errorKind: 'server' as const }
      : rid === BUSY ? { ok: false, error: 'Server busy, try again', errorKind: 'server' as const }
      : { ok: true, log: framedLog([]) }])),
  };
}

describe('summary read outcome', () => {
  it('names what it read, reports what is not there and what failed', async () => {
    const r = await readSummaries(contextReader(), [OK, GONE, BUSY, QUIET], () => TEST_FRAME);
    expect(r.summaries.map(s => s.rid)).toEqual([OK]);
    // QUIET ran and wrote no row: DEV answers a RID that does not exist this way.
    expect(r.missing.sort()).toEqual([GONE, QUIET].sort());
    expect(Object.keys(r.failed)).toEqual([BUSY]);
    expect(r.failed[BUSY]).toBe('Server busy, try again');
  });

  it('an object the answer leaves out entirely is failed, not missing', async () => {
    const reader: SummaryReader = { ...contextReader(), executeEcEach: async () => new Map() };
    const r = await readSummaries(reader, [OK], () => TEST_FRAME);
    expect(r.missing).toEqual([]);
    expect(Object.keys(r.failed)).toEqual([OK]);
  });

  it('a lost connection fails the read as a whole', async () => {
    const reader: SummaryReader = { ...contextReader(), executeEcEach: async (_c, rids) => new Map(rids.map(rid => [rid, { ok: false, error: 'Not signed in', errorKind: 'not-signed-in' as const }])) };
    await expect(readSummaries(reader, [OK], () => TEST_FRAME)).rejects.toThrow('Not signed in');
  });

  it('tells "not there" from other errors', () => {
    expect(isNotThereError('Object read returned no data')).toBe(true);
    expect(isNotThereError('Object not found: 123')).toBe(true);
    expect(isNotThereError('ClassCastException')).toBe(false);
    expect(isNotThereError(undefined)).toBe(false);
  });
});
