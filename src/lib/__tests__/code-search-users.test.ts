/**
 * New credentials for a profile (same profile id and server URL, another
 * client): nothing the code search kept for the old client is served to the
 * new one, through the real call sites (code-index-service serverScanSource,
 * noteSavedObject; bmp-client retire), and a search of the old client that
 * is still running does not leave anything behind.
 */
import { describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { server, type SimObject } from './code-search-sim';
import type { SwContext } from '../sw-context';

const URL = 'https://bmp.users.test/Ws/';
// The expression root lists as RID 1 in the simulated server; the object lies under it.
const obj = (code: string, stamp = 'Nov 1, 2026 10:00:00'): SimObject => ({ rid: '501', type: 'ExtendedExpression', id: 'e1', name: 'E', stamp, root: 'expression', parent: '1', code: { expression: code } });

async function load() {
  vi.resetModules();
  mockChromeStorage();
  (globalThis.chrome as unknown as { runtime: Record<string, unknown> }).runtime.sendMessage = vi.fn(async () => undefined);
  const svc = await import('../code-index-service');
  const { runCodeSearch } = await import('../code-search');
  const { codeReadCache } = await import('../code-scope-read');
  const feed = await import('../code-feed');
  const { BmpClient } = await import('../bmp-client');
  return { svc, runCodeSearch, codeReadCache, feed, BmpClient };
}

/** A client of the profile: one object per credentials (the pool's). */
function client(objects: SimObject[]) {
  return Object.assign(server(objects, { context: true }), { serverUrl: URL, sessionEpoch: 0 });
}
const ctxOf = (c: object) => ({ client: c, settings: { activeProfileId: 'p1' } }) as unknown as SwContext;

describe('another user of the same profile and server', () => {
  it('is never served what the client before kept; the old one\'s code goes when it is retired, and a search still running for it keeps nothing', async () => {
    const { svc, runCodeSearch, codeReadCache, feed, BmpClient } = await load();
    const a = client([obj('_a := secret A')]);
    const ctxA = ctxOf(a);
    const found = async (ctx: SwContext, text: string) => {
      const src = await svc.serverScanSource(undefined, undefined, ctx);
      return (await runCodeSearch({ mode: 'text', text }, src!, () => {})).matchedObjects;
    };
    expect(await found(ctxA, 'secret')).toBe(1);
    const envA = svc.searchEnvironment(ctxA)!;
    // Credentials changed: a new client; the server now answers other code
    // (same stamp and length: only the key keeps them apart).
    const b = client([obj('_a := public B')]);
    const ctxB = ctxOf(b);
    expect(await found(ctxB, 'secret')).toBe(0);
    expect(await found(ctxB, 'public')).toBe(1);
    // A save by the new user does not touch the old key either.
    svc.noteSavedObject('501', undefined, ctxB);
    expect(codeReadCache.knows(envA, '501')).toBe(true);
    // The old client is retired (what clientForProfile and evictPooledClient do).
    feed.retireClient(a);
    expect(codeReadCache.knows(envA, '501')).toBe(false);
    // A search of the old client still running when it is retired keeps nothing.
    const c = client([obj('_a := late C')]);
    const ctxC = ctxOf(c);
    const envC = svc.searchEnvironment(ctxC)!;
    const exec = c.executeEcBatch;
    c.executeEcBatch = async (codes, sg, ms) => { const r = await exec(codes, sg, ms); if (codes.some(x => x.includes('"~CREV_R~1:I"'))) feed.retireClient(c); return r; };
    expect(await found(ctxC, 'late')).toBe(1);
    expect(codeReadCache.knows(envC, '501')).toBe(false);
    expect(codeReadCache.listing(envC, 'x')).toBeUndefined();
    // BmpClient.retire reaches the same listener.
    const real = new BmpClient(URL, 'u', 'p', 'p1', 'portal', '');
    const envR = `p1@${URL}#${feed.clientKey(real)}`;
    codeReadCache.put(envR, '7', { type: 'ExtendedExpression', stamp: 's', len: 1, o: { rid: '7', businessId: '', name: '', parent: '', grandparent: '', stamp: 's', code: { expression: 'x' } } });
    expect(codeReadCache.knows(envR, '7')).toBe(true);
    real.retire();
    expect(codeReadCache.knows(envR, '7')).toBe(false);
  });
});
