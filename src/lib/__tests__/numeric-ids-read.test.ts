import { describe, expect, it, vi } from 'vitest';
import { framedText } from '../ec-parser';
import { classifyScript } from '../script-kinds';
import { TRANSPORT_ROOTS } from '../transport-bundle';
import {
  buildNumericScanEc, buildTransportOriginEc, NUMERIC_SCAN_CAP, parseNumericScanLog, parseTransportOriginLog, readNumericScan, readTransportOrigins,
} from '../transport-read';
import type { EcResult } from '../bmp-client';

const RID_A = '9007199254740993', RID_B = '9223372036854775801', RID_C = '1234567890123456789', PARENT = '9007199254740000';
const full = (rid: string, id: string, name: string, cls = 'ActionButton', parent = PARENT) => [
  'O', `${rid} ${parent} 2 ${cls}`, id, name, 'Jun 25, 2026 14:29:58|Jun 25, 2026 14:29:58|', '12:admin|Tassilo', 'folder_x', 'Folder X',
];
const context = (rid: string, id: string, name: string, cls = 'Category', parent = PARENT, parentId = 'PORTAL') => ['I', `${rid} ${parent} 1 ${cls}`, id, name, parentId];

describe('the numeric-ID scan', () => {
  it('walks one root, tests the first character of the ID and writes a full row or a short one', () => {
    const code = buildNumericScanEc('templateCategory');
    expect(code).toContain('_g := root.templateCategory');
    expect(code).toContain(`.first(${NUMERIC_SCAN_CAP + 1}).forEach(_i:`);
    expect(code).toContain('_d := _i.id.whenMissing("x").substring(0,1)');
    for (const d of '0123456789') expect(code).toContain(`_d = "${d}"`);
    expect(code).toContain('IF _d = "0" OR');
    expect(code).toContain('ELSE');
    expect(code).toContain('_i.parent.id.whenMissing("")');
    expect(code.endsWith('_r + "~CREV_D~"')).toBe(true);
  });

  it('is a constant script for every root (one text per root) and under the limit', () => {
    for (const root of TRANSPORT_ROOTS) {
      const code = buildNumericScanEc(root);
      expect(classifyScript(code).kind, root).toBe('constant');
      expect(code.length).toBeLessThan(25_000);
    }
    expect(buildNumericScanEc('classConfig')).toContain('className = "ConditionRule"');
    expect(() => buildNumericScanEc('risk')).toThrow(/Not a root/);
  });

  it('reads candidates as scan rows and the other objects as context', () => {
    const scan = parseNumericScanLog(framedText([
      context(RID_A, 'folder_x', 'Folder X', 'Category', PARENT, 'TEMPLATECATEGORY'),
      full(RID_B, '5612', 'Cleanup'),
    ]), 'templateCategory');
    expect(scan.rows).toHaveLength(1);
    expect(scan.rows[0]).toMatchObject({ rid: RID_B, id: '5612', name: 'Cleanup', className: 'ActionButton', parentRid: PARENT, parentId: 'folder_x' });
    expect(scan.context).toEqual([{ rid: RID_A, parentRid: PARENT, parentId: 'TEMPLATECATEGORY', sortIndex: 1, id: 'folder_x', name: 'Folder X', className: 'Category' }]);
    expect(scan.more).toBe(false);
    expect(scan.missingRoot).toBe(false);
  });

  it('drops objects the scan never lists and keeps 64-bit RIDs as text', () => {
    const scan = parseNumericScanLog(framedText([context(RID_A, 'cfg', 'Config', 'ClassConfig'), full(RID_C, '7', 'Seven', 'SystemMethodConfig'), context(RID_B, 'real', 'Real', 'Tab')]), 'portal');
    expect(scan.context.map(c => c.rid)).toEqual([RID_B]);
    expect(scan.rows).toEqual([]);
  });

  it('says when a root is missing or cut', () => {
    expect(parseNumericScanLog(framedText([['M']]), 'role')).toMatchObject({ missingRoot: true, rows: [], context: [] });
    const rows = Array.from({ length: NUMERIC_SCAN_CAP + 1 }, (_, i) => context(String(1000 + i), `id_${i}`, 'n'));
    const cut = parseNumericScanLog(framedText(rows), 'portal');
    expect(cut.more).toBe(true);
  });

  it('throws on a cut-off or damaged answer', () => {
    expect(() => parseNumericScanLog(framedText([context(RID_A, 'a', 'A')], false), 'portal')).toThrow(/incomplete/);
    expect(() => parseNumericScanLog(framedText([['I', 'x y z', 'a', 'A', 'p']]), 'portal')).toThrow(/damaged/);
    expect(() => parseNumericScanLog(framedText([['I', `${RID_A} ${PARENT} 1 Tab`, 'a']]), 'portal')).toThrow(/damaged/);
  });

  it('reads a root in one preview run; a missing root is not an error', async () => {
    const executeEc = vi.fn(async (..._a: unknown[]): Promise<EcResult> => ({ ok: true, log: framedText([full(RID_B, '5612', 'Cleanup')]) }));
    const scan = await readNumericScan({ executeEc }, 'portal');
    expect(scan.rows.map(r => r.id)).toEqual(['5612']);
    expect(executeEc).toHaveBeenCalledTimes(1);
    expect(executeEc.mock.calls[0][0]).toBe(buildNumericScanEc('portal'));
    expect(executeEc.mock.calls[0][2]).toBe(false);
    const gone = await readNumericScan({ executeEc: async () => ({ ok: true, log: 'Missing value for .role\n' + framedText([['M']]) }) }, 'role');
    expect(gone.missingRoot).toBe(true);
    await expect(readNumericScan({ executeEc: async () => ({ ok: false, error: 'boom' }) }, 'portal')).rejects.toThrow();
  });
});

