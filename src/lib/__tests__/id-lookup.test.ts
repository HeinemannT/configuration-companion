/**
 * Exact business-ID lookup without script text (id-lookup.ts): the ID
 * spaces from the type catalogue, the script lookup's order of preference,
 * and the BROWSE_RESOLVE handler sending no Extended Code for it.
 */
import { describe, expect, it, vi } from 'vitest';
import { idLookupCandidates, lookupIdByCommand, lookupRefsByCommand } from '../id-lookup';
import { mockChromeStorage } from './chrome-mock';

const catalogue = {
  types: {
    Category: { parents: [], concrete: true, idSpace: 'TEMPLATE' },
    Organisation: { parents: [], concrete: true, idSpace: 'ORGANISATION' },
    TextMethodConfig: { parents: [], concrete: true, idSpace: 'PROPERTY' },
    Identifiable: { parents: [], concrete: false },
  },
  models: {},
};

describe('ID lookup candidates', () => {
  it('a bare ID in every space, common namespaces first', () => {
    expect(idLookupCandidates('risk_view', catalogue)).toEqual([
      { space: 'TEMPLATE', id: 'risk_view' }, { space: 'ORGANISATION', id: 'risk_view' }, { space: 'PROPERTY', id: 'risk_view' },
    ]);
  });
  it('ns.rest: the rest in that namespace\'s spaces first', () => {
    expect(idLookupCandidates('k.pName', catalogue).slice(0, 2)).toEqual([{ space: 'PROPERTY', id: 'pName' }, { space: 'TEMPLATE', id: 'k.pName' }]);
  });
});

