import { describe, expect, it, vi } from 'vitest';
import type { AccessSubject, AccessTraceNode } from '../types';
import { AccessModeService, type AccessModeClient } from '../access-mode-service';
import { UNAVAILABLE_REASON } from '../access-mode';

const SUBJECTS: AccessSubject[] = [{ rid: '900', name: 'Maya', kind: 'user', businessId: 'maya_chen' }];
const t = (resource: string, result: boolean): AccessTraceNode => ({ element: 'TraceRequest', result, timedOut: false, details: { resource }, children: [] });

/** Answers every command; throws for any request naming `bad`. */
function client(bad?: string, fail?: Error): AccessModeClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    listAccessSubjects: vi.fn(async () => SUBJECTS),
    fetchAccessTraces: vi.fn(async (_subject: string, commands: Parameters<AccessModeClient['fetchAccessTraces']>[1]) => {
      const rids: string[] = [...new Set(commands.flatMap(c => [...c.rids]))];
      calls.push(rids);
      if (fail) throw fail;
      if (bad && rids.includes(bad)) throw new Error(`Cannot cast ${bad}`);
      return commands.map(c => c.action === 'CREATE' ? [t('', true)] : c.rids.map((r: string) => t(r, c.action === 'READ')));
    }),
  };
}

const ok = () => { /* environment unchanged */ };

describe('AccessModeService', () => {
  it('sends one request for a chunk and returns all four actions per node', async () => {
    const c = client();
    const res = await new AccessModeService().decide(c, 'env', '900', ['1', '2', '3'], ok);
    expect(c.calls).toEqual([['1', '2', '3']]);
    expect(res.verdicts['2']).toMatchObject({ READ: { state: 'allowed' }, UPDATE: { state: 'denied' }, CREATE: { state: 'allowed' }, DELETE: { state: 'denied' } });
  });

  it('isolates one failing node; the others keep their answers', async () => {
    const c = client('3');
    const res = await new AccessModeService().decide(c, 'env', '900', ['1', '2', '3', '4'], ok);
    expect(res.verdicts['1'].READ?.state).toBe('allowed');
    expect(res.verdicts['4'].READ?.state).toBe('allowed');
    expect(res.verdicts['3'].READ).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Cannot cast 3') });
    expect(c.calls.length).toBeLessThan(8);
  });

  it('reports an older server instead of failing every node, and remembers it', async () => {
    const s = new AccessModeService();
    const c = client(undefined, new Error('java.lang.ClassNotFoundException: AccessTraceCommand'));
    expect(await s.decide(c, 'env', '900', ['1'], ok)).toEqual({ verdicts: {}, unavailable: true });
    expect(s.status('env')).toEqual({ available: false, reason: UNAVAILABLE_REASON });
    expect(s.status('other')).toBeUndefined();
  });

  it('a connection failure is not split per node', async () => {
    const c = client(undefined, new Error('BMP at x timed out'));
    await expect(new AccessModeService().decide(c, 'env', '900', ['1', '2'], ok)).rejects.toThrow(/timed out/);
    expect(c.calls).toHaveLength(1);
  });

  it('checks the environment around the BMP call', async () => {
    let switched = false;
    const assert = () => { if (switched) throw new Error('changed'); };
    const c: AccessModeClient = { listAccessSubjects: async () => SUBJECTS, fetchAccessTraces: async () => { switched = true; return []; } };
    await expect(new AccessModeService().decide(c, 'env', '900', ['1'], assert)).rejects.toThrow('changed');
  });

  it('loads subjects once per environment and probes availability once', async () => {
    const s = new AccessModeService();
    const c = client();
    const a = await s.prepare(c, 'env', ok);
    const b = await s.prepare(c, 'env', ok);
    expect(a).toEqual({ subjects: SUBJECTS, available: true });
    expect(b.subjects).toBe(a.subjects);
    expect(c.listAccessSubjects).toHaveBeenCalledTimes(1);
    expect(c.fetchAccessTraces).toHaveBeenCalledTimes(1);
  });

  it('the availability probe marks an older server unavailable', async () => {
    const s = new AccessModeService();
    const res = await s.prepare(client(undefined, new Error('InvalidClassException: AccessTraceRequestDTO')), 'env', ok);
    expect(res).toMatchObject({ available: false, reason: UNAVAILABLE_REASON });
  });

  it('rejects malformed input', async () => {
    const s = new AccessModeService();
    await expect(s.decide(client(), 'env', 'x', ['1'], ok)).rejects.toThrow();
    await expect(s.decide(client(), 'env', '900', ['1x'], ok)).rejects.toThrow();
    await expect(s.decide(client(), 'env', '900', Array.from({ length: 51 }, (_, i) => String(i)), ok)).rejects.toThrow();
  });

  it('fetches the full trace for one node, with CREATE naming the node as parent', async () => {
    const c = client();
    await new AccessModeService().trace(c, 'env', '900', '5', 'CREATE', ok);
    const [, commands, depth] = (c.fetchAccessTraces as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(commands).toEqual([{ action: 'CREATE', rids: ['5'], updates: { type: '', parent_rid: '5' } }]);
    expect(depth).toBe(10);
  });
});
