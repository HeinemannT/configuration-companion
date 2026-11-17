/**
 * Transport (beta), the reads and their handlers: the scan script and its
 * parse, the per-object scripts, the batched client read with a fake
 * client, the transport log read, and TRANSPORT_SCAN /
 * TRANSPORT_READ_OBJECTS / TRANSPORT_LOG / TRANSPORT_CANCEL in the service
 * worker.
 */
import { describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { EC_FRAME, framedText } from '../ec-parser';
import { classifyScript, SCRIPT_LIMITS } from '../script-kinds';
import { START_SPACE, TRANSPORT_READ_BATCH, TRANSPORT_ROOTS, TRANSPORT_SCAN_CAP } from '../transport-bundle';
import {
  addressOfText, buildTransportCreationEc, buildTransportLogEc, buildTransportNeighboursEc, buildTransportObjectEc, buildTransportScanEc,
  parseTransportCreationLog, parseTransportLogLog, parseTransportNeighboursLog, parseTransportObjectLog, parseTransportScanLog, readTransportCreation, readTransportLog,
  readTransportObjects, readTransportScan, TRANSPORT_LOG_CAP,
  TRANSPORT_READ_TIMEOUT_MS, TRANSPORT_SCAN_TIMEOUT_MS, buildTransportStartEc, buildTransportUnderEc, buildTransportUnderSinceEc, parseTransportStartLog, readTransportUnder,
  buildTransportChildrenEc, buildTransportRootChildrenEc, buildTransportRowEc, parseTransportChildrenLog, readTransportBelow, readTransportChildren, readTransportFind,
} from '../transport-read';
import type { EcResult } from '../bmp-client';
import { BmpRequestError, errorKindOf } from '../error-kind';

const RID_A = '9007199254740993', RID_B = '9223372036854775801', RID_C = '1234567890123456789';
const ENV = 'p1@https://bmp.example/demo/';
const FRAME = { senderKind: 'frame', senderTabId: 7, senderFrameId: 3, senderDocumentId: 'doc-a', senderUrl: 'chrome-extension://abcdef/transport/window.html' };

const PARENT_RID = '9007199254740000';
/** A scan row as the script prints it: RID, parent RID, sort index and
 *  class in one field; ID; name; both dates and the linked template in one
 *  field; the user's ID and name in one; parent. */
const scanRow = (rid: string, id: string, extra: Partial<Record<'name' | 'cls' | 'mod' | 'by' | 'byId' | 'created' | 'parentRid' | 'sort' | 'parentId' | 'parentName' | 'linked', string>> = {}) => [
  'O', `${rid} ${extra.parentRid ?? PARENT_RID} ${extra.sort ?? '3'} ${extra.cls ?? 'TextElement'}`, id, extra.name ?? `Name ${id}`,
  `${extra.mod ?? 'Nov 15, 2026 10:00:00'}|${extra.created ?? 'Nov 1, 2026 09:00:00'}|${extra.linked ?? ''}`, `${extra.byId ?? 'admin'}|${extra.by ?? 'Admin'}`, extra.parentId ?? 'PORTAL', extra.parentName ?? 'Portal',
];
const PLACE = { parentRid: PARENT_RID, parentId: 'PORTAL', parentName: 'Portal', sortIndex: 3 };

describe('the scan script', () => {
  it('walks one root with the measured date filter, capped one over the limit', () => {
    const code = buildTransportScanEc('portal', '2026-11-15');
    expect(code).toContain('_g := root.portal');
    expect(code).toContain('IF _g = MISSING THEN');
    expect(code).toContain(`_g.descendants().filter(lastModifiedDate > date("2026-11-15")).first(${TRANSPORT_SCAN_CAP + 1}).forEach(_i:`);
    expect(code).toContain('_h := str(_i.lastModifiedBy.id.whenMissing("")) + "|" + str(_i.lastModifiedBy.name.whenMissing(""))');
    // No description is read: the first field is the RID, parent RID, sort index and class.
    expect(code).toContain('_a := str(_i.rid) + " " + str(_i.parent.rid) + " " + str(_i.sortIndex) + " " + str(_i.className)\n');
    expect(code).not.toContain('description');
    // The ID of the template a linked copy is linked to, last of the dates (the measured form).
    expect(code).toContain('_e := str(_i.lastModifiedDate.whenMissing("")) + "|" + str(_i.createdTime.whenMissing("")) + "|" + str(_i.linkedTo.id.whenMissing(""))');
    expect(code).toContain('str(_i.parent.id)');
    expect(code).toContain('str(_i.parent.name.whenMissing(""))');
    expect(code.endsWith('_r + "~CREV_D~"')).toBe(true);
  });

  it('is varying and within 1,200 characters for every root', () => {
    for (const root of TRANSPORT_ROOTS) {
      const code = buildTransportScanEc(root, '2026-11-15');
      expect(code.length, root).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
      expect(classifyScript(code).kind).toBe('varying');
    }
  });

  it('refuses a root off the list and a day that is not a day', () => {
    for (const bad of ['risk', 'portal.x', 'portal\n_x := 1', 'Portal']) expect(() => buildTransportScanEc(bad, '2026-11-15'), bad).toThrow(/Not a root/);
    for (const bad of ['2026-11-31', '2026-11-15") OR (1', '']) expect(() => buildTransportScanEc('portal', bad), bad).toThrow(/Not a day/);
  });

  it('parses rows with any text; the server\'s dates plus their ISO form', () => {
    const hostile = `a ~CREV_R~1:x ~CREV_D~ 3:abc "quote" \\ \n line`;
    const log = 'Missing value for IF\n' + framedText([
      scanRow(RID_A, 'crev_qa_text', { name: hostile }),
      scanRow(RID_B, 'crev_qa_btn', { by: '', byId: '', mod: 'odd date', created: '', parentRid: '', sort: '', parentId: 'x', parentName: 'y \n z', linked: 't_tpl | odd' }),
    ]);
    expect(parseTransportScanLog(log, 'portal', '2026-11-15')).toEqual({
      root: 'portal', since: '2026-11-15', more: false, missingRoot: false,
      rows: [
        {
          rid: RID_A, id: 'crev_qa_text', name: hostile, className: 'TextElement', modified: 'Nov 15, 2026 10:00:00', modifiedIso: '2026-11-15T10:00:00',
          modifiedBy: 'Admin', modifiedById: 'admin', created: 'Nov 1, 2026 09:00:00', createdIso: '2026-11-01T09:00:00', ...PLACE,
        },
        {
          rid: RID_B, id: 'crev_qa_btn', name: 'Name crev_qa_btn', className: 'TextElement', modified: 'odd date', modifiedBy: '', modifiedById: '', created: '',
          parentRid: '', parentId: 'x', parentName: 'y \n z', sortIndex: 0, linkedTo: 't_tpl | odd',
        },
      ],
    });
  });

  it('cuts at the cap and says so; a missing root; a damaged or cut-off answer throws', () => {
    const many = Array.from({ length: TRANSPORT_SCAN_CAP + 1 }, (_, i) => scanRow(String(7000000000000000000n + BigInt(i)), `o${i}`));
    const cut = parseTransportScanLog(framedText(many), 'accessPolicy', '2026-11-15');
    expect(cut.rows).toHaveLength(TRANSPORT_SCAN_CAP);
    expect(cut.more).toBe(true);
    expect(parseTransportScanLog(framedText([['M']]), 'role', '2026-11-15')).toMatchObject({ rows: [], missingRoot: true });
    expect(() => parseTransportScanLog(framedText([scanRow(RID_A, 'x')], false), 'portal', '2026-11-15')).toThrow(/incomplete/);
    expect(() => parseTransportScanLog(framedText([scanRow('not-a-rid', 'x')]), 'portal', '2026-11-15')).toThrow(/damaged/);
    expect(() => parseTransportScanLog(framedText([['O', RID_A]]), 'portal', '2026-11-15')).toThrow(/damaged/);
    // The first field: RID, parent RID, sort index and class, one space each.
    for (const head of [`${RID_A} 1 2`, `${RID_A} 1 2 C #no`, `${RID_A} 1 2  C`, `x 1 2 C`, '']) {
      const bad = scanRow(RID_A, 'x');
      bad[1] = head;
      expect(() => parseTransportScanLog(framedText([bad]), 'portal', '2026-11-15'), head).toThrow(/damaged/);
    }
    // The dates: two, with a bar between them.
    const bad = scanRow(RID_A, 'x');
    bad[4] = 'Nov 1, 2026 09:00:00';
    expect(() => parseTransportScanLog(framedText([bad]), 'portal', '2026-11-15')).toThrow(/damaged/);
    // Both with the protocol kind, as the other readers' errors.
    for (const log of [framedText([['O', RID_A]]), framedText([scanRow(RID_A, 'x')], false)]) {
      let caught: unknown;
      try { parseTransportScanLog(log, 'portal', '2026-11-15'); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(BmpRequestError);
      expect(errorKindOf(caught)).toBe('protocol');
    }
  });
});

describe('readTransportScan', () => {
  const client = (result: EcResult) => ({ executeEc: vi.fn(async (..._args: unknown[]) => result) });

  it('one preview run without a context object', async () => {
    const c = client({ ok: true, log: framedText([scanRow(RID_A, 'crev_qa_text')]) });
    const scan = await readTransportScan(c, 'portal', '2026-11-15');
    expect(scan.rows.map(r => r.rid)).toEqual([RID_A]);
    expect(c.executeEc).toHaveBeenCalledTimes(1);
    const [code, objectRid, transactional, , timeout] = c.executeEc.mock.calls[0];
    expect(code).toBe(buildTransportScanEc('portal', '2026-11-15'));
    expect(objectRid).toBeUndefined();
    expect(transactional).toBe(false);
    expect(timeout).toBe(TRANSPORT_SCAN_TIMEOUT_MS);
  });

  it('a missing root, by its row or by the server\'s words, is not an error', async () => {
    expect(await readTransportScan(client({ ok: true, log: 'Missing value for .accessPolicy\n' + framedText([['M']]) }), 'accessPolicy', '2026-11-15')).toMatchObject({ missingRoot: true, rows: [] });
    expect(await readTransportScan(client({ ok: true, log: 'Missing value for .accessPolicy\n' + framedText([]) }), 'accessPolicy', '2026-11-15')).toMatchObject({ missingRoot: true, rows: [] });
    expect(await readTransportScan(client({ ok: false, error: 'Missing value for .accessPolicy' }), 'accessPolicy', '2026-11-15')).toMatchObject({ missingRoot: true, rows: [] });
    expect(await readTransportScan(client({ ok: true, log: framedText([]) }), 'portal', '2026-11-15')).toMatchObject({ missingRoot: false, rows: [] });
  });

  it('a failed run throws with its kind; nothing is sent for a bad root', async () => {
    await expect(readTransportScan(client({ ok: false, error: 'EC execution timed out (60s)', errorKind: 'timeout' }), 'portal', '2026-11-15')).rejects.toMatchObject({ message: 'EC execution timed out (60s)', kind: 'timeout' });
    const c = client({ ok: true, log: framedText([]) });
    await expect(readTransportScan(c, 'risk', '2026-11-15')).rejects.toThrow(/Not a root/);
    expect(c.executeEc).not.toHaveBeenCalled();
  });
});

describe('the scan under one object', () => {
  it('finds the object by its ID in a small varying script, with the scan\'s row', () => {
    const code = buildTransportStartEc('my_module');
    expect(code).toContain('_g := t.get("my_module")');
    expect(code).toContain('IF _g = MISSING THEN');
    expect(code).toContain('_g.lastModifiedBy.name.whenMissing("")');
    expect(code).not.toContain('description');
    expect(code).toContain('str(_g.parent.rid)');
    for (const space of ['k', 'r', 'd']) expect(buildTransportStartEc('my_x', space)).toContain(`_g := ${space}.get("my_x")`);
    for (const space of ['o', 'root', 'K', 't.x']) expect(() => buildTransportStartEc('my_x', space), space).toThrow(/Not an ID space/);
    expect(buildTransportStartEc(`_${'x'.repeat(127)}`, 'k').length).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
    expect(code).not.toContain('descendants');
    expect(code.endsWith('_r + "~CREV_D~"')).toBe(true);
    expect(classifyScript(code).kind).toBe('varying');
    expect(buildTransportStartEc(`_${'x'.repeat(127)}`).length).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
    for (const bad of ['', 'a")\n_x := 1', `a${'b'.repeat(128)}`]) expect(() => buildTransportStartEc(bad), bad).toThrow(/Not an ID/);
    // Any other ID is written as a quoted text.
    expect(buildTransportStartEc('x")')).toContain('_g := t.get("x\\")")');
  });

  it('lists what is under the context object: constant without a day, varying with one', () => {
    const all = buildTransportUnderEc();
    expect(all).toBe(buildTransportUnderEc());
    expect(classifyScript(all).kind).toBe('constant');
    expect(all).toContain('_g := this.object');
    expect(all).toContain(`_g.descendants().first(${TRANSPORT_SCAN_CAP}).forEach(_i:`);
    expect(all).not.toMatch(/\d{6,}|lastModifiedDate > /);
    const since = buildTransportUnderSinceEc('2026-11-15');
    expect(since).toContain(`_g.descendants().filter(lastModifiedDate > date("2026-11-15")).first(${TRANSPORT_SCAN_CAP}).forEach(_i:`);
    expect(classifyScript(since).kind).toBe('varying');
    expect(since.length).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
    expect(() => buildTransportUnderSinceEc('2026-02-30')).toThrow(/Not a day/);
    // The same row as the changes scan.
    const row = (code: string) => code.split('\n').filter(l => l.includes('_i.') && !l.includes('forEach')).map(l => l.trim());
    expect(row(all)).toEqual(row(buildTransportScanEc('portal', '2026-11-15')));
  });

  it('parses the object\'s row; none for an M row; a damaged answer throws', () => {
    expect(parseTransportStartLog(framedText([scanRow(RID_A, 'my_module')]))).toMatchObject({ rid: RID_A, id: 'my_module', name: 'Name my_module' });
    expect(parseTransportStartLog(framedText([['M']]))).toBeNull();
    expect(() => parseTransportStartLog(framedText([scanRow(RID_A, 'a'), scanRow(RID_B, 'b')]))).toThrow(/damaged/);
    expect(() => parseTransportStartLog(framedText([]))).toThrow(/damaged/);
    expect(() => parseTransportStartLog(framedText([scanRow(RID_A, 'a')], false))).toThrow(/incomplete/);
  });
});

describe('readTransportUnder', () => {
  const START = scanRow(RID_A, 'my_module', { mod: 'Nov 10, 2026 10:00:00' });
  const client = (found: EcResult, under: EcResult) => ({
    executeEc: vi.fn(async (..._args: unknown[]) => found),
    executeEcOn: vi.fn(async (..._args: unknown[]) => under),
  });

  it('two preview runs: the ID, then the object as the context; the object first', async () => {
    const c = client({ ok: true, log: framedText([START]) }, { ok: true, log: framedText([scanRow(RID_B, 'my_tab'), scanRow(RID_C, 'my_list')]) });
    const scan = await readTransportUnder(c, 't.my_module', '');
    expect(scan).toMatchObject({ start: 'my_module', since: '', more: false, missingStart: false, origin: { rid: RID_A } });
    expect(scan.rows.map(r => r.id)).toEqual(['my_module', 'my_tab', 'my_list']);
    const [code, objectRid, transactional, , timeout] = c.executeEc.mock.calls[0];
    expect([code, objectRid, transactional, timeout]).toEqual([buildTransportStartEc('my_module'), undefined, false, TRANSPORT_SCAN_TIMEOUT_MS]);
    const [under, rid, , timeoutOn] = c.executeEcOn.mock.calls[0];
    expect([under, rid, timeoutOn]).toEqual([buildTransportUnderEc(), RID_A, TRANSPORT_SCAN_TIMEOUT_MS]);
  });

  it('with a day: the dated script; the object itself only when it changed after the day', async () => {
    const c = client({ ok: true, log: framedText([START]) }, { ok: true, log: framedText([scanRow(RID_B, 'my_tab')]) });
    const later = await readTransportUnder(c, 'my_module', '2026-11-12');
    expect(c.executeEcOn.mock.calls[0][0]).toBe(buildTransportUnderSinceEc('2026-11-12'));
    expect(later.rows.map(r => r.id)).toEqual(['my_tab']);
    expect(later.origin?.id).toBe('my_module');
    expect((await readTransportUnder(c, 'my_module', '2026-11-10')).rows.map(r => r.id)).toEqual(['my_module', 'my_tab']);
  });

  it('caps at the scan cap with the object itself and says more', async () => {
    const many = Array.from({ length: TRANSPORT_SCAN_CAP }, (_, i) => scanRow(String(7000000000000000000n + BigInt(i)), `o${i}`));
    const scan = await readTransportUnder(client({ ok: true, log: framedText([START]) }, { ok: true, log: framedText(many) }), 'my_module', '');
    expect(scan.rows).toHaveLength(TRANSPORT_SCAN_CAP);
    expect(scan.rows[0].rid).toBe(RID_A);
    expect(scan.more).toBe(true);
    const fits = await readTransportUnder(client({ ok: true, log: framedText([START]) }, { ok: true, log: framedText(many.slice(1)) }), 'my_module', '');
    expect([fits.rows.length, fits.more]).toEqual([TRANSPORT_SCAN_CAP, false]);
  });

  it('no object with that ID is a result, not an error; nothing is read under it', async () => {
    const c = client({ ok: true, log: framedText([['M']]) }, { ok: true, log: framedText([]) });
    expect(await readTransportUnder(c, 'gone', '')).toEqual({ start: 'gone', since: '', rows: [], more: false, missingStart: true });
    expect(c.executeEcOn).not.toHaveBeenCalled();
    // Deleted between the two runs.
    expect(await readTransportUnder(client({ ok: true, log: framedText([START]) }, { ok: true, log: framedText([['M']]) }), 'my_module', '')).toMatchObject({ missingStart: true, rows: [] });
  });

  it('refuses a start or day before any run; a failed run throws with its kind', async () => {
    const c = client({ ok: true, log: framedText([START]) }, { ok: true, log: framedText([]) });
    await expect(readTransportUnder(c, 'o.my_org', '')).rejects.toThrow(START_SPACE);
    await expect(readTransportUnder(c, 'my_module', '15.11.2026')).rejects.toThrow(/Not a day/);
    expect(c.executeEc).not.toHaveBeenCalled();
    await expect(readTransportUnder(client({ ok: false, error: 'EC execution timed out (60s)', errorKind: 'timeout' }, { ok: true }), 'my_module', '')).rejects.toMatchObject({ kind: 'timeout' });
    await expect(readTransportUnder(client({ ok: true, log: framedText([START]) }, { ok: false, error: 'Script failed', errorKind: 'server' }), 'my_module', '')).rejects.toMatchObject({ message: 'Script failed', kind: 'server' });
  });
});

describe('reading a cut scan on, and finding one object', () => {
  it('the children of a root (varying, one per root) or of the context object (constant); the own row is constant', () => {
    const root = buildTransportRootChildrenEc('page');
    expect(root).toContain('_g := root.page');
    expect(root).toContain('_g.children.forEach(_i:');
    expect(root).not.toContain('descendants');
    expect(classifyScript(root).kind).toBe('varying');
    for (const r of TRANSPORT_ROOTS) expect(buildTransportRootChildrenEc(r).length).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
    expect(() => buildTransportRootChildrenEc('risk')).toThrow(/Not a root/);
    const ctx = buildTransportChildrenEc();
    expect(ctx).toContain('_g := this.object');
    expect(classifyScript(ctx).kind).toBe('constant');
    const own = buildTransportRowEc();
    expect(own).toContain('_g := this.object');
    expect(own).not.toContain('descendants');
    expect(classifyScript(own).kind).toBe('constant');
    expect(parseTransportChildrenLog(framedText([['C', RID_A], ['C', RID_B]]))).toEqual({ rids: [RID_A, RID_B], missing: false });
    expect(parseTransportChildrenLog(framedText([['M']]))).toEqual({ rids: [], missing: true });
    expect(() => parseTransportChildrenLog(framedText([['C', 'x']]))).toThrow(/damaged/);
    expect(() => parseTransportChildrenLog(framedText([['C', RID_A]], false))).toThrow(/incomplete/);
  });

  it('readTransportChildren: a root without a context object, an object as the context', async () => {
    const c = {
      executeEc: vi.fn(async (..._a: unknown[]) => ({ ok: true, log: framedText([['C', RID_A]]) }) as EcResult),
      executeEcOn: vi.fn(async (..._a: unknown[]) => ({ ok: true, log: framedText([['C', RID_B]]) }) as EcResult),
    };
    expect(await readTransportChildren(c, { root: 'portal' })).toEqual({ rids: [RID_A], missing: false });
    expect(c.executeEc.mock.calls[0].slice(0, 2)).toEqual([buildTransportRootChildrenEc('portal'), undefined]);
    expect(await readTransportChildren(c, { rid: RID_C })).toEqual({ rids: [RID_B], missing: false });
    expect(c.executeEcOn.mock.calls[0].slice(0, 2)).toEqual([buildTransportChildrenEc(), RID_C]);
    await expect(readTransportChildren(c, { rid: '1 OR 1' })).rejects.toThrow();
    await expect(readTransportChildren(c, { root: 'risk' })).rejects.toThrow(/Not a root/);
    expect(c.executeEc).toHaveBeenCalledTimes(1);
  });

  it('readTransportBelow: one post of the own row and what is under it; the day rule of the starting object; cut at the cap', async () => {
    const own = scanRow(RID_A, 'my_folder', { mod: 'Nov 10, 2026 10:00:00' });
    const pairs = (under: string[][]) => ({ executeEcPairs: vi.fn(async (p: ReadonlyArray<{ code: string; objectRid?: string }>) => p.map(x => ({ ok: true, log: framedText(x.code === buildTransportRowEc() ? [own] : under) }) as EcResult)) });
    const c = pairs([scanRow(RID_B, 'my_tab')]);
    const all = await readTransportBelow(c, RID_A, '');
    expect(all).toMatchObject({ origin: { rid: RID_A }, more: false, missing: false });
    expect(all.rows.map(r => r.id)).toEqual(['my_folder', 'my_tab']);
    expect(c.executeEcPairs.mock.calls[0][0]).toEqual([{ code: buildTransportRowEc(), objectRid: RID_A }, { code: buildTransportUnderEc(), objectRid: RID_A }]);
    const later = await readTransportBelow(c, RID_A, '2026-11-12');
    expect(later.rows.map(r => r.id)).toEqual(['my_tab']);
    expect(c.executeEcPairs.mock.calls[1][0][1].code).toBe(buildTransportUnderSinceEc('2026-11-12'));
    const many = Array.from({ length: TRANSPORT_SCAN_CAP }, (_, i) => scanRow(String(7000000000000000000n + BigInt(i)), `o${i}`));
    expect(await readTransportBelow(pairs(many), RID_A, '')).toMatchObject({ more: true, rows: { length: TRANSPORT_SCAN_CAP } });
    const gone = { executeEcPairs: vi.fn(async () => [{ ok: true, log: framedText([['M']]) }, { ok: true, log: framedText([['M']]) }] as EcResult[]) };
    expect(await readTransportBelow(gone, RID_A, '')).toEqual({ rows: [], more: false, missing: true });
    await expect(readTransportBelow(c, 'x', '')).rejects.toThrow();
    await expect(readTransportBelow(c, RID_A, '2026-02-30')).rejects.toThrow(/Not a day/);
  });

  it('readTransportFind: the space\'s get; none is not an error; another space is refused before any run', async () => {
    const c = { executeEc: vi.fn(async (code: string) => ({ ok: true, log: framedText(code.includes('"gone"') ? [['M']] : [scanRow(RID_A, 'my_kpi')]) }) as EcResult) };
    expect(await readTransportFind(c, 'k.my_kpi')).toMatchObject({ row: { rid: RID_A, id: 'my_kpi', ...PLACE } });
    expect(c.executeEc.mock.calls[0][0]).toBe(buildTransportStartEc('my_kpi', 'k'));
    expect(await readTransportFind(c, 't.gone')).toEqual({});
    await expect(readTransportFind(c, 'o.my_org')).rejects.toThrow(START_SPACE);
    await expect(readTransportFind(c, 'my_kpi')).rejects.toThrow(/Not an address/);
    expect(c.executeEc).toHaveBeenCalledTimes(2);
  });
});

describe('the per-object scripts', () => {
  it('constant: the object is the command\'s context', () => {
    for (const code of [buildTransportObjectEc(), buildTransportCreationEc(), buildTransportNeighboursEc()]) {
      expect(code.startsWith('_o := this.object\n')).toBe(true);
      expect(code).not.toMatch(/\d{6,}/);
      expect(classifyScript(code).kind).toBe('constant');
      expect(code.length).toBeLessThanOrEqual(SCRIPT_LIMITS.constant);
    }
    // The object's text without its creation text, which is read on its own.
    // A file is measured on the server and read without its content; any other object, genedit().
    expect(buildTransportObjectEc()).toContain(["IF _o.className = 'FileResource' THEN", '     _t := str(_o.genedit())', '     _s := str(_t.size())', '     _t := str(_o.genedit(id, name))', 'ELSE'].map(l => `     ${l}`).join('\n'));
    expect(buildTransportObjectEc()).toContain('_f2 := str(_t)');
    expect(buildTransportObjectEc()).toContain('_f3 := str(_s)');
    expect(buildTransportObjectEc()).not.toContain('generate');
    expect(buildTransportCreationEc()).toContain('_t := str(_o.generate(true))');
    expect(buildTransportCreationEc()).toContain('_f := "N"');
    // genedit() only of its instances (its own values per class).
    expect(buildTransportCreationEc().match(/genedit()/g)).toHaveLength(1);
    expect(buildTransportCreationEc()).toContain('_o.rref(linkedTo).forEach(_i:');
    // The neighbours are looked up by RID and without any generated text
    // (genedit() adds a temporary sibling for the rest of the run), robust
    // to gaps in sortIndex; with the parent's ID and class and the system flag.
    const near = buildTransportNeighboursEc();
    const lines = near.split('\n').map(l => l.trim());
    const from = (first: string, n: number) => lines.slice(lines.indexOf(first), lines.indexOf(first) + n);
    // Both siblings found first, then the addresses (genedit() adds a temporary sibling).
    expect(from('_c := _p.children.filter(sortIndex < _i)', 3)).toEqual(['_c := _p.children.filter(sortIndex < _i)', '_n := _p.children.filter(sortIndex > _i)', '_ga := str(_p.genedit(id))']);
    expect(from('IF _c.size() > 0 THEN', 6)).toEqual(['IF _c.size() > 0 THEN', '_cv := _c.last()', '_pv := str(_cv.rid)', '_gv := str(_cv.genedit(id))', 'ELSE ""', 'ENDIF']);
    expect(from('IF _n.size() > 0 THEN', 6)).toEqual(['IF _n.size() > 0 THEN', '_cn := _n.first()', '_nx := str(_cn.rid)', '_gx := str(_cn.genedit(id))', 'ELSE ""', 'ENDIF']);
    expect(near).toContain('_pi := str(_p.id)');
    expect(near).toContain('_pc := str(_p.className)');
    expect(near).toContain('_so := str(_o.systemObject.whenMissing(false))');
    // Only genedit(id): one value, never content.
    expect(near.match(/genedit\(/g)).toHaveLength(3);
    expect(near).not.toMatch(/genedit\(\)|generate|sortIndex = /);
  });

  it('parses generated text of any content; the neighbours as RIDs; an address as a plain address', () => {
    const generate = `t.p.add(TextElement, id := 'x', text := '${EC_FRAME.row}1:a${EC_FRAME.done} 5:', name := 'X')\n        _x.add(Foo)`;
    const genedit = `\nt.x.change(text := '~CREV_D~') //TextElement`;
    expect(parseTransportObjectLog(framedText([[RID_A, 'TextElement', genedit, '']]), RID_A)).toEqual({ className: 'TextElement', genedit });
    expect(parseTransportObjectLog(framedText([[RID_A, 'FileResource', genedit, '412000']]), RID_A)).toEqual({ className: 'FileResource', genedit, fileSize: 412000, isFile: true });
    // Not measured (file content off): a file without a size.
    expect(parseTransportObjectLog(framedText([[RID_A, 'FileResource', genedit, '?']]), RID_A)).toEqual({ className: 'FileResource', genedit, isFile: true });
    expect(parseTransportObjectLog(framedText([]), RID_A)).toBeNull();
    expect(() => parseTransportObjectLog(framedText([[RID_B, 'TextElement', '', '']]), RID_A)).toThrow(/damaged/);
    expect(parseTransportCreationLog(framedText([[RID_A, '', generate, '3:abc']]), RID_A)).toEqual({ text: generate, instances: '3:abc' });
    expect(parseTransportCreationLog(framedText([[RID_A, 'N', '', '']]), RID_A)).toEqual({ other: true });
    expect(parseTransportCreationLog(framedText([]), RID_A)).toBeNull();
    expect(() => parseTransportCreationLog(framedText([[RID_B, '', '', '']]), RID_A)).toThrow(/damaged/);
    expect(parseTransportNeighboursLog(framedText([[RID_A, ` ${RID_B}`, 't.x', 'my folder', 'Category', 'false', '', "\nt.my_folder.change(id := 'my_folder') //Category\n", "r.logo.change(id := 'logo') //FileResource", '']]))).toEqual({
      parentRid: RID_A, previousRid: RID_B, nextRid: '', parentId: 'my folder', parentClass: 'Category', systemObject: false, step: false,
      parentAddress: 't.my_folder', previousAddress: 'r.logo', nextAddress: '',
    });
    // A step of a flow project: under a FlowProject and one of its configObjects.
    expect(parseTransportNeighboursLog(framedText([[RID_A, '', '', 'p', 'FlowProject', 'false', '1', '', '', '']]))).toMatchObject({ step: true });
    expect(parseTransportNeighboursLog(framedText([[RID_A, '', '', 'p', 'FlowProject', 'false', '0', '', '', '']]))).toMatchObject({ step: false });
    expect(parseTransportNeighboursLog(framedText([[RID_A, '', '', 'PORTAL', 'PortalRoot', 'true', '', '', '', '']]))).toMatchObject({ parentId: 'PORTAL', parentClass: 'PortalRoot', systemObject: true });
    expect(parseTransportNeighboursLog(framedText([]))).toEqual({ parentRid: '', previousRid: '', nextRid: '', parentId: '', parentClass: '', systemObject: false, step: false, parentAddress: '', previousAddress: '', nextAddress: '' });
    expect(addressOfText("\nt.parent.change(id := 'parent') //Category\n")).toBe('t.parent');
    expect(addressOfText("ap.Everyone profile.change(id := 'Everyone profile') //ScorecardAccessProfile")).toBe('');
    expect(addressOfText('')).toBe('');
  });
});

describe('readTransportObjects', () => {
  const own = (rid: string, cls = 'TextElement'): EcResult => ({ ok: true, log: framedText([[rid, cls, `t.x${rid.slice(-3)}.change(name := 'X') //${cls}`, '']]) });
  const made = (rid: string): EcResult => ({ ok: true, log: framedText([[rid, '', `t.p.add(TextElement, id := 'x${rid.slice(-3)}')`, '']]) });
  const PARENT = '7000000000000000001';
  /** The neighbours row; the addresses as genedit(id) prints them. */
  const near = (pa = PARENT, pv = '', nx = '', pc = 'Category', ga = "\nt.p.change(id := 'p') //Category\n", gv = '', gx = ''): EcResult => ({ ok: true, log: framedText([[pa, pv, nx, 'p', pc, 'false', '', ga, gv, gx]]) });

  it('two context scripts per object in one post, the neighbours\' addresses with them: no further post', async () => {
    const executeEcPairs = vi.fn(async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => pairs.map(p => (
      p.code === buildTransportObjectEc() ? own(p.objectRid!)
        : p.code === buildTransportCreationEc() ? made(p.objectRid!)
          : near(PARENT, p.objectRid === RID_B ? RID_A : '', '', 'Category', "\nt.p.change(id := 'p') //Category\n", p.objectRid === RID_B ? "t.x993.change(id := 'x993') //TextElement" : '')
    )));
    const read = await readTransportObjects({ executeEcPairs }, [RID_A, RID_B, RID_A], undefined, [RID_B, RID_C]);
    expect(executeEcPairs).toHaveBeenCalledTimes(1);
    const [pairs, , timeout] = executeEcPairs.mock.calls[0] as unknown as [Array<{ code: string; objectRid: string }>, unknown, number];
    // The creation text only of the objects asked for that are in the read.
    expect(pairs.map(p => [p.objectRid, p.code === buildTransportObjectEc() ? 'own' : p.code === buildTransportNeighboursEc() ? 'near' : p.code === buildTransportCreationEc() ? 'made' : '?'])).toEqual([
      [RID_A, 'own'], [RID_A, 'near'], [RID_B, 'own'], [RID_B, 'near'], [RID_B, 'made'],
    ]);
    expect(timeout).toBe(TRANSPORT_READ_TIMEOUT_MS);
    const place = { parentAddress: 't.p', parentId: 'p', parentIsRoot: false, systemObject: false };
    expect(read).toEqual([
      { rid: RID_A, ok: true, className: 'TextElement', genedit: "t.x993.change(name := 'X') //TextElement", ...place, previousAddress: '', nextAddress: '' },
      { rid: RID_B, ok: true, className: 'TextElement', generate: "t.p.add(TextElement, id := 'x801')", genedit: "t.x801.change(name := 'X') //TextElement", ...place, previousAddress: 't.x993', nextAddress: '' },
    ]);
  });

  it('a parent that is a root: by its class, or because it has no address; a creation text that fails keeps the object', async () => {
    const executeEcPairs = vi.fn(async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => pairs.map(p => (
      p.code === buildTransportObjectEc() ? own(p.objectRid!)
          : p.code === buildTransportCreationEc() ? { ok: false, error: 'Heap' }
            : near(p.objectRid === RID_A ? PARENT : '7000000000000000003', '', '', p.objectRid === RID_A ? 'PortalRoot' : 'Category', '')
    )));
    const read = await readTransportObjects({ executeEcPairs }, [RID_A, RID_B], undefined, [RID_A]);
    expect(read[0]).toMatchObject({ rid: RID_A, ok: true, parentIsRoot: true, creationError: 'Heap' });
    expect(read[0]).not.toHaveProperty('generate');
    expect(read[1]).toMatchObject({ rid: RID_B, ok: true, parentAddress: '', parentIsRoot: true });
  });

  it('the creation text on its own: one script per object, each answered on its own', async () => {
    const executeEcPairs = vi.fn(async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => pairs.map(p => (p.objectRid === RID_B ? { ok: false, error: 'Heap' } : made(p.objectRid!))));
    expect(await readTransportCreation({ executeEcPairs }, [RID_A, RID_B, RID_A])).toEqual([
      { rid: RID_A, ok: true, generate: "t.p.add(TextElement, id := 'x993')" },
      { rid: RID_B, ok: false, error: 'Heap' },
    ]);
    expect((executeEcPairs.mock.calls[0] as unknown as [Array<{ code: string }>])[0].every(p => p.code === buildTransportCreationEc())).toBe(true);
    const many = Array.from({ length: TRANSPORT_READ_BATCH + 1 }, (_, i) => String(7000000000000000000n + BigInt(i)));
    await expect(readTransportCreation({ executeEcPairs }, many)).rejects.toThrow(`At most ${TRANSPORT_READ_BATCH}`);
  });

  it('an object that fails does not fail the others; failed neighbours keep the object\'s own text', async () => {
    const answers: EcResult[] = [
      { ok: false, error: 'Not allowed' }, near(),
      own(RID_B), { ok: false, error: 'No genedit for the parent' },
      { ok: true, log: framedText([]) }, near(),
      { ok: true, log: framedText([[RID_A, 'x', 'y', 'z', '']], false) }, near(),
    ];
    const executeEcPairs = vi.fn(async () => answers);
    const read = await readTransportObjects({ executeEcPairs }, [RID_A, RID_B, RID_C, '5000000000000000001']);
    expect(read[0]).toEqual({ rid: RID_A, ok: false, error: 'Not allowed' });
    expect(read[1]).toMatchObject({ rid: RID_B, ok: true, parentAddress: '', previousAddress: '', nextAddress: '', neighboursError: 'No genedit for the parent' });
    expect(read[2]).toEqual({ rid: RID_C, ok: false, error: 'The object does not exist (any more).', missing: true });
    expect(read[3]).toMatchObject({ ok: false, error: expect.stringMatching(/incomplete/) });
  });

  it('refuses more than a batch or a RID that is not one, before any post', async () => {
    const executeEcPairs = vi.fn(async () => [] as EcResult[]);
    const many = Array.from({ length: TRANSPORT_READ_BATCH + 1 }, (_, i) => String(7000000000000000000n + BigInt(i)));
    await expect(readTransportObjects({ executeEcPairs }, many)).rejects.toThrow(`At most ${TRANSPORT_READ_BATCH}`);
    await expect(readTransportObjects({ executeEcPairs }, ['1 OR 1'])).rejects.toThrow(/Invalid RID/);
    expect(await readTransportObjects({ executeEcPairs }, [])).toEqual([]);
    expect(executeEcPairs).not.toHaveBeenCalled();
  });
});

describe('the transport log read', () => {
  const entry = (rid: string, id: string, created: string, extra: Partial<Record<'name' | 'description' | 'by', string>> = {}) => [
    'L', rid, id, extra.name ?? `Title ${id}`, extra.description ?? `Summary ${id}`, created, extra.by ?? 'Admin',
  ];

  it('one constant script: the fixed folder, the last entries, no generated text', () => {
    const code = buildTransportLogEc();
    expect(code).toBe(buildTransportLogEc());
    expect(classifyScript(code).kind).toBe('constant');
    expect(code.length).toBeLessThanOrEqual(SCRIPT_LIMITS.constant);
    expect(code).toContain('_g := t.cc_transport_log');
    expect(code).toContain('IF _g = MISSING THEN');
    expect(code).toContain('_l := _g.children');
    expect(code).toContain(`IF _j > _n - ${TRANSPORT_LOG_CAP} THEN`);
    expect(code).toContain('_i.description.whenMissing("")');
    expect(code).toContain('_i.createdBy.name.whenMissing("")');
    expect(code).not.toMatch(/genedit|generate/);
    expect(code.endsWith('_r + "~CREV_D~"')).toBe(true);
  });

  it('newest first by created time, then the reverse of the folder\'s order; any text; more; no log', () => {
    const hostile = 'a ~CREV_R~1:x ~CREV_D~ \n \'quote\' \\';
    const log = framedText([
      ['T', '250'],
      entry(RID_A, 'cc_tr_1', 'Nov 1, 2026 10:00:00', { description: hostile }),
      entry(RID_B, 'cc_tr_3', 'Nov 15, 2026 21:30:00'),
      entry(RID_C, 'cc_tr_2', 'odd date', { by: '' }),
      entry('5000000000000000001', 'cc_tr_4', 'odd date'),
    ]);
    const read = parseTransportLogLog(log);
    expect(read.entries.map(e => e.id)).toEqual(['cc_tr_3', 'cc_tr_1', 'cc_tr_4', 'cc_tr_2']);
    expect(read.entries[1]).toEqual({ rid: RID_A, id: 'cc_tr_1', name: 'Title cc_tr_1', description: hostile, created: 'Nov 1, 2026 10:00:00', createdIso: '2026-11-01T10:00:00', createdBy: 'Admin' });
    expect(read.more).toBe(true);
    expect(read.missingLog).toBe(false);
    expect(parseTransportLogLog(framedText([['N']]))).toEqual({ entries: [], more: false, missingLog: true });
    expect(parseTransportLogLog(framedText([['T', '0']]))).toEqual({ entries: [], more: false, missingLog: false });
    let caught: unknown;
    try { parseTransportLogLog(framedText([['L', RID_A]])); } catch (e) { caught = e; }
    expect(errorKindOf(caught)).toBe('protocol');
    expect(() => parseTransportLogLog(framedText([entry(RID_A, 'x', '')], false))).toThrow(/incomplete/);
  });

  it('one preview run without a context object; a failed run throws with its kind', async () => {
    const executeEc = vi.fn(async (..._args: unknown[]) => ({ ok: true, log: framedText([['T', '1'], entry(RID_A, 'cc_tr_1', '')]) }) as EcResult);
    expect((await readTransportLog({ executeEc })).entries.map(e => e.rid)).toEqual([RID_A]);
    const [code, objectRid, transactional, , timeout] = executeEc.mock.calls[0];
    expect([code, objectRid, transactional, timeout]).toEqual([buildTransportLogEc(), undefined, false, TRANSPORT_SCAN_TIMEOUT_MS]);
    await expect(readTransportLog({ executeEc: async () => ({ ok: false, error: 'EC execution timed out (60s)', errorKind: 'timeout' }) })).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('the transport handlers', () => {
  async function harness() {
    vi.resetModules();
    mockChromeStorage();
    let release: () => void = () => undefined;
    let gate: Promise<void> | null = null;
    let logAnswer: string[][] = [['T', '1'], ['L', RID_A, 'cc_tr_1', 'Title', 'Summary', 'Nov 15, 2026 21:30:00', 'Admin']];
    const client = {
      serverUrl: 'https://bmp.example/demo/', sessionEpoch: 1,
      executeEc: vi.fn(async (code: string) => {
        if (gate) await gate;
        if (code === buildTransportLogEc()) return { ok: true, log: framedText(logAnswer) } as EcResult;
        if (code.includes('t.get("gone")')) return { ok: true, log: framedText([['M']]) } as EcResult;
        if (code.includes('.get(')) return { ok: true, log: framedText([scanRow(RID_B, 'my_module')]) } as EcResult;
        if (code === buildTransportRootChildrenEc('portal')) return { ok: true, log: framedText([['C', RID_A], ['C', RID_B]]) } as EcResult;
        return { ok: true, log: framedText(code.includes('root.role') ? [['M']] : [scanRow(RID_A, 'crev_qa_text')]) } as EcResult;
      }),
      executeEcOn: vi.fn(async (code: string, ..._rest: unknown[]) => ({ ok: true, log: framedText(code === buildTransportChildrenEc() ? [['C', RID_C]] : [scanRow(RID_C, 'my_tab')]) }) as EcResult),
      executeEcPairs: vi.fn(async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>) => pairs.map(p => (p.code === buildTransportRowEc()
        ? { ok: true, log: framedText([scanRow(p.objectRid!, 'my_folder')]) }
        : p.code === buildTransportUnderEc() ? { ok: true, log: framedText([scanRow(RID_C, 'my_tab')]) }
        : p.code === buildTransportObjectEc()
        ? { ok: true, log: framedText([[p.objectRid!, 'TextElement', 'e', '']]) }
        : p.code === buildTransportCreationEc() ? { ok: true, log: framedText([[p.objectRid!, '', 'g', '']]) }
            : { ok: true, log: framedText([['7000000000000000001', '', '', 'p', 'Category', 'false', '', "t.p.change(id := 'p') //Category", '', '']]) }))),
    };
    const ctx: any = { client, settings: { activeProfileId: 'p1' }, cache: { get: vi.fn(() => null) }, logActivity: vi.fn(), toast: vi.fn() };
    const { setSwContext } = await import('../sw-context');
    const { getHandler } = await import('../handler-registry');
    setSwContext(ctx);
    await import('../handlers/transport');
    const send = (type: string, msg: Record<string, unknown>, meta: Record<string, unknown> = FRAME) => new Promise<any>(resolve => {
      void getHandler(type)!({ type, environment: ENV, ...msg } as any, resolve, { isOneShot: true, ...meta } as any);
    });
    const hold = () => { gate = new Promise(r => { release = () => { gate = null; r(); }; }); };
    return { client, ctx, send, hold, release: () => release(), setLog: (rows: string[][]) => { logAnswer = rows; } };
  }

  it('TRANSPORT_SCAN answers with the rows, a missing root, and its request', async () => {
    const h = await harness();
    expect(await h.send('TRANSPORT_SCAN', { requestId: 's1', root: 'portal', since: '2026-11-15' })).toMatchObject({
      type: 'TRANSPORT_SCAN_RESULT', requestId: 's1', environment: ENV, root: 'portal', since: '2026-11-15', ok: true, rows: [{ rid: RID_A, id: 'crev_qa_text' }],
    });
    expect(await h.send('TRANSPORT_SCAN', { requestId: 's2', root: 'role', since: '2026-11-15' })).toMatchObject({ ok: true, rows: [], missingRoot: true });
  });

  it('TRANSPORT_SCAN_UNDER answers with the object first, or that there is none', async () => {
    const h = await harness();
    expect(await h.send('TRANSPORT_SCAN_UNDER', { requestId: 'u1', start: 't.my_module', since: '' })).toMatchObject({
      type: 'TRANSPORT_SCAN_UNDER_RESULT', requestId: 'u1', environment: ENV, start: 't.my_module', since: '', ok: true,
      origin: { rid: RID_B, id: 'my_module' }, rows: [{ rid: RID_B }, { rid: RID_C }],
    });
    expect(h.client.executeEcOn.mock.calls[0][1]).toBe(RID_B);
    const none = await h.send('TRANSPORT_SCAN_UNDER', { requestId: 'u2', start: 'gone', since: '2026-11-15' });
    expect(none).toMatchObject({ ok: true, rows: [], missingStart: true });
    expect(none.origin).toBeUndefined();
  });

  it('TRANSPORT_SCAN_UNDER refuses a start that is not an ID of a start space, or a bad day; nothing is read', async () => {
    const h = await harness();
    const refused = { type: 'TRANSPORT_SCAN_UNDER_RESULT', ok: false, refused: true };
    expect(await h.send('TRANSPORT_SCAN_UNDER', { requestId: 'u', start: 'o.my_org', since: '' })).toMatchObject({ ...refused, error: START_SPACE });
    expect(await h.send('TRANSPORT_SCAN_UNDER', { requestId: 'u', start: 'x\ny', since: '' })).toMatchObject({ ...refused, error: expect.stringMatching(/no line breaks/) });
    expect(await h.send('TRANSPORT_SCAN_UNDER', { requestId: 'u', start: 42, since: '' })).toMatchObject({ ...refused, error: 'Enter the ID of an object.' });
    expect(await h.send('TRANSPORT_SCAN_UNDER', { requestId: 'u', start: 'my_module', since: '2026-13-01' })).toMatchObject({ ...refused, error: 'The day must be a date (YYYY-MM-DD).' });
    expect(await h.send('TRANSPORT_SCAN_UNDER', { requestId: 'u', start: 'my_module', since: '' }, { ...FRAME, senderKind: 'content' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_SCAN_UNDER', { requestId: 'u', start: 'my_module', since: '', environment: 'p2@https://other.example/' })).toMatchObject(refused);
    expect(h.client.executeEc).not.toHaveBeenCalled();
    expect(h.client.executeEcOn).not.toHaveBeenCalled();
  });

  it('refuses a page, another environment, a bad root or day, saying refused; nothing is read', async () => {
    const h = await harness();
    const refused = { ok: false, refused: true };
    expect(await h.send('TRANSPORT_SCAN', { requestId: 's', root: 'portal', since: '2026-11-15' }, { ...FRAME, senderKind: 'content' })).toMatchObject({ ...refused, error: 'This request is not accepted from a page.' });
    expect(await h.send('TRANSPORT_SCAN', { requestId: 's', root: 'portal', since: '2026-11-15', environment: 'p2@https://other.example/' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_SCAN', { requestId: 's', root: 'portal', since: '2026-11-15', environment: undefined })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_SCAN', { requestId: 's', root: 'risk', since: '2026-11-15' })).toMatchObject({ ...refused, error: expect.stringMatching(/Not a root/) });
    expect(await h.send('TRANSPORT_SCAN', { requestId: 's', root: 'portal', since: '15.11.2026' })).toMatchObject({ ...refused, error: 'The day must be a date (YYYY-MM-DD).' });
    expect(await h.send('TRANSPORT_READ_OBJECTS', { requestId: 'r', rids: [RID_A] }, { ...FRAME, senderKind: 'content' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_READ_OBJECTS', { requestId: 'r', rids: Array.from({ length: TRANSPORT_READ_BATCH + 1 }, () => RID_A) })).toMatchObject({ ...refused, error: `At most ${TRANSPORT_READ_BATCH} objects per read.` });
    expect(await h.send('TRANSPORT_READ_OBJECTS', { requestId: 'r', rids: [RID_A, 1234567] })).toMatchObject({ ...refused, error: 'Not an object RID: 1234567' });
    expect(await h.send('TRANSPORT_LOG', { requestId: 'l' }, { ...FRAME, senderKind: 'content' })).toMatchObject({ type: 'TRANSPORT_LOG_RESULT', ...refused });
    expect(await h.send('TRANSPORT_LOG', { requestId: 'l', environment: 'p2@https://other.example/' })).toMatchObject(refused);
    expect(h.client.executeEc).not.toHaveBeenCalled();
    expect(h.client.executeEcPairs).not.toHaveBeenCalled();
  });

  it('TRANSPORT_CHILDREN, TRANSPORT_SCAN_BELOW and TRANSPORT_FIND answer, or refuse before anything is read', async () => {
    const h = await harness();
    expect(await h.send('TRANSPORT_CHILDREN', { requestId: 'c1', root: 'portal' })).toMatchObject({ type: 'TRANSPORT_CHILDREN_RESULT', requestId: 'c1', root: 'portal', ok: true, rids: [RID_A, RID_B] });
    expect(await h.send('TRANSPORT_CHILDREN', { requestId: 'c2', rid: RID_A })).toMatchObject({ ok: true, rids: [RID_C] });
    expect(h.client.executeEcOn.mock.calls[0][1]).toBe(RID_A);
    expect(await h.send('TRANSPORT_SCAN_BELOW', { requestId: 'b1', rid: RID_A, since: '' })).toMatchObject({
      type: 'TRANSPORT_SCAN_BELOW_RESULT', requestId: 'b1', rid: RID_A, since: '', ok: true, origin: { rid: RID_A }, rows: [{ rid: RID_A }, { rid: RID_C }],
    });
    expect(await h.send('TRANSPORT_FIND', { requestId: 'f1', address: 'k.my_kpi' })).toMatchObject({ type: 'TRANSPORT_FIND_RESULT', address: 'k.my_kpi', ok: true, row: { rid: RID_B } });
    expect(await h.send('TRANSPORT_FIND', { requestId: 'f2', address: 't.gone' })).toMatchObject({ ok: true, missing: true });
    const calls = h.client.executeEc.mock.calls.length + h.client.executeEcOn.mock.calls.length + h.client.executeEcPairs.mock.calls.length;
    const refused = { ok: false, refused: true };
    expect(await h.send('TRANSPORT_CHILDREN', { requestId: 'c', root: 'risk' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_CHILDREN', { requestId: 'c', rid: 'x' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_CHILDREN', { requestId: 'c' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_SCAN_BELOW', { requestId: 'b', rid: RID_A, since: '2026-13-01' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_SCAN_BELOW', { requestId: 'b', rid: '-1', since: '' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_FIND', { requestId: 'f', address: 'o.my_org' })).toMatchObject({ ...refused, error: START_SPACE });
    expect(await h.send('TRANSPORT_FIND', { requestId: 'f', address: 'my_kpi' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_FIND', { requestId: 'f', address: 'k.my_kpi' }, { ...FRAME, senderKind: 'content' })).toMatchObject(refused);
    expect(h.client.executeEc.mock.calls.length + h.client.executeEcOn.mock.calls.length + h.client.executeEcPairs.mock.calls.length).toBe(calls);
  });

  it('not connected: refused', async () => {
    const h = await harness();
    h.ctx.client = null;
    expect(await h.send('TRANSPORT_LOG', { requestId: 'l' })).toMatchObject({ ok: false, refused: true, error: 'Not connected to BMP' });
    expect(await h.send('TRANSPORT_SCAN', { requestId: 's', root: 'portal', since: '2026-11-15' })).toMatchObject({ ok: false, refused: true });
  });

  it('TRANSPORT_LOG answers with the entries, more, or no log; a failed read is not refused', async () => {
    const h = await harness();
    expect(await h.send('TRANSPORT_LOG', { requestId: 'l1' })).toEqual({
      type: 'TRANSPORT_LOG_RESULT', requestId: 'l1', environment: ENV, ok: true,
      entries: [{ rid: RID_A, id: 'cc_tr_1', name: 'Title', description: 'Summary', created: 'Nov 15, 2026 21:30:00', createdIso: '2026-11-15T21:30:00', createdBy: 'Admin' }],
    });
    h.setLog([['T', '300']]);
    expect(await h.send('TRANSPORT_LOG', { requestId: 'l2' })).toMatchObject({ ok: true, entries: [], more: true });
    h.setLog([['N']]);
    expect(await h.send('TRANSPORT_LOG', { requestId: 'l3' })).toMatchObject({ ok: true, entries: [], missingLog: true });
    h.setLog([['L', 'x']]);
    const bad = await h.send('TRANSPORT_LOG', { requestId: 'l4' });
    expect(bad).toMatchObject({ ok: false, errorKind: 'protocol', error: expect.stringMatching(/damaged/) });
    expect(bad.refused).toBeUndefined();
  });

  it('TRANSPORT_READ_OBJECTS answers per object, in order', async () => {
    const h = await harness();
    expect(await h.send('TRANSPORT_READ_OBJECTS', { requestId: 'r1', rids: [RID_B, RID_A] })).toEqual({
      type: 'TRANSPORT_OBJECTS_RESULT', requestId: 'r1', environment: ENV, ok: true,
      objects: [
        { rid: RID_B, ok: true, className: 'TextElement', genedit: 'e', parentAddress: 't.p', previousAddress: '', nextAddress: '', parentId: 'p', parentIsRoot: false, systemObject: false },
        { rid: RID_A, ok: true, className: 'TextElement', genedit: 'e', parentAddress: 't.p', previousAddress: '', nextAddress: '', parentId: 'p', parentIsRoot: false, systemObject: false },
      ],
    });
  });

  it('TRANSPORT_READ_OBJECTS reads creation text only for objects of the read', async () => {
    const h = await harness();
    await h.send('TRANSPORT_READ_OBJECTS', { requestId: 'r2', rids: [RID_A], creation: [RID_C, 42, RID_A] });
    const pairs = h.client.executeEcPairs.mock.calls[0][0];
    expect(pairs.filter(p => p.code === buildTransportCreationEc()).map(p => p.objectRid)).toEqual([RID_A]);
  });

  it('TRANSPORT_READ_CREATION answers per object, in order; refuses like the object read', async () => {
    const h = await harness();
    expect(await h.send('TRANSPORT_READ_CREATION', { requestId: 'c1', rids: [RID_B, RID_A] })).toEqual({
      type: 'TRANSPORT_CREATION_RESULT', requestId: 'c1', environment: ENV, ok: true,
      texts: [{ rid: RID_B, ok: true, generate: 'g' }, { rid: RID_A, ok: true, generate: 'g' }],
    });
    const refused = { type: 'TRANSPORT_CREATION_RESULT', ok: false, refused: true };
    expect(await h.send('TRANSPORT_READ_CREATION', { requestId: 'c', rids: [RID_A] }, { ...FRAME, senderKind: 'content' })).toMatchObject(refused);
    expect(await h.send('TRANSPORT_READ_CREATION', { requestId: 'c', rids: [RID_A, 'x'] })).toMatchObject({ ...refused, error: 'Not an object RID: x' });
    expect(await h.send('TRANSPORT_READ_CREATION', { requestId: 'c', rids: [RID_A], environment: 'p2@https://other.example/' })).toMatchObject(refused);
  });

  it('one request at a time per environment; a queued request cancelled before its turn never runs', async () => {
    const h = await harness();
    h.hold();
    const first = h.send('TRANSPORT_SCAN', { requestId: 'a', root: 'portal', since: '2026-11-15' });
    const second = h.send('TRANSPORT_SCAN', { requestId: 'b', root: 'expression', since: '2026-11-15' });
    const third = h.send('TRANSPORT_READ_OBJECTS', { requestId: 'c', rids: [RID_A] });
    await vi.waitFor(() => expect(h.client.executeEc).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 0));
    expect(h.client.executeEc).toHaveBeenCalledTimes(1);
    expect(h.client.executeEcPairs).not.toHaveBeenCalled();
    void h.send('TRANSPORT_CANCEL', { requestId: 'b' });
    h.release();
    expect(await first).toMatchObject({ requestId: 'a', ok: true });
    expect(await second).toMatchObject({ requestId: 'b', ok: false, cancelled: true });
    expect(await third).toMatchObject({ requestId: 'c', ok: true });
    expect(h.client.executeEc).toHaveBeenCalledTimes(1);
    // The object read: one post, the neighbours' addresses in it.
    expect(h.client.executeEcPairs).toHaveBeenCalledTimes(1);
  });

  it('a running request that is cancelled answers cancelled', async () => {
    const h = await harness();
    h.hold();
    const run = h.send('TRANSPORT_SCAN', { requestId: 'x', root: 'portal', since: '2026-11-15' });
    await vi.waitFor(() => expect(h.client.executeEc).toHaveBeenCalledTimes(1));
    void h.send('TRANSPORT_CANCEL', { requestId: 'x' });
    h.release();
    expect(await run).toMatchObject({ requestId: 'x', ok: false, cancelled: true });
  });
});