describe('lookupIdByCommand', () => {
  const client = (refs: Record<string, { rid: string } | null>, unavailable: string[] = []) => ({
    fetchTypeCatalogue: vi.fn(),
    resolvePolicyReferences: vi.fn(async () => ({ references: refs, unavailable, problems: [] })),
  });
  it('the first space that knows it; null when none; undefined when not asked', async () => {
    expect(await lookupIdByCommand(client({ 0: null, 1: { rid: '9223372036854775807' }, 2: null }), 'x', async () => catalogue as never)).toBe('9223372036854775807');
    expect(await lookupIdByCommand(client({ 0: null, 1: null, 2: null }), 'x', async () => catalogue as never)).toBeNull();
    expect(await lookupIdByCommand(client({ 0: null }, ['1', '2']), 'x', async () => catalogue as never)).toBeUndefined();
    expect(await lookupIdByCommand(client({}), 'x', async () => { throw new Error('no catalogue'); })).toBeUndefined();
  });

  it('code references: the ID in its namespace\'s spaces, all in one post; null, or undefined for no space', async () => {
    const cat = { types: { ...catalogue.types, Scorecard: { parents: [], concrete: true, idSpace: 'TEMPLATE' }, ExtendedExpression: { parents: [], concrete: true, idSpace: 'TEMPLATE' } }, models: {} };
    const c = {
      resolvePolicyReferences: vi.fn(async (refs: Array<{ token: string; space: string; id: string }>) => ({
        references: Object.fromEntries(refs.map(r => [r.token, r.id === 'known' ? { rid: '9223372036854775806' } : null])), unavailable: [], problems: [],
      })),
    };
    const out = await lookupRefsByCommand(c, [{ key: 't.known', ns: 't', id: 'known' }, { key: 't.zz_no_such_id_xq', ns: 't', id: 'zz_no_such_id_xq' }, { key: 'zz.x', ns: 'zz', id: 'x' }], async () => cat as never);
    expect(c.resolvePolicyReferences).toHaveBeenCalledTimes(1);
    // Only the namespace's own spaces: `t.x` is never looked up as "t.x" in another space.
    expect(c.resolvePolicyReferences.mock.calls[0][0].every((r: { id: string }) => !r.id.includes('.'))).toBe(true);
    expect(out?.get('t.known')).toBe('9223372036854775806');
    expect(out?.get('t.zz_no_such_id_xq')).toBeNull();
    expect(out?.get('zz.x')).toBeUndefined();
    // A lost post: not answered, so the script answers it.
    const lost = { resolvePolicyReferences: vi.fn(async (refs: Array<{ token: string }>) => ({ references: {}, unavailable: refs.map(r => r.token), problems: ['HTTP 500'] })) };
    expect((await lookupRefsByCommand(lost, [{ key: 't.known', ns: 't', id: 'known' }], async () => cat as never))?.get('t.known')).toBeUndefined();
    expect(await lookupRefsByCommand(lost, [{ key: 't.known', ns: 't', id: 'known' }], async () => { throw new Error('no catalogue'); })).toBeUndefined();
  });

  it('HOVER_RESOLVE: by ID, no script text for the reference; a missing object is said', async () => {
    vi.resetModules();
    mockChromeStorage();
    const { resetScriptKinds, classifyScript } = await import('../script-kinds');
    resetScriptKinds();
    const cat = { types: { ExtendedExpression: { parents: [], concrete: true, idSpace: 'TEMPLATE' } }, models: {} };
    const sent: string[] = [];
    const c = {
      serverUrl: 'https://bmp.hover.test/W/', sessionEpoch: 0,
      fetchTypeCatalogue: vi.fn(async () => cat),
      resolvePolicyReferences: vi.fn(async (refs: Array<{ token: string; id: string }>) => ({ references: Object.fromEntries(refs.map(r => [r.token, r.id === 'known' ? { rid: '9223372036854775805' } : null])), unavailable: [], problems: [] })),
      executeEc: vi.fn(async (code: string) => { sent.push(code); return { ok: true, log: '' }; }),
      executeEcOn: vi.fn(async (code: string, _rid: string) => { sent.push(code); return { ok: false, error: 'not in this test' }; }),
    };
    const { setSwContext } = await import('../sw-context');
    setSwContext({ client: c, settings: { activeProfileId: 'p' }, profileId: 'p', settingsReady: Promise.resolve() } as never);
    await import('../handlers/objects');
    const { getHandler } = await import('../handler-registry');
    const ask = async (ref: string) => { let reply: any; await getHandler('HOVER_RESOLVE')!({ type: 'HOVER_RESOLVE', ref } as never, (r: unknown) => { reply = r; }, { isOneShot: true } as never); return reply; };
    expect(await ask('t.zz_no_such_id_xq')).toEqual({ type: 'HOVER_RESOLVE_RESULT', ref: 't.zz_no_such_id_xq', missing: 'No object t.zz_no_such_id_xq on this server.' });
    await ask('t.known');
    // The found object is read by the constant hover script on its RID; no
    // text with the reference's ID was sent, and nothing varying.
    expect(c.executeEc).not.toHaveBeenCalled();
    expect(c.executeEcOn.mock.calls[0][1]).toBe('9223372036854775805');
    for (const code of sent) { expect(code).not.toContain('known'); expect(classifyScript(code).kind).toBe('constant'); }
  });

  it('BROWSE_RESOLVE finds an exact ID with no Extended Code', async () => {
    vi.resetModules();
    mockChromeStorage();
    const executeEc = vi.fn();
    const executeEcBatch = vi.fn(async () => [{ ok: true, log: '' }]);
    const c = {
      serverUrl: 'https://bmp.id.test/W/', sessionEpoch: 0,
      fetchTypeCatalogue: vi.fn(async () => catalogue),
      resolvePolicyReferences: vi.fn(async (refs: Array<{ token: string; space: string; id: string }>) => ({ references: Object.fromEntries(refs.map(r => [r.token, r.space === 'ORGANISATION' ? { rid: '42' } : null])), unavailable: [], problems: [] })),
      executeEc, executeEcBatch,
      // The summary of the found object: the constant script on its RID.
      executeEcEach: vi.fn(async () => new Map()),
      executeEcPairs: vi.fn(async () => []),
      executeEcScriptsOn: vi.fn(async () => []),
    };
    const { setSwContext } = await import('../sw-context');
    setSwContext({ client: c, settings: { activeProfileId: 'p' }, settingsReady: Promise.resolve() } as never);
    await import('../handlers/browse');
    const { getHandler } = await import('../handler-registry');
    const replies: unknown[] = [];
    await getHandler('BROWSE_RESOLVE')!({ type: 'BROWSE_RESOLVE', query: 'org_x', gen: 1 } as never, (r: unknown) => replies.push(r), { isOneShot: true } as never);
    expect(c.resolvePolicyReferences).toHaveBeenCalledTimes(1);
    expect(c.resolvePolicyReferences.mock.calls[0][0].map((r: { space: string; id: string }) => [r.space, r.id])).toEqual([['TEMPLATE', 'org_x'], ['ORGANISATION', 'org_x'], ['PROPERTY', 'org_x']]);
    // The varying script lookup is not used (readSummaries is a constant script).
    expect(executeEc).not.toHaveBeenCalled();
    // The same query again (the picker asks on every pause in typing): answered here.
    await getHandler('BROWSE_RESOLVE')!({ type: 'BROWSE_RESOLVE', query: 'org_x', gen: 2 } as never, (r: unknown) => replies.push(r), { isOneShot: true } as never);
    expect(c.resolvePolicyReferences).toHaveBeenCalledTimes(1);
    expect(replies[1]).toEqual({ ...(replies[0] as object), gen: 2 });
  });
});
