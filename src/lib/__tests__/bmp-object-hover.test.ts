/** Tests for EC emitted by the BMP object-hover resolver. */
import { describe, it, expect } from 'vitest';
import { buildHoverResolveEc, parseHoverResolveLog } from '../handlers/objects';
import { framedLog, framedLogCut } from './ec-frame-fixtures';

describe('buildHoverResolveEc — syntax regression', () => {
  // Before 2026-05-29 this EC used `_code := IF ... ENDIF` (no parens).
  // That's a parse error in EC; every hover for `t.x`-style refs silently
  // returned no identity and the user saw only the unresolved fallback.
  // Lock the working form in.
  it('never emits bare `:= IF` (must wrap inline IF in parens)', () => {
    const ec = buildHoverResolveEc('t.foo');
    expect(ec).not.toMatch(/:=\s+IF\b/);
    expect(ec).toMatch(/:=\s+\(IF\b/);
    expect(ec).toMatch(/ENDIF\)/);
  });

  it('inlines the ref verbatim', () => {
    expect(buildHoverResolveEc('t.json_size')).toContain('_o := t.json_size');
    expect(buildHoverResolveEc('ceiss.42')).toContain('_o := ceiss.42');
  });

  it('emits one framed 5-field result row and the completion marker', () => {
    const ec = buildHoverResolveEc('t.foo');
    const lines = ec.trim().split('\n');
    expect(lines.filter(l => /^_f\d := str\(/.test(l))).toHaveLength(5);
    expect(lines.at(-1)).toBe('_r + "~CREV_D~"');
  });

  it('parses multi-line code and names with ||| without truncation', () => {
    const code = 'line one\n|||\nline three';
    expect(parseHoverResolveLog(framedLog([['A ||| B\nC', 'ExtendedTable', '42', 'x.y', code]]))).toEqual({
      name: 'A ||| B\nC', objectType: 'ExtendedTable', rid: '42', businessId: 'x.y', codePreview: code,
    });
  });

  it('caps the code preview at 500 characters and rejects a cut-off answer', () => {
    const parsed = parseHoverResolveLog(framedLog([['N', 'ExtendedTable', '42', 'x', 'c'.repeat(2000)]]));
    expect(parsed?.codePreview).toHaveLength(500);
    expect(parseHoverResolveLog(framedLogCut([['N', 'ExtendedTable', '42', 'x', 'code']]))).toBeNull();
  });

  // Golden (plan 014 — ec-row-codec migration): the exact EC string this
  // builder produced before it was rewritten to compose its result row via
  // ec-row-codec's buildRowEc. Locks the CODE_BEARING_TYPES OR-chain order
  // and the exact field order/whenMissing defaults of the result row.
  it('golden: exact EC string for a namespace ref', () => {
    // Old golden: 4 lines, 534 characters, fields split by markers; new:
    // length-framed fields (each evaluated once), 11 lines, 681 characters.
    const ec = buildHoverResolveEc('t.foo');
    expect(ec).toBe([
      '_o := t.foo',
      '_cls := _o.className.whenMissing("")',
      '_code := (IF _cls = "ExtendedMethodConfig" OR _cls = "ExtendedTable" OR _cls = "ExtendedExpression" OR _cls = "ReferenceMethodConfig" OR _cls = "HistoricalReferenceMethodConfig" OR _cls = "CustomVisualization" OR _cls = "DashboardHTML" THEN output(_o.expression.whenMissing("")) ELSE "" ENDIF)',
      '_r := ""',
      '_f0 := str(_o.name.whenMissing(""))',
      '_f1 := str(_cls)',
      '_f2 := str(_o.rid.whenMissing(""))',
      '_f3 := str(_o.id.whenMissing(""))',
      '_f4 := str(_code)',
      '_r := _r + ("~CREV_R~" + str(_f0.size()) + ":" + _f0 + str(_f1.size()) + ":" + _f1 + str(_f2.size()) + ":" + _f2 + str(_f3.size()) + ":" + _f3 + str(_f4.size()) + ":" + _f4)',
      '_r + "~CREV_D~"',
    ].join('\n'));
  });
});
