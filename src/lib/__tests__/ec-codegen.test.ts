/**
 * Tests for EC code generation — validates that the EC strings the
 * production builders emit are syntactically plausible Extended Code.
 *
 * Covers:
 * - badge enrichment (EcQueryService.batchEnrich, buildContextEnrichEc,
 *   buildBatchEnrichEc): template ID through linkedTo with the enterprise
 *   template fallback, the row it answers, RID filtering before any request
 * - template resolution (EcQueryService.resolveTemplate)
 * - EC syntax validation (no bare inline IF after :=, balanced blocks)
 */
import { describe, it, expect } from 'vitest';
import {
  buildObjectPaneEc,
  buildEditFieldPropertyEc, buildPropertyApplicationsEc,
} from '../ec-codegen';
import { buildBatchEnrichEc, buildContextEnrichEc, EcQueryService } from '../ec-query-service';
import { framedText } from '../ec-parser';
import { BATCH_CHUNK_SIZE } from '../constants';
import type { EcResult } from '../bmp-client';

// ── EC syntax validator ──

/** Checks common EC syntax errors that would cause parse failures on BMP */
function validateEcSyntax(code: string): string[] {
  const errors: string[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNum = i + 1;

    // Rule: inline IF after := MUST be wrapped in parentheses
    // Bad:  _x := IF ... THEN ... ELSE ... ENDIF
    // Good: _x := (IF ... THEN ... ELSE ... ENDIF)
    if (/:=\s+IF\b/.test(line) && !/:=\s+\(IF\b/.test(line)) {
      errors.push(`Line ${lineNum}: bare inline IF after := — must wrap in parentheses: ${line}`);
    }
  }

  // Block IF/ENDIF balance: a line that ends in THEN opens a block, a line
  // that starts with ENDIF closes one. `IF … THEN … ENDIF` on one line is
  // balanced by itself.
  const ifCount = lines.filter(l => /^\s*IF\b.*\bTHEN\s*$/.test(l)).length;
  const endifCount = lines.filter(l => /^\s*ENDIF\b/.test(l)).length;
  if (ifCount !== endifCount) {
    errors.push(`IF/ENDIF mismatch: ${ifCount} IF vs ${endifCount} ENDIF`);
  }

  // Parenthesized inline IFs also count
  const inlineIfCount = (code.match(/\(IF\b/g) || []).length;
  const inlineEndifCount = (code.match(/ENDIF\)/g) || []).length;
  if (inlineIfCount !== inlineEndifCount) {
    errors.push(`Inline IF/ENDIF mismatch: ${inlineIfCount} (IF vs ${inlineEndifCount} ENDIF)`);
  }

  return errors;
}

/** An EcQueryService whose context commands are recorded and answered by
 *  `answer` (the object RID decides the reply). */
function service(answer: (rid: string) => EcResult = () => ({ ok: true, log: framedText([]) })) {
  const calls: Array<{ code: string; rid: string }> = [];
  const on = async (code: string, rid: string): Promise<EcResult> => {
    calls.push({ code, rid });
    return answer(rid);
  };
  const svc = new EcQueryService(
    async () => { throw new Error('no free-form script expected'); },
    async rid => `lookup(${rid})`,
    [],
    undefined,
    {
      on,
      each: async (code, rids) => {
        const out = new Map<string, EcResult>();
        for (const rid of rids) out.set(rid, await on(code, rid));
        return out;
      },
    },
  );
  return { svc, calls };
}

// ── Tests ──

describe('EC syntax validation', () => {
  it('rejects bare inline IF after :=', () => {
    const badCode = '_tid := IF _t != MISSING THEN _t.id ELSE "" ENDIF';
    const errors = validateEcSyntax(badCode);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('bare inline IF');
  });

  it('accepts parenthesized inline IF after :=', () => {
    const goodCode = '_tid := (IF _t != MISSING THEN _t.id ELSE "" ENDIF)';
    const errors = validateEcSyntax(goodCode);
    expect(errors.filter(e => e.includes('bare inline IF'))).toHaveLength(0);
  });

  it('accepts block IF statements', () => {
    const code = 'IF _o != MISSING THEN\n  _x := _o.name\nENDIF';
    const errors = validateEcSyntax(code);
    expect(errors).toHaveLength(0);
  });

  it('reports an unclosed block', () => {
    expect(validateEcSyntax('IF _o != MISSING THEN\n  _x := _o.name')).toEqual(['IF/ENDIF mismatch: 1 IF vs 0 ENDIF']);
  });
});

describe('badge enrichment EC (production builders)', () => {
  const scripts = { context: buildContextEnrichEc(), batch: buildBatchEnrichEc(['lookup(111)', 'lookup(222)']) };

  it.each(Object.entries(scripts))('%s script passes EC syntax validation', (_name, code) => {
    expect(validateEcSyntax(code)).toEqual([]);
  });

  it.each(Object.entries(scripts))('%s script resolves the template through linkedTo, then the enterprise template', (_name, code) => {
    const linked = code.indexOf('_t := _o.linkedTo');
    const fallback = code.indexOf('IF _t = MISSING THEN');
    expect(linked).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(linked);
    expect(code).toContain('_t := _o.template');
    expect(code).toContain('_tid := (IF _t != MISSING THEN _t.id.whenMissing("") ELSE "" ENDIF)');
  });

  it('the context script names no object: the object is the command context', () => {
    expect(scripts.context).not.toMatch(/lookup\(\d/);
    expect(scripts.context).toContain('this.object');
  });

  it('the batch script names each object once', () => {
    expect(scripts.batch.match(/lookup\(111\)/g)).toHaveLength(1);
    expect(scripts.batch.match(/lookup\(222\)/g)).toHaveLength(1);
  });
});

describe('EcQueryService.batchEnrich', () => {
  it('sends one constant script per valid RID and parses the nine-field row, RIDs as strings', async () => {
    const big = '9007199254740993'; // above Number.MAX_SAFE_INTEGER
    const { svc, calls } = service(rid => ({
      ok: true,
      log: framedText([[rid, ' bid_1 ', 'InputView', 'Name, kept', ' tmpl_1 ', '9007199254740995', 'set_1', 'InputSet', 'Set name']]),
    }));
    const res = await svc.batchEnrich([big, '-12', 'not-a-rid', '', '1); delete(']);
    expect(calls.map(c => c.rid).sort()).toEqual(['-12', big].sort());
    expect(new Set(calls.map(c => c.code))).toEqual(new Set([buildContextEnrichEc()]));
    expect(res.error).toBeUndefined();
    expect(res.results[big]).toEqual({
      businessId: 'bid_1', type: 'InputView', name: 'Name, kept', templateBusinessId: 'tmpl_1',
      cascade: { rid: '9007199254740995', businessId: 'set_1', type: 'InputSet', name: 'Set name' },
    });
    expect(Object.keys(res.results)).toEqual(expect.arrayContaining([big, '-12']));
  });

  it('asks nothing when no RID is valid (an injection attempt included)', async () => {
    const { svc, calls } = service();
    expect(await svc.batchEnrich(['123); evil(); (456', '12345\n_x := evil()', 'abc', ''])).toEqual({ results: {} });
    expect(calls).toEqual([]);
  });

  it(`asks about at most ${BATCH_CHUNK_SIZE} objects`, async () => {
    const { svc, calls } = service();
    await svc.batchEnrich(Array.from({ length: BATCH_CHUNK_SIZE * 2 }, (_, i) => String(1000 + i)));
    expect(calls).toHaveLength(BATCH_CHUNK_SIZE);
  });

  it('a non-flow object gets no cascade; a cut-off answer is an error, not "no results"', async () => {
    const ok = service(rid => ({ ok: true, log: framedText([[rid, 'kpi_1', 'Kpi', 'KPI', '', '', '', '', '']]) }));
    expect((await ok.svc.batchEnrich(['5'])).results).toEqual({ 5: { businessId: 'kpi_1', type: 'Kpi', name: 'KPI', templateBusinessId: undefined } });
    const cut = service(rid => ({ ok: true, log: framedText([[rid, 'kpi_1', 'Kpi', 'KPI', '', '', '', '', '']], false) }));
    const res = await cut.svc.batchEnrich(['5']);
    expect(res.results).toEqual({});
    expect(res).toMatchObject({ errorKind: 'protocol' });
  });
});

describe('EcQueryService.resolveTemplate', () => {
  it('runs a valid constant script on the object and parses the template row', async () => {
    const { svc, calls } = service(() => ({ ok: true, log: framedText([['9007199254740997', 'Risk template', 'Scorecard', 'sc_risk']]) }));
    const res = await svc.resolveTemplate('9007199254740993');
    expect(calls).toHaveLength(1);
    expect(calls[0].rid).toBe('9007199254740993');
    expect(calls[0].code).toContain('_o := this.object');
    expect(calls[0].code).toContain('_t := _o.linkedTo');
    expect(validateEcSyntax(calls[0].code)).toEqual([]);
    expect(res).toEqual({ templateRid: '9007199254740997', templateName: 'Risk template', templateType: 'Scorecard', templateBusinessId: 'sc_risk' });
  });

  it('an object without a template answers MISSING: no template', async () => {
    const { svc } = service(() => ({ ok: true, log: framedText([['MISSING', '', '', '']]) }));
    expect(await svc.resolveTemplate('42')).toEqual({ templateRid: null });
  });

  it('refuses an invalid RID before any request', async () => {
    const { svc, calls } = service();
    await expect(svc.resolveTemplate('1); delete(')).rejects.toThrow('Invalid RID');
    expect(calls).toEqual([]);
  });
});

describe('object-pane EC (EAV query) — conditional emission', () => {
  const code = buildObjectPaneEc('t.150', ['width', 'headerColor']);

  it('keeps identity / parent / template / card blocks unconditional', () => {
    // parseIdentityBlock depends on these being present (they use the MISSING
    // sentinel), so they must NOT be guarded.
    for (const label of ['instRid', 'instId', 'parRid', 'tmplRid', 'cardRid']) {
      // A [label, value] row: the label is framed in the literal.
      expect(code).toContain(`"~CREV_R~${label.length}:${label}"`);
    }
  });

  it('guards every EAV slot (style / code / ref / ctx / gate) on non-empty', () => {
    // style props, code, ctx, gate -> condEcBlock (IF _v != "")
    expect(code).toContain('IF _v != "" THEN');
    expect(code).toContain('10:inst_width"');
    expect(code).toContain('10:tmpl_width"');
    // references -> condRefEc (read once, emit 4 only if resolved)
    expect(code).toContain('IF _ref != MISSING THEN');
    expect(code).toContain('ref_actionObject_rid');
    // the old unconditional reference read must be gone
    expect(code).not.toContain('_o.actionObject.rid.whenMissing');
  });

  it('coerces the guarded value to a string before the != "" comparison', () => {
    // A bare `_v := output(_o.headerStyle...)` then `_v != ""` makes BMP coerce
    // "" into the enum type and throw ("Valid choices for HeaderStyle is INSIDE,
    // OUTSIDE, NONE" — reproduced live on t.5920). The value MUST be string-
    // coerced first. Assert the codegen never emits the bare (typed) form and
    // always prefixes `"" +`.
    const styled = buildObjectPaneEc('t.5920', ['headerStyle', 'borderStyle', 'transparency']);
    expect(styled).toContain('_v := "" + output(_o.headerStyle.whenMissing(""))');
    expect(styled).toContain('_v := "" + output(_o.borderStyle.whenMissing(""))');
    // the buggy un-coerced form must not appear for a style/value slot.
    // (condIndirectEc legitimately uses a bare `_v := output(...)` for
    // expression TEXT, which is always a string and safe — so only the
    // _o.<prop> value slots are asserted, not every output() read.)
    expect(styled).not.toContain('_v := output(_o.headerStyle');
    expect(styled).not.toContain('_v := output(_o.transparency');
  });
})

describe('EditField property resolver EC', () => {
  it('walks validated class applications and opens their master property config', () => {
    const code = buildEditFieldPropertyEc('lookup(9001)', ['CeRiskAssessment', 'CeRiskAssessment']);

    expect(code.match(/c\.get\(CeRiskAssessment\.name\)/g)).toHaveLength(1);
    expect(code).toContain('_accessor := _o.propertyMapping.whenMissing("")');
    expect(code).toContain('IF _app.linkedTo.id = _accessor THEN');
    expect(code).toContain('_property := _app.linkedTo');
    expect(code).toContain('11:propertyRid"');
    expect(code).not.toContain('applicationRid');
    expect(code).not.toContain('ownerClassName');
    expect(code.trimEnd().endsWith('_r + "~CREV_D~"')).toBe(true);
  });

  it('rejects a class name that could inject Extended Code', () => {
    expect(() => buildEditFieldPropertyEc('lookup(9001)', ['CeRiskAssessment); output("owned")']))
      .toThrow();
  });
});

describe('Property application scan EC', () => {
  it('keeps the reverse-reference scan out of the initial object pane query', () => {
    const code = buildObjectPaneEc('k.get("bucket_1_max")', []);
    expect(code).not.toContain('.rref(linkedTo)');
    expect(code).not.toContain('propertyApplications');
  });

  it('walks direct linkedTo reverse references and captures each delta', () => {
    const code = buildPropertyApplicationsEc('k.get("bucket_1_max")');

    expect(code).toContain('_applications := _property.rref(linkedTo)');
    expect(code).toContain('_applications.first(100).forEach(_application:');
    expect(code).toContain('_application.parent.id.whenMissing("")');
    expect(code).toContain('_application.genedit()');
    expect(code).toContain('IF _genedit = "*<<<CREV_*" THEN');
    expect(code).toContain('<<<CREV_PROPERTY_ERROR>>>');
    expect(code).toContain('<<<CREV_PROPERTY_END>>>');
    expect(code).not.toContain('root.classConfig');
    expect(code).not.toContain('CeRiskAssessment');
  });
});
