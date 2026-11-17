/**
 * The `.expression` mark (ec-grammar isOutputArgument): marked where
 * reading it runs the stored code, not as the direct argument of output(…);
 * the same in read-only lines (ec-format, code-view) and in the editor's
 * stream parser (editor-core/ec/language). The mark has no hover text.
 *
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { StringStream } from '@codemirror/language';
import { tokenizeEcLine } from '../../lib/ec-format';
import { isOutputArgument } from '../../lib/ec-grammar';
import { extendedLanguage } from '../ec/language';
import { renderCodeLine } from '../code-view';

const CASES: Array<[string, boolean]> = [
  ['_basis := t.assessment_basis_values.expression', true],
  ['_t := output(t.calc.expression)', false],
  ['_t := OUTPUT( o.get("a (b)").expression )', false],
  ['_t := output(t.calc.expression + 1)', true],
  ['_t := output(t.a.expression, t.b)', true],
  ['_t := _x.output(t.calc.expression)', true],
  ['_t := output(lookup(123).expression)', false],
];

/** Is the `.expression` of `line` marked by the read-only tokeniser? */
const markedInLines = (line: string) => tokenizeEcLine(line).some(t => t.kind === 'expr');

/** …and by the editor's stream parser? */
function markedInEditor(line: string): boolean {
  const parser = (extendedLanguage as unknown as { streamParser: { startState(n: number): unknown; token(s: StringStream, st: unknown): string | null } }).streamParser;
  const state = parser.startState(5);
  const stream = new StringStream(line, 4, 5);
  let marked = false;
  while (!stream.eol()) {
    const style = parser.token(stream, state);
    if (stream.pos === stream.start) stream.next();
    if (style === 'expr') marked = true;
    stream.start = stream.pos;
  }
  return marked;
}

describe('the .expression mark', () => {
  it('is drawn where reading it runs the code, not as the direct argument of output(…)', () => {
    for (const [line, marked] of CASES) {
      expect(markedInLines(line), line).toBe(marked);
      expect(markedInEditor(line), `editor: ${line}`).toBe(marked);
    }
    const line = '_t := output(t.calc.expression)';
    expect(isOutputArgument(line, line.indexOf('.expression'), line.indexOf(')'))).toBe(true);
  });

  it('is drawn in rendered result lines without a hover text', () => {
    const host = document.createElement('div');
    host.append(...renderCodeLine('_basis := t.x.expression'));
    const mark = host.querySelector('.s-expr');
    expect(mark).not.toBeNull();
    expect(mark?.hasAttribute('title')).toBe(false);
    expect(host.querySelector('[title]')).toBeNull();
    const safe = document.createElement('div');
    safe.append(...renderCodeLine('_t := output(t.x.expression)'));
    expect(safe.querySelector('.s-expr')).toBeNull();
  });
});
