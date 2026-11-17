import { describe, expect, it, vi } from 'vitest';
import type { AccessSubject } from '../../lib/types';
import type { ActionVerdicts } from '../../lib/access-mode';
import { AccessMode, type AccessSource, type DecideAnswer, type TraceAnswer } from '../window/access-state';

const MAYA: AccessSubject = { rid: '900', name: 'Maya', kind: 'user', businessId: 'maya_chen' };
const ROLE: AccessSubject = { rid: '901', name: 'Process Manager', kind: 'role', businessId: 'roleProcessManager' };
const all = (state: 'allowed' | 'denied'): ActionVerdicts => state === 'allowed'
  ? { READ: { state, by: [], evaluated: 1 }, UPDATE: { state, by: [], evaluated: 1 }, CREATE: { state, by: [], evaluated: 1 }, DELETE: { state, by: [], evaluated: 1 } }
  : { READ: { state, evaluated: 1, denyMatched: [] }, UPDATE: { state, evaluated: 1, denyMatched: [] }, CREATE: { state, evaluated: 1, denyMatched: [] }, DELETE: { state, evaluated: 1, denyMatched: [] } };

interface Pending<T> { req: any; resolve(v: T): void; reject(e: unknown): void }

/** A source whose answers the test releases by hand. */
function harness(over: Partial<AccessSource> = {}) {
  const decides: Array<Pending<DecideAnswer>> = [];
  const traces: Array<Pending<TraceAnswer>> = [];
  const saved: unknown[] = [];
  const source: AccessSource = {
    status: vi.fn(async () => ({})),
    prepare: vi.fn(async () => ({ subjects: [MAYA, ROLE], available: true, environmentName: 'DEV' })),
    decide: vi.fn(req => new Promise<DecideAnswer>((resolve, reject) => { decides.push({ req, resolve, reject }); })),
    trace: vi.fn(req => new Promise<TraceAnswer>((resolve, reject) => { traces.push({ req, resolve, reject }); })),
    loadPrefs: vi.fn(async () => ({ recents: [] })),
    savePrefs: vi.fn((_env, prefs) => { saved.push(prefs); }),
    ...over,
  };
  const queue: Array<() => void> = [];
  const mode = new AccessMode(source, { defer: fn => queue.push(fn), now: () => 1000 });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); while (queue.length) queue.shift()!(); await Promise.resolve(); };
  const answer = (p: Pending<DecideAnswer>, verdicts: Record<string, ActionVerdicts>, extra: Partial<DecideAnswer> = {}) =>
    p.resolve({ requestId: p.req.requestId, environment: p.req.environment, subjectRid: p.req.subjectRid, ok: true, verdicts, ...extra });
  return { mode, source, decides, traces, saved, flush, answer };
}

async function ready(h: ReturnType<typeof harness>, rids = ['1', '2', '3']) {
  h.mode.setEnvironment('p1@https://bmp/');
  await h.flush();
  h.mode.toggle(true);
  h.mode.setNodes(rids, 1);
  h.mode.pick(MAYA);
  await h.flush();
}