describe('who created an object', () => {
  it('reads the system flag and the creator of the context object', () => {
    const code = buildTransportOriginEc();
    expect(code).toContain('this.object');
    expect(code).toContain('_o.systemObject.whenMissing(false)');
    expect(code).toContain('_o.createdBy.name.whenMissing("")');
    expect(classifyScript(code).kind).toBe('constant');
  });

  it('parses a row, nothing, and refuses damage', () => {
    expect(parseTransportOriginLog(framedText([[RID_A, 'false', 'System']]))).toEqual({ rid: RID_A, systemObject: false, createdBy: 'System' });
    expect(parseTransportOriginLog(framedText([[RID_A, 'true', '']]))).toMatchObject({ systemObject: true });
    expect(parseTransportOriginLog(framedText([]))).toBeNull();
    expect(() => parseTransportOriginLog(framedText([['x', 'true', 'S']]))).toThrow();
    expect(() => parseTransportOriginLog(framedText([[RID_A, 'true']]))).toThrow();
  });

  it('reads a batch in one post and answers per object', async () => {
    const executeEcPairs = vi.fn(async (pairs: ReadonlyArray<{ code: string; objectRid?: string }>): Promise<EcResult[]> => pairs.map((p, i) => (
      i === 0 ? { ok: true, log: framedText([[p.objectRid!, 'false', 'Tassilo']]) }
        : i === 1 ? { ok: true, log: framedText([]) }
          : i === 2 ? { ok: false, error: 'no access' }
            : { ok: true, log: framedText([['111', 'false', 'x']]) })));
    const out = await readTransportOrigins({ executeEcPairs }, [RID_A, RID_B, RID_C, '5']);
    expect(executeEcPairs).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      { rid: RID_A, origin: { rid: RID_A, systemObject: false, createdBy: 'Tassilo' } },
      { rid: RID_B, missing: true },
      { rid: RID_C, error: 'no access' },
      { rid: '5', error: expect.stringMatching(/damaged/) },
    ]);
    await expect(readTransportOrigins({ executeEcPairs }, Array.from({ length: 26 }, (_, i) => String(i + 1)))).rejects.toThrow(/At most/);
    expect(await readTransportOrigins({ executeEcPairs }, [])).toEqual([]);
  });
});
