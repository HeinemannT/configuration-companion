/**
 * Characterization goldens for bmp-client.ts's row (de)serialization —
 * plan 014 (ec-row-codec consolidation). Each test locks the EXACT EC string
 * (or, where the codec provably regroups an equivalent literal concatenation,
 * the exact resulting parse behavior) these builders had before migrating to
 * ec-row-codec, so a regression in the codec swap fails loudly here.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildAccessSubjectsEc, parseAccessSubjectsLog,
  parseResolveTemplateLog,
  buildLayoutTreeEc,
} from '../bmp-client';
import { LAYOUT_SEP } from '../layout-wire';
import { EcQueryService } from '../ec-query-service';
import type { EcResult } from '../bmp-client';
import { framedLog, framedLogCut } from './ec-frame-fixtures';

describe('buildAccessSubjectsEc (golden)', () => {
  it('includes nested users and roles, excludes delegation nodes and frames each row', () => {
    // Old golden 728 characters (random frame per call outside tests); new
    // 620 characters, the same text on every call.
    expect(buildAccessSubjectsEc()).toBe([
      '_out := ""',
      'root.user.descendants.filter(className = "User").forEach(_u:',
      '     _f1 := str(_u.rid)',
      '     _f2 := str(_u.id.whenMissing(""))',
      '     _f3 := str(_u.name.whenMissing(""))',
      '     _out := _out + ("~CREV_R~4:user" + str(_f1.size()) + ":" + _f1 + str(_f2.size()) + ":" + _f2 + str(_f3.size()) + ":" + _f3)',
      ')',
      'root.role.descendants.filter(className = "Role").forEach(_r:',
      '     _f1 := str(_r.rid)',
      '     _f2 := str(_r.id.whenMissing(""))',
      '     _f3 := str(_r.name.whenMissing(""))',
      '     _out := _out + ("~CREV_R~4:role" + str(_f1.size()) + ":" + _f1 + str(_f2.size()) + ":" + _f2 + str(_f3.size()) + ":" + _f3)',
      ')',
      '_out + "~CREV_D~"',
    ].join('\n'));
  });
});

describe('parseAccessSubjectsLog (golden)', () => {
  it('reports failed or incomplete directory queries instead of hiding them as an empty picker', async () => {
    for (const result of [{ ok: false, error: 'Denied' }, { ok: true, hasWarning: true, log: 'Incomplete' }]) {
      const service = new EcQueryService(async () => result as EcResult, async rid => `lookup(${rid})`, []);
      await expect(service.listAccessSubjects()).rejects.toThrow(/Denied|Incomplete/);
    }
  });
  it('parses users and roles, sorted by name', () => {
    const log = framedLog([
      ['user', '111', 'u1', 'Zed User'],
      ['role', '222', 'r1', 'Admins'],
      ['user', '333', 'u2', 'Ann User'],
    ]);
    expect(parseAccessSubjectsLog(log)).toEqual([
      { rid: '222', name: 'Admins', kind: 'role', businessId: 'r1' },
      { rid: '333', name: 'Ann User', kind: 'user', businessId: 'u2' },
      { rid: '111', name: 'Zed User', kind: 'user', businessId: 'u1' },
    ]);
  });

  it('keeps names with pipes, triple pipes and line breaks intact', () => {
    const names = ['A | B', 'x|||y|||z', 'Line one\nLine two', 'L'.repeat(5000)];
    const log = framedLog(names.map((name, i) => ['user', String(100 + i), `u${i}`, name]));
    expect(parseAccessSubjectsLog(log).map(s => s.name).sort()).toEqual([...names].sort());
  });

  it('throws on a cut-off answer instead of returning a short list', () => {
    expect(() => parseAccessSubjectsLog(framedLogCut([['user', '111', 'u1', 'Zed']]))).toThrow(/incomplete/i);
  });

  it('falls back to businessId then rid when name is empty', () => {
    expect(parseAccessSubjectsLog(framedLog([['user', '111', 'u1', '']]))).toEqual([
      { rid: '111', name: 'u1', kind: 'user', businessId: 'u1' },
    ]);
    expect(parseAccessSubjectsLog(framedLog([['user', '111', '', '']]))).toEqual([
      { rid: '111', name: '111', kind: 'user', businessId: undefined },
    ]);
  });

  it('skips a MISSING-rid row and non user/role kinds', () => {
    expect(parseAccessSubjectsLog(framedLog([['user', 'MISSING', 'u1', 'Name']]))).toEqual([]);
    expect(parseAccessSubjectsLog(framedLog([['other', '111', 'u1', 'Name']]))).toEqual([]);
  });
});

describe('parseResolveTemplateLog (golden)', () => {
  it('parses a resolved template row (rid, name, className, id order) between log noise', () => {
    const log = `Result : 0\n${framedLog([['8765432109876543210', 'Enterprise Template', 'EnterpriseTemplate', 'et_1']])}\nDuration: 4ms`;
    expect(parseResolveTemplateLog(log)).toEqual({
      templateRid: '8765432109876543210',
      templateName: 'Enterprise Template',
      templateType: 'EnterpriseTemplate',
      templateBusinessId: 'et_1',
    });
  });

  it('returns templateRid: null when the row starts with MISSING', () => {
    expect(parseResolveTemplateLog(framedLog([['MISSING', '', '', '']]))).toEqual({ templateRid: null });
  });

  it('throws when the completion marker is missing (cut-off answer)', () => {
    expect(() => parseResolveTemplateLog('Result : 0\nDuration: 2ms')).toThrow(/incomplete/i);
  });

  it('treats empty name/className/id as undefined', () => {
    expect(parseResolveTemplateLog(framedLog([['123', '', '', '']]))).toEqual({
      templateRid: '123', templateName: undefined, templateType: undefined, templateBusinessId: undefined,
    });
  });

  it('keeps a template name with ||| and a line break, and the fields after it', () => {
    expect(parseResolveTemplateLog(framedLog([['123', 'Risk ||| Template\nv2', 'TemplateCategory', 'tc_1']]))).toEqual({
      templateRid: '123', templateName: 'Risk ||| Template\nv2', templateType: 'TemplateCategory', templateBusinessId: 'tc_1',
    });
  });
});

describe('buildLayoutTreeEc (golden)', () => {
  it('emits the lean structural row into a 32-node chunk', () => {
    const ec = buildLayoutTreeEc('lookup(123)');
    expect(ec).toContain(
      `_line := "${LAYOUT_SEP}" + _n.rid + "|" + _n.id.whenMissing("") + "|" + _type + "|" + _p.rid.whenMissing("") + "|" + "" + "|" + _n.columnsLargeScreen.whenMissing("") + "|" + _n.columnsMediumScreen.whenMissing("") + "|" + _n.columnsSmallScreen.whenMissing("") + "|" + "" + "|" + (IF _n.name.whenMissing("") = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE _n.name.whenMissing("") ENDIF) + "\\n"`,
    );
    expect(ec).toContain('IF _i > 31 THEN');
    expect(ec).not.toContain('_n.container');
    expect(ec).not.toContain('_n.chartHeight');
  });

  it('emits the root row with the same resulting field values as the pre-codec "|||"/"||" literal-compaction form (regrouped, not renumbered)', () => {
    const ec = buildLayoutTreeEc('lookup(123)');
    expect(ec).toContain(
      `_r := _r + "${LAYOUT_SEP}" + _root.rid + "|" + _root.id.whenMissing("") + "|" + _root.className.whenMissing("") + "|" + "" + "|" + "" + "|" + _root.columnsLargeScreen.whenMissing("") + "|" + _root.columnsMediumScreen.whenMissing("") + "|" + _root.columnsSmallScreen.whenMissing("") + "|" + "" + "|" + (IF _root.name.whenMissing("") = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE _root.name.whenMissing("") ENDIF) + "\\n"`,
    );
  });

  it('inlines the ref and enforces the structural source cap', () => {
    const ec = buildLayoutTreeEc('lookup(123)');
    expect(ec.split('\n')[0]).toBe('_root := lookup(123)');
    expect(ec.trim().split('\n').pop()).toBe('_r');
    expect(ec).toContain('IF _emitted < 600 THEN');
    expect(ec).toContain('<<<CREV_LAYOUT_TREE_LIMIT>>>600');
    expect(ec).toContain('IF _type = "Tab"');
    expect(ec).toContain('IF _type = "Container"');
  });
});

describe('EcQueryService.fetchLayoutTree (bounded portal structure)', () => {
  // rid|bid|type|parentRid|containerRid|L|M|S|chartHeight|name — the wire row parseLayoutNodes reads.
  const row = (rid: string, type: string, parentRid: string, name: string) =>
    `${LAYOUT_SEP}${rid}|${rid.toLowerCase()}|${type}|${parentRid}|||||| ${name}`;
  const log = [
    row('t1', 'Tab', 'r0', 'Cases'),
    row('c1', 'Container', 't1', 'Main'),
  ].join('\n');

  it('parses structural rows and reports the source-limit marker', async () => {
    const svc = new EcQueryService(
      async () => ({ ok: true, log: `${log}\n<<<CREV_LAYOUT_TREE_LIMIT>>>600` }) as unknown as EcResult,
      async (rid: string) => `lookup(${rid})`,
      [],
    );
    const result = await svc.fetchLayoutTree('123');
    expect(result.nodes.map(n => n.type)).toEqual(['Tab', 'Container']);
    expect(result.truncated).toBe(true);
  });

  it('uses a bounded timeout and throws instead of turning failure into an empty tree', async () => {
    const executeEc = vi.fn(async () => ({ ok: false, error: 'timed out' }) as unknown as EcResult);
    const svc = new EcQueryService(executeEc, async rid => `lookup(${rid})`, []);

    await expect(svc.fetchLayoutTree('123')).rejects.toThrow('timed out');
    // The object is the command's context; the bounded timeout stays.
    expect(executeEc).toHaveBeenCalledWith(
      expect.any(String),
      '123',
      false,
      undefined,
      10_000,
      undefined,
    );
  });
});
