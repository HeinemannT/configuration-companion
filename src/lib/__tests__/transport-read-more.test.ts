/**
 * Transport (beta), the reads of round five: the search by ID or name, the
 * rows of objects by RID (a draft read again, the objects of a page), what
 * uses one object, and their handlers.
 */
import { describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { framedText } from '../ec-parser';
import { classifyScript } from '../script-kinds';
import { TRANSPORT_READ_BATCH } from '../transport-bundle';
import {
  buildTransportCountEc, buildTransportRootCountEc, parseTransportCountLog, readTransportCounts,
  buildTransportRowEc, buildTransportSearchEc, buildTransportUsedByEc, parseTransportUsedByLog,
  readTransportRows, readTransportSearch, readTransportUsedBy, searchText, TRANSPORT_SCAN_TIMEOUT_MS, TRANSPORT_SEARCH_CAP, TRANSPORT_SEARCH_MAX,
  TRANSPORT_USED_BY_CAP, buildTransportFactsEcs, parseTransportFactsLog, readTransportFacts, TRANSPORT_FACTS_BATCH,
} from '../transport-read';
import { SCRIPT_LIMITS } from '../script-kinds';
import type { EcResult } from '../bmp-client';

const RID_A = '9007199254740993', RID_B = '9223372036854775801', RID_C = '1234567890123456789';
const ENV = 'p1@https://bmp.example/demo/';
const FRAME = { senderKind: 'frame', senderTabId: 7, senderFrameId: 3, senderDocumentId: 'doc-a', senderUrl: 'chrome-extension://abcdef/transport/window.html' };
const PARENT_RID = '9007199254740000';

/** A scan row as the script prints it (see transport-read.test.ts). */
const scanRow = (rid: string, id: string) => [
  'O', `${rid} ${PARENT_RID} 3 TextElement`, id, `Name ${id}`, 'Nov 15, 2026 10:00:00|Nov 1, 2026 09:00:00|', 'admin|Admin', 'PORTAL', 'Portal',
];
/** A search row: no dates, no user. */
const slimRow = (rid: string, id: string) => ['O', `${rid} ${PARENT_RID} 1 TextElement`, id, `Name ${id}`, '||t_tpl', '', 'PORTAL', 'Portal'];

describe('the search', () => {
  it('the measured wildcard filter on one root, the text as a literal, capped one over the limit; slim rows', () => {
    const code = buildTransportSearchEc('portal', ' crev "qa" ');
    expect(code.startsWith('_q := "*crev \\"qa\\"*"\n')).toBe(true);
    expect(code).toContain('_g := root.portal');
    expect(code).toContain(`_g.descendants().filter(id = _q OR name = _q).first(${TRANSPORT_SEARCH_CAP + 1}).forEach(_i:`);
    expect(code).toContain('_e := "||" + str(_i.linkedTo.id.whenMissing(""))');
    expect(code).not.toContain('lastModifiedBy');
    expect(classifyScript(code).kind).toBe('varying');
    expect(() => buildTransportSearchEc('portal', 'a')).toThrow(/2 to 80/);
    expect(() => buildTransportSearchEc('portal', 'x'.repeat(TRANSPORT_SEARCH_MAX + 1))).toThrow(/2 to 80/);
    expect(() => buildTransportSearchEc('risk', 'abc')).toThrow(/Not a root/);
    expect(searchText('  ab ')).toBe('ab');
    expect(searchText(' a ')).toBeNull();
  });

  it('readTransportSearch: rows of the slim form, cut at the cap, a missing root', async () => {
    const many = Array.from({ length: TRANSPORT_SEARCH_CAP + 1 }, (_, i) => slimRow(String(7000000000000000000n + BigInt(i)), `o${i}`));
    const client = { executeEc: vi.fn(async () => ({ ok: true, log: framedText(many) }) as EcResult) };
    const r = await readTransportSearch(client, 'portal', 'crev');
    expect(r.rows).toHaveLength(TRANSPORT_SEARCH_CAP);
    expect(r.more).toBe(true);
    expect(r.rows[0]).toMatchObject({ id: 'o0', modified: '', created: '', modifiedBy: '', modifiedById: '', linkedTo: 't_tpl', parentId: 'PORTAL' });
    const none = { executeEc: vi.fn(async () => ({ ok: true, log: framedText([['M']]) }) as EcResult) };
    expect(await readTransportSearch(none, 'role', 'crev')).toMatchObject({ rows: [], missingRoot: true });
  });
});

describe('how many objects are under an object', () => {
  it('the measured descendants().size() of the context object or of one root; a root that is missing is an M row', () => {
    const one = buildTransportCountEc();
    expect(one).toContain('_o := this.object');
    expect(one).toContain('_o.descendants().size()');
    expect(classifyScript(one).kind).toBe('constant');
    const root = buildTransportRootCountEc('portal');
    expect(root).toContain('_g := root.portal');
    expect(root).toContain('_g.descendants().size()');
    // Under the visibility rules only the rules count, as in every scan.
    expect(buildTransportRootCountEc('classConfig')).toContain('_g.descendants().filter(className = "ConditionRule").size()');
    expect(classifyScript(root).kind).toBe('varying');
    expect(() => buildTransportRootCountEc('risk')).toThrow(/Not a root/);
    expect(parseTransportCountLog(framedText([['N', '48']]))).toBe(48);
    expect(parseTransportCountLog(framedText([['M']]))).toBeNull();
    expect(() => parseTransportCountLog(framedText([['N', 'many']]))).toThrow(/damaged/);
    expect(() => parseTransportCountLog(framedText([['N', '1'], ['N', '2']]))).toThrow(/damaged/);
  });

  it('readTransportCounts: roots one run each, objects in one post; what is missing or fails is left out; at most a batch', async () => {
    const client = {
      executeEc: vi.fn(async (code: string) => (code.includes('root.role') ? { ok: false, error: 'Script failed' } : { ok: true, log: framedText(code.includes('root.property') ? [['M']] : [['N', '21']]) }) as EcResult),
      executeEcPairs: vi.fn(async (pairs: ReadonlyArray<{ objectRid?: string }>) => pairs.map(p => (p.objectRid === RID_B ? { ok: false, error: 'x' } : { ok: true, log: framedText([['N', p.objectRid === RID_A ? '3' : '0']]) })) as EcResult[]),
    };
    expect(await readTransportCounts(client, { roots: ['portal', 'property', 'role'] })).toEqual({ portal: 21 });
    expect(client.executeEc).toHaveBeenCalledTimes(3);
    expect(await readTransportCounts(client, { rids: [RID_A, RID_B, RID_C] })).toEqual({ [RID_A]: 3, [RID_C]: 0 });
    expect(client.executeEcPairs).toHaveBeenCalledTimes(1);
    await expect(readTransportCounts(client, { rids: Array.from({ length: TRANSPORT_READ_BATCH + 1 }, (_, i) => String(1000 + i)) })).rejects.toThrow(/At most/);
    await expect(readTransportCounts(client, { rids: ['x'] })).rejects.toThrow();
  });
});

describe('rows by RID', () => {
  it('one post, the row script with each object as the context; missing and failed objects on their own', async () => {
    const client = {
      executeEcPairs: vi.fn(async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => pairs.map(p => (p.objectRid === RID_B
        ? { ok: true, log: framedText([['M']]) }
        : p.objectRid === RID_C ? { ok: false, error: 'boom' } : { ok: true, log: framedText([scanRow(p.objectRid!, 'a')]) }))),
    };
    const out = await readTransportRows(client, [RID_A, RID_B, RID_C, RID_A]);
    expect(client.executeEcPairs.mock.calls[0][0]).toEqual([RID_A, RID_B, RID_C].map(objectRid => ({ code: buildTransportRowEc(), objectRid })));
    expect(out).toEqual([{ rid: RID_A, row: expect.objectContaining({ rid: RID_A, id: 'a' }) }, { rid: RID_B, missing: true }, { rid: RID_C, error: 'boom' }]);
    await expect(readTransportRows(client, Array.from({ length: TRANSPORT_READ_BATCH + 1 }, (_, i) => String(i + 1)))).rejects.toThrow(/At most/);
  });
});

describe('what uses an object', () => {
  it('"Used by": rref() of the context object, first n + 1, the measured row fields; cut says more', async () => {
    const code = buildTransportUsedByEc();
    expect(code).toContain(`_o.rref().first(${TRANSPORT_USED_BY_CAP + 1}).forEach(_i:`);
    expect(code).toContain('_i.id.whenMissing("")');
    expect(code).toContain('_i.name.whenMissing("")');
    expect(classifyScript(code).kind).toBe('constant');
    const rows = Array.from({ length: TRANSPORT_USED_BY_CAP + 1 }, (_, i) => ['U', String(8000000000000000000n + BigInt(i)), `u${i}`, 'TextElement', `User ${i}`]);
    const parsed = parseTransportUsedByLog(framedText(rows));
    expect(parsed.users).toHaveLength(TRANSPORT_USED_BY_CAP);
    expect(parsed.more).toBe(true);
    expect(parsed.users[0]).toEqual({ rid: '8000000000000000000', id: 'u0', className: 'TextElement', name: 'User 0' });
    expect(() => parseTransportUsedByLog(framedText([['U', 'x', 'a', 'b', 'c']]))).toThrow(/damaged/);
    const client = { executeEcOn: vi.fn(async () => ({ ok: true, log: framedText([['U', RID_B, 'b', 'Category', 'B']]) }) as EcResult) };
    expect(await readTransportUsedBy(client, RID_A)).toEqual({ users: [{ rid: RID_B, id: 'b', className: 'Category', name: 'B' }], more: false });
    expect(client.executeEcOn.mock.calls[0]).toEqual([code, RID_A, undefined, TRANSPORT_SCAN_TIMEOUT_MS]);
  });
});


describe('the facts of used objects', () => {
  it('per address: assigned, tested for MISSING, then read; several per script, each within the varying limit', () => {
    const [code, ...rest] = buildTransportFactsEcs(['t.a', 'k.b', 't.a']);
    expect(rest).toEqual([]);
    expect(code).toContain([
      '_o := t.a',
      'IF _o != MISSING THEN',
      '_a := str(_o.rid) + " " + str(_o.className)',
      '_b := str(_o.parent.id)',
      '_c := str(_o.name.whenMissing(""))',
    ].join('\n'));
    expect(code).toContain('_o := k.b\nIF _o != MISSING THEN');
    expect(code.match(/_o := t\.a\n/g)).toHaveLength(1);
    expect(code).toContain('ELSE ""\nENDIF');
    expect(classifyScript(code).kind).toBe('varying');
    const long = buildTransportFactsEcs(Array.from({ length: TRANSPORT_FACTS_BATCH }, (_, i) => `t.${'x'.repeat(120)}${i}`));
    expect(long.length).toBeGreaterThan(1);
    for (const s of long) expect(s.length).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
    for (const bad of ['root.portal', 't.a")', 'r.file', 'x']) expect(() => buildTransportFactsEcs([bad]), bad).toThrow(/Not an address/);
  });

  it('parses one row per object found; an address without a row is missing; a damaged row throws', () => {
    const log = framedText([['F', 't.a', `${RID_A} ListPropertySet`, 'LISTS', 'My list']]);
    expect(parseTransportFactsLog(log, ['t.a', 'k.b'])).toEqual([
      { address: 't.a', rid: RID_A, className: 'ListPropertySet', parentId: 'LISTS', name: 'My list' }, { address: 'k.b', missing: true },
    ]);
    expect(() => parseTransportFactsLog(framedText([['F', 't.other', `${RID_A} X`, '', '']]), ['t.a'])).toThrow(/damaged/);
  });

  it('readTransportFacts: one preview run per script, at most a batch', async () => {
    const client = { executeEc: vi.fn(async (code: string, ..._rest: unknown[]) => ({ ok: true, log: framedText(code.includes('_o := t.a\n') ? [['F', 't.a', `${RID_A} Kpi`, 'P', 'A']] : []) }) as EcResult) };
    expect(await readTransportFacts(client, ['t.a', 'k.b'])).toEqual([{ address: 't.a', rid: RID_A, className: 'Kpi', parentId: 'P', name: 'A' }, { address: 'k.b', missing: true }]);
    expect(client.executeEc).toHaveBeenCalledTimes(1);
    expect(client.executeEc.mock.calls[0][2]).toBe(false);
    await expect(readTransportFacts(client, Array.from({ length: TRANSPORT_FACTS_BATCH + 1 }, (_, i) => `t.a${i}`))).rejects.toThrow(/At most/);
  });
});

describe('the handlers', () => {
  it('TRANSPORT_SEARCH, TRANSPORT_ROWS, TRANSPORT_USED_BY, TRANSPORT_PAGE_OBJECTS answer; refusals read nothing', async () => {
    vi.resetModules();
    mockChromeStorage();
    const sendMessage = vi.fn(async () => ({ type: 'PAGE_INFO', url: '', widgets: [{ rid: RID_A }, { rid: RID_A }, { rid: 'x' }, { rid: RID_B }] }));
    (globalThis as any).chrome.tabs = { sendMessage };
    const client = {
      serverUrl: 'https://bmp.example/demo/', sessionEpoch: 1,
      executeEc: vi.fn(async (code: string) => ({ ok: true, log: framedText(code.includes('_o := ') ? [] : [slimRow(RID_A, 'found')]) }) as EcResult),
      executeEcOn: vi.fn(async () => ({ ok: true, log: framedText([['U', RID_B, 'b', 'Category', 'B']]) }) as EcResult),
      executeEcPairs: vi.fn(async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => pairs.map(p => ({ ok: true, log: framedText([scanRow(p.objectRid!, 'r')]) }))),
    };
    const ctx: any = { client, settings: { activeProfileId: 'p1' }, cache: { get: vi.fn(() => null) }, logActivity: vi.fn(), toast: vi.fn() };
    const { setSwContext } = await import('../sw-context');
    const { getHandler } = await import('../handler-registry');
    setSwContext(ctx);
    await import('../handlers/transport');
    const send = (type: string, msg: Record<string, unknown>, meta: Record<string, unknown> = FRAME) => new Promise<any>(resolve => {
      void getHandler(type)!({ type, environment: ENV, ...msg } as any, resolve, { isOneShot: true, ...meta } as any);
    });
    expect(await send('TRANSPORT_SEARCH', { requestId: 's', root: 'portal', text: 'fou' })).toMatchObject({ type: 'TRANSPORT_SEARCH_RESULT', ok: true, root: 'portal', rows: [{ rid: RID_A, id: 'found' }] });
    expect(await send('TRANSPORT_ROWS', { requestId: 'r', rids: [RID_A] })).toMatchObject({ type: 'TRANSPORT_ROWS_RESULT', ok: true, rows: [{ rid: RID_A, row: { id: 'r' } }] });
    expect(await send('TRANSPORT_USED_BY', { requestId: 'u', rid: RID_A })).toMatchObject({ type: 'TRANSPORT_USED_BY_RESULT', ok: true, rid: RID_A, users: [{ rid: RID_B }] });
    expect(await send('TRANSPORT_PAGE_OBJECTS', { requestId: 'p' })).toMatchObject({ type: 'TRANSPORT_PAGE_OBJECTS_RESULT', ok: true, rids: [RID_A, RID_B] });
    expect(await send('TRANSPORT_FACTS', { requestId: 'x', addresses: ['t.a'] })).toMatchObject({ type: 'TRANSPORT_FACTS_RESULT', ok: true, facts: [{ address: 't.a', missing: true }] });
    expect(await send('TRANSPORT_COUNTS', { requestId: 'c', roots: ['portal'] })).toMatchObject({ type: 'TRANSPORT_COUNTS_RESULT', ok: true, counts: {} });
    expect(await send('TRANSPORT_COUNTS', { requestId: 'c', rids: [RID_A] })).toMatchObject({ type: 'TRANSPORT_COUNTS_RESULT', ok: true });
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'GET_PAGE_INFO' });
    const calls = client.executeEc.mock.calls.length + client.executeEcOn.mock.calls.length + client.executeEcPairs.mock.calls.length;
    const refused = { ok: false, refused: true };
    expect(await send('TRANSPORT_SEARCH', { requestId: 's', root: 'portal', text: 'a' })).toMatchObject(refused);
    expect(await send('TRANSPORT_SEARCH', { requestId: 's', root: 'risk', text: 'abc' })).toMatchObject(refused);
    expect(await send('TRANSPORT_USED_BY', { requestId: 'u', rid: 'x' })).toMatchObject(refused);
    expect(await send('TRANSPORT_FACTS', { requestId: 'x', addresses: ['root.portal'] })).toMatchObject(refused);
    expect(await send('TRANSPORT_FACTS', { requestId: 'x', addresses: [] })).toMatchObject(refused);
    expect(await send('TRANSPORT_COUNTS', { requestId: 'c', roots: ['risk'] })).toMatchObject(refused);
    expect(await send('TRANSPORT_COUNTS', { requestId: 'c', rids: ['x'] })).toMatchObject(refused);
    expect(await send('TRANSPORT_COUNTS', { requestId: 'c' })).toMatchObject(refused);
    expect(await send('TRANSPORT_COUNTS', { requestId: 'c', roots: ['portal'], rids: [RID_A] })).toMatchObject(refused);
    expect(await send('TRANSPORT_ROWS', { requestId: 'r', rids: [RID_A] }, { ...FRAME, senderKind: 'content' })).toMatchObject(refused);
    expect(await send('TRANSPORT_PAGE_OBJECTS', { requestId: 'p' }, { ...FRAME, senderTabId: undefined })).toMatchObject(refused);
    expect(client.executeEc.mock.calls.length + client.executeEcOn.mock.calls.length + client.executeEcPairs.mock.calls.length).toBe(calls);
  });
});