describe('AccessMode: request matching and staleness', () => {
  it('fills the visible nodes from one request and marks them loading until then', async () => {
    const h = harness();
    await ready(h);
    expect(h.decides).toHaveLength(1);
    expect(h.decides[0].req).toMatchObject({ environment: 'p1@https://bmp/', subjectRid: '900', rids: ['1', '2', '3'] });
    expect(h.mode.cell('1', 'READ').state).toBe('loading');
    h.answer(h.decides[0], { 1: all('allowed'), 2: all('denied'), 3: all('denied') });
    await h.flush();
    expect(h.mode.cell('1', 'READ').state).toBe('allowed');
    expect(h.mode.cell('2', 'DELETE').state).toBe('denied');
    expect(h.mode.progress()).toEqual({ total: 3, done: 3, requests: 0 });
  });

  it('a slow answer for an earlier subject never overwrites the newer one', async () => {
    const h = harness();
    await ready(h);
    const first = h.decides[0];
    h.mode.pick(ROLE);
    await h.flush();
    const second = h.decides[1];
    expect(second.req.subjectRid).toBe('901');
    h.answer(second, { 1: all('denied'), 2: all('denied'), 3: all('denied') });
    await h.flush();
    h.answer(first, { 1: all('allowed'), 2: all('allowed'), 3: all('allowed') });
    await h.flush();
    expect(h.mode.cell('1', 'READ').state).toBe('denied');
  });

  it('ignores an answer whose id, subject or environment does not match its request', async () => {
    const h = harness();
    await ready(h);
    const p = h.decides[0];
    p.resolve({ requestId: 'other', environment: p.req.environment, subjectRid: '900', ok: true, verdicts: { 1: all('allowed') } });
    await h.flush();
    expect(h.mode.cell('1', 'READ').state).toBe('loading');
  });

  it('drops answers for nodes no longer visible and for older data', async () => {
    const h = harness();
    await ready(h);
    h.mode.setNodes(['1', '2'], 1);
    h.answer(h.decides[0], { 1: all('allowed'), 2: all('allowed'), 3: all('allowed') });
    await h.flush();
    expect(h.mode.cell('3', 'READ').state).toBe('idle');
    // The window's data changed (a save): results for generation 1 are gone and asked again.
    h.mode.setNodes(['1', '2'], 2);
    await h.flush();
    expect(h.mode.cell('1', 'READ').state).toBe('loading');
    expect(h.decides).toHaveLength(2);
  });

  it('drops answers after the connection changed', async () => {
    const h = harness();
    await ready(h);
    const p = h.decides[0];
    h.mode.setEnvironment('p2@https://other/');
    h.answer(p, { 1: all('allowed') });
    await h.flush();
    expect(h.mode.subject).toBeNull();
    expect(h.mode.cell('1', 'READ').state).toBe('idle');
  });

  it('a timeout or a missing decision is "could not evaluate" with the reason', async () => {
    const h = harness();
    await ready(h);
    h.answer(h.decides[0], { 1: all('allowed') });
    await h.flush();
    expect(h.mode.cell('2', 'READ')).toEqual({ state: 'unknown', reason: 'BMP returned no decision for this node.' });
    h.mode.retry('2');
    await h.flush();
    h.decides[1].reject(new Error('Request timed out'));
    await h.flush();
    expect(h.mode.cell('2', 'UPDATE')).toEqual({ state: 'unknown', reason: 'No answer within 30 s.' });
  });

  it('a failed request names its error on every node it asked for', async () => {
    const h = harness();
    await ready(h);
    h.decides[0].resolve({ requestId: h.decides[0].req.requestId, environment: 'p1@https://bmp/', subjectRid: '900', ok: false, error: 'The BMP connection changed.' });
    await h.flush();
    expect(h.mode.cell('3', 'CREATE')).toEqual({ state: 'unknown', reason: 'The BMP connection changed.' });
  });
});

describe('AccessMode: batching', () => {
  it('splits a large tree into chunks of 10, two in flight, top of the tree first', async () => {
    const h = harness();
    const rids = Array.from({ length: 25 }, (_, i) => String(i + 1));
    await ready(h, rids);
    expect(h.decides.map(d => d.req.rids.length)).toEqual([10, 10]);
    expect(h.decides[0].req.rids[0]).toBe('1');
    expect(h.mode.progress()).toEqual({ total: 25, done: 0, requests: 2 });
    h.answer(h.decides[0], Object.fromEntries(h.decides[0].req.rids.map((r: string) => [r, all('denied')])));
    await h.flush();
    expect(h.decides).toHaveLength(3);
    expect(h.decides[2].req.rids).toEqual(['21', '22', '23', '24', '25']);
    expect(h.mode.progress().done).toBe(10);
  });

  it('asks nothing while the mode is off or no subject is chosen', async () => {
    const h = harness();
    h.mode.setEnvironment('p1@https://bmp/');
    h.mode.setNodes(['1'], 1);
    await h.flush();
    expect(h.decides).toHaveLength(0);
    h.mode.toggle(true);
    await h.flush();
    expect(h.decides).toHaveLength(0);
    expect(h.source.prepare).toHaveBeenCalledTimes(1);
  });
});

