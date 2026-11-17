/** Reads that used to take two posts and now take one. */
import { describe, expect, it, vi } from 'vitest';
import { buildBatchCodeReadEc, buildBatchEnrichEc, EcQueryService } from '../ec-query-service';
import type { EcResult } from '../bmp-client';
import { framedBlocks } from '../ec-parser';


function service(log: string | ((code: string) => EcResult)) {
  const executeEc = vi.fn(async (code: string): Promise<EcResult> =>
    typeof log === 'function' ? log(code) : { ok: true, log });
  return { svc: new EcQueryService(executeEc, async rid => `lookup(${rid})`, []), executeEc };
}

describe('object window property picker (FETCH_EDIT_FIELD_TYPES)', () => {
  it('reads only the owning classes, not the whole pane', async () => {
    const { svc, executeEc } = service(framedBlocks({ types: 'CeRisk,CeRisk,CeIssue,' }));
    expect(await svc.fetchEditFieldClassNames('42')).toEqual(['CeRisk', 'CeIssue']);
    const code = executeEc.mock.calls[0][0];
    expect(code).toContain('_o.parent.rref(editPage).forEach(_view:');
    expect(code).not.toContain('inst_');
  });

  it('rejects a cut-off answer instead of reporting no classes', async () => {
    await expect(service(framedBlocks({ types: 'CeRisk' }, false)).svc.fetchEditFieldClassNames('42')).rejects.toThrow(/incomplete/);
  });
});

describe('multi-object scripts grow their result in chunks (ec-parser appendEc)', () => {
  /** Every `+` whose left operand is the full result copies it on BMP. */
  const longCopiesPerRow = (code: string) => code.split('\n')
    .filter(line => /^\s*_r := _r \+/.test(line)).length;

  it('badge identity: one constant script, one command per object; the loop fallback chunks every 8 objects', async () => {
    const { svc, executeEc } = service(() => ({ ok: false, error: 'x' }));
    const rids = Array.from({ length: 24 }, (_, i) => String(1000 + i));
    await svc.batchEnrich(rids);
    expect(executeEc).toHaveBeenCalledTimes(24);
    expect(new Set(executeEc.mock.calls.map(c => c[0])).size).toBe(1);
    expect(executeEc.mock.calls.map(c => (c as unknown[])[1]).sort()).toEqual(rids);
    const code = buildBatchEnrichEc(rids.map(r => `lookup(${r})`));
    // One row append in the loop body, not one block per object.
    expect(code.match(/^\s*_rc := _rc \+ \(/gm)).toHaveLength(1);
    expect(code).toContain('IF _k >= 8 THEN');
    // The flush in the loop and the final one: never one per row.
    expect(longCopiesPerRow(code)).toBe(2);
    expect(code.match(/lookup\(/g)).toHaveLength(24);
  });

  it('code batch: every block is parenthesised into the chunk, flushed every 4 objects', async () => {
    const { svc, executeEc } = service(() => ({ ok: false, error: 'x' }));
    await svc.batchFetchCode(Array.from({ length: 10 }, (_, i) => String(1000 + i)), ['expression', 'html']).catch(() => {});
    expect(new Set(executeEc.mock.calls.map(c => c[0])).size).toBe(1);
    const code = buildBatchCodeReadEc(Array.from({ length: 10 }, (_, i) => `lookup(${1000 + i})`), ['expression', 'html']);
    // OBJ row + one row per property, written once in the loop body.
    expect(code.match(/^\s*_rc := _rc \+ \(/gm)).toHaveLength(3);
    expect(code).toContain('IF _k >= 4 THEN');
    expect(longCopiesPerRow(code)).toBe(2);
  });
});
