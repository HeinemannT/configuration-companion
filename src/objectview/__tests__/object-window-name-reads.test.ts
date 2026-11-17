/**
 * Names of reference targets in the object window: what the server says
 * about an object (not there, not readable) is remembered; a read that
 * failed or dropped an answer is asked once more at once, then shows Retry;
 * a load never inherits another read's pending or failed state.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FullObject, ObjectSummary } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ObjectWindowController, type ObjectWindowSource, type SummaryAnswer } from '../window/controller';
import type { WindowModel } from '../window/view';

const A = '7705595896874502408';
const B = '7705595896874502409';
const X = '5100000000000000001';
const Y = '5100000000000000002';

const obj = (rid: string, refs: Record<string, string[]>): FullObject =>
  ({ rid, type: 'Scorecard', name: `n${rid.slice(-3)}`, businessId: `b${rid.slice(-3)}`, props: {}, references: refs, overridden: [] });
const root = (o: FullObject): ObjectRootPayload => ({ rid: o.rid, root: o, rows: [], nodes: {}, posts: 1, ms: 1 });
const named = (rid: string): ObjectSummary => ({ rid, type: 'ClassConfig', name: `name ${rid.slice(-3)}`, businessId: `id${rid.slice(-3)}` });
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };

function harness(roots: Record<string, ObjectRootPayload>, readSummaries: ObjectWindowSource['readSummaries']) {
  let last: WindowModel | undefined;
  const src = {
    openRoot: vi.fn(async (rid: string) => roots[rid]),
    readSummaries: vi.fn(readSummaries),
    fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => ({ objects: {}, errors: {} })),
    run: vi.fn(async () => { throw new Error('no writes in this test'); }),
  } satisfies ObjectWindowSource;
  const ctl = new ObjectWindowController({ update: m => { last = m; } }, src);
  return { ctl, src, model: () => last! };
}

describe('reference names in the object window', () => {
  it('a dropped answer is asked once more at once and then named', async () => {
    let calls = 0;
    const { ctl, src, model } = harness({ [A]: root(obj(A, { statusType: [X] })) }, async (rids): Promise<SummaryAnswer> => {
      calls++;
      // The first answer leaves X out without saying why.
      return calls === 1 ? { summaries: [] } : { summaries: rids.map(named) };
    });
    await ctl.open(A, { type: 'Scorecard' });
    await flush();
    expect(src.readSummaries).toHaveBeenCalledTimes(2);
    expect(model().summaries[X]?.name).toBe('name 001');
    expect(model().missing?.[X]).toBeUndefined();
    expect(model().summariesError).toBeUndefined();
  });

  it('a name that fails twice shows the reason with Retry, is not remembered, and Retry names it', async () => {
    let fail = true;
    const { ctl, src, model } = harness({ [A]: root(obj(A, { statusType: [X] })) }, async (rids): Promise<SummaryAnswer> =>
      (fail ? { summaries: [], failed: Object.fromEntries(rids.map(r => [r, 'Server busy'])) } : { summaries: rids.map(named) }));
    await ctl.open(A, { type: 'Scorecard' });
    await flush();
    expect(src.readSummaries).toHaveBeenCalledTimes(2);
    expect(model().summaries[X]).toBeUndefined();
    expect(model().missing?.[X]).toBeUndefined();
    expect(model().summariesError).toBe('Server busy');
    fail = false;
    await ctl.retryNames([X]);
    expect(model().summaries[X]?.name).toBe('name 001');
  });

  it('remembers what the server says is not there, and does not ask again', async () => {
    const { ctl, src, model } = harness({ [A]: root(obj(A, { statusType: [X] })), [B]: root(obj(B, { statusType: [X] })) },
      async (rids): Promise<SummaryAnswer> => ({ summaries: [], missing: rids }));
    await ctl.open(A, { type: 'Scorecard' });
    await flush();
    expect(model().missing?.[X]).toBe(true);
    await ctl.open(B, { type: 'Scorecard' });
    await flush();
    expect(src.readSummaries).toHaveBeenCalledTimes(1);
  });

  it('a navigation does not inherit another read in flight: it waits, then asks itself', async () => {
    // A's read of X and Y is held, then drops X twice; B (reached through
    // an expression link) wants X too while A's read is still under way.
    const gates: Array<() => void> = [];
    let call = 0;
    const { ctl, src, model } = harness({ [A]: root(obj(A, { statusType: [X], yearDef: [Y] })), [B]: root(obj(B, { statusType: [X] })) },
      async (rids): Promise<SummaryAnswer> => {
        const n = ++call;
        if (n <= 2) await new Promise<void>(r => gates.push(r));
        return n <= 2 ? { summaries: rids.filter(r => r !== X).map(named) } : { summaries: rids.map(named) };
      });
    await ctl.open(A, { type: 'Scorecard' });
    await flush();
    await ctl.open(B, { type: 'Scorecard' });
    await flush();
    // B did not start its own read of X while A's was pending, and shows it as pending.
    expect(src.readSummaries).toHaveBeenCalledTimes(1);
    expect(model().pendingNames?.has(X)).toBe(true);
    gates.shift()!();
    await flush();
    gates.shift()!();
    await flush();
    // A's read gave up on X; B then asked for X itself.
    expect(src.readSummaries.mock.calls.at(-1)?.[0]).toEqual([X]);
    expect(model().summaries[X]?.name).toBe('name 001');
    expect(model().summaries[Y]?.name).toBe('name 002');
    expect(model().pendingNames?.has(X)).toBe(false);
  });

  it('a lost connection is not asked again at once', async () => {
    const { ctl, src, model } = harness({ [A]: root(obj(A, { statusType: [X] })) }, async () => { throw new Error('Not connected to BMP'); });
    await ctl.open(A, { type: 'Scorecard' });
    await flush();
    expect(src.readSummaries).toHaveBeenCalledTimes(1);
    expect(model().summariesError).toBe('Not connected to BMP');
    expect(model().missing?.[X]).toBeUndefined();
  });
});