describe('AccessMode: subject, trace and availability', () => {
  it('keeps recents most recent first and saves the subject for the session', async () => {
    const h = harness();
    await ready(h);
    h.mode.pick(ROLE);
    h.mode.pick(MAYA);
    expect(h.mode.recents).toEqual(['900', '901']);
    expect(h.saved.at(-1)).toEqual({ subject: MAYA, recents: ['900', '901'] });
  });

  it('restores the subject saved for the environment', async () => {
    const h = harness({ loadPrefs: vi.fn(async () => ({ subject: ROLE, recents: ['901'] })) });
    h.mode.setEnvironment('p1@https://bmp/');
    await h.flush();
    expect(h.mode.subject).toEqual(ROLE);
    expect(h.mode.recents).toEqual(['901']);
  });

  it('fetches the trace for the selected node and action once its verdict is known', async () => {
    const h = harness();
    await ready(h);
    h.mode.select('2');
    expect(h.traces).toHaveLength(0);
    h.answer(h.decides[0], { 1: all('allowed'), 2: all('allowed'), 3: all('allowed') });
    await h.flush();
    expect(h.traces.map(t => t.req)).toEqual([expect.objectContaining({ rid: '2', action: 'READ', subjectRid: '900' })]);
    h.mode.setAction('CREATE');
    expect(h.traces[1].req).toMatchObject({ rid: '2', action: 'CREATE' });
    // A late answer for READ after the subject changed is dropped.
    h.mode.pick(ROLE);
    h.traces[0].resolve({ ...h.traces[0].req, ok: true, trace: { element: 'TraceRequest', result: false, timedOut: false, details: {}, children: [] } });
    await h.flush();
    expect(h.mode.trace('2', 'READ')).toBeUndefined();
  });

  it('the trace, the newer answer, updates the cell', async () => {
    const h = harness();
    await ready(h, ['1']);
    h.mode.select('1');
    h.answer(h.decides[0], { 1: all('allowed') });
    await h.flush();
    h.traces[0].resolve({ ...h.traces[0].req, ok: true, trace: { element: 'TraceRequest', result: false, timedOut: false, details: {}, children: [] } });
    await h.flush();
    expect(h.mode.cell('1', 'READ').state).toBe('denied');
  });

  it('an unavailable command turns the mode off and keeps the toggle off', async () => {
    const h = harness();
    await ready(h);
    h.answer(h.decides[0], {}, { unavailable: true });
    await h.flush();
    expect(h.mode.on).toBe(false);
    expect(h.mode.availability).toBe('unavailable');
    expect(h.mode.unavailableReason).toMatch(/no access test command/);
    h.mode.toggle(true);
    expect(h.mode.on).toBe(false);
  });

  it('a cached "unavailable" status disables the toggle before any request', async () => {
    const h = harness({ status: vi.fn(async () => ({ available: false, reason: 'Old BMP.' })) });
    h.mode.setEnvironment('p1@https://bmp/');
    await h.flush();
    h.mode.toggle(true);
    expect(h.mode.on).toBe(false);
    expect(h.mode.unavailableReason).toBe('Old BMP.');
    expect(h.source.prepare).not.toHaveBeenCalled();
  });

  it('a prepare answer without the command marks it unavailable', async () => {
    const h = harness({ prepare: vi.fn(async () => ({ subjects: [], available: false, reason: 'No users or roles.' })) });
    h.mode.setEnvironment('p1@https://bmp/');
    h.mode.toggle(true);
    await h.flush();
    expect(h.mode.on).toBe(false);
    expect(h.mode.unavailableReason).toBe('No users or roles.');
  });
});
