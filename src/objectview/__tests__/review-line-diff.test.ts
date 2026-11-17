// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { lineDiff, withContext, renderLineDiff, codeSummary } from '../../lib/line-diff';
import { buildReview } from '../window/review';

describe('review: expression line diff', () => {
  it('marks only the changed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'B' }, { op: ' ', text: 'c' },
    ]);
    expect(lineDiff('', 'x')).toEqual([{ op: '+', text: 'x' }]);
  });

  it('folds unchanged runs outside the context', () => {
    const from = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const rows = withContext(lineDiff(from, from.replace('l10', 'L10')), 2);
    expect(rows[0]).toEqual({ op: 'gap', count: 8 });
    expect(rows.at(-1)).toEqual({ op: 'gap', count: 7 });
  });

  it('uses the singular for one line', () => {
    expect(codeSummary('', 'x := 1')).toBe('1 line (+1 −0)');
    expect(codeSummary('a', 'a\nb')).toBe('2 lines (+1 −0)');
  });

  it('shows the change itself for an expression, not line counts', () => {
    const review = buildReview(
      [{ rid: '1', prop: 'expression', entry: { kind: 'value', value: '_a := 1\n_b := 2', base: '_a := 1' } }] as never,
      rid => ({ rid, name: 'Button', kind: 'Button' }),
      () => 'Expression',
      () => true,
    );
    const host = document.createElement('div');
    host.append(...review.body);
    expect(host.querySelector('.ow-ld')).not.toBeNull();
    expect([...host.querySelectorAll('.ow-ld-row.add')].map(r => r.textContent)).toEqual(['+_b := 2']);
    expect(host.textContent).not.toContain('1 lines');
    expect(renderLineDiff('a', 'b').getAttribute('aria-label')).toBe('Expression change: 1 added, 1 removed');
  });
});
