/**
 * Characterization goldens for bmp-client.ts methods whose row-building EC
 * lives inline (not a standalone exported pure function) — batchEnrich. Captures the exact EC these methods sent to BMP, and their
 * exact parse of a representative log, before the plan-014 ec-row-codec
 * migration. `client.executeEc` is stubbed to capture + short-circuit,
 * mirroring the harness in bmp-client-codegen.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { framedLog, framedLogCut } from './ec-frame-fixtures';

async function createClient() {
  mockChromeStorage();
  const { BmpClient } = await import('../bmp-client');
  const client: any = new BmpClient('https://bmp.test/', 'admin', 'pass', 'p1');
  client.applyVersionFlags('5.6.7.2'); // supportsLookup=true → resolveRef returns lookup(rid)
  return client;
}

describe('BmpClient.batchEnrich (golden)', () => {
  it('emits the exact framed 9-field row for one resolved rid, then the completion marker', async () => {
    const client = await createClient();
    let captured = '';
    let rid: string | undefined;
    client.executeEc = vi.fn(async (ec: string, objectRid?: string) => {
      captured = ec;
      rid = objectRid;
      return { ok: true, log: '~CREV_D~' };
    });
    await client.batchEnrich(['123']);
    // Old: one block per object with the RID literal in the row (1,700
    // characters for one object, about 42,000 for a badge chunk of 25, a
    // new text on every call). New: one constant script of 1,801 characters
    // for every object; the object is the command's context.
    expect(rid).toBe('123');
    expect(captured).not.toContain('123');
    expect(captured.split('\n')[0]).toBe('_o := this.object');
    expect(captured).toContain('     _f0 := str(_o.rid)');
    expect(captured).toContain(
      // The row goes into the short chunk in parentheses (one copy of the
      // growing string per row, not one per term: see ec-parser appendEc).
      '     _rc := _rc + ("~CREV_R~" + str(_f0.size()) + ":" + _f0 + str(_f1.size()) + ":" + _f1 + str(_f2.size()) + ":" + _f2 + str(_f3.size()) + ":" + _f3 + str(_f4.size()) + ":" + _f4 + str(_f5.size()) + ":" + _f5 + str(_f6.size()) + ":" + _f6 + str(_f7.size()) + ":" + _f7 + str(_f8.size()) + ":" + _f8)',
    );
    expect(captured.trimEnd().endsWith('_r + "~CREV_D~"')).toBe(true);
  });

  it('parses a representative 9-field log row', async () => {
    const client = await createClient();
    client.executeEc = vi.fn(async () => ({
      ok: true,
      log: framedLog([['123', 'b1', 'Scorecard', 'Risk Register', 'tb1', '456', 'cb1', 'InputSet', 'My Set']]),
    }));
    const { results } = await client.batchEnrich(['123']);
    expect(results['123']).toEqual({
      businessId: 'b1', type: 'Scorecard', name: 'Risk Register', templateBusinessId: 'tb1',
      cascade: { rid: '456', businessId: 'cb1', type: 'InputSet', name: 'My Set' },
    });
  });

  it('keeps names with |||, | and line breaks without shifting the template and cascade fields', async () => {
    const client = await createClient();
    const name = 'Risk ||| Register | 2026\nsecond line';
    const cascadeName = 'Set|||A\nB';
    client.executeEc = vi.fn(async () => ({
      ok: true,
      log: framedLog([['123', 'b1', 'Scorecard', name, 'tb1', '456', 'cb1', 'InputSet', cascadeName]]),
    }));
    const { results } = await client.batchEnrich(['123']);
    expect(results['123']).toEqual({
      businessId: 'b1', type: 'Scorecard', name, templateBusinessId: 'tb1',
      cascade: { rid: '456', businessId: 'cb1', type: 'InputSet', name: cascadeName },
    });
  });

  it('keeps a very long name', async () => {
    const client = await createClient();
    const name = 'N'.repeat(20_000);
    client.executeEc = vi.fn(async () => ({ ok: true, log: framedLog([['123', 'b1', 'Scorecard', name, '', '', '', '', '']]) }));
    const { results } = await client.batchEnrich(['123']);
    expect(results['123'].name).toBe(name);
  });

  it('reports a cut-off log (no completion marker) as an error, not as "no results"', async () => {
    const client = await createClient();
    client.executeEc = vi.fn(async () => ({ ok: true, log: '' }));
    const empty = await client.batchEnrich(['123']);
    expect(empty.error).toMatch(/incomplete/i);
    expect(empty.errorKind).toBe('protocol');
    client.executeEc = vi.fn(async () => ({ ok: true, log: framedLogCut([['123', 'b1', 'Scorecard', 'Risk', '', '', '', '', '']]) }));
    const cut = await client.batchEnrich(['123']);
    expect(cut.error).toMatch(/incomplete/i);
    expect(cut.results).toEqual({});
  });

  it('an empty but complete answer is a success with no results', async () => {
    const client = await createClient();
    client.executeEc = vi.fn(async () => ({ ok: true, log: framedLog([]) }));
    const r = await client.batchEnrich(['123']);
    expect(r).toEqual({ results: {} });
  });

  it('omits cascade when the cascade rid is blank', async () => {
    const client = await createClient();
    client.executeEc = vi.fn(async () => ({
      ok: true,
      log: framedLog([['123', 'b1', 'Scorecard', 'Risk Register', 'tb1', '', '', '', '']]),
    }));
    const { results } = await client.batchEnrich(['123']);
    expect(results['123'].cascade).toBeUndefined();
  });
});
